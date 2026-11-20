import { describe, expect, it } from 'vitest';
import { buildHaystack, detectStack, publicStack } from '../../server/stack/detect.js';
import { SIGNATURES } from '../../server/stack/signatures.js';
import { fixture } from './_siteMock.js';

const ids = (htmls: string[]) => detectStack(htmls).tech.map((t) => t.id);

describe('stack detection', () => {
  it('has about 35 signatures with unique ids, categories and signals', () => {
    expect(SIGNATURES.length).toBeGreaterThanOrEqual(35);
    expect(new Set(SIGNATURES.map((s) => s.id)).size).toBe(SIGNATURES.length);
    for (const s of SIGNATURES) {
      expect(s.signals.length).toBeGreaterThan(10);
      expect(s.patterns.length).toBeGreaterThan(0);
    }
  });

  it('WordPress fixture: cf7, calendly, ga4; saasCount excludes analytics', () => {
    const r = detectStack([fixture('html/wp-classic.html')]);
    const got = r.tech.map((t) => t.id);
    expect(got).toEqual(expect.arrayContaining(['cf7', 'calendly', 'ga4']));
    expect(got).not.toContain('woocommerce');
    expect(r.saasCount).toBe(r.tech.filter((t) => t.category !== 'analytics').length);
    expect(r.saasCount).toBe(2); // cf7 + calendly
  });

  it('Shopify fixture: shopify, stripe, klaviyo', () => {
    expect(ids([fixture('html/shopify.html')])).toEqual(expect.arrayContaining(['shopify', 'stripe', 'klaviyo']));
  });

  it('offshorly.com snapshot: cf7 and Google Analytics detected', () => {
    const got = ids([fixture('html/offshorly-home.html')]);
    expect(got).toContain('cf7');
    expect(got).toContain('ga4');
  });

  it('a mention in visible copy does not count', () => {
    expect(ids(['<p>We integrate with HubSpot, Calendly (calendly.com) and Zendesk.</p>'])).toEqual([]);
  });

  it('cal.com via link or embed, but not lookalike hosts', () => {
    expect(ids(['<a href="https://cal.com/acme/30min">Book</a>'])).toEqual(['cal-com']);
    expect(ids(['<script src="https://app.cal.com/embed/embed.js"></script>'])).toEqual(['cal-com']);
    expect(ids(['<a href="https://medical.com/x">x</a>'])).toEqual([]);
  });

  it('analytics-only site → saasCount 0', () => {
    const r = detectStack(['<script async src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD12"></script><script src="https://static.hotjar.com/c/hotjar-1.js"></script><script src="https://www.clarity.ms/tag/x"></script>']);
    expect(r.tech.map((t) => t.id).sort()).toEqual(['clarity', 'gtm', 'hotjar']);
    expect(r.saasCount).toBe(0);
  });

  it('detects across inner pages, ATS and helpdesk categories', () => {
    const r = detectStack([
      '<html></html>',
      '<a href="https://apply.workable.com/acme/">Jobs</a><script src="https://static.zdassets.com/ekr/snippet.js?key=x"></script><script src="https://js.hsforms.net/forms/v2.js"></script>',
    ]);
    expect(r.tech.map((t) => [t.id, t.category])).toEqual([
      ['zendesk', 'helpdesk'],
      ['hubspot-forms', 'forms'],
      ['workable', 'recruitment'],
    ]);
    expect(r.saasCount).toBe(3);
  });

  it('inline scripts are scanned; JSON-LD is not', () => {
    expect(buildHaystack('<script>window.intercomSettings={app_id:"x"}</script>')).toContain('intercomSettings');
    expect(buildHaystack('<script type="application/ld+json">{"url":"https://calendly.com/x"}</script>')).toBe('');
  });

  it('publicStack strips signals', () => {
    const r = detectStack([fixture('html/shopify.html')]);
    expect(publicStack(r.tech)[0]).toEqual({ id: r.tech[0]!.id, name: r.tech[0]!.name, category: r.tech[0]!.category });
  });
});
