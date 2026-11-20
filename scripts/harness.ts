// Run one audit from the command line, without the HTTP layer (PLAN Phase 7).
//
//   npm run harness -- '<json body>' [--out file.json] [--read-only] [--live-smoke]
//
// Prints the HTTP-equivalent status, seconds, statuses, section scores, fetches per host and
// every requested path, then waits for the buyer-fit and AI promises. --read-only stops after
// the site read. Uses the same env/AI mode as the server (fixture without a key).
//
// --live-smoke: requires ANTHROPIC_API_KEY. Probes the model (models.retrieve), runs one live
// audit, then prints one line per AI call attempt (label, model, stop_reason, usage, seconds)
// and a cost estimate from the usage, using the per-token prices below.
import { writeFileSync } from 'node:fs';
import { fixtureEngine, liveEngine } from '../server/audit/aiEngine.js';
import type { AiEngine } from '../server/audit/aiEngine.js';
import { runAudit, validateAuditRequest } from '../server/audit/runAudit.js';
import { createAnthropic, createJsonCaller, probeModel, resolveModel } from '../server/ai/client.js';
import type { AiUsage } from '../server/ai/client.js';
import { createWordfence } from '../server/cms/wordfence.js';
import { createWpOrgClient } from '../server/cms/wordpressOrg.js';
import { loadConfig, loadLocalEnv } from '../server/config.js';
import { SiteReadError } from '../server/site/errors.js';
import { createFetchSafe } from '../server/site/fetchSafe.js';
import type { FetchLogEntry } from '../server/site/fetchSafe.js';
import { readSite } from '../server/site/readSite.js';
import { DailyCounter } from '../server/http/limits.js';

// Prices in USD per million tokens for the default model (Claude Sonnet 5.5), from
// platform.claude.com/docs/en/models/overview on 2026-11-20. CHECK CURRENT PRICING before
// relying on the estimate, and update these if AUDIT_MODEL points at another model.
const PRICE_INPUT_PER_MTOK = 2;
const PRICE_OUTPUT_PER_MTOK = 10; // thinking tokens are billed as output
const PRICE_CACHE_READ_PER_MTOK = 0.1; // 5% of input on Sonnet 5.5
const PRICE_CACHE_WRITE_PER_MTOK = 2.5; // assumed 1.25x input (5-minute cache); this app sets no cache breakpoints

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const bodyArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (!bodyArg) {
  console.error(`Usage: npm run harness -- '{"url":"https://example.com"}' [--out file] [--read-only] [--live-smoke]`);
  process.exit(2);
}

let body: unknown;
try {
  body = JSON.parse(bodyArg);
} catch {
  body = { url: bodyArg };
}

const secs = (t0: number) => ((performance.now() - t0) / 1000).toFixed(1);

const printLog = (log: readonly FetchLogEntry[]) => {
  const perHost = new Map<string, number>();
  for (const e of log) {
    const h = new URL(e.url).host;
    perHost.set(h, (perHost.get(h) ?? 0) + 1);
  }
  console.log(`fetches: ${log.length} (${[...perHost].map(([h, n]) => `${h}=${n}`).join(', ')})`);
  for (const e of log) {
    const u = new URL(e.url);
    console.log(`  ${String(e.status ?? e.error ?? '-').padEnd(8)} ${u.protocol}//${u.host}${u.pathname}${u.search}`);
  }
};

const usageCost = (u: AiUsage): number =>
  ((u.input_tokens ?? 0) * PRICE_INPUT_PER_MTOK +
    (u.output_tokens ?? 0) * PRICE_OUTPUT_PER_MTOK +
    (u.cache_read_input_tokens ?? 0) * PRICE_CACHE_READ_PER_MTOK +
    (u.cache_creation_input_tokens ?? 0) * PRICE_CACHE_WRITE_PER_MTOK) /
  1_000_000;

interface CallLine {
  label: string;
  model: string;
  stop: string;
  usage: AiUsage;
  secs: number;
}

const printCalls = (calls: readonly CallLine[], events: readonly Record<string, unknown>[]) => {
  console.log(`AI calls (${calls.length} attempts):`);
  let total = 0;
  let inTok = 0;
  let outTok = 0;
  let thinkTok = 0;
  for (const c of calls) {
    const u = c.usage;
    const cost = usageCost(u);
    total += cost;
    inTok += u.input_tokens ?? 0;
    outTok += u.output_tokens ?? 0;
    thinkTok += u.thinking_tokens ?? 0;
    const thinking = u.thinking_tokens !== undefined ? ` (thinking ${u.thinking_tokens})` : '';
    const cache = u.cache_read_input_tokens ? ` cacheRead=${u.cache_read_input_tokens}` : '';
    console.log(
      `  ${c.label.padEnd(22)} ${c.model}  stop=${c.stop.padEnd(10)} in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'}${thinking}${cache}  ${c.secs.toFixed(1)}s  ~$${cost.toFixed(4)}`,
    );
  }
  for (const e of events) console.log(`  [event] ${JSON.stringify(e)}`);
  console.log(`AI total: in=${inTok} out=${outTok} thinking=${thinkTok}  estimated cost ~$${total.toFixed(4)} per audit (prices are constants in scripts/harness.ts; check current pricing)`);
};

const main = async () => {
  loadLocalEnv();
  const config = loadConfig();
  const liveSmoke = flag('--live-smoke');
  if (liveSmoke && !config.anthropicApiKey) {
    console.error('--live-smoke needs ANTHROPIC_API_KEY (in .env.local or the environment).');
    process.exit(2);
  }
  const valid = validateAuditRequest(body);
  if (!valid.ok) {
    console.log(`status: 400 bad_request (${valid.error})`);
    return;
  }
  const request = valid.value;
  const t0 = performance.now();

  if (flag('--read-only')) {
    const fetchSafe = createFetchSafe();
    try {
      const site = await readSite(request.url, { fetchSafe });
      console.log(`status: 200 (read only)  seconds: ${secs(t0)}  thin: ${site.thin}`);
      for (const p of [site.home, ...site.pages]) console.log(`  ${p.label.padEnd(14)} ${p.url}  "${p.title}" (${p.text.length} chars)`);
      printLog(fetchSafe.log);
    } catch (e) {
      if (!(e instanceof SiteReadError)) throw e;
      console.log(`status: 422 ${e.code === 'not_found' ? 'site_not_found' : 'site_unreadable'} (${e.message})  seconds: ${secs(t0)}`);
      printLog(fetchSafe.log);
    }
    return;
  }

  let ai: AiEngine | null = null;
  const calls: CallLine[] = [];
  const events: Record<string, unknown>[] = [];
  if ((liveSmoke || config.aiMode === 'live') && config.anthropicApiKey) {
    const anthropic = createAnthropic(config.anthropicApiKey);
    const model = resolveModel(config.auditModel);
    const settings = await probeModel(anthropic, model, { log: (e) => console.log(`  [probe] ${JSON.stringify(e)}`) });
    console.log(`model: ${model}  thinking: ${settings.thinking?.type ?? 'default'}  thinkingOn: ${settings.thinkingOn}  source: ${settings.source}`);
    ai = liveEngine(
      createJsonCaller({
        anthropic,
        model,
        settings,
        log: (e) => {
          if (e.usage && typeof e.label === 'string') {
            calls.push({
              label: e.label,
              model: String(e.model),
              stop: String(e.stop_reason ?? '-'),
              usage: e.usage as AiUsage,
              secs: typeof e.ms === 'number' ? e.ms / 1000 : 0,
            });
          } else {
            const { auditId: _a, domain: _d, ...rest } = e;
            events.push(rest);
          }
        },
      }).callJson,
    );
  } else if (config.aiMode === 'fixture') ai = fixtureEngine();

  const wordfence = createWordfence(config.wordfenceApiKey ? { apiKey: config.wordfenceApiKey } : null);
  if (wordfence) await wordfence.start();

  let fetchLog: FetchLogEntry[] = [];
  const quota = new DailyCounter(config.dailyAiAudits);
  try {
    const run = await runAudit(request, {
      createFetchSafe: () => {
        const f = createFetchSafe();
        fetchLog = f.log;
        return f;
      },
      wpOrg: createWpOrgClient(),
      wordfence,
      pagespeed: config.pagespeedApiKey ? { apiKey: config.pagespeedApiKey } : null,
      ai,
      takeAiQuota: () => quota.tryTake(),
      log: (msg, extra) => {
        if (msg !== 'audit measured') console.log(`  [log] ${msg} ${JSON.stringify(extra ?? {})}`);
      },
    });
    const r = run.report;
    console.log(`status: 200  seconds: ${secs(t0)}  aiMode: ${config.aiMode}`);
    console.log(`url: ${r.url}  platform: ${r.cms.platform}${r.cms.wordpress ? ` (core ${r.cms.wordpress.core.version ?? '?'} ${r.cms.wordpress.core.status})` : ''}`);
    console.log(`scores: security=${r.security.score} health=${r.health.score} (google=${r.health.measuredByGoogle})`);
    console.log(`statuses: buyerFit=${r.buyerFitStatus} ai=${r.aiStatus}${r.omitted ? `  omitted: ${r.omitted.join(',')}` : ''}`);
    console.log(`pages: ${r.pagesRead.map((p) => `${p.label}=${new URL(p.url).pathname}`).join(', ')}`);
    console.log(`stack: ${r.stack.map((t) => t.id).join(', ') || '-'}`);
    if (r.cms.wordpress) {
      console.log(`wp components: ${r.cms.wordpress.components.map((c) => `${c.type}:${c.slug}@${c.version ?? '?'}/${c.latest ?? '?'}(${c.directory},${c.status})`).join(' ') || '-'}`);
    }
    const issues = [...r.security.checks, ...r.health.checks].filter((c) => c.status === 'fail' || c.status === 'warn');
    console.log(`issues: ${issues.map((c) => `${c.id}:${c.status}`).join(' ')}`);
    console.log(`fixFirst (measured): ${r.fixFirst.map((f) => f.checkId ?? `action#${f.actionIndex}`).join(', ')}`);
    printLog(fetchLog);

    const [bf, aiRes] = await Promise.all([run.buyerFit, run.ai]);
    console.log(`after AI: seconds ${secs(t0)}  buyerFit=${bf?.buyerFitStatus ?? r.buyerFitStatus}${bf?.buyerFit ? ` score=${bf.buyerFit.score} criteria=${bf.buyerFit.criteria.length} actions=${bf.buyerFit.actions.length}` : ''}  ai=${aiRes?.aiStatus ?? r.aiStatus}${aiRes?.ai ? ` opportunities=${aiRes.ai.opportunities.length}` : ''}`);
    if (bf) console.log(`fixFirst (re-ranked): ${bf.fixFirst.map((f) => f.checkId ?? `buyer-fit action#${f.actionIndex}`).join(', ')}`);
    if (liveSmoke) printCalls(calls, events);

    const outFile = opt('--out');
    if (outFile) {
      const merged = {
        ...r,
        ...(bf?.buyerFit ? { buyerFit: bf.buyerFit, buyerFitStatus: bf.buyerFitStatus, fixFirst: bf.fixFirst } : {}),
        ...(aiRes ? { aiStatus: aiRes.aiStatus, ...(aiRes.ai ? { ai: aiRes.ai } : {}) } : {}),
        fetchLog,
      };
      writeFileSync(outFile, `${JSON.stringify(merged, null, 2)}\n`);
      console.log(`wrote ${outFile}`);
    }
  } catch (e) {
    if (!(e instanceof SiteReadError)) throw e;
    console.log(`status: 422 ${e.code === 'not_found' ? 'site_not_found' : 'site_unreadable'} (${e.message})  seconds: ${secs(t0)}`);
    printLog(fetchLog);
  } finally {
    wordfence?.stop();
  }
};

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
