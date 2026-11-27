// Spec 001: the daily counter store. Fake clock, temp dir, no network.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COUNTER_NAMES, createMetricsStore, FileMetricsStore, MemoryMetricsStore } from '../../server/metrics/store.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-11-24T10:00:00Z');

describe('MemoryMetricsStore', () => {
  it('increments by UTC day and rolls over at midnight', () => {
    let t = T0;
    const s = new MemoryMetricsStore({ now: () => t });
    s.inc('audit_run');
    s.inc('audit_run');
    t += DAY;
    s.inc('audit_run');
    const days = s.range('2026-11-24', '2026-11-25');
    expect(days.get('2026-11-24')?.audit_run).toBe(2);
    expect(days.get('2026-11-25')?.audit_run).toBe(1);
  });

  it('ignores unknown names, negative and non-finite amounts (nothing identifying can be stored)', () => {
    const s = new MemoryMetricsStore({ now: () => T0 });
    s.inc('someone@example.com');
    s.inc('click.direct.not-a-placement');
    s.inc('audit_run', -1);
    s.inc('audit_run', Number.NaN);
    expect(s.range('2026-11-24', '2026-11-24').size).toBe(0);
  });

  it('adds cost with a count, and skips unknown (null) or negative cost', () => {
    const s = new MemoryMetricsStore({ now: () => T0 });
    s.addCost(0.5);
    s.addCost(0.25);
    s.addCost(null);
    s.addCost(-1);
    const d = s.range('2026-11-24', '2026-11-24').get('2026-11-24')!;
    expect(d.cost_usd_sum).toBeCloseTo(0.75);
    expect(d.cost_n).toBe(2);
  });

  it('range is inclusive, ordered and excludes other days', () => {
    let t = T0;
    const s = new MemoryMetricsStore({ now: () => t });
    for (let i = 0; i < 4; i++, t += DAY) s.inc('report_view');
    expect([...s.range('2026-11-25', '2026-11-26').keys()]).toEqual(['2026-11-25', '2026-11-26']);
  });

  it('has a counter for every direct and shared placement', () => {
    for (const n of ['click.direct.ai-top', 'click.direct.blocked', 'click.shared.audit-link', 'click.shared.ai-top']) {
      expect(COUNTER_NAMES).toContain(n);
    }
  });
});

describe('FileMetricsStore', () => {
  it('writes on close and reloads the same counts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'metrics-'));
    const path = join(dir, 'm.json');
    const a = await FileMetricsStore.open(path, { now: () => T0, flushMs: 60_000 });
    a.inc('click.direct.ai-top', 3);
    a.addCost(0.1);
    await a.close();
    const raw = JSON.parse(await readFile(path, 'utf8')) as { v: number; days: Record<string, Record<string, number>> };
    expect(raw.v).toBe(1);
    expect(Object.values(raw.days).every((d) => Object.values(d).every((n) => typeof n === 'number'))).toBe(true);
    const b = await FileMetricsStore.open(path, { now: () => T0 });
    expect(b.range('2026-11-24', '2026-11-24').get('2026-11-24')?.['click.direct.ai-top']).toBe(3);
    await b.close();
  });

  it('flushes by itself after the interval', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'metrics-'));
    const path = join(dir, 'm.json');
    const s = await FileMetricsStore.open(path, { now: () => T0, flushMs: 20 });
    s.inc('audit_run');
    await new Promise((r) => setTimeout(r, 120));
    expect(await readFile(path, 'utf8')).toContain('"audit_run":1');
    await s.close();
  });

  it('starts empty on a corrupt file and drops unknown keys, bad days and days past retention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'metrics-'));
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{not json');
    const s1 = await FileMetricsStore.open(bad, { now: () => T0 });
    expect(s1.range('2000-01-01', '2100-01-01').size).toBe(0);
    await s1.close();

    const mixed = join(dir, 'mixed.json');
    await writeFile(
      mixed,
      JSON.stringify({
        v: 1,
        days: {
          '2026-11-24': { audit_run: 2, 'x@y.z': 5, report_view: -1 },
          '2024-01-01': { audit_run: 9 },
          'not-a-day': { audit_run: 1 },
        },
      }),
    );
    const s2 = await FileMetricsStore.open(mixed, { now: () => T0 });
    const all = s2.range('2000-01-01', '2100-01-01');
    expect([...all.keys()]).toEqual(['2026-11-24']);
    expect(all.get('2026-11-24')).toEqual({ audit_run: 2 });
    await s2.close();
  });

  it('createMetricsStore: no path or an unwritable path falls back to memory', async () => {
    const logs: string[] = [];
    const log = (_l: string, m: string) => void logs.push(m);
    expect((await createMetricsStore({ metricsPath: null, isProduction: true }, log)).kind).toBe('memory');
    expect(logs.some((m) => m.includes('METRICS_PATH is not set'))).toBe(true);
    expect((await createMetricsStore({ metricsPath: '/proc/nope/m.json', isProduction: true }, log)).kind).toBe('memory');
    expect(logs.some((m) => m.includes('unavailable'))).toBe(true);
  });
});
