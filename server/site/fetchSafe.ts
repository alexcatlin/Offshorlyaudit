// The only way to fetch anything from a target site. BUILD_GUIDE §5.2:
// assertPublicUrl on every hop, manual redirects (max 5), 10 s per request, 1.5 MB cap, honest UA.
// Every hop is appended to the fetch log so tests and the harness can assert what was requested.
import { fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';
import { SiteReadError, findCause, isBlockedAddressError } from './errors.js';
import { assertPublicUrl, createSafeAgent, defaultResolveAll } from './ssrf.js';
import type { ResolveAll } from './ssrf.js';

export const USER_AGENT = 'Mozilla/5.0 (compatible; OffshorlyAuditBot/1.0; +https://offshorly.com)';
export const DEFAULT_MAX_BYTES = 1_500_000;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;
/** PLAN Phase 3: at most 10 target fetches per audit (pages, robots, sitemap, http://, feed, theme CSS). */
export const DEFAULT_MAX_FETCHES = 10;

/** Minimal response shape we need; satisfied by both undici's and the global Response. */
export interface FetchLikeResponse {
  status: number;
  headers: {
    get(name: string): string | null;
    forEach(cb: (value: string, key: string) => void): void;
    getSetCookie?: () => string[];
  };
  body: ReadableStream<Uint8Array> | null | AsyncIterable<Uint8Array>;
}

export interface FetchLikeInit {
  method: 'GET';
  redirect: 'manual';
  signal: AbortSignal;
  headers: Record<string, string>;
  dispatcher?: Dispatcher;
}

export type FetchLike = (url: string, init: FetchLikeInit) => Promise<FetchLikeResponse>;

export interface FetchSafeOptions {
  /** Throw 'unreadable' unless content-type contains "html". */
  requireHtml?: boolean;
  /** Throw 'unreadable' on a non-2xx final status. */
  requireOk?: boolean;
  maxBytes?: number;
  accept?: string;
}

export interface SafeResponse {
  /** URL originally requested. */
  url: string;
  /** URL of the final response after redirects. */
  finalUrl: string;
  status: number;
  /** Lower-cased header names; repeated headers joined with ", " (except set-cookie). */
  headers: Record<string, string>;
  setCookies: string[];
  body: string;
  /** Decoded bytes read (up to maxBytes). */
  bytes: number;
  truncated: boolean;
  /** Time from the final hop's request until its response headers arrived. */
  ttfbMs: number;
  redirects: number;
}

export interface FetchLogEntry {
  url: string;
  status: number | null;
  error?: string;
}

export interface FetchSafe {
  (url: string | URL, opts?: FetchSafeOptions): Promise<SafeResponse>;
  /** Every request made to a target (one entry per hop), in order. */
  readonly log: FetchLogEntry[];
}

export interface FetchSafeDeps {
  fetchImpl?: FetchLike;
  /** DNS resolver for the pre-check and (with the default fetch) the connect-time guard. */
  resolveAll?: ResolveAll;
  /** undici dispatcher; defaults to a guarded Agent built from resolveAll (only used with the default fetch). */
  dispatcher?: Dispatcher;
  now?: () => number;
  timeoutMs?: number;
  /** Cap on top-level calls (not hops). */
  maxFetches?: number;
}

const defaultFetch: FetchLike = (url, init) =>
  undiciFetch(url, init) as unknown as Promise<FetchLikeResponse>;

let sharedAgent: Dispatcher | null = null;
const getSharedAgent = (): Dispatcher => (sharedAgent ??= createSafeAgent(defaultResolveAll));

const collectHeaders = (res: FetchLikeResponse): { headers: Record<string, string>; setCookies: string[] } => {
  const headers: Record<string, string> = {};
  const setCookies: string[] = [];
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === 'set-cookie') {
      setCookies.push(value);
      return;
    }
    headers[k] = headers[k] ? `${headers[k]}, ${value}` : value;
  });
  if (typeof res.headers.getSetCookie === 'function') {
    const list = res.headers.getSetCookie();
    if (list.length) return { headers, setCookies: list };
  }
  return { headers, setCookies };
};

const cancelBody = async (body: FetchLikeResponse['body']): Promise<void> => {
  try {
    if (body && 'cancel' in body && typeof body.cancel === 'function') await body.cancel();
  } catch {
    /* ignore */
  }
};

const readCapped = async (
  body: FetchLikeResponse['body'],
  maxBytes: number,
): Promise<{ buf: Uint8Array; truncated: boolean }> => {
  if (!body) return { buf: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  if ('getReader' in body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (total + value.byteLength > maxBytes) {
          chunks.push(value.subarray(0, maxBytes - total));
          total = maxBytes;
          truncated = true;
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      if (truncated) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } else {
    for await (const value of body as AsyncIterable<Uint8Array>) {
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { buf, truncated };
};

const charsetOf = (contentType: string): string => {
  const m = contentType.match(/charset=["']?([\w-]+)/i);
  const cs = m?.[1]?.toLowerCase();
  if (!cs) return 'utf-8';
  try {
    new TextDecoder(cs);
    return cs;
  } catch {
    return 'utf-8';
  }
};

const isTimeout = (err: unknown): boolean => {
  const name = (err as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
};

/**
 * Build a per-audit fetcher. Each audit should create its own so the log and fetch budget
 * are per audit. Tests inject fetchImpl + resolveAll and run with no network.
 */
export const createFetchSafe = (deps: FetchSafeDeps = {}): FetchSafe => {
  const resolveAll = deps.resolveAll ?? defaultResolveAll;
  const usingDefaultFetch = !deps.fetchImpl;
  const fetchImpl = deps.fetchImpl ?? defaultFetch;
  const now = deps.now ?? (() => performance.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFetches = deps.maxFetches ?? DEFAULT_MAX_FETCHES;
  const dispatcher =
    deps.dispatcher ??
    (usingDefaultFetch ? (deps.resolveAll ? createSafeAgent(resolveAll) : getSharedAgent()) : undefined);
  const log: FetchLogEntry[] = [];
  let calls = 0;

  const fetchSafe = async (input: string | URL, opts: FetchSafeOptions = {}): Promise<SafeResponse> => {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    let current: URL;
    try {
      current = new URL(String(input));
    } catch {
      throw new SiteReadError('not_found', "That doesn't look like a website address.");
    }
    if (calls >= maxFetches) {
      throw new SiteReadError('unreadable', 'Fetch budget for this audit is used up.');
    }
    calls++;
    const startUrl = current.href;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(current, resolveAll);
      const entry: FetchLogEntry = { url: current.href, status: null };
      log.push(entry);
      const signal = AbortSignal.timeout(timeoutMs);
      const started = now();
      let res: FetchLikeResponse;
      try {
        res = await fetchImpl(current.href, {
          method: 'GET',
          redirect: 'manual',
          signal,
          headers: {
            'user-agent': USER_AGENT,
            accept: opts.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-GB,en;q=0.8',
          },
          ...(dispatcher ? { dispatcher } : {}),
        });
      } catch (err) {
        if (findCause(err, isBlockedAddressError)) {
          entry.error = 'blocked';
          throw new SiteReadError('not_found', "That address can't be audited.");
        }
        if (isTimeout(err) || signal.aborted) {
          entry.error = 'timeout';
          throw new SiteReadError('unreadable', 'The site took too long to respond.');
        }
        const code = findCause(err, (e): e is Error & { code: string } => typeof (e as { code?: unknown })?.code === 'string')?.code;
        entry.error = code ?? 'fetch_failed';
        if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
          throw new SiteReadError('not_found', "We couldn't find a website at that address.");
        }
        throw new SiteReadError('unreadable', "We couldn't connect to the site.");
      }
      const ttfbMs = Math.max(0, Math.round(now() - started));
      entry.status = res.status;

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await cancelBody(res.body);
        if (hop === MAX_REDIRECTS) break;
        try {
          current = new URL(location, current);
        } catch {
          throw new SiteReadError('unreadable', 'The site sent us to an invalid address.');
        }
        continue;
      }

      const { headers, setCookies } = collectHeaders(res);
      const ok = res.status >= 200 && res.status < 300;
      if (opts.requireOk && !ok) {
        await cancelBody(res.body);
        throw new SiteReadError(
          'unreadable',
          [401, 403, 429].includes(res.status)
            ? 'The site refused our automated visit.'
            : `The site returned an error (status ${res.status}).`,
        );
      }
      const contentType = headers['content-type'] ?? '';
      if (opts.requireHtml && !/html/i.test(contentType)) {
        await cancelBody(res.body);
        throw new SiteReadError('unreadable', 'The address did not return a web page.');
      }
      let buf: Uint8Array;
      let truncated: boolean;
      try {
        ({ buf, truncated } = await readCapped(res.body, maxBytes));
      } catch (err) {
        if (isTimeout(err) || signal.aborted) {
          entry.error = 'timeout';
          throw new SiteReadError('unreadable', 'The site took too long to respond.');
        }
        entry.error = 'body_failed';
        throw new SiteReadError('unreadable', "We couldn't read the site's response.");
      }
      const body = new TextDecoder(charsetOf(contentType)).decode(buf);
      return {
        url: startUrl,
        finalUrl: current.href,
        status: res.status,
        headers,
        setCookies,
        body,
        bytes: buf.byteLength,
        truncated,
        ttfbMs,
        redirects: hop,
      };
    }
    throw new SiteReadError('unreadable', 'The site redirected too many times.');
  };

  return Object.assign(fetchSafe, { log }) as FetchSafe;
};
