// /print window for "Save as PDF" (Amendment 5 Phase 1). Asks its opener for the report over
// postMessage (src/lib/printBridge.ts), renders it in print mode, waits for fonts and layout,
// then opens the print dialog. Opened directly (no opener, or no data within 3 s) it explains
// how to get here.
import { useEffect, useState } from 'preact/hooks';
import { Report } from '../components/Report.js';
import { COPY } from '../content/copy.js';
import { formatDate } from '../lib/report.js';
import { afterLayout, parseDataMessage, PRINT_ORPHAN_MS, PRINT_READY, type PrintPayload } from '../lib/printBridge.js';

type State = { kind: 'waiting' } | { kind: 'orphan' } | { kind: 'ready'; payload: PrintPayload };

export const PrintApp = () => {
  const [state, setState] = useState<State>({ kind: 'waiting' });

  useEffect(() => {
    const opener = window.opener as Window | null;
    if (!opener) {
      setState({ kind: 'orphan' });
      return;
    }
    const origin = window.location.origin;
    const onMessage = (ev: MessageEvent) => {
      const payload = parseDataMessage(ev, { origin, opener });
      if (!payload) return;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      setState({ kind: 'ready', payload });
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      setState((s) => (s.kind === 'waiting' ? { kind: 'orphan' } : s));
    }, PRINT_ORPHAN_MS);
    try {
      opener.postMessage({ type: PRINT_READY }, origin);
    } catch {
      // opener navigated away or closed
    }
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    document.title = COPY.print.header(state.payload.report.domain, formatDate(state.payload.report.auditedAt));
    let cancelled = false;
    void afterLayout().then(() => {
      if (!cancelled) window.print();
    });
    return () => {
      cancelled = true;
    };
  }, [state]);

  return (
    <div class="oa-app oa-app--print">
      <main class="oa-main">
        {/* No actions: the print window has nothing to keep. */}
        {state.kind === 'ready' && <Report report={state.payload.report} request={state.payload.request} mode="print" features={state.payload.features} />}
        {state.kind === 'orphan' && <p class="oa-print-orphan">{COPY.actions.printOrphan}</p>}
      </main>
    </div>
  );
};
