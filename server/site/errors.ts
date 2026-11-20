// Errors raised while reading a target site. The orchestrator maps them to 422 responses:
//   not_found  → { code: 'site_not_found' }   bad address, can't resolve, private address, odd port
//   unreadable → { code: 'site_unreadable' }  refused, errored, timed out, not HTML

export type SiteReadErrorCode = 'not_found' | 'unreadable';

export class SiteReadError extends Error {
  readonly code: SiteReadErrorCode;
  constructor(code: SiteReadErrorCode, message: string) {
    super(message);
    this.name = 'SiteReadError';
    this.code = code;
  }
}

/** Raised by the connect-time guard when a hostname resolves to a non-public address. */
export class BlockedAddressError extends Error {
  readonly code = 'EBLOCKEDADDRESS';
  constructor(host: string) {
    super(`Refused to connect to ${host}: not a public address.`);
    this.name = 'BlockedAddressError';
  }
}

/** Walk an error's `cause` chain looking for a match. */
export const findCause = <T extends Error>(
  err: unknown,
  match: (e: unknown) => e is T,
  depth = 6,
): T | null => {
  let cur: unknown = err;
  for (let i = 0; i < depth && cur; i++) {
    if (match(cur)) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
};

export const isBlockedAddressError = (e: unknown): e is BlockedAddressError =>
  e instanceof BlockedAddressError || (e as { code?: unknown } | null)?.code === 'EBLOCKEDADDRESS';
