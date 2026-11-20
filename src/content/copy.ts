// Visitor-facing copy. UK English; plain, direct, anti-hype; written for a non-technical
// business owner.
//
// Rules: never use the word "vulnerable". No figures for the visitor's business. Never
// say the proof of concept is free or fixed-price. Never quote the lender first-tool saving.
import type {
  AiStatus,
  Confidence,
  Customers,
  Efficiency,
  ErrorCode,
  Lvl,
  Owner,
  Status,
  TeamSize,
} from '../../shared/types.js';
import { CTA } from '../../shared/services.js';

export interface LoadingStage {
  /** Seconds after submit when this message appears. */
  afterSec: number;
  text: string;
}

export const LOADING_STAGES: readonly LoadingStage[] = [
  { afterSec: 0, text: 'Reading your homepage' },
  { afterSec: 3, text: 'Following key pages' },
  { afterSec: 7, text: 'Checking security and WordPress' },
  { afterSec: 11, text: 'Checking search basics and speed' },
  { afterSec: 18, text: 'Nearly there… slow sites take a little longer' },
];

export const TEAM_SIZE_OPTIONS: readonly { value: TeamSize; label: string }[] = [
  { value: '1-10', label: '1–10 people' },
  { value: '11-50', label: '11–50 people' },
  { value: '51-200', label: '51–200 people' },
  { value: '200+', label: 'More than 200 people' },
];

/** Suggestions for the business-type field (guide §6.1). Free text is still accepted. */
export const BUSINESS_TYPE_SUGGESTIONS: readonly string[] = [
  'Technology Agency',
  'Creative Agency',
  'Marketing Agency',
  'Brand Agency',
  'CRO Agency',
  'Full Service Agency',
  'Digital Agency',
  'PR Agency',
  'UX/Design Agency',
  'Architectural Firm',
  'Law Firm',
  'Consultancy',
];

/** "See example" fills these into the buyer fields. */
export const EXAMPLE_BUYER = {
  businessType: 'Technology Agency',
  role: 'Founder',
  size: '10–50 person software company',
  sector: 'B2B SaaS',
  trigger: 'Needs software built without hiring in-house',
} as const;

export const EFFICIENCY_LABELS: Record<Efficiency, string> = {
  'time-per-task': 'Less time per task',
  turnaround: 'Faster turnaround',
  capacity: 'More work handled by the same team',
  'error-rate': 'Fewer mistakes',
  'tool-costs': 'Lower software costs',
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  likely: 'Likely fit',
  'worth-checking': 'Worth checking',
};

export const CUSTOMERS_LABELS: Record<Customers, string> = {
  b2b: 'Sells to businesses',
  b2c: 'Sells to consumers',
  both: 'Sells to businesses and consumers',
  unclear: '',
};

export const STATUS_LABELS: Record<Status, string> = {
  fail: 'Fix',
  warn: 'Improve',
  pass: 'Passed',
  info: 'Note',
};

export const IMPACT_LABELS: Record<Lvl, string> = {
  high: 'High impact',
  medium: 'Medium impact',
  low: 'Low impact',
};

export const EFFORT_LABELS: Record<Lvl, string> = {
  low: 'Quick fix',
  medium: 'Some work',
  high: 'A project',
};

export const OWNER_LABELS: Record<Owner, string> = {
  leadership: 'For you',
  marketing: 'For marketing',
  developer: 'For your developer',
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Friendly error text per API error code. `serverError` is the server's own `error`
 * string, used where the wording builds on it (guide §6.1).
 */
export const ERROR_COPY: Record<ErrorCode, (serverError: string, retryAfterSec?: number) => string> = {
  bad_request: () => "That doesn't look like a website address. Please check it and try again.",
  forbidden: () => 'This request was blocked. Please reload the page and try again.',
  site_not_found: (e) => `${e} Please check the address and try again.`.trim(),
  site_unreadable: (e) =>
    `We couldn't read this website, so we haven't produced an audit. ${e} That is worth knowing in itself: AI assistants and some search tools read sites the same way, so they may be shut out too.`.replace(
      /\s+/g,
      ' ',
    ),
  rate_limited: (_e, retryAfterSec) => {
    const minutes = Math.max(1, Math.ceil((retryAfterSec ?? 60) / 60));
    return `You've run a few audits already. Please try again in ${plural(minutes, 'minute', 'minutes')}.`;
  },
  not_found: () => 'This report has expired. Please run the audit again.',
  busy: () => "We're running a lot of audits right now. Please try again in a minute.",
  server_error: () => 'Something went wrong on our side. Please try again.',
  email_invalid: () => "We couldn't confirm that email address can receive email. Please check it and try again.",
  email_used: () =>
    "This email has already been used for a free audit. Want to go further? Book a free 30-minute call and we'll walk through your site and where AI could help.",
};

export const COPY = {
  hero: {
    title: 'Does your website win buyers, and where could AI save you time?',
    sub: 'A free check of how your site lands with the buyers you want, its security and search basics, and where AI could take repetitive work off your team. Website results usually take under 30 seconds; buyer fit and AI ideas follow on the report.',
  },

  form: {
    urlLabel: 'Your website',
    urlPlaceholder: 'yourcompany.com',
    urlHint: 'Your homepage address. We read it and up to four key pages.',
    urlRequired: 'Please enter your website address.',
    urlInvalid: "That doesn't look like a website address. Please check it and try again.",
    optional: 'Optional',
    buyerToggle: 'Who are you trying to win?',
    buyerHelp:
      "Describe the buyer you want to attract and we'll show you what they see. Leave it blank and we'll work out who your site appears to be aimed at.",
    seeExample: 'See example',
    clearExample: 'Clear',
    businessTypeLabel: 'What kind of business are you?',
    businessTypePlaceholder: 'For example: Law Firm',
    businessTypeHelp: 'Type anything. The AI works out the right criteria for your type of business.',
    roleLabel: 'Their role',
    rolePlaceholder: 'For example: Founder',
    sizeLabel: 'Their company size',
    sizePlaceholder: 'For example: 20-person agency',
    sectorLabel: 'Their sector',
    sectorPlaceholder: 'For example: B2B SaaS',
    triggerLabel: "Why they're looking now",
    triggerPlaceholder: 'For example: outgrown freelancers',
    detailToggle: 'Add detail for AI ideas',
    detailHelp: 'Two quick answers make the AI ideas more specific to how your team works.',
    timeSinkCount: (used: number, max: number) => `${used} of ${max} characters`,
    teamSizeLabel: 'How big is your team?',
    teamSizePlaceholder: 'Choose a size',
    timeSinkLabel: "What eats most of your team's week?",
    timeSinkPlaceholder: 'For example: typing up quotes, chasing invoices, answering the same customer emails',
    timeSinkMaxLength: 200,
    emailLabel: 'Your email',
    emailPlaceholder: 'you@yourcompany.com',
    emailRequired: 'Please enter your email address.',
    emailInvalid: "That doesn't look like an email address. Please check it and try again.",
    nameLabel: 'Your name',
    namePlaceholder: 'For example: Sam Taylor',
    /** Under the email/name row; followed by the privacy policy link. */
    leadNotice:
      "We'll add your email, the site you audit and its results to Offshorly's CRM so we can follow up about this audit. One free audit per email.",
    marketingOptIn: 'Email me occasional ideas and offers from Offshorly. You can unsubscribe at any time.',
    submit: 'Run the audit',
    privacyNotice:
      "We read the public pages of the site you enter and use Anthropic's Claude to analyse them. Your email is never sent to Anthropic.",
    privacyLinkLabel: 'Privacy policy',
    emailUsedContact: "Or tell us what you're building",
  },

  loading: {
    heading: 'Running your audit',
    sub: 'The website audit takes a few seconds. Buyer fit and AI ideas follow on the report.',
  },

  report: {
    heading: (domain: string) => `Website audit for ${domain}`,
    tabsLabel: 'Report sections',
    tabWebsite: 'Website audit',
    tabAi: 'AI opportunities',
    tabAiPending: 'Still working',
    tabAiCount: (n: number) => `${n} ${n === 1 ? 'idea' : 'ideas'}`,
    pending: 'Still reading your pages…',
    pendingDetail: 'This part usually takes under a minute. You can read the rest of the report meanwhile.',
  },

  context: {
    businessTypeInferred: 'inferred from your site',
    eyesOf: 'Assessed through the eyes of:',
    whyLooking: "Why they're looking:",
    inferredBuyer:
      'You left some buyer details blank, so we filled them in with the buyer your site appears to be aimed at.',
    buyerFitUnavailable:
      "We couldn't assess buyer fit this time, so the measured checks below stand alone.",
    buyerFitThin:
      'Your homepage came back almost empty when we read it, so we skipped the buyer-fit assessment. The measured checks below still stand.',
  },

  verdict: {
    scoreLabel: 'Buyer fit',
    outOf: 'out of 100',
    oneSentence: 'In one sentence',
    brutalTruth: 'The brutal truth',
  },

  tiles: {
    allClear: 'Everything we checked is in order',
    summary: (fix: number, improve: number) => {
      const parts: string[] = [];
      if (fix) parts.push(`${fix} to fix`);
      if (improve) parts.push(`${improve} to improve`);
      return parts.join(', ');
    },
    startWith: 'Start with:',
  },

  whatsWorking: {
    heading: "What's working",
    empty: 'Nothing stood out as a clear strength for this buyer.',
  },

  buyerFit: {
    heading: 'Buyer fit',
    summary: (n: number, weakest: string, score: number) =>
      `${n} things this buyer looks for. Weakest: ${weakest} (${score}/10)`,
    intro:
      'Each criterion is scored out of 10 from what your pages actually say. The overall score is an average in which critical criteria count three times, important ones twice and supporting ones once, so it can differ slightly from a simple average.',
    weight: { high: 'Critical', medium: 'Important', low: 'Supporting' },
    outOfTen: (n: number) => `${n} out of 10`,
    viewPage: (label: string) => `See it on: ${label}`,
    mismatchHeading: 'Where image and reality part',
    mismatchSummary: (n: number) => `${n} ${n === 1 ? 'place' : 'places'} your site undercuts itself`,
    actionsHeading: 'Action plan for winning this buyer',
    actionsSummary: (now: number, later: number) => `${now} to do now, ${later} longer-term`,
    doNow: 'Do now',
    longerTerm: 'Longer-term shifts',
    fixSectionLabel: 'Buyer fit',
  },

  detail: {
    show: 'Show detail',
    hide: 'Hide detail',
    heading: 'The detail',
  },

  header: {
    auditedOn: (date: string) => `Audited on ${date}`,
    whatWeThinkYouDo: 'What we think you do',
  },

  ai: {
    heading: 'Where AI could help',
    intro: "Ideas to test in a free consultation, not promises. We've only read your public website.",
    whyWeThinkSo: 'Why we think so',
    howAiCouldHelp: 'How AI could help',
    likelyBenefit: 'Likely benefit',
    measureFirst: 'Measure first',
    basisQuote: 'From your website',
    basisAnswer: 'From your answer',
    basisStack: 'From the tools your site uses',
    basisToldUs: 'You told us',
    basisTeamSize: (size: string) => `Your team size: ${size}`,
    basisDetected: (name: string) => `Your site uses ${name}`,
    processLabel: 'The work today',
    confidenceLabel: 'How sure we are',
    businessHeading: 'What we think you do',
    ideasHeading: (n: number) => (n === 1 ? 'One idea worth testing' : `${n} ideas worth testing`),
    serviceLink: (name: string) => `${name} at Offshorly`,
    proofLink: 'Read the case study',
    pitchHeading: 'Find where AI would actually pay off',
    pitchText:
      "Most repetitive work never shows up on a public website. In a free consultation we look at how your team spends its week, find the process that costs most by hand, and tell you straight if AI isn't worth it.",
    thinHeading: 'AI tools read sites the same way',
    thinTab:
      "Your homepage came back almost empty when we read it, which usually means the site builds its content in the browser. So we haven't suggested AI ideas. That is worth knowing in itself: AI assistants and some search tools read sites the same way, so they may be shut out too. Security and website health are still measured: see the Website audit tab.",
    unavailableTab: "AI ideas aren't available right now.",

    suggestedService: 'How Offshorly would approach it',
    proofLabel: 'An Offshorly client result. Your numbers will differ.',
    notWorthItHeading: 'Probably not worth automating',
    thin: "Your homepage came back almost empty when we read it, which usually means the site builds its content in the browser. So we haven't suggested AI ideas. That is worth knowing in itself: AI assistants and some search tools read sites the same way, so they may be shut out too. Security and website health below are still measured.",
    insufficient:
      "We couldn't find enough on your public website to suggest AI ideas we'd stand behind. That's normal: most repetitive work never shows up on a website. A free consultation is the quickest way to find where AI would actually pay off, and we'll tell you straight if it wouldn't.",
    unavailable:
      "AI ideas aren't available right now. Security and website health below are still measured. Please try again later for AI ideas.",
    fixtureBanner: 'Sample AI output for development, not an analysis of this site',
  },

  fixFirst: {
    heading: 'Fix these first',
    intro: 'The changes we would make first, across everything we checked.',
    empty: 'Nothing urgent stood out. Everything we checked is in order or close to it.',
  },

  security: {
    heading: 'Security',
    intro: 'Basic protective settings anyone can see from outside, plus email forgery protection.',
  },

  wordpress: {
    heading: 'WordPress',
    intro: 'What your site shows publicly about its WordPress software.',
    updatesNote: 'Updates often include security fixes.',
    versionNotShown: 'Version not shown publicly',
    securityFixChip: 'Security fix available',
    notListed: 'Not in the WordPress directory (premium or custom), so no public update information',
    closed: 'Closed: no longer available in the WordPress.org directory',
    stale: 'Not updated in over two years',
    running: 'Running',
    latest: 'Latest',
    knownIssues: (count: number, highest: string) =>
      `${plural(count, 'published security issue affects', 'published security issues affect')} versions we saw (highest rating: ${highest}).`,
    shareDetails: 'We share full details with the site owner on request.',
    wordfenceAttribution: 'Vulnerability data: Wordfence Intelligence',
    wordfenceUrl: 'https://www.wordfence.com/threat-intel/',
    core: 'WordPress core',
    plugins: 'Plugins and theme',
    plugin: 'Plugin',
    theme: 'Theme',
    statusLatest: 'Up to date',
    statusOutdated: 'Update available',
    statusInsecure: 'Listed as insecure by WordPress.org',
    statusUnknown: 'No public update information',
    sourceGenerator: 'seen in the page code',
    sourceFeed: 'seen in the news feed',
    sourceAsset: "seen in the page's file links",
    sourceStylesheet: "seen in the theme's stylesheet",
    unknownVersion: 'Not visible',
  },

  /** One muted line when a measured part missed the audit deadline. */
  omittedChecks: "Some checks didn't finish in time and aren't shown.",

  health: {
    heading: 'Website health',
    intro: 'Search basics, how readable your site is for AI tools, and speed.',
    notScored: 'Not scored',
    googleSpeedNote: "Google's speed result varies a little between tests.",
    noGoogleSpeedNote: "A full loading-time score from Google's test isn't included.",
  },

  firstImpression: {
    heading: 'First impression',
    biggestGap: 'Biggest gap',
    workingFor: 'Working for you',
    workingAgainst: 'Working against you',
  },

  checks: {
    passedCount: (n: number) => `${plural(n, 'check', 'checks')} passed`,
    showPassed: 'Show passed checks',
    hidePassed: 'Hide passed checks',
    allClear: 'Everything we checked is in order',
  },

  offshorlyCanHelp: 'Offshorly can help with this',

  sectionLabels: {
    security: 'Security',
    health: 'Website health',
    'buyer-fit': 'Buyer fit',
  },

  whatWeRead: {
    heading: 'What we read',
    summary: (n: number) => `${n} ${n === 1 ? 'page' : 'pages'} from your public website`,
  },

  attributionsHeading: 'Data sources',

  cta: {
    heading: 'Want to test one of these ideas?',
    text: "One process first, measured before the next. In a free consultation we look at your real numbers, and we'll tell you straight if AI isn't worth it.",
    secondaryHeading: 'Talk it through with us',
    secondaryText: "Book a call, or tell us what you're working on.",
    pitchHeading: 'Talk to us about where AI would pay off',
    websiteHeading: 'Want a hand with any of this?',
    websiteText:
      "We build and look after websites, and we'll tell you straight which fixes matter and which can wait.",
    primary: CTA.consultation.label,
    secondary: "Tell us what you're building",
  },

  footer: {
    whatWeRead: 'What we read',
    disclaimer:
      'Passive checks only: we look at what your site shows any visitor. This is not a penetration test.',
    privacy:
      "We don't save reports or create share links. We keep your email, the site you audited and a summary of the results in our CRM to follow up. Results are otherwise held briefly in memory. The text of the pages we read is sent to Anthropic's Claude for analysis.",
    newAudit: 'Run another audit',
  },

  errors: {
    network: "We couldn't reach the audit service. Please check your connection and try again.",
    render: "We couldn't display this report. Refresh the page and run the audit again.",
    renderButton: 'Start again',
  },

  aiStatusNote: {
    pending: '',
    ok: '',
    fixture: 'Sample AI output for development, not an analysis of this site',
    thin: 'AI ideas skipped: the homepage text was almost empty',
    insufficient: 'Not enough public evidence for AI ideas',
    unavailable: "AI ideas aren't available right now",
  } satisfies Record<AiStatus, string>,

  standalone: {
    footer: 'Offshorly Ltd. UK-led AI development company.',
  },
} as const;
