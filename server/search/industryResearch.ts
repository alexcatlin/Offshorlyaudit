// Industry research (Amendment 5 Phase 5): two server-owned web searches per industry, cached.
//
// - Queries come from INDUSTRIES[id].searchQueries only: never a visitor's answers, email or the
//   audited domain. Nothing about the visitor or their site is ever sent to the provider.
// - Cache key `${provider}:${industryId}:${QUERIES_VERSION}`, TTL SEARCH_CACHE_DAYS; in-flight
//   de-duplication; a failure is negatively cached for 30 minutes; SEARCH_DAILY_MAX caps provider
//   requests per UTC day (each run makes two); persisted at SEARCH_CACHE_PATH as one JSON file
//   (atomic tmp + rename, 0600; corrupt → ignored).
// - Per audit: wait at most 4 s (RESEARCH_WAIT_MS). A late search still fills the cache.
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
import { DailyCounter, DAY, MINUTE } from '../http/limits.js';
import type { Clock } from '../http/limits.js';
import { SearchError } from './types.js';
import type { SearchHit, SearchProvider } from './types.js';

/** Bump when any industry's searchQueries change: old cache entries are then ignored. */
export const QUERIES_VERSION = 1;
/** Longest an audit waits for research before calling the model without it. */
export const RESEARCH_WAIT_MS = 4_000;
/** Provider request timeout (both queries share it). */
export const SEARCH_TIMEOUT_MS = 4_000;
export const RESULTS_PER_QUERY = 6;
export const MAX_RESULTS = 8;
export const NEGATIVE_TTL_MS = 30 * MINUTE;
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

export interface IndustryResearch {
  readonly provider: SearchProvider['name'];
  /** Never rejects. `research.sources` is empty when nothing usable came back in time. */
  forAudit(industryId: IndustryId | null, opts: { auditedDomain: string }): Promise<IndustryResearchInput>;
  /** Cached entries (admin). */
  list(): ResearchListing[];
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
  return [key, { industryId: o.industryId, fetchedAt: o.fetchedAt, expiresAt: o.expiresAt, results }];
};

export const cacheKey = (provider: string, industryId: IndustryId): string => `${provider}:${industryId}:${QUERIES_VERSION}`;

const reasonOf = (e: unknown): string => (e instanceof SearchError ? String(e.reason) : 'error');

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
  const inflight = new Map<string, Promise<Entry | null>>();
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

  const fetchFresh = async (industryId: IndustryId, key: string): Promise<Entry | null> => {
    const started = now();
    const signal = AbortSignal.timeout(timeoutMs);
    const queries = INDUSTRIES[industryId].searchQueries;
    const settled = await Promise.allSettled(
      queries.map((q) => provider.search(q, { num: RESULTS_PER_QUERY, country: 'gb', lang: 'en', signal })),
    );
    const ok = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    const failed = settled.flatMap((s) => (s.status === 'rejected' ? [reasonOf(s.reason)] : []));
    const ms = Math.round(now() - started);
    if (!ok.length) {
      negative.set(key, now() + NEGATIVE_TTL_MS);
      log('warn', 'industry_research', { industryId, provider: provider.name, status: 'failed', reasons: failed, ms });
      return null;
    }
    // First query's results first, then the second's.
    const results = cleanHits(ok.flat());
    const t = now();
    const entry: Entry = { industryId, fetchedAt: t, expiresAt: t + ttlMs, results };
    cache.set(key, entry);
    negative.delete(key);
    persist();
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

  return {
    provider: provider.name,
    async forAudit(industryId, { auditedDomain }) {
      if (!industryId) return outcome(null, 'none', null, auditedDomain);
      const key = cacheKey(provider.name, industryId);
      const t = now();
      const hit = cache.get(key);
      if (hit && hit.expiresAt > t) return outcome(industryId, 'hit', hit, auditedDomain);
      if (hit) cache.delete(key);
      const neg = negative.get(key);
      if (neg !== undefined && neg > t) return outcome(industryId, 'negative', null, auditedDomain);
      let p = inflight.get(key);
      if (!p) {
        if (!daily.tryTake(INDUSTRIES[industryId].searchQueries.length)) {
          log('warn', 'industry_research', { industryId, provider: provider.name, status: 'capped' });
          return outcome(industryId, 'capped', null, auditedDomain);
        }
        p = fetchFresh(industryId, key)
          .catch(() => {
            negative.set(key, now() + NEGATIVE_TTL_MS);
            return null;
          })
          .finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      const r = await waitFor(p);
      if (r === 'timeout') return outcome(industryId, 'timeout', null, auditedDomain);
      return r ? outcome(industryId, 'miss', r, auditedDomain) : outcome(industryId, 'error', null, auditedDomain);
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
