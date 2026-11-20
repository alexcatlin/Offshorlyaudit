import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AuditReport, AuditRequest, ErrorCode, Features } from '../shared/types.js';
import { AuditError, fetchAi, fetchBuyerFit, sendFeedback, startAudit } from './api.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Form } from './components/Form.js';
import { Loading } from './components/Loading.js';
import type { Vote, VoteHandler } from './components/FeedbackButtons.js';
import { Report } from './components/Report.js';
import { ReportActions } from './components/ReportActions.js';
import { CTA, OFFSHORLY_ORIGIN } from '../shared/services.js';
import { COPY } from './content/copy.js';
import { postScrollTop } from './embed/resize.js';
import { buildRequest, EMPTY_FORM, normaliseUrlInput, type FormValues } from './lib/form.js';
import { markUnavailable, mergeAi, mergeBuyerFit } from './lib/report.js';
import { browserOpenerEnv, openPrintWindow } from './lib/printBridge.js';
import { captureScrollAnchor } from './lib/scrollAnchor.js';
import { usePrintInPlace } from './lib/usePrintInPlace.js';

type State =
  | { phase: 'form'; error: string | null; errorCode: ErrorCode | 'network' | null }
  | { phase: 'loading'; domain: string }
  /** `session` and `features` sit beside the report, never inside it (Amendment 5). */
  | { phase: 'report'; report: AuditReport; request: AuditRequest; session: string | null; features: Features | null };

const domainFromUrl = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const scrollToTop = () => {
  window.scrollTo({ top: 0 });
  postScrollTop();
};

export interface DevAutorun {
  url: string;
  tab: 'website' | 'ai';
}

export const App = ({ embedded, devAutorun }: { embedded: boolean; devAutorun?: DevAutorun }) => {
  const [state, setState] = useState<State>({ phase: 'form', error: null, errorCode: null });
  const [values, setValues] = useState<FormValues>(EMPTY_FORM);
  /** Bumped on every new audit, so late responses from an earlier one are ignored. */
  const generation = useRef(0);
  const restoreScroll = useRef<(() => void) | null>(null);
  /** The current report's session, for handlers created before the latest render. */
  const sessionRef = useRef<string | null>(null);
  /** The session-expired text shows once per page, not on every idea. */
  const expiredShown = useRef(false);
  const [printing, startPrintInPlace] = usePrintInPlace();
  /**
   * Votes the server accepted, by idea index. In-place printing swaps the tabbed panels for the
   * print layout and back, remounting the feedback buttons; they start from these.
   */
  const [votes, setVotes] = useState<Record<number, Vote>>({});

  useLayoutEffect(() => {
    if (restoreScroll.current) {
      restoreScroll.current();
      restoreScroll.current = null;
    }
  });

  /** Applies a late update to the current report without moving the visitor's view. */
  const updateReport = useCallback((gen: number, fn: (r: AuditReport) => AuditReport) => {
    if (gen !== generation.current) return;
    restoreScroll.current = captureScrollAnchor();
    setState((s) => (s.phase === 'report' ? { ...s, report: fn(s.report) } : s));
  }, []);

  const followUp = (gen: number, report: AuditReport) => {
    if (report.buyerFitStatus === 'pending') {
      fetchBuyerFit(report.auditId).then(
        (res) => updateReport(gen, (r) => mergeBuyerFit(r, res)),
        () => updateReport(gen, (r) => markUnavailable(r, 'buyerFit')),
      );
    }
    if (report.aiStatus === 'pending') {
      fetchAi(report.auditId).then(
        (res) => updateReport(gen, (r) => mergeAi(r, res)),
        () => updateReport(gen, (r) => markUnavailable(r, 'ai')),
      );
    }
  };

  const submit = async (formValues: FormValues, url: string) => {
    const gen = ++generation.current;
    setValues(formValues);
    const request = buildRequest(formValues, url);
    setState({ phase: 'loading', domain: domainFromUrl(url) });
    scrollToTop();
    try {
      const { session, features, ...report } = await startAudit(request);
      if (gen !== generation.current) return;
      sessionRef.current = typeof session === 'string' ? session : null;
      expiredShown.current = false;
      setVotes({});
      setState({ phase: 'report', report, request, session: sessionRef.current, features: features ?? null });
      scrollToTop();
      followUp(gen, report);
    } catch (err) {
      if (gen !== generation.current) return;
      const message = err instanceof AuditError ? err.message : COPY.errors.network;
      const errorCode = err instanceof AuditError ? err.code : 'network';
      setState({ phase: 'form', error: message, errorCode });
      scrollToTop();
    }
  };

  useEffect(() => {
    if (!devAutorun) return;
    const check = normaliseUrlInput(devAutorun.url);
    if (check.ok) void submit({ ...EMPTY_FORM, url: devAutorun.url, email: 'dev@example.com' }, check.url);
  }, []);

  const onVote: VoteHandler = async (ideaIndex, vote) => {
    const session = sessionRef.current;
    if (!session) return 'error';
    try {
      await sendFeedback(session, ideaIndex, vote);
      if (session === sessionRef.current) setVotes((v) => ({ ...v, [ideaIndex]: vote }));
      return 'ok';
    } catch (e) {
      if (e instanceof AuditError && e.code === 'session_expired' && !expiredShown.current) {
        expiredShown.current = true;
        return 'expired';
      }
      return 'error';
    }
  };

  /** Synchronous in the click handler, so the print window isn't treated as a popup. */
  const onPdf = () => {
    if (state.phase !== 'report') return;
    openPrintWindow(
      { report: state.report, request: state.request, ...(state.features ? { features: state.features } : {}) },
      browserOpenerEnv(startPrintInPlace),
    );
  };

  const restart = () => {
    generation.current++;
    sessionRef.current = null;
    setState({ phase: 'form', error: null, errorCode: null });
    scrollToTop();
  };

  return (
    <div class={embedded ? 'oa-app oa-app--embed' : 'oa-app'}>
      {!embedded && (
        <header class="oa-site-header">
          <a class="oa-site-header__brand" href={OFFSHORLY_ORIGIN} target="_blank" rel="noopener">
            <img src="/offshorly-icon.png" width="32" height="32" alt="" />
            <span>Offshorly</span>
            <span class="oa-visually-hidden"> (opens in a new tab)</span>
          </a>
          <span class="oa-site-header__tag">Website and AI audit</span>
        </header>
      )}
      <main class="oa-main">
        <ErrorBoundary onReset={restart}>
          {state.phase === 'form' && <Form key="form" initial={values} error={state.error} errorCode={state.errorCode} onSubmit={submit} />}
          {state.phase === 'loading' && <Loading domain={state.domain} />}
          {state.phase === 'report' && (
            <Report
              report={state.report}
              request={state.request}
              mode={printing ? 'print' : 'live'}
              onRestart={restart}
              initialTab={devAutorun?.tab}
              onVote={state.features?.feedback && state.session ? onVote : undefined}
              votes={votes}
              features={state.features}
              actions={
                <ReportActions
                  report={state.report}
                  mode="live"
                  onPdf={onPdf}
                  features={state.features}
                  session={state.session}
                  email={values.email || null}
                />
              }
            />
          )}
        </ErrorBoundary>
      </main>
      {!embedded && (
        <footer class="oa-site-footer">
          <span>{COPY.standalone.footer}</span>
          <span class="oa-site-footer__links">
            <a href={CTA.privacy.url} target="_blank" rel="noopener">
              {CTA.privacy.label}
            </a>
            <a href={CTA.contact.url} target="_blank" rel="noopener">
              Contact
            </a>
          </span>
        </footer>
      )}
    </div>
  );
};
