// Amendment 5 front end (Phases 1–3): print bridge, Report modes, feedback buttons, actions
// row, shared page and footer copy. Rendered to HTML; no DOM.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { h } from 'preact';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it, vi } from 'vitest';
import type { AuditReport, SharedReport } from '../../shared/types.js';
import { FeedbackButtons, nextVote } from '../../src/components/FeedbackButtons.js';
import { Report } from '../../src/components/Report.js';
import { isReportSettled, ReportActions } from '../../src/components/ReportActions.js';
import { privacyText, ReportFooter } from '../../src/components/WhatWeRead.js';
import { COPY } from '../../src/content/copy.js';
import { toAuditError } from '../../src/lib/errors.js';
import { formatDate } from '../../src/lib/report.js';
import {
  dataMessage,
  isReadyMessage,
  openPrintWindow,
  parseDataMessage,
  PRINT_DATA,
  PRINT_READY,
} from '../../src/lib/printBridge.js';
import type { BridgeMessage, OpenerEnv } from '../../src/lib/printBridge.js';
import { sharedView, SharedView } from '../../src/shared/SharedApp.js';
import { sampleAi, sampleBuyerFit } from './_appMock.js';

const ORIGIN = 'https://audit.example';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const report = (over: Partial<AuditReport> = {}): AuditReport => ({
  auditId: 'a1',
  auditedAt: '2026-11-20T10:00:00Z',
  url: 'https://acme.example/',
  domain: 'acme.example',
  pagesRead: [{ url: 'https://acme.example/', label: 'Homepage', title: 'Acme' }],
  aiStatus: 'ok',
  ai: sampleAi(),
  buyerFitStatus: 'ok',
  buyerFit: sampleBuyerFit(),
  security: { score: 70, checks: [{ id: 'sec-https', status: 'pass', detail: 'HTTPS.' }] },
  health: { score: 80, checks: [{ id: 'seo-title', status: 'warn', detail: 'Short title.' }], measuredByGoogle: false },
  cms: { platform: 'unknown' },
  stack: [],
  fixFirst: [],
  attributions: [],
  ...over,
});

const request = { url: 'https://acme.example/' };
const features = { share: true, email: false, feedback: true, shareRetentionDays: 30 };
const onVote = async () => 'ok' as const;

describe('printBridge', () => {
  const opener = { id: 'opener' };
  const payload = { report: report(), request };
  const msg = (over: Partial<BridgeMessage> = {}): BridgeMessage => ({ origin: ORIGIN, source: opener, data: dataMessage(payload), ...over });

  it('accepts a valid data message from the opener', () => {
    expect(parseDataMessage(msg(), { origin: ORIGIN, opener })).toEqual(payload);
    const withFeatures = parseDataMessage(msg({ data: dataMessage({ ...payload, features: { share: true, shareRetentionDays: 30 } }) }), { origin: ORIGIN, opener });
    expect(withFeatures?.features).toEqual({ share: true, shareRetentionDays: 30 });
  });

  it('rejects a wrong origin, a wrong source, no opener and malformed payloads', () => {
    expect(parseDataMessage(msg({ origin: 'https://evil.example' }), { origin: ORIGIN, opener })).toBeNull();
    expect(parseDataMessage(msg({ source: { id: 'other' } }), { origin: ORIGIN, opener })).toBeNull();
    expect(parseDataMessage(msg({ source: null }), { origin: ORIGIN, opener: null })).toBeNull();
    for (const data of [
      null,
      'oa-print:data',
      { type: PRINT_READY },
      { type: PRINT_DATA },
      { type: PRINT_DATA, report: { domain: 'x' }, request },
      { type: PRINT_DATA, report: report(), request: {} },
      { type: PRINT_DATA, report: { ...report(), security: null }, request },
    ]) {
      expect(parseDataMessage(msg({ data }), { origin: ORIGIN, opener }), JSON.stringify(data)?.slice(0, 60)).toBeNull();
    }
  });

  it('isReadyMessage checks origin, source and type', () => {
    const w = {};
    expect(isReadyMessage({ origin: ORIGIN, source: w, data: { type: PRINT_READY } }, { origin: ORIGIN, source: w })).toBe(true);
    expect(isReadyMessage({ origin: 'https://evil.example', source: w, data: { type: PRINT_READY } }, { origin: ORIGIN, source: w })).toBe(false);
    expect(isReadyMessage({ origin: ORIGIN, source: {}, data: { type: PRINT_READY } }, { origin: ORIGIN, source: w })).toBe(false);
    expect(isReadyMessage({ origin: ORIGIN, source: w, data: { type: 'other' } }, { origin: ORIGIN, source: w })).toBe(false);
  });

  const env = (win: { postMessage: (m: unknown, o: string) => void } | null) => {
    const listeners: ((ev: BridgeMessage) => void)[] = [];
    const e: OpenerEnv & { listeners: typeof listeners } = {
      listeners,
      origin: ORIGIN,
      open: vi.fn(() => win),
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
      printInPlace: vi.fn(),
      setTimer: () => 0,
    };
    return e;
  };

  it('openPrintWindow: replies to the ready message from its window only, once', () => {
    const win = { postMessage: vi.fn() };
    const e = env(win);
    expect(openPrintWindow(payload, e)).toBe('window');
    expect(e.open).toHaveBeenCalledWith('/print', 'oa-print');
    e.listeners[0]!({ origin: ORIGIN, source: {}, data: { type: PRINT_READY } });
    e.listeners[0]!({ origin: 'https://evil.example', source: win, data: { type: PRINT_READY } });
    expect(win.postMessage).not.toHaveBeenCalled();
    e.listeners[0]!({ origin: ORIGIN, source: win, data: { type: PRINT_READY } });
    expect(win.postMessage).toHaveBeenCalledWith(dataMessage(payload), ORIGIN);
    expect(e.listeners).toHaveLength(0);
  });

  it('openPrintWindow: popup blocked → prints in place', () => {
    const e = env(null);
    expect(openPrintWindow(payload, e)).toBe('in-place');
    expect(e.printInPlace).toHaveBeenCalled();
  });
});

describe('Report modes', () => {
  it('print: both panels with headings, every section open, no tablist, feedback or restart; actions kept but hidden by print CSS', () => {
    const html = renderToString(
      h(Report, {
        report: report(),
        request,
        mode: 'print',
        onRestart: () => undefined,
        onVote,
        actions: h('div', { class: 'oa-actions' }, 'ACTIONS'),
        features,
      }),
    );
    expect(html).toContain(COPY.print.header('acme.example', '20 November 2026'));
    expect(html).toContain(`>${COPY.print.websiteHeading}</h2>`);
    expect(html).toContain(`>${COPY.print.aiHeading}</h2>`);
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tabpanel"');
    // In-place printing keeps the actions mounted in the header (state survives); the
    // `.oa-actions` class is hidden by the print stylesheet.
    expect(html).toMatch(/<header class="oa-report__header">.*<div class="oa-actions">ACTIONS<\/div><\/header>/s);
    expect(readFileSync(join(ROOT, 'src/styles/widget.css'), 'utf8')).toMatch(/@media print[\s\S]*\.oa-actions,[\s\S]*display: none !important/);
    expect(html).not.toContain('oa-feedback');
    expect(html).not.toContain(COPY.footer.newAudit);
    expect(html).toContain('Faster invoice processing');
    // Collapsibles forced open: no hidden section bodies.
    expect(html).not.toMatch(/class="oa-collapsible__body" hidden/);
    expect(html).toContain('aria-expanded="true"');
  });

  it('live: tabs, actions slot, feedback on each idea and restart', () => {
    const html = renderToString(
      h(Report, { report: report(), request, mode: 'live', onRestart: () => undefined, onVote, actions: h('div', null, 'ACTIONS'), features }),
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('ACTIONS');
    expect(html).toContain('class="oa-feedback"');
    expect(html).toContain(COPY.feedback.question);
    expect(html).toContain(COPY.footer.newAudit);
  });

  it('shared: no feedback even with a handler, no restart; banner shown', () => {
    const shared: SharedReport = {
      v: 1,
      shareId: 'S'.repeat(22),
      createdAt: '2026-11-20T10:00:00Z',
      expiresAt: '2026-12-20T10:00:00Z',
      report: (({ auditId: _a, ...r }) => r)(report()),
      answers: { timeSink: 'chasing invoices' },
    };
    const html = renderToString(h(SharedView, { shared, onPdf: () => undefined }));
    expect(html).toContain(COPY.shared.banner('acme.example', '20 November 2026', '20 December 2026'));
    expect(html).toContain(COPY.shared.disclaimer('acme.example', '20 November 2026'));
    expect(html).toContain(COPY.shared.cta);
    expect(html).toContain('role="tablist"');
    expect(html).not.toContain('oa-feedback');
    expect(html).not.toContain(COPY.footer.newAudit);
    expect(html).toContain(COPY.actions.pdf);
    expect(html).not.toContain(COPY.actions.copyLink);
    expect(html).toContain(COPY.footer.privacyShare(30));
    const printed = renderToString(h(SharedView, { shared, printing: true, onPdf: () => undefined }));
    expect(printed).not.toContain('role="tablist"');
    // Kept mounted for in-place printing; print CSS hides .oa-actions.
    expect(printed).toContain('class="oa-actions"');
    const view = sharedView(shared);
    expect(view.days).toBe(30);
    expect(view.request).toEqual({ url: 'https://acme.example/', timeSink: 'chasing invoices' });
  });
});

describe('print window', () => {
  it('PrintApp passes no actions to Report and titles the page with formatDate', () => {
    const src = readFileSync(join(ROOT, 'src/print/PrintApp.tsx'), 'utf8');
    const call = /<Report\b[^>]*\/>/.exec(src)?.[0] ?? '';
    expect(call).toContain('mode="print"');
    expect(call).not.toContain('actions');
    expect(src).toContain('document.title = COPY.print.header(state.payload.report.domain, formatDate(state.payload.report.auditedAt))');
    expect(formatDate('2026-11-20T10:00:00Z')).toBe('20 November 2026');
  });
});

describe('FeedbackButtons', () => {
  it('pressing toggles; pressing the active one clears', () => {
    expect(nextVote(null, 'up')).toBe('up');
    expect(nextVote('up', 'up')).toBeNull();
    expect(nextVote('up', 'down')).toBe('down');
    expect(nextVote('down', 'down')).toBeNull();
  });

  it('aria-pressed reflects the vote', () => {
    const none = renderToString(h(FeedbackButtons, { index: 0, onVote }));
    expect(none.match(/aria-pressed="false"/g)).toHaveLength(2);
    const up = renderToString(h(FeedbackButtons, { index: 0, onVote, initialVote: 'up' }));
    expect(up).toMatch(/aria-pressed="true"[^>]*>Useful</);
    expect(up).toMatch(/aria-pressed="false"[^>]*>Not useful</);
  });
});

describe('ReportActions', () => {
  it('disabled with the waiting hint while buyer fit or AI is pending', () => {
    const html = renderToString(h(ReportActions, { report: report({ aiStatus: 'pending' }), mode: 'live', onPdf: () => undefined, features, session: 'S'.repeat(22) }));
    expect(html).toContain(COPY.actions.waiting);
    expect(html.match(/disabled/g)?.length).toBe(2);
    expect(isReportSettled(report({ buyerFitStatus: 'pending' }))).toBe(false);
    expect(isReportSettled(report())).toBe(true);
  });

  it('live with sharing on: Save as PDF and Copy link in one row; off or no session: PDF only', () => {
    const on = renderToString(h(ReportActions, { report: report(), mode: 'live', onPdf: () => undefined, features, session: 'S'.repeat(22) }));
    expect(on).toContain(COPY.actions.pdf);
    expect(on).toContain(COPY.actions.copyLink);
    expect(on).toContain(COPY.actions.pdfHint);
    expect(on).not.toContain('disabled');
    expect(on.match(/oa-actions__row/g)).toHaveLength(1);
    expect(on).not.toContain(COPY.actions.email); // Phase 4 not built
    const off = renderToString(h(ReportActions, { report: report(), mode: 'live', onPdf: () => undefined, features: { ...features, share: false }, session: 'S'.repeat(22) }));
    expect(off).not.toContain(COPY.actions.copyLink);
    const noSession = renderToString(h(ReportActions, { report: report(), mode: 'live', onPdf: () => undefined, features, session: null }));
    expect(noSession).not.toContain(COPY.actions.copyLink);
  });
});

describe('footer privacy copy', () => {
  it('switches on features.share', () => {
    expect(privacyText({ share: true, shareRetentionDays: 30 })).toContain('deleted after 30 days');
    expect(privacyText({ share: false, shareRetentionDays: 30 })).toBe(COPY.footer.privacy);
    expect(privacyText(null)).toBe(COPY.footer.privacy);
    expect(COPY.footer.privacy).toContain("We don't save reports or create share links.");
    const on = renderToString(h(ReportFooter, { report: report(), features: { share: true, shareRetentionDays: 7 } }));
    expect(on).toContain('We only save a report if you share or email it.');
    expect(on).toContain('deleted after 7 days');
    const off = renderToString(h(ReportFooter, { report: report() }));
    expect(off).toContain("We don't save reports");
  });
});

describe('new error codes', () => {
  it('maps 410, 409 not_ready and 503 share_unavailable to the planned copy', () => {
    expect(toAuditError(410, null).message).toBe(COPY.actions.sessionExpired);
    expect(toAuditError(410, { code: 'session_expired', error: 'x' }).code).toBe('session_expired');
    expect(toAuditError(409, { code: 'not_ready', error: 'x' }).message).toBe(COPY.actions.waiting);
    expect(toAuditError(503, { code: 'share_unavailable', error: 'x' }).message).toBe(COPY.actions.shareUnavailable);
  });

  it('exact copy strings', () => {
    expect(COPY.actions.linkCopied('20 December 2026')).toBe('Link copied. Anyone with it can view this report, including your answers, until 20 December 2026.');
    expect(COPY.actions.pdfHint).toBe("Choose 'Save as PDF' as the printer.");
    expect(COPY.shared.expired).toBe('This report link has expired or been deleted.');
    expect(COPY.feedback).toMatchObject({ question: 'Was this idea useful?', up: 'Useful', down: 'Not useful', thanks: 'Thanks for telling us.' });
    const rated = "If you rate an idea, we keep your rating, the idea and the site's address for up to a year, with no email attached.";
    expect(COPY.footer.privacy).toBe(
      `We don't save reports or create share links. We keep your email, the site you audited, your answers and a summary of the results in our CRM to follow up. Results are otherwise held briefly in memory. ${rated} The text of the pages we read and any answers you add are sent to Anthropic's Claude for analysis; your email is not.`,
    );
    expect(COPY.footer.privacyShare(30)).toBe(
      `We only save a report if you share or email it. A saved report has no email address attached, can be seen by anyone with its link, is hidden from search engines, and is deleted after 30 days or as soon as you delete the link. We keep your email, the site you audited, your answers and a summary of the results in our CRM to follow up. Otherwise results are held briefly in memory. ${rated} The text of the pages we read and any answers you add are sent to Anthropic's Claude for analysis; your email is not.`,
    );
  });
});
