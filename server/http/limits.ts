// In-memory controls for one instance (PLAN Phase 7): sliding-window per-key limiter,
// global daily counter, concurrency semaphore, and a TTL LRU cache with in-flight dedupe.
// Every piece takes an injected clock so tests can move time.

export type Clock = () => number;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// ---------- Sliding-window limiter ----------

export interface LimitWindow {
  ms: number;
  max: number;
}

export type LimitResult = { ok: true } | { ok: false; retryAfterSec: number };

export interface SlidingWindowOptions {
  windows: LimitWindow[];
  now?: Clock;
  /** Upper bound on tracked keys; the least recently used key is dropped beyond it. */
  maxKeys?: number;
}

export class SlidingWindowLimiter {
  private readonly windows: LimitWindow[];
  private readonly now: Clock;
  private readonly maxKeys: number;
  private readonly longest: number;
  private readonly hits = new Map<string, number[]>();

  constructor(opts: SlidingWindowOptions) {
    if (!opts.windows.length) throw new Error('SlidingWindowLimiter needs at least one window');
    this.windows = opts.windows;
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 50_000;
    this.longest = Math.max(...opts.windows.map((w) => w.ms));
  }

  /** Records a hit when every window has room; otherwise reports when to retry. */
  hit(key: string): LimitResult {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((ts) => ts > t - this.longest);
    let retryMs = 0;
    for (const w of this.windows) {
      const inWindow = list.filter((ts) => ts > t - w.ms);
      if (inWindow.length >= w.max) {
        // The window frees a slot when its oldest counted hit (that keeps it full) expires.
        const freeing = inWindow[inWindow.length - w.max]!;
        retryMs = Math.max(retryMs, freeing + w.ms - t);
      }
    }
    if (retryMs > 0) {
      this.store(key, list);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) };
    }
    list.push(t);
    this.store(key, list);
    return { ok: true };
  }

  /** Gives back the most recent hit for `key` (e.g. the request was refused as busy). */
  refund(key: string): void {
    const list = this.hits.get(key);
    if (!list?.length) return;
    list.pop();
    if (!list.length) this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }

  private store(key: string, list: number[]): void {
    this.hits.delete(key);
    if (!list.length) return;
    this.hits.set(key, list);
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}

// ---------- Global daily counter ----------

/** Counts uses per UTC calendar day; resets at midnight UTC. */
export class DailyCounter {
  private day = '';
  private count = 0;
  constructor(
    private readonly max: number,
    private readonly now: Clock = Date.now,
  ) {}

  private roll(): void {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.count = 0;
    }
  }

  /** Takes `n` units (default one) if that many remain today; all or none. */
  tryTake(n = 1): boolean {
    this.roll();
    if (this.count + n > this.max) return false;
    this.count += n;
    return true;
  }

  /** Gives back `n` units taken today (e.g. the action was refused further on). */
  refund(n = 1): void {
    this.roll();
    this.count = Math.max(0, this.count - n);
  }

  get used(): number {
    this.roll();
    return this.count;
  }
}

// ---------- Semaphore ----------

/** Non-blocking: callers that can't get a slot are told "busy" rather than queued. */
export class Semaphore {
  private active = 0;
  constructor(private readonly max: number) {}

  /** A release function, or null when all slots are taken. Release is idempotent. */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.max) return null;
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }

  /**
   * All `n` slots at once or none: `n` independent release functions (each idempotent), or
   * null when fewer than `n` slots are free.
   */
  tryAcquireMany(n: number): Array<() => void> | null {
    if (this.active + n > this.max) return null;
    const releases: Array<() => void> = [];
    for (let i = 0; i < n; i++) releases.push(this.tryAcquire()!);
    return releases;
  }

  get inUse(): number {
    return this.active;
  }
}

// ---------- TTL LRU cache with in-flight dedupe ----------

export interface TtlLruOptions {
  ttlMs: number;
  maxEntries: number;
  now?: Clock;
}

export class TtlLruCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();
  private readonly inflight = new Map<string, Promise<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: Clock;

  constructor(opts: TtlLruOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency (not expiry).
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  /** Like get, without refreshing recency. */
  peek(key: string): V | undefined {
    const e = this.map.get(key);
    return e && e.expires > this.now() ? e.value : undefined;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
    this.evict();
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Cached value, or the result of `create`. Concurrent calls for the same key share one
   * `create` run. Rejections are not cached. `hit` is true for a cached value or a shared run.
   */
  async getOrCreate(key: string, create: () => Promise<V>): Promise<{ value: V; hit: boolean }> {
    const cached = this.get(key);
    if (cached !== undefined) return { value: cached, hit: true };
    const running = this.inflight.get(key);
    if (running) return { value: await running, hit: true };
    const p = (async () => create())();
    this.inflight.set(key, p);
    try {
      const value = await p;
      this.set(key, value);
      return { value, hit: false };
    } finally {
      this.inflight.delete(key);
    }
  }

  /** True while a create() for this key is running. */
  isInFlight(key: string): boolean {
    return this.inflight.has(key);
  }

  private evict(): void {
    const t = this.now();
    for (const [k, e] of this.map) {
      if (e.expires <= t) this.map.delete(k);
    }
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
