import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AuditReport, AuditRequest, ErrorCode } from '../shared/types.js';
import { AuditError, fetchAi, fetchBuyerFit, startAudit } from './api.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Form } from './components/Form.js';
import { Loading } from './components/Loading.js';
import { Report } from './components/Report.js';
import { CTA, OFFSHORLY_ORIGIN } from '../shared/services.js';
import { COPY } from './content/copy.js';
import { postScrollTop } from './embed/resize.js';
import { buildRequest, EMPTY_FORM, normaliseUrlInput, type FormValues } from './lib/form.js';
import { markUnavailable, mergeAi, mergeBuyerFit } from './lib/report.js';
import { captureScrollAnchor } from './lib/scrollAnchor.js';

type State =
  | { phase: 'form'; error: string | null; errorCode: ErrorCode | 'network' | null }
  | { phase: 'loading'; domain: string }
  | { phase: 'report'; report: AuditReport; request: AuditRequest };

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
      const report = await startAudit(request);
      if (gen !== generation.current) return;
      setState({ phase: 'report', report, request });
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

  const restart = () => {
    generation.current++;
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
          {state.phase === 'report' && <Report report={state.report} request={state.request} onRestart={restart} initialTab={devAutorun?.tab} />}
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
