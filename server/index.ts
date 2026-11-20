// Production/dev entry point: load config, build process-wide clients, start the server.
import { resolve } from 'node:path';
import { liveEngine, fixtureEngine } from './audit/aiEngine.js';
import type { AiEngine } from './audit/aiEngine.js';
import type { ModelSettings } from './ai/client.js';
import { createAnthropic, createJsonCaller, ModelConfigError, probeModel, reprobeInBackground, resolveModel } from './ai/client.js';
import { buildApp } from './app.js';
import { createWordfence } from './cms/wordfence.js';
import { createWpOrgClient } from './cms/wordpressOrg.js';
import { ConfigError, loadConfig, loadLocalEnv } from './config.js';
import type { Config } from './config.js';
import { createFetchSafe } from './site/fetchSafe.js';

loadLocalEnv();
let config: Config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`Configuration error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

const logger = { level: config.logLevel };

// One of each per process.
const wpOrg = createWpOrgClient();
let ai: AiEngine | null = null;
let cancelReprobe: (() => void) | null = null;
if (config.aiMode === 'live' && config.anthropicApiKey) {
  const anthropic = createAnthropic(config.anthropicApiKey);
  const model = resolveModel(config.auditModel);
  // Fail loudly for an unknown/retired model or a refused key; a transient failure is logged
  // and the caller starts on conservative settings while a background re-probe retries.
  let settings: ModelSettings;
  try {
    settings = await probeModel(anthropic, model);
  } catch (e) {
    if (e instanceof ModelConfigError) {
      console.error(`Configuration error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  const caller = createJsonCaller({ anthropic, model, settings });
  if (settings.source === 'unknown') cancelReprobe = reprobeInBackground(caller, anthropic);
  ai = liveEngine(caller.callJson);
} else if (config.aiMode === 'fixture') {
  ai = fixtureEngine();
}

// Wordfence only when keyed; the feed downloads in the background and matching starts once
// indexed (analyseWordPress checks `ready` per audit).
let logInfo = (msg: string, extra?: Record<string, unknown>) => console.info(JSON.stringify({ msg, ...extra }));
const wordfence = createWordfence(
  config.wordfenceApiKey ? { apiKey: config.wordfenceApiKey, log: (msg, extra) => logInfo(msg, extra) } : null,
);

const app = await buildApp({
  config,
  audit: {
    createFetchSafe: () => createFetchSafe(),
    wpOrg,
    wordfence,
    pagespeed: config.pagespeedApiKey ? { apiKey: config.pagespeedApiKey } : null,
    ai,
  },
  clientDir: resolve(process.cwd(), 'dist/client'),
  logger,
});

logInfo = (msg, extra) => app.log.info(extra ?? {}, msg);
if (wordfence) void wordfence.start();

// A background promise that rejects must never take the process down.
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled rejection');
});

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  wordfence?.stop();
  cancelReprobe?.();
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info({ aiMode: config.aiMode, version: config.version, wordfence: !!wordfence, pagespeed: !!config.pagespeedApiKey }, 'audit service ready');
