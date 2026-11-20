// Environment parsing and validation (docs/PLAN.md "Env vars").
// Values are never logged. `.env.local` is loaded only outside production and only if present.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EMAIL_RE, parseAllowlist } from './lead/email.js';
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
  /** Per-response session lifetime (Amendment 5). */
  sessionTtlHours: number;
  /** Idea feedback JSONL on the persistent disk; null = in memory. */
  feedbackPath: string | null;
  feedbackRetentionDays: number;
  /** Bearer token for /api/admin/*; null = admin routes off (404). ≥32 characters. */
  adminToken: string | null;
  /** 'off' = no share store; share and email are hidden. */
  shareLinks: 'on' | 'off';
  /** One JSON file per shared report; null = in memory. */
  reportsDir: string | null;
  shareRetentionDays: number;
  shareMaxFiles: number;
  shareMinFreeMb: number;
  /** Amendment 5 Phase 4: 'resend' or null (email off). */
  mailProvider: 'resend' | null;
  mailApiKey: string | null;
  /** Parsed From, "Name <addr>" or "addr"; null when unset or unparseable (warned). */
  mailFrom: string | null;
  /** Bare address; null when unset or unparseable (warned). */
  mailReplyTo: string | null;
  /** Report emails per UTC day across all visitors. */
  mailDailyMax: number;
  /** One line at the foot of the report email (registered company details). */
  mailFooterLine: string;
  /**
   * Provider, key, From and an https PUBLIC_ORIGIN are all in place. The email feature also needs
   * the share store, which is only known at boot (see server/index.ts and buildApp).
   */
  mailConfigured: boolean;
  /** Amendment 5 Phase 5: 'serpapi', 'fixture' (dev/test only) or null (search off). */
  searchProvider: 'serpapi' | 'fixture' | null;
  searchApiKey: string | null;
  /** Industry research cache (JSON) on the persistent disk; null = in memory. */
  searchCachePath: string | null;
  searchCacheDays: number;
  /** Search provider requests per UTC day (each research run makes two). */
  searchDailyMax: number;
  /** Non-fatal configuration problems, logged once at boot. Never contain values. */
  warnings: string[];
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

/** Default footer line of the report email until MAIL_FOOTER_LINE gives the registered details. */
export const DEFAULT_MAIL_FOOTER = 'Offshorly Ltd';
export const MAIL_FOOTER_MAX = 200;
const MAIL_NAME_RE = /^[^<>"\\\x00-\x1f\x7f]{1,64}$/;

/**
 * MAIL_FROM: "Name <addr@domain>" or "addr@domain". Index-based (no backtracking regex over the
 * whole value); the address must pass the gate's EMAIL_RE. Returns the normalised form or null.
 */
export const parseMailFrom = (raw: string): string | null => {
  const v = raw.trim();
  if (v.length > 320) return null;
  if (v.endsWith('>')) {
    const lt = v.lastIndexOf('<');
    if (lt < 0) return null;
    const name = v.slice(0, lt).trim();
    const addr = v.slice(lt + 1, -1).trim();
    if (!EMAIL_RE.test(addr)) return null;
    if (!name) return addr;
    return MAIL_NAME_RE.test(name) ? `${name} <${addr}>` : null;
  }
  return EMAIL_RE.test(v) ? v : null;
};

/** One line, control characters and runs of whitespace collapsed, at most MAIL_FOOTER_MAX characters. */
export const sanitiseFooterLine = (raw: string): string =>
  raw
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAIL_FOOTER_MAX)
    .trim();

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

  const adminToken = str(env, 'ADMIN_TOKEN');
  if (adminToken !== null && adminToken.length < 32) throw new ConfigError('ADMIN_TOKEN must be at least 32 characters.');

  const shareRaw = str(env, 'SHARE_LINKS')?.toLowerCase() ?? 'on';
  if (shareRaw !== 'on' && shareRaw !== 'off') throw new ConfigError('SHARE_LINKS must be on or off.');

  // ----- Email the report (Phase 4). Problems switch email off with a warning; never fatal. -----
  const warnings: string[] = [];
  const mailRaw = str(env, 'MAIL_PROVIDER')?.toLowerCase() ?? null;
  if (mailRaw !== null && mailRaw !== 'resend') warnings.push('MAIL_PROVIDER must be resend or empty: report email is off.');
  const mailProvider = mailRaw === 'resend' ? 'resend' : null;
  const mailApiKey = str(env, 'MAIL_API_KEY');
  const mailFromRaw = str(env, 'MAIL_FROM');
  const mailFrom = mailFromRaw ? parseMailFrom(mailFromRaw) : null;
  const replyRaw = str(env, 'MAIL_REPLY_TO');
  const mailReplyTo = replyRaw && EMAIL_RE.test(replyRaw) ? replyRaw : null;
  const footerRaw = str(env, 'MAIL_FOOTER_LINE');
  const footer = footerRaw ? sanitiseFooterLine(footerRaw) : '';
  if (footerRaw && footerRaw.trim().length > MAIL_FOOTER_MAX) warnings.push(`MAIL_FOOTER_LINE is longer than ${MAIL_FOOTER_MAX} characters and was cut.`);
  let mailConfigured = false;
  if (mailProvider) {
    if (!mailApiKey) warnings.push('MAIL_PROVIDER is set but MAIL_API_KEY is empty: report email is off.');
    else if (!mailFrom) warnings.push('MAIL_FROM is missing or not a valid "Name <address>": report email is off.');
    else if (!publicOrigin || !publicOrigin.startsWith('https:')) {
      warnings.push('PUBLIC_ORIGIN must be an https origin for report email: report email is off.');
    } else mailConfigured = true;
    if (replyRaw && !mailReplyTo) warnings.push('MAIL_REPLY_TO is not a valid address and is ignored.');
  }

  // ----- Web-search grounding (Phase 5). Problems switch search off with a warning; never fatal. -----
  const searchRaw = str(env, 'SEARCH_PROVIDER')?.toLowerCase() ?? null;
  const searchApiKey = str(env, 'SEARCH_API_KEY');
  let searchProvider: Config['searchProvider'] = null;
  if (searchRaw === 'serpapi') searchProvider = 'serpapi';
  else if (searchRaw === 'fixture') {
    if (isProduction) warnings.push('SEARCH_PROVIDER=fixture is not allowed in production (it feeds sample results to real reports): web search is off.');
    else searchProvider = 'fixture';
  } else if (searchRaw !== null) {
    // Only SerpApi is built (its API shape was verified); a Serper adapter can follow once its docs are.
    warnings.push('SEARCH_PROVIDER must be serpapi (or fixture outside production) or empty: web search is off.');
  }
  if (searchProvider === 'serpapi' && !searchApiKey) {
    warnings.push('SEARCH_PROVIDER is set but SEARCH_API_KEY is empty: web search is off.');
    searchProvider = null;
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
    sessionTtlHours: int(env, 'SESSION_TTL_HOURS', 24, 1, 72),
    feedbackPath: str(env, 'FEEDBACK_PATH'),
    // Capped at a year: the footer and privacy copy promise "up to a year" (src/content/copy.ts).
    feedbackRetentionDays: int(env, 'FEEDBACK_RETENTION_DAYS', 365, 1, 365),
    adminToken,
    shareLinks: shareRaw,
    reportsDir: str(env, 'REPORTS_DIR'),
    shareRetentionDays: int(env, 'SHARE_RETENTION_DAYS', 30, 1, 365),
    shareMaxFiles: int(env, 'SHARE_MAX_FILES', 5000, 1, 1_000_000),
    shareMinFreeMb: int(env, 'SHARE_MIN_FREE_MB', 150, 0, 1_000_000),
    mailProvider,
    mailApiKey,
    mailFrom,
    mailReplyTo,
    // Resend's free tier allows 100 a day; 90 leaves headroom for manual sends.
    mailDailyMax: int(env, 'MAIL_DAILY_MAX', 90, 0, 1_000_000),
    mailFooterLine: footer || DEFAULT_MAIL_FOOTER,
    mailConfigured,
    searchProvider,
    searchApiKey,
    searchCachePath: str(env, 'SEARCH_CACHE_PATH'),
    searchCacheDays: int(env, 'SEARCH_CACHE_DAYS', 7, 1, 30),
    // SerpApi's free plan: 250 searches a month, 50 an hour. Each research run makes two.
    searchDailyMax: int(env, 'SEARCH_DAILY_MAX', 20, 0, 100_000),
    warnings,
  };
};
