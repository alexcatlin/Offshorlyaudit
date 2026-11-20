import { describe, expect, it } from 'vitest';
import { DAY, DailyCounter, HOUR, Semaphore, SlidingWindowLimiter, TtlLruCache } from '../../server/http/limits.js';
import { rateLimitSubject } from '../../server/http/security.js';

const clock = (start = Date.UTC(2026, 10, 20, 10, 0, 0)) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('SlidingWindowLimiter', () => {
  it('allows 5 per hour, then reports when the oldest hit expires', () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: 5 }, { ms: DAY, max: 20 }], now: c.now });
    for (let i = 0; i < 5; i++) {
      expect(l.hit('ip').ok).toBe(true);
      c.advance(60_000);
    }
    const blocked = l.hit('ip');
    expect(blocked).toEqual({ ok: false, retryAfterSec: 55 * 60 });
    expect(l.hit('other').ok).toBe(true);
    c.advance(55 * 60_000 + 1);
    expect(l.hit('ip').ok).toBe(true);
  });

  it('a blocked attempt does not consume a slot', () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: 1 }], now: c.now });
    expect(l.hit('ip').ok).toBe(true);
    for (let i = 0; i < 3; i++) expect(l.hit('ip').ok).toBe(false);
    c.advance(HOUR + 1);
    expect(l.hit('ip').ok).toBe(true);
  });

  it('enforces the daily window across hours', () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: 5 }, { ms: DAY, max: 20 }], now: c.now });
    for (let h = 0; h < 4; h++) {
      for (let i = 0; i < 5; i++) expect(l.hit('ip').ok).toBe(true);
      c.advance(HOUR);
    }
    const r = l.hit('ip');
    expect(r.ok).toBe(false);
    // The first hit (4 h ago) frees the daily window 20 h from now.
    expect(r.ok === false && r.retryAfterSec).toBe(20 * 3600);
    c.advance(20 * HOUR + 1);
    expect(l.hit('ip').ok).toBe(true);
  });

  it('caps tracked keys', () => {
    const l = new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: 1 }], maxKeys: 3 });
    for (const k of ['a', 'b', 'c', 'd']) l.hit(k);
    expect(l.size).toBe(3);
  });
});

describe('DailyCounter', () => {
  it('caps per UTC day and resets at midnight', () => {
    const c = clock(Date.UTC(2026, 10, 20, 23, 0, 0));
    const d = new DailyCounter(2, c.now);
    expect(d.tryTake()).toBe(true);
    expect(d.tryTake()).toBe(true);
    expect(d.tryTake()).toBe(false);
    expect(d.used).toBe(2);
    c.advance(HOUR);
    expect(d.tryTake()).toBe(true);
    expect(d.used).toBe(1);
  });

  it('a cap of 0 never allows AI', () => {
    expect(new DailyCounter(0).tryTake()).toBe(false);
  });
});

describe('Semaphore', () => {
  it('hands out up to max slots; release is idempotent', () => {
    const s = new Semaphore(2);
    const a = s.tryAcquire();
    const b = s.tryAcquire();
    expect(a && b).toBeTruthy();
    expect(s.tryAcquire()).toBeNull();
    a!();
    a!();
    expect(s.inUse).toBe(1);
    expect(s.tryAcquire()).not.toBeNull();
    expect(s.tryAcquire()).toBeNull();
  });
});

describe('TtlLruCache', () => {
  it('expires entries after the TTL', () => {
    const c = clock();
    const cache = new TtlLruCache<number>({ ttlMs: 1000, maxEntries: 10, now: c.now });
    cache.set('a', 1);
    c.advance(999);
    expect(cache.get('a')).toBe(1);
    c.advance(1);
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the least recently used beyond maxEntries', () => {
    const cache = new TtlLruCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // a is now most recent
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
  });

  it('dedupes concurrent creates and caches the result', async () => {
    const cache = new TtlLruCache<string>({ ttlMs: 60_000, maxEntries: 10 });
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const create = async () => {
      runs++;
      await gate;
      return 'v';
    };
    const p1 = cache.getOrCreate('k', create);
    const p2 = cache.getOrCreate('k', create);
    expect(cache.isInFlight('k')).toBe(true);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(runs).toBe(1);
    expect(r1).toEqual({ value: 'v', hit: false });
    expect(r2).toEqual({ value: 'v', hit: true });
    expect(await cache.getOrCreate('k', create)).toEqual({ value: 'v', hit: true });
    expect(runs).toBe(1);
  });

  it('does not cache rejections', async () => {
    const cache = new TtlLruCache<string>({ ttlMs: 60_000, maxEntries: 10 });
    await expect(cache.getOrCreate('k', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(cache.isInFlight('k')).toBe(false);
    expect(await cache.getOrCreate('k', async () => 'ok')).toEqual({ value: 'ok', hit: false });
  });
});

describe('refund and peek', () => {
  it('refund gives back the latest hit', () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ windows: [{ ms: HOUR, max: 1 }], now: c.now });
    expect(l.hit('ip').ok).toBe(true);
    l.refund('ip');
    expect(l.hit('ip').ok).toBe(true);
    expect(l.hit('ip').ok).toBe(false);
    l.refund('nobody'); // no-op
  });

  it('peek reads without refreshing recency or returning expired values', () => {
    const c = clock();
    const cache = new TtlLruCache<string>({ ttlMs: HOUR, maxEntries: 2, now: c.now });
    cache.set('a', '1');
    cache.set('b', '2');
    expect(cache.peek('a')).toBe('1');
    cache.set('c', '3'); // a was not refreshed by peek, so it is evicted
    expect(cache.peek('a')).toBeUndefined();
    c.advance(HOUR + 1);
    expect(cache.peek('b')).toBeUndefined();
  });
});

describe('rateLimitSubject', () => {
  it('buckets IPv6 to /64, unwraps mapped IPv4, keeps IPv4', () => {
    expect(rateLimitSubject('203.0.113.5')).toBe('203.0.113.5');
    expect(rateLimitSubject('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(rateLimitSubject('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitSubject('2001:0db8:0001:0002:ffff:abcd:1234:9')).toBe('2001:db8:1:2::/64');
    expect(rateLimitSubject('2001:db8:1:3::1')).not.toBe(rateLimitSubject('2001:db8:1:2::1'));
    expect(rateLimitSubject(undefined)).toBe('unknown');
  });
});
