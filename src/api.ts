// Client for the audit API. Same-origin only.
//   POST   /api/audit                     → AuditStartResponse (report + session + features)
//   GET    /api/audit/:auditId/buyer-fit  → BuyerFitResult
//   GET    /api/audit/:auditId/ai         → AiResult
//   POST   /api/feedback                  → 204
//   POST   /api/share / DELETE /api/share → ShareCreated / 204
//   GET    /api/share/:shareId            → SharedReport
//   POST   /api/share/email               → EmailReportSent (202; Phase 4)
//   POST   /api/event                     → 204 (counted as a daily total; spec 001)
// The session token only ever travels in a JSON body, never in a URL.
import type {
  AiResult,
  AuditRequest,
  AuditStartResponse,
  BuyerFitResult,
  EmailReportBody,
  EmailReportSent,
  EventBody,
  EventName,
  FeedbackBody,
  Placement,
  ShareCreated,
  SharedReport,
} from '../shared/types.js';
import { BLOCKED_PLACEMENT } from '../shared/types.js';
import { networkError, toAuditError } from './lib/errors.js';

export interface HttpResult {
  status: number;
  body: unknown;
  retryAfter?: string | null;
}

export type Method = 'GET' | 'POST' | 'DELETE';

/** Transport seam: the real fetch, or the dev mock. */
export type Transport = (method: Method, path: string, body?: unknown) => Promise<HttpResult>;

const TIMEOUT_MS: Record<Method, number> = { POST: 90_000, GET: 100_000, DELETE: 20_000 };

const fetchTransport: Transport = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive: path === '/api/event',
    signal: AbortSignal.timeout(TIMEOUT_MS[method]),
  });
  let parsed: unknown = null;
  if (res.status !== 204) {
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
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

const send = async (method: Method, path: string, body?: unknown): Promise<HttpResult> => {
  const transport = await getTransport();
  try {
    return await transport(method, path, body);
  } catch {
    throw networkError();
  }
};

const call = async <T>(method: Method, path: string, body?: unknown): Promise<T> => {
  const res = await send(method, path, body);
  if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === 'object') return res.body as T;
  throw toAuditError(res.status, res.body, res.retryAfter);
};

/** For 204 endpoints. */
const callNoContent = async (method: Method, path: string, body?: unknown): Promise<void> => {
  const res = await send(method, path, body);
  if (res.status >= 200 && res.status < 300) return;
  throw toAuditError(res.status, res.body, res.retryAfter);
};

export const startAudit = (req: AuditRequest): Promise<AuditStartResponse> => call<AuditStartResponse>('POST', '/api/audit', req);

export const fetchBuyerFit = (auditId: string): Promise<BuyerFitResult> =>
  call<BuyerFitResult>('GET', `/api/audit/${encodeURIComponent(auditId)}/buyer-fit`);

export const fetchAi = (auditId: string): Promise<AiResult> =>
  call<AiResult>('GET', `/api/audit/${encodeURIComponent(auditId)}/ai`);

export const sendFeedback = (session: string, ideaIndex: number, vote: FeedbackBody['vote']): Promise<void> =>
  callNoContent('POST', '/api/feedback', { session, ideaIndex, vote } satisfies FeedbackBody);

export const createShare = (session: string): Promise<ShareCreated> => call<ShareCreated>('POST', '/api/share', { session });

export const deleteShare = (session: string): Promise<void> => callNoContent('DELETE', '/api/share', { session });

/** The email goes in the body (never a URL); the server sends only to the audit's own address. */
export const emailReport = (session: string, email: string): Promise<EmailReportSent> =>
  call<EmailReportSent>('POST', '/api/share/email', { session, email } satisfies EmailReportBody);

export const fetchShared = (shareId: string): Promise<SharedReport> =>
  call<SharedReport>('GET', `/api/share/${encodeURIComponent(shareId)}`);

export { AuditError } from './lib/errors.js';

/** What this page counts as: a direct report (its session), the shared page, or neither. */
type TrackContext = { session: string } | { shared: true } | null;
let trackContext: TrackContext = null;
export const setTrackContext = (c: TrackContext): void => {
  trackContext = c;
};

/**
 * Counts a visitor event (spec 001). Fire and forget: never throws, never delays the click (the
 * booking links open in a new tab), and a blocked or failed call is silent. Nothing about the
 * visitor is sent: the session token proves a live report, the server stores only totals.
 */
export const track = (event: EventName, placement?: Placement): void => {
  let body: EventBody | null = null;
  if (placement === BLOCKED_PLACEMENT) body = { event, placement };
  else if (trackContext && 'session' in trackContext) body = { event, ...(placement ? { placement } : {}), session: trackContext.session };
  else if (trackContext && event === 'cta_click' && placement) body = { event, placement, shared: true };
  if (!body) return;
  void send('POST', '/api/event', body).catch(() => undefined);
};
