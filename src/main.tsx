import { render } from 'preact';
import '@fontsource/inter/latin-300.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/urbanist/latin-500.css';
import '@fontsource/urbanist/latin-600.css';
import './styles/tokens.css';
import './styles/widget.css';
import { App } from './App.js';
import { isEmbedded, startResizeReporting } from './embed/resize.js';

const embedded = isEmbedded();
document.documentElement.classList.toggle('oa-embedded', embedded);

// Dev only (removed from production builds): ?mock=1&autorun=example.com submits the form
// on load, &tab=ai opens the AI tab. Used for screenshots.
const params = new URLSearchParams(window.location.search);
const devAutorun =
  import.meta.env.DEV && params.get('mock') === '1' && params.get('autorun')
    ? { url: params.get('autorun') ?? '', tab: params.get('tab') === 'ai' ? ('ai' as const) : ('website' as const) }
    : undefined;

const root = document.getElementById('app');
if (root) {
  render(<App embedded={embedded} devAutorun={devAutorun} />, root);
  startResizeReporting();
}
