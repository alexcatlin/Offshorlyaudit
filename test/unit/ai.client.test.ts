import { describe, expect, it } from 'vitest';
import {
  AiCallError,
  CONSERVATIVE_SETTINGS,
  createJsonCaller,
  DEFAULT_MODEL,
  extractJson,
  ModelConfigError,
  OUTPUT_TOOL_NAME,
  probeModel,
  reprobeInBackground,
  settingsFromModelInfo,
  THINKING_HEADROOM_TOKENS,
  type AnthropicLike,
  type JsonRequest,
  type ModelSettings,
} from '../../server/ai/client.js';

class FakeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const textMessage = (text: string, stop = 'end_turn') => ({
  content: [{ type: 'text', text }],
  stop_reason: stop,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
});

const toolMessage = (input: unknown) => ({
  content: [{ type: 'tool_use', id: 't1', name: OUTPUT_TOOL_NAME, input }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 5 },
});

type Step = unknown | Error | (() => Promise<unknown>);

const fakeAnthropic = (...steps: Step[]) => {
  const bodies: Record<string, unknown>[] = [];
  const options: Record<string, unknown>[] = [];
  const client: AnthropicLike = {
    messages: {
      create: async (body: Record<string, unknown>, opts?: Record<string, unknown>) => {
        bodies.push(structuredClone(body));
        options.push(opts ?? {});
        const step = steps.shift();
        if (step instanceof Error) throw step;
        if (typeof step === 'function') return (step as () => Promise<unknown>)();
        return step;
      },
    },
  };
  return { client, bodies, options };
};

const req = (over: Partial<JsonRequest> = {}): JsonRequest => ({
  system: 'SYSTEM SECRET PROMPT',
  user: 'PAGE TEXT and visitor answer: chasing references',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  maxTokens: 500,
  timeoutMs: 10_000,
  label: 'test.call',
  ...over,
});

const logs = () => {
  const entries: Record<string, unknown>[] = [];
  return { entries, log: (e: Record<string, unknown>) => entries.push(e) };
};

// Settings as the Models API would yield them for the three shapes that matter.
const DISABLED: ModelSettings = {
  source: 'models_api',
  thinking: { type: 'disabled' },
  thinkingOn: false,
  forcedToolAllowed: true,
  structuredOutputs: true,
  maxTokensCeiling: 64_000,
};
const BETWEEN_TOOLS: ModelSettings = {
  source: 'models_api',
  thinking: { type: 'between_tools' },
  thinkingOn: false,
  forcedToolAllowed: false,
  structuredOutputs: true,
  maxTokensCeiling: 128_000,
};
const ADAPTIVE: ModelSettings = {
  source: 'models_api',
  thinking: { type: 'adaptive' },
  thinkingOn: true,
  forcedToolAllowed: false,
  structuredOutputs: true,
  maxTokensCeiling: 128_000,
};

const sup = (supported: boolean) => ({ supported });
/** A ModelInfo shaped like the SDK's `ModelInfo` type. */
const modelInfo = (thinking: { disabled: boolean; between_tools: boolean; adaptive: boolean; supported?: boolean }, over: Record<string, unknown> = {}) => ({
  id: 'claude-sonnet-5-5',
  type: 'model',
  lifecycle: 'active',
  max_tokens: 128_000,
  capabilities: {
    structured_outputs: sup(true),
    thinking: {
      supported: thinking.supported ?? true,
      types: {
        adaptive: sup(thinking.adaptive),
        between_tools: sup(thinking.between_tools),
        disabled: sup(thinking.disabled),
        enabled: sup(false),
      },
    },
  },
  ...over,
});

describe('settingsFromModelInfo', () => {
  it('disables thinking when the model accepts disabled', () => {
    expect(settingsFromModelInfo(modelInfo({ disabled: true, between_tools: false, adaptive: true }))).toEqual({
      source: 'models_api',
      thinking: { type: 'disabled' },
      thinkingOn: false,
      forcedToolAllowed: true,
      structuredOutputs: true,
      maxTokensCeiling: 128_000,
    });
  });

  it('uses between_tools when disabled is refused (Sonnet 5.5 shape), and never forces a tool', () => {
    const s = settingsFromModelInfo(modelInfo({ disabled: false, between_tools: true, adaptive: true }));
    expect(s.thinking).toEqual({ type: 'between_tools' });
    expect(s.thinkingOn).toBe(false);
    expect(s.forcedToolAllowed).toBe(false);
  });

  it('falls back to adaptive with thinking on when neither off switch is accepted', () => {
    const s = settingsFromModelInfo(modelInfo({ disabled: false, between_tools: false, adaptive: true }));
    expect(s).toMatchObject({ thinking: { type: 'adaptive' }, thinkingOn: true, forcedToolAllowed: false });
  });

  it('sends nothing for a model without thinking', () => {
    const s = settingsFromModelInfo(modelInfo({ supported: false, disabled: false, between_tools: false, adaptive: false }));
    expect(s).toMatchObject({ thinking: null, thinkingOn: false, forcedToolAllowed: true });
  });

  it('null capabilities → conservative, keeping the ceiling', () => {
    expect(settingsFromModelInfo({ id: 'x', capabilities: null, max_tokens: 8_000 })).toEqual({
      ...CONSERVATIVE_SETTINGS,
      source: 'models_api',
      maxTokensCeiling: 8_000,
    });
  });
});

describe('probeModel', () => {
  const probeClient = (step: unknown | Error) => {
    const calls: unknown[][] = [];
    const client: AnthropicLike = {
      messages: { create: async () => ({}) },
      models: {
        retrieve: async (...args: unknown[]) => {
          calls.push(args);
          if (step instanceof Error) throw step;
          return step;
        },
      },
    };
    return { client, calls };
  };

  it('reads capabilities for the configured model', async () => {
    const { client, calls } = probeClient(modelInfo({ disabled: false, between_tools: true, adaptive: true }));
    const { entries, log } = logs();
    const s = await probeModel(client, 'claude-sonnet-5-5', { log });
    expect(calls[0]![0]).toBe('claude-sonnet-5-5');
    expect(s.thinking).toEqual({ type: 'between_tools' });
    expect(entries[0]).toMatchObject({ event: 'model_probe_ok', thinking: 'between_tools' });
  });

  it('fails loudly for an unknown model (404)', async () => {
    const { client } = probeClient(new FakeApiError(404, 'model: claude-nope not found'));
    const err = await probeModel(client, 'claude-nope', { log: () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelConfigError);
    expect(err.message).toMatch(/claude-nope.*not found/);
  });

  it('fails loudly for a refused key (401) and a retired model', async () => {
    expect(await probeModel(probeClient(new FakeApiError(401, 'invalid x-api-key')).client, 'm', { log: () => {} }).catch((e) => e)).toBeInstanceOf(
      ModelConfigError,
    );
    const retired = probeClient(modelInfo({ disabled: true, between_tools: false, adaptive: false }, { lifecycle: 'retired' }));
    expect(await probeModel(retired.client, 'm', { log: () => {} }).catch((e) => e)).toBeInstanceOf(ModelConfigError);
  });

  it('logs and returns conservative settings on a transient failure (network, 529, timeout)', async () => {
    for (const err of [new Error('fetch failed'), new FakeApiError(529, 'Overloaded'), new FakeApiError(500, 'boom')]) {
      const { entries, log } = logs();
      const s = await probeModel(probeClient(err).client, 'm', { log });
      expect(s).toEqual(CONSERVATIVE_SETTINGS);
      expect(entries[0]).toMatchObject({ event: 'model_probe_failed', model: 'm' });
    }
    const hanging: AnthropicLike = { messages: { create: async () => ({}) }, models: { retrieve: () => new Promise(() => {}) } };
    const { entries, log } = logs();
    expect(await probeModel(hanging, 'm', { log, timeoutMs: 20 })).toEqual(CONSERVATIVE_SETTINGS);
    expect(entries[0]).toMatchObject({ event: 'model_probe_failed', status: 'timeout' });
  });

  it('re-probes in the background and applies the settings once known', async () => {
    let answer: unknown | Error = new Error('fetch failed');
    const client: AnthropicLike = {
      messages: { create: async () => ({}) },
      models: {
        retrieve: async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    };
    const timers: (() => void)[] = [];
    const caller = createJsonCaller({ anthropic: client, model: 'm', log: () => {} });
    reprobeInBackground(caller, client, { log: () => {}, delaysMs: [1, 1], setTimer: (fn) => (timers.push(fn), {}) });
    timers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(caller.state().settings.source).toBe('unknown');
    answer = modelInfo({ disabled: true, between_tools: false, adaptive: true });
    timers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(caller.state().settings.thinking).toEqual({ type: 'disabled' });
  });
});

describe('createJsonCaller', () => {
  it('sends model, thinking, system/user and json_schema output, no sampling params; returns data + usage', async () => {
    const { client, bodies, options } = fakeAnthropic(textMessage('{"ok":true}'));
    const { entries, log } = logs();
    const caller = createJsonCaller({ anthropic: client, model: 'm-1', log, settings: DISABLED });
    const res = await caller.callJson(req({ logMeta: { auditId: 'a1' } }));
    expect(res).toEqual({ data: { ok: true }, usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 }, model: 'm-1' });
    const body = bodies[0]!;
    expect(body.model).toBe('m-1');
    expect(body.thinking).toEqual({ type: 'disabled' });
    for (const k of ['temperature', 'top_p', 'top_k']) expect(k in body).toBe(false);
    expect(body.max_tokens).toBe(500);
    expect(body.system).toBe('SYSTEM SECRET PROMPT');
    expect(body.messages).toEqual([{ role: 'user', content: req().user }]);
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema: req().schema } });
    expect(body.tools).toBeUndefined();
    expect(options[0]!.maxRetries).toBe(0);
    expect(options[0]!.signal).toBeInstanceOf(AbortSignal);
    // Logs carry label/model/usage/stop_reason/timing only, never prompt text.
    expect(entries).toEqual([
      { label: 'test.call', model: 'm-1', auditId: 'a1', usage: res.usage, stop_reason: 'end_turn', max_tokens: 500, ms: expect.any(Number) },
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/SECRET|PAGE TEXT|chasing/);
  });

  it('between_tools models: thinking off up-front, no headroom', async () => {
    const { client, bodies } = fakeAnthropic(textMessage('{"ok":true}'));
    await createJsonCaller({ anthropic: client, log: () => {}, settings: BETWEEN_TOOLS }).callJson(req());
    expect(bodies[0]!.thinking).toEqual({ type: 'between_tools' });
    expect(bodies[0]!.max_tokens).toBe(500);
  });

  it('adaptive models: thinking adaptive with max_tokens headroom', async () => {
    const { client, bodies } = fakeAnthropic(textMessage('{"ok":true}'));
    await createJsonCaller({ anthropic: client, log: () => {}, settings: ADAPTIVE }).callJson(req());
    expect(bodies[0]!.thinking).toEqual({ type: 'adaptive' });
    expect(bodies[0]!.max_tokens).toBe(500 + THINKING_HEADROOM_TOKENS);
  });

  it('unknown capabilities (default): thinking omitted, headroom added, capped by the model ceiling', async () => {
    const a = fakeAnthropic(textMessage('{"ok":true}'));
    const caller = createJsonCaller({ anthropic: a.client, log: () => {} });
    expect(caller.state().settings).toEqual(CONSERVATIVE_SETTINGS);
    await caller.callJson(req());
    expect('thinking' in a.bodies[0]!).toBe(false);
    expect(a.bodies[0]!.max_tokens).toBe(500 + THINKING_HEADROOM_TOKENS);

    const b = fakeAnthropic(textMessage('{"ok":true}'));
    await createJsonCaller({ anthropic: b.client, log: () => {}, settings: { ...ADAPTIVE, maxTokensCeiling: 4_000 } }).callJson(req());
    expect(b.bodies[0]!.max_tokens).toBe(4_000);
  });

  it('reports thinking tokens from usage.output_tokens_details', async () => {
    const msg = { ...textMessage('{"ok":true}'), usage: { input_tokens: 10, output_tokens: 900, output_tokens_details: { thinking_tokens: 700 } } };
    const res = await createJsonCaller({ anthropic: fakeAnthropic(msg).client, log: () => {}, settings: ADAPTIVE }).callJson(req());
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 900, thinking_tokens: 700 });
  });

  it('defaults the model to AUDIT_MODEL then claude-sonnet-5-5', () => {
    const prev = process.env.AUDIT_MODEL;
    delete process.env.AUDIT_MODEL;
    expect(createJsonCaller({ anthropic: fakeAnthropic().client }).model).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5-5');
    process.env.AUDIT_MODEL = 'claude-haiku-5-5';
    expect(createJsonCaller({ anthropic: fakeAnthropic().client }).model).toBe('claude-haiku-5-5');
    if (prev === undefined) delete process.env.AUDIT_MODEL;
    else process.env.AUDIT_MODEL = prev;
  });

  it('retries once on overload (529, 429, 500) then succeeds', async () => {
    for (const status of [529, 429, 500]) {
      const { client, bodies } = fakeAnthropic(new FakeApiError(status, 'Overloaded'), textMessage('{"ok":true}'));
      const res = await createJsonCaller({ anthropic: client, log: () => {} }).callJson(req());
      expect(res.data).toEqual({ ok: true });
      expect(bodies).toHaveLength(2);
    }
  });

  it('gives up after one overload retry', async () => {
    const { client, bodies } = fakeAnthropic(new FakeApiError(529, 'Overloaded'), new FakeApiError(529, 'Overloaded'), textMessage('{"ok":true}'));
    const err = await createJsonCaller({ anthropic: client, log: () => {} }).callJson(req()).catch((e) => e);
    expect(err).toBeInstanceOf(AiCallError);
    expect(err.code).toBe('overloaded');
    expect(bodies).toHaveLength(2);
  });

  it('does not retry other 4xx errors', async () => {
    const { client, bodies } = fakeAnthropic(new FakeApiError(401, 'invalid x-api-key'));
    const err = await createJsonCaller({ anthropic: client, log: () => {} }).callJson(req()).catch((e) => e);
    expect(err.code).toBe('api_error');
    expect(err.status).toBe(401);
    expect(bodies).toHaveLength(1);
  });

  it('a 400 about thinking falls back to the model default once, with headroom, and remembers', async () => {
    const { client, bodies } = fakeAnthropic(
      new FakeApiError(400, "thinking.type 'between_tools' is not supported at this effort level"),
      textMessage('{"ok":true}'),
      textMessage('{"ok":true}'),
    );
    const { entries, log } = logs();
    const caller = createJsonCaller({ anthropic: client, log, settings: BETWEEN_TOOLS });
    expect((await caller.callJson(req())).data).toEqual({ ok: true });
    expect(bodies[0]!.thinking).toEqual({ type: 'between_tools' });
    expect('thinking' in bodies[1]!).toBe(false);
    expect(bodies[1]!.max_tokens).toBe(500 + THINKING_HEADROOM_TOKENS);
    expect(entries[0]).toMatchObject({ event: 'thinking_rejected', thinking: 'between_tools' });
    await caller.callJson(req());
    expect('thinking' in bodies[2]!).toBe(false);
  });

  it('falls back to a single forced tool if output_config is rejected and thinking is off, and remembers', async () => {
    const { client, bodies } = fakeAnthropic(
      new FakeApiError(400, 'output_config.format: not supported for this model'),
      toolMessage({ ok: true }),
      toolMessage({ ok: false }),
    );
    const caller = createJsonCaller({ anthropic: client, log: () => {}, settings: DISABLED });
    expect((await caller.callJson(req())).data).toEqual({ ok: true });
    const body = bodies[1]!;
    expect(body.output_config).toBeUndefined();
    expect(body.tools).toEqual([{ name: OUTPUT_TOOL_NAME, description: expect.any(String), input_schema: req().schema }]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: OUTPUT_TOOL_NAME });
    expect(body.system).toBe('SYSTEM SECRET PROMPT');
    expect(caller.state().structured).toBe('tool');
    expect((await caller.callJson(req())).data).toEqual({ ok: false });
    expect((bodies[2]!.tools as unknown[]).length).toBe(1);
  });

  it('never forces the tool while thinking may be on: auto tool_choice plus an instruction', async () => {
    for (const settings of [ADAPTIVE, BETWEEN_TOOLS, CONSERVATIVE_SETTINGS]) {
      const { client, bodies } = fakeAnthropic(new FakeApiError(400, 'output_config: unsupported'), toolMessage({ ok: true }));
      expect((await createJsonCaller({ anthropic: client, log: () => {}, settings }).callJson(req())).data).toEqual({ ok: true });
      expect(bodies[1]!.tool_choice).toEqual({ type: 'auto' });
      expect(bodies[1]!.system).toMatch(new RegExp(`^SYSTEM SECRET PROMPT\\n\\n.*${OUTPUT_TOOL_NAME}`));
    }
  });

  it('starts in tool mode when the model reports no structured outputs', async () => {
    const { client, bodies } = fakeAnthropic(toolMessage({ ok: true }));
    await createJsonCaller({ anthropic: client, log: () => {}, settings: { ...DISABLED, structuredOutputs: false } }).callJson(req());
    expect(bodies[0]!.output_config).toBeUndefined();
    expect(bodies[0]!.tool_choice).toEqual({ type: 'tool', name: OUTPUT_TOOL_NAME });
  });

  it("stop_reason 'max_tokens' is logged and retried once with a doubled cap", async () => {
    const { client, bodies } = fakeAnthropic(textMessage('{"ok":', 'max_tokens'), textMessage('{"ok":true}'));
    const { entries, log } = logs();
    const res = await createJsonCaller({ anthropic: client, log, settings: DISABLED }).callJson(req());
    expect(res.data).toEqual({ ok: true });
    expect(bodies.map((b) => b.max_tokens)).toEqual([500, 1_000]);
    expect(entries.find((e) => e.event === 'max_tokens')).toMatchObject({ label: 'test.call', max_tokens: 500, retry_max_tokens: 1_000 });
  });

  it('max_tokens twice → bad_output; the max_tokens retry does not use up the bad-output retry', async () => {
    const twice = fakeAnthropic(textMessage('{', 'max_tokens'), textMessage('{', 'max_tokens'), textMessage('{"ok":true}'));
    const err = await createJsonCaller({ anthropic: twice.client, log: () => {}, settings: DISABLED }).callJson(req()).catch((e) => e);
    expect(err.code).toBe('bad_output');
    expect(err.message).toMatch(/max_tokens/);
    expect(twice.bodies).toHaveLength(2);

    const mixed = fakeAnthropic(textMessage('{', 'max_tokens'), textMessage('not json'), textMessage('{"ok":true}'));
    expect((await createJsonCaller({ anthropic: mixed.client, log: () => {}, settings: DISABLED }).callJson(req())).data).toEqual({ ok: true });
    expect(mixed.bodies.map((b) => b.max_tokens)).toEqual([500, 1_000, 1_000]);
  });

  it('max_tokens retry respects the model ceiling (no retry when already at it)', async () => {
    const { client, bodies } = fakeAnthropic(textMessage('{', 'max_tokens'), textMessage('{"ok":true}'));
    const err = await createJsonCaller({ anthropic: client, log: () => {}, settings: { ...DISABLED, maxTokensCeiling: 500 } })
      .callJson(req())
      .catch((e) => e);
    expect(err.code).toBe('bad_output');
    expect(bodies).toHaveLength(1);
  });

  it('retries once on unparseable output, then fails with bad_output', async () => {
    const ok = fakeAnthropic(textMessage('not json'), textMessage('```json\n{"ok":true}\n```'));
    expect((await createJsonCaller({ anthropic: ok.client, log: () => {} }).callJson(req())).data).toEqual({ ok: true });
    expect(ok.bodies).toHaveLength(2);

    const bad = fakeAnthropic(textMessage('{"ok":'), textMessage('[1,2]'), textMessage('{"ok":true}'));
    const err = await createJsonCaller({ anthropic: bad.client, log: () => {} }).callJson(req()).catch((e) => e);
    expect(err.code).toBe('bad_output');
    expect(bad.bodies).toHaveLength(2);
  });

  it('accept() false counts as unparseable output', async () => {
    const { client, bodies } = fakeAnthropic(textMessage('{"ok":false}'), textMessage('{"ok":true}'));
    const res = await createJsonCaller({ anthropic: client, log: () => {} }).callJson(req({ accept: (d) => d.ok === true }));
    expect(res.data).toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
  });

  it('ignores thinking blocks when reading the JSON text', async () => {
    const msg = {
      content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: '{"ok":true}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    expect((await createJsonCaller({ anthropic: fakeAnthropic(msg).client, log: () => {} }).callJson(req())).data).toEqual({ ok: true });
  });

  it('times out and aborts the request', async () => {
    let signal: AbortSignal | undefined;
    const client: AnthropicLike = {
      messages: {
        create: (_body: unknown, opts?: { signal?: AbortSignal }) => {
          signal = opts?.signal;
          return new Promise(() => {});
        },
      },
    };
    const { entries, log } = logs();
    const err = await createJsonCaller({ anthropic: client, log }).callJson(req({ timeoutMs: 30 })).catch((e) => e);
    expect(err).toBeInstanceOf(AiCallError);
    expect(err.code).toBe('timeout');
    expect(signal?.aborted).toBe(true);
    expect(entries[0]).toMatchObject({ label: 'test.call', event: 'timeout' });
  });

  it('does not retry when too little budget remains', async () => {
    let t = 0;
    const { client, bodies } = fakeAnthropic(async () => {
      t += 9_000; // the first attempt used most of the 10 s budget
      return textMessage('garbage');
    }, textMessage('{"ok":true}'));
    const err = await createJsonCaller({ anthropic: client, log: () => {}, now: () => t }).callJson(req()).catch((e) => e);
    expect(err.code).toBe('bad_output');
    expect(bodies).toHaveLength(1);
  });
});

describe('extractJson', () => {
  it('reads text JSON in json_schema mode and the named tool input in tool mode', () => {
    expect(extractJson(textMessage('{"a":1}'), 'json_schema')).toEqual({ a: 1 });
    expect(extractJson(toolMessage({ a: 1 }), 'tool')).toEqual({ a: 1 });
    expect(extractJson({ content: [{ type: 'tool_use', name: 'other', input: { a: 1 } }] }, 'tool')).toBeNull();
    expect(extractJson({ content: [] }, 'json_schema')).toBeNull();
    expect(extractJson(null, 'json_schema')).toBeNull();
  });
});
