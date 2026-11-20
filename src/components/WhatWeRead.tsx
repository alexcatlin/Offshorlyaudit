import { industryPhrase } from '../../shared/industries.js';
import type { AuditReport, Features } from '../../shared/types.js';
import { COPY } from '../content/copy.js';
import { Collapsible } from './Collapsible.js';
import { ExternalLink } from './ui.js';

const shortUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
};

export const WhatWeRead = ({ report }: { report: AuditReport }) => {
  if (!report.pagesRead.length) return null;
  return (
    <Collapsible title={COPY.whatWeRead.heading} summary={COPY.whatWeRead.summary(report.pagesRead.length)}>
      <ul class="oa-pages">
        {report.pagesRead.map((p) => (
          <li key={p.url} class="oa-page-chip">
            <span class="oa-page-chip__label">{p.label}</span>
            <ExternalLink class="oa-page-chip__url" href={p.url}>
              {shortUrl(p.url)}
            </ExternalLink>
          </li>
        ))}
      </ul>
      {report.ai?.research?.label && (
        <p class="oa-muted oa-small oa-searched">
          {COPY.whatWeRead.searched(industryPhrase(report.ai.research.industryId, report.ai.research.label))}
        </p>
      )}
    </Collapsible>
  );
};

export type FooterFeatures = Pick<Features, 'share' | 'shareRetentionDays'> & Partial<Pick<Features, 'email'>>;

/**
 * The privacy line: the saved-report wording when sharing is on, else "We don't save reports…".
 * The Resend sentence is added only when report email is on (which needs sharing).
 */
export const privacyText = (features?: FooterFeatures | null): string => {
  if (!features?.share) return COPY.footer.privacy;
  const base = COPY.footer.privacyShare(features.shareRetentionDays);
  return features.email ? `${base} ${COPY.footer.privacyEmail}` : base;
};

/** Disclaimers, privacy line and data attributions at the foot of the report. */
export const ReportFooter = ({ report, features }: { report: AuditReport; features?: FooterFeatures | null }) => (
  <footer class="oa-report-foot">
    <p>{COPY.footer.disclaimer}</p>
    <p>{privacyText(features)}</p>
    {report.attributions.length > 0 && (
      <p>
        {COPY.attributionsHeading}: {report.attributions.join('; ')}
      </p>
    )}
  </footer>
);
