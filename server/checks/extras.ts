// The extra target fetches the measured checks need (PLAN Phase 3):
// /robots.txt; /sitemap.xml only if robots.txt has no Sitemap: line; http://host/ for the redirect check.
import type { FetchSafe } from '../site/fetchSafe.js';

export interface TextFile {
  status: number;
  body: string;
  /** False when the server answered with an HTML page (soft 404) or a non-2xx status. */
  usable: boolean;
}

export interface CheckFetches {
  /** null when the fetch failed outright. */
  robots: TextFile | null;
  /** null when not fetched (robots lists a sitemap) or the fetch failed. */
  sitemap: TextFile | null;
  sitemapFetched: boolean;
  /** Final URL after following http://host/; null when it couldn't be fetched. */
  httpProbe: { finalUrl: string; status: number } | null;
}

export const ROBOTS_MAX_BYTES = 512_000;
export const SITEMAP_MAX_BYTES = 256_000;
export const PROBE_MAX_BYTES = 16_000;

export const robotsListsSitemap = (robots: string): boolean => /^\s*sitemap\s*:\s*\S+/im.test(robots);

const looksHtml = (body: string, contentType: string | undefined): boolean =>
  /html/i.test(contentType ?? '') || /^\s*(<!doctype html|<html)/i.test(body);

export const fetchCheckInputs = async (homeFinalUrl: string, deps: { fetchSafe: FetchSafe }): Promise<CheckFetches> => {
  const { fetchSafe } = deps;
  const home = new URL(homeFinalUrl);
  const origin = home.origin;

  const [robotsRes, probeRes] = await Promise.allSettled([
    fetchSafe(`${origin}/robots.txt`, { maxBytes: ROBOTS_MAX_BYTES, accept: 'text/plain,*/*;q=0.5' }),
    fetchSafe(`http://${home.host.replace(/:\d+$/, '')}/`, { maxBytes: PROBE_MAX_BYTES }),
  ]);

  const robots: TextFile | null =
    robotsRes.status === 'fulfilled'
      ? {
          status: robotsRes.value.status,
          body: robotsRes.value.body,
          usable:
            robotsRes.value.status >= 200 &&
            robotsRes.value.status < 300 &&
            !looksHtml(robotsRes.value.body, robotsRes.value.headers['content-type']),
        }
      : null;

  const httpProbe =
    probeRes.status === 'fulfilled' ? { finalUrl: probeRes.value.finalUrl, status: probeRes.value.status } : null;

  let sitemap: TextFile | null = null;
  let sitemapFetched = false;
  if (!(robots?.usable && robotsListsSitemap(robots.body))) {
    sitemapFetched = true;
    try {
      const r = await fetchSafe(`${origin}/sitemap.xml`, {
        maxBytes: SITEMAP_MAX_BYTES,
        accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5',
      });
      sitemap = { status: r.status, body: r.body, usable: r.status >= 200 && r.status < 300 };
    } catch {
      sitemap = null;
    }
  }

  return { robots, sitemap, sitemapFetched, httpProbe };
};
