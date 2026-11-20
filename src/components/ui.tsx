import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import type { Lvl, Owner } from '../../shared/types.js';
import { EFFORT_LABELS, IMPACT_LABELS, OWNER_LABELS } from '../content/copy.js';
import { safeHref } from '../lib/report.js';

/** External link: always a new tab, never passes the opener. Non-http(s) URLs render as text. */
/** Third-party pages (search results) get "noopener noreferrer nofollow ugc"; our own links "noopener". */
export const THIRD_PARTY_REL = 'noopener noreferrer nofollow ugc';

export const ExternalLink = ({
  href,
  children,
  class: cls,
  thirdParty,
}: {
  href: string;
  children: ComponentChildren;
  class?: string;
  thirdParty?: boolean;
}) => {
  const safe = safeHref(href);
  if (!safe) return <span class={cls}>{children}</span>;
  return (
    <a class={cls} href={safe} target="_blank" rel={thirdParty ? THIRD_PARTY_REL : 'noopener'}>
      {children}
      <span class="oa-visually-hidden"> (opens in a new tab)</span>
    </a>
  );
};

export const Spinner = ({ label, small }: { label?: string; small?: boolean }) => (
  <span class={small ? 'oa-spinner oa-spinner--small' : 'oa-spinner'} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
);

export const ActionTags = ({ impact, effort, owner }: { impact: Lvl; effort: Lvl; owner: Owner }) => (
  <ul class="oa-tags" aria-label="Tags">
    <li class={`oa-tag oa-tag--impact-${impact}`}>{IMPACT_LABELS[impact]}</li>
    <li class="oa-tag">{EFFORT_LABELS[effort]}</li>
    <li class="oa-tag">{OWNER_LABELS[owner]}</li>
  </ul>
);

/** Pending placeholder with grey bars and the "still reading" line. */
export const Skeleton = ({ lines = 3, text, dark }: { lines?: number; text: string; dark?: boolean }) => (
  <div class={dark ? 'oa-skeleton oa-skeleton--dark' : 'oa-skeleton'} aria-busy="true">
    <p class="oa-skeleton__text">
      <Spinner small />
      <span>{text}</span>
    </p>
    {Array.from({ length: lines }, (_, i) => (
      <span key={i} class="oa-skeleton__bar" style={{ width: `${92 - i * 17}%` }} aria-hidden="true" />
    ))}
  </div>
);

/** 0–100 score in a gradient ring; number stays in dark text for contrast. */
export const ScoreRing = ({ score, label, size = 72 }: { score: number | null; label: string; size?: number }) => {
  const id = useId();
  const r = 15.5;
  const c = 2 * Math.PI * r;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <span class="oa-ring" style={{ width: `${size}px`, height: `${size}px` }}>
      <svg viewBox="0 0 36 36" width={size} height={size} aria-hidden="true">
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="0.1">
            <stop offset="0%" stop-color="#7f67f6" />
            <stop offset="53%" stop-color="#4da1ff" />
            <stop offset="100%" stop-color="#5dd9b3" />
          </linearGradient>
        </defs>
        <circle cx="18" cy="18" r={r} fill="none" stroke="#ececf3" stroke-width="3" />
        {score !== null && (
          <circle
            cx="18"
            cy="18"
            r={r}
            fill="none"
            stroke={`url(#g${id})`}
            stroke-width="3"
            stroke-linecap="round"
            stroke-dasharray={`${(pct / 100) * c} ${c}`}
            transform="rotate(-90 18 18)"
          />
        )}
      </svg>
      <span class="oa-ring__value">
        <span class="oa-visually-hidden">{label}: </span>
        {score === null ? '–' : score}
        {score !== null && <span class="oa-visually-hidden"> out of 100</span>}
      </span>
    </span>
  );
};
