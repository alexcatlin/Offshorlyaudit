// CRM sync tests. Twenty is a fake fetch: no network, no credentials.
import { describe, expect, it } from 'vitest';
import type { AiResult, AuditReport, BuyerFitResult } from '../../shared/types.js';
import { CTA } from '../../shared/services.js';
import { buildNote } from '../../server/crm/summary.js';
import type { CrmLead } from '../../server/crm/summary.js';
import { companyDomainFor, createCrmSync, splitName } from '../../server/crm/sync.js';
import type { CrmLog } from '../../server/crm/sync.js';
import { createTwentyClient, hostOfLink } from '../../server/crm/twenty.js';
import type { TwentyFetch } from '../../server/crm/twenty.js';
import { PROBE_DOMAIN, PROBE_EMAIL, runTwentyCheck } from '../../server/crm/twentyCheck.js';
import type { AuditEntry } from '../../server/routes/audit.js';
import { sampleAi, sampleBuyerFit } from './_appMock.js';

const EMAIL = 'jo.bloggs@acme.example';
const HASH = 'f'.repeat(32);

const report = (over: Partial<AuditReport> = {}): AuditReport => ({
  auditId: 'A'.repeat(22),
  auditedAt: '2026-11-20T10:00:00.000Z',
  url: 'https://acme.example/',
  domain: 'acme.example',
  pagesRead: [],
  aiStatus: 'pending',
  buyerFitStatus: 'pending',
  security: { score: 71, checks: [{ id: 'sec-hsts', status: 'fail', detail: 'No HSTS header.' }] },
  health: { score: 64, measuredByGoogle: false, checks: [{ id: 'seo-description', status: 'warn', detail: 'Meta description missing.' }] },
  cms: { platform: 'wordpress' },
  stack: [],
  fixFirst: [
    { source: 'check', section: 'security', checkId: 'sec-hsts' },
    { source: 'check', section: 'health', checkId: 'seo-description' },
  ],
  attributions: [],
  ...over,
});

const bfResult = (): BuyerFitResult => ({
  auditId: 'A'.repeat(22),
  buyerFitStatus: 'ok',
  buyerFit: sampleBuyerFit([{ text: 'Name a client on the homepage', horizon: 'now', impact: 'high', effort: 'low', owner: 'marketing' }]),
  fixFirst: [
    { source: 'ai', section: 'buyer-fit', actionIndex: 0 },
    { source: 'check', section: 'security', checkId: 'sec-hsts' },
  ],
});

const aiResult = (): AiResult => ({ auditId: 'A'.repeat(22), aiStatus: 'ok', ai: sampleAi() });

const entry = (over: Partial<AuditEntry> = {}, rep = report()): AuditEntry => ({
  report: rep,
  buyerFit: Promise.resolve(bfResult()),
  ai: Promise.resolve(aiResult()),
  ...over,
});

const lead = (over: Partial<CrmLead> = {}): CrmLead => ({
  email: EMAIL,
  name: 'Jo Anne Bloggs',
  marketingOptIn: false,
  consentAt: '2026-11-20T10:00:00.000Z',
  noticeVersion: 'v1',
  emailHash: HASH,
  test: false,
  ...over,
});

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  auth: string;
  redirect: string;
}

type Handler = (c: Call) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

/** A fake Twenty: routes `${method} ${path}` to handlers and records every call. */
const fakeTwenty = (handlers: Record<string, Handler>) => {
  const calls: Call[] = [];
  const fetchImpl: TwentyFetch = async (url, init) => {
    const u = new URL(url);
    const call: Call = {
      method: init.method,
      path: u.pathname,
      query: u.searchParams,
      body: init.body ? JSON.parse(init.body) : undefined,
      auth: init.headers.authorization ?? '',
      redirect: init.redirect,
    };
    calls.push(call);
    const key = `${init.method} ${u.pathname.replace(/\/[0-9a-f-]{36}$/, '/:id')}`;
    const h = handlers[key];
    if (!h) throw new Error(`unexpected ${key}`);
    const r = await h(call);
    return { ok: r.status < 300, status: r.status, json: async () => r.body ?? {} };
  };
  return { fetchImpl, calls };
};

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const baseHandlers = (): Record<string, Handler> => ({
  'GET /rest/people': () => ({ status: 200, body: { data: { people: [] }, totalCount: 0 } }),
  'POST /rest/people': () => ({ status: 201, body: { data: { createPerson: { id: ID(1) } } } }),
  'PATCH /rest/people/:id': () => ({ status: 200, body: { data: { updatePerson: { id: ID(1) } } } }),
  'GET /rest/companies': () => ({ status: 200, body: { data: { companies: [] } } }),
  'POST /rest/companies': () => ({ status: 201, body: { data: { createCompany: { id: ID(2) } } } }),
  'POST /rest/notes': () => ({ status: 201, body: { data: { createNote: { id: ID(3) } } } }),
  'POST /rest/noteTargets': () => ({ status: 201, body: { data: { createNoteTarget: { id: ID(4) } } } }),
});

const logCapture = () => {
  const entries: { level: string; msg: string; extra: Record<string, unknown> }[] = [];
  const log: CrmLog = (level, msg, extra) => entries.push({ level, msg, extra });
  return { log, entries, text: () => JSON.stringify(entries) };
};

const setup = (handlers: Record<string, Handler>, opts: { maxQueue?: number } = {}) => {
  const tw = fakeTwenty(handlers);
  const client = createTwentyClient({ apiUrl: 'https://api.twenty.example', apiKey: 'test-key', fetchImpl: tw.fetchImpl });
  const logs = logCapture();
  const sleeps: number[] = [];
  const sync = createCrmSync({
    client,
    log: logs.log,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(opts.maxQueue !== undefined ? { maxQueue: opts.maxQueue } : {}),
  });
  return { ...tw, logs, sync, sleeps };
};

describe('Twenty client shapes', () => {
  it('uses Bearer auth, /rest paths and the documented filter syntax', async () => {
    const { calls, fetchImpl } = fakeTwenty(baseHandlers());
    const c = createTwentyClient({ apiUrl: 'https://api.twenty.example/', apiKey: 'k123', fetchImpl });
    await c.findPersonByEmail(EMAIL);
    await c.findCompanyByDomain('acme.example');
    expect(calls[0]!.auth).toBe('Bearer k123');
    expect(calls[0]!.path).toBe('/rest/people');
    expect(calls[0]!.query.get('filter')).toBe(`emails.primaryEmail[ilike]:"${EMAIL}"`);
    expect(calls[1]!.query.get('filter')).toBe('domainName.primaryLinkUrl[ilike]:"%acme.example%"');
    expect(calls[0]!.query.get('limit')).toBe('10');
    expect(calls[1]!.query.get('limit')).toBe('60');
    expect(calls.every((c) => c.redirect === 'error')).toBe(true);
  });

  it('a short domain still finds its company deep in a loose match list', async () => {
    const noise = Array.from({ length: 40 }, (_, i) => ({ id: ID(100 + i), domainName: { primaryLinkUrl: `https://shopa${i}.io` } }));
    const { fetchImpl } = fakeTwenty({
      'GET /rest/companies': () => ({ status: 200, body: { data: { companies: [...noise, { id: ID(9), domainName: { primaryLinkUrl: 'a.io' } }] } } }),
    });
    const c = createTwentyClient({ apiUrl: 'https://api.twenty.example', apiKey: 'k', fetchImpl });
    expect(await c.findCompanyByDomain('a.io')).toBe(ID(9));
  });

  it('ilike wildcard near-miss: jo_x@ matching only joax@ creates a new Person, updates nothing', async () => {
    const h = baseHandlers();
    h['GET /rest/people'] = () => ({
      status: 200,
      body: { data: { people: [{ id: ID(8), name: { firstName: '', lastName: '' }, emails: { primaryEmail: 'joax@acme.example' }, companyId: null }] } },
    });
    const { sync, calls } = setup(h);
    sync.enqueue(lead({ email: 'jo_x@acme.example' }), entry());
    await sync.drain(1_000);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    const created = calls.filter((c) => c.method === 'POST' && c.path === '/rest/people');
    expect(created).toHaveLength(1);
    expect((created[0]!.body as { emails: { primaryEmail: string } }).emails.primaryEmail).toBe('jo_x@acme.example');
  });

  it('matches a company on the normalised stored host only', async () => {
    const { fetchImpl } = fakeTwenty({
      'GET /rest/companies': () => ({
        status: 200,
        body: {
          data: {
            companies: [
              { id: ID(7), domainName: { primaryLinkUrl: 'https://notacme.example' } },
              { id: ID(8), domainName: { primaryLinkUrl: 'https://www.acme.example/about' } },
            ],
          },
        },
      }),
    });
    const c = createTwentyClient({ apiUrl: 'https://api.twenty.example', apiKey: 'k', fetchImpl });
    expect(await c.findCompanyByDomain('acme.example')).toBe(ID(8));
    expect(hostOfLink('HTTP://WWW.Acme.Example:8080/x?y')).toBe('acme.example');
  });
});

describe('CRM sync', () => {
  it('new Person + Note linked to the Person (no Company for a mismatched domain)', async () => {
    const { sync, calls } = setup(baseHandlers());
    sync.enqueue(lead(), entry({}, report({ domain: 'client-site.example', url: 'https://client-site.example/' })));
    expect(await sync.drain(1_000)).toBe(0);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual(['/rest/people', '/rest/notes', '/rest/noteTargets']);
    expect(posts[0]!.body).toEqual({ name: { firstName: 'Jo', lastName: 'Anne Bloggs' }, emails: { primaryEmail: EMAIL } });
    expect((posts[1]!.body as { title: string }).title).toBe('Website audit: client-site.example');
    expect((posts[1]!.body as { bodyV2: { markdown: string } }).bodyV2.markdown).toContain('Email not verified');
    expect(posts[2]!.body).toEqual({ noteId: ID(3), targetPersonId: ID(1) });
    expect(calls.some((c) => c.path.startsWith('/rest/companies'))).toBe(false);
  });

  it('existing Person: name never overwritten, Note still added', async () => {
    const h = baseHandlers();
    h['GET /rest/people'] = () => ({
      status: 200,
      body: {
        data: {
          people: [
            // ilike treats "_" and "%" as wildcards: only an exact (case-insensitive) match counts.
            { id: ID(8), name: { firstName: 'Other', lastName: '' }, emails: { primaryEmail: 'jo_bloggs@acme.example' }, companyId: null },
            { id: ID(9), name: { firstName: 'Joanna', lastName: '' }, emails: { primaryEmail: 'Jo.Bloggs@Acme.example' }, companyId: ID(5) },
          ],
        },
      },
    });
    const { sync, calls } = setup(h);
    sync.enqueue(lead(), entry());
    await sync.drain(1_000);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/rest/people')).toBe(false);
    const targets = calls.filter((c) => c.path === '/rest/noteTargets').map((c) => c.body);
    expect(targets).toContainEqual({ noteId: ID(3), targetPersonId: ID(9) });
  });

  it('existing Person without a name or company: blanks are filled', async () => {
    const h = baseHandlers();
    h['GET /rest/people'] = () => ({
      status: 200,
      body: { data: { people: [{ id: ID(9), name: { firstName: '', lastName: '' }, emails: { primaryEmail: EMAIL }, companyId: null }] } },
    });
    const { sync, calls } = setup(h);
    sync.enqueue(lead(), entry());
    await sync.drain(1_000);
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe(`/rest/people/${ID(9)}`);
    expect(patch?.body).toEqual({ name: { firstName: 'Jo', lastName: 'Anne Bloggs' }, companyId: ID(2) });
  });

  it('Company only on a matching, non-free-mail domain; found company is reused', async () => {
    const h = baseHandlers();
    h['GET /rest/companies'] = () => ({ status: 200, body: { data: { companies: [{ id: ID(6), domainName: { primaryLinkUrl: 'acme.example' } }] } } });
    const { sync, calls } = setup(h);
    sync.enqueue(lead(), entry());
    sync.enqueue(lead({ email: 'jo@gmail.com', emailHash: 'e'.repeat(32) }), entry());
    await sync.drain(1_000);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/rest/companies')).toBe(false);
    const people = calls.filter((c) => c.method === 'POST' && c.path === '/rest/people').map((c) => c.body as Record<string, unknown>);
    expect(people[0]).toMatchObject({ companyId: ID(6) });
    expect(people[1]).not.toHaveProperty('companyId');
    const targets = calls.filter((c) => c.path === '/rest/noteTargets').map((c) => c.body);
    expect(targets).toContainEqual({ noteId: ID(3), targetCompanyId: ID(6) });
    expect(targets.filter((t) => (t as Record<string, unknown>).targetCompanyId)).toHaveLength(1);
  });

  it('creates the Company (name = domain) when none matches', async () => {
    const { sync, calls } = setup(baseHandlers());
    sync.enqueue(lead({ email: 'jo@uk.acme.example' }), entry());
    await sync.drain(1_000);
    expect(calls.find((c) => c.method === 'POST' && c.path === '/rest/companies')?.body).toEqual({
      name: 'acme.example',
      domainName: { primaryLinkUrl: 'https://acme.example' },
    });
  });

  it.each([400, 403])('company lookup %i → Person and Note still created, Note linked to the Person only', async (status) => {
    const h = baseHandlers();
    h['GET /rest/companies'] = () => ({ status });
    const { sync, calls, logs } = setup(h);
    sync.enqueue(lead(), entry());
    expect(await sync.drain(1_000)).toBe(0);
    expect(calls.some((c) => c.method === 'POST' && c.path === '/rest/companies')).toBe(false);
    const person = calls.find((c) => c.method === 'POST' && c.path === '/rest/people');
    expect(person?.body).not.toHaveProperty('companyId');
    expect(calls.filter((c) => c.path === '/rest/notes')).toHaveLength(1);
    expect(calls.filter((c) => c.path === '/rest/noteTargets').map((c) => c.body)).toEqual([{ noteId: ID(3), targetPersonId: ID(1) }]);
    expect(logs.entries).toContainEqual({ level: 'warn', msg: 'crm step failed', extra: { emailHash: HASH.slice(0, 12), domain: 'acme.example', step: 'company', status } });
    expect(logs.entries.at(-1)).toMatchObject({ msg: 'crm synced', extra: { company: false } });
  });

  it('company create failing → carries on without the Company', async () => {
    const h = baseHandlers();
    h['POST /rest/companies'] = () => ({ status: 403 });
    const { sync, calls } = setup(h);
    sync.enqueue(lead(), entry());
    await sync.drain(1_000);
    expect(calls.filter((c) => c.path === '/rest/noteTargets').map((c) => c.body)).toEqual([{ noteId: ID(3), targetPersonId: ID(1) }]);
  });

  it('a failed note link is retried on its own: one Note, no duplicate targets', async () => {
    const h = baseHandlers();
    let n = 0;
    h['POST /rest/noteTargets'] = (c) => {
      // Person link ok; the first company link attempt fails with a 503.
      if ((c.body as Record<string, unknown>).targetCompanyId && ++n === 1) return { status: 503 };
      return { status: 201, body: { data: { createNoteTarget: { id: ID(4) } } } };
    };
    const { sync, calls, sleeps } = setup(h);
    sync.enqueue(lead(), entry());
    await sync.drain(1_000);
    expect(sleeps).toEqual([2_000]);
    expect(calls.filter((c) => c.path === '/rest/notes')).toHaveLength(1);
    const targets = calls.filter((c) => c.path === '/rest/noteTargets').map((c) => c.body);
    expect(targets).toEqual([
      { noteId: ID(3), targetPersonId: ID(1) },
      { noteId: ID(3), targetCompanyId: ID(2) },
      { noteId: ID(3), targetCompanyId: ID(2) },
    ]);
  });

  it('429 → retry → ok; 400 → no retry, logged with status only', async () => {
    const h = baseHandlers();
    let n = 0;
    h['GET /rest/people'] = () => (++n === 1 ? { status: 429 } : { status: 200, body: { data: { people: [] } } });
    const a = setup(h);
    a.sync.enqueue(lead(), entry());
    await a.sync.drain(1_000);
    expect(a.sleeps).toEqual([2_000]);
    expect(a.calls.some((c) => c.path === '/rest/notes')).toBe(true);

    const h2 = baseHandlers();
    h2['POST /rest/people'] = () => ({ status: 400, body: { error: `duplicate ${EMAIL}` } });
    const b = setup(h2);
    b.sync.enqueue(lead(), entry());
    await b.sync.drain(1_000);
    expect(b.sleeps).toEqual([]);
    expect(b.calls.filter((c) => c.method === 'POST' && c.path === '/rest/people')).toHaveLength(1);
    expect(b.calls.some((c) => c.path === '/rest/notes')).toBe(false);
    expect(b.logs.entries).toContainEqual({ level: 'warn', msg: 'crm step failed', extra: { emailHash: HASH.slice(0, 12), domain: 'acme.example', step: 'person', status: 400 } });
  });

  it('5xx and network failures retry with 2 s / 10 s / 60 s, then give up', async () => {
    const h = baseHandlers();
    h['POST /rest/notes'] = () => {
      throw new Error('ECONNRESET');
    };
    const { sync, sleeps, logs } = setup(h);
    sync.enqueue(lead(), entry());
    await sync.drain(1_000);
    expect(sleeps).toEqual([2_000, 10_000, 60_000]);
    expect(logs.entries.at(-1)).toMatchObject({ msg: 'crm step failed', extra: { step: 'note', status: 'network' } });
  });

  it('jobs run one at a time, in order', async () => {
    const h = baseHandlers();
    let inFlight = 0;
    let maxInFlight = 0;
    h['GET /rest/people'] = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { status: 200, body: { data: { people: [] } } };
    };
    const { sync, calls } = setup(h);
    for (let i = 0; i < 3; i++) sync.enqueue(lead({ email: `p${i}@acme.example`, emailHash: String(i).repeat(32) }), entry());
    expect(await sync.drain(2_000)).toBe(0);
    expect(maxInFlight).toBe(1);
    const created = calls.filter((c) => c.method === 'POST' && c.path === '/rest/people').map((c) => (c.body as { emails: { primaryEmail: string } }).emails.primaryEmail);
    expect(created).toEqual(['p0@acme.example', 'p1@acme.example', 'p2@acme.example']);
  });

  it('the queue bound drops the oldest waiting job', async () => {
    const h = baseHandlers();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h['GET /rest/people'] = async () => {
      await gate;
      return { status: 200, body: { data: { people: [] } } };
    };
    const { sync, calls, logs } = setup(h, { maxQueue: 2 });
    for (let i = 0; i < 4; i++) sync.enqueue(lead({ email: `p${i}@acme.example`, emailHash: String(i).repeat(32) }), entry());
    // p0 is running; p1 was dropped when p3 arrived; p2 and p3 wait.
    release();
    await sync.drain(2_000);
    const created = calls.filter((c) => c.method === 'POST' && c.path === '/rest/people').map((c) => (c.body as { emails: { primaryEmail: string } }).emails.primaryEmail);
    expect(created).toEqual(['p0@acme.example', 'p2@acme.example', 'p3@acme.example']);
    expect(logs.entries.some((e) => e.msg === 'crm queue full, dropped oldest')).toBe(true);
  });

  it('dedupes the same email and domain within 24 h', async () => {
    const { sync, calls } = setup(baseHandlers());
    sync.enqueue(lead(), entry());
    sync.enqueue(lead(), entry());
    await sync.drain(1_000);
    expect(calls.filter((c) => c.path === '/rest/notes')).toHaveLength(1);
  });

  it('drain reports jobs left undone', async () => {
    const h = baseHandlers();
    h['GET /rest/people'] = () => new Promise(() => undefined);
    const { sync } = setup(h);
    sync.enqueue(lead(), entry());
    sync.enqueue(lead({ emailHash: 'c'.repeat(32) }), entry());
    expect(await sync.drain(20)).toBe(2);
  });

  it('captured logs never contain the email, the name or a Twenty response body', async () => {
    const h = baseHandlers();
    h['POST /rest/notes'] = () => ({ status: 422, body: { message: `bad note for ${EMAIL}` } });
    const { sync, logs } = setup(h);
    sync.enqueue(lead(), entry());
    await sync.drain(1_000);
    const text = logs.text();
    expect(text).toContain(HASH.slice(0, 12));
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain('jo.bloggs');
    expect(text).not.toContain('Bloggs');
    expect(text).not.toContain(HASH); // only the 12-hex prefix
  });
});

describe('Note summary', () => {
  it('contains scores, verdict, fix lines, idea titles, consent and the unverified notice', () => {
    const { title, markdown } = buildNote({ lead: lead({ marketingOptIn: true }), report: report(), buyerFit: bfResult(), ai: aiResult() });
    expect(title).toBe('Website audit: acme.example');
    expect(markdown).toContain('**Audited URL:** <https://acme.example/>');
    expect(markdown).toContain('2026-11-20');
    expect(markdown).toContain('62/100');
    expect(markdown).toContain('Clear offer, light on proof.');
    expect(markdown).toContain('**Security:** 71/100');
    expect(markdown).toContain('**Website health:** 64/100');
    expect(markdown).toContain('- Name a client on the homepage');
    expect(markdown).toContain('- No HSTS header.');
    expect(markdown).toContain('- Faster invoice processing (AI Automation) \\[site\\]');
    expect(markdown).toContain('Email not verified');
    expect(markdown).toContain('Marketing opt-in: yes (notice v1, 2026-11-20T10:00:00.000Z)');
    expect(markdown).toContain('Source: audit widget');
    expect(markdown).toContain(`Booking link shown: ${CTA.consultation.url}`);
    expect(markdown).not.toContain(EMAIL);
  });

  it('audited URL is an autolink; site-derived lines are markdown-escaped', () => {
    const r = report({
      url: 'https://acme.example/a b><img src=x>',
      security: { score: 71, checks: [{ id: 'sec-hsts', status: 'fail', detail: '[click](https://evil.example) **now** <b>' }] },
    });
    const { markdown } = buildNote({ lead: lead(), report: r, buyerFit: null, ai: null });
    expect(markdown).toContain('**Audited URL:** <https://acme.example/a%20b%3E%3Cimg%20src=x%3E>');
    expect(markdown).toContain('- \\[click\\]\\(https://evil.example\\) \\*\\*now\\*\\* \\<b\\>');
    expect(markdown).not.toContain('[click](');
  });

  it('"AI ideas: not run" when AI was off; measured fix lines; [Test] prefix', () => {
    const r = report({ aiStatus: 'unavailable', buyerFitStatus: 'unavailable' });
    const { title, markdown } = buildNote({ lead: lead({ test: true }), report: r, buyerFit: null, ai: null });
    expect(title).toBe('[Test] Website audit: acme.example');
    expect(markdown).toContain('**AI ideas:** not run');
    expect(markdown).toContain('**Buyer fit:** not run');
    expect(markdown).toContain('- Meta description missing.');
    expect(markdown).toContain('Marketing opt-in: no');
  });

  it('helpers: company domain rule and name split', () => {
    expect(companyDomainFor('jo@acme.example', 'acme.example')).toBe('acme.example');
    expect(companyDomainFor('jo@uk.acme.example', 'acme.example')).toBe('acme.example');
    expect(companyDomainFor('jo@acme.example', 'shop.acme.example')).toBe('shop.acme.example');
    expect(companyDomainFor('jo@gmail.com', 'gmail.com')).toBeNull();
    expect(companyDomainFor('jo@agency.example', 'client.example')).toBeNull();
    expect(companyDomainFor('jo@notacme.example', 'acme.example')).toBeNull();
    expect(splitName(undefined)).toEqual({ firstName: '', lastName: '' });
    expect(splitName(' Cher ')).toEqual({ firstName: 'Cher', lastName: '' });
  });
});

describe('twenty:check', () => {
  const run = (handlers: Record<string, Handler>) => {
    const tw = fakeTwenty(handlers);
    const client = createTwentyClient({ apiUrl: 'https://api.twenty.example', apiKey: 'secret-key', fetchImpl: tw.fetchImpl });
    return { ...tw, result: runTwentyCheck(client, 'https://api.twenty.example') };
  };

  it('three GETs only, OK with counts; no emails, record data or key in the output', async () => {
    const { calls, result } = run({
      'GET /rest/people': (c) =>
        c.query.get('filter')
          ? { status: 200, body: { data: { people: [] } } }
          : { status: 200, body: { data: { people: [{ id: ID(1), name: { firstName: 'Secret' }, emails: { primaryEmail: 'boss@client.example' }, companyId: null }] } } },
      'GET /rest/companies': () => ({ status: 200, body: { data: { companies: [{ id: ID(2), name: 'Hidden Co', domainName: { primaryLinkUrl: 'https://hidden.example' } }] } } }),
    });
    const { ok, lines } = await result;
    expect(ok).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
    expect(calls[1]!.query.get('filter')).toContain(PROBE_EMAIL);
    expect(calls[2]!.query.get('filter')).toContain(PROBE_DOMAIN);
    expect(lines).toEqual([
      'OK list people: https://api.twenty.example accepted the key (1 record returned).',
      'OK find person by email (0 matches).',
      'OK find company by domain (0 matches).',
    ]);
    const text = lines.join('\n');
    for (const leak of ['boss@client.example', 'Secret', 'Hidden Co', 'hidden.example', 'secret-key', ID(1), ID(2)]) expect(text).not.toContain(leak);
  });

  it('warns when a Person record has no companyId key', async () => {
    const { result } = run({
      'GET /rest/people': () => ({ status: 200, body: { data: { people: [{ id: ID(1) }] } } }),
      'GET /rest/companies': () => ({ status: 200, body: { data: { companies: [] } } }),
    });
    const { ok, lines } = await result;
    expect(ok).toBe(true);
    expect(lines[1]).toMatch(/^WARN list people: the Person record has no companyId key/);
  });

  it('reports each failed call with its status and a hint', async () => {
    const { result } = run({
      'GET /rest/people': (c) => (c.query.get('filter') ? { status: 400 } : { status: 200, body: { data: { people: [] } } }),
      'GET /rest/companies': () => ({ status: 403 }),
    });
    const { ok, lines } = await result;
    expect(ok).toBe(false);
    expect(lines[0]).toBe('OK list people: https://api.twenty.example accepted the key (0 records returned).');
    expect(lines[1]).toMatch(/^FAILED find person by email \(400\): /);
    expect(lines[2]).toMatch(/^FAILED find company by domain \(403\): .*role/);
  });
});

describe('Note summary (Amendment 4)', () => {
  const aiWithIndustry = (): AiResult => {
    const ai = sampleAi();
    return {
      auditId: 'A'.repeat(22),
      aiStatus: 'ok',
      ai: {
        ...ai,
        industry: { id: 'accounting', label: 'Accounting', inferred: true },
        opportunities: [
          ...ai.opportunities,
          { ...ai.opportunities[0]!, title: 'Chasing client records', source: 'industry' },
        ],
      },
    };
  };

  it('adds industry, answers, source tags and the cost line', () => {
    const { markdown } = buildNote({
      lead: lead(),
      report: report(),
      buyerFit: null,
      ai: aiWithIndustry(),
      request: { url: 'acme.example', businessType: 'Bookkeeping firm', teamSize: '11-50', region: 'uk-ireland', tools: 'Xero, spreadsheets', timeSink: 'Receipts' },
      costUsd: 0.0421,
    });
    expect(markdown).toContain('**Industry:** Accounting (inferred)');
    expect(markdown).toContain('**Business type:** Bookkeeping firm');
    expect(markdown).toContain('**Team size:** 11-50');
    expect(markdown).toContain('**Based in:** UK and Ireland');
    expect(markdown).toContain('**Tools:** Xero, spreadsheets');
    expect(markdown).toContain('**What eats the week:** Receipts');
    expect(markdown).toContain('- Faster invoice processing (AI Automation) \\[site\\]');
    expect(markdown).toContain('- Chasing client records (AI Automation) \\[industry\\]');
    expect(markdown).toContain('AI cost (est.): $0.04');
  });

  it("industry falls back to the visitor's choice (given); no cost line when unknown", () => {
    const { markdown } = buildNote({ lead: lead(), report: report(), buyerFit: null, ai: null, request: { url: 'x', industry: 'legal' }, costUsd: null });
    expect(markdown).toContain('**Industry:** Legal (given)');
    expect(markdown).not.toContain('AI cost');
    expect(markdown).not.toContain('**Tools:**');
    expect(markdown).not.toContain('**Based in:**');
  });

  it('visitor answers are markdown-escaped and capped', () => {
    const { markdown } = buildNote({
      lead: lead(),
      report: report(),
      buyerFit: null,
      ai: null,
      request: { url: 'x', tools: '[x](https://evil.example) # heading', timeSink: `${'long '.repeat(80)}` },
    });
    expect(markdown).toContain('**Tools:** \\[x\\]\\(https://evil.example\\) \\# heading');
    expect(markdown).not.toContain('[x](');
    const sink = markdown.split('\n').find((l) => l.startsWith('**What eats the week:**'))!;
    expect(sink.length).toBeLessThanOrEqual(230);
  });

  it('sync passes the entry answers and settled cost into the note', async () => {
    const { sync, calls } = setup(baseHandlers());
    sync.enqueue(
      lead(),
      entry({
        ai: Promise.resolve(aiWithIndustry()),
        request: { url: 'acme.example', tools: 'Xero' },
        aiCost: Promise.resolve({ calls: 3, input: 1, output: 1, thinking: 0, cost_usd: 0.031 }),
      }),
    );
    await sync.drain(1_000);
    const note = calls.find((c) => c.method === 'POST' && c.path === '/rest/notes')!.body as Record<string, unknown>;
    const text = JSON.stringify(note);
    expect(text).toContain('**Tools:** Xero');
    expect(text).toContain('AI cost (est.): $0.03');
    expect(text).toContain('\\\\[industry\\\\]');
  });

  it('a cache hit omits the cost line (the cost was paid by the original run)', async () => {
    const { sync, calls } = setup(baseHandlers());
    sync.enqueue(
      lead(),
      entry({
        ai: Promise.resolve(aiWithIndustry()),
        aiCost: Promise.resolve({ calls: 3, input: 1, output: 1, thinking: 0, cost_usd: 0.031 }),
      }),
      { cacheHit: true },
    );
    await sync.drain(1_000);
    const note = calls.find((c) => c.method === 'POST' && c.path === '/rest/notes')!.body as Record<string, unknown>;
    const text = JSON.stringify(note);
    expect(text).toContain('**AI ideas**');
    expect(text).not.toContain('AI cost');
  });
});
