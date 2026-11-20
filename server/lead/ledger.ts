// The one-audit-per-email record (Amendment 3 §2): key = HMAC of the canonical address,
// value = the domain(s) audited and when. Pseudonymous: no address is ever stored here.
//
// FileLedger: an append-only JSONL file on the Render persistent disk, loaded into a Map at
// boot. One line per record, v1: {"v":1,"k":"<32 hex>","d":["example.com"],"t":"<ISO>"}.
// Later lines for the same key add domains. Unparseable lines (a torn last write) are
// skipped; entries past the retention period are dropped and the file is rewritten
// (tmp file + rename) at boot.
//
// Failure policy is fail open: a broken store must not block a lead-gen widget. The route
// treats a throwing get() as "allowed"; a failed append is logged and kept in memory.
import { constants as fsConstants } from 'node:fs';
import { access, appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LedgerEntry {
  domains: string[];
  /** ms since epoch of the latest record. */
  at: number;
}

export interface AuditLedger {
  readonly kind: 'disk' | 'memory';
  /** May throw: the caller fails open. */
  get(key: string): Promise<LedgerEntry | null>;
  record(key: string, domains: string[]): Promise<{ created: boolean }>;
  close(): Promise<void>;
}

export type LedgerLog = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^[0-9a-f]{32}$/;

const merge = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

/** True when the visitor may audit `domain` again under this entry. */
export const ledgerAllows = (entry: LedgerEntry | null, domain: string): boolean => !entry || entry.domains.includes(domain);

export class MemoryLedger implements AuditLedger {
  readonly kind: 'disk' | 'memory' = 'memory';
  protected readonly map = new Map<string, LedgerEntry>();
  protected readonly now: () => number;
  protected readonly retentionMs: number;

  constructor(opts: { now?: () => number; retentionDays?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.retentionMs = (opts.retentionDays ?? 365) * DAY_MS;
  }

  async get(key: string): Promise<LedgerEntry | null> {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.at < this.now() - this.retentionMs) {
      this.map.delete(key);
      return null;
    }
    return { domains: [...e.domains], at: e.at };
  }

  /** Updates memory; returns the line to persist, or null when nothing changed. */
  protected put(key: string, domains: string[]): { created: boolean; changed: boolean; entry: LedgerEntry } {
    const at = this.now();
    const prev = this.map.get(key);
    const live = prev && prev.at >= at - this.retentionMs ? prev : undefined;
    const next = merge(live?.domains ?? [], domains);
    const changed = !live || next.length !== live.domains.length;
    const entry = { domains: next, at: changed ? at : live.at };
    this.map.set(key, entry);
    return { created: !live, changed, entry };
  }

  async record(key: string, domains: string[]): Promise<{ created: boolean }> {
    return { created: this.put(key, domains).created };
  }

  async close(): Promise<void> {}
}

interface LedgerLine {
  v: 1;
  k: string;
  d: string[];
  t: string;
}

const parseLine = (line: string): { key: string; domains: string[]; at: number } | null => {
  try {
    const o = JSON.parse(line) as Partial<LedgerLine>;
    if (o.v !== 1 || typeof o.k !== 'string' || !KEY_RE.test(o.k) || !Array.isArray(o.d) || typeof o.t !== 'string') return null;
    const at = Date.parse(o.t);
    if (!Number.isFinite(at)) return null;
    const domains = o.d.filter((d): d is string => typeof d === 'string' && d.length > 0 && d.length <= 253);
    return { key: o.k, domains, at };
  } catch {
    return null;
  }
};

const toLine = (key: string, e: LedgerEntry): string =>
  `${JSON.stringify({ v: 1, k: key, d: e.domains, t: new Date(e.at).toISOString() } satisfies LedgerLine)}\n`;

export class FileLedger extends MemoryLedger {
  override readonly kind = 'disk' as const;
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly log: LedgerLog,
    opts: { now?: () => number; retentionDays?: number },
  ) {
    super(opts);
  }

  /**
   * Loads the file (creating it if missing). Throws when the file can't be read or written;
   * createLedger turns that into a MemoryLedger.
   */
  static async open(path: string, opts: { now?: () => number; retentionDays?: number; log?: LedgerLog } = {}): Promise<FileLedger> {
    const log: LedgerLog = opts.log ?? (() => undefined);
    const ledger = new FileLedger(path, log, opts);
    await ledger.load();
    return ledger;
  }

  private async load(): Promise<void> {
    // Fail now (not on the first audit) if the file can't be created or appended to.
    // 0600: the file holds pseudonymous keys only, but no one else on the host needs to read it.
    const fh = await open(this.path, 'a', 0o600);
    await fh.close();
    const text = await readFile(this.path, 'utf8');
    const cutoff = this.now() - this.retentionMs;
    let skipped = 0;
    let expired = 0;
    let lines = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      lines++;
      const r = parseLine(line);
      if (!r) {
        skipped++;
        continue;
      }
      const prev = this.map.get(r.key);
      this.map.set(r.key, { domains: merge(prev?.domains ?? [], r.domains), at: Math.max(prev?.at ?? 0, r.at) });
    }
    for (const [k, e] of this.map) {
      if (e.at < cutoff) {
        this.map.delete(k);
        expired++;
      }
    }
    // Rewrite when anything was dropped, or the file doesn't end in a newline (a torn write
    // that the next append would otherwise run into).
    const torn = text.length > 0 && !text.endsWith('\n');
    if (expired || skipped || torn || (lines > this.map.size * 2 && lines > 100)) {
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, [...this.map].map(([k, e]) => toLine(k, e)).join(''), { mode: 0o600 });
      await rename(tmp, this.path);
    }
    this.log('info', 'ledger loaded', { entries: this.map.size, skipped, expired });
  }

  override async record(key: string, domains: string[]): Promise<{ created: boolean }> {
    const { created, changed, entry } = this.put(key, domains);
    if (!changed) return { created };
    const line = toLine(key, entry);
    // Serialised: one append at a time, in order.
    const write = this.chain.then(() => appendFile(this.path, line));
    this.chain = write.catch(() => undefined);
    try {
      await write;
    } catch (e) {
      this.log('error', 'ledger append failed', { error: (e as { code?: string }).code ?? (e as Error).name });
    }
    return { created };
  }

  override async close(): Promise<void> {
    await this.chain;
  }
}

export interface LedgerConfig {
  ledgerPath: string | null;
  ledgerRetentionDays: number;
  isProduction: boolean;
}

/**
 * LEDGER_PATH unset → MemoryLedger (warned in production). Outside production the parent
 * directory is created; in production a missing or unwritable directory means the disk is
 * not mounted, which is logged as an error and falls back to memory.
 */
export const createLedger = async (config: LedgerConfig, log: LedgerLog, now?: () => number): Promise<AuditLedger> => {
  const opts = { retentionDays: config.ledgerRetentionDays, log, ...(now ? { now } : {}) };
  if (!config.ledgerPath) {
    if (config.isProduction) log('warn', 'LEDGER_PATH is not set: the one-audit-per-email record is in memory and resets on every deploy');
    return new MemoryLedger(opts);
  }
  try {
    const dir = dirname(config.ledgerPath);
    if (!config.isProduction) await mkdir(dir, { recursive: true });
    await access(dir, fsConstants.W_OK);
    return await FileLedger.open(config.ledgerPath, opts);
  } catch (e) {
    log('error', 'ledger unavailable, using memory', { error: (e as { code?: string }).code ?? (e as Error).name });
    return new MemoryLedger(opts);
  }
};
