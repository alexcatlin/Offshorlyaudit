// Choose up to 4 inner pages from homepage links. Scoring per BUILD_GUIDE §5.2, plus a Careers
// type and the PLAN priority order: Services > About > Careers > Case studies > Pricing > Contact.
import { sameHost } from './html.js';
import type { PageLink } from './extract.js';

export interface PageType {
  label: string;
  pattern: RegExp;
}

/** In priority order. */
export const PAGE_TYPES: readonly PageType[] = [
  { label: 'Services', pattern: /service|what-we-do|capabilit|solution|expertise|offering|how-we-(work|help)/ },
  { label: 'About', pattern: /about|team|who-we-are|our-story|people/ },
  { label: 'Careers', pattern: /career|jobs?\b|vacanc|join-us|work-with-us|hiring/ },
  { label: 'Case studies', pattern: /case-stud|our-work|\bwork\b|portfolio|project|client|result|success|testimonial/ },
  { label: 'Pricing', pattern: /pricing|prices|packages|\bfees\b|\bplans\b/ },
  { label: 'Contact', pattern: /contact|get-in-touch|book|enquir|inquir/ },
];

export const SKIPPED_PATHS = /^\/(blog|news|insights|articles|resources|category|tag|author|wp-|app(\/|$))/;
export const SKIPPED_FILES = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mp3|ics|xml|json|css|js|txt)$/;
export const MAX_PAGES = 4;
const MIN_SCORE = 0.8;
/** Tie-break: the conventional page name beats a longer match (/about over /teams, /services over /ai-services). */
const CANONICAL_SEGMENT = /^(our-)?(services|about(-us)?|careers|jobs|case-studies|work|pricing|prices|contact(-us)?)$/;
const CANONICAL_BONUS = 1.5;

export interface PickedPage {
  url: string;
  label: string;
  score: number;
}

const segmentsOf = (pathname: string): string[] => {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* keep raw */
  }
  return decoded.toLowerCase().split('/').filter(Boolean);
};

export const scoreLink = (link: { url: URL; text: string | string[] }, type: PageType): number => {
  const segs = segmentsOf(link.url.pathname);
  if (!segs.length) return 0;
  let pathScore = 0;
  if (type.pattern.test(segs[0]!)) {
    pathScore = segs.length === 1 ? 2 : 1.2;
    if (segs.length === 1 && CANONICAL_SEGMENT.test(segs[0]!)) pathScore += CANONICAL_BONUS;
  }
  const texts = (Array.isArray(link.text) ? link.text : [link.text]).map((t) => t.trim().toLowerCase());
  const textScore = texts.some((t) => t && t.length <= 25 && type.pattern.test(t)) ? 1 : 0;
  return pathScore + textScore - 0.1 * segs.length;
};

const canonicalKey = (u: URL): string => {
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path.toLowerCase()}${u.search}`;
};

/** Pick at most 4 distinct same-site pages, in priority order. */
export const pickPages = (links: PageLink[], homeUrl: string, max = MAX_PAGES): PickedPage[] => {
  const home = new URL(homeUrl);
  const homeKey = canonicalKey(home);
  const candidates: { url: URL; text: string[] }[] = [];
  const seen = new Map<string, number>();
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l.url);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (!sameHost(u, home)) continue;
    const path = u.pathname.toLowerCase();
    if (SKIPPED_PATHS.test(path) || SKIPPED_FILES.test(path)) continue;
    u.hash = '';
    const key = canonicalKey(u);
    if (key === homeKey) continue;
    // Keep each URL once, with every link text seen for it.
    const idx = seen.get(key);
    if (idx !== undefined) {
      if (l.text) candidates[idx]!.text.push(l.text);
      continue;
    }
    seen.set(key, candidates.length);
    candidates.push({ url: u, text: l.text ? [l.text] : [] });
  }

  const picked: PickedPage[] = [];
  const taken = new Set<string>();
  for (const type of PAGE_TYPES) {
    if (picked.length >= max) break;
    let best: { url: URL; score: number } | null = null;
    for (const c of candidates) {
      const key = canonicalKey(c.url);
      if (taken.has(key)) continue;
      const score = scoreLink(c, type);
      if (score >= MIN_SCORE && (!best || score > best.score)) best = { url: c.url, score };
    }
    if (best) {
      taken.add(canonicalKey(best.url));
      picked.push({ url: best.url.href, label: type.label, score: Math.round(best.score * 100) / 100 });
    }
  }
  return picked;
};
