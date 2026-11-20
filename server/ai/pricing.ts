// Per-token prices for cost estimates in logs, the harness and the CRM note (Amendment 4 §5).
//
// USD per million tokens, from platform.claude.com/docs/en/models/overview on 2026-11-20.
// CHECK CURRENT PRICING before relying on these, and add a row when AUDIT_MODEL points at another
// model: an unknown model gives a null cost rather than a guess.
import type { AiUsage } from './client.js';

export interface ModelPrice {
  inputPerMTok: number;
  /** Thinking tokens are billed as output. */
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Claude Sonnet 5.5 (the default model). Cache read is 5% of input; cache write assumed 1.25x
  // input (5-minute cache). This app sets no cache breakpoints.
  'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2.5 },
};

/** Price row for a model id; a dated snapshot id ("claude-sonnet-5-5-20261001") uses its base row. */
export const priceFor = (model: string): ModelPrice | null => {
  if (Object.hasOwn(MODEL_PRICES, model)) return MODEL_PRICES[model]!;
  const base = model.replace(/-\d{8}$/, '');
  return Object.hasOwn(MODEL_PRICES, base) ? MODEL_PRICES[base]! : null;
};

/** Rounds to 6 decimal places (a millionth of a dollar). */
const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

/** Estimated USD cost of one call's usage, or null when the model's price is unknown. */
export const usageCostUsd = (usage: AiUsage, model: string): number | null => {
  const price = priceFor(model);
  if (!price) return null;
  return round6(
    ((usage.input_tokens ?? 0) * price.inputPerMTok +
      (usage.output_tokens ?? 0) * price.outputPerMTok +
      (usage.cache_read_input_tokens ?? 0) * price.cacheReadPerMTok +
      (usage.cache_creation_input_tokens ?? 0) * price.cacheWritePerMTok) /
      1_000_000,
  );
};

/** Running totals for one audit's AI calls (every attempt, retries included). */
export interface AiCostSummary {
  calls: number;
  input: number;
  output: number;
  thinking: number;
  /** null when any call's model has no known price. */
  cost_usd: number | null;
}

export interface UsageTally {
  add(usage: AiUsage, model: string): void;
  summary(): AiCostSummary;
}

export const createUsageTally = (): UsageTally => {
  const s: AiCostSummary = { calls: 0, input: 0, output: 0, thinking: 0, cost_usd: 0 };
  return {
    add(usage, model) {
      s.calls++;
      s.input += usage.input_tokens ?? 0;
      s.output += usage.output_tokens ?? 0;
      s.thinking += usage.thinking_tokens ?? 0;
      const c = usageCostUsd(usage, model);
      s.cost_usd = c === null || s.cost_usd === null ? null : round6(s.cost_usd + c);
    },
    summary: () => ({ ...s }),
  };
};
