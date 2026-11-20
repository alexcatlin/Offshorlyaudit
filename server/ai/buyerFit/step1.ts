// Buyer fit step 1 (BUILD_GUIDE §5.4): evaluation criteria, plus filling in any blank buyer
// fields and, if blank, the business type, from the homepage text.
import type { CriterionWeight, EvaluationCriterion, Persona } from '../../../shared/types.js';
import type { FetchedPage } from '../../site/types.js';
import type { CallJson, JsonSchema } from '../client.js';
import { dataRule, fence, visitorValue, type Boundary } from '../prompt.js';
import { asArray, cleanText, coerceEnum, hasBannedWords, isRecord } from '../text.js';

export const STEP1_TIMEOUT_MS = 25_000;
export const STEP1_MAX_TOKENS = 2_000;
const HOMEPAGE_CHARS = 5_000;

export const PERSONA_FIELDS = ['role', 'size', 'sector', 'trigger'] as const;
type PersonaField = (typeof PERSONA_FIELDS)[number];

/** Neutral fallbacks when neither the visitor nor the AI supplied a value. Never a fixed persona. */
export const PERSONA_FALLBACKS: Persona = {
  role: 'Senior decision-maker',
  size: 'Mid-sized company',
  sector: 'Not specified',
  trigger: 'Looking for a new supplier',
};
export const BUSINESS_TYPE_FALLBACK = 'Business';

const PERSONA_CAPS: Record<PersonaField, { words: number; chars: number }> = {
  role: { words: 8, chars: 200 },
  size: { words: 10, chars: 200 },
  sector: { words: 8, chars: 200 },
  trigger: { words: 20, chars: 300 },
};
const VISITOR_CAPS: Record<PersonaField, number> = { role: 200, size: 200, sector: 200, trigger: 300 };

export interface Step1Input {
  pages: readonly FetchedPage[];
  businessType?: string;
  persona?: Partial<Persona>;
}

export interface Step1Result {
  businessType: string;
  businessTypeInferred: boolean;
  businessContext: string;
  persona: Persona;
  personaInferred: boolean;
  criteria: EvaluationCriterion[];
}

const trimVisitor = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Visitor values, trimmed and capped (blank → ''). */
export const givenFields = (input: Pick<Step1Input, 'businessType' | 'persona'>) => {
  const persona = {} as Record<PersonaField, string>;
  for (const f of PERSONA_FIELDS) persona[f] = trimVisitor(input.persona?.[f], VISITOR_CAPS[f]);
  return { businessType: trimVisitor(input.businessType, 100), persona };
};

export const STEP1_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['businessType', 'businessContext', 'buyer', 'criteria'],
  properties: {
    businessType: {
      type: 'string',
      description:
        'If the business type was specified, copy it exactly. Otherwise, 4 words or fewer naming the type of business shown in the homepage text, e.g. "Digital marketing agency".',
    },
    businessContext: {
      type: 'string',
      description: 'One sentence: what this type of business does and what clients hire them for.',
    },
    buyer: {
      type: 'object',
      additionalProperties: false,
      description: 'Copy every field that was specified exactly as given. Fill in any field marked (not specified).',
      required: ['role', 'size', 'sector', 'trigger'],
      properties: {
        role: { type: 'string', description: "5 words or fewer, e.g. 'Founder', 'CTO', 'Head of Marketing'" },
        size: { type: 'string', description: "6 words or fewer, e.g. '10-50 person software company'" },
        sector: { type: 'string', description: "4 words or fewer, e.g. 'B2B SaaS'; if many sectors, 'Growing SMEs'" },
        trigger: { type: 'string', description: "10 words or fewer, e.g. 'Needs software built without hiring in-house'" },
      },
    },
    criteria: {
      type: 'array',
      description: '4 to 6 criteria.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'redFlags', 'weight'],
        properties: {
          name: { type: 'string', description: "2 to 4 words, e.g. 'Portfolio Depth'" },
          description: { type: 'string', description: 'What good looks like to a discerning buyer.' },
          redFlags: { type: 'array', items: { type: 'string' }, description: '2 to 3 warning signs.' },
          weight: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

export const buildStep1Prompt = (input: Step1Input, boundary: Boundary): { system: string; user: string } => {
  const given = givenFields(input);
  const btBlank = !given.businessType;
  const personaBlank = PERSONA_FIELDS.some((f) => !given.persona[f]);
  // Visitor-typed values stay inside the fence; the instructions only refer to them.
  const bt = btBlank ? 'business of the type shown in the homepage text' : 'business of the type given in VISITOR ANSWERS';

  const system = [
    'You are a senior consultant specialising in evaluating and procuring professional services and suppliers. You have 20 years of experience advising buyers on how to assess and select the right partner.',
    'Use UK English spelling.',
    'Answer only with the requested structured result.',
    dataRule(boundary),
  ].join('\n\n');

  const parts: string[] = [
    `VISITOR ANSWERS (typed by the website visitor):\n${fence(
      boundary,
      [
        `BUSINESS TYPE: ${visitorValue(given.businessType, boundary)}`,
        'THE BUYER:',
        `- Role: ${visitorValue(given.persona.role, boundary)}`,
        `- Business Size: ${visitorValue(given.persona.size, boundary)}`,
        `- Sector: ${visitorValue(given.persona.sector, boundary)}`,
        `- Buying Trigger: ${visitorValue(given.persona.trigger, boundary)}`,
      ].join('\n'),
    )}`,
    `A potential buyer is evaluating a ${bt}. Define the optimal evaluation framework: the criteria that matter most when judging whether this type of business is credible, competent, and worth hiring.`,
    [
      'INSTRUCTIONS:',
      `- Generate 4-6 evaluation criteria specifically tailored to assessing a ${bt}.`,
      "- Each criterion must be relevant to what a buyer would look for on the business's website.",
      `- Think about what separates an excellent ${bt} from a mediocre one, from the buyer's perspective.`,
      '- Weight the criteria: what matters most for the buyer described in VISITOR ANSWERS?',
      `- Be specific to the business type. Generic criteria like "good design" are not useful. Think about what uniquely matters for a ${bt}.`,
      '- Write every field in UK English.',
    ].join('\n'),
  ];

  if (btBlank) {
    parts.push(
      'THE BUSINESS TYPE WAS NOT SPECIFIED.\nFrom the homepage text below, name the type of business in 4 words or fewer (for example "Digital marketing agency" or "Family law firm") and return it as businessType. Build the criteria around that business type.',
    );
  } else {
    parts.push('Return the business type exactly as given in VISITOR ANSWERS in businessType.');
  }
  if (personaBlank) {
    parts.push(
      'SOME BUYER DETAILS WERE NOT SPECIFIED.\nFill in each one marked (not specified) from the homepage text below: describe the buyer this website most evidently sets out to win. Be specific rather than generic (for example "Founder of a 10-50 person software company", not "business owner"). Keep the specified fields exactly as given, and build the criteria around the completed buyer.',
    );
  } else {
    parts.push('Copy every buyer field from VISITOR ANSWERS into buyer exactly as given.');
  }
  if (btBlank || personaBlank) {
    const home = input.pages[0];
    parts.push(`HOMEPAGE TEXT:\n${fence(boundary, (home?.text ?? '').slice(0, HOMEPAGE_CHARS))}`);
  }

  return { system, user: parts.join('\n\n') };
};

/** Model text, or '' when it uses a banned security word (it may be shown to the visitor). */
const safe = (value: unknown, caps: { words?: number; chars: number }): string => {
  const t = cleanText(value, caps);
  return t && !hasBannedWords(t) ? t : '';
};

const parseCriteria = (raw: unknown): EvaluationCriterion[] =>
  asArray(raw)
    .filter(isRecord)
    .map((c) => ({
      name: safe(c.name, { words: 6, chars: 60 }),
      description: cleanText(c.description, { words: 60, chars: 400 }),
      redFlags: asArray(c.redFlags)
        .map((r) => cleanText(r, { words: 30, chars: 200 }))
        .filter(Boolean)
        .slice(0, 3),
      weight: coerceEnum<CriterionWeight>(c.weight, ['high', 'medium', 'low'], 'medium'),
    }))
    .filter((c) => c.name)
    .slice(0, 6);

/** Shape check used to trigger the one retry on a useless answer. */
export const acceptStep1 = (data: Record<string, unknown>): boolean => parseCriteria(data.criteria).length > 0;

/**
 * Resolve the buyer per guide: visitor value if given, else the AI's, else a neutral
 * fallback. Given fields are copied exactly; inferred flags are set when any was blank.
 */
export const parseStep1 = (data: Record<string, unknown>, input: Pick<Step1Input, 'businessType' | 'persona'>): Step1Result => {
  const given = givenFields(input);
  const aiBuyer = isRecord(data.buyer) ? data.buyer : {};
  const persona = {} as Persona;
  let personaInferred = false;
  for (const f of PERSONA_FIELDS) {
    if (given.persona[f]) {
      persona[f] = given.persona[f];
    } else {
      personaInferred = true;
      persona[f] = safe(aiBuyer[f], PERSONA_CAPS[f]) || PERSONA_FALLBACKS[f];
    }
  }
  const businessTypeInferred = !given.businessType;
  const businessType = given.businessType || safe(data.businessType, { words: 4, chars: 100 }) || BUSINESS_TYPE_FALLBACK;

  return {
    businessType,
    businessTypeInferred,
    businessContext: cleanText(data.businessContext, { words: 50, chars: 400 }),
    persona,
    personaInferred,
    criteria: parseCriteria(data.criteria),
  };
};

export const runStep1 = async (
  input: Step1Input,
  deps: { call: CallJson; boundary: Boundary; logMeta?: Record<string, string> },
): Promise<Step1Result> => {
  const { system, user } = buildStep1Prompt(input, deps.boundary);
  const res = await deps.call({
    system,
    user,
    schema: STEP1_SCHEMA,
    maxTokens: STEP1_MAX_TOKENS,
    timeoutMs: STEP1_TIMEOUT_MS,
    label: 'buyerFit.step1',
    accept: acceptStep1,
    ...(deps.logMeta ? { logMeta: deps.logMeta } : {}),
  });
  return parseStep1(res.data, input);
};
