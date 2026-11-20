// WordPress.org public APIs (no key): core stable-check, plugins/info 1.2, themes/info 1.2.
// Fixed trusted hosts, so these don't go through fetchSafe. Concurrency 5, 5 s timeout,
// 256 KB cap, in-memory cache (12 h per slug, 6 h for stable-check). Response shapes are
// recorded in test/fixtures/wporg/ (listed, closed, not listed).
import { decodeEntities } from '../site/html.js';

export type StableStatus = 'latest' | 'outdated' | 'insecure';
export type StableCheckMap = Record<string, StableStatus>;

export interface DirectoryInfo {
  directory: 'listed' | 'closed' | 'not_listed' | 'unknown';
  name: string | null;
  latest: string | null;
  /** YYYY-MM-DD */
  lastUpdated: string | null;
}

export interface WpOrgClient {
  /** null if the API couldn't be reached. */
  stableCheck(): Promise<StableCheckMap | null>;
  plugin(slug: string): Promise<DirectoryInfo>;
  theme(slug: string): Promise<DirectoryInfo>;
}

export type WpOrgFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ status: number; body?: ReadableStream<Uint8Array> | null; text(): Promise<string> }>;

export interface WpOrgDeps {
  fetchImpl?: WpOrgFetch;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  concurrency?: number;
  slugTtlMs?: number;
  stableTtlMs?: number;
  /** Hard cap on cached slugs (LRU). Default WPORG_CACHE_MAX. */
  maxCacheEntries?: number;
}

export const WPORG_CACHE_MAX = 2_000;

export const WPORG_API = 'https://api.wordpress.org';
const HOUR = 3_600_000;

const SLUG_RE = /^[a-z0-9_-]{1,100}$/;

const PLUGIN_FIELDS_OFF = ['sections', 'description', 'reviews', 'banners', 'icons', 'screenshots', 'versions', 'contributors', 'tags', 'ratings', 'donate_link', 'compatibility'];
const THEME_FIELDS_OFF = ['sections', 'description', 'screenshot_url', 'tags', 'ratings', 'reviews_url'];

export const pluginInfoUrl = (slug: string): string => {
  const q = new URLSearchParams({ action: 'plugin_information', 'request[slug]': slug });
  for (const f of PLUGIN_FIELDS_OFF) q.set(`request[fields][${f}]`, '0');
  return `${WPORG_API}/plugins/info/1.2/?${q.toString()}`;
};

export const themeInfoUrl = (slug: string): string => {
  const q = new URLSearchParams({ action: 'theme_information', 'request[slug]': slug });
  for (const f of THEME_FIELDS_OFF) q.set(`request[fields][${f}]`, '0');
  return `${WPORG_API}/themes/info/1.2/?${q.toString()}`;
};

export const STABLE_CHECK_URL = `${WPORG_API}/core/stable-check/1.0/`;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Directory names arrive HTML-encoded ("Jetpack &#8211; WP Security…"): decode, strip tags. */
const cleanName = (v: unknown): string | null => {
  const s = str(v);
  return s ? str(decodeEntities(s.replace(/<[^<>]*>/g, '')).replace(/\s+/g, ' ')) : null;
};

const dateOnly = (v: unknown): string | null => str(v)?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;

/** Map a plugins/info or themes/info JSON body (200 or 404) to DirectoryInfo. */
export const parseDirectoryResponse = (status: number, json: unknown): DirectoryInfo => {
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const err = str(o.error);
  if (err === 'closed' || o.closed === true) {
    // The closure reason is deliberately not read: we show "closed" only.
    return { directory: 'closed', name: cleanName(o.name), latest: null, lastUpdated: dateOnly(o.closed_date) };
  }
  if (err && /not found/i.test(err)) return { directory: 'not_listed', name: null, latest: null, lastUpdated: null };
  if (status === 200 && !err && str(o.slug) && str(o.version)) {
    return {
      directory: 'listed',
      name: cleanName(o.name),
      latest: str(o.version),
      lastUpdated: dateOnly(o.last_updated) ?? dateOnly(o.last_updated_time),
    };
  }
  return { directory: 'unknown', name: null, latest: null, lastUpdated: null };
};

export const parseStableCheck = (json: unknown): StableCheckMap | null => {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const out: StableCheckMap = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (v === 'latest' || v === 'outdated' || v === 'insecure') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
};

export const latestCoreVersion = (map: StableCheckMap): string | null =>
  Object.entries(map).find(([, s]) => s === 'latest')?.[0] ?? null;

/** Look a version up in the stable-check map, trying "6.4.0" ↔ "6.4". */
export const stableStatusOf = (map: StableCheckMap, version: string): StableStatus | null => {
  const tries = [version, version.replace(/^(\d+\.\d+)\.0$/, '$1'), /^\d+\.\d+$/.test(version) ? `${version}.0` : ''];
  for (const t of tries) if (t && map[t]) return map[t]!;
  return null;
};

const readCapped = async (
  res: { body?: ReadableStream<Uint8Array> | null; text(): Promise<string> },
  maxBytes: number,
): Promise<string> => {
  if (!res.body) {
    const t = await res.text();
    if (t.length > maxBytes) throw new Error('response too large');
    return t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

const createLimiter = (max: number) => {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
};

export const createWpOrgClient = (deps: WpOrgDeps = {}): WpOrgClient => {
  const fetchImpl: WpOrgFetch = deps.fetchImpl ?? ((u, init) => fetch(u, init));
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const maxBytes = deps.maxBytes ?? 256_000;
  const slugTtl = deps.slugTtlMs ?? 12 * HOUR;
  const stableTtl = deps.stableTtlMs ?? 6 * HOUR;
  const maxEntries = deps.maxCacheEntries ?? WPORG_CACHE_MAX;
  const limit = createLimiter(deps.concurrency ?? 5);
  // LRU with a hard cap: attacker pages can add up to 15 slugs per audit.
  const cache = new Map<string, { expires: number; value: Promise<unknown> }>();

  const getJson = (url: string): Promise<{ status: number; json: unknown }> =>
    limit(async () => {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'user-agent': 'OffshorlyAuditBot/1.0 (+https://offshorly.com)' },
      });
      const body = await readCapped(res, maxBytes);
      return { status: res.status, json: JSON.parse(body) as unknown };
    });

  /** Cache successful values; failures (keep: false) are not cached. */
  const cached = <T>(key: string, ttl: number, load: () => Promise<{ value: T; keep: boolean }>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      cache.delete(key); // refresh recency
      cache.set(key, hit);
      return hit.value as Promise<T>;
    }
    const entry = { expires: now() + ttl, value: undefined as unknown as Promise<unknown> };
    const p = load().then(({ value, keep }) => {
      if (!keep && cache.get(key) === entry) cache.delete(key);
      return value;
    });
    entry.value = p;
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > maxEntries) {
      const t = now();
      for (const [k, v] of cache) if (v.expires <= t) cache.delete(k);
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
    return p;
  };

  const directory = (kind: 'plugin' | 'theme', slug: string): Promise<DirectoryInfo> => {
    const s = slug.toLowerCase();
    if (!SLUG_RE.test(s)) return Promise.resolve({ directory: 'unknown', name: null, latest: null, lastUpdated: null });
    return cached(`${kind}:${s}`, slugTtl, async () => {
      try {
        const { status, json } = await getJson(kind === 'plugin' ? pluginInfoUrl(s) : themeInfoUrl(s));
        const value = parseDirectoryResponse(status, json);
        return { value, keep: value.directory !== 'unknown' };
      } catch {
        return { value: { directory: 'unknown', name: null, latest: null, lastUpdated: null }, keep: false };
      }
    });
  };

  return {
    stableCheck: () =>
      cached('core:stable-check', stableTtl, async () => {
        try {
          const { status, json } = await getJson(STABLE_CHECK_URL);
          const value = status === 200 ? parseStableCheck(json) : null;
          return { value, keep: value !== null };
        } catch {
          return { value: null, keep: false };
        }
      }),
    plugin: (slug) => directory('plugin', slug),
    theme: (slug) => directory('theme', slug),
  };
};
