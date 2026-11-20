// app.inject tests for Amendment 5 Phase 4: POST /api/share/email. The mailer is a fake; no
// network. Network, DNS and AI are mocked as in the other app tests.
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditStartResponse } from '../../shared/types.js';
import { buildApp } from '../../server/app.js';
import type { AppDeps } from '../../server/app.js';
import { emailKey, logHash } from '../../server/lead/email.js';
import type { MailMessage, MailResult, Mailer } from '../../server/mail/types.js';
import { MemoryReportStore } from '../../server/share/store.js';
import { appConfig, appDeps, ORIGIN, siteRoutes } from './_appMock.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const SECRET = appConfig().emailHashSecret;
let n = 0;
const nextEmail = () => `person${++n}@mail.example`;

const fakeMailer = (results: MailResult[] = []) => {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    name: 'resend',
    send: async (m) => {
      sent.push(m);
      return results.shift() ?? { ok: true };
    },
  };
  return { mailer, sent };
};

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
  buildApp({
    ...appDeps({}, { ...siteRoutes('acme.example'), ...siteRoutes('other.example') }),
    ...over,
    config: appConfig({ rateLimitHourly: 100, rateLimitDaily: 1000, ...cfg }),
  });

const start = async (a: FastifyInstance, email: string, url = 'acme.example') => {
  const res = await a.inject({ method: 'POST', url: '/api/audit', headers: ORIGIN, payload: { url, email } });
  expect(res.statusCode).toBe(200);
  const body = res.json<AuditStartResponse>();
  await a.inject({ method: 'GET', url: `/api/audit/${body.auditId}/ai`, headers: ORIGIN });
  await a.inject({ method: 'GET', url: `/api/audit/${body.auditId}/buyer-fit`, headers: ORIGIN });
  return body;
};

const sendEmail = (a: FastifyInstance, session: string, email: string, headers: Record<string, string> = ORIGIN) =>
  a.inject({ method: 'POST', url: '/api/share/email', headers, payload: { session, email } });

describe('Phase 4: POST /api/share/email', () => {
  it('202 {sent, expiresAt}; share auto-created; one message to the gate address with the share URL', async () => {
    const m = fakeMailer();
    const reports = new MemoryReportStore({ retentionDays: 30, maxFiles: 100 });
    app = await build({ mailer: m.mailer, reports });
    const email = nextEmail();
    const r = await start(app, email);
    expect(r.features.email).toBe(true);
    expect(await reports.count()).toBe(0);
    const res = await sendEmail(app, r.session, email);
    expect(res.statusCode).toBe(202);
    const body = res.json<{ sent: boolean; expiresAt: string }>();
    expect(body.sent).toBe(true);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(await reports.count()).toBe(1);
    expect(m.sent).toHaveLength(1);
    const msg = m.sent[0]!;
    expect(msg.to).toBe(email);
    expect(msg.subject).toBe('Your website audit for acme.example');
    expect(msg.text).toMatch(/https:\/\/audit\.example\/r\/[A-Za-z0-9_-]{22}/);
    expect(msg.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(msg.text).toContain('Offshorly Ltd');
    // A later Copy link reuses the same share.
    const share = await app.inject({ method: 'POST', url: '/api/share', headers: ORIGIN, payload: { session: r.session } });
    expect(msg.text).toContain(share.json<{ url: string }>().url);
  });

  it('uses MAIL_FOOTER_LINE when set', async () => {
    const m = fakeMailer();
    app = await build({ mailer: m.mailer }, { mailFooterLine: 'Offshorly Ltd, registered in England no. 00000000' });
    const email = nextEmail();
    const r = await start(app, email);
    await sendEmail(app, r.session, email);
    expect(m.sent[0]!.text).toContain('Offshorly Ltd, registered in England no. 00000000');
  });

  it('403 for a different email (the recipient can only be the gate address); gate canonicalisation applies', async () => {
    const m = fakeMailer();
    app = await build({ mailer: m.mailer });
    const email = nextEmail();
    const r = await start(app, email);
    expect((await sendEmail(app, r.session, 'someone.else@mail.example')).statusCode).toBe(403);
    expect(m.sent).toHaveLength(0);
    // Same canonical address (case) passes.
    expect((await sendEmail(app, r.session, email.toUpperCase())).statusCode).toBe(202);
  });

  it('400 email_invalid for list, display-name and CRLF strings that canonicalise to the gate address; nothing sent', async () => {
    const m = fakeMailer();
    app = await build({ mailer: m.mailer });
    const email = 'attacker@evil.com';
    const r = await start(app, email, 'acme.example');
    for (const bad of [
      'attacker+x,victim@target.com,y@evil.com',
      'attacker+ <victim@target.com> @evil.com',
      'attacker+x\r\nBcc: victim@target.com\r\n@evil.com',
    ]) {
      const res = await sendEmail(app, r.session, bad);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'email_invalid' });
    }
    expect(m.sent).toHaveLength(0);
    // The real address still works, and is sent trimmed.
    expect((await sendEmail(app, r.session, `  ${email} `)).statusCode).toBe(202);
    expect(m.sent[0]!.to).toBe(email);
  });

  it('the gate (POST /api/audit) rejects the same strings with 400 email_invalid before canonicalising', async () => {
    app = await build({ mailer: fakeMailer().mailer });
    for (const email of ['attacker+x,victim@target.com,y@evil.com', 'attacker+ <victim@target.com> @evil.com']) {
      const res = await app.inject({ method: 'POST', url: '/api/audit', headers: ORIGIN, payload: { url: 'acme.example', email } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'email_invalid' });
    }
  });

  it('idempotency key is sha256(session + ":" + shareId)', async () => {
    const m = fakeMailer();
    app = await build({ mailer: m.mailer });
    const email = nextEmail();
    const r = await start(app, email);
    expect((await sendEmail(app, r.session, email)).statusCode).toBe(202);
    const share = await app.inject({ method: 'POST', url: '/api/share', headers: ORIGIN, payload: { session: r.session } });
    const shareId = share.json<{ shareId: string }>().shareId;
    const expected = createHash('sha256').update(`${r.session}:${shareId}`).digest('hex');
    expect(m.sent[0]!.idempotencyKey).toBe(expected);
    expect(m.sent[0]!.idempotencyKey).not.toBe(createHash('sha256').update(r.session).digest('hex'));
  });

  it('409 already_sent on a second send for the same session', async () => {
    const m = fakeMailer();
    app = await build({ mailer: m.mailer });
    const email = nextEmail();
    const r = await start(app, email);
    expect((await sendEmail(app, r.session, email)).statusCode).toBe(202);
    const again = await sendEmail(app, r.session, email);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'already_sent' });
    expect(m.sent).toHaveLength(1);
  });

  it('per-key cap: 3 sends per email per 24 h across sessions → 429', async () => {
    const m = fakeMailer();
    app = await build({ mailer: m.mailer });
    const email = nextEmail();
    for (let i = 0; i < 3; i++) {
      const r = await start(app, email);
      expect((await sendEmail(app, r.session, email)).statusCode).toBe(202);
    }
    const r = await start(app, email);
    const res = await sendEmail(app, r.session, email);
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'rate_limited' });
    expect(m.sent).toHaveLength(3);
  });

  it('global MAIL_DAILY_MAX → 503 busy', async () => {
    const m = fakeMailer();
    app = await build({ mailer: m.mailer }, { mailDailyMax: 1 });
    const a = nextEmail();
    const b = nextEmail();
    const ra = await start(app, a);
    const rb = await start(app, b);
    expect((await sendEmail(app, ra.session, a)).statusCode).toBe(202);
    const res = await sendEmail(app, rb.session, b);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'busy' });
    expect(m.sent).toHaveLength(1);
  });

  it('502 email_failed on provider failure; the status code is logged, never the address; a retry may succeed', async () => {
    const m = fakeMailer([{ ok: false, status: 500 }]);
    const sink = logSink();
    app = await build({ mailer: m.mailer, logger: sink.logger });
    const email = 'Secret.Visitor@acme.example';
    const r = await start(app, email);
    const res = await sendEmail(app, r.session, email);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'email_failed' });
    const logs = sink.text();
    expect(logs).toContain('report_email');
    expect(logs).toContain('"providerStatus":500');
    expect(logs).toContain(logHash(emailKey(SECRET, email)));
    expect(logs).not.toContain('@');
    expect(logs.toLowerCase()).not.toContain('secret.visitor');
    expect(logs).not.toContain(r.session);
    // Not marked sent: a retry is allowed.
    expect((await sendEmail(app, r.session, email)).statusCode).toBe(202);
    expect(sink.text()).toContain('"status":"sent"');
    expect(sink.text()).not.toContain('@');
  });

  it('410 for an unknown session, 400 for a missing email, 403 for a foreign origin, 429 past 5/h per IP', async () => {
    const m = fakeMailer();
    app = await build({ mailer: m.mailer });
    const email = nextEmail();
    expect((await sendEmail(app, 'A'.repeat(22), email)).statusCode).toBe(410);
    const r = await start(app, email);
    expect((await app.inject({ method: 'POST', url: '/api/share/email', headers: ORIGIN, payload: { session: r.session } })).statusCode).toBe(400);
    expect((await sendEmail(app, r.session, email, { origin: 'https://evil.example' })).statusCode).toBe(403);
    // 3 requests used so far that reached the limiter (410, 400; the 403 stops before it).
    for (let i = 0; i < 3; i++) await sendEmail(app, r.session, 'wrong@mail.example');
    expect((await sendEmail(app, r.session, email)).statusCode).toBe(429);
    expect(m.sent).toHaveLength(0);
  });

  it('the stored snapshot never holds the email; the request never puts it in a URL', async () => {
    const m = fakeMailer();
    const reports = new MemoryReportStore({ retentionDays: 30, maxFiles: 100 });
    const sink = logSink();
    app = await build({ mailer: m.mailer, reports, logger: sink.logger });
    const email = nextEmail();
    const r = await start(app, email);
    await sendEmail(app, r.session, email);
    const share = await app.inject({ method: 'POST', url: '/api/share', headers: ORIGIN, payload: { session: r.session } });
    const stored = await reports.get(share.json<{ shareId: string }>().shareId);
    expect(JSON.stringify(stored)).not.toContain('@');
    expect(JSON.stringify(stored)).not.toContain(emailKey(SECRET, email));
    expect(sink.text()).not.toContain('@');
  });
});

describe('Phase 4: feature switch', () => {
  it('off when PUBLIC_ORIGIN is unset: features.email false, no email route, /healthz mail false', async () => {
    const m = fakeMailer();
    app = await build({ mailer: m.mailer }, { publicOrigin: null, allowedOrigins: ['https://audit.example'] });
    const email = nextEmail();
    const r = await start(app, email);
    expect(r.features.email).toBe(false);
    // No email route: the path falls to /api/share/:shareId, which allows GET only.
    expect((await sendEmail(app, r.session, email)).statusCode).toBe(405);
    expect(m.sent).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({ mail: false });
  });

  it('off with an http PUBLIC_ORIGIN, with sharing off, and without a mailer', async () => {
    for (const [over, cfg] of [
      [{ mailer: fakeMailer().mailer }, { publicOrigin: 'http://audit.example' }],
      [{ mailer: fakeMailer().mailer }, { shareLinks: 'off' as const }],
      [{}, {}],
    ] as const) {
      const a = await build(over, cfg);
      const health = (await a.inject({ method: 'GET', url: '/healthz' })).json<{ mail: boolean }>();
      expect(health.mail).toBe(false);
      await a.close();
    }
  });

  it('on: /healthz mail true and features.email true', async () => {
    app = await build({ mailer: fakeMailer().mailer });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({ mail: true, search: false });
  });
});
