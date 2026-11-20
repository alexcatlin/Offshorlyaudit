// Small regex-based HTML helpers (no parser dependency; BUILD_GUIDE §5.2).

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  pound: '£',
  euro: '€',
  bull: '•',
  middot: '·',
  times: '×',
  eacute: 'é',
  egrave: 'è',
  aacute: 'á',
  agrave: 'à',
  ouml: 'ö',
  uuml: 'ü',
  auml: 'ä',
  ccedil: 'ç',
  shy: '',
  zwj: '',
  zwnj: '',
};

export const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = NAMED_ENTITIES[ent.toLowerCase()];
    return v ?? m;
  });

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Attributes of a tag's inner text (after the tag name). Names lower-cased, values entity-decoded. */
export const parseAttrs = (inner: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of inner.matchAll(ATTR_RE)) {
    const name = m[1]!.toLowerCase();
    if (name in out) continue;
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
};

// Tag scanning is hand-written rather than one big regex: pages are hostile input, and a
// backtracking pattern over unclosed tags/quotes goes quadratic on 1.5 MB. A tag body ends at
// '>' and fails at an unquoted '<'; a quoted value is capped, so total work stays linear.
const MAX_QUOTED = 16_384;

/** End index of the '>' closing the tag body starting at `from`, or -1. */
const tagBodyEnd = (html: string, from: number): number => {
  let quote = 0;
  let quoteStart = 0;
  for (let j = from; j < html.length; j++) {
    const c = html.charCodeAt(j);
    if (quote) {
      if (c === quote) quote = 0;
      else if (j - quoteStart > MAX_QUOTED) return -1;
      continue;
    }
    if (c === 34 || c === 39) {
      quote = c;
      quoteStart = j;
    } else if (c === 62) return j; // >
    else if (c === 60) return -1; // <
  }
  return -1;
};

interface RawTag {
  body: string;
  /** Index just after the closing '>'. */
  end: number;
}

const scanOpenTags = (html: string, name: string, limit = Infinity): RawTag[] => {
  const startRe = new RegExp(`<${name}(?=[\\s/>])`, 'gi');
  const out: RawTag[] = [];
  let m: RegExpExecArray | null;
  while (out.length < limit && (m = startRe.exec(html))) {
    const bodyStart = m.index + 1 + name.length;
    const end = tagBodyEnd(html, bodyStart);
    if (end < 0) {
      startRe.lastIndex = m.index + 1;
      continue;
    }
    out.push({ body: html.slice(bodyStart, end), end: end + 1 });
    startRe.lastIndex = end + 1;
  }
  return out;
};

/** All opening tags `<name ...>` with their attributes. */
export const findTags = (html: string, name: string): Record<string, string>[] =>
  scanOpenTags(html, name).map((t) => parseAttrs(t.body.replace(/\/\s*$/, '')));

/** `<name ...>inner</name>` pairs (non-nesting). Linear: stops once no closing tag remains. */
export const findElements = (
  html: string,
  name: string,
  limit = Infinity,
): { attrs: Record<string, string>; inner: string }[] => {
  const startRe = new RegExp(`<${name}(?=[\\s>])`, 'gi');
  const closeRe = new RegExp(`<\\/${name}\\s*>`, 'gi');
  const out: { attrs: Record<string, string>; inner: string }[] = [];
  let m: RegExpExecArray | null;
  while (out.length < limit && (m = startRe.exec(html))) {
    const bodyStart = m.index + 1 + name.length;
    const end = tagBodyEnd(html, bodyStart);
    if (end < 0) {
      startRe.lastIndex = m.index + 1;
      continue;
    }
    closeRe.lastIndex = end + 1;
    const close = closeRe.exec(html);
    if (!close) break;
    out.push({ attrs: parseAttrs(html.slice(bodyStart, end)), inner: html.slice(end + 1, close.index) });
    startRe.lastIndex = close.index + close[0].length;
  }
  return out;
};

/**
 * Remove `<name ...>…</name>` blocks for the given tag names, replacing each with a space.
 * An unclosed block swallows the rest of the document (as a browser would for script/style).
 */
export const removeBlocks = (html: string, names: readonly string[]): string => {
  const startRe = new RegExp(`<(${names.join('|')})(?=[\\s/>])`, 'gi');
  const parts: string[] = [];
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(html))) {
    const name = m[1]!.toLowerCase();
    parts.push(html.slice(pos, m.index), ' ');
    const closeRe = new RegExp(`<\\/${name}\\s*>`, 'gi');
    closeRe.lastIndex = m.index + 1;
    const close = closeRe.exec(html);
    if (!close) return parts.join('');
    pos = close.index + close[0].length;
    startRe.lastIndex = pos;
  }
  parts.push(html.slice(pos));
  return parts.join('');
};

/** The document head (up to </head>, or the first <body>), or the first 64 KB if neither is found. */
export const headOf = (html: string): string => {
  const end = html.search(/<\/head\s*>|<body[\s>]/i);
  return end >= 0 ? html.slice(0, end) : html.slice(0, 65_536);
};

/** Replace comments with a space; an unclosed comment runs to the end (as in browsers). */
export const stripComments = (html: string): string => {
  let pos = 0;
  let out = '';
  for (;;) {
    const start = html.indexOf('<!--', pos);
    if (start < 0) return out + html.slice(pos);
    out += `${html.slice(pos, start)} `;
    const end = html.indexOf('-->', start + 4);
    if (end < 0) return out;
    pos = end + 3;
  }
};

/** Strip tags from a fragment (linear: a tag cannot contain '<'). */
export const stripTags = (s: string, replacement = ' '): string => s.replace(/<[^<>]*>/g, replacement);

/** Meta content by name or property, case-insensitive. */
export const metaContent = (html: string, key: string): string | null => {
  const k = key.toLowerCase();
  for (const a of findTags(html, 'meta')) {
    if ((a.name ?? a.property ?? '').toLowerCase() === k && a.content !== undefined) return a.content;
    if ((a.property ?? '').toLowerCase() === k && a.content !== undefined) return a.content;
  }
  return null;
};

export const metaContents = (html: string, key: string): string[] => {
  const k = key.toLowerCase();
  return findTags(html, 'meta')
    .filter((a) => (a.name ?? '').toLowerCase() === k || (a.property ?? '').toLowerCase() === k)
    .map((a) => a.content ?? '');
};

export const collapseWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

export const stripWww = (host: string): string => host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');

/** Same site, ignoring a leading `www.`. */
export const sameHost = (a: string | URL, b: string | URL): boolean => {
  try {
    const ha = typeof a === 'string' ? new URL(a).hostname : a.hostname;
    const hb = typeof b === 'string' ? new URL(b).hostname : b.hostname;
    return stripWww(ha) === stripWww(hb);
  } catch {
    return false;
  }
};

export const resolveUrl = (href: string, base: string | URL): URL | null => {
  try {
    return new URL(href.trim(), base);
  } catch {
    return null;
  }
};
