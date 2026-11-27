// Amendment 4 front end: the AI tab's two groups and the form order (rendered to HTML).
import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { OTHER_INDUSTRY_FALLBACK_LABEL } from '../../shared/industries.js';
import { CTA } from '../../shared/services.js';
import type { AiOpportunity, AiSection, AuditReport } from '../../shared/types.js';
import { AiOpportunities, industryBadge } from '../../src/components/AiOpportunities.js';
import { Form } from '../../src/components/Form.js';
import { AI_LOADING_STAGES, COPY, EXAMPLE_BUYER, INDUSTRY_OPTIONS } from '../../src/content/copy.js';
import { buildRequest, EMPTY_FORM } from '../../src/lib/form.js';

const siteIdea: AiOpportunity = {
  title: 'Triage incoming enquiries',
  process: 'Enquiries are sorted by hand.',
  basis: [{ kind: 'stack', techId: 'hubspot', name: 'HubSpot' }],
  aiApproach: 'Sort and draft replies for review.',
  efficiency: 'turnaround',
  measureFirst: 'Enquiries per week.',
  confidence: 'likely',
  service: { id: 'ai-automation', name: 'AI Automation', url: 'https://offshorly.com/ai-automation-agency/' },
  source: 'site',
  industryContext: 'Firms like this often sort enquiries by matter type first.',
};

const industryIdea: AiOpportunity = {
  title: 'First-pass document review',
  process: 'Contracts are likely read in full by a lawyer.',
  basis: [{ kind: 'industry', patternId: 'legal.document-review', industryLabel: 'Legal', text: 'AI reads contracts against a checklist.' }],
  aiApproach: 'Flag unusual clauses for a lawyer to judge.',
  efficiency: 'time-per-task',
  measureFirst: 'Contracts reviewed per month.',
  confidence: 'worth-checking',
  service: { id: 'ai-agent-development', name: 'AI Agent Development', url: 'https://offshorly.com/ai-agent-development/' },
  source: 'industry',
};

const report = (ai: AiSection): AuditReport => ({
  auditId: 'a1',
  auditedAt: '2026-11-20T10:00:00Z',
  url: 'https://a.com/',
  domain: 'a.com',
  pagesRead: [],
  aiStatus: 'ok',
  ai,
  buyerFitStatus: 'ok',
  security: { score: 50, checks: [] },
  health: { score: 80, checks: [], measuredByGoogle: false },
  cms: { platform: 'unknown' },
  stack: [],
  fixFirst: [],
  attributions: [],
});

const section = (opportunities: AiOpportunity[], industry: AiSection['industry'] | null = { id: 'legal', label: 'Legal', inferred: true }): AiSection => ({
  business: { summary: 'A law firm.', customers: 'b2b' },
  ...(industry ? { industry } : {}),
  opportunities,
  notWorthIt: 'Partner relationships.',
});

const render = (ai: AiSection) => renderToString(h(AiOpportunities, { report: report(ai), request: { url: 'https://a.com/' } }));

describe('AiOpportunities (Amendment 4)', () => {
  it('renders both groups, the industry badge, basis and context row; heading counts the total', () => {
    const html = render(section([siteIdea, industryIdea]));
    expect(html).toContain('2 ideas worth testing');
    expect(html).toContain('Legal · inferred from your site');
    const siteAt = html.indexOf(COPY.ai.siteGroupHeading);
    const indAt = html.indexOf('Common in your industry: Legal</h4>');
    expect(siteAt).toBeGreaterThan(-1);
    expect(indAt).toBeGreaterThan(siteAt);
    expect(html).toContain(COPY.ai.industryGroupIntro);
    expect(html).toContain('AI reads contracts against a checklist.');
    expect(html).toContain('<span class="oa-basis__kind">Common in your industry: Legal</span>');
    expect(html).toContain(COPY.ai.inYourIndustry);
    expect(html).toContain('Firms like this often sort enquiries by matter type first.');
    expect(html.indexOf('Triage incoming enquiries')).toBeLessThan(html.indexOf('First-pass document review'));
  });

  it('hides an empty group and the context row when there is no context', () => {
    const onlySite = render(section([{ ...siteIdea, industryContext: undefined }]));
    expect(onlySite).toContain(COPY.ai.siteGroupHeading);
    expect(onlySite).not.toContain('Common in your industry: Legal');
    expect(onlySite).not.toContain(COPY.ai.inYourIndustry);
    const onlyIndustry = render(section([industryIdea]));
    expect(onlyIndustry).not.toContain(COPY.ai.siteGroupHeading);
    expect(onlyIndustry).toContain('Common in your industry: Legal');
  });

  it('a visitor-chosen industry shows the plain label', () => {
    expect(industryBadge({ id: 'legal', label: 'Legal', inferred: false })).toBe('Legal');
    expect(industryBadge(undefined)).toBeNull();
  });

  it('the generic fallback industry shows no badge and a heading that names no industry', () => {
    const fallback = { id: 'other' as const, label: OTHER_INDUSTRY_FALLBACK_LABEL, inferred: true };
    expect(industryBadge(fallback)).toBeNull();
    const fallbackIdea: AiOpportunity = { ...industryIdea, basis: [{ kind: 'industry', patternId: 'other.enquiry-triage', industryLabel: OTHER_INDUSTRY_FALLBACK_LABEL, text: 'AI sorts enquiries.' }] };
    const html = render(section([fallbackIdea], fallback));
    expect(html).not.toContain('oa-badge--industry');
    expect(html).toContain('Common in businesses like yours</h4>');
    expect(html).toContain('<span class="oa-basis__kind">Common in businesses like yours</span>');
    expect(html).not.toContain('Common in your industry');
    // A free-form `other` label still shows as-is.
    const vet = render(section([industryIdea], { id: 'other', label: 'Veterinary practices', inferred: true }));
    expect(vet).toContain('Veterinary practices · inferred from your site');
    expect(vet).toContain('Common in your industry: Veterinary practices</h4>');
  });

  it('copy: industry group heading and intro', () => {
    expect(COPY.ai.industryGroupHeading('Legal')).toBe('Common in your industry: Legal');
    expect(COPY.ai.industryGroupHeading()).toBe('Common in businesses like yours');
    expect(COPY.ai.basisIndustry('Legal')).toBe('Common in your industry: Legal');
    expect(COPY.ai.basisIndustry()).toBe('Common in businesses like yours');
    expect(COPY.ai.industryGroupIntro).toBe('Common ways businesses like yours use AI. Not checked against your site.');
  });

  it('tolerates older JSON without source, industry or industryContext', () => {
    const { source: _s, industryContext: _c, ...old } = siteIdea;
    const html = render(section([old as AiOpportunity], null));
    expect(html).toContain(COPY.ai.siteGroupHeading);
    expect(html).toContain('Triage incoming enquiries');
    expect(html).not.toContain('inferred from your site');
  });

  it('pending state shows the first staged message and the under-a-minute line', () => {
    const html = renderToString(h(AiOpportunities, { report: { ...report(section([])), aiStatus: 'pending', ai: undefined }, request: { url: 'x' } }));
    expect(html).toContain(AI_LOADING_STAGES[0]!.text);
    expect(COPY.report.pendingDetail).toMatch(/under a minute/);
    expect(AI_LOADING_STAGES.map((s) => s.text)).toEqual([
      'Reading what your business does',
      'Matching common automations in your industry',
      'Checking every quote against your pages',
    ]);
  });
});

describe('Form order (Amendment 4)', () => {
  const html = renderToString(h(Form, { initial: EMPTY_FORM, error: null, onSubmit: () => undefined }));
  const at = (s: string) => {
    const i = html.indexOf(s);
    expect(i, s).toBeGreaterThan(-1);
    return i;
  };

  it('URL, email, industry select, both expanders, then the submit button, then the merged notice', () => {
    const url = at(COPY.form.urlLabel);
    const industry = at(COPY.form.industryLabel);
    const business = at(COPY.form.businessToggle);
    const buyer = at(COPY.form.buyerToggle);
    const email = at(COPY.form.emailLabel);
    const submit = at('type="submit"');
    const privacy = at(COPY.form.privacyNotice.slice(0, 40));
    expect(url).toBeLessThan(email);
    expect(email).toBeLessThan(industry);
    expect(industry).toBeLessThan(business);
    expect(business).toBeLessThan(buyer);
    expect(buyer).toBeLessThan(submit);
    expect(submit).toBeLessThan(privacy);
  });

  it('one notice under the button carries every CRM, Anthropic and privacy-policy statement', () => {
    const notice = html.slice(html.indexOf('type="submit"'));
    for (const s of [COPY.form.leadNotice, COPY.form.privacyNotice]) expect(notice).toContain(s);
    expect(notice).toContain(CTA.privacy.url);
    expect(notice).toContain('One free audit per email.');
    expect(notice).toContain('Your email is never sent to Anthropic.');
    expect(html.match(/class="oa-privacy"/g)).toHaveLength(1);
  });

  it('the pitch is one h1, a short intro and a real list of what you get', () => {
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain(`<ul class="oa-hero__gets" aria-label="${COPY.hero.getsLabel}">`);
    expect(html.match(/<li>/g)).toHaveLength(COPY.hero.gets.length);
    expect(COPY.hero.sub.match(/under 30 seconds/g)).toHaveLength(1);
  });

  it('industry select defaults to "not sure" and lists every industry', () => {
    // The blank "not sure" option is the selected default.
    expect(html).toContain(`<option selected value>${COPY.form.industryNotSure}</option>`);
    for (const o of INDUSTRY_OPTIONS) expect(html).toContain(`value="${o.value}"`);
    expect(html).not.toContain('<datalist');
  });

  it('the business expander opens when it has initial values; the buyer one stays shut', () => {
    const open = renderToString(h(Form, { initial: { ...EMPTY_FORM, tools: 'Xero' }, error: null, onSubmit: () => undefined }));
    const toggles = [...open.matchAll(/aria-expanded="(true|false)"/g)].map((m) => m[1]);
    expect(toggles).toEqual(['true', 'false']);
  });

  it('lead notice mentions the answers going to the CRM; customer labels say whose industry it is', () => {
    expect(COPY.form.leadNotice).toContain('your answers');
    expect(COPY.form.sectorLabel).toBe('Their industry (not yours)');
    expect(EXAMPLE_BUYER).not.toHaveProperty('businessType');
  });
});

describe('buildRequest (Amendment 4)', () => {
  it('includes industry and tools when set; omits them when blank', () => {
    expect(buildRequest({ ...EMPTY_FORM, industry: 'legal', tools: ' Xero ' }, 'https://a.com/')).toMatchObject({ industry: 'legal', tools: 'Xero' });
    const blank = buildRequest({ ...EMPTY_FORM, industry: '', tools: '   ' }, 'https://a.com/');
    expect(blank).not.toHaveProperty('industry');
    expect(blank).not.toHaveProperty('tools');
    expect(buildRequest({ ...EMPTY_FORM, industry: 'nope' as never }, 'https://a.com/')).not.toHaveProperty('industry');
    expect(buildRequest({ ...EMPTY_FORM, tools: 'x'.repeat(400) }, 'https://a.com/').tools).toHaveLength(150);
  });
});

describe('booking cards on the AI tab (spec 002)', () => {
  const links = (html: string) =>
    [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&')).filter((u) => u.startsWith(`${CTA.consultation.url}?`));
  const placement = (url: string) => new URL(url).searchParams.get('utm_content');

  it('with ideas: only the full card at the end (ai), no strip or link above the ideas', () => {
    const html = render(section([siteIdea, industryIdea]));
    expect(links(html).map(placement)).toEqual(['ai']);
    expect(html).not.toMatch(/oa-cta-strip|ideas below/);
    expect(html.match(/class="oa-cta"/g)).toHaveLength(1);
    expect(html.lastIndexOf('class="oa-cta"')).toBeGreaterThan(html.indexOf('Triage incoming enquiries'));
  });

  it('with one idea: the same single end card', () => {
    expect(links(render(section([siteIdea]))).map(placement)).toEqual(['ai']);
  });

  it('with no ideas: one card only (the pitch), no strip', () => {
    const html = render(section([]));
    expect(links(html).map(placement)).toEqual(['pitch']);
    expect(html.match(/class="oa-cta"/g)).toHaveLength(1);
    expect(html).not.toContain('oa-cta-strip');
  });

  it('while the AI is pending: one card only, no strip', () => {
    const html = renderToString(h(AiOpportunities, { report: { ...report(section([siteIdea])), aiStatus: 'pending', ai: undefined }, request: { url: 'x' } }));
    expect(links(html).map(placement)).toEqual(['ai']);
    expect(html.match(/class="oa-cta"/g)).toHaveLength(1);
    expect(html).not.toContain('oa-cta-strip');
  });
});
