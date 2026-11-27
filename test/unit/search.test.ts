// Amendment 5 Phase 5: industry guess, research cache and result hygiene, and the SerpApi adapter
// against hand-written fixtures (no live search).
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INDUSTRIES, INDUSTRY_IDS } from '../../shared/industries.js';
import { DAY, HOUR, MINUTE } from '../../server/http/limits.js';
import { CLASSIFIER_EXCLUDED, guessIndustry, industryHits, industryMatches } from '../../server/search/classify.js';
import { createFixtureSearchProvider, FIXTURE_HITS } from '../../server/search/fixture.js';
import {
  cacheKey,
  cleanHits,
  createIndustryResearch,
  isBlockedHost,
  AUTH_PAUSE_MS,
  MAX_RESULTS,
  NEGATIVE_TTL_MS,
  NEGATIVE_TTLS_MS,
  NO_RESULTS_TTL_MS,
  QUERIES_VERSION,
  RESEARCH_WAIT_MS,
  reasonOf,
  SEARCH_TIMEOUT_MS,
  safeResultUrl,
  sourcesForAudit,
} from '../../server/search/industryResearch.js';
import type { ResearchLog } from '../../server/search/industryResearch.js';
import { createSerpApiProvider, parseSerpApi, SERPAPI_ENDPOINT } from '../../server/search/serpapi.js';
import type { SearchFetch } from '../../server/search/serpapi.js';
import { SearchError } from '../../server/search/types.js';
import type { SearchHit, SearchOptions, SearchProvider } from '../../server/search/types.js';
import type { FetchedPage } from '../../server/site/types.js';
import { SERPAPI_200_UNKNOWN_ERROR, SERPAPI_BAD_KEY, SERPAPI_NO_RESULTS, SERPAPI_OK, SERPAPI_RESULTS_WITH_ERROR } from '../fixtures/serpapi.js';

const page = (over: Partial<FetchedPage> = {}): FetchedPage => ({ url: 'https://a.example/', label: 'Homepage', title: '', description: '', text: '', ...over });

describe('guessIndustry', () => {
  it('top industry with ≥2 whole-word hits and strictly ahead', () => {
    const pages = [
      page({ title: 'Smith & Co Solicitors', description: 'A law firm in Leeds.', text: 'Our solicitors handle conveyancing.' }),
      page({ url: 'https://a.example/team/', title: 'Our legal services' }),
    ];
    expect(guessIndustry(pages)).toBe('legal');
    expect(industryHits(pages).get('legal')).toBeGreaterThanOrEqual(3);
  });

  it('null with one hit, a tie, or no hits', () => {
    expect(guessIndustry([page({ title: 'Solicitors' })])).toBeNull();
    expect(guessIndustry([page({ title: 'Solicitors and solicitors', text: 'hotel hotel' })])).toBeNull();
    expect(guessIndustry([page({ text: 'We make nice things.' })])).toBeNull();
    expect(guessIndustry([])).toBeNull();
  });

  it('whole words only, and only the first 3,000 text characters', () => {
    expect(guessIndustry([page({ text: 'hotels hotelier hotelling' })])).toBeNull();
    expect(guessIndustry([page({ text: `${'x '.repeat(1600)} hotel hotel hotel` })])).toBeNull();
    expect(guessIndustry([page({ text: 'hotel. Hotel! restaurant' })])).toBe('hospitality-travel');
  });

  it('needs hits from at least 2 different phrases: one phrase repeated never decides', () => {
    expect(guessIndustry([page({ title: 'Solicitors', text: 'solicitors solicitors solicitors' })])).toBeNull();
    expect(guessIndustry([page({ text: 'courier courier courier, same-day courier' })])).toBeNull();
    expect(guessIndustry([page({ text: 'saas saas saas' })])).toBeNull();
    expect(guessIndustry([page({ text: 'Haulage and warehousing; courier work too.' })])).toBe('logistics');
    expect(guessIndustry([page({ title: 'Acme, a SaaS software company' })])).toBe('software-saas');
    expect(industryMatches([page({ text: 'solicitors solicitors law firm' })]).get('legal')).toEqual({ hits: 3, phrases: 2 });
  });

  it('risky single words are not classifier evidence (playbook aliases unchanged)', () => {
    for (const w of ['property', 'legal', 'production', 'foundation', 'school', 'ecommerce']) {
      expect(CLASSIFIER_EXCLUDED.has(w)).toBe(true);
      expect(guessIndustry([page({ text: `${w} ${w} ${w}` })])).toBeNull();
    }
    expect(INDUSTRIES.manufacturing.aliases).toContain('production');
    expect(INDUSTRIES.nonprofit.aliases).toContain('foundation');
    expect(INDUSTRIES['education-training'].aliases).toContain('school');
    expect(INDUSTRIES['ecommerce-retail'].aliases).toContain('ecommerce');
    expect(INDUSTRIES.legal.label).toBe('Legal');
    expect(INDUSTRIES.property.label).toBe('Property');
  });

  it('false positives: IP law footer, video production agency, agency that builds ecommerce shops', () => {
    const ipFooter = page({
      title: 'Bright Widgets | Garden lighting',
      text: 'Solar garden lights. © 2026 Bright Widgets. All intellectual property rights reserved. Legal notice. Legal terms. Property of Bright Widgets Ltd.',
    });
    expect(guessIndustry([ipFooter])).toBeNull();
    const video = page({
      title: 'Reel Studio | Video production agency',
      description: 'Video production for brands.',
      text: 'Production, post-production and production design. Our production crew shoots ads.',
    });
    expect(guessIndustry([video])).not.toBe('manufacturing');
    const shopBuilder = page({
      title: 'Pixel & Co | Ecommerce web design',
      description: 'A digital agency building ecommerce websites.',
      text: 'We design ecommerce stores and build your online shop on Shopify. Ecommerce SEO and ecommerce strategy for retailers.',
    });
    expect(guessIndustry([shopBuilder])).not.toBe('ecommerce-retail');
  });

  it('a real shop still classifies from shop phrases', () => {
    expect(guessIndustry([page({ title: 'Acme online shop', text: 'Shop now. Add to basket. Free returns.' })])).toBe('ecommerce-retail');
  });

  it('only the first part of a title counts: evidence past the cap is ignored', () => {
    const evidence = 'shop now add to basket';
    expect(guessIndustry([page({ title: `${evidence} ${'x '.repeat(400)}`, text: '' })])).toBe('ecommerce-retail');
    expect(guessIndustry([page({ title: `${'x '.repeat(400)} ${evidence}`, text: '' })])).toBeNull();
  });

  it('linear on large hostile input', () => {
    const big = 'law '.repeat(200_000) + '-'.repeat(200_000);
    const t = Date.now();
    guessIndustry([page({ title: big, description: big, text: big }), page({ title: big })]);
    expect(Date.now() - t).toBeLessThan(1500);
  });
});

describe('industry search queries', () => {
  it('two server-owned queries per industry, with no placeholders', () => {
    for (const id of INDUSTRY_IDS) {
      const q = INDUSTRIES[id].searchQueries;
      expect(q).toHaveLength(2);
      for (const s of q) {
        expect(s.length).toBeGreaterThan(10);
        expect(s).not.toMatch(/[{}$@]|https?:/);
      }
    }
  });
});

describe('result hygiene', () => {
  it('URL validation', () => {
    expect(safeResultUrl('https://www.example.com/a?b=1')).toEqual({ url: 'https://www.example.com/a?b=1', domain: 'example.com' });
    expect(safeResultUrl('http://example.com:80/')?.url).toBe('http://example.com/');
    for (const bad of [
      'javascript:alert(1)',
      'ftp://example.com/',
      'https://user:pw@example.com/',
      'https://example.com:8443/',
      'https://192.168.0.1/',
      'https://[::1]/',
      'https://localhost/',
      `https://example.com/${'x'.repeat(500)}`,
      'not a url',
      42,
    ]) {
      expect(safeResultUrl(bad)).toBeNull();
    }
  });

  it('blocklist: social, video and pin sites, offshorly.com and subdomains', () => {
    for (const d of ['facebook.com', 'm.facebook.com', 'youtube.com', 'linkedin.com', 'uk.pinterest.com', 'pinterest.co.uk', 'offshorly.com', 'blog.offshorly.com', 'x.com']) {
      expect(isBlockedHost(d)).toBe(true);
    }
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedHost('notx.com')).toBe(false);
  });

  it('strips HTML, entities and control characters; caps title 120 and snippet 300; one result per host; ≤8', () => {
    const hits: SearchHit[] = [
      { title: '<b>Bold</b> &amp; \u202EReversed\u0007 title', snippet: `Snippet with <a href="x">link</a> https://evil.example/path and ${'word '.repeat(100)}`, url: 'https://a.example/1' },
      { title: 'Same host', snippet: '', url: 'https://www.a.example/2' },
      { title: 'x'.repeat(300), snippet: '', url: 'https://b.example/' },
      { title: '', snippet: 'no title', url: 'https://c.example/' },
      { title: 'Blocked', snippet: '', url: 'https://www.facebook.com/page' },
      ...Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, snippet: 's', url: `https://h${i}.example/` })),
    ];
    const out = cleanHits(hits);
    expect(out).toHaveLength(MAX_RESULTS);
    expect(out[0]!.title).toBe('Bold & Reversed title');
    expect(out[0]!.snippet).not.toMatch(/<|https?:|evil\.example/);
    expect(out[0]!.snippet.length).toBeLessThanOrEqual(300);
    expect(out[1]!.domain).toBe('b.example');
    expect(out[1]!.title.length).toBeLessThanOrEqual(120);
    expect(out.map((r) => r.domain)).not.toContain('facebook.com');
    expect(new Set(out.map((r) => r.domain)).size).toBe(out.length);
  });

  it('per audit: drops the audited domain, its subdomains and parents; numbers S1…', () => {
    const results = cleanHits([
      { title: 'Own site', snippet: '', url: 'https://acme.example/blog' },
      { title: 'Own sub', snippet: '', url: 'https://blog.acme.example/' },
      { title: 'Other', snippet: '', url: 'https://other.example/' },
      { title: 'Third', snippet: '', url: 'https://third.example/' },
    ]);
    const s = sourcesForAudit(results, 'www.acme.example');
    expect(s.map((x) => [x.id, x.domain])).toEqual([
      ['S1', 'other.example'],
      ['S2', 'third.example'],
    ]);
    expect(sourcesForAudit(results, 'shop.other.example').map((x) => x.domain)).not.toContain('other.example');
  });
});

// ---------- Research cache ----------

const hit = (host: string, title = `Title on ${host}`): SearchHit => ({ title, snippet: `Snippet about ${host}`, url: `https://${host}/page` });

/** A provider whose answers the test controls; records queries. */
const fakeProvider = (impl?: (q: string, o: SearchOptions) => Promise<SearchHit[]>) => {
  const queries: string[] = [];
  const provider: SearchProvider = {
    name: 'serpapi',
    search: async (q, o) => {
      queries.push(q);
      return impl ? impl(q, o) : [hit(`r${queries.length}.example`)];
    },
  };
  return { provider, queries };
};

const research = (provider: SearchProvider, over: Partial<Parameters<typeof createIndustryResearch>[0]> = {}) =>
  createIndustryResearch({ provider, ttlDays: 7, dailyMax: 100, ...over });

describe('industryResearch', () => {
  it('miss then hit; queries are exactly the industry queries (no domain, answers or email)', async () => {
    const p = fakeProvider();
    const r = await research(p.provider);
    const first = await r.forAudit('legal', { auditedDomain: 'acme.example' });
    expect(first.cache).toBe('miss');
    expect(first.industryId).toBe('legal');
    expect(first.sources.map((s) => s.id)).toEqual(['S1', 'S2']);
    expect(first.searchedAt).toMatch(/^\d{4}-/);
    expect(p.queries).toEqual([...INDUSTRIES.legal.searchQueries]);
    for (const q of p.queries) expect(q).not.toContain('acme');
    const second = await r.forAudit('legal', { auditedDomain: 'other.example' });
    expect(second.cache).toBe('hit');
    expect(p.queries).toHaveLength(2);
  });

  it('expiry after SEARCH_CACHE_DAYS', async () => {
    let t = Date.parse('2026-11-20T10:00:00Z');
    const p = fakeProvider();
    const r = await research(p.provider, { now: () => t, ttlDays: 7 });
    await r.forAudit('legal', { auditedDomain: 'a.example' });
    t += 7 * DAY - 1;
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('hit');
    t += 2;
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('miss');
    expect(p.queries).toHaveLength(4);
  });

  it('no industry → none, no search', async () => {
    const p = fakeProvider();
    const r = await research(p.provider);
    expect(await r.forAudit(null, { auditedDomain: 'a.example' })).toEqual({ industryId: null, cache: 'none', searchedAt: null, sources: [] });
    expect(p.queries).toHaveLength(0);
  });

  it('in-flight de-duplication', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const p = fakeProvider(async (q) => {
      await gate;
      return [hit(`${q.length}.example`)];
    });
    const r = await research(p.provider, { waitMs: 1000 });
    const a = r.forAudit('legal', { auditedDomain: 'a.example' });
    const b = r.forAudit('legal', { auditedDomain: 'b.example' });
    release();
    await Promise.all([a, b]);
    expect(p.queries).toHaveLength(2);
  });

  it('failure → 30-minute negative cache; the log carries the status only', async () => {
    let t = 1_000_000;
    const logs: unknown[] = [];
    const log: ResearchLog = (_l, msg, extra) => logs.push({ msg, ...extra });
    const p = fakeProvider(async () => {
      throw new SearchError(429);
    });
    const r = await research(p.provider, { now: () => t, log });
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('error');
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('negative');
    expect(p.queries).toHaveLength(2);
    t += NEGATIVE_TTL_MS + 1;
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('error');
    expect(p.queries).toHaveLength(4);
    expect(JSON.stringify(logs)).toContain('"reason":"http_429","reasons":["http_429","http_429"]');
    expect(NEGATIVE_TTL_MS).toBe(30 * MINUTE);
  });

  it('one query failing still caches the other', async () => {
    const p = fakeProvider(async (q) => {
      if (q === INDUSTRIES.legal.searchQueries[0]) throw new SearchError(503);
      return [hit('ok.example')];
    });
    const r = await research(p.provider);
    const out = await r.forAudit('legal', { auditedDomain: 'a.example' });
    expect(out.cache).toBe('miss');
    expect(out.sources.map((s) => s.domain)).toEqual(['ok.example']);
  });

  it('daily cap counts provider requests (two per run)', async () => {
    const p = fakeProvider();
    const r = await research(p.provider, { dailyMax: 3 });
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('miss');
    expect((await r.forAudit('insurance', { auditedDomain: 'a.example' })).cache).toBe('capped');
    expect(p.queries).toHaveLength(2);
  });

  it('timeout → no sources within the wait; the late result still fills the cache', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const p = fakeProvider(async () => {
      await gate;
      return [hit('late.example')];
    });
    const r = await research(p.provider, { waitMs: 20 });
    const out = await r.forAudit('legal', { auditedDomain: 'a.example' });
    expect(out).toMatchObject({ cache: 'timeout', sources: [] });
    release();
    await new Promise((res) => setTimeout(res, 10));
    const later = await r.forAudit('legal', { auditedDomain: 'a.example' });
    expect(later.cache).toBe('hit');
    expect(later.sources[0]!.domain).toBe('late.example');
  });

  it('persist and reload (0600, atomic); the key embeds provider, industry and QUERIES_VERSION', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-search-'));
    const path = join(dir, 'search-cache.json');
    const p = fakeProvider();
    const r = await research(p.provider, { path });
    await r.forAudit('legal', { auditedDomain: 'a.example' });
    await r.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { v: number; entries: { key: string }[] };
    expect(saved.v).toBe(1);
    expect(saved.entries[0]!.key).toBe(`serpapi:legal:${QUERIES_VERSION}`);
    expect(cacheKey('serpapi', 'legal')).toBe(saved.entries[0]!.key);
    expect(readFileSync(path, 'utf8')).not.toContain('@');

    const p2 = fakeProvider();
    const r2 = await research(p2.provider, { path });
    expect((await r2.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('hit');
    expect(p2.queries).toHaveLength(0);
    expect(r2.list()[0]).toMatchObject({ industryId: 'legal' });
  });

  it('a corrupt cache file is ignored; entries for another provider or version are not used', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-search-'));
    const path = join(dir, 'search-cache.json');
    writeFileSync(path, '{not json');
    const logs: string[] = [];
    const p = fakeProvider();
    const r = await research(p.provider, { path, log: (_l, msg) => logs.push(msg) });
    expect(logs).toContain('search cache unreadable: ignored');
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('miss');

    const t = Date.now();
    writeFileSync(
      path,
      JSON.stringify({ v: 1, entries: [{ key: 'serpapi:legal:0', industryId: 'legal', fetchedAt: t, expiresAt: t + DAY, results: [hit('old.example')] }] }),
    );
    const p3 = fakeProvider();
    const r3 = await research(p3.provider, { path });
    expect((await r3.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('miss');
  });

  it('the audited domain is removed per audit, not from the cache', async () => {
    const p = fakeProvider(async () => [hit('acme.example'), hit('other.example')]);
    const r = await research(p.provider);
    const a = await r.forAudit('legal', { auditedDomain: 'acme.example' });
    expect(a.sources.map((s) => s.domain)).toEqual(['other.example']);
    const b = await r.forAudit('legal', { auditedDomain: 'third.example' });
    expect(b.sources.map((s) => s.domain)).toEqual(['acme.example', 'other.example']);
  });

  it('results empty only after removing the audited domain: still a cache hit', async () => {
    const p = fakeProvider(async () => [hit('acme.example')]);
    const r = await research(p.provider);
    expect((await r.forAudit('legal', { auditedDomain: 'other.example' })).cache).toBe('miss');
    expect(await r.forAudit('legal', { auditedDomain: 'acme.example' })).toMatchObject({ cache: 'hit', sources: [] });
    expect(p.queries).toHaveLength(2);
  });

  it('empty cache entries are dropped on load; non-empty ones kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oa-search-'));
    const path = join(dir, 'search-cache.json');
    const t = Date.now();
    const entry = (industryId: string, results: SearchHit[]) => ({ key: `serpapi:${industryId}:${QUERIES_VERSION}`, industryId, fetchedAt: t, expiresAt: t + DAY, results });
    writeFileSync(
      path,
      JSON.stringify({ v: 1, entries: [entry('legal', []), entry('insurance', [hit('kept.example')]), entry('accounting', [hit('www.facebook.com')])] }),
    );
    const logs: Record<string, unknown>[] = [];
    const p = fakeProvider();
    const r = await research(p.provider, { path, log: (_l, msg, extra) => logs.push({ msg, ...extra }) });
    expect(logs).toContainEqual({ msg: 'search cache loaded', entries: 1 });
    expect(r.list().map((e) => e.industryId)).toEqual(['insurance']);
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('miss');
  });
});

// ---------- No results, backoff and the account-wide pause ----------

describe('industryResearch failures: no_results, backoff, pause', () => {
  const clock = (start = Date.parse('2026-11-20T10:00:00Z')) => {
    const c = { t: start, now: () => c.t };
    return c;
  };
  const recorder = () => {
    const logs: Record<string, unknown>[] = [];
    const log: ResearchLog = (level, msg, extra) => logs.push({ level, msg, ...extra });
    return { logs, log };
  };
  const negativeIn = (r: Awaited<ReturnType<typeof research>>, t: number, industryId = 'legal') => {
    const o = r.outcomes().find((x) => x.industryId === industryId);
    return o?.negativeUntil ? Date.parse(o.negativeUntil) - t : null;
  };

  it('schedule constants', () => {
    expect(NEGATIVE_TTLS_MS).toEqual([30 * MINUTE, 2 * HOUR, 6 * HOUR]);
    expect(NEGATIVE_TTL_MS).toBe(30 * MINUTE);
    expect(NO_RESULTS_TTL_MS).toBe(24 * HOUR);
    expect(AUTH_PAUSE_MS).toBe(6 * HOUR);
  });

  it('SerpApi "no results" on both queries → no_results, negative for 24 h, nothing cached or persisted', async () => {
    const c = clock();
    const { logs, log } = recorder();
    const s = serp(200, SERPAPI_NO_RESULTS);
    const dir = mkdtempSync(join(tmpdir(), 'oa-search-'));
    const path = join(dir, 'search-cache.json');
    const r = await createIndustryResearch({ provider: s.provider, ttlDays: 7, dailyMax: 100, now: c.now, log, path });
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('error');
    await r.close();
    expect(s.calls).toHaveLength(2);
    expect(r.list()).toEqual([]);
    expect(() => statSync(path)).toThrow();
    expect(r.outcomes()[0]).toMatchObject({ lastRefresh: { status: 'failed', reason: 'no_results', results: 0 } });
    expect(negativeIn(r, c.t)).toBe(NO_RESULTS_TTL_MS);
    expect(r.pausedUntil()).toBeNull();
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'industry_research', status: 'failed', reason: 'no_results', ms: 0 }));

    c.t += NO_RESULTS_TTL_MS - 1;
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('negative');
    expect(s.calls).toHaveLength(2);
    c.t += 2;
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('error');
    expect(s.calls).toHaveLength(4);
  });

  it('no_results resets the failure streak', async () => {
    const c = clock();
    let mode: 'fail' | 'empty' = 'fail';
    const p = fakeProvider(async () => {
      if (mode === 'fail') throw new SearchError(503);
      return [];
    });
    const r = await research(p.provider, { now: c.now });
    await r.forAudit('legal', { auditedDomain: 'a.example' });
    c.t += NEGATIVE_TTLS_MS[0]! + 1;
    await r.forAudit('legal', { auditedDomain: 'a.example' });
    expect(negativeIn(r, c.t)).toBe(NEGATIVE_TTLS_MS[1]);
    c.t += NEGATIVE_TTLS_MS[1]! + 1;
    mode = 'empty';
    await r.forAudit('legal', { auditedDomain: 'a.example' });
    expect(negativeIn(r, c.t)).toBe(NO_RESULTS_TTL_MS);
    c.t += NO_RESULTS_TTL_MS + 1;
    mode = 'fail';
    await r.forAudit('legal', { auditedDomain: 'a.example' });
    expect(negativeIn(r, c.t)).toBe(NEGATIVE_TTLS_MS[0]);
  });

  it('a 200 with an unknown `error` → provider_error; the message and its URL never reach the error or the logs', async () => {
    const s = serp(200, SERPAPI_200_UNKNOWN_ERROR);
    const err = await s.provider.search('q', opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchError);
    expect((err as SearchError).reason).toBe('provider_error');
    expect(`${String(err)} ${(err as Error).stack ?? ''} ${JSON.stringify(err)}`).not.toMatch(/https?:\/\/|leak|went wrong/);

    const { logs, log } = recorder();
    const r = await createIndustryResearch({ provider: serp(200, SERPAPI_200_UNKNOWN_ERROR).provider, ttlDays: 7, dailyMax: 10, log });
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('error');
    expect(r.outcomes()[0]).toMatchObject({ lastRefresh: { status: 'failed', reason: 'provider_error' } });
    const text = JSON.stringify(logs);
    expect(text).toContain('"reason":"provider_error"');
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain('leak');
  });

  it('0 cleaned results with one query failed → the failed reason and backoff, not no_results', async () => {
    const c = clock();
    const { logs, log } = recorder();
    const p = fakeProvider(async (q) => {
      if (q === INDUSTRIES.legal.searchQueries[0]) throw new SearchError(503);
      return [hit('www.youtube.com')]; // blocked → nothing usable
    });
    const r = await research(p.provider, { now: c.now, log });
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('error');
    expect(r.outcomes()[0]).toMatchObject({ lastRefresh: { status: 'failed', reason: 'http_503' } });
    expect(negativeIn(r, c.t)).toBe(NEGATIVE_TTLS_MS[0]);
    expect(logs).toContainEqual(expect.objectContaining({ status: 'failed', reason: 'http_503', reasons: ['http_503'] }));
    expect(logs.some((l) => l.reason === 'no_results')).toBe(false);
    c.t += NEGATIVE_TTLS_MS[0]! + 1;
    await r.forAudit('legal', { auditedDomain: 'a.example' });
    expect(negativeIn(r, c.t)).toBe(NEGATIVE_TTLS_MS[1]);
  });

  it('backoff: 30 min, 2 h, 6 h, 6 h; reset after a success', async () => {
    const c = clock();
    let fail = true;
    const p = fakeProvider(async (q) => {
      if (fail) throw new SearchError(503);
      return [hit(`${q.length}.example`)];
    });
    const r = await research(p.provider, { now: c.now, ttlDays: 7 });
    const seen: (number | null)[] = [];
    for (let i = 0; i < 4; i++) {
      expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('error');
      const ttl = negativeIn(r, c.t);
      seen.push(ttl);
      c.t += (ttl ?? 0) - 1;
      expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('negative');
      c.t += 2;
    }
    expect(seen).toEqual([30 * MINUTE, 2 * HOUR, 6 * HOUR, 6 * HOUR]);
    expect(p.queries).toHaveLength(8);
    expect(r.pausedUntil()).toBeNull(); // 503 never pauses

    fail = false;
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('miss');
    expect(negativeIn(r, c.t)).toBeNull();
    c.t += 7 * DAY + 1;
    fail = true;
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('error');
    expect(negativeIn(r, c.t)).toBe(30 * MINUTE);
  });

  it('a 401 pauses every industry for 6 h: no provider call and nothing taken from the daily counter', async () => {
    const c = clock();
    const { logs, log } = recorder();
    let fail = true;
    const p = fakeProvider(async (q) => {
      if (fail) throw new SearchError(401);
      return [hit(`${q.length}.example`)];
    });
    // 4 requests a day: the failed legal run takes 2 (no refund); exactly one more run fits.
    const r = await research(p.provider, { now: c.now, log, dailyMax: 4 });
    const start = c.t;
    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('error');
    expect(r.pausedUntil()).toBe(new Date(start + AUTH_PAUSE_MS).toISOString());
    expect(logs.filter((l) => l.status === 'paused')).toEqual([
      expect.objectContaining({ msg: 'industry_research', status: 'paused', reason: 'http_401', ms: 0 }),
    ]);
    expect(p.queries).toHaveLength(2);

    fail = false;
    expect((await r.forAudit('insurance', { auditedDomain: 'a.example' })).cache).toBe('negative');
    c.t = start + AUTH_PAUSE_MS - 1;
    expect((await r.forAudit('insurance', { auditedDomain: 'a.example' })).cache).toBe('negative');
    expect((await r.forAudit('accounting', { auditedDomain: 'a.example' })).cache).toBe('negative');
    expect(p.queries).toHaveLength(2);
    expect(r.outcomes().find((o) => o.industryId === 'insurance')).toMatchObject({ lastAudit: { cache: 'negative' }, lastRefresh: null });

    c.t = start + AUTH_PAUSE_MS + 1;
    expect(r.pausedUntil()).toBeNull();
    expect((await r.forAudit('insurance', { auditedDomain: 'a.example' })).cache).toBe('miss');
    expect(p.queries).toHaveLength(4);
    // The paused audits took nothing: the counter is now exactly full.
    expect((await r.forAudit('accounting', { auditedDomain: 'a.example' })).cache).toBe('capped');
  });

  it('a 403 pauses for 6 h too', async () => {
    const c = clock();
    const p = fakeProvider(async () => {
      throw new SearchError(403);
    });
    const r = await research(p.provider, { now: c.now });
    await r.forAudit('legal', { auditedDomain: 'a.example' });
    expect(r.pausedUntil()).toBe(new Date(c.t + AUTH_PAUSE_MS).toISOString());
  });

  it('a 429 pause follows the streak (30 min, then 2 h)', async () => {
    const c = clock();
    const { logs, log } = recorder();
    const p = fakeProvider(async () => {
      throw new SearchError(429);
    });
    const r = await research(p.provider, { now: c.now, log });
    await r.forAudit('legal', { auditedDomain: 'a.example' });
    expect(r.pausedUntil()).toBe(new Date(c.t + 30 * MINUTE).toISOString());
    expect((await r.forAudit('insurance', { auditedDomain: 'a.example' })).cache).toBe('negative');
    expect(p.queries).toHaveLength(2);

    c.t += 30 * MINUTE + 1;
    expect(r.pausedUntil()).toBeNull();
    await r.forAudit('legal', { auditedDomain: 'a.example' });
    expect(r.pausedUntil()).toBe(new Date(c.t + 2 * HOUR).toISOString());
    expect(p.queries).toHaveLength(4);
    expect(logs.filter((l) => l.status === 'paused')).toHaveLength(2);
  });
});

// ---------- Timings: the audit's 4 s wait vs the provider's 20 s timeout (fake timers) ----------

describe('industryResearch timings', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const recorder = () => {
    const logs: Record<string, unknown>[] = [];
    const log: ResearchLog = (level, msg, extra) => logs.push({ level, msg, ...extra });
    return { logs, log };
  };

  it('the wait (4 s) is shorter than the provider timeout (20 s)', () => {
    expect(RESEARCH_WAIT_MS).toBe(4_000);
    expect(SEARCH_TIMEOUT_MS).toBe(20_000);
  });

  it('provider answering at 6 s: first audit times out without a negative entry; the refresh fills the cache; dedupe; then a hit', async () => {
    vi.useFakeTimers();
    const { logs, log } = recorder();
    // Honours the signal like the real adapter: an abort before 6 s would lose the answer.
    const p = fakeProvider(
      (q, o) =>
        new Promise((res, reject) => {
          setTimeout(() => res([hit(`${q.length}-${q.charCodeAt(0)}.example`)]), 6_000);
          o.signal.addEventListener('abort', () => reject(new SearchError('timeout')));
        }),
    );
    const r = await research(p.provider, { log });

    const first = r.forAudit('legal', { auditedDomain: 'a.example' });
    await vi.advanceTimersByTimeAsync(RESEARCH_WAIT_MS);
    expect(await first).toMatchObject({ cache: 'timeout', sources: [] });
    expect(r.outcomes()).toEqual([
      expect.objectContaining({ industryId: 'legal', lastAudit: expect.objectContaining({ cache: 'timeout' }), lastRefresh: null, negativeUntil: null, inflight: true }),
    ]);

    // A second audit during the refresh joins it: no new provider call.
    const second = r.forAudit('legal', { auditedDomain: 'b.example' });
    expect(p.queries).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    const got = await second;
    expect(got.cache).toBe('miss');
    expect(got.sources.length).toBeGreaterThan(0);
    expect(p.queries).toHaveLength(2);

    const third = await r.forAudit('legal', { auditedDomain: 'c.example' });
    expect(third.cache).toBe('hit');
    expect(third.sources.length).toBeGreaterThan(0);
    expect(p.queries).toHaveLength(2);
    expect(r.outcomes()[0]).toMatchObject({ lastAudit: { cache: 'hit' }, lastRefresh: { status: 'ok', reason: null, ms: 6_000 }, negativeUntil: null, inflight: false });

    expect(logs).toContainEqual(expect.objectContaining({ msg: 'industry_research', status: 'wait_timeout', reason: 'wait_timeout', ms: RESEARCH_WAIT_MS }));
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'industry_research', status: 'ok', ms: 6_000 }));
    expect(logs.some((l) => l.status === 'failed')).toBe(false);
  });

  it('provider still silent at 20 s: the refresh fails with reason timeout and only then is negatively cached', async () => {
    vi.useFakeTimers();
    const { logs, log } = recorder();
    const signals: AbortSignal[] = [];
    // First query honours the signal; the second ignores it (the refresh must still settle).
    const p = fakeProvider((q, o) => {
      signals.push(o.signal);
      if (q === INDUSTRIES.legal.searchQueries[0]) {
        return new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(new SearchError('timeout'))));
      }
      return new Promise(() => undefined);
    });
    const r = await research(p.provider, { log });

    const first = r.forAudit('legal', { auditedDomain: 'a.example' });
    await vi.advanceTimersByTimeAsync(RESEARCH_WAIT_MS);
    expect((await first).cache).toBe('timeout');
    expect(r.outcomes()[0]!.negativeUntil).toBeNull();

    await vi.advanceTimersByTimeAsync(SEARCH_TIMEOUT_MS - RESEARCH_WAIT_MS - 1);
    expect(signals.every((s) => !s.aborted)).toBe(true);
    expect(r.outcomes()[0]!.inflight).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(r.outcomes()[0]).toMatchObject({ lastRefresh: { status: 'failed', reason: 'timeout', ms: SEARCH_TIMEOUT_MS }, inflight: false });
    expect(r.outcomes()[0]!.negativeUntil).not.toBeNull();
    expect(logs).toContainEqual(expect.objectContaining({ status: 'failed', reason: 'timeout', reasons: ['timeout', 'timeout'], ms: SEARCH_TIMEOUT_MS }));

    expect((await r.forAudit('legal', { auditedDomain: 'a.example' })).cache).toBe('negative');
    expect(p.queries).toHaveLength(2);
  });

  it('reason codes', () => {
    expect(reasonOf(new SearchError(401))).toBe('http_401');
    expect(reasonOf(new SearchError(429))).toBe('http_429');
    expect(reasonOf(new SearchError('timeout'))).toBe('timeout');
    expect(reasonOf(new SearchError('bad_json'))).toBe('bad_json');
    expect(reasonOf(new SearchError('network'))).toBe('network');
    expect(reasonOf(new SearchError('provider_error'))).toBe('provider_error');
    expect(reasonOf(new Error('https://serpapi.com/search?api_key=x'))).toBe('error');
  });
});

// ---------- SerpApi adapter (hand-written fixtures; see test/fixtures/serpapi.ts) ----------

const KEY = 'serpapi-secret-key-0123456789';

const serp = (status: number, body: unknown) => {
  const calls: { url: string; init: Parameters<SearchFetch>[1] }[] = [];
  const fetchImpl: SearchFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { provider: createSerpApiProvider({ apiKey: KEY, fetchImpl }), calls };
};

const opts = (): SearchOptions => ({ num: 6, country: 'gb', lang: 'en', signal: AbortSignal.timeout(4000) });

describe('SerpApi adapter', () => {
  it('request: GET serpapi.com/search with engine, q, gl=uk, hl=en, google_domain, api_key; no num, no no_cache; redirects refused', async () => {
    const s = serp(200, SERPAPI_OK);
    await s.provider.search('how UK law firms use AI automation', opts());
    const u = new URL(s.calls[0]!.url);
    expect(`${u.origin}${u.pathname}`).toBe(SERPAPI_ENDPOINT);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      engine: 'google',
      q: 'how UK law firms use AI automation',
      gl: 'uk',
      hl: 'en',
      google_domain: 'google.co.uk',
      api_key: KEY,
    });
    expect(u.searchParams.has('num')).toBe(false);
    expect(u.searchParams.has('no_cache')).toBe(false);
    expect(s.calls[0]!.init).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('parses organic_results: first `num` with a title and link; snippet optional', async () => {
    const s = serp(200, SERPAPI_OK);
    const hits = await s.provider.search('q', { ...opts(), num: 5 });
    expect(hits.map((h) => h.url)).toEqual([
      'https://www.legal-news.example/ai-intake',
      'https://guides.example/document-review',
      'https://www.youtube.com/watch?v=abc',
      'https://www.legal-news.example/another',
      'https://conveyancing.example/automation',
    ]);
    expect(hits[4]!.snippet).toBe('');
    // Hygiene happens in the research layer.
    const cleaned = cleanHits(hits);
    expect(cleaned.map((h) => h.domain)).toEqual(['legal-news.example', 'guides.example', 'conveyancing.example']);
    expect(cleaned[0]!.snippet).toBe('Firms describe using an assistant to sort new enquiries & collect documents before a solicitor reviews them.');
  });

  it('"no results" (200 with a top-level error) is an empty list, not a failure', async () => {
    expect(await serp(200, SERPAPI_NO_RESULTS).provider.search('q', opts())).toEqual([]);
    expect(parseSerpApi({ organic_results: 'nope' }, 6)).toEqual([]);
  });

  it('parse rules for `error`: results win; the no-results message → []; another message → provider_error; nothing → []', async () => {
    expect((await serp(200, SERPAPI_RESULTS_WITH_ERROR).provider.search('q', opts())).length).toBeGreaterThan(0);
    expect(parseSerpApi({ error: 'Google hasn’t returned any results for this query.' }, 6)).toEqual([]);
    expect(parseSerpApi({ error: 'Google hasnt returned any results for this query.' }, 6)).toEqual([]);
    expect(parseSerpApi({ error: 'GOOGLE HASN\'T RETURNED ANY RESULTS' }, 6)).toEqual([]);
    expect(() => parseSerpApi({ error: 'Your account has run out of searches.' }, 6)).toThrow(SearchError);
    expect(parseSerpApi({}, 6)).toEqual([]);
    expect(parseSerpApi({ error: 42 }, 6)).toEqual([]);
  });

  it('errors carry the status only: the key and the URL never appear in the thrown error', async () => {
    for (const status of [400, 401, 403, 404, 410, 429, 500, 503]) {
      const s = serp(status, SERPAPI_BAD_KEY);
      const err = await s.provider.search('q', opts()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SearchError);
      expect((err as SearchError).reason).toBe(status);
      const text = `${String(err)} ${(err as Error).message} ${(err as Error).stack ?? ''} ${JSON.stringify(err)}`;
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('serpapi.com');
      expect(text).not.toContain('api_key');
    }
  });

  it('a fetch error mentioning the URL (and key) is dropped, not rethrown', async () => {
    const fetchImpl: SearchFetch = async (url) => {
      throw new TypeError(`fetch failed for ${url}`);
    };
    const err = await createSerpApiProvider({ apiKey: KEY, fetchImpl }).search('q', opts()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchError);
    expect(`${String(err)} ${(err as Error).stack ?? ''}`).not.toContain(KEY);
    expect((err as SearchError).reason).toBe('network');
  });

  it('bad JSON and over-size bodies fail cleanly', async () => {
    expect(await serp(200, '{oops').provider.search('q', opts()).catch((e: SearchError) => e.reason)).toBe('bad_json');
    const big = new Response('x'.repeat(600 * 1024), { status: 200 });
    const p = createSerpApiProvider({ apiKey: KEY, fetchImpl: async () => big });
    expect(await p.search('q', opts()).catch((e: SearchError) => e.reason)).toBe('too_large');
  });

  it('one of the two SerpApi queries failing: results from the other; the shared signal is not aborted; logs carry codes only', async () => {
    const logs: string[] = [];
    const signals: AbortSignal[] = [];
    const fetchImpl: SearchFetch = async (url, init) => {
      signals.push(init.signal);
      const q = new URL(url).searchParams.get('q');
      if (q === INDUSTRIES.legal.searchQueries[0]) return new Response(JSON.stringify(SERPAPI_BAD_KEY), { status: 429 });
      return new Response(JSON.stringify(SERPAPI_OK), { status: 200 });
    };
    const r = await createIndustryResearch({
      provider: createSerpApiProvider({ apiKey: KEY, fetchImpl }),
      ttlDays: 7,
      dailyMax: 10,
      log: (_l, msg, extra) => logs.push(`${msg} ${JSON.stringify(extra)}`),
    });
    const out = await r.forAudit('legal', { auditedDomain: 'a.example' });
    expect(out.cache).toBe('miss');
    expect(out.sources.map((s) => s.domain)).toEqual(['legal-news.example', 'guides.example', 'conveyancing.example', 'seventh.example']);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]!.aborted).toBe(false);
    const text = logs.join('\n');
    expect(text).toContain('"reasons":["http_429"]');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('api_key');
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('research logs never contain the key when SerpApi fails', async () => {
    const logs: string[] = [];
    const s = serp(401, SERPAPI_BAD_KEY);
    const r = await createIndustryResearch({ provider: s.provider, ttlDays: 7, dailyMax: 10, log: (_l, msg, extra) => logs.push(`${msg} ${JSON.stringify(extra)}`) });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await r.forAudit('legal', { auditedDomain: 'a.example' });
    expect(logs.join('\n')).toContain('"reason":"http_401"');
    expect(logs.join('\n')).not.toContain(KEY);
    expect(logs.join('\n')).not.toMatch(/https?:\/\/|api_key|serpapi\.com/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('fixture search provider', () => {
  it('three [Sample] hits on reserved example domains, all surviving hygiene', async () => {
    const hits = await createFixtureSearchProvider().search('q', opts());
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.title.startsWith('[Sample]'))).toBe(true);
    expect(cleanHits(hits)).toHaveLength(3);
    expect(FIXTURE_HITS.every((h) => /^https:\/\/(www\.)?example\.(com|org|net)\//.test(h.url))).toBe(true);
  });
});
