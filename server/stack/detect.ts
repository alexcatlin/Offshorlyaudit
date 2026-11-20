// Detect third-party tools from script/link/iframe/anchor/form URLs and inline scripts.
// saasCount counts detected tools outside the analytics category.
import type { DetectedTech } from '../../shared/types.js';
import { findElements, findTags, stripComments } from '../site/html.js';
import { SIGNATURES } from './signatures.js';
import type { TechSignature } from './signatures.js';

export interface DetectedStackItem extends DetectedTech {
  /** Hint for the AI prompt; not shown to visitors. */
  signals: string;
}

export interface StackResult {
  tech: DetectedStackItem[];
  saasCount: number;
}

const URL_ATTRS: readonly [string, string[]][] = [
  ['script', ['src']],
  ['link', ['href']],
  ['iframe', ['src', 'data-src', 'data-lazy-src', 'data-rocket-src']],
  ['a', ['href']],
  ['form', ['action']],
  ['img', ['src']],
  ['div', ['data-url', 'data-src']],
];

const INLINE_SCRIPT_CAP = 300_000;

/** URLs from relevant attributes plus inline script bodies; visible copy is excluded. */
export const buildHaystack = (html: string): string => {
  const clean = stripComments(html);
  const parts: string[] = [];
  for (const [tag, attrs] of URL_ATTRS) {
    for (const a of findTags(clean, tag)) {
      for (const k of attrs) if (a[k]) parts.push(a[k]!);
    }
  }
  let inline = 0;
  for (const { attrs, inner } of findElements(clean, 'script')) {
    if (attrs.src || /ld\+json/i.test(attrs.type ?? '')) continue;
    if (inline + inner.length > INLINE_SCRIPT_CAP) break;
    inline += inner.length;
    parts.push(inner.replace(/\\\//g, '/'));
  }
  return parts.join('\n');
};

export const matchSignature = (sig: TechSignature, haystack: string): boolean => sig.patterns.some((p) => p.test(haystack));

/** Detect across the homepage and any inner pages read. */
export const detectStack = (htmls: readonly string[]): StackResult => {
  const haystack = htmls.map(buildHaystack).join('\n');
  const tech: DetectedStackItem[] = SIGNATURES.filter((s) => matchSignature(s, haystack)).map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    signals: s.signals,
  }));
  return { tech, saasCount: tech.filter((t) => t.category !== 'analytics').length };
};

/** Strip prompt-only fields for the public report. */
export const publicStack = (tech: readonly DetectedStackItem[]): DetectedTech[] =>
  tech.map(({ id, name, category }) => ({ id, name, category }));
