// Section score: weighted pass 1 / warn 0.5 / fail 0, `info` excluded, ×100, rounded.
// null when nothing is scorable. Unlisted checks weigh 1.
import { CHECKS } from '../../shared/checks.js';
import type { CheckResult, Section, Status } from '../../shared/types.js';

const VALUE: Record<Exclude<Status, 'info'>, number> = { pass: 1, warn: 0.5, fail: 0 };

export const scoreChecks = (checks: readonly CheckResult[]): number | null => {
  let total = 0;
  let weights = 0;
  for (const c of checks) {
    if (c.status === 'info') continue;
    const w = CHECKS[c.id]?.weight ?? 1;
    if (w <= 0) continue;
    total += w * VALUE[c.status];
    weights += w;
  }
  return weights > 0 ? Math.round((total / weights) * 100) : null;
};

export const buildSection = (checks: CheckResult[]): Section => ({ score: scoreChecks(checks), checks });
