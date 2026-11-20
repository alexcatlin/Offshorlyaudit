// Environment parsing and validation (docs/PLAN.md "Env vars").
// Values are never logged. `.env.local` is loaded only outside production and only if present.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAllowlist } from './lead/email.js';
import type { Allowlist } from './lead/email.js';

export type AiMode = 'live' | 'fixture' | 'off';

export interface Config {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  logLevel: string;
  version: string;
  anthropicApiKey: string | null;
  auditModel: string | null;
  aiMode: AiMode;
  pagespeedApiKey: string | null;
  wordfenceApiKey: string | null;
  /** e.g. https://audit.offshorly.com; null until a domain is set. */
  publicOrigin: string | null;
  /** Extra request origins allowed to call the API. */
  allowedOrigins: string[];
  /** CSP frame-ancestors sources (after 'self'). */
  allowedFrameAncestors: string[];
  rateLimitHourly: number;
  rateLimitDaily: number;
  dailyAiAudits: number;
  maxConcurrentAudits: number;
  cacheTtlMin: number;
  trustProxyHops: number;
  typekitKitUrl: string | null;
  /** One free audit per email; 'off' still requires and syncs the email. */
  emailGate: 'on' | 'off';
  /** HMAC secret for the gate key. Random per process when unset (see emailHashSecretGenerated). */
  emailHashSecret: string;
  emailHashSecretGenerated: boolean;
  /** JSONL ledger on the persistent disk; null = in memory. */
  ledgerPath: string | null;
  ledgerRetentionDays: number;
  /** Addresses/domains that skip the gate and are never recorded. */
  auditAllowlist: Allowlist;
  /** Sync allow-listed audits to the CRM too (Note title prefixed "[Test] "). */
  crmSyncAllowlisted: boolean;
  /** Twenty origin; null (or no key) = CRM off. */
  twentyApiUrl: string | null;
  twentyApiKey: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
export const DEFAULT_FRAME_ANCESTORS = ['https://offshorly.com', 'https://www.offshorly.com'];
export const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:8787'];
export const DEFAULT_ALLOWLIST = ['@offshorly.com'];

const str = (env: Env, key: string): string | null => {
  const v = env[key]?.trim();
  return v ? v : null;
};

const int = (env: Env, key: string, def: number, min: number, max: number): number => {
  const raw = str(env, key);
  if (raw === null) return def;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${key} must be a whole number.`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${key} must be between ${min} and ${max}.`);
  return n;
};

/** Parse an http(s) origin ("https://host[:port]") with no path. */
const parseOrigin = (key: string, value: string): string => {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ConfigError(`${key} contains an invalid origin.`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ConfigError(`${key} must use http or https.`);
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) {
    throw new ConfigError(`${key} must be bare origins (no path).`);
  }
  return u.origin;
};

const list = (env: Env, key: string): string[] | null => {
  const raw = str(env, key);
  return raw === null ? null : raw.split(/[\s,]+/).filter(Boolean);
};

/** CSP host-source: scheme://host[:port] with an optional leading "*." wildcard. No quotes, semicolons or paths. */
const FRAME_SOURCE_RE = /^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/i;

const readVersion = (env: Env): string => {
  if (env.npm_package_version) return env.npm_package_version;
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
};

/**
 * Load `.env.local` into process.env when it exists and NODE_ENV is not production.
 * Uses Node's built-in loader; values are never printed. Returns whether a file was loaded.
 */
export const loadLocalEnv = (file = resolve(process.cwd(), '.env.local'), env: Env = process.env): boolean => {
  if (env.NODE_ENV === 'production' || !existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
};

export const loadConfig = (env: Env = process.env): Config => {
  const nodeEnv = str(env, 'NODE_ENV') ?? 'development';
  const isProduction = nodeEnv === 'production';

  const anthropicApiKey = str(env, 'ANTHROPIC_API_KEY');
  const modeRaw = str(env, 'AI_MODE')?.toLowerCase() ?? null;
  if (modeRaw !== null && !['live', 'fixture', 'off'].includes(modeRaw)) {
    throw new ConfigError('AI_MODE must be live, fixture or off.');
  }
  const aiMode: AiMode = (modeRaw as AiMode | null) ?? (anthropicApiKey ? 'live' : isProduction ? 'off' : 'fixture');
  if (aiMode === 'fixture' && isProduction) {
    throw new ConfigError('AI_MODE=fixture is not allowed in production: it shows sample output to real visitors.');
  }
  if (aiMode === 'live' && !anthropicApiKey) throw new ConfigError('AI_MODE=live needs ANTHROPIC_API_KEY.');

  const publicOriginRaw = str(env, 'PUBLIC_ORIGIN');
  const publicOrigin = publicOriginRaw ? parseOrigin('PUBLIC_ORIGIN', publicOriginRaw) : null;
  const allowedOrigins = (list(env, 'ALLOWED_ORIGINS') ?? (isProduction ? [] : DEV_ORIGINS)).map((o) =>
    parseOrigin('ALLOWED_ORIGINS', o),
  );

  const frameAncestors = list(env, 'ALLOWED_FRAME_ANCESTORS') ?? DEFAULT_FRAME_ANCESTORS;
  for (const f of frameAncestors) {
    if (!FRAME_SOURCE_RE.test(f)) throw new ConfigError('ALLOWED_FRAME_ANCESTORS must be space-separated origins like https://example.com.');
  }

  const typekitKitUrl = str(env, 'TYPEKIT_KIT_URL');
  if (typekitKitUrl && !/^https:\/\/use\.typekit\.net\/[a-z0-9]+\.css$/i.test(typekitKitUrl)) {
    throw new ConfigError('TYPEKIT_KIT_URL must look like https://use.typekit.net/<kit>.css.');
  }

  const gateRaw = str(env, 'EMAIL_GATE')?.toLowerCase() ?? 'on';
  if (gateRaw !== 'on' && gateRaw !== 'off') throw new ConfigError('EMAIL_GATE must be on or off.');

  const secretRaw = str(env, 'EMAIL_HASH_SECRET');
  if (secretRaw !== null && secretRaw.length < 16) throw new ConfigError('EMAIL_HASH_SECRET must be at least 16 characters.');

  const allowEntries = list(env, 'AUDIT_ALLOWLIST') ?? DEFAULT_ALLOWLIST;
  const allow = parseAllowlist(allowEntries);
  if (!allow.ok) throw new ConfigError('AUDIT_ALLOWLIST entries must be email addresses or @domain.');

  const crmAllowRaw = str(env, 'CRM_SYNC_ALLOWLISTED')?.toLowerCase() ?? 'false';
  if (crmAllowRaw !== 'true' && crmAllowRaw !== 'false') throw new ConfigError('CRM_SYNC_ALLOWLISTED must be true or false.');

  const twentyRaw = str(env, 'TWENTY_API_URL');
  let twentyApiUrl: string | null = null;
  if (twentyRaw) {
    twentyApiUrl = parseOrigin('TWENTY_API_URL', twentyRaw);
    const host = new URL(twentyApiUrl).hostname;
    const localHttp = twentyApiUrl.startsWith('http:') && (host === 'localhost' || host === '127.0.0.1') && !isProduction;
    if (!twentyApiUrl.startsWith('https:') && !localHttp) {
      throw new ConfigError('TWENTY_API_URL must be an https origin (http://localhost is allowed outside production).');
    }
  }

  const logLevel = str(env, 'LOG_LEVEL')?.toLowerCase() ?? 'info';
  if (!LOG_LEVELS.includes(logLevel)) throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}.`);

  return {
    nodeEnv,
    isProduction,
    port: int(env, 'PORT', 8787, 1, 65_535),
    logLevel,
    version: readVersion(env),
    anthropicApiKey,
    auditModel: str(env, 'AUDIT_MODEL'),
    aiMode,
    pagespeedApiKey: str(env, 'PAGESPEED_API_KEY'),
    wordfenceApiKey: str(env, 'WORDFENCE_API_KEY'),
    publicOrigin,
    allowedOrigins,
    allowedFrameAncestors: frameAncestors,
    rateLimitHourly: int(env, 'RATE_LIMIT_HOURLY', 5, 1, 100_000),
    rateLimitDaily: int(env, 'RATE_LIMIT_DAILY', 20, 1, 1_000_000),
    dailyAiAudits: int(env, 'DAILY_AI_AUDITS', 50, 0, 1_000_000),
    maxConcurrentAudits: int(env, 'MAX_CONCURRENT_AUDITS', 4, 1, 100),
    cacheTtlMin: int(env, 'CACHE_TTL_MIN', 360, 1, 10_080),
    trustProxyHops: int(env, 'TRUST_PROXY_HOPS', 1, 0, 10),
    typekitKitUrl,
    emailGate: gateRaw,
    emailHashSecret: secretRaw ?? randomBytes(32).toString('base64'),
    emailHashSecretGenerated: secretRaw === null,
    ledgerPath: str(env, 'LEDGER_PATH'),
    ledgerRetentionDays: int(env, 'LEDGER_RETENTION_DAYS', 365, 30, 1825),
    auditAllowlist: allow.value,
    crmSyncAllowlisted: crmAllowRaw === 'true',
    twentyApiUrl,
    twentyApiKey: str(env, 'TWENTY_API_KEY'),
  };
};
