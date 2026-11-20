// Report view helpers: merging late results, check ordering, summaries. Pure.
import { CHECKS } from '../../shared/checks.js';
import { checkRank } from '../../shared/reportLogic.js';
import type {
  ActionItem,
  AiResult,
  AuditReport,
  BuyerFitResult,
  CheckId,
  CheckResult,
  MeasuredPart,
  CriterionWeight,
  FixItem,
  FixSection,
  Lvl,
  Owner,
  ScoredCriterion,
} from '../../shared/types.js';
import { CHECK_TEXT } from '../content/checkText.js';

/** Applies GET /buyer-fit to the report. Ignores results for a different audit. */
export const mergeBuyerFit = (report: AuditReport, result: BuyerFitResult): AuditReport => {
  if (result.auditId !== report.auditId) return report;
  const ok = (result.buyerFitStatus === 'ok' || result.buyerFitStatus === 'fixture') && !!result.buyerFit;
  return {
    ...report,
    buyerFitStatus: ok ? result.buyerFitStatus : 'unavailable',
    buyerFit: ok ? result.buyerFit : undefined,
    fixFirst: Array.isArray(result.fixFirst) ? result.fixFirst : report.fixFirst,
    ...(result.fixture ? { fixture: true as const } : {}),
  };
};

/** Applies GET /ai to the report. Ignores results for a different audit. */
export const mergeAi = (report: AuditReport, result: AiResult): AuditReport => {
  if (result.auditId !== report.auditId) return report;
  const hasAi = !!result.ai;
  let status: AuditReport['aiStatus'] = result.aiStatus;
  if ((status === 'ok' || status === 'fixture') && !hasAi) status = 'unavailable';
  return {
    ...report,
    aiStatus: status,
    ai: status === 'ok' || status === 'fixture' ? result.ai : undefined,
    ...(result.fixture ? { fixture: true as const } : {}),
  };
};

/** Marks a still-pending part unavailable (used when its GET fails). */
export const markUnavailable = (report: AuditReport, part: 'buyerFit' | 'ai'): AuditReport => {
  if (part === 'buyerFit') {
    return report.buyerFitStatus === 'pending' ? { ...report, buyerFitStatus: 'unavailable' } : report;
  }
  return report.aiStatus === 'pending' ? { ...report, aiStatus: 'unavailable' } : report;
};

export const hasBuyerFit = (r: AuditReport): boolean =>
  (r.buyerFitStatus === 'ok' || r.buyerFitStatus === 'fixture') && !!r.buyerFit;

export const hasAi = (r: AuditReport): boolean => (r.aiStatus === 'ok' || r.aiStatus === 'fixture') && !!r.ai;

/** Number of AI opportunity cards when ready, else null. */
export const aiCount = (r: AuditReport): number | null => (hasAi(r) ? (r.ai?.opportunities.length ?? 0) : null);

export interface SplitChecks {
  /** Fails then warns, each ordered by rank (highest first). */
  toAddress: CheckResult[];
  passed: CheckResult[];
  info: CheckResult[];
}

/** Splits a section's checks for display. */
export const splitChecks = (checks: readonly CheckResult[]): SplitChecks => {
  const known = checks.filter((c) => c.id in CHECKS);
  const issues = known.filter((c) => c.status === 'fail' || c.status === 'warn');
  const order = (c: CheckResult) => (c.status === 'fail' ? 0 : 1);
  const toAddress = issues
    .map((c, i) => ({ c, i }))
    .sort((a, b) => order(a.c) - order(b.c) || checkRank(b.c) - checkRank(a.c) || a.i - b.i)
    .map(({ c }) => c);
  return {
    toAddress,
    passed: known.filter((c) => c.status === 'pass'),
    info: known.filter((c) => c.status === 'info'),
  };
};

export interface SectionSummary {
  fix: number;
  improve: number;
  /** Label of the highest-ranked issue, if any. */
  startWith: string | null;
}

export const sectionSummary = (checks: readonly CheckResult[]): SectionSummary => {
  const { toAddress } = splitChecks(checks);
  const fix = toAddress.filter((c) => c.status === 'fail').length;
  const improve = toAddress.length - fix;
  const ranked = [...toAddress].sort((a, b) => checkRank(b) - checkRank(a));
  const first = ranked[0];
  return { fix, improve, startWith: first ? CHECK_TEXT[first.id].label : null };
};

export interface FixRow {
  key: string;
  section: FixSection;
  title: string;
  detail: string | null;
  impact: Lvl;
  effort: Lvl;
  owner: Owner;
}

/** Resolves FixItems (ids and indices) to display rows; drops any that don't resolve. */
export const resolveFixFirst = (report: AuditReport): FixRow[] => {
  const byId = new Map<CheckId, CheckResult>();
  for (const c of [...report.security.checks, ...report.health.checks]) byId.set(c.id, c);
  const actions: ActionItem[] = hasBuyerFit(report) ? (report.buyerFit?.actions ?? []) : [];
  const rows: FixRow[] = [];
  report.fixFirst.forEach((item: FixItem, i) => {
    if (item.source === 'check' && item.checkId) {
      const meta = CHECKS[item.checkId];
      const text = CHECK_TEXT[item.checkId];
      if (!meta || !text) return;
      rows.push({
        key: `c-${item.checkId}`,
        section: meta.section,
        title: text.action,
        detail: byId.get(item.checkId)?.detail ?? null,
        impact: meta.impact,
        effort: meta.effort,
        owner: meta.owner,
      });
    } else if (item.source === 'ai' && typeof item.actionIndex === 'number') {
      const a = actions[item.actionIndex];
      if (!a) return;
      rows.push({
        key: `a-${item.actionIndex}-${i}`,
        section: 'buyer-fit',
        title: a.text,
        detail: null,
        impact: a.impact,
        effort: a.effort,
        owner: a.owner,
      });
    }
  });
  return rows;
};

const WEIGHT_ORDER: Record<CriterionWeight, number> = { high: 0, medium: 1, low: 2 };

/** Critical first, keeping the model's order within a weight. */
export const sortCriteria = (criteria: readonly ScoredCriterion[]): ScoredCriterion[] =>
  criteria
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (WEIGHT_ORDER[a.c.weight] ?? 3) - (WEIGHT_ORDER[b.c.weight] ?? 3) || a.i - b.i)
    .map(({ c }) => c);

/** Lowest-scoring criterion (first one on ties, critical-first order). */
export const weakestCriterion = (criteria: readonly ScoredCriterion[]): ScoredCriterion | null => {
  let weakest: ScoredCriterion | null = null;
  for (const c of sortCriteria(criteria)) if (!weakest || c.score < weakest.score) weakest = c;
  return weakest;
};

/** "20 November 2026" in UK format; falls back to the raw string. */
export const formatDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

/** Only http(s) links are rendered as links. */
/** Which section's checks each measured part feeds (site files feed both). */
const PART_SECTIONS: Record<MeasuredPart, readonly ('security' | 'health')[]> = {
  'site-files': ['security', 'health'],
  'email-dns': ['security'],
  wordpress: ['security'],
  pagespeed: ['health'],
};

/** True when a measured part feeding this section missed the deadline (its checks are missing). */
export const hasOmittedChecks = (report: Pick<AuditReport, 'omitted'>, section: 'security' | 'health'): boolean =>
  (report.omitted ?? []).some((p) => PART_SECTIONS[p]?.includes(section));

export const safeHref = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
};
