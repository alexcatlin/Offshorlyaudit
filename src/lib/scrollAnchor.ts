// Keeps what the visitor is reading in place when late data (buyer fit, AI) re-renders
// blocks above it. Browser scroll anchoring is switched off in CSS (overflow-anchor:none)
// so the two don't both adjust.

const CANDIDATES = '[data-anchor], .oa-panel:not([hidden]) > *, .oa-details > *';

/** Records the first visible block's position; the returned function restores it. */
export const captureScrollAnchor = (): (() => void) => {
  if (typeof window === 'undefined' || window.scrollY <= 0) return () => {};
  const els = Array.from(document.querySelectorAll<HTMLElement>(CANDIDATES));
  const anchor = els.find((el) => el.getBoundingClientRect().bottom > 0);
  if (!anchor) return () => {};
  const before = anchor.getBoundingClientRect().top;
  return () => {
    if (!anchor.isConnected) return;
    const delta = anchor.getBoundingClientRect().top - before;
    if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
  };
};
