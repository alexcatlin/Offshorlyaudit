// Maps API failures to friendly visitor text. Pure: no DOM or fetch.
import type { ErrorCode } from '../../shared/types.js';
import { COPY, ERROR_COPY } from '../content/copy.js';

const ERROR_CODES: readonly ErrorCode[] = [
  'bad_request',
  'forbidden',
  'site_not_found',
  'site_unreadable',
  'not_found',
  'rate_limited',
  'busy',
  'server_error',
];

export const isErrorCode = (v: unknown): v is ErrorCode =>
  typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);

/** A failed API call, already turned into visitor-facing text. */
export class AuditError extends Error {
  readonly code: ErrorCode | 'network';
  constructor(code: ErrorCode | 'network', message: string) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

const STATUS_FALLBACK: Record<number, ErrorCode> = {
  400: 'bad_request',
  403: 'forbidden',
  404: 'not_found',
  413: 'bad_request',
  422: 'site_unreadable',
  429: 'rate_limited',
  503: 'busy',
};

/** Seconds from a Retry-After header value (seconds form only), or undefined. */
export const parseRetryAfter = (header: string | null | undefined): number | undefined => {
  if (!header) return undefined;
  const n = Number(header.trim());
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
};

/**
 * Turn a non-2xx response into an AuditError. Uses the body's `code` when valid,
 * else a code inferred from the HTTP status. The server's `error` text is only used
 * by codes whose wording builds on it (site_not_found, site_unreadable).
 */
export const toAuditError = (status: number, body: unknown, retryAfterHeader?: string | null): AuditError => {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const code: ErrorCode = isErrorCode(obj.code) ? obj.code : (STATUS_FALLBACK[status] ?? 'server_error');
  const serverText = typeof obj.error === 'string' ? obj.error.trim().slice(0, 300) : '';
  const retry =
    typeof obj.retryAfterSec === 'number' && Number.isFinite(obj.retryAfterSec)
      ? obj.retryAfterSec
      : parseRetryAfter(retryAfterHeader);
  return new AuditError(code, ERROR_COPY[code](serverText, retry));
};

export const networkError = (): AuditError => new AuditError('network', COPY.errors.network);
