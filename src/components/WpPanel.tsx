import { displayName } from '../../shared/displayName.js';
import type { WordPressInfo, WpComponent } from '../../shared/types.js';
import { COPY } from '../content/copy.js';
import { PassedToggle } from './CheckList.js';
import { ExternalLink } from './ui.js';

const W = COPY.wordpress;

const coreSource = (s: WordPressInfo['core']['source']): string | null => {
  switch (s) {
    case 'generator':
      return W.sourceGenerator;
    case 'feed':
      return W.sourceFeed;
    case 'asset':
      return W.sourceAsset;
    default:
      return null;
  }
};

const coreStatus = (s: WordPressInfo['core']['status']) => {
  switch (s) {
    case 'insecure':
      return { text: W.statusInsecure, cls: 'fail' };
    case 'outdated':
      return { text: W.statusOutdated, cls: 'warn' };
    case 'latest':
      return { text: W.statusLatest, cls: 'pass' };
    default:
      return { text: W.versionNotShown, cls: 'info' };
  }
};

/** Status chips for one component. Wording is factual; "security fix" only from Wordfence. */
const componentChips = (c: WpComponent): { text: string; cls: string }[] => {
  const chips: { text: string; cls: string }[] = [];
  if (c.status === 'fix_available') chips.push({ text: W.securityFixChip, cls: 'fail' });
  if (c.directory === 'closed') chips.push({ text: W.closed, cls: 'fail' });
  if (c.status === 'outdated') chips.push({ text: W.statusOutdated, cls: 'warn' });
  if (c.stale) chips.push({ text: W.stale, cls: 'warn' });
  if (c.status === 'up_to_date' && chips.length === 0) chips.push({ text: W.statusLatest, cls: 'pass' });
  if (c.directory === 'not_listed') chips.push({ text: W.notListed, cls: 'info' });
  if (chips.length === 0) chips.push({ text: W.statusUnknown, cls: 'info' });
  return chips;
};

/** Passed = nothing but an "Up to date" chip. Unknown and not-listed stay visible, like CheckList's notes. */
const componentPassed = (c: WpComponent): boolean => componentChips(c).every((chip) => chip.cls === 'pass');

const Core = ({ wp }: { wp: WordPressInfo }) => {
  const status = coreStatus(wp.core.status);
  const source = coreSource(wp.core.source);
  return (
    <div class="oa-wp__core">
      <div class="oa-wp__row">
        <span class="oa-wp__name">{W.core}</span>
        <span class={`oa-chip oa-chip--${status.cls}`}>{status.text}</span>
      </div>
      <dl class="oa-wp__versions">
        <div>
          <dt>{W.running}</dt>
          <dd>
            {wp.core.version ?? W.unknownVersion}
            {wp.core.version && source && <span class="oa-muted"> ({source})</span>}
          </dd>
        </div>
        {wp.core.latest && (
          <div>
            <dt>{W.latest}</dt>
            <dd>{wp.core.latest}</dd>
          </div>
        )}
      </dl>
    </div>
  );
};

const Components = ({ items }: { items: WpComponent[] }) => (
  <ul class="oa-wp__components">
    {items.map((c) => (
      <li key={`${c.type}-${c.slug}`} class="oa-wp__component">
        <div class="oa-wp__row">
          <span class="oa-wp__name">
            {displayName(c)}
            <span class="oa-wp__type">{c.type === 'theme' ? W.theme : W.plugin}</span>
          </span>
        </div>
        <dl class="oa-wp__versions">
          <div>
            <dt>{W.running}</dt>
            <dd>{c.version ?? W.unknownVersion}</dd>
          </div>
          {c.latest && (
            <div>
              <dt>{W.latest}</dt>
              <dd>{c.latest}</dd>
            </div>
          )}
        </dl>
        <ul class="oa-chips">
          {componentChips(c).map((chip) => (
            <li key={chip.text} class={`oa-chip oa-chip--${chip.cls}`}>
              {chip.text}
            </li>
          ))}
        </ul>
      </li>
    ))}
  </ul>
);

/** Concerning and unknown items first; up-to-date core, plugins and theme behind "N checks passed". */
export const WpPanel = ({ wp }: { wp: WordPressInfo }) => {
  const corePassed = coreStatus(wp.core.status).cls === 'pass';
  const open = wp.components.filter((c) => !componentPassed(c));
  const passed = wp.components.filter(componentPassed);
  const passedCount = passed.length + (corePassed ? 1 : 0);
  return (
    <div class="oa-wp">
      <h4 class="oa-wp__heading">{W.heading}</h4>
      <p class="oa-muted">{W.intro}</p>

      {corePassed && open.length === 0 && <p class="oa-checks__clear">{COPY.checks.allClear}</p>}
      {!corePassed && <Core wp={wp} />}
      {open.length > 0 && (
        <>
          <h5 class="oa-wp__subheading">{W.plugins}</h5>
          <Components items={open} />
        </>
      )}
      {passedCount > 0 && (
        <PassedToggle count={passedCount}>
          {corePassed && <Core wp={wp} />}
          {passed.length > 0 && <Components items={passed} />}
        </PassedToggle>
      )}

      {wp.knownIssues && wp.knownIssues.count > 0 && (
        <p class="oa-wp__issues">{W.knownIssues(wp.knownIssues.count, wp.knownIssues.highest.replace(/^./, (s) => s.toUpperCase()))}</p>
      )}
      <p class="oa-wp__note">
        {W.updatesNote} {W.shareDetails}
      </p>
      {wp.vulnSource === 'wordfence' && (
        <p class="oa-attribution">
          <ExternalLink href={W.wordfenceUrl}>{W.wordfenceAttribution}</ExternalLink>
        </p>
      )}
    </div>
  );
};
