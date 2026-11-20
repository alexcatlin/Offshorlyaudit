// AI opportunities: one structured call, then server-side validation.
// Throws (AiCallError) on API failure; the orchestrator maps that to 'unavailable'.
import type { CallJson } from '../client.js';
import { createBoundary } from '../prompt.js';
import type { OpportunitiesInput, OpportunitiesResult } from '../types.js';
import { buildOpportunitiesPrompt } from './prompt.js';
import { OPPORTUNITIES_SCHEMA } from './schema.js';
import { validateOpportunities } from './validate.js';

export const OPPORTUNITIES_TIMEOUT_MS = 45_000;
export const OPPORTUNITIES_MAX_TOKENS = 2_500;

export interface OpportunitiesDeps {
  call: CallJson;
  randomHex?: () => string;
  logMeta?: Record<string, string>;
}

const acceptOpportunities = (data: Record<string, unknown>): boolean =>
  Array.isArray(data.opportunities) && typeof data.business === 'object' && data.business !== null;

export const runOpportunities = async (input: OpportunitiesInput, deps: OpportunitiesDeps): Promise<OpportunitiesResult> => {
  if (!input.pages.length) throw new Error('opportunities: no pages');
  const { system, user } = buildOpportunitiesPrompt(input, createBoundary(deps.randomHex));
  const res = await deps.call({
    system,
    user,
    schema: OPPORTUNITIES_SCHEMA,
    maxTokens: OPPORTUNITIES_MAX_TOKENS,
    timeoutMs: OPPORTUNITIES_TIMEOUT_MS,
    label: 'opportunities',
    accept: acceptOpportunities,
    ...(deps.logMeta ? { logMeta: deps.logMeta } : {}),
  });
  return validateOpportunities(res.data, {
    pages: input.pages,
    stack: input.stack,
    ...(input.teamSize ? { teamSize: input.teamSize } : {}),
    ...(input.timeSink ? { timeSink: input.timeSink } : {}),
  });
};
