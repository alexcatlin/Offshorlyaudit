// "Save as PDF" print-window protocol (Amendment 5 Phase 1). Pure: no DOM globals; callers
// pass the window pieces in, so tests drive it with fakes.
//
// window.print() inside an iframe is inconsistent (Safari may print the parent page), so the
// report opens a same-origin /print window and hands it the data over postMessage:
//   1. Click → synchronously w = window.open('/print', 'oa-print') (no noopener; same origin).
//   2. /print posts {type:'oa-print:ready'} to window.opener, targetOrigin = location.origin.
//   3. The opener accepts only event.origin === location.origin && event.source === w, and
//      replies {type:'oa-print:data', report, request}.
//   4. /print accepts data only from event.source === window.opener with the same origin.
//   5. No opener, or no data after 3 s → the orphan message.
//   6. Popup blocked (w === null) → in-place window.print().
import type { AuditReport, AuditRequest, Features } from '../../shared/types.js';

export const PRINT_READY = 'oa-print:ready';
export const PRINT_DATA = 'oa-print:data';
export const PRINT_PATH = '/print';
export const PRINT_WINDOW_NAME = 'oa-print';
export const PRINT_ORPHAN_MS = 3_000;
/** The opener stops listening after this long. */
export const OPENER_LISTEN_MS = 60_000;

export interface PrintPayload {
  report: AuditReport;
  request: AuditRequest;
  /** For the footer's privacy wording only. */
  features?: Pick<Features, 'share' | 'shareRetentionDays'> & Partial<Pick<Features, 'email'>>;
}

/** The parts of a MessageEvent the protocol reads. */
export interface BridgeMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Minimal shape check: enough that Report can render without throwing. */
export const isPrintableReport = (r: unknown): r is AuditReport =>
  isObj(r) &&
  typeof r.domain === 'string' &&
  typeof r.auditedAt === 'string' &&
  typeof r.url === 'string' &&
  typeof r.aiStatus === 'string' &&
  typeof r.buyerFitStatus === 'string' &&
  Array.isArray(r.pagesRead) &&
  Array.isArray(r.fixFirst) &&
  Array.isArray(r.attributions) &&
  Array.isArray(r.stack) &&
  isObj(r.cms) &&
  isObj(r.security) &&
  Array.isArray(r.security.checks) &&
  isObj(r.health) &&
  Array.isArray(r.health.checks);

/** Opener side: is this the print window saying it is ready? */
export const isReadyMessage = (ev: BridgeMessage, expected: { origin: string; source: unknown }): boolean =>
  ev.origin === expected.origin && expected.source != null && ev.source === expected.source && isObj(ev.data) && ev.data.type === PRINT_READY;

/** Print side: the payload, or null for a wrong origin, a wrong source or a malformed message. */
export const parseDataMessage = (ev: BridgeMessage, expected: { origin: string; opener: unknown }): PrintPayload | null => {
  if (ev.origin !== expected.origin || expected.opener == null || ev.source !== expected.opener) return null;
  const d = ev.data;
  if (!isObj(d) || d.type !== PRINT_DATA || !isPrintableReport(d.report)) return null;
  if (!isObj(d.request) || typeof d.request.url !== 'string') return null;
  const f = d.features;
  const features =
    isObj(f) && typeof f.share === 'boolean' && typeof f.shareRetentionDays === 'number' && Number.isInteger(f.shareRetentionDays)
      ? { share: f.share, shareRetentionDays: f.shareRetentionDays, ...(f.email === true ? { email: true } : {}) }
      : undefined;
  return { report: d.report, request: d.request as unknown as AuditRequest, ...(features ? { features } : {}) };
};

export const dataMessage = (p: PrintPayload) => ({
  type: PRINT_DATA,
  report: p.report,
  request: p.request,
  ...(p.features
    ? { features: { share: p.features.share, shareRetentionDays: p.features.shareRetentionDays, ...(p.features.email ? { email: true } : {}) } }
    : {}),
});

interface PrintTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface OpenerEnv {
  origin: string;
  open(url: string, name: string): PrintTarget | null;
  addListener(fn: (ev: BridgeMessage) => void): void;
  removeListener(fn: (ev: BridgeMessage) => void): void;
  printInPlace(): void;
  setTimer(fn: () => void, ms: number): unknown;
}

/**
 * Must run synchronously inside the click handler (popup blockers). Returns 'window' when
 * the print window opened, 'in-place' when it was blocked and the page printed itself.
 */
export const openPrintWindow = (payload: PrintPayload, env: OpenerEnv): 'window' | 'in-place' => {
  const w = env.open(PRINT_PATH, PRINT_WINDOW_NAME);
  if (!w) {
    env.printInPlace();
    return 'in-place';
  }
  const onMessage = (ev: BridgeMessage) => {
    if (!isReadyMessage(ev, { origin: env.origin, source: w })) return;
    w.postMessage(dataMessage(payload), env.origin);
    env.removeListener(onMessage);
  };
  env.addListener(onMessage);
  env.setTimer(() => env.removeListener(onMessage), OPENER_LISTEN_MS);
  return 'window';
};

/** Browser wiring for openPrintWindow. */
export const browserOpenerEnv = (printInPlace: () => void): OpenerEnv => {
  const wrap = new Map<(ev: BridgeMessage) => void, (ev: MessageEvent) => void>();
  return {
    origin: window.location.origin,
    open: (url, name) => window.open(url, name),
    addListener: (fn) => {
      const h = (ev: MessageEvent) => fn(ev);
      wrap.set(fn, h);
      window.addEventListener('message', h);
    },
    removeListener: (fn) => {
      const h = wrap.get(fn);
      if (h) window.removeEventListener('message', h);
      wrap.delete(fn);
    },
    printInPlace,
    setTimer: (fn, ms) => setTimeout(fn, ms),
  };
};

/** Resolves after web fonts load and two animation frames, so print sees the final layout. */
export const afterLayout = async (): Promise<void> => {
  try {
    await document.fonts?.ready;
  } catch {
    // fonts API missing: print anyway
  }
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
};
