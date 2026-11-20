// Quote verification (BUILD_GUIDE §5.5): keep only quotes that appear word for word on a
// page we read. Anything else the model "quoted" is dropped.
import type { EvidenceQuote } from '../../shared/types.js';
import type { FetchedPage } from '../site/types.js';

export const MAX_QUOTES = 2;
const MIN_QUOTE_CHARS = 12;

export const normaliseForMatch = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();

const field = (raw: unknown, key: string): unknown =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[key] : undefined;

export const verifyQuotes = (quotes: unknown, pages: readonly FetchedPage[], max: number = MAX_QUOTES): EvidenceQuote[] => {
  if (!Array.isArray(quotes)) return [];
  const searchable = pages.map((p) => normaliseForMatch(p.text));
  const verified: EvidenceQuote[] = [];
  for (const raw of quotes) {
    if (verified.length >= max) break;
    const q = field(raw, 'quote');
    const text = typeof raw === 'string' ? raw : typeof q === 'string' ? q : '';
    const quote = text.trim().replace(/^["'“‘.\s]+|["'”’.\s]+$/g, '');
    const needle = normaliseForMatch(quote);
    if (needle.length < MIN_QUOTE_CHARS) continue;
    const index = searchable.findIndex((pageText) => pageText.includes(needle));
    const page = pages[index];
    if (index === -1 || !page) continue; // not on the site: drop it
    const item: EvidenceQuote = { quote, pageUrl: page.url, pageLabel: page.label };
    const effect = field(raw, 'effect');
    if (effect === 'for' || effect === 'against') item.effect = effect;
    const note = field(raw, 'note');
    if (typeof note === 'string' && note.trim()) item.note = note.trim().slice(0, 140);
    verified.push(item);
  }
  return verified;
};
