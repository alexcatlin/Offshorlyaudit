// The CRM Note for one audit (Amendment 3 §4): title and markdown body. Pure.
import { CTA } from '../../shared/services.js';
import type { AiResult, AuditReport, BuyerFitResult, CheckResult, FixItem } from '../../shared/types.js';

export interface CrmLead {
  /** Lowercased as typed (not the canonical gate form). */
  email: string;
  name?: string;
  marketingOptIn: boolean;
  /** ISO time the visitor submitted the form. */
  consentAt: string;
  noticeVersion: 'v1';
  /** The gate key (HMAC); only its prefix is ever logged. */
  emailHash: string;
  /** Allow-listed (staff/testing) address: the title is prefixed "[Test] ". */
  test: boolean;
}

export interface NoteInput {
  lead: CrmLead;
  report: AuditReport;
  buyerFit: BuyerFitResult | null;
  ai: AiResult | null;
}

const MAX_FIX_LINES = 5;

/** Backslash-escapes markdown control characters, so site- or visitor-derived text can't add
 *  links, images, emphasis or HTML to the Note. */
export const escapeMarkdown = (s: string): string => s.replace(/[\\`*_{}[\]()<>#+!|~]/g, '\\$&');

/** One line of plain text: no newlines, trimmed, capped, markdown-escaped. */
const line = (s: string, max = 300): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return escapeMarkdown(t.length > max ? `${t.slice(0, max - 1)}…` : t);
};

/** The audited URL (site-controlled after redirects) as a markdown autolink. Spaces and angle
 *  brackets are percent-encoded so the link can't be closed early. */
export const autolink = (url: string): string => `<${url.replace(/[\s<>]/g, (c) => encodeURIComponent(c))}>`;

const score = (n: number | null | undefined): string => (typeof n === 'number' ? `${n}/100` : 'n/a');

const fixLine = (item: FixItem, checks: Map<string, CheckResult>, bf: BuyerFitResult | null): string | null => {
  if (item.source === 'check' && item.checkId) {
    const c = checks.get(item.checkId);
    return c ? line(c.detail) : null;
  }
  if (item.source === 'ai' && item.actionIndex !== undefined) {
    const a = bf?.buyerFit?.actions[item.actionIndex];
    return a ? line(a.text) : null;
  }
  return null;
};

export const noteTitle = (lead: CrmLead, report: AuditReport): string =>
  `${lead.test ? '[Test] ' : ''}Website audit: ${report.domain}`;

export const buildNote = ({ lead, report, buyerFit, ai }: NoteInput): { title: string; markdown: string } => {
  const out: string[] = [];
  out.push(`**Audited URL:** ${autolink(report.url)}`);
  out.push(`**Audit date:** ${report.auditedAt.slice(0, 10)}`);

  const bf = buyerFit?.buyerFit;
  if (bf) {
    out.push(`**Buyer fit:** ${score(bf.score)} - ${line(bf.verdict.summary)}`);
  } else {
    out.push('**Buyer fit:** not run');
  }
  out.push(`**Security:** ${score(report.security.score)} · **Website health:** ${score(report.health.score)}`);

  const checks = new Map<string, CheckResult>([...report.security.checks, ...report.health.checks].map((c) => [c.id, c]));
  const fixes = (buyerFit?.fixFirst ?? report.fixFirst)
    .map((f) => fixLine(f, checks, buyerFit))
    .filter((s): s is string => !!s)
    .slice(0, MAX_FIX_LINES);
  if (fixes.length) {
    out.push('', '**Fix these first**', ...fixes.map((f) => `- ${f}`));
  }

  const ran = ai && (ai.aiStatus === 'ok' || ai.aiStatus === 'fixture' || ai.aiStatus === 'insufficient');
  const ideas = ran ? (ai.ai?.opportunities ?? []) : [];
  out.push('');
  if (!ran) out.push('**AI ideas:** not run');
  else if (!ideas.length) out.push('**AI ideas:** none found');
  else out.push('**AI ideas**', ...ideas.map((o) => `- ${line(o.title)} (${o.service.name})`));

  out.push(
    '',
    'Email not verified',
    `Marketing opt-in: ${lead.marketingOptIn ? 'yes' : 'no'} (notice ${lead.noticeVersion}, ${lead.consentAt})`,
    'Source: audit widget',
    `Booking link shown: ${CTA.consultation.url}`,
  );
  return { title: noteTitle(lead, report), markdown: out.join('\n') };
};
