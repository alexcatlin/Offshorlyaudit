// Dev/test search provider (Amendment 5 Phase 5): three "[Sample]" hits on reserved example
// domains (one host each, so per-host de-duplication keeps all three). Config refuses it in
// production. Makes no network calls.
import type { SearchHit, SearchProvider } from './types.js';

export const FIXTURE_HITS: readonly SearchHit[] = [
  {
    title: '[Sample] How one firm sorts incoming requests with an assistant',
    snippet: '[Sample] a short write-up of a business that uses an assistant to sort and route incoming requests before a person replies.',
    url: 'https://example.com/sample-article',
  },
  {
    title: '[Sample] Automating document intake',
    snippet: '[Sample] notes on reading forms and documents automatically and passing anything unclear to a person.',
    url: 'https://www.example.org/sample-notes',
  },
  {
    title: '[Sample] A guide to weekly reporting',
    snippet: '[Sample] pulling data from several tools into a draft weekly summary for review.',
    url: 'https://example.net/sample-guide',
  },
];

export const createFixtureSearchProvider = (): SearchProvider => ({
  name: 'fixture',
  search: async (_q, o) => FIXTURE_HITS.slice(0, o.num).map((h) => ({ ...h })),
});
