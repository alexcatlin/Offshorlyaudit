// Fastify app factory. `buildApp(deps)` wires config, limits, routes, static files and headers;
// tests drive it with `app.inject` and injected network/AI deps.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyServerOptions } from 'fastify';
import { AI_SLOTS_PER_AUDIT, limitAiConcurrency } from './audit/aiEngine.js';
import type { AuditDeps, runAudit } from './audit/runAudit.js';
import type { Config } from './config.js';
import { DAY, DailyCounter, HOUR, MINUTE, Semaphore, SlidingWindowLimiter, TtlLruCache } from './http/limits.js';
import type { Clock } from './http/limits.js';
import { createIpHasher, originAllowed, rateLimitSubject, securityHeaders, sendError } from './http/security.js';
import type { CrmSync } from './crm/sync.js';
import { MemoryFeedbackStore } from './feedback/store.js';
import { MemoryMetricsStore } from './metrics/store.js';
import type { MetricsStore } from './metrics/store.js';
import type { FeedbackStore } from './feedback/store.js';
import { createSessionStore } from './http/sessions.js';
import { createEmailChecker } from './lead/email.js';
import type { MxResolver } from './lead/email.js';
import { MemoryLedger } from './lead/ledger.js';
import type { AuditLedger } from './lead/ledger.js';
import { registerAuditRoutes } from './routes/audit.js';
import type { AuditEntry } from './routes/audit.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerEventRoutes } from './routes/events.js';
import { registerFeedbackRoutes } from './routes/feedback.js';
import { registerShareRoutes, ROBOTS_NONE } from './routes/share.js';
import { MemoryReportStore } from './share/store.js';
import type { ReportStore } from './share/store.js';
import type { Mailer } from './mail/types.js';
import type { Features } from '../shared/types.js';

export const BODY_LIMIT = 8 * 1024;
export const CACHE_MAX_ENTRIES = 500;
export const RESULT_LIMIT_HOURLY = 30;
export const FEEDBACK_LIMIT_HOURLY = 60;
/** Per IP; generous because an office can share one address. Counting is a speed bump, not a control. */
export const EVENT_LIMIT_HOURLY = 300;
export const SHARE_WRITE_LIMIT_HOURLY = 10;
export const SHARE_READ_LIMIT_HOURLY = 60;
export const ADMIN_LIMIT_HOURLY = 10;
/** POST /api/share/email per IP. */
export const EMAIL_LIMIT_HOURLY = 5;
/** Report emails per email key per 24 h, across sessions. */
export const EMAIL_PER_KEY_DAILY = 3;

export type AppConfig = Pick<
  Config,
  | 'aiMode'
  | 'version'
  | 'isProduction'
  | 'publicOrigin'
  | 'allowedOrigins'
  | 'allowedFrameAncestors'
  | 'rateLimitHourly'
  | 'rateLimitDaily'
  | 'dailyAiAudits'
  | 'maxConcurrentAudits'
  | 'cacheTtlMin'
  | 'trustProxyHops'
  | 'typekitKitUrl'
  | 'emailGate'
  | 'emailHashSecret'
  | 'auditAllowlist'
  | 'crmSyncAllowlisted'
  | 'sessionTtlHours'
  | 'adminToken'
  | 'shareLinks'
  | 'shareRetentionDays'
  | 'shareMaxFiles'
  | 'mailDailyMax'
  | 'mailFooterLine'
>;

export interface AppDeps {
  config: AppConfig;
  /** Audit dependencies, minus the per-request pieces the routes add. */
  audit: Omit<AuditDeps, 'takeAiQuota'>;
  /** Built client (dist/client); null/missing → no static files (dev uses Vite). */
  clientDir?: string | null;
  logger?: FastifyServerOptions['logger'];
  now?: Clock;
  /** Salt for IP hashing; random per process by default. */
  ipSalt?: string;
  /** True when the Anthropic key or model was refused at boot (AI is off). */
  aiConfigError?: boolean;
  /** One-audit-per-email record; default in memory. */
  ledger?: AuditLedger;
  /** CRM sync; null/omitted = CRM off. */
  crm?: CrmSync | null;
  /** DNS for the email MX check; default node:dns. */
  mxResolver?: MxResolver;
  /** Test seam for the orchestrator. */
  runAudit?: typeof runAudit;
  /** Wait limits for the result endpoints (tests shorten them). */
  aiWaitMs?: number;
  buyerFitWaitMs?: number;
  /** AI analyses in flight; default AI_SLOTS_PER_AUDIT × maxConcurrentAudits. */
  aiMaxConcurrent?: number;
  /** Idea feedback store; default in memory. */
  feedback?: FeedbackStore;
  /** Daily counters (spec 001); default in memory. */
  metrics?: MetricsStore;
  /** Shared report store; undefined → in memory, null → sharing off. SHARE_LINKS=off always wins. */
  reports?: ReportStore | null;
  /** Test seam: how long a share waits for the AI results (15 s). */
  snapshotWaitMs?: number;
  /**
   * Report email (Phase 4). Built at boot only when MAIL_* is complete; the feature is on only
   * with a mailer, the share store and an https PUBLIC_ORIGIN.
   */
  mailer?: Mailer | null;
}

const escapeAttr = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export const injectTypekit = (html: string, kitUrl: string | null): string =>
  html.replace('<!--TYPEKIT-->', kitUrl ? `<link rel="stylesheet" href="${escapeAttr(kitUrl)}">` : '');

/**
 * Path for the request log: query dropped, and share ids (read capabilities) replaced with
 * ":id" wherever they appear (so "//r/<id>" and "/r/<id>/" are redacted too). A lookbehind
 * instead of a leading "/+" keeps it linear on long runs of slashes.
 */
export const logPath = (url: string): string =>
  (url.split('?')[0] ?? '')
    .replace(/(?<=\/)r\/[A-Za-z0-9_-]{22}/g, 'r/:id')
    .replace(/(?<=\/)api\/share\/[A-Za-z0-9_-]{22}/g, 'api/share/:id')
    .replace(/(?<=\/)api\/admin\/share\/[A-Za-z0-9_-]{22}/g, 'api/admin/share/:id');

/** index.html for /r/:id: the robots meta says noindex, nofollow, noarchive. */
export const sharedPageHtml = (html: string): string => {
  const meta = `<meta name="robots" content="${ROBOTS_NONE}" />`;
  const replaced = html.replace(/<meta name="robots"[^>]*>/, meta);
  return replaced !== html ? replaced : html.replace('<head>', `<head>${meta}`);
};

export const buildApp = async (deps: AppDeps): Promise<FastifyInstance> => {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const hashIp = createIpHasher(deps.ipSalt);
  // Limiter key: IPv6 bucketed to /64 and mapped IPv4 unwrapped before hashing.
  const ipKey = (req: FastifyRequest) => hashIp(rateLimitSubject(req.ip));

  // Raw IPs never reach the logs: the request serializer records a salted hash instead of
  // Fastify's default remoteAddress, and drops query strings.
  // Share ids are rewritten to ":id" (Amendment 5): a shareId is a read capability.
  const reqSerializer = (req: FastifyRequest) => ({ method: req.method, url: logPath(req.url), ip: hashIp(req.ip) });
  let logger: FastifyServerOptions['logger'] = false;
  if (deps.logger) {
    const base = typeof deps.logger === 'object' ? deps.logger : {};
    logger = { ...base, serializers: { ...(base as { serializers?: object }).serializers, req: reqSerializer } };
  }

  // Trust the first N hops nearest the server (Render's proxy appends the real client to
  // X-Forwarded-For). Fastify 5.12+ treats a numeric trustProxy as "trust nothing", so the hop
  // count is expressed as a function: address i (0 = socket peer) is a proxy when i < N.
  const hops = config.trustProxyHops;
  const trustProxy = hops > 0 ? (_addr: string, i: number) => i < hops : false;
  const app = Fastify({ bodyLimit: BODY_LIMIT, trustProxy, logger });

  const ttlMs = config.cacheTtlMin * MINUTE;
  const policy = { publicOrigin: config.publicOrigin, allowedOrigins: config.allowedOrigins };
  const checkOrigin = (req: FastifyRequest) => originAllowed(req, policy);
  const byId = new TtlLruCache<AuditEntry>({ ttlMs, maxEntries: CACHE_MAX_ENTRIES, now });

  const headers = securityHeaders({
    frameAncestors: config.allowedFrameAncestors,
    typekit: !!config.typekitKitUrl,
    hsts: true,
  });
  app.addHook('onSend', async (req, reply, payload) => {
    // Only Referrer-Policy may be set by a route (no-referrer on /r/:id); CSP, nosniff, HSTS
    // and Permissions-Policy are always ours.
    for (const [k, v] of Object.entries(headers)) {
      if (k === 'referrer-policy' && reply.hasHeader(k)) continue;
      reply.header(k, v);
    }
    reply.removeHeader('x-frame-options');
    if (req.url.startsWith('/api/') || req.url === '/healthz') reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err: { statusCode?: number; code?: string; message?: string }, req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status < 500) {
      return sendError(reply, status, { code: 'bad_request', error: status === 413 ? 'Request too large.' : 'Bad request.' });
    }
    req.log.error({ err }, 'unhandled error');
    return sendError(reply, 500, { code: 'server_error', error: 'Something went wrong.' });
  });

  app.setNotFoundHandler((req, reply) => sendError(reply, 404, { code: 'not_found', error: 'Not found.' }));

  const ledger = deps.ledger ?? new MemoryLedger({ now });
  const crm = deps.crm ?? null;
  const feedback = deps.feedback ?? new MemoryFeedbackStore({ now });
  const metrics = deps.metrics ?? new MemoryMetricsStore({ now });
  let reports: ReportStore | null = null;
  if (config.shareLinks !== 'off') {
    reports =
      deps.reports === undefined
        ? new MemoryReportStore({ retentionDays: config.shareRetentionDays, maxFiles: config.shareMaxFiles, now })
        : deps.reports;
  }
  const mailer = reports && deps.mailer && config.publicOrigin?.startsWith('https:') ? deps.mailer : null;
  const research = deps.audit.research ?? null;
  const features: Features = { share: !!reports, email: !!mailer, feedback: true, shareRetentionDays: config.shareRetentionDays };
  const sessions = createSessionStore({ ttlMs: config.sessionTtlHours * HOUR, now });

  app.get('/healthz', async () => ({
    ok: true,
    aiMode: config.aiMode,
    ...(deps.aiConfigError ? { aiConfigError: true } : {}),
    version: config.version,
    ledger: ledger.kind,
    crm: !!crm,
    feedback: feedback.kind,
    metrics: metrics.kind,
    shares: reports ? reports.kind : 'off',
    mail: !!mailer,
    search: !!research,
  }));

  // Every audit that may run at once can hold both its AI slots.
  const aiSlots = deps.aiMaxConcurrent ?? AI_SLOTS_PER_AUDIT * config.maxConcurrentAudits;
  registerAuditRoutes(app, {
    audit: {
      ...deps.audit,
      ai: deps.audit.ai ? limitAiConcurrency(deps.audit.ai, new Semaphore(aiSlots)) : null,
    },
    auditLimiter: new SlidingWindowLimiter({
      windows: [
        { ms: HOUR, max: config.rateLimitHourly },
        { ms: DAY, max: config.rateLimitDaily },
      ],
      now,
    }),
    resultLimiter: new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: RESULT_LIMIT_HOURLY }], now }),
    aiQuota: new DailyCounter(config.dailyAiAudits, now),
    semaphore: new Semaphore(config.maxConcurrentAudits),
    byKey: new TtlLruCache<AuditEntry>({ ttlMs, maxEntries: CACHE_MAX_ENTRIES, now }),
    byId,
    ipKey,
    checkOrigin,
    ...(deps.aiWaitMs !== undefined ? { aiWaitMs: deps.aiWaitMs } : {}),
    ...(deps.buyerFitWaitMs !== undefined ? { buyerFitWaitMs: deps.buyerFitWaitMs } : {}),
    lead: {
      gate: config.emailGate,
      secret: config.emailHashSecret,
      allowlist: config.auditAllowlist,
      crmSyncAllowlisted: config.crmSyncAllowlisted,
      ledger,
      emailChecker: createEmailChecker({ ...(deps.mxResolver ? { resolver: deps.mxResolver } : {}), now }),
      crm,
      now,
    },
    sessions,
    metrics,
    features,
    ...(deps.runAudit ? { runAudit: deps.runAudit } : {}),
  });

  registerFeedbackRoutes(app, {
    store: feedback,
    sessions,
    limiter: new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: FEEDBACK_LIMIT_HOURLY }], now }),
    ipKey,
    checkOrigin,
    now,
  });

  registerEventRoutes(app, {
    metrics,
    sessions,
    limiter: new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: EVENT_LIMIT_HOURLY }], now }),
    ipKey,
    checkOrigin,
  });

  if (reports) {
    registerShareRoutes(app, {
      store: reports,
      sessions,
      writeLimiter: new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: SHARE_WRITE_LIMIT_HOURLY }], now }),
      readLimiter: new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: SHARE_READ_LIMIT_HOURLY }], now }),
      ipKey,
      checkOrigin,
      publicOrigin: config.publicOrigin,
      retentionDays: config.shareRetentionDays,
      now,
      metrics,
      ...(deps.snapshotWaitMs !== undefined ? { snapshotWaitMs: deps.snapshotWaitMs } : {}),
      email: mailer
        ? {
            mailer,
            secret: config.emailHashSecret,
            limiter: new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: EMAIL_LIMIT_HOURLY }], now }),
            perKey: new SlidingWindowLimiter({ windows: [{ ms: DAY, max: EMAIL_PER_KEY_DAILY }], now }),
            daily: new DailyCounter(config.mailDailyMax, now),
            footerLine: config.mailFooterLine,
          }
        : null,
    });
  }

  // Admin only with a token (config enforces ≥32 characters); otherwise /api/admin/* is a 404.
  if (config.adminToken && config.adminToken.length >= 32) {
    registerAdminRoutes(app, {
      token: config.adminToken,
      feedback,
      metrics,
      now,
      reports,
      research,
      limiter: new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: ADMIN_LIMIT_HOURLY }], now }),
      ipKey,
    });
  }

  // ----- Static client -----
  const clientDir = deps.clientDir ?? null;
  const indexPath = clientDir ? join(clientDir, 'index.html') : null;
  if (clientDir && indexPath && existsSync(indexPath)) {
    const indexHtml = injectTypekit(readFileSync(indexPath, 'utf8'), config.typekitKitUrl);
    await app.register(fastifyStatic, {
      root: clientDir,
      index: false,
      wildcard: true,
      cacheControl: false,
      allowedPath: (pathName) => pathName !== '/index.html',
      setHeaders: (reply, filePath) => {
        reply.header(
          'cache-control',
          filePath.includes(`${join(clientDir, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
        );
      },
    });
    app.get('/', async (_req, reply) =>
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(indexHtml),
    );
    // Print window for "Save as PDF" (Amendment 5 Phase 1): the same app, routed client-side.
    app.get('/print', async (_req, reply) =>
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').header('x-robots-tag', 'noindex').send(indexHtml),
    );
    // Shared report page (Phase 3). Served for any id: the client shows the expired page on a 404.
    // Not listed in robots.txt (that would advertise the path); noindex headers and meta instead.
    if (reports) {
      const sharedHtml = sharedPageHtml(indexHtml);
      app.get('/r/:shareId', async (_req, reply) =>
        reply
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-store')
          .header('x-robots-tag', ROBOTS_NONE)
          .header('referrer-policy', 'no-referrer')
          .send(sharedHtml),
      );
    }
  }

  return app;
};
