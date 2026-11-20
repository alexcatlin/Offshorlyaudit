import { describe, expect, it, vi } from 'vitest';
import { createJsonCaller } from '../../server/ai/client.js';
import { createUsageTally, priceFor, usageCostUsd } from '../../server/ai/pricing.js';

describe('pricing', () => {
  it('estimates cost from usage for a known model (thinking billed inside output)', () => {
    // 10,000 in × $2/M + 2,000 out × $10/M = $0.02 + $0.02
    expect(usageCostUsd({ input_tokens: 10_000, output_tokens: 2_000, thinking_tokens: 500 }, 'claude-sonnet-5-5')).toBe(0.04);
    expect(usageCostUsd({ cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }, 'claude-sonnet-5-5')).toBe(2.6);
    expect(usageCostUsd({}, 'claude-sonnet-5-5')).toBe(0);
  });

  it('a dated snapshot uses its base row; an unknown model gives null, never a guess', () => {
    expect(priceFor('claude-sonnet-5-5-20261001')).toEqual(priceFor('claude-sonnet-5-5'));
    expect(priceFor('some-other-model')).toBeNull();
    expect(usageCostUsd({ input_tokens: 100 }, 'some-other-model')).toBeNull();
    expect(priceFor('__proto__')).toBeNull();
  });

  it('tally sums every call; any unknown model makes the total null', () => {
    const t = createUsageTally();
    t.add({ input_tokens: 1000, output_tokens: 100, thinking_tokens: 40 }, 'claude-sonnet-5-5');
    t.add({ input_tokens: 2000, output_tokens: 200 }, 'claude-sonnet-5-5');
    expect(t.summary()).toEqual({ calls: 2, input: 3000, output: 300, thinking: 40, cost_usd: 0.009 });
    t.add({ input_tokens: 1 }, 'mystery');
    expect(t.summary().cost_usd).toBeNull();
    expect(t.summary().calls).toBe(3);
  });
});

describe('ai_call log and usage sink', () => {
  it('each attempt logs cost_usd and feeds the sink, retries included', async () => {
    const ok = { content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 1000, output_tokens: 100 }, stop_reason: 'end_turn' };
    const bad = { content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 500, output_tokens: 50 }, stop_reason: 'end_turn' };
    const create = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(ok);
    const logs: Record<string, unknown>[] = [];
    const seen: number[] = [];
    const caller = createJsonCaller({ anthropic: { messages: { create } }, model: 'claude-sonnet-5-5', log: (e) => logs.push(e) });
    await caller.callJson({
      system: 's',
      user: 'u',
      schema: {},
      maxTokens: 100,
      timeoutMs: 10_000,
      label: 't',
      onUsage: (u) => seen.push(u.input_tokens ?? 0),
    });
    expect(seen).toEqual([500, 1000]);
    const usageLines = logs.filter((l) => l.usage);
    expect(usageLines.map((l) => l.cost_usd)).toEqual([0.0015, 0.003]);
  });

  it('a throwing sink never breaks the call', async () => {
    const ok = { content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 1 }, stop_reason: 'end_turn' };
    const caller = createJsonCaller({ anthropic: { messages: { create: async () => ok } }, model: 'm', log: () => undefined });
    const res = await caller.callJson({ system: 's', user: 'u', schema: {}, maxTokens: 10, timeoutMs: 5_000, label: 't', onUsage: () => { throw new Error('x'); } });
    expect(res.data).toEqual({ a: 1 });
  });
});
