// Per-response session tokens (Amendment 5, cross-cutting decision 3).
//
// A cache hit hands the same auditId to several visitors, so auditId is never a capability.
// Every 200 from POST /api/audit gets its own 128-bit token instead; share, email and feedback
// act through it. The token travels in JSON bodies only (never a URL, never a log line). Sessions
// live in memory: after a restart they are gone and the routes answer 410 session_expired.
import { randomBytes } from 'node:crypto';
import type { AuditEntry } from '../routes/audit.js';
import { TtlLruCache } from './limits.js';
import type { Clock } from './limits.js';

/** 16 random bytes, base64url: exactly 22 characters. */
export const SESSION_RE = /^[A-Za-z0-9_-]{22}$/;

export const SESSION_MAX_ENTRIES = 500;

export const newSessionToken = (): string => randomBytes(16).toString('base64url');

export interface AuditSession {
  entry: AuditEntry;
  /** HMAC gate key of the visitor's email (never the address). For Phase 4's recipient check. */
  emailKey: string;
  allowlisted: boolean;
  marketingOptIn: boolean;
  /** Set once this session created a share link; cleared on delete. */
  shareId?: string;
  shareExpiresAt?: string;
  emailSent: boolean;
  /** Feedback lines written through this session (POST /api/feedback caps it). */
  feedbackWrites: number;
  createdAt: number;
}

export type NewSession = Omit<AuditSession, 'createdAt' | 'emailSent' | 'feedbackWrites' | 'shareId' | 'shareExpiresAt'>;

export interface SessionStore {
  /** Stores a new session and returns its token. */
  create(data: NewSession): string;
  /** The live session, or undefined (unknown, expired, evicted or malformed token). */
  get(token: unknown): AuditSession | undefined;
  readonly size: number;
}

export const createSessionStore = (opts: { ttlMs: number; max?: number; now?: Clock }): SessionStore => {
  const now = opts.now ?? Date.now;
  const cache = new TtlLruCache<AuditSession>({ ttlMs: opts.ttlMs, maxEntries: opts.max ?? SESSION_MAX_ENTRIES, now });
  return {
    create(data) {
      const token = newSessionToken();
      cache.set(token, { ...data, emailSent: false, feedbackWrites: 0, createdAt: now() });
      return token;
    },
    get(token) {
      if (typeof token !== 'string' || !SESSION_RE.test(token)) return undefined;
      return cache.get(token);
    },
    get size() {
      return cache.size;
    },
  };
};
