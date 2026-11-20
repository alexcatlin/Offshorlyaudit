import { useEffect, useRef, useState } from 'preact/hooks';
import type { AuditReport, AuditRequest } from '../../shared/types.js';
import { COPY } from '../content/copy.js';
import { aiCount, hasBuyerFit } from '../lib/report.js';
import { nextTabIndex } from '../lib/tabs.js';
import { AiOpportunities } from './AiOpportunities.js';
import { BuyerFitDetail } from './BuyerFitDetail.js';
import { ContextBar } from './ContextBar.js';
import { Cta } from './Cta.js';
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

interface Props {
  report: AuditReport;
  request: AuditRequest;
  onRestart: () => void;
  initialTab?: Tab;
}

export const Report = ({ report, request, onRestart, initialTab = 'website' }: Props) => {
  const [tab, setTab] = useState<Tab>(initialTab);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Focus the report heading once, when the report first renders (not on later updates).
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
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
  const bfPending = report.buyerFitStatus === 'pending';
  const showBuyerFitBlocks = bfPending || hasBuyerFit(report);

  return (
    <article class="oa-report">
      {report.fixture && <FixtureBanner />}
      <header class="oa-report__header">
        <h2 class="oa-report__title" tabIndex={-1} ref={headingRef}>
          {COPY.report.heading(report.domain)}
        </h2>
        <ContextBar report={report} />
      </header>

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
      </div>

      <div id="oa-panel-ai" role="tabpanel" aria-labelledby="oa-tab-ai" class="oa-panel" hidden={tab !== 'ai'} tabIndex={0}>
        <AiOpportunities report={report} request={request} />
      </div>

      <ReportFooter report={report} />
      <p class="oa-restart">
        <button type="button" class="oa-button oa-button--outline" onClick={onRestart}>
          {COPY.footer.newAudit}
        </button>
      </p>
    </article>
  );
};
