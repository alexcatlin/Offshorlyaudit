// Minimal input types for the AI layer. Deliberately not imported from server/cms or
// server/stack: callers map their results onto these.
import type { AiSection, CmsInfo, DetectedTech, TeamSize } from '../../shared/types.js';
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
}

export interface OpportunitiesResult {
  status: 'ok' | 'insufficient';
  /** Present for both statuses; `opportunities` is empty when insufficient. */
  ai?: AiSection;
}
