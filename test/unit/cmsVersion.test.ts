import { describe, expect, it } from 'vitest';
import { detectPlatform } from '../../server/cms/detect.js';
import {
  assetCoreVersion,
  compareVersions,
  extractComponents,
  extractCoreVersion,
  feedGeneratorVersion,
  findFeedUrl,
  findThemeStylesheet,
  parseStyleCss,
  parseVersion,
  xmlrpcAdvertised,
} from '../../server/cms/version.js';
import { fixture } from './_siteMock.js';

describe('version maths', () => {
  it('6.4 = 6.4.0', () => expect(compareVersions('6.4', '6.4.0')).toBe(0));
  it('6.10 > 6.9', () => expect(compareVersions('6.10', '6.9')).toBe(1));
  it('1.2.3-beta treated as 1.2.3', () => {
    expect(parseVersion('1.2.3-beta')).toEqual([1, 2, 3]);
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBe(0);
  });
  it('garbage → null', () => {
    expect(parseVersion('abc')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(compareVersions('x', '1.0')).toBeNull();
  });
  it('4-part versions', () => expect(compareVersions('1.5.1.3', '1.5.1.2')).toBe(1));
});

describe('core version', () => {
  const wp = fixture('html/wp-classic.html');
  it('generator first', () => {
    expect(extractCoreVersion(wp, null)).toEqual({ version: '6.4.2', source: 'generator', versionExposed: true });
  });
  it('feed generator next', () => {
    expect(feedGeneratorVersion(fixture('html/feed.xml'))).toBe('6.4.2');
    const noGen = wp.replace(/<meta name="generator"[^>]*>/, '');
    expect(extractCoreVersion(noGen, fixture('html/feed.xml'))).toEqual({ version: '6.4.2', source: 'feed', versionExposed: true });
  });
  it('then most common ?ver= on wp-includes, ignoring bundled jQuery', () => {
    const noGen = wp.replace(/<meta name="generator"[^>]*>/, '');
    expect(assetCoreVersion(noGen)).toBe('6.4.2');
    expect(extractCoreVersion(noGen, null)).toEqual({ version: '6.4.2', source: 'asset', versionExposed: false });
    expect(assetCoreVersion('<script src="/wp/wp-includes/js/jquery/jquery.min.js?ver=3.7.1"></script>')).toBeNull();
  });
  it('none → null', () => {
    expect(extractCoreVersion('<html></html>', null)).toEqual({ version: null, source: null, versionExposed: false });
  });
});

describe('components', () => {
  it('plugin ver equal to core → null; hash ver ignored; most common value wins', () => {
    const comps = extractComponents(fixture('html/wp-classic.html'), '6.4.2');
    const get = (slug: string) => comps.find((c) => c.slug === slug);
    expect(get('contact-form-7')).toEqual({ type: 'plugin', slug: 'contact-form-7', version: '5.8.4', versionSource: 'asset' });
    expect(get('elementor')?.version).toBe('3.18.0'); // 2× 3.18.0 vs 1× 3.17.9
    expect(get('display-widgets')?.version).toBeNull(); // ver = core
    expect(get('premium-addon')?.version).toBeNull(); // hash
    expect(get('astra')).toEqual({ type: 'theme', slug: 'astra', version: null, versionSource: null }); // themes: style.css only
  });

  it('Bedrock /app/ paths (offshorly.com snapshot)', () => {
    const html = fixture('html/offshorly-home.html');
    const comps = extractComponents(html, null);
    const slugs = comps.map((c) => `${c.type}:${c.slug}`);
    expect(slugs).toContain('theme:offshorly-v2');
    expect(slugs).toContain('plugin:contact-form-7');
    expect(comps.find((c) => c.slug === 'contact-form-7')?.version).toBe('6.2.5');
    expect(comps.length).toBeLessThanOrEqual(15);
  });

  it('caps at 15 components', () => {
    const html = Array.from({ length: 30 }, (_, i) => `<script src="/wp-content/plugins/p${i}/a.js?ver=1.0.${i}"></script>`).join('');
    expect(extractComponents(html, null)).toHaveLength(15);
  });

  it('JSON-escaped and &#038; encoded URLs are understood', () => {
    const html = '<script>var x={"u":"https:\\/\\/s.test\\/wp-content\\/plugins\\/foo\\/a.js?a=1&#038;ver=2.1"}</script>';
    expect(extractComponents(html, null)).toEqual([{ type: 'plugin', slug: 'foo', version: '2.1', versionSource: 'asset' }]);
  });
});

describe('linked files', () => {
  const wp = fixture('html/wp-classic.html');
  it('feed: main feed from <head>, same host only', () => {
    expect(findFeedUrl(wp, 'https://harbour.example/')).toBe('https://harbour.example/feed/');
    expect(findFeedUrl(wp, 'https://www.harbour.example/')).toBe('https://harbour.example/feed/');
    expect(findFeedUrl(wp, 'https://other.example/')).toBeNull();
    expect(findFeedUrl('<body><link rel="alternate" type="application/rss+xml" href="/feed/"></body>', 'https://a.test/')).toBeNull();
  });
  it('theme style.css: linked and same host only', () => {
    expect(findThemeStylesheet(wp, 'https://harbour.example/')).toEqual({ url: 'https://harbour.example/wp-content/themes/astra/style.css?ver=6.4.2', slug: 'astra' });
    expect(findThemeStylesheet(wp, 'https://elsewhere.example/')).toBeNull();
    expect(findThemeStylesheet(fixture('html/offshorly-home.html'), 'https://offshorly.com/')).toEqual({
      url: 'https://offshorly.com/app/themes/offshorly-v2/style.css',
      slug: 'offshorly-v2',
    });
  });
  it('style.css Version: header', () => {
    expect(parseStyleCss(fixture('html/style.css'))).toEqual({ name: 'Astra', version: '4.5.2' });
    expect(parseStyleCss('/* Theme Name: X */')).toEqual({ name: 'X', version: null });
    expect(parseStyleCss('body{}')).toEqual({ name: null, version: null });
    // Site-controlled text: only the numeric part is kept.
    expect(parseStyleCss('/*\nVersion: 1.0-vulnerable <b>\n*/').version).toBe('1.0');
    expect(parseStyleCss('/*\nVersion: banana\n*/').version).toBeNull();
  });
  it('xmlrpc via pingback link or header', () => {
    expect(xmlrpcAdvertised(wp, {})).toBe(true);
    expect(xmlrpcAdvertised('<head></head>', { 'x-pingback': 'https://a/xmlrpc.php' })).toBe(true);
    expect(xmlrpcAdvertised('<head></head>', {})).toBe(false);
  });
});

describe('platform detection', () => {
  it('WordPress by generator', () => {
    expect(detectPlatform({ html: fixture('html/wp-classic.html'), headers: {} }).platform).toBe('wordpress');
  });
  it('WordPress Bedrock without generator (offshorly.com)', () => {
    const r = detectPlatform({ html: fixture('html/offshorly-home.html'), headers: {} });
    expect(r.platform).toBe('wordpress');
    expect(r.signals).toEqual(expect.arrayContaining(['api.w.org', 'asset-paths']));
  });
  it('Shopify', () => {
    expect(detectPlatform({ html: fixture('html/shopify.html'), headers: {} }).platform).toBe('shopify');
    expect(detectPlatform({ html: '<html></html>', headers: { 'x-shopid': '123' } }).platform).toBe('shopify');
  });
  it('Wix', () => {
    expect(detectPlatform({ html: fixture('html/wix.html'), headers: {} })).toMatchObject({ platform: 'wix' });
  });
  it('Drupal generator version is reported as fact', () => {
    expect(detectPlatform({ html: '<head><meta name="Generator" content="Drupal 10 (https://www.drupal.org)"></head>', headers: {} })).toMatchObject({
      platform: 'drupal',
      version: '10',
    });
  });
  it('Webflow, Squarespace, Joomla, unknown', () => {
    expect(detectPlatform({ html: '<html data-wf-page="1" data-wf-site="2">', headers: {} }).platform).toBe('webflow');
    expect(detectPlatform({ html: '<script src="https://static1.squarespace.com/x.js"></script>', headers: {} }).platform).toBe('squarespace');
    expect(detectPlatform({ html: '<head><meta name="generator" content="Joomla! - Open Source Content Management"></head>', headers: {} }).platform).toBe('joomla');
    expect(detectPlatform({ html: '<html><body>hi</body></html>', headers: {} }).platform).toBe('unknown');
  });
});
