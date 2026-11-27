// The report email (Amendment 5 Phase 4). Pure: server-owned wording only. No model prose, no site
// quotes, no idea titles, no remote images, no open or click tracking. No booking CTA either
// (a one-off service message under PECR), except when the visitor ticked "Email me occasional
// ideas and offers": the caller then passes `bookingUrl`. Every interpolated value is escaped
// in the HTML part.
import { CTA } from '../../shared/services.js';
import type { AuditReport } from '../../shared/types.js';

export interface ReportEmailInput {
  domain: string;
  /** The share link (https, from PUBLIC_ORIGIN). */
  url: string;
  auditedAt: string;
  expiresAt: string;
  buyerFit: number | null;
  security: number | null;
  health: number | null;
  /** Number of AI ideas; null when the AI ideas are not available. */
  ideas: number | null;
  /** MAIL_FOOTER_LINE, or "Offshorly Ltd". */
  footerLine: string;
  /** The tagged booking link. Pass it only for a visitor who opted in to offers; absent = no booking line. */
  bookingUrl?: string;
}

export interface ReportEmail {
  subject: string;
  text: string;
  html: string;
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** One line, no control characters (keeps the subject and text parts single-line per field). */
const oneLine = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, ' ').trim();

/** "20 November 2026" (UTC); the raw string when unparseable. */
export const emailDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return oneLine(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** The fields of a settled report the email reads. */
export const reportEmailFields = (
  report: Pick<AuditReport, 'domain' | 'auditedAt' | 'buyerFit' | 'buyerFitStatus' | 'security' | 'health' | 'ai' | 'aiStatus'>,
): Pick<ReportEmailInput, 'domain' | 'auditedAt' | 'buyerFit' | 'security' | 'health' | 'ideas'> => ({
  domain: report.domain,
  auditedAt: report.auditedAt,
  buyerFit: (report.buyerFitStatus === 'ok' || report.buyerFitStatus === 'fixture') && report.buyerFit ? report.buyerFit.score : null,
  security: report.security.score,
  health: report.health.score,
  ideas: (report.aiStatus === 'ok' || report.aiStatus === 'fixture') && report.ai ? report.ai.opportunities.length : null,
});

const scoreLine = (i: ReportEmailInput): string => {
  const parts: string[] = [];
  if (i.buyerFit !== null) parts.push(`Customer fit: ${i.buyerFit}/100`);
  if (i.security !== null) parts.push(`Security: ${i.security}/100`);
  if (i.health !== null) parts.push(`Website health: ${i.health}/100`);
  if (i.ideas !== null) parts.push(`AI ideas: ${i.ideas}`);
  return parts.join(' · ');
};

export const buildReportEmail = (input: ReportEmailInput): ReportEmail => {
  const domain = oneLine(input.domain);
  const url = oneLine(input.url);
  const audited = emailDate(input.auditedAt);
  const expiry = emailDate(input.expiresAt);
  const scores = scoreLine(input);
  const footer = oneLine(input.footerLine);
  const booking = input.bookingUrl ? oneLine(input.bookingUrl) : '';

  const lines = [
    `Here's the link to the website audit you asked for: ${url}`,
    `Website: ${domain}, audited ${audited}`,
    ...(scores ? [scores] : []),
    `The link works until ${expiry}. Anyone with it can view the report, so only forward it to people you trust.`,
    ...(booking ? [`Want to talk it through? ${CTA.consultation.label}: ${booking}`] : []),
    "You're getting this one-off email because you asked for it on the Offshorly website audit. Questions? Just reply.",
    footer,
  ];
  const text = `${lines.join('\n\n')}\n`;

  const p = (inner: string, style = 'margin:0 0 16px') => `<p style="${style}">${inner}</p>`;
  const e = escapeHtml;
  const html = [
    '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
    `<title>${e(`Your website audit for ${domain}`)}</title></head>`,
    '<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;background:#ffffff">',
    p(`Here's the link to the website audit you asked for: <a href="${e(url)}" style="color:#0b57d0">${e(url)}</a>`),
    p(`Website: ${e(domain)}, audited ${e(audited)}`),
    ...(scores ? [p(e(scores))] : []),
    p(`The link works until ${e(expiry)}. Anyone with it can view the report, so only forward it to people you trust.`),
    ...(booking ? [p(`Want to talk it through? <a href="${e(booking)}" style="color:#0b57d0">${e(CTA.consultation.label)}</a>`)] : []),
    p("You're getting this one-off email because you asked for it on the Offshorly website audit. Questions? Just reply.", 'margin:0 0 16px;color:#555555;font-size:13px'),
    p(e(footer), 'margin:0;color:#555555;font-size:13px'),
    '</body></html>',
  ].join('');

  return { subject: `Your website audit for ${domain}`, text, html };
};
