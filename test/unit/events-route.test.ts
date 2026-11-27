// Spec 001: POST /api/event. app.inject, in-memory metrics, no network.
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditStartResponse } from '../../shared/types.js';
import { buildApp, EVENT_LIMIT_HOURLY } from '../../server/app.js';
import { MemoryMetricsStore } from '../../server/metrics/store.js';
import { appConfig, appDeps, ORIGIN, siteRoutes } from './_appMock.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

let n = 0;
const build = (metrics: MemoryMetricsStore) =>
  buildApp({ ...appDeps({}, siteRoutes('acme.example')), metrics, config: appConfig({ rateLimitHourly: 100, rateLimitDaily: 1000 }) });

const session = async (a: FastifyInstance, email = `visitor${++n}@mail.example`): Promise<string> => {
  const res = await a.inject({ method: 'POST', url: '/api/audit', headers: ORIGIN, payload: { url: 'acme.example', email } });
  expect(res.statusCode).toBe(200);
  return res.json<AuditStartResponse>().session;
};

const post = (a: FastifyInstance, payload: unknown, headers: Record<string, string> = ORIGIN) =>
  a.inject({ method: 'POST', url: '/api/event', headers, payload: payload as Record<string, unknown> });

const today = (m: MemoryMetricsStore): Record<string, number> => [...m.range('2000-01-01', '2100-01-01').values()][0] ?? {};

describe('POST /api/event', () => {
  it('counts a direct booking click by placement and a report view once per session', async () => {
    const m = new MemoryMetricsStore();
    app = await build(m);
    const s = await session(app);
    for (const placement of ['ai', 'ai-top', 'pitch', 'website']) {
      expect((await post(app, { event: 'cta_click', placement, session: s })).statusCode).toBe(204);
    }
    expect((await post(app, { event: 'report_view', session: s })).statusCode).toBe(204);
    expect((await post(app, { event: 'report_view', session: s })).statusCode).toBe(204);
    const d = today(m);
    expect(d['click.direct.ai']).toBe(1);
    expect(d['click.direct.ai-top']).toBe(1);
    expect(d['click.direct.pitch']).toBe(1);
    expect(d['click.direct.website']).toBe(1);
    expect(d.report_view).toBe(1);
  });

  it('counts shared-page clicks without a session, and the blocked alert click', async () => {
    const m = new MemoryMetricsStore();
    app = await build(m);
    expect((await post(app, { event: 'cta_click', placement: 'audit-link', shared: true })).statusCode).toBe(204);
    expect((await post(app, { event: 'cta_click', placement: 'ai-top', shared: true })).statusCode).toBe(204);
    expect((await post(app, { event: 'cta_click', placement: 'blocked' })).statusCode).toBe(204);
    const d = today(m);
    expect(d['click.shared.audit-link']).toBe(1);
    expect(d['click.shared.ai-top']).toBe(1);
    expect(d['click.direct.blocked']).toBe(1);
  });

  it('staff (allow-listed) sessions are accepted but not counted', async () => {
    const m = new MemoryMetricsStore();
    app = await build(m);
    const s = await session(app, 'someone@offshorly.com');
    expect((await post(app, { event: 'cta_click', placement: 'ai', session: s })).statusCode).toBe(204);
    expect((await post(app, { event: 'report_view', session: s })).statusCode).toBe(204);
    expect(m.range('2000-01-01', '2100-01-01').size).toBe(0);
  });

  it('400 for unknown events and placements, and for the wrong shape for each mode', async () => {
    const m = new MemoryMetricsStore();
    app = await build(m);
    const s = await session(app);
    const cases: unknown[] = [
      {},
      { event: 'purchase', placement: 'ai', session: s },
      { event: 'cta_click', placement: 'nope', session: s },
      { event: 'cta_click', placement: 'audit-link', session: s }, // audit-link is shared only
      { event: 'cta_click', placement: 'blocked', session: s },
      { event: 'cta_click', session: s }, // no placement
      { event: 'report_view', placement: 'ai', session: s }, // report_view takes no placement
      { event: 'report_view', shared: true }, // views are direct only
      { event: 'cta_click', placement: 'ai', session: s, shared: true }, // both modes
      { event: 'cta_click', placement: 'ai' }, // neither: only "blocked" is allowed
      { event: 'cta_click', placement: 'audit-link' },
      { event: 'cta_click', placement: 'ai', shared: false },
      { event: 'cta_click', placement: 'ai', session: 42 },
    ];
    for (const payload of cases) expect((await post(app, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    // Only the audit that made the session is counted; no event from a rejected body.
    expect(Object.keys(today(m)).filter((k) => k.startsWith('click.') || k === 'report_view')).toEqual([]);
  });

  it('410 for an unknown or expired session', async () => {
    app = await build(new MemoryMetricsStore());
    const res = await post(app, { event: 'cta_click', placement: 'ai', session: 'AAAAAAAAAAAAAAAAAAAAAA' });
    expect(res.statusCode).toBe(410);
    expect(res.json<{ code: string }>().code).toBe('session_expired');
  });

  it('403 for a foreign origin, 405 for other methods', async () => {
    app = await build(new MemoryMetricsStore());
    expect((await post(app, { event: 'cta_click', placement: 'blocked' }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    const get = await app.inject({ method: 'GET', url: '/api/event', headers: ORIGIN });
    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe('POST');
  });

  it('429 past the per-IP limit', async () => {
    const m = new MemoryMetricsStore();
    app = await build(m);
    let last = 204;
    for (let i = 0; i < EVENT_LIMIT_HOURLY + 1; i++) last = (await post(app, { event: 'cta_click', placement: 'blocked' })).statusCode;
    expect(last).toBe(429);
    expect(today(m)['click.direct.blocked']).toBe(EVENT_LIMIT_HOURLY);
  });

  it('a metrics failure still answers 204, and nothing identifying is logged or stored', async () => {
    const m = new MemoryMetricsStore();
    m.inc = () => {
      throw new Error('disk gone');
    };
    app = await build(m);
    expect((await post(app, { event: 'cta_click', placement: 'blocked' })).statusCode).toBe(204);
  });

  it('stores only integer totals: no key outside the fixed list', async () => {
    const m = new MemoryMetricsStore();
    app = await build(m);
    const email = `visitor${++n}@mail.example`;
    const s = await session(app, email);
    await post(app, { event: 'cta_click', placement: 'ai', session: s });
    await post(app, { event: 'report_view', session: s });
    const dump = JSON.stringify([...m.range('2000-01-01', '2100-01-01')]);
    expect(dump).not.toContain(s);
    expect(dump).not.toContain(email);
    expect(dump).not.toContain('acme.example');
  });
});
