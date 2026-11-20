import { describe, expect, it } from 'vitest';
import { verifyQuotes } from '../../server/ai/quotes.js';
import type { FetchedPage } from '../../server/site/types.js';

const pages: FetchedPage[] = [
  { url: 'https://a.example/', label: 'Homepage', title: '', description: '', text: 'We’re the   team that "ships" fast.\nNo jargon, ever…' },
  { url: 'https://a.example/about/', label: 'About', title: '', description: '', text: 'Founded in Leeds by two engineers in a garage.' },
];

describe('verifyQuotes', () => {
  it('keeps an exact match and attaches the right page', () => {
    const out = verifyQuotes([{ quote: 'Founded in Leeds by two engineers', effect: 'for', note: ' Origin story ' }], pages);
    expect(out).toEqual([
      { quote: 'Founded in Leeds by two engineers', pageUrl: 'https://a.example/about/', pageLabel: 'About', effect: 'for', note: 'Origin story' },
    ]);
  });

  it('normalises curly quotes, ellipses and whitespace', () => {
    const out = verifyQuotes(["We're the team that “ships” fast", 'No jargon, ever...'], pages);
    expect(out).toHaveLength(2);
    expect(out[0]?.pageLabel).toBe('Homepage');
  });

  it('drops an invented quote', () => {
    expect(verifyQuotes(['We are the market leader in Europe'], pages)).toEqual([]);
  });

  it('drops quotes under 12 characters and ignores bad effects', () => {
    expect(verifyQuotes(['No jargon'], pages)).toEqual([]);
    const out = verifyQuotes([{ quote: 'two engineers in a garage', effect: 'maybe' }], pages);
    expect(out[0]?.effect).toBeUndefined();
  });

  it('keeps at most 2', () => {
    const out = verifyQuotes(['Founded in Leeds by two', 'engineers in a garage', 'the team that "ships" fast'], pages);
    expect(out).toHaveLength(2);
  });

  it('non-array → []', () => {
    expect(verifyQuotes('Founded in Leeds by two engineers', pages)).toEqual([]);
  });
});
