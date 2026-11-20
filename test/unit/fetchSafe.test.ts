import { describe, expect, it } from 'vitest';
import { createFetchSafe, USER_AGENT } from '../../server/site/fetchSafe.js';
import { SiteReadError } from '../../server/site/errors.js';
import { mockFetch, mockResolve } from './_siteMock.js';

const html = { 'content-type': 'text/html; charset=utf-8' };

const expectCode = async (p: Promise<unknown>, code: 'not_found' | 'unreadable', msg?: RegExp) => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SiteReadError);
  expect((err as SiteReadError).code).toBe(code);
  if (msg) expect((err as SiteReadError).message).toMatch(msg);
};

describe('fetchSafe', () => {
  it('fetches, sends the honest UA, and logs', async () => {
    let ua = '';
    const fetchImpl = mockFetch({
      'https://site.test/': (init) => {
        ua = init.headers['user-agent'] ?? '';
        expect(init.redirect).toBe('manual');
        return { body: '<html>hi</html>', headers: { ...html, 'set-cookie': 'a=1; Secure' } };
      },
    });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    const r = await f('https://site.test/', { requireHtml: true, requireOk: true });
    expect(ua).toBe(USER_AGENT);
    expect(ua).toBe('Mozilla/5.0 (compatible; OffshorlyAuditBot/1.0; +https://offshorly.com)');
    expect(r.body).toBe('<html>hi</html>');
    expect(r.setCookies).toEqual(['a=1; Secure']);
    expect(f.log).toEqual([{ url: 'https://site.test/', status: 200 }]);
  });

  it('follows redirects, re-checking each hop', async () => {
    const fetchImpl = mockFetch({
      'http://site.test/': { status: 301, headers: { location: 'https://site.test/' } },
      'https://site.test/': { status: 302, headers: { location: '/home' } },
      'https://site.test/home': { body: 'ok', headers: html },
    });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    const r = await f('http://site.test/');
    expect(r.finalUrl).toBe('https://site.test/home');
    expect(r.redirects).toBe(2);
    expect(f.log.map((e) => e.url)).toEqual(['http://site.test/', 'https://site.test/', 'https://site.test/home']);
  });

  it('refuses a redirect to 169.254.169.254 without requesting it', async () => {
    const fetchImpl = mockFetch({
      'https://site.test/': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
    });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    await expectCode(f('https://site.test/'), 'not_found');
    expect(fetchImpl.calls).toEqual(['https://site.test/']);
  });

  it('refuses a redirect to a host that resolves privately', async () => {
    const fetchImpl = mockFetch({ 'https://site.test/': { status: 302, headers: { location: 'https://inside.test/' } } });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve({ 'inside.test': ['10.1.2.3'] }) });
    await expectCode(f('https://site.test/'), 'not_found');
    expect(fetchImpl.calls).toEqual(['https://site.test/']);
  });

  it('errors after more than 5 redirects (6 hops)', async () => {
    const routes: Record<string, { status: number; headers: Record<string, string> }> = {};
    for (let i = 0; i < 7; i++) routes[`https://site.test/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    const fetchImpl = mockFetch(routes);
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    await expectCode(f('https://site.test/0'), 'unreadable', /redirected too many times/);
    expect(fetchImpl.calls).toHaveLength(6);
  });

  it('allows exactly 5 redirects', async () => {
    const routes: Record<string, { status?: number; headers: Record<string, string>; body?: string }> = {};
    for (let i = 0; i < 5; i++) routes[`https://site.test/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    routes['https://site.test/5'] = { headers: html, body: 'done' };
    const f = createFetchSafe({ fetchImpl: mockFetch(routes), resolveAll: mockResolve() });
    await expect(f('https://site.test/0')).resolves.toMatchObject({ body: 'done', redirects: 5 });
  });

  it('truncates at maxBytes', async () => {
    const fetchImpl = mockFetch({ 'https://site.test/': { body: 'x'.repeat(5000), headers: html } });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    const r = await f('https://site.test/', { maxBytes: 1000 });
    expect(r.bytes).toBe(1000);
    expect(r.body).toHaveLength(1000);
    expect(r.truncated).toBe(true);
  });

  it('non-HTML → unreadable when HTML is required', async () => {
    const fetchImpl = mockFetch({ 'https://site.test/': { body: '{}', headers: { 'content-type': 'application/json' } } });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    await expectCode(f('https://site.test/', { requireHtml: true }), 'unreadable', /did not return a web page/);
  });

  it('403 → refused', async () => {
    const fetchImpl = mockFetch({ 'https://site.test/': { status: 403, body: 'no', headers: html } });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    await expectCode(f('https://site.test/', { requireOk: true }), 'unreadable', /refused our automated visit/);
  });

  it('500 → error with status', async () => {
    const fetchImpl = mockFetch({ 'https://site.test/': { status: 500, body: 'x', headers: html } });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    await expectCode(f('https://site.test/', { requireOk: true }), 'unreadable', /status 500/);
  });

  it('non-2xx without requireOk is returned', async () => {
    const fetchImpl = mockFetch({ 'https://site.test/robots.txt': { status: 404, body: 'nope', headers: html } });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve() });
    await expect(f('https://site.test/robots.txt')).resolves.toMatchObject({ status: 404 });
  });

  it('handles a timeout', async () => {
    const fetchImpl = mockFetch({ 'https://site.test/': { delayMs: 500, body: 'late', headers: html } });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve(), timeoutMs: 30 });
    await expectCode(f('https://site.test/'), 'unreadable', /too long/);
    expect(f.log[0]).toMatchObject({ error: 'timeout' });
  });

  it('maps connection failures and DNS errors', async () => {
    const refused: Parameters<typeof createFetchSafe>[0] = {
      resolveAll: mockResolve(),
      fetchImpl: async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
      },
    };
    await expectCode(createFetchSafe(refused)('https://site.test/'), 'unreadable', /couldn't connect/);
    await expectCode(
      createFetchSafe({ resolveAll: mockResolve({ 'nx.test': [] }), fetchImpl: mockFetch({}) })('https://nx.test/'),
      'not_found',
    );
  });

  it('refuses the guide list of bad inputs without fetching', async () => {
    const fetchImpl = mockFetch({});
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve({ '127.0.0.1.nip.io': ['127.0.0.1'] }), maxFetches: 100 });
    for (const u of [
      'http://localhost:3000',
      'http://127.0.0.1',
      'http://0.0.0.0',
      'http://10.0.0.1',
      'http://169.254.169.254/latest',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://2130706433/',
      'http://127.0.0.1.nip.io',
      'ftp://example.com',
      'http://example.com:8080',
    ]) {
      await expectCode(f(u), 'not_found');
    }
    expect(fetchImpl.calls).toEqual([]);
  });

  it('enforces the per-audit fetch budget', async () => {
    const fetchImpl = mockFetch({ 'https://site.test/': { body: 'ok', headers: html } });
    const f = createFetchSafe({ fetchImpl, resolveAll: mockResolve(), maxFetches: 2 });
    await f('https://site.test/');
    await f('https://site.test/');
    await expectCode(f('https://site.test/'), 'unreadable', /budget/);
  });

  it('decodes a declared charset', async () => {
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in latin1
    const f = createFetchSafe({
      resolveAll: mockResolve(),
      fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'text/html; charset=iso-8859-1' } }),
    });
    expect((await f('https://site.test/')).body).toBe('café');
  });
});
