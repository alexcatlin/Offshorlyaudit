// Industry research (Amendment 5 Phase 5): two server-owned web searches per industry, cached.
//
// - Queries come from INDUSTRIES[id].searchQueries only: never a visitor's answers, email or the
//   audited domain. Nothing about the visitor or their site is ever sent to the provider.
// - Cache key `${provider}:${industryId}:${QUERIES_VERSION}`, TTL SEARCH_CACHE_DAYS; in-flight
//   de-duplication; SEARCH_DAILY_MAX caps provider requests per UTC day (each run makes two; failed
//   runs count too, no refund); persisted at SEARCH_CACHE_PATH as one JSON file (atomic tmp +
//   rename, 0600; corrupt → ignored; entries with no results are dropped on load).
// - Failures: a failed refresh is negatively cached with backoff per industry: 30 min, 2 h, then
//   6 h for each further consecutive failure; a success (or no_results) resets the streak. A
//   refresh that succeeds but yields no usable result (and no query failed) is negatively cached
//   for 24 h with reason no_results and is not written to the cache. A failure with http_401 or
//   http_403 pauses the provider for every industry for 6 h; http_429 pauses it for the streak's
//   TTL. While paused, audits get `negative` without a provider call or a daily-counter take.
// - Timings: an audit waits at most 4 s (RESEARCH_WAIT_MS) and then continues without results; the
//   refresh is not tied to the audit and keeps running for up to 20 s (SEARCH_TIMEOUT_MS, the
//   provider request timeout), so a slow provider still fills the cache for later audits. Only a
//   real provider failure or the 20 s timeout is negatively cached, never the audit's 4 s wait.
// - Diagnosis: every `industry_research` log line carries `status`, `ms` and, on failure, a
//   `reason` code (http_<status>, timeout, network, bad_json, too_large, provider_error, error,
//   no_results, daily_cap, wait_timeout): never a URL, key or response body. Statuses: ok, failed,
//   capped, wait_timeout, paused (logged once when an account-wide pause is set). The last audit
//   and refresh outcome per industry is kept in memory for the admin view (reset on restart).
// - Hygiene: HTML, entities, control and bidi characters stripped; title ≤120, snippet ≤300; URL
//   http(s), no userinfo, default port, hostname not an IP literal, ≤500 chars; host blocklist
//   (social, video and pin sites, offshorly.com); one result per host; ≤8 kept. Per audit the
//   audited domain (and its sub- and parent domains) is dropped and the rest numbered S1…S8.
// - We never fetch a result URL. The only host contacted is the provider's.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { INDUSTRIES, isIndustryId } from '../../shared/industries.js';
import type { IndustryId } from '../../shared/industries.js';
import type { IndustryResearchInput, ResearchCache, ResearchSource } from '../ai/types.js';
import { capChars, stripUrlsAndHtml } from '../ai/text.js';
import { DailyCounter, DAY, HOUR, MINUTE } from '../http/limits.js';
import type { Clock } from '../http/limits.js';
import { SearchError } from './types.js';
import type { SearchHit, SearchProvider } from './types.js';

/** Bump when any industry's searchQueries change: old cache entries are then ignored. */
export const QUERIES_VERSION = 1;
/** Longest an audit waits for research before calling the model without it. */
export const RESEARCH_WAIT_MS = 4_000;
/**
 * Provider request timeout (both queries share it). Deliberately longer than RESEARCH_WAIT_MS:
 * uncached Google searches often take more than 4 s, and a late answer must still fill the cache.
 */
export const SEARCH_TIMEOUT_MS = 20_000;
export const RESULTS_PER_QUERY = 6;
export const MAX_RESULTS = 8;
/** Negative-cache TTL by consecutive failure count (1st, 2nd, 3rd and later). */
export const NEGATIVE_TTLS_MS: readonly number[] = [30 * MINUTE, 2 * HOUR, 6 * HOUR];
export const NEGATIVE_TTL_MS = NEGATIVE_TTLS_MS[0]!;
/** A refresh that succeeded with no usable result is not retried for this long. */
export const NO_RESULTS_TTL_MS = 24 * HOUR;
/** Account-wide pause after http_401 / http_403 (bad or disabled key). */
export const AUTH_PAUSE_MS = 6 * HOUR;
export const TITLE_MAX = 120;
export const SNIPPET_MAX = 300;
export const URL_MAX = 500;
/** Raw provider text is cut to this before cleaning, so cleaning cost is bounded per result. */
const RAW_TEXT_MAX = 1_500;

/** Social, video and pin sites, and our own domain. A host matches itself and its subdomains. */
export const BLOCKED_HOSTS: readonly string[] = [
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'linkedin.com',
  'tiktok.com',
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
  'reddit.com',
  'threads.net',
  'snapchat.com',
  'quora.com',
  'offshorly.com',
];

export type ResearchLog = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

export interface CachedHit {
  title: string;
  snippet: string;
  url: string;
  /** Hostname without "www.". */
  domain: string;
}

interface Entry {
  industryId: IndustryId;
  fetchedAt: number;
  expiresAt: number;
  results: CachedHit[];
}

export interface ResearchListing {
  industryId: IndustryId;
  fetchedAt: string;
  expiresAt: string;
  results: { title: string; domain: string; url: string }[];
}

/** Last outcome per industry (admin): why research is, or is not, there. No URL, key or body. */
export interface ResearchOutcome {
  industryId: IndustryId;
  /** The last audit that asked for this industry. */
  lastAudit: { cache: ResearchCache; at: string } | null;
  /** The last provider refresh that finished. `reason` is null on success. */
  lastRefresh: { status: 'ok' | 'failed'; reason: string | null; results: number; ms: number; at: string } | null;
  /** Set while a failure is negatively cached. */
  negativeUntil: string | null;
  /** A refresh is running now. */
  inflight: boolean;
}

export interface IndustryResearch {
  readonly provider: SearchProvider['name'];
  /** Never rejects. `research.sources` is empty when nothing usable came back in time. */
  forAudit(industryId: IndustryId | null, opts: { auditedDomain: string }): Promise<IndustryResearchInput>;
  /** Cached entries (admin). */
  list(): ResearchListing[];
  /** Last outcome per industry asked for since start (admin). */
  outcomes(): ResearchOutcome[];
  /** ISO time until which the provider is paused for every industry; null when not paused (admin). */
  pausedUntil(): string | null;
  /** Waits for a pending cache write. */
  close(): Promise<void>;
}

export interface ResearchOptions {
  provider: SearchProvider;
  ttlDays: number;
  dailyMax: number;
  /** JSON cache file; null = memory only. */
  path?: string | null;
  /** Create the cache file's directory if missing (outside production). */
  createDir?: boolean;
  now?: Clock;
  log?: ResearchLog;
  waitMs?: number;
  timeoutMs?: number;
}

// ---------- Hygiene ----------

// C0/C1 controls, zero-width and bidi controls.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g;

/** Plain text: no HTML, entities, URLs, emails or control characters; capped at `max`. */
export const cleanResultText = (raw: unknown, max: number): string => {
  if (typeof raw !== 'string') return '';
  const s = stripUrlsAndHtml(raw.slice(0, RAW_TEXT_MAX).replace(CONTROL, ' '));
  return s ? capChars(s, max) : '';
};

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A result URL fit to show as a link, with its display domain; null when refused. */
export const safeResultUrl = (raw: unknown): { url: string; domain: string } | null => {
  if (typeof raw !== 'string' || raw.length > URL_MAX) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port !== '') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253 || host.startsWith('[') || host.includes(':') || IPV4.test(host)) return null;
  if (!host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return null;
  const url = u.toString();
  if (url.length > URL_MAX) return null;
  return { url, domain: host.replace(/^www\./, '') };
};

const sameOrSub = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

export const isBlockedHost = (domain: string): boolean =>
  BLOCKED_HOSTS.some((b) => sameOrSub(domain, b)) || domain.split('.').includes('pinterest');

/** Cleaned, validated, one per host, at most MAX_RESULTS. */
export const cleanHits = (hits: readonly SearchHit[]): CachedHit[] => {
  const out: CachedHit[] = [];
  const hosts = new Set<string>();
  for (const h of hits) {
    if (out.length >= MAX_RESULTS) break;
    const u = safeResultUrl(h?.url);
    if (!u || isBlockedHost(u.domain) || hosts.has(u.domain)) continue;
    const title = cleanResultText(h.title, TITLE_MAX);
    if (!title) continue;
    hosts.add(u.domain);
    out.push({ title, snippet: cleanResultText(h.snippet, SNIPPET_MAX), url: u.url, domain: u.domain });
  }
  return out;
};

/** Drops the audited site (itself, its subdomains and its parent domains) and numbers the rest. */
export const sourcesForAudit = (results: readonly CachedHit[], auditedDomain: string): ResearchSource[] => {
  const audited = auditedDomain.toLowerCase().replace(/^www\./, '');
  return results
    .filter((r) => !(audited && (sameOrSub(r.domain, audited) || sameOrSub(audited, r.domain))))
    .slice(0, MAX_RESULTS)
    .map((r, i) => ({ id: `S${i + 1}`, title: r.title, snippet: r.snippet, url: r.url, domain: r.domain }));
};

// ---------- Cache ----------

const parseEntry = (v: unknown, provider: string, now: number): [string, Entry] | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isIndustryId(o.industryId) || typeof o.fetchedAt !== 'number' || typeof o.expiresAt !== 'number') return null;
  if (o.expiresAt <= now || !Array.isArray(o.results)) return null;
  const key = cacheKey(provider, o.industryId);
  if (o.key !== key) return null;
  // Re-clean on load: the file is ours, but the rules may have tightened since it was written.
  const results = cleanHits(o.results as SearchHit[]);
  // An empty entry (written before no_results existed) would block a refresh for the whole TTL.
  if (!results.length) return null;
  return [key, { industryId: o.industryId, fetchedAt: o.fetchedAt, expiresAt: o.expiresAt, results }];
};

export const cacheKey = (provider: string, industryId: IndustryId): string => `${provider}:${industryId}:${QUERIES_VERSION}`;

/** A loggable reason code: http_<status>, timeout, network, bad_json, too_large, provider_error or error. */
export const reasonOf = (e: unknown): string => {
  if (!(e instanceof SearchError)) return 'error';
  return typeof e.reason === 'number' ? `http_${e.reason}` : e.reason;
};

export const createIndustryResearch = async (opts: ResearchOptions): Promise<IndustryResearch> => {
  const provider = opts.provider;
  const now = opts.now ?? Date.now;
  const log: ResearchLog = opts.log ?? (() => undefined);
  const ttlMs = opts.ttlDays * DAY;
  const waitMs = opts.waitMs ?? RESEARCH_WAIT_MS;
  const timeoutMs = opts.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const daily = new DailyCounter(opts.dailyMax, now);
  const cache = new Map<string, Entry>();
  const negative = new Map<string, number>();
  /** Consecutive failed refreshes per cache key (backoff index). */
  const failStreak = new Map<string, number>();
  /** Account-wide: no provider call before this time (after 401/403/429). */
  let pausedUntil = 0;
  const inflight = new Map<string, Promise<Entry | null>>();
  const lastAudit = new Map<IndustryId, NonNullable<ResearchOutcome['lastAudit']>>();
  const lastRefresh = new Map<IndustryId, NonNullable<ResearchOutcome['lastRefresh']>>();
  let path = opts.path ?? null;
  let writes: Promise<void> = Promise.resolve();

  if (path) {
    try {
      if (opts.createDir) await mkdir(dirname(path), { recursive: true });
      const text = await readFile(path, 'utf8');
      const data = JSON.parse(text) as { v?: unknown; entries?: unknown };
      if (data.v !== 1 || !Array.isArray(data.entries)) throw new Error('bad shape');
      for (const e of data.entries) {
        const parsed = parseEntry(e, provider.name, now());
        if (parsed) cache.set(parsed[0], parsed[1]);
      }
      log('info', 'search cache loaded', { entries: cache.size });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOENT') log('info', 'search cache empty', {});
      else if (code) {
        log('error', 'search cache unavailable: in memory only', { error: code });
        path = null;
      } else log('warn', 'search cache unreadable: ignored', {});
    }
  }

  const persist = () => {
    if (!path) return;
    const file = path;
    const t = now();
    const entries = [...cache].filter(([, e]) => e.expiresAt > t).map(([key, e]) => ({ key, ...e }));
    const body = JSON.stringify({ v: 1, entries });
    writes = writes
      .then(async () => {
        const tmp = `${file}.tmp`;
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, file);
      })
      .catch((e: unknown) => log('error', 'search cache write failed', { error: (e as { code?: string }).code ?? 'error' }));
  };

  /** Records a failed refresh (call after logging it): backoff, and an account-wide pause on 401/403/429. */
  const failRefresh = (industryId: IndustryId, key: string, reason: string, ms: number) => {
    const t = now();
    const streak = (failStreak.get(key) ?? 0) + 1;
    failStreak.set(key, streak);
    const ttl = NEGATIVE_TTLS_MS[Math.min(streak - 1, NEGATIVE_TTLS_MS.length - 1)]!;
    negative.set(key, t + ttl);
    lastRefresh.set(industryId, { status: 'failed', reason, results: 0, ms, at: new Date(t).toISOString() });
    const pauseMs = reason === 'http_401' || reason === 'http_403' ? AUTH_PAUSE_MS : reason === 'http_429' ? ttl : 0;
    if (pauseMs && t + pauseMs > pausedUntil) {
      pausedUntil = t + pauseMs;
      log('warn', 'industry_research', { industryId, provider: provider.name, status: 'paused', reason, ms: 0 });
    }
  };

  // Runs to completion whether or not any audit is still waiting: it is never tied to an audit.
  const fetchFresh = async (industryId: IndustryId, key: string): Promise<Entry | null> => {
    const started = now();
    // A timer (not AbortSignal.timeout) so the refresh always settles by timeoutMs, even if a
    // provider ignored the signal.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    const timedOut = new Promise<never>((_, reject) => {
      ac.signal.addEventListener('abort', () => reject(new SearchError('timeout')), { once: true });
    });
    timedOut.catch(() => undefined);
    const queries = INDUSTRIES[industryId].searchQueries;
    let settled: PromiseSettledResult<SearchHit[]>[];
    try {
      // Each query settles on its own: one failing never aborts or discards the other.
      settled = await Promise.allSettled(
        queries.map((q) =>
          Promise.race([provider.search(q, { num: RESULTS_PER_QUERY, country: 'gb', lang: 'en', signal: ac.signal }), timedOut]),
        ),
      );
    } finally {
      clearTimeout(timer);
    }
    const ok = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    const failed = settled.flatMap((s) => (s.status === 'rejected' ? [reasonOf(s.reason)] : []));
    const ms = Math.round(now() - started);
    // First query's results first, then the second's.
    const results = cleanHits(ok.flat());
    if (!results.length && failed.length) {
      // Nothing usable and a query failed: the failure is the cause (all failed, or one failed and
      // the other came back empty). Backoff applies.
      const reason = failed[0]!;
      log('warn', 'industry_research', { industryId, provider: provider.name, status: 'failed', reason, reasons: failed, ms });
      failRefresh(industryId, key, reason, ms);
      return null;
    }
    const t = now();
    if (!results.length) {
      // Every query succeeded with nothing usable: not cached (an empty entry would hide the
      // industry for the whole cache TTL), not a provider fault, retried after 24 h.
      negative.set(key, t + NO_RESULTS_TTL_MS);
      failStreak.delete(key);
      lastRefresh.set(industryId, { status: 'failed', reason: 'no_results', results: 0, ms, at: new Date(t).toISOString() });
      log('warn', 'industry_research', { industryId, provider: provider.name, status: 'failed', reason: 'no_results', ms });
      return null;
    }
    const entry: Entry = { industryId, fetchedAt: t, expiresAt: t + ttlMs, results };
    cache.set(key, entry);
    negative.delete(key);
    failStreak.delete(key);
    persist();
    lastRefresh.set(industryId, { status: 'ok', reason: null, results: results.length, ms, at: new Date(t).toISOString() });
    log('info', 'industry_research', {
      industryId,
      provider: provider.name,
      status: 'ok',
      results: results.length,
      ...(failed.length ? { reasons: failed } : {}),
      ms,
    });
    return entry;
  };

  const outcome = (industryId: IndustryId | null, cacheState: ResearchCache, entry: Entry | null, auditedDomain: string): IndustryResearchInput => ({
    industryId,
    cache: cacheState,
    searchedAt: entry ? new Date(entry.fetchedAt).toISOString() : null,
    sources: entry ? sourcesForAudit(entry.results, auditedDomain) : [],
  });

  const waitFor = <T>(p: Promise<T>): Promise<T | 'timeout'> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), waitMs);
    });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  };

  const forAudit = async (industryId: IndustryId, auditedDomain: string): Promise<IndustryResearchInput> => {
    const key = cacheKey(provider.name, industryId);
    const t = now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > t) return outcome(industryId, 'hit', hit, auditedDomain);
    if (hit) cache.delete(key);
    const neg = negative.get(key);
    if (neg !== undefined && neg > t) return outcome(industryId, 'negative', null, auditedDomain);
    // Account paused (bad key or rate limited): no provider call, nothing taken from the counter.
    if (t < pausedUntil) return outcome(industryId, 'negative', null, auditedDomain);
    let p = inflight.get(key);
    if (!p) {
      if (!daily.tryTake(INDUSTRIES[industryId].searchQueries.length)) {
        log('warn', 'industry_research', { industryId, provider: provider.name, status: 'capped', reason: 'daily_cap', ms: 0 });
        return outcome(industryId, 'capped', null, auditedDomain);
      }
      const started = now();
      p = fetchFresh(industryId, key)
        .catch(() => {
          // Unexpected (fetchFresh handles provider errors itself): still a refresh failure.
          const ms = Math.round(now() - started);
          log('error', 'industry_research', { industryId, provider: provider.name, status: 'failed', reason: 'error', ms });
          failRefresh(industryId, key, 'error', ms);
          return null;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const r = await waitFor(p);
    if (r === 'timeout') {
      // The audit stops waiting; the refresh carries on and is not negatively cached.
      log('info', 'industry_research', { industryId, provider: provider.name, status: 'wait_timeout', reason: 'wait_timeout', ms: waitMs });
      return outcome(industryId, 'timeout', null, auditedDomain);
    }
    return r ? outcome(industryId, 'miss', r, auditedDomain) : outcome(industryId, 'error', null, auditedDomain);
  };

  return {
    provider: provider.name,
    async forAudit(industryId, { auditedDomain }) {
      if (!industryId) return outcome(null, 'none', null, auditedDomain);
      const out = await forAudit(industryId, auditedDomain);
      lastAudit.set(industryId, { cache: out.cache, at: new Date(now()).toISOString() });
      return out;
    },
    outcomes() {
      const t = now();
      const ids = new Set<IndustryId>([...lastAudit.keys(), ...lastRefresh.keys()]);
      return [...ids].map((industryId) => {
        const key = cacheKey(provider.name, industryId);
        const neg = negative.get(key);
        return {
          industryId,
          lastAudit: lastAudit.get(industryId) ?? null,
          lastRefresh: lastRefresh.get(industryId) ?? null,
          negativeUntil: neg !== undefined && neg > t ? new Date(neg).toISOString() : null,
          inflight: inflight.has(key),
        };
      });
    },
    pausedUntil() {
      return now() < pausedUntil ? new Date(pausedUntil).toISOString() : null;
    },
    list() {
      const t = now();
      return [...cache.values()]
        .filter((e) => e.expiresAt > t)
        .map((e) => ({
          industryId: e.industryId,
          fetchedAt: new Date(e.fetchedAt).toISOString(),
          expiresAt: new Date(e.expiresAt).toISOString(),
          results: e.results.map((r) => ({ title: r.title, domain: r.domain, url: r.url })),
        }));
    },
    async close() {
      await writes;
    },
  };
};
