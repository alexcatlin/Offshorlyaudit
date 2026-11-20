// String hygiene for model output: strip URLs and HTML, cap length, coerce enums, and the two
// honesty filters for model-written prose (banned security words, unsupported figures).
// Quotes copied from the site are evidence, verified separately, and never go through
// these filters.
import { normaliseForMatch } from './quotes.js';

/**
 * Words the model must not use about a third-party site (PLAN wording rules): we never call a
 * site vulnerable, insecure, hacked or breached. Applies to model-written prose only.
 */
export const BANNED_MODEL_WORDS = /vulnerab|insecure|hack(?:ed|able)|breach/i;

export const hasBannedWords = (text: string): boolean => BANNED_MODEL_WORDS.test(text);

// A whole number: digits with optional thousands commas and decimals ("15,000", "2.5").
const NUM = String.raw`\d(?:[\d,]*\d)?(?:\.\d+)?`;
// Never start a figure mid-number: stops "2.5 hours" reading as "5 hours" and keeps the scan
// linear on long digit runs (each run has one starting point, not one per digit).
const START = String.raw`(?<![\d.,])`;
// A whole number or a range ("45–50", "2-3", "45 to 50"): the full range must be in a source.
const NUM_OR_RANGE = String.raw`(?:${NUM}\s*(?:[-–—]|to)\s*)?${NUM}`;

/**
 * Money, percentages, multiples and durations (docs/PLAN.md honesty rules). Each alternative
 * captures the whole figure, so "$15,000" is checked as "$15,000", not "$1". Bare years
 * ("since 2014") and hyphenated adjectives ("2-minute video") are not figures.
 */
export const FIGURE_PATTERN = new RegExp(
  [
    String.raw`[£$€]\s?${NUM}(?:\s?(?:k|m|bn|million|billion)\b)?`,
    String.raw`${START}${NUM_OR_RANGE}\s?(?:%|per\s?cent\b)`,
    String.raw`${START}${NUM_OR_RANGE}\s*(?:x\b|×|times\b)`,
    String.raw`${START}${NUM_OR_RANGE}\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?|yrs?)\b`,
  ].join('|'),
  'gi',
);

/** Longer model fields are rejected outright rather than scanned. */
export const MAX_FIGURE_SCAN_CHARS = 2000;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const tokenRe = (token: string): string =>
  /^[-–—]$/.test(token) ? '[-–—]' : token === 'percent' ? String.raw`per\s*cent` : escapeRe(token);

/**
 * Source matcher for one figure: case-insensitive, any whitespace between symbol, number and
 * unit, and numeric boundaries so "40%" isn't found in "140%" and "$19" isn't found in "$190",
 * "$19.99" or "$19,000". Any dash matches any dash in a range; "percent" matches "per cent".
 */
const figureMatcher = (figure: string): RegExp => {
  const tokens = normaliseForMatch(figure).replace(/\s+/g, '').match(/[\d.,]+|[a-z]+|[^\d.,a-z]/g) ?? [];
  const body = tokens.map(tokenRe).join(String.raw`\s*`);
  const last = tokens[tokens.length - 1] ?? '';
  const right = /\d$/.test(last) ? String.raw`(?![\d]|[.,]\d)` : /[a-z]$/.test(last) ? '(?![a-z])' : '';
  return new RegExp(String.raw`(?<![\d.,])${body}${right}`, 'i');
};

/**
 * Figures in `text` that do not appear (case/whitespace-insensitive, whole number) in any allowed
 * source. A field over MAX_FIGURE_SCAN_CHARS is not scanned and counts as one disallowed figure.
 */
export const disallowedFigures = (text: string, allowedSources: readonly string[]): string[] => {
  if (text.length > MAX_FIGURE_SCAN_CHARS) return [`(field over ${MAX_FIGURE_SCAN_CHARS} characters)`];
  const sources = allowedSources.map(normaliseForMatch);
  const bad: string[] = [];
  for (const m of text.matchAll(FIGURE_PATTERN)) {
    const re = figureMatcher(m[0]);
    if (!sources.some((s) => re.test(s))) bad.push(m[0]);
  }
  return bad;
};

/**
 * True when a piece of model-written prose may be shown: no banned word and no figure that
 * isn't in an allowed source. Check the uncapped text so a cut can't hide a figure.
 */
export const proseAllowed = (text: string, allowedFigureSources: readonly string[]): boolean =>
  !hasBannedWords(text) && disallowedFigures(text, allowedFigureSources).length === 0;

const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const SCHEME_URL = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"')\]]+/gi;
const BARE_DOMAIN =
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:com|co|uk|org|net|io|ai|dev|app|biz|info|me|us|eu|de|fr|au|nz|ca)\b(?:\/[^\s<>"')\]]*)?/gi;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const HTML_TAG = /<\/?[a-z!][^>]*>/gi;
const ENTITY = /&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi;
const NAMED: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const decodeEntity = (e: string): string => NAMED[e.toLowerCase()] ?? ' ';

/** Remove URLs, email addresses, HTML tags/entities and angle brackets; collapse whitespace. */
export const stripUrlsAndHtml = (text: string): string =>
  text
    .replace(MARKDOWN_LINK, '$1')
    .replace(HTML_TAG, ' ')
    .replace(ENTITY, decodeEntity)
    .replace(SCHEME_URL, '')
    .replace(EMAIL, '')
    .replace(BARE_DOMAIN, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim();

/** Cap to `max` words; adds an ellipsis when cut. */
export const capWords = (text: string, max: number): string => {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(' ');
  return `${words.slice(0, max).join(' ').replace(/[\s,;:.–—-]+$/, '')}…`;
};

/** Cap to `max` characters at a word boundary; adds an ellipsis when cut. */
export const capChars = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const atSpace = cut.lastIndexOf(' ');
  return `${(atSpace > max * 0.6 ? cut.slice(0, atSpace) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
};

export interface CleanOptions {
  words?: number;
  chars: number;
}

/** Model string → safe display string ('' if not a string). */
export const cleanText = (value: unknown, { words, chars }: CleanOptions): string => {
  if (typeof value !== 'string') return '';
  let s = stripUrlsAndHtml(value);
  if (words) s = capWords(s, words);
  return capChars(s, chars);
};

/** Same as cleanText but without length caps (used for figure checks before truncation). */
export const cleanUncapped = (value: unknown): string => (typeof value === 'string' ? stripUrlsAndHtml(value) : '');

export const coerceEnum = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value.trim().toLowerCase())
    ? (value.trim().toLowerCase() as T)
    : fallback;

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// ---------- Amendment 4: industry knowledge filters ----------

// Nouns for "other firms": "most firms", "leading agencies", "the majority of practices".
const FIRMS = String.raw`(?:firms|businesses|companies|practices|agencies|organisations|organizations|providers|brands|retailers|sellers|shops|clinics|studios|consultancies|landlords|operators|merchants|suppliers)`;
// "agents"/"teams" are also everyday nouns ("the most common requests agents handle"), so they
// count as firm nouns only with at most one word after the quantifier ("most letting agents").
const PEOPLE_FIRMS = String.raw`(?:agents|teams)`;
// Up to N filler words between the quantifier and the firm noun ("most UK accountancy firms").
// Bounded repetition after a literal prefix, so each match attempt is bounded: linear overall.
const FILLER = (n: number): string => String.raw`(?:[\p{L}\p{N}]+\s+){0,${n}}`;

/**
 * Claims about what other firms do, or appeals to research, that we can't stand behind.
 * Model-written industry context with any of these is blanked. Quantifiers (most, majority of,
 * leading, top) count only before a firm noun, so "the most time-consuming step" and "leading to
 * delays" pass; competitors/rivals count only in claim shapes ("your competitors", "rivals
 * already…"). Linear: literal prefixes with bounded repetition.
 */
export const ADOPTION_CLAIM = new RegExp(
  [
    String.raw`\bmost\s+(?!of\s+the\s+time\b)${FILLER(2)}${FIRMS}\b`,
    String.raw`\bmajority\s+of\s+${FILLER(2)}${FIRMS}\b`,
    String.raw`\bleading\s+(?!to\b)${FILLER(1)}${FIRMS}\b`,
    String.raw`\btop\s+(?!of\b)${FILLER(2)}${FIRMS}\b`,
    String.raw`\b(?:most|majority\s+of|leading(?!\s+to\b)|top(?!\s+of\b))\s+${FILLER(1)}${PEOPLE_FIRMS}\b`,
    String.raw`\b(?:your|their|many|most|some|other|local)\s+(?:[\p{L}]+\s+)?(?:competitors|rivals)\b`,
    String.raw`\b(?:competitors|rivals)\s+(?:are|already|use|now|have|often|increasingly|tend|typically|all)\b`,
    String.raw`(?<!\bcase\s)\bstudies\b`,
    String.raw`\bresearch\s+(?:shows|suggests|found|finds)\b`,
    String.raw`\bsurveys?\s+(?:show|shows|suggest|suggests|found|finds|find)\b`,
    String.raw`\baccording\s+to\s+(?:a\s+|the\s+|one\s+)?(?:recent\s+)?(?:survey|study|research|report)\b`,
    String.raw`\bon\s+average\b`,
    String.raw`\bindustry\s+average\b`,
  ].join('|'),
  'iu',
);

export const hasAdoptionClaim = (text: string): boolean => ADOPTION_CLAIM.test(text);

/** Placeholder for an email address removed from visitor text. */
export const EMAIL_REDACTED = '[email removed]';

/**
 * Removes email-like strings from visitor free text, so an address typed into an answer never
 * reaches a prompt. Token-based (split on whitespace), so linear on any input: a token with an
 * "@" that has text before it and a dot somewhere after it counts as an email.
 */
export const redactEmails = (text: string): string =>
  text
    .split(/(\s+)/)
    .map((tok) => {
      const at = tok.indexOf('@');
      return at > 0 && tok.indexOf('.', at + 2) > at + 1 ? EMAIL_REDACTED : tok;
    })
    .join('');

// One word: letters/digits, optionally joined by apostrophes or hyphens ("firm's", "Smith-Jones").
// The separator is required between groups, so matching is linear.
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const POSSESSIVE = /['’]s$/iu;
const UPPER_START = /^\p{Lu}/u;
/** All-caps acronym of 1–5 letters, optionally plural ("AI", "CRM", "CVs"). */
const ACRONYM = /^\p{Lu}{1,5}s?$/u;
const SENTENCE_BREAK = /[.!?\n]/;

/**
 * Capitalised single words that are never treated as company or product names: days, months,
 * dates, and well-known UK public bodies, schemes and terms.
 */
const COMMON_CAPITALISED = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'english', 'british', 'uk',
  'christmas', 'easter', 'ofsted', 'hmrc', 'vat', 'gdpr', 'self-assessment',
]);

/**
 * Multi-word public bodies, schemes and dates, lowercased. Every word of a matching phrase passes
 * ("Making Tax Digital"), but a part on its own does not ("House", "Black"). Matched only as
 * consecutive words separated by whitespace.
 */
const KNOWN_PHRASES: readonly (readonly string[])[] = [
  'companies house', 'making tax digital', 'land registry', 'hm land registry', 'gift aid', 'self assessment',
  'black friday', 'cyber monday', 'boxing day', 'bank holiday', 'bank holidays', 'good friday', 'new year',
  'christmas eve', 'christmas day', 'easter monday',
].map((p) => p.split(' '));
const PHRASE_FIRST_WORDS = new Set(KNOWN_PHRASES.map((p) => p[0]!));

const bare = (w: string): string => w.toLowerCase().replace(POSSESSIVE, '');

/** Lowercased words (whole, possessive-stripped, and each hyphen part) from the sources. Linear. */
const sourceWords = (sources: readonly string[]): Set<string> => {
  const set = new Set<string>();
  for (const s of sources) {
    for (const m of s.matchAll(WORD)) {
      const w = bare(m[0]);
      set.add(w);
      if (w.includes('-')) for (const part of w.split('-')) set.add(part.replace(POSSESSIVE, ''));
    }
  }
  return set;
};

/**
 * Capitalised words in `text` that look like company or product names and appear in none of the
 * sources. Skipped: a word at the start of a sentence, an all-caps acronym of 5 letters or fewer,
 * days, months, well-known UK public bodies, schemes and dates (single words or whole phrases
 * such as "Companies House"), and a few common words. A hyphenated word passes if the whole word, or each of its
 * capitalised parts, is in a source. Case-insensitive matching. Linear in text + sources.
 */
export const unknownProperNouns = (text: string, sources: readonly string[]): string[] => {
  let known: Set<string> | null = null;
  const isKnown = (w: string): boolean => {
    known ??= sourceWords(sources);
    return known.has(w) || COMMON_CAPITALISED.has(w);
  };
  const words: { word: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(WORD)) {
    const start = m.index ?? 0;
    words.push({ word: m[0], start, end: start + m[0].length });
  }
  // Words covered by a known phrase. Each start tries a fixed phrase list of a few words each:
  // linear in the word count.
  const inPhrase = new Uint8Array(words.length);
  for (let i = 0; i < words.length; i++) {
    if (!PHRASE_FIRST_WORDS.has(bare(words[i]!.word))) continue;
    for (const phrase of KNOWN_PHRASES) {
      if (i + phrase.length > words.length) continue;
      let ok = true;
      for (let k = 0; k < phrase.length && ok; k++) {
        const w = words[i + k]!;
        if (bare(w.word) !== phrase[k]) ok = false;
        else if (k > 0 && !/^\s+$/.test(text.slice(words[i + k - 1]!.end, w.start))) ok = false;
      }
      if (ok) inPhrase.fill(1, i, i + phrase.length);
    }
  }
  const out: string[] = [];
  let last = 0;
  for (let i = 0; i < words.length; i++) {
    const { word, start, end } = words[i]!;
    const atSentenceStart = i === 0 || SENTENCE_BREAK.test(text.slice(last, start));
    last = end;
    if (inPhrase[i]) continue;
    const parts = word.split('-');
    const suspects = parts.filter((part, j) => {
      if (!UPPER_START.test(part)) return false;
      if (j === 0 && atSentenceStart) return false;
      return !ACRONYM.test(part.replace(POSSESSIVE, ''));
    });
    if (!suspects.length) continue;
    if (isKnown(bare(word))) continue;
    if (suspects.every((part) => isKnown(bare(part)))) continue;
    out.push(word);
  }
  return out;
};

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
