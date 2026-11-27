// Keyword industry guess (Amendment 5 Phase 5), used to choose search queries when the visitor
// didn't pick an industry. Whole-word hits of each industry's label and aliases (minus
// CLASSIFIER_EXCLUDED, plus CLASSIFIER_EXTRA) in the homepage title, meta description and first
// 3,000 text characters, plus inner page titles. The top industry wins only when at least 2
// DIFFERENT phrases hit, it has at least 2 hits, and strictly more hits than the runner-up;
// otherwise null (no search). A wrong guess is caught later: validation drops all grounding when
// the model's resolved industry differs.
//
// Linear and bounded: every field is capped before use (see CLASSIFY_*_CHARS), the text is
// normalised once to lowercase words separated by single spaces, then each fixed phrase is
// counted with indexOf (no regex over page text). The cost is about phrases x capped input, so
// a hostile multi-megabyte title cannot make it slow.
import { INDUSTRIES, INDUSTRY_IDS } from '../../shared/industries.js';
import type { IndustryId } from '../../shared/industries.js';
import type { FetchedPage } from '../site/types.js';

export const CLASSIFY_TEXT_CHARS = 3_000;
/** Real titles and descriptions are far shorter; the rest of a huge one is not evidence. */
export const CLASSIFY_TITLE_CHARS = 300;
export const CLASSIFY_DESCRIPTION_CHARS = 600;
export const CLASSIFY_MAX_INNER_PAGES = 10;
export const CLASSIFY_MIN_HITS = 2;
export const CLASSIFY_MIN_PHRASES = 2;

/**
 * Single words too common outside their industry to count as evidence (an IP-law footer says
 * "property" and "legal", a video agency says "production"). Classifier only: the playbook and
 * the model prompt keep them as aliases.
 *
 * Also dropped: bare "ecommerce", which agencies that build shops use as often as shops do.
 * Kept under the 2-phrase rule: "courier" and "saas" (alone they can no longer decide).
 */
export const CLASSIFIER_EXCLUDED: ReadonlySet<string> = new Set(['property', 'legal', 'production', 'foundation', 'school', 'ecommerce']);

/** Classifier-only phrases that stand in for an excluded word (shop pages, not shop builders). */
export const CLASSIFIER_EXTRA: Partial<Record<IndustryId, readonly string[]>> = {
  'ecommerce-retail': ['add to basket', 'add to cart', 'shop now'],
};

/** Lowercase words joined by single spaces, padded with a space at each end. */
const words = (s: string): string => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

/** Non-overlapping whole-word occurrences of `phrase` (already normalised, padded) in `hay`. */
const count = (hay: string, needle: string): number => {
  if (needle.trim() === '') return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    // The needle's trailing space may start the next match.
    i = hay.indexOf(needle, i + needle.length - 1);
  }
  return n;
};

const PHRASES: ReadonlyMap<IndustryId, readonly string[]> = new Map(
  INDUSTRY_IDS.map((id) => {
    const all = [INDUSTRIES[id].label, ...INDUSTRIES[id].aliases, ...(CLASSIFIER_EXTRA[id] ?? [])].map(words);
    return [id, [...new Set(all)].filter((ph) => !CLASSIFIER_EXCLUDED.has(ph.trim()))];
  }),
);

export interface IndustryMatch {
  /** Total whole-word hits across the industry's phrases. */
  hits: number;
  /** How many different phrases hit at least once. */
  phrases: number;
}

export const industryMatches = (pages: readonly FetchedPage[]): Map<IndustryId, IndustryMatch> => {
  const [home, ...inner] = pages;
  const hay = words(
    [
      (home?.title ?? '').slice(0, CLASSIFY_TITLE_CHARS),
      (home?.description ?? '').slice(0, CLASSIFY_DESCRIPTION_CHARS),
      (home?.text ?? '').slice(0, CLASSIFY_TEXT_CHARS),
      ...inner.slice(0, CLASSIFY_MAX_INNER_PAGES).map((p) => p.title.slice(0, CLASSIFY_TITLE_CHARS)),
    ].join(' \n '),
  );
  const out = new Map<IndustryId, IndustryMatch>();
  for (const [id, phrases] of PHRASES) {
    let hits = 0;
    let distinct = 0;
    for (const ph of phrases) {
      const n = count(hay, ph);
      hits += n;
      if (n) distinct++;
    }
    if (hits) out.set(id, { hits, phrases: distinct });
  }
  return out;
};

/** Total hits per industry. */
export const industryHits = (pages: readonly FetchedPage[]): Map<IndustryId, number> =>
  new Map([...industryMatches(pages)].map(([id, m]) => [id, m.hits]));

export const guessIndustry = (pages: readonly FetchedPage[]): IndustryId | null => {
  let best: IndustryId | null = null;
  let bestPhrases = 0;
  let top = 0;
  let second = 0;
  for (const [id, m] of industryMatches(pages)) {
    if (m.hits > top) {
      second = top;
      top = m.hits;
      best = id;
      bestPhrases = m.phrases;
    } else if (m.hits > second) second = m.hits;
  }
  return best && top >= CLASSIFY_MIN_HITS && bestPhrases >= CLASSIFY_MIN_PHRASES && top > second ? best : null;
};
