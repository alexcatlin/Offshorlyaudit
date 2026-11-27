// /r/:shareId (Amendment 5 Phase 3): a saved report, read-only. Tabs work; the actions row
// has Save as PDF only (prints in place); no feedback, no restart. A 404 shows the expired page.
import { useEffect, useState } from 'preact/hooks';
import { CTA, OFFSHORLY_ORIGIN } from '../../shared/services.js';
import type { AuditReport, AuditRequest, SharedReport } from '../../shared/types.js';
import { AuditError, fetchShared, setTrackContext, track } from '../api.js';
import { Report } from '../components/Report.js';
import { ReportActions } from '../components/ReportActions.js';
import { COPY } from '../content/copy.js';
import { formatDate } from '../lib/report.js';
import { usePrintInPlace } from '../lib/usePrintInPlace.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The report and request a shared snapshot renders with (auditId is gone; the answers stand in for the request). */
export const sharedView = (s: SharedReport): { report: AuditReport; request: AuditRequest; days: number } => {
  const days = Math.max(1, Math.round((Date.parse(s.expiresAt) - Date.parse(s.createdAt)) / DAY_MS) || 1);
  return { report: { ...s.report, auditId: '' }, request: { url: s.report.url, ...s.answers }, days };
};

export const SharedBanner = ({ shared }: { shared: SharedReport }) => {
  const created = formatDate(shared.createdAt);
  return (
    <div class="oa-shared-banner" role="note">
      <p class="oa-shared-banner__line">{COPY.shared.banner(shared.report.domain, created, formatDate(shared.expiresAt))}</p>
      <p class="oa-shared-banner__disclaimer">{COPY.shared.disclaimer(shared.report.domain, formatDate(shared.report.auditedAt))}</p>
      <a class="oa-button oa-button--primary oa-button--small" href={CTA.auditPage.url} onClick={() => track('cta_click', 'audit-link')}>
        {COPY.shared.cta}
      </a>
    </div>
  );
};

type State = { kind: 'loading' } | { kind: 'expired' } | { kind: 'error'; message: string } | { kind: 'ready'; shared: SharedReport };

/** The view for a loaded state; exported for render tests. */
export const SharedView = ({ shared, printing = false, onPdf }: { shared: SharedReport; printing?: boolean; onPdf: () => void }) => {
  const { report, request, days } = sharedView(shared);
  return (
    <Report
      report={report}
      request={request}
      mode={printing ? 'print' : 'shared'}
      banner={<SharedBanner shared={shared} />}
      features={{ share: true, shareRetentionDays: days }}
      actions={<ReportActions report={report} mode="shared" onPdf={onPdf} />}
    />
  );
};

export const SharedApp = ({ shareId }: { shareId: string }) => {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [printing, startPrint] = usePrintInPlace();

  // The booking cards inside the report count as shared-page clicks.
  useEffect(() => {
    setTrackContext({ shared: true });
    return () => setTrackContext(null);
  }, []);

  useEffect(() => {
    fetchShared(shareId).then(
      (shared) => setState({ kind: 'ready', shared }),
      (e: unknown) => {
        if (e instanceof AuditError && e.code === 'not_found') setState({ kind: 'expired' });
        else setState({ kind: 'error', message: e instanceof AuditError ? e.message : COPY.errors.network });
      },
    );
  }, [shareId]);

  return (
    <div class="oa-app oa-app--shared">
      {!printing && (
        <header class="oa-site-header">
          <a class="oa-site-header__brand" href={OFFSHORLY_ORIGIN} target="_blank" rel="noopener noreferrer">
            <img src="/offshorly-icon.png" width="32" height="32" alt="" />
            <span>Offshorly</span>
            <span class="oa-visually-hidden"> (opens in a new tab)</span>
          </a>
          <span class="oa-site-header__tag">Website and AI audit</span>
        </header>
      )}
      <main class="oa-main">
        {state.kind === 'loading' && <p class="oa-muted">{COPY.shared.loading}</p>}
        {state.kind === 'ready' && <SharedView shared={state.shared} printing={printing} onPdf={startPrint} />}
        {(state.kind === 'expired' || state.kind === 'error') && (
          <section class="oa-card oa-shared-expired">
            <p>{state.kind === 'expired' ? COPY.shared.expired : state.message}</p>
            <a class="oa-button oa-button--primary" href={CTA.auditPage.url} onClick={() => track('cta_click', 'audit-link')}>
              {COPY.shared.cta}
            </a>
          </section>
        )}
      </main>
    </div>
  );
};
