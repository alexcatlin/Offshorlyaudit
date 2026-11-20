import type { AiOpportunity, AuditReport, AuditRequest, Basis } from '../../shared/types.js';
import { CONFIDENCE_LABELS, COPY, CUSTOMERS_LABELS, EFFICIENCY_LABELS, TEAM_SIZE_OPTIONS } from '../content/copy.js';
import { Cta } from './Cta.js';
import { ExternalLink, Skeleton } from './ui.js';

const A = COPY.ai;

const BasisItem = ({ b, request }: { b: Basis; request: AuditRequest }) => {
  if (b.kind === 'quote') {
    return (
      <li class="oa-basis oa-basis--quote">
        <span class="oa-basis__kind">{A.basisQuote}</span>
        <blockquote class="oa-basis__quote">“{b.quote}”</blockquote>
        <ExternalLink class="oa-basis__link" href={b.pageUrl}>
          {COPY.buyerFit.viewPage(b.pageLabel)}
        </ExternalLink>
      </li>
    );
  }
  if (b.kind === 'answer') {
    const text =
      b.field === 'timeSink'
        ? request.timeSink
        : request.teamSize
          ? A.basisTeamSize(TEAM_SIZE_OPTIONS.find((o) => o.value === request.teamSize)?.label ?? request.teamSize)
          : undefined;
    return (
      <li class="oa-basis oa-basis--answer">
        <span class="oa-basis__kind">{A.basisToldUs}</span>
        {text && <span class="oa-basis__text">{b.field === 'timeSink' ? `“${text}”` : text}</span>}
      </li>
    );
  }
  return (
    <li class="oa-basis oa-basis--stack">
      <span class="oa-basis__kind">{A.basisStack}</span>
      <span class="oa-basis__text">{A.basisDetected(b.name)}</span>
    </li>
  );
};

const Opportunity = ({ o, request }: { o: AiOpportunity; request: AuditRequest }) => (
  <li class="oa-opp">
    <div class="oa-opp__head">
      <h4 class="oa-opp__title">{o.title}</h4>
      <span class={`oa-pill oa-pill--confidence-${o.confidence}`}>
        <span class="oa-visually-hidden">{A.confidenceLabel}: </span>
        {CONFIDENCE_LABELS[o.confidence]}
      </span>
    </div>
    <dl class="oa-opp__grid">
      <div class="oa-opp__row">
        <dt>{A.processLabel}</dt>
        <dd>{o.process}</dd>
      </div>
      <div class="oa-opp__row">
        <dt>{A.whyWeThinkSo}</dt>
        <dd>
          <ul class="oa-basis-list">
            {o.basis.map((b, i) => (
              <BasisItem key={i} b={b} request={request} />
            ))}
          </ul>
        </dd>
      </div>
      <div class="oa-opp__row">
        <dt>{A.howAiCouldHelp}</dt>
        <dd>{o.aiApproach}</dd>
      </div>
      <div class="oa-opp__row oa-opp__row--split">
        <div>
          <dt>{A.likelyBenefit}</dt>
          <dd>
            <span class="oa-benefit">{EFFICIENCY_LABELS[o.efficiency]}</span>
          </dd>
        </div>
        <div>
          <dt>{A.measureFirst}</dt>
          <dd>{o.measureFirst}</dd>
        </div>
      </div>
    </dl>
    {o.proof && (
      <div class="oa-proof">
        <p class="oa-proof__label">{A.proofLabel}</p>
        <p class="oa-proof__text">{o.proof.text}</p>
        <ExternalLink class="oa-proof__link" href={o.proof.url}>
          {A.proofLink}
        </ExternalLink>
      </div>
    )}
    <p class="oa-opp__service">
      <span class="oa-opp__service-label">{A.suggestedService}:</span>{' '}
      <ExternalLink href={o.service.url}>{A.serviceLink(o.service.name)} →</ExternalLink>
    </p>
  </li>
);

const Pitch = ({ heading, text }: { heading: string; text: string }) => (
  <section class="oa-card oa-pitch">
    <h3 class="oa-card__title">{heading}</h3>
    <p>{text}</p>
  </section>
);

export const AiOpportunities = ({ report, request }: { report: AuditReport; request: AuditRequest }) => {
  const status = report.aiStatus;

  if (status === 'pending') {
    return (
      <div class="oa-ai">
        <p class="oa-ai__intro">{A.intro}</p>
        <section class="oa-card">
          <Skeleton lines={5} text={COPY.report.pending} />
          <p class="oa-muted oa-small">{COPY.report.pendingDetail}</p>
        </section>
        <Cta variant="ai" />
      </div>
    );
  }

  const ai = (status === 'ok' || status === 'fixture') && report.ai ? report.ai : null;

  if (!ai || ai.opportunities.length === 0) {
    let pitch: { heading: string; text: string } = { heading: A.pitchHeading, text: A.pitchText };
    if (status === 'thin') pitch = { heading: A.thinHeading, text: A.thinTab };
    else if (status === 'insufficient' || (ai && ai.opportunities.length === 0)) pitch = { heading: A.pitchHeading, text: A.insufficient };
    else if (status === 'unavailable') pitch = { heading: A.pitchHeading, text: `${A.unavailableTab} ${A.pitchText}` };
    return (
      <div class="oa-ai">
        <Pitch heading={pitch.heading} text={pitch.text} />
        <Cta variant="pitch" />
      </div>
    );
  }

  const customers = CUSTOMERS_LABELS[ai.business.customers];
  return (
    <div class="oa-ai">
      <p class="oa-ai__intro">{A.intro}</p>
      <section class="oa-card oa-business">
        <h3 class="oa-eyebrow">{A.businessHeading}</h3>
        <p class="oa-business__summary">{ai.business.summary}</p>
        {customers && <span class="oa-badge">{customers}</span>}
      </section>

      <h3 class="oa-ai__heading">{A.ideasHeading(ai.opportunities.length)}</h3>
      <ol class="oa-opps">
        {ai.opportunities.map((o, i) => (
          <Opportunity key={i} o={o} request={request} />
        ))}
      </ol>

      <section class="oa-card oa-notworth">
        <h3 class="oa-card__title">{A.notWorthItHeading}</h3>
        <p>{ai.notWorthIt}</p>
      </section>

      <Cta variant="ai" />
    </div>
  );
};
