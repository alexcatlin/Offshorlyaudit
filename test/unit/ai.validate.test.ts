import { describe, expect, it } from 'vitest';
import {
  disallowedFigures,
  FIGURE_PATTERN,
  NOT_WORTH_IT_FALLBACK,
  SUMMARY_FALLBACK,
  validateOpportunities,
  type ValidateContext,
} from '../../server/ai/opportunities/validate.js';
import { runOpportunities } from '../../server/ai/opportunities/run.js';
import { fakeCall, PAGES, STACK } from '../fixtures/aiPages.js';

const QUOTE = 'Our team handles tenant referencing, maintenance requests and rent collection every day.';
const QUOTE_WITH_FIGURE = 'Typical response within 2 days';

const opp = (over: Record<string, unknown> = {}) => ({
  title: 'Automate tenant referencing checks',
  process: 'Staff gather and check tenant references by hand.',
  quotes: [QUOTE],
  techIds: [],
  usesAnswer: false,
  aiApproach: 'Extract reference details and flag gaps for a person to review.',
  efficiency: 'time-per-task',
  measureFirst: 'How long one reference check takes today.',
  confidence: 'likely',
  serviceId: 'ai-automation',
  proofId: null,
  ...over,
});

const raw = (opportunities: unknown[], extra: Record<string, unknown> = {}) => ({
  business: { summary: 'A Leeds letting agent serving private landlords.', customers: 'b2c' },
  opportunities,
  notWorthIt: 'Landlord relationship calls are best kept personal.',
  ...extra,
});

const ctx: ValidateContext = { pages: PAGES, stack: STACK };

const first = (r: ReturnType<typeof validateOpportunities>) => r.ai!.opportunities[0]!;

describe('validateOpportunities', () => {
  it('accepts a good item and attaches server-owned service name and URL', () => {
    const r = validateOpportunities(raw([opp()]), ctx);
    expect(r.status).toBe('ok');
    expect(first(r).service).toEqual({
      id: 'ai-automation',
      name: 'AI Automation',
      url: 'https://offshorly.com/ai-automation-agency/',
    });
    expect(first(r).basis[0]).toMatchObject({ kind: 'quote', quote: QUOTE.replace(/\.$/, ''), pageLabel: 'Homepage' });
  });

  it('bad serviceId → ai-development-services; the consultation is never an idea service', () => {
    const r = validateOpportunities(raw([opp({ serviceId: 'hack-the-planet' })]), ctx);
    expect(first(r).service.id).toBe('ai-development-services');
    const web = validateOpportunities(raw([opp({ serviceId: 'wordpress' })]), ctx);
    expect(first(web).service.id).toBe('ai-development-services');
    const consult = validateOpportunities(raw([opp({ serviceId: 'free-ai-consultation' })]), ctx);
    expect(first(consult).service.id).toBe('ai-development-services');
    expect(consult.stats!.remaps).toEqual([{ from: 'free-ai-consultation', to: 'ai-development-services' }]);
    // A model id that isn't id-like is logged as 'invalid', never as prose.
    const prose = validateOpportunities(raw([opp({ serviceId: 'Our team should build it' })]), ctx);
    expect(prose.stats!.remaps).toEqual([{ from: 'invalid', to: 'ai-development-services' }]);
  });

  it('ai-product-development without a verified quote → ai-development-services', () => {
    const r = validateOpportunities(raw([opp({ serviceId: 'ai-product-development', quotes: [], techIds: ['hubspot'] })]), ctx);
    expect(first(r).service.id).toBe('ai-development-services');
    const ok = validateOpportunities(raw([opp({ serviceId: 'ai-product-development' })]), ctx);
    expect(first(ok).service.id).toBe('ai-product-development');
  });

  it('ignores URLs from the model', () => {
    const r = validateOpportunities(
      raw([
        opp({
          title: 'Automate referencing https://evil.example/x',
          aiApproach: 'See <a href="https://evil.example">here</a> or www.evil.example and evil.com/page for details.',
          serviceUrl: 'https://evil.example',
        }),
      ]),
      ctx,
    );
    const o = first(r);
    const all = JSON.stringify({ title: o.title, aiApproach: o.aiApproach });
    expect(all).not.toMatch(/evil|https?:|<a|www\./);
    expect(o.service.url).toBe('https://offshorly.com/ai-automation-agency/');
  });

  it('figure regex drops the item', () => {
    for (const bad of ['Save 20 hours a week', 'Cut costs by 30%', 'Make it 3x faster', 'Save £500 monthly', 'Done in 5 days']) {
      const r = validateOpportunities(raw([opp({ aiApproach: bad })]), ctx);
      expect(r.status, bad).toBe('insufficient');
    }
  });

  it('a figure from the visitor answer survives', () => {
    const r = validateOpportunities(raw([opp({ process: 'Chasing references takes 10 hours each week.', usesAnswer: true })]), {
      ...ctx,
      timeSink: 'Chasing references, about 10 hours every week',
    });
    expect(r.status).toBe('ok');
    expect(first(r).basis.some((b) => b.kind === 'answer' && b.field === 'timeSink')).toBe(true);
  });

  it('a figure from a verified quote survives', () => {
    const r = validateOpportunities(
      raw([opp({ quotes: [QUOTE_WITH_FIGURE], process: 'Replies promised within 2 days are drafted by hand.' })]),
      ctx,
    );
    expect(r.status).toBe('ok');
  });

  it('invented quote leaves no basis → item dropped', () => {
    const r = validateOpportunities(raw([opp({ quotes: ['We process ten thousand applications a week'] })]), ctx);
    expect(r.status).toBe('insufficient');
    expect(r.ai?.opportunities).toEqual([]);
  });

  it('undetected techId rejected', () => {
    const r = validateOpportunities(raw([opp({ quotes: [], techIds: ['salesforce'] })]), ctx);
    expect(r.status).toBe('insufficient');
    const ok = validateOpportunities(raw([opp({ quotes: [], techIds: ['salesforce', 'zendesk'] })]), ctx);
    expect(first(ok).basis).toEqual([{ kind: 'stack', techId: 'zendesk', name: 'Zendesk' }]);
  });

  it('form-builder tech (category forms) is never a basis; real evidence tools are kept', () => {
    const withCf7 = { ...ctx, stack: [...STACK, { id: 'cf7', name: 'Contact Form 7', category: 'forms' }] };
    const only = validateOpportunities(raw([opp({ quotes: [], techIds: ['cf7'] })]), withCf7);
    expect(only.status).toBe('insufficient');
    const mixed = validateOpportunities(raw([opp({ quotes: [], techIds: ['cf7', 'zendesk'] })]), withCf7);
    expect(first(mixed).basis).toEqual([{ kind: 'stack', techId: 'zendesk', name: 'Zendesk' }]);
  });

  it('usesAnswer without an answer rejected', () => {
    const r = validateOpportunities(raw([opp({ quotes: [], usesAnswer: true })]), ctx);
    expect(r.status).toBe('insufficient');
    const withTeam = validateOpportunities(raw([opp({ quotes: [], usesAnswer: true })]), { ...ctx, teamSize: '11-50' });
    expect(first(withTeam).basis).toEqual([{ kind: 'answer', field: 'teamSize' }]);
  });

  it('saas-enhancer with only 1 stack basis remapped; 2 kept', () => {
    const one = validateOpportunities(raw([opp({ serviceId: 'ai-saas-enhancer', techIds: ['hubspot'] })]), ctx);
    expect(first(one).service.id).toBe('ai-automation');
    const two = validateOpportunities(raw([opp({ serviceId: 'ai-saas-enhancer', techIds: ['hubspot', 'zendesk'] })]), ctx);
    expect(first(two).service.id).toBe('ai-saas-enhancer');
  });

  it('proof id must exist and be allowed for the final service; server attaches text', () => {
    const ok = validateOpportunities(raw([opp({ proofId: 'lender-appraisal' })]), ctx);
    expect(first(ok).proof).toEqual({
      id: 'lender-appraisal',
      text: 'Appraisal review cut from 45–50 minutes to 15 for a US mortgage lender',
      url: 'https://offshorly.com/case-study/us-mortgage-lender/',
    });
    expect(first(validateOpportunities(raw([opp({ proofId: 'made-up' })]), ctx)).proof).toBeUndefined();
    // contained-roi is not allowed with ai-automation
    expect(first(validateOpportunities(raw([opp({ proofId: 'contained-roi' })]), ctx)).proof).toBeUndefined();
  });

  it('caps lengths and coerces enums', () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`).join(' ');
    const r = validateOpportunities(
      raw([opp({ title: long, process: long, aiApproach: long, measureFirst: long, efficiency: 'vibes', confidence: 'certain' })], {
        business: { summary: long, customers: 'aliens' },
      }),
      ctx,
    );
    const o = first(r);
    const words = (s: string) => s.split(/\s+/).length;
    expect(words(o.title)).toBeLessThanOrEqual(8);
    expect(words(o.process)).toBeLessThanOrEqual(30);
    expect(words(o.aiApproach)).toBeLessThanOrEqual(40);
    expect(words(o.measureFirst)).toBeLessThanOrEqual(20);
    expect(o.efficiency).toBe('time-per-task');
    expect(o.confidence).toBe('worth-checking');
    expect(r.ai!.business.customers).toBe('unclear');
    expect(words(r.ai!.business.summary)).toBeLessThanOrEqual(30);
  });

  it('keeps at most 3 site ideas, likely first', () => {
    const r = validateOpportunities(
      raw([
        opp({ title: 'One', confidence: 'worth-checking' }),
        opp({ title: 'Two', confidence: 'likely' }),
        opp({ title: 'Three', confidence: 'worth-checking' }),
        opp({ title: 'Four', confidence: 'likely' }),
      ]),
      ctx,
    );
    expect(r.ai!.opportunities.map((o) => o.title)).toEqual(['Two', 'Four', 'One']);
  });

  it('notWorthIt fallback when missing, empty or carrying a figure', () => {
    expect(validateOpportunities(raw([opp()], { notWorthIt: '' }), ctx).ai!.notWorthIt).toBe(NOT_WORTH_IT_FALLBACK);
    expect(validateOpportunities(raw([opp()], { notWorthIt: 42 }), ctx).ai!.notWorthIt).toBe(NOT_WORTH_IT_FALLBACK);
    expect(validateOpportunities(raw([opp()], { notWorthIt: 'Saves only 2 hours' }), ctx).ai!.notWorthIt).toBe(NOT_WORTH_IT_FALLBACK);
  });

  it('garbage input → insufficient with safe defaults', () => {
    const r = validateOpportunities('not an object', ctx);
    expect(r.status).toBe('insufficient');
    expect(r.ai!.notWorthIt).toBe(NOT_WORTH_IT_FALLBACK);
    expect(r.ai!.business.customers).toBe('unclear');
  });

  it('disallowedFigures is case and whitespace insensitive', () => {
    expect(disallowedFigures('About 10 Hours', ['about 10   hours a week'])).toEqual([]);
    expect(disallowedFigures('About 12 hours', ['about 10 hours'])).toEqual(['12 hours']);
  });

  it('disallowedFigures checks whole figures, not a symbol plus first digit or last digit plus %', () => {
    const page = ['100% committed. Plans from $19/month'];
    expect(disallowedFigures('You are losing 40% of visitors.', page)).toEqual(['40%']);
    expect(disallowedFigures('This costs you $15,000 a month.', page)).toEqual(['$15,000']);
  });

  it('disallowedFigures needs numeric boundaries in the source', () => {
    expect(disallowedFigures('Up 40%', ['grew 140% last year'])).toEqual(['40%']);
    expect(disallowedFigures('Only $19', ['plans from $190'])).toEqual(['$19']);
    expect(disallowedFigures('Only $19', ['plans from $19.99'])).toEqual(['$19']);
    expect(disallowedFigures('Only $19', ['plans from $19,000'])).toEqual(['$19']);
    expect(disallowedFigures('Saves 3x', ['about 13x faster'])).toEqual(['3x']);
  });

  it('disallowedFigures allows a figure that is in a source', () => {
    expect(disallowedFigures('Up 40%', ['grew 40% last year'])).toEqual([]);
    expect(disallowedFigures('Plans start at $19.', ['Plans from $19/month'])).toEqual([]);
    expect(disallowedFigures('From $ 19 a month', ['plans from $19/month'])).toEqual([]);
    expect(disallowedFigures('About 40 Percent', ['roughly 40  percent of leads'])).toEqual([]);
    expect(disallowedFigures('£2.5m saved', ['we saved clients £2.5m'])).toEqual([]);
    expect(disallowedFigures('£2.5m saved', ['we saved clients £2.5bn'])).toEqual(['£2.5m']);
  });

  it('disallowedFigures leaves non-figure numbers alone with no source', () => {
    for (const t of ['Trading since 2014', 'Launched in 2025', 'Support 24/7', 'A top 5 firm', '500+ clients', 'Watch our 2-minute video', 'ISO 27001 certified']) {
      expect(disallowedFigures(t, []), t).toEqual([]);
    }
  });

  it('disallowedFigures reads decimal durations whole', () => {
    expect(disallowedFigures('Takes 2.5 hours', ['each report takes 2.5 hours'])).toEqual([]);
    expect(disallowedFigures('Takes 2.5 hours', ['each report takes 5 hours'])).toEqual(['2.5 hours']);
    expect(disallowedFigures('About 0.5 days', ['about 5 days'])).toEqual(['0.5 days']);
    expect(disallowedFigures('You spend 1.5 hours a day on it', ['1.5 hours a day'])).toEqual([]);
  });

  it('disallowedFigures checks the whole range', () => {
    expect(disallowedFigures('Calls take 45–50 minutes', ['calls take 50 minutes'])).toEqual(['45–50 minutes']);
    expect(disallowedFigures('Calls take 45–50 minutes', ['calls take 45–50 minutes'])).toEqual([]);
    expect(disallowedFigures('Calls take 45 to 50 minutes', ['calls take 45 to 50 minutes'])).toEqual([]);
    expect(disallowedFigures('Calls take 45 to 50 minutes', ['calls take 50 minutes'])).toEqual(['45 to 50 minutes']);
    expect(disallowedFigures('Ships in 2-3 days', ['ships in 3 days'])).toEqual(['2-3 days']);
    expect(disallowedFigures('Saves 10–50%', ['saves up to 50%'])).toEqual(['10–50%']);
  });

  it('disallowedFigures flags ×, per cent, months and years with no source', () => {
    expect(disallowedFigures('Replies 3× faster', [])).toEqual(['3×']);
    expect(disallowedFigures('Cuts 40 per cent of the work', [])).toEqual(['40 per cent']);
    expect(disallowedFigures('Pays back in 18 months', [])).toEqual(['18 months']);
    expect(disallowedFigures('Saves 2 years of effort', [])).toEqual(['2 years']);
    expect(disallowedFigures('Cuts 40 per cent of the work', ['about 40 per cent'])).toEqual([]);
  });

  it('figure scan stays linear on long digit runs', () => {
    for (const s of ['1'.repeat(20_000), Array(10_000).fill('1').join(',')]) {
      expect(s.length).toBeGreaterThanOrEqual(19_999);
      const t0 = performance.now();
      const n = [...s.matchAll(FIGURE_PATTERN)].length;
      expect(disallowedFigures(s, [])).toHaveLength(1);
      expect(performance.now() - t0).toBeLessThan(100);
      expect(n).toBe(0);
    }
  });

  it('disallowedFigures rejects a field over 2,000 characters without scanning', () => {
    expect(disallowedFigures('word '.repeat(500), [])).toHaveLength(1);
    expect(disallowedFigures('word '.repeat(400), [])).toEqual([]);
  });
});

describe('opportunities honesty filters (model prose only)', () => {
  it('drops an idea whose model text uses a banned security word', () => {
    for (const field of ['title', 'process', 'aiApproach', 'measureFirst']) {
      const r = validateOpportunities(raw([opp({ [field]: 'Fix the insecure booking form and patch vulnerabilities' }), opp({ title: 'Second idea' })]), ctx);
      expect(r.ai!.opportunities.map((o) => o.title), field).toEqual(['Second idea']);
    }
  });

  it('summary and notWorthIt with a banned word fall back', () => {
    const r = validateOpportunities(raw([opp()], { business: { summary: 'An agent that was hacked last year.', customers: 'b2c' }, notWorthIt: 'Breach reporting.' }), ctx);
    expect(r.ai!.business.summary).toBe(SUMMARY_FALLBACK);
    expect(r.ai!.notWorthIt).toBe(NOT_WORTH_IT_FALLBACK);
  });

  it('a quote containing "data breach" copied from the page is kept as evidence', () => {
    const page = { url: 'https://law.example/', label: 'Homepage', title: 'Law', description: '', text: 'We help clients respond to a data breach and notify the regulator quickly.' };
    const r = validateOpportunities(
      raw([opp({ quotes: ['We help clients respond to a data breach and notify the regulator quickly'], title: 'Triage incoming client enquiries', process: 'Enquiries are read and routed by hand.', aiApproach: 'Sort enquiries by matter type for a solicitor to review.' })]),
      { pages: [page], stack: [] },
    );
    expect(r.status).toBe('ok');
    expect(first(r).basis[0]).toMatchObject({ kind: 'quote', quote: 'We help clients respond to a data breach and notify the regulator quickly' });
  });

  it('quote basis carries only the verified fields, never the model note or effect', () => {
    const r = validateOpportunities(raw([opp({ quotes: [{ quote: QUOTE, note: 'Visit https://evil.example <b>now</b>', effect: 'against' }] })]), ctx);
    expect(first(r).basis[0]).toEqual({ kind: 'quote', quote: QUOTE.replace(/\.$/, ''), pageUrl: 'https://acme.example/', pageLabel: 'Homepage' });
  });
});

describe('runOpportunities', () => {
  it('calls once with the schema and validates the result', async () => {
    const { call, requests } = fakeCall(raw([opp()]));
    const r = await runOpportunities({ pages: PAGES, cms: { platform: 'wordpress' }, stack: STACK, saasCount: 2 }, { call, log: () => undefined });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.label).toBe('opportunities');
    expect(requests[0]!.maxTokens).toBe(4000);
    expect(requests[0]!.timeoutMs).toBe(60_000);
    expect(r.status).toBe('ok');
  });
});

describe('text hygiene', async () => {
  const { stripUrlsAndHtml, capWords } = await import('../../server/ai/text.js');
  it('strips URLs, emails and tags; decodes common entities', () => {
    expect(stripUrlsAndHtml('R&amp;D at <b>Acme</b>, mail hi@acme.example or see https://x.example/a.')).toBe('R&D at Acme, mail or see');
    expect(stripUrlsAndHtml('Use [our form](https://x.example) today')).toBe('Use our form today');
  });
  it('caps words with an ellipsis', () => {
    expect(capWords('one two three four', 2)).toBe('one two…');
  });
});
