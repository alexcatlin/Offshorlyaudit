// Read the homepage and up to 4 key inner pages. PLAN Phase 2.
// Thin homepage text (< 400 chars) is not an error here: the measured checks still run.
import { SiteReadError } from './errors.js';
import { extractLinks, extractPage, HOME_TEXT_CAP, INNER_TEXT_CAP } from './extract.js';
import type { PageLink } from './extract.js';
import type { FetchLogEntry, FetchSafe } from './fetchSafe.js';
import { sameHost } from './html.js';
import { pickPages } from './pickPages.js';
import type { FetchedPage } from './types.js';

export const THIN_TEXT_CHARS = 400;
export const MIN_INNER_TEXT_CHARS = 100;

export interface HomePage extends FetchedPage {
  html: string;
  headers: Record<string, string>;
  setCookies: string[];
  status: number;
  ttfbMs: number;
  bytes: number;
  truncated: boolean;
  finalUrl: string;
  /** Words in the full visible text (before the cap). */
  wordCount: number;
  links: PageLink[];
}

export interface InnerPage extends FetchedPage {
  /** Raw HTML, kept for stack detection. */
  html: string;
}

export interface SiteRead {
  /** Normalised URL that was requested. */
  requestedUrl: string;
  home: HomePage;
  pages: InnerPage[];
  thin: boolean;
  /** Live reference to the fetcher's log: later check/CMS fetches through the same fetcher appear here too. */
  fetchLog: FetchLogEntry[];
}

export interface ReadSiteDeps {
  fetchSafe: FetchSafe;
}

/** Add https:// when no scheme is given; throws SiteReadError('not_found') if unparseable. */
export const normaliseInputUrl = (input: string): URL => {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[^:/]+:\d+(\/|$)/.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    throw new SiteReadError('not_found', "That doesn't look like a website address.");
  }
};

export const readSite = async (input: string, deps: ReadSiteDeps): Promise<SiteRead> => {
  const { fetchSafe } = deps;
  const url = normaliseInputUrl(input);
  const res = await fetchSafe(url, { requireHtml: true, requireOk: true });
  const page = extractPage(res.body, HOME_TEXT_CAP);
  const links = extractLinks(res.body, res.finalUrl);
  const home: HomePage = {
    url: res.finalUrl,
    label: 'Home',
    title: page.title,
    description: page.description,
    text: page.text,
    html: res.body,
    headers: res.headers,
    setCookies: res.setCookies,
    status: res.status,
    ttfbMs: res.ttfbMs,
    bytes: res.bytes,
    truncated: res.truncated,
    finalUrl: res.finalUrl,
    wordCount: page.wordCount,
    links,
  };
  const thin = page.fullLength < THIN_TEXT_CHARS;

  let pages: InnerPage[] = [];
  if (!thin) {
    const picked = pickPages(links, res.finalUrl);
    const settled = await Promise.allSettled(
      picked.map(async (p): Promise<InnerPage | null> => {
        const r = await fetchSafe(p.url, { requireHtml: true, requireOk: true });
        if (!sameHost(r.finalUrl, res.finalUrl)) return null;
        const ex = extractPage(r.body, INNER_TEXT_CAP);
        if (ex.text.length < MIN_INNER_TEXT_CHARS) return null;
        return { url: r.finalUrl, label: p.label, title: ex.title, description: ex.description, text: ex.text, html: r.body };
      }),
    );
    const seen = new Set<string>([res.finalUrl]);
    pages = settled
      .map((s) => (s.status === 'fulfilled' ? s.value : null))
      .filter((p): p is InnerPage => {
        if (!p || seen.has(p.url)) return false;
        seen.add(p.url);
        return true;
      });
  }

  return { requestedUrl: url.href, home, pages, thin, fetchLog: fetchSafe.log };
};
