// Admin endpoints (Amendment 5 Phases 2–3). Registered only when ADMIN_TOKEN (≥32 chars) is
// set; otherwise every /api/admin path is a plain 404.
//
//   GET    /api/admin/feedback.csv        idea feedback, last vote per (session, idea) wins
//   DELETE /api/admin/share/:shareId      deletion requests for a shared report
//   GET    /api/admin/research            cached industry search results (Phase 5; 404 when off)
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
import { sendError } from '../http/security.js';
import type { IndustryResearch } from '../search/industryResearch.js';
import type { ReportStore } from '../share/store.js';
import { SHARE_ID_RE } from '../share/store.js';

export interface AdminRouteDeps {
  token: string;
  feedback: FeedbackStore;
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

  app.get('/api/admin/research', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    if (!deps.research) return sendError(reply, 404, { code: 'not_found', error: 'Not found.' });
    return reply.send({ provider: deps.research.provider, entries: deps.research.list() });
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
