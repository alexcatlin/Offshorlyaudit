import { scoreBand } from '../../shared/reportLogic.js';
import type { AuditReport } from '../../shared/types.js';
import { COPY } from '../content/copy.js';
import { hasBuyerFit } from '../lib/report.js';
import { Skeleton } from './ui.js';

/** Dark verdict card. Skeleton while pending; nothing when buyer fit is unavailable. */
export const VerdictCard = ({ report }: { report: AuditReport }) => {
  if (report.buyerFitStatus === 'pending') {
    return (
      <section class="oa-verdict oa-verdict--pending" aria-label={COPY.verdict.scoreLabel}>
        <div class="oa-verdict__score">
          <span class="oa-verdict__eyebrow">{COPY.verdict.scoreLabel}</span>
          <span class="oa-verdict__placeholder" aria-hidden="true" />
        </div>
        <div class="oa-verdict__body">
          <Skeleton dark lines={4} text={COPY.report.pending} />
        </div>
      </section>
    );
  }
  if (!hasBuyerFit(report) || !report.buyerFit) return null;
  const bf = report.buyerFit;
  const band = scoreBand(bf.score);
  return (
    <section class="oa-verdict" aria-label={COPY.verdict.scoreLabel}>
      <div class="oa-verdict__score">
        <span class="oa-verdict__eyebrow">{COPY.verdict.scoreLabel}</span>
        <p class="oa-verdict__number">
          <span class="oa-gradient-text">{bf.score ?? '–'}</span>
          <span class="oa-verdict__outof">{bf.score === null ? '' : COPY.verdict.outOf}</span>
        </p>
        {band && <p class={`oa-verdict__band oa-verdict__band--${band.id}`}>{band.text}</p>}
      </div>
      <div class="oa-verdict__body">
        <h3 class="oa-verdict__label">{COPY.verdict.oneSentence}</h3>
        <p class="oa-verdict__summary">{bf.verdict.summary}</p>
        <h3 class="oa-verdict__label">{COPY.verdict.brutalTruth}</h3>
        <p class="oa-verdict__truth">{bf.verdict.brutalTruth}</p>
      </div>
    </section>
  );
};
