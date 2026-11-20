import { gaugeColour } from '../../shared/reportLogic.js';
import type { ActionItem, BuyerFit, EvidenceQuote, ScoredCriterion } from '../../shared/types.js';
import { COPY } from '../content/copy.js';
import { sortCriteria, weakestCriterion } from '../lib/report.js';
import { Collapsible } from './Collapsible.js';
import { ActionTags, ExternalLink } from './ui.js';

const B = COPY.buyerFit;

export const Quote = ({ q }: { q: EvidenceQuote }) => (
  <figure class={`oa-quote oa-quote--${q.effect ?? 'neutral'}`}>
    {q.effect && (
      <figcaption class="oa-quote__label">
        {q.effect === 'for' ? COPY.firstImpression.workingFor : COPY.firstImpression.workingAgainst}
      </figcaption>
    )}
    <blockquote class="oa-quote__text">“{q.quote}”</blockquote>
    {q.note && <p class="oa-quote__note">{q.note}</p>}
    <p class="oa-quote__source">
      <ExternalLink href={q.pageUrl}>{B.viewPage(q.pageLabel)}</ExternalLink>
    </p>
  </figure>
);

const Gauge = ({ score }: { score: number }) => (
  <span class={`oa-gauge oa-gauge--${gaugeColour(score)}`} role="img" aria-label={B.outOfTen(score)}>
    <span class="oa-gauge__value" aria-hidden="true">
      {score}
      <span class="oa-gauge__of">/10</span>
    </span>
    <span class="oa-gauge__track" aria-hidden="true">
      <span class="oa-gauge__fill" style={{ width: `${Math.max(0, Math.min(10, score)) * 10}%` }} />
    </span>
  </span>
);

const Criterion = ({ c }: { c: ScoredCriterion }) => (
  <li class="oa-criterion">
    <div class="oa-criterion__head">
      <Gauge score={c.score} />
      <span class="oa-criterion__name">{c.name}</span>
      <span class={`oa-weight oa-weight--${c.weight}`}>{B.weight[c.weight]}</span>
    </div>
    <p class="oa-criterion__reasoning">{c.reasoning}</p>
    {c.evidence && c.evidence.length > 0 && (
      <div class="oa-criterion__quotes">
        {c.evidence.map((q, i) => (
          <Quote key={i} q={q} />
        ))}
      </div>
    )}
  </li>
);

const ActionList = ({ items }: { items: ActionItem[] }) => (
  <ul class="oa-actions">
    {items.map((a, i) => (
      <li key={i} class="oa-action">
        <p class="oa-action__text">{a.text}</p>
        <ActionTags impact={a.impact} effort={a.effort} owner={a.owner} />
      </li>
    ))}
  </ul>
);

/** The three buyer-fit detail sections. Pending → placeholder headers; unavailable → nothing. */
export const BuyerFitDetail = ({ buyerFit, pending }: { buyerFit?: BuyerFit; pending: boolean }) => {
  if (pending) {
    return (
      <>
        <Collapsible title={B.heading} pending />
        <Collapsible title={B.mismatchHeading} pending />
        <Collapsible title={B.actionsHeading} pending />
      </>
    );
  }
  if (!buyerFit) return null;
  const weakest = weakestCriterion(buyerFit.criteria);
  const now = buyerFit.actions.filter((a) => a.horizon === 'now');
  const later = buyerFit.actions.filter((a) => a.horizon !== 'now');
  return (
    <>
      {buyerFit.criteria.length > 0 && (
        <Collapsible
          title={B.heading}
          score={buyerFit.score}
          summary={weakest ? B.summary(buyerFit.criteria.length, weakest.name, weakest.score) : undefined}
        >
          <p class="oa-section-intro">{B.intro}</p>
          <ul class="oa-criteria">
            {sortCriteria(buyerFit.criteria).map((c, i) => (
              <Criterion key={i} c={c} />
            ))}
          </ul>
        </Collapsible>
      )}
      {buyerFit.mismatchIndex.length > 0 && (
        <Collapsible title={B.mismatchHeading} summary={B.mismatchSummary(buyerFit.mismatchIndex.length)}>
          <ul class="oa-mismatch">
            {buyerFit.mismatchIndex.map((m, i) => (
              <li key={i}>
                <p class="oa-mismatch__point">{m.point}</p>
                <p>{m.explanation}</p>
              </li>
            ))}
          </ul>
        </Collapsible>
      )}
      {buyerFit.actions.length > 0 && (
        <Collapsible title={B.actionsHeading} summary={B.actionsSummary(now.length, later.length)}>
          {now.length > 0 && (
            <>
              <h4 class="oa-subheading">{B.doNow}</h4>
              <ActionList items={now} />
            </>
          )}
          {later.length > 0 && (
            <>
              <h4 class="oa-subheading">{B.longerTerm}</h4>
              <ActionList items={later} />
            </>
          )}
        </Collapsible>
      )}
    </>
  );
};
