// Share links (Amendment 5 Phase 3).
//
//   POST   /api/share {session}   → 201 {shareId, url, expiresAt}; idempotent per session
//   DELETE /api/share {session}   → 204; removes the file and clears session.shareId
//   GET    /api/share/:shareId    → SharedReport, or 404 not_found when missing or expired
//   POST   /api/share/email {session, email} → 202 {sent:true, expiresAt} (Phase 4; only when
//          email is configured, otherwise the route does not exist)
//
// The snapshot is built from the server's own AuditEntry (buildSnapshot); the client only
// names its session. A shareId is a read capability: it is never logged (the request
// serializer rewrites it to :id) and these handlers log ids other than it only.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ShareCreated } from '../../shared/types.js';
import type { DailyCounter, SlidingWindowLimiter } from '../http/limits.js';
import { sendError } from '../http/security.js';
import { EMAIL_INVALID_MESSAGE, EMAIL_MAX, emailKey, logHash, validEmail } from '../lead/email.js';
import { buildReportEmail, reportEmailFields } from '../mail/reportEmail.js';
import type { Mailer } from '../mail/types.js';
import type { AuditSession, SessionStore } from '../http/sessions.js';
import { buildSnapshot, NotReadyError } from '../share/snapshot.js';
import { newShareId, SHARE_ID_RE } from '../share/store.js';
import type { ReportStore } from '../share/store.js';
import { SESSION_EXPIRED_MESSAGE } from './feedback.js';

export const ROBOTS_NONE = 'noindex, nofollow, noarchive';
const UNAVAILABLE = 'Sharing is not available right now.';

export interface ShareRouteDeps {
  store: ReportStore;
  sessions: SessionStore;
  /** POST and DELETE: 10/h per IP. */
  writeLimiter: SlidingWindowLimiter;
  /** GET: 60/h per IP. */
  readLimiter: SlidingWindowLimiter;
  ipKey: (req: FastifyRequest) => string;
  checkOrigin: (req: FastifyRequest) => boolean;
  publicOrigin: string | null;
  retentionDays: number;
  now: () => number;
  /** Test seam: the snapshot wait (15 s). */
  snapshotWaitMs?: number;
  /** Phase 4: present only when email is on (provider configured, https PUBLIC_ORIGIN). */
  email?: EmailRouteDeps | null;
}

export interface EmailRouteDeps {
  mailer: Mailer;
  /** The gate's HMAC secret: the recipient must hash to the session's emailKey. */
  secret: string;
  /** 5/h per IP. */
  limiter: SlidingWindowLimiter;
  /** 3 sends per 24 h per email key (across sessions). */
  perKey: SlidingWindowLimiter;
  /** MAIL_DAILY_MAX across all visitors. */
  daily: DailyCounter;
  footerLine: string;
}

/** Same comparison cost whatever the input: both sides are fixed-length digests. */
const sameKey = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export const registerShareRoutes = (app: FastifyInstance, deps: ShareRouteDeps): void => {
  /** One create at a time per session, so a double click can't make two files. */
  const creating = new WeakMap<AuditSession, Promise<ShareCreated | 'not_ready' | 'unavailable'>>();

  const methodNotAllowed = (allow: string) => async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('allow', allow).send({ code: 'bad_request', error: 'Method not allowed.' });

  const rateLimited = (reply: FastifyReply, retryAfterSec: number) =>
    sendError(reply, 429, { code: 'rate_limited', error: 'Too many requests. Please try again later.', retryAfterSec });

  /** Origin, limiter, body and session; replies and returns null when the request stops here. */
  const sessionFor = (req: FastifyRequest, reply: FastifyReply, limiter = deps.writeLimiter): AuditSession | null => {
    if (!deps.checkOrigin(req)) {
      sendError(reply, 403, { code: 'forbidden', error: 'Forbidden.' });
      return null;
    }
    const limit = limiter.hit(deps.ipKey(req));
    if (!limit.ok) {
      rateLimited(reply, limit.retryAfterSec);
      return null;
    }
    const token = req.body && typeof req.body === 'object' ? (req.body as { session?: unknown }).session : undefined;
    if (typeof token !== 'string') {
      sendError(reply, 400, { code: 'bad_request', error: 'Bad request.' });
      return null;
    }
    const session = deps.sessions.get(token);
    if (!session) {
      sendError(reply, 410, { code: 'session_expired', error: SESSION_EXPIRED_MESSAGE });
      return null;
    }
    return session;
  };

  const originFor = (req: FastifyRequest): string => deps.publicOrigin ?? `${req.protocol}://${req.headers.host ?? 'localhost'}`;

  const create = async (req: FastifyRequest, session: AuditSession): Promise<ShareCreated | 'not_ready' | 'unavailable'> => {
    const origin = originFor(req);
    if (session.shareId && session.shareExpiresAt && (await deps.store.get(session.shareId))) {
      return { shareId: session.shareId, url: `${origin}/r/${session.shareId}`, expiresAt: session.shareExpiresAt };
    }
    let snapshot;
    try {
      snapshot = await buildSnapshot(session.entry, {
        shareId: newShareId(),
        now: deps.now(),
        retentionDays: deps.retentionDays,
        ...(deps.snapshotWaitMs !== undefined ? { waitMs: deps.snapshotWaitMs } : {}),
      });
    } catch (e) {
      if (e instanceof NotReadyError) return 'not_ready';
      throw e;
    }
    const put = await deps.store.put(snapshot);
    const auditId = session.entry.report.auditId;
    if (!put.ok) {
      req.log.warn({ auditId, reason: put.reason }, 'share refused');
      return 'unavailable';
    }
    session.shareId = snapshot.shareId;
    session.shareExpiresAt = snapshot.expiresAt;
    req.log.info({ auditId, store: deps.store.kind }, 'report_shared');
    return { shareId: snapshot.shareId, url: `${origin}/r/${snapshot.shareId}`, expiresAt: snapshot.expiresAt };
  };

  /** One create at a time per session (shared by Copy link and Email). */
  const createOnce = (req: FastifyRequest, session: AuditSession) => {
    let p = creating.get(session);
    if (!p) {
      p = create(req, session).finally(() => creating.delete(session));
      creating.set(session, p);
    }
    return p;
  };

  app.post('/api/share', async (req, reply) => {
    const session = sessionFor(req, reply);
    if (!session) return reply;
    const result = await createOnce(req, session);
    if (result === 'not_ready') return sendError(reply, 409, { code: 'not_ready', error: 'The report is still being prepared.' });
    if (result === 'unavailable') return sendError(reply, 503, { code: 'share_unavailable', error: UNAVAILABLE });
    return reply.code(201).send(result);
  });

  if (deps.email) registerEmailRoute(deps.email);

  function registerEmailRoute(mail: EmailRouteDeps): void {
    /** Sessions with a send in flight: a second click gets already_sent, never a second email. */
    const sending = new WeakSet<AuditSession>();

    app.post('/api/share/email', async (req, reply) => {
      const session = sessionFor(req, reply, mail.limiter);
      if (!session) return reply;
      const body = req.body as { session: string; email?: unknown };
      if (typeof body.email !== 'string' || !body.email.trim() || body.email.length > EMAIL_MAX) {
        return sendError(reply, 400, { code: 'bad_request', error: 'Bad request.' });
      }
      // Syntax first, with the gate's rule: canonicalEmail splits at the last @ and drops "+tag",
      // so a list or display-name string could otherwise hash to the gate key and reach the
      // provider as `to`. Only this trimmed, validated value is ever sent to.
      const email = validEmail(body.email);
      if (!email) return sendError(reply, 400, { code: 'email_invalid', error: EMAIL_INVALID_MESSAGE });
      // The recipient can only be the address this report was requested with. The address is
      // used for this one send only: never stored, never logged (logs carry the key prefix).
      const key = emailKey(mail.secret, email);
      if (!sameKey(key, session.emailKey)) return sendError(reply, 403, { code: 'forbidden', error: 'Forbidden.' });
      const meta = { auditId: session.entry.report.auditId, emailHash: logHash(key) };
      if (session.emailSent || sending.has(session)) {
        return sendError(reply, 409, { code: 'already_sent', error: 'This report has already been emailed.' });
      }
      const perKey = mail.perKey.hit(key);
      if (!perKey.ok) {
        return sendError(reply, 429, { code: 'rate_limited', error: 'Too many requests. Please try again later.', retryAfterSec: perKey.retryAfterSec });
      }
      if (!mail.daily.tryTake()) {
        mail.perKey.refund(key);
        req.log.warn(meta, 'report_email daily cap reached');
        return sendError(reply, 503, { code: 'busy', error: 'Email is busy right now. Please copy the link instead.' });
      }
      sending.add(session);
      try {
        const created = await createOnce(req, session);
        if (created === 'not_ready' || created === 'unavailable') {
          mail.perKey.refund(key);
          mail.daily.refund();
          return created === 'not_ready'
            ? sendError(reply, 409, { code: 'not_ready', error: 'The report is still being prepared.' })
            : sendError(reply, 503, { code: 'share_unavailable', error: UNAVAILABLE });
        }
        const report = await deps.store.get(created.shareId);
        if (!report) {
          mail.perKey.refund(key);
          mail.daily.refund();
          return sendError(reply, 503, { code: 'share_unavailable', error: UNAVAILABLE });
        }
        const message = buildReportEmail({
          ...reportEmailFields(report.report),
          url: created.url,
          expiresAt: created.expiresAt,
          footerLine: mail.footerLine,
        });
        const result = await mail.mailer.send({
          to: email,
          ...message,
          // Per session and share: a retry of the same send never produces a second email, and
          // a new share (after Delete link) is a different send.
          idempotencyKey: createHash('sha256').update(`${body.session}:${created.shareId}`).digest('hex'),
        });
        if (!result.ok) {
          req.log.warn({ ...meta, status: 'failed', providerStatus: result.status }, 'report_email');
          return sendError(reply, 502, { code: 'email_failed', error: 'The email could not be sent.' });
        }
        session.emailSent = true;
        req.log.info({ ...meta, status: 'sent' }, 'report_email');
        return reply.code(202).send({ sent: true, expiresAt: created.expiresAt });
      } finally {
        sending.delete(session);
      }
    });
    app.route({ method: ['GET', 'PUT', 'PATCH', 'DELETE'], url: '/api/share/email', handler: methodNotAllowed('POST') });
  }

  app.delete('/api/share', async (req, reply) => {
    const session = sessionFor(req, reply);
    if (!session) return reply;
    const id = session.shareId;
    if (id) await deps.store.delete(id);
    delete session.shareId;
    delete session.shareExpiresAt;
    if (id) req.log.info({ auditId: session.entry.report.auditId }, 'report_share_deleted');
    return reply.code(204).send();
  });

  app.get<{ Params: { shareId: string } }>('/api/share/:shareId', async (req, reply) => {
    reply.header('x-robots-tag', ROBOTS_NONE);
    if (!deps.checkOrigin(req)) return sendError(reply, 403, { code: 'forbidden', error: 'Forbidden.' });
    const limit = deps.readLimiter.hit(deps.ipKey(req));
    if (!limit.ok) return rateLimited(reply, limit.retryAfterSec);
    const id = req.params.shareId;
    const report = SHARE_ID_RE.test(id) ? await deps.store.get(id) : null;
    if (!report) return sendError(reply, 404, { code: 'not_found', error: 'This report link has expired or been deleted.' });
    return reply.send(report);
  });

  app.route({ method: ['GET', 'PUT', 'PATCH'], url: '/api/share', handler: methodNotAllowed('POST, DELETE') });
  app.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE'], url: '/api/share/:shareId', handler: methodNotAllowed('GET') });
};
