import { bookingUrl, CTA } from '../../shared/services.js';
import { track } from '../api.js';
import { COPY } from '../content/copy.js';
import { ExternalLink } from './ui.js';

/** Booking card: after "Fix these first" on the audit tab, at the end of the AI tab. */
const CONTENT = {
  ai: { heading: COPY.cta.heading, text: COPY.cta.text },
  pitch: { heading: COPY.cta.pitchHeading, text: COPY.cta.text },
  website: { heading: COPY.cta.websiteHeading, text: COPY.cta.websiteText },
} as const;

/** 'ai' when ideas are shown, 'pitch' when the AI tab has no ideas, 'website' on the audit tab. */
export const Cta = ({ variant }: { variant: keyof typeof CONTENT }) => (
  <aside class="oa-cta" aria-label={CONTENT[variant].heading}>
    <div class="oa-cta__text">
      <h3 class="oa-cta__heading">{CONTENT[variant].heading}</h3>
      <p>{CONTENT[variant].text}</p>
    </div>
    <div class="oa-cta__buttons">
      <ExternalLink class="oa-button oa-button--on-dark" href={bookingUrl(variant)} onClick={() => track('cta_click', variant)}>
        {CTA.consultation.label}
      </ExternalLink>
      <ExternalLink class="oa-button oa-button--outline-dark" href={CTA.contact.url}>
        {COPY.cta.secondary}
      </ExternalLink>
    </div>
  </aside>
);
