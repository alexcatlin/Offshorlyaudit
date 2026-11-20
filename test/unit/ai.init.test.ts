import { describe, expect, it, vi } from 'vitest';
import { initAi } from '../../server/ai/init.js';
import { CONSERVATIVE_SETTINGS, ModelConfigError, probeModel } from '../../server/ai/client.js';
import type { AnthropicLike } from '../../server/ai/client.js';

const fakeAnthropic = (retrieve: () => Promise<unknown>): AnthropicLike => ({
  messages: { create: async () => ({}) },
  models: { retrieve },
});

describe('initAi', () => {
  it('a refused key → AI off, aiConfigError true, no exit', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const logs: string[] = [];
    const anthropic = fakeAnthropic(async () => {
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    });
    const r = await initAi(
      { aiMode: 'live', anthropicApiKey: 'sk-test-bad', auditModel: null },
      { createAnthropic: () => anthropic, probe: (a, m) => probeModel(a, m, { log: () => undefined }), log: (m) => logs.push(m) },
    );
    expect(r).toMatchObject({ ai: null, aiMode: 'off', aiConfigError: true });
    expect(exit).not.toHaveBeenCalled();
    expect(logs[0]).toMatch(/^AI disabled: .*refused the key \(401\)/);
    expect(logs.join('')).not.toContain('sk-test-bad');
    exit.mockRestore();
  });

  it('an unknown model → AI off with aiConfigError', async () => {
    const r = await initAi(
      { aiMode: 'live', anthropicApiKey: 'k', auditModel: 'claude-nope' },
      {
        createAnthropic: () => fakeAnthropic(async () => ({})),
        probe: async () => {
          throw new ModelConfigError('AUDIT_MODEL check failed: model "claude-nope" was not found by the Models API.', 404);
        },
        log: () => undefined,
      },
    );
    expect(r).toMatchObject({ ai: null, aiMode: 'off', aiConfigError: true });
  });

  it('a transient probe failure still starts live, with a background re-probe', async () => {
    const reprobe = vi.fn(() => () => undefined);
    const r = await initAi(
      { aiMode: 'live', anthropicApiKey: 'k', auditModel: null },
      { createAnthropic: () => fakeAnthropic(async () => ({})), probe: async () => CONSERVATIVE_SETTINGS, reprobe, log: () => undefined },
    );
    expect(r.aiMode).toBe('live');
    expect(r.ai?.mode).toBe('live');
    expect(r.aiConfigError).toBe(false);
    expect(reprobe).toHaveBeenCalledTimes(1);
  });

  it('fixture and off modes need no key and make no calls', async () => {
    const createAnthropic = vi.fn();
    expect((await initAi({ aiMode: 'fixture', anthropicApiKey: null, auditModel: null }, { createAnthropic })).ai?.mode).toBe('fixture');
    expect(await initAi({ aiMode: 'off', anthropicApiKey: 'k', auditModel: null }, { createAnthropic })).toMatchObject({ ai: null, aiMode: 'off', aiConfigError: false });
    expect(createAnthropic).not.toHaveBeenCalled();
  });
});
