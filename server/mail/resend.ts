// Resend adapter (Amendment 5 Phase 4). The only file that knows Resend's API shape.
//
// Verified against resend.com/docs (2026-11-20):
//   POST https://api.resend.com/emails, `Authorization: Bearer <key>`, JSON body.
//   A User-Agent header is required (requests without one get 403).
//   Body: from ("Name <addr>" allowed), to (string or string[]), subject, html, text, reply_to.
//   200 → {"id": "<uuid>"}.
//   Idempotency-Key header: 1–256 characters, kept 24 h. Same key + different body → 409
//   invalid_idempotent_request; same key still in progress → 409 concurrent_idempotent_requests.
//   Rate limit 10 requests/s per team: 429 with a `retry-after` header (seconds). 429 is also used
//   for daily/monthly quota exhaustion; the error JSON's field names are not documented, so the
//   retry decision uses the status and `retry-after` only, and the body is never read or logged.
//   Open/click tracking is a per-domain setting (off by default): nothing to send per request.
//
// Retry policy: one retry on 5xx, network failure/timeout, or 429 with a `retry-after` of at most
// 3 s (honoured). A 429 without one, or asking for longer, is most likely a quota and is not
// retried. Other 4xx (409 included) are final.
import type { MailMessage, MailResult, Mailer } from './types.js';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/**
 * Wire name of the Reply-To field. The docs' examples use the SDK's camelCase `replyTo`; the REST
 * body is snake_case like the rest of the API. Confirm with the first live send.
 */
export const RESEND_REPLY_TO_FIELD = 'reply_to';
export const MAIL_TIMEOUT_MS = 10_000;
export const MAX_RETRY_AFTER_MS = 3_000;
/** Pause before retrying a 5xx or network failure. */
export const RETRY_PAUSE_MS = 500;

export type MailFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface ResendOptions {
  apiKey: string;
  from: string;
  replyTo?: string | null;
  /** e.g. offshorly-audit/0.1.0 */
  userAgent: string;
  fetchImpl?: MailFetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Attempt = { kind: 'ok' } | { kind: 'status'; status: number; retryAfterMs: number | null } | { kind: 'network' };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `retry-after` in whole or decimal seconds; an HTTP date or anything else → null. */
export const parseRetryAfter = (v: string | null): number | null => {
  if (v === null || !/^\d{1,6}(\.\d{1,3})?$/.test(v.trim())) return null;
  return Math.round(Number(v.trim()) * 1000);
};

export const createResendMailer = (opts: ResendOptions): Mailer => {
  const fetchImpl: MailFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? MAIL_TIMEOUT_MS;

  const attempt = async (m: MailMessage): Promise<Attempt> => {
    const body: Record<string, unknown> = { from: opts.from, to: [m.to], subject: m.subject, html: m.html, text: m.text };
    if (opts.replyTo) body[RESEND_REPLY_TO_FIELD] = opts.replyTo;
    let res: Response;
    try {
      res = await fetchImpl(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': opts.userAgent,
          'idempotency-key': m.idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // The error may carry request details; it is dropped, never logged or rethrown.
      return { kind: 'network' };
    }
    // The body (the message id, or an error naming the recipient) is never read.
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }
    if (res.status >= 200 && res.status < 300) return { kind: 'ok' };
    return { kind: 'status', status: res.status, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) };
  };

  const toResult = (a: Attempt): MailResult => (a.kind === 'ok' ? { ok: true } : { ok: false, status: a.kind === 'network' ? 'network' : a.status });

  return {
    name: 'resend',
    async send(m) {
      const first = await attempt(m);
      if (first.kind === 'ok') return { ok: true };
      let waitMs: number | null = null;
      if (first.kind === 'network' || first.status >= 500) waitMs = RETRY_PAUSE_MS;
      else if (first.status === 429 && first.retryAfterMs !== null && first.retryAfterMs <= MAX_RETRY_AFTER_MS) waitMs = first.retryAfterMs;
      if (waitMs === null) return toResult(first);
      await sleep(waitMs);
      return toResult(await attempt(m));
    },
  };
};
