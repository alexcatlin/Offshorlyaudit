// Web-search seam (Amendment 5 Phase 5). Provider-neutral: only the adapter files
// (server/search/serpapi.ts, and the dev/test fixture) know an API shape. A Serper adapter can be
// added behind this interface once its API is verified from official docs.

export interface SearchHit {
  title: string;
  snippet: string;
  url: string;
}

export interface SearchOptions {
  /** Results wanted; adapters without a count parameter take the first `num` client-side. */
  num: number;
  country: 'gb';
  lang: 'en';
  signal: AbortSignal;
}

export type SearchProviderName = 'serpapi' | 'fixture';

export interface SearchProvider {
  readonly name: SearchProviderName;
  /** Throws SearchError on failure. A query with no results resolves with []. */
  search(q: string, o: SearchOptions): Promise<SearchHit[]>;
}

/**
 * A search failure. Carries a status or reason only: never the request URL (SerpApi's key travels
 * in its query string), never the provider's response body.
 */
export class SearchError extends Error {
  constructor(readonly reason: number | 'network' | 'timeout' | 'too_large' | 'bad_json' | 'provider_error') {
    super(`search failed: ${String(reason)}`);
    this.name = 'SearchError';
  }
}
