import type { ComponentChildren } from 'preact';
import { useId, useState } from 'preact/hooks';
import type { CheckResult } from '../../shared/types.js';
import { CHECK_TEXT } from '../content/checkText.js';
import { COPY, STATUS_LABELS } from '../content/copy.js';
import { splitChecks } from '../lib/report.js';

/** "✓ N checks passed · Show passed checks": `children` (the passed items) stay collapsed until asked. */
export const PassedToggle = ({ count, children }: { count: number; children: ComponentChildren }) => {
  const [showPassed, setShowPassed] = useState(false);
  const passedId = `oa-passed-${useId()}`;
  return (
    <div class="oa-passed">
      <button
        type="button"
        class="oa-link-button"
        aria-expanded={showPassed}
        aria-controls={passedId}
        onClick={() => setShowPassed((s) => !s)}
      >
        <span class="oa-passed__tick" aria-hidden="true">
          ✓
        </span>
        {COPY.checks.passedCount(count)}
        <span class="oa-passed__action"> · {showPassed ? COPY.checks.hidePassed : COPY.checks.showPassed}</span>
      </button>
      <div id={passedId} hidden={!showPassed}>
        {children}
      </div>
    </div>
  );
};

/** Fails then warns (with fix text), then notes; passes behind a toggle. */
export const CheckList = ({ checks }: { checks: readonly CheckResult[] }) => {
  const { toAddress, passed, info } = splitChecks(checks);

  return (
    <div class="oa-checks">
      {toAddress.length === 0 ? (
        <p class="oa-checks__clear">{COPY.checks.allClear}</p>
      ) : (
        <ul class="oa-checklist">
          {toAddress.map((c) => (
            <li key={c.id} class={`oa-check oa-check--${c.status}`}>
              <div class="oa-check__head">
                <span class="oa-check__label">{CHECK_TEXT[c.id].label}</span>
                <span class={`oa-pill oa-pill--${c.status}`}>{STATUS_LABELS[c.status]}</span>
              </div>
              <p class="oa-check__detail">{c.detail}</p>
              <p class="oa-check__fix">{CHECK_TEXT[c.id].fix}</p>
            </li>
          ))}
        </ul>
      )}

      {info.length > 0 && (
        <ul class="oa-checklist oa-checklist--info">
          {info.map((c) => (
            <li key={c.id} class="oa-check oa-check--info">
              <div class="oa-check__head">
                <span class="oa-check__label">{CHECK_TEXT[c.id].label}</span>
                <span class="oa-pill oa-pill--info">{STATUS_LABELS.info}</span>
              </div>
              <p class="oa-check__detail">{c.detail}</p>
            </li>
          ))}
        </ul>
      )}

      {passed.length > 0 && (
        <PassedToggle count={passed.length}>
          <ul class="oa-passed__list">
            {passed.map((c) => (
              <li key={c.id}>
                <span class="oa-passed__label">{CHECK_TEXT[c.id].label}</span>
                <span class="oa-passed__detail">{c.detail}</span>
              </li>
            ))}
          </ul>
        </PassedToggle>
      )}
    </div>
  );
};
