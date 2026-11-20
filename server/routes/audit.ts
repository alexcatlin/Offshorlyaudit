// POST /api/audit, GET /api/audit/:auditId/ai, GET /api/audit/:auditId/buyer-fit
// (PLAN Phase 7, Amendments 1 and 2).
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AiResult, AuditReport, AuditRequest, BuyerFitResult } from '../../shared/types.js';
import { runAudit, validateAuditRequest } from '../audit/runAudit.js';
import type { AuditDeps, AuditRun } from '../audit/runAudit.js';
import type { DailyCounter, Semaphore, SlidingWindowLimiter, TtlLruCache } from '../http/limits.js';
import { sendError } from '../http/security.js';
import { SiteReadError } from '../site/errors.js';
import { normaliseInputUrl } from '../site/readSite.js';

export const AI_WAIT_MS = 50_000;
export const BUYER_FIT_WAIT_MS = 80_000;

/** One audit held in memory: the measured report plus its AI promises and, once settled, their results. */
export interface AuditEntry {
  report: AuditReport;
  buyerFit: Promise<BuyerFitResult> | null;
  ai: Promise<AiResult> | null;
  buyerFitResult?: BuyerFitResult;
  aiResult?: AiResult;
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
}

class BusyError extends Error {}

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
  ]);
  const hash = createHash('sha256').update(answers).digest('hex').slice(0, 16);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '') || '/'}${url.search}#${hash}`;
};

const entryFromRun = (run: AuditRun): AuditEntry => {
  const entry: AuditEntry = { report: run.report, buyerFit: run.buyerFit, ai: run.ai };
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

  app.post('/api/audit', async (req, reply) => {
    if (!deps.checkOrigin(req)) return forbidden(reply);

    const valid = validateAuditRequest(req.body);
    if (!valid.ok) return sendError(reply, 400, { code: 'bad_request', error: valid.error });
    const request = valid.value;

    let url: URL;
    try {
      url = normaliseInputUrl(request.url);
    } catch (e) {
      return sendError(reply, 422, { code: 'site_not_found', error: (e as Error).message });
    }

    const ip = deps.ipKey(req);
    const limit = deps.auditLimiter.hit(ip);
    if (!limit.ok) {
      return sendError(reply, 429, {
        code: 'rate_limited',
        error: 'Too many audits from this address. Please try again later.',
        retryAfterSec: limit.retryAfterSec,
      });
    }

    const key = cacheKey(request, url);
    const keys = [key];
    let uncacheable = false;
    try {
      const { value: entry, hit } = await deps.byKey.getOrCreate(key, async () => {
        const release = deps.semaphore.tryAcquire();
        if (!release) throw new BusyError();
        try {
          const run = await runAudit(request, { ...deps.audit, takeAiQuota: () => deps.aiQuota.tryTake() });
          const e = entryFromRun(run);
          deps.byId.set(run.report.auditId, e);
          // AI skipped for want of slots: keep it off the URL keys so a retry runs fresh.
          uncacheable = run.aiBusy;
          // Also reachable by the final URL (e.g. "example.com" and "https://www.example.com/").
          const finalKey = cacheKey(request, new URL(run.finalUrl));
          if (finalKey !== key && !uncacheable) {
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
      return reply.send(hit ? reportWithSettled(entry) : entry.report);
    } catch (e) {
      if (e instanceof BusyError) {
        // A refused audit doesn't use up the visitor's allowance.
        deps.auditLimiter.refund(ip);
        return sendError(reply, 503, { code: 'busy', error: 'Too many audits are running. Please try again in a minute.' });
      }
      if (e instanceof SiteReadError) {
        return sendError(reply, 422, {
          code: e.code === 'not_found' ? 'site_not_found' : 'site_unreadable',
          error: e.message,
        });
      }
      req.log.error({ err: e }, 'audit failed');
      return sendError(reply, 500, { code: 'server_error', error: 'Something went wrong.' });
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
