import { describe, expect, it } from 'vitest';
import type { AiResult, AuditReport, BuyerFit, BuyerFitResult } from '../../shared/types.js';
import { toAuditError, parseRetryAfter, isErrorCode } from '../../src/lib/errors.js';
import { buildRequest, EMPTY_FORM, normaliseUrlInput } from '../../src/lib/form.js';
import {
  markUnavailable,
  mergeAi,
  mergeBuyerFit,
  resolveFixFirst,
  sectionSummary,
  sortCriteria,
  splitChecks,
  weakestCriterion,
  safeHref,
  hasOmittedChecks,
} from '../../src/lib/report.js';
import { COPY } from '../../src/content/copy.js';
import { displayName } from '../../shared/displayName.js';
import { nextTabIndex } from '../../src/lib/tabs.js';

describe('nextTabIndex', () => {
  it('moves and wraps with arrow keys', () => {
    expect(nextTabIndex('ArrowRight', 0, 2)).toBe(1);
    expect(nextTabIndex('ArrowRight', 1, 2)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 2)).toBe(1);
    expect(nextTabIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextTabIndex('ArrowUp', 0, 3)).toBe(2);
  });
  it('handles Home/End and ignores other keys', () => {
    expect(nextTabIndex('Home', 1, 2)).toBe(0);
    expect(nextTabIndex('End', 0, 3)).toBe(2);
    expect(nextTabIndex('Enter', 0, 2)).toBeNull();
    expect(nextTabIndex('ArrowRight', 0, 0)).toBeNull();
  });
});

describe('toAuditError', () => {
  it('uses the body code and builds on the server text where the copy does', () => {
    const e = toAuditError(422, { code: 'site_not_found', error: 'No site found at that address.' });
    expect(e.code).toBe('site_not_found');
    expect(e.message).toBe('No site found at that address. Please check the address and try again.');
  });
  it('maps 429 with retryAfterSec to minutes', () => {
    const e = toAuditError(429, { code: 'rate_limited', error: 'x', retryAfterSec: 1740 });
    expect(e.message).toBe("You've run a few audits already. Please try again in 29 minutes.");
  });
  it('falls back to the Retry-After header', () => {
    expect(toAuditError(429, null, '60').message).toContain('1 minute.');
    expect(parseRetryAfter('abc')).toBeUndefined();
    expect(parseRetryAfter(' 120 ')).toBe(120);
  });
  it('infers a code from status when the body is missing or bogus', () => {
    expect(toAuditError(503, 'oops').code).toBe('busy');
    expect(toAuditError(404, { code: 'nope' }).code).toBe('not_found');
    expect(toAuditError(500, null).code).toBe('server_error');
    expect(toAuditError(418, null).code).toBe('server_error');
  });
  it('does not echo server text for generic codes', () => {
    const e = toAuditError(500, { code: 'server_error', error: '<script>stack trace</script>' });
    expect(e.message).not.toContain('stack');
    expect(isErrorCode('busy')).toBe(true);
    expect(isErrorCode('x')).toBe(false);
  });
});

describe('normaliseUrlInput / buildRequest', () => {
  it('adds https:// and accepts plain domains', () => {
    expect(normaliseUrlInput(' example.com ')).toEqual({ ok: true, url: 'https://example.com/' });
    expect(normaliseUrlInput('http://example.co.uk/about')).toEqual({ ok: true, url: 'http://example.co.uk/about' });
  });
  it('rejects empty, spaces, other schemes and dotless hosts', () => {
    expect(normaliseUrlInput('')).toEqual({ ok: false, reason: 'empty' });
    expect(normaliseUrlInput('not a site')).toEqual({ ok: false, reason: 'invalid' });
    expect(normaliseUrlInput('ftp://example.com')).toEqual({ ok: false, reason: 'invalid' });
    expect(normaliseUrlInput('localhost')).toEqual({ ok: false, reason: 'invalid' });
  });
  it('leaves blank optional fields out instead of defaulting them', () => {
    expect(buildRequest(EMPTY_FORM, 'https://a.com/')).toEqual({ url: 'https://a.com/' });
    const req = buildRequest(
      { ...EMPTY_FORM, businessType: ' Law Firm ', role: 'Founder', sector: '  ', teamSize: '11-50', timeSink: 'quotes' },
      'https://a.com/',
    );
    expect(req).toEqual({
      url: 'https://a.com/',
      businessType: 'Law Firm',
      persona: { role: 'Founder' },
      teamSize: '11-50',
      timeSink: 'quotes',
    });
  });
  it('clips over-long fields', () => {
    const req = buildRequest({ ...EMPTY_FORM, timeSink: 'x'.repeat(500) }, 'https://a.com/');
    expect(req.timeSink).toHaveLength(200);
  });
});

const baseReport = (): AuditReport => ({
  auditId: 'a1',
  auditedAt: '2026-11-20T10:00:00Z',
  url: 'https://a.com/',
  domain: 'a.com',
  pagesRead: [],
  aiStatus: 'pending',
  buyerFitStatus: 'pending',
  security: {
    score: 50,
    checks: [
      { id: 'sec-csp', status: 'fail', detail: 'No CSP' },
      { id: 'sec-hsts', status: 'warn', detail: 'Short' },
      { id: 'sec-https', status: 'pass', detail: 'ok' },
      { id: 'sec-dmarc', status: 'fail', detail: 'No DMARC' },
      { id: 'wp-theme', status: 'info', detail: 'custom' },
    ],
  },
  health: { score: 80, checks: [{ id: 'seo-title', status: 'warn', detail: 'Short title' }], measuredByGoogle: false },
  cms: { platform: 'unknown' },
  stack: [],
  fixFirst: [{ source: 'check', section: 'security', checkId: 'sec-csp' }],
  attributions: [],
  leadCapture: false,
});

const bf: BuyerFit = {
  businessType: 'Agency',
  businessTypeInferred: true,
  persona: { role: 'Founder', size: 'Small', sector: 'SaaS', trigger: 'Growth' },
  personaInferred: true,
  score: 60,
  verdict: { summary: 's', brutalTruth: 'b' },
  strengths: [],
  criteria: [
    { name: 'Low', score: 9, reasoning: '', weight: 'low' },
    { name: 'High A', score: 5, reasoning: '', weight: 'high' },
    { name: 'Med', score: 3, reasoning: '', weight: 'medium' },
    { name: 'High B', score: 3, reasoning: '', weight: 'high' },
  ],
  mismatchIndex: [],
  actions: [{ text: 'Add a case study', horizon: 'now', impact: 'high', effort: 'low', owner: 'marketing' }],
};

describe('merging late results', () => {
  it('applies buyer fit and the re-ranked fixFirst', () => {
    const res: BuyerFitResult = {
      auditId: 'a1',
      buyerFitStatus: 'ok',
      buyerFit: bf,
      fixFirst: [
        { source: 'ai', section: 'buyer-fit', actionIndex: 0 },
        { source: 'check', section: 'security', checkId: 'sec-dmarc' },
      ],
    };
    const r = mergeBuyerFit(baseReport(), res);
    expect(r.buyerFitStatus).toBe('ok');
    expect(r.buyerFit).toBe(bf);
    const rows = resolveFixFirst(r);
    expect(rows.map((x) => x.title)).toEqual(['Add a case study', expect.stringContaining('DMARC')]);
    expect(rows[1]?.detail).toBe('No DMARC');
    expect(r.aiStatus).toBe('pending');
  });
  it('treats ok-without-data as unavailable and ignores other audits', () => {
    const r = mergeBuyerFit(baseReport(), { auditId: 'a1', buyerFitStatus: 'ok', fixFirst: [] });
    expect(r.buyerFitStatus).toBe('unavailable');
    const other = baseReport();
    expect(mergeBuyerFit(other, { auditId: 'zzz', buyerFitStatus: 'ok', buyerFit: bf, fixFirst: [] })).toBe(other);
  });
  it('applies AI results and statuses', () => {
    const ai: AiResult = {
      auditId: 'a1',
      aiStatus: 'fixture',
      fixture: true,
      ai: { business: { summary: 's', customers: 'b2b' }, opportunities: [], notWorthIt: 'n' },
    };
    const r = mergeAi(baseReport(), ai);
    expect(r.aiStatus).toBe('fixture');
    expect(r.fixture).toBe(true);
    expect(mergeAi(baseReport(), { auditId: 'a1', aiStatus: 'unavailable' }).ai).toBeUndefined();
    expect(mergeAi(baseReport(), { auditId: 'a1', aiStatus: 'ok' }).aiStatus).toBe('unavailable');
  });
  it('marks only pending parts unavailable', () => {
    expect(markUnavailable(baseReport(), 'ai').aiStatus).toBe('unavailable');
    const done = { ...baseReport(), buyerFitStatus: 'ok' as const, buyerFit: bf };
    expect(markUnavailable(done, 'buyerFit').buyerFitStatus).toBe('ok');
  });
  it('drops ai fix items that point at missing actions', () => {
    const r = { ...baseReport(), fixFirst: [{ source: 'ai' as const, section: 'buyer-fit' as const, actionIndex: 3 }] };
    expect(resolveFixFirst(r)).toEqual([]);
  });
});

describe('check ordering and summaries', () => {
  it('lists fails before warns, separates passes and notes', () => {
    const s = splitChecks(baseReport().security.checks);
    expect(s.toAddress.map((c) => c.status)).toEqual(['fail', 'fail', 'warn']);
    expect(s.passed.map((c) => c.id)).toEqual(['sec-https']);
    expect(s.info.map((c) => c.id)).toEqual(['wp-theme']);
  });
  it('summarises counts and the top issue', () => {
    const s = sectionSummary(baseReport().security.checks);
    expect(s.fix).toBe(2);
    expect(s.improve).toBe(1);
    expect(s.startWith).toBeTruthy();
    expect(sectionSummary([{ id: 'sec-https', status: 'pass', detail: '' }])).toEqual({ fix: 0, improve: 0, startWith: null });
  });
  it('sorts criteria critical first and finds the weakest', () => {
    expect(sortCriteria(bf.criteria).map((c) => c.name)).toEqual(['High A', 'High B', 'Med', 'Low']);
    expect(weakestCriterion(bf.criteria)?.name).toBe('High B');
    expect(weakestCriterion([])).toBeNull();
  });
  it('only allows http(s) links', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://a.com/x')).toBe('https://a.com/x');
    expect(safeHref('nope')).toBeNull();
  });
});

describe('omitted checks line', () => {
  it('shows in the sections the late part feeds', () => {
    expect(hasOmittedChecks({}, 'security')).toBe(false);
    expect(hasOmittedChecks({ omitted: ['email-dns'] }, 'security')).toBe(true);
    expect(hasOmittedChecks({ omitted: ['email-dns'] }, 'health')).toBe(false);
    expect(hasOmittedChecks({ omitted: ['pagespeed'] }, 'health')).toBe(true);
    expect(hasOmittedChecks({ omitted: ['site-files'] }, 'security')).toBe(true);
    expect(hasOmittedChecks({ omitted: ['site-files'] }, 'health')).toBe(true);
    expect(hasOmittedChecks({ omitted: ['wordpress'] }, 'security')).toBe(true);
    expect(COPY.omittedChecks).toBe("Some checks didn't finish in time and aren't shown.");
  });
});

describe('WordPress panel names (shared displayName)', () => {
  it('filters banned words, control characters and long names, as the server checks do', () => {
    expect(displayName({ type: 'plugin', slug: 'wp-vuln', name: 'WP Vulnerability Scanner' })).toBe('wp-vuln');
    expect(displayName({ type: 'plugin', slug: 'insecure-x', name: null })).toBe('a plugin');
    expect(displayName({ type: 'theme', slug: 'evil\u0000\u001bslug', name: null })).toBe('evilslug');
    expect(displayName({ type: 'plugin', slug: 'x', name: 'y'.repeat(80) }).length).toBeLessThanOrEqual(51);
    expect(COPY.wordpress.plugins).toBe('Plugins and theme');
  });
});
