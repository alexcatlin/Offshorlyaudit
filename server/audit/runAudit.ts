// The audit orchestrator (PLAN Phase 7, Amendments 1 and 2). Pure: every network-facing piece
// is injected, so tests run it offline.
//
// Flow: validate → readSite (20 s budget) → detect CMS + stack → start, all at once:
//   measured: site files (robots/sitemap/http probe), email DNS, PageSpeed (if keyed), WordPress
//   AI:       buyer fit (step 1 → step 2) and opportunities (skipped when thin/off/over the cap)
// The report returns when the measured parts finish (or the 60 s deadline passes; late parts are
// omitted and flagged). The two AI results come back as promises that never reject.
import { randomBytes } from 'node:crypto';
import { rankFixFirst } from '../../shared/reportLogic.js';
import type {
  AiResult,
  AiStatus,
  AuditReport,
  AuditRequest,
  BuyerFitResult,
  BuyerFitStatus,
  CheckId,
  CheckResult,
  CmsInfo,
  MeasuredPart,
  Persona,
  TeamSize,
} from '../../shared/types.js';
import { emailChecks } from '../checks/dns.js';
import type { ResolveTxt } from '../checks/dns.js';
import { fetchCheckInputs } from '../checks/extras.js';
import type { CheckFetches } from '../checks/extras.js';
import { healthChecks } from '../checks/health.js';
import { runPageSpeed } from '../checks/pagespeed.js';
import type { PlainFetch } from '../checks/pagespeed.js';
import { buildSection } from '../checks/score.js';
import { securityChecks } from '../checks/security.js';
import { analyseCms } from '../cms/cms.js';
import type { CmsResult } from '../cms/cms.js';
import { detectPlatform } from '../cms/detect.js';
import type { Wordfence } from '../cms/wordfence.js';
import type { WpOrgClient } from '../cms/wordpressOrg.js';
import { SiteReadError } from '../site/errors.js';
import type { FetchLogEntry, FetchSafe } from '../site/fetchSafe.js';
import { readSite } from '../site/readSite.js';
import type { SiteRead } from '../site/readSite.js';
import type { FetchedPage } from '../site/types.js';
import { detectStack, publicStack } from '../stack/detect.js';
import type { AiEngine, AiReservation } from './aiEngine.js';

export const READ_BUDGET_MS = 20_000;
export const MEASURED_DEADLINE_MS = 60_000;

export type AuditLog = (msg: string, extra?: Record<string, unknown>) => void;

export interface AuditDeps {
  /** A fresh fetcher per audit (its log and fetch budget are per audit). */
  createFetchSafe: () => FetchSafe;
  wpOrg: WpOrgClient;
  wordfence?: Wordfence | null;
  resolveTxt?: ResolveTxt;
  /** null/omitted when PAGESPEED_API_KEY is not set. */
  pagespeed?: { apiKey: string; fetchImpl?: PlainFetch; timeoutMs?: number } | null;
  /** null = AI mode off. */
  ai: AiEngine | null;
  /** Takes one unit of the global daily AI-audit allowance; false = cap reached. */
  takeAiQuota?: () => boolean;
  now?: () => number;
  log?: AuditLog;
  randomId?: () => string;
  readBudgetMs?: number;
  measuredDeadlineMs?: number;
}

export interface AuditRun {
  /** Measured report; buyer fit / AI are 'pending' when their promises are running. */
  report: AuditReport;
  /** Resolves (never rejects) with the buyer-fit result, or null when it isn't running. */
  buyerFit: Promise<BuyerFitResult> | null;
  /** Resolves (never rejects) with the AI result, or null when it isn't running. */
  ai: Promise<AiResult> | null;
  /** Every target request made for this audit (live: later CMS fetches still append). */
  fetchLog: FetchLogEntry[];
  /** Normalised final homepage URL, for cache keys. */
  finalUrl: string;
  /** True when AI was skipped because no AI slots were free: don't cache under the URL keys. */
  aiBusy: boolean;
}

// ---------- Validation ----------

export const LIMITS = { url: 500, businessType: 100, role: 200, size: 200, sector: 200, trigger: 300, timeSink: 200 } as const;
const TEAM_SIZES: readonly TeamSize[] = ['1-10', '11-50', '51-200', '200+'];

export type Validated = { ok: true; value: AuditRequest } | { ok: false; error: string };

const optString = (v: unknown, max: number, name: string): { ok: true; value?: string } | { ok: false; error: string } => {
  if (v === undefined || v === null) return { ok: true };
  if (typeof v !== 'string') return { ok: false, error: `${name} must be text.` };
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length > max) return { ok: false, error: `${name} is too long.` };
  return t ? { ok: true, value: t } : { ok: true };
};

/** Validates and normalises a POST /api/audit body. Unknown fields are ignored. */
export const validateAuditRequest = (body: unknown): Validated => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected a JSON object.' };
  const b = body as Record<string, unknown>;
  const url = optString(b.url, LIMITS.url, 'url');
  if (!url.ok) return url;
  if (!url.value) return { ok: false, error: 'url is required.' };
  const out: AuditRequest = { url: url.value };

  const bt = optString(b.businessType, LIMITS.businessType, 'businessType');
  if (!bt.ok) return bt;
  if (bt.value) out.businessType = bt.value;

  if (b.persona !== undefined && b.persona !== null) {
    if (typeof b.persona !== 'object' || Array.isArray(b.persona)) return { ok: false, error: 'persona must be an object.' };
    const p = b.persona as Record<string, unknown>;
    const persona: Partial<Persona> = {};
    for (const key of ['role', 'size', 'sector', 'trigger'] as const) {
      const r = optString(p[key], LIMITS[key], `persona.${key}`);
      if (!r.ok) return r;
      if (r.value) persona[key] = r.value;
    }
    if (Object.keys(persona).length) out.persona = persona;
  }

  if (b.teamSize !== undefined && b.teamSize !== null && b.teamSize !== '') {
    if (!TEAM_SIZES.includes(b.teamSize as TeamSize)) return { ok: false, error: 'teamSize is not a valid option.' };
    out.teamSize = b.teamSize as TeamSize;
  }
  const ts = optString(b.timeSink, LIMITS.timeSink, 'timeSink');
  if (!ts.ok) return ts;
  if (ts.value) out.timeSink = ts.value;
  return out.url ? { ok: true, value: out } : { ok: false, error: 'url is required.' };
};

// ---------- Helpers ----------

const newAuditId = (): string => randomBytes(16).toString('base64url');

const noopLog: AuditLog = () => undefined;

const LATE = Symbol('late');

/** Resolves with the value, or LATE once the deadline passes. Rejections pass through. */
const beforeDeadline = <T>(p: Promise<T>, deadline: number, now: () => number): Promise<T | typeof LATE> => {
  const ms = Math.max(0, deadline - now());
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

const withBudget = <T>(p: Promise<T>, ms: number, onLate: () => Error): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onLate()), ms);
  });
  p.catch(() => undefined); // a rejection after the budget must not go unhandled
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

const toPage = (p: FetchedPage): FetchedPage => ({ url: p.url, label: p.label, title: p.title, description: p.description, text: p.text });

const domainOf = (url: string): string => new URL(url).hostname.replace(/^www\./i, '');

const errorCode = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'unknown';
};

// Checks that depend on the extra site-file fetches; dropped if those miss the deadline.
const SITE_FILE_CHECKS: ReadonlySet<CheckId> = new Set<CheckId>(['sec-redirect', 'seo-sitemap', 'geo-bots']);

// ---------- Orchestration ----------

/**
 * Runs one audit. Throws SiteReadError for an unreadable or refused site (→ 422);
 * otherwise resolves with the measured report and the pending AI promises.
 */
export const runAudit = async (request: AuditRequest, deps: AuditDeps): Promise<AuditRun> => {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? noopLog;
  const started = now();
  const deadline = started + (deps.measuredDeadlineMs ?? MEASURED_DEADLINE_MS);
  const auditId = (deps.randomId ?? newAuditId)();

  const fetchSafe = deps.createFetchSafe();
  const site: SiteRead = await withBudget(
    readSite(request.url, { fetchSafe }),
    deps.readBudgetMs ?? READ_BUDGET_MS,
    () => new SiteReadError('unreadable', 'The site took too long to respond.'),
  );

  const finalUrl = site.home.finalUrl;
  const domain = domainOf(finalUrl);
  const logMeta = { auditId, domain };
  const pages = [toPage(site.home), ...site.pages.map(toPage)];
  const stack = detectStack([site.home.html, ...site.pages.map((p) => p.html)]);
  const platform = detectPlatform(site.home);

  // ----- AI: start straight away, in parallel with the measured checks -----
  // Slots first, quota second: an audit refused for slots takes no daily quota.
  let aiSkip: 'thin' | 'unavailable' | null = null;
  let aiBusy = false;
  let engine: AiEngine | null = null;
  if (site.thin) aiSkip = 'thin';
  else if (!deps.ai) aiSkip = 'unavailable';
  else {
    const reservation: AiReservation | null = deps.ai.reserve
      ? deps.ai.reserve()
      : { engine: deps.ai, release: () => undefined };
    if (!reservation) {
      aiSkip = 'unavailable';
      aiBusy = true;
      log('AI slots full', logMeta);
    } else {
      let quotaOk = false;
      try {
        quotaOk = !deps.takeAiQuota || deps.takeAiQuota();
      } finally {
        if (!quotaOk) reservation.release();
      }
      if (quotaOk) engine = reservation.engine;
      else {
        aiSkip = 'unavailable';
        log('daily AI cap reached', logMeta);
      }
    }
  }
  const fixture = engine?.mode === 'fixture';

  const buyerFitRaw = engine
    ? engine
        .buyerFit(
          {
            pages,
            ...(request.businessType ? { businessType: request.businessType } : {}),
            ...(request.persona ? { persona: request.persona } : {}),
          },
          logMeta,
        )
        .then(
          (bf) => ({ ok: true as const, bf }),
          (e: unknown) => {
            log('buyer fit failed', { ...logMeta, error: errorCode(e) });
            return { ok: false as const };
          },
        )
    : null;

  const aiPromise: Promise<AiResult> | null = engine
    ? engine
        .opportunities(
          {
            pages,
            cms: { platform: platform.platform },
            stack: stack.tech,
            saasCount: stack.saasCount,
            ...(request.teamSize ? { teamSize: request.teamSize } : {}),
            ...(request.timeSink ? { timeSink: request.timeSink } : {}),
          },
          logMeta,
        )
        .then(
          (r): AiResult => {
            if (r.status === 'insufficient') return { auditId, aiStatus: 'insufficient', ...(r.ai ? { ai: r.ai } : {}) };
            if (!r.ai) return { auditId, aiStatus: 'unavailable' };
            return fixture
              ? { auditId, aiStatus: 'fixture', ai: r.ai, fixture: true }
              : { auditId, aiStatus: 'ok', ai: r.ai };
          },
          (e: unknown): AiResult => {
            log('opportunities failed', { ...logMeta, error: errorCode(e) });
            return { auditId, aiStatus: 'unavailable' };
          },
        )
    : null;

  // ----- Measured parts, each under the overall deadline -----
  const omitted: MeasuredPart[] = [];
  const settle = async <T>(part: MeasuredPart, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      const r = await beforeDeadline(p, deadline, now);
      if (r === LATE) {
        omitted.push(part);
        log('measured part late', { ...logMeta, part });
        return fallback;
      }
      return r;
    } catch (e) {
      omitted.push(part);
      log('measured part failed', { ...logMeta, part, error: errorCode(e) });
      return fallback;
    }
  };

  const [files, email, psi, cmsResult] = await Promise.all([
    settle<CheckFetches | null>('site-files', fetchCheckInputs(finalUrl, { fetchSafe }), null),
    settle<CheckResult[] | null>(
      'email-dns',
      emailChecks(new URL(finalUrl).hostname, deps.resolveTxt ? { resolveTxt: deps.resolveTxt } : {}),
      null,
    ),
    deps.pagespeed ? settle<CheckResult[] | null>('pagespeed', runPageSpeed(finalUrl, deps.pagespeed), null) : Promise.resolve(null),
    settle<CmsResult | null>(
      'wordpress',
      analyseCms(site.home, { fetchSafe, wpOrg: deps.wpOrg, wordfence: deps.wordfence ?? null, now }),
      null,
    ),
  ]);

  const fetches: CheckFetches = files ?? { robots: null, sitemap: null, sitemapFetched: false, httpProbe: null };
  const dropLate = (checks: CheckResult[]) => (files ? checks : checks.filter((c) => !SITE_FILE_CHECKS.has(c.id)));
  const cms: CmsInfo =
    cmsResult?.cms ?? { platform: platform.platform, ...(platform.version ? { version: platform.version } : {}) };

  const security = buildSection([
    ...dropLate(securityChecks({ home: site.home, httpProbe: fetches.httpProbe })),
    ...(email ?? []),
    ...(cmsResult?.checks ?? []),
  ]);
  const health = {
    ...buildSection([...dropLate(healthChecks({ home: site.home, pages: site.pages, fetches })), ...(psi ?? [])]),
    measuredByGoogle: !!psi,
  };
  const measuredChecks = [...security.checks, ...health.checks];

  const aiStatus: AiStatus = aiSkip ?? 'pending';
  const buyerFitStatus: BuyerFitStatus = aiSkip ?? 'pending';

  const report: AuditReport = {
    auditId,
    auditedAt: new Date(started).toISOString(),
    url: finalUrl,
    domain,
    pagesRead: pages.map((p) => ({ url: p.url, label: p.label, title: p.title })),
    aiStatus,
    buyerFitStatus,
    ...(fixture ? { fixture: true as const } : {}),
    security,
    health,
    cms,
    stack: publicStack(stack.tech),
    fixFirst: rankFixFirst({ checks: measuredChecks }),
    attributions: cmsResult?.attributions ?? [],
    ...(omitted.length ? { omitted } : {}),
  };

  const buyerFitPromise: Promise<BuyerFitResult> | null = buyerFitRaw
    ? buyerFitRaw
        .then((r): BuyerFitResult => {
          if (!r.ok) return { auditId, buyerFitStatus: 'unavailable', fixFirst: report.fixFirst };
          return {
            auditId,
            buyerFitStatus: fixture ? 'fixture' : 'ok',
            buyerFit: r.bf,
            ...(fixture ? { fixture: true as const } : {}),
            fixFirst: rankFixFirst({ checks: measuredChecks, buyerFitActions: r.bf.actions }),
          };
        })
        .catch((): BuyerFitResult => ({ auditId, buyerFitStatus: 'unavailable', fixFirst: report.fixFirst }))
    : null;

  log('audit measured', {
    ...logMeta,
    ms: Math.round(now() - started),
    fetches: site.fetchLog.length,
    aiStatus,
    ...(omitted.length ? { omitted } : {}),
  });

  return { report, buyerFit: buyerFitPromise, ai: aiPromise, fetchLog: site.fetchLog, finalUrl, aiBusy };
};
