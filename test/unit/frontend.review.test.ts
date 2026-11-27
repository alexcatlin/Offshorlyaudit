// Owner review of the report screenshots: region field, detail groups, titles, tabs, WordPress
// panel, quote cards, confidence labels and the tagged contact link.
import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreBand } from '../../shared/reportLogic.js';
import { CTA } from '../../shared/services.js';
import { REGIONS, type AuditReport, type BuyerFit, type WordPressInfo, type WpComponent } from '../../shared/types.js';
import { AiOpportunities } from '../../src/components/AiOpportunities.js';
import { BuyerFitDetail, Quote } from '../../src/components/BuyerFitDetail.js';
import { ReportActions } from '../../src/components/ReportActions.js';
import { ReportFooter } from '../../src/components/WhatWeRead.js';
import { CHECK_TEXT } from '../../src/content/checkText.js';
import { Form } from '../../src/components/Form.js';
import { Report } from '../../src/components/Report.js';
import { WpPanel } from '../../src/components/WpPanel.js';
import { CONFIDENCE_LABELS, CONFIDENCE_MEANINGS, COPY, REGION_OPTIONS } from '../../src/content/copy.js';
import { buildRequest, EMPTY_FORM } from '../../src/lib/form.js';
import { sampleAi, sampleBuyerFit } from './_appMock.js';

const report = (over: Partial<AuditReport> = {}): AuditReport => ({
  auditId: 'a1',
  auditedAt: '2026-11-20T10:00:00Z',
  url: 'https://acme.example/',
  domain: 'acme.example',
  pagesRead: [{ url: 'https://acme.example/', label: 'Homepage', title: 'Acme' }],
  aiStatus: 'ok',
  ai: sampleAi(),
  buyerFitStatus: 'ok',
  buyerFit: { ...sampleBuyerFit(), mismatchIndex: [{ point: 'Says fast', explanation: 'Shows slow' }] },
  security: { score: 70, checks: [{ id: 'sec-https', status: 'pass', detail: 'HTTPS.' }] },
  health: { score: 80, checks: [{ id: 'seo-title', status: 'warn', detail: 'Short title.' }], measuredByGoogle: false },
  cms: { platform: 'unknown' },
  stack: [],
  fixFirst: [],
  attributions: [],
  ...over,
});
const request = { url: 'https://acme.example/' };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const css = readFileSync(join(ROOT, 'src/styles/widget.css'), 'utf8');
/** Visible text only (tags stripped). */
const textOnly = (html: string) => html.replace(/<[^>]+>/g, ' ');

describe('region field', () => {
  it('sits in the business expander with "not sure" as the blank default and every region listed', () => {
    const html = renderToString(h(Form, { initial: EMPTY_FORM, error: null, onSubmit: () => undefined }));
    expect(html).toContain(COPY.form.regionLabel);
    expect(html).toContain(`<option selected value>${COPY.form.regionNotSure}</option>`);
    expect(REGION_OPTIONS.map((o) => o.value)).toEqual(Object.keys(REGIONS));
    for (const o of REGION_OPTIONS) expect(html).toContain(`<option value="${o.value}">${o.label}</option>`);
    // Inside "More about your business": after its toggle, before the buyer toggle.
    const at = (s: string) => html.indexOf(s);
    expect(at(COPY.form.regionLabel)).toBeGreaterThan(at(COPY.form.businessToggle));
    expect(at(COPY.form.regionLabel)).toBeLessThan(at(COPY.form.buyerToggle));
  });

  it('buildRequest sends a known region and leaves out the blank one', () => {
    expect(buildRequest({ ...EMPTY_FORM, region: 'europe' }, 'https://a.com/').region).toBe('europe');
    expect('region' in buildRequest(EMPTY_FORM, 'https://a.com/')).toBe(false);
  });
});

describe('"The detail" in two groups', () => {
  const groups = (html: string) => {
    const msg = html.indexOf(`>${COPY.detail.messageHeading}</h3>`);
    const tech = html.indexOf(`>${COPY.detail.technicalHeading}</h3>`);
    return { msg, tech };
  };

  it('message group holds buyer fit, mismatch and actions; technical group holds security, health and pages', () => {
    const html = renderToString(h(Report, { report: report(), request }));
    const { msg, tech } = groups(html);
    expect(msg).toBeGreaterThan(-1);
    expect(tech).toBeGreaterThan(msg);
    const between = (s: string) => {
      const i = html.indexOf(s, msg);
      return i > msg && i < tech;
    };
    expect(between(`>${COPY.buyerFit.heading}<`)).toBe(true);
    expect(between(COPY.buyerFit.mismatchHeading)).toBe(true);
    expect(html.indexOf(COPY.security.heading, tech)).toBeGreaterThan(tech);
    expect(html.indexOf(COPY.health.heading, tech)).toBeGreaterThan(tech);
    expect(html.indexOf(COPY.whatWeRead.heading, tech)).toBeGreaterThan(tech);
  });

  it('no message group without buyer fit; print still shows both groups, every section open', () => {
    const none = renderToString(h(Report, { report: report({ buyerFitStatus: 'unavailable', buyerFit: undefined }), request }));
    expect(groups(none).msg).toBe(-1);
    expect(groups(none).tech).toBeGreaterThan(-1);
    const printed = renderToString(h(Report, { report: report(), request, mode: 'print' }));
    expect(groups(printed).msg).toBeGreaterThan(-1);
    expect(groups(printed).tech).toBeGreaterThan(groups(printed).msg);
    expect(printed).not.toMatch(/class="oa-collapsible__body" hidden/);
  });
});

describe('titles', () => {
  it('renamed section titles', () => {
    expect(COPY.detail.messageHeading).toBe('Content checks');
    expect(COPY.detail.technicalHeading).toBe('Technical checks');
    expect(COPY.buyerFit.mismatchHeading).toBe('Where your site undercuts itself');
    expect(COPY.buyerFit.mismatchSummary(1)).toBe('1 place that weakens your message');
    expect(COPY.buyerFit.mismatchSummary(3)).toBe('3 places that weaken your message');
    expect(COPY.buyerFit.actionsHeading).toBe('How to win this customer');
    expect(COPY.security.heading).toBe('Website security');
    expect(COPY.sectionLabels.security).toBe('Website security');
    expect(COPY.whatWeRead.heading).toBe('Pages we analysed');
    expect(COPY.report.tabAi).toBe('Where AI can help');
    expect(COPY.print.aiHeading).toBe(COPY.report.tabAi);
  });
});

describe('tabs', () => {
  it('each tab has a label and a hint read as its description; roles and badge kept', () => {
    const html = renderToString(h(Report, { report: report(), request }));
    expect(html).toContain('role="tablist"');
    for (const t of ['website', 'ai']) {
      expect(html).toContain(`aria-describedby="oa-tab-${t}-hint"`);
      expect(html).toContain(`id="oa-tab-${t}-hint" aria-hidden="true"`);
    }
    // Selected tab keeps its hint; the unselected one's hint is an action.
    expect(html).toContain(COPY.report.tabWebsiteHint);
    expect(html).toContain(`>${COPY.report.tabAiAction(1)}</span>`);
    expect(html).toContain(`aria-label="${COPY.report.tabAiCount(1)}"`);
    const ai = renderToString(h(Report, { report: report(), request, initialTab: 'ai' }));
    expect(ai).toContain(`>${COPY.report.tabWebsiteAction}</span>`);
    expect(ai).toContain(`>${COPY.report.tabAiHint}</span>`);
  });
});

describe('WordPress panel', () => {
  const comp = (over: Partial<WpComponent>): WpComponent => ({
    type: 'plugin',
    slug: 'x',
    name: 'X',
    version: '1.0',
    versionSource: 'asset',
    latest: '1.0',
    directory: 'listed',
    stale: false,
    status: 'up_to_date',
    ...over,
  });
  const wp = (components: WpComponent[], status: WordPressInfo['core']['status'] = 'latest'): WordPressInfo => ({
    core: { version: '6.8', source: 'generator', latest: '6.8', status },
    components,
    xmlrpcAdvertised: false,
    versionExposed: true,
    vulnSource: null,
  });

  it('shows concerning and unknown items; up-to-date core and plugins go behind "N checks passed"', () => {
    const html = renderToString(
      h(WpPanel, {
        wp: wp([
          comp({ slug: 'ok', name: 'Fine Plugin' }),
          comp({ slug: 'old', name: 'Old Plugin', latest: '2.0', status: 'outdated' }),
          comp({ slug: 'pro', name: 'Pro Plugin', directory: 'not_listed', status: 'unknown', latest: null }),
        ]),
      }),
    );
    const toggle = html.indexOf(COPY.checks.passedCount(2));
    expect(toggle).toBeGreaterThan(-1);
    expect(html.indexOf('Old Plugin')).toBeLessThan(toggle);
    expect(html.indexOf('Pro Plugin')).toBeLessThan(toggle);
    expect(html.indexOf('Fine Plugin')).toBeGreaterThan(toggle);
    expect(html.indexOf(COPY.wordpress.core)).toBeGreaterThan(toggle);
    expect(html).toMatch(/aria-expanded="false"[^>]*>.*?<div id="oa-passed-[^"]*" hidden>/s);
  });

  it('an outdated core stays visible; all clear when nothing needs attention', () => {
    const outdated = renderToString(h(WpPanel, { wp: wp([comp({})], 'outdated') }));
    expect(outdated.indexOf(COPY.wordpress.core)).toBeLessThan(outdated.indexOf(COPY.checks.passedCount(1)));
    const clear = renderToString(h(WpPanel, { wp: wp([comp({})]) }));
    expect(clear).toContain(COPY.checks.allClear);
    expect(clear).toContain(COPY.checks.passedCount(2));
    expect(clear).not.toContain(`>${COPY.wordpress.plugins}<`);
    // Owner check: with nothing concerning, the visible part is the all-clear line then the collapsed toggle;
    // core and the plugin are only inside the hidden passed list.
    expect(clear).toMatch(
      new RegExp(`<p class="oa-checks__clear">${COPY.checks.allClear}</p><div class="oa-passed"><button type="button" class="oa-link-button" aria-expanded="false"[^>]*>.*?${COPY.checks.passedCount(2)}.*?</button><div id="oa-passed-[^"]*" hidden>.*?${COPY.wordpress.core}.*?</div></div><p class="oa-wp__note">`, 's'),
    );
  });
});

describe('AI idea cards', () => {
  const ai = sampleAi();
  const quoteIdea = {
    ...ai.opportunities[0]!,
    basis: [{ kind: 'quote' as const, quote: 'We key in every invoice', pageUrl: 'https://acme.example/', pageLabel: 'Home' }],
  };

  it('quote card: label and "See it on" link in one header row, quote below', () => {
    const html = renderToString(h(AiOpportunities, { report: report({ ai: { ...ai, opportunities: [quoteIdea] } }), request }));
    expect(html).toMatch(
      /<div class="oa-basis__head"><span class="oa-basis__kind">From your website<\/span><a class="oa-basis__link"[^>]*>See it on: Home.*?<\/a><\/div><blockquote/s,
    );
  });

  it('confidence: production pill; its meaning is the first muted line of "Why we think so", not beside the pill', () => {
    expect(CONFIDENCE_LABELS).toEqual({ likely: 'Likely fit', 'worth-checking': 'Worth checking' });
    expect(CONFIDENCE_MEANINGS).toEqual({
      likely: 'Rated likely fit: your site or your answers point to this directly.',
      'worth-checking': 'Rated worth checking: the evidence is indirect, so it is best confirmed in a conversation.',
    });
    const html = renderToString(h(AiOpportunities, { report: report(), request }));
    expect(html).toContain(
      `<span class="oa-pill oa-pill--confidence-likely"><span class="oa-visually-hidden">${COPY.ai.confidenceLabel}: </span>Likely fit</span></div>`,
    );
    expect(html).toContain(
      `<dt>${COPY.ai.whyWeThinkSo}</dt><dd><p class="oa-muted oa-small oa-confidence-note">${CONFIDENCE_MEANINGS.likely}</p><ul class="oa-basis-list">`,
    );
    expect(html).not.toContain('oa-confidence__meaning');
  });
});

describe('links', () => {
  it('contact link is tagged, with no invented pre-selection parameter', () => {
    const u = new URL(CTA.contact.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://offshorly.com/contact/');
    expect(Object.fromEntries(u.searchParams)).toEqual({ utm_source: 'offshorly-audit', utm_medium: 'report' });
  });
});

// ---------- Fable design and copy review, 27 Nov 2026 (specs/fable-review-2026-11-27.md) ----------

describe('§1 "customer", not "buyer"', () => {
  it('visitor copy says customer; the form heading stays', () => {
    expect(COPY.hero.title).toBe('Does your website win the customers you want, and where could AI save you time?');
    expect(COPY.form.buyerToggle).toBe('Who are you trying to win?');
    expect([COPY.form.roleLabel, COPY.form.sizeLabel, COPY.form.sectorLabel, COPY.form.triggerLabel]).toEqual([
      'Their job title',
      'Their company size',
      'Their industry (not yours)',
      'Why they are looking now',
    ]);
    expect(COPY.verdict.scoreLabel).toBe('Customer fit');
    expect(COPY.buyerFit.heading).toBe('Customer fit');
    expect(COPY.sectionLabels['buyer-fit']).toBe('Customer fit');
    expect(COPY.report.tabWebsiteHint).toBe('Customer fit, security, speed');
    expect(scoreBand(50)?.text).toBe('Losing this customer to clearer competitors');
    expect(CHECK_TEXT['geo-questions'].label).toBe("Answers customers' questions");
  });

  it('no visible "buyer" anywhere in the form, the report (live and print) or the copy file', () => {
    const form = renderToString(h(Form, { initial: EMPTY_FORM, error: null, onSubmit: () => undefined }));
    const live = renderToString(h(Report, { report: report(), request, onRestart: () => undefined }));
    const printed = renderToString(h(Report, { report: report(), request, mode: 'print' }));
    for (const html of [form, live, printed]) expect(textOnly(html)).not.toMatch(/buyer/i);
    // String values only (keys such as buyerToggle are identifiers); templates are covered by the renders above.
    const values = (o: unknown): string[] =>
      typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(values) : [];
    expect(values([COPY, CHECK_TEXT]).join('\n')).not.toMatch(/buyer/i);
  });
});

describe('§2 evidence cards', () => {
  const q = (effect: 'for' | 'against' | undefined, quote: string) => ({ quote, effect, note: 'Claims sector experience but names no client.', pageUrl: 'https://acme.example/', pageLabel: 'Homepage' });

  it('label with ✓/✕ and "See it on" in one row, then the quote, then "Why:"', () => {
    const against = renderToString(h(Quote, { q: q('against', 'We know logistics') }));
    expect(against).toMatch(
      /<figcaption class="oa-quote__head"><span class="oa-quote__label"><span class="oa-quote__mark" aria-hidden="true">✕ <\/span>Working against you<\/span><a class="oa-quote__link"[^>]*>See it on: Homepage.*?<\/a><\/figcaption><blockquote class="oa-quote__text">“We know logistics”<\/blockquote><p class="oa-quote__note">Why: Claims sector experience but names no client.<\/p>/s,
    );
    const helps = renderToString(h(Quote, { q: q('for', 'x') }));
    expect(helps).toContain('<span class="oa-quote__mark" aria-hidden="true">✓ </span>Working for you');
    // A neutral quote has no label (as in production); the link still sits right.
    const neutral = renderToString(h(Quote, { q: q(undefined, 'x') }));
    expect(neutral).toMatch(/<figcaption class="oa-quote__head"><a class="oa-quote__link"/);
    expect(css).toMatch(/\.oa-quote__link \{[^}]*margin-left: auto;/);
  });

  it('"Working against you" first; a lone card spans the full width', () => {
    const bf: BuyerFit = {
      ...sampleBuyerFit(),
      criteria: [{ name: 'Proof', score: 4, reasoning: 'Thin.', weight: 'high', evidence: [q('for', 'HELPS'), q('against', 'HURTS')] }],
    };
    const html = renderToString(h(BuyerFitDetail, { buyerFit: bf, pending: false }));
    expect(html.indexOf('HURTS')).toBeLessThan(html.indexOf('HELPS'));
    expect(css).toMatch(/\.oa-criterion__quotes > \.oa-quote:only-child \{\s*grid-column: 1 \/ -1;/);
  });
});

describe('§3 action plan', () => {
  const actions: BuyerFit['actions'] = [
    { text: 'Name a client', horizon: 'now', impact: 'high', effort: 'medium', owner: 'marketing' },
    { text: 'Add prices', horizon: 'now', impact: 'medium', effort: 'low', owner: 'leadership' },
    { text: 'Add a case study', horizon: 'now', impact: 'high', effort: 'high', owner: 'marketing' },
    { text: 'Rebuild services page', horizon: 'later', impact: 'medium', effort: 'high', owner: 'developer' },
    { text: 'Video testimonials', horizon: 'later', impact: 'low', effort: 'high', owner: 'marketing' },
  ];

  it('one numbered list across "Do first (3)" and "Do later (2)", each row with a plain meta line', () => {
    expect(COPY.buyerFit.actionsSummary(3, 2)).toBe('5 changes: 3 to do first, 2 to do later');
    expect(COPY.buyerFit.actionsSummary(1, 0)).toBe('1 change: 1 to do first');
    const html = renderToString(h(BuyerFitDetail, { buyerFit: sampleBuyerFit(actions), pending: false }));
    expect(html).toContain('5 changes: 3 to do first, 2 to do later');
    expect(html).toContain('<h4 class="oa-eyebrow oa-plan__group">Do first (3)</h4>');
    expect(html).toContain('<h4 class="oa-eyebrow oa-plan__group">Do later (2)</h4>');
    expect(html).toContain('<ol class="oa-fixfirst__list oa-plan" start="4">');
    const nums = [...html.matchAll(/<span class="oa-fixfirst__num" aria-hidden="true">(\d)<\/span>/g)].map((m) => m[1]);
    expect(nums).toEqual(['1', '2', '3', '4', '5']);
    expect(html).toContain('<p class="oa-fixfirst__title">Name a client</p><p class="oa-plan__meta">High impact · Some work · For marketing</p>');
    expect(html).not.toContain('oa-tags');
    expect(html).not.toContain('class="oa-actions"'); // the old class was also hidden by the print rule
  });
});

describe('§4 tabs', () => {
  it('segmented control: ARIA kept, arrow only on the unselected tab', () => {
    const html = renderToString(h(Report, { report: report(), request }));
    expect(html).toMatch(/role="tab" id="oa-tab-website" class="oa-tab is-selected" aria-selected="true" aria-controls="oa-panel-website"[^>]*tabindex="0"/);
    expect(html).toMatch(/role="tab" id="oa-tab-ai" class="oa-tab" aria-selected="false" aria-controls="oa-panel-ai"[^>]*tabindex="-1"/);
    expect(html.match(/class="oa-tab__arrow" aria-hidden="true">→</g)).toHaveLength(1);
    expect(html.indexOf('oa-tab__arrow')).toBeGreaterThan(html.indexOf('id="oa-tab-ai"'));
    expect(css).not.toMatch(/position:\s*(sticky|fixed)/);
  });

  it('no foot links: the tabs at the top are enough', () => {
    const html = renderToString(h(Report, { report: report(), request, onRestart: () => undefined }));
    expect(html).not.toMatch(/Next: Where AI can help|Back to: Website audit|oa-tabfoot/);
    expect(css).not.toContain('oa-tabfoot');
  });
});

describe('§5 security intro, §7 PDF hint', () => {
  it('security intro and the waiting text', () => {
    expect(COPY.security.intro).toBe(
      'We checked the security settings your site shows to every visitor, and whether your domain stops other people sending fake emails in your name. We did not try to break in.',
    );
    const busy = renderToString(h(ReportActions, { report: report({ aiStatus: 'pending' }), mode: 'live', onPdf: () => undefined }));
    expect(busy).toContain('<span class="oa-actions__hint">Available when the report has finished loading.</span>');
    const idle = renderToString(h(ReportActions, { report: report(), mode: 'live', onPdf: () => undefined }));
    expect(idle).not.toContain('oa-actions__hint');
  });
});

describe('§6 footer', () => {
  const features = { share: true, shareRetentionDays: 30, email: true };

  it('"About this report": three visible lines and a privacy link, the rest folded in a closed <details>', () => {
    const html = renderToString(h(ReportFooter, { report: report({ attributions: ['Wordfence Intelligence (vulnerability data, https://www.wordfence.com/threat-intel/)'] }), features }));
    expect(html).toMatch(
      /<footer class="oa-report-foot"><h3 class="oa-report-foot__heading">About this report<\/h3><p>We only look at.*?<\/p><p>Your pages and answers.*?<\/p><p>We keep your email.*?<a href="[^"]+"[^>]*>Privacy policy.*?<\/a><\/p><details class="oa-report-foot__more"><summary>How we handle your data<\/summary><dl/s,
    );
    const labels = [...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]);
    expect(labels).toEqual(['Saved reports', 'Idea ratings', 'Usage counts', 'Emailed reports', 'Data sources']);
    expect(html).toContain('<dd>Wordfence Intelligence (vulnerability data, https://www.wordfence.com/threat-intel/).</dd>');
    expect(html).not.toContain('Data sources:');
  });

  it('sharing off keeps its own first item; no Resend row without email; no sources row without sources', () => {
    const html = renderToString(h(ReportFooter, { report: report(), features: { share: false, shareRetentionDays: 30, email: true } }));
    expect(textOnly(html).replace(/&#39;/g, "'")).toContain(` Saved reports  ${COPY.footer.savedOff} `);
    expect(html).not.toContain('Resend');
    expect(html).not.toContain('Data sources');
  });

  it('"How we handle your data" is closed in live and shared, open only in print; ?expand=1 only touches Collapsible', () => {
    const closed = /<details class="oa-report-foot__more"><summary>/;
    expect(renderToString(h(Report, { report: report(), request, onRestart: () => undefined, features }))).toMatch(closed);
    expect(renderToString(h(Report, { report: report(), request, mode: 'shared', features }))).toMatch(closed);
    expect(renderToString(h(Report, { report: report(), request, mode: 'print', features }))).toContain('<details class="oa-report-foot__more" open>');
    expect(readFileSync(join(ROOT, 'src/components/WhatWeRead.tsx'), 'utf8')).not.toMatch(/DEV_EXPAND|expand/);
  });

  it('the data panel: bounded tint box, +/− icon on the summary, focus ring, label column from 600px, icon hidden in print', () => {
    expect(css).toMatch(/\.oa-report-foot__more \{[^}]*background: var\(--oa-tint\);[^}]*border: 1px solid var\(--oa-card-border\);[^}]*border-radius: 12px;/);
    expect(css).toMatch(/\.oa-report-foot__more > summary::before \{\s*content: '\+';/);
    expect(css).toMatch(/\.oa-report-foot__more\[open\] > summary::before \{\s*content: '−';/);
    expect(css).toMatch(/\.oa-report-foot__more > summary:focus-visible \{\s*outline: 2px solid var\(--oa-purple\);/);
    expect(css).toMatch(/@media \(min-width: 600px\) \{\s*\.oa-report-foot__list > div \{\s*grid-template-columns: 160px 1fr;/);
    expect(css).toMatch(/@media print[\s\S]*\.oa-report-foot__more > summary::before \{\s*display: none;/);
  });

  it('open in print; "Run another audit" sits under the panels, above the footer, live only', () => {
    const printed = renderToString(h(Report, { report: report(), request, mode: 'print', features }));
    expect(printed).toContain('<details class="oa-report-foot__more" open>');
    const live = renderToString(h(Report, { report: report(), request, onRestart: () => undefined, features }));
    expect(live).toContain('<details class="oa-report-foot__more">');
    const restart = live.indexOf(COPY.footer.newAudit);
    expect(restart).toBeGreaterThan(live.indexOf('id="oa-panel-ai"'));
    expect(restart).toBeLessThan(live.indexOf(COPY.footer.heading));
    expect(css).toMatch(/\.oa-restart \{\s*display: flex;\s*justify-content: flex-end;/);
  });
});

describe('§8 general', () => {
  it('title; production context lines (all visible, no toggle); production weight labels; customer-fit intro; no score explainer', () => {
    const html = renderToString(h(Report, { report: report(), request }));
    expect(html).toContain('>Website audit for acme.example</h2>');
    expect(html).toMatch(
      /<div class="oa-context"><p class="oa-context__meta"><span>Audited 20 November 2026<\/span><span class="oa-badge">Bookkeeping firm<span class="oa-badge__note"> · inferred from your site<\/span><\/span><\/p><p class="oa-context__line"><span class="oa-context__label">Assessed through the eyes of:<\/span> Owner · 10-person firm · Hospitality<\/p><p class="oa-context__line"><span class="oa-context__label">Why they(&#39;|')re looking:<\/span> Accounts are a mess<\/p><p class="oa-context__inferred">You left some customer details blank, so we filled them in with the customer your site appears to be aimed at.<\/p><\/div>/,
    );
    expect(html).not.toMatch(/Why this customer|<details class="oa-context/);
    expect(html).toContain('<span class="oa-weight oa-weight--high">Critical</span>');
    expect(COPY.buyerFit.weight).toEqual({ high: 'Critical', medium: 'Important', low: 'Supporting' });
    expect(css).toMatch(/\.oa-weight--high \{\s*background: var\(--oa-dark\);\s*border-color: var\(--oa-dark\);\s*color: var\(--oa-white\);/);
    expect(COPY.buyerFit.intro).toBe(
      'Each criterion is scored out of 10 from what your pages actually say. The overall score is an average in which the criteria that matter most to this customer count more: critical three times, important twice and supporting once, so it can differ slightly from a simple average.',
    );
    expect(html).toContain(COPY.buyerFit.intro);
    expect(html).not.toContain('How well your site persuades');
  });

  it('"What\'s working" and "Fix these first" sit side by side from 780px, as in production', () => {
    expect(css).toMatch(/@media \(min-width: 780px\) \{\s*\.oa-split \{\s*grid-template-columns: 2fr 3fr;\s*\}\s*\.oa-split--single \{\s*grid-template-columns: 1fr;/);
  });

  it('the web-search line is unchanged from production', () => {
    expect(COPY.whatWeRead.searched('agencies')).toBe('We also searched the web for examples from agencies. Nothing about you or your site was sent.');
  });

  it('while customer fit is pending, "Still reading your pages…" shows in the score card only', () => {
    const html = renderToString(h(Report, { report: report({ buyerFitStatus: 'pending', buyerFit: undefined }), request }));
    const header = html.slice(0, html.indexOf('role="tablist"'));
    expect(header).not.toContain(COPY.report.pending);
    expect(html.slice(html.indexOf('oa-verdict'))).toContain(COPY.report.pending);
  });

  it('"Optional" in sentence case everywhere; 44px tap targets on touch screens', () => {
    expect(css).toMatch(/\.oa-expander__optional \{(?![^}]*uppercase)[^}]*\}/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.oa-button,\s*\.oa-link-button,\s*\.oa-feedback__button \{\s*min-height: 44px;/);
  });

  it('placeholder and upcoming loading stages meet 4.5:1', () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const placeholder = /\.oa-input::placeholder \{\s*color: (#[0-9a-f]{6})/.exec(css)?.[1] ?? '';
    const stage = /\.oa-stage \{[^}]*color: (#[0-9a-f]{6})/.exec(css)?.[1] ?? '';
    expect(ratio(placeholder, '#f7f7fa')).toBeGreaterThanOrEqual(4.5); // input fill
    expect(ratio(stage, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
