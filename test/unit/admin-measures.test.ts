// Spec 001: GET /api/admin/measures.csv and the counters behind it. app.inject, no network.
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditStartResponse } from '../../shared/types.js';
import { buildApp } from '../../server/app.js';
import type { FeedbackLine } from '../../server/feedback/store.js';
import { MemoryFeedbackStore } from '../../server/feedback/store.js';
import { MEASURES_COLUMNS, MEASURES_NOTE, measuresCsv } from '../../server/metrics/measures.js';
import { MemoryMetricsStore } from '../../server/metrics/store.js';
import { MemoryReportStore } from '../../server/share/store.js';
import { appConfig, appDeps, ORIGIN, siteRoutes } from './_appMock.js';

const TOKEN = 'T'.repeat(40);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const NOW = Date.parse('2026-11-24T12:00:00Z');

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const parse = (csv: string) => {
  const lines = csv.trim().split('\r\n');
  const head = lines[0]!.split(',');
  return {
    head,
    rows: lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], v]))) as Record<string, string>[],
  };
};

const vote = (t: string, s: string, vote: 'up' | 'down' | 'clear', i = 0): FeedbackLine => ({
  v: 1, t, a: 'aud', s, i, vote, src: 'site', svc: 'ai-automation', pat: null, ind: null, dom: 'x.example', title: 'T', ex: 0,
});

describe('measuresCsv', () => {
  const metrics = new MemoryMetricsStore({ now: () => Date.parse('2026-11-23T10:00:00Z') });
  metrics.inc('audit_run', 4);
  metrics.inc('report_view', 4);
  metrics.inc('click.direct.ai', 1);
  metrics.inc('click.direct.ai-top', 1);
  metrics.inc('click.shared.audit-link', 2);
  metrics.inc('ai_attempted', 4);
  metrics.inc('ai_finished', 3);
  metrics.addCost(0.4);
  metrics.addCost(0.2);
  const later = new MemoryMetricsStore({ now: () => Date.parse('2026-11-24T10:00:00Z') });
  later.inc('audit_run', 6);
  later.inc('report_view', 6);
  later.inc('click.direct.website', 3);
  later.inc('ai_attempted', 6);
  later.inc('ai_finished', 6);
  const days = new Map([...metrics.range('2026-11-01', '2026-11-30'), ...later.range('2026-11-01', '2026-11-30')]);
  const feedback = [
    vote('2026-11-23T09:00:00Z', 'aaaaaaaaaaaa', 'up'),
    vote('2026-11-23T09:01:00Z', 'bbbbbbbbbbbb', 'down'),
    vote('2026-11-24T09:00:00Z', 'aaaaaaaaaaaa', 'up', 1),
    vote('2026-11-24T09:05:00Z', 'aaaaaaaaaaaa', 'clear', 1), // cleared: not counted
  ];
  const csv = measuresCsv(days, feedback, '2026-11-22', '2026-11-24');
  const { head, rows } = parse(csv);

  it('has the documented columns, one row per day in range (zero days included), TOTAL, then the NOTE row', () => {
    expect(head).toEqual([...MEASURES_COLUMNS]);
    expect(rows.map((r) => r.date)).toEqual(['2026-11-22', '2026-11-23', '2026-11-24', 'TOTAL', 'NOTE']);
    expect(rows[0]!.audits_run).toBe('0');
    expect(rows[4]!.audits_run).toBe(MEASURES_NOTE);
  });

  it('day rates: click rate, AI-finished share, average cost, thumbs', () => {
    const d = rows[1]!;
    expect(d.click_rate_direct).toBe('0.5');
    expect(d.ai_finished_share).toBe('0.75');
    expect(d.avg_cost_usd).toBe('0.3');
    expect(d.thumbs_up).toBe('1');
    expect(d.thumbs_down).toBe('1');
    expect(d.thumbs_up_rate).toBe('0.5');
  });

  it('a rate with no denominator is blank (empty day, no votes)', () => {
    expect(rows[0]!.click_rate_direct).toBe('');
    expect(rows[0]!.thumbs_up_rate).toBe('');
    expect(rows[2]!.thumbs_up_rate).toBe(''); // the only vote that day was cleared
  });

  it('TOTAL uses summed numerators and denominators, not an average of daily rates', () => {
    const t = rows[3]!;
    expect(t.audits_run).toBe('10');
    expect(t.reports_viewed).toBe('10');
    expect(t.clicks_direct_ai_top).toBe('1');
    expect(t.clicks_shared_audit_link).toBe('2');
    expect(t.click_rate_direct).toBe('0.5'); // (1+1+3)/10, not (0.5+0.5)/2
    expect(t.ai_finished_share).toBe('0.9'); // 9/10
    expect(t.avg_cost_usd).toBe('0.3');
  });
});

describe('GET /api/admin/measures.csv', () => {
  const build = (over: Parameters<typeof buildApp>[0] extends infer D ? Partial<D> : never = {}, token: string | null = TOKEN) =>
    buildApp({
      ...appDeps({}, siteRoutes('acme.example')),
      config: appConfig({ adminToken: token, rateLimitHourly: 100, rateLimitDaily: 1000 }),
      now: () => NOW,
      ...over,
    });

  it('404 without an ADMIN_TOKEN, 401 without or with a wrong token', async () => {
    app = await build({}, null);
    expect((await app.inject({ method: 'GET', url: '/api/admin/measures.csv' })).statusCode).toBe(404);
    await app.close();
    app = await build();
    expect((await app.inject({ method: 'GET', url: '/api/admin/measures.csv' })).statusCode).toBe(401);
    const wrong = await app.inject({ method: 'GET', url: '/api/admin/measures.csv', headers: { authorization: `Bearer ${'x'.repeat(40)}` } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).not.toContain('audits_run');
  });

  it('defaults to the last 30 UTC days and sends a CSV attachment', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/admin/measures.csv', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('measures.csv');
    const { rows } = parse(res.body);
    expect(rows).toHaveLength(30 + 2);
    expect(rows[0]!.date).toBe('2026-10-26');
    expect(rows[29]!.date).toBe('2026-11-24');
  });

  it('400 for a bad date, from after to, and a range over 366 days', async () => {
    app = await build();
    for (const q of ['from=2026-13-01', 'from=nope', 'from=2026-11-24&to=2026-11-01', 'from=2025-01-01&to=2026-11-24', 'from=0000-01-01&to=9999-12-31']) {
      const res = await app.inject({ method: 'GET', url: `/api/admin/measures.csv?${q}`, headers: AUTH });
      expect(res.statusCode, q).toBe(400);
    }
  });

  it('accepts a 366-day range and rejects a 367-day one', async () => {
    app = await build();
    const ok = await app.inject({ method: 'GET', url: '/api/admin/measures.csv?from=2025-01-01&to=2026-01-01', headers: AUTH });
    expect(ok.statusCode).toBe(200);
    const over = await app.inject({ method: 'GET', url: '/api/admin/measures.csv?from=2025-01-01&to=2026-01-02', headers: AUTH });
    expect(over.statusCode).toBe(400);
  });
});

describe('counting through the routes', () => {
  const build = (metrics: MemoryMetricsStore, over = {}) =>
    buildApp({
      ...appDeps({}, siteRoutes('acme.example')),
      metrics,
      config: appConfig({ rateLimitHourly: 100, rateLimitDaily: 1000 }),
      ...over,
    });
  const run = (a: FastifyInstance, email: string) =>
    a.inject({ method: 'POST', url: '/api/audit', headers: ORIGIN, payload: { url: 'acme.example', email } });
  const total = (m: MemoryMetricsStore, name: string): number =>
    [...m.range('2000-01-01', '2100-01-01').values()].reduce((s, d) => s + (d[name] ?? 0), 0);
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it('counts audit_run for a visitor, not for staff; AI outcome only on a fresh run (not a cache hit)', async () => {
    const m = new MemoryMetricsStore();
    app = await build(m);
    expect((await run(app, 'a@mail.example')).statusCode).toBe(200);
    expect((await run(app, 'b@mail.example')).statusCode).toBe(200); // same site and answers: cache hit
    expect((await run(app, 'someone@offshorly.com')).statusCode).toBe(200); // staff
    await settle();
    expect(total(m, 'audit_run')).toBe(2);
    expect(total(m, 'ai_attempted')).toBe(1);
    expect(total(m, 'ai_finished')).toBe(1);
  });

  it('counts a shared_view on a 200 from GET /api/share/:id, not on a 404', async () => {
    const m = new MemoryMetricsStore();
    const reports = new MemoryReportStore({ retentionDays: 30, maxFiles: 100 });
    app = await build(m, { reports });
    const body = (await run(app, 'c@mail.example')).json<AuditStartResponse>();
    await app.inject({ method: 'GET', url: `/api/audit/${body.auditId}/ai`, headers: ORIGIN });
    await app.inject({ method: 'GET', url: `/api/audit/${body.auditId}/buyer-fit`, headers: ORIGIN });
    const share = await app.inject({ method: 'POST', url: '/api/share', headers: ORIGIN, payload: { session: body.session } });
    const id = share.json<{ shareId: string }>().shareId;
    expect((await app.inject({ method: 'GET', url: `/api/share/${id}`, headers: ORIGIN })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/share/${'z'.repeat(22)}`, headers: ORIGIN })).statusCode).toBe(404);
    expect(total(m, 'shared_view')).toBe(1);
  });

  it('a failing metrics store never affects the audit response', async () => {
    const m = new MemoryMetricsStore();
    m.inc = () => {
      throw new Error('disk gone');
    };
    app = await build(m);
    expect((await run(app, 'd@mail.example')).statusCode).toBe(200);
  });
});
