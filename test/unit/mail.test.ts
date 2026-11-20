// Amendment 5 Phase 4: the report email body, the Resend adapter (fake fetch, no network) and
// the MAIL_* configuration.
import { describe, expect, it, vi } from 'vitest';
import { ConfigError, DEFAULT_MAIL_FOOTER, loadConfig, parseMailFrom, sanitiseFooterLine } from '../../server/config.js';
import { buildReportEmail, reportEmailFields } from '../../server/mail/reportEmail.js';
import type { ReportEmailInput } from '../../server/mail/reportEmail.js';
import { createResendMailer, MAIL_TIMEOUT_MS, parseRetryAfter, RESEND_ENDPOINT, RESEND_REPLY_TO_FIELD } from '../../server/mail/resend.js';
import type { MailFetch } from '../../server/mail/resend.js';
import type { MailMessage } from '../../server/mail/types.js';
import { sampleAi, sampleBuyerFit } from './_appMock.js';

const input = (over: Partial<ReportEmailInput> = {}): ReportEmailInput => ({
  domain: 'acme.example',
  url: 'https://audit.example/r/AAAAAAAAAAAAAAAAAAAAAA',
  auditedAt: '2026-11-20T10:00:00Z',
  expiresAt: '2026-12-20T10:00:00Z',
  buyerFit: 62,
  security: 70,
  health: 80,
  ideas: 3,
  footerLine: 'Offshorly Ltd',
  ...over,
});

describe('reportEmail', () => {
  it('subject, link, scores, expiry and the one-off notice; footer line last', () => {
    const e = buildReportEmail(input());
    expect(e.subject).toBe('Your website audit for acme.example');
    expect(e.text).toContain("Here's the link to the website audit you asked for: https://audit.example/r/AAAAAAAAAAAAAAAAAAAAAA");
    expect(e.text).toContain('Website: acme.example, audited 20 November 2026');
    expect(e.text).toContain('Buyer fit: 62/100 · Security: 70/100 · Website health: 80/100 · AI ideas: 3');
    expect(e.text).toContain('The link works until 20 December 2026. Anyone with it can view the report, so only forward it to people you trust.');
    expect(e.text).toContain("You're getting this one-off email because you asked for it on the Offshorly website audit. Questions? Just reply.");
    expect(e.text.trim().endsWith('Offshorly Ltd')).toBe(true);
    expect(e.html).toContain('href="https://audit.example/r/AAAAAAAAAAAAAAAAAAAAAA"');
  });

  it('escapes the domain and footer in the HTML part', () => {
    const e = buildReportEmail(input({ domain: '<b>evil</b>.example"', footerLine: 'A & B <Ltd>' }));
    expect(e.html).not.toContain('<b>evil</b>');
    expect(e.html).toContain('&lt;b&gt;evil&lt;/b&gt;.example&quot;');
    expect(e.html).toContain('A &amp; B &lt;Ltd&gt;');
  });

  it('no images, no tracking, no booking link', () => {
    const e = buildReportEmail(input());
    expect(e.html).not.toMatch(/<img/i);
    expect(e.html).not.toMatch(/<script|pixel|utm_/i);
    expect(`${e.text}${e.html}`).not.toMatch(/book a|consultation|calendly/i);
  });

  it('contains no model prose: no opportunity titles, summaries or quotes', () => {
    const ai = sampleAi();
    const report = {
      domain: 'acme.example',
      auditedAt: '2026-11-20T10:00:00Z',
      aiStatus: 'ok' as const,
      ai,
      buyerFitStatus: 'ok' as const,
      buyerFit: sampleBuyerFit(),
      security: { score: 70, checks: [] },
      health: { score: null, checks: [], measuredByGoogle: false },
    };
    const e = buildReportEmail({ ...reportEmailFields(report), url: 'https://audit.example/r/x', expiresAt: '2026-12-20T10:00:00Z', footerLine: 'Offshorly Ltd' });
    const all = `${e.subject}${e.text}${e.html}`;
    for (const o of ai.opportunities) expect(all).not.toContain(o.title);
    expect(all).not.toContain(ai.business.summary);
    expect(all).not.toContain(sampleBuyerFit().verdict.summary);
    expect(e.text).toContain('AI ideas: 1');
  });

  it('omits null scores and the ideas count when AI is unavailable', () => {
    const e = buildReportEmail(input({ buyerFit: null, health: null, ideas: null }));
    expect(e.text).toContain('Security: 70/100');
    expect(e.text).not.toMatch(/Buyer fit:|Website health:|AI ideas:/);
    const none = buildReportEmail(input({ buyerFit: null, security: null, health: null, ideas: null }));
    expect(none.text).not.toContain('/100');
    expect(reportEmailFields({
      domain: 'a.example',
      auditedAt: 'x',
      aiStatus: 'unavailable',
      buyerFitStatus: 'unavailable',
      security: { score: 50, checks: [] },
      health: { score: 60, checks: [], measuredByGoogle: false },
    })).toMatchObject({ buyerFit: null, ideas: null, security: 50, health: 60 });
  });
});

// ---------- Resend adapter ----------

const MESSAGE: MailMessage = {
  to: 'Visitor@Acme.example',
  subject: 'Your website audit for acme.example',
  text: 'text body',
  html: '<p>html body</p>',
  idempotencyKey: 'a'.repeat(64),
};

interface Call {
  url: string;
  init: Parameters<MailFetch>[1];
}

const fakeFetch = (responses: (Response | Error)[]) => {
  const calls: Call[] = [];
  const impl: MailFetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    if (r instanceof Error) throw r;
    return r;
  };
  return { impl, calls };
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const mailer = (f: MailFetch, over: { replyTo?: string | null } = {}) => {
  const sleeps: number[] = [];
  const m = createResendMailer({
    apiKey: 're_test_key_123',
    from: 'Offshorly audit <audit@mail.offshorly.com>',
    replyTo: over.replyTo === undefined ? 'hello@offshorly.com' : over.replyTo,
    userAgent: 'offshorly-audit/0.0.0-test',
    fetchImpl: f,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { m, sleeps };
};

describe('Resend adapter', () => {
  it('request shape per the verified docs: endpoint, Bearer, User-Agent, Idempotency-Key, snake_case reply_to', async () => {
    const f = fakeFetch([json(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' })]);
    const { m } = mailer(f.impl);
    expect(await m.send(MESSAGE)).toEqual({ ok: true });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(RESEND_ENDPOINT);
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer re_test_key_123');
    expect(init.headers['user-agent']).toBe('offshorly-audit/0.0.0-test');
    expect(init.headers['idempotency-key']).toBe('a'.repeat(64));
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(RESEND_REPLY_TO_FIELD).toBe('reply_to');
    expect(body).toEqual({
      from: 'Offshorly audit <audit@mail.offshorly.com>',
      to: ['Visitor@Acme.example'],
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
      reply_to: 'hello@offshorly.com',
    });
    expect(MAIL_TIMEOUT_MS).toBe(10_000);
  });

  it('omits reply_to when not configured', async () => {
    const f = fakeFetch([json(200, { id: 'x' })]);
    await mailer(f.impl, { replyTo: null }).m.send(MESSAGE);
    expect(JSON.parse(f.calls[0]!.init.body)).not.toHaveProperty('reply_to');
  });

  it('429 with retry-after ≤ 3 s → waits and retries once with the same Idempotency-Key', async () => {
    const f = fakeFetch([json(429, { name: 'rate_limit_exceeded' }, { 'retry-after': '1' }), json(200, { id: 'x' })]);
    const { m, sleeps } = mailer(f.impl);
    expect(await m.send(MESSAGE)).toEqual({ ok: true });
    expect(f.calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    expect(f.calls[1]!.init.headers['idempotency-key']).toBe(f.calls[0]!.init.headers['idempotency-key']);
  });

  it('429 without retry-after, or asking for longer than 3 s, is not retried (likely a quota)', async () => {
    for (const headers of [{}, { 'retry-after': '3600' }] as Record<string, string>[]) {
      const f = fakeFetch([json(429, { message: 'quota' }, headers)]);
      expect(await mailer(f.impl).m.send(MESSAGE)).toEqual({ ok: false, status: 429 });
      expect(f.calls).toHaveLength(1);
    }
  });

  it('5xx and network errors retry once; a second failure reports the last status', async () => {
    const a = fakeFetch([json(503, {}), json(200, { id: 'x' })]);
    expect(await mailer(a.impl).m.send(MESSAGE)).toEqual({ ok: true });
    expect(a.calls).toHaveLength(2);
    const b = fakeFetch([new Error('connect ECONNREFUSED https://api.resend.com/emails'), new Error('again')]);
    expect(await mailer(b.impl).m.send(MESSAGE)).toEqual({ ok: false, status: 'network' });
    expect(b.calls).toHaveLength(2);
    const c = fakeFetch([json(500, {}), json(502, {})]);
    expect(await mailer(c.impl).m.send(MESSAGE)).toEqual({ ok: false, status: 502 });
  });

  it('400, 403, 422 and 409 (idempotency conflicts) are final: no retry', async () => {
    for (const status of [400, 403, 409, 422]) {
      const f = fakeFetch([json(status, { name: 'invalid_idempotent_request', message: 'Visitor@Acme.example' })]);
      expect(await mailer(f.impl).m.send(MESSAGE)).toEqual({ ok: false, status });
      expect(f.calls).toHaveLength(1);
    }
  });

  it('never reads or logs the response body', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = json(422, { message: 'The to field contains Visitor@Acme.example' });
    const text = vi.spyOn(res, 'text');
    const jsonSpy = vi.spyOn(res, 'json');
    const f = fakeFetch([res]);
    const result = await mailer(f.impl).m.send(MESSAGE);
    expect(JSON.stringify(result)).not.toContain('@');
    expect(text).not.toHaveBeenCalled();
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    info.mockRestore();
    warn.mockRestore();
  });

  it('parseRetryAfter: seconds only', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0.5')).toBe(500);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
  });
});

// ---------- Config ----------

const MAIL_ENV = {
  MAIL_PROVIDER: 'resend',
  MAIL_API_KEY: 're_key',
  MAIL_FROM: 'Offshorly audit <audit@mail.offshorly.com>',
  MAIL_REPLY_TO: 'hello@offshorly.com',
  PUBLIC_ORIGIN: 'https://audit.offshorly.com',
};

describe('config: MAIL_*', () => {
  it('off by default with no warnings; daily max 90; footer "Offshorly Ltd"', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ mailProvider: null, mailConfigured: false, mailDailyMax: 90, mailFooterLine: DEFAULT_MAIL_FOOTER });
    expect(DEFAULT_MAIL_FOOTER).toBe('Offshorly Ltd');
    expect(c.warnings).toEqual([]);
  });

  it('complete settings → configured', () => {
    const c = loadConfig(MAIL_ENV);
    expect(c).toMatchObject({
      mailProvider: 'resend',
      mailApiKey: 're_key',
      mailFrom: 'Offshorly audit <audit@mail.offshorly.com>',
      mailReplyTo: 'hello@offshorly.com',
      mailConfigured: true,
    });
    expect(c.warnings).toEqual([]);
  });

  it('production with an http PUBLIC_ORIGIN → mail off plus a warning (no boot failure)', () => {
    const c = loadConfig({ ...MAIL_ENV, NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://audit.offshorly.com' });
    expect(c.mailConfigured).toBe(false);
    expect(c.warnings.join(' ')).toMatch(/PUBLIC_ORIGIN must be an https origin/);
    expect(loadConfig({ ...MAIL_ENV, PUBLIC_ORIGIN: '' }).mailConfigured).toBe(false);
  });

  it('missing key or unparseable From → off with a warning; values never in the warning', () => {
    const noKey = loadConfig({ ...MAIL_ENV, MAIL_API_KEY: '' });
    expect(noKey.mailConfigured).toBe(false);
    expect(noKey.warnings.join(' ')).toMatch(/MAIL_API_KEY/);
    const badFrom = loadConfig({ ...MAIL_ENV, MAIL_FROM: 'not an address' });
    expect(badFrom.mailConfigured).toBe(false);
    expect(badFrom.warnings.join(' ')).toMatch(/MAIL_FROM/);
    expect(badFrom.warnings.join(' ')).not.toContain('not an address');
    const badReply = loadConfig({ ...MAIL_ENV, MAIL_REPLY_TO: 'nope' });
    expect(badReply.mailConfigured).toBe(true);
    expect(badReply.mailReplyTo).toBeNull();
    expect(badReply.warnings.join(' ')).toMatch(/MAIL_REPLY_TO/);
    expect(loadConfig({ ...MAIL_ENV }).warnings.join(' ')).not.toContain('re_key');
  });

  it('unknown provider → mail off plus a warning (no boot failure); MAIL_DAILY_MAX is range-checked', () => {
    for (const env of [{ MAIL_PROVIDER: 'postmark' }, { ...MAIL_ENV, MAIL_PROVIDER: 'postmark', NODE_ENV: 'production' }]) {
      const c = loadConfig(env);
      expect(c).toMatchObject({ mailProvider: null, mailConfigured: false });
      expect(c.warnings.join(' ')).toMatch(/MAIL_PROVIDER must be resend or empty: report email is off/);
    }
    expect(loadConfig({ MAIL_DAILY_MAX: '10' }).mailDailyMax).toBe(10);
    expect(() => loadConfig({ MAIL_DAILY_MAX: '-1' })).toThrow(ConfigError);
  });

  it('SEARCH_PROVIDER: unknown value or fixture in production → search off plus a warning (no boot failure)', () => {
    const unknown = loadConfig({ SEARCH_PROVIDER: 'serper', SEARCH_API_KEY: 'k' });
    expect(unknown.searchProvider).toBeNull();
    expect(unknown.warnings.join(' ')).toMatch(/SEARCH_PROVIDER must be serpapi/);
    const prodFixture = loadConfig({ SEARCH_PROVIDER: 'fixture', NODE_ENV: 'production' });
    expect(prodFixture.searchProvider).toBeNull();
    expect(prodFixture.warnings.join(' ')).toMatch(/SEARCH_PROVIDER=fixture is not allowed in production/);
    expect(loadConfig({ SEARCH_PROVIDER: 'fixture' })).toMatchObject({ searchProvider: 'fixture', warnings: [] });
    expect(loadConfig({ SEARCH_PROVIDER: 'serpapi', SEARCH_API_KEY: 'k' })).toMatchObject({ searchProvider: 'serpapi', warnings: [] });
    expect(loadConfig({ SEARCH_PROVIDER: 'serpapi' }).searchProvider).toBeNull();
  });

  it('parseMailFrom', () => {
    expect(parseMailFrom('audit@mail.offshorly.com')).toBe('audit@mail.offshorly.com');
    expect(parseMailFrom('  Offshorly audit   <audit@mail.offshorly.com> ')).toBe('Offshorly audit <audit@mail.offshorly.com>');
    expect(parseMailFrom('<audit@mail.offshorly.com>')).toBe('audit@mail.offshorly.com');
    expect(parseMailFrom('Bad "quote" <audit@mail.offshorly.com>')).toBeNull();
    expect(parseMailFrom('Name <not-an-address>')).toBeNull();
    expect(parseMailFrom('Name\r\nBcc: x <a@b.example>')).toBeNull();
    expect(parseMailFrom(`${'<'.repeat(5000)}a@b.example>`)).toBeNull();
  });

  it('MAIL_FOOTER_LINE: one line, ≤200 characters', () => {
    expect(loadConfig({ MAIL_FOOTER_LINE: 'Offshorly Ltd,\n registered in England,\tno. 123' }).mailFooterLine).toBe('Offshorly Ltd, registered in England, no. 123');
    const long = loadConfig({ MAIL_FOOTER_LINE: 'x'.repeat(250) });
    expect(long.mailFooterLine).toHaveLength(200);
    expect(long.warnings.join(' ')).toMatch(/MAIL_FOOTER_LINE/);
    expect(sanitiseFooterLine('a b\u0000c')).toBe('a b c');
  });

  it('FEEDBACK_RETENTION_DAYS is capped at 365 (the copy promises "up to a year")', () => {
    expect(loadConfig({ FEEDBACK_RETENTION_DAYS: '365' }).feedbackRetentionDays).toBe(365);
    expect(() => loadConfig({ FEEDBACK_RETENTION_DAYS: '366' })).toThrow(/between 1 and 365/);
  });
});
