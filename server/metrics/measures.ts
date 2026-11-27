// The success-measures CSV (spec 001): one row per UTC day, a TOTAL row, then a NOTE row.
// Counts come from the daily counter store; thumbs come from the idea-feedback store (last vote
// per visitor and idea wins). Rates in TOTAL use summed numerators and denominators, never an
// average of daily rates. A rate with no denominator is a blank cell.
import { csvCell, latestVotes } from '../feedback/store.js';
import type { FeedbackLine } from '../feedback/store.js';
import type { DayCounts } from './store.js';

export const MEASURES_COLUMNS = [
  'date',
  'audits_run',
  'reports_viewed',
  'shared_views',
  'clicks_direct_ai',
  'clicks_direct_ai_top',
  'clicks_direct_pitch',
  'clicks_direct_website',
  'clicks_direct_blocked',
  'clicks_shared_ai',
  'clicks_shared_ai_top',
  'clicks_shared_pitch',
  'clicks_shared_website',
  'clicks_shared_audit_link',
  'click_rate_direct',
  'ai_attempted',
  'ai_finished',
  'ai_finished_share',
  'industry_known',
  'industry_with_examples',
  'industry_example_share',
  'avg_cost_usd',
  'thumbs_up',
  'thumbs_down',
  'thumbs_up_rate',
] as const;

export const MEASURES_NOTE = 'Call booked is not measured here';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_RANGE_DAYS = 366;

export const isDay = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};

/** Every UTC day from `from` to `to`, inclusive. */
const daysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

type Sums = Record<string, number>;
const get = (d: DayCounts | Sums | undefined, k: string): number => d?.[k] ?? 0;
const rate = (n: number, d: number): number | '' => (d > 0 ? Number((n / d).toFixed(4)) : '');

const row = (label: string, c: DayCounts | Sums, up: number, down: number): (string | number)[] => {
  const directClicks = get(c, 'click.direct.ai') + get(c, 'click.direct.ai-top') + get(c, 'click.direct.pitch') + get(c, 'click.direct.website');
  return [
    label,
    get(c, 'audit_run'),
    get(c, 'report_view'),
    get(c, 'shared_view'),
    get(c, 'click.direct.ai'),
    get(c, 'click.direct.ai-top'),
    get(c, 'click.direct.pitch'),
    get(c, 'click.direct.website'),
    get(c, 'click.direct.blocked'),
    get(c, 'click.shared.ai'),
    get(c, 'click.shared.ai-top'),
    get(c, 'click.shared.pitch'),
    get(c, 'click.shared.website'),
    get(c, 'click.shared.audit-link'),
    rate(directClicks, get(c, 'report_view')),
    get(c, 'ai_attempted'),
    get(c, 'ai_finished'),
    rate(get(c, 'ai_finished'), get(c, 'ai_attempted')),
    get(c, 'industry_known'),
    get(c, 'industry_with_examples'),
    rate(get(c, 'industry_with_examples'), get(c, 'industry_known')),
    rate(get(c, 'cost_usd_sum'), get(c, 'cost_n')),
    up,
    down,
    rate(up, up + down),
  ];
};

export const measuresCsv = (days: ReadonlyMap<string, DayCounts>, feedback: readonly FeedbackLine[], from: string, to: string): string => {
  const thumbs = new Map<string, { up: number; down: number }>();
  for (const l of latestVotes(feedback)) {
    const day = l.t.slice(0, 10);
    const t = thumbs.get(day) ?? { up: 0, down: 0 };
    if (l.vote === 'up') t.up++;
    else if (l.vote === 'down') t.down++;
    thumbs.set(day, t);
  }
  const total: Sums = {};
  let up = 0;
  let down = 0;
  const rows: (string | number)[][] = [];
  for (const day of daysBetween(from, to)) {
    const c = days.get(day) ?? {};
    const t = thumbs.get(day) ?? { up: 0, down: 0 };
    rows.push(row(day, c, t.up, t.down));
    for (const [k, v] of Object.entries(c)) total[k] = (total[k] ?? 0) + v;
    up += t.up;
    down += t.down;
  }
  rows.push(row('TOTAL', total, up, down));
  const lines = [MEASURES_COLUMNS.join(','), ...rows.map((r) => r.map(csvCell).join(',')), `NOTE,${csvCell(MEASURES_NOTE)}`];
  return `${lines.join('\r\n')}\r\n`;
};
