// Production/dev entry point: load config, build process-wide clients, start the server.
import { resolve } from 'node:path';
import { initAi } from './ai/init.js';
import { buildApp } from './app.js';
import { createWordfence } from './cms/wordfence.js';
import { createWpOrgClient } from './cms/wordpressOrg.js';
import { ConfigError, loadConfig, loadLocalEnv } from './config.js';
import type { Config } from './config.js';
import { createCrmSync } from './crm/sync.js';
import type { CrmLog } from './crm/sync.js';
import { createTwentyClient } from './crm/twenty.js';
import { createLedger } from './lead/ledger.js';
import type { LedgerLog } from './lead/ledger.js';
import { createFetchSafe } from './site/fetchSafe.js';

/** Drain budget for queued CRM jobs on shutdown (the force-exit timer is 10 s). */
const CRM_DRAIN_MS = 7_000;

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

// Until the app's logger exists, log JSON lines to stdout; rebound to app.log below.
type Level = 'info' | 'warn' | 'error';
let log = (level: Level, msg: string, extra?: Record<string, unknown>) =>
  (level === 'info' ? console.info : console.error)(JSON.stringify({ level, msg, ...extra }));

// One of each per process.
const wpOrg = createWpOrgClient();

// A refused key or unknown model switches AI off (and shows in /healthz) instead of exiting.
const { ai, aiMode, aiConfigError, cancelReprobe } = await initAi(config, { log: (msg) => log('error', msg) });

// Wordfence only when keyed; the feed downloads in the background and matching starts once
// indexed (analyseWordPress checks `ready` per audit).
const wordfence = createWordfence(
  config.wordfenceApiKey ? { apiKey: config.wordfenceApiKey, log: (msg, extra) => log('info', msg, extra) } : null,
);

if (config.emailHashSecretGenerated) {
  log('warn', 'EMAIL_HASH_SECRET is not set: using a random per-process secret, so the one-audit-per-email record resets on restart');
}
const ledgerLog: LedgerLog = (level, msg, extra) => log(level, msg, extra);
const ledger = await createLedger(config, ledgerLog);

const crmLog: CrmLog = (level, msg, extra) => log(level, msg, extra);
const crm =
  config.twentyApiUrl && config.twentyApiKey
    ? createCrmSync({ client: createTwentyClient({ apiUrl: config.twentyApiUrl, apiKey: config.twentyApiKey }), log: crmLog })
    : null;

const app = await buildApp({
  config: { ...config, aiMode },
  aiConfigError,
  audit: {
    createFetchSafe: () => createFetchSafe(),
    wpOrg,
    wordfence,
    pagespeed: config.pagespeedApiKey ? { apiKey: config.pagespeedApiKey } : null,
    ai,
  },
  ledger,
  crm,
  clientDir: resolve(process.cwd(), 'dist/client'),
  logger,
});

log = (level, msg, extra) => app.log[level](extra ?? {}, msg);
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
  Promise.all([
    app.close(),
    crm
      ? crm.drain(CRM_DRAIN_MS).then((dropped) => {
          if (dropped) app.log.warn({ dropped }, 'crm jobs dropped at shutdown');
        })
      : null,
  ])
    .then(() => ledger.close())
    .then(
      () => process.exit(0),
      () => process.exit(1),
    );
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(
  {
    aiMode,
    ...(aiConfigError ? { aiConfigError } : {}),
    version: config.version,
    wordfence: !!wordfence,
    pagespeed: !!config.pagespeedApiKey,
    emailGate: config.emailGate,
    ledger: ledger.kind,
    crm: crm ? 'on' : 'off',
  },
  'audit service ready',
);
