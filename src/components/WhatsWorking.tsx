import type { AuditReport } from '../../shared/types.js';
import { COPY } from '../content/copy.js';
import { hasBuyerFit } from '../lib/report.js';
import { Skeleton } from './ui.js';

export const WhatsWorking = ({ report }: { report: AuditReport }) => {
  if (report.buyerFitStatus === 'pending') {
    return (
      <section class="oa-card oa-working">
        <h3 class="oa-card__title">{COPY.whatsWorking.heading}</h3>
        <Skeleton lines={3} text={COPY.report.pending} />
      </section>
    );
  }
  if (!hasBuyerFit(report) || !report.buyerFit) return null;
  const strengths = report.buyerFit.strengths;
  return (
    <section class="oa-card oa-working">
      <h3 class="oa-card__title">{COPY.whatsWorking.heading}</h3>
      {strengths.length ? (
        <ul class="oa-working__list">
          {strengths.map((s, i) => (
            <li key={i}>
              <span class="oa-working__tick" aria-hidden="true">
                ✓
              </span>
              {s}
            </li>
          ))}
        </ul>
      ) : (
        <p class="oa-muted">{COPY.whatsWorking.empty}</p>
      )}
    </section>
  );
};
