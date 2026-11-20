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

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
