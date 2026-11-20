import { describe, expect, it } from 'vitest';
import {
  ALL_PATTERNS,
  findPattern,
  GENERIC_PATTERNS,
  INDUSTRIES,
  INDUSTRY_IDS,
  isIndustryId,
  patternsFor,
} from '../../shared/industries.js';
import { OPPORTUNITY_SERVICE_IDS } from '../../shared/services.js';
import { hasAdoptionClaim, proseAllowed, unknownProperNouns } from '../../server/ai/text.js';

const words = (s: string) => s.trim().split(/\s+/).length;

describe('industry playbook', () => {
  it('has the 16 industries, each keyed by its own id', () => {
    expect(INDUSTRY_IDS).toHaveLength(16);
    for (const id of INDUSTRY_IDS) expect(INDUSTRIES[id].id).toBe(id);
    expect(isIndustryId('legal')).toBe(true);
    expect(isIndustryId('other')).toBe(false);
    expect(isIndustryId('__proto__')).toBe(false);
    expect(isIndustryId(7)).toBe(false);
  });

  it('pattern ids are unique and prefixed with their industry (other. for the generic set)', () => {
    const ids = ALL_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of INDUSTRY_IDS) {
      const pats = INDUSTRIES[id].patterns;
      expect(pats.length, id).toBeGreaterThanOrEqual(5);
      expect(pats.length, id).toBeLessThanOrEqual(6);
      for (const p of pats) expect(p.id.startsWith(`${id}.`), p.id).toBe(true);
    }
    for (const p of GENERIC_PATTERNS) expect(p.id.startsWith('other.')).toBe(true);
    expect(patternsFor('other')).toBe(GENERIC_PATTERNS);
    expect(findPattern('legal.intake')?.title).toBe('Triage of new enquiries');
    expect(findPattern('legal.nope')).toBeUndefined();
  });

  it('every serviceId is an opportunity service (never the consultation)', () => {
    for (const p of ALL_PATTERNS) {
      expect(OPPORTUNITY_SERVICE_IDS as readonly string[], p.id).toContain(p.serviceId);
      expect(p.serviceId).not.toBe('free-ai-consultation');
    }
  });

  it('every text and title passes the prose filters: no figures, banned words or adoption claims', () => {
    for (const p of ALL_PATTERNS) {
      expect(proseAllowed(p.text, []), p.id).toBe(true);
      expect(proseAllowed(p.title, []), p.id).toBe(true);
      expect(hasAdoptionClaim(p.text), p.id).toBe(false);
      expect(/\d/.test(p.text), p.id).toBe(false);
    }
  });

  it('word caps: titles ≤8 words in sentence case, texts ≤35 words', () => {
    for (const p of ALL_PATTERNS) {
      expect(words(p.title), p.id).toBeLessThanOrEqual(8);
      expect(words(p.text), p.id).toBeLessThanOrEqual(35);
      expect(p.title[0], p.id).toBe(p.title[0]!.toUpperCase());
    }
  });

  it('no company or product names: no unknown proper nouns in any title or text', () => {
    for (const p of ALL_PATTERNS) {
      expect(unknownProperNouns(p.text, []), p.id).toEqual([]);
      expect(unknownProperNouns(p.title, []), p.id).toEqual([]);
    }
  });

  it('aliases are lowercase and labels are short', () => {
    for (const id of INDUSTRY_IDS) {
      const ind = INDUSTRIES[id];
      expect(ind.aliases.length).toBeGreaterThan(0);
      for (const a of ind.aliases) expect(a, `${id}: ${a}`).toBe(a.toLowerCase());
      expect(words(ind.label)).toBeLessThanOrEqual(5);
    }
  });

  it('UK English spellings only', () => {
    const all = ALL_PATTERNS.map((p) => `${p.title} ${p.text}`).join(' ');
    expect(all).not.toMatch(/\b(organization|prioritize|analyze|optimize|summarize|color|center)\b/i);
  });
});
