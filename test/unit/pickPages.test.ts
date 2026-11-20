import { describe, expect, it } from 'vitest';
import { PAGE_TYPES, pickPages, scoreLink } from '../../server/site/pickPages.js';

const L = (path: string, text = '') => ({ url: `https://site.test${path}`, text });
const HOME = 'https://site.test/';
const type = (label: string) => PAGE_TYPES.find((t) => t.label === label)!;

describe('pickPages', () => {
  it('scores per the guide formula', () => {
    // single segment match 2 + text 1 − 0.1 × 1
    expect(scoreLink({ url: new URL('https://site.test/what-we-do'), text: 'Services' }, type('Services'))).toBeCloseTo(2.9);
    // conventional name gets a +1.5 bonus
    expect(scoreLink({ url: new URL('https://site.test/services'), text: 'Services' }, type('Services'))).toBeCloseTo(4.4);
    // any of several link texts can match
    expect(scoreLink({ url: new URL('https://site.test/x'), text: ['Learn more', 'Services'] }, type('Services'))).toBeCloseTo(0.9);
    // first segment match 1.2 − 0.2
    expect(scoreLink({ url: new URL('https://site.test/services/branding'), text: '' }, type('Services'))).toBeCloseTo(1.0);
    // text only: 1 − 0.1
    expect(scoreLink({ url: new URL('https://site.test/x'), text: 'Our services' }, type('Services'))).toBeCloseTo(0.9);
    // long text doesn't count
    expect(scoreLink({ url: new URL('https://site.test/x'), text: 'A very long link text about our services' }, type('Services'))).toBeCloseTo(-0.1);
  });

  it('picks by type in priority order Services > About > Careers > Case studies > Pricing > Contact, max 4', () => {
    const picked = pickPages(
      [L('/contact', 'Contact'), L('/pricing', 'Pricing'), L('/case-studies', 'Case studies'), L('/careers', 'Careers'), L('/about', 'About'), L('/services', 'Services')],
      HOME,
    );
    expect(picked.map((p) => p.label)).toEqual(['Services', 'About', 'Careers', 'Case studies']);
    expect(picked).toHaveLength(4);
  });

  it('picks Careers from jobs / vacancies / join-us / hiring', () => {
    for (const path of ['/jobs', '/vacancies', '/join-us', '/work-with-us', '/hiring', '/careers/']) {
      const p = pickPages([L(path)], HOME);
      expect(p[0]?.label, path).toBe('Careers');
    }
  });

  it('skips blog/news/wp-/app paths and files', () => {
    const p = pickPages(
      [L('/blog/services-we-love', 'Services'), L('/news/about', 'About'), L('/wp-content/uploads/services.pdf'), L('/app/themes/about/'), L('/about.pdf', 'About'), L('/app', 'About')],
      HOME,
    );
    expect(p).toEqual([]);
  });

  it('does not skip /apple or /application-services', () => {
    expect(pickPages([L('/application-services', 'Services')], HOME)[0]?.label).toBe('Services');
  });

  it('is www-insensitive and ignores other hosts', () => {
    const p = pickPages(
      [{ url: 'https://www.site.test/about', text: 'About' }, { url: 'https://other.test/services', text: 'Services' }],
      HOME,
    );
    expect(p).toEqual([{ url: 'https://www.site.test/about', label: 'About', score: 4.4 }]);
  });

  it('does not pick the homepage or the same page twice', () => {
    const p = pickPages([L('/', 'Services'), L('/about-us', 'About us'), L('/about-us/', 'Our team')], HOME);
    expect(p.map((x) => x.url)).toEqual(['https://site.test/about-us']);
  });

  it('falls through to the next-best link when a page is already taken', () => {
    // /work-with-us matches Careers and Case studies (\bwork\b); Careers claims it first.
    const p = pickPages([L('/work-with-us', 'Work with us'), L('/our-work', 'Our work')], HOME);
    expect(p.map((x) => [x.label, x.url])).toEqual([
      ['Careers', 'https://site.test/work-with-us'],
      ['Case studies', 'https://site.test/our-work'],
    ]);
  });

  it('prefers the conventional page (/about over /teams, /services over /ai-development-services)', () => {
    // offshorly.com: /teams/ has short matching text "AI Development Teams"; /about/ only "Company".
    const p = pickPages([L('/ai-development-services/', 'AI Services'), L('/teams/', 'AI Development Teams'), L('/about/', 'Company'), L('/services/')], HOME);
    expect(p.slice(0, 2).map((x) => x.url)).toEqual(['https://site.test/services/', 'https://site.test/about/']);
  });

  it('ignores links below the 0.8 threshold', () => {
    expect(pickPages([L('/a/b/c/d/services')], HOME)).toEqual([]);
  });
});
