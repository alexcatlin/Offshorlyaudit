// Platform detection from generator meta, headers and asset paths/hosts. Only WordPress gets
// version and security lookups; for others we report the platform (and generator version as fact).
import type { Platform } from '../../shared/types.js';
import { findTags, headOf, metaContents } from '../site/html.js';

export interface DetectInput {
  html: string;
  headers: Record<string, string>;
}

export interface PlatformResult {
  platform: Platform;
  /** Non-WordPress generator version, if the generator meta states one. */
  version: string | null;
  /** Evidence labels, for logs/tests. */
  signals: string[];
}

/** WordPress asset paths, Bedrock-aware (/app/plugins|themes, /wp/wp-includes). */
export const WP_PATH_RE = /\/(?:wp-content|wp-includes|wp\/wp-includes)\/|\/app\/(?:plugins|themes)\//i;

interface PlatformRule {
  platform: Exclude<Platform, 'unknown'>;
  generator: RegExp;
  html: RegExp[];
  headers: [string, RegExp][];
}

const RULES: PlatformRule[] = [
  {
    platform: 'shopify',
    generator: /shopify/i,
    html: [/cdn\.shopify\.com/i, /\bShopify\.theme\b/, /\.myshopify\.com/i],
    headers: [
      ['x-shopid', /./],
      ['x-shopify-stage', /./],
      ['powered-by', /shopify/i],
    ],
  },
  {
    platform: 'wix',
    generator: /wix\.com/i,
    html: [/static\.wixstatic\.com/i, /static\.parastorage\.com/i],
    headers: [
      ['x-wix-request-id', /./],
      ['server', /pepyaka/i],
    ],
  },
  {
    platform: 'squarespace',
    generator: /squarespace/i,
    html: [/static1\.squarespace\.com/i, /assets\.squarespace\.com/i, /<!--\s*This is Squarespace\.\s*-->/i],
    headers: [['server', /squarespace/i]],
  },
  {
    platform: 'webflow',
    generator: /webflow/i,
    html: [/\bdata-wf-(page|site)=/i, /(assets|uploads-ssl)\.website-files\.com/i, /cdn\.prod\.website-files\.com/i],
    headers: [],
  },
  {
    platform: 'drupal',
    generator: /drupal/i,
    html: [/\/sites\/(default|all)\/(files|themes|modules)\//i, /drupal-settings-json/i, /\bDrupal\.settings\b/],
    headers: [
      ['x-generator', /drupal/i],
      ['x-drupal-cache', /./],
      ['x-drupal-dynamic-cache', /./],
    ],
  },
  {
    platform: 'joomla',
    generator: /joomla/i,
    html: [/\/media\/jui\//i, /\/components\/com_[a-z]+\//i, /\/media\/system\/js\/core\.js/i],
    headers: [],
  },
];

const versionFrom = (generator: string): string | null => generator.match(/\b(\d+(?:\.\d+){0,3})\b/)?.[1] ?? null;

export const isWordPressGenerator = (g: string): boolean => /^\s*WordPress\b/i.test(g);

export const detectPlatform = (input: DetectInput): PlatformResult => {
  const { html, headers } = input;
  const head = headOf(html);
  const generators = metaContents(head, 'generator');
  const signals: string[] = [];

  // 1. Generator meta naming a platform wins.
  for (const g of generators) {
    if (isWordPressGenerator(g)) return { platform: 'wordpress', version: null, signals: ['generator'] };
    for (const r of RULES) {
      if (r.generator.test(g)) return { platform: r.platform, version: versionFrom(g), signals: ['generator'] };
    }
  }
  const xGen = headers['x-generator'] ?? '';
  for (const r of RULES) if (r.generator.test(xGen)) return { platform: r.platform, version: versionFrom(xGen), signals: ['x-generator'] };

  // 2. WordPress-specific markers.
  const linkHeader = headers.link ?? '';
  const wp: string[] = [];
  if (/api\.w\.org/i.test(linkHeader) || findTags(head, 'link').some((a) => /api\.w\.org/i.test(a.rel ?? ''))) wp.push('api.w.org');
  if (WP_PATH_RE.test(html)) wp.push('asset-paths');
  if (headers['x-pingback'] || /\/xmlrpc\.php/i.test(head)) wp.push('pingback');

  // 3. Score other platforms by asset hosts and headers.
  let best: { platform: Exclude<Platform, 'unknown'>; hits: number } | null = null;
  for (const r of RULES) {
    let hits = 0;
    for (const re of r.html) if (re.test(html)) hits++;
    for (const [h, re] of r.headers) if (headers[h] && re.test(headers[h]!)) hits += 2;
    if (hits && (!best || hits > best.hits)) best = { platform: r.platform, hits };
  }

  if (wp.length && (!best || wp.length >= best.hits)) return { platform: 'wordpress', version: null, signals: wp };
  if (best) {
    signals.push(`${best.platform}:${best.hits}`);
    return { platform: best.platform, version: null, signals };
  }
  return { platform: 'unknown', version: null, signals };
};
