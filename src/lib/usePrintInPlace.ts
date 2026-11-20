// In-place printing (Amendment 5 Phase 1): switch the report to print mode, wait for the
// layout, call window.print(), and switch back on `afterprint`. Used by shared pages and as the
// popup-blocked fallback on the live report.
import { useEffect, useState } from 'preact/hooks';
import { afterLayout } from './printBridge.js';

export const usePrintInPlace = (): readonly [boolean, () => void] => {
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    let cancelled = false;
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    void afterLayout().then(() => {
      if (!cancelled) window.print();
    });
    return () => {
      cancelled = true;
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);
  return [printing, () => setPrinting(true)] as const;
};
