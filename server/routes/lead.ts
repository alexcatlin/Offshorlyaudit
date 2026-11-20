// POST /api/lead (PLAN Phase 9). Registered only when LEAD_WEBHOOK_URL is set.
// Forwards the lead server-side; nothing is stored and emails are never logged.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TeamSize } from '../../shared/types.js';
import type { SlidingWindowLimiter } from '../http/limits.js';
import { sendError } from '../http/security.js';

export const CONSENT_TEXT = 'I agree that Offshorly may contact me about this audit and how they could help.';
const TEAM_SIZES: readonly TeamSize[] = ['1-10', '11-50', '51-200', '200+'];
const EMAIL_RE = /^[^\s@<>()[\],;:"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export type LeadFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface LeadRouteDeps {
  webhookUrl: string;
  limiter: SlidingWindowLimiter;
  ipKey: (req: FastifyRequest) => string;
  checkOrigin: (req: FastifyRequest) => boolean;
  /** Titles of the AI ideas for an audit, when it is still in memory and matches the domain. */
  topIdeas: (auditId: string, domain: string) => string[];
  fetchImpl?: LeadFetch;
  now?: () => number;
}

export interface LeadInput {
  email: string;
  name?: string;
  domain: string;
  teamSize?: TeamSize;
  auditId?: string;
}

/**
 * Webhook-safe name: no angle brackets or pipes (Slack reads `<!channel>` and `<url|text>`),
 * no control characters, whitespace collapsed.
 */
export const sanitiseLeadName = (name: string): string =>
  name
    .replace(/[<>|]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const validateLead = (body: unknown): { ok: true; value: LeadInput } | { ok: false; error: string } => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected a JSON object.' };
  const b = body as Record<string, unknown>;
  if (b.consent !== true) return { ok: false, error: 'Consent is required.' };
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, error: 'Please enter a valid email address.' };
  const domain = typeof b.domain === 'string' ? b.domain.trim().toLowerCase() : '';
  if (!DOMAIN_RE.test(domain)) return { ok: false, error: 'domain is not valid.' };
  const out: LeadInput = { email, domain };
  if (b.name !== undefined && b.name !== null && b.name !== '') {
    if (typeof b.name !== 'string' || b.name.trim().length > 100) return { ok: false, error: 'name is too long.' };
    const name = sanitiseLeadName(b.name);
    if (name) out.name = name;
  }
  if (b.teamSize !== undefined && b.teamSize !== null && b.teamSize !== '') {
    if (!TEAM_SIZES.includes(b.teamSize as TeamSize)) return { ok: false, error: 'teamSize is not a valid option.' };
    out.teamSize = b.teamSize as TeamSize;
  }
  if (typeof b.auditId === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(b.auditId)) out.auditId = b.auditId;
  return { ok: true, value: out };
};

export const registerLeadRoute = (app: FastifyInstance, deps: LeadRouteDeps): void => {
  const fetchImpl: LeadFetch = deps.fetchImpl ?? ((u, init) => fetch(u, init));
  const now = deps.now ?? Date.now;

  app.post('/api/lead', async (req, reply) => {
    if (!deps.checkOrigin(req)) return sendError(reply, 403, { code: 'forbidden', error: 'Forbidden.' });
    const limit = deps.limiter.hit(deps.ipKey(req));
    if (!limit.ok) {
      return sendError(reply, 429, { code: 'rate_limited', error: 'Too many requests. Please try again later.', retryAfterSec: limit.retryAfterSec });
    }
    const valid = validateLead(req.body);
    if (!valid.ok) return sendError(reply, 400, { code: 'bad_request', error: valid.error });
    const { auditId, ...lead } = valid.value;

    const payload = {
      ...lead,
      topIdeas: auditId ? deps.topIdeas(auditId, lead.domain) : [],
      consentText: CONSENT_TEXT,
      consentAt: new Date(now()).toISOString(),
      source: 'audit-widget',
    };
    try {
      const res = await fetchImpl(deps.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        req.log.warn({ status: res.status, domain: lead.domain }, 'lead webhook rejected');
        return sendError(reply, 500, { code: 'server_error', error: "We couldn't send your details. Please try again." });
      }
    } catch (e) {
      req.log.warn({ error: (e as Error).name, domain: lead.domain }, 'lead webhook failed');
      return sendError(reply, 500, { code: 'server_error', error: "We couldn't send your details. Please try again." });
    }
    req.log.info({ domain: lead.domain }, 'lead forwarded');
    return reply.send({ ok: true });
  });
};
