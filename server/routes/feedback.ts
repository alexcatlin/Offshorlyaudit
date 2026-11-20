// POST /api/feedback {session, ideaIndex, vote: 'up'|'down'|null} → 204 (Amendment 5 Phase 2).
//
// Acts through the per-response session, never the auditId. Writes one JSONL line (null →
// 'clear') holding ids, the idea's service/pattern/title and the vote: no email, no email
// hash, no IP. Logs `idea_feedback` with ids and the vote only. Fail open: a store failure
// is logged and the visitor still gets 204. A session may write at most
// FEEDBACK_WRITES_PER_IDEA × (number of ideas) lines; past that, 429 without writing.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AiOpportunity } from '../../shared/types.js';
import { redactEmails } from '../ai/text.js';
import type { FeedbackStore, FeedbackVote } from '../feedback/store.js';
import type { SlidingWindowLimiter } from '../http/limits.js';
import { sendError } from '../http/security.js';
import type { SessionStore } from '../http/sessions.js';
import { reportWithSettled } from './audit.js';

export interface FeedbackRouteDeps {
  store: FeedbackStore;
  sessions: SessionStore;
  limiter: SlidingWindowLimiter;
  ipKey: (req: FastifyRequest) => string;
  checkOrigin: (req: FastifyRequest) => boolean;
  now: () => number;
}

export const SESSION_EXPIRED_MESSAGE = 'This report is no longer held on our server.';

/** First 12 hex of sha256(session): links one visitor's votes without storing the token. */
export const sessionHash = (session: string): string => createHash('sha256').update(session).digest('hex').slice(0, 12);

/** ≤80 characters, single line, no control characters, email-like tokens removed. */
export const feedbackTitle = (title: string): string =>
  redactEmails(title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 80);

const patternOf = (o: AiOpportunity): string | null => {
  for (const b of o.basis) if (b.kind === 'industry') return b.patternId.slice(0, 64);
  return null;
};

/** Votes per idea a session may record (toggling up, down, clear). */
export const FEEDBACK_WRITES_PER_IDEA = 3;

type Body = { session: unknown; ideaIndex: unknown; vote: unknown };

export const registerFeedbackRoutes = (app: FastifyInstance, deps: FeedbackRouteDeps): void => {
  app.post('/api/feedback', async (req, reply: FastifyReply) => {
    if (!deps.checkOrigin(req)) return sendError(reply, 403, { code: 'forbidden', error: 'Forbidden.' });
    const limit = deps.limiter.hit(deps.ipKey(req));
    if (!limit.ok) {
      return sendError(reply, 429, { code: 'rate_limited', error: 'Too many requests. Please try again later.', retryAfterSec: limit.retryAfterSec });
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Body;
    const { ideaIndex, vote } = body;
    if (typeof body.session !== 'string' || typeof ideaIndex !== 'number' || !Number.isInteger(ideaIndex) || ideaIndex < 0) {
      return sendError(reply, 400, { code: 'bad_request', error: 'Bad request.' });
    }
    if (vote !== 'up' && vote !== 'down' && vote !== null) return sendError(reply, 400, { code: 'bad_request', error: 'Bad request.' });

    const session = deps.sessions.get(body.session);
    if (!session) return sendError(reply, 410, { code: 'session_expired', error: SESSION_EXPIRED_MESSAGE });

    const report = reportWithSettled(session.entry);
    const ai = (report.aiStatus === 'ok' || report.aiStatus === 'fixture') && report.ai ? report.ai : null;
    if (!ai) return sendError(reply, 409, { code: 'not_ready', error: 'The AI ideas are not ready yet.' });
    const idea = ai.opportunities[ideaIndex];
    if (!idea) return sendError(reply, 400, { code: 'bad_request', error: 'Bad request.' });
    if (session.feedbackWrites >= FEEDBACK_WRITES_PER_IDEA * ai.opportunities.length) {
      return sendError(reply, 429, { code: 'rate_limited', error: 'Too many requests. Please try again later.' });
    }
    session.feedbackWrites++;

    const auditId = report.auditId;
    const s = sessionHash(body.session);
    const recorded: FeedbackVote = vote ?? 'clear';
    try {
      await deps.store.append({
        v: 1,
        t: new Date(deps.now()).toISOString(),
        a: auditId,
        s,
        i: ideaIndex,
        vote: recorded,
        src: idea.source === 'industry' ? 'industry' : 'site',
        svc: idea.service.id,
        pat: patternOf(idea),
        ind: ai.industry?.id ?? null,
        dom: report.domain,
        title: feedbackTitle(idea.title),
        // Search results this idea cites (Phase 5).
        ex: idea.basis.filter((b) => b.kind === 'source').length,
      });
    } catch (e) {
      req.log.error({ error: (e as { code?: string }).code ?? (e as Error).name }, 'feedback store failed');
    }
    req.log.info({ auditId, s, i: ideaIndex, vote: recorded }, 'idea_feedback');
    return reply.code(204).send();
  });

  const postOnly = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', 'POST').send({ code: 'bad_request', error: 'Method not allowed.' });
  app.route({ method: ['GET', 'PUT', 'PATCH', 'DELETE'], url: '/api/feedback', handler: postOnly });
};
