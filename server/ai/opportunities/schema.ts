// JSON schema for the opportunities call (raw model output, see shared RawAiOutput).
// Kept to features structured outputs accept: types, enums, required, no extra keys.
// Length and count limits are stated in descriptions and enforced by validate.ts.
import { AI_SERVICE_IDS } from '../../../shared/services.js';
import type { JsonSchema } from '../client.js';

export const EFFICIENCY_VALUES = ['time-per-task', 'turnaround', 'capacity', 'error-rate', 'tool-costs'] as const;
export const CONFIDENCE_VALUES = ['likely', 'worth-checking'] as const;
export const CUSTOMER_VALUES = ['b2b', 'b2c', 'both', 'unclear'] as const;

export const OPPORTUNITIES_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['business', 'opportunities', 'notWorthIt'],
  properties: {
    business: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'customers'],
      properties: {
        summary: { type: 'string', description: 'One sentence, 30 words or fewer: what the business does and who it serves.' },
        customers: { type: 'string', enum: [...CUSTOMER_VALUES] },
      },
    },
    opportunities: {
      type: 'array',
      description: '1 to 3 items, most likely first.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title',
          'process',
          'quotes',
          'techIds',
          'usesAnswer',
          'aiApproach',
          'efficiency',
          'measureFirst',
          'confidence',
          'serviceId',
          'proofId',
        ],
        properties: {
          title: { type: 'string', description: '8 words or fewer.' },
          process: { type: 'string', description: '30 words or fewer: the manual work as you infer it.' },
          quotes: {
            type: 'array',
            items: { type: 'string' },
            description: '0-2 quotes, each 25 words or fewer, copied exactly from the page text.',
          },
          techIds: { type: 'array', items: { type: 'string' }, description: 'Ids from DETECTED only.' },
          usesAnswer: { type: 'boolean', description: 'True only if this idea relies on the visitor answers.' },
          aiApproach: { type: 'string', description: '40 words or fewer: how AI could help, as a hypothesis to test.' },
          efficiency: { type: 'string', enum: [...EFFICIENCY_VALUES] },
          measureFirst: { type: 'string', description: '20 words or fewer: what to measure before building anything.' },
          confidence: { type: 'string', enum: [...CONFIDENCE_VALUES] },
          serviceId: { type: 'string', enum: [...AI_SERVICE_IDS] },
          proofId: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'A PROOF ID, or null.' },
        },
      },
    },
    notWorthIt: {
      type: 'string',
      description: '30 words or fewer: one area of this business that is probably not worth automating, and why.',
    },
  },
};
