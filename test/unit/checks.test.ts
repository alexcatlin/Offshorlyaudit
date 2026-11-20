import { describe, expect, it } from 'vitest';
import type { CheckId, CheckResult } from '../../shared/types.js';
import { buildSection, scoreChecks } from '../../server/checks/score.js';
import { securityChecks, checkCookies, checkDisclosure, checkFrame, findMixedContent } from '../../server/checks/security.js';
import { healthChecks, blockedAiBots, checkBlockingScripts, jsonLdTypes } from '../../server/checks/health.js';
import { checkDmarc, checkSpf, domainCandidates, emailChecks } from '../../server/checks/dns.js';
import type { ResolveTxt } from '../../server/checks/dns.js';
import { pageSpeedChecks, runPageSpeed } from '../../server/checks/pagespeed.js';
import { fetchCheckInputs } from '../../server/checks/extras.js';
import { createFetchSafe } from '../../server/site/fetchSafe.js';
import { fixture, mockFetch, mockResolve } from './_siteMock.js';

const byId = (checks: CheckResult[]) => Object.fromEntries(checks.map((c) => [c.id, c])) as Record<CheckId, CheckResult>;

describe('score', () => {
  it('weights pass 1 / warn 0.5 / fail 0 and excludes info', () => {
    // sec-https w3 pass, sec-hsts w2 warn, sec-frame w1 fail, sec-csp info (excluded)
    const checks: CheckResult[] = [
      { id: 'sec-https', status: 'pass', detail: '' },
      { id: 'sec-hsts', status: 'warn', detail: '' },
      { id: 'sec-frame', status: 'fail', detail: '' },
      { id: 'sec-csp', status: 'info', detail: '' },
    ];
    // (3 + 1 + 0) / 6 = 0.6667
    expect(scoreChecks(checks)).toBe(67);
    expect(buildSection(checks).score).toBe(67);
  });
  it('null when nothing is scorable', () => {
    expect(scoreChecks([])).toBeNull();
    expect(scoreChecks([{ id: 'sec-csp', status: 'info', detail: '' }])).toBeNull();
  });
  it('uses fractional weights (wp-version-exposed 0.5)', () => {
    expect(
      scoreChecks([
        { id: 'wp-version-exposed', status: 'fail', detail: '' },
        { id: 'sec-frame', status: 'pass', detail: '' },
      ]),
    ).toBe(67);
  });
});

describe('security checks', () => {
  const offshorlyHeaders = {
    server: 'nginx-rc',
    'content-type': 'text/html; charset=UTF-8',
    'x-frame-options': 'SAMEORIGIN',
    'x-xss-protection': '1; mode=block',
    'x-content-type-options': 'nosniff',
  };

  it('offshorly-like headers: sec-frame pass (SAMEORIGIN), sec-csp fail', () => {
    const r = byId(
      securityChecks({
        home: { finalUrl: 'https://offshorly.com/', headers: offshorlyHeaders, setCookies: [], html: fixture('html/offshorly-home.html') },
        httpProbe: { finalUrl: 'https://offshorly.com/' },
      }),
    );
    expect(r['sec-frame']).toMatchObject({ status: 'pass', detail: 'X-Frame-Options is SAMEORIGIN.' });
    expect(r['sec-csp'].status).toBe('fail');
    expect(r['sec-https'].status).toBe('pass');
    expect(r['sec-redirect'].status).toBe('pass');
    expect(r['sec-hsts'].status).toBe('fail');
    expect(r['sec-nosniff'].status).toBe('pass');
    expect(r['sec-referrer'].status).toBe('warn');
    expect(r['sec-cookies'].status).toBe('pass');
    expect(r['sec-disclosure'].status).toBe('pass');
  });

  it('plain-HTTP site: https fail, redirect fail, hsts fail, mixed info', () => {
    const r = byId(
      securityChecks({ home: { finalUrl: 'http://a.test/', headers: {}, setCookies: [], html: '' }, httpProbe: { finalUrl: 'http://a.test/' } }),
    );
    expect(r['sec-https'].status).toBe('fail');
    expect(r['sec-redirect'].status).toBe('fail');
    expect(r['sec-hsts'].status).toBe('fail');
    expect(r['sec-mixed'].status).toBe('info');
  });

  it('redirect probe failure → info; full headers → pass', () => {
    const r = byId(
      securityChecks({
        home: {
          finalUrl: 'https://a.test/',
          headers: {
            'strict-transport-security': 'max-age=31536000',
            'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
            'referrer-policy': 'strict-origin-when-cross-origin',
            'x-content-type-options': 'nosniff',
          },
          setCookies: ['sid=1; Secure; HttpOnly; SameSite=Lax'],
          html: '<img src="https://a.test/x.png">',
        },
        httpProbe: null,
      }),
    );
    expect(r['sec-redirect'].status).toBe('info');
    for (const id of ['sec-hsts', 'sec-csp', 'sec-frame', 'sec-referrer', 'sec-cookies', 'sec-mixed', 'sec-nosniff'] as const) {
      expect(r[id].status, id).toBe('pass');
    }
  });

  it('hsts max-age=0 fails; report-only CSP fails', () => {
    const r = byId(
      securityChecks({
        home: { finalUrl: 'https://a.test/', headers: { 'strict-transport-security': 'max-age=0', 'content-security-policy-report-only': "default-src 'self'" }, setCookies: [], html: '' },
        httpProbe: null,
      }),
    );
    expect(r['sec-hsts'].status).toBe('fail');
    expect(r['sec-csp']).toMatchObject({ status: 'fail', detail: expect.stringMatching(/report-only/) });
  });

  it('cookies, disclosure, frame edge cases', () => {
    expect(checkCookies(['a=1; Secure', 'b=2; Secure; SameSite=None']).status).toBe('warn');
    expect(checkDisclosure({ server: 'Apache/2.4.57', 'x-powered-by': 'PHP/8.1.2' })).toMatchObject({ status: 'warn' });
    expect(checkDisclosure({ server: 'cloudflare' }).status).toBe('pass');
    expect(checkFrame({}).status).toBe('fail');
    expect(checkFrame({ 'x-frame-options': 'ALLOW-FROM https://x' }).status).toBe('warn');
    // Echoed header values are sanitised.
    expect(checkDisclosure({ server: 'Apache/2.4 <script>alert(1)</script>' }).detail).not.toMatch(/[<>]/);
    expect(checkDisclosure({ server: 'vulnerable-server/1.0' }).detail).toBe('Response headers show software versions (Server: (value not shown)).');
  });

  it('mixed content finds http:// on img, script, iframe, stylesheet, srcset; ignores anchors', () => {
    const found = findMixedContent(
      '<img src="http://a/x.png"><script src="http://a/x.js"></script><iframe src="http://a/f"></iframe>' +
        '<link rel="stylesheet" href="http://a/s.css"><img src="https://ok" srcset="http://a/1.png 1x"><a href="http://a/page">x</a><!-- <img src="http://c"> -->',
    );
    expect(found).toHaveLength(5);
  });
});

describe('health checks', () => {
  const wp = fixture('html/wp-classic.html');
  const base = {
    html: wp,
    headers: { 'content-encoding': 'br' },
    title: 'Harbour Accountants | Bookkeeping and tax for small firms',
    description: '',
    text: 'Do you need help with VAT?\nWhat do we charge?\nHow fast?',
    wordCount: 320,
    ttfbMs: 400,
    bytes: 50_000,
  };

  it('representative results from fixture HTML', () => {
    const r = byId(
      healthChecks({
        home: base,
        pages: [{ text: 'Who do you work with?' }],
        fetches: { robots: { status: 200, body: 'User-agent: *\nDisallow: /wp-admin/\nSitemap: https://harbour.example/sitemap.xml', usable: true }, sitemap: null },
      }),
    );
    expect(r['seo-title'].status).toBe('pass');
    expect(r['seo-description'].status).toBe('pass');
    expect(r['seo-h1'].status).toBe('pass');
    expect(r['seo-indexable'].status).toBe('pass');
    expect(r['seo-content'].status).toBe('pass');
    expect(r['seo-sitemap'].status).toBe('pass');
    expect(r['seo-canonical'].status).toBe('pass');
    expect(r['seo-og'].status).toBe('warn'); // title, no image
    expect(r['seo-alt']).toMatchObject({ status: 'warn', detail: '2 of 3 images on the homepage have a description (alt text).' });
    expect(r['geo-bots'].status).toBe('pass');
    expect(r['geo-nojs'].status).toBe('pass');
    expect(r['geo-structured'].status).toBe('pass');
    expect(r['geo-questions'].status).toBe('pass');
    expect(r['spd-ttfb'].status).toBe('pass');
    expect(r['spd-viewport'].status).toBe('pass');
    expect(r['spd-compression'].status).toBe('pass');
    expect(r['spd-html-size'].status).toBe('pass');
    expect(r['spd-blocking-scripts']).toMatchObject({ status: 'fail', detail: expect.stringMatching(/^6 script/) });
  });

  it('failing cases', () => {
    const r = byId(
      healthChecks({
        home: { html: '<html><head><meta name="robots" content="noindex,follow"></head><body><h1>a</h1><h1>b</h1></body></html>', headers: {}, title: '', description: '', text: '', wordCount: 40, ttfbMs: 2500, bytes: 600 * 1024 },
        pages: [],
        fetches: { robots: { status: 200, body: 'User-agent: *\nDisallow: /', usable: true }, sitemap: { status: 404, body: '', usable: false } },
      }),
    );
    expect(r['seo-title'].status).toBe('fail');
    expect(r['seo-description'].status).toBe('fail');
    expect(r['seo-h1'].status).toBe('warn');
    expect(r['seo-indexable'].status).toBe('fail');
    expect(r['seo-content'].status).toBe('fail');
    expect(r['seo-sitemap'].status).toBe('fail');
    expect(r['seo-canonical'].status).toBe('warn');
    expect(r['seo-og'].status).toBe('fail');
    expect(r['seo-alt'].status).toBe('pass');
    expect(r['geo-bots'].status).toBe('fail');
    expect(r['geo-nojs'].status).toBe('warn');
    expect(r['geo-structured'].status).toBe('fail');
    expect(r['geo-questions'].status).toBe('fail');
    expect(r['spd-ttfb'].status).toBe('fail');
    expect(r['spd-viewport'].status).toBe('fail');
    expect(r['spd-compression'].status).toBe('warn');
    expect(r['spd-html-size'].status).toBe('fail');
  });

  it('X-Robots-Tag noindex fails seo-indexable; sitemap.xml with <urlset passes', () => {
    const r = byId(
      healthChecks({
        home: { ...base, headers: { 'x-robots-tag': 'noindex' } },
        pages: [],
        fetches: { robots: null, sitemap: { status: 200, body: '<?xml version="1.0"?><urlset></urlset>', usable: true } },
      }),
    );
    expect(r['seo-indexable'].status).toBe('fail');
    expect(r['seo-sitemap'].status).toBe('pass');
  });

  it('geo-bots: specific groups override *, Allow: / reopens', () => {
    expect(blockedAiBots('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /')).toEqual(['GPTBot']);
    expect(blockedAiBots('User-agent: *\nDisallow: /\n\nUser-agent: ClaudeBot\nAllow: /')).toEqual(['GPTBot', 'OAI-SearchBot', 'PerplexityBot', 'Google-Extended']);
    expect(blockedAiBots('User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /*')).toEqual(['GPTBot', 'ClaudeBot']);
    expect(blockedAiBots('User-agent: *\nDisallow: /private/')).toEqual([]);
    expect(blockedAiBots('User-agent: *\nDisallow: /\nAllow: /')).toEqual([]);
  });

  it('geo-structured echoes only schema-like type names', () => {
    const html = '<script type="application/ld+json">{"@type":["<img src=x>","Article"]}</script>';
    const r = byId(healthChecks({ home: { html, headers: {}, title: '', description: '', text: '', wordCount: 0, ttfbMs: 0, bytes: 0 }, pages: [], fetches: { robots: null, sitemap: null } }));
    expect(r['geo-structured']).toMatchObject({ status: 'warn', detail: 'Structured data is present (Article) but does not describe the business.' });
  });

  it('JSON-LD types from @graph and arrays; invalid JSON ignored', () => {
    expect(jsonLdTypes('<script type="application/ld+json">{"@graph":[{"@type":["Organization","Thing"]}]}</script><script type="application/ld+json">{bad</script>')).toEqual(['Organization', 'Thing']);
  });

  it('blocking scripts ignore async, defer and module', () => {
    expect(
      checkBlockingScripts('<head><script src="a.js"></script><script async src="b.js"></script><script defer src="c.js"></script><script type="module" src="d.js"></script></head>'),
    ).toMatchObject({ status: 'pass', detail: expect.stringMatching(/^1 script/) });
  });
});

describe('dns', () => {
  it('candidates stop before compound suffixes and TLDs', () => {
    expect(domainCandidates('www.example.co.uk')).toEqual(['www.example.co.uk', 'example.co.uk']);
    expect(domainCandidates('shop.example.com')).toEqual(['shop.example.com', 'example.com']);
    expect(domainCandidates('example.com.au')).toEqual(['example.com.au']);
    expect(domainCandidates('co.uk')).toEqual([]);
  });

  const txt = (records: Record<string, string[][]>): ResolveTxt & { asked: string[] } => {
    const asked: string[] = [];
    const fn = async (name: string) => {
      asked.push(name);
      if (records[name]) return records[name]!;
      throw Object.assign(new Error('nodata'), { code: 'ENODATA' });
    };
    return Object.assign(fn, { asked });
  };

  it('SPF found on the parent; walk never queries co.uk', async () => {
    const r = txt({ 'example.co.uk': [['v=spf1 include:_spf.google.com ', '~all']] });
    await expect(checkSpf('www.example.co.uk', { resolveTxt: r })).resolves.toMatchObject({ status: 'pass', detail: 'SPF record found on example.co.uk.' });
    const miss = txt({});
    await expect(checkSpf('www.example.co.uk', { resolveTxt: miss })).resolves.toMatchObject({ status: 'fail' });
    expect(miss.asked).toEqual(['www.example.co.uk', 'example.co.uk']);
  });

  it('DMARC policies', async () => {
    const mk = (p: string) => txt({ '_dmarc.example.com': [[`v=DMARC1; p=${p}; rua=mailto:x@example.com`]] });
    await expect(checkDmarc('example.com', { resolveTxt: mk('reject') })).resolves.toMatchObject({ status: 'pass' });
    await expect(checkDmarc('example.com', { resolveTxt: mk('quarantine') })).resolves.toMatchObject({ status: 'pass' });
    await expect(checkDmarc('example.com', { resolveTxt: mk('none') })).resolves.toMatchObject({ status: 'warn' });
    await expect(checkDmarc('example.com', { resolveTxt: txt({}) })).resolves.toMatchObject({ status: 'fail' });
  });

  it('timeouts / server failures → info', async () => {
    const slow: ResolveTxt = () => new Promise(() => undefined);
    await expect(checkSpf('example.com', { resolveTxt: slow, timeoutMs: 10 })).resolves.toMatchObject({ status: 'info' });
    const servfail: ResolveTxt = async () => {
      throw Object.assign(new Error('x'), { code: 'ESERVFAIL' });
    };
    await expect(checkDmarc('example.com', { resolveTxt: servfail })).resolves.toMatchObject({ status: 'info' });
  });

  it('IP-addressed site → info', async () => {
    const r = await emailChecks('93.184.216.34', { resolveTxt: txt({}) });
    expect(r.map((c) => c.status)).toEqual(['info', 'info']);
  });
});

describe('pagespeed', () => {
  it('maps the API response', () => {
    const r = byId(pageSpeedChecks(JSON.parse(fixture('pagespeed/psi-mobile.json'))));
    expect(r['spd-google-score']).toMatchObject({ status: 'warn', detail: "Google's mobile speed score is 62 out of 100." });
    expect(r['spd-lcp'].status).toBe('warn');
    expect(r['spd-cls'].status).toBe('pass');
    expect(r['spd-tbt'].status).toBe('fail');
  });
  it('returns null on failure and calls Google with the key', async () => {
    let called = '';
    const ok = await runPageSpeed('https://a.test/', {
      apiKey: 'K',
      fetchImpl: async (u) => {
        called = u;
        return { ok: true, status: 200, json: async () => JSON.parse(fixture('pagespeed/psi-mobile.json')) as unknown };
      },
    });
    expect(ok).toHaveLength(4);
    expect(called).toMatch(/^https:\/\/www\.googleapis\.com\/pagespeedonline\/v5\/runPagespeed\?url=https%3A%2F%2Fa\.test%2F&strategy=mobile&category=performance&key=K$/);
    await expect(runPageSpeed('https://a.test/', { apiKey: 'K', fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) })).resolves.toBeNull();
  });
});

describe('check fetches', () => {
  const html = { 'content-type': 'text/html' };
  it('skips /sitemap.xml when robots.txt lists a sitemap', async () => {
    const fetchImpl = mockFetch({
      'https://a.test/robots.txt': { body: 'Sitemap: https://a.test/s.xml', headers: { 'content-type': 'text/plain' } },
      'http://a.test/': { status: 301, headers: { location: 'https://a.test/' } },
      'https://a.test/': { body: '<html></html>', headers: html },
    });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    const r = await fetchCheckInputs('https://a.test/', { fetchSafe: f });
    expect(r.sitemapFetched).toBe(false);
    expect(r.httpProbe?.finalUrl).toBe('https://a.test/');
    expect(fetchImpl.calls.sort()).toEqual(['http://a.test/', 'https://a.test/', 'https://a.test/robots.txt']);
  });

  it('fetches /sitemap.xml when robots has no Sitemap line; HTML robots is unusable', async () => {
    const fetchImpl = mockFetch({
      'https://a.test/robots.txt': { body: '<!doctype html><p>404</p>', headers: html },
      'https://a.test/sitemap.xml': { body: '<sitemapindex></sitemapindex>', headers: { 'content-type': 'application/xml' } },
    });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    const r = await fetchCheckInputs('https://a.test/', { fetchSafe: f });
    expect(r.robots?.usable).toBe(false);
    expect(r.sitemapFetched).toBe(true);
    expect(r.sitemap?.usable).toBe(true);
  });
});
