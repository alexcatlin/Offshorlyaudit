// The two AI analyses behind one seam, so the orchestrator doesn't care whether output is
// live (Anthropic) or fixture (deterministic samples). AI mode `off` = no engine at all.
import type { BuyerFit } from '../../shared/types.js';
import { runBuyerFit } from '../ai/buyerFit/run.js';
import type { BuyerFitInput } from '../ai/buyerFit/run.js';
import type { CallJson, UsageSink } from '../ai/client.js';
import type { Semaphore } from '../http/limits.js';
import { fixtureBuyerFit, fixtureOpportunities } from '../ai/fixture.js';
import { runOpportunities } from '../ai/opportunities/run.js';
import type { OpportunitiesInput, OpportunitiesResult } from '../ai/types.js';

export interface AiEngine {
  mode: 'live' | 'fixture';
  /** Throws on failure; the orchestrator maps that to 'unavailable'. `onUsage` sees every call attempt. */
  buyerFit(input: BuyerFitInput, logMeta: Record<string, string>, onUsage?: UsageSink): Promise<BuyerFit>;
  /** Throws on failure; the orchestrator maps that to 'unavailable'. `onUsage` sees every call attempt. */
  opportunities(input: OpportunitiesInput, logMeta: Record<string, string>, onUsage?: UsageSink): Promise<OpportunitiesResult>;
  /**
   * Present on a concurrency-limited engine: reserves the slots for one audit's two analyses
   * in one step. null = not enough free slots (the audit skips AI). Without `reserve`, the
   * engine is unlimited and is used directly.
   */
  reserve?: () => AiReservation | null;
}

/** Slots held for one audit. `engine` runs each analysis once, on its own slot. */
export interface AiReservation {
  engine: AiEngine;
  /** Frees both slots (idempotent). For backing out before the analyses start, e.g. daily cap hit. */
  release(): void;
}

export const liveEngine = (call: CallJson): AiEngine => ({
  mode: 'live',
  buyerFit: (input, logMeta, onUsage) => runBuyerFit(input, { call, logMeta, ...(onUsage ? { onUsage } : {}) }),
  opportunities: (input, logMeta, onUsage) => runOpportunities(input, { call, logMeta, ...(onUsage ? { onUsage } : {}) }),
});

/** Thrown when an analysis runs without a slot (unreserved, or its slot already used). */
export class AiBusyError extends Error {
  readonly code = 'ai_busy';
  constructor() {
    super('AI busy');
    this.name = 'AiBusyError';
  }
}

/** Thrown when an analysis holds its slot longer than AI_SLOT_HOLD_MS; the slot is freed. */
export class AiSlotTimeoutError extends Error {
  readonly code = 'ai_slot_timeout';
  constructor() {
    super('AI slot held too long');
    this.name = 'AiSlotTimeoutError';
  }
}

/** Slots per audit: buyer fit and opportunities. */
export const AI_SLOTS_PER_AUDIT = 2;

/**
 * Longest an analysis may hold its slot. Above the slowest legitimate run (buyer fit: 25 s +
 * 45 s call budgets; opportunities: 60 s) and the 80 s buyer-fit wait, so it only fires on a
 * hung call.
 */
export const AI_SLOT_HOLD_MS = 90_000;

/**
 * Caps analyses in flight across all audits. Buyer fit makes its two calls one after the
 * other, so N slots means at most N Anthropic calls at once. Slots are reserved per audit
 * (both or none, no queue) and each is freed when its analysis settles or times out.
 */
export const limitAiConcurrency = (engine: AiEngine, slots: Semaphore, holdMs = AI_SLOT_HOLD_MS): AiEngine => {
  const unreserved = async (): Promise<never> => {
    throw new AiBusyError();
  };

  /** One-shot: runs `run` on the slot `release` and frees it on success, failure or timeout. */
  const onSlot =
    <I, O>(release: () => void, run: (input: I, logMeta: Record<string, string>, onUsage?: UsageSink) => Promise<O>) => {
      let used = false;
      return async (input: I, logMeta: Record<string, string>, onUsage?: UsageSink): Promise<O> => {
        if (used) throw new AiBusyError();
        used = true;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AiSlotTimeoutError()), holdMs);
          timer.unref?.();
        });
        try {
          // Promise.resolve().then: a synchronous throw from `run` still lands in finally.
          const work = Promise.resolve().then(() => run(input, logMeta, onUsage));
          work.catch(() => undefined); // a rejection after the timeout must not go unhandled
          return await Promise.race([work, timeout]);
        } finally {
          clearTimeout(timer);
          release();
        }
      };
    };

  return {
    mode: engine.mode,
    buyerFit: unreserved,
    opportunities: unreserved,
    reserve: () => {
      const releases = slots.tryAcquireMany(AI_SLOTS_PER_AUDIT);
      if (!releases) return null;
      const [bfRelease, oppRelease] = releases as [() => void, () => void];
      return {
        engine: {
          mode: engine.mode,
          buyerFit: onSlot(bfRelease, (i: BuyerFitInput, m, u) => engine.buyerFit(i, m, u)),
          opportunities: onSlot(oppRelease, (i: OpportunitiesInput, m, u) => engine.opportunities(i, m, u)),
        },
        release: () => {
          for (const r of releases) r();
        },
      };
    },
  };
};

export const fixtureEngine = (): AiEngine => ({
  mode: 'fixture',
  buyerFit: async (input) => fixtureBuyerFit(input).buyerFit,
  opportunities: async (input) => {
    const { fixture: _fixture, ...result } = fixtureOpportunities(input);
    return result;
  },
  // Fixture output makes no API calls, so there is no usage to report.
});
