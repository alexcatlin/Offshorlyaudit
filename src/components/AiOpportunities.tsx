import { useEffect, useState } from 'preact/hooks';
import { industryPhrase, OTHER_INDUSTRY_FALLBACK_LABEL } from '../../shared/industries.js';
import type { AiOpportunity, AiSection, AuditReport, AuditRequest, Basis, ExampleSource, IndustryExample } from '../../shared/types.js';
import {
  AI_LOADING_STAGES,
  CONFIDENCE_LABELS,
  CONFIDENCE_MEANINGS,
  COPY,
  CUSTOMERS_LABELS,
  EFFICIENCY_LABELS,
  TEAM_SIZE_OPTIONS,
} from '../content/copy.js';
import { Cta } from './Cta.js';
import { formatDate } from '../lib/report.js';
import { FeedbackButtons, type Vote, type VoteHandler } from './FeedbackButtons.js';
import { ExternalLink, Skeleton } from './ui.js';

const A = COPY.ai;

/** "{title} ({domain})", or the domain alone when the server left the title out. */
export const sourceLabel = (s: ExampleSource): string => (s.title ? `${s.title} (${s.domain})` : s.domain);

const SourceLink = ({ s }: { s: ExampleSource }) => (
  <ExternalLink class="oa-source-link" href={s.url} thirdParty>
    {sourceLabel(s)}
  </ExternalLink>
);

const answerText = (field: 'timeSink' | 'tools' | 'teamSize', request: AuditRequest) => {
  if (field === 'timeSink') return request.timeSink && `“${request.timeSink}”`;
  if (field === 'tools') return request.tools && A.basisTools(request.tools);
  if (request.teamSize) {
    return A.basisTeamSize(TEAM_SIZE_OPTIONS.find((o) => o.value === request.teamSize)?.label ?? request.teamSize);
  }
  return undefined;
};

const BasisItem = ({ b, request }: { b: Basis; request: AuditRequest }) => {
  if (b.kind === 'quote') {
    return (
      <li class="oa-basis oa-basis--quote">
        <div class="oa-basis__head">
          <span class="oa-basis__kind">{A.basisQuote}</span>
          <ExternalLink class="oa-basis__link" href={b.pageUrl}>
            {COPY.buyerFit.viewPage(b.pageLabel)}
          </ExternalLink>
        </div>
        <blockquote class="oa-basis__quote">“{b.quote}”</blockquote>
      </li>
    );
  }
  if (b.kind === 'answer') {
    const text = answerText(b.field, request);
    return (
      <li class="oa-basis oa-basis--answer">
        <span class="oa-basis__kind">{A.basisToldUs}</span>
        {text && <span class="oa-basis__text">{text}</span>}
      </li>
    );
  }
  if (b.kind === 'industry') {
    return (
      <li class="oa-basis oa-basis--industry">
        <span class="oa-basis__kind">{A.basisIndustry(b.industryLabel === OTHER_INDUSTRY_FALLBACK_LABEL ? undefined : b.industryLabel || undefined)}</span>
        <span class="oa-basis__text">{b.text}</span>
      </li>
    );
  }
  if (b.kind === 'source') {
    return (
      <li class="oa-basis oa-basis--source">
        <span class="oa-basis__kind">{A.basisSource}</span>
        <span class="oa-basis__text">
          <SourceLink s={b} />
        </span>
      </li>
    );
  }
  if (b.kind === 'stack') {
    return (
      <li class="oa-basis oa-basis--stack">
        <span class="oa-basis__kind">{A.basisStack}</span>
        <span class="oa-basis__text">{A.basisDetected(b.name)}</span>
      </li>
    );
  }
  return null;
};

/** An idea and its index in `ai.opportunities` (the feedback route's ideaIndex). */
interface Indexed {
  o: AiOpportunity;
  index: number;
}

const Opportunity = ({
  o,
  index,
  request,
  onVote,
  vote,
}: {
  o: AiOpportunity;
  index: number;
  request: AuditRequest;
  onVote?: VoteHandler;
  vote?: Vote;
}) => (
  <li class={o.source === 'industry' ? 'oa-opp oa-opp--industry' : 'oa-opp'}>
    <div class="oa-opp__head">
      <h5 class="oa-opp__title">{o.title}</h5>
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
          <p class="oa-muted oa-small oa-confidence-note">{CONFIDENCE_MEANINGS[o.confidence]}</p>
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
      {o.industryContext && (
        <div class="oa-opp__row">
          <dt>{A.inYourIndustry}</dt>
          <dd>{o.industryContext}</dd>
        </div>
      )}
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
    {onVote && <FeedbackButtons index={index} onVote={onVote} initialVote={vote ?? null} />}
  </li>
);

const Group = ({
  heading,
  intro,
  items,
  request,
  modifier,
  onVote,
  votes,
}: {
  heading: string;
  intro?: string;
  items: Indexed[];
  request: AuditRequest;
  modifier: 'site' | 'industry';
  onVote?: VoteHandler;
  votes?: Readonly<Record<number, Vote>>;
}) =>
  items.length ? (
    <section class={`oa-opp-group oa-opp-group--${modifier}`}>
      <h4 class="oa-opp-group__heading">{heading}</h4>
      {intro && <p class="oa-opp-group__intro">{intro}</p>}
      <ol class="oa-opps">
        {items.map(({ o, index }) => (
          <Opportunity key={index} o={o} index={index} request={request} onVote={onVote} vote={votes?.[index]} />
        ))}
      </ol>
    </section>
  ) : null;

/**
 * Phase 5: "What others in {industry} are doing", from cited web-search results. Hidden with no
 * examples (and in older JSON, which has none).
 */
export const IndustryExamples = ({ examples, label, searchedAt }: { examples?: IndustryExample[]; label?: string; searchedAt?: string }) => {
  const items = (examples ?? []).filter((e) => e && typeof e.text === 'string' && e.text && Array.isArray(e.sources) && e.sources.length);
  if (!items.length) return null;
  return (
    <section class="oa-opp-group oa-examples">
      <h4 class="oa-opp-group__heading">{A.examplesHeading(label || undefined)}</h4>
      {searchedAt && <p class="oa-opp-group__intro">{A.examplesIntro(formatDate(searchedAt))}</p>}
      <ul class="oa-examples__list">
        {items.map((e, i) => (
          <li key={i} class="oa-example">
            <p class="oa-example__text">{e.text}</p>
            <p class="oa-example__sources">
              <span class="oa-example__label">{A.examplesSource}</span>{' '}
              {e.sources.map((s, j) => (
                <span key={s.domain}>
                  {j > 0 && '; '}
                  <SourceLink s={s} />
                </span>
              ))}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
};

const Pitch = ({ heading, text }: { heading: string; text: string }) => (
  <section class="oa-card oa-pitch">
    <h3 class="oa-card__title">{heading}</h3>
    <p>{text}</p>
  </section>
);

/** Pending state: staged messages, timer-driven like the main loading screen. */
const AiPending = () => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - started) / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  const stage = AI_LOADING_STAGES.reduce((acc, s, i) => (elapsed >= s.afterSec ? i : acc), 0);
  return (
    <section class="oa-card">
      <Skeleton lines={5} text={AI_LOADING_STAGES[stage]?.text ?? COPY.report.pending} />
      <p class="oa-muted oa-small">{COPY.report.pendingDetail}</p>
    </section>
  );
};

/** Industry badge text, e.g. "Legal · inferred from your site". None for the generic fallback. */
export const industryBadge = (industry: AiSection['industry']): string | null => {
  if (!industry?.label || industry.label === OTHER_INDUSTRY_FALLBACK_LABEL) return null;
  return industry.inferred ? `${industry.label} · ${A.industryBadgeInferred}` : industry.label;
};

/** `onVote` present = live mode: each idea gets Useful / Not useful. Absent in shared and print modes. */
export const AiOpportunities = ({
  report,
  request,
  onVote,
  votes,
}: {
  report: AuditReport;
  request: AuditRequest;
  onVote?: VoteHandler;
  votes?: Readonly<Record<number, Vote>>;
}) => {
  const status = report.aiStatus;

  if (status === 'pending') {
    return (
      <div class="oa-ai">
        <p class="oa-ai__intro">{A.intro}</p>
        <AiPending />
        <Cta variant="ai" />
      </div>
    );
  }

  const ai = (status === 'ok' || status === 'fixture') && report.ai ? report.ai : null;

  if (!ai || ai.opportunities.length === 0) {
    let pitch: { heading: string; text: string } = { heading: A.pitchHeading, text: A.pitchText };
    if (status === 'thin') pitch = { heading: A.thinHeading, text: A.thinTab };
    else if (status === 'insufficient' || ai?.opportunities.length === 0) pitch = { heading: A.pitchHeading, text: A.insufficient };
    else if (status === 'unavailable') pitch = { heading: A.pitchHeading, text: `${A.unavailableTab} ${A.pitchText}` };
    return (
      <div class="oa-ai">
        <Pitch heading={pitch.heading} text={pitch.text} />
        <Cta variant="pitch" />
      </div>
    );
  }

  const customers = CUSTOMERS_LABELS[ai.business.customers];
  const badge = industryBadge(ai.industry);
  // Older JSON has no `source`: those ideas are site ideas.
  const indexed: Indexed[] = ai.opportunities.map((o, index) => ({ o, index }));
  const siteIdeas = indexed.filter(({ o }) => o.source !== 'industry');
  const industryIdeas = indexed.filter(({ o }) => o.source === 'industry');
  // The generic fallback label is not an industry: the heading then names none.
  const rawLabel = ai.industry?.label ?? '';
  const industryLabel = rawLabel === OTHER_INDUSTRY_FALLBACK_LABEL ? '' : rawLabel;
  return (
    <div class="oa-ai">
      <p class="oa-ai__intro">{A.intro}</p>
      <section class="oa-card oa-business">
        <h3 class="oa-eyebrow">{A.businessHeading}</h3>
        <p class="oa-business__summary">{ai.business.summary}</p>
        {(badge || customers) && (
          <div class="oa-business__badges">
            {badge && <span class="oa-badge oa-badge--industry">{badge}</span>}
            {customers && <span class="oa-badge">{customers}</span>}
          </div>
        )}
      </section>

      <h3 class="oa-ai__heading">{A.ideasHeading(ai.opportunities.length)}</h3>
      <Group heading={A.siteGroupHeading} items={siteIdeas} request={request} modifier="site" onVote={onVote} votes={votes} />
      <Group
        heading={A.industryGroupHeading(industryLabel || undefined)}
        intro={A.industryGroupIntro}
        items={industryIdeas}
        request={request}
        modifier="industry"
        onVote={onVote}
        votes={votes}
      />
      <IndustryExamples
        examples={ai.industryExamples}
        label={ai.research ? industryPhrase(ai.research.industryId, ai.research.label) : industryPhrase(ai.industry?.id, industryLabel)}
        searchedAt={ai.research?.searchedAt}
      />

      <section class="oa-card oa-notworth">
        <h3 class="oa-card__title">{A.notWorthItHeading}</h3>
        <p>{ai.notWorthIt}</p>
      </section>

      <Cta variant="ai" />
    </div>
  );
};
