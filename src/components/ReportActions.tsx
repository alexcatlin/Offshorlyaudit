// One compact row under the ContextBar (Amendment 5): Save as PDF, and in live mode Copy link
// (Phase 3) and "Email me this report" (Phase 4, only when `features.email` is true).
// Disabled until buyer fit and the AI ideas settle, so a PDF, link or email never shows "pending".
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AuditReport, Features } from '../../shared/types.js';
import { AuditError, createShare, deleteShare, emailReport } from '../api.js';
import { COPY } from '../content/copy.js';
import { formatDate, maskEmail } from '../lib/report.js';

const C = COPY.actions;

type ShareState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'shared'; url: string; expiresAt: string; copied: boolean }
  | { kind: 'message'; text: string };

type EmailState = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'sending' } | { kind: 'done'; text: string; sent: boolean };

export interface ReportActionsProps {
  report: AuditReport;
  mode: 'live' | 'shared';
  onPdf: () => void;
  /** Live mode: null/absent hides Copy link. */
  features?: Features | null;
  session?: string | null;
  /** Live mode: the address the audit was run with (masked in the confirm; sent back in the body). */
  email?: string | null;
}

export const isReportSettled = (r: AuditReport): boolean => r.aiStatus !== 'pending' && r.buyerFitStatus !== 'pending';

const errorText = (e: unknown): string => (e instanceof AuditError ? e.message : C.shareUnavailable);

const shareText = (s: ShareState): string => {
  if (s.kind === 'shared') return (s.copied ? C.linkCopied : C.linkReady)(formatDate(s.expiresAt));
  return s.kind === 'message' ? s.text : '';
};

/** Email errors: already sent and session expired have their own words; anything else → "copy the link". */
export const emailErrorText = (e: unknown): string => {
  if (e instanceof AuditError) {
    if (e.code === 'already_sent') return C.emailAlready;
    if (e.code === 'session_expired') return C.sessionExpired;
    if (e.code === 'rate_limited' || e.code === 'not_ready') return e.message;
  }
  return C.emailFailed;
};

export const ReportActions = ({ report, mode, onPdf, features, session, email }: ReportActionsProps) => {
  const [share, setShare] = useState<ShareState>({ kind: 'idle' });
  const [mail, setMail] = useState<EmailState>({ kind: 'idle' });
  /** After Save as PDF: the status line says how to save; any share action replaces it. */
  const [pdfNote, setPdfNote] = useState(false);
  const canEmail = mode === 'live' && !!features?.email && !!features.share && !!session && !!email;
  const inputRef = useRef<HTMLInputElement>(null);
  const settled = isReportSettled(report);
  const statusText = pdfNote ? C.pdfHint : shareText(share);
  const canShare = mode === 'live' && !!features?.share && !!session;

  // Clipboard refused (e.g. inside an iframe without clipboard-write): select the URL instead.
  useEffect(() => {
    if (share.kind === 'shared' && !share.copied) inputRef.current?.select();
  }, [share]);

  const onCopy = async () => {
    if (!session) return;
    setPdfNote(false);
    setShare({ kind: 'busy' });
    try {
      const res = await createShare(session);
      let copied = false;
      try {
        await navigator.clipboard.writeText(res.url);
        copied = true;
      } catch {
        copied = false;
      }
      setShare({ kind: 'shared', url: res.url, expiresAt: res.expiresAt, copied });
    } catch (e) {
      setShare({ kind: 'message', text: errorText(e) });
    }
  };

  const onDelete = async () => {
    if (!session) return;
    setPdfNote(false);
    try {
      await deleteShare(session);
      setShare({ kind: 'message', text: C.linkDeleted });
    } catch (e) {
      setShare({ kind: 'message', text: errorText(e) });
    }
  };

  const onSendEmail = async () => {
    if (!session || !email) return;
    setMail({ kind: 'sending' });
    try {
      await emailReport(session, email);
      setMail({ kind: 'done', text: C.emailSent, sent: true });
    } catch (e) {
      const already = e instanceof AuditError && e.code === 'already_sent';
      setMail({ kind: 'done', text: emailErrorText(e), sent: already });
    }
  };

  return (
    <div class="oa-actions">
      <div class="oa-actions__row">
        <button
          type="button"
          class="oa-button oa-button--outline oa-button--small"
          disabled={!settled}
          onClick={() => {
            setPdfNote(true);
            onPdf();
          }}
        >
          {C.pdf}
        </button>
        {canShare && (
          <button
            type="button"
            class="oa-button oa-button--outline oa-button--small"
            disabled={!settled || share.kind === 'busy'}
            aria-busy={share.kind === 'busy'}
            onClick={() => void onCopy()}
          >
            {C.copyLink}
          </button>
        )}
        {canEmail && (
          <button
            type="button"
            class="oa-button oa-button--outline oa-button--small"
            disabled={!settled || mail.kind === 'sending' || (mail.kind === 'done' && mail.sent)}
            aria-expanded={mail.kind === 'confirm'}
            onClick={() => setMail({ kind: 'confirm' })}
          >
            {C.email}
          </button>
        )}
        {!settled && <span class="oa-actions__hint">{C.waiting}</span>}
      </div>
      {share.kind === 'shared' && (
        <div class="oa-actions__share">
          <input
            ref={inputRef}
            class="oa-actions__url"
            type="text"
            readOnly
            value={share.url}
            aria-label={C.linkLabel}
            onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
          />
          <button type="button" class="oa-link-button oa-actions__delete" onClick={() => void onDelete()}>
            {C.deleteLink}
          </button>
        </div>
      )}
      {canEmail && (mail.kind === 'confirm' || mail.kind === 'sending') && (
        <div class="oa-actions__email">
          <p class="oa-actions__email-text">{C.emailConfirm(maskEmail(email ?? ''))}</p>
          <button
            type="button"
            class="oa-button oa-button--small"
            disabled={mail.kind === 'sending'}
            aria-busy={mail.kind === 'sending'}
            onClick={() => void onSendEmail()}
          >
            {C.emailSend}
          </button>
          <button type="button" class="oa-link-button" disabled={mail.kind === 'sending'} onClick={() => setMail({ kind: 'idle' })}>
            {C.emailCancel}
          </button>
        </div>
      )}
      {canEmail && (
        <output class="oa-actions__status oa-actions__status--email">{mail.kind === 'done' ? mail.text : ''}</output>
      )}
      <output class="oa-actions__status">{statusText}</output>
    </div>
  );
};
