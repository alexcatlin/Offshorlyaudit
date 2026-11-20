import { describe, expect, it } from 'vitest';
import { fixtureBuyerFit, fixtureOpportunities, sampleSentences } from '../../server/ai/fixture.js';
import { postprocessBuyerFit } from '../../server/ai/buyerFit/postprocess.js';
import { validateOpportunities } from '../../server/ai/opportunities/validate.js';
import { verifyQuotes } from '../../server/ai/quotes.js';
import { PAGES, STACK } from '../fixtures/aiPages.js';

describe('fixture opportunities', () => {
  const input = { pages: PAGES, cms: { platform: 'wordpress' as const }, stack: STACK, saasCount: 2 };

  it('is flagged, ok, and uses real sentences that verify', () => {
    const r = fixtureOpportunities(input);
    expect(r.fixture).toBe(true);
    expect(r.status).toBe('ok');
    const opps = r.ai!.opportunities;
    expect(opps.length).toBeGreaterThanOrEqual(1);
    expect(opps.every((o) => o.title.startsWith('[Sample]'))).toBe(true);
    const quotes = opps[0]!.basis.filter((b) => b.kind === 'quote');
    expect(quotes.length).toBe(2);
    for (const q of quotes) expect(q.kind === 'quote' && q.quote.length).toBeGreaterThanOrEqual(40);
  });

  it('basis includes the detected tech', () => {
    const r = fixtureOpportunities(input);
    const stack = r.ai!.opportunities[0]!.basis.filter((b) => b.kind === 'stack').map((b) => (b.kind === 'stack' ? b.techId : ''));
    expect(stack).toEqual(['hubspot', 'zendesk']);
    expect(r.ai!.opportunities[0]!.service.id).toBe('ai-saas-enhancer');
  });

  it('passes the validator unchanged (idempotent re-validation keeps every item)', () => {
    const r = fixtureOpportunities(input);
    const again = validateOpportunities(
      {
        business: { ...r.ai!.business, industryId: r.ai!.industry?.id, industryLabel: r.ai!.industry?.label },
        notWorthIt: r.ai!.notWorthIt,
        opportunities: r.ai!.opportunities.map((o) => ({
          ...o,
          quotes: o.basis.filter((b) => b.kind === 'quote').map((b) => (b.kind === 'quote' ? b.quote : '')),
          techIds: o.basis.filter((b) => b.kind === 'stack').map((b) => (b.kind === 'stack' ? b.techId : '')),
          patternId: o.basis.find((b) => b.kind === 'industry')?.patternId ?? null,
          usesAnswer: false,
          serviceId: o.service.id,
          proofId: o.proof?.id ?? null,
        })),
      },
      { pages: PAGES, stack: STACK },
    );
    expect(again.ai!.opportunities.length).toBe(r.ai!.opportunities.length);
  });

  it('is deterministic', () => {
    expect(fixtureOpportunities(input)).toEqual(fixtureOpportunities(input));
  });

  it('no site evidence → site ideas dropped, the generic industry idea stays', () => {
    const r = fixtureOpportunities({ ...input, pages: [{ ...PAGES[0]!, text: 'Tiny.' }], stack: [] });
    expect(r.fixture).toBe(true);
    expect(r.ai!.opportunities.map((o) => o.source)).toEqual(['industry']);
    expect(r.ai!.industry).toEqual({ id: 'other', label: '[Sample] general business', inferred: true });
  });

  it('has one industry idea from the playbook, server text, worth checking, never the consultation', () => {
    const r = fixtureOpportunities({ ...input, industry: 'legal' });
    const ind = r.ai!.opportunities.filter((o) => o.source === 'industry');
    expect(ind).toHaveLength(1);
    expect(ind[0]!.confidence).toBe('worth-checking');
    expect(ind[0]!.basis[0]).toMatchObject({ kind: 'industry', patternId: 'legal.intake', industryLabel: 'Legal' });
    expect(r.ai!.industry).toEqual({ id: 'legal', label: 'Legal', inferred: false });
    expect(r.ai!.opportunities.some((o) => o.service.id === 'free-ai-consultation')).toBe(false);
  });
});

describe('fixture buyer fit', () => {
  it('is flagged, scored server-side, and its quotes verify', () => {
    const { buyerFit, fixture } = fixtureBuyerFit({ pages: PAGES });
    expect(fixture).toBe(true);
    expect(buyerFit.criteria).toHaveLength(4);
    expect(buyerFit.score).toBeTypeOf('number');
    const quotes = buyerFit.criteria.flatMap((c) => c.evidence ?? []);
    expect(quotes.length).toBeGreaterThan(0);
    expect(verifyQuotes(quotes, PAGES)).toHaveLength(Math.min(2, quotes.length));
    expect(buyerFit.verdict.summary.startsWith('[Sample]')).toBe(true);
  });

  it('blank persona is inferred and flagged; given fields kept', () => {
    const blank = fixtureBuyerFit({ pages: PAGES }).buyerFit;
    expect(blank.personaInferred).toBe(true);
    expect(blank.businessTypeInferred).toBe(true);
    const given = fixtureBuyerFit({
      pages: PAGES,
      businessType: 'Letting agent',
      persona: { role: 'Landlord', size: 'Small', sector: 'Property', trigger: 'Slow agent' },
    }).buyerFit;
    expect(given.persona).toEqual({ role: 'Landlord', size: 'Small', sector: 'Property', trigger: 'Slow agent' });
    expect(given.personaInferred).toBe(false);
    expect(given.businessType).toBe('Letting agent');
  });

  it('survives re-validation', () => {
    const { buyerFit } = fixtureBuyerFit({ pages: PAGES });
    const again = postprocessBuyerFit(
      { ...buyerFit, criteria: buyerFit.criteria.map((c) => ({ ...c, evidence: c.evidence ?? [] })) },
      {
        step1: {
          businessType: buyerFit.businessType,
          businessTypeInferred: buyerFit.businessTypeInferred,
          businessContext: '',
          persona: buyerFit.persona,
          personaInferred: buyerFit.personaInferred,
          criteria: buyerFit.criteria.map((c) => ({ name: c.name, description: '', redFlags: [], weight: c.weight })),
        },
        pages: PAGES,
      },
    );
    expect(again).toEqual(buyerFit);
  });

  it('sampleSentences picks homepage sentences of 40+ chars', () => {
    const s = sampleSentences(PAGES);
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s.every((x) => x.length >= 40)).toBe(true);
  });
});
