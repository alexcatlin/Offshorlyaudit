import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLedger, FileLedger, ledgerAllows, MemoryLedger } from '../../server/lead/ledger.js';
import type { LedgerLog } from '../../server/lead/ledger.js';

const K1 = 'a'.repeat(32);
const K2 = 'b'.repeat(32);
const DAY = 24 * 60 * 60 * 1000;
const tmp = () => mkdtempSync(join(tmpdir(), 'oa-ledger-'));
const quiet: LedgerLog = () => undefined;
const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean);

describe('FileLedger', () => {
  it('record → a new instance reloads it; v1 JSONL line shape', async () => {
    const path = join(tmp(), 'ledger.jsonl');
    const a = await FileLedger.open(path, { log: quiet });
    expect(await a.record(K1, ['acme.example', 'www-less.example'])).toEqual({ created: true });
    expect(await a.record(K1, ['acme.example'])).toEqual({ created: false });
    await a.close();
    expect(lines(path)).toHaveLength(1);
    const line = JSON.parse(lines(path)[0]!);
    expect(line).toMatchObject({ v: 1, k: K1, d: ['acme.example', 'www-less.example'] });
    expect(Date.parse(line.t)).toBeGreaterThan(0);

    const b = await FileLedger.open(path, { log: quiet });
    expect(b.kind).toBe('disk');
    expect(await b.get(K1)).toMatchObject({ domains: ['acme.example', 'www-less.example'] });
    expect(await b.get(K2)).toBeNull();
    // A new domain for the same key merges.
    await b.record(K1, ['other.example']);
    await b.close();
    const c = await FileLedger.open(path, { log: quiet });
    expect((await c.get(K1))?.domains).toEqual(['acme.example', 'www-less.example', 'other.example']);
  });

  it('creates a missing ledger file with mode 0600', async () => {
    const path = join(tmp(), 'ledger.jsonl');
    const l = await FileLedger.open(path, { log: quiet });
    await l.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('skips a torn last line and rewrites the file so the next append is clean', async () => {
    const path = join(tmp(), 'ledger.jsonl');
    const t = new Date().toISOString();
    writeFileSync(path, `${JSON.stringify({ v: 1, k: K1, d: ['acme.example'], t })}\n{"v":1,"k":"${K2}","d":["x`);
    const l = await FileLedger.open(path, { log: quiet });
    expect(await l.get(K1)).not.toBeNull();
    expect(await l.get(K2)).toBeNull();
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
    await l.record(K2, ['b.example']);
    await l.close();
    const again = await FileLedger.open(path, { log: quiet });
    expect(await again.get(K2)).not.toBeNull();
  });

  it('prunes entries past the retention period and rewrites the file', async () => {
    const path = join(tmp(), 'ledger.jsonl');
    const now = Date.parse('2026-11-20T10:00:00Z');
    const old = new Date(now - 400 * DAY).toISOString();
    const fresh = new Date(now - 10 * DAY).toISOString();
    writeFileSync(path, `${JSON.stringify({ v: 1, k: K1, d: ['old.example'], t: old })}\n${JSON.stringify({ v: 1, k: K2, d: ['new.example'], t: fresh })}\n`);
    const l = await FileLedger.open(path, { log: quiet, now: () => now, retentionDays: 365 });
    expect(await l.get(K1)).toBeNull();
    expect(await l.get(K2)).not.toBeNull();
    expect(lines(path)).toHaveLength(1);
    expect(lines(path)[0]).toContain(K2);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('serialises concurrent appends: every record lands on its own line', async () => {
    const path = join(tmp(), 'ledger.jsonl');
    const l = await FileLedger.open(path, { log: quiet });
    const keys = Array.from({ length: 50 }, (_, i) => i.toString(16).padStart(32, '0'));
    await Promise.all(keys.map((k, i) => l.record(k, [`site${i}.example`])));
    await l.close();
    const parsed = lines(path).map((x) => JSON.parse(x) as { k: string });
    expect(parsed.map((p) => p.k).sort()).toEqual([...keys].sort());
  });

  it('a failed append is logged and kept in memory', async () => {
    const dir = tmp();
    const path = join(dir, 'ledger.jsonl');
    const logs: string[] = [];
    const l = await FileLedger.open(path, { log: (_lvl, msg) => logs.push(msg) });
    chmodSync(path, 0o400);
    try {
      expect(await l.record(K1, ['acme.example'])).toEqual({ created: true });
      expect(await l.get(K1)).not.toBeNull();
      // Root ignores file modes; only assert the log when the append really failed.
      if (lines(path).length === 0) expect(logs).toContain('ledger append failed');
    } finally {
      chmodSync(path, 0o600);
    }
  });
});

describe('createLedger', () => {
  it('no LEDGER_PATH → memory', async () => {
    const l = await createLedger({ ledgerPath: null, ledgerRetentionDays: 365, isProduction: false }, quiet);
    expect(l.kind).toBe('memory');
  });

  it('outside production the directory is created → disk', async () => {
    const path = join(tmp(), 'nested', 'dir', 'ledger.jsonl');
    const l = await createLedger({ ledgerPath: path, ledgerRetentionDays: 365, isProduction: false }, quiet);
    expect(l.kind).toBe('disk');
  });

  it('production with a missing directory (disk not mounted) → memory, logged as an error', async () => {
    const logs: [string, string][] = [];
    const path = join(tmp(), 'missing', 'ledger.jsonl');
    const l = await createLedger({ ledgerPath: path, ledgerRetentionDays: 365, isProduction: true }, (lvl, msg) => logs.push([lvl, msg]));
    expect(l.kind).toBe('memory');
    expect(logs).toContainEqual(['error', 'ledger unavailable, using memory']);
  });

  it('unwritable path → memory', async () => {
    const dir = tmp();
    // A directory where the file should be: open(…, 'a') fails.
    const path = join(dir, 'ledger.jsonl');
    mkdirSync(path);
    const l = await createLedger({ ledgerPath: path, ledgerRetentionDays: 365, isProduction: false }, quiet);
    expect(l.kind).toBe('memory');
  });
});

describe('MemoryLedger and ledgerAllows', () => {
  it('records, merges, expires and answers the gate question', async () => {
    let now = 1_000 * DAY;
    const l = new MemoryLedger({ now: () => now, retentionDays: 30 });
    expect(await l.record(K1, ['a.example'])).toEqual({ created: true });
    const e = await l.get(K1);
    expect(ledgerAllows(e, 'a.example')).toBe(true);
    expect(ledgerAllows(e, 'b.example')).toBe(false);
    expect(ledgerAllows(null, 'b.example')).toBe(true);
    now += 31 * DAY;
    expect(await l.get(K1)).toBeNull();
  });
});
