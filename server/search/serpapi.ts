// SerpApi adapter (Amendment 5 Phase 5). The only file that knows SerpApi's API shape.
//
// Verified against serpapi.com/search-api (2026-11-20):
//   GET https://serpapi.com/search?engine=google&q=…&gl=uk&hl=en&google_domain=google.co.uk&api_key=…
//   There is no documented `num` parameter: none is sent; the first N organic results are kept.
//   Results: organic_results[] with position, title, link, displayed_link, snippet.
//   Errors: JSON {"error": "..."} with 400/401/403/404/410/429 (hourly throughput or out of
//   searches)/500/503. "No results" is HTTP 200 with a top-level `error` string and
//   organic_results possibly absent: treated as an empty list, not a failure.
//   Identical queries within an hour are served from SerpApi's cache for free: `no_cache` is
//   never sent.
//
// The API key is a query parameter, so the request URL is a secret: it is never logged, never put
// in an error message, and fetch errors (which may carry it) are dropped, not rethrown. Redirects
// are refused, the body is capped at 512 KB, and only this fixed host is ever called.
import { SearchError } from './types.js';
import type { SearchHit, SearchOptions, SearchProvider } from './types.js';

export const SERPAPI_ENDPOINT = 'https://serpapi.com/search';
export const SEARCH_MAX_BYTES = 512 * 1024;

export type SearchFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; redirect: 'error'; signal: AbortSignal },
) => Promise<Response>;

export interface SerpApiOptions {
  apiKey: string;
  fetchImpl?: SearchFetch;
  maxBytes?: number;
}

/** SerpApi's country code for the United Kingdom is `uk` (Google's own gl value). */
const GL: Record<SearchOptions['country'], string> = { gb: 'uk' };
const GOOGLE_DOMAIN: Record<SearchOptions['country'], string> = { gb: 'google.co.uk' };

/** Reads at most `max` bytes of the body; more → SearchError('too_large'). */
export const readCapped = async (res: Response, max: number): Promise<string> => {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new SearchError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

/** organic_results → hits; tolerant of absent or malformed entries. */
export const parseSerpApi = (data: unknown, num: number): SearchHit[] => {
  if (!data || typeof data !== 'object') throw new SearchError('bad_json');
  const organic = (data as { organic_results?: unknown }).organic_results;
  if (!Array.isArray(organic)) return []; // "no results" (200 with a top-level error) or absent
  const out: SearchHit[] = [];
  for (const r of organic) {
    if (out.length >= num) break;
    if (!r || typeof r !== 'object') continue;
    const { title, link, snippet } = r as { title?: unknown; link?: unknown; snippet?: unknown };
    if (typeof title !== 'string' || typeof link !== 'string') continue;
    out.push({ title, url: link, snippet: typeof snippet === 'string' ? snippet : '' });
  }
  return out;
};

export const createSerpApiProvider = (opts: SerpApiOptions): SearchProvider => {
  const fetchImpl: SearchFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const maxBytes = opts.maxBytes ?? SEARCH_MAX_BYTES;
  return {
    name: 'serpapi',
    async search(q, o) {
      const url = new URL(SERPAPI_ENDPOINT);
      url.searchParams.set('engine', 'google');
      url.searchParams.set('q', q);
      url.searchParams.set('gl', GL[o.country]);
      url.searchParams.set('hl', o.lang);
      url.searchParams.set('google_domain', GOOGLE_DOMAIN[o.country]);
      url.searchParams.set('api_key', opts.apiKey);
      let res: Response;
      try {
        res = await fetchImpl(url.toString(), { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: o.signal });
      } catch {
        // Dropped on purpose: a fetch error can carry the URL, and with it the key.
        throw new SearchError(o.signal.aborted ? 'timeout' : 'network');
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new SearchError(res.status);
      }
      let text: string;
      try {
        text = await readCapped(res, maxBytes);
      } catch (e) {
        if (e instanceof SearchError) throw e;
        throw new SearchError(o.signal.aborted ? 'timeout' : 'network');
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new SearchError('bad_json');
      }
      return parseSerpApi(data, o.num);
    },
  };
};
