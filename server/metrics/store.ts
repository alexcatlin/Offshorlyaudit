// Daily counters (spec 001): how many audits ran, reports were viewed, booking buttons clicked,
// what the AI did and what it cost. Integers (and one cost sum) per UTC day, so no email, domain,
// session, audit id or IP can ever be stored here: the keys come from a fixed list.
//
// File shape: {"v":1,"days":{"2026-11-24":{"audit_run":12,"click.direct.ai":3,"cost_usd_sum":0.84}}}
// Written to a tmp file and renamed, at most every FLUSH_MS and on close.
// ponytail: counts since the last flush (up to 30 s) are lost on a crash; one JSONL append per
// event would make it exact. Single process only (the disk stores assume one instance too).
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DIRECT_PLACEMENTS, SHARED_PLACEMENTS } from '../../shared/types.js';

const PLAIN = [
  'audit_run',
  'report_view',
  'shared_view',
  'ai_attempted',
  'ai_finished',
  'industry_known',
  'industry_with_examples',
  'cost_usd_sum',
  'cost_n',
] as const;

export const COUNTER_NAMES: readonly string[] = [
  ...PLAIN,
  ...DIRECT_PLACEMENTS.map((p) => `click.direct.${p}`),
  'click.direct.blocked',
  ...SHARED_PLACEMENTS.map((p) => `click.shared.${p}`),
];

const COUNTER_SET: ReadonlySet<string> = new Set(COUNTER_NAMES);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
export const METRICS_RETENTION_DAYS = 365;
export const METRICS_FLUSH_MS = 30_000;

export type DayCounts = Record<string, number>;
export type MetricsLog = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

export interface MetricsStore {
  readonly kind: 'disk' | 'memory';
  /** Adds to a counter. Never throws; an unknown name is ignored. */
  inc(name: string, by?: number): void;
  /** One audit's estimated AI cost: adds to cost_usd_sum and cost_n. A null or negative cost is skipped. */
  addCost(usd: number | null): void;
  /** Days from `from` to `to` inclusive (UTC, YYYY-MM-DD) that have any counts. */
  range(from: string, to: string): Map<string, DayCounts>;
  close(): Promise<void>;
}

const sanitiseDays = (raw: unknown): Map<string, DayCounts> => {
  const out = new Map<string, DayCounts>();
  const days = raw && typeof raw === 'object' ? (raw as { days?: unknown }).days : null;
  if (!days || typeof days !== 'object') return out;
  for (const [day, counts] of Object.entries(days)) {
    if (!DAY_RE.test(day) || !counts || typeof counts !== 'object') continue;
    const clean: DayCounts = {};
    for (const [k, v] of Object.entries(counts)) {
      if (COUNTER_SET.has(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0) clean[k] = v;
    }
    if (Object.keys(clean).length) out.set(day, clean);
  }
  return out;
};

export class MemoryMetricsStore implements MetricsStore {
  readonly kind: 'disk' | 'memory' = 'memory';
  protected readonly days = new Map<string, DayCounts>();
  protected readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  protected touched(): void {
    return undefined;
  }

  inc(name: string, by = 1): void {
    if (!COUNTER_SET.has(name) || !Number.isFinite(by) || by < 0) return;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const counts = this.days.get(day) ?? {};
    counts[name] = (counts[name] ?? 0) + by;
    this.days.set(day, counts);
    this.touched();
  }

  addCost(usd: number | null): void {
    if (usd === null || !Number.isFinite(usd) || usd < 0) return;
    this.inc('cost_usd_sum', usd);
    this.inc('cost_n');
  }

  range(from: string, to: string): Map<string, DayCounts> {
    const out = new Map<string, DayCounts>();
    for (const [day, counts] of [...this.days].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (day >= from && day <= to) out.set(day, { ...counts });
    }
    return out;
  }

  async close(): Promise<void> {
    return undefined;
  }
}

export class FileMetricsStore extends MemoryMetricsStore {
  override readonly kind = 'disk' as const;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly log: MetricsLog,
    opts: { now?: () => number; flushMs?: number },
    private readonly flushMs: number,
  ) {
    super(opts);
  }

  /** Loads the file (starting empty when it is missing or unreadable). Throws only when the directory is not writable. */
  static async open(path: string, opts: { now?: () => number; flushMs?: number; log?: MetricsLog } = {}): Promise<FileMetricsStore> {
    const store = new FileMetricsStore(path, opts.log ?? (() => undefined), opts, opts.flushMs ?? METRICS_FLUSH_MS);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    let text = '';
    try {
      text = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') this.log('warn', 'metrics file unreadable, starting empty', { error: (e as { code?: string }).code ?? (e as Error).name });
    }
    let parsed: unknown = null;
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        this.log('warn', 'metrics file is not valid JSON, starting empty');
      }
    }
    const cutoff = new Date(this.now() - METRICS_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
    for (const [day, counts] of sanitiseDays(parsed)) if (day >= cutoff) this.days.set(day, counts);
    // Fail early (caller falls back to memory) when the directory cannot be written.
    await this.write();
    this.log('info', 'metrics loaded', { days: this.days.size });
  }

  private async write(): Promise<void> {
    const body = JSON.stringify({ v: 1, days: Object.fromEntries(this.days) });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, this.path);
  }

  protected override touched(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  /** Writes now. Never throws; a failure is logged and the counts stay in memory. */
  flush(): Promise<void> {
    const run = this.chain.then(() => this.write());
    this.chain = run.catch((e: unknown) => this.log('error', 'metrics write failed', { error: (e as { code?: string }).code ?? (e as Error).name }));
    return this.chain;
  }

  override async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}

export interface MetricsConfig {
  metricsPath: string | null;
  isProduction: boolean;
}

/** Same policy as createFeedbackStore: unset → memory (warned in production); unwritable → memory plus an error log. */
export const createMetricsStore = async (config: MetricsConfig, log: MetricsLog, now?: () => number): Promise<MetricsStore> => {
  const opts = { ...(now ? { now } : {}) };
  if (!config.metricsPath) {
    if (config.isProduction) log('warn', 'METRICS_PATH is not set: counters are in memory and reset on every deploy');
    return new MemoryMetricsStore(opts);
  }
  try {
    const dir = dirname(config.metricsPath);
    if (!config.isProduction) await mkdir(dir, { recursive: true });
    await access(dir, fsConstants.W_OK);
    return await FileMetricsStore.open(config.metricsPath, { ...opts, log });
  } catch (e) {
    log('error', 'metrics store unavailable, using memory', { error: (e as { code?: string }).code ?? (e as Error).name });
    return new MemoryMetricsStore(opts);
  }
};
