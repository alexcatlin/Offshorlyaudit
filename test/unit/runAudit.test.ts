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
