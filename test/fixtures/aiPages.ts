// Sample pages and helpers for AI-layer tests.
import type { FetchedPage } from '../../server/site/types.js';
import type { CallJson, JsonRequest } from '../../server/ai/client.js';

export const HOME_TEXT = [
  'Acme Lettings',
  'We manage over 400 rental properties across Leeds and Bradford for private landlords.',
  'Our team handles tenant referencing, maintenance requests and rent collection every day.',
  'Book a free valuation with our friendly lettings team today.',
  'Short line',
].join('\n');

export const PAGES: FetchedPage[] = [
  {
    url: 'https://acme.example/',
    label: 'Homepage',
    title: 'Acme Lettings | Leeds letting agent',
    description: 'Letting agent in Leeds.',
    text: HOME_TEXT,
  },
  {
    url: 'https://acme.example/careers/',
    label: 'Careers',
    title: 'Careers',
    description: '',
    text: 'We are hiring a full-time lettings administrator to process tenancy paperwork and chase references. Typical response within 2 days.',
  },
];

export const STACK = [
  { id: 'hubspot', name: 'HubSpot', category: 'crm', signals: 'lead and enquiry handling' },
  { id: 'zendesk', name: 'Zendesk', category: 'helpdesk', signals: 'support triage' },
  { id: 'ga4', name: 'Google Analytics 4', category: 'analytics' },
];

/** Fake CallJson that returns queued data and records requests. */
export const fakeCall = (...responses: Record<string, unknown>[]) => {
  const requests: JsonRequest[] = [];
  const call: CallJson = async (req) => {
    requests.push(req);
    const data = responses.shift();
    if (!data) throw new Error('fakeCall: no response queued');
    return { data, usage: { input_tokens: 1, output_tokens: 1 }, model: 'fake' };
  };
  return { call, requests };
};
