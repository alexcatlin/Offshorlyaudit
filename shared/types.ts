// Shared contracts between server and client. Types only: no runtime code here.
// See docs/PLAN.md "Data shapes".

// ---------- Ids ----------

export type SecurityCheckId =
  | 'sec-https'
  | 'sec-redirect'
  | 'sec-hsts'
  | 'sec-csp'
  | 'sec-frame'
  | 'sec-nosniff'
  | 'sec-referrer'
  | 'sec-cookies'
  | 'sec-disclosure'
  | 'sec-mixed'
  | 'sec-spf'
  | 'sec-dmarc';

export type WordPressCheckId =
  | 'wp-core-version'
  | 'wp-plugins'
  | 'wp-theme'
  | 'wp-xmlrpc'
  | 'wp-version-exposed';

export type HealthCheckId =
  | 'seo-title'
  | 'seo-description'
  | 'seo-h1'
  | 'seo-indexable'
  | 'seo-content'
  | 'seo-sitemap'
  | 'seo-canonical'
  | 'seo-og'
  | 'seo-alt'
  | 'geo-bots'
  | 'geo-nojs'
  | 'geo-structured'
  | 'geo-questions'
  | 'spd-ttfb'
  | 'spd-viewport'
  | 'spd-compression'
  | 'spd-html-size'
  | 'spd-blocking-scripts';

export type PageSpeedCheckId = 'spd-google-score' | 'spd-lcp' | 'spd-cls' | 'spd-tbt';

export type CheckId = SecurityCheckId | WordPressCheckId | HealthCheckId | PageSpeedCheckId;

export type AiServiceId =
  | 'free-ai-consultation'
  | 'ai-automation'
  | 'ai-agent-development'
  | 'ai-development-services'
  | 'dedicated-ai-teams'
  | 'ai-product-development'
  | 'ai-saas-enhancer';

export type WebServiceId = 'websites' | 'wordpress' | 'website-redesign';

export type ServiceId = AiServiceId | WebServiceId;

export type ProofId = 'lender-appraisal' | 'lender-savings' | 'compliance-tickets' | 'contained-roi';

// ---------- Common ----------

export type Lvl = 'high' | 'medium' | 'low';
export type Owner = 'leadership' | 'marketing' | 'developer';
export type SectionId = 'security' | 'health';
/** Sections that can feed "Fix these first". */
export type FixSection = SectionId | 'buyer-fit';

// ---------- Catalogues ----------

export interface CheckMeta {
  section: SectionId;
  weight: number;
  impact: Lvl;
  effort: Lvl;
  owner: Owner;
  /** false = never listed in "Fix these first" (e.g. spd-google-score). */
  rankable: boolean;
}

export interface Service {
  id: ServiceId;
  name: string;
  /** Path on offshorly.com, with leading and trailing slash. */
  path: string;
  kind: 'ai' | 'web';
  /** Model-facing hint: when this service fits. */
  fitsWhen: string;
}

export interface Proof {
  id: ProofId;
  /** Services this proof point may be shown with. */
  serviceIds: ServiceId[];
  /** Fixed visitor-facing text. */
  text: string;
  /** Path on offshorly.com, with leading and trailing slash. */
  path: string;
}

// ---------- Request ----------

export type TeamSize = '1-10' | '11-50' | '51-200' | '200+';

/** The buyer the site is judged against (guide §4). */
export interface Persona {
  /** e.g. "Founder" */
  role: string;
  /** e.g. "25-person digital agency" */
  size: string;
  /** e.g. "B2B SaaS" */
  sector: string;
  /** Why they are looking now. */
  trigger: string;
}

export interface AuditRequest {
  url: string;
  /** ≤100; blank → inferred by the AI. */
  businessType?: string;
  /** role/size/sector ≤200, trigger ≤300; blank fields → inferred by the AI. */
  persona?: Partial<Persona>;
  teamSize?: TeamSize;
  timeSink?: string;
}

// ---------- Checks ----------

export type Status = 'pass' | 'warn' | 'fail' | 'info';

export interface CheckResult {
  id: CheckId;
  status: Status;
  /** Factual, server-written. */
  detail: string;
}

export interface Section {
  score: number | null;
  checks: CheckResult[];
}

// ---------- AI ----------

export interface EvidenceQuote {
  quote: string;
  pageUrl: string;
  pageLabel: string;
  effect?: 'for' | 'against';
  note?: string;
}

export type Basis =
  | ({ kind: 'quote' } & EvidenceQuote)
  | { kind: 'answer'; field: 'timeSink' | 'teamSize' }
  | { kind: 'stack'; techId: string; name: string };

export type Efficiency = 'time-per-task' | 'turnaround' | 'capacity' | 'error-rate' | 'tool-costs';

export type Confidence = 'likely' | 'worth-checking';

export interface AiOpportunity {
  /** ≤8 words */
  title: string;
  /** ≤30 words, the manual work as inferred */
  process: string;
  /** ≥1 after validation */
  basis: Basis[];
  /** ≤40 words */
  aiApproach: string;
  efficiency: Efficiency;
  /** ≤20 words */
  measureFirst: string;
  confidence: Confidence;
  /** Server-attached from the catalogue. */
  service: { id: ServiceId; name: string; url: string };
  /** Server-attached. */
  proof?: { id: ProofId; text: string; url: string };
}

export type Customers = 'b2b' | 'b2c' | 'both' | 'unclear';

export interface AiSection {
  business: { summary: string; customers: Customers };
  /** 0–3 */
  opportunities: AiOpportunity[];
  notWorthIt: string;
}

/** Raw model output, validated server-side into AiSection. Never trusted as-is. */
export interface RawAiOutput {
  business: { summary: string; customers: string };
  opportunities: {
    title: string;
    process: string;
    quotes: string[];
    techIds: string[];
    usesAnswer: boolean;
    aiApproach: string;
    efficiency: string;
    measureFirst: string;
    confidence: string;
    serviceId: string;
    proofId: string | null;
  }[];
  notWorthIt: string;
}

// ---------- Buyer fit (guide §4, §5.4, §5.5) ----------

export type CriterionWeight = 'high' | 'medium' | 'low';

export interface EvaluationCriterion {
  name: string;
  /** What good looks like. */
  description: string;
  redFlags: string[];
  weight: CriterionWeight;
}

export interface ScoredCriterion {
  name: string;
  /** Integer 0–10. */
  score: number;
  reasoning: string;
  weight: CriterionWeight;
  /** 0–2 verified quotes. */
  evidence?: EvidenceQuote[];
}

export interface ActionItem {
  text: string;
  horizon: 'now' | 'later';
  impact: Lvl;
  effort: Lvl;
  owner: Owner;
}

export interface BuyerFit {
  businessType: string;
  businessTypeInferred: boolean;
  persona: Persona;
  personaInferred: boolean;
  /** 0–100, server-computed (critical ×3, important ×2, supporting ×1). */
  score: number | null;
  verdict: { summary: string; brutalTruth: string };
  /** ≤3 */
  strengths: string[];
  /** 4–6 */
  criteria: ScoredCriterion[];
  mismatchIndex: { point: string; explanation: string }[];
  /** ≤6 */
  actions: ActionItem[];
}

// ---------- CMS ----------

export interface WpComponent {
  type: 'plugin' | 'theme';
  slug: string;
  name: string | null;
  version: string | null;
  versionSource: 'asset' | 'stylesheet' | null;
  latest: string | null;
  directory: 'listed' | 'closed' | 'not_listed' | 'unknown';
  lastUpdated?: string;
  stale: boolean;
  status: 'up_to_date' | 'outdated' | 'fix_available' | 'unknown';
}

export type Platform =
  | 'wordpress'
  | 'shopify'
  | 'wix'
  | 'squarespace'
  | 'webflow'
  | 'drupal'
  | 'joomla'
  | 'unknown';

export interface WordPressInfo {
  core: {
    version: string | null;
    source: 'generator' | 'feed' | 'asset' | null;
    latest: string | null;
    status: 'latest' | 'outdated' | 'insecure' | 'unknown';
  };
  components: WpComponent[];
  xmlrpcAdvertised: boolean;
  versionExposed: boolean;
  vulnSource: 'wordfence' | null;
  /** Aggregate only, never CVE ids. */
  knownIssues?: { count: number; highest: 'low' | 'medium' | 'high' | 'critical' };
}

export interface CmsInfo {
  platform: Platform;
  /** Non-WP generator version, fact only. */
  version?: string | null;
  wordpress?: WordPressInfo;
}

export interface DetectedTech {
  id: string;
  name: string;
  category: string;
}

// ---------- Report ----------

export interface FixItem {
  source: 'check' | 'ai';
  section: FixSection;
  checkId?: CheckId;
  /** source 'ai': index into buyerFit.actions. */
  actionIndex?: number;
}

export type AiStatus = 'pending' | 'ok' | 'fixture' | 'thin' | 'insufficient' | 'unavailable';

export type BuyerFitStatus = 'pending' | 'ok' | 'fixture' | 'thin' | 'unavailable';

export interface PageRead {
  url: string;
  label: string;
  title: string;
}

export interface AuditReport {
  auditId: string;
  auditedAt: string;
  url: string;
  domain: string;
  pagesRead: PageRead[];
  aiStatus: AiStatus;
  ai?: AiSection;
  buyerFitStatus: BuyerFitStatus;
  buyerFit?: BuyerFit;
  fixture?: true;
  security: Section;
  health: Section & { measuredByGoogle: boolean };
  cms: CmsInfo;
  stack: DetectedTech[];
  /** ≤5, at most 2 per section. Measured checks only until buyer fit arrives. */
  fixFirst: FixItem[];
  /** e.g. Wordfence when used */
  attributions: string[];
  leadCapture: boolean;
  /** Measured parts that missed the audit deadline and were left out (their checks are omitted). */
  omitted?: MeasuredPart[];
}

/** Measured work that runs after the site read, each under the overall deadline. */
export type MeasuredPart = 'site-files' | 'email-dns' | 'pagespeed' | 'wordpress';

/** Response of GET /api/audit/:auditId/ai */
export interface AiResult {
  auditId: string;
  aiStatus: 'ok' | 'fixture' | 'insufficient' | 'unavailable';
  ai?: AiSection;
  fixture?: true;
}

/** Response of GET /api/audit/:auditId/buyer-fit */
export interface BuyerFitResult {
  auditId: string;
  buyerFitStatus: 'ok' | 'fixture' | 'unavailable';
  buyerFit?: BuyerFit;
  fixture?: true;
  /** Re-ranked with buyer-fit actions; replaces the report's list. */
  fixFirst: FixItem[];
}

// ---------- Errors ----------

export type ErrorCode =
  | 'bad_request'
  | 'forbidden'
  | 'site_not_found'
  | 'site_unreadable'
  | 'not_found'
  | 'rate_limited'
  | 'busy'
  | 'server_error';

export interface ApiError {
  code: ErrorCode;
  error: string;
  retryAfterSec?: number;
}
