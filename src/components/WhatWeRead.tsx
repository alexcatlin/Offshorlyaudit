import { industryPhrase } from '../../shared/industries.js';
import { CTA } from '../../shared/services.js';
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
 * The folded "How we handle your data" list as [label, text] rows: saved reports (the sharing-on
 * wording, else "We don't save reports…"), idea ratings, usage counts, the Resend row only when
 * report email is on (which needs sharing), and the data sources when there are any.
 */
export const footerItems = (features?: FooterFeatures | null, attributions: readonly string[] = []): [string, string][] => {
  const F = COPY.footer;
  return [
    [F.savedLabel, features?.share ? F.savedOn(features.shareRetentionDays) : F.savedOff],
    [F.ratingsLabel, F.ratings],
    [F.countsLabel, F.counts],
    ...(features?.share && features.email ? [[F.emailLabel, F.privacyEmail] as [string, string]] : []),
    ...(attributions.length ? [[F.sourcesLabel, `${attributions.join('; ')}.`] as [string, string]] : []),
  ];
};

/**
 * "About this report": three visible lines, then the rest in a native <details> that renders
 * open in print (`open`), so a PDF keeps every statement.
 */
export const ReportFooter = ({ report, features, open = false }: { report: AuditReport; features?: FooterFeatures | null; open?: boolean }) => (
  <footer class="oa-report-foot">
    <h3 class="oa-report-foot__heading">{COPY.footer.heading}</h3>
    <p>{COPY.footer.disclaimer}</p>
    <p>{COPY.footer.ai}</p>
    <p>
      {COPY.footer.crm} <ExternalLink href={CTA.privacy.url}>{COPY.form.privacyLinkLabel}</ExternalLink>
    </p>
    <details class="oa-report-foot__more" open={open}>
      <summary>{COPY.footer.more}</summary>
      <dl class="oa-report-foot__list">
        {footerItems(features, report.attributions).map(([label, text]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </details>
  </footer>
);
