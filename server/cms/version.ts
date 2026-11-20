// WordPress version extraction from what the page serves: generator meta, linked feed
// <generator>, ?ver= on wp-includes assets, plugin/theme asset paths (Bedrock /app/ aware),
// and the active theme's style.css header.
import { decodeEntities, findElements, findTags, headOf, metaContents, resolveUrl, sameHost } from '../site/html.js';
import { isWordPressGenerator } from './detect.js';

// ---------- Version maths ----------

/** "6.4" → [6,4,0]; "1.2.3-beta" → [1,2,3]; garbage → null. */
export const parseVersion = (v: string | null | undefined): number[] | null => {
  if (!v) return null;
  const m = v.trim().match(/^v?(\d+(?:\.\d+){0,3})(?:[-+_ ]?[0-9a-z.]*)?$/i);
  if (!m) return null;
  const parts = m[1]!.split('.').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  while (parts.length < 3) parts.push(0);
  return parts;
};

/** -1 / 0 / 1, or null if either side doesn't parse. */
export const compareVersions = (a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 | null => {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

/** Strict component version: 2–4 numeric parts. */
export const STRICT_VERSION = /^\d+(\.\d+){1,3}$/;

const mostCommon = (values: string[]): string | null => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [v, c] of counts) {
    if (c > bestN || (c === bestN && best !== null && (compareVersions(v, best) ?? 0) > 0)) {
      best = v;
      bestN = c;
    }
  }
  return best;
};

// ---------- URL harvesting ----------

/** Normalise escaped slashes and HTML-encoded ampersands so URLs in JSON/attributes match. */
const normaliseHtml = (html: string): string =>
  html.replace(/\\\//g, '/').replace(/&#0?38;|&amp;/gi, '&');

const URLISH = /(?:https?:)?\/\/[^\s"'<>()]+|\/[^\s"'<>()]+/g;

export const assetUrls = (html: string): string[] => normaliseHtml(html).match(URLISH) ?? [];

const verParam = (url: string): string | null => {
  const m = url.match(/[?&]ver=([^&#"'\s]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
};

// ---------- Core ----------

export const generatorVersion = (html: string): string | null => {
  for (const g of metaContents(headOf(html), 'generator')) {
    if (!isWordPressGenerator(g)) continue;
    const v = g.match(/WordPress\s+(\d+(?:\.\d+){0,3})/i)?.[1];
    if (v) return v;
  }
  return null;
};

/** `<generator>https://wordpress.org/?v=6.4.2</generator>` from an RSS/Atom feed. */
export const feedGeneratorVersion = (xml: string): string | null => {
  const el = findElements(xml, 'generator', 1)[0];
  if (!el) return null;
  const text = decodeEntities(el.inner.trim());
  const atomVersion = /wordpress/i.test(text) ? el.attrs.version ?? null : null;
  const v = text.match(/wordpress\.org\/\?v=(\d+(?:\.\d+){0,3})/i)?.[1] ?? atomVersion;
  return v && parseVersion(v) ? v : null;
};

/** Bundled third-party libraries in wp-includes carry their own version in ?ver=, not core's. */
const BUNDLED_LIB =
  /\/wp-includes\/js\/(jquery|dist\/vendor|underscore|backbone|imagesloaded|masonry|hoverintent|mediaelement|thickbox|tinymce|swfobject|clipboard|zxcvbn|plupload|jcrop|codemirror|colorpicker|json2|twemoji|wp-polyfill|dist\/development)/i;

/** Most common ?ver= on wp-includes assets (incl. Bedrock /wp/wp-includes/), bundled libraries excluded. */
export const assetCoreVersion = (html: string): string | null => {
  const vers = assetUrls(html)
    .filter((u) => /\/wp-includes\//i.test(u) && !BUNDLED_LIB.test(u))
    .map(verParam)
    .filter((v): v is string => !!v && STRICT_VERSION.test(v) && v.split('.')[0]!.length <= 2);
  return mostCommon(vers);
};

export type CoreSource = 'generator' | 'feed' | 'asset';

export const extractCoreVersion = (
  html: string,
  feedXml: string | null,
): { version: string | null; source: CoreSource | null; versionExposed: boolean } => {
  const gen = generatorVersion(html);
  const feed = feedXml ? feedGeneratorVersion(feedXml) : null;
  const versionExposed = !!(gen || feed);
  if (gen) return { version: gen, source: 'generator', versionExposed };
  if (feed) return { version: feed, source: 'feed', versionExposed };
  const asset = assetCoreVersion(html);
  if (asset) return { version: asset, source: 'asset', versionExposed };
  return { version: null, source: null, versionExposed };
};

// ---------- Components ----------

export const COMPONENT_RE = /\/(?:wp-content|app)\/(plugins|themes)\/([a-z0-9_-]+)\//gi;
export const MAX_COMPONENTS = 15;

export interface FoundComponent {
  type: 'plugin' | 'theme';
  slug: string;
  version: string | null;
  versionSource: 'asset' | 'stylesheet' | null;
}

/**
 * Plugins and themes referenced by asset paths. A plugin version is accepted only if it is
 * 2–4 numeric parts, not equal to the core version (WP defaults ver to core), and the most
 * common value for that slug. Theme versions come from style.css only (see parseStyleCss).
 */
export const extractComponents = (html: string, coreVersion: string | null): FoundComponent[] => {
  const order: string[] = [];
  const vers = new Map<string, string[]>();
  for (const url of assetUrls(html)) {
    for (const m of url.matchAll(COMPONENT_RE)) {
      const type = m[1]!.toLowerCase() === 'plugins' ? 'plugin' : 'theme';
      const slug = m[2]!.toLowerCase();
      const key = `${type}:${slug}`;
      if (!vers.has(key)) {
        vers.set(key, []);
        order.push(key);
      }
      if (type === 'plugin') {
        const v = verParam(url);
        if (v && STRICT_VERSION.test(v) && v !== coreVersion) vers.get(key)!.push(v);
      }
    }
  }
  // Themes first (there are few), then plugins, capped.
  const keys = [...order.filter((k) => k.startsWith('theme:')), ...order.filter((k) => k.startsWith('plugin:'))].slice(
    0,
    MAX_COMPONENTS,
  );
  return keys.map((key) => {
    const [type, slug] = key.split(':') as ['plugin' | 'theme', string];
    const version = type === 'plugin' ? mostCommon(vers.get(key) ?? []) : null;
    return { type, slug, version, versionSource: version ? 'asset' : null };
  });
};

// ---------- Linked files (fetched only if linked and same host) ----------

/** The main RSS/Atom feed linked from <head>, if on the same host (ignoring www). */
export const findFeedUrl = (html: string, pageUrl: string): string | null => {
  const links = findTags(headOf(html), 'link').filter(
    (a) => /(^|\s)alternate(\s|$)/i.test(a.rel ?? '') && /application\/(rss|atom)\+xml/i.test(a.type ?? '') && a.href,
  );
  const preferred = links.find((a) => !/comments/i.test(a.href! + (a.title ?? ''))) ?? links[0];
  if (!preferred) return null;
  const u = resolveUrl(preferred.href!, pageUrl);
  return u && /^https?:$/.test(u.protocol) && sameHost(u, pageUrl) ? u.href : null;
};

/** The active theme's style.css if linked (last theme stylesheet = child theme) and same host. */
export const findThemeStylesheet = (html: string, pageUrl: string): { url: string; slug: string } | null => {
  let found: { url: string; slug: string } | null = null;
  for (const a of findTags(html, 'link')) {
    if (!/stylesheet/i.test(a.rel ?? '') || !a.href) continue;
    const u = resolveUrl(a.href, pageUrl);
    if (!u || !/^https?:$/.test(u.protocol) || !sameHost(u, pageUrl)) continue;
    const m = u.pathname.match(/\/(?:wp-content|app)\/themes\/([a-z0-9_-]+)\/style\.css$/i);
    if (m) found = { url: u.href, slug: m[1]!.toLowerCase() };
  }
  return found;
};

/** `Theme Name:` and `Version:` from a theme style.css header comment. */
export const parseStyleCss = (css: string): { name: string | null; version: string | null } => {
  const open = css.indexOf('/*');
  const close = open >= 0 ? css.indexOf('*/', open + 2) : -1;
  const header = open >= 0 && close > open ? css.slice(open + 2, close) : '';
  const field = (k: string): string | null =>
    header.match(new RegExp(`^[ \\t*]*${k}[ \\t]*:([^\\n]*)`, 'im'))?.[1]?.trim() || null;
  // Keep only the numeric part: the header is site-controlled text and ends up in check details.
  const version = field('Version')?.match(/^v?(\d+(?:\.\d+){0,3})\b/i)?.[1] ?? null;
  return { name: field('Theme Name'), version };
};

/** XML-RPC advertised via <link rel="pingback"> or X-Pingback header. */
export const xmlrpcAdvertised = (html: string, headers: Record<string, string>): boolean =>
  !!headers['x-pingback'] || findTags(headOf(html), 'link').some((a) => /(^|\s)pingback(\s|$)/i.test(a.rel ?? ''));
