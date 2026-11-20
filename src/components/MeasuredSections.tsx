import { serviceUrl } from '../../shared/services.js';
import type { AuditReport } from '../../shared/types.js';
import { COPY } from '../content/copy.js';
import { hasOmittedChecks, sectionSummary } from '../lib/report.js';
import { CheckList } from './CheckList.js';
import { Collapsible } from './Collapsible.js';
import { WpPanel } from './WpPanel.js';
import { ExternalLink } from './ui.js';

const summaryLine = (checks: AuditReport['security']['checks']): string => {
  const s = sectionSummary(checks);
  const counts = COPY.tiles.summary(s.fix, s.improve);
  if (!counts) return COPY.tiles.allClear;
  return s.startWith ? `${counts}. ${COPY.tiles.startWith} ${s.startWith}` : counts;
};

const HelpLink = ({ path }: { path: string }) => (
  <p class="oa-helplink">
    <ExternalLink href={path}>{COPY.offshorlyCanHelp} →</ExternalLink>
  </p>
);

export const SecuritySection = ({ report }: { report: AuditReport }) => {
  const wp = report.cms.platform === 'wordpress' ? report.cms.wordpress : undefined;
  return (
    <Collapsible title={COPY.security.heading} score={report.security.score} summary={summaryLine(report.security.checks)}>
      <p class="oa-section-intro">{COPY.security.intro}</p>
      {wp && <WpPanel wp={wp} />}
      <CheckList checks={report.security.checks} />
      {hasOmittedChecks(report, 'security') && <p class="oa-muted oa-omitted">{COPY.omittedChecks}</p>}
      <HelpLink path={serviceUrl(wp ? 'wordpress' : 'websites')} />
    </Collapsible>
  );
};

export const HealthSection = ({ report }: { report: AuditReport }) => (
  <Collapsible title={COPY.health.heading} score={report.health.score} summary={summaryLine(report.health.checks)}>
    <p class="oa-section-intro">
      {COPY.health.intro} {report.health.measuredByGoogle ? COPY.health.googleSpeedNote : COPY.health.noGoogleSpeedNote}
    </p>
    <CheckList checks={report.health.checks} />
    {hasOmittedChecks(report, 'health') && <p class="oa-muted oa-omitted">{COPY.omittedChecks}</p>}
    <HelpLink path={serviceUrl('website-redesign')} />
  </Collapsible>
);
