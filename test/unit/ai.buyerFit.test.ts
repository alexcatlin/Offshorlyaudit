import { describe, expect, it } from 'vitest';
import { BRUTAL_TRUTH_FALLBACK, clampScore, postprocessBuyerFit, VERDICT_SUMMARY_FALLBACK } from '../../server/ai/buyerFit/postprocess.js';
import { runBuyerFit } from '../../server/ai/buyerFit/run.js';
import { BUSINESS_TYPE_FALLBACK, parseStep1, PERSONA_FALLBACKS, type Step1Result } from '../../server/ai/buyerFit/step1.js';
import type { FetchedPage } from '../../server/site/types.js';
import { fakeCall, PAGES } from '../fixtures/aiPages.js';

const QUOTE = 'We manage over 400 rental properties across Leeds and Bradford for private landlords';

const step1Data = {
  businessType: 'Letting agent',
  businessContext: 'Letting agents find tenants and manage rentals for landlords.',
  buyer: { role: 'Portfolio landlord', size: 'Five to ten properties', sector: 'Residential property', trigger: 'Current agent is slow' },
  criteria: [
    { name: 'Local Track Record', description: 'Shows properties managed locally.', redFlags: ['No numbers', 'No area'], weight: 'high' },
    { name: 'Service Clarity', description: 'Clear fee and service tiers.', redFlags: ['Hidden fees'], weight: 'medium' },
    { name: 'Responsiveness', description: 'Promises and proves fast replies.', redFlags: ['No SLA'], weight: 'low' },
    { name: 'Compliance', description: 'Shows licensing and deposit protection.', redFlags: ['No accreditation'], weight: 'HIGH' },
  ],
};

const step1: Step1Result = parseStep1(step1Data, {});

const step2Data = (over: Record<string, unknown> = {}) => ({
  verdict: { summary: 'Solid local agent.', brutalTruth: 'No fees shown.' },
  strengths: ['Clear area focus.', 'Specific numbers.', 'Easy booking.', 'Fourth strength.'],
  criteria: [
    { name: 'Renamed 1', score: 8, reasoning: 'Good.', weight: 'low', evidence: [{ quote: QUOTE, effect: 'for', note: 'Shows scale' }] },
    { name: 'Renamed 2', score: 14, reasoning: 'Too high.', weight: 'low', evidence: [{ quote: 'We are the cheapest agent in Yorkshire', effect: 'for', note: 'x' }] },
    { name: 'Renamed 3', score: -3, reasoning: 'Too low.', weight: 'high', evidence: [] },
    { name: 'Renamed 4', score: 6.6, reasoning: 'Rounded.', weight: 'medium', evidence: [] },
  ],
  mismatchIndex: [
    { point: 'Fees', explanation: 'Claims transparency, shows no fees.' },
    { point: 'Speed', explanation: 'No response promise.' },
  ],
  actions: Array.from({ length: 8 }, (_, i) => ({
    text: `Action ${i + 1}`,
    horizon: i === 0 ? 'soon' : 'now',
    impact: i === 0 ? 'huge' : 'high',
    effort: i === 0 ? 'tiny' : 'low',
    owner: i === 0 ? 'ceo' : 'marketing',
  })),
  ...over,
});

describe('step 1 buyer resolution', () => {
  it('blank persona → inferred from the AI and flagged', () => {
    const r = parseStep1(step1Data, { persona: {} });
    expect(r.personaInferred).toBe(true);
    expect(r.persona).toEqual(step1Data.buyer);
    expect(r.businessTypeInferred).toBe(true);
    expect(r.businessType).toBe('Letting agent');
  });

  it('given fields are copied exactly, even if the AI changed them', () => {
    const given = { role: 'Founder', size: '25-person agency', sector: 'B2B SaaS', trigger: 'Needs a rebuild' };
    const r = parseStep1(
      { ...step1Data, businessType: 'Something else', buyer: { role: 'CTO', size: 'x', sector: 'y', trigger: 'z' } },
      { businessType: 'Digital agency', persona: given },
    );
    expect(r.persona).toEqual(given);
    expect(r.personaInferred).toBe(false);
    expect(r.businessType).toBe('Digital agency');
    expect(r.businessTypeInferred).toBe(false);
  });

  it('partly blank: given kept, blanks filled, flagged', () => {
    const r = parseStep1(step1Data, { persona: { role: 'Founder', sector: '  ' } });
    expect(r.persona.role).toBe('Founder');
    expect(r.persona.sector).toBe('Residential property');
    expect(r.personaInferred).toBe(true);
  });

  it('neutral fallbacks when the AI gives nothing; never a fixed persona', () => {
    const r = parseStep1({ criteria: step1Data.criteria }, {});
    expect(r.persona).toEqual(PERSONA_FALLBACKS);
    expect(r.businessType).toBe(BUSINESS_TYPE_FALLBACK);
    expect(r.personaInferred).toBe(true);
  });

  it('coerces criterion weights and caps at 6', () => {
    expect(step1.criteria[3]?.weight).toBe('high');
    const many = parseStep1({ ...step1Data, criteria: Array(9).fill(step1Data.criteria[0]) }, {});
    expect(many.criteria).toHaveLength(6);
  });
});

describe('postprocessBuyerFit', () => {
  it('takes names and weights from step 1 when counts match', () => {
    const r = postprocessBuyerFit(step2Data(), { step1, pages: PAGES });
    expect(r.criteria.map((c) => c.name)).toEqual(step1.criteria.map((c) => c.name));
    expect(r.criteria.map((c) => c.weight)).toEqual(['high', 'medium', 'low', 'high']);
  });

  it('keeps step-2 names (coerced weights) when counts differ', () => {
    const data = step2Data();
    const r = postprocessBuyerFit({ ...data, criteria: (data.criteria as unknown[]).slice(0, 3) }, { step1, pages: PAGES });
    expect(r.criteria.map((c) => c.name)).toEqual(['Renamed 1', 'Renamed 2', 'Renamed 3']);
    expect(r.criteria[2]?.weight).toBe('high');
  });

  it('clamps scores to 0–10 integers', () => {
    const r = postprocessBuyerFit(step2Data(), { step1, pages: PAGES });
    expect(r.criteria.map((c) => c.score)).toEqual([8, 10, 0, 7]);
    expect(clampScore('7')).toBe(7);
    expect(clampScore('nope')).toBe(0);
  });

  it('drops invented quotes and keeps verified ones', () => {
    const r = postprocessBuyerFit(step2Data(), { step1, pages: PAGES });
    expect(r.criteria[0]?.evidence).toEqual([
      { quote: QUOTE, pageUrl: 'https://acme.example/', pageLabel: 'Homepage', effect: 'for', note: 'Shows scale' },
    ]);
    expect(r.criteria[1]?.evidence).toBeUndefined();
  });

  it('caps strengths at 3 and actions at 6', () => {
    const r = postprocessBuyerFit(step2Data(), { step1, pages: PAGES });
    expect(r.strengths).toHaveLength(3);
    expect(r.actions).toHaveLength(6);
  });

  it('coerces out-of-range enums to defaults', () => {
    const r = postprocessBuyerFit(step2Data(), { step1, pages: PAGES });
    expect(r.actions[0]).toEqual({ text: 'Action 1', horizon: 'now', impact: 'medium', effort: 'medium', owner: 'marketing' });
  });

  it('computes the score server-side from the processed criteria', () => {
    const r = postprocessBuyerFit(step2Data(), { step1, pages: PAGES });
    // weights h,m,l,h = 3,2,1,3; scores 8,10,0,7 → (24+20+0+21)/9×10 = 72.2 → 72
    expect(r.score).toBe(72);
  });

  it('strips URLs and HTML from model strings', () => {
    const r = postprocessBuyerFit(
      step2Data({ verdict: { summary: 'Visit <b>https://evil.example</b> now', brutalTruth: 'ok' } }),
      { step1, pages: PAGES },
    );
    expect(r.verdict.summary).toBe('Visit now');
  });
});

describe('runBuyerFit', () => {
  it('runs step 1 then step 2 with the right budgets and returns the post-processed result', async () => {
    const { call, requests } = fakeCall(step1Data, step2Data());
    const r = await runBuyerFit({ pages: PAGES, persona: { role: 'Founder' } }, { call });
    expect(requests.map((q) => [q.label, q.timeoutMs])).toEqual([
      ['buyerFit.step1', 25_000],
      ['buyerFit.step2', 45_000],
    ]);
    expect(r.persona.role).toBe('Founder');
    expect(r.personaInferred).toBe(true);
    expect(r.businessTypeInferred).toBe(true);
    expect(r.score).toBe(72);
    // Step 2 sees step 1's criteria and resolved persona.
    expect(requests[1]!.user).toContain('"Local Track Record" [Weight: HIGH]');
    expect(requests[1]!.user).toContain('- Role: Founder');
    expect(requests[1]!.user).toContain('- Sector: Residential property');
  });

  it('throws when step 1 yields no criteria', async () => {
    const { call } = fakeCall({ ...step1Data, criteria: [] });
    await expect(runBuyerFit({ pages: PAGES }, { call })).rejects.toThrow();
  });

  it('propagates a call failure', async () => {
    const call = async () => {
      throw new Error('boom');
    };
    await expect(runBuyerFit({ pages: PAGES }, { call })).rejects.toThrow('boom');
  });
});

describe('buyer fit honesty filters (model prose only)', () => {
  const LAW_PAGE: FetchedPage = {
    url: 'https://law.example/',
    label: 'Homepage',
    title: 'Smith & Co Solicitors',
    description: 'Data protection solicitors.',
    text: 'We advise companies on what to do after a data breach and how to report it to the regulator within 72 hours. Fixed fees from £950 for a first review.',
  };

  it('drops strengths, actions and mismatch items with an invented figure', () => {
    const r = postprocessBuyerFit(
      step2Data({
        strengths: ['You are losing 40% of visitors at the first screen.', 'Clear area focus.'],
        actions: [
          { text: 'This costs you £10k a month: add a fee table.', horizon: 'now', impact: 'high', effort: 'low', owner: 'marketing' },
          { text: 'Add a fee table.', horizon: 'now', impact: 'high', effort: 'low', owner: 'marketing' },
        ],
        mismatchIndex: [
          { point: 'Speed', explanation: 'Buyers wait 3 days for a reply.' },
          { point: 'Fees', explanation: 'Claims transparency, shows no fees.' },
        ],
      }),
      { step1, pages: PAGES },
    );
    expect(r.strengths).toEqual(['Clear area focus.']);
    expect(r.actions.map((a) => a.text)).toEqual(['Add a fee table.']);
    expect(r.mismatchIndex.map((m) => m.point)).toEqual(['Fees']);
  });

  it('blanks a criterion reasoning with an invented figure; replaces verdict fields with fallbacks', () => {
    const data = step2Data({ verdict: { summary: 'Loses 2x the leads of rivals.', brutalTruth: 'Takes 5 weeks to reply.' } });
    (data.criteria as Record<string, unknown>[])[0]!.reasoning = 'Only 12% of buyers would trust this.';
    const r = postprocessBuyerFit(data, { step1, pages: PAGES });
    expect(r.criteria[0]!.reasoning).toBe('');
    expect(r.criteria[0]!.score).toBe(8);
    expect(r.verdict).toEqual({ summary: VERDICT_SUMMARY_FALLBACK, brutalTruth: BRUTAL_TRUTH_FALLBACK });
  });

  it('keeps a figure that is on the page, or that the visitor typed', () => {
    const data = step2Data({ strengths: ['Shows it manages over 400 rental properties, which proves scale.'] });
    (data.criteria as Record<string, unknown>[])[0]!.reasoning = 'The "typical response within 2 days" promise nearly meets the 48 hours this buyer wants.';
    const r = postprocessBuyerFit(data, { step1, pages: PAGES, given: { persona: { trigger: 'Needs replies within 48 hours' } } });
    expect(r.strengths).toEqual(['Shows it manages over 400 rental properties, which proves scale.']);
    expect(r.criteria[0]!.reasoning).toMatch(/within 2 days.*48 hours/);
    // Without the visitor's answer, "48 hours" is not allowed.
    const bare = postprocessBuyerFit(data, { step1, pages: PAGES });
    expect(bare.criteria[0]!.reasoning).toBe('');
  });

  it('drops model prose using a banned security word', () => {
    const data = step2Data({
      verdict: { summary: 'The site looks insecure and dated.', brutalTruth: 'No fees shown.' },
      strengths: ['Clear area focus.', 'Not obviously hackable.'],
      actions: [{ text: 'Patch the vulnerability in the contact form.', horizon: 'now', impact: 'high', effort: 'low', owner: 'developer' }],
      mismatchIndex: [{ point: 'Trust', explanation: 'A breach would hurt landlords.' }],
    });
    (data.criteria as Record<string, unknown>[])[0]!.reasoning = 'It may have been hacked.';
    const r = postprocessBuyerFit(data, { step1, pages: PAGES });
    expect(r.verdict.summary).toBe(VERDICT_SUMMARY_FALLBACK);
    expect(r.verdict.brutalTruth).toBe('No fees shown.');
    expect(r.strengths).toEqual(['Clear area focus.']);
    expect(r.actions).toEqual([]);
    expect(r.mismatchIndex).toEqual([]);
    expect(r.criteria[0]!.reasoning).toBe('');
  });

  it('a verified quote with "data breach" and figures from a law firm page survives; a banned model note is dropped', () => {
    const lawStep1 = parseStep1({ ...step1Data, criteria: step1Data.criteria.slice(0, 1) }, {});
    const quote = 'We advise companies on what to do after a data breach and how to report it to the regulator within 72 hours';
    const r = postprocessBuyerFit(
      {
        verdict: { summary: 'Specialist and specific.', brutalTruth: 'Fees from £950 are buried.' },
        strengths: ['Names the 72 hours reporting deadline buyers worry about.'],
        criteria: [
          {
            name: 'Expertise',
            score: 8,
            reasoning: 'Explains the steps after a data breach, citing the 72 hours deadline.',
            weight: 'high',
            evidence: [
              { quote, effect: 'for', note: 'Shows breach-response know-how.' },
              { quote: 'Fixed fees from £950 for a first review', effect: 'for', note: 'Clear starting price.' },
            ],
          },
        ],
        mismatchIndex: [],
        actions: [],
      },
      { step1: lawStep1, pages: [LAW_PAGE] },
    );
    // Quotes are evidence copied from the site: kept, including "data breach" and the figures.
    expect(r.criteria[0]!.evidence?.map((e) => e.quote)).toEqual([quote, 'Fixed fees from £950 for a first review']);
    // The model's own note using "breach" is dropped; the clean note stays.
    expect(r.criteria[0]!.evidence?.[0]?.note).toBeUndefined();
    expect(r.criteria[0]!.evidence?.[1]?.note).toBe('Clear starting price.');
    // Model reasoning repeating "data breach" is model prose: blanked. Page figures are fine elsewhere.
    expect(r.criteria[0]!.reasoning).toBe('');
    expect(r.verdict.brutalTruth).toBe('Fees from £950 are buried.');
    expect(r.strengths).toEqual(['Names the 72 hours reporting deadline buyers worry about.']);
  });

  it('step 1: inferred buyer fields, business type and criterion names with a banned word fall back', () => {
    const r = parseStep1(
      {
        ...step1Data,
        businessType: 'Insecure web shop',
        buyer: { ...step1Data.buyer, trigger: 'Was hacked last year' },
        criteria: [{ name: 'Vulnerability Handling', description: 'x', redFlags: [], weight: 'high' }, ...step1Data.criteria],
      },
      {},
    );
    expect(r.businessType).toBe(BUSINESS_TYPE_FALLBACK);
    expect(r.persona.trigger).toBe(PERSONA_FALLBACKS.trigger);
    expect(r.criteria.map((c) => c.name)).not.toContain('Vulnerability Handling');
    // A visitor's own words are copied exactly, never filtered.
    expect(parseStep1(step1Data, { persona: { trigger: 'We were hacked last year' } }).persona.trigger).toBe('We were hacked last year');
  });

  it('runBuyerFit passes the visitor answers as allowed figure sources', async () => {
    const data = step2Data({ strengths: ['Answers a landlord who wants a reply within 24 hours.'] });
    const { call } = fakeCall(step1Data, data);
    const r = await runBuyerFit({ pages: PAGES, persona: { trigger: 'Wants a reply within 24 hours' } }, { call });
    expect(r.strengths).toEqual(['Answers a landlord who wants a reply within 24 hours.']);
    const { call: call2 } = fakeCall(step1Data, data);
    expect((await runBuyerFit({ pages: PAGES }, { call: call2 })).strengths).toEqual([]);
  });
});
