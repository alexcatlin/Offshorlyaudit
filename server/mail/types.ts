// Mail seam (Amendment 5 Phase 4). Only server/mail/resend.ts knows a provider's API shape.
// A message is built from server-owned text (server/mail/reportEmail.ts) and sent once; the
// recipient address is used for that one send and never stored or logged.

export interface MailMessage {
  /** The gate address the visitor typed. Never stored, never logged. */
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Same key for a retry, so the provider sends at most one message. */
  idempotencyKey: string;
}

/** `status` is the provider's HTTP status (or 'network' for no response / timeout). Never a body. */
export type MailResult = { ok: true } | { ok: false; status: number | 'network' };

export interface Mailer {
  readonly name: 'resend';
  send(message: MailMessage): Promise<MailResult>;
}
