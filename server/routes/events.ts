// POST /api/event {event, placement?, session?, shared?} → 204 (spec 001).
//
// Counts one visitor event as a daily total: a direct report viewed (once per session) or a
// booking card clicked. Three shapes, each with a fixed list of placements:
//   direct   {session}                 report_view, or cta_click on ai | ai-top | pitch | website
//   shared   {shared: true}            cta_click on ai | ai-top | pitch | website | audit-link
//   blocked  {} (no session, no shared) cta_click on blocked (the "email already used" alert)
// Staff (allow-listed) sessions are accepted and not counted. The body, the session token and the
// IP are never stored or logged: the log line carries the event and placement only. Fail open:
// a store failure still answers 204.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BLOCKED_PLACEMENT, DIRECT_PLACEMENTS, EVENT_NAMES, SHARED_PLACEMENTS } from '../../shared/types.js';
import type { EventName } from '../../shared/types.js';
import type { SlidingWindowLimiter } from '../http/limits.js';
import { sendError } from '../http/security.js';
import type { AuditSession, SessionStore } from '../http/sessions.js';
import type { MetricsStore } from '../metrics/store.js';
import { SESSION_EXPIRED_MESSAGE } from './feedback.js';

export interface EventRouteDeps {
  metrics: MetricsStore;
  sessions: SessionStore;
  limiter: SlidingWindowLimiter;
  ipKey: (req: FastifyRequest) => string;
  checkOrigin: (req: FastifyRequest) => boolean;
}

const bad = (reply: FastifyReply) => sendError(reply, 400, { code: 'bad_request', error: 'Bad request.' });
const has = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

type Kind = { kind: 'direct'; session: string } | { kind: 'shared' | 'blocked' };
type Parsed = { event: EventName; placement: string | undefined } & Kind;

const parseKind = (b: Record<string, unknown>, click: boolean, placement: string | undefined): Kind | null => {
  const { session, shared } = b;
  if (session !== undefined) {
    return typeof session === 'string' && shared === undefined && (!click || has(DIRECT_PLACEMENTS, placement))
      ? { kind: 'direct', session }
      : null;
  }
  if (shared !== undefined) return shared === true && click && has(SHARED_PLACEMENTS, placement) ? { kind: 'shared' } : null;
  return click && placement === BLOCKED_PLACEMENT ? { kind: 'blocked' } : null;
};

const parseEvent = (body: unknown): Parsed | null => {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const { event } = b;
  const placement = b.placement as string | undefined;
  if (!has(EVENT_NAMES, event)) return null;
  if (event === 'report_view' ? placement !== undefined : typeof placement !== 'string') return null;
  const kind = parseKind(b, event === 'cta_click', placement);
  return kind && { event, placement, ...kind };
};

const directCounter = (event: EventName, placement: string | undefined, session: AuditSession): string | null => {
  if (session.allowlisted) return null;
  if (event !== 'report_view') return `click.direct.${placement}`;
  if (session.viewCounted) return null;
  session.viewCounted = true;
  return 'report_view';
};

export const registerEventRoutes = (app: FastifyInstance, deps: EventRouteDeps): void => {
  app.post('/api/event', async (req, reply: FastifyReply) => {
    if (!deps.checkOrigin(req)) return sendError(reply, 403, { code: 'forbidden', error: 'Forbidden.' });
    const limit = deps.limiter.hit(deps.ipKey(req));
    if (!limit.ok) {
      return sendError(reply, 429, { code: 'rate_limited', error: 'Too many requests. Please try again later.', retryAfterSec: limit.retryAfterSec });
    }
    const parsed = parseEvent(req.body);
    if (!parsed) return bad(reply);
    const { event, placement } = parsed;

    let counter: string | null;
    if (parsed.kind === 'direct') {
      const session = deps.sessions.get(parsed.session);
      if (!session) return sendError(reply, 410, { code: 'session_expired', error: SESSION_EXPIRED_MESSAGE });
      counter = directCounter(event, placement, session);
    } else counter = parsed.kind === 'shared' ? `click.shared.${placement}` : 'click.direct.blocked';

    if (counter) {
      try {
        deps.metrics.inc(counter);
      } catch (e) {
        req.log.error({ error: (e as Error).name }, 'metrics inc failed');
      }
      req.log.info({ event, placement: placement ?? null }, 'visitor_event');
    }
    return reply.code(204).send();
  });

  app.route({
    method: ['GET', 'PUT', 'PATCH', 'DELETE'],
    url: '/api/event',
    handler: async (_req, reply) => reply.code(405).header('allow', 'POST').send({ code: 'bad_request', error: 'Method not allowed.' }),
  });
};
