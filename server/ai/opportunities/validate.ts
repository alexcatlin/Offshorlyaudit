// Server-side validation of the opportunities answer (docs/PLAN.md Phase 6, Amendment 4). Never
// trust the model: catalogue ids only, server-attached names/URLs/proof and playbook text,
// verified quotes, no unsupported figures, a surviving basis for every site idea, a valid
// playbook pattern for every industry idea, safe strings and enums.
import {
  findPattern,
  INDUSTRIES,
  isIndustryId,
  OTHER_INDUSTRY,
  OTHER_INDUSTRY_FALLBACK_LABEL,
  patternsFor,
  type IndustryChoice,
} from '../../../shared/industries.js';
import {
  isOpportunityServiceId,
  isProofId,
  proofAllowedFor,
  PROOFS,
  SERVICES,
  proofUrl,
  serviceUrl,
  type OpportunityServiceId,
} from '../../../shared/services.js';
import type {
  AiOpportunity,
  AiSection,
  Basis,
  Confidence,
  Customers,
  Efficiency,
  EvidenceQuote,
  ExampleSource,
  IndustryExample,
} from '../../../shared/types.js';
import type { FetchedPage } from '../../site/types.js';
import type { TechCategory } from '../../stack/signatures.js';
import { verifyQuotes } from '../quotes.js';
import {
  asArray,
  cleanText,
  cleanUncapped,
  coerceEnum,
  disallowedFigures,
  hasAdoptionClaim,
  hasBannedWords,
  isRecord,
  proseAllowed,
  unknownProperNouns,
} from '../text.js';
import type {
  IndustryResearchInput,
  OpportunitiesInput,
  OpportunitiesResult,
  OpportunityDropReason,
  OpportunityStats,
  ResearchSource,
  StackTechInput,
} from '../types.js';
import { CONFIDENCE_VALUES, CUSTOMER_VALUES, EFFICIENCY_VALUES } from './schema.js';

export const MAX_SITE_OPPORTUNITIES = 3;
export const MAX_INDUSTRY_OPPORTUNITIES = 2;
export const MAX_OPPORTUNITIES = MAX_SITE_OPPORTUNITIES + MAX_INDUSTRY_OPPORTUNITIES;
export const NOT_WORTH_IT_FALLBACK =
  'Work that depends on personal relationships or judgement calls is rarely worth automating first.';
export const MEASURE_FIRST_FALLBACK = 'How long this work takes today, and how often it happens, before building anything.';
export const SUMMARY_FALLBACK = "We couldn't summarise this business confidently from its public pages.";
/** Where an unknown, consultation or no-longer-allowed service id lands. */
export const SERVICE_FALLBACK: OpportunityServiceId = 'ai-development-services';
/** Phase 5: industry examples kept, and result ids one item may cite. */
export const MAX_INDUSTRY_EXAMPLES = 3;
export const MAX_SOURCES_PER_ITEM = 2;
/** Stack category (server/stack/signatures.ts) that is context only, never an idea's basis. */
export const FORMS_CATEGORY: TechCategory = 'forms';

// Re-exported for existing callers; the filters live in ../text.ts.
export { disallowedFigures, FIGURE_PATTERN } from '../text.js';

export interface ValidateContext {
  pages: readonly FetchedPage[];
  stack: readonly StackTechInput[];
  teamSize?: OpportunitiesInput['teamSize'];
  timeSink?: string;
  tools?: string;
  businessType?: string;
  industry?: OpportunitiesInput['industry'];
  /** Phase 5 search results given to the model (absent when search is off). */
  research?: IndustryResearchInput;
}

interface ResolvedIndustry {
  id: IndustryChoice;
  label: string;
  inferred: boolean;
  source: OpportunityStats['industrySource'];
}

/**
 * Visitor's choice wins, then a valid model id, else `other` (generic patterns). An `other` label
 * is model prose shown as a badge and heading: it falls back when it has a banned word, a figure,
 * or a capitalised name not found in `labelSources` (which must not include the label itself).
 */
export const resolveIndustry = (
  business: Record<string, unknown>,
  visitor: OpportunitiesInput['industry'],
  labelSources: readonly string[] = [],
): ResolvedIndustry => {
  if (visitor && isIndustryId(visitor)) return { id: visitor, label: INDUSTRIES[visitor].label, inferred: false, source: 'visitor' };
  const raw = typeof business.industryId === 'string' ? business.industryId.trim().toLowerCase() : '';
  if (isIndustryId(raw)) return { id: raw, label: INDUSTRIES[raw].label, inferred: true, source: 'model' };
  const label = cleanText(business.industryLabel, { words: 5, chars: 40 });
  const okLabel =
    label && proseAllowed(label, []) && unknownProperNouns(cleanUncapped(business.industryLabel), labelSources).length === 0
      ? label
      : '';
  return {
    id: OTHER_INDUSTRY,
    label: okLabel || OTHER_INDUSTRY_FALLBACK_LABEL,
    inferred: true,
    source: raw === OTHER_INDUSTRY ? 'model' : 'fallback',
  };
};

/** A raw id fit for a log line: catalogue-like ids pass, anything else is 'invalid'. */
const logId = (v: unknown): string => (typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v) ? v : 'invalid');

type Classified =
  | { kind: 'site'; opp: AiOpportunity; patternId: string | null }
  | { kind: 'industry'; opp: AiOpportunity; patternId: string }
  | { kind: 'drop'; reason: OpportunityDropReason };

interface Shared {
  ctx: ValidateContext;
  industry: ResolvedIndustry;
  patternIds: ReadonlySet<string>;
  /** Words a capitalised name may come from: pages, stack, answers, playbook, services. */
  nameSources: readonly string[];
  remaps: OpportunityStats['remaps'];
  /** Citable search results by id; empty without research or on an industry mismatch. */
  sources: ReadonlyMap<string, ResearchSource>;
}

/** Valid, distinct result ids, at most MAX_SOURCES_PER_ITEM; unknown ids are filtered out. */
const citedSources = (raw: unknown, sources: ReadonlyMap<string, ResearchSource>): ResearchSource[] => {
  if (!sources.size) return [];
  const out: ResearchSource[] = [];
  for (const v of asArray(raw)) {
    if (out.length >= MAX_SOURCES_PER_ITEM) break;
    const id = typeof v === 'string' ? v.trim().toUpperCase() : '';
    const src = sources.get(id);
    if (src && !out.includes(src)) out.push(src);
  }
  return out;
};

/** The visitor-facing source: the title only when it passes the figure and banned-word filters. */
export const exampleSource = (s: ResearchSource): ExampleSource => {
  const titleOk = s.title && !hasBannedWords(s.title) && disallowedFigures(s.title, []).length === 0;
  return { ...(titleOk ? { title: s.title } : {}), domain: s.domain, url: s.url };
};

/** Words a cited result lends to the name check: its title and snippet. */
const citedWords = (cited: readonly ResearchSource[]): string[] => cited.flatMap((c) => [c.title, c.snippet]);

const validateOne = (raw: Record<string, unknown>, sh: Shared): Classified => {
  const { ctx, industry } = sh;
  // Site basis: verified quotes, detected tech, a real answer.
  const quotes: EvidenceQuote[] = verifyQuotes(raw.quotes, ctx.pages);
  const detected = new Map(ctx.stack.map((t) => [t.id, t]));
  // A form builder (Contact Form 7 and the like) shows a form exists, not manual work: never a basis.
  const techIds = [...new Set(asArray(raw.techIds).filter((t): t is string => typeof t === 'string'))].filter(
    (id) => detected.has(id) && detected.get(id)?.category !== FORMS_CATEGORY,
  );
  const timeSink = (ctx.timeSink ?? '').trim();
  const tools = (ctx.tools ?? '').trim();
  const businessType = (ctx.businessType ?? '').trim();
  const answerField: 'timeSink' | 'tools' | 'teamSize' | null = timeSink ? 'timeSink' : tools ? 'tools' : ctx.teamSize ? 'teamSize' : null;
  const usesAnswer = raw.usesAnswer === true && answerField !== null;

  const siteBasis: Basis[] = [
    // Only the verified fields: never the model's own note/effect.
    ...quotes.map((q): Basis => ({ kind: 'quote', quote: q.quote, pageUrl: q.pageUrl, pageLabel: q.pageLabel })),
    ...techIds.map((id): Basis => ({ kind: 'stack', techId: id, name: detected.get(id)?.name ?? id })),
  ];
  if (usesAnswer && answerField) siteBasis.push({ kind: 'answer', field: answerField });

  const patternRaw = typeof raw.patternId === 'string' ? raw.patternId.trim() : '';
  const pattern = patternRaw && sh.patternIds.has(patternRaw) ? findPattern(patternRaw) : undefined;
  const declared = raw.source === 'industry' ? 'industry' : 'site';

  let kind: 'site' | 'industry';
  if (declared === 'site') {
    if (siteBasis.length) kind = 'site';
    else if (pattern) kind = 'industry'; // no site basis, but a valid pattern: an industry idea
    else return { kind: 'drop', reason: 'noBasis' };
  } else {
    if (!pattern) return { kind: 'drop', reason: 'badPattern' };
    kind = 'industry';
  }

  // Phase 5: an industry idea may cite search results; their titles and snippets may then supply
  // names. Site ideas' sourceIds are ignored.
  const cited = kind === 'industry' ? citedSources(raw.sourceIds, sh.sources) : [];
  const itemNames = cited.length ? [...sh.nameSources, ...citedWords(cited)] : sh.nameSources;

  // Industry ideas carry no site evidence, so model prose naming a company or product it can't
  // have read anywhere is dropped. Each field starts a sentence, so a title's first word is skipped.
  if (kind === 'industry') {
    const names = [raw.title, raw.process, raw.aiApproach, raw.measureFirst]
      .map(cleanUncapped)
      .flatMap((t) => unknownProperNouns(t, itemNames));
    if (names.length) return { kind: 'drop', reason: 'properNoun' };
  }

  // Figures: allowed only if verbatim in a visitor answer or one of this idea's verified quotes.
  // Banned security words: never in model prose. Either drops the idea.
  const figureSources = [timeSink, tools, businessType, ...(kind === 'site' ? quotes.map((q) => q.quote) : [])].filter(Boolean);
  const uncapped = [raw.title, raw.process, raw.aiApproach, raw.measureFirst].map(cleanUncapped);
  if (uncapped.some(hasBannedWords)) return { kind: 'drop', reason: 'banned' };
  if (uncapped.some((t) => disallowedFigures(t, figureSources).length > 0)) return { kind: 'drop', reason: 'figure' };

  const title = cleanText(raw.title, { words: 8, chars: 80 });
  const process = cleanText(raw.process, { words: 30, chars: 240 });
  const aiApproach = cleanText(raw.aiApproach, { words: 40, chars: 300 });
  if (!title || !process || !aiApproach) return { kind: 'drop', reason: 'empty' };
  const measureFirst = cleanText(raw.measureFirst, { words: 20, chars: 160 }) || MEASURE_FIRST_FALLBACK;

  // Industry context: general knowledge, so stricter: no figures, no adoption claims or research,
  // no names we can't trace. Any failure blanks the field; the idea stays.
  const ctxRaw = cleanUncapped(raw.industryContext);
  const industryContext =
    ctxRaw &&
    proseAllowed(ctxRaw, figureSources) &&
    !hasAdoptionClaim(ctxRaw) &&
    unknownProperNouns(ctxRaw, itemNames).length === 0
      ? cleanText(raw.industryContext, { words: 35, chars: 260 })
      : '';

  // Service: opportunity ids only, with the mapping rules the server can check.
  const stackBases = siteBasis.filter((b) => b.kind === 'stack').length;
  let serviceId: OpportunityServiceId = isOpportunityServiceId(raw.serviceId) ? raw.serviceId : SERVICE_FALLBACK;
  if (serviceId === 'ai-saas-enhancer' && (kind === 'industry' || stackBases < 2)) serviceId = 'ai-automation';
  if (serviceId === 'ai-product-development' && (kind === 'industry' || quotes.length === 0)) serviceId = SERVICE_FALLBACK;
  if (raw.serviceId !== serviceId) sh.remaps.push({ from: logId(raw.serviceId), to: serviceId });

  const basis: Basis[] =
    kind === 'industry' && pattern
      ? [
          { kind: 'industry', patternId: pattern.id, industryLabel: industry.label, text: pattern.text },
          ...cited.map((c): Basis => ({ kind: 'source', ...exampleSource(c) })),
        ]
      : siteBasis;

  const out: AiOpportunity = {
    title,
    process,
    basis,
    aiApproach,
    efficiency: coerceEnum<Efficiency>(raw.efficiency, EFFICIENCY_VALUES, 'time-per-task'),
    measureFirst,
    // Industry ideas are never more than worth checking: nothing on the site backs them.
    confidence: kind === 'industry' ? 'worth-checking' : coerceEnum<Confidence>(raw.confidence, CONFIDENCE_VALUES, 'worth-checking'),
    service: { id: serviceId, name: SERVICES[serviceId].name, url: serviceUrl(serviceId) },
    source: kind,
    ...(industryContext ? { industryContext } : {}),
  };
  const proofId = raw.proofId;
  if (typeof proofId === 'string' && isProofId(proofId) && proofAllowedFor(proofId, serviceId)) {
    out.proof = { id: proofId, text: PROOFS[proofId].text, url: proofUrl(proofId) };
  }
  return kind === 'industry' && pattern
    ? { kind: 'industry', opp: out, patternId: pattern.id }
    : { kind: 'site', opp: out, patternId: pattern?.id ?? null };
};

const emptyDropped = (): Record<OpportunityDropReason, number> => ({
  noBasis: 0,
  figure: 0,
  banned: 0,
  empty: 0,
  badPattern: 0,
  cap: 0,
  properNoun: 0,
  duplicate: 0,
});

/** Stable: likely first, model order otherwise. */
const likelyFirst = <T extends { opp: AiOpportunity }>(items: T[]): T[] =>
  items
    .map((x, i) => ({ x, i }))
    .sort((a, b) => Number(b.x.opp.confidence === 'likely') - Number(a.x.opp.confidence === 'likely') || a.i - b.i)
    .map(({ x }) => x);

/**
 * Phase 5 industry examples: each must cite at least one result actually given; the text passes
 * the banned-word, adoption-claim and figure filters (search snippets are never a figure source),
 * and may name only what the base sources or its own cited results contain. Capped at 3.
 */
const validateExamples = (raw: unknown, sh: Shared): { kept: IndustryExample[]; dropped: number } => {
  const items = asArray(raw).filter(isRecord);
  if (!sh.sources.size) return { kept: [], dropped: items.length };
  const kept: IndustryExample[] = [];
  let dropped = 0;
  for (const item of items) {
    const cited = citedSources(item.sourceIds, sh.sources);
    const text = cleanUncapped(item.text);
    const ok =
      cited.length > 0 &&
      !!text &&
      !hasBannedWords(text) &&
      !hasAdoptionClaim(text) &&
      disallowedFigures(text, []).length === 0 &&
      unknownProperNouns(text, [...sh.nameSources, ...citedWords(cited)]).length === 0;
    const capped = ok ? cleanText(item.text, { words: 30, chars: 220 }) : '';
    if (!capped || kept.length >= MAX_INDUSTRY_EXAMPLES) {
      dropped++;
      continue;
    }
    kept.push({ text: capped, sources: cited.map(exampleSource) });
  }
  return { kept, dropped };
};

export const validateOpportunities = (data: unknown, ctx: ValidateContext): OpportunitiesResult => {
  const raw = isRecord(data) ? data : {};
  const business = isRecord(raw.business) ? raw.business : {};
  const answers = [ctx.timeSink, ctx.tools, ctx.businessType].map((s) => (s ?? '').trim()).filter(Boolean);

  const summaryRaw = cleanUncapped(business.summary);
  const summary =
    summaryRaw && proseAllowed(summaryRaw, answers) ? cleanText(business.summary, { words: 30, chars: 240 }) : SUMMARY_FALLBACK;

  const notWorthItRaw = cleanUncapped(raw.notWorthIt);
  const notWorthIt =
    notWorthItRaw && proseAllowed(notWorthItRaw, answers) ? cleanText(raw.notWorthIt, { words: 30, chars: 240 }) : NOT_WORTH_IT_FALLBACK;

  // Words a capitalised name may come from, before the industry label. Pattern words are added per
  // industry below; for `other` they are the generic patterns, the only ones an `other` label sees.
  const baseSources = [
    ...ctx.pages.flatMap((p) => [p.title, p.description, p.text]),
    ...ctx.stack.map((t) => t.name),
    ...answers,
    ...Object.values(SERVICES).map((s) => s.name),
  ];
  const patternWords = (id: IndustryChoice): string[] => patternsFor(id).flatMap((pt) => [pt.title, pt.text]);
  const industry = resolveIndustry(business, ctx.industry, [...baseSources, ...patternWords(OTHER_INDUSTRY)]);
  const patterns = patternsFor(industry.id);
  // A catalogue label is server-owned and may name things; a model-written `other` label is not a
  // source (it would let the model vouch for its own names).
  const nameSources = [
    ...baseSources,
    ...(industry.id === OTHER_INDUSTRY ? [] : [industry.label]),
    ...patternWords(industry.id),
  ];
  // Phase 5: results count only for the industry they were searched for. A different resolved
  // industry (e.g. a wrong keyword guess) drops every example and source basis.
  const research = ctx.research;
  const searched = research && research.industryId && research.sources.length ? research : null;
  const mismatch = !!searched && searched.industryId !== industry.id;
  const sources = new Map<string, ResearchSource>(searched && !mismatch ? searched.sources.map((r) => [r.id, r]) : []);
  const shared: Shared = {
    ctx,
    industry,
    patternIds: new Set(patterns.map((pt) => pt.id)),
    nameSources,
    remaps: [],
    sources,
  };

  const dropped = emptyDropped();
  const items = asArray(raw.opportunities).filter(isRecord);
  const site: Extract<Classified, { kind: 'site' }>[] = [];
  const ind: Extract<Classified, { kind: 'industry' }>[] = [];
  for (const item of items) {
    const c = validateOne(item, shared);
    if (c.kind === 'drop') dropped[c.reason]++;
    else if (c.kind === 'site') site.push(c);
    else ind.push(c);
  }

  const keptSite = likelyFirst(site).slice(0, MAX_SITE_OPPORTUNITIES);
  dropped.cap += site.length - keptSite.length;

  // An industry idea repeating a pattern a kept site idea already cites (or another industry idea
  // already used) adds nothing.
  const cited = new Set(keptSite.map((s) => s.patternId).filter((p): p is string => !!p));
  const uniqueInd: typeof ind = [];
  for (const c of ind) {
    if (cited.has(c.patternId)) {
      dropped.duplicate++;
      continue;
    }
    cited.add(c.patternId);
    uniqueInd.push(c);
  }
  const keptInd = uniqueInd.slice(0, MAX_INDUSTRY_OPPORTUNITIES);
  dropped.cap += uniqueInd.length - keptInd.length;

  const opportunities = [...keptSite.map((c) => c.opp), ...keptInd.map((c) => c.opp)];
  const examples = validateExamples(raw.industryExamples, shared);

  const ai: AiSection = {
    business: { summary, customers: coerceEnum<Customers>(business.customers, CUSTOMER_VALUES, 'unclear') },
    industry: { id: industry.id, label: industry.label, inferred: industry.inferred },
    opportunities,
    notWorthIt,
    ...(examples.kept.length ? { industryExamples: examples.kept } : {}),
    // Disclosed whenever results went to the model, even if none were used.
    ...(searched?.industryId && searched.searchedAt
      ? { research: { industryId: searched.industryId, label: INDUSTRIES[searched.industryId].label, searchedAt: searched.searchedAt } }
      : {}),
  };
  const stats: OpportunityStats = {
    raw: items.length,
    kept: { site: keptSite.length, industry: keptInd.length },
    dropped,
    remaps: shared.remaps,
    industryId: industry.id,
    industrySource: industry.source,
    research: {
      industryId: research?.industryId ?? null,
      cache: research?.cache ?? 'off',
      results: research?.sources.length ?? 0,
      examplesKept: examples.kept.length,
      examplesDropped: examples.dropped,
      mismatch,
    },
  };
  return { status: opportunities.length ? 'ok' : 'insufficient', ai, stats };
};
