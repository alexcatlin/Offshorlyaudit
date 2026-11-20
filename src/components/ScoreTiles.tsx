import type { AuditReport, Section } from '../../shared/types.js';
import { COPY } from '../content/copy.js';
import { sectionSummary } from '../lib/report.js';
import { ScoreRing } from './ui.js';

const Tile = ({ title, section }: { title: string; section: Section }) => {
  const s = sectionSummary(section.checks);
  const counts = COPY.tiles.summary(s.fix, s.improve);
  return (
    <div class="oa-tile">
      <ScoreRing score={section.score} label={title} />
      <div class="oa-tile__text">
        <h3 class="oa-tile__title">{title}</h3>
        {section.score === null && <p class="oa-muted">{COPY.health.notScored}</p>}
        {counts ? (
          <p class="oa-tile__summary">
            {counts}.{' '}
            {s.startWith && (
              <>
                {COPY.tiles.startWith} <strong>{s.startWith}</strong>
              </>
            )}
          </p>
        ) : (
          <p class="oa-tile__summary">{COPY.tiles.allClear}</p>
        )}
      </div>
    </div>
  );
};

export const ScoreTiles = ({ report }: { report: AuditReport }) => (
  <div class="oa-tiles">
    <Tile title={COPY.security.heading} section={report.security} />
    <Tile title={COPY.health.heading} section={report.health} />
  </div>
);
