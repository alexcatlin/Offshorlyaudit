import { describe, expect, it } from 'vitest';
import { extractLinks, extractPage, extractText, HOME_TEXT_CAP, INNER_TEXT_CAP } from '../../server/site/extract.js';
import { decodeEntities, findTags, parseAttrs } from '../../server/site/html.js';

describe('extract', () => {
  it('title and meta description, falling back to og:description', () => {
    const a = extractPage('<title> Acme &amp; Co </title><meta name="description" content="We make &quot;things&quot;">', 1000);
    expect(a.title).toBe('Acme & Co');
    expect(a.description).toBe('We make "things"');
    const b = extractPage('<title>x</title><meta property="og:description" content="OG text">', 1000);
    expect(b.description).toBe('OG text');
    const c = extractPage('<p>none</p>', 1000);
    expect(c.title).toBe('');
    expect(c.description).toBe('');
  });

  it('removes script, style, svg, noscript, template, iframe and comments', () => {
    const t = extractText(
      '<head><title>T</title></head><body><script>var secret=1</script><style>.a{}</style><svg><text>svgtext</text></svg>' +
        '<noscript>enable js</noscript><template><p>tpl</p></template><iframe>frame</iframe><!-- hidden comment --><p>Visible</p></body>',
    );
    expect(t).toBe('Visible');
  });

  it('decodes entities', () => {
    expect(decodeEntities('&pound;10 &#8211; &#x2014; &rsquo; &nbsp;&unknown;')).toBe('£10 – — ’  &unknown;');
    expect(extractText('<p>Fish &amp; chips&nbsp;&hellip;</p>')).toBe('Fish & chips …');
  });

  it('keeps short lines once, long lines always', () => {
    const long = 'This sentence is definitely longer than forty characters in total.';
    const t = extractText(`<nav><li>Home</li><li>About</li></nav><p>${long}</p><p>${long}</p><footer><li>Home</li><li>About</li></footer>`);
    expect(t.split('\n')).toEqual(['Home', 'About', long, long]);
  });

  it('turns block closers and <br> into line breaks', () => {
    expect(extractText('<div>One<br>Two</div><h2>Three</h2>Four')).toBe('One\nTwo\nThree\nFour');
  });

  it('caps text (homepage 10,000; inner 5,000) and counts words before the cap', () => {
    expect(HOME_TEXT_CAP).toBe(10_000);
    expect(INNER_TEXT_CAP).toBe(5_000);
    const body = `<p>${'word '.repeat(4000)}</p>`;
    const home = extractPage(body, HOME_TEXT_CAP);
    expect(home.text.length).toBeLessThanOrEqual(10_000);
    expect(home.wordCount).toBe(4000);
    const inner = extractPage(body, INNER_TEXT_CAP);
    expect(inner.text.length).toBeLessThanOrEqual(5_000);
  });

  it('extracts links, resolving relative URLs and dropping mailto/tel/hash', () => {
    const links = extractLinks(
      '<a href="/services/">Our <b>services</b></a><a href="mailto:a@b.c">m</a><a href="#top">t</a><a href="https://x.test/p#frag">P</a><a href="tel:1">t</a>',
      'https://site.test/',
    );
    expect(links).toEqual([
      { url: 'https://site.test/services/', text: 'Our services' },
      { url: 'https://x.test/p', text: 'P' },
    ]);
  });

  it('parses attributes in any order and quoting style', () => {
    expect(parseAttrs(` content='a "b"' name=description data-x`)).toEqual({ content: 'a "b"', name: 'description', 'data-x': '' });
    expect(findTags('<meta name="a" content="1"><META NAME="b" CONTENT="2"/>', 'meta')).toEqual([
      { name: 'a', content: '1' },
      { name: 'b', content: '2' },
    ]);
  });

  it('stays linear on hostile markup (unclosed tags, quotes, comments, scripts)', () => {
    const cases = ['<a href="x" '.repeat(60_000), '<script>'.repeat(60_000), '<!--'.repeat(100_000), '<'.repeat(500_000), "<a x='".repeat(60_000)];
    for (const html of cases) {
      const t = performance.now();
      extractPage(html, HOME_TEXT_CAP);
      extractLinks(html, 'https://a.test/');
      findTags(html, 'meta');
      expect(performance.now() - t).toBeLessThan(1_000);
    }
  });
});
