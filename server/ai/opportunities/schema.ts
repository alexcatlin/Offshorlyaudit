// JSON schema for the opportunities call (raw model output, see shared RawAiOutput).
// Kept to features structured outputs accept: types, enums, required, no extra keys.
// Length and count limits are stated in descriptions and enforced by validate.ts.
// Structured output generates properties in order, so each item states its source and pattern
// before the prose that depends on them.
import { OPPORTUNITY_SERVICE_IDS } from '../../../shared/services.js';
import type { JsonSchema } from '../client.js';

export const EFFICIENCY_VALUES = ['time-per-task', 'turnaround', 'capacity', 'error-rate', 'tool-costs'] as const;
export const CONFIDENCE_VALUES = ['likely', 'worth-checking'] as const;
export const CUSTOMER_VALUES = ['b2b', 'b2c', 'both', 'unclear'] as const;
export const SOURCE_VALUES = ['site', 'industry'] as const;

export const OPPORTUNITIES_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['business', 'opportunities', 'industryExamples', 'notWorthIt'],
  properties: {
    business: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'customers', 'industryId', 'industryLabel'],
      properties: {
        summary: { type: 'string', description: 'One sentence, 30 words or fewer: what the business does and who it serves.' },
        customers: { type: 'string', enum: [...CUSTOMER_VALUES] },
        industryId: {
          type: 'string',
          description: "An industryId from INDUSTRY PLAYBOOK (copy the visitor's if given), or 'other' if none fits.",
        },
        industryLabel: {
          type: 'string',
          description: "5 words or fewer naming the industry. Only used when industryId is 'other'.",
        },
      },
    },
    opportunities: {
      type: 'array',
      description: '3 to 5 items, site ideas first.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title',
          'source',
          'patternId',
          'process',
          'quotes',
          'techIds',
          'usesAnswer',
          'aiApproach',
          'industryContext',
          'efficiency',
          'measureFirst',
          'confidence',
          'serviceId',
          'proofId',
          'sourceIds',
        ],
        properties: {
          title: { type: 'string', description: '8 words or fewer, sentence case.' },
          source: {
            type: 'string',
            enum: [...SOURCE_VALUES],
            description: "'site' when based on the site, DETECTED or VISITOR ANSWERS; 'industry' when based on a playbook pattern.",
          },
          patternId: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'A patternId from INDUSTRY PLAYBOOK for this industry. Required for industry ideas; optional for site ideas.',
          },
          process: { type: 'string', description: '30 words or fewer: the manual work as you infer it.' },
          quotes: {
            type: 'array',
            items: { type: 'string' },
            description: '0-2 quotes, each 25 words or fewer, copied exactly from the page text. Empty for industry ideas.',
          },
          techIds: { type: 'array', items: { type: 'string' }, description: 'Ids from DETECTED only; never form builders (category forms).' },
          usesAnswer: { type: 'boolean', description: 'True only if this idea relies on the visitor answers.' },
          aiApproach: {
            type: 'string',
            description:
              '40 words or fewer: what the AI would do in this work, e.g. "An assistant reads each form submission, tags it and drafts a reply for a person to approve". Never an instruction to test or try; testing goes in measureFirst.',
          },
          industryContext: {
            type: 'string',
            description:
              '35 words or fewer: how businesses of this type commonly handle this work, as a general pattern. May be empty.',
          },
          efficiency: { type: 'string', enum: [...EFFICIENCY_VALUES] },
          measureFirst: { type: 'string', description: '20 words or fewer: what to measure before building anything.' },
          confidence: { type: 'string', enum: [...CONFIDENCE_VALUES] },
          serviceId: { type: 'string', enum: [...OPPORTUNITY_SERVICE_IDS] },
          proofId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'A PROOF ID, or null.' },
          sourceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Industry ideas only: 0-2 ids from INDUSTRY SEARCH RESULTS (e.g. S1) this idea draws on. Empty for site ideas.',
          },
        },
      },
    },
    industryExamples: {
      type: 'array',
      description:
        '0-3 items, only when INDUSTRY SEARCH RESULTS are given and this business is in that industry; otherwise empty.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceIds', 'text'],
        properties: {
          sourceIds: { type: 'array', items: { type: 'string' }, description: '1-2 ids from INDUSTRY SEARCH RESULTS.' },
          text: {
            type: 'string',
            description: 'One sentence, 30 words or fewer, stating only what the cited results say. No figures.',
          },
        },
      },
    },
    notWorthIt: {
      type: 'string',
      description: '30 words or fewer: one area of this business that is probably not worth automating, and why.',
    },
  },
};
