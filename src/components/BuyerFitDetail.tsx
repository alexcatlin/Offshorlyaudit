import { gaugeColour } from '../../shared/reportLogic.js';
import type { ActionItem, BuyerFit, EvidenceQuote, ScoredCriterion } from '../../shared/types.js';
import { COPY, EFFORT_LABELS, IMPACT_LABELS, OWNER_LABELS } from '../content/copy.js';
import { sortCriteria, weakestCriterion } from '../lib/report.js';
import { Collapsible } from './Collapsible.js';
import { ExternalLink } from './ui.js';

const B = COPY.buyerFit;

/** Quote card: "✓ Working for you" / "✕ Working against you" and "See it on" in one row, the quote, then "Why:". */
export const Quote = ({ q }: { q: EvidenceQuote }) => (
  <figure class={`oa-quote oa-quote--${q.effect ?? 'neutral'}`}>
    <figcaption class="oa-quote__head">
      {q.effect && (
        <span class="oa-quote__label">
          <span class="oa-quote__mark" aria-hidden="true">
            {q.effect === 'for' ? '✓' : '✕'}{' '}
          </span>
          {q.effect === 'for' ? COPY.firstImpression.workingFor : COPY.firstImpression.workingAgainst}
        </span>
      )}
      <ExternalLink class="oa-quote__link" href={q.pageUrl}>
        {B.viewPage(q.pageLabel)}
      </ExternalLink>
    </figcaption>
    <blockquote class="oa-quote__text">“{q.quote}”</blockquote>
    {q.note && (
      <p class="oa-quote__note">
        {COPY.firstImpression.why} {q.note}
      </p>
    )}
  </figure>
);

/** "Puts customers off" first, then the rest in their order. */
const againstFirst = (quotes: readonly EvidenceQuote[]): EvidenceQuote[] =>
  [...quotes].sort((a, b) => Number(b.effect === 'against') - Number(a.effect === 'against'));

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
        {againstFirst(c.evidence).map((q, i) => (
          <Quote key={i} q={q} />
        ))}
      </div>
    )}
  </li>
);

/** "High impact · Some work · For marketing". */
export const actionMeta = (a: Pick<ActionItem, 'impact' | 'effort' | 'owner'>): string =>
  [IMPACT_LABELS[a.impact], EFFORT_LABELS[a.effort], OWNER_LABELS[a.owner]].join(' · ');

/** Numbered rows in the "Fix these first" style; `start` continues the numbering across groups. */
const ActionList = ({ items, start }: { items: ActionItem[]; start: number }) => (
  <ol class="oa-fixfirst__list oa-plan" start={start}>
    {items.map((a, i) => (
      <li key={i} class="oa-fixfirst__item">
        <span class="oa-fixfirst__num" aria-hidden="true">
          {start + i}
        </span>
        <div class="oa-fixfirst__body">
          <p class="oa-fixfirst__title">{a.text}</p>
          <p class="oa-plan__meta">{actionMeta(a)}</p>
        </div>
      </li>
    ))}
  </ol>
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
              <h4 class="oa-eyebrow oa-plan__group">{B.doNow(now.length)}</h4>
              <ActionList items={now} start={1} />
            </>
          )}
          {later.length > 0 && (
            <>
              <h4 class="oa-eyebrow oa-plan__group">{B.longerTerm(later.length)}</h4>
              <ActionList items={later} start={now.length + 1} />
            </>
          )}
        </Collapsible>
      )}
    </>
  );
};
