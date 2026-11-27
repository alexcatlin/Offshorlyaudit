// Builds the saved snapshot for a share link (Amendment 5 Phase 3) from the server's own
// AuditEntry. The server never accepts report JSON from a client.
//
// - Waits for buyer fit and the AI ideas (capped at SNAPSHOT_WAIT_MS); still pending →
//   NotReadyError (409 not_ready).
// - Merges the settled results the way reportWithSettled does; any status still 'pending'
//   becomes 'unavailable'.
// - Strips auditId (a cache hit shares it with other visitors).
// - Adds only the AuditRequest fields the report reads. Never the URL query, never lead fields.
import type { AiResult, AuditReport, BuyerFitResult, ShareAnswers, SharedReport } from '../../shared/types.js';
import type { AuditEntry } from '../routes/audit.js';

export const SNAPSHOT_WAIT_MS = 15_000;

export class NotReadyError extends Error {
  constructor() {
    super('not ready');
    this.name = 'NotReadyError';
  }
}

const PENDING = Symbol('pending');

const settle = async <T>(p: Promise<T> | null, ms: number): Promise<T | null | typeof PENDING> => {
  if (!p) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Report with the given settled results applied; anything still pending becomes unavailable. */
export const mergeSettled = (base: AuditReport, bf: BuyerFitResult | null, ai: AiResult | null): AuditReport => {
  let r = base;
  if (r.buyerFitStatus === 'pending') {
    r = bf
      ? { ...r, buyerFitStatus: bf.buyerFitStatus, ...(bf.buyerFit ? { buyerFit: bf.buyerFit } : {}), fixFirst: bf.fixFirst }
      : { ...r, buyerFitStatus: 'unavailable' };
  }
  if (r.aiStatus === 'pending') {
    r = ai ? { ...r, aiStatus: ai.aiStatus, ...(ai.ai ? { ai: ai.ai } : {}) } : { ...r, aiStatus: 'unavailable' };
  }
  return r;
};

export const pickAnswers = (req: AuditEntry['request']): ShareAnswers => {
  const a: ShareAnswers = {};
  if (!req) return a;
  if (req.timeSink) a.timeSink = req.timeSink;
  if (req.tools) a.tools = req.tools;
  if (req.teamSize) a.teamSize = req.teamSize;
  if (req.region) a.region = req.region;
  if (req.industry) a.industry = req.industry;
  if (req.businessType) a.businessType = req.businessType;
  return a;
};

export interface SnapshotOptions {
  shareId: string;
  now: number;
  retentionDays: number;
  waitMs?: number;
}

/**
 * The audited URL can carry the visitor's query string (it is part of the cache key). A saved
 * report keeps origin + path only: every exact occurrence of the full URL (report.url, the
 * homepage entry in pagesRead, quote page links) is replaced with the bare one.
 */
export const stripUrlQuery = (report: Omit<AuditReport, 'auditId'>): Omit<AuditReport, 'auditId'> => {
  let bare: string;
  try {
    const u = new URL(report.url);
    if (!u.search && !u.hash) return report;
    u.search = '';
    u.hash = '';
    bare = u.toString();
  } catch {
    return report;
  }
  const needle = JSON.stringify(report.url).slice(1, -1);
  const json = JSON.stringify(report).split(needle).join(JSON.stringify(bare).slice(1, -1));
  return JSON.parse(json) as Omit<AuditReport, 'auditId'>;
};

export const buildSnapshot = async (entry: AuditEntry, opts: SnapshotOptions): Promise<SharedReport> => {
  const waitMs = opts.waitMs ?? SNAPSHOT_WAIT_MS;
  const [bf, ai] = await Promise.all([
    entry.buyerFitResult ?? settle(entry.buyerFit, waitMs),
    entry.aiResult ?? settle(entry.ai, waitMs),
  ]);
  if (bf === PENDING || ai === PENDING) throw new NotReadyError();
  const { auditId: _auditId, ...report } = mergeSettled(entry.report, bf, ai);
  const createdAt = new Date(opts.now).toISOString();
  const expiresAt = new Date(opts.now + opts.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return { v: 1, shareId: opts.shareId, createdAt, expiresAt, report: stripUrlQuery(report), answers: pickAnswers(entry.request) };
};
