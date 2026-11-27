// app.inject tests for Amendment 3: email gate, ledger, allow-list and CRM hand-off.
// Network, DNS and AI are mocked; the CRM is a fake CrmSync.
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditReport } from '../../shared/types.js';
import { buildApp } from '../../server/app.js';
import type { AppDeps } from '../../server/app.js';
import { runAudit } from '../../server/audit/runAudit.js';
import type { CrmSync } from '../../server/crm/sync.js';
import { emailKey } from '../../server/lead/email.js';
import { MemoryLedger } from '../../server/lead/ledger.js';
import type { AuditLedger } from '../../server/lead/ledger.js';
import { allowlist, appConfig, appDeps, auditDeps, ORIGIN, siteRoutes, thinRoutes } from './_appMock.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const SECRET = appConfig().emailHashSecret;
const keyOf = (email: string) => emailKey(SECRET, email);

const post = (a: FastifyInstance, payload: Record<string, unknown>, headers: Record<string, string> = ORIGIN) =>
  a.inject({ method: 'POST', url: '/api/audit', headers, payload });

const routes = () => ({ ...siteRoutes('acme.example'), ...siteRoutes('other.example'), ...siteRoutes('third.example') });

const fakeCrm = (impl?: () => void) => {
  const enqueue = vi.fn<CrmSync['enqueue']>(impl ?? (() => undefined));
  const crm: CrmSync = { enqueue, drain: async () => 0 };
  return { crm, enqueue };
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

const build = (over: Partial<AppDeps> = {}, r = routes()) =>
  buildApp({ ...appDeps({}, r), config: appConfig({ rateLimitHourly: 100, rateLimitDaily: 1000 }), ...over });

describe('email validation', () => {
  it('missing, malformed, disposable or undeliverable email → 400 email_invalid', async () => {
    app = await build();
    for (const email of [undefined, '', '   ', 42, 'not-an-email', 'a@b', `${'x'.repeat(250)}@a.example`, 'jo@mailinator.com', 'jo@sub.yopmail.com', 'jo@nxdomain.example', 'jo@nomail.example', 'jo\u0000@acme.example', 'jo\u001b@acme.example', 'jo\u200b@acme.example']) {
      const res = await post(app, { url: 'acme.example', ...(email === undefined ? {} : { email }) });
      expect(res.statusCode, String(email)).toBe(400);
      expect(res.json().code, String(email)).toBe('email_invalid');
    }
    // A-only domain is deliverable.
    expect((await post(app, { url: 'acme.example', email: 'jo@a-only.example' })).statusCode).toBe(200);
  });

  it('URL errors still win over email errors (bad_request first)', async () => {
    app = await build();
    expect((await post(app, { email: 'nope' })).json().code).toBe('bad_request');
  });
});

describe('one audit per email', () => {
  it('first 200 is recorded; another site → 409; the same site → 200', async () => {
    const ledger = new MemoryLedger();
    app = await build({ ledger });
    const email = 'Jo@Acme.example';
    expect((await post(app, { url: 'acme.example', email })).statusCode).toBe(200);
    expect(await ledger.get(keyOf(email))).toMatchObject({ domains: ['acme.example'] });

    const used = await post(app, { url: 'other.example', email: 'jo@acme.example' });
    expect(used.statusCode).toBe(409);
    expect(used.json().code).toBe('email_used');
    // Never reveals the site audited before.
    expect(used.body).not.toContain('acme.example');

    expect((await post(app, { url: 'https://acme.example/', email })).statusCode).toBe(200);
  });

  it('canonical form: +tags, Gmail dots and googlemail count as the same address', async () => {
    app = await build();
    expect((await post(app, { url: 'acme.example', email: 'j.o.bloggs+audit@gmail.com' })).statusCode).toBe(200);
    expect((await post(app, { url: 'other.example', email: 'JoBloggs@googlemail.com' })).statusCode).toBe(409);
  });

  it('a cached URL with a new email → 200 and recorded', async () => {
    const ledger = new MemoryLedger();
    app = await build({ ledger });
    const a = (await post(app, { url: 'acme.example', email: 'a@one.example' })).json<AuditReport>();
    const b = (await post(app, { url: 'acme.example', email: 'b@two.example' })).json<AuditReport>();
    expect(b.auditId).toBe(a.auditId); // the email is not part of the cache key
    expect(await ledger.get(keyOf('b@two.example'))).not.toBeNull();
  });

  it('422 unreadable → not recorded; a different site then → 200', async () => {
    const ledger = new MemoryLedger();
    app = await build({ ledger });
    const res = await post(app, { url: 'nowhere.example', email: 'jo@acme.example' });
    expect(res.statusCode).toBe(422);
    expect(await ledger.get(keyOf('jo@acme.example'))).toBeNull();
    expect((await post(app, { url: 'acme.example', email: 'jo@acme.example' })).statusCode).toBe(200);
  });

  it('503 busy → not recorded', async () => {
    const ledger = new MemoryLedger();
    const r = { ...routes(), ...siteRoutes('slow.example', { delayMs: 300 }) };
    const { calls: _c, ...audit } = auditDeps(r);
    app = await build({ ledger, audit, config: appConfig({ maxConcurrentAudits: 1, rateLimitHourly: 100 }) }, r);
    const slow = post(app, { url: 'slow.example', email: 'first@one.example' });
    await new Promise((res) => setTimeout(res, 50));
    const busy = await post(app, { url: 'acme.example', email: 'jo@acme.example' });
    expect(busy.statusCode).toBe(503);
    expect(await ledger.get(keyOf('jo@acme.example'))).toBeNull();
    expect((await slow).statusCode).toBe(200);
  });

  it('AI off (ai:null) → 200 but not recorded; thin site → recorded', async () => {
    const ledger = new MemoryLedger();
    const r = { ...routes(), ...thinRoutes() };
    const { calls: _c, ...audit } = auditDeps(r, { ai: null });
    app = await build({ ledger, audit, config: appConfig({ aiMode: 'off', rateLimitHourly: 100 }) }, r);
    const res = await post(app, { url: 'acme.example', email: 'jo@acme.example' });
    expect(res.statusCode).toBe(200);
    expect(res.json<AuditReport>().aiStatus).toBe('unavailable');
    expect(await ledger.get(keyOf('jo@acme.example'))).toBeNull();
    expect((await post(app, { url: 'other.example', email: 'jo@acme.example' })).statusCode).toBe(200);

    const thin = await post(app, { url: 'thin.example', email: 'thin@acme.example' });
    expect(thin.json<AuditReport>().aiStatus).toBe('thin');
    expect(await ledger.get(keyOf('thin@acme.example'))).not.toBeNull();
  });

  it('daily AI cap reached → not recorded', async () => {
    const ledger = new MemoryLedger();
    app = await build({ ledger, config: appConfig({ dailyAiAudits: 0, rateLimitHourly: 100 }) });
    expect((await post(app, { url: 'acme.example', email: 'jo@acme.example' })).statusCode).toBe(200);
    expect(await ledger.get(keyOf('jo@acme.example'))).toBeNull();
  });

  it('ledger.get throws → fails open (200) and logs ledger_unavailable', async () => {
    const broken: AuditLedger = {
      kind: 'disk',
      get: async () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
      record: async () => {
        throw new Error('EIO');
      },
      close: async () => undefined,
    };
    const sink = logSink();
    app = await build({ ledger: broken, logger: sink.logger });
    expect((await post(app, { url: 'acme.example', email: 'jo@acme.example' })).statusCode).toBe(200);
    expect(sink.text()).toContain('ledger_unavailable');
  });

  it('the same email on two domains at once → one 503 busy', async () => {
    const r = { ...routes(), ...siteRoutes('slow.example', { delayMs: 300 }) };
    const { calls: _c, ...audit } = auditDeps(r);
    app = await build({ audit }, r);
    const slow = post(app, { url: 'slow.example', email: 'jo@acme.example' });
    await new Promise((res) => setTimeout(res, 50));
    const second = await post(app, { url: 'acme.example', email: 'jo@acme.example' });
    expect(second.statusCode).toBe(503);
    // Generic wording: indistinguishable from the server-full reply.
    expect(second.json()).toMatchObject({ code: 'busy', error: 'Too many audits are running. Please try again in a minute.' });
    expect((await slow).statusCode).toBe(200);
  });

  it('the per-email 503 busy is not refunded, so it is no free probe', async () => {
    const r = { ...routes(), ...siteRoutes('slow.example', { delayMs: 300 }) };
    const { calls: _c, ...audit } = auditDeps(r);
    app = await build({ audit, config: appConfig({ rateLimitHourly: 2, rateLimitDaily: 1000 }) }, r);
    const slow = post(app, { url: 'slow.example', email: 'jo@acme.example' });
    await new Promise((res) => setTimeout(res, 50));
    expect((await post(app, { url: 'acme.example', email: 'jo@acme.example' })).statusCode).toBe(503);
    // Both hits counted: a third request from the same IP is over the hourly limit.
    expect((await post(app, { url: 'third.example', email: 'sam@acme.example' })).statusCode).toBe(429);
    expect((await slow).statusCode).toBe(200);
  });

  it('EMAIL_GATE=off: repeats on other sites are allowed, nothing recorded, CRM still synced', async () => {
    const ledger = new MemoryLedger();
    const { crm, enqueue } = fakeCrm();
    app = await build({ ledger, crm, config: appConfig({ emailGate: 'off', rateLimitHourly: 100 }) });
    expect((await post(app, { url: 'acme.example', email: 'jo@acme.example' })).statusCode).toBe(200);
    expect((await post(app, { url: 'other.example', email: 'jo@acme.example' })).statusCode).toBe(200);
    expect(await ledger.get(keyOf('jo@acme.example'))).toBeNull();
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

describe('allow-list', () => {
  it('allow-listed addresses repeat freely, are never recorded and skip the CRM', async () => {
    const ledger = new MemoryLedger();
    const { crm, enqueue } = fakeCrm();
    app = await build({ ledger, crm });
    for (const url of ['acme.example', 'other.example', 'third.example']) {
      expect((await post(app, { url, email: 'alex@offshorly.com' })).statusCode).toBe(200);
    }
    expect(await ledger.get(keyOf('alex@offshorly.com'))).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    // Subdomains of an @domain entry are not allow-listed.
    expect((await post(app, { url: 'acme.example', email: 'x@sub.offshorly.com' })).statusCode).toBe(200);
    expect((await post(app, { url: 'other.example', email: 'x@sub.offshorly.com' })).statusCode).toBe(409);
  });

  it('CRM_SYNC_ALLOWLISTED=true: allow-listed audits are synced as tests', async () => {
    const { crm, enqueue } = fakeCrm();
    app = await build({ crm, config: appConfig({ crmSyncAllowlisted: true, auditAllowlist: allowlist('@offshorly.com', 'tester@example.org') }) });
    expect((await post(app, { url: 'acme.example', email: 'tester+x@example.org' })).statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ test: true, email: 'tester+x@example.org' });
  });
});

describe('CRM hand-off', () => {
  it('flags a cache hit so the note leaves out the original run\'s cost', async () => {
    const { crm, enqueue } = fakeCrm();
    app = await build({ crm, config: appConfig({ emailGate: 'off', rateLimitHourly: 100 }) });
    expect((await post(app, { url: 'acme.example', email: 'jo@acme.example' })).statusCode).toBe(200);
    expect((await post(app, { url: 'acme.example', email: 'sam@other.example' })).statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0]![2]).toEqual({ cacheHit: false });
    expect(enqueue.mock.calls[1]![2]).toEqual({ cacheHit: true });
  });

  it('enqueues the lead with consent details; the email is lowercased as typed', async () => {
    const { crm, enqueue } = fakeCrm();
    app = await build({ crm });
    await post(app, { url: 'acme.example', email: ' Jo.Bloggs+x@Acme.example ', name: 'Jo  Bloggs', marketingOptIn: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [lead, entry] = enqueue.mock.calls[0]!;
    expect(lead).toMatchObject({
      email: 'jo.bloggs+x@acme.example',
      name: 'Jo Bloggs',
      marketingOptIn: true,
      noticeVersion: 'v1',
      test: false,
      emailHash: keyOf('jo.bloggs@acme.example'),
    });
    expect(lead.consentAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(entry.report.domain).toBe('acme.example');
  });

  it('a CRM that throws never affects the response', async () => {
    const { crm } = fakeCrm(() => {
      throw new Error('twenty down');
    });
    app = await build({ crm });
    expect((await post(app, { url: 'acme.example', email: 'jo@acme.example' })).statusCode).toBe(200);
  });
});

describe('the email stays out of runAudit, the cache key and the logs', () => {
  it('runAudit sees AuditRequest only; logs carry no address', async () => {
    const spy = vi.fn(runAudit);
    const sink = logSink();
    const { crm } = fakeCrm();
    app = await build({ runAudit: spy, logger: sink.logger, crm });
    const email = 'secret.person@acme.example';
    expect((await post(app, { url: 'acme.example', email, name: 'Secret Person', marketingOptIn: true })).statusCode).toBe(200);
    expect((await post(app, { url: 'other.example', email })).statusCode).toBe(409);
    expect((await post(app, { url: 'acme.example', email: 'bad@nxdomain.example' })).statusCode).toBe(400);
    expect(spy).toHaveBeenCalledTimes(1);
    const request = spy.mock.calls[0]![0];
    expect(request).toEqual({ url: 'acme.example' });
    expect(JSON.stringify(spy.mock.calls[0]![0])).not.toContain('@');

    const logs = sink.text();
    expect(logs).toContain('email gate: recorded');
    expect(logs).toContain(keyOf(email).slice(0, 12));
    for (const s of [email, 'secret.person', 'Secret Person', 'nxdomain.example', 'bad@']) expect(logs).not.toContain(s);
  });
});

describe('/healthz', () => {
  it('reports ledger kind and CRM state', async () => {
    app = await build({ crm: fakeCrm().crm, ledger: new MemoryLedger(), aiConfigError: true, config: appConfig({ aiMode: 'off' }) });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ ok: true, aiMode: 'off', aiConfigError: true, version: '0.0.0-test', ledger: 'memory', crm: true, feedback: 'memory', metrics: 'memory', shares: 'memory', mail: false, search: false });
  });
});
