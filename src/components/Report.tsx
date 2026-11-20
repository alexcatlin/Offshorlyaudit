import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AuditReport, AuditRequest, Features } from '../../shared/types.js';
import { COPY } from '../content/copy.js';
import { aiCount, formatDate, hasBuyerFit } from '../lib/report.js';
import { nextTabIndex } from '../lib/tabs.js';
import { AiOpportunities } from './AiOpportunities.js';
import { BuyerFitDetail } from './BuyerFitDetail.js';
import { ForceOpenContext } from './Collapsible.js';
import { ContextBar } from './ContextBar.js';
import { Cta } from './Cta.js';
import type { Vote, VoteHandler } from './FeedbackButtons.js';
import { FixFirst } from './FixFirst.js';
import { FixtureBanner } from './FixtureBanner.js';
import { HealthSection, SecuritySection } from './MeasuredSections.js';
import { ScoreTiles } from './ScoreTiles.js';
import { VerdictCard } from './VerdictCard.js';
import { WhatWeRead, ReportFooter } from './WhatWeRead.js';
import { WhatsWorking } from './WhatsWorking.js';
import { Spinner } from './ui.js';

const TABS = ['website', 'ai'] as const;
type Tab = (typeof TABS)[number];

/**
 * live: the visitor's own report (tabs, actions, feedback, restart).
 * shared: a saved snapshot at /r/:id (tabs, Save as PDF only; no feedback or restart).
 * print: both panels in sequence, every section open, no tabs, feedback or restart (Amendment 5
 *   Phase 1). Actions stay mounted (hidden by print CSS) so in-place printing keeps their state.
 */
export type ReportMode = 'live' | 'shared' | 'print';

interface Props {
  report: AuditReport;
  request: AuditRequest;
  mode?: ReportMode;
  onRestart?: () => void;
  initialTab?: Tab;
  /** The actions row (ReportActions) under the ContextBar; kept mounted in print mode, hidden by print CSS. */
  actions?: ComponentChildren;
  /** Above the header (e.g. the shared-report banner). */
  banner?: ComponentChildren;
  /** Live mode only: Useful / Not useful on each idea. */
  onVote?: VoteHandler;
  /** Accepted votes by idea index, so the buttons keep their pressed state across in-place print. */
  votes?: Readonly<Record<number, Vote>>;
  /** Footer privacy copy switches on `share` (and `email`). */
  features?: Pick<Features, 'share' | 'shareRetentionDays'> & Partial<Pick<Features, 'email'>> | null;
}

const WebsitePanel = ({ report }: { report: AuditReport }) => {
  const bfPending = report.buyerFitStatus === 'pending';
  const showBuyerFitBlocks = bfPending || hasBuyerFit(report);
  return (
    <>
      <VerdictCard report={report} />
      <ScoreTiles report={report} />
      <div class={showBuyerFitBlocks ? 'oa-split' : 'oa-split oa-split--single'}>
        <WhatsWorking report={report} />
        <FixFirst report={report} />
      </div>
      <Cta variant="website" />
      <h3 class="oa-detail-heading">{COPY.detail.heading}</h3>
      <div class="oa-details">
        <BuyerFitDetail pending={bfPending} buyerFit={hasBuyerFit(report) ? report.buyerFit : undefined} />
        <SecuritySection report={report} />
        <HealthSection report={report} />
        <WhatWeRead report={report} />
      </div>
    </>
  );
};

export const Report = ({ report, request, mode = 'live', onRestart, initialTab = 'website', actions, banner, onVote, votes, features }: Props) => {
  const [tab, setTab] = useState<Tab>(initialTab);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const print = mode === 'print';

  // Focus the report heading once, when the report first renders (not on later updates).
  useEffect(() => {
    if (!print) headingRef.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    const current = TABS.indexOf(tab);
    const next = nextTabIndex(e.key, current, TABS.length);
    if (next === null) return;
    e.preventDefault();
    const nextTab = TABS[next] ?? 'website';
    setTab(nextTab);
    tabRefs.current[next]?.focus();
  };

  const count = aiCount(report);
  const voteHandler = mode === 'live' ? onVote : undefined;

  // One tree for every mode: the header (and the actions in it) keeps its place when in-place
  // printing flips mode to 'print', so ReportActions keeps its state (e.g. a shown share link).
  // Print CSS hides .oa-actions; the /print window passes no actions at all.
  return (
    <ForceOpenContext.Provider value={print}>
      <article class={print ? 'oa-report oa-report--print' : 'oa-report'}>
        {report.fixture && <FixtureBanner />}
        {banner}
        <header class="oa-report__header">
          {print ? (
            <h1 class="oa-report__title oa-print-header">{COPY.print.header(report.domain, formatDate(report.auditedAt))}</h1>
          ) : (
            <h2 class="oa-report__title" tabIndex={-1} ref={headingRef}>
              {COPY.report.heading(report.domain)}
            </h2>
          )}
          <ContextBar report={report} />
          {actions}
        </header>

        {print ? (
          <>
            <section class="oa-print-section">
              <h2 class="oa-print-section__heading">{COPY.print.websiteHeading}</h2>
              <WebsitePanel report={report} />
            </section>
            <section class="oa-print-section">
              <h2 class="oa-print-section__heading">{COPY.print.aiHeading}</h2>
              <AiOpportunities report={report} request={request} />
            </section>
          </>
        ) : (
          <>
            <div class="oa-tabs" role="tablist" aria-label={COPY.report.tabsLabel} onKeyDown={onKeyDown}>
              {TABS.map((t, i) => {
                const selected = tab === t;
                return (
                  <button
                    key={t}
                    ref={(el) => {
                      tabRefs.current[i] = el;
                    }}
                    type="button"
                    role="tab"
                    id={`oa-tab-${t}`}
                    class={selected ? 'oa-tab is-selected' : 'oa-tab'}
                    aria-selected={selected}
                    aria-controls={`oa-panel-${t}`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setTab(t)}
                  >
                    {t === 'website' ? COPY.report.tabWebsite : COPY.report.tabAi}
                    {t === 'ai' && report.aiStatus === 'pending' && (
                      <span class="oa-tab__status">
                        <Spinner small label={COPY.report.tabAiPending} />
                      </span>
                    )}
                    {t === 'ai' && count !== null && count > 0 && (
                      <span class="oa-tab__badge" aria-label={COPY.report.tabAiCount(count)}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div
              id="oa-panel-website"
              role="tabpanel"
              aria-labelledby="oa-tab-website"
              class="oa-panel"
              hidden={tab !== 'website'}
              tabIndex={0}
            >
              <WebsitePanel report={report} />
            </div>

            <div id="oa-panel-ai" role="tabpanel" aria-labelledby="oa-tab-ai" class="oa-panel" hidden={tab !== 'ai'} tabIndex={0}>
              <AiOpportunities report={report} request={request} onVote={voteHandler} votes={votes} />
            </div>
          </>
        )}

        <ReportFooter report={report} features={features} />
        {mode === 'live' && onRestart && (
          <p class="oa-restart">
            <button type="button" class="oa-button oa-button--outline" onClick={onRestart}>
              {COPY.footer.newAudit}
            </button>
          </p>
        )}
      </article>
    </ForceOpenContext.Provider>
  );
};
