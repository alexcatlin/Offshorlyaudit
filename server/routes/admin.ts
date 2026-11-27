// Admin endpoints (Amendment 5 Phases 2–3). Registered only when ADMIN_TOKEN (≥32 chars) is
// set; otherwise every /api/admin path is a plain 404.
//
//   GET    /api/admin/feedback.csv        idea feedback, last vote per (session, idea) wins
//   GET    /api/admin/measures.csv        success measures per UTC day (?from=&to=, default last 30 days; spec 001)
//   DELETE /api/admin/share/:shareId      deletion requests for a shared report
//   GET    /api/admin/research            cached industry search results and the last audit/refresh
//                                         outcome per industry with its reason code (Phase 5; 404 when off)
//
// Auth: `Authorization: Bearer <token>`, compared with timingSafeEqual over sha256 digests
// (equal lengths, no early exit). Limited to 10 requests per IP per hour, counted before the
// token check. No origin check, so the owner can use curl. The auth header is never logged
// (the request serializer records method, path and a hashed IP only).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { feedbackCsv } from '../feedback/store.js';
import type { FeedbackStore } from '../feedback/store.js';
import type { SlidingWindowLimiter } from '../http/limits.js';
import { isDay, MAX_RANGE_DAYS, measuresCsv } from '../metrics/measures.js';
import type { MetricsStore } from '../metrics/store.js';
import { sendError } from '../http/security.js';
import type { IndustryResearch } from '../search/industryResearch.js';
import type { ReportStore } from '../share/store.js';
import { SHARE_ID_RE } from '../share/store.js';

export interface AdminRouteDeps {
  token: string;
  feedback: FeedbackStore;
  /** Daily counters (spec 001). */
  metrics: MetricsStore;
  now: () => number;
  reports: ReportStore | null;
  /** Phase 5 research cache; null/absent = search off. */
  research?: IndustryResearch | null;
  limiter: SlidingWindowLimiter;
  ipKey: (req: FastifyRequest) => string;
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export const bearerMatches = (header: unknown, token: string): boolean => {
  if (typeof header !== 'string') return false;
  const m = /^Bearer ([\x21-\x7e]{1,512})$/.exec(header);
  if (!m) return false;
  return timingSafeEqual(digest(m[1]!), digest(token));
};

export const registerAdminRoutes = (app: FastifyInstance, deps: AdminRouteDeps): void => {
  /** Limit then auth; replies and returns false when the request may not proceed. */
  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const limit = deps.limiter.hit(deps.ipKey(req));
    if (!limit.ok) {
      sendError(reply, 429, { code: 'rate_limited', error: 'Too many requests. Please try again later.', retryAfterSec: limit.retryAfterSec });
      return false;
    }
    if (!bearerMatches(req.headers.authorization, deps.token)) {
      reply.header('www-authenticate', 'Bearer');
      sendError(reply, 401, { code: 'forbidden', error: 'Unauthorised.' });
      return false;
    }
    return true;
  };

  app.get('/api/admin/feedback.csv', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="feedback.csv"')
      .send(feedbackCsv(deps.feedback.list()));
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/admin/measures.csv', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const day = (offset: number) => new Date(deps.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const to = req.query.to ?? day(0);
    const from = req.query.from ?? day(-29);
    if (!isDay(from) || !isDay(to) || from > to || (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1 > MAX_RANGE_DAYS) {
      return sendError(reply, 400, { code: 'bad_request', error: 'Bad request.' });
    }
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="measures.csv"')
      .send(measuresCsv(deps.metrics.range(from, to), deps.feedback.list(), from, to));
  });

  app.get('/api/admin/research', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    if (!deps.research) return sendError(reply, 404, { code: 'not_found', error: 'Not found.' });
    return reply.send({
      provider: deps.research.provider,
      entries: deps.research.list(),
      outcomes: deps.research.outcomes(),
      pausedUntil: deps.research.pausedUntil(),
    });
  });

  app.delete<{ Params: { shareId: string } }>('/api/admin/share/:shareId', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const id = req.params.shareId;
    if (!deps.reports || !SHARE_ID_RE.test(id) || !(await deps.reports.delete(id))) {
      return sendError(reply, 404, { code: 'not_found', error: 'Not found.' });
    }
    req.log.info('admin_share_deleted');
    return reply.code(204).send();
  });
};
