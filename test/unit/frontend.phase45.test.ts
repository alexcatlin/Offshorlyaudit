// Amendment 5 Phases 4–5 front end: email action, footer copy, industry examples, source bases,
// the "we searched the web" line, and votes kept across in-place print. Rendered to HTML; no DOM.
import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { INDUSTRIES, INDUSTRY_IDS, industryPhrase } from '../../shared/industries.js';
import type { AiSection, AuditReport } from '../../shared/types.js';
import { AiOpportunities, IndustryExamples, sourceLabel } from '../../src/components/AiOpportunities.js';
import { FeedbackButtons } from '../../src/components/FeedbackButtons.js';
import { Report } from '../../src/components/Report.js';
import { emailErrorText, ReportActions } from '../../src/components/ReportActions.js';
import { privacyText, WhatWeRead } from '../../src/components/WhatWeRead.js';
import { COPY } from '../../src/content/copy.js';
import { toAuditError } from '../../src/lib/errors.js';
import { dataMessage, parseDataMessage } from '../../src/lib/printBridge.js';
import { maskEmail } from '../../src/lib/report.js';
import { sampleAi, sampleBuyerFit } from './_appMock.js';

const aiWithExamples = (): AiSection => ({
  ...sampleAi(),
  industry: { id: 'legal', label: 'Legal', inferred: false },
  opportunities: [
    ...sampleAi().opportunities,
    {
      ...sampleAi().opportunities[0]!,
      title: 'Client intake triage',
      source: 'industry',
      basis: [
        { kind: 'industry', patternId: 'legal.intake', industryLabel: 'Legal', text: 'Pattern text.' },
        { kind: 'source', title: 'How firms triage intake', domain: 'news.example', url: 'https://news.example/a' },
      ],
    },
  ],
  industryExamples: [
    {
      text: 'One firm describes sorting new enquiries with an assistant.',
      sources: [
        { title: 'Intake with AI', domain: 'example.com', url: 'https://example.com/sample-article' },
        { domain: 'other.example', url: 'https://other.example/x' },
      ],
    },
  ],
  research: { industryId: 'legal', label: 'Legal', searchedAt: '2026-11-19T09:00:00.000Z' },
});

const report = (over: Partial<AuditReport> = {}): AuditReport => ({
  auditId: 'a1',
  auditedAt: '2026-11-20T10:00:00Z',
  url: 'https://acme.example/',
  domain: 'acme.example',
  pagesRead: [{ url: 'https://acme.example/', label: 'Homepage', title: 'Acme' }],
  aiStatus: 'ok',
  ai: aiWithExamples(),
  buyerFitStatus: 'ok',
  buyerFit: sampleBuyerFit(),
  security: { score: 70, checks: [{ id: 'sec-https', status: 'pass', detail: 'HTTPS.' }] },
  health: { score: 80, checks: [], measuredByGoogle: false },
  cms: { platform: 'unknown' },
  stack: [],
  fixFirst: [],
  attributions: [],
  ...over,
});

const request = { url: 'https://acme.example/' };
const features = { share: true, email: true, feedback: true, shareRetentionDays: 30 };

describe('Phase 4: email action', () => {
  it('"Email me this report" only in live mode with features.email, a session and the email', () => {
    const r = report();
    const on = renderToString(h(ReportActions, { report: r, mode: 'live', onPdf: () => undefined, features, session: 's'.repeat(22), email: 'jo@acme.example' }));
    expect(on).toContain(COPY.actions.email);
    for (const props of [
      { features: { ...features, email: false }, session: 's', email: 'jo@acme.example' },
      { features, session: null, email: 'jo@acme.example' },
      { features, session: 's', email: null },
      { features: { ...features, share: false }, session: 's', email: 'jo@acme.example' },
    ]) {
      expect(renderToString(h(ReportActions, { report: r, mode: 'live', onPdf: () => undefined, ...props }))).not.toContain(COPY.actions.email);
    }
    expect(renderToString(h(ReportActions, { report: r, mode: 'shared', onPdf: () => undefined, features, session: 's', email: 'jo@acme.example' }))).not.toContain(COPY.actions.email);
  });

  it('disabled until the report settles', () => {
    const pending = renderToString(h(ReportActions, { report: report({ aiStatus: 'pending' }), mode: 'live', onPdf: () => undefined, features, session: 's', email: 'jo@acme.example' }));
    expect(pending).toMatch(new RegExp(`<button[^>]*disabled[^>]*>${COPY.actions.email}`));
  });

  it('maskEmail: first character, dots, domain; the full address is never shown', () => {
    expect(maskEmail('jo.smith@acme.com')).toBe('j•••@acme.com');
    expect(maskEmail(' Jo@acme.com ')).toBe('J•••@acme.com');
    expect(maskEmail('nope')).toBe('•••');
    expect(COPY.actions.emailConfirm(maskEmail('jo.smith@acme.com'))).toBe(
      "We'll email a link to this report to j•••@acme.com. We only send to the address you entered.",
    );
  });

  it('error copy: already sent, session expired, otherwise "copy the link"', () => {
    expect(emailErrorText(toAuditError(409, { code: 'already_sent', error: 'x' }))).toBe(COPY.actions.emailAlready);
    expect(emailErrorText(toAuditError(410, { code: 'session_expired', error: 'x' }))).toBe(COPY.actions.sessionExpired);
    expect(emailErrorText(toAuditError(502, { code: 'email_failed', error: 'x' }))).toBe(COPY.actions.emailFailed);
    expect(emailErrorText(new Error('network'))).toBe(COPY.actions.emailFailed);
    expect(COPY.actions.emailSent).toBe('Sent. It should arrive in a minute or two; check your spam folder if not.');
    expect(COPY.actions.email).toBe('Email me this report');
  });

  it('footer: the Resend sentence only when email is on', () => {
    const sentence = 'If you ask us to email the report, we send it to the address you entered through our email provider, Resend.';
    expect(COPY.footer.privacyEmail).toBe(sentence);
    expect(privacyText({ share: true, shareRetentionDays: 30, email: true })).toContain(sentence);
    expect(privacyText({ share: true, shareRetentionDays: 30, email: false })).not.toContain('Resend');
    expect(privacyText({ share: true, shareRetentionDays: 30 })).not.toContain('Resend');
    expect(privacyText({ share: false, shareRetentionDays: 30, email: true })).not.toContain('Resend');
    expect(privacyText(null)).not.toContain('Resend');
  });

  it('the print window keeps the email flag for the footer', () => {
    const msg = dataMessage({ report: report(), request, features: { share: true, shareRetentionDays: 30, email: true } });
    const parsed = parseDataMessage({ origin: 'https://a.example', source: 'op', data: msg }, { origin: 'https://a.example', opener: 'op' });
    expect(parsed?.features).toEqual({ share: true, shareRetentionDays: 30, email: true });
  });
});

describe('Phase 5: industry examples', () => {
  it('heading, dated intro, text and source links with third-party rel attributes', () => {
    const out = renderToString(h(AiOpportunities, { report: report(), request }));
    expect(out).toContain(COPY.ai.examplesHeading('legal'));
    expect(out).toContain('What others in legal are doing');
    expect(out).not.toContain('What others in Legal');
    expect(out).toMatch(/From a web search on 19 November 2026\. Third-party sources we haven(&#39;|')t checked: follow the links to read them\./);
    expect(out).toContain('One firm describes sorting new enquiries with an assistant.');
    expect(out).toContain('Intake with AI (example.com)');
    expect(out).toContain('other.example');
    const links = [...out.matchAll(/<a [^>]*class="oa-source-link"[^>]*>/g)].map((m) => m[0]);
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const a of links) {
      expect(a).toContain('rel="noopener noreferrer nofollow ugc"');
      expect(a).toContain('target="_blank"');
    }
  });

  it('hidden with no examples, and only http(s) URLs become links', () => {
    expect(renderToString(h(IndustryExamples, { examples: [] }))).toBe('');
    expect(renderToString(h(IndustryExamples, { examples: undefined }))).toBe('');
    const out = renderToString(h(IndustryExamples, { examples: [{ text: 'T.', sources: [{ title: 'X', domain: 'x.example', url: 'javascript:alert(1)' }] }] }));
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('<a ');
  });

  it('a source basis reads "Seen elsewhere: {title} ({domain})", or the domain alone', () => {
    const out = renderToString(h(AiOpportunities, { report: report(), request }));
    expect(out).toContain(COPY.ai.basisSource);
    expect(out).toContain('How firms triage intake (news.example)');
    expect(sourceLabel({ domain: 'a.example', url: 'https://a.example/' })).toBe('a.example');
  });

  it('older JSON (no industryExamples, research or source bases) still renders, without the block', () => {
    const out = renderToString(h(AiOpportunities, { report: report({ ai: sampleAi() }), request }));
    expect(out).toContain(sampleAi().opportunities[0]!.title);
    expect(out).not.toContain('What others in');
  });

  it('"What we read" mentions the web search only when research was used', () => {
    const line = COPY.whatWeRead.searched('legal');
    expect(line).toBe('We also searched the web for examples from legal. Nothing about you or your site was sent.');
    expect(renderToString(h(WhatWeRead, { report: report() }))).toContain(line);
    expect(renderToString(h(WhatWeRead, { report: report({ ai: sampleAi() }) }))).not.toContain('searched the web');
  });

  it('print mode shows the examples too', () => {
    const out = renderToString(h(Report, { report: report(), request, mode: 'print' }));
    expect(out).toContain('What others in legal are doing');
  });

  it('industry names are lowercased mid-sentence: phrase per industry, SaaS kept', () => {
    for (const id of INDUSTRY_IDS) {
      const { label, phrase } = INDUSTRIES[id];
      expect(phrase).toBeTruthy();
      expect(phrase.toLowerCase()).toBe(label.toLowerCase());
      expect(phrase.charAt(0)).toBe(phrase.charAt(0).toLowerCase());
    }
    expect(industryPhrase('software-saas')).toBe('software and SaaS');
    expect(industryPhrase('construction-trades', 'Construction and trades')).toBe('construction and trades');
    // `other`: the model's own label, first letter lowered unless it starts with an acronym.
    expect(industryPhrase('other', 'Garden lighting')).toBe('garden lighting');
    expect(industryPhrase('other', 'IT support')).toBe('IT support');
    expect(industryPhrase('other', '')).toBe('');
    const r = report({ ai: { ...report().ai!, industry: { id: 'construction-trades', label: 'Construction and trades', inferred: false }, research: { industryId: 'construction-trades', label: 'Construction and trades', searchedAt: '2026-11-19T09:00:00.000Z' } } });
    expect(renderToString(h(AiOpportunities, { report: r, request }))).toContain('What others in construction and trades are doing');
    expect(renderToString(h(WhatWeRead, { report: r }))).toContain('examples from construction and trades.');
  });
});

describe('votes kept across in-place print', () => {
  it('FeedbackButtons start from initialVote', () => {
    const out = renderToString(h(FeedbackButtons, { index: 0, onVote: async () => 'ok' as const, initialVote: 'down' }));
    expect(out).toMatch(/aria-pressed="true"[^>]*>Not useful/);
    expect(out).toMatch(/aria-pressed="false"[^>]*>Useful/);
  });

  it('Report passes accepted votes to each idea (live); print mode still has no feedback markup', () => {
    const live = renderToString(h(Report, { report: report(), request, mode: 'live', onVote: async () => 'ok' as const, votes: { 0: 'up' } }));
    expect(live).toMatch(/aria-pressed="true"[^>]*>Useful/);
    const print = renderToString(h(Report, { report: report(), request, mode: 'print', onVote: async () => 'ok' as const, votes: { 0: 'up' } }));
    expect(print).not.toContain('oa-feedback');
  });
});
