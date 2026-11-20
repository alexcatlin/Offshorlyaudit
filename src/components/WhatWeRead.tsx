import type { AuditReport } from '../../shared/types.js';
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
    </Collapsible>
  );
};

/** Disclaimers, privacy line and data attributions at the foot of the report. */
export const ReportFooter = ({ report }: { report: AuditReport }) => (
  <footer class="oa-report-foot">
    <p>{COPY.footer.disclaimer}</p>
    <p>{COPY.footer.privacy}</p>
    {report.attributions.length > 0 && (
      <p>
        {COPY.attributionsHeading}: {report.attributions.join('; ')}
      </p>
    )}
  </footer>
);
