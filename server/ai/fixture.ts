// Fixture mode: deterministic "[Sample]" output built from the real pages, run through the
// same parsers and validators as live output. Callers set `fixture: true` on the report so
// the UI shows "Sample AI output for development, not an analysis of this site".
import { INDUSTRIES, OTHER_INDUSTRY, patternsFor } from '../../shared/industries.js';
import type { BuyerFit, Persona } from '../../shared/types.js';
import type { FetchedPage } from '../site/types.js';
import { postprocessBuyerFit } from './buyerFit/postprocess.js';
import { parseStep1 } from './buyerFit/step1.js';
import { validateContextFor } from './opportunities/run.js';
import { validateOpportunities } from './opportunities/validate.js';
import type { OpportunitiesInput, OpportunitiesResult } from './types.js';

const MIN_SENTENCE = 40;
const MAX_SENTENCE_WORDS = 30;

/** Homepage sentences of 40+ characters, in page order (so they verify as quotes). */
export const sampleSentences = (pages: readonly FetchedPage[], limit = 6): string[] => {
  const text = pages[0]?.text ?? '';
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= MIN_SENTENCE && s.split(' ').length <= MAX_SENTENCE_WORDS)
    .slice(0, limit);
};

export interface FixtureBuyerFitInput {
  pages: readonly FetchedPage[];
  businessType?: string;
  persona?: Partial<Persona>;
}

export const fixtureBuyerFit = (input: FixtureBuyerFitInput): { buyerFit: BuyerFit; fixture: true } => {
  const sentences = sampleSentences(input.pages);
  const quote = (i: number, effect: 'for' | 'against', note: string) => {
    const s = sentences[i % Math.max(1, sentences.length)];
    return s ? [{ quote: s, effect, note }] : [];
  };

  // Step 1 as the model would answer it; resolved with the real buyer rules.
  const step1Raw = {
    businessType: '[Sample] Business',
    businessContext: '[Sample] A business evaluated by a prospective client from its public pages.',
    buyer: {
      role: '[Sample] Operations lead',
      size: '[Sample] Growing company',
      sector: '[Sample] Mixed sectors',
      trigger: '[Sample] Wants a dependable new supplier',
    },
    criteria: [
      { name: 'Clarity of Offer', description: 'States plainly what is offered and to whom.', redFlags: ['Vague service list', 'Jargon'], weight: 'high' },
      { name: 'Proof of Results', description: 'Shows named clients, case studies or outcomes.', redFlags: ['No case studies', 'Anonymous testimonials'], weight: 'high' },
      { name: 'Relevance to Customer', description: 'Speaks to this customer’s situation and trigger.', redFlags: ['Generic copy'], weight: 'medium' },
      { name: 'Ease of Next Step', description: 'Makes it simple to get in touch or book.', redFlags: ['Hidden contact details'], weight: 'low' },
    ],
  };
  const step1 = parseStep1(step1Raw, input);

  const step2Raw = {
    verdict: {
      summary: '[Sample] A credible first impression with room to sharpen the offer.',
      brutalTruth: '[Sample] Proof is thin for a customer who wants evidence before calling.',
    },
    strengths: ['[Sample] The homepage says what the business does early on.', '[Sample] Contact routes are easy to find.'],
    criteria: [
      { name: 'x', score: 6, reasoning: '[Sample] The offer is stated but could be more specific.', weight: 'high', evidence: quote(0, 'for', '[Sample] States the offer') },
      { name: 'x', score: 4, reasoning: '[Sample] Little specific proof is visible on these pages.', weight: 'high', evidence: quote(1, 'against', '[Sample] Claim without proof') },
      { name: 'x', score: 6, reasoning: '[Sample] Some copy speaks to this customer, much is generic.', weight: 'medium', evidence: [] },
      { name: 'x', score: 7, reasoning: '[Sample] The next step is clear.', weight: 'low', evidence: [] },
    ],
    mismatchIndex: [
      { point: '[Sample] Claims versus proof', explanation: '[Sample] Strong claims are not backed by named examples.' },
      { point: '[Sample] Audience focus', explanation: '[Sample] The copy addresses everyone rather than this customer.' },
    ],
    actions: [
      { text: '[Sample] Add one named case study to the homepage.', horizon: 'now', impact: 'high', effort: 'low', owner: 'marketing' },
      { text: '[Sample] Rewrite the opening line for this customer.', horizon: 'now', impact: 'medium', effort: 'low', owner: 'marketing' },
      { text: '[Sample] Agree the single audience to lead with.', horizon: 'later', impact: 'high', effort: 'medium', owner: 'leadership' },
      { text: '[Sample] Add structured data for services.', horizon: 'later', impact: 'low', effort: 'medium', owner: 'developer' },
    ],
  };

  return { buyerFit: postprocessBuyerFit(step2Raw, { step1, pages: input.pages }), fixture: true };
};

export const fixtureOpportunities = (input: OpportunitiesInput): OpportunitiesResult & { fixture: true } => {
  const sentences = sampleSentences(input.pages, 2);
  const saasTech = input.stack.filter((t) => t.category !== 'analytics');
  const techIds = (saasTech.length ? saasTech : input.stack).slice(0, 3).map((t) => t.id);
  const answered = Boolean(input.timeSink?.trim() || input.tools?.trim() || input.teamSize);
  // The visitor's industry when given; otherwise the generic set, as the model's 'other'.
  // Industry-idea prose stays lowercase after "[Sample]": the proper-noun filter would read a
  // capital there as a name, since "]" doesn't end a sentence.
  const industryId = input.industry ?? OTHER_INDUSTRY;
  const pattern = patternsFor(industryId)[0];
  // Phase 5: with search results, one sample example citing the first (validation drops it when
  // the searched industry differs from this one, as it would for the model).
  const firstSource = input.research?.sources[0]?.id ?? null;

  const opportunities = [
    {
      title: '[Sample] Faster handling of incoming enquiries',
      source: 'site',
      patternId: null,
      process: '[Sample] Enquiries arrive through the website and are read, sorted and answered by hand.',
      quotes: sentences,
      techIds,
      usesAnswer: answered,
      aiApproach: '[Sample] An assistant drafts replies and routes each enquiry, with a person approving before anything is sent.',
      industryContext: '[Sample] businesses like this often sort enquiries by type before anyone replies.',
      efficiency: 'turnaround',
      measureFirst: '[Sample] Count enquiries per week and time a typical reply.',
      confidence: 'likely',
      serviceId: saasTech.length >= 2 ? 'ai-saas-enhancer' : 'ai-automation',
      proofId: 'lender-appraisal',
      sourceIds: [],
    },
    {
      title: '[Sample] Tidier internal reporting',
      source: 'site',
      patternId: null,
      process: '[Sample] Someone pulls figures from several tools into a weekly update by hand.',
      quotes: sentences.slice(1),
      techIds,
      usesAnswer: answered,
      aiApproach: '[Sample] An assistant pulls the figures together and drafts the summary for a person to review.',
      industryContext: '',
      efficiency: 'time-per-task',
      measureFirst: '[Sample] Note who builds the report and how long it takes.',
      confidence: 'worth-checking',
      serviceId: 'ai-development-services',
      proofId: null,
      sourceIds: [],
    },
    ...(pattern
      ? [
          {
            title: `[Sample] ${pattern.title}`,
            source: 'industry',
            patternId: pattern.id,
            process: '[Sample] this work may be done by hand today; worth checking how it is handled now.',
            quotes: [],
            techIds: [],
            usesAnswer: false,
            aiApproach: '[Sample] an assistant handles one narrow, repetitive step of this work and hands the rest to a person.',
            industryContext: '[Sample] businesses of this type often start with the simplest repetitive step.',
            efficiency: 'capacity',
            measureFirst: '[Sample] how often this work happens and who does it.',
            confidence: 'worth-checking',
            serviceId: pattern.serviceId,
            proofId: null,
            sourceIds: firstSource ? [firstSource] : [],
          },
        ]
      : []),
  ];

  const raw = {
    business: {
      summary: `[Sample] ${input.pages[0]?.title || 'A business'} as described on its homepage.`,
      customers: 'unclear',
      industryId,
      industryLabel: input.industry ? INDUSTRIES[input.industry].label : '[Sample] general business',
    },
    opportunities,
    industryExamples: firstSource
      ? [{ text: '[Sample] one business in this industry describes using an assistant to sort incoming requests before a person replies.', sourceIds: [firstSource] }]
      : [],
    notWorthIt: '[Sample] Conversations that rely on long-standing client relationships are best left to people.',
  };

  const result = validateOpportunities(raw, validateContextFor(input));
  return { ...result, fixture: true };
};
