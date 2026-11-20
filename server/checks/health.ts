// Website health: SEO, AI readiness (GEO) and speed basics, BUILD_GUIDE §5.7 retained ids.
// PageSpeed checks come from pagespeed.ts and are appended by the caller when present.
import type { CheckResult } from '../../shared/types.js';
import { decodeEntities, findElements, findTags, headOf, metaContent, stripComments } from '../site/html.js';
import type { CheckFetches } from './extras.js';
import { robotsListsSitemap } from './extras.js';

export interface HealthInput {
  home: {
    html: string;
    headers: Record<string, string>;
    title: string;
    description: string;
    text: string;
    wordCount: number;
    ttfbMs: number;
    bytes: number;
    truncated?: boolean;
  };
  pages: { text: string }[];
  fetches: Pick<CheckFetches, 'robots' | 'sitemap'>;
}

const n = (x: number): string => x.toLocaleString('en-GB');

// ---------- SEO ----------

export const checkTitle = (title: string): CheckResult => {
  const len = title.trim().length;
  if (!len) return { id: 'seo-title', status: 'fail', detail: 'The homepage has no page title.' };
  if (len >= 25 && len <= 65) return { id: 'seo-title', status: 'pass', detail: `Page title is ${len} characters.` };
  return {
    id: 'seo-title',
    status: 'warn',
    detail: `Page title is ${len} characters (${len < 25 ? 'short' : 'long'}; 25 to 65 works best).`,
  };
};

export const checkDescription = (html: string): CheckResult => {
  const d = (metaContent(html, 'description') ?? '').trim();
  const len = d.length;
  if (!len) return { id: 'seo-description', status: 'fail', detail: 'No meta description on the homepage.' };
  if (len >= 70 && len <= 165) return { id: 'seo-description', status: 'pass', detail: `Meta description is ${len} characters.` };
  return {
    id: 'seo-description',
    status: 'warn',
    detail: `Meta description is ${len} characters (${len < 70 ? 'short' : 'long'}; 70 to 165 works best).`,
  };
};

export const checkH1 = (html: string): CheckResult => {
  const count = findTags(stripComments(html), 'h1').length;
  if (count === 1) return { id: 'seo-h1', status: 'pass', detail: 'The homepage has one main heading (h1).' };
  if (count === 0) return { id: 'seo-h1', status: 'fail', detail: 'The homepage has no main heading (h1).' };
  return { id: 'seo-h1', status: 'warn', detail: `The homepage has ${count} main headings (h1); one is clearer.` };
};

export const checkIndexable = (html: string, headers: Record<string, string>): CheckResult => {
  const metaNoindex = findTags(headOf(html), 'meta').some(
    (a) => /^(robots|googlebot)$/i.test(a.name ?? '') && /noindex|\bnone\b/i.test(a.content ?? ''),
  );
  const headerNoindex = /noindex|\bnone\b/i.test(headers['x-robots-tag'] ?? '');
  if (metaNoindex || headerNoindex) {
    return {
      id: 'seo-indexable',
      status: 'fail',
      detail: `The homepage asks search engines not to list it (${metaNoindex ? 'robots meta tag' : 'X-Robots-Tag header'}).`,
    };
  }
  return { id: 'seo-indexable', status: 'pass', detail: 'The homepage allows search engines to list it.' };
};

export const checkContent = (words: number): CheckResult => {
  if (words >= 300) return { id: 'seo-content', status: 'pass', detail: `About ${n(words)} words of text on the homepage.` };
  if (words >= 150) return { id: 'seo-content', status: 'warn', detail: `About ${n(words)} words of text on the homepage.` };
  return { id: 'seo-content', status: 'fail', detail: `Only about ${n(words)} words of text on the homepage.` };
};

export const checkSitemap = (fetches: Pick<CheckFetches, 'robots' | 'sitemap'>): CheckResult => {
  if (fetches.robots?.usable && robotsListsSitemap(fetches.robots.body)) {
    return { id: 'seo-sitemap', status: 'pass', detail: 'robots.txt lists a sitemap.' };
  }
  const s = fetches.sitemap;
  if (s?.usable && /<(urlset|sitemapindex)\b/i.test(s.body)) {
    return { id: 'seo-sitemap', status: 'pass', detail: 'A sitemap is published at /sitemap.xml.' };
  }
  return { id: 'seo-sitemap', status: 'fail', detail: 'No sitemap listed in robots.txt or found at /sitemap.xml.' };
};

export const checkCanonical = (html: string): CheckResult =>
  findTags(headOf(html), 'link').some((a) => /(^|\s)canonical(\s|$)/i.test(a.rel ?? '') && a.href)
    ? { id: 'seo-canonical', status: 'pass', detail: 'The homepage declares a canonical address.' }
    : { id: 'seo-canonical', status: 'warn', detail: 'No canonical tag on the homepage.' };

export const checkOg = (html: string): CheckResult => {
  const title = !!metaContent(html, 'og:title')?.trim();
  const image = !!metaContent(html, 'og:image')?.trim();
  if (title && image) return { id: 'seo-og', status: 'pass', detail: 'Link previews have a title and an image (og:title, og:image).' };
  if (title || image) {
    return { id: 'seo-og', status: 'warn', detail: `Link previews have ${title ? 'a title but no image' : 'an image but no title'}.` };
  }
  return { id: 'seo-og', status: 'fail', detail: 'No link preview tags (og:title, og:image).' };
};

export const checkAlt = (html: string): CheckResult => {
  const imgs = findTags(stripComments(html), 'img');
  if (!imgs.length) return { id: 'seo-alt', status: 'pass', detail: 'No images on the homepage.' };
  const withAlt = imgs.filter((a) => 'alt' in a).length;
  const share = withAlt / imgs.length;
  const detail = `${withAlt} of ${imgs.length} images on the homepage have a description (alt text).`;
  if (share >= 0.9) return { id: 'seo-alt', status: 'pass', detail };
  if (share >= 0.6) return { id: 'seo-alt', status: 'warn', detail };
  return { id: 'seo-alt', status: 'fail', detail };
};

// ---------- AI readiness ----------

export const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'] as const;

interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

export const parseRobots = (body: string): RobotsGroup[] => {
  const groups: RobotsGroup[] = [];
  let cur: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      if (cur) cur.rules.push({ allow: key === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
};

const closesWholeSite = (rules: RobotsGroup['rules']): boolean =>
  rules.some((r) => !r.allow && (r.path === '/' || r.path === '/*')) &&
  !rules.some((r) => r.allow && (r.path === '/' || r.path === '/*'));

/** Bots that robots.txt closes the whole site to (specific group, else `*`). */
export const blockedAiBots = (robotsBody: string): string[] => {
  const groups = parseRobots(robotsBody);
  return AI_BOTS.filter((bot) => {
    const specific = groups.filter((g) => g.agents.includes(bot.toLowerCase()));
    const use = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
    return closesWholeSite(use.flatMap((g) => g.rules));
  });
};

export const checkBots = (robots: CheckFetches['robots']): CheckResult => {
  if (!robots?.usable) return { id: 'geo-bots', status: 'pass', detail: 'No robots.txt rules block AI tools.' };
  const blocked = blockedAiBots(robots.body);
  if (!blocked.length) return { id: 'geo-bots', status: 'pass', detail: 'robots.txt does not block the main AI tools.' };
  if (blocked.length === AI_BOTS.length) {
    return { id: 'geo-bots', status: 'fail', detail: `robots.txt blocks all ${AI_BOTS.length} AI tools we check (${blocked.join(', ')}).` };
  }
  return { id: 'geo-bots', status: 'warn', detail: `robots.txt blocks ${blocked.join(', ')}.` };
};

export const checkNoJs = (words: number): CheckResult =>
  words >= 300
    ? { id: 'geo-nojs', status: 'pass', detail: `About ${n(words)} words are readable without running JavaScript.` }
    : { id: 'geo-nojs', status: 'warn', detail: `Only about ${n(words)} words are readable without running JavaScript.` };

/** All JSON-LD @type values, including inside @graph and nested objects. */
export const jsonLdTypes = (html: string): string[] => {
  const types: string[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((x) => visit(x, depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    const t = o['@type'];
    if (typeof t === 'string') types.push(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && types.push(x));
    for (const [k, val] of Object.entries(o)) if (k !== '@type' && typeof val === 'object') visit(val, depth + 1);
  };
  for (const { attrs, inner } of findElements(html, 'script')) {
    if (!/ld\+json/i.test(attrs.type ?? '')) continue;
    try {
      visit(JSON.parse(decodeEntities(inner.trim()).replace(/^<!\[CDATA\[|\]\]>$/g, '')), 0);
    } catch {
      try {
        visit(JSON.parse(inner.trim()), 0);
      } catch {
        /* ignore invalid JSON-LD */
      }
    }
  }
  return types;
};

/** Only echo schema-like type names (site-controlled text). */
const safeTypes = (types: string[]): string[] =>
  [...new Set(types.filter((t) => /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(t)))].slice(0, 3);

const BUSINESS_TYPE =
  /Organization|Corporation|LocalBusiness|ProfessionalService|LegalService|AccountingService|Attorney|Consult|Agency|FinancialService|Store|Service$/i;

export const checkStructured = (types: string[]): CheckResult => {
  if (!types.length) return { id: 'geo-structured', status: 'fail', detail: 'No structured data (JSON-LD) on the homepage.' };
  const biz = types.filter((t) => BUSINESS_TYPE.test(t));
  if (biz.length) {
    return { id: 'geo-structured', status: 'pass', detail: `Structured data describes the business${safeTypes(biz).length ? ` (${safeTypes(biz).join(', ')})` : ''}.` };
  }
  return {
    id: 'geo-structured',
    status: 'warn',
    detail: `Structured data is present${safeTypes(types).length ? ` (${safeTypes(types).join(', ')})` : ''} but does not describe the business.`,
  };
};

export const checkQuestions = (types: string[], texts: string[]): CheckResult => {
  if (types.some((t) => /^(FAQPage|QAPage)$/i.test(t))) {
    return { id: 'geo-questions', status: 'pass', detail: 'The homepage has FAQ structured data.' };
  }
  const qs = new Set<string>();
  for (const t of texts) {
    for (const line of t.split('\n')) {
      const l = line.trim();
      if (l.length > 0 && l.length <= 120 && l.endsWith('?')) qs.add(l.toLowerCase());
    }
  }
  const count = qs.size;
  if (count >= 3) return { id: 'geo-questions', status: 'pass', detail: `${count} question-style headings or lines across the pages read.` };
  if (count >= 1) return { id: 'geo-questions', status: 'warn', detail: `${count} question-style line(s) across the pages read.` };
  return { id: 'geo-questions', status: 'fail', detail: 'No question-and-answer content found on the pages read.' };
};

// ---------- Speed basics ----------

export const checkTtfb = (ms: number): CheckResult => {
  const detail = `The server took ${n(ms)} ms to start sending the homepage.`;
  if (ms <= 800) return { id: 'spd-ttfb', status: 'pass', detail };
  if (ms <= 1800) return { id: 'spd-ttfb', status: 'warn', detail };
  return { id: 'spd-ttfb', status: 'fail', detail };
};

export const checkViewport = (html: string): CheckResult => {
  const vp = findTags(headOf(html), 'meta').find((a) => (a.name ?? '').toLowerCase() === 'viewport');
  return vp && /width\s*=\s*device-width/i.test(vp.content ?? '')
    ? { id: 'spd-viewport', status: 'pass', detail: 'The page sets a mobile viewport (width=device-width).' }
    : { id: 'spd-viewport', status: 'fail', detail: 'No mobile viewport setting (width=device-width).' };
};

export const checkCompression = (headers: Record<string, string>): CheckResult => {
  const enc = (headers['content-encoding'] ?? '').toLowerCase();
  const m = enc.match(/\b(br|gzip|zstd|deflate)\b/);
  return m
    ? { id: 'spd-compression', status: 'pass', detail: `The homepage is sent compressed (${m[1]}).` }
    : { id: 'spd-compression', status: 'warn', detail: 'The homepage is sent uncompressed.' };
};

export const checkHtmlSize = (bytes: number, truncated = false): CheckResult => {
  const kb = Math.round(bytes / 1024);
  const detail = truncated ? `The homepage HTML is over ${n(kb)} KB.` : `The homepage HTML is ${n(kb)} KB.`;
  if (!truncated && bytes <= 200 * 1024) return { id: 'spd-html-size', status: 'pass', detail };
  if (!truncated && bytes <= 500 * 1024) return { id: 'spd-html-size', status: 'warn', detail };
  return { id: 'spd-html-size', status: 'fail', detail };
};

export const countBlockingScripts = (html: string): number =>
  findTags(stripComments(headOf(html)), 'script').filter(
    (a) => a.src && !('async' in a) && !('defer' in a) && (a.type ?? '').toLowerCase() !== 'module' &&
      !/^(text\/template|application\/json|application\/ld\+json|text\/x-template|text\/plain|text\/rocketlazyloadscript)$/i.test(a.type ?? ''),
  ).length;

export const checkBlockingScripts = (html: string): CheckResult => {
  const count = countBlockingScripts(html);
  const detail = `${count} script file(s) in the page head block rendering (no async or defer).`;
  if (count <= 2) return { id: 'spd-blocking-scripts', status: 'pass', detail };
  if (count <= 5) return { id: 'spd-blocking-scripts', status: 'warn', detail };
  return { id: 'spd-blocking-scripts', status: 'fail', detail };
};

// ---------- All ----------

export const healthChecks = (input: HealthInput): CheckResult[] => {
  const { home, pages, fetches } = input;
  const types = jsonLdTypes(home.html);
  return [
    checkTitle(home.title),
    checkDescription(home.html),
    checkH1(home.html),
    checkIndexable(home.html, home.headers),
    checkContent(home.wordCount),
    checkSitemap(fetches),
    checkCanonical(home.html),
    checkOg(home.html),
    checkAlt(home.html),
    checkBots(fetches.robots),
    checkNoJs(home.wordCount),
    checkStructured(types),
    checkQuestions(types, [home.text, ...pages.map((p) => p.text)]),
    checkTtfb(home.ttfbMs),
    checkViewport(home.html),
    checkCompression(home.headers),
    checkHtmlSize(home.bytes, home.truncated),
    checkBlockingScripts(home.html),
  ];
};
