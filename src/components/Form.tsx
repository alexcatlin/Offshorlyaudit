import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { CTA } from '../../shared/services.js';
import type { ErrorCode, TeamSize } from '../../shared/types.js';
import { COPY, EXAMPLE_BUYER, INDUSTRY_OPTIONS, TEAM_SIZE_OPTIONS } from '../content/copy.js';
import { checkEmailInput, LIMITS, normaliseUrlInput, type FormValues } from '../lib/form.js';
import { ExternalLink } from './ui.js';

const F = COPY.form;

interface Props {
  initial: FormValues;
  error: string | null;
  /** Code of the server error, when there was one: picks the alert style and focus. */
  errorCode?: ErrorCode | 'network' | null;
  onSubmit: (values: FormValues, url: string) => void;
}

const Expander = ({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ComponentChildren;
}) => {
  const id = `oa-exp-${useId()}`;
  return (
    <div class={open ? 'oa-expander is-open' : 'oa-expander'}>
      <button type="button" class="oa-expander__toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span class="oa-expander__icon" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
        <span class="oa-expander__label">{label}</span>
        <span class="oa-expander__optional">{F.optional}</span>
      </button>
      <div id={id} class="oa-expander__body" hidden={!open}>
        {children}
      </div>
    </div>
  );
};

/**
 * Shown in place of the form error on 409 email_used. Deliberately does not say which
 * site the email was used for.
 */
export const EmailUsedAlert = ({ message }: { message: string }) => (
  <div class="oa-alert oa-alert--info" role="alert">
    <p>{message}</p>
    <div class="oa-alert__actions">
      <ExternalLink class="oa-button oa-button--primary" href={CTA.consultation.url}>
        {CTA.consultation.label}
      </ExternalLink>
      <ExternalLink class="oa-alert__link" href={CTA.contact.url}>
        {F.emailUsedContact}
      </ExternalLink>
    </div>
  </div>
);

const Field = ({
  id,
  label,
  hint,
  optional,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  /** Shows the "Optional" tag after the label. */
  optional?: boolean;
  children: ComponentChildren;
}) => (
  <div class="oa-field">
    <label class="oa-label" for={id}>
      {label}
      {optional && (
        <>
          {' '}
          <span class="oa-label__optional">{F.optional}</span>
        </>
      )}
    </label>
    {children}
    {hint && (
      <p class="oa-hint" id={`${id}-hint`}>
        {hint}
      </p>
    )}
  </div>
);

export const Form = ({ initial, error, errorCode, onSubmit }: Props) => {
  const [v, setV] = useState<FormValues>(initial);
  const [urlError, setUrlError] = useState<string | null>(null);
  // A server email_invalid is shown on the email field itself, not as a form alert.
  const [emailError, setEmailError] = useState<string | null>(errorCode === 'email_invalid' ? error : null);
  const formError = errorCode === 'email_invalid' ? null : error;
  const hasBuyer = !!(initial.role || initial.size || initial.sector || initial.trigger);
  const hasBusiness = !!(initial.businessType || initial.teamSize || initial.tools || initial.timeSink);
  const [buyerOpen, setBuyerOpen] = useState(hasBuyer);
  const [businessOpen, setBusinessOpen] = useState(hasBusiness);
  const urlRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (errorCode === 'email_invalid') emailRef.current?.focus();
  }, []);
  const uid = useId();
  const fid = (name: string) => `oa-${name}-${uid}`;

  const set =
    <K extends keyof FormValues>(key: K) =>
    (e: Event) => {
      const value = (e.currentTarget as HTMLInputElement).value as FormValues[K];
      setV((prev) => ({ ...prev, [key]: value }));
      if (key === 'url') setUrlError(null);
      if (key === 'email') setEmailError(null);
    };

  const submit = (e: Event) => {
    e.preventDefault();
    const check = normaliseUrlInput(v.url);
    if (!check.ok) {
      setUrlError(check.reason === 'empty' ? F.urlRequired : F.urlInvalid);
      urlRef.current?.focus();
      return;
    }
    const email = checkEmailInput(v.email);
    if (!email.ok) {
      setEmailError(email.reason === 'empty' ? F.emailRequired : F.emailInvalid);
      emailRef.current?.focus();
      return;
    }
    onSubmit(v, check.url);
  };

  const fillExample = (e: Event) => {
    e.preventDefault();
    setV((prev) => ({ ...prev, ...EXAMPLE_BUYER }));
  };

  const urlErrId = fid('url-error');
  const emailErrId = fid('email-error');
  const leadNoticeId = fid('lead-notice');
  const formErrId = fid('form-error');

  return (
    <section class="oa-hero">
      <div class="oa-hero__inner">
        <h1 class="oa-hero__title">{COPY.hero.title}</h1>
        <p class="oa-hero__sub">{COPY.hero.sub}</p>

        <form class="oa-form" onSubmit={submit} noValidate aria-describedby={formError ? formErrId : undefined}>
          {formError &&
            (errorCode === 'email_used' ? (
              <div id={formErrId}>
                <EmailUsedAlert message={formError} />
              </div>
            ) : (
              <div class="oa-alert" role="alert" id={formErrId}>
                {formError}
              </div>
            ))}

          <div class="oa-field">
            <label class="oa-label" for={fid('url')}>
              {F.urlLabel}
            </label>
            <input
                ref={urlRef}
                id={fid('url')}
                class={urlError ? 'oa-input has-error' : 'oa-input'}
                type="text"
                inputMode="url"
                autoComplete="url"
                autoCapitalize="none"
                spellcheck={false}
                required
                maxLength={LIMITS.url}
                placeholder={F.urlPlaceholder}
                value={v.url}
                onInput={set('url')}
                aria-invalid={urlError ? true : undefined}
                aria-describedby={urlError ? `${urlErrId} ${fid('url')}-hint` : `${fid('url')}-hint`}
              />
            {urlError && (
              <p class="oa-field-error" id={urlErrId}>
                {urlError}
              </p>
            )}
            <p class="oa-hint" id={`${fid('url')}-hint`}>
              {F.urlHint}
            </p>
          </div>

          <Field id={fid('industry')} label={F.industryLabel} optional hint={F.industryHelp}>
            <select
              id={fid('industry')}
              class="oa-input oa-select"
              value={v.industry}
              onChange={set('industry')}
              aria-describedby={`${fid('industry')}-hint`}
            >
              <option value="">{F.industryNotSure}</option>
              {INDUSTRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>

          <Expander label={F.businessToggle} open={businessOpen} onToggle={() => setBusinessOpen((o) => !o)}>
            <p class="oa-expander__help">{F.businessHelp}</p>
            <Field id={fid('bt')} label={F.businessTypeLabel} hint={F.businessTypeHelp}>
              <input
                id={fid('bt')}
                class="oa-input"
                type="text"
                maxLength={LIMITS.businessType}
                placeholder={F.businessTypePlaceholder}
                value={v.businessType}
                onInput={set('businessType')}
                aria-describedby={`${fid('bt')}-hint`}
              />
            </Field>
            <Field id={fid('team')} label={F.teamSizeLabel}>
              <select id={fid('team')} class="oa-input oa-select" value={v.teamSize} onChange={set('teamSize')}>
                <option value="">{F.teamSizePlaceholder}</option>
                {TEAM_SIZE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value satisfies TeamSize}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id={fid('tools')} label={F.toolsLabel} hint={F.timeSinkCount(v.tools.length, LIMITS.tools)}>
              <input
                id={fid('tools')}
                class="oa-input"
                type="text"
                maxLength={LIMITS.tools}
                placeholder={F.toolsPlaceholder}
                value={v.tools}
                onInput={set('tools')}
                aria-describedby={`${fid('tools')}-hint`}
              />
            </Field>
            <Field id={fid('sink')} label={F.timeSinkLabel} hint={F.timeSinkCount(v.timeSink.length, LIMITS.timeSink)}>
              <textarea
                id={fid('sink')}
                class="oa-input oa-textarea"
                rows={3}
                maxLength={LIMITS.timeSink}
                placeholder={F.timeSinkPlaceholder}
                value={v.timeSink}
                onInput={set('timeSink')}
                aria-describedby={`${fid('sink')}-hint`}
              />
            </Field>
          </Expander>

          <Expander label={F.buyerToggle} open={buyerOpen} onToggle={() => setBuyerOpen((o) => !o)}>
            <p class="oa-expander__help">
              {F.buyerHelp}{' '}
              <a href="#" class="oa-inline-link" onClick={fillExample}>
                {F.seeExample}
              </a>
            </p>
            <div class="oa-grid-2">
              <Field id={fid('role')} label={F.roleLabel}>
                <input id={fid('role')} class="oa-input" type="text" maxLength={LIMITS.role} placeholder={F.rolePlaceholder} value={v.role} onInput={set('role')} />
              </Field>
              <Field id={fid('size')} label={F.sizeLabel}>
                <input id={fid('size')} class="oa-input" type="text" maxLength={LIMITS.size} placeholder={F.sizePlaceholder} value={v.size} onInput={set('size')} />
              </Field>
              <Field id={fid('sector')} label={F.sectorLabel}>
                <input id={fid('sector')} class="oa-input" type="text" maxLength={LIMITS.sector} placeholder={F.sectorPlaceholder} value={v.sector} onInput={set('sector')} />
              </Field>
              <Field id={fid('trigger')} label={F.triggerLabel}>
                <input id={fid('trigger')} class="oa-input" type="text" maxLength={LIMITS.trigger} placeholder={F.triggerPlaceholder} value={v.trigger} onInput={set('trigger')} />
              </Field>
            </div>
          </Expander>

          <div class="oa-grid-2 oa-lead-row">
            <div class="oa-field">
              <label class="oa-label" for={fid('email')}>
                {F.emailLabel}
              </label>
              <input
                ref={emailRef}
                id={fid('email')}
                class={emailError ? 'oa-input has-error' : 'oa-input'}
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellcheck={false}
                required
                maxLength={LIMITS.email}
                placeholder={F.emailPlaceholder}
                value={v.email}
                onInput={set('email')}
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailError ? `${emailErrId} ${leadNoticeId}` : leadNoticeId}
              />
              {emailError && (
                <p class="oa-field-error" id={emailErrId}>
                  {emailError}
                </p>
              )}
            </div>
            <div class="oa-field">
              <label class="oa-label" for={fid('name')}>
                {F.nameLabel} <span class="oa-label__optional">{F.optional}</span>
              </label>
              <input
                id={fid('name')}
                class="oa-input"
                type="text"
                autoComplete="name"
                maxLength={LIMITS.name}
                placeholder={F.namePlaceholder}
                value={v.name}
                onInput={set('name')}
              />
            </div>
          </div>
          <p class="oa-privacy oa-lead-notice" id={leadNoticeId}>
            {F.leadNotice} <ExternalLink href={CTA.privacy.url}>{F.privacyLinkLabel}</ExternalLink>
          </p>

          <label class="oa-optin">
            <input
              type="checkbox"
              class="oa-optin__box"
              checked={v.marketingOptIn}
              onChange={(e) => {
                const checked = (e.currentTarget as HTMLInputElement).checked;
                setV((prev) => ({ ...prev, marketingOptIn: checked }));
              }}
            />
            <span>{F.marketingOptIn}</span>
          </label>

          <button type="submit" class="oa-button oa-button--primary oa-form__submit">
            {F.submit}
          </button>

          <p class="oa-privacy">{F.privacyNotice}</p>
        </form>
      </div>
    </section>
  );
};
