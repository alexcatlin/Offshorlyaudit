import { describe, expect, it } from 'vitest';
import {
  actionRank,
  buyerFitScore,
  checkRank,
  gaugeColour,
  rankFixFirst,
  scoreBand,
  scoreColour,
} from '../../shared/reportLogic.js';
import type { ActionItem, CheckResult } from '../../shared/types.js';

const check = (id: CheckResult['id'], status: CheckResult['status']) => ({ id, status });
const action = (impact: ActionItem['impact'], effort: ActionItem['effort']) => ({ impact, effort });

describe('buyerFitScore', () => {
  it('weights high ×3, medium ×2, low ×1', () => {
    // (10×3 + 5×2 + 0×1) / 6 × 10 = 66.67 → 67
    expect(
      buyerFitScore([
        { score: 10, weight: 'high' },
        { score: 5, weight: 'medium' },
        { score: 0, weight: 'low' },
      ]),
    ).toBe(67);
  });

  it('a high-weight criterion moves the score more than a low one', () => {
    const a = buyerFitScore([
      { score: 10, weight: 'high' },
      { score: 0, weight: 'low' },
    ]);
    const b = buyerFitScore([
      { score: 0, weight: 'high' },
      { score: 10, weight: 'low' },
    ]);
    expect(a).toBe(75);
    expect(b).toBe(25);
  });

  it('all 10s → 100, all 0s → 0, no criteria → null', () => {
    expect(buyerFitScore([{ score: 10, weight: 'low' }, { score: 10, weight: 'high' }])).toBe(100);
    expect(buyerFitScore([{ score: 0, weight: 'medium' }])).toBe(0);
    expect(buyerFitScore([])).toBeNull();
  });
});

describe('score bands and colours', () => {
  it('bands at 80/60/40', () => {
    expect(scoreBand(80)?.text).toBe('A strong fit for this customer');
    expect(scoreBand(79)?.text).toBe('Credible, with gaps this customer will notice');
    expect(scoreBand(60)?.id).toBe('credible');
    expect(scoreBand(59)?.text).toBe('Losing this customer to clearer competitors');
    expect(scoreBand(40)?.id).toBe('losing');
    expect(scoreBand(39)?.text).toBe('Not making the case to this customer');
    expect(scoreBand(null)).toBeNull();
  });

  it('colour buckets', () => {
    expect(scoreColour(80)).toBe('good');
    expect(scoreColour(50)).toBe('mid');
    expect(scoreColour(49)).toBe('warning');
    expect(scoreColour(null)).toBe('none');
    expect(gaugeColour(8)).toBe('good');
    expect(gaugeColour(5)).toBe('mid');
    expect(gaugeColour(4)).toBe('warning');
  });
});

describe('ranks', () => {
  it('check: impact×2 − effort, warn −1', () => {
    expect(checkRank(check('sec-https', 'fail'))).toBe(5); // high/low
    expect(checkRank(check('sec-https', 'warn'))).toBe(4);
    expect(checkRank(check('sec-csp', 'fail'))).toBe(2); // medium/medium
  });
  it('action: impact×2 − effort + 0.25', () => {
    expect(actionRank(action('high', 'low'))).toBe(5.25);
    expect(actionRank(action('low', 'high'))).toBe(-0.75);
  });
});

describe('rankFixFirst', () => {
  it('returns top 5 with at most 2 per section', () => {
    const items = rankFixFirst({
      checks: [
        check('sec-https', 'fail'),
        check('sec-spf', 'fail'),
        check('sec-dmarc', 'fail'),
        check('seo-title', 'fail'),
        check('seo-indexable', 'fail'),
        check('geo-bots', 'fail'),
      ],
      buyerFitActions: [action('high', 'low'), action('high', 'low'), action('high', 'low')],
    });
    expect(items).toHaveLength(5);
    const counts = items.reduce<Record<string, number>>((m, i) => ({ ...m, [i.section]: (m[i.section] ?? 0) + 1 }), {});
    expect(Object.values(counts).every((n) => n <= 2)).toBe(true);
    expect(counts['buyer-fit']).toBe(2);
    // buyer-fit wins the tie at rank 5 vs 5.25
    expect(items[0]).toEqual({ source: 'ai', section: 'buyer-fit', actionIndex: 0 });
    expect(items[1]).toEqual({ source: 'ai', section: 'buyer-fit', actionIndex: 1 });
  });

  it('buyer-fit action outranks an equal check via the tie-break', () => {
    const items = rankFixFirst({
      checks: [check('sec-https', 'fail')],
      buyerFitActions: [action('high', 'low')],
    });
    expect(items[0]?.source).toBe('ai');
    expect(items[1]?.checkId).toBe('sec-https');
  });

  it('a stronger check outranks a weaker action', () => {
    const items = rankFixFirst({
      checks: [check('sec-https', 'fail')],
      buyerFitActions: [action('medium', 'medium')],
    });
    expect(items[0]?.checkId).toBe('sec-https');
  });

  it('warnings rank below equal failures', () => {
    const items = rankFixFirst({ checks: [check('sec-spf', 'warn'), check('seo-title', 'fail')] });
    expect(items.map((i) => i.checkId)).toEqual(['seo-title', 'sec-spf']);
  });

  it('skips pass, info and non-rankable checks', () => {
    const items = rankFixFirst({
      checks: [
        check('sec-https', 'pass'),
        check('sec-hsts', 'info'),
        check('spd-google-score', 'fail'),
        check('spd-lcp', 'fail'),
      ],
    });
    expect(items).toEqual([{ source: 'check', section: 'health', checkId: 'spd-lcp' }]);
  });

  it('works with no buyer-fit actions and returns [] when nothing to fix', () => {
    expect(rankFixFirst({ checks: [] })).toEqual([]);
    expect(rankFixFirst({ checks: [check('sec-csp', 'fail')] })).toHaveLength(1);
  });
});
