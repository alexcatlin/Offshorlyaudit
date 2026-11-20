// Thin wrapper over the Anthropic Messages API for one structured JSON answer per call.
//
// Sources for every behaviour below (checked 2026-11-20 against @anthropic-ai/sdk 1.11.0, which
// sends `anthropic-version: 2026-10-21`, and platform.claude.com/docs):
//
// - Model capabilities. At boot in live mode, `probeModel` calls `models.retrieve(model)`. A 404,
//   a retired model or a rejected key throws ModelConfigError and the service refuses to start.
//   A transient failure (network, timeout, 429, 5xx) is logged and the caller runs on
//   CONSERVATIVE_SETTINGS until a background re-probe succeeds.
// - Thinking. Thinking tokens count toward `max_tokens`, and what happens when `thinking` is
//   omitted depends on the model (Claude 5+ models think by default). From the model's
//   `capabilities.thinking.types` we send, in order of preference:
//     `{type:'disabled'}`      when accepted (thinking off);
//     `{type:'between_tools'}` when accepted (no up-front thinking; Sonnet 5.5's lowest setting,
//                              because it rejects 'disabled'; without tools the reply is text only);
//     `{type:'adaptive'}`      otherwise, with THINKING_HEADROOM_TOKENS added to `max_tokens`.
//   With unknown capabilities, `thinking` is omitted (model default) and the headroom is added.
// - Structured output: `output_config.format` with a JSON schema. If the API rejects it, the
//   caller switches to a single tool whose input_schema is the schema. `tool_choice` forces that
//   tool only when thinking is known to be fully disabled: forced tool use is rejected with
//   thinking on, and Opus 5.5 / Sonnet 5.5 reject it on every request. Otherwise the tool is
//   offered with `tool_choice: auto` and the system prompt asks for exactly one call.
// - Sampling. `temperature`, `top_p` and `top_k` are not sent: from API version 2026-10-21 any
//   value returns a 400 on every model, and the installed SDK no longer types them.
// - `stop_reason: 'max_tokens'` is logged as its own event and retried once with a higher cap
//   (doubled, within the model's `max_tokens` ceiling). This retry is separate from the one
//   overload / unparseable-output retry.
//
// Logging: `{label, model, usage, stop_reason, ms}` plus caller-supplied metadata only. Never
// prompt text, page text or visitor answers.
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const OUTPUT_TOOL_NAME = 'submit_result';

/** Minimum time left in the budget for a retry to be worth starting. */
const MIN_RETRY_MS = 3_000;
/** Extra `max_tokens` when the model may think before answering. */
export const THINKING_HEADROOM_TOKENS = 12_000;
/** Upper bound for the max_tokens retry when the model's own ceiling is unknown. */
export const MAX_TOKENS_RETRY_CEILING = 32_000;
/** Budget for the boot-time models.retrieve call. */
export const PROBE_TIMEOUT_MS = 10_000;

export type JsonSchema = Record<string, unknown>;

/** The slice of the Anthropic client we use. The real SDK client satisfies it; tests pass a fake. */
export interface AnthropicLike {
  messages: {
    create(body: any, options?: any): PromiseLike<unknown>;
  };
  models?: {
    retrieve(modelId: string, params?: any, options?: any): PromiseLike<unknown>;
  };
}

export interface AiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  /** From usage.output_tokens_details.thinking_tokens; part of output_tokens. */
  thinking_tokens?: number;
}

export interface JsonRequest {
  system: string;
  user: string;
  schema: JsonSchema;
  /** Tokens for the answer itself; thinking headroom is added by the caller when needed. */
  maxTokens: number;
  /** Total budget across attempts, in ms. */
  timeoutMs: number;
  /** Short label for logs, e.g. "buyerFit.step1". */
  label: string;
  /** Extra shape check; false counts as unparseable output (one retry). */
  accept?: (data: Record<string, unknown>) => boolean;
  /** Safe log metadata (e.g. auditId, domain). Never page text or answers. */
  logMeta?: Record<string, string>;
}

export interface JsonResponse {
  data: Record<string, unknown>;
  usage: AiUsage;
  model: string;
}

export type CallJson = (req: JsonRequest) => Promise<JsonResponse>;

export type AiErrorCode = 'timeout' | 'overloaded' | 'bad_output' | 'api_error';

export class AiCallError extends Error {
  readonly code: AiErrorCode;
  readonly status?: number;
  constructor(code: AiErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AiCallError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** The configured model can't be used (unknown, retired, or the key was refused). Fatal at boot. */
export class ModelConfigError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ModelConfigError';
    if (status !== undefined) this.status = status;
  }
}

export type AiLog = (entry: Record<string, unknown>) => void;

export type ThinkingParam = { type: 'disabled' } | { type: 'between_tools' } | { type: 'adaptive' };

/** Request settings derived from the model's capabilities. */
export interface ModelSettings {
  /** 'models_api' once models.retrieve answered; 'unknown' when it couldn't run. */
  source: 'models_api' | 'unknown';
  /** Sent as `thinking`; null = omit (model default). */
  thinking: ThinkingParam | null;
  /** True when the model may think before answering (adds max_tokens headroom). */
  thinkingOn: boolean;
  /** True only when thinking is known to be fully off, so `tool_choice: {type:'tool'}` is accepted. */
  forcedToolAllowed: boolean;
  /** capabilities.structured_outputs.supported; null = unknown (try json_schema). */
  structuredOutputs: boolean | null;
  /** The model's max_tokens limit; null = unknown. */
  maxTokensCeiling: number | null;
}

/** Used until (or unless) the Models API answers: assume thinking may be on. */
export const CONSERVATIVE_SETTINGS: ModelSettings = Object.freeze({
  source: 'unknown',
  thinking: null,
  thinkingOn: true,
  forcedToolAllowed: false,
  structuredOutputs: null,
  maxTokensCeiling: null,
}) as ModelSettings;

export interface JsonCallerOptions {
  anthropic: AnthropicLike;
  /** Defaults to AUDIT_MODEL, then DEFAULT_MODEL. */
  model?: string;
  log?: AiLog;
  /** From probeModel; defaults to CONSERVATIVE_SETTINGS. */
  settings?: ModelSettings;
  /** Starting structured-output mode. Default 'json_schema' (or 'tool' if the model lacks it). */
  structured?: 'json_schema' | 'tool';
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface JsonCaller {
  callJson: CallJson;
  model: string;
  /** Replace the settings (e.g. after a background re-probe succeeds). */
  setSettings(settings: ModelSettings): void;
  /** Read-only view of what this caller has learned about the API. */
  state(): { structured: 'json_schema' | 'tool'; settings: ModelSettings };
}

/** Real SDK client. Retries are ours (see callJson), so the SDK's own are off. */
export const createAnthropic = (apiKey: string): AnthropicLike => new Anthropic({ apiKey, maxRetries: 0 });

export const resolveModel = (model?: string | null): string => model || process.env.AUDIT_MODEL || DEFAULT_MODEL;

const defaultLog: AiLog = (entry) => console.info(JSON.stringify({ msg: 'ai_call', ...entry }));

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const errorStatus = (e: unknown): number | undefined => {
  const s = isPlainObject(e) || e instanceof Error ? (e as { status?: unknown }).status : undefined;
  return typeof s === 'number' ? s : undefined;
};

const errorText = (e: unknown): string => {
  if (e instanceof Error) {
    const body = (e as { error?: unknown }).error;
    return `${e.message} ${body ? JSON.stringify(body) : ''}`;
  }
  return String(e);
};

const isRetryableStatus = (status: number | undefined): boolean =>
  status === 429 || status === 529 || (status !== undefined && status >= 500);

/** Connection failures from the SDK carry no status. */
const isConnectionError = (e: unknown): boolean =>
  e instanceof Error && errorStatus(e) === undefined && /connection|network|ECONNRESET|socket|fetch failed|timed? ?out|abort/i.test(e.name + ' ' + e.message);

const pickUsage = (u: unknown): AiUsage => {
  if (!isPlainObject(u)) return {};
  const out: AiUsage = {};
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
    const v = u[k];
    if (typeof v === 'number') out[k] = v;
  }
  const details = u.output_tokens_details;
  if (isPlainObject(details) && typeof details.thinking_tokens === 'number') out.thinking_tokens = details.thinking_tokens;
  return out;
};

const supported = (v: unknown): boolean => isPlainObject(v) && v.supported === true;

/** Map a Models API `ModelInfo` to request settings. */
export const settingsFromModelInfo = (info: unknown): ModelSettings => {
  const o = isPlainObject(info) ? info : {};
  const ceiling = typeof o.max_tokens === 'number' && o.max_tokens > 0 ? o.max_tokens : null;
  const caps = isPlainObject(o.capabilities) ? o.capabilities : null;
  if (!caps) return { ...CONSERVATIVE_SETTINGS, source: 'models_api', maxTokensCeiling: ceiling };
  const structuredOutputs = isPlainObject(caps.structured_outputs) ? caps.structured_outputs.supported === true : null;
  const base = { source: 'models_api' as const, structuredOutputs, maxTokensCeiling: ceiling };
  const thinking = isPlainObject(caps.thinking) ? caps.thinking : {};
  const types = isPlainObject(thinking.types) ? thinking.types : {};
  if (supported(types.disabled)) {
    return { ...base, thinking: { type: 'disabled' }, thinkingOn: false, forcedToolAllowed: true };
  }
  if (thinking.supported === false) {
    // No thinking at all and 'disabled' not listed: send nothing.
    return { ...base, thinking: null, thinkingOn: false, forcedToolAllowed: true };
  }
  if (supported(types.between_tools)) {
    return { ...base, thinking: { type: 'between_tools' }, thinkingOn: false, forcedToolAllowed: false };
  }
  if (supported(types.adaptive)) {
    return { ...base, thinking: { type: 'adaptive' }, thinkingOn: true, forcedToolAllowed: false };
  }
  return { ...base, thinking: null, thinkingOn: true, forcedToolAllowed: false };
};

const isTransient = (e: unknown): boolean => {
  const status = errorStatus(e);
  if (status === undefined) return true; // network, timeout, abort
  return status === 408 || isRetryableStatus(status);
};

export interface ProbeOptions {
  log?: AiLog;
  timeoutMs?: number;
}

/**
 * Boot-time check of the configured model via the Models API.
 * - Model found and usable → settings from its capabilities.
 * - 404, retired, or a refused key (other 4xx) → throws ModelConfigError (fail loudly).
 * - Transient failure → logs and returns CONSERVATIVE_SETTINGS (the service still starts).
 */
export const probeModel = async (anthropic: AnthropicLike, model: string, opts: ProbeOptions = {}): Promise<ModelSettings> => {
  const log = opts.log ?? defaultLog;
  if (!anthropic.models) {
    log({ event: 'model_probe_skipped', model });
    return CONSERVATIVE_SETTINGS;
  }
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  let info: unknown;
  try {
    info = await withTimeout((signal) => anthropic.models!.retrieve(model, {}, { signal, timeout: timeoutMs, maxRetries: 0 }), timeoutMs);
  } catch (e) {
    const status = errorStatus(e);
    if (!(e instanceof TimeoutSignal) && !isTransient(e)) {
      const why =
        status === 404
          ? `model "${model}" was not found by the Models API`
          : status === 401 || status === 403
            ? `the Anthropic API refused the key (${status})`
            : `the Models API rejected model "${model}" (${status})`;
      throw new ModelConfigError(`AUDIT_MODEL check failed: ${why}.`, status);
    }
    log({ event: 'model_probe_failed', model, status: status ?? (e instanceof TimeoutSignal ? 'timeout' : 'connection') });
    return CONSERVATIVE_SETTINGS;
  }
  const lifecycle = isPlainObject(info) ? info.lifecycle : undefined;
  if (lifecycle === 'retired') throw new ModelConfigError(`AUDIT_MODEL check failed: model "${model}" is retired.`);
  const settings = settingsFromModelInfo(info);
  log({
    event: 'model_probe_ok',
    model,
    lifecycle: typeof lifecycle === 'string' ? lifecycle : null,
    thinking: settings.thinking?.type ?? 'default',
    structuredOutputs: settings.structuredOutputs,
    maxTokensCeiling: settings.maxTokensCeiling,
  });
  return settings;
};

export interface ReprobeOptions extends ProbeOptions {
  /** Delays between attempts. Default: 1, 5, 15, 60 minutes. */
  delaysMs?: readonly number[];
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
}

/**
 * After a transient boot-probe failure, keep trying in the background and apply the settings
 * once the Models API answers. A late ModelConfigError is logged loudly (calls will fail too).
 * Returns a cancel function.
 */
export const reprobeInBackground = (caller: JsonCaller, anthropic: AnthropicLike, opts: ReprobeOptions = {}): (() => void) => {
  const delays = [...(opts.delaysMs ?? [60_000, 300_000, 900_000, 3_600_000])];
  const log = opts.log ?? defaultLog;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let cancelled = false;
  const next = () => {
    const ms = delays.shift();
    if (ms === undefined || cancelled) return;
    setTimer(() => {
      if (cancelled) return;
      probeModel(anthropic, caller.model, opts).then(
        (s) => {
          if (s.source === 'models_api') caller.setSettings(s);
          else next();
        },
        (e: unknown) => log({ event: 'model_probe_fatal', model: caller.model, error: (e as Error).message }),
      );
    }, ms).unref?.();
  };
  next();
  return () => {
    cancelled = true;
  };
};

const stripFences = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

/** Pull the JSON object out of a Messages API response. Returns null if absent or unparseable. */
export const extractJson = (message: unknown, mode: 'json_schema' | 'tool'): Record<string, unknown> | null => {
  if (!isPlainObject(message) || !Array.isArray(message.content)) return null;
  const blocks = message.content.filter(isPlainObject);
  if (mode === 'tool') {
    const block = blocks.find((b) => b.type === 'tool_use' && b.name === OUTPUT_TOOL_NAME);
    return block && isPlainObject(block.input) ? block.input : null;
  }
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  if (!text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(stripFences(text));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

class TimeoutSignal extends Error {}

const withTimeout = <T>(work: (signal: AbortSignal) => PromiseLike<T>, ms: number): Promise<T> => {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutSignal('timeout'));
    }, Math.max(0, ms));
    Promise.resolve()
      .then(() => work(controller.signal))
      .then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
  });
};

const TOOL_INSTRUCTION = `Give your answer by calling the ${OUTPUT_TOOL_NAME} tool exactly once.`;

export const createJsonCaller = (opts: JsonCallerOptions): JsonCaller => {
  const model = resolveModel(opts.model);
  const log = opts.log ?? defaultLog;
  const now = opts.now ?? Date.now;
  let settings: ModelSettings = opts.settings ?? CONSERVATIVE_SETTINGS;
  let structured: 'json_schema' | 'tool' = opts.structured ?? (settings.structuredOutputs === false ? 'tool' : 'json_schema');

  const capTokens = (n: number): number => (settings.maxTokensCeiling ? Math.min(n, settings.maxTokensCeiling) : n);

  /** max_tokens for a first attempt: the answer budget plus thinking headroom when needed. */
  const firstCap = (req: JsonRequest): number =>
    capTokens(settings.thinkingOn ? req.maxTokens + THINKING_HEADROOM_TOKENS : req.maxTokens);

  const buildBody = (req: JsonRequest, maxTokens: number): Record<string, unknown> => {
    const forced = settings.forcedToolAllowed;
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system: structured === 'tool' && !forced ? `${req.system}\n\n${TOOL_INSTRUCTION}` : req.system,
      messages: [{ role: 'user', content: req.user }],
    };
    if (settings.thinking) body.thinking = { ...settings.thinking };
    if (structured === 'json_schema') {
      body.output_config = { format: { type: 'json_schema', schema: req.schema } };
    } else {
      body.tools = [
        {
          name: OUTPUT_TOOL_NAME,
          description: 'Return the complete result. Call this exactly once.',
          input_schema: req.schema,
        },
      ];
      body.tool_choice = forced ? { type: 'tool', name: OUTPUT_TOOL_NAME } : { type: 'auto' };
    }
    return body;
  };

  const callJson: CallJson = async (req) => {
    const deadline = now() + req.timeoutMs;
    let retriesLeft = 1; // one retry on overload or unparseable output
    let maxTokensRetryLeft = 1; // one retry with a higher cap on stop_reason max_tokens
    let thinkingFallbackLeft = 1; // one retry with model-default thinking on a 400 about thinking
    let maxTokens = firstCap(req);
    const meta = { label: req.label, model, ...req.logMeta };

    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new AiCallError('timeout', `${req.label}: timed out`);
      const mode = structured;
      const started = now();
      let message: unknown;
      try {
        message = await withTimeout(
          (signal) =>
            opts.anthropic.messages.create(buildBody(req, maxTokens), {
              signal,
              timeout: remaining + 1_000,
              maxRetries: 0,
            }),
          remaining,
        );
      } catch (e) {
        if (e instanceof TimeoutSignal) {
          log({ ...meta, event: 'timeout' });
          throw new AiCallError('timeout', `${req.label}: timed out`);
        }
        const status = errorStatus(e);
        const text = errorText(e);
        if (status === 400 && settings.thinking && thinkingFallbackLeft > 0 && /thinking/i.test(text)) {
          // e.g. 'between_tools' refused at this effort level: fall back to the model default.
          thinkingFallbackLeft--;
          log({ ...meta, event: 'thinking_rejected', thinking: settings.thinking.type });
          settings = { ...settings, thinking: null, thinkingOn: true, forcedToolAllowed: false };
          maxTokens = Math.max(maxTokens, firstCap(req));
          continue;
        }
        if (status === 400 && mode === 'json_schema' && /output_config|output_format|json_schema|structured output/i.test(text)) {
          structured = 'tool';
          log({ ...meta, event: 'output_format_rejected' });
          continue;
        }
        if (isRetryableStatus(status) || isConnectionError(e)) {
          if (retriesLeft > 0 && deadline - now() > MIN_RETRY_MS) {
            retriesLeft--;
            log({ ...meta, event: 'retry', status: status ?? 'connection' });
            continue;
          }
          throw new AiCallError('overloaded', `${req.label}: API unavailable (${status ?? 'connection'})`, status);
        }
        throw new AiCallError('api_error', `${req.label}: API error (${status ?? 'unknown'})`, status);
      }

      const usage = pickUsage(isPlainObject(message) ? message.usage : undefined);
      const stop = isPlainObject(message) && typeof message.stop_reason === 'string' ? message.stop_reason : null;
      log({ ...meta, usage, stop_reason: stop, max_tokens: maxTokens, ms: Math.round(now() - started) });

      if (stop === 'max_tokens') {
        const bigger = capTokens(Math.min(maxTokens * 2, settings.maxTokensCeiling ?? MAX_TOKENS_RETRY_CEILING));
        const canRetry = maxTokensRetryLeft > 0 && bigger > maxTokens && deadline - now() > MIN_RETRY_MS;
        log({ ...meta, event: 'max_tokens', max_tokens: maxTokens, ...(canRetry ? { retry_max_tokens: bigger } : {}) });
        if (canRetry) {
          maxTokensRetryLeft--;
          maxTokens = bigger;
          continue;
        }
        throw new AiCallError('bad_output', `${req.label}: output cut off at max_tokens (${maxTokens})`);
      }

      const data = extractJson(message, mode);
      if (data && (!req.accept || req.accept(data))) return { data, usage, model };

      if (retriesLeft > 0 && deadline - now() > MIN_RETRY_MS) {
        retriesLeft--;
        log({ ...meta, event: 'retry', reason: 'bad_output', stop_reason: stop });
        continue;
      }
      throw new AiCallError('bad_output', `${req.label}: unparseable output (${String(stop ?? 'unknown')})`);
    }
  };

  return {
    callJson,
    model,
    setSettings: (s) => {
      settings = s;
      if (s.structuredOutputs === false) structured = 'tool';
    },
    state: () => ({ structured, settings }),
  };
};
