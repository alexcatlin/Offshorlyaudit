// Amendment 5 Phase 5 in the orchestrator and the app: search runs inside the opportunities
// promise only, never delays the measured report, and the search-off path is unchanged.
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiSection, AuditStartResponse } from '../../shared/types.js';
import type { AiEngine } from '../../server/audit/aiEngine.js';
import { fixtureEngine } from '../../server/audit/aiEngine.js';
import { runAudit } from '../../server/audit/runAudit.js';
import type { OpportunitiesInput } from '../../server/ai/types.js';
import { buildApp } from '../../server/app.js';
import { MemoryFeedbackStore } from '../../server/feedback/store.js';
import { createFixtureSearchProvider } from '../../server/search/fixture.js';
import { createIndustryResearch } from '../../server/search/industryResearch.js';
import type { IndustryResearch } from '../../server/search/industryResearch.js';
import type { SearchProvider } from '../../server/search/types.js';
import { appConfig, appDeps, auditDeps, homeHtml, ORIGIN, sampleBuyerFit, siteRoutes } from './_appMock.js';

/** An engine that records the opportunities input and answers at once. */
const recordingEngine = () => {
  const inputs: OpportunitiesInput[] = [];
  const ai: AiSection = { business: { summary: 'S.', customers: 'b2b' }, opportunities: [], notWorthIt: 'N.' };
  const engine: AiEngine = {
    mode: 'live',
    buyerFit: async () => sampleBuyerFit(),
    opportunities: async (input) => {
      inputs.push(input);
      return { status: 'insufficient', ai };
    },
  };
  return { engine, inputs };
};

const hangingProvider = (): SearchProvider => ({ name: 'serpapi', search: () => new Promise(() => undefined) });

describe('runAudit with search', () => {
  it('search off: the opportunities input has no research (unchanged path)', async () => {
    const e = recordingEngine();
    const run = await runAudit({ url: 'acme.example', industry: 'accounting' }, auditDeps(siteRoutes(), { ai: e.engine }));
    await run.ai;
    expect(e.inputs).toHaveLength(1);
    expect('research' in e.inputs[0]!).toBe(false);
  });

  it("visitor's industry → the research is for it; results arrive in the input", async () => {
    const e = recordingEngine();
    const research = await createIndustryResearch({ provider: createFixtureSearchProvider(), ttlDays: 7, dailyMax: 10 });
    const run = await runAudit({ url: 'acme.example', industry: 'legal', businessType: 'Acme special firm' }, auditDeps(siteRoutes(), { ai: e.engine, research }));
    await run.ai;
    const r = e.inputs[0]!.research!;
    expect(r).toMatchObject({ industryId: 'legal', cache: 'miss' });
    expect(r.sources.map((s) => s.id)).toEqual(['S1', 'S2', 'S3']);
  });

  it('no industry given: the keyword guess from the pages picks it (two accounting phrases), or null on one phrase', async () => {
    const guessFor = async (routes: ReturnType<typeof siteRoutes>) => {
      const seen: (string | null)[] = [];
      const research: IndustryResearch = {
        provider: 'fixture',
        forAudit: async (id, { auditedDomain }) => {
          seen.push(id, auditedDomain);
          return { industryId: id, cache: 'none', searchedAt: null, sources: [] };
        },
        list: () => [],
        close: async () => undefined,
      };
      const run = await runAudit({ url: 'acme.example' }, auditDeps(routes, { ai: recordingEngine().engine, research }));
      await run.ai;
      return seen;
    };
    const twoPhrases = homeHtml('acme.example').replace(
      '<h1>Bookkeeping for small firms</h1>',
      '<h1>Bookkeeping and payroll bureau for small firms</h1>',
    );
    expect(await guessFor(siteRoutes('acme.example', { body: twoPhrases }))).toEqual(['accounting', 'acme.example']);
    // The stock mock site only ever says "bookkeeping": one phrase, so no guess.
    expect(await guessFor(siteRoutes())).toEqual([null, 'acme.example']);
  });

  it('a hanging search does not delay the measured report; the model is called after the wait without results', async () => {
    const e = recordingEngine();
    const research = await createIndustryResearch({ provider: hangingProvider(), ttlDays: 7, dailyMax: 10, waitMs: 4_000 });
    const t = Date.now();
    const run = await runAudit({ url: 'acme.example', industry: 'legal' }, auditDeps(siteRoutes(), { ai: e.engine, research }));
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(run.report.aiStatus).toBe('pending');
    expect(e.inputs).toHaveLength(0);

    const quick = await createIndustryResearch({ provider: hangingProvider(), ttlDays: 7, dailyMax: 10, waitMs: 30 });
    const e2 = recordingEngine();
    const run2 = await runAudit({ url: 'acme.example', industry: 'legal' }, auditDeps(siteRoutes(), { ai: e2.engine, research: quick }));
    await run2.ai;
    expect(e2.inputs[0]!.research).toMatchObject({ cache: 'timeout', sources: [] });
  });

  it('a research failure never fails the analysis', async () => {
    const e = recordingEngine();
    const research: IndustryResearch = {
      provider: 'serpapi',
      forAudit: async () => {
        throw new Error('boom');
      },
      list: () => [],
      close: async () => undefined,
    };
    const run = await runAudit({ url: 'acme.example', industry: 'legal' }, auditDeps(siteRoutes(), { ai: e.engine, research }));
    expect((await run.ai)?.aiStatus).toBe('insufficient');
    expect('research' in e.inputs[0]!).toBe(false);
  });
});

describe('app with search (fixture provider + fixture AI)', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  const build = async (feedback = new MemoryFeedbackStore(), adminToken: string | null = null) => {
    const research = await createIndustryResearch({ provider: createFixtureSearchProvider(), ttlDays: 7, dailyMax: 10 });
    const base = appDeps();
    return buildApp({
      ...base,
      audit: { ...base.audit, ai: fixtureEngine(), research },
      feedback,
      config: appConfig({ rateLimitHourly: 100, rateLimitDaily: 1000, adminToken }),
    });
  };

  it('/healthz search true; the AI result carries one example, a source basis and the research disclosure', async () => {
    app = await build();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({ search: true, mail: false });
    const res = await app.inject({ method: 'POST', url: '/api/audit', headers: ORIGIN, payload: { url: 'acme.example', email: 'x1@mail.example', industry: 'accounting' } });
    const start = res.json<AuditStartResponse>();
    const ai = (await app.inject({ method: 'GET', url: `/api/audit/${start.auditId}/ai`, headers: ORIGIN })).json<{ ai: AiSection }>().ai;
    expect(ai.industryExamples).toHaveLength(1);
    expect(ai.industryExamples![0]!.sources[0]!.url).toBe('https://example.com/sample-article');
    expect(ai.research).toMatchObject({ industryId: 'accounting', label: 'Accounting' });
    expect(ai.opportunities.some((o) => o.basis.some((b) => b.kind === 'source'))).toBe(true);
  });

  it('feedback lines count cited sources in `ex`', async () => {
    const feedback = new MemoryFeedbackStore();
    app = await build(feedback);
    const res = await app.inject({ method: 'POST', url: '/api/audit', headers: ORIGIN, payload: { url: 'acme.example', email: 'x2@mail.example', industry: 'accounting' } });
    const start = res.json<AuditStartResponse>();
    const ai = (await app.inject({ method: 'GET', url: `/api/audit/${start.auditId}/ai`, headers: ORIGIN })).json<{ ai: AiSection }>().ai;
    const idx = ai.opportunities.findIndex((o) => o.basis.some((b) => b.kind === 'source'));
    await app.inject({ method: 'POST', url: '/api/feedback', headers: ORIGIN, payload: { session: start.session, ideaIndex: idx, vote: 'up' } });
    expect(feedback.list()[0]!.ex).toBe(1);
  });

  it('GET /api/admin/research lists cached results (admin token only)', async () => {
    const token = 'admin-token-0123456789abcdefghijklmnop';
    app = await build(new MemoryFeedbackStore(), token);
    await app.inject({ method: 'POST', url: '/api/audit', headers: ORIGIN, payload: { url: 'acme.example', email: 'x3@mail.example', industry: 'legal' } });
    // Research runs inside the AI promise; wait for it.
    await new Promise((r) => setTimeout(r, 20));
    expect((await app.inject({ method: 'GET', url: '/api/admin/research' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/api/admin/research', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ provider: 'fixture', entries: [{ industryId: 'legal' }] });
  });

  it('search off: /healthz search false and no research block', async () => {
    app = await buildApp(appDeps());
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({ search: false });
  });
});
