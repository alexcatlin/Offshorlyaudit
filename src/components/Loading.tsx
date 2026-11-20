import { useEffect, useState } from 'preact/hooks';
import { COPY, LOADING_STAGES } from '../content/copy.js';
import { Spinner } from './ui.js';

/** Simulated progress for the site read and measured checks (one request, so timer-driven). */
export const Loading = ({ domain }: { domain: string }) => {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - started) / 1000), 500);
    return () => clearInterval(t);
  }, []);
  const stageIndex = LOADING_STAGES.reduce((acc, s, i) => (elapsed >= s.afterSec ? i : acc), 0);

  return (
    <section class="oa-loading" aria-busy="true">
      <div class="oa-loading__card">
        <Spinner />
        <h2 class="oa-loading__title">{COPY.loading.heading}</h2>
        <p class="oa-loading__domain">{domain}</p>
        <ol class="oa-stages">
          {LOADING_STAGES.map((s, i) => (
            <li
              key={s.text}
              class={i < stageIndex ? 'oa-stage is-done' : i === stageIndex ? 'oa-stage is-current' : 'oa-stage'}
              aria-current={i === stageIndex ? 'step' : undefined}
            >
              <span class="oa-stage__dot" aria-hidden="true" />
              {s.text}
            </li>
          ))}
        </ol>
        <p class="oa-visually-hidden" aria-live="polite">
          {LOADING_STAGES[stageIndex]?.text}
        </p>
        <p class="oa-muted oa-small">{COPY.loading.sub}</p>
      </div>
    </section>
  );
};
