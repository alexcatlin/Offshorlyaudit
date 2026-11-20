// Email handling for the one-audit-per-email gate (Amendment 3 §1, §3).
//
// The address itself is used for exactly two things: the validation below and the CRM sync.
// It never enters AuditRequest, the cache key, runAudit, a prompt or a log line. The gate and
// logs only ever see `emailKey()`: an HMAC of the canonical address.
import { createHmac } from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import type { LeadFields } from '../../shared/types.js';
import { isDisposableDomain } from './disposable.js';

export const EMAIL_MAX = 254;
export const NAME_MAX = 100;
/** Local part: printable ASCII only (0x21-0x7e, so no spaces, control or zero-width characters),
 *  minus the characters that would need quoting. */
export const EMAIL_RE = /^(?:(?![@<>()[\],;:"])[\x21-\x7e]){1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * The trimmed address when it passes the gate's syntax rule (EMAIL_RE, at most EMAIL_MAX),
 * else null. Run this before canonicalEmail/emailKey: canonicalisation splits at the last @
 * and drops "+tag", so an unvalidated string (a list, a display-name form, CRLF) could hash
 * to someone else's key.
 */
export const validEmail = (email: string): string | null => {
  const e = email.trim();
  return e.length <= EMAIL_MAX && EMAIL_RE.test(e) ? e : null;
};

/**
 * Safe display name: no angle brackets or pipes, no control characters, whitespace collapsed.
 * (Kept from the old webhook route; harmless in Twenty and in logs we never write.)
 */
export const sanitiseLeadName = (name: string): string =>
  name
    .replace(/[<>|]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export type LeadValidation =
  | { ok: true; value: LeadFields }
  | { ok: false; code: 'email_invalid' | 'bad_request'; error: string };

export const EMAIL_INVALID_MESSAGE = 'Please enter a valid email address.';

/**
 * Shape check of the lead fields in a POST /api/audit body. The email must be a non-empty
 * string of at most 254 characters here; syntax, disposable domains and MX are checked later
 * (after the per-IP limiter) by `checkEmail`.
 */
export const validateLeadFields = (body: unknown): LeadValidation => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'bad_request', error: 'Expected a JSON object.' };
  }
  const b = body as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!email || email.length > EMAIL_MAX) return { ok: false, code: 'email_invalid', error: EMAIL_INVALID_MESSAGE };
  const out: LeadFields = { email };
  if (b.name !== undefined && b.name !== null && b.name !== '') {
    if (typeof b.name !== 'string') return { ok: false, code: 'bad_request', error: 'name must be text.' };
    if (b.name.trim().length > NAME_MAX) return { ok: false, code: 'bad_request', error: 'name is too long.' };
    const name = sanitiseLeadName(b.name);
    if (name) out.name = name;
  }
  if (b.marketingOptIn !== undefined && b.marketingOptIn !== null) {
    if (typeof b.marketingOptIn !== 'boolean') return { ok: false, code: 'bad_request', error: 'marketingOptIn must be true or false.' };
    if (b.marketingOptIn) out.marketingOptIn = true;
  }
  return { ok: true, value: out };
};

/** Lowercased domain part of an address ('' when there is no @). */
export const emailDomain = (email: string): string => {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
};

/**
 * Canonical form, used only for the gate key and the allow-list (never for the CRM).
 * Callers must pass an address that already passed `validEmail`:
 * lowercase; strip "+tag" on every domain; for Gmail also remove dots and map
 * googlemail.com → gmail.com.
 */
export const canonicalEmail = (email: string): string => {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
};

/** Gate key: HMAC-SHA256(secret, canonical address), first 32 hex characters. */
export const emailKey = (secret: string, email: string): string =>
  createHmac('sha256', secret).update(canonicalEmail(email)).digest('hex').slice(0, 32);

/** Short form of the key for log lines. */
export const logHash = (key: string): string => key.slice(0, 12);

// ---------- Allow-list ----------

export interface Allowlist {
  emails: ReadonlySet<string>;
  domains: ReadonlySet<string>;
}

/**
 * Parse AUDIT_ALLOWLIST entries (already split on spaces/commas): exact addresses or
 * "@domain" (exact domain, no subdomains). Returns null for the first invalid entry.
 */
export const parseAllowlist = (entries: readonly string[]): { ok: true; value: Allowlist } | { ok: false; entry: string } => {
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const raw of entries) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (e.startsWith('@')) {
      const d = e.slice(1);
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return { ok: false, entry: raw };
      domains.add(d === 'googlemail.com' ? 'gmail.com' : d);
    } else {
      if (!EMAIL_RE.test(e)) return { ok: false, entry: raw };
      emails.add(canonicalEmail(e));
    }
  }
  return { ok: true, value: { emails, domains } };
};

/** True when the canonical address is listed, or its exact domain is. */
export const isAllowlisted = (list: Allowlist, email: string): boolean => {
  const c = canonicalEmail(email);
  return list.emails.has(c) || list.domains.has(emailDomain(c));
};

// ---------- Deliverability ----------

/** The DNS calls the MX check needs. node:dns/promises satisfies it; tests pass a fake. */
export interface MxResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

export const MX_TIMEOUT_MS = 2_000;

const NO_RECORDS = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

class MxTimeout extends Error {}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MxTimeout('timeout')), ms);
  });
  p.catch(() => undefined);
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
};

const code = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? '');

/**
 * Can this domain receive mail? MX first, then A/AAAA. Fails open: only a definite
 * "no such domain" or "no records" answer returns false. Timeouts, SERVFAIL and other
 * errors return true. A null MX (RFC 7505: "." exchange) returns false.
 */
export const domainAcceptsMail = async (domain: string, resolver: MxResolver, timeoutMs = MX_TIMEOUT_MS): Promise<boolean> => {
  const lookup = async (): Promise<boolean> => {
    try {
      const mx = await resolver.resolveMx(domain);
      if (mx.length) return !mx.every((r) => r.exchange === '' || r.exchange === '.');
    } catch (e) {
      if (code(e) === 'ENOTFOUND' || code(e) === 'NXDOMAIN') return false;
      if (!NO_RECORDS.has(code(e))) return true;
    }
    // No MX: an A or AAAA record means mail is delivered to the host itself.
    const settled = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);
    if (settled.some((r) => r.status === 'fulfilled' && r.value.length > 0)) return true;
    // Definitely no records → reject; any other failure (SERVFAIL, refused) → fail open.
    const definite = settled.every((r) => r.status === 'fulfilled' || NO_RECORDS.has(code(r.reason)));
    return !definite;
  };
  try {
    return await withTimeout(lookup(), timeoutMs);
  } catch {
    return true; // timeout or an unexpected resolver failure: fail open
  }
};

export type EmailCheck = 'ok' | 'syntax' | 'disposable' | 'undeliverable';

export interface EmailChecker {
  check(email: string): Promise<EmailCheck>;
}

export interface EmailCheckerOptions {
  resolver?: MxResolver;
  timeoutMs?: number;
  now?: () => number;
  /** Cache of domain verdicts, so repeat lookups are free. */
  cacheTtlMs?: number;
  cacheMax?: number;
}

/** Syntax, disposable list, then MX (cached per domain). */
export const createEmailChecker = (opts: EmailCheckerOptions = {}): EmailChecker => {
  const resolver: MxResolver = opts.resolver ?? dnsPromises;
  const now = opts.now ?? Date.now;
  const ttl = opts.cacheTtlMs ?? 60 * 60_000;
  const max = opts.cacheMax ?? 1_000;
  const cache = new Map<string, { ok: boolean; expires: number }>();
  return {
    async check(email) {
      const e = validEmail(email);
      if (!e) return 'syntax';
      const domain = emailDomain(e);
      if (isDisposableDomain(domain)) return 'disposable';
      const hit = cache.get(domain);
      let ok: boolean;
      if (hit && hit.expires > now()) ok = hit.ok;
      else {
        ok = await domainAcceptsMail(domain, resolver, opts.timeoutMs);
        cache.delete(domain);
        cache.set(domain, { ok, expires: now() + ttl });
        if (cache.size > max) cache.delete(cache.keys().next().value as string);
      }
      return ok ? 'ok' : 'undeliverable';
    },
  };
};
