// Server-side validation of the opportunities answer (docs/PLAN.md Phase 6). Never trust
// the model: catalogue ids only, server-attached names/URLs/proof text, verified quotes,
// no unsupported figures, a surviving basis for every idea, safe strings and enums.
import {
  isAiServiceId,
  isProofId,
  proofAllowedFor,
  PROOFS,
  SERVICES,
  proofUrl,
  serviceUrl,
} from '../../../shared/services.js';
import type {
  AiOpportunity,
  AiSection,
  AiServiceId,
  Basis,
  Confidence,
  Customers,
  Efficiency,
  EvidenceQuote,
} from '../../../shared/types.js';
import type { FetchedPage } from '../../site/types.js';
import { verifyQuotes } from '../quotes.js';
import { asArray, cleanText, cleanUncapped, coerceEnum, isRecord, proseAllowed } from '../text.js';
import type { OpportunitiesInput, OpportunitiesResult, StackTechInput } from '../types.js';
import { CONFIDENCE_VALUES, CUSTOMER_VALUES, EFFICIENCY_VALUES } from './schema.js';

export const MAX_OPPORTUNITIES = 3;
export const NOT_WORTH_IT_FALLBACK =
  'Work that depends on personal relationships or judgement calls is rarely worth automating first.';
export const MEASURE_FIRST_FALLBACK = 'How long this work takes today, and how often it happens, before building anything.';
export const SUMMARY_FALLBACK = "We couldn't summarise this business confidently from its public pages.";

// Re-exported for existing callers; the filters live in ../text.ts.
export { disallowedFigures, FIGURE_PATTERN } from '../text.js';

/** False when any text has a banned word or an unsupported figure. */
const allAllowed = (texts: readonly string[], allowed: readonly string[]): boolean =>
  texts.every((t) => proseAllowed(t, allowed));

export interface ValidateContext {
  pages: readonly FetchedPage[];
  stack: readonly StackTechInput[];
  teamSize?: OpportunitiesInput['teamSize'];
  timeSink?: string;
}

const validateOne = (raw: Record<string, unknown>, ctx: ValidateContext): AiOpportunity | null => {
  // Basis: verified quotes, detected tech, a real answer.
  const quotes: EvidenceQuote[] = verifyQuotes(raw.quotes, ctx.pages);
  const detected = new Map(ctx.stack.map((t) => [t.id, t]));
  const techIds = [...new Set(asArray(raw.techIds).filter((t): t is string => typeof t === 'string'))].filter((id) =>
    detected.has(id),
  );
  const timeSink = (ctx.timeSink ?? '').trim();
  const answered = Boolean(timeSink || ctx.teamSize);
  const usesAnswer = raw.usesAnswer === true && answered;

  const basis: Basis[] = [
    // Only the verified fields: never the model's own note/effect.
    ...quotes.map((q): Basis => ({ kind: 'quote', quote: q.quote, pageUrl: q.pageUrl, pageLabel: q.pageLabel })),
    ...techIds.map((id): Basis => ({ kind: 'stack', techId: id, name: detected.get(id)?.name ?? id })),
  ];
  if (usesAnswer) basis.push({ kind: 'answer', field: timeSink ? 'timeSink' : 'teamSize' });
  if (!basis.length) return null;

  // Figures: allowed only if verbatim in the visitor's answer or one of this idea's verified quotes.
  // Banned security words: never in model prose. Either drops the idea.
  const allowed = [timeSink, ...quotes.map((q) => q.quote)].filter(Boolean);
  const uncapped = [raw.title, raw.process, raw.aiApproach, raw.measureFirst].map(cleanUncapped);
  if (!allAllowed(uncapped, allowed)) return null;

  const title = cleanText(raw.title, { words: 8, chars: 80 });
  const process = cleanText(raw.process, { words: 30, chars: 240 });
  const aiApproach = cleanText(raw.aiApproach, { words: 40, chars: 300 });
  if (!title || !process || !aiApproach) return null;
  const measureFirst = cleanText(raw.measureFirst, { words: 20, chars: 160 }) || MEASURE_FIRST_FALLBACK;

  // Service: catalogue AI ids only, with the mapping rules the server can check.
  const stackBases = basis.filter((b) => b.kind === 'stack').length;
  let serviceId: AiServiceId =
    typeof raw.serviceId === 'string' && isAiServiceId(raw.serviceId) ? raw.serviceId : 'free-ai-consultation';
  if (serviceId === 'ai-saas-enhancer' && stackBases < 2) serviceId = 'free-ai-consultation';
  if (serviceId === 'ai-product-development' && quotes.length === 0) serviceId = 'free-ai-consultation';

  const out: AiOpportunity = {
    title,
    process,
    basis,
    aiApproach,
    efficiency: coerceEnum<Efficiency>(raw.efficiency, EFFICIENCY_VALUES, 'time-per-task'),
    measureFirst,
    confidence: coerceEnum<Confidence>(raw.confidence, CONFIDENCE_VALUES, 'worth-checking'),
    service: { id: serviceId, name: SERVICES[serviceId].name, url: serviceUrl(serviceId) },
  };
  const proofId = raw.proofId;
  if (typeof proofId === 'string' && isProofId(proofId) && proofAllowedFor(proofId, serviceId)) {
    out.proof = { id: proofId, text: PROOFS[proofId].text, url: proofUrl(proofId) };
  }
  return out;
};

export const validateOpportunities = (data: unknown, ctx: ValidateContext): OpportunitiesResult => {
  const raw = isRecord(data) ? data : {};
  const timeSink = (ctx.timeSink ?? '').trim();
  const business = isRecord(raw.business) ? raw.business : {};

  const summaryRaw = cleanUncapped(business.summary);
  const summary =
    summaryRaw && proseAllowed(summaryRaw, [timeSink].filter(Boolean))
      ? cleanText(business.summary, { words: 30, chars: 240 })
      : SUMMARY_FALLBACK;

  const notWorthItRaw = cleanUncapped(raw.notWorthIt);
  const notWorthIt =
    notWorthItRaw && proseAllowed(notWorthItRaw, [timeSink].filter(Boolean))
      ? cleanText(raw.notWorthIt, { words: 30, chars: 240 })
      : NOT_WORTH_IT_FALLBACK;

  const opportunities = asArray(raw.opportunities)
    .filter(isRecord)
    .map((o) => validateOne(o, ctx))
    .filter((o): o is AiOpportunity => o !== null)
    // Stable sort: likely first, model order otherwise.
    .map((o, i) => ({ o, i }))
    .sort((a, b) => Number(b.o.confidence === 'likely') - Number(a.o.confidence === 'likely') || a.i - b.i)
    .map(({ o }) => o)
    .slice(0, MAX_OPPORTUNITIES);

  const ai: AiSection = {
    business: { summary, customers: coerceEnum<Customers>(business.customers, CUSTOMER_VALUES, 'unclear') },
    opportunities,
    notWorthIt,
  };
  return { status: opportunities.length ? 'ok' : 'insufficient', ai };
};
