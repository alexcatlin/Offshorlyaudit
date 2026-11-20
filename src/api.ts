// Client for the audit API. Same-origin only.
//   POST /api/audit                       → AuditReport (buyer fit and AI may be 'pending')
//   GET  /api/audit/:auditId/buyer-fit    → BuyerFitResult
//   GET  /api/audit/:auditId/ai           → AiResult
import type { AiResult, AuditReport, AuditRequest, BuyerFitResult } from '../shared/types.js';
import { AuditError, networkError, toAuditError } from './lib/errors.js';

export interface HttpResult {
  status: number;
  body: unknown;
  retryAfter?: string | null;
}

/** Transport seam: the real fetch, or the dev mock. */
export type Transport = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<HttpResult>;

const TIMEOUT_MS = { POST: 90_000, GET: 100_000 } as const;

const fetchTransport: Transport = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS[method]),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, retryAfter: res.headers.get('Retry-After') };
};

let transportPromise: Promise<Transport> | null = null;

/**
 * The dev mock is only reachable when Vite's DEV flag is true, so the whole branch
 * (and the dynamic import) is removed from production builds.
 */
const getTransport = (): Promise<Transport> => {
  if (!transportPromise) {
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('mock') === '1') {
      transportPromise = import('./dev/mockApi.js').then((m) => m.createMockTransport(window.location.search));
    } else {
      transportPromise = Promise.resolve(fetchTransport);
    }
  }
  return transportPromise;
};

const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
  const transport = await getTransport();
  let res: HttpResult;
  try {
    res = await transport(method, path, body);
  } catch {
    throw networkError();
  }
  if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === 'object') return res.body as T;
  throw toAuditError(res.status, res.body, res.retryAfter);
};

export const startAudit = (req: AuditRequest): Promise<AuditReport> => call<AuditReport>('POST', '/api/audit', req);

export const fetchBuyerFit = (auditId: string): Promise<BuyerFitResult> =>
  call<BuyerFitResult>('GET', `/api/audit/${encodeURIComponent(auditId)}/buyer-fit`);

export const fetchAi = (auditId: string): Promise<AiResult> =>
  call<AiResult>('GET', `/api/audit/${encodeURIComponent(auditId)}/ai`);

export { AuditError };
