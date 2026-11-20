// app.inject tests (PLAN Testing, Amendments 1 and 2). Network and AI are mocked.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditReport, BuyerFitResult } from '../../shared/types.js';
import { buildApp } from '../../server/app.js';
import { sanitiseLeadName, validateLeadFields } from '../../server/lead/email.js';
import { appConfig, appDeps, auditDeps, controlledEngine, deferred, fakeMx, ORIGIN, sampleAi, sampleBuyerFit, siteRoutes } from './_appMock.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = null;
});

// Every audit needs an email (Amendment 3). These tests aren't about the gate, so each call gets
// a fresh address unless the payload brings its own (see app.gate.test.ts for the gate).
let emailN = 0;
const withEmail = (payload: unknown): unknown =>
  payload && typeof payload === 'object' && !Array.isArray(payload) && !('email' in payload)
    ? { ...payload, email: `visitor${++emailN}@mail.example` }
    : payload;
const post = (a: FastifyInstance, payload: unknown, headers: Record<string, string> = ORIGIN) =>
  a.inject({ method: 'POST', url: '/api/audit', headers, payload: withEmail(payload) as object });

describe('POST /api/audit', () => {
  it('200 with mocked network and fixture AI; buyer fit and AI pending', async () => {
    app = await buildApp(appDeps());
    const res = await post(app, { url: 'acme.example' });
    expect(res.statusCode).toBe(200);
    const r = res.json<AuditReport>();
    expect(r.buyerFitStatus).toBe('pending');
    expect(r.aiStatus).toBe('pending');
    expect(r.fixture).toBe(true);
    expect('leadCapture' in r).toBe(false);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns before a slow AI resolves; each GET then returns its result', async () => {
    const c = controlledEngine();
    const { calls: _c, ...audit } = auditDeps(siteRoutes(), { ai: c.engine });
    app = await buildApp({ mxResolver: fakeMx, config: appConfig({ aiMode: 'live' }), audit });
    const res = await post(app, { url: 'acme.example' });
    expect(res.statusCode).toBe(200);
    const r = res.json<AuditReport>();
    expect([r.buyerFitStatus, r.aiStatus]).toEqual(['pending', 'pending']);
    expect(r.ai).toBeUndefined();
    expect(r.buyerFit).toBeUndefined();

    const aiReq = app.inject({ method: 'GET', url: `/api/audit/${r.auditId}/ai`, headers: ORIGIN });
    const bfReq = app.inject({ method: 'GET', url: `/api/audit/${r.auditId}/buyer-fit`, headers: ORIGIN });
    c.ai.resolve({ status: 'ok', ai: sampleAi() });
    c.bf.resolve(sampleBuyerFit([{ text: 'Name a client on the homepage', horizon: 'now', impact: 'high', effort: 'low', owner: 'marketing' }]));

    const ai = await aiReq;
    expect(ai.statusCode).toBe(200);
    expect(ai.json()).toMatchObject({ auditId: r.auditId, aiStatus: 'ok', ai: { opportunities: [{ title: 'Faster invoice processing' }] } });
    expect(ai.json().fixFirst).toBeUndefined();

    const bf = await bfReq;
    expect(bf.statusCode).toBe(200);
    const bfBody = bf.json<BuyerFitResult>();
    expect(bfBody.buyerFitStatus).toBe('ok');
    expect(bfBody.buyerFit?.score).toBe(62);
    // The buyer-fit action (high impact, low effort, +0.25) outranks every measured check.
    expect(bfBody.fixFirst[0]).toEqual({ source: 'ai', section: 'buyer-fit', actionIndex: 0 });
    expect(bfBody.fixFirst.length).toBeLessThanOrEqual(5);
    expect(r.fixFirst.some((f) => f.source === 'ai')).toBe(false);
  });

  it('a cache hit returns the same auditId, with settled results inline', async () => {
    app = await buildApp(appDeps());
    const first = (await post(app, { url: 'acme.example' })).json<AuditReport>();
    await app.inject({ method: 'GET', url: `/api/audit/${first.auditId}/buyer-fit`, headers: ORIGIN });
    await app.inject({ method: 'GET', url: `/api/audit/${first.auditId}/ai`, headers: ORIGIN });
    const again = (await post(app, { url: 'https://acme.example/' })).json<AuditReport>();
    expect(again.auditId).toBe(first.auditId);
    expect(again.buyerFitStatus).toBe('fixture');
    expect(again.aiStatus).toBe('fixture');
    expect(again.buyerFit).toBeTruthy();
    expect(again.ai).toBeTruthy();
    // Different answers → different audit.
    const other = (await post(app, { url: 'acme.example', timeSink: 'chasing invoices' })).json<AuditReport>();
    expect(other.auditId).not.toBe(first.auditId);
  });

  it('dedupes concurrent identical requests into one audit', async () => {
    const c = controlledEngine();
    const { calls: _c, ...audit } = auditDeps(siteRoutes(), { ai: c.engine });
    app = await buildApp({ mxResolver: fakeMx, config: appConfig(), audit });
    const [a, b] = await Promise.all([post(app, { url: 'acme.example' }), post(app, { url: 'acme.example' })]);
    expect(a.json().auditId).toBe(b.json().auditId);
    expect(c.calls()).toBe(1);
  });

  it('405 for other methods', async () => {
    app = await buildApp(appDeps());
    const res = await app.inject({ method: 'GET', url: '/api/audit', headers: ORIGIN });
    expect(res.statusCode).toBe(405);
    expect((await app.inject({ method: 'POST', url: '/api/audit/abc/ai', headers: ORIGIN })).statusCode).toBe(405);
  });

  it('403 for a foreign or missing Origin; allows own host, PUBLIC_ORIGIN and ALLOWED_ORIGINS', async () => {
    app = await buildApp(appDeps());
    expect((await post(app, { url: 'acme.example' }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post(app, { url: 'acme.example' }, {})).json()).toMatchObject({ code: 'forbidden' });
    expect((await post(app, { url: 'acme.example' }, { origin: 'http://localhost:5173' })).statusCode).toBe(200);
    expect((await post(app, { url: 'acme.example' }, { origin: 'http://tool.internal:8787', host: 'tool.internal:8787' })).statusCode).toBe(200);
  });

  it('400 cases', async () => {
    app = await buildApp(appDeps());
    for (const payload of [{}, { url: '' }, { url: 42 }, { url: `a.example/${'x'.repeat(600)}` }, { url: 'a.example', teamSize: 'huge' }, { url: 'a.example', timeSink: 'x'.repeat(201) }]) {
      const res = await post(app, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().code).toBe('bad_request');
    }
    const badJson = await app.inject({ method: 'POST', url: '/api/audit', headers: { ...ORIGIN, 'content-type': 'application/json' }, payload: '{nope' });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().code).toBe('bad_request');
    const tooBig = await post(app, { url: 'a.example', pad: 'x'.repeat(9_000) });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().code).toBe('bad_request');
  });

  it('422 for an SSRF target and a missing site', async () => {
    app = await buildApp(appDeps());
    const res = await post(app, { url: 'http://127.0.0.1' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'site_not_found', error: "That address can't be audited." });
    const meta = await post(app, { url: 'http://169.254.169.254/latest' });
    expect(meta.json().code).toBe('site_not_found');
    const missing = await post(app, { url: 'nowhere.example' });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().code).toBe('site_unreadable');
  });

  it('429 on the 6th call from one IP (cache hits count), with Retry-After', async () => {
    app = await buildApp(appDeps());
    for (let i = 0; i < 5; i++) expect((await post(app, { url: 'acme.example' })).statusCode).toBe(200);
    const res = await post(app, { url: 'acme.example' });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'rate_limited' });
    expect(res.json().retryAfterSec).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBe(String(res.json().retryAfterSec));
    // A different client IP behind the trusted proxy has its own allowance.
    const other = await post(app, { url: 'acme.example' }, { ...ORIGIN, 'x-forwarded-for': '203.0.113.9' });
    expect(other.statusCode).toBe(200);
  });

  it('ignores X-Forwarded-For when TRUST_PROXY_HOPS=0', async () => {
    app = await buildApp({ ...appDeps(), config: appConfig({ trustProxyHops: 0, rateLimitHourly: 1 }) });
    expect((await post(app, { url: 'acme.example' }, { ...ORIGIN, 'x-forwarded-for': '203.0.113.1' })).statusCode).toBe(200);
    expect((await post(app, { url: 'acme.example' }, { ...ORIGIN, 'x-forwarded-for': '203.0.113.2' })).statusCode).toBe(429);
  });

  it('503 when every audit slot is busy', async () => {
    const routes = { ...siteRoutes(), ...siteRoutes('slow.example', { delayMs: 300 }) };
    const { calls: _c, ...audit } = auditDeps(routes);
    app = await buildApp({ mxResolver: fakeMx, config: appConfig({ maxConcurrentAudits: 1 }), audit });
    const slow = post(app, { url: 'slow.example' });
    await new Promise((r) => setTimeout(r, 50));
    const busy = await post(app, { url: 'acme.example' });
    expect(busy.statusCode).toBe(503);
    expect(busy.json().code).toBe('busy');
    expect((await slow).statusCode).toBe(200);
  });

  it('a 503 busy refusal does not use up the rate-limit slot', async () => {
    const routes = { ...siteRoutes(), ...siteRoutes('slow.example', { delayMs: 300 }) };
    const { calls: _c, ...audit } = auditDeps(routes);
    app = await buildApp({ mxResolver: fakeMx, config: appConfig({ maxConcurrentAudits: 1, rateLimitHourly: 2 }), audit });
    const slow = post(app, { url: 'slow.example' });
    await new Promise((r) => setTimeout(r, 50));
    expect((await post(app, { url: 'acme.example' })).statusCode).toBe(503);
    expect((await slow).statusCode).toBe(200);
    // slow = 1 hit, the 503 was refunded, so this is the 2nd of 2.
    expect((await post(app, { url: 'acme.example' })).statusCode).toBe(200);
    expect((await post(app, { url: 'other.example' })).statusCode).toBe(429);
  });

  it('IPv6 addresses in one /64 share a limit; mapped IPv4 counts as the IPv4 address', async () => {
    app = await buildApp({ ...appDeps(), config: appConfig({ trustProxyHops: 0, rateLimitHourly: 1 }) });
    const from = (remoteAddress: string) => app!.inject({ method: 'POST', url: '/api/audit', headers: ORIGIN, payload: withEmail({ url: 'acme.example' }) as object, remoteAddress });
    expect((await from('2001:db8:1:2::1')).statusCode).toBe(200);
    expect((await from('2001:db8:1:2:ffff:abcd:1234:9')).statusCode).toBe(429);
    expect((await from('2001:db8:1:3::1')).statusCode).toBe(200);
    expect((await from('::ffff:203.0.113.5')).statusCode).toBe(200);
    expect((await from('203.0.113.5')).statusCode).toBe(429);
  });

  it('TRUST_PROXY_HOPS=1: the limit is keyed on the real client, not a spoofed leading X-Forwarded-For entry', async () => {
    app = await buildApp({ ...appDeps(), config: appConfig({ trustProxyHops: 1, rateLimitHourly: 1 }) });
    const via = (xff: string) =>
      app!.inject({ method: 'POST', url: '/api/audit', headers: { ...ORIGIN, 'x-forwarded-for': xff }, payload: withEmail({ url: 'acme.example' }) as object, remoteAddress: '10.0.0.1' });
    expect((await via('1.1.1.1, 198.51.100.7')).statusCode).toBe(200);
    // Same real client (last entry, appended by the proxy), different spoofed first entry: still limited.
    expect((await via('9.9.9.9, 198.51.100.7')).statusCode).toBe(429);
    expect((await via('1.1.1.1, 198.51.100.8')).statusCode).toBe(200);
  });

  it('refuses a foreign Origin even when X-Forwarded-Host claims the same host', async () => {
    app = await buildApp(appDeps());
    const res = await post(app, { url: 'acme.example' }, { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden');
  });

  it('a failed AI run is not served from the cache: a re-POST runs afresh, the old id still resolves', async () => {
    let buyerFitCalls = 0;
    const engine = {
      mode: 'live' as const,
      buyerFit: async () => {
        buyerFitCalls++;
        if (buyerFitCalls === 1) throw new Error('blip');
        return sampleBuyerFit();
      },
      opportunities: async () => ({ status: 'ok' as const, ai: sampleAi() }),
    };
    const { calls: _c, ...audit } = auditDeps(siteRoutes(), { ai: engine });
    app = await buildApp({ mxResolver: fakeMx, config: appConfig({ aiMode: 'live' }), audit });
    const first = (await post(app, { url: 'acme.example' })).json<AuditReport>();
    const bf = await app.inject({ method: 'GET', url: `/api/audit/${first.auditId}/buyer-fit`, headers: ORIGIN });
    expect(bf.json().buyerFitStatus).toBe('unavailable');
    await new Promise((r) => setTimeout(r, 0));
    const second = (await post(app, { url: 'acme.example' })).json<AuditReport>();
    expect(second.auditId).not.toBe(first.auditId);
    expect(buyerFitCalls).toBe(2);
    // A successful run stays cached.
    await app.inject({ method: 'GET', url: `/api/audit/${second.auditId}/buyer-fit`, headers: ORIGIN });
    expect((await post(app, { url: 'acme.example' })).json<AuditReport>().auditId).toBe(second.auditId);
    // The first audit's id still resolves.
    expect((await app.inject({ method: 'GET', url: `/api/audit/${first.auditId}/ai`, headers: ORIGIN })).statusCode).toBe(200);
  });

  it('default AI slots (2 × MAX_CONCURRENT_AUDITS): audits at the limit all get AI', async () => {
    const hosts = ['a1.example', 'a2.example', 'a3.example', 'a4.example'];
    const c = controlledEngine(); // holds every slot until resolved
    const { calls: _c, ...audit } = auditDeps(Object.assign({}, ...hosts.map((h) => siteRoutes(h))), { ai: c.engine });
    app = await buildApp({ mxResolver: fakeMx, config: appConfig({ aiMode: 'live', maxConcurrentAudits: 4, rateLimitHourly: 50 }), audit });
    const reports = await Promise.all(hosts.map(async (h) => (await post(app!, { url: h })).json<AuditReport>()));
    for (const r of reports) expect([r.aiStatus, r.buyerFitStatus]).toEqual(['pending', 'pending']);
    expect(c.calls()).toBe(4);
  });

  it('AI slots full → AI skipped, no daily quota used, report not served from cache', async () => {
    let bfCalls = 0;
    let gate = deferred<void>();
    const engine = {
      mode: 'live' as const,
      buyerFit: async () => {
        bfCalls++;
        await gate.promise;
        return sampleBuyerFit();
      },
      opportunities: async () => {
        await gate.promise;
        return { status: 'ok' as const, ai: sampleAi() };
      },
    };
    const routes = Object.assign({}, siteRoutes('a1.example'), siteRoutes('a2.example'), siteRoutes('a3.example'));
    const { calls: _c, ...audit } = auditDeps(routes, { ai: engine });
    // One audit's worth of slots (2) and two AI audits a day.
    app = await buildApp({ mxResolver: fakeMx, config: appConfig({ aiMode: 'live', maxConcurrentAudits: 1, dailyAiAudits: 2, rateLimitHourly: 50 }), audit });

    const first = (await post(app, { url: 'a1.example' })).json<AuditReport>();
    expect(first.aiStatus).toBe('pending');
    // a1's analyses still hold both slots: a2 is refused AI.
    const refused = (await post(app, { url: 'a2.example' })).json<AuditReport>();
    expect([refused.aiStatus, refused.buyerFitStatus]).toEqual(['unavailable', 'unavailable']);
    expect(bfCalls).toBe(1);

    gate.resolve();
    await app.inject({ method: 'GET', url: `/api/audit/${first.auditId}/ai`, headers: ORIGIN });
    await app.inject({ method: 'GET', url: `/api/audit/${first.auditId}/buyer-fit`, headers: ORIGIN });
    gate = deferred<void>();

    // Retry runs fresh (not the cached refusal) and gets AI: the refusal took no quota.
    const retry = (await post(app, { url: 'a2.example' })).json<AuditReport>();
    expect(retry.auditId).not.toBe(refused.auditId);
    expect([retry.aiStatus, retry.buyerFitStatus]).toEqual(['pending', 'pending']);
    expect(bfCalls).toBe(2);
    gate.resolve();
    await app.inject({ method: 'GET', url: `/api/audit/${retry.auditId}/buyer-fit`, headers: ORIGIN });
    await app.inject({ method: 'GET', url: `/api/audit/${retry.auditId}/ai`, headers: ORIGIN });

    // Both daily units are now used (a1, a2 retry): a3 hits the cap.
    const capped = (await post(app, { url: 'a3.example' })).json<AuditReport>();
    expect(capped.aiStatus).toBe('unavailable');
    expect(bfCalls).toBe(2);
    // The refused audit's id still resolves.
    expect((await app.inject({ method: 'GET', url: `/api/audit/${refused.auditId}/ai`, headers: ORIGIN })).json()).toMatchObject({ aiStatus: 'unavailable' });
  });

  it('AI cap reached → unavailable statuses, measured report still returned', async () => {
    app = await buildApp({ ...appDeps(), config: appConfig({ dailyAiAudits: 0 }) });
    const r = (await post(app, { url: 'acme.example' })).json<AuditReport>();
    expect([r.aiStatus, r.buyerFitStatus]).toEqual(['unavailable', 'unavailable']);
    expect(r.security.score).not.toBeNull();
  });
});

describe('GET result endpoints', () => {
  it('404 not_found for unknown or malformed ids', async () => {
    app = await buildApp(appDeps());
    for (const path of ['ai', 'buyer-fit']) {
      for (const id of ['AAAAAAAAAAAAAAAAAAAAAA', 'x']) {
        const res = await app.inject({ method: 'GET', url: `/api/audit/${id}/${path}`, headers: ORIGIN });
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe('not_found');
      }
    }
  });

  it('same-origin GETs without an Origin header are allowed; cross-site ones are not', async () => {
    app = await buildApp(appDeps());
    const r = (await post(app, { url: 'acme.example' })).json<AuditReport>();
    const ok = await app.inject({ method: 'GET', url: `/api/audit/${r.auditId}/ai`, headers: { 'sec-fetch-site': 'same-origin' } });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: 'GET', url: `/api/audit/${r.auditId}/ai`, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(bad.statusCode).toBe(403);
  });

  it("'unavailable' after the 50 s and 80 s wait limits (fake timers)", async () => {
    const c = controlledEngine(); // never resolves
    const { calls: _c, ...audit } = auditDeps(siteRoutes(), { ai: c.engine });
    app = await buildApp({ mxResolver: fakeMx, config: appConfig({ aiMode: 'live' }), audit });
    const r = (await post(app, { url: 'acme.example' })).json<AuditReport>();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const settle = async (p: Promise<unknown>, stepMs: number, maxMs: number) => {
      let done = false;
      void p.then(() => (done = true));
      let elapsed = 0;
      while (!done && elapsed < maxMs) {
        await vi.advanceTimersByTimeAsync(stepMs);
        await new Promise((res) => setImmediate(res));
        elapsed += stepMs;
      }
      return elapsed;
    };

    const aiReq = app.inject({ method: 'GET', url: `/api/audit/${r.auditId}/ai`, headers: ORIGIN });
    const aiElapsed = await settle(aiReq, 1_000, 120_000);
    expect(aiElapsed).toBeGreaterThanOrEqual(50_000);
    expect(aiElapsed).toBeLessThan(53_000);
    expect((await aiReq).json()).toEqual({ auditId: r.auditId, aiStatus: 'unavailable' });

    const bfReq = app.inject({ method: 'GET', url: `/api/audit/${r.auditId}/buyer-fit`, headers: ORIGIN });
    const bfElapsed = await settle(bfReq, 1_000, 120_000);
    expect(bfElapsed).toBeGreaterThanOrEqual(80_000);
    expect(bfElapsed).toBeLessThan(83_000);
    expect((await bfReq).json()).toEqual({ auditId: r.auditId, buyerFitStatus: 'unavailable', fixFirst: r.fixFirst });
  });

  it('result endpoints are limited to 30 per IP per hour, separately from audits', async () => {
    app = await buildApp(appDeps());
    const r = (await post(app, { url: 'acme.example' })).json<AuditReport>();
    for (let i = 0; i < 30; i++) {
      expect((await app.inject({ method: 'GET', url: `/api/audit/${r.auditId}/ai`, headers: ORIGIN })).statusCode).toBe(200);
    }
    const res = await app.inject({ method: 'GET', url: `/api/audit/${r.auditId}/buyer-fit`, headers: ORIGIN });
    expect(res.statusCode).toBe(429);
    expect((await post(app, { url: 'acme.example' })).statusCode).toBe(200);
  });
});

describe('lead fields', () => {
  it('/api/lead is gone (404)', async () => {
    app = await buildApp(appDeps());
    const res = await app.inject({ method: 'POST', url: '/api/lead', headers: ORIGIN, payload: { email: 'a@b.example', consent: true, domain: 'acme.example' } });
    expect(res.statusCode).toBe(404);
  });

  it('sanitises the optional name: no angle brackets, pipes or control characters', () => {
    expect(sanitiseLeadName('Jo <!channel> <https://evil.example|click>\u0007 Smith')).toBe('Jo !channel https://evil.exampleclick Smith');
    const v = validateLeadFields({ email: 'jo@acme.example', name: '  <@U123>|Jo\nBloggs ' });
    expect(v).toMatchObject({ ok: true, value: { name: '@U123Jo Bloggs' } });
    expect(validateLeadFields({ email: 'jo@acme.example', name: '<>|' })).toEqual({ ok: true, value: { email: 'jo@acme.example' } });
    expect(validateLeadFields({ email: 'jo@acme.example', name: 'x'.repeat(101) })).toMatchObject({ ok: false, code: 'bad_request', error: 'name is too long.' });
    expect(validateLeadFields({ email: 'jo@acme.example', name: 42 })).toEqual({ ok: false, code: 'bad_request', error: 'name must be text.' });
    expect(validateLeadFields({ email: 'jo@acme.example', name: ['Jo'] })).toEqual({ ok: false, code: 'bad_request', error: 'name must be text.' });
    expect(validateLeadFields({ email: 'jo@acme.example', marketingOptIn: 'yes' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(validateLeadFields({ email: 'jo@acme.example', marketingOptIn: true })).toEqual({ ok: true, value: { email: 'jo@acme.example', marketingOptIn: true } });
    expect(validateLeadFields({ url: 'a.example' })).toMatchObject({ ok: false, code: 'email_invalid' });
  });
});

describe('health, static files and headers', () => {
  const clientDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-client-'));
    writeFileSync(join(dir, 'index.html'), '<html><head><!--TYPEKIT--></head><body></body></html>');
    writeFileSync(join(dir, 'embed.js'), 'console.log(1)');
    return dir;
  };

  it('GET /healthz', async () => {
    app = await buildApp(appDeps());
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ ok: true, aiMode: 'fixture', version: '0.0.0-test', ledger: 'memory', crm: false });
  });

  it('serves index.html with CSP frame-ancestors, no X-Frame-Options, and security headers', async () => {
    app = await buildApp(appDeps({ clientDir: clientDir() }));
    const res = await app.inject({ method: 'GET', url: '/?embed=1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).not.toContain('<!--TYPEKIT-->');
    expect(res.body).not.toContain('typekit');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("frame-ancestors 'self' https://offshorly.com https://www.offshorly.com");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=/);
    const js = await app.inject({ method: 'GET', url: '/embed.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-security-policy']).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: '/index.html' })).statusCode).toBe(404);
  });

  it('injects Typekit and allows its hosts in the CSP when configured', async () => {
    app = await buildApp({ ...appDeps({ clientDir: clientDir() }), config: appConfig({ typekitKitUrl: 'https://use.typekit.net/abc1234.css' }) });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).toContain('<link rel="stylesheet" href="https://use.typekit.net/abc1234.css">');
    expect(String(res.headers['content-security-policy'])).toContain('style-src \'self\' https://use.typekit.net');
  });
});
