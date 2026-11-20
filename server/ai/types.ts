// Minimal input types for the AI layer. Deliberately not imported from server/cms or
// server/stack: callers map their results onto these.
import type { AiSection, CmsInfo, DetectedTech, IndustryChoice, IndustryId, TeamSize } from '../../shared/types.js';
import type { FetchedPage } from '../site/types.js';

/** Detected tech plus the signature's optional `signals` hint (e.g. "support triage"). */
export type StackTechInput = DetectedTech & { signals?: string };

export interface OpportunitiesInput {
  /** Homepage first, then inner pages. */
  pages: readonly FetchedPage[];
  cms: Pick<CmsInfo, 'platform'>;
  stack: readonly StackTechInput[];
  saasCount: number;
  teamSize?: TeamSize;
  timeSink?: string;
  /** Visitor's own words for their business (sanitised, emails redacted). */
  businessType?: string;
  /** Visitor's chosen industry; absent → the model infers one. */
  industry?: IndustryId;
  /** Tools the team uses day to day (sanitised, emails redacted). */
  tools?: string;
  /** Industry web-search results (Amendment 5 Phase 5); absent when search is off. */
  research?: IndustryResearchInput;
}

/** How the research for one audit was obtained (telemetry). 'none' = no industry known. */
export type ResearchCache = 'hit' | 'miss' | 'timeout' | 'negative' | 'capped' | 'error' | 'none';

/** One cleaned search result, numbered for the prompt (S1…S8). Third-party text. */
export interface ResearchSource {
  id: string;
  title: string;
  snippet: string;
  url: string;
  /** Hostname without "www.". */
  domain: string;
}

export interface IndustryResearchInput {
  /** The industry the queries were for (visitor's choice, else the keyword guess). */
  industryId: IndustryId | null;
  cache: ResearchCache;
  /** When the results were fetched; null when there are none. */
  searchedAt: string | null;
  /** Empty when nothing usable came back in time: the prompt then says "none". */
  sources: ResearchSource[];
}

/** Why a model idea was dropped (telemetry only). */
export type OpportunityDropReason =
  | 'noBasis'
  | 'figure'
  | 'banned'
  | 'empty'
  | 'badPattern'
  | 'cap'
  | 'properNoun'
  | 'duplicate';

/** Ids and counts only: never prose. Logged as `ai_opportunities`. */
export interface OpportunityStats {
  raw: number;
  kept: { site: number; industry: number };
  dropped: Record<OpportunityDropReason, number>;
  remaps: { from: string; to: string }[];
  industryId: IndustryChoice;
  industrySource: 'visitor' | 'model' | 'fallback';
  /** Phase 5 grounding: ids and counts only. */
  research: {
    industryId: IndustryId | null;
    cache: ResearchCache | 'off';
    results: number;
    examplesKept: number;
    examplesDropped: number;
    /** The model's industry differed from the searched one: all grounding dropped. */
    mismatch: boolean;
  };
}

export interface OpportunitiesResult {
  status: 'ok' | 'insufficient';
  /** Present for both statuses; `opportunities` is empty when insufficient. */
  ai?: AiSection;
  /** Validation telemetry. Server-side only: never sent to the client. */
  stats?: OpportunityStats;
}
