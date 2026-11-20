// Amendment 5 Phase 2: per-response session tokens.
import { describe, expect, it } from 'vitest';
import { createSessionStore, newSessionToken, SESSION_RE } from '../../server/http/sessions.js';
import type { NewSession } from '../../server/http/sessions.js';
import type { AuditEntry } from '../../server/routes/audit.js';

const entry = { report: { auditId: 'a1' }, buyerFit: null, ai: null } as unknown as AuditEntry;
const data = (): NewSession => ({ entry, emailKey: '0'.repeat(32), allowlisted: false, marketingOptIn: false });

describe('session tokens', () => {
  it('are 22 base64url characters, random, and match SESSION_RE', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = newSessionToken();
      expect(t).toMatch(SESSION_RE);
      expect(t).toHaveLength(22);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
  });

  it('SESSION_RE rejects other shapes', () => {
    for (const bad of ['', 'a'.repeat(21), 'a'.repeat(23), `${'a'.repeat(21)}/`, `${'a'.repeat(21)}.`, `../${'a'.repeat(19)}`]) {
      expect(SESSION_RE.test(bad), bad).toBe(false);
    }
  });
});

describe('createSessionStore', () => {
  it('stores and returns a session; unknown, malformed or non-string tokens → undefined', () => {
    const store = createSessionStore({ ttlMs: 1000 });
    const t = store.create(data());
    const s = store.get(t);
    expect(s?.entry).toBe(entry);
    expect(s?.emailSent).toBe(false);
    expect(s?.shareId).toBeUndefined();
    expect(store.get(newSessionToken())).toBeUndefined();
    expect(store.get('not a token')).toBeUndefined();
    expect(store.get(42)).toBeUndefined();
    expect(store.get(undefined)).toBeUndefined();
  });

  it('expires after the TTL', () => {
    let now = 1_000;
    const store = createSessionStore({ ttlMs: 24 * 3_600_000, now: () => now });
    const t = store.create(data());
    expect(store.get(t)?.createdAt).toBe(1_000);
    now += 24 * 3_600_000 - 1;
    expect(store.get(t)).toBeDefined();
    now += 1;
    expect(store.get(t)).toBeUndefined();
  });

  it('is capped: the least recently used session is dropped beyond max', () => {
    const store = createSessionStore({ ttlMs: 60_000, max: 3 });
    const [a, b, c] = [store.create(data()), store.create(data()), store.create(data())];
    store.get(a); // a is now most recent
    const d = store.create(data());
    expect(store.size).toBe(3);
    expect(store.get(b)).toBeUndefined();
    for (const t of [a, c, d]) expect(store.get(t)).toBeDefined();
  });

  it('defaults to 500 entries', () => {
    const store = createSessionStore({ ttlMs: 60_000 });
    for (let i = 0; i < 520; i++) store.create(data());
    expect(store.size).toBe(500);
  });
});
