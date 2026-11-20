// Buyer fit post-processing (BUILD_GUIDE §5.5). The model's step-2 answer is never
// trusted as-is: names and weights come from step 1 when counts match, scores are clamped,
// every quote is verified, lists are capped and enums coerced.
//
// Honesty filters on model-written prose (never on verified quotes, which are evidence):
// - no banned security words ("vulnerable", "insecure", "hacked", "breach"…);
// - no figure (money, %, multiple, duration) unless it appears in the page text or in what the
//   visitor typed (business type, buyer fields).
// On a hit: a strength, action or mismatch item is dropped; a criterion's reasoning is blanked;
// an evidence note is dropped (the quote stays); a verdict field gets a static fallback.
import { buyerFitScore } from '../../../shared/reportLogic.js';
import type { ActionItem, BuyerFit, CriterionWeight, Lvl, Owner, Persona, ScoredCriterion } from '../../../shared/types.js';
import type { FetchedPage } from '../../site/types.js';
import { verifyQuotes } from '../quotes.js';
import { asArray, cleanText, cleanUncapped, coerceEnum, hasBannedWords, isRecord, proseAllowed } from '../text.js';
import type { Step1Result } from './step1.js';

export const MAX_STRENGTHS = 3;
export const MAX_ACTIONS = 6;
export const MAX_CRITERIA = 6;
export const MAX_MISMATCHES = 3;

export const VERDICT_SUMMARY_FALLBACK = "We couldn't sum up this buyer's first impression confidently from these pages.";
export const BRUTAL_TRUTH_FALLBACK = 'See the criteria below for where this buyer would hesitate.';

const LVLS: readonly Lvl[] = ['high', 'medium', 'low'];
const OWNERS: readonly Owner[] = ['leadership', 'marketing', 'developer'];

/** Integer 0–10. Non-numbers → 0. */
export const clampScore = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.min(10, Math.max(0, Math.round(n)));
};

/** Model prose → display string, or '' when it fails the honesty filters. */
const prose = (value: unknown, caps: { words: number; chars: number }, allowed: readonly string[]): string => {
  const uncapped = cleanUncapped(value);
  if (!uncapped || !proseAllowed(uncapped, allowed)) return '';
  return cleanText(value, caps);
};

const cleanEvidence = (raw: unknown, pages: readonly FetchedPage[], allowed: readonly string[]) =>
  verifyQuotes(raw, pages).map((q) => {
    // The quote is verified page text and stays as is; the note is model prose.
    const note = q.note ? prose(q.note, { words: 14, chars: 140 }, allowed) : '';
    const { note: _drop, ...rest } = q;
    return note ? { ...rest, note } : rest;
  });

export const postprocessCriteria = (
  raw: unknown,
  step1Criteria: Step1Result['criteria'],
  pages: readonly FetchedPage[],
  allowed: readonly string[] = pages.map((p) => p.text),
): ScoredCriterion[] => {
  const items = asArray(raw).filter(isRecord);
  const fromStep1 = items.length === step1Criteria.length;
  return items.slice(0, MAX_CRITERIA).map((c, i) => {
    const s1 = fromStep1 ? step1Criteria[i] : undefined;
    const evidence = cleanEvidence(c.evidence, pages, allowed);
    const modelName = cleanText(c.name, { words: 6, chars: 60 });
    const out: ScoredCriterion = {
      name: s1 ? s1.name : (modelName && !hasBannedWords(modelName) ? modelName : '') || `Criterion ${i + 1}`,
      score: clampScore(c.score),
      reasoning: prose(c.reasoning, { words: 80, chars: 600 }, allowed),
      weight: s1 ? s1.weight : coerceEnum<CriterionWeight>(c.weight, LVLS, 'medium'),
    };
    if (evidence.length) out.evidence = evidence;
    return out;
  });
};

export const postprocessActions = (raw: unknown, allowed: readonly string[] = []): ActionItem[] =>
  asArray(raw)
    .filter(isRecord)
    .map((a) => ({
      text: prose(a.text, { words: 45, chars: 300 }, allowed),
      horizon: coerceEnum<'now' | 'later'>(a.horizon, ['now', 'later'], 'now'),
      impact: coerceEnum<Lvl>(a.impact, LVLS, 'medium'),
      effort: coerceEnum<Lvl>(a.effort, LVLS, 'medium'),
      owner: coerceEnum<Owner>(a.owner, OWNERS, 'marketing'),
    }))
    .filter((a) => a.text)
    .slice(0, MAX_ACTIONS);

export interface PostprocessContext {
  step1: Step1Result;
  pages: readonly FetchedPage[];
  /** What the visitor typed; figures in it may be repeated. */
  given?: { businessType?: string; persona?: Partial<Persona> };
}

/** Where a figure may come from: every page we read, plus the visitor's own words. */
export const figureSources = (pages: readonly FetchedPage[], given: PostprocessContext['given']): string[] => [
  ...pages.flatMap((p) => [p.title, p.description, p.text]),
  given?.businessType ?? '',
  ...Object.values(given?.persona ?? {}).map((v) => v ?? ''),
].filter(Boolean);

export const postprocessBuyerFit = (data: Record<string, unknown>, { step1, pages, given }: PostprocessContext): BuyerFit => {
  const allowed = figureSources(pages, given);
  const verdict = isRecord(data.verdict) ? data.verdict : {};
  const criteria = postprocessCriteria(data.criteria, step1.criteria, pages, allowed);
  return {
    businessType: step1.businessType,
    businessTypeInferred: step1.businessTypeInferred,
    persona: { ...step1.persona },
    personaInferred: step1.personaInferred,
    score: buyerFitScore(criteria),
    verdict: {
      summary: prose(verdict.summary, { words: 45, chars: 300 }, allowed) || VERDICT_SUMMARY_FALLBACK,
      brutalTruth: prose(verdict.brutalTruth, { words: 45, chars: 300 }, allowed) || BRUTAL_TRUTH_FALLBACK,
    },
    strengths: asArray(data.strengths)
      .map((s) => prose(s, { words: 40, chars: 280 }, allowed))
      .filter(Boolean)
      .slice(0, MAX_STRENGTHS),
    criteria,
    mismatchIndex: asArray(data.mismatchIndex)
      .filter(isRecord)
      .map((m) => ({
        point: prose(m.point, { words: 16, chars: 120 }, allowed),
        explanation: prose(m.explanation, { words: 60, chars: 400 }, allowed),
      }))
      .filter((m) => m.point && m.explanation)
      .slice(0, MAX_MISMATCHES),
    actions: postprocessActions(data.actions, allowed),
  };
};
