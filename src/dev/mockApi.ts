// DEV ONLY. Fake API for building the UI before the real routes exist.
// Enabled by ?mock=1 when import.meta.env.DEV is true (see src/api.ts); never in production builds.
// Pick a variant with &case=full|no-wp|ai-unavailable|buyerfit-unavailable|thin|error-unreadable|rate-limited.
// &emailUsed=1 answers every POST with 409 email_used; a blank or malformed email gets 400 email_invalid.
// Amendment 5: POST /api/audit adds a fake session + features; /api/feedback answers 204
// (&sessionExpired=1 → 410); /api/share creates/deletes an in-memory snapshot and
// GET /api/share/:id serves it (unknown id → 404). &shareOff=1 hides sharing.
// Phase 4: POST /api/share/email answers 202 once per session (then 409 already_sent);
// &emailOff=1 hides the email button, &emailFail=1 answers 502 email_failed.
// Phase 5: the AI section carries one industry example citing an example.com source.
// All content is marked "[Sample]" and flagged fixture.
import { rankFixFirst } from '../../shared/reportLogic.js';
import type {
  AiResult,
  AiSection,
  AuditReport,
  AuditRequest,
  AuditStartBody,
  BuyerFit,
  BuyerFitResult,
  CheckResult,
  CmsInfo,
  Features,
  Persona,
  SharedReport,
} from '../../shared/types.js';
import { INDUSTRIES } from '../../shared/industries.js';
import type { HttpResult, Transport } from '../api.js';

/** Marker string used to verify this module is absent from production bundles. */
export const MOCK_MARKER = '__OA_DEV_MOCK_API__';

type MockCase =
  | 'full'
  | 'no-wp'
  | 'ai-unavailable'
  | 'buyerfit-unavailable'
  | 'thin'
  | 'error-unreadable'
  | 'rate-limited';

const CASES: readonly MockCase[] = [
  'full',
  'no-wp',
  'ai-unavailable',
  'buyerfit-unavailable',
  'thin',
  'error-unreadable',
  'rate-limited',
];

const POST_DELAY_MS = 900;
const BUYER_FIT_AFTER_MS = 3000;
const AI_AFTER_MS = 5000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'example-agency.co.uk';
  }
};

const securityChecks = (wp: boolean): CheckResult[] => [
  { id: 'sec-https', status: 'pass', detail: '[Sample] Served over HTTPS with a valid certificate.' },
  { id: 'sec-redirect', status: 'pass', detail: '[Sample] http:// redirects to https:// (301).' },
  { id: 'sec-hsts', status: 'warn', detail: '[Sample] HSTS is set, but max-age is 1 day (6 months or more is recommended).' },
  { id: 'sec-csp', status: 'fail', detail: '[Sample] No Content-Security-Policy header.' },
  { id: 'sec-frame', status: 'pass', detail: '[Sample] X-Frame-Options: SAMEORIGIN.' },
  { id: 'sec-nosniff', status: 'pass', detail: '[Sample] X-Content-Type-Options: nosniff.' },
  { id: 'sec-referrer', status: 'warn', detail: '[Sample] No Referrer-Policy header; browsers fall back to their default.' },
  { id: 'sec-cookies', status: 'pass', detail: '[Sample] No cookies set on the homepage.' },
  { id: 'sec-disclosure', status: 'warn', detail: '[Sample] The Server header shows "nginx/1.18.0".' },
  { id: 'sec-mixed', status: 'pass', detail: '[Sample] No insecure http:// resources on the homepage.' },
  { id: 'sec-spf', status: 'pass', detail: '[Sample] SPF record found, ending in ~all.' },
  { id: 'sec-dmarc', status: 'fail', detail: '[Sample] No DMARC record on the domain.' },
  ...(wp
    ? ([
        { id: 'wp-core-version', status: 'warn', detail: '[Sample] Running 6.6.2 (seen in the page code); latest is 6.8.3.' },
        { id: 'wp-plugins', status: 'fail', detail: '[Sample] 3 of 6 detected plugins are behind the latest version; 1 has a security fix available.' },
        { id: 'wp-theme', status: 'info', detail: '[Sample] Custom theme: not in the WordPress directory, so no public update information.' },
        { id: 'wp-xmlrpc', status: 'warn', detail: '[Sample] The page advertises XML-RPC (pingback link).' },
        { id: 'wp-version-exposed', status: 'warn', detail: '[Sample] The generator tag shows the WordPress version.' },
      ] satisfies CheckResult[])
    : []),
];

const healthChecks = (): CheckResult[] => [
  { id: 'seo-title', status: 'warn', detail: '[Sample] "Home - Example" (14 characters; 25 to 65 is ideal).' },
  { id: 'seo-description', status: 'pass', detail: '[Sample] 148 characters.' },
  { id: 'seo-h1', status: 'pass', detail: '[Sample] One H1: "Software that ships on time".' },
  { id: 'seo-indexable', status: 'pass', detail: '[Sample] No noindex found.' },
  { id: 'seo-content', status: 'pass', detail: '[Sample] About 820 words of readable text.' },
  { id: 'seo-sitemap', status: 'pass', detail: '[Sample] Sitemap listed in robots.txt.' },
  { id: 'seo-canonical', status: 'pass', detail: '[Sample] Canonical points to the homepage.' },
  { id: 'seo-og', status: 'warn', detail: '[Sample] og:image is missing, so shared links show no picture.' },
  { id: 'seo-alt', status: 'fail', detail: '[Sample] 9 of 14 images have no alt text.' },
  { id: 'geo-bots', status: 'pass', detail: '[Sample] robots.txt does not block AI crawlers.' },
  { id: 'geo-nojs', status: 'pass', detail: '[Sample] Main content is in the HTML without JavaScript.' },
  { id: 'geo-structured', status: 'warn', detail: '[Sample] No Organization structured data.' },
  { id: 'geo-questions', status: 'info', detail: '[Sample] No question-style headings found.' },
  { id: 'spd-ttfb', status: 'pass', detail: '[Sample] First byte in 310 ms.' },
  { id: 'spd-viewport', status: 'pass', detail: '[Sample] Mobile viewport set.' },
  { id: 'spd-compression', status: 'pass', detail: '[Sample] Compressed with gzip.' },
  { id: 'spd-html-size', status: 'pass', detail: '[Sample] 86 KB of HTML.' },
  { id: 'spd-blocking-scripts', status: 'warn', detail: '[Sample] 7 scripts in the <head> block rendering.' },
];

const wordpressCms = (): CmsInfo => ({
  platform: 'wordpress',
  wordpress: {
    core: { version: '6.6.2', source: 'generator', latest: '6.8.3', status: 'outdated' },
    components: [
      { type: 'plugin', slug: 'contact-form-7', name: '[Sample] Contact Form 7', version: '5.8.1', versionSource: 'asset', latest: '6.1.2', directory: 'listed', stale: false, status: 'fix_available' },
      { type: 'plugin', slug: 'wordpress-seo', name: '[Sample] Yoast SEO', version: '23.4', versionSource: 'asset', latest: '26.3', directory: 'listed', stale: false, status: 'outdated' },
      { type: 'plugin', slug: 'old-slider', name: '[Sample] Old Slider', version: '2.1.0', versionSource: 'asset', latest: '2.1.0', directory: 'closed', stale: true, status: 'unknown' },
      { type: 'plugin', slug: 'gravityforms', name: null, version: null, versionSource: null, latest: null, directory: 'not_listed', stale: false, status: 'unknown' },
      { type: 'plugin', slug: 'wp-rocket', name: null, version: null, versionSource: null, latest: null, directory: 'not_listed', stale: false, status: 'unknown' },
      { type: 'theme', slug: 'example-v2', name: null, version: '2.0.4', versionSource: 'stylesheet', latest: null, directory: 'not_listed', stale: false, status: 'unknown' },
    ],
    xmlrpcAdvertised: true,
    versionExposed: true,
    vulnSource: 'wordfence',
    knownIssues: { count: 2, highest: 'medium' },
  },
});

const persona = (req: AuditRequest): { persona: Persona; inferred: boolean } => {
  const p = req.persona ?? {};
  const inferred = !p.role || !p.size || !p.sector || !p.trigger;
  return {
    persona: {
      role: p.role || '[Sample] Operations Director',
      size: p.size || '[Sample] 50–200 person logistics firm',
      sector: p.sector || '[Sample] Freight and logistics',
      trigger: p.trigger || '[Sample] Wants to cut manual admin without new hires',
    },
    inferred,
  };
};

const buyerFit = (req: AuditRequest, domain: string): BuyerFit => {
  const { persona: buyer, inferred } = persona(req);
  const page = `https://${domain}/`;
  const services = `https://${domain}/services/`;
  const criteria: BuyerFit['criteria'] = [
    {
      name: '[Sample] Relevant case studies',
      score: 4,
      weight: 'high',
      reasoning:
        '[Sample] The site mentions "clients across logistics" but shows no named project, outcome or before-and-after. A buyer has to take the claim on trust.',
      evidence: [
        { quote: 'We have helped clients across logistics and retail', pageUrl: page, pageLabel: 'Homepage', effect: 'against', note: 'Claims sector experience but names no client.' },
      ],
    },
    {
      name: '[Sample] Clear offer',
      score: 7,
      weight: 'high',
      reasoning: '[Sample] The services page explains what is built and how a project starts. It loses focus when it lists eleven technologies.',
      evidence: [
        { quote: 'Every project starts with a two-week discovery sprint', pageUrl: services, pageLabel: 'Services', effect: 'for', note: 'Concrete first step lowers the risk of saying yes.' },
        { quote: 'We work with all major frameworks and platforms', pageUrl: services, pageLabel: 'Services', effect: 'against', note: 'Generic; sounds like every other agency.' },
      ],
    },
    {
      name: '[Sample] Team credibility',
      score: 6,
      weight: 'medium',
      reasoning: '[Sample] The about page names the founders but not who would run a project day to day.',
    },
    {
      name: '[Sample] Pricing signals',
      score: 3,
      weight: 'medium',
      reasoning: '[Sample] There is no indication of budget range or engagement model, so the buyer cannot tell if this fits before calling.',
    },
    {
      name: '[Sample] Ease of contact',
      score: 9,
      weight: 'low',
      reasoning: '[Sample] A booking link and phone number appear on every page.',
      evidence: [
        { quote: 'Book a 30-minute call with a founder', pageUrl: page, pageLabel: 'Homepage', effect: 'for', note: 'Direct access to a decision-maker.' },
      ],
    },
  ];
  return {
    businessType: req.businessType || '[Sample] Software development agency',
    businessTypeInferred: !req.businessType,
    persona: buyer,
    personaInferred: inferred,
    score: 58,
    verdict: {
      summary: '[Sample] A capable-sounding agency that asks the buyer to trust claims it never backs up.',
      brutalTruth: '[Sample] Without one named client result, an operations director will shortlist a competitor who shows theirs.',
    },
    strengths: [
      '[Sample] A clear first step: the two-week discovery sprint is explained in plain terms.',
      '[Sample] Booking a call takes one click from any page.',
      '[Sample] The homepage says who you work with in the first line.',
    ],
    criteria,
    mismatchIndex: [
      { point: '[Sample] "Specialists" with no specialism', explanation: '[Sample] The headline claims logistics expertise, but every example and image is generic.' },
      { point: '[Sample] Senior team, junior proof', explanation: '[Sample] Founders are presented as veterans, yet the work shown is two small brochure sites.' },
    ],
    actions: [
      { text: '[Sample] Add one named logistics case study with the problem, what you built and the result', horizon: 'now', impact: 'high', effort: 'medium', owner: 'marketing' },
      { text: '[Sample] Replace the technology list with three outcomes buyers care about', horizon: 'now', impact: 'medium', effort: 'low', owner: 'marketing' },
      { text: '[Sample] Say who runs projects day to day, with a photo and a line on their background', horizon: 'now', impact: 'medium', effort: 'low', owner: 'leadership' },
      { text: '[Sample] Publish a typical engagement model and budget range', horizon: 'later', impact: 'high', effort: 'medium', owner: 'leadership' },
      { text: '[Sample] Build a logistics landing page with sector-specific proof', horizon: 'later', impact: 'medium', effort: 'high', owner: 'developer' },
    ],
  };
};

const aiSection = (req: AuditRequest, domain: string): AiSection => ({
  business: {
    summary: '[Sample] A UK software agency building custom web and mobile apps for mid-sized logistics and retail firms.',
    customers: 'b2b',
  },
  industry: req.industry
    ? { id: req.industry, label: INDUSTRIES[req.industry].label, inferred: false }
    : { id: 'agencies', label: INDUSTRIES.agencies.label, inferred: true },
  opportunities: [
    {
      title: '[Sample] Triage incoming project enquiries',
      process: '[Sample] Enquiries arrive through the contact form and are read, sorted and answered by hand before anyone qualifies them.',
      basis: [
        { kind: 'quote', quote: 'Tell us about your project and we will reply within one working day', pageUrl: `https://${domain}/contact/`, pageLabel: 'Contact' },
        { kind: 'stack', techId: 'cf7', name: 'Contact Form 7' },
      ],
      aiApproach: '[Sample] An assistant reads each enquiry, pulls out budget, timeline and project type, drafts a reply and flags the ones worth a founder call.',
      efficiency: 'turnaround',
      measureFirst: '[Sample] How many enquiries arrive each week and how long each takes to qualify.',
      confidence: 'likely',
      service: { id: 'ai-automation', name: 'AI Automation', url: 'https://offshorly.com/ai-automation-agency/' },
      proof: { id: 'compliance-tickets', text: 'Daily compliance tickets cut from 140+ to about 20 in around six weeks', url: 'https://offshorly.com/case-studies/' },
      source: 'site',
      industryContext: '[Sample] agencies like this often sort enquiries by budget and project type before anyone replies.',
    },
    {
      title: '[Sample] Draft proposals from discovery notes',
      process: req.timeSink
        ? '[Sample] Proposals are written from scratch after each discovery call, which you said takes a lot of the week.'
        : '[Sample] Proposals appear to be written from scratch after each discovery sprint.',
      basis: req.timeSink
        ? [{ kind: 'answer', field: 'timeSink' }]
        : [{ kind: 'quote', quote: 'Every project starts with a two-week discovery sprint', pageUrl: `https://${domain}/services/`, pageLabel: 'Services' }],
      aiApproach: '[Sample] An agent turns call transcripts and notes into a first-draft proposal in your template, for a person to check and price.',
      efficiency: 'time-per-task',
      measureFirst: '[Sample] Time from discovery call to proposal sent, over the last ten proposals.',
      confidence: 'worth-checking',
      service: { id: 'ai-agent-development', name: 'AI Agent Development', url: 'https://offshorly.com/ai-agent-development/' },
      source: 'site',
    },
    {
      title: '[Sample] Screen applications for open roles',
      process: '[Sample] The careers page lists three open roles; applications are likely read one by one.',
      basis: [
        { kind: 'stack', techId: 'workable', name: 'Workable' },
        ...(req.teamSize ? [{ kind: 'answer', field: 'teamSize' } as const] : []),
      ],
      aiApproach: '[Sample] Score each CV against the role brief and summarise the strongest matches, with a person making every decision.',
      efficiency: 'capacity',
      measureFirst: '[Sample] Applications per role and hours spent shortlisting.',
      confidence: 'worth-checking',
      service: { id: 'ai-agent-development', name: 'AI Agent Development', url: 'https://offshorly.com/ai-agent-development/' },
      source: 'site',
    },
    {
      title: '[Sample] Client performance reporting',
      process: '[Sample] Account teams likely pull figures from several platforms into monthly client reports by hand.',
      basis: [
        {
          kind: 'industry',
          patternId: 'agencies.client-reporting',
          industryLabel: INDUSTRIES.agencies.label,
          text: INDUSTRIES.agencies.patterns.find((p) => p.id === 'agencies.client-reporting')?.text ?? '',
        },
      ],
      aiApproach: '[Sample] Pull the data together automatically and draft the commentary, so the account lead reviews rather than builds.',
      efficiency: 'time-per-task',
      measureFirst: '[Sample] How long one monthly client report takes, start to finish.',
      confidence: 'worth-checking',
      service: { id: 'ai-automation', name: 'AI Automation', url: 'https://offshorly.com/ai-automation-agency/' },
      source: 'industry',
      industryContext: '[Sample] agencies often automate the data gathering first and keep the commentary human.',
    },
  ],
  industryExamples: [
    {
      text: '[Sample] one agency describes drafting monthly client reports automatically and having the account lead check them before sending.',
      sources: [{ title: '[Sample] How one agency automated client reporting', domain: 'example.com', url: 'https://example.com/sample-article' }],
    },
  ],
  research: { industryId: 'agencies', label: INDUSTRIES.agencies.label, searchedAt: new Date().toISOString() },
  notWorthIt: '[Sample] Founder sales calls: the relationship is the product, and automating them would cost more trust than time saved.',
});

const baseReport = (req: AuditRequest, mockCase: MockCase): AuditReport => {
  const domain = domainOf(req.url);
  const wp = mockCase !== 'no-wp';
  const security = securityChecks(wp);
  const health = healthChecks();
  const thin = mockCase === 'thin';
  return {
    auditId: `mock-${mockCase}-${Math.random().toString(16).slice(2)}`,
    auditedAt: new Date().toISOString(),
    url: req.url,
    domain,
    pagesRead: thin
      ? [{ url: `https://${domain}/`, label: 'Homepage', title: '[Sample] Loading…' }]
      : [
          { url: `https://${domain}/`, label: 'Homepage', title: '[Sample] Software that ships on time' },
          { url: `https://${domain}/services/`, label: 'Services', title: '[Sample] What we build' },
          { url: `https://${domain}/about/`, label: 'About', title: '[Sample] About us' },
          { url: `https://${domain}/careers/`, label: 'Careers', title: '[Sample] Join the team' },
          { url: `https://${domain}/contact/`, label: 'Contact', title: '[Sample] Contact' },
        ],
    aiStatus: thin ? 'thin' : 'pending',
    buyerFitStatus: thin ? 'thin' : 'pending',
    fixture: true,
    security: { score: wp ? 61 : 74, checks: security },
    health: { score: 79, checks: health, measuredByGoogle: false },
    cms: wp ? wordpressCms() : { platform: 'shopify' },
    stack: [
      { id: 'cf7', name: 'Contact Form 7', category: 'forms' },
      { id: 'workable', name: 'Workable', category: 'recruitment' },
      { id: 'ga4', name: 'Google Analytics 4', category: 'analytics' },
    ],
    fixFirst: rankFixFirst({ checks: [...security, ...health] }),
    attributions: wp ? ['Vulnerability data: Wordfence Intelligence'] : [],
  };
};

interface Pending {
  req: AuditRequest;
  report: AuditReport;
  mockCase: MockCase;
  startedAt: number;
}

export const createMockTransport = (search: string): Transport => {
  const params = new URLSearchParams(search);
  const raw = params.get('case') ?? 'full';
  const mockCase: MockCase = (CASES as readonly string[]).includes(raw) ? (raw as MockCase) : 'full';
  const emailUsed = params.get('emailUsed') === '1';
  const sessionExpired = params.get('sessionExpired') === '1';
  const shareOn = params.get('shareOff') !== '1';
  const features: Features = { share: shareOn, email: shareOn && params.get('emailOff') !== '1', feedback: true, shareRetentionDays: 30 };
  const emailFail = params.get('emailFail') === '1';
  const emailed = new Set<string>();
  const audits = new Map<string, Pending>();
  /** session → auditId, and the mock's saved snapshots. */
  const sessions = new Map<string, string>();
  const shares = new Map<string, SharedReport>();
  const randomId = () => Array.from({ length: 22 }, () => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 56)]).join('');
  const expired = { status: 410, body: { code: 'session_expired', error: '[Sample] Session expired.' } };
  console.info(`[mock api] ${MOCK_MARKER} case=${mockCase}`);

  return async (method, path, body): Promise<HttpResult> => {
    if (method === 'POST' && path === '/api/audit') {
      await wait(POST_DELAY_MS);
      const email = (body as Partial<AuditStartBody> | undefined)?.email;
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { status: 400, body: { code: 'email_invalid', error: '[Sample] Email not accepted.' } };
      }
      if (emailUsed) {
        return { status: 409, body: { code: 'email_used', error: '[Sample] This email has already been used.' } };
      }
      if (mockCase === 'error-unreadable') {
        return { status: 422, body: { code: 'site_unreadable', error: '[Sample] The site refused our request (HTTP 403).' } };
      }
      if (mockCase === 'rate-limited') {
        return { status: 429, body: { code: 'rate_limited', error: 'Too many audits', retryAfterSec: 1740 } };
      }
      // Drop the lead fields: like the server, the audit itself never sees the email.
      const { email: _email, name: _name, marketingOptIn: _optIn, ...req } = body as AuditStartBody;
      const report = baseReport(req, mockCase);
      audits.set(report.auditId, { req, report, mockCase, startedAt: Date.now() });
      const session = randomId();
      sessions.set(session, report.auditId);
      return { status: 200, body: { ...report, session, features } };
    }

    if (path === '/api/feedback' && method === 'POST') {
      await wait(200);
      return sessionExpired ? expired : { status: 204, body: null };
    }

    if (path === '/api/share' && (method === 'POST' || method === 'DELETE')) {
      await wait(300);
      const token = (body as { session?: string } | undefined)?.session ?? '';
      const audit = audits.get(sessions.get(token) ?? '');
      if (sessionExpired || !audit) return expired;
      if (method === 'DELETE') {
        for (const [id, s] of shares) if (s.report.domain === audit.report.domain) shares.delete(id);
        return { status: 204, body: null };
      }
      const shareId = randomId();
      const now = Date.now();
      const { auditId: _id, ...report } = audit.report;
      const { url: _url, persona: _p, ...answers } = audit.req;
      const snap: SharedReport = {
        v: 1,
        shareId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
        report: { ...report, buyerFitStatus: 'unavailable', aiStatus: 'unavailable' },
        answers,
      };
      shares.set(shareId, snap);
      return { status: 201, body: { shareId, url: `${window.location.origin}/r/${shareId}?mock=1`, expiresAt: snap.expiresAt } };
    }

    if (path === '/api/share/email' && method === 'POST') {
      await wait(600);
      const token = (body as { session?: string } | undefined)?.session ?? '';
      if (sessionExpired || !sessions.has(token)) return expired;
      if (emailFail) return { status: 502, body: { code: 'email_failed', error: '[Sample] Provider failed.' } };
      if (emailed.has(token)) return { status: 409, body: { code: 'already_sent', error: '[Sample] Already sent.' } };
      emailed.add(token);
      return { status: 202, body: { sent: true, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } };
    }

    const shareGet = /^\/api\/share\/([^/]+)$/.exec(path);
    if (shareGet && method === 'GET') {
      await wait(300);
      const snap = shares.get(decodeURIComponent(shareGet[1] ?? ''));
      return snap ? { status: 200, body: snap } : { status: 404, body: { code: 'not_found', error: '[Sample] Expired.' } };
    }

    const m = /^\/api\/audit\/([^/]+)\/(buyer-fit|ai)$/.exec(path);
    const audit = m ? audits.get(decodeURIComponent(m[1] ?? '')) : undefined;
    if (method !== 'GET' || !m || !audit) {
      return { status: 404, body: { code: 'not_found', error: 'Not found' } };
    }
    const elapsed = Date.now() - audit.startedAt;
    const { req, report } = audit;

    if (m[2] === 'buyer-fit') {
      await wait(BUYER_FIT_AFTER_MS - elapsed);
      if (audit.mockCase === 'buyerfit-unavailable') {
        const res: BuyerFitResult = { auditId: report.auditId, buyerFitStatus: 'unavailable', fixFirst: report.fixFirst };
        return { status: 200, body: res };
      }
      const bf = buyerFit(req, report.domain);
      const res: BuyerFitResult = {
        auditId: report.auditId,
        buyerFitStatus: 'fixture',
        buyerFit: bf,
        fixture: true,
        fixFirst: rankFixFirst({
          checks: [...report.security.checks, ...report.health.checks],
          buyerFitActions: bf.actions,
        }),
      };
      return { status: 200, body: res };
    }

    await wait(AI_AFTER_MS - elapsed);
    if (audit.mockCase === 'ai-unavailable') {
      const res: AiResult = { auditId: report.auditId, aiStatus: 'unavailable' };
      return { status: 200, body: res };
    }
    const res: AiResult = { auditId: report.auditId, aiStatus: 'fixture', ai: aiSection(req, report.domain), fixture: true };
    return { status: 200, body: res };
  };
};
