// Page text extraction, BUILD_GUIDE §5.2. Caps per PLAN: homepage 10,000 chars, inner pages 5,000.
import { collapseWs, decodeEntities, findElements, headOf, metaContent, removeBlocks, resolveUrl, stripComments, stripTags } from './html.js';

export const HOME_TEXT_CAP = 10_000;
export const INNER_TEXT_CAP = 5_000;
const SHORT_LINE = 40;

export interface PageLink {
  url: string;
  text: string;
}

export interface ExtractedPage {
  title: string;
  description: string;
  /** Visible text, short lines de-duplicated, capped. */
  text: string;
  /** Words in the visible text before the cap. */
  wordCount: number;
  /** Text length before the cap. */
  fullLength: number;
}

const REMOVED_BLOCKS = ['head', 'script', 'style', 'noscript', 'svg', 'template', 'iframe'] as const;
const BLOCK_CLOSE =
  /<\/(p|div|section|article|header|footer|nav|aside|main|h[1-6]|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|blockquote|form|figure|figcaption|pre|address|fieldset|button|option|details|summary)\s*>|<(br|hr)\b[^<>]*>/gi;

export const extractTitle = (html: string): string => {
  const clean = stripComments(html);
  const el = findElements(headOf(clean), 'title', 1)[0] ?? findElements(clean, 'title', 1)[0];
  return el ? collapseWs(decodeEntities(stripTags(el.inner, ''))) : '';
};

export const extractDescription = (html: string): string => {
  const d = metaContent(html, 'description') ?? metaContent(html, 'og:description') ?? '';
  return collapseWs(d);
};

/** Visible text with block structure kept as line breaks; short lines kept once. Uncapped. */
export const extractText = (html: string): string => {
  const cleaned = stripTags(removeBlocks(stripComments(html), REMOVED_BLOCKS).replace(BLOCK_CLOSE, '\n'));
  const decoded = decodeEntities(cleaned);
  const seenShort = new Set<string>();
  const out: string[] = [];
  for (const raw of decoded.split(/\n+/)) {
    const line = collapseWs(raw);
    if (!line) continue;
    if (line.length < SHORT_LINE) {
      const key = line.toLowerCase();
      if (seenShort.has(key)) continue;
      seenShort.add(key);
    }
    out.push(line);
  }
  return out.join('\n');
};

export const countWords = (text: string): number => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

const capText = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.search(/\s\S*$/);
  return lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut;
};

export const extractPage = (html: string, maxChars: number): ExtractedPage => {
  const full = extractText(html);
  return {
    title: extractTitle(html),
    description: extractDescription(html),
    text: capText(full, maxChars),
    wordCount: countWords(full),
    fullLength: full.length,
  };
};

/** `<a href>` links, resolved against the page URL, http(s) only, hash stripped. */
export const extractLinks = (html: string, baseUrl: string): PageLink[] => {
  const out: PageLink[] = [];
  for (const { attrs, inner } of findElements(stripComments(html), 'a')) {
    const href = attrs.href;
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href.trim())) continue;
    const u = resolveUrl(href, baseUrl);
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) continue;
    u.hash = '';
    const text = collapseWs(decodeEntities(stripTags(inner))) || collapseWs(attrs['aria-label'] ?? attrs.title ?? '');
    out.push({ url: u.href, text });
  }
  return out;
};
