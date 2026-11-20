import type { ComponentChildren } from 'preact';
import { useId, useRef, useState } from 'preact/hooks';
import { CTA } from '../../shared/services.js';
import type { TeamSize } from '../../shared/types.js';
import { BUSINESS_TYPE_SUGGESTIONS, COPY, EXAMPLE_BUYER, TEAM_SIZE_OPTIONS } from '../content/copy.js';
import { LIMITS, normaliseUrlInput, type FormValues } from '../lib/form.js';
import { ExternalLink } from './ui.js';

const F = COPY.form;

interface Props {
  initial: FormValues;
  error: string | null;
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

const Field = ({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ComponentChildren;
}) => (
  <div class="oa-field">
    <label class="oa-label" for={id}>
      {label}
    </label>
    {children}
    {hint && (
      <p class="oa-hint" id={`${id}-hint`}>
        {hint}
      </p>
    )}
  </div>
);

export const Form = ({ initial, error, onSubmit }: Props) => {
  const [v, setV] = useState<FormValues>(initial);
  const [urlError, setUrlError] = useState<string | null>(null);
  const hasBuyer = !!(initial.businessType || initial.role || initial.size || initial.sector || initial.trigger);
  const [buyerOpen, setBuyerOpen] = useState(hasBuyer);
  const [detailOpen, setDetailOpen] = useState(!!(initial.teamSize || initial.timeSink));
  const urlRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const fid = (name: string) => `oa-${name}-${uid}`;

  const set =
    <K extends keyof FormValues>(key: K) =>
    (e: Event) => {
      const value = (e.currentTarget as HTMLInputElement).value as FormValues[K];
      setV((prev) => ({ ...prev, [key]: value }));
      if (key === 'url') setUrlError(null);
    };

  const submit = (e: Event) => {
    e.preventDefault();
    const check = normaliseUrlInput(v.url);
    if (!check.ok) {
      setUrlError(check.reason === 'empty' ? F.urlRequired : F.urlInvalid);
      urlRef.current?.focus();
      return;
    }
    onSubmit(v, check.url);
  };

  const fillExample = (e: Event) => {
    e.preventDefault();
    setV((prev) => ({ ...prev, ...EXAMPLE_BUYER }));
  };

  const urlErrId = fid('url-error');
  const formErrId = fid('form-error');

  return (
    <section class="oa-hero">
      <div class="oa-hero__inner">
        <h1 class="oa-hero__title">{COPY.hero.title}</h1>
        <p class="oa-hero__sub">{COPY.hero.sub}</p>

        <form class="oa-form" onSubmit={submit} noValidate aria-describedby={error ? formErrId : undefined}>
          {error && (
            <div class="oa-alert" role="alert" id={formErrId}>
              {error}
            </div>
          )}

          <div class="oa-field">
            <label class="oa-label" for={fid('url')}>
              {F.urlLabel}
            </label>
            <div class="oa-url-row">
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
              <button type="submit" class="oa-button oa-button--primary oa-url-row__submit">
                {F.submit}
              </button>
            </div>
            {urlError && (
              <p class="oa-field-error" id={urlErrId}>
                {urlError}
              </p>
            )}
            <p class="oa-hint" id={`${fid('url')}-hint`}>
              {F.urlHint}
            </p>
          </div>

          <Expander label={F.buyerToggle} open={buyerOpen} onToggle={() => setBuyerOpen((o) => !o)}>
            <p class="oa-expander__help">
              {F.buyerHelp}{' '}
              <a href="#" class="oa-inline-link" onClick={fillExample}>
                {F.seeExample}
              </a>
            </p>
            <Field id={fid('bt')} label={F.businessTypeLabel} hint={F.businessTypeHelp}>
              <input
                id={fid('bt')}
                class="oa-input"
                type="text"
                list={fid('bt-list')}
                maxLength={LIMITS.businessType}
                placeholder={F.businessTypePlaceholder}
                value={v.businessType}
                onInput={set('businessType')}
                aria-describedby={`${fid('bt')}-hint`}
              />
              <datalist id={fid('bt-list')}>
                {BUSINESS_TYPE_SUGGESTIONS.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </Field>
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

          <Expander label={F.detailToggle} open={detailOpen} onToggle={() => setDetailOpen((o) => !o)}>
            <p class="oa-expander__help">{F.detailHelp}</p>
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

          <p class="oa-privacy">
            {F.privacyNotice} <ExternalLink href={CTA.privacy.url}>{F.privacyLinkLabel}</ExternalLink>
          </p>
        </form>
      </div>
    </section>
  );
};
