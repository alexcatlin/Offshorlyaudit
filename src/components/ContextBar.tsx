import type { AuditReport } from '../../shared/types.js';
import { COPY } from '../content/copy.js';
import { formatDate, hasBuyerFit } from '../lib/report.js';

/** While customer fit is pending the score card carries the "still reading" line, so this bar stays quiet. */
export const ContextBar = ({ report }: { report: AuditReport }) => {
  const bf = hasBuyerFit(report) ? report.buyerFit : undefined;
  const p = bf?.persona;
  return (
    <div class="oa-context">
      <p class="oa-context__meta">
        <span>{COPY.header.auditedOn(formatDate(report.auditedAt))}</span>
        {bf && (
          <span class="oa-badge">
            {bf.businessType}
            {bf.businessTypeInferred && <span class="oa-badge__note"> · {COPY.context.businessTypeInferred}</span>}
          </span>
        )}
      </p>
      {p && (
        <>
          <p class="oa-context__line">
            <span class="oa-context__label">{COPY.context.eyesOf}</span> {[p.role, p.size, p.sector].filter(Boolean).join(' · ')}
          </p>
          {p.trigger && (
            <p class="oa-context__line">
              <span class="oa-context__label">{COPY.context.whyLooking}</span> {p.trigger}
            </p>
          )}
          {bf.personaInferred && <p class="oa-context__inferred">{COPY.context.inferredBuyer}</p>}
        </>
      )}
      {report.buyerFitStatus === 'unavailable' && <p class="oa-context__note">{COPY.context.buyerFitUnavailable}</p>}
      {report.buyerFitStatus === 'thin' && <p class="oa-context__note">{COPY.context.buyerFitThin}</p>}
    </div>
  );
};
