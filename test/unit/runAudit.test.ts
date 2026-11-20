import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiEngine } from '../../server/audit/aiEngine.js';
import { AI_SLOT_HOLD_MS, AiSlotTimeoutError, limitAiConcurrency } from '../../server/audit/aiEngine.js';
import { Semaphore } from '../../server/http/limits.js';
import { runAudit, validateAuditRequest } from '../../server/audit/runAudit.js';
import { SiteReadError } from '../../server/site/errors.js';
import { auditDeps, controlledEngine, sampleAi, sampleBuyerFit, siteRoutes, thinRoutes } from './_appMock.js';

const ALLOWED_PATHS = new Set(['/', '/services/', '/about/', '/robots.txt', '/sitemap.xml']);

describe('validateAuditRequest', () => {
  it('normalises and trims; blanks are dropped', () => {
    const r = validateAuditRequest({ url: ' acme.example ', businessType: '  ', persona: { role: 'Owner', size: '' }, teamSize: '', timeSink: ' quotes ' });
    expect(r).toEqual({ ok: true, value: { url: 'acme.example', persona: { role: 'Owner' }, timeSink: 'quotes' } });
  });

  it('an answer that is only redacted emails is treated as blank; mixed text keeps the placeholder', () => {
    const r = validateAuditRequest({ url: 'a.example', timeSink: ' jo@acme.example ', tools: 'a@b.co, c@d.co', businessType: 'Letting agent jo@acme.example' });
    expect(r).toEqual({ ok: true, value: { url: 'a.example', businessType: 'Letting agent [email removed]' } });
  });

  it('rejects bad shapes and overlong fields', () => {
    expect(validateAuditRequest(null).ok).toBe(false);
    expect(validateAuditRequest([]).ok).toBe(false);
    expect(validateAuditRequest({}).ok).toBe(false);
    expect(validateAuditRequest({ url: 5 }).ok).toBe(false);
    expect(validateAuditRequest({ url: `a.example/${'x'.repeat(500)}` }).ok).toBe(false);
    expect(validateAuditRequest({ url: 'a.example', teamSize: '7' }).ok).toBe(false);
    expect(validateAuditRequest({ url: 'a.example', timeSink: 'x'.repeat(201) }).ok).toBe(false);
    expect(validateAuditRequest({ url: 'a.example', persona: 'founder' }).ok).toBe(false);
    expect(validateAuditRequest({ url: 'a.example', persona: { trigger: 'x'.repeat(301) } }).ok).toBe(false);
  });
});

describe('runAudit', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the measured report with both AI parts pending, and only allowed fetches', async () => {
    const c = controlledEngine();
    const deps = auditDeps(siteRoutes(), { ai: c.engine });
    const run = await runAudit({ url: 'acme.example' }, deps);
    const r = run.report;
    expect(r.aiStatus).toBe('pending');
    expect(r.buyerFitStatus).toBe('pending');
    expect(r.ai).toBeUndefined();
    expect(r.auditId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(r.domain).toBe('acme.example');
    expect(r.pagesRead.map((p) => p.label)).toEqual(['Home', 'Services', 'About']);
    expect(r.security.score).not.toBeNull();
    expect(r.health.score).not.toBeNull();
    expect(r.security.checks.some((c) => c.id === 'sec-hsts' && c.status === 'pass')).toBe(true);
    expect(r.stack.map((t) => t.id)).toContain('hubspot');
    expect(r.fixFirst.every((f) => f.source === 'check')).toBe(true);
    expect(r.fixFirst.length).toBeLessThanOrEqual(5);
    for (const u of deps.calls) expect(ALLOWED_PATHS.has(new URL(u).pathname)).toBe(true);

    c.bf.resolve(sampleBuyerFit([{ text: 'Name a client', horizon: 'now', impact: 'high', effort: 'low', owner: 'marketing' }]));
    c.ai.resolve({ status: 'ok', ai: sampleAi() });
    const [bf, ai] = await Promise.all([run.buyerFit, run.ai]);
    expect(bf).toMatchObject({ auditId: r.auditId, buyerFitStatus: 'ok' });
    expect(bf!.fixFirst[0]).toEqual({ source: 'ai', section: 'buyer-fit', actionIndex: 0 });
    expect(ai).toMatchObject({ auditId: r.auditId, aiStatus: 'ok' });
    expect(ai!.ai!.opportunities).toHaveLength(1);
  });

  it('maps AI failures to unavailable without failing the audit or leaking rejections', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const engine: AiEngine = {
      mode: 'live',
      buyerFit: () => Promise.reject(new Error('boom')),
      opportunities: () => Promise.reject(Object.assign(new Error('overloaded'), { code: 'overloaded' })),
    };
    const log = vi.fn();
    const run = await runAudit({ url: 'acme.example' }, auditDeps(siteRoutes(), { ai: engine, log }));
    const [bf, ai] = await Promise.all([run.buyerFit, run.ai]);
    expect(bf).toEqual({ auditId: run.report.auditId, buyerFitStatus: 'unavailable', fixFirst: run.report.fixFirst });
    expect(ai).toEqual({ auditId: run.report.auditId, aiStatus: 'unavailable' });
    expect(log).toHaveBeenCalledWith('opportunities failed', expect.objectContaining({ error: 'overloaded' }));
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('thin site: measured only, both AI parts thin, no promises', async () => {
    const c = controlledEngine();
    const run = await runAudit({ url: 'thin.example' }, auditDeps(thinRoutes(), { ai: c.engine }));
    expect(run.report.aiStatus).toBe('thin');
    expect(run.report.buyerFitStatus).toBe('thin');
    expect(run.buyerFit).toBeNull();
    expect(run.ai).toBeNull();
    expect(c.calls()).toBe(0);
    expect(run.report.security.score).not.toBeNull();
  });

  it('AI off or over the daily cap → unavailable straight away', async () => {
    const off = await runAudit({ url: 'acme.example' }, auditDeps(siteRoutes(), { ai: null }));
    expect([off.report.aiStatus, off.report.buyerFitStatus, off.ai, off.buyerFit]).toEqual(['unavailable', 'unavailable', null, null]);
    const c = controlledEngine();
    const capped = await runAudit({ url: 'acme.example' }, auditDeps(siteRoutes(), { ai: c.engine, takeAiQuota: () => false }));
    expect(capped.report.aiStatus).toBe('unavailable');
    expect(c.calls()).toBe(0);
  });

  it('fixture engine marks the report and results as fixture', async () => {
    const run = await runAudit({ url: 'acme.example' }, auditDeps(siteRoutes()));
    expect(run.report.fixture).toBe(true);
    const [bf, ai] = await Promise.all([run.buyerFit, run.ai]);
    expect(bf).toMatchObject({ buyerFitStatus: 'fixture', fixture: true });
    expect(ai).toMatchObject({ aiStatus: 'fixture', fixture: true });
  });

  it('omits and flags measured parts that miss the deadline', async () => {
    const routes = siteRoutes();
    routes['https://acme.example/robots.txt'] = { ...routes['https://acme.example/robots.txt'], delayMs: 2_000 };
    const run = await runAudit({ url: 'acme.example' }, auditDeps(routes, { ai: null, measuredDeadlineMs: 300 }));
    expect(run.report.omitted).toEqual(['site-files']);
    const ids = [...run.report.security.checks, ...run.report.health.checks].map((c) => c.id);
    expect(ids).not.toContain('sec-redirect');
    expect(ids).not.toContain('seo-sitemap');
    expect(ids).not.toContain('geo-bots');
    expect(ids).toContain('sec-https');
  });

  it('throws SiteReadError for refused and missing sites', async () => {
    await expect(runAudit({ url: 'http://127.0.0.1' }, auditDeps({}))).rejects.toMatchObject({ code: 'not_found' });
    const refused = auditDeps({ 'https://blocked.example/': { status: 403, body: 'no' } });
    await expect(runAudit({ url: 'blocked.example' }, refused)).rejects.toBeInstanceOf(SiteReadError);
    await expect(runAudit({ url: 'blocked.example' }, refused)).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('enforces the read budget', async () => {
    const slow = auditDeps({ 'https://slow.example/': { delayMs: 1_000, body: '<html></html>' } }, { readBudgetMs: 100 });
    await expect(runAudit({ url: 'slow.example' }, slow)).rejects.toMatchObject({ code: 'unreadable' });
  });
});

describe('AI slots (limitAiConcurrency + runAudit)', () => {
  afterEach(() => vi.useRealTimers());

  it('reserves both slots for an audit in one step, all or nothing', () => {
    const slots = new Semaphore(3);
    const engine = limitAiConcurrency(controlledEngine().engine, slots);
    const first = engine.reserve!();
    expect(first).not.toBeNull();
    expect(slots.inUse).toBe(2);
    expect(engine.reserve!()).toBeNull();
    expect(slots.inUse).toBe(2);
    first!.release();
    first!.release();
    expect(slots.inUse).toBe(0);
  });

  it('unreserved calls are refused, and each reserved analysis runs once', async () => {
    const slots = new Semaphore(2);
    const engine = limitAiConcurrency({ mode: 'live', buyerFit: async () => sampleBuyerFit(), opportunities: async () => ({ status: 'ok', ai: sampleAi() }) }, slots);
    await expect(engine.buyerFit({ pages: [] }, {})).rejects.toMatchObject({ code: 'ai_busy' });
    const r = engine.reserve!()!;
    await r.engine.buyerFit({ pages: [] }, {});
    expect(slots.inUse).toBe(1);
    await expect(r.engine.buyerFit({ pages: [] }, {})).rejects.toMatchObject({ code: 'ai_busy' });
    expect(slots.inUse).toBe(1);
  });

  it('releases each slot after its analysis fails', async () => {
    const slots = new Semaphore(2);
    const engine: AiEngine = {
      mode: 'live',
      buyerFit: () => Promise.reject(new Error('boom')),
      opportunities: () => {
        throw new Error('sync boom');
      },
    };
    const run = await runAudit({ url: 'acme.example' }, auditDeps(siteRoutes(), { ai: limitAiConcurrency(engine, slots) }));
    const [bf, ai] = await Promise.all([run.buyerFit, run.ai]);
    expect([bf!.buyerFitStatus, ai!.aiStatus]).toEqual(['unavailable', 'unavailable']);
    expect(slots.inUse).toBe(0);
  });

  it('releases each slot after a hung analysis times out (fake timers)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const slots = new Semaphore(2);
    const c = controlledEngine(); // never resolves
    const r = limitAiConcurrency(c.engine, slots).reserve!()!;
    const bf = r.engine.buyerFit({ pages: [] }, {});
    const opp = r.engine.opportunities({ pages: [], cms: { platform: 'unknown' }, stack: [], saasCount: 0 }, {});
    const settled = Promise.allSettled([bf, opp]);
    await vi.advanceTimersByTimeAsync(AI_SLOT_HOLD_MS - 1);
    expect(slots.inUse).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    const results = await settled;
    expect(results.map((x) => x.status)).toEqual(['rejected', 'rejected']);
    expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(AiSlotTimeoutError);
    expect(slots.inUse).toBe(0);
  });

  it('slots full → AI skipped, no daily quota taken, run flagged aiBusy', async () => {
    const slots = new Semaphore(1);
    const c = controlledEngine();
    const takeAiQuota = vi.fn(() => true);
    const run = await runAudit({ url: 'acme.example' }, auditDeps(siteRoutes(), { ai: limitAiConcurrency(c.engine, slots), takeAiQuota }));
    expect([run.report.aiStatus, run.report.buyerFitStatus, run.ai, run.buyerFit]).toEqual(['unavailable', 'unavailable', null, null]);
    expect(run.aiBusy).toBe(true);
    expect(takeAiQuota).not.toHaveBeenCalled();
    expect(c.calls()).toBe(0);
    expect(slots.inUse).toBe(0);
  });

  it('daily cap reached after reserving → both slots handed back', async () => {
    const slots = new Semaphore(2);
    const c = controlledEngine();
    const run = await runAudit({ url: 'acme.example' }, auditDeps(siteRoutes(), { ai: limitAiConcurrency(c.engine, slots), takeAiQuota: () => false }));
    expect(run.report.aiStatus).toBe('unavailable');
    expect(run.aiBusy).toBe(false);
    expect(slots.inUse).toBe(0);
    expect(c.calls()).toBe(0);
  });
});

describe('Amendment 4: request fields', () => {
  it('industry: valid kept, blank omitted, invalid → 400', () => {
    expect(validateAuditRequest({ url: 'a.example', industry: 'legal' })).toEqual({ ok: true, value: { url: 'a.example', industry: 'legal' } });
    expect(validateAuditRequest({ url: 'a.example', industry: '' })).toEqual({ ok: true, value: { url: 'a.example' } });
    expect(validateAuditRequest({ url: 'a.example', industry: null })).toEqual({ ok: true, value: { url: 'a.example' } });
    expect(validateAuditRequest({ url: 'a.example', industry: 'astrology' }).ok).toBe(false);
    expect(validateAuditRequest({ url: 'a.example', industry: 'other' }).ok).toBe(false);
    expect(validateAuditRequest({ url: 'a.example', industry: 3 }).ok).toBe(false);
  });

  it('tools: up to 150 characters; over → 400', () => {
    expect(validateAuditRequest({ url: 'a.example', tools: ` ${'x'.repeat(150)} ` })).toEqual({ ok: true, value: { url: 'a.example', tools: 'x'.repeat(150) } });
    expect(validateAuditRequest({ url: 'a.example', tools: 'x'.repeat(151) }).ok).toBe(false);
    expect(validateAuditRequest({ url: 'a.example', tools: 7 }).ok).toBe(false);
  });

  it('redacts email addresses from every free-text field', () => {
    const r = validateAuditRequest({
      url: 'a.example',
      businessType: 'Law firm jo@a.example',
      tools: 'Xero, ask sam@b.co.uk',
      timeSink: 'emails to x.y+z@c.org all day',
      persona: { role: 'CFO a@b.io', size: 'Big c@d.io', sector: 'Retail e@f.io', trigger: 'Growth g@h.io' },
    });
    expect(r.ok).toBe(true);
    const text = JSON.stringify(r.ok ? r.value : {});
    expect(text).not.toMatch(/@/);
    expect(text).toContain('[email removed]');
    // A field that was only an email is dropped (blank), not kept as a bare placeholder.
    expect(validateAuditRequest({ url: 'a.example', tools: 'jo@a.example' })).toEqual({ ok: true, value: { url: 'a.example' } });
  });
});

describe('Amendment 4: inputs reach both engines; one cost line', () => {
  it('passes business type, industry, tools, team size and time sink to opportunities, industry to buyer fit', async () => {
    const seen: { bf?: unknown; opp?: unknown } = {};
    const engine: AiEngine = {
      mode: 'live',
      buyerFit: async (input) => {
        seen.bf = input;
        return sampleBuyerFit();
      },
      opportunities: async (input) => {
        seen.opp = input;
        return { status: 'ok', ai: sampleAi() };
      },
    };
    const run = await runAudit(
      { url: 'acme.example', businessType: 'Bookkeeper', industry: 'accounting', tools: 'Xero', teamSize: '1-10', timeSink: 'Receipts' },
      auditDeps(siteRoutes(), { ai: engine, costLog: () => undefined }),
    );
    await Promise.all([run.buyerFit, run.ai]);
    expect(seen.opp).toMatchObject({ businessType: 'Bookkeeper', industry: 'accounting', tools: 'Xero', teamSize: '1-10', timeSink: 'Receipts' });
    expect(seen.bf).toMatchObject({ businessType: 'Bookkeeper', industry: 'accounting' });
    expect(run.request).toMatchObject({ industry: 'accounting', tools: 'Xero' });
  });

  it('ai_audit_cost fires once after both settle, with every attempt counted and no prose, answers or email', async () => {
    const lines: unknown[] = [];
    const engine: AiEngine = {
      mode: 'live',
      buyerFit: async (_i, _m, onUsage) => {
        onUsage?.({ input_tokens: 1000, output_tokens: 100 }, 'claude-sonnet-5-5');
        onUsage?.({ input_tokens: 2000, output_tokens: 200, thinking_tokens: 50 }, 'claude-sonnet-5-5');
        return sampleBuyerFit();
      },
      opportunities: async (_i, _m, onUsage) => {
        onUsage?.({ input_tokens: 3000, output_tokens: 300 }, 'claude-sonnet-5-5');
        throw new Error('model said something');
      },
    };
    const run = await runAudit(
      { url: 'acme.example', tools: 'Secret tools answer', timeSink: 'Secret week answer' },
      auditDeps(siteRoutes(), { ai: engine, costLog: (e) => lines.push(e) }),
    );
    const cost = await run.aiCost;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      msg: 'ai_audit_cost',
      auditId: run.report.auditId,
      domain: 'acme.example',
      calls: 3,
      input: 6000,
      output: 600,
      thinking: 50,
      cost_usd: 0.018,
    });
    expect(cost).toMatchObject({ calls: 3, cost_usd: 0.018 });
    const text = JSON.stringify(lines);
    expect(text).not.toMatch(/Secret|@|model said/);
  });

  it('no AI → no cost promise and no cost line', async () => {
    const lines: unknown[] = [];
    const run = await runAudit({ url: 'acme.example' }, auditDeps(siteRoutes(), { ai: null, costLog: (e) => lines.push(e) }));
    expect(run.aiCost).toBeNull();
    expect(lines).toEqual([]);
  });
});

describe('Amendment 4: cache key', async () => {
  const { cacheKey } = await import('../../server/routes/audit.js');
  const u = new URL('https://acme.example/');
  it('changes with industry or tools; blank equals absent', () => {
    const base = cacheKey({ url: 'x' }, u);
    expect(cacheKey({ url: 'x', industry: 'legal' }, u)).not.toBe(base);
    expect(cacheKey({ url: 'x', tools: 'Xero' }, u)).not.toBe(base);
    expect(cacheKey({ url: 'x', industry: 'legal' }, u)).not.toBe(cacheKey({ url: 'x', industry: 'property' }, u));
    // Validation drops blanks, so a blank never reaches the key; undefined and '' hash the same.
    expect(cacheKey({ url: 'x', tools: '' }, u)).toBe(base);
    const blank = validateAuditRequest({ url: 'x', industry: '', tools: '   ' });
    expect(blank.ok && cacheKey(blank.value, u)).toBe(base);
  });
});
