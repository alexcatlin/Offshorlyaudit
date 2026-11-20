// Shared contracts between server and client. Types only: no runtime code here.
// See docs/PLAN.md "Data shapes".
import type { IndustryChoice, IndustryId } from './industries.js';

export type { IndustryChoice, IndustryId } from './industries.js';

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
  /** The visitor's own business, ≤100; blank → inferred by the AI. Used by buyer fit and opportunities. */
  businessType?: string;
  /** The visitor's industry from the playbook; blank / "not sure" → inferred by the AI. */
  industry?: IndustryId;
  /** The BUYER the site is judged against. role/size/sector ≤200, trigger ≤300; blank fields → inferred. */
  persona?: Partial<Persona>;
  teamSize?: TeamSize;
  /** ≤200 */
  timeSink?: string;
  /** ≤150: "Which tools does your team use day to day?" */
  tools?: string;
}

/** Lead fields sent with POST /api/audit. Never part of AuditRequest, the cache key or any prompt. */
export interface LeadFields {
  email: string;
  /** ≤100, sanitised server-side. */
  name?: string;
  marketingOptIn?: boolean;
}

/** Body of POST /api/audit. The server splits it; runAudit sees AuditRequest only. */
export type AuditStartBody = AuditRequest & LeadFields;

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
  | { kind: 'answer'; field: 'timeSink' | 'tools' | 'teamSize' }
  | { kind: 'stack'; techId: string; name: string }
  /** A playbook pattern for the business's industry: server text, not checked against the site. */
  | { kind: 'industry'; patternId: string; industryLabel: string; text: string }
  /** A cited web-search result (Phase 5). Server-attached; `title` absent when it failed the filters. */
  | ({ kind: 'source' } & ExampleSource);

/** A third-party web page a search result pointed to. We never fetch it. */
export interface ExampleSource {
  title?: string;
  domain: string;
  /** http(s), validated server-side. */
  url: string;
}

/** "What others in {industry} are doing": one sentence grounded in cited search results. */
export interface IndustryExample {
  /** ≤30 words */
  text: string;
  /** 1–2, server-attached from the cited result ids. */
  sources: ExampleSource[];
}

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
  /** 'site' = grounded in the site or answers; 'industry' = a playbook pattern. Absent in older JSON (= site). */
  source?: 'site' | 'industry';
  /** ≤35 words: how businesses of this type commonly handle this work. Omitted when empty. */
  industryContext?: string;
}

export type Customers = 'b2b' | 'b2c' | 'both' | 'unclear';

export interface AiSection {
  business: { summary: string; customers: Customers };
  /** The industry used for the playbook ideas. Absent in older JSON. */
  industry?: { id: IndustryChoice; label: string; inferred: boolean };
  /** 0–5: up to 3 site ideas first, then up to 2 industry ideas. */
  opportunities: AiOpportunity[];
  notWorthIt: string;
  /** Phase 5: 0–3 examples from an industry web search. Absent in older JSON or without search. */
  industryExamples?: IndustryExample[];
  /** Phase 5: present when web-search results were given to the model for this report. */
  research?: { industryId: IndustryId; label: string; searchedAt: string };
}

/** Raw model output, validated server-side into AiSection. Never trusted as-is. */
export interface RawAiOutput {
  business: { summary: string; customers: string; industryId: string; industryLabel: string };
  opportunities: {
    title: string;
    source: 'site' | 'industry';
    patternId: string | null;
    process: string;
    quotes: string[];
    techIds: string[];
    usesAnswer: boolean;
    aiApproach: string;
    industryContext: string;
    efficiency: string;
    measureFirst: string;
    confidence: string;
    serviceId: string;
    proofId: string | null;
    /** Phase 5: INDUSTRY SEARCH RESULTS ids; industry ideas only. Absent in older output. */
    sourceIds?: string[];
  }[];
  /** Phase 5. Absent in older output. */
  industryExamples?: { text: string; sourceIds: string[] }[];
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

// ---------- Session, feedback, sharing (Amendment 5) ----------

/** What the report may offer. `email` is true only when report email is configured (Phase 4). */
export interface Features {
  share: boolean;
  email: boolean;
  feedback: boolean;
  /** Days a shared report is kept (footer copy and the link notice). */
  shareRetentionDays: number;
}

/**
 * Response of POST /api/audit. `session` is per response (never cached, never in a URL) and
 * is the only handle for share, email and feedback.
 */
export interface AuditStartResponse extends AuditReport {
  session: string;
  features: Features;
}

/** The visitor answers a saved or printed report shows (BasisItem reads them). Never lead fields. */
export type ShareAnswers = Pick<AuditRequest, 'timeSink' | 'tools' | 'teamSize' | 'industry' | 'businessType'>;

/** A saved snapshot, built server-side from the server's own AuditEntry. No email, no auditId. */
export interface SharedReport {
  v: 1;
  shareId: string;
  createdAt: string;
  expiresAt: string;
  report: Omit<AuditReport, 'auditId'>;
  answers: ShareAnswers;
}

/** Response of POST /api/share */
export interface ShareCreated {
  shareId: string;
  url: string;
  expiresAt: string;
}

/** Body of POST /api/share/email (Phase 4). `email` must be the address the audit was run with. */
export interface EmailReportBody {
  session: string;
  email: string;
}

/** Response of POST /api/share/email (202). */
export interface EmailReportSent {
  sent: true;
  expiresAt: string;
}

/** Body of POST /api/feedback. `vote: null` clears an earlier vote. */
export interface FeedbackBody {
  session: string;
  ideaIndex: number;
  vote: 'up' | 'down' | null;
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
  | 'server_error'
  /** 400: missing, malformed, disposable or undeliverable email. */
  | 'email_invalid'
  /** 409: this email already had its free audit (of another site). */
  | 'email_used'
  /** 410: the per-response session is gone (restart, expiry). Share/email/feedback need a new audit. */
  | 'session_expired'
  /** 409: the AI results this action needs have not settled yet. */
  | 'not_ready'
  /** 409: this report was already emailed (Phase 4). */
  | 'already_sent'
  /** 503: the share store refused (off, full, low disk, snapshot too large). */
  | 'share_unavailable'
  /** 502: the email provider failed (Phase 4). */
  | 'email_failed';

export interface ApiError {
  code: ErrorCode;
  error: string;
  retryAfterSec?: number;
}
