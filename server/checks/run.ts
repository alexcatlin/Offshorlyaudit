// Convenience runner for the measured checks. The orchestrator may instead call the pieces
// (fetchCheckInputs, securityChecks, emailChecks, healthChecks, runPageSpeed) with its own deadlines.
import type { CheckResult } from '../../shared/types.js';
import type { FetchSafe } from '../site/fetchSafe.js';
import type { SiteRead } from '../site/readSite.js';
import { emailChecks } from './dns.js';
import type { ResolveTxt } from './dns.js';
import { fetchCheckInputs } from './extras.js';
import type { CheckFetches } from './extras.js';
import { healthChecks } from './health.js';
import { runPageSpeed } from './pagespeed.js';
import type { PlainFetch } from './pagespeed.js';
import { securityChecks } from './security.js';

export interface MeasuredDeps {
  fetchSafe: FetchSafe;
  resolveTxt?: ResolveTxt;
  dnsTimeoutMs?: number;
  /** Omit or null when PAGESPEED_API_KEY is not set. */
  pagespeed?: { apiKey: string; fetchImpl?: PlainFetch; timeoutMs?: number } | null;
}

export interface MeasuredResult {
  /** sec-* checks (WordPress checks are added separately from cms/wpChecks). */
  security: CheckResult[];
  /** Health checks, plus PageSpeed checks when measured. */
  health: CheckResult[];
  measuredByGoogle: boolean;
  fetches: CheckFetches;
}

export const runMeasuredChecks = async (site: SiteRead, deps: MeasuredDeps): Promise<MeasuredResult> => {
  const host = new URL(site.home.finalUrl).hostname;
  const [fetches, email, psi] = await Promise.all([
    fetchCheckInputs(site.home.finalUrl, deps),
    emailChecks(host, {
      ...(deps.resolveTxt ? { resolveTxt: deps.resolveTxt } : {}),
      ...(deps.dnsTimeoutMs ? { timeoutMs: deps.dnsTimeoutMs } : {}),
    }),
    deps.pagespeed ? runPageSpeed(site.home.finalUrl, deps.pagespeed) : Promise.resolve(null),
  ]);
  const security = [...securityChecks({ home: site.home, httpProbe: fetches.httpProbe }), ...email];
  const health = [...healthChecks({ home: site.home, pages: site.pages, fetches }), ...(psi ?? [])];
  return { security, health, measuredByGoogle: !!psi, fetches };
};
