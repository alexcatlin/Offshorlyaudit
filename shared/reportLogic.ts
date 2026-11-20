// Report calculations shared by server and client (BUILD_GUIDE §6.4).
// Pure functions only: no Node or DOM APIs.
import { CHECKS } from './checks.js';
import type { ActionItem, CheckResult, CriterionWeight, FixItem, FixSection, Lvl, ScoredCriterion } from './types.js';

// ---------- Buyer fit score ----------

/** Critical ×3, important ×2, supporting ×1. */
export const WEIGHT_POINTS: Record<CriterionWeight, number> = { high: 3, medium: 2, low: 1 };

/** Weighted 0–100 buyer-fit score from 0–10 criterion scores, or null with no criteria. */
export const buyerFitScore = (criteria: readonly Pick<ScoredCriterion, 'score' | 'weight'>[]): number | null => {
  const total = criteria.reduce((s, c) => s + (WEIGHT_POINTS[c.weight] ?? 0), 0);
  if (!total) return null;
  const weighted = criteria.reduce((s, c) => s + c.score * (WEIGHT_POINTS[c.weight] ?? 0), 0);
  return Math.round((weighted / total) * 10);
};

export type ScoreBandId = 'strong' | 'credible' | 'losing' | 'not-making-case';

export interface ScoreBand {
  id: ScoreBandId;
  text: string;
}

/** Visitor-facing band for a 0–100 buyer-fit score; null when the score is null. */
export const scoreBand = (score: number | null): ScoreBand | null => {
  if (score === null || !Number.isFinite(score)) return null;
  if (score >= 80) return { id: 'strong', text: 'A strong fit for this buyer' };
  if (score >= 60) return { id: 'credible', text: 'Credible, with gaps this buyer will notice' };
  if (score >= 40) return { id: 'losing', text: 'Losing this buyer to clearer competitors' };
  return { id: 'not-making-case', text: 'Not making the case to this buyer' };
};

export type ScoreColour = 'good' | 'mid' | 'warning' | 'none';

/** Colour bucket for a 0–100 score: ≥80 good, ≥50 mid, else warning; null → none (grey). */
export const scoreColour = (score: number | null): ScoreColour => {
  if (score === null || !Number.isFinite(score)) return 'none';
  if (score >= 80) return 'good';
  if (score >= 50) return 'mid';
  return 'warning';
};

/** Colour bucket for a 0–10 criterion gauge: ≥8 good, ≥5 mid, else warning. */
export const gaugeColour = (score: number | null): ScoreColour => {
  if (score === null || !Number.isFinite(score)) return 'none';
  if (score >= 8) return 'good';
  if (score >= 5) return 'mid';
  return 'warning';
};

// ---------- Fix these first ----------

const POINTS: Record<Lvl, number> = { high: 3, medium: 2, low: 1 };

export const FIX_FIRST_LIMIT = 5;
export const FIX_FIRST_PER_SECTION = 2;
/** Buyer-fit actions win ties against checks. */
export const BUYER_FIT_TIE_BREAK = 0.25;

/** Rank for a warn/fail check: impact×2 − effort, minus 1 if it is only a warning. */
export const checkRank = (check: Pick<CheckResult, 'id' | 'status'>): number => {
  const meta = CHECKS[check.id];
  const base = POINTS[meta.impact] * 2 - POINTS[meta.effort];
  return check.status === 'warn' ? base - 1 : base;
};

/** Rank for a buyer-fit action: impact×2 − effort + 0.25. */
export const actionRank = (action: Pick<ActionItem, 'impact' | 'effort'>): number =>
  (POINTS[action.impact] ?? 1) * 2 - (POINTS[action.effort] ?? 3) + BUYER_FIT_TIE_BREAK;

export interface RankInput {
  /** Security and health checks together; pass/info and non-rankable checks are skipped. */
  checks: readonly Pick<CheckResult, 'id' | 'status'>[];
  /** buyerFit.actions; FixItem.actionIndex points back into this array. */
  buyerFitActions?: readonly Pick<ActionItem, 'impact' | 'effort'>[];
}

/**
 * "Fix these first": top 5 by rank, no more than 2 from any one section
 * (buyer-fit, security, health). Ties keep input order (actions first, then checks).
 * Returns ids and indices only, never wording.
 */
export const rankFixFirst = ({ checks, buyerFitActions = [] }: RankInput): FixItem[] => {
  const candidates: { item: FixItem; rank: number; order: number }[] = [];
  let order = 0;

  buyerFitActions.forEach((action, actionIndex) => {
    candidates.push({
      item: { source: 'ai', section: 'buyer-fit', actionIndex },
      rank: actionRank(action),
      order: order++,
    });
  });

  for (const check of checks) {
    if (check.status !== 'warn' && check.status !== 'fail') continue;
    const meta = CHECKS[check.id];
    if (!meta || !meta.rankable) continue;
    candidates.push({
      item: { source: 'check', section: meta.section, checkId: check.id },
      rank: checkRank(check),
      order: order++,
    });
  }

  candidates.sort((a, b) => b.rank - a.rank || a.order - b.order);

  const perSection: Partial<Record<FixSection, number>> = {};
  const seenChecks = new Set<string>();
  const picked: FixItem[] = [];
  for (const { item } of candidates) {
    if (picked.length >= FIX_FIRST_LIMIT) break;
    if (item.checkId) {
      if (seenChecks.has(item.checkId)) continue;
      seenChecks.add(item.checkId);
    }
    const count = perSection[item.section] ?? 0;
    if (count >= FIX_FIRST_PER_SECTION) continue;
    perSection[item.section] = count + 1;
    picked.push(item);
  }
  return picked;
};
