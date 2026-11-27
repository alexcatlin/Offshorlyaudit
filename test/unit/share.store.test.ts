// Amendment 5 Phase 3: shared report store and snapshot builder.
import { existsSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AiResult, AuditReport, BuyerFitResult, SharedReport } from '../../shared/types.js';
import type { AuditEntry } from '../../server/routes/audit.js';
import { buildSnapshot, NotReadyError, pickAnswers, stripUrlQuery } from '../../server/share/snapshot.js';
import { createReportStore, FileReportStore, MEMORY_MAX_FILES, MEMORY_MAX_TOTAL_BYTES, MemoryReportStore, newShareId, SHARE_ID_RE } from '../../server/share/store.js';
import { deferred, sampleAi, sampleBuyerFit } from './_appMock.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-20T10:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'oa-share-'));

const baseReport = (over: Partial<AuditReport> = {}): AuditReport => ({
  auditId: 'audit_abcdefghijklmnopqrstuv',
  auditedAt: new Date(T0).toISOString(),
  url: 'https://acme.example/',
  domain: 'acme.example',
  pagesRead: [{ url: 'https://acme.example/', label: 'Homepage', title: 'Acme' }],
  aiStatus: 'pending',
  buyerFitStatus: 'pending',
  security: { score: 70, checks: [] },
  health: { score: 80, checks: [], measuredByGoogle: false },
  cms: { platform: 'unknown' },
  stack: [],
  fixFirst: [],
  attributions: [],
  ...over,
});

const snapshot = (over: Partial<SharedReport> = {}): SharedReport => {
  const { auditId: _a, ...report } = baseReport({ aiStatus: 'unavailable', buyerFitStatus: 'unavailable' });
  return {
    v: 1,
    shareId: newShareId(),
    createdAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 30 * DAY).toISOString(),
    report,
    answers: {},
    ...over,
  };
};

const open = (dir: string, over: Partial<Parameters<typeof FileReportStore.open>[1]> = {}) =>
  FileReportStore.open(dir, { retentionDays: 30, maxFiles: 100, now: () => T0, freeBytes: async () => 10 ** 12, ...over });

describe('FileReportStore', () => {
  it('round-trips a snapshot through an atomic 0600 file', async () => {
    const dir = tmp();
    const store = await open(dir);
    const s = snapshot();
    expect(await store.put(s)).toEqual({ ok: true });
    expect(await store.get(s.shareId)).toEqual(s);
    expect(statSync(join(dir, `${s.shareId}.json`)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(await store.count()).toBe(1);
    expect(await store.delete(s.shareId)).toBe(true);
    expect(await store.get(s.shareId)).toBeNull();
    expect(await store.delete(s.shareId)).toBe(false);
    store.close();
  });

  it('refuses bad ids before touching the filesystem (incl. ../x)', async () => {
    const dir = tmp();
    const store = await open(dir);
    for (const id of ['../x', '..%2Fx', 'a'.repeat(21), `${'a'.repeat(21)}/`, '', `../${'a'.repeat(19)}`]) {
      expect(SHARE_ID_RE.test(id)).toBe(false);
      expect(await store.get(id), id).toBeNull();
      expect(await store.delete(id), id).toBe(false);
      expect(await store.put(snapshot({ shareId: id })), id).toEqual({ ok: false, reason: 'bad_id' });
    }
    store.close();
  });

  it('get on an expired file deletes it and returns null', async () => {
    const dir = tmp();
    let now = T0;
    const store = await open(dir, { now: () => now });
    const s = snapshot();
    await store.put(s);
    now = T0 + 30 * DAY;
    expect(await store.get(s.shareId)).toBeNull();
    expect(existsSync(join(dir, `${s.shareId}.json`))).toBe(false);
    store.close();
  });

  it('sweep removes expired and unreadable files, keeps live ones', async () => {
    const dir = tmp();
    let now = T0;
    const store = await open(dir, { now: () => now });
    const old = snapshot({ createdAt: new Date(T0 - 31 * DAY).toISOString() });
    const live = snapshot();
    await store.put(old);
    await store.put(live);
    writeFileSync(join(dir, `${'b'.repeat(22)}.json`), 'not json');
    writeFileSync(join(dir, 'README'), 'ignored');
    // Only files older than the retention period are read: age the two candidates.
    const aged = (T0 - 31 * DAY) / 1000;
    utimesSync(join(dir, `${old.shareId}.json`), aged, aged);
    utimesSync(join(dir, `${'b'.repeat(22)}.json`), aged, aged);
    expect(await store.sweep()).toBe(2);
    expect(await store.count()).toBe(1);
    expect(await store.get(live.shareId)).not.toBeNull();
    expect(existsSync(join(dir, 'README'))).toBe(true);
    now += 1;
    store.close();
  });

  it('sweep skips (never parses) files modified within the retention period', async () => {
    const dir = tmp();
    const store = await open(dir, { now: () => T0 });
    const recentBad = `${'c'.repeat(22)}.json`;
    writeFileSync(join(dir, recentBad), 'not json');
    utimesSync(join(dir, recentBad), (T0 - DAY) / 1000, (T0 - DAY) / 1000);
    expect(await store.sweep()).toBe(0);
    expect(existsSync(join(dir, recentBad))).toBe(true);
    // Once older than the retention period it is a candidate, parsed and removed.
    utimesSync(join(dir, recentBad), (T0 - 31 * DAY) / 1000, (T0 - 31 * DAY) / 1000);
    expect(await store.sweep()).toBe(1);
    expect(existsSync(join(dir, recentBad))).toBe(false);
    store.close();
  });

  it('refuses at the file cap, below the free-space floor and above 100 KB', async () => {
    const dir = tmp();
    let free = 10 ** 12;
    const store = await open(dir, { maxFiles: 2, minFreeBytes: 150 * 1024 * 1024, freeBytes: async () => free });
    expect((await store.put(snapshot())).ok).toBe(true);
    expect((await store.put(snapshot())).ok).toBe(true);
    expect(await store.put(snapshot())).toEqual({ ok: false, reason: 'full' });
    const roomy = await open(tmp(), { minFreeBytes: 150 * 1024 * 1024, freeBytes: async () => free });
    free = 100 * 1024 * 1024;
    expect(await roomy.put(snapshot())).toEqual({ ok: false, reason: 'disk_low' });
    free = 10 ** 12;
    const big = snapshot();
    big.report.stack = Array.from({ length: 3000 }, (_, i) => ({ id: `t${i}`, name: 'x'.repeat(30), category: 'c' }));
    expect(await roomy.put(big)).toEqual({ ok: false, reason: 'too_large' });
    store.close();
    roomy.close();
  });
});

describe('MemoryReportStore', () => {
  it('round-trips, expires and caps like the file store', async () => {
    let now = T0;
    const store = new MemoryReportStore({ retentionDays: 30, maxFiles: 1, now: () => now });
    const s = snapshot();
    expect((await store.put(s)).ok).toBe(true);
    expect(await store.put(snapshot())).toEqual({ ok: false, reason: 'full' });
    expect(await store.get(s.shareId)).toEqual(s);
    now = T0 + 30 * DAY;
    expect(await store.get(s.shareId)).toBeNull();
  });

  it(`caps files at ${MEMORY_MAX_FILES} whatever SHARE_MAX_FILES says`, async () => {
    const store = new MemoryReportStore({ retentionDays: 30, maxFiles: 5000, now: () => T0 });
    for (let i = 0; i < MEMORY_MAX_FILES; i++) expect((await store.put(snapshot())).ok).toBe(true);
    expect(await store.put(snapshot())).toEqual({ ok: false, reason: 'full' });
  });

  it('refuses past the total-bytes budget (20 MB by default); delete and expiry free it', async () => {
    expect(MEMORY_MAX_TOTAL_BYTES).toBe(20 * 1024 * 1024);
    let now = T0;
    const one = Buffer.byteLength(JSON.stringify(snapshot()));
    const store = new MemoryReportStore({ retentionDays: 30, maxFiles: 100, now: () => now, maxTotalBytes: one * 2 + 10 });
    const a = snapshot();
    expect((await store.put(a)).ok).toBe(true);
    expect((await store.put(snapshot())).ok).toBe(true);
    expect(await store.put(snapshot())).toEqual({ ok: false, reason: 'full' });
    expect(await store.delete(a.shareId)).toBe(true);
    expect((await store.put(snapshot())).ok).toBe(true);
    now = T0 + 30 * DAY;
    expect((await store.put(snapshot({ createdAt: new Date(now).toISOString() }))).ok).toBe(true);
  });
});

describe('createReportStore', () => {
  const cfg = (over: Partial<Parameters<typeof createReportStore>[0]> = {}): Parameters<typeof createReportStore>[0] => ({
    shareLinks: 'on',
    reportsDir: null,
    shareRetentionDays: 30,
    shareMaxFiles: 5000,
    shareMinFreeMb: 0,
    isProduction: false,
    ...over,
  });

  it('SHARE_LINKS=off → null; no dir → memory (warned in production)', async () => {
    expect(await createReportStore(cfg({ shareLinks: 'off' }), () => undefined)).toBeNull();
    const logs: string[] = [];
    const s = await createReportStore(cfg({ isProduction: true, shareMaxFiles: 5000 }), (_l, msg) => logs.push(msg));
    expect(s?.kind).toBe('memory');
    // The memory fallback uses its own cap, not shareMaxFiles.
    for (let i = 0; i < MEMORY_MAX_FILES; i++) await s!.put(snapshot());
    expect(await s!.put(snapshot())).toEqual({ ok: false, reason: 'full' });
    expect(logs.join()).toContain('REPORTS_DIR is not set');
  });

  it('unwritable dir → memory plus an error log', async () => {
    const file = join(tmp(), 'file');
    writeFileSync(file, 'x');
    const logs: string[] = [];
    const s = await createReportStore(cfg({ reportsDir: join(file, 'reports') }), (_l, msg) => logs.push(msg));
    expect(s?.kind).toBe('memory');
    expect(logs).toContain('share store unavailable, using memory');
    const prod = await createReportStore(cfg({ reportsDir: '/nonexistent-mount-oa/reports', isProduction: true }), () => undefined);
    expect(prod?.kind).toBe('memory');
  });

  it('a writable dir → disk; production creates one level under an existing mount', async () => {
    const s = await createReportStore(cfg({ reportsDir: join(tmp(), 'a', 'reports') }), () => undefined);
    expect(s?.kind).toBe('disk');
    s?.close();
    const mount = tmp();
    const p = await createReportStore(cfg({ reportsDir: join(mount, 'reports'), isProduction: true }), () => undefined);
    expect(p?.kind).toBe('disk');
    expect(existsSync(join(mount, 'reports'))).toBe(true);
    p?.close();
  });
});

describe('buildSnapshot', () => {
  const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
    report: baseReport(),
    buyerFit: Promise.resolve<BuyerFitResult>({ auditId: 'x', buyerFitStatus: 'ok', buyerFit: sampleBuyerFit(), fixFirst: [] }),
    ai: Promise.resolve<AiResult>({ auditId: 'x', aiStatus: 'ok', ai: sampleAi() }),
    request: {
      url: 'https://acme.example/?utm_source=mail&token=secret',
      timeSink: 'chasing invoices',
      tools: 'Xero',
      teamSize: '11-50',
      region: 'europe',
      industry: 'legal',
      businessType: 'Law firm',
      persona: { role: 'Founder' },
    },
    ...over,
  });

  it('strips auditId, merges settled results and keeps only the answer subset', async () => {
    const s = await buildSnapshot(entry(), { shareId: 'S'.repeat(22), now: T0, retentionDays: 30 });
    expect('auditId' in s.report).toBe(false);
    expect(JSON.stringify(s)).not.toContain('audit_abcdefghijklmnopqrstuv');
    expect(s.report.aiStatus).toBe('ok');
    expect(s.report.buyerFitStatus).toBe('ok');
    expect(s.answers).toEqual({ timeSink: 'chasing invoices', tools: 'Xero', teamSize: '11-50', industry: 'legal', businessType: 'Law firm' });
    expect(s.answers).not.toHaveProperty('region');
    expect(JSON.stringify(s)).not.toContain('europe');
    expect(JSON.stringify(s)).not.toContain('Founder');
    expect(JSON.stringify(s)).not.toContain('utm_source');
    expect(s.createdAt).toBe(new Date(T0).toISOString());
    expect(s.expiresAt).toBe(new Date(T0 + 30 * DAY).toISOString());
  });

  it('holds no email or "@" even when the visitor typed one (route redacts answers; snapshot never sees lead fields)', async () => {
    const s = await buildSnapshot(entry(), { shareId: 'S'.repeat(22), now: T0, retentionDays: 30 });
    expect(JSON.stringify(s)).not.toContain('@');
  });

  it('a result with no promise and status pending → unavailable', async () => {
    const s = await buildSnapshot(entry({ buyerFit: null, ai: null }), { shareId: 'S'.repeat(22), now: T0, retentionDays: 30 });
    expect(s.report.aiStatus).toBe('unavailable');
    expect(s.report.buyerFitStatus).toBe('unavailable');
  });

  it('still pending after the wait → NotReadyError', async () => {
    const never = deferred<AiResult>();
    await expect(buildSnapshot(entry({ ai: never.promise }), { shareId: 'S'.repeat(22), now: T0, retentionDays: 30, waitMs: 20 })).rejects.toBeInstanceOf(NotReadyError);
  });

  it('pickAnswers ignores missing fields; stripUrlQuery removes query and hash everywhere the URL appears', () => {
    expect(pickAnswers(undefined)).toEqual({});
    expect(pickAnswers({ url: 'x' })).toEqual({});
    const { auditId: _a, ...r } = baseReport({ url: 'https://a.example/?q=1#h', pagesRead: [{ url: 'https://a.example/?q=1#h', label: 'Homepage', title: 't' }] });
    const out = stripUrlQuery(r);
    expect(out.url).toBe('https://a.example/');
    expect(out.pagesRead[0]?.url).toBe('https://a.example/');
  });
});
