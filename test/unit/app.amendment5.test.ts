// app.inject tests for Amendment 5 Phases 1–3: /print, sessions, idea feedback, admin CSV and
// share links. Network, DNS and AI are mocked.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditStartResponse, ShareCreated, SharedReport } from '../../shared/types.js';
import { buildApp, logPath, sharedPageHtml } from '../../server/app.js';
import type { AppDeps } from '../../server/app.js';
import { runAudit } from '../../server/audit/runAudit.js';
import { MemoryFeedbackStore } from '../../server/feedback/store.js';
import { emailKey } from '../../server/lead/email.js';
import { SESSION_RE } from '../../server/http/sessions.js';
import { bearerMatches } from '../../server/routes/admin.js';
import { MemoryReportStore } from '../../server/share/store.js';
import type { ReportStore } from '../../server/share/store.js';
import { appConfig, appDeps, auditDeps, controlledEngine, fakeMx, ORIGIN, siteRoutes } from './_appMock.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const TOKEN = 'admin-token-0123456789abcdefghijklmnop';
const SECRET = appConfig().emailHashSecret;

let emailN = 0;
const nextEmail = () => `visitor${++emailN}@mail.example`;

const routes = () => ({ ...siteRoutes('acme.example'), ...siteRoutes('other.example') });

const logSink = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { logger: { level: 'debug', stream } as never, text: () => lines.join('') };
};

const build = (over: Partial<AppDeps> = {}, cfg: Parameters<typeof appConfig>[0] = {}) =>
  buildApp({ ...appDeps({}, routes()), ...over, config: appConfig({ rateLimitHourly: 100, rateLimitDaily: 1000, ...cfg }) });

const start = async (a: FastifyInstance, payload: Record<string, unknown> = {}, email = nextEmail()) => {
  const res = await a.inject({ method: 'POST', url: '/api/audit', headers: ORIGIN, payload: { url: 'acme.example', email, ...payload } });
  expect(res.statusCode).toBe(200);
  return res.json<AuditStartResponse>();
};

/** Waits for the fixture AI and buyer fit to settle. */
const settle = async (a: FastifyInstance, auditId: string) => {
  await a.inject({ method: 'GET', url: `/api/audit/${auditId}/ai`, headers: ORIGIN });
  await a.inject({ method: 'GET', url: `/api/audit/${auditId}/buyer-fit`, headers: ORIGIN });
};

const ideaCount = async (a: FastifyInstance, auditId: string): Promise<number> =>
  (await a.inject({ method: 'GET', url: `/api/audit/${auditId}/ai`, headers: ORIGIN })).json<{ ai: { opportunities: unknown[] } }>().ai.opportunities.length;

const vote = (a: FastifyInstance, payload: unknown, headers: Record<string, string> = ORIGIN) =>
  a.inject({ method: 'POST', url: '/api/feedback', headers, payload: payload as object });

const share = (a: FastifyInstance, session: string, method: 'POST' | 'DELETE' = 'POST') =>
  a.inject({ method, url: '/api/share', headers: ORIGIN, payload: { session } });

const clientDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'oa-client-'));
  writeFileSync(join(dir, 'index.html'), '<html><head><meta name="robots" content="noindex" /><!--TYPEKIT--></head><body></body></html>');
  return dir;
};

describe('Phase 1: /print', () => {
  it('serves index.html with X-Robots-Tag: noindex', async () => {
    app = await build({ clientDir: clientDir() });
    const res = await app.inject({ method: 'GET', url: '/print' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['content-security-policy']).toBeTruthy();
  });
});

describe('Phase 2: session on POST /api/audit', () => {
  it('each 200 carries its own session and the features; the cached report never holds them', async () => {
    const captured: object[] = [];
    const run: typeof runAudit = async (req, deps) => {
      const r = await runAudit(req, deps);
      captured.push(r.report);
      return r;
    };
    app = await build({ runAudit: run });
    const a = await start(app);
    expect(a.session).toMatch(SESSION_RE);
    expect(a.features).toEqual({ share: true, email: false, feedback: true, shareRetentionDays: 30 });
    const b = await start(app);
    expect(b.auditId).toBe(a.auditId); // cache hit
    expect(b.session).toMatch(SESSION_RE);
    expect(b.session).not.toBe(a.session);
    expect(captured).toHaveLength(1);
    expect('session' in captured[0]!).toBe(false);
    expect('features' in captured[0]!).toBe(false);
  });

  it('the session token never appears in the logs', async () => {
    const sink = logSink();
    app = await build({ logger: sink.logger });
    const r = await start(app);
    await settle(app, r.auditId);
    await vote(app, { session: r.session, ideaIndex: 0, vote: 'up' });
    await share(app, r.session);
    expect(sink.text()).not.toContain(r.session);
  });
});

describe('Phase 2: POST /api/feedback', () => {
  it('204 and one line with ids, idea fields and the vote; no email, email hash or "@"', async () => {
    const feedback = new MemoryFeedbackStore();
    const sink = logSink();
    app = await build({ feedback, logger: sink.logger });
    const email = 'Secret.Person@acme.example';
    const r = await start(app, {}, email);
    await settle(app, r.auditId);
    const res = await vote(app, { session: r.session, ideaIndex: 0, vote: 'up' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    const lines = feedback.list();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ v: 1, a: r.auditId, i: 0, vote: 'up', dom: 'acme.example', ex: 0 });
    expect(lines[0]!.s).toMatch(/^[0-9a-f]{12}$/);
    const text = JSON.stringify(lines);
    const key = emailKey(SECRET, email);
    expect(text).not.toContain('@');
    expect(text).not.toContain(key);
    expect(text).not.toContain(key.slice(0, 12));
    expect(sink.text()).toContain('idea_feedback');

    expect((await vote(app, { session: r.session, ideaIndex: 0, vote: null })).statusCode).toBe(204);
    // Memory keeps only the last vote per (session, idea).
    expect(feedback.list()).toHaveLength(1);
    expect(feedback.list()[0]?.vote).toBe('clear');
  });

  it('two sessions on one cached audit are recorded separately', async () => {
    const feedback = new MemoryFeedbackStore();
    app = await build({ feedback });
    const a = await start(app);
    await settle(app, a.auditId);
    const b = await start(app);
    expect(b.auditId).toBe(a.auditId);
    await vote(app, { session: a.session, ideaIndex: 0, vote: 'up' });
    await vote(app, { session: b.session, ideaIndex: 0, vote: 'down' });
    const [la, lb] = feedback.list();
    expect(la?.a).toBe(lb?.a);
    expect(la?.s).not.toBe(lb?.s);
  });

  it('410 for an unknown session, 400 for a bad index or vote, 403 for a foreign origin', async () => {
    app = await build();
    const r = await start(app);
    await settle(app, r.auditId);
    const gone = await vote(app, { session: 'A'.repeat(22), ideaIndex: 0, vote: 'up' });
    expect(gone.statusCode).toBe(410);
    expect(gone.json().code).toBe('session_expired');
    expect((await vote(app, { session: 'nope', ideaIndex: 0, vote: 'up' })).statusCode).toBe(410);
    for (const bad of [
      { session: r.session, ideaIndex: 99, vote: 'up' },
      { session: r.session, ideaIndex: -1, vote: 'up' },
      { session: r.session, ideaIndex: 0.5, vote: 'up' },
      { session: r.session, ideaIndex: '0', vote: 'up' },
      { session: r.session, ideaIndex: 0, vote: 'maybe' },
      { session: r.session, ideaIndex: 0 },
      { ideaIndex: 0, vote: 'up' },
    ]) {
      const res = await vote(app, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().code).toBe('bad_request');
    }
    expect((await vote(app, { session: r.session, ideaIndex: 0, vote: 'up' }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/feedback', headers: ORIGIN })).statusCode).toBe(405);
  });

  it('409 not_ready while the AI ideas are pending', async () => {
    const c = controlledEngine();
    const { calls: _c, ...audit } = auditDeps(routes(), { ai: c.engine });
    app = await buildApp({ mxResolver: fakeMx, config: appConfig({ aiMode: 'live' }), audit });
    const r = await start(app);
    const res = await vote(app, { session: r.session, ideaIndex: 0, vote: 'up' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('not_ready');
  });

  it('429 after 60 votes per IP per hour', async () => {
    app = await build();
    const first = await start(app);
    await settle(app, first.auditId);
    const n = await ideaCount(app, first.auditId);
    // Spread over enough sessions that the per-session cap (3 × ideas) never bites first.
    const sessions = [first.session];
    while (sessions.length * 3 * n < 61) sessions.push((await start(app)).session);
    for (let i = 0; i < 60; i++) {
      expect((await vote(app, { session: sessions[i % sessions.length], ideaIndex: 0, vote: i % 2 ? 'up' : 'down' })).statusCode).toBe(204);
    }
    const res = await vote(app, { session: sessions[0], ideaIndex: 0, vote: 'up' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeTruthy();
  });

  it('a session may write 3 × (number of ideas) lines; then 429 rate_limited and nothing is written', async () => {
    const feedback = new MemoryFeedbackStore();
    let writes = 0;
    const append = feedback.append.bind(feedback);
    feedback.append = async (l) => {
      writes++;
      return append(l);
    };
    app = await build({ feedback });
    const r = await start(app);
    await settle(app, r.auditId);
    const n = await ideaCount(app, r.auditId);
    for (let i = 0; i < 3 * n; i++) {
      expect((await vote(app, { session: r.session, ideaIndex: i % n, vote: i % 2 ? 'up' : null })).statusCode).toBe(204);
    }
    const res = await vote(app, { session: r.session, ideaIndex: 0, vote: 'down' });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('rate_limited');
    expect(writes).toBe(3 * n);
    expect(feedback.list().some((l) => l.vote === 'down')).toBe(false);
    // Another visitor on the same cached audit is unaffected.
    const other = await start(app);
    expect(other.auditId).toBe(r.auditId);
    expect((await vote(app, { session: other.session, ideaIndex: 0, vote: 'down' })).statusCode).toBe(204);
  });

  it('a failing store still answers 204', async () => {
    const feedback = new MemoryFeedbackStore();
    feedback.append = async () => {
      throw new Error('disk gone');
    };
    app = await build({ feedback });
    const r = await start(app);
    await settle(app, r.auditId);
    expect((await vote(app, { session: r.session, ideaIndex: 0, vote: 'up' })).statusCode).toBe(204);
  });
});

describe('Phase 2: admin CSV', () => {
  const csv = (a: FastifyInstance, auth?: string) =>
    a.inject({ method: 'GET', url: '/api/admin/feedback.csv', headers: auth === undefined ? {} : { authorization: auth } });

  it('404 when ADMIN_TOKEN is unset', async () => {
    app = await build();
    expect((await csv(app, `Bearer ${TOKEN}`)).statusCode).toBe(404);
  });

  it('401 for a missing or wrong token; the auth header is never logged', async () => {
    const sink = logSink();
    app = await build({ logger: sink.logger }, { adminToken: TOKEN });
    expect((await csv(app)).statusCode).toBe(401);
    expect((await csv(app, `Bearer ${TOKEN}x`)).statusCode).toBe(401);
    expect((await csv(app, TOKEN)).statusCode).toBe(401);
    expect((await csv(app, `Bearer ${TOKEN}`)).statusCode).toBe(200);
    expect(sink.text()).not.toContain(TOKEN);
  });

  it('CSV: last vote per (session, idea) wins; text/csv attachment, no-store', async () => {
    app = await build({}, { adminToken: TOKEN });
    const a = await start(app);
    await settle(app, a.auditId);
    const b = await start(app);
    await vote(app, { session: a.session, ideaIndex: 0, vote: 'up' });
    await vote(app, { session: a.session, ideaIndex: 0, vote: 'down' });
    await vote(app, { session: b.session, ideaIndex: 0, vote: 'up' });
    await vote(app, { session: b.session, ideaIndex: 0, vote: null });
    const res = await csv(app, `Bearer ${TOKEN}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toContain('feedback.csv');
    expect(res.headers['cache-control']).toBe('no-store');
    const rows = res.body.trim().split('\r\n');
    expect(rows[0]).toBe('date,domain,industry,source,service,pattern,title,vote,sourcesCited');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(',down,0');
    expect(res.body).not.toContain('@');
  });

  it('429 after 10 admin requests per IP per hour, counted before the token check', async () => {
    app = await build({}, { adminToken: TOKEN });
    for (let i = 0; i < 10; i++) await csv(app, 'Bearer wrong');
    expect((await csv(app, `Bearer ${TOKEN}`)).statusCode).toBe(429);
  });

  it('bearerMatches compares digests and rejects malformed headers', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer  ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches(['x'], TOKEN)).toBe(false);
  });
});

describe('Phase 3: share links', () => {
  it('201 then the same id (idempotent per session); GET returns the snapshot without auditId', async () => {
    app = await build();
    const r = await start(app, { timeSink: 'chasing invoices' });
    await settle(app, r.auditId);
    const first = await share(app, r.session);
    expect(first.statusCode).toBe(201);
    const created = first.json<ShareCreated>();
    expect(created.shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.url).toBe(`https://audit.example/r/${created.shareId}`);
    const again = (await share(app, r.session)).json<ShareCreated>();
    expect(again).toEqual(created);

    const got = await app.inject({ method: 'GET', url: `/api/share/${created.shareId}`, headers: ORIGIN });
    expect(got.statusCode).toBe(200);
    expect(got.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    const snap = got.json<SharedReport>();
    expect('auditId' in snap.report).toBe(false);
    expect(got.body).not.toContain(r.auditId);
    expect(got.body).not.toContain('@');
    expect(snap.answers).toEqual({ timeSink: 'chasing invoices' });
    expect(snap.report.aiStatus).toBe('fixture');
  });

  it('url falls back to the request host when PUBLIC_ORIGIN is unset', async () => {
    app = await build({}, { publicOrigin: null });
    const local = { origin: 'http://localhost:5173' };
    const r = (await app.inject({ method: 'POST', url: '/api/audit', headers: local, payload: { url: 'acme.example', email: nextEmail() } })).json<AuditStartResponse>();
    await app.inject({ method: 'GET', url: `/api/audit/${r.auditId}/ai`, headers: local });
    const res = await app.inject({ method: 'POST', url: '/api/share', headers: { origin: 'http://localhost:5173', host: 'tool.example' }, payload: { session: r.session } });
    expect(res.json<ShareCreated>().url).toMatch(/^http:\/\/tool\.example\/r\//);
  });

  it('DELETE then GET → 404; a new POST makes a new id', async () => {
    app = await build();
    const r = await start(app);
    await settle(app, r.auditId);
    const { shareId } = (await share(app, r.session)).json<ShareCreated>();
    expect((await share(app, r.session, 'DELETE')).statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url: `/api/share/${shareId}`, headers: ORIGIN });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().code).toBe('not_found');
    const next = (await share(app, r.session)).json<ShareCreated>();
    expect(next.shareId).not.toBe(shareId);
  });

  it('two sessions on one cached audit get separate shareIds; deleting one leaves the other readable', async () => {
    app = await build();
    const a = await start(app);
    await settle(app, a.auditId);
    const b = await start(app);
    expect(b.auditId).toBe(a.auditId);
    const sa = (await share(app, a.session)).json<ShareCreated>();
    const sb = (await share(app, b.session)).json<ShareCreated>();
    expect(sa.shareId).not.toBe(sb.shareId);
    expect((await share(app, a.session, 'DELETE')).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/share/${sa.shareId}`, headers: ORIGIN })).statusCode).toBe(404);
    const still = await app.inject({ method: 'GET', url: `/api/share/${sb.shareId}`, headers: ORIGIN });
    expect(still.statusCode).toBe(200);
    expect(still.json<SharedReport>().shareId).toBe(sb.shareId);
  });

  it('410 unknown session, 400 no session, 403 foreign origin, 404 malformed id', async () => {
    app = await build();
    expect((await share(app, 'B'.repeat(22))).json().code).toBe('session_expired');
    expect((await share(app, 'B'.repeat(22), 'DELETE')).statusCode).toBe(410);
    expect((await app.inject({ method: 'POST', url: '/api/share', headers: ORIGIN, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/share', headers: { origin: 'https://evil.example' }, payload: { session: 'B'.repeat(22) } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/share/..%2F..%2Fetc', headers: ORIGIN })).statusCode).toBe(404);
  });

  it('409 not_ready when the AI is still pending after the snapshot wait', async () => {
    const c = controlledEngine();
    const { calls: _c, ...audit } = auditDeps(routes(), { ai: c.engine });
    app = await buildApp({ mxResolver: fakeMx, config: appConfig({ aiMode: 'live' }), audit, snapshotWaitMs: 20 });
    const r = await start(app);
    const res = await share(app, r.session);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('not_ready');
  });

  it('503 share_unavailable when the store refuses; the audit route is unaffected', async () => {
    const reports: ReportStore = new MemoryReportStore({ retentionDays: 30, maxFiles: 1 });
    reports.put = async () => ({ ok: false, reason: 'full' });
    app = await build({ reports });
    const r = await start(app);
    await settle(app, r.auditId);
    const res = await share(app, r.session);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('share_unavailable');
    await start(app);
  });

  it('GET /r/:id: noindex headers and meta, no-referrer, no-store; the id never reaches the logs', async () => {
    const sink = logSink();
    app = await build({ clientDir: clientDir(), logger: sink.logger });
    const r = await start(app);
    await settle(app, r.auditId);
    const { shareId } = (await share(app, r.session)).json<ShareCreated>();
    const page = await app.inject({ method: 'GET', url: `/r/${shareId}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('<meta name="robots" content="noindex, nofollow, noarchive" />');
    expect(page.body.match(/name="robots"/g)).toHaveLength(1);
    // The route's no-referrer survives, but CSP and nosniff are always the app's.
    expect(page.headers['content-security-policy']).toContain('frame-ancestors');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['strict-transport-security']).toBeTruthy();
    await app.inject({ method: 'GET', url: `/api/share/${shareId}?x=1`, headers: ORIGIN });
    const logs = sink.text();
    expect(logs).toContain('/r/:id');
    expect(logs).toContain('/api/share/:id');
    expect(logs).not.toContain(shareId);
    // Not advertised in robots.txt.
    expect((await app.inject({ method: 'GET', url: '/robots.txt' })).body).not.toContain('/r/');
  });

  it('admin DELETE /api/admin/share/:id removes a report', async () => {
    app = await build({}, { adminToken: TOKEN });
    const r = await start(app);
    await settle(app, r.auditId);
    const { shareId } = (await share(app, r.session)).json<ShareCreated>();
    const auth = { authorization: `Bearer ${TOKEN}` };
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/share/${shareId}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/share/${shareId}`, headers: ORIGIN })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/share/${shareId}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/share/${shareId}`, headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  });

  it('SHARE_LINKS=off: share routes and /r/ are 404, features.share=false, /healthz shares off', async () => {
    app = await build({ clientDir: clientDir() }, { shareLinks: 'off' });
    const r = await start(app);
    expect(r.features.share).toBe(false);
    expect((await share(app, r.session)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/share/${'C'.repeat(22)}`, headers: ORIGIN })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/r/${'C'.repeat(22)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().shares).toBe('off');
  });
});

describe('security headers', () => {
  it('a route may set Referrer-Policy only; CSP, nosniff, HSTS and Permissions-Policy are forced', async () => {
    app = await build();
    app.get('/test-headers', async (_req, reply) =>
      reply
        .header('content-security-policy', "default-src *")
        .header('x-content-type-options', 'off')
        .header('strict-transport-security', 'max-age=0')
        .header('permissions-policy', 'camera=*')
        .header('referrer-policy', 'no-referrer')
        .send('ok'),
    );
    const res = await app.inject({ method: 'GET', url: '/test-headers' });
    expect(res.headers['content-security-policy']).not.toBe('default-src *');
    expect(res.headers['content-security-policy']).toContain('frame-ancestors');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=(), payment=()');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect((await app.inject({ method: 'GET', url: '/healthz' })).headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});

describe('helpers', () => {
  const ID = 'AbCdEfGhIjKlMnOpQrSt_-';

  it('logPath drops the query and redacts share ids anywhere in the path', () => {
    expect(ID).toHaveLength(22);
    expect(logPath(`/r/${ID}?x=1`)).toBe('/r/:id');
    expect(logPath(`//r/${ID}`)).toBe('//r/:id');
    expect(logPath(`/r/${ID}/`)).toBe('/r/:id/');
    expect(logPath(`/api/share/${ID}`)).toBe('/api/share/:id');
    expect(logPath(`//api/share/${ID}/`)).toBe('//api/share/:id/');
    expect(logPath(`/api/admin/share/${ID}`)).toBe('/api/admin/share/:id');
    expect(logPath(`///api/admin/share/${ID}?q`)).toBe('///api/admin/share/:id');
    expect(logPath('/api/share')).toBe('/api/share');
    expect(logPath('/api/audit/x/ai?y')).toBe('/api/audit/x/ai');
    expect(logPath('/r/short')).toBe('/r/short');
  });

  it('logPath is linear on long input', () => {
    const t = Date.now();
    logPath(`/r/${'a'.repeat(200_000)}`);
    logPath(`/api/share/${'/'.repeat(200_000)}`);
    logPath('/'.repeat(200_000));
    logPath(`${'/r'.repeat(100_000)}`);
    expect(Date.now() - t).toBeLessThan(200);
  });

  it('sharedPageHtml replaces the robots meta, or injects one', () => {
    expect(sharedPageHtml('<head><meta name="robots" content="noindex" /></head>')).toBe('<head><meta name="robots" content="noindex, nofollow, noarchive" /></head>');
    expect(sharedPageHtml('<head></head>')).toContain('<head><meta name="robots" content="noindex, nofollow, noarchive" />');
  });
});
