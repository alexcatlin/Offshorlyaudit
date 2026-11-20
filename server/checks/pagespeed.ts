// Google PageSpeed Insights (only with PAGESPEED_API_KEY). Mobile, performance category, 45 s timeout.
// Not a target-site fetch: Google loads the page, so this does not go through fetchSafe.
import type { CheckResult } from '../../shared/types.js';

export const PAGESPEED_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
export const PAGESPEED_TIMEOUT_MS = 45_000;

export type PlainFetch = (
  url: string,
  init: { signal: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface PageSpeedDeps {
  apiKey: string;
  fetchImpl?: PlainFetch;
  timeoutMs?: number;
}

interface PsiShape {
  lighthouseResult?: {
    categories?: { performance?: { score?: number | null } };
    audits?: Record<string, { numericValue?: number }>;
  };
}

const fmtSec = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** Map a PageSpeed API response to the four spd-* checks. Returns [] if the response has no score. */
export const pageSpeedChecks = (json: unknown): CheckResult[] => {
  const lh = (json as PsiShape | null)?.lighthouseResult;
  const raw = lh?.categories?.performance?.score;
  if (typeof raw !== 'number') return [];
  const score = Math.round(raw * 100);
  const out: CheckResult[] = [
    {
      id: 'spd-google-score',
      status: score >= 90 ? 'pass' : score >= 50 ? 'warn' : 'fail',
      detail: `Google's mobile speed score is ${score} out of 100.`,
    },
  ];
  const audit = (k: string): number | null => {
    const v = lh?.audits?.[k]?.numericValue;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const lcp = audit('largest-contentful-paint');
  if (lcp !== null) {
    out.push({
      id: 'spd-lcp',
      status: lcp <= 2500 ? 'pass' : lcp <= 4000 ? 'warn' : 'fail',
      detail: `Main content appears after ${fmtSec(lcp)} on a mobile test.`,
    });
  }
  const cls = audit('cumulative-layout-shift');
  if (cls !== null) {
    out.push({
      id: 'spd-cls',
      status: cls <= 0.1 ? 'pass' : cls <= 0.25 ? 'warn' : 'fail',
      detail: `Layout shift score is ${cls.toFixed(2)}.`,
    });
  }
  const tbt = audit('total-blocking-time');
  if (tbt !== null) {
    out.push({
      id: 'spd-tbt',
      status: tbt <= 200 ? 'pass' : tbt <= 600 ? 'warn' : 'fail',
      detail: `The page is blocked for ${Math.round(tbt)} ms while loading on a mobile test.`,
    });
  }
  return out;
};

/** Run PageSpeed; null on any failure (the section then has no Google measurement). */
export const runPageSpeed = async (url: string, deps: PageSpeedDeps): Promise<CheckResult[] | null> => {
  const fetchImpl: PlainFetch = deps.fetchImpl ?? ((u, init) => fetch(u, init));
  const q = new URLSearchParams({ url, strategy: 'mobile', category: 'performance', key: deps.apiKey });
  try {
    const res = await fetchImpl(`${PAGESPEED_ENDPOINT}?${q.toString()}`, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? PAGESPEED_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const checks = pageSpeedChecks(await res.json());
    return checks.length ? checks : null;
  } catch {
    return null;
  }
};
