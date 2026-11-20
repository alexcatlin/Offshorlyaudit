// Shared report store (Amendment 5 Phase 3): one JSON file per shared report on the Render
// disk (/var/data/reports/<shareId>.json). Saved only when the visitor clicks Share.
//
// - The id is checked against SHARE_ID_RE before any path join, so no input reaches the
//   filesystem as a path segment.
// - Atomic writes: <id>.json.tmp (0600), then rename.
// - Expiry comes from `createdAt` inside the file. Sweep at boot and hourly (unref'd timer);
//   a get() on an expired file deletes it and returns null.
// - put() refuses when the file count is at the cap, free space is below the floor or the
//   snapshot is larger than maxBytes. Audits and the ledger are unaffected by a refusal.
// - The memory fallback caps itself at MEMORY_MAX_FILES (200) and MEMORY_MAX_TOTAL_BYTES (20 MB):
//   it shares the instance's RAM, so SHARE_MAX_FILES (sized for the disk) would be far too many.
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SharedReport } from '../../shared/types.js';

export const SHARE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const FILE_RE = /^([A-Za-z0-9_-]{22})\.json$/;
const TMP_RE = /^[A-Za-z0-9_-]{22}\.json\.tmp$/;

export const SHARE_MAX_BYTES = 100_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
/** A .tmp file older than this was left by a crash mid-write. */
const STALE_TMP_MS = 10 * 60 * 1000;
/** The in-memory store holds far fewer reports than the disk: it shares the instance's RAM. */
export const MEMORY_MAX_FILES = 200;
export const MEMORY_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export const newShareId = (): string => randomBytes(16).toString('base64url');

export type PutRefusal = 'full' | 'disk_low' | 'too_large' | 'bad_id' | 'io';
export type PutResult = { ok: true } | { ok: false; reason: PutRefusal };

export interface ReportStore {
  readonly kind: 'disk' | 'memory';
  put(report: SharedReport): Promise<PutResult>;
  get(shareId: string): Promise<SharedReport | null>;
  /** True when something was removed. */
  delete(shareId: string): Promise<boolean>;
  /** Removes expired (and unreadable) entries; returns how many. */
  sweep(): Promise<number>;
  count(): Promise<number>;
  close(): void;
}

export type ShareLog = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

export interface StoreOptions {
  retentionDays: number;
  maxFiles: number;
  /** Free-space floor on the disk (bytes). */
  minFreeBytes?: number;
  maxBytes?: number;
  now?: () => number;
  /** Test seam for free space: bytes available to us. */
  freeBytes?: (dir: string) => Promise<number>;
  log?: ShareLog;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Shape check for a stored snapshot (our own files, but a disk can hold anything). */
export const parseSharedReport = (text: string, expectId: string): SharedReport | null => {
  try {
    const o = JSON.parse(text) as unknown;
    if (!isObj(o) || o.v !== 1 || o.shareId !== expectId || typeof o.createdAt !== 'string' || typeof o.expiresAt !== 'string') return null;
    if (!Number.isFinite(Date.parse(o.createdAt)) || !isObj(o.report) || !isObj(o.answers)) return null;
    if ('auditId' in o.report) return null;
    return o as unknown as SharedReport;
  } catch {
    return null;
  }
};

const defaultFreeBytes = async (dir: string): Promise<number> => {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
};

const errCode = (e: unknown): string => (e as { code?: string }).code ?? (e as Error).name;

export class MemoryReportStore implements ReportStore {
  readonly kind: 'disk' | 'memory' = 'memory';
  private readonly map = new Map<string, { json: string; bytes: number; createdAt: number }>();
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly maxTotalBytes: number;
  private totalBytes = 0;

  /** maxFiles is capped at MEMORY_MAX_FILES; the total is capped at maxTotalBytes (20 MB). */
  constructor(opts: StoreOptions & { maxTotalBytes?: number }) {
    this.retentionMs = opts.retentionDays * DAY_MS;
    this.now = opts.now ?? Date.now;
    this.maxFiles = Math.min(opts.maxFiles, MEMORY_MAX_FILES);
    this.maxBytes = opts.maxBytes ?? SHARE_MAX_BYTES;
    this.maxTotalBytes = opts.maxTotalBytes ?? MEMORY_MAX_TOTAL_BYTES;
  }

  private remove(id: string): boolean {
    const e = this.map.get(id);
    if (!e) return false;
    this.totalBytes -= e.bytes;
    return this.map.delete(id);
  }

  async put(report: SharedReport): Promise<PutResult> {
    if (!SHARE_ID_RE.test(report.shareId)) return { ok: false, reason: 'bad_id' };
    const json = JSON.stringify(report);
    const bytes = Buffer.byteLength(json);
    if (bytes > this.maxBytes) return { ok: false, reason: 'too_large' };
    const prev = this.map.get(report.shareId);
    if (!prev && (await this.count()) >= this.maxFiles) return { ok: false, reason: 'full' };
    if (this.totalBytes - (prev?.bytes ?? 0) + bytes > this.maxTotalBytes) return { ok: false, reason: 'full' };
    this.remove(report.shareId);
    this.map.set(report.shareId, { json, bytes, createdAt: Date.parse(report.createdAt) });
    this.totalBytes += bytes;
    return { ok: true };
  }

  async get(shareId: string): Promise<SharedReport | null> {
    if (!SHARE_ID_RE.test(shareId)) return null;
    const e = this.map.get(shareId);
    if (!e) return null;
    if (e.createdAt + this.retentionMs <= this.now()) {
      this.remove(shareId);
      return null;
    }
    return parseSharedReport(e.json, shareId);
  }

  async delete(shareId: string): Promise<boolean> {
    if (!SHARE_ID_RE.test(shareId)) return false;
    return this.remove(shareId);
  }

  async sweep(): Promise<number> {
    let n = 0;
    const t = this.now();
    for (const [id, e] of this.map) {
      if (e.createdAt + this.retentionMs <= t) {
        this.remove(id);
        n++;
      }
    }
    return n;
  }

  async count(): Promise<number> {
    await this.sweep();
    return this.map.size;
  }

  close(): void {}
}

export class FileReportStore implements ReportStore {
  readonly kind = 'disk' as const;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly minFreeBytes: number;
  private readonly freeBytes: (dir: string) => Promise<number>;
  private readonly log: ShareLog;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dir: string,
    opts: StoreOptions,
  ) {
    this.retentionMs = opts.retentionDays * DAY_MS;
    this.now = opts.now ?? Date.now;
    this.maxFiles = opts.maxFiles;
    this.maxBytes = opts.maxBytes ?? SHARE_MAX_BYTES;
    this.minFreeBytes = opts.minFreeBytes ?? 0;
    this.freeBytes = opts.freeBytes ?? defaultFreeBytes;
    this.log = opts.log ?? (() => undefined);
  }

  /** Checks the directory is writable, sweeps once and starts the hourly sweep. */
  static async open(dir: string, opts: StoreOptions): Promise<FileReportStore> {
    await access(dir, fsConstants.W_OK);
    // Probe a real write: access() can pass on a read-only mount.
    const probe = join(dir, '.write-probe');
    await writeFile(probe, '', { mode: 0o600 });
    await rm(probe, { force: true });
    const store = new FileReportStore(dir, opts);
    const removed = await store.sweep();
    store.log('info', 'share store ready', { files: await store.count(), removed });
    store.timer = setInterval(() => {
      store.sweep().catch((e) => store.log('error', 'share sweep failed', { error: errCode(e) }));
    }, SWEEP_EVERY_MS);
    store.timer.unref();
    return store;
  }

  /** Only ever called with an id that passed SHARE_ID_RE. */
  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private expired(createdAt: string): boolean {
    const t = Date.parse(createdAt);
    return !Number.isFinite(t) || t + this.retentionMs <= this.now();
  }

  async put(report: SharedReport): Promise<PutResult> {
    const id = report.shareId;
    if (!SHARE_ID_RE.test(id)) return { ok: false, reason: 'bad_id' };
    const json = JSON.stringify(report);
    if (Buffer.byteLength(json) > this.maxBytes) return { ok: false, reason: 'too_large' };
    try {
      if ((await this.count()) >= this.maxFiles) return { ok: false, reason: 'full' };
      if ((await this.freeBytes(this.dir)) < this.minFreeBytes) return { ok: false, reason: 'disk_low' };
      const tmp = `${this.file(id)}.tmp`;
      await writeFile(tmp, json, { mode: 0o600 });
      await rename(tmp, this.file(id));
      return { ok: true };
    } catch (e) {
      this.log('error', 'share write failed', { error: errCode(e) });
      return { ok: false, reason: 'io' };
    }
  }

  async get(shareId: string): Promise<SharedReport | null> {
    if (!SHARE_ID_RE.test(shareId)) return null;
    let text: string;
    try {
      text = await readFile(this.file(shareId), 'utf8');
    } catch {
      return null;
    }
    const r = parseSharedReport(text, shareId);
    if (!r || this.expired(r.createdAt)) {
      await rm(this.file(shareId), { force: true }).catch(() => undefined);
      return null;
    }
    return r;
  }

  async delete(shareId: string): Promise<boolean> {
    if (!SHARE_ID_RE.test(shareId)) return false;
    try {
      await stat(this.file(shareId));
    } catch {
      return false;
    }
    await rm(this.file(shareId), { force: true });
    return true;
  }

  /**
   * Removes expired and unreadable files plus stale .tmp files. A file modified within the
   * retention period can't hold an expired snapshot (createdAt ≤ write time), so only older
   * files are read and parsed; the boot sweep therefore costs one stat per file.
   */
  async sweep(): Promise<number> {
    let removed = 0;
    const t = this.now();
    for (const name of await readdir(this.dir)) {
      const m = FILE_RE.exec(name);
      if (m) {
        const id = m[1]!;
        let keep = false;
        try {
          if ((await stat(this.file(id))).mtimeMs + this.retentionMs > t) continue;
          const r = parseSharedReport(await readFile(this.file(id), 'utf8'), id);
          keep = !!r && !this.expired(r.createdAt);
        } catch {
          keep = false;
        }
        if (!keep) {
          await rm(this.file(id), { force: true }).catch(() => undefined);
          removed++;
        }
      } else if (TMP_RE.test(name)) {
        const p = join(this.dir, name);
        try {
          if ((await stat(p)).mtimeMs < t - STALE_TMP_MS) await rm(p, { force: true });
        } catch {
          // gone already
        }
      }
    }
    return removed;
  }

  async count(): Promise<number> {
    return (await readdir(this.dir)).filter((n) => FILE_RE.test(n)).length;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export interface ShareConfig {
  shareLinks: 'on' | 'off';
  reportsDir: string | null;
  shareRetentionDays: number;
  shareMaxFiles: number;
  shareMinFreeMb: number;
  isProduction: boolean;
}

/**
 * SHARE_LINKS=off → null (share and email hidden). REPORTS_DIR unset → memory (warned in
 * production). Missing or unwritable → memory plus an error log, like createLedger. Outside
 * production the directory is created.
 */
export const createReportStore = async (
  config: ShareConfig,
  log: ShareLog,
  extra: Pick<StoreOptions, 'now' | 'freeBytes'> = {},
): Promise<ReportStore | null> => {
  if (config.shareLinks === 'off') return null;
  const opts: StoreOptions = {
    retentionDays: config.shareRetentionDays,
    maxFiles: config.shareMaxFiles,
    minFreeBytes: config.shareMinFreeMb * 1024 * 1024,
    log,
    ...extra,
  };
  if (!config.reportsDir) {
    if (config.isProduction) log('warn', 'REPORTS_DIR is not set: shared reports are in memory and vanish on every deploy');
    return new MemoryReportStore(opts);
  }
  try {
    if (!config.isProduction) await mkdir(config.reportsDir, { recursive: true, mode: 0o700 });
    else {
      // The reports directory sits inside the mount, so the first deploy must create it. Only
      // one level, and only when the parent (the mount) is writable: a missing mount still
      // falls back to memory instead of writing to the container's ephemeral disk.
      await access(dirname(config.reportsDir), fsConstants.W_OK);
      await mkdir(config.reportsDir, { mode: 0o700 }).catch((e: unknown) => {
        if (errCode(e) !== 'EEXIST') throw e;
      });
    }
    return await FileReportStore.open(config.reportsDir, opts);
  } catch (e) {
    log('error', 'share store unavailable, using memory', { error: errCode(e) });
    return new MemoryReportStore(opts);
  }
};
