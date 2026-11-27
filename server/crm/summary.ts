// The CRM Note for one audit (Amendment 3 §4): title and markdown body. Pure.
import { INDUSTRIES } from '../../shared/industries.js';
import { CTA } from '../../shared/services.js';
import { REGIONS, type AiResult, type AuditReport, type AuditRequest, type BuyerFitResult, type CheckResult, type FixItem } from '../../shared/types.js';

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
  /** The visitor's answers (validated, emails already redacted). */
  request?: AuditRequest;
  /** Estimated AI cost for this audit in USD; null/absent when unknown or AI didn't run. */
  costUsd?: number | null;
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

/** Industry line: the AI's resolved industry when it ran, else the visitor's choice. */
const industryLine = (ai: AiResult | null, request: AuditRequest | undefined): string | null => {
  const ind = ai?.ai?.industry;
  if (ind) return `${line(ind.label, 60)} (${ind.inferred ? 'inferred' : 'given'})`;
  if (request?.industry) return `${line(INDUSTRIES[request.industry].label, 60)} (given)`;
  return null;
};

const formatUsd = (n: number): string => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

export const buildNote = ({ lead, report, buyerFit, ai, request, costUsd }: NoteInput): { title: string; markdown: string } => {
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

  const about: string[] = [];
  const industry = industryLine(ai, request);
  if (industry) about.push(`**Industry:** ${industry}`);
  if (request?.businessType) about.push(`**Business type:** ${line(request.businessType, 100)}`);
  if (request?.teamSize) about.push(`**Team size:** ${line(request.teamSize, 20)}`);
  if (request?.region) about.push(`**Based in:** ${line(REGIONS[request.region], 40)}`);
  if (request?.tools) about.push(`**Tools:** ${line(request.tools, 150)}`);
  if (request?.timeSink) about.push(`**What eats the week:** ${line(request.timeSink, 200)}`);
  if (about.length) out.push('', ...about);

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
  // Square brackets escaped like every other markdown character in the note.
  else out.push('**AI ideas**', ...ideas.map((o) => `- ${line(o.title)} (${o.service.name}) ${escapeMarkdown(`[${o.source ?? 'site'}]`)}`));
  if (typeof costUsd === 'number' && Number.isFinite(costUsd)) out.push(`AI cost (est.): ${formatUsd(costUsd)}`);

  out.push(
    '',
    'Email not verified',
    `Marketing opt-in: ${lead.marketingOptIn ? 'yes' : 'no'} (notice ${lead.noticeVersion}, ${lead.consentAt})`,
    'Source: audit widget',
    `Booking link shown: ${CTA.consultation.url}`,
  );
  return { title: noteTitle(lead, report), markdown: out.join('\n') };
};
