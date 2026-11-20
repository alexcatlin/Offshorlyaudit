// Fastify app factory. `buildApp(deps)` wires config, limits, routes, static files and headers;
// tests drive it with `app.inject` and injected network/AI deps.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyServerOptions } from 'fastify';
import { AI_SLOTS_PER_AUDIT, limitAiConcurrency } from './audit/aiEngine.js';
import type { AuditDeps } from './audit/runAudit.js';
import type { Config } from './config.js';
import { DAY, DailyCounter, HOUR, MINUTE, Semaphore, SlidingWindowLimiter, TtlLruCache } from './http/limits.js';
import type { Clock } from './http/limits.js';
import { createIpHasher, originAllowed, rateLimitSubject, securityHeaders, sendError } from './http/security.js';
import { registerAuditRoutes } from './routes/audit.js';
import type { AuditEntry } from './routes/audit.js';
import { registerLeadRoute } from './routes/lead.js';
import type { LeadFetch } from './routes/lead.js';

export const BODY_LIMIT = 8 * 1024;
export const CACHE_MAX_ENTRIES = 500;
export const RESULT_LIMIT_HOURLY = 30;
export const LEAD_LIMIT_HOURLY = 10;

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
  | 'leadWebhookUrl'
  | 'typekitKitUrl'
>;

export interface AppDeps {
  config: AppConfig;
  /** Audit dependencies, minus the per-request pieces the routes add. */
  audit: Omit<AuditDeps, 'takeAiQuota' | 'leadCapture'>;
  /** Built client (dist/client); null/missing → no static files (dev uses Vite). */
  clientDir?: string | null;
  logger?: FastifyServerOptions['logger'];
  now?: Clock;
  /** Salt for IP hashing; random per process by default. */
  ipSalt?: string;
  leadFetch?: LeadFetch;
  /** Wait limits for the result endpoints (tests shorten them). */
  aiWaitMs?: number;
  buyerFitWaitMs?: number;
  /** AI analyses in flight; default AI_SLOTS_PER_AUDIT × maxConcurrentAudits. */
  aiMaxConcurrent?: number;
}

const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const injectTypekit = (html: string, kitUrl: string | null): string =>
  html.replace('<!--TYPEKIT-->', kitUrl ? `<link rel="stylesheet" href="${escapeAttr(kitUrl)}">` : '');

export const buildApp = async (deps: AppDeps): Promise<FastifyInstance> => {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const hashIp = createIpHasher(deps.ipSalt);
  // Limiter key: IPv6 bucketed to /64 and mapped IPv4 unwrapped before hashing.
  const ipKey = (req: FastifyRequest) => hashIp(rateLimitSubject(req.ip));

  // Raw IPs never reach the logs: the request serializer records a salted hash instead of
  // Fastify's default remoteAddress, and drops query strings.
  const reqSerializer = (req: FastifyRequest) => ({ method: req.method, url: req.url.split('?')[0], ip: hashIp(req.ip) });
  let logger: FastifyServerOptions['logger'] = false;
  if (deps.logger) {
    const base = typeof deps.logger === 'object' ? deps.logger : {};
    logger = { ...base, serializers: { ...((base as { serializers?: object }).serializers ?? {}), req: reqSerializer } };
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
    reply.headers(headers);
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

  app.get('/healthz', async () => ({ ok: true, aiMode: config.aiMode, version: config.version }));

  // Every audit that may run at once can hold both its AI slots.
  const aiSlots = deps.aiMaxConcurrent ?? AI_SLOTS_PER_AUDIT * config.maxConcurrentAudits;
  registerAuditRoutes(app, {
    audit: {
      ...deps.audit,
      ai: deps.audit.ai ? limitAiConcurrency(deps.audit.ai, new Semaphore(aiSlots)) : null,
      leadCapture: !!config.leadWebhookUrl,
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
  });

  if (config.leadWebhookUrl) {
    registerLeadRoute(app, {
      webhookUrl: config.leadWebhookUrl,
      limiter: new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: LEAD_LIMIT_HOURLY }], now }),
      ipKey,
      checkOrigin,
      topIdeas: (auditId, domain) => {
        const e = byId.get(auditId);
        if (!e || e.report.domain !== domain.replace(/^www\./, '')) return [];
        return (e.aiResult?.ai?.opportunities ?? []).map((o) => o.title).slice(0, 3);
      },
      ...(deps.leadFetch ? { fetchImpl: deps.leadFetch } : {}),
      now,
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
  }

  return app;
};
