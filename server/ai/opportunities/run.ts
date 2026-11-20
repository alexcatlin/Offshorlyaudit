// AI opportunities: one structured call, then server-side validation.
// Throws (AiCallError) on API failure; the orchestrator maps that to 'unavailable'.
import type { CallJson, UsageSink } from '../client.js';
import { createBoundary } from '../prompt.js';
import type { OpportunitiesInput, OpportunitiesResult, OpportunityStats } from '../types.js';
import { buildOpportunitiesPrompt } from './prompt.js';
import { OPPORTUNITIES_SCHEMA } from './schema.js';
import { validateOpportunities } from './validate.js';

// Must stay under AI_SLOT_HOLD_MS (90 s) in server/audit/aiEngine.ts.
export const OPPORTUNITIES_TIMEOUT_MS = 60_000;
export const OPPORTUNITIES_MAX_TOKENS = 4_000;

/** One telemetry line per analysis: ids and counts only, never prose. */
export type OpportunitiesLog = (entry: { msg: 'ai_opportunities' } & Record<string, unknown>) => void;

const defaultLog: OpportunitiesLog = (entry) => console.info(JSON.stringify(entry));

export interface OpportunitiesDeps {
  call: CallJson;
  randomHex?: () => string;
  logMeta?: Record<string, string>;
  onUsage?: UsageSink;
  log?: OpportunitiesLog;
}

const acceptOpportunities = (data: Record<string, unknown>): boolean =>
  Array.isArray(data.opportunities) && typeof data.business === 'object' && data.business !== null;

/** The validation context for an input: the fields validate.ts checks against. */
export const validateContextFor = (input: OpportunitiesInput) => ({
  pages: input.pages,
  stack: input.stack,
  ...(input.teamSize ? { teamSize: input.teamSize } : {}),
  ...(input.timeSink ? { timeSink: input.timeSink } : {}),
  ...(input.tools ? { tools: input.tools } : {}),
  ...(input.businessType ? { businessType: input.businessType } : {}),
  ...(input.industry ? { industry: input.industry } : {}),
  ...(input.research ? { research: input.research } : {}),
});

export const statsLogEntry = (stats: OpportunityStats, logMeta: Record<string, string> = {}) => ({
  msg: 'ai_opportunities' as const,
  ...(logMeta.auditId ? { auditId: logMeta.auditId } : {}),
  ...(logMeta.domain ? { domain: logMeta.domain } : {}),
  raw: stats.raw,
  kept: stats.kept,
  dropped: stats.dropped,
  remaps: stats.remaps,
  industryId: stats.industryId,
  industrySource: stats.industrySource,
  research: {
    industryId: stats.research.industryId,
    cache: stats.research.cache,
    results: stats.research.results,
    examplesKept: stats.research.examplesKept,
    examplesDropped: stats.research.examplesDropped,
  },
  ...(stats.research.mismatch ? { researchMismatch: true } : {}),
});

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
    ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
  });
  const result = validateOpportunities(res.data, validateContextFor(input));
  if (result.stats) {
    try {
      (deps.log ?? defaultLog)(statsLogEntry(result.stats, deps.logMeta));
    } catch {
      // Telemetry must never fail the analysis.
    }
  }
  return result;
};
