import { describe, expect, it } from 'vitest';
import {
  createWpOrgClient,
  latestCoreVersion,
  parseDirectoryResponse,
  parseStableCheck,
  pluginInfoUrl,
  stableStatusOf,
  STABLE_CHECK_URL,
  themeInfoUrl,
} from '../../server/cms/wordpressOrg.js';
import type { WpOrgFetch } from '../../server/cms/wordpressOrg.js';
import { fixture } from './_siteMock.js';

// Fixtures are real WordPress.org API responses recorded on 2026-11-20.
const json = (name: string): unknown => JSON.parse(fixture(`wporg/${name}`));

describe('WordPress.org response mapping (recorded fixtures)', () => {
  it('listed plugin', () => {
    expect(parseDirectoryResponse(200, json('plugin-contact-form-7.json'))).toEqual({
      directory: 'listed',
      name: 'Contact Form 7',
      latest: '6.2.5',
      lastUpdated: '2026-11-10',
    });
  });
  it('closed plugin (404 body with error "closed") → closed, without the closure reason', () => {
    const r = parseDirectoryResponse(404, json('plugin-display-widgets.json'));
    expect(r).toEqual({ directory: 'closed', name: 'Display Widgets', latest: null, lastUpdated: '2021-01-30' });
    expect(JSON.stringify(r)).not.toMatch(/Security Issue|reason/i);
  });
  it('premium / unlisted plugin → not_listed', () => {
    expect(parseDirectoryResponse(404, json('plugin-elementor-pro.json')).directory).toBe('not_listed');
  });
  it('listed theme and unlisted custom theme', () => {
    expect(parseDirectoryResponse(200, json('theme-twentytwentyfour.json'))).toEqual({
      directory: 'listed',
      name: 'Twenty Twenty-Four',
      latest: '1.6',
      lastUpdated: '2026-08-19',
    });
    expect(parseDirectoryResponse(404, json('theme-offshorly.json')).directory).toBe('not_listed');
  });
  it('decodes HTML-encoded directory names', () => {
    expect(parseDirectoryResponse(200, { slug: 'jetpack', version: '16.4', name: 'Jetpack &#8211; WP Security &amp; Backup' }).name).toBe('Jetpack – WP Security & Backup');
  });
  it('anything else → unknown', () => {
    expect(parseDirectoryResponse(500, { error: 'Something odd' }).directory).toBe('unknown');
    expect(parseDirectoryResponse(200, null).directory).toBe('unknown');
  });
  it('stable-check', () => {
    const map = parseStableCheck(json('core-stable-check.json'))!;
    expect(latestCoreVersion(map)).toBe('7.1.5');
    expect(stableStatusOf(map, '7.1.5')).toBe('latest');
    expect(stableStatusOf(map, '2.0')).toBe('insecure');
    expect(stableStatusOf(map, '2.0.0')).toBe('insecure');
    expect(stableStatusOf(map, '99.0')).toBeNull();
  });
});

describe('WordPress.org client', () => {
  const routes = (): Map<string, { status: number; body: string }> =>
    new Map([
      [STABLE_CHECK_URL, { status: 200, body: fixture('wporg/core-stable-check.json') }],
      [pluginInfoUrl('contact-form-7'), { status: 200, body: fixture('wporg/plugin-contact-form-7.json') }],
      [pluginInfoUrl('display-widgets'), { status: 404, body: fixture('wporg/plugin-display-widgets.json') }],
      [themeInfoUrl('offshorly-v2'), { status: 404, body: fixture('wporg/theme-offshorly.json') }],
    ]);

  const makeFetch = (r = routes(), delayMs = 0) => {
    const calls: string[] = [];
    let active = 0;
    let peak = 0;
    const fn: WpOrgFetch = async (url) => {
      calls.push(url);
      active++;
      peak = Math.max(peak, active);
      if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
      active--;
      const route = r.get(url) ?? { status: 404, body: '{"error":"Plugin not found."}' };
      return new Response(route.body, { status: route.status });
    };
    return { fn, calls, peak: () => peak };
  };

  it('queries the fixed API URLs and caches per slug', async () => {
    const f = makeFetch();
    let t = 0;
    const c = createWpOrgClient({ fetchImpl: f.fn, now: () => t });
    expect((await c.plugin('contact-form-7')).latest).toBe('6.2.5');
    expect((await c.plugin('contact-form-7')).latest).toBe('6.2.5');
    expect((await c.theme('offshorly-v2')).directory).toBe('not_listed');
    expect(f.calls.filter((u) => u.includes('contact-form-7'))).toHaveLength(1);
    expect(f.calls.every((u) => u.startsWith('https://api.wordpress.org/'))).toBe(true);
    t += 12 * 3_600_000 + 1;
    await c.plugin('contact-form-7');
    expect(f.calls.filter((u) => u.includes('contact-form-7'))).toHaveLength(2);
  });

  it('slug cache is an LRU with a hard cap', async () => {
    const f = makeFetch();
    const c = createWpOrgClient({ fetchImpl: f.fn, maxCacheEntries: 3 });
    for (const s of ['a1', 'a2', 'a3']) await c.plugin(s);
    await c.plugin('a1'); // a1 becomes most recent; a2 is now the oldest
    await c.plugin('a4'); // over the cap: a2 evicted
    expect(f.calls.filter((u) => u.includes('a1'))).toHaveLength(1);
    await c.plugin('a2');
    expect(f.calls.filter((u) => u.includes('a2'))).toHaveLength(2);
    // Unexpired entries are evicted too: the cap is hard.
    for (let i = 0; i < 50; i++) await c.plugin(`b${i}`);
    await c.plugin('a1');
    expect(f.calls.filter((u) => u.includes('a1'))).toHaveLength(2);
  });

  it('stable-check cached for 6 h', async () => {
    const f = makeFetch();
    let t = 0;
    const c = createWpOrgClient({ fetchImpl: f.fn, now: () => t });
    await c.stableCheck();
    t += 5 * 3_600_000;
    await c.stableCheck();
    expect(f.calls.filter((u) => u === STABLE_CHECK_URL)).toHaveLength(1);
    t += 2 * 3_600_000;
    await c.stableCheck();
    expect(f.calls.filter((u) => u === STABLE_CHECK_URL)).toHaveLength(2);
  });

  it('limits concurrency to 5', async () => {
    const f = makeFetch(routes(), 20);
    const c = createWpOrgClient({ fetchImpl: f.fn });
    await Promise.all(Array.from({ length: 12 }, (_, i) => c.plugin(`p${i}`)));
    expect(f.peak()).toBe(5);
  });

  it('failures are unknown and not cached; oversize bodies rejected; bad slugs not requested', async () => {
    let fail = true;
    const calls: string[] = [];
    const c = createWpOrgClient({
      fetchImpl: async (u) => {
        calls.push(u);
        if (fail) throw new Error('network');
        return new Response(fixture('wporg/plugin-contact-form-7.json'));
      },
    });
    expect((await c.plugin('contact-form-7')).directory).toBe('unknown');
    fail = false;
    expect((await c.plugin('contact-form-7')).directory).toBe('listed');
    expect(calls).toHaveLength(2);
    expect((await c.plugin('../etc')).directory).toBe('unknown');
    expect(calls).toHaveLength(2);

    const big = createWpOrgClient({ maxBytes: 100, fetchImpl: async () => new Response('x'.repeat(1000)) });
    expect((await big.plugin('x')).directory).toBe('unknown');
    expect(await big.stableCheck()).toBeNull();
  });

  it('passes a timeout signal', async () => {
    const c = createWpOrgClient({
      timeoutMs: 20,
      fetchImpl: (_u, init) =>
        new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('timeout')))),
    });
    expect((await c.plugin('slow')).directory).toBe('unknown');
  });
});
