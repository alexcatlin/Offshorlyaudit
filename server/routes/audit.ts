// POST /api/audit, GET /api/audit/:auditId/ai, GET /api/audit/:auditId/buyer-fit
// (PLAN Phase 7, Amendments 1, 2 and 3).
//
// Amendment 3: the POST body carries lead fields (email required). The route splits it into
// `{audit: AuditRequest, lead: LeadFields}`; the email never reaches runAudit, the cache key, a
// prompt or a log line (logs carry the 12-hex prefix of the HMAC key only).
//
// Amendment 5: every 200 adds `session` (per response, never cached, never logged) and `features`.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AiResult, AuditReport, AuditRequest, AuditStartResponse, BuyerFitResult, Features, LeadFields } from '../../shared/types.js';
import { runAudit, validateAuditRequest } from '../audit/runAudit.js';
import type { AuditDeps, AuditRun } from '../audit/runAudit.js';
import type { AiCostSummary } from '../ai/pricing.js';
import type { CrmSync } from '../crm/sync.js';
import type { DailyCounter, Semaphore, SlidingWindowLimiter, TtlLruCache } from '../http/limits.js';
import { sendError } from '../http/security.js';
import type { SessionStore } from '../http/sessions.js';
import { EMAIL_INVALID_MESSAGE, emailKey, isAllowlisted, logHash, validEmail, validateLeadFields } from '../lead/email.js';
import type { Allowlist, EmailChecker } from '../lead/email.js';
import { ledgerAllows } from '../lead/ledger.js';
import type { AuditLedger } from '../lead/ledger.js';
import type { MetricsStore } from '../metrics/store.js';
import { SiteReadError } from '../site/errors.js';
import { normaliseInputUrl } from '../site/readSite.js';

// Above the opportunities call budget (60 s, Amendment 4), below the client's 100 s GET timeout.
export const AI_WAIT_MS = 80_000;
export const BUYER_FIT_WAIT_MS = 80_000;

/** One audit held in memory: the measured report plus its AI promises and, once settled, their results. */
export interface AuditEntry {
  report: AuditReport;
  buyerFit: Promise<BuyerFitResult> | null;
  ai: Promise<AiResult> | null;
  buyerFitResult?: BuyerFitResult;
  aiResult?: AiResult;
  /** The visitor's answers (no email), for the CRM note. Same for every cache hit: they're in the key. */
  request?: AuditRequest;
  /** Settles with the audit's AI usage and estimated cost; null/absent when AI didn't run. */
  aiCost?: Promise<AiCostSummary> | null;
}

export interface AuditRouteDeps {
  audit: AuditDeps;
  /** Per-IP audit limiter (hourly + daily). */
  auditLimiter: SlidingWindowLimiter;
  /** Per-IP limiter for the two result endpoints. */
  resultLimiter: SlidingWindowLimiter;
  aiQuota: DailyCounter;
  semaphore: Semaphore;
  byKey: TtlLruCache<AuditEntry>;
  byId: TtlLruCache<AuditEntry>;
  ipKey: (req: FastifyRequest) => string;
  checkOrigin: (req: FastifyRequest) => boolean;
  aiWaitMs?: number;
  buyerFitWaitMs?: number;
  lead: LeadDeps;
  /** Per-response sessions (Amendment 5): every 200 gets its own token. */
  sessions: SessionStore;
  /** Daily counters (spec 001); absent = nothing counted. */
  metrics?: MetricsStore;
  /** What the report may offer (share, email, feedback). */
  features: Features;
  /** Test seam: defaults to runAudit. */
  runAudit?: typeof runAudit;
}

export interface LeadDeps {
  gate: 'on' | 'off';
  secret: string;
  allowlist: Allowlist;
  crmSyncAllowlisted: boolean;
  ledger: AuditLedger;
  emailChecker: EmailChecker;
  crm: CrmSync | null;
  now: () => number;
}

class BusyError extends Error {}

const BUSY_MESSAGE = 'Too many audits are running. Please try again in a minute.';

export const NOTICE_VERSION = 'v1' as const;

/** The validated POST body, split: runAudit only ever sees `audit`. */
export type StartBody = { ok: true; audit: AuditRequest; lead: LeadFields } | { ok: false; code: 'bad_request' | 'email_invalid'; error: string };

export const validateStartBody = (body: unknown): StartBody => {
  const audit = validateAuditRequest(body);
  if (!audit.ok) return { ok: false, code: 'bad_request', error: audit.error };
  const lead = validateLeadFields(body);
  if (!lead.ok) return lead;
  return { ok: true, audit: audit.value, lead: lead.value };
};

/**
 * Spec 001: what the AI did on a fresh run, counted as totals when its promises settle. Adds no
 * wait to the response (both promises never reject). Runs only for non-staff, non-cache-hit audits.
 */
const countAiOutcome = (metrics: MetricsStore, entry: AuditEntry): void => {
  if (!entry.ai) return;
  metrics.inc('ai_attempted');
  void entry.ai.then((r) => {
    if (r.aiStatus !== 'unavailable') metrics.inc('ai_finished');
    const ai = r.ai;
    if (ai?.industry) {
      metrics.inc('industry_known');
      const cites = (ai.industryExamples?.length ?? 0) > 0 || ai.opportunities.some((o) => o.basis.some((b) => b.kind === 'source'));
      if (cites) metrics.inc('industry_with_examples');
    }
  });
  void entry.aiCost?.then((s) => metrics.addCost(s.cost_usd));
};

const countAudit = (metrics: MetricsStore, entry: AuditEntry, hit: boolean, log: { error: (o: object, msg: string) => void }): void => {
  try {
    metrics.inc('audit_run');
    if (!hit) countAiOutcome(metrics, entry);
  } catch (e) {
    log.error({ error: (e as Error).name }, 'metrics failed');
  }
};

/**
 * The allowance is used only by a 200 where AI ran or legitimately didn't apply: the initial
 * report doesn't have both statuses 'unavailable' (AI off, daily cap, no slots). 'thin' counts.
 */
export const usesAllowance = (report: AuditReport): boolean =>
  !(report.aiStatus === 'unavailable' && report.buyerFitStatus === 'unavailable');

const inputHost = (url: URL): string => url.hostname.toLowerCase().replace(/^www\./, '');

const AUDIT_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** Cache key: normalised URL + a hash of everything that changes the AI output. */
export const cacheKey = (req: AuditRequest, url: URL): string => {
  const answers = JSON.stringify([
    req.businessType ?? '',
    req.persona?.role ?? '',
    req.persona?.size ?? '',
    req.persona?.sector ?? '',
    req.persona?.trigger ?? '',
    req.teamSize ?? '',
    req.timeSink ?? '',
    req.industry ?? '',
    req.tools ?? '',
    req.region ?? '',
  ]);
  const hash = createHash('sha256').update(answers).digest('hex').slice(0, 16);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '') || '/'}${url.search}#${hash}`;
};

const entryFromRun = (run: AuditRun): AuditEntry => {
  const entry: AuditEntry = { report: run.report, buyerFit: run.buyerFit, ai: run.ai, request: run.request, aiCost: run.aiCost };
  // Remember settled results so cache hits can inline them. These promises never reject.
  run.buyerFit?.then((r) => {
    entry.buyerFitResult = r;
  });
  run.ai?.then((r) => {
    entry.aiResult = r;
  });
  return entry;
};

/**
 * A failed AI result (API blip, timeout, bad output) must not be served from
 * the cache for the whole TTL: once either promise settles 'unavailable', the URL keys are
 * dropped so the next POST runs afresh. The id entry stays, so open GETs still resolve.
 * Runs after getOrCreate has stored the key; only removes keys still pointing at this entry.
 */
export const forgetOnAiFailure = (byKey: TtlLruCache<AuditEntry>, entry: AuditEntry, keys: readonly string[]): void => {
  const forget = () => {
    for (const k of keys) if (byKey.peek(k) === entry) byKey.delete(k);
  };
  entry.buyerFit?.then((r) => {
    if (r.buyerFitStatus === 'unavailable') forget();
  });
  entry.ai?.then((r) => {
    if (r.aiStatus === 'unavailable') forget();
  });
};

/** The report for a cache hit, with any AI results that have already settled. */
export const reportWithSettled = (entry: AuditEntry): AuditReport => {
  let r: AuditReport = entry.report;
  const bf = entry.buyerFitResult;
  if (bf && r.buyerFitStatus === 'pending') {
    r = {
      ...r,
      buyerFitStatus: bf.buyerFitStatus,
      ...(bf.buyerFit ? { buyerFit: bf.buyerFit } : {}),
      fixFirst: bf.fixFirst,
    };
  }
  const ai = entry.aiResult;
  if (ai && r.aiStatus === 'pending') {
    r = { ...r, aiStatus: ai.aiStatus, ...(ai.ai ? { ai: ai.ai } : {}) };
  }
  return r;
};

/** Waits for a promise up to `ms`; resolves with the fallback when the wait runs out. */
const waitFor = <T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

export const registerAuditRoutes = (app: FastifyInstance, deps: AuditRouteDeps): void => {
  const forbidden = (reply: FastifyReply) => sendError(reply, 403, { code: 'forbidden', error: 'Forbidden.' });

  const run = deps.runAudit ?? runAudit;
  const lead = deps.lead;
  /** Gate keys with an audit in flight, and for which domain. */
  const pending = new Map<string, { domain: string; count: number }>();

  app.post('/api/audit', async (req, reply) => {
    if (!deps.checkOrigin(req)) return forbidden(reply);

    const valid = validateStartBody(req.body);
    if (!valid.ok) return sendError(reply, 400, { code: valid.code, error: valid.error });
    const request = valid.audit;
    const fields = valid.lead;

    let url: URL;
    try {
      url = normaliseInputUrl(request.url);
    } catch (e) {
      return sendError(reply, 422, { code: 'site_not_found', error: (e as Error).message });
    }

    // Before the email checks, so probing addresses costs IP allowance. No refund on email_used.
    const ip = deps.ipKey(req);
    const limit = deps.auditLimiter.hit(ip);
    if (!limit.ok) {
      return sendError(reply, 429, {
        code: 'rate_limited',
        error: 'Too many audits from this address. Please try again later.',
        retryAfterSec: limit.retryAfterSec,
      });
    }

    // Syntax here as well as in the checker: canonicalEmail (emailKey, allow-list) must never see
    // an unvalidated string, whatever EmailChecker is plugged in.
    if (!validEmail(fields.email)) return sendError(reply, 400, { code: 'email_invalid', error: EMAIL_INVALID_MESSAGE });
    const emailCheck = await lead.emailChecker.check(fields.email);
    if (emailCheck !== 'ok') return sendError(reply, 400, { code: 'email_invalid', error: EMAIL_INVALID_MESSAGE });

    const key = emailKey(lead.secret, fields.email);
    const meta = { emailHash: logHash(key) };
    const host = inputHost(url);
    const allowlisted = isAllowlisted(lead.allowlist, fields.email);
    const gated = lead.gate === 'on' && !allowlisted;
    const submittedAt = new Date(lead.now()).toISOString();

    if (gated) {
      let allowed = true;
      try {
        allowed = ledgerAllows(await lead.ledger.get(key), host);
      } catch (e) {
        req.log.error({ ...meta, error: (e as { code?: string }).code ?? (e as Error).name }, 'ledger_unavailable');
      }
      if (!allowed) {
        req.log.info(meta, 'email gate: already used');
        return sendError(reply, 409, { code: 'email_used', error: 'This email has already been used for a free audit.' });
      }
      const p = pending.get(key);
      if (p && p.domain !== host) {
        // No refund and the generic busy wording: this reply must not be a free probe of
        // which addresses have an audit in flight.
        return sendError(reply, 503, { code: 'busy', error: BUSY_MESSAGE });
      }
      pending.set(key, { domain: host, count: (p?.count ?? 0) + 1 });
    }

    const auditKey = cacheKey(request, url);
    const keys = [auditKey];
    let uncacheable = false;
    try {
      const { value: entry, hit } = await deps.byKey.getOrCreate(auditKey, async () => {
        const release = deps.semaphore.tryAcquire();
        if (!release) throw new BusyError();
        try {
          const r = await run(request, { ...deps.audit, takeAiQuota: () => deps.aiQuota.tryTake() });
          const e = entryFromRun(r);
          deps.byId.set(r.report.auditId, e);
          // AI skipped for want of slots: keep it off the URL keys so a retry runs fresh.
          uncacheable = r.aiBusy;
          // Also reachable by the final URL (e.g. "example.com" and "https://www.example.com/").
          const finalKey = cacheKey(request, new URL(r.finalUrl));
          if (finalKey !== auditKey && !uncacheable) {
            deps.byKey.set(finalKey, e);
            keys.push(finalKey);
          }
          return e;
        } finally {
          release();
        }
      });
      if (hit) req.log.info({ auditId: entry.report.auditId }, 'audit cache hit');
      else if (uncacheable) {
        for (const k of keys) if (deps.byKey.peek(k) === entry) deps.byKey.delete(k);
      } else forgetOnAiFailure(deps.byKey, entry, keys);

      if (deps.metrics && !allowlisted) countAudit(deps.metrics, entry, hit, req.log);

      if (gated && usesAllowance(entry.report)) {
        try {
          const { created } = await lead.ledger.record(key, [...new Set([host, entry.report.domain])]);
          if (created) req.log.info({ ...meta, auditId: entry.report.auditId }, 'email gate: recorded');
        } catch (e) {
          req.log.error({ ...meta, error: (e as { code?: string }).code ?? (e as Error).name }, 'ledger record failed');
        }
      }
      if (lead.crm && (!allowlisted || lead.crmSyncAllowlisted)) {
        // Fire-and-forget: never awaited, never allowed to affect the response.
        try {
          lead.crm.enqueue(
            {
              email: fields.email.toLowerCase(),
              ...(fields.name ? { name: fields.name } : {}),
              marketingOptIn: fields.marketingOptIn === true,
              consentAt: submittedAt,
              noticeVersion: NOTICE_VERSION,
              emailHash: key,
              test: allowlisted,
            },
            entry,
            // A hit (cached or shared run) spent nothing new: the note omits the cost line.
            { cacheHit: hit },
          );
        } catch (e) {
          req.log.error({ ...meta, error: (e as Error).name }, 'crm enqueue failed');
        }
      }
      // A fresh object: the session and features are per response and never touch the cached report.
      const session = deps.sessions.create({
        entry,
        emailKey: key,
        allowlisted,
        marketingOptIn: fields.marketingOptIn === true,
      });
      const body: AuditStartResponse = { ...(hit ? reportWithSettled(entry) : entry.report), session, features: deps.features };
      return reply.send(body);
    } catch (e) {
      if (e instanceof BusyError) {
        // A refused audit doesn't use up the visitor's allowance.
        deps.auditLimiter.refund(ip);
        return sendError(reply, 503, { code: 'busy', error: BUSY_MESSAGE });
      }
      if (e instanceof SiteReadError) {
        return sendError(reply, 422, {
          code: e.code === 'not_found' ? 'site_not_found' : 'site_unreadable',
          error: e.message,
        });
      }
      req.log.error({ err: e }, 'audit failed');
      return sendError(reply, 500, { code: 'server_error', error: 'Something went wrong.' });
    } finally {
      if (gated) {
        const p = pending.get(key);
        if (p && p.count > 1) p.count--;
        else pending.delete(key);
      }
    }
  });

  const lookup = (req: FastifyRequest<{ Params: { auditId: string } }>, reply: FastifyReply): AuditEntry | null => {
    if (!deps.checkOrigin(req)) {
      forbidden(reply);
      return null;
    }
    const limit = deps.resultLimiter.hit(deps.ipKey(req));
    if (!limit.ok) {
      sendError(reply, 429, { code: 'rate_limited', error: 'Too many requests. Please try again later.', retryAfterSec: limit.retryAfterSec });
      return null;
    }
    const id = req.params.auditId;
    const entry = AUDIT_ID_RE.test(id) ? deps.byId.get(id) : undefined;
    if (!entry) {
      sendError(reply, 404, { code: 'not_found', error: 'This report has expired or does not exist.' });
      return null;
    }
    return entry;
  };

  app.get<{ Params: { auditId: string } }>('/api/audit/:auditId/ai', async (req, reply) => {
    const entry = lookup(req, reply);
    if (!entry) return reply;
    const auditId = entry.report.auditId;
    if (!entry.ai) {
      const s = entry.report.aiStatus;
      const result: AiResult =
        (s === 'ok' || s === 'fixture' || s === 'insufficient') && entry.report.ai
          ? { auditId, aiStatus: s, ai: entry.report.ai }
          : { auditId, aiStatus: 'unavailable' };
      return reply.send(result);
    }
    const result = await waitFor<AiResult>(entry.ai, deps.aiWaitMs ?? AI_WAIT_MS, () => ({ auditId, aiStatus: 'unavailable' }));
    return reply.send(result);
  });

  app.get<{ Params: { auditId: string } }>('/api/audit/:auditId/buyer-fit', async (req, reply) => {
    const entry = lookup(req, reply);
    if (!entry) return reply;
    const auditId = entry.report.auditId;
    const fallback = (): BuyerFitResult => ({ auditId, buyerFitStatus: 'unavailable', fixFirst: entry.report.fixFirst });
    if (!entry.buyerFit) return reply.send(fallback());
    const result = await waitFor(entry.buyerFit, deps.buyerFitWaitMs ?? BUYER_FIT_WAIT_MS, fallback);
    return reply.send(result);
  });

  // 405 for other methods on the API paths.
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send({ code: 'bad_request', error: 'Method not allowed.' });
  app.route({ method: ['GET', 'PUT', 'PATCH', 'DELETE'], url: '/api/audit', handler: methodNotAllowed });
  const getOnly = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'GET').send({ code: 'bad_request', error: 'Method not allowed.' });
  app.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE'], url: '/api/audit/:auditId/ai', handler: getOnly });
  app.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE'], url: '/api/audit/:auditId/buyer-fit', handler: getOnly });
};
