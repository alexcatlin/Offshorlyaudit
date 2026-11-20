// Wordfence Intelligence scanner feed (only when WORDFENCE_API_KEY is set).
//
// ============================================================================================
// DORMANT: DO NOT ENABLE. This module targets a RETIRED feed shape (the v2-era scanner format).
// Before anyone sets WORDFENCE_API_KEY it must be rebuilt against the current Wordfence
// Intelligence API, and Wordfence's terms (attribution, commercial use) must be confirmed.
// Until then leave the key unset. No further work is planned on this file as it stands.
// ============================================================================================
//
// STATUS: built against a fixture (test/fixtures/wordfence/scanner-feed.json). As of 2026-11-20
// the v2 endpoint returns 410 Gone and the v3 scanner endpoint answers 401 without a Bearer key;
// the public docs sit behind a bot challenge, so the v3 record format and the terms of use were
// NOT verified. The parser assumes the v2-era shape (object keyed by id, each record with
// software[].{type,slug,affected_versions{from_version,from_inclusive,to_version,to_inclusive},
// patched}, cvss.rating, informational). If the live feed yields no usable records the module
// stays not-ready and the audit behaves as if no key were set.
//
// Public output is aggregate only: count and highest severity. Never ids, titles or links.
import { compareVersions } from './version.js';

export const WORDFENCE_FEED_URL = 'https://www.wordfence.com/api/intelligence/v3/vulnerabilities/scanner';
export const WORDFENCE_ATTRIBUTION = 'Vulnerability data: Wordfence Intelligence (https://www.wordfence.com/threat-intel/)';

export type Severity = 'low' | 'medium' | 'high' | 'critical';
const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export interface WfRange {
  from: string;
  fromInclusive: boolean;
  to: string;
  toInclusive: boolean;
}

export interface WfEntry {
  ranges: WfRange[];
  severity: Severity;
  patched: boolean;
}

export type WfSoftwareType = 'plugin' | 'theme' | 'core';
export type WfIndex = Map<string, WfEntry[]>;

const key = (type: WfSoftwareType, slug: string): string => `${type}:${slug.toLowerCase()}`;

const toSeverity = (rating: unknown): Severity => {
  const r = typeof rating === 'string' ? rating.toLowerCase() : '';
  return r === 'critical' || r === 'high' || r === 'medium' ? r : 'low';
};

/** Add one feed record to the index. Ignores informational and malformed records. */
export const indexRecord = (index: WfIndex, record: unknown): boolean => {
  if (!record || typeof record !== 'object') return false;
  const r = record as Record<string, unknown>;
  if (r.informational === true) return false;
  const software = Array.isArray(r.software) ? r.software : [];
  const severity = toSeverity((r.cvss as Record<string, unknown> | undefined)?.rating);
  let added = false;
  for (const sw of software) {
    if (!sw || typeof sw !== 'object') continue;
    const s = sw as Record<string, unknown>;
    const type = s.type;
    const slug = s.slug;
    if ((type !== 'plugin' && type !== 'theme' && type !== 'core') || typeof slug !== 'string' || !slug) continue;
    const av = s.affected_versions;
    const rawRanges = av && typeof av === 'object' ? Object.values(av as Record<string, unknown>) : [];
    const ranges: WfRange[] = [];
    for (const rr of rawRanges) {
      if (!rr || typeof rr !== 'object') continue;
      const x = rr as Record<string, unknown>;
      if (typeof x.from_version !== 'string' || typeof x.to_version !== 'string') continue;
      ranges.push({
        from: x.from_version,
        fromInclusive: x.from_inclusive !== false,
        to: x.to_version,
        toInclusive: x.to_inclusive !== false,
      });
    }
    if (!ranges.length) continue;
    const k = key(type, slug);
    const list = index.get(k) ?? [];
    list.push({ ranges, severity, patched: s.patched === true });
    index.set(k, list);
    added = true;
  }
  return added;
};

export const versionInRange = (version: string, r: WfRange): boolean => {
  if (r.from !== '*') {
    const c = compareVersions(version, r.from);
    if (c === null || c < 0 || (c === 0 && !r.fromInclusive)) return false;
  }
  if (r.to !== '*') {
    const c = compareVersions(version, r.to);
    if (c === null || c > 0 || (c === 0 && !r.toInclusive)) return false;
  }
  return true;
};

export const matchVersion = (index: WfIndex, type: WfSoftwareType, slug: string, version: string | null): WfEntry[] => {
  if (!version) return [];
  return (index.get(key(type, slug)) ?? []).filter((e) => e.ranges.some((r) => versionInRange(version, r)));
};

export const aggregate = (matches: WfEntry[]): { count: number; highest: Severity } | null => {
  if (!matches.length) return null;
  let highest: Severity = 'low';
  for (const m of matches) if (SEVERITY_RANK[m.severity] > SEVERITY_RANK[highest]) highest = m.severity;
  return { count: matches.length, highest };
};

/**
 * Incrementally parse a top-level JSON object or array, calling onValue for each member value
 * that is itself an object/array. Keeps only the current record in memory.
 */
export const parseFeedStream = async (
  chunks: AsyncIterable<Uint8Array | string>,
  onValue: (value: unknown) => void,
): Promise<number> => {
  const decoder = new TextDecoder();
  let depth = 0;
  let inStr = false;
  let esc = false;
  let pieces: string[] | null = null;
  let emitted = 0;
  const handle = (s: string): void => {
    let start = pieces ? 0 : -1;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === 92) esc = true; // backslash
        else if (c === 34) inStr = false; // quote
        continue;
      }
      if (c === 34) {
        inStr = true;
      } else if (c === 123 || c === 91) {
        depth++;
        if (depth === 2) {
          start = i;
          pieces = [];
        }
      } else if (c === 125 || c === 93) {
        if (depth === 2 && pieces) {
          pieces.push(s.slice(start, i + 1));
          try {
            onValue(JSON.parse(pieces.join('')));
            emitted++;
          } catch {
            /* skip malformed record */
          }
          pieces = null;
          start = -1;
        }
        depth--;
      }
    }
    if (pieces && start >= 0) pieces.push(s.slice(start));
  };
  for await (const chunk of chunks) handle(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
  handle(decoder.decode());
  return emitted;
};

export const buildIndex = async (chunks: AsyncIterable<Uint8Array | string>): Promise<{ index: WfIndex; records: number }> => {
  const index: WfIndex = new Map();
  let records = 0;
  await parseFeedStream(chunks, (v) => {
    if (indexRecord(index, v)) records++;
  });
  return { index, records };
};

export type WfFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ status: number; body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | null }>;

export interface WordfenceDeps {
  apiKey: string;
  fetchImpl?: WfFetch;
  feedUrl?: string;
  refreshMs?: number;
  timeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface Wordfence {
  /** True once a feed with at least one usable record has been indexed. */
  readonly ready: boolean;
  /** Download and index now. Resolves false on failure (previous index kept). */
  refresh(): Promise<boolean>;
  /** refresh() now and every refreshMs (timer unref'd). */
  start(): Promise<boolean>;
  stop(): void;
  match(type: WfSoftwareType, slug: string, version: string | null): WfEntry[];
}

const toAsyncIterable = (body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> => {
  if (Symbol.asyncIterator in body) return body as AsyncIterable<Uint8Array>;
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    },
  };
};

/** Returns null when no key is configured: the feature is off by default. */
export const createWordfence = (deps: WordfenceDeps | null): Wordfence | null => {
  if (!deps?.apiKey) return null;
  const fetchImpl: WfFetch =
    deps.fetchImpl ?? ((u, init) => fetch(u, init) as unknown as ReturnType<WfFetch>);
  const log = deps.log ?? (() => undefined);
  let index: WfIndex = new Map();
  let ready = false;
  let timer: NodeJS.Timeout | null = null;

  const refresh = async (): Promise<boolean> => {
    try {
      const res = await fetchImpl(deps.feedUrl ?? WORDFENCE_FEED_URL, {
        signal: AbortSignal.timeout(deps.timeoutMs ?? 180_000),
        headers: { authorization: `Bearer ${deps.apiKey}`, accept: 'application/json' },
      });
      if (res.status !== 200 || !res.body) {
        log('wordfence feed fetch failed', { status: res.status });
        return false;
      }
      const built = await buildIndex(toAsyncIterable(res.body));
      if (!built.records) {
        log('wordfence feed had no usable records; leaving disabled');
        return false;
      }
      index = built.index;
      ready = true;
      log('wordfence feed indexed', { records: built.records, slugs: built.index.size });
      return true;
    } catch (err) {
      log('wordfence feed error', { error: (err as Error).message });
      return false;
    }
  };

  return {
    get ready() {
      return ready;
    },
    refresh,
    start: async () => {
      const ok = await refresh();
      if (!timer) {
        timer = setInterval(() => void refresh(), deps.refreshMs ?? 24 * 3_600_000);
        timer.unref();
      }
      return ok;
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    match: (type, slug, version) => (ready ? matchVersion(index, type, slug, version) : []),
  };
};
