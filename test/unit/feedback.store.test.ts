// Amendment 5 Phase 2: idea feedback JSONL store and CSV export.
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFeedbackStore,
  csvCell,
  FEEDBACK_MAX_LINES,
  feedbackCsv,
  FileFeedbackStore,
  latestVotes,
  MemoryFeedbackStore,
  parseFeedbackLine,
} from '../../server/feedback/store.js';
import type { FeedbackLine } from '../../server/feedback/store.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-20T10:00:00Z');

const line = (over: Partial<FeedbackLine> = {}): FeedbackLine => ({
  v: 1,
  t: new Date(T0).toISOString(),
  a: 'audit_abcdefghijklmnopqrstuv',
  s: 'abcdef012345',
  i: 0,
  vote: 'up',
  src: 'site',
  svc: 'ai-automation',
  pat: null,
  ind: 'legal',
  dom: 'example.com',
  title: 'Triage incoming enquiries',
  ex: 0,
  ...over,
});

const tmp = () => mkdtempSync(join(tmpdir(), 'oa-fb-'));

describe('parseFeedbackLine', () => {
  it('round-trips a valid line and rejects malformed ones', () => {
    const l = line({ pat: 'legal.intake', src: 'industry', vote: 'clear' });
    expect(parseFeedbackLine(JSON.stringify(l))).toEqual(l);
    for (const bad of ['{', 'null', JSON.stringify({ ...l, v: 2 }), JSON.stringify({ ...l, s: 'nothex' }), JSON.stringify({ ...l, vote: 'maybe' }), JSON.stringify({ ...l, i: -1 }), JSON.stringify({ ...l, title: 'x'.repeat(81) })]) {
      expect(parseFeedbackLine(bad), bad).toBeNull();
    }
  });
});

describe('FileFeedbackStore', () => {
  it('appends lines (0600) and reloads them', async () => {
    const path = join(tmp(), 'fb.jsonl');
    const a = await FileFeedbackStore.open(path, { now: () => T0 });
    await a.append(line());
    await a.append(line({ i: 1, vote: 'down' }));
    await a.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    const b = await FileFeedbackStore.open(path, { now: () => T0 });
    expect(b.kind).toBe('disk');
    expect(b.list().map((l) => [l.i, l.vote])).toEqual([
      [0, 'up'],
      [1, 'down'],
    ]);
  });

  it('skips a torn last line and rewrites the file so the next append starts clean', async () => {
    const path = join(tmp(), 'fb.jsonl');
    writeFileSync(path, `${JSON.stringify(line())}\n{"v":1,"t":"2026-11-`);
    const logs: string[] = [];
    const s = await FileFeedbackStore.open(path, { now: () => T0, log: (_l, msg, extra) => logs.push(`${msg} ${JSON.stringify(extra)}`) });
    expect(s.list()).toHaveLength(1);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
    await s.append(line({ i: 2 }));
    const again = await FileFeedbackStore.open(path, { now: () => T0 });
    expect(again.list()).toHaveLength(2);
    expect(logs.join()).toContain('"skipped":1');
  });

  it('compacts superseded votes at boot', async () => {
    const path = join(tmp(), 'fb.jsonl');
    writeFileSync(path, [line({ vote: 'up' }), line({ vote: 'down' }), line({ i: 1 }), line({ vote: 'clear' })].map((l) => `${JSON.stringify(l)}\n`).join(''));
    const s = await FileFeedbackStore.open(path, { now: () => T0 });
    expect(s.list().map((l) => [l.i, l.vote])).toEqual([
      [1, 'up'],
      [0, 'clear'],
    ]);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('prunes lines past the retention period at boot', async () => {
    const path = join(tmp(), 'fb.jsonl');
    writeFileSync(path, [line({ t: new Date(T0 - 400 * DAY).toISOString() }), line({ i: 1 })].map((l) => `${JSON.stringify(l)}\n`).join(''));
    const s = await FileFeedbackStore.open(path, { now: () => T0, retentionDays: 365 });
    expect(s.list().map((l) => l.i)).toEqual([1]);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('a failed append is logged, kept in memory and never throws', async () => {
    const dir = tmp();
    const path = join(dir, 'fb.jsonl');
    const logs: string[] = [];
    const s = await FileFeedbackStore.open(path, { now: () => T0, log: (_l, msg) => logs.push(msg) });
    chmodSync(path, 0o400);
    try {
      await expect(s.append(line())).resolves.toBeUndefined();
    } finally {
      chmodSync(path, 0o600);
    }
    expect(s.list()).toHaveLength(1);
    if (process.getuid?.() !== 0) expect(logs).toContain('feedback append failed');
  });
});

describe('createFeedbackStore', () => {
  it('no path → memory (warned in production)', async () => {
    const logs: string[] = [];
    const s = await createFeedbackStore({ feedbackPath: null, feedbackRetentionDays: 365, isProduction: true }, (_l, msg) => logs.push(msg));
    expect(s.kind).toBe('memory');
    expect(logs.join()).toContain('FEEDBACK_PATH is not set');
  });

  it('unwritable location → memory plus an error log', async () => {
    const dir = tmp();
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    const logs: string[] = [];
    const s = await createFeedbackStore({ feedbackPath: join(file, 'fb.jsonl'), feedbackRetentionDays: 365, isProduction: false }, (_l, msg) => logs.push(msg));
    expect(s.kind).toBe('memory');
    expect(logs).toContain('feedback store unavailable, using memory');
  });

  it('a writable path → disk (directory created outside production)', async () => {
    const s = await createFeedbackStore({ feedbackPath: join(tmp(), 'sub', 'fb.jsonl'), feedbackRetentionDays: 365, isProduction: false }, () => undefined);
    expect(s.kind).toBe('disk');
  });
});

describe('MemoryFeedbackStore', () => {
  it('keeps only the last vote per (session, idea), ordered by last write', async () => {
    const s = new MemoryFeedbackStore({ now: () => T0 });
    await s.append(line({ s: 'aaaaaaaaaaaa', i: 0, vote: 'up' }));
    await s.append(line({ s: 'bbbbbbbbbbbb', i: 0, vote: 'up' }));
    for (let n = 0; n < 50; n++) await s.append(line({ s: 'aaaaaaaaaaaa', i: 0, vote: n % 2 ? 'up' : 'down' }));
    await s.append(line({ s: 'aaaaaaaaaaaa', i: 1, vote: 'clear' }));
    expect(s.list().map((l) => [l.s, l.i, l.vote])).toEqual([
      ['bbbbbbbbbbbb', 0, 'up'],
      ['aaaaaaaaaaaa', 0, 'up'],
      ['aaaaaaaaaaaa', 1, 'clear'],
    ]);
    expect(feedbackCsv(s.list()).trim().split('\r\n')).toHaveLength(3);
  });

  it(`bounds memory at FEEDBACK_MAX_LINES (${FEEDBACK_MAX_LINES}) keys, dropping the oldest`, async () => {
    expect(FEEDBACK_MAX_LINES).toBe(50_000);
    const s = new MemoryFeedbackStore({ now: () => T0, maxLines: 3 });
    for (let i = 0; i < 5; i++) await s.append(line({ i }));
    expect(s.list().map((l) => l.i)).toEqual([2, 3, 4]);
    await s.append(line({ i: 2, vote: 'down' }));
    expect(s.list().map((l) => l.i)).toEqual([3, 4, 2]);
  });

  it('boot: votes beyond the size bound are dropped with a warning carrying the count', async () => {
    const path = join(tmp(), 'fb.jsonl');
    writeFileSync(path, [0, 1, 2, 3, 4, 4].map((i, n) => `${JSON.stringify(line({ i, vote: n === 5 ? 'down' : 'up' }))}\n`).join(''));
    const logs: { level: string; msg: string; extra?: Record<string, unknown> }[] = [];
    const s = await FileFeedbackStore.open(path, { now: () => T0, maxLines: 3, log: (level, msg, extra) => logs.push({ level, msg, ...(extra ? { extra } : {}) }) });
    expect(s.list().map((l) => l.i)).toEqual([2, 3, 4]);
    const warn = logs.find((l) => l.level === 'warn');
    expect(warn?.msg).toMatch(/size bound/);
    expect(warn?.extra).toEqual({ dropped: 2, max: 3 });
    const loaded = logs.find((l) => l.msg === 'feedback loaded');
    expect(loaded?.extra).toMatchObject({ lines: 3, superseded: 1 });
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('boot within the bound logs no warning', async () => {
    const path = join(tmp(), 'fb.jsonl');
    writeFileSync(path, `${JSON.stringify(line())}\n`);
    const levels: string[] = [];
    await FileFeedbackStore.open(path, { now: () => T0, log: (level) => levels.push(level) });
    expect(levels).not.toContain('warn');
  });

  it('drops expired lines on read', async () => {
    let now = T0;
    const s = new MemoryFeedbackStore({ now: () => now, retentionDays: 1 });
    await s.append(line());
    now += 2 * DAY;
    await s.append(line({ i: 1, t: new Date(now).toISOString() }));
    expect(s.list().map((l) => l.i)).toEqual([1]);
  });
});

describe('CSV export', () => {
  it('last vote per (session, idea) wins; a final clear drops the row', () => {
    const rows = latestVotes([
      line({ s: 'aaaaaaaaaaaa', i: 0, vote: 'up' }),
      line({ s: 'aaaaaaaaaaaa', i: 0, vote: 'down' }),
      line({ s: 'bbbbbbbbbbbb', i: 0, vote: 'up' }),
      line({ s: 'aaaaaaaaaaaa', i: 1, vote: 'up' }),
      line({ s: 'aaaaaaaaaaaa', i: 1, vote: 'clear' }),
    ]);
    expect(rows.map((r) => [r.s, r.i, r.vote])).toEqual([
      ['aaaaaaaaaaaa', 0, 'down'],
      ['bbbbbbbbbbbb', 0, 'up'],
    ]);
  });

  it('has the planned columns and guards against CSV injection', () => {
    const csv = feedbackCsv([line({ title: '=HYPERLINK("http://x")', dom: '+evil.example', pat: 'legal.intake', src: 'industry' })]);
    const [head, row] = csv.split('\r\n');
    expect(head).toBe('date,domain,industry,source,service,pattern,title,vote,sourcesCited');
    expect(row).toContain(`'+evil.example`);
    expect(row).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(row).toContain('industry,ai-automation,legal.intake');
    for (const c of ['=', '+', '-', '@', '\t', '\r']) expect(csvCell(`${c}x`).replace(/^"/, '').startsWith(`'${c}`)).toBe(true);
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
    expect(csvCell('a,b')).toBe('"a,b"');
  });
});
