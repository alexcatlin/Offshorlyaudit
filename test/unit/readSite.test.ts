// End-to-end over the mocked internet: readSite → measured checks → CMS → stack.
// Asserts the passive-fetch contract from the fetch log.
import { describe, expect, it } from 'vitest';
import { readSite, normaliseInputUrl } from '../../server/site/readSite.js';
import { createFetchSafe } from '../../server/site/fetchSafe.js';
import { SiteReadError } from '../../server/site/errors.js';
import { runMeasuredChecks } from '../../server/checks/run.js';
import { analyseCms } from '../../server/cms/cms.js';
import { createWpOrgClient, pluginInfoUrl, STABLE_CHECK_URL, themeInfoUrl } from '../../server/cms/wordpressOrg.js';
import { createWordfence } from '../../server/cms/wordfence.js';
import { detectStack } from '../../server/stack/detect.js';
import { fixture, mockFetch, mockResolve } from './_siteMock.js';

const H = { 'content-type': 'text/html; charset=utf-8' };
const filler = `<p>${'We help small firms with clear monthly bookkeeping and friendly advice. '.repeat(8)}</p>`;
const inner = (title: string) => `<html><head><title>${title}</title></head><body><h1>${title}</h1>${filler}</body></html>`;

const harbourRoutes = () => ({
  'https://harbour.example/': {
    body: fixture('html/wp-classic.html').replace('</main>', `${filler}</main>`),
    headers: { ...H, 'x-frame-options': 'SAMEORIGIN', 'content-encoding': 'gzip' },
  },
  'https://harbour.example/services/': { body: inner('Services'), headers: H },
  'https://harbour.example/about-us/': { body: inner('About us'), headers: H },
  'https://harbour.example/contact/': { body: inner('Contact'), headers: H },
  'https://harbour.example/robots.txt': { body: 'User-agent: *\nDisallow: /wp-admin/\n', headers: { 'content-type': 'text/plain' } },
  'https://harbour.example/sitemap.xml': { body: '<urlset></urlset>', headers: { 'content-type': 'application/xml' } },
  'http://harbour.example/': { status: 301, headers: { location: 'https://harbour.example/' } },
  'https://harbour.example/feed/': { body: fixture('html/feed.xml'), headers: { 'content-type': 'application/rss+xml' } },
  'https://harbour.example/wp-content/themes/astra/style.css?ver=6.4.2': { body: fixture('html/style.css'), headers: { 'content-type': 'text/css' } },
});

const wpOrgRoutes = new Map<string, { status: number; body: string }>([
  [STABLE_CHECK_URL, { status: 200, body: fixture('wporg/core-stable-check.json') }],
  [pluginInfoUrl('contact-form-7'), { status: 200, body: fixture('wporg/plugin-contact-form-7.json') }],
  [pluginInfoUrl('display-widgets'), { status: 404, body: fixture('wporg/plugin-display-widgets.json') }],
  [pluginInfoUrl('elementor'), { status: 200, body: JSON.stringify({ name: 'Elementor', slug: 'elementor', version: '3.30.1', last_updated: '2026-10-01 1:00pm GMT' }) }],
  [themeInfoUrl('astra'), { status: 200, body: JSON.stringify({ name: 'Astra', slug: 'astra', version: '4.11.0', last_updated: '2026-09-01' }) }],
]);

const wpOrg = () =>
  createWpOrgClient({
    fetchImpl: async (u) => {
      const r = wpOrgRoutes.get(u) ?? { status: 404, body: '{"error":"Plugin not found."}' };
      return new Response(r.body, { status: r.status });
    },
  });

describe('readSite', () => {
  it('normalises input URLs', () => {
    expect(normaliseInputUrl('example.com').href).toBe('https://example.com/');
    expect(normaliseInputUrl('example.com:8080').href).toBe('https://example.com:8080/');
    expect(normaliseInputUrl('http://example.com').href).toBe('http://example.com/');
    expect(() => normaliseInputUrl('http://')).toThrow(SiteReadError);
  });

  it('reads home + picked pages, then checks and CMS stay within the allowed fetch set', async () => {
    const fetchImpl = mockFetch(harbourRoutes());
    const fetchSafe = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    const site = await readSite('harbour.example', { fetchSafe });

    expect(site.thin).toBe(false);
    expect(site.home.finalUrl).toBe('https://harbour.example/');
    expect(site.home.title).toMatch(/^Harbour Accountants/);
    expect(site.pages.map((p) => p.label)).toEqual(['Services', 'About', 'Contact']);

    const wf = createWordfence({ apiKey: 'k', fetchImpl: async () => new Response(fixture('wordfence/scanner-feed.json')) })!;
    await wf.refresh();

    const [measured, cms] = await Promise.all([
      runMeasuredChecks(site, { fetchSafe, resolveTxt: async () => [['v=spf1 -all']] }),
      analyseCms(site.home, { fetchSafe, wpOrg: wpOrg(), wordfence: wf, now: () => Date.parse('2026-11-20T00:00:00Z') }),
    ]);

    // Passive contract: only these URLs, nothing else on the target.
    const allowed = new Set([
      'https://harbour.example/',
      'https://harbour.example/services/',
      'https://harbour.example/about-us/',
      'https://harbour.example/contact/',
      'https://harbour.example/robots.txt',
      'https://harbour.example/sitemap.xml',
      'http://harbour.example/',
      'https://harbour.example/feed/',
      'https://harbour.example/wp-content/themes/astra/style.css?ver=6.4.2',
    ]);
    const urls = site.fetchLog.map((e) => e.url);
    for (const u of urls) expect(allowed.has(u), u).toBe(true);
    expect(urls.filter((u) => /wp-login|readme|wp-json|xmlrpc|author|debug\.log|uploads\/$/i.test(u))).toEqual([]);
    expect(fetchImpl.calls).toEqual(urls);
    expect(new Set(urls).size).toBeLessThanOrEqual(10);

    // Measured checks.
    const sec = Object.fromEntries(measured.security.map((c) => [c.id, c.status]));
    expect(sec['sec-frame']).toBe('pass');
    expect(sec['sec-csp']).toBe('fail');
    expect(sec['sec-redirect']).toBe('pass');
    expect(sec['sec-spf']).toBe('pass');
    expect(sec['sec-mixed']).toBe('fail'); // http:// image in fixture
    expect(measured.fetches.sitemapFetched).toBe(true);
    expect(measured.measuredByGoogle).toBe(false);

    // CMS.
    expect(cms.cms.platform).toBe('wordpress');
    const w = cms.cms.wordpress!;
    // Real stable-check fixture lists 6.4.2 as insecure.
    expect(w.core).toEqual({ version: '6.4.2', source: 'generator', latest: '7.1.5', status: 'insecure' });
    expect(w.versionExposed).toBe(true);
    expect(w.xmlrpcAdvertised).toBe(true);
    const c = (slug: string) => w.components.find((x) => x.slug === slug)!;
    expect(c('contact-form-7')).toMatchObject({ version: '5.8.4', latest: '6.2.5', status: 'outdated', directory: 'listed' });
    expect(c('display-widgets')).toMatchObject({ directory: 'closed' });
    expect(c('display-widgets')).not.toHaveProperty('closedReason');
    expect(c('astra')).toMatchObject({ type: 'theme', name: 'Astra', version: '4.5.2', versionSource: 'stylesheet', latest: '4.11.0', status: 'outdated' });
    // elementor 3.18.0 matches fixture issue C (unpatched) → counted, but no "fix available" status.
    expect(c('elementor')).toMatchObject({ version: '3.18.0', status: 'outdated' });
    expect(w.vulnSource).toBe('wordfence');
    expect(w.knownIssues).toEqual({ count: 2, highest: 'critical' }); // elementor C + core 6.4.2
    expect(cms.attributions).toHaveLength(1);

    const wpc = Object.fromEntries(cms.checks.map((x) => [x.id, x]));
    expect(wpc['wp-core-version']).toMatchObject({ status: 'fail', detail: expect.stringMatching(/lists as insecure/) });
    expect(wpc['wp-plugins']!.status).toBe('fail'); // closed plugin
    expect(wpc['wp-theme']!.status).toBe('warn');
    expect(wpc['wp-xmlrpc']!.status).toBe('warn');
    expect(wpc['wp-version-exposed']!.status).toBe('warn');

    // Stack across home + pages.
    const stack = detectStack([site.home.html, ...site.pages.map((p) => p.html)]);
    expect(stack.tech.map((t) => t.id)).toEqual(expect.arrayContaining(['cf7', 'calendly', 'ga4']));
  });

  it('does not fetch a feed or stylesheet on another host', async () => {
    const html = `<html><head><meta name="generator" content="WordPress 6.4.2">
      <link rel="alternate" type="application/rss+xml" href="https://feeds.other.example/feed">
      <link rel="stylesheet" href="https://cdn.other.example/wp-content/themes/x/style.css"></head><body>${filler}</body></html>`;
    const fetchImpl = mockFetch({ 'https://a.example/': { body: html, headers: H } });
    const fetchSafe = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    const site = await readSite('https://a.example/', { fetchSafe });
    await analyseCms(site.home, { fetchSafe, wpOrg: wpOrg() });
    expect(fetchImpl.calls).toEqual(['https://a.example/']);
  });

  it('thin homepage: flagged, no inner pages fetched', async () => {
    const fetchImpl = mockFetch({
      'https://thin.example/': { body: '<html><head><title>App</title></head><body><div id="root"></div><a href="/about">About</a></body></html>', headers: H },
    });
    const fetchSafe = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    const site = await readSite('thin.example', { fetchSafe });
    expect(site.thin).toBe(true);
    expect(site.pages).toEqual([]);
    expect(fetchImpl.calls).toEqual(['https://thin.example/']);
  });

  it('inner pages that fail, redirect off-site, or are too short are dropped', async () => {
    const home = `<html><body>${filler}<a href="/services">Services</a><a href="/about">About</a><a href="/careers">Careers</a></body></html>`;
    const fetchImpl = mockFetch({
      'https://b.example/': { body: home, headers: H },
      'https://b.example/services': { status: 500, body: 'x', headers: H },
      'https://b.example/about': { status: 302, headers: { location: 'https://elsewhere.example/about' } },
      'https://elsewhere.example/about': { body: inner('About'), headers: H },
      'https://b.example/careers': { body: '<p>short</p>', headers: H },
    });
    const site = await readSite('https://b.example/', { fetchSafe: createFetchSafe({ fetchImpl, resolveAll: mockResolve() }) });
    expect(site.pages).toEqual([]);
  });

  it('403 homepage → site_unreadable; private target → site_not_found', async () => {
    const f1 = createFetchSafe({ fetchImpl: mockFetch({ 'https://c.example/': { status: 403, body: '', headers: H } }), resolveAll: mockResolve() });
    await expect(readSite('c.example', { fetchSafe: f1 })).rejects.toMatchObject({ code: 'unreadable' });
    const f2 = createFetchSafe({ fetchImpl: mockFetch({}), resolveAll: mockResolve() });
    await expect(readSite('http://127.0.0.1', { fetchSafe: f2 })).rejects.toMatchObject({ code: 'not_found' });
  });
});
