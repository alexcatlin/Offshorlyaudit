import type { ComponentChildren } from 'preact';
import { useId, useState } from 'preact/hooks';
import { COPY } from '../content/copy.js';
import { ScoreRing, Spinner } from './ui.js';

/** Dev only (dropped from production builds): ?expand=1 opens every section, for screenshots. */
const DEV_EXPAND = import.meta.env.DEV && new URLSearchParams(window.location.search).get('expand') === '1';

interface Props {
  title: string;
  summary?: string;
  score?: number | null;
  /** Shows a non-interactive header while the content is still being produced. */
  pending?: boolean;
  defaultOpen?: boolean;
  children?: ComponentChildren;
}

export const Collapsible = ({ title, summary, score, pending, defaultOpen = false, children }: Props) => {
  const [open, setOpen] = useState(defaultOpen || DEV_EXPAND);
  const id = useId();
  const bodyId = `oa-col-${id}`;
  const showScore = score !== undefined;

  if (pending) {
    return (
      <section class="oa-collapsible oa-collapsible--pending" aria-busy="true">
        <div class="oa-collapsible__header">
          <span class="oa-collapsible__main">
            <h3 class="oa-collapsible__title">{title}</h3>
            <span class="oa-collapsible__summary oa-collapsible__summary--pending">
              <Spinner small />
              {COPY.report.pending}
            </span>
          </span>
        </div>
      </section>
    );
  }

  return (
    <section class={open ? 'oa-collapsible is-open' : 'oa-collapsible'}>
      <h3 class="oa-collapsible__heading">
        <button
          type="button"
          class="oa-collapsible__header"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
        >
          {showScore && <ScoreRing score={score ?? null} label={title} size={52} />}
          <span class="oa-collapsible__main">
            <span class="oa-collapsible__title">{title}</span>
            {summary && <span class="oa-collapsible__summary">{summary}</span>}
          </span>
          <span class="oa-collapsible__toggle">
            <span class="oa-collapsible__toggle-text">{open ? COPY.detail.hide : COPY.detail.show}</span>
            <svg class="oa-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </span>
        </button>
      </h3>
      <div id={bodyId} class="oa-collapsible__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
};
