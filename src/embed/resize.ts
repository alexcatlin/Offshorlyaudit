// Inside the iframe: tell the host page (public/embed.js) our height, and ask it to scroll
// the iframe into view when a new screen renders. embed.js only accepts these messages
// when event.origin is the tool's origin and event.source is this iframe's window.

export const RESIZE_MESSAGE = 'offshorly-audit:resize';
export const SCROLLTOP_MESSAGE = 'offshorly-audit:scrolltop';

/** True inside an iframe, or when ?embed=1 is set. */
export const isEmbedded = (): boolean => {
  if (new URLSearchParams(window.location.search).get('embed') === '1') return true;
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin access to window.top throws: we are framed.
    return true;
  }
};

const inFrame = (): boolean => window.parent !== window;

/**
 * Messages carry no visitor data (a height, or a scroll request), so they are posted with
 * targetOrigin '*': the host's origin is not known inside the iframe. The receiving side checks origin and source.
 */
const post = (msg: Record<string, unknown>): void => {
  if (!inFrame()) return;
  window.parent.postMessage(msg, '*');
};

let lastHeight = 0;

const reportHeight = (): void => {
  const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
  if (height === lastHeight || height <= 0) return;
  lastHeight = height;
  post({ type: RESIZE_MESSAGE, height });
};

/** Starts posting the document height whenever it changes. No-op outside an iframe. */
export const startResizeReporting = (): void => {
  if (!inFrame()) return;
  reportHeight();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => reportHeight());
    ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
  } else {
    window.addEventListener('resize', reportHeight);
    setInterval(reportHeight, 1000);
  }
};

/** Asks the host page to bring the top of the iframe into view. */
export const postScrollTop = (): void => post({ type: SCROLLTOP_MESSAGE });
