import type { AuditReport } from '../../shared/types.js';
import { COPY } from '../content/copy.js';
import { resolveFixFirst } from '../lib/report.js';
import { ActionTags } from './ui.js';

/** Top 5 across buyer fit, security and health. Re-renders when the re-ranked list arrives. */
export const FixFirst = ({ report }: { report: AuditReport }) => {
  const rows = resolveFixFirst(report);
  return (
    <section class="oa-card oa-fixfirst">
      <h3 class="oa-card__title">{COPY.fixFirst.heading}</h3>
      <p class="oa-muted oa-card__intro">{COPY.fixFirst.intro}</p>
      {rows.length === 0 ? (
        <p>{COPY.fixFirst.empty}</p>
      ) : (
        <ol class="oa-fixfirst__list">
          {rows.map((r, i) => (
            <li key={r.key} class="oa-fixfirst__item">
              <span class="oa-fixfirst__num" aria-hidden="true">
                {i + 1}
              </span>
              <div class="oa-fixfirst__body">
                <span class="oa-fixfirst__section">{COPY.sectionLabels[r.section]}</span>
                <p class="oa-fixfirst__title">{r.title}</p>
                {r.detail && <p class="oa-fixfirst__detail">{r.detail}</p>}
                <ActionTags impact={r.impact} effort={r.effort} owner={r.owner} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
};
