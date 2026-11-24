// HAND-WRITTEN SerpApi fixtures, NOT recorded responses. No live search may be run from this
// project's tests, so these follow the documented shape (serpapi.com/search-api, checked
// 2026-11-20): `organic_results[]` with position, title, link, displayed_link, snippet; errors as
// {"error": "..."}; "no results" as HTTP 200 with a top-level `error` and no organic_results.
// Replace with a recorded response (key removed) once the owner's account exists.

export const SERPAPI_OK = {
  search_metadata: { id: '000000000000000000000000', status: 'Success' },
  search_parameters: { engine: 'google', q: 'how UK law firms use AI automation', google_domain: 'google.co.uk', gl: 'uk', hl: 'en' },
  organic_results: [
    {
      position: 1,
      title: 'How law firms are using AI for client intake',
      link: 'https://www.legal-news.example/ai-intake',
      displayed_link: 'https://www.legal-news.example › ai-intake',
      snippet: 'Firms describe using an assistant to sort <b>new enquiries</b> &amp; collect documents before a solicitor reviews them.',
    },
    {
      position: 2,
      title: 'Document review with AI: a practical guide',
      link: 'https://guides.example/document-review',
      displayed_link: 'guides.example › document-review',
      snippet: 'A guide to reading contracts automatically and flagging unusual clauses for a lawyer to check.',
    },
    {
      position: 3,
      title: 'Law firm AI video',
      link: 'https://www.youtube.com/watch?v=abc',
      displayed_link: 'youtube.com',
      snippet: 'Video.',
    },
    {
      position: 4,
      title: 'Second article on the same host',
      link: 'https://www.legal-news.example/another',
      displayed_link: 'legal-news.example',
      snippet: 'Same host as result 1.',
    },
    { position: 5, title: 'No link here' },
    {
      position: 6,
      title: 'Conveyancing automation',
      link: 'https://conveyancing.example/automation',
      displayed_link: 'conveyancing.example',
    },
    {
      position: 7,
      title: 'Seventh result',
      link: 'https://seventh.example/',
      snippet: 'Beyond num.',
    },
  ],
};

/** HTTP 200 "no results": a top-level error and no organic_results. */
export const SERPAPI_NO_RESULTS = {
  search_metadata: { id: '000000000000000000000001', status: 'Success' },
  error: "Google hasn't returned any results for this query.",
};

/** HTTP 401 body. */
export const SERPAPI_BAD_KEY = { error: 'Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key' };

/** HTTP 200 with an `error` that is not "no results" (hand-written; message carries a URL on purpose). */
export const SERPAPI_200_UNKNOWN_ERROR = {
  search_metadata: { id: '000000000000000000000002', status: 'Error' },
  error: 'Something went wrong, see https://serpapi.com/search?api_key=leak for details.',
};

/** HTTP 200 with organic_results and an `error` field: the results win, the error is ignored. */
export const SERPAPI_RESULTS_WITH_ERROR = {
  ...SERPAPI_OK,
  error: 'Some notice that must be ignored.',
};
