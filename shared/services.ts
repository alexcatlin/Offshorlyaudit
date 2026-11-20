// Offshorly service catalogue, proof points and CTAs.
// Source: docs/offshorly-brand-and-services.md. The server owns these URLs, names and
// proof texts; the model only ever picks ids.
//
// Never add: a price or "free"/"fixed-price" claim for the proof of concept, or the
// inconsistent first-tool monthly saving figure from the lender case study.
import type { AiServiceId, Proof, ProofId, Service, ServiceId } from './types.js';

export const OFFSHORLY_ORIGIN = 'https://offshorly.com';

export const SERVICES: Record<ServiceId, Service> = {
  // AI services
  'free-ai-consultation': {
    id: 'free-ai-consultation',
    name: 'Free AI Consultation',
    path: '/free-ai-consultation/',
    kind: 'ai',
    fitsWhen:
      'Any high-volume, rule-heavy, costly-by-hand process; the default first step, and the right choice when evidence is thin',
  },
  'ai-automation': {
    id: 'ai-automation',
    name: 'AI Automation',
    path: '/ai-automation-agency/',
    kind: 'ai',
    fitsWhen:
      'High-volume rule-heavy work done by hand: document review, compliance checks, data extraction, document generation, pricing and valuation, matching and sorting, meeting transcripts, routine admin',
  },
  'ai-agent-development': {
    id: 'ai-agent-development',
    name: 'AI Agent Development',
    path: '/ai-agent-development/',
    kind: 'ai',
    fitsWhen: 'Judgement-heavy multi-step work on messy inputs (scans, free text, photos, forms)',
  },
  'ai-development-services': {
    id: 'ai-development-services',
    name: 'AI Development Services',
    path: '/ai-development-services/',
    kind: 'ai',
    fitsWhen: 'Wants custom AI built without hiring an in-house team yet',
  },
  'dedicated-ai-teams': {
    id: 'dedicated-ai-teams',
    name: 'Dedicated AI Teams',
    path: '/teams/',
    kind: 'ai',
    fitsWhen: 'Long, changing roadmap; high-volume operations',
  },
  'ai-product-development': {
    id: 'ai-product-development',
    name: 'AI Product Development',
    path: '/ai-product-development/',
    kind: 'ai',
    fitsWhen: 'Companies with a shipped software product',
  },
  'ai-saas-enhancer': {
    id: 'ai-saas-enhancer',
    name: 'AI SaaS Enhancer',
    path: '/ai-saas-enhancer/',
    kind: 'ai',
    fitsWhen: 'SaaS sprawl (HubSpot, Salesforce, Jira, Xero, Notion and similar)',
  },

  // Web services
  websites: {
    id: 'websites',
    name: 'Websites and Web Apps',
    path: '/websites/',
    kind: 'web',
    fitsWhen: 'Needs a new website or web application built',
  },
  wordpress: {
    id: 'wordpress',
    name: 'WordPress Builds',
    path: '/wordpress/',
    kind: 'web',
    fitsWhen: 'Runs WordPress and needs it built, updated, secured or maintained',
  },
  'website-redesign': {
    id: 'website-redesign',
    name: 'Website Redesign',
    path: '/website-redesign/',
    kind: 'web',
    fitsWhen: 'Existing site has search, speed, AI-readiness or first-impression gaps',
  },
};

export const SERVICE_IDS = Object.keys(SERVICES) as ServiceId[];

export const AI_SERVICE_IDS = SERVICE_IDS.filter((id) => SERVICES[id].kind === 'ai') as AiServiceId[];

export const isServiceId = (id: string): id is ServiceId => Object.hasOwn(SERVICES, id);

export const isAiServiceId = (id: string): id is AiServiceId =>
  isServiceId(id) && SERVICES[id].kind === 'ai';

export const PROOFS: Record<ProofId, Proof> = {
  'lender-appraisal': {
    id: 'lender-appraisal',
    serviceIds: ['ai-automation', 'ai-agent-development', 'ai-development-services', 'free-ai-consultation'],
    text: 'Appraisal review cut from 45–50 minutes to 15 for a US mortgage lender',
    path: '/case-study/us-mortgage-lender/',
  },
  'lender-savings': {
    id: 'lender-savings',
    serviceIds: ['ai-automation', 'ai-development-services', 'dedicated-ai-teams'],
    text: '$175,000+ a month saved in under nine months',
    path: '/case-study/us-mortgage-lender/',
  },
  'compliance-tickets': {
    id: 'compliance-tickets',
    serviceIds: ['ai-agent-development', 'ai-automation'],
    text: 'Daily compliance tickets cut from 140+ to about 20 in around six weeks',
    path: '/case-studies/',
  },
  'contained-roi': {
    id: 'contained-roi',
    serviceIds: ['ai-development-services', 'ai-product-development', 'ai-saas-enhancer'],
    text: '3x ROI in year one',
    path: '/case-study/contained-io/',
  },
};

export const PROOF_IDS = Object.keys(PROOFS) as ProofId[];

export const isProofId = (id: string): id is ProofId => Object.hasOwn(PROOFS, id);

/** True if the proof may be shown alongside the given service. */
export const proofAllowedFor = (proofId: ProofId, serviceId: ServiceId): boolean =>
  PROOFS[proofId].serviceIds.includes(serviceId);

export const offshorlyUrl = (path: string): string => `${OFFSHORLY_ORIGIN}${path}`;

export const serviceUrl = (id: ServiceId): string => offshorlyUrl(SERVICES[id].path);

export const proofUrl = (id: ProofId): string => offshorlyUrl(PROOFS[id].path);

export const CTA = {
  consultation: {
    label: 'Book a free AI consultation',
    url: 'https://offshorly.com/free-ai-consultation/',
  },
  calCom: {
    label: 'Book a free AI consultation',
    url: 'https://cal.com/offshorly/30min',
  },
  contact: {
    label: "Tell us what you're building",
    url: 'https://offshorly.com/contact/',
  },
  privacy: {
    label: 'Privacy policy',
    url: 'https://offshorly.com/privacy-policy/',
  },
} as const;
