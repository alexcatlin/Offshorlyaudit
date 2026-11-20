// Buyer fit: step 1 (criteria + buyer) then step 2 (scored audit), then post-processing.
// Throws (AiCallError or Error) on failure; the orchestrator maps that to 'unavailable'.
import type { BuyerFit, Persona } from '../../../shared/types.js';
import type { FetchedPage } from '../../site/types.js';
import type { CallJson } from '../client.js';
import { createBoundary } from '../prompt.js';
import { postprocessBuyerFit } from './postprocess.js';
import { runStep1 } from './step1.js';
import { runStep2 } from './step2.js';

export interface BuyerFitInput {
  /** Homepage first, then inner pages. */
  pages: readonly FetchedPage[];
  businessType?: string;
  persona?: Partial<Persona>;
}

export interface BuyerFitDeps {
  call: CallJson;
  /** 16 hex chars; injectable for tests. */
  randomHex?: () => string;
  logMeta?: Record<string, string>;
}

export const runBuyerFit = async (input: BuyerFitInput, deps: BuyerFitDeps): Promise<BuyerFit> => {
  if (!input.pages.length) throw new Error('buyerFit: no pages');
  // A fresh boundary per request.
  const common = { call: deps.call, ...(deps.logMeta ? { logMeta: deps.logMeta } : {}) };
  const step1 = await runStep1(input, { ...common, boundary: createBoundary(deps.randomHex) });
  if (!step1.criteria.length) throw new Error('buyerFit: no criteria from step 1');
  const raw = await runStep2(
    { pages: input.pages, framework: step1 },
    { ...common, boundary: createBoundary(deps.randomHex) },
  );
  const given = {
    ...(input.businessType ? { businessType: input.businessType } : {}),
    ...(input.persona ? { persona: input.persona } : {}),
  };
  const result = postprocessBuyerFit(raw, { step1, pages: input.pages, given });
  if (!result.criteria.length) throw new Error('buyerFit: no criteria from step 2');
  return result;
};
