// Idea feedback (Amendment 5 Phase 2): one JSONL line per Useful / Not useful click.
//
// Line v1: {"v":1,"t":"ISO","a":"<auditId>","s":"<sha256(session)[0:12]>","i":0,"vote":"up|down|clear",
//   "src":"site|industry","svc":"ai-automation","pat":"legal.intake"|null,"ind":"legal"|null,
//   "dom":"example.com","title":"≤80 chars","ex":0}
// No email, no email hash, no IP. Last vote per (s, i) wins: memory keeps only that line and the
// boot rewrite compacts the file to it.
//
// The append chain and the boot load/prune follow server/lead/ledger.ts (copied, not shared):
// the file is created 0600, torn or unparseable lines are skipped, lines past the retention
// period are dropped and the file is rewritten (tmp file + rename) at boot. Fail open: a failed
// append is logged and the line is kept in memory; the route still answers 204.
import { constants as fsConstants } from 'node:fs';
import { access, appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type FeedbackVote = 'up' | 'down' | 'clear';

export interface FeedbackLine {
  v: 1;
  t: string;
  a: string;
  s: string;
  i: number;
  vote: FeedbackVote;
  src: 'site' | 'industry';
  svc: string;
  pat: string | null;
  ind: string | null;
  dom: string;
  title: string;
  ex: number;
}

export interface FeedbackStore {
  readonly kind: 'disk' | 'memory';
  /** Never throws: failures are logged and the line is kept in memory. */
  append(line: FeedbackLine): Promise<void>;
  /** The latest retained line per (session hash, idea index), oldest first. */
  list(): FeedbackLine[];
  close(): Promise<void>;
}

export type FeedbackLog = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Memory bound on (session, idea) keys: the oldest are dropped beyond it (the file keeps them
 * until the next boot prune).
 */
export const FEEDBACK_MAX_LINES = 50_000;

const VOTES: readonly FeedbackVote[] = ['up', 'down', 'clear'];
const HASH_RE = /^[0-9a-f]{12}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

export const parseFeedbackLine = (line: string): FeedbackLine | null => {
  try {
    const o = JSON.parse(line) as Partial<FeedbackLine>;
    if (o.v !== 1 || !isStr(o.t, 40) || !Number.isFinite(Date.parse(o.t))) return null;
    if (!isStr(o.a, 64) || !ID_RE.test(o.a) || !isStr(o.s, 12) || !HASH_RE.test(o.s)) return null;
    if (typeof o.i !== 'number' || !Number.isInteger(o.i) || o.i < 0 || o.i > 99) return null;
    if (!VOTES.includes(o.vote as FeedbackVote) || (o.src !== 'site' && o.src !== 'industry')) return null;
    if (!isStr(o.svc, 64) || !isStr(o.dom, 253) || !isStr(o.title, 80)) return null;
    if (o.pat !== null && !isStr(o.pat, 64)) return null;
    if (o.ind !== null && !isStr(o.ind, 64)) return null;
    const ex = typeof o.ex === 'number' && Number.isInteger(o.ex) && o.ex >= 0 ? o.ex : 0;
    return { v: 1, t: o.t, a: o.a, s: o.s, i: o.i, vote: o.vote as FeedbackVote, src: o.src, svc: o.svc, pat: o.pat ?? null, ind: o.ind ?? null, dom: o.dom, title: o.title, ex };
  } catch {
    return null;
  }
};

const toText = (l: FeedbackLine): string => `${JSON.stringify(l)}\n`;

/**
 * Memory keeps only the last vote per (session hash, idea index): the CSV reads nothing else.
 * Map order is "last written": a key is deleted and re-set on every vote, so the oldest
 * vote sits at the front and expiry and the size bound both trim from there.
 */
export class MemoryFeedbackStore implements FeedbackStore {
  readonly kind: 'disk' | 'memory' = 'memory';
  protected readonly lines = new Map<string, FeedbackLine>();
  protected readonly now: () => number;
  protected readonly retentionMs: number;
  protected readonly maxLines: number;

  constructor(opts: { now?: () => number; retentionDays?: number; maxLines?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.retentionMs = (opts.retentionDays ?? 365) * DAY_MS;
    this.maxLines = opts.maxLines ?? FEEDBACK_MAX_LINES;
  }

  /** Keeps the line; returns how many older votes the size bound dropped to make room. */
  protected keep(line: FeedbackLine): number {
    const key = `${line.s}:${line.i}`;
    this.lines.delete(key);
    this.lines.set(key, line);
    let dropped = 0;
    for (const k of this.lines.keys()) {
      if (this.lines.size <= this.maxLines) break;
      this.lines.delete(k);
      dropped++;
    }
    return dropped;
  }

  async append(line: FeedbackLine): Promise<void> {
    this.keep(line);
  }

  list(): FeedbackLine[] {
    const cutoff = this.now() - this.retentionMs;
    // Votes are kept in time order, so expired ones sit at the front.
    for (const [k, l] of this.lines) {
      if (Date.parse(l.t) >= cutoff) break;
      this.lines.delete(k);
    }
    return [...this.lines.values()];
  }

  async close(): Promise<void> {}
}

export class FileFeedbackStore extends MemoryFeedbackStore {
  override readonly kind = 'disk' as const;
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly log: FeedbackLog,
    opts: { now?: () => number; retentionDays?: number; maxLines?: number },
  ) {
    super(opts);
  }

  /** Loads the file (creating it if missing). Throws when it can't be read or written. */
  static async open(path: string, opts: { now?: () => number; retentionDays?: number; maxLines?: number; log?: FeedbackLog } = {}): Promise<FileFeedbackStore> {
    const store = new FileFeedbackStore(path, opts.log ?? (() => undefined), opts);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    const fh = await open(this.path, 'a', 0o600);
    await fh.close();
    const text = await readFile(this.path, 'utf8');
    const cutoff = this.now() - this.retentionMs;
    let skipped = 0;
    let expired = 0;
    let read = 0;
    let overBound = 0;
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      const l = parseFeedbackLine(raw);
      if (!l) {
        skipped++;
        continue;
      }
      if (Date.parse(l.t) < cutoff) {
        expired++;
        continue;
      }
      read++;
      overBound += this.keep(l);
    }
    const torn = text.length > 0 && !text.endsWith('\n');
    // Superseded votes (and any beyond the size bound) are compacted away too.
    const superseded = read - this.lines.size - overBound;
    if (overBound) {
      // Votes beyond FEEDBACK_MAX_LINES are lost for good once the file is rewritten below.
      this.log('warn', 'feedback over the size bound: oldest votes dropped', { dropped: overBound, max: this.maxLines });
    }
    if (expired || skipped || torn || superseded || overBound) {
      const tmp = `${this.path}.tmp`;
      // The rewrite keeps only the latest vote per (session, idea), like memory.
      await writeFile(tmp, [...this.lines.values()].map(toText).join(''), { mode: 0o600 });
      await rename(tmp, this.path);
    }
    this.log('info', 'feedback loaded', { lines: this.lines.size, skipped, expired, superseded });
  }

  override async append(line: FeedbackLine): Promise<void> {
    this.keep(line);
    const write = this.chain.then(() => appendFile(this.path, toText(line)));
    this.chain = write.catch(() => undefined);
    try {
      await write;
    } catch (e) {
      this.log('error', 'feedback append failed', { error: (e as { code?: string }).code ?? (e as Error).name });
    }
  }

  override async close(): Promise<void> {
    await this.chain;
  }
}

export interface FeedbackConfig {
  feedbackPath: string | null;
  feedbackRetentionDays: number;
  isProduction: boolean;
}

/** Same policy as createLedger: unset → memory (warned in production); unwritable → memory plus an error log. */
export const createFeedbackStore = async (config: FeedbackConfig, log: FeedbackLog, now?: () => number): Promise<FeedbackStore> => {
  const opts = { retentionDays: config.feedbackRetentionDays, log, ...(now ? { now } : {}) };
  if (!config.feedbackPath) {
    if (config.isProduction) log('warn', 'FEEDBACK_PATH is not set: idea feedback is in memory and resets on every deploy');
    return new MemoryFeedbackStore(opts);
  }
  try {
    const dir = dirname(config.feedbackPath);
    if (!config.isProduction) await mkdir(dir, { recursive: true });
    await access(dir, fsConstants.W_OK);
    return await FileFeedbackStore.open(config.feedbackPath, opts);
  } catch (e) {
    log('error', 'feedback store unavailable, using memory', { error: (e as { code?: string }).code ?? (e as Error).name });
    return new MemoryFeedbackStore(opts);
  }
};

/** Last vote per (session hash, idea index) wins; cleared votes drop out. Order: first occurrence in the input. */
export const latestVotes = (lines: readonly FeedbackLine[]): FeedbackLine[] => {
  const byKey = new Map<string, FeedbackLine>();
  for (const l of lines) byKey.set(`${l.s}:${l.i}`, l);
  return [...byKey.values()].filter((l) => l.vote !== 'clear');
};

const CSV_COLUMNS = ['date', 'domain', 'industry', 'source', 'service', 'pattern', 'title', 'vote', 'sourcesCited'] as const;

/** CSV-injection guard: a cell starting with = + - @ tab or CR gets a leading apostrophe. */
export const csvCell = (value: string | number | null): string => {
  let s = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const feedbackCsv = (lines: readonly FeedbackLine[]): string => {
  const rows = latestVotes(lines).map((l) =>
    [l.t, l.dom, l.ind, l.src, l.svc, l.pat, l.title, l.vote, l.ex].map(csvCell).join(','),
  );
  return `${[CSV_COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
};
