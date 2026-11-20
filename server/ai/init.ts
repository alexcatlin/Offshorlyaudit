// Boot-time AI setup (Amendment 3 §8). A refused key or an unknown/retired model no longer
// stops the process: AI is switched off, `/healthz` reports `aiConfigError: true`, and the
// measured audit keeps working. AI_MODE=live with no key is still a ConfigError (loadConfig).
import { fixtureEngine, liveEngine } from '../audit/aiEngine.js';
import type { AiEngine } from '../audit/aiEngine.js';
import type { AiMode, Config } from '../config.js';
import { createAnthropic, createJsonCaller, ModelConfigError, probeModel, reprobeInBackground, resolveModel } from './client.js';
import type { AnthropicLike, ModelSettings } from './client.js';

export interface AiInit {
  ai: AiEngine | null;
  /** Effective mode: 'off' after a ModelConfigError. */
  aiMode: AiMode;
  aiConfigError: boolean;
  cancelReprobe: (() => void) | null;
}

export interface AiInitDeps {
  createAnthropic?: (apiKey: string) => AnthropicLike;
  probe?: (anthropic: AnthropicLike, model: string) => Promise<ModelSettings>;
  reprobe?: typeof reprobeInBackground;
  log?: (msg: string) => void;
}

export const initAi = async (
  config: Pick<Config, 'aiMode' | 'anthropicApiKey' | 'auditModel'>,
  deps: AiInitDeps = {},
): Promise<AiInit> => {
  const log = deps.log ?? ((msg: string) => console.error(msg));
  if (config.aiMode === 'fixture') return { ai: fixtureEngine(), aiMode: 'fixture', aiConfigError: false, cancelReprobe: null };
  if (config.aiMode !== 'live' || !config.anthropicApiKey) {
    return { ai: null, aiMode: 'off', aiConfigError: false, cancelReprobe: null };
  }
  const anthropic = (deps.createAnthropic ?? createAnthropic)(config.anthropicApiKey);
  const model = resolveModel(config.auditModel);
  let settings: ModelSettings;
  try {
    // A transient failure returns conservative settings (a background re-probe retries).
    settings = await (deps.probe ?? probeModel)(anthropic, model);
  } catch (e) {
    // ModelConfigError (refused key, unknown or retired model); anything unexpected is treated
    // the same way rather than taking the service down.
    log(`AI disabled: ${e instanceof ModelConfigError ? e.message : `model check failed (${(e as Error)?.name ?? 'error'})`}`);
    return { ai: null, aiMode: 'off', aiConfigError: true, cancelReprobe: null };
  }
  const caller = createJsonCaller({ anthropic, model, settings });
  const cancelReprobe = settings.source === 'unknown' ? (deps.reprobe ?? reprobeInBackground)(caller, anthropic) : null;
  return { ai: liveEngine(caller.callJson), aiMode: 'live', aiConfigError: false, cancelReprobe };
};
