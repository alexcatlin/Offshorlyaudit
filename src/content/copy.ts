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
  IndustryId,
  Region,
  TeamSize,
} from '../../shared/types.js';
import { REGIONS } from '../../shared/types.js';
import { INDUSTRIES, INDUSTRY_IDS } from '../../shared/industries.js';
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

export const REGION_OPTIONS: readonly { value: Region; label: string }[] = (Object.keys(REGIONS) as Region[]).map((value) => ({
  value,
  label: REGIONS[value],
}));

/** Staged messages while the AI tab is pending (Amendment 4 §7). */
export const AI_LOADING_STAGES: readonly LoadingStage[] = [
  { afterSec: 0, text: 'Reading what your business does' },
  { afterSec: 8, text: 'Matching common automations in your industry' },
  { afterSec: 20, text: 'Checking every quote against your pages' },
];

/** Options for the industry select, in playbook order. The blank option is "not sure". */
export const INDUSTRY_OPTIONS: readonly { value: IndustryId; label: string }[] = INDUSTRY_IDS.map((id) => ({
  value: id,
  label: INDUSTRIES[id].label,
}));

/** "See example" fills these into the buyer fields (the visitor's own business type is separate). */
export const EXAMPLE_BUYER = {
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

/** First line of "Why we think so": what the pill means. Industry ideas are always worth-checking, so no "your site" there. */
export const CONFIDENCE_MEANINGS: Record<Confidence, string> = {
  likely: 'Rated likely fit: your site or your answers point to this directly.',
  'worth-checking': 'Rated worth checking: the evidence is indirect, so it is best confirmed in a conversation.',
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

/** Report actions row: Save as PDF, Copy link, and (Phase 4) email (Amendment 5). */
const ACTIONS = {
  pdf: 'Save as PDF',
  /** In the status line under the row, after Save as PDF is clicked. */
  pdfHint: "In the print window, choose 'Save as PDF' as the destination.",
  waiting: 'Available when the report has finished loading.',
  printOrphan: "Open this page from the report's Save as PDF button.",
  copyLink: 'Copy link',
  linkCopied: (date: string) => `Link copied. Anyone with it can view this report, including your answers, until ${date}.`,
  /** Clipboard refused (e.g. inside an iframe): the URL is shown selected instead. */
  linkReady: (date: string) => `Copy this link. Anyone with it can view this report, including your answers, until ${date}.`,
  linkLabel: 'Link to this report',
  deleteLink: 'Delete link',
  linkDeleted: 'Link deleted.',
  sessionExpired:
    "This report is no longer held on our server, so it can't be shared or emailed. Run the audit again with the same site and email to share it.",
  shareUnavailable: "Sharing isn't available right now. Please try again later.",
  // Phase 4: email the report (shown only when features.email is true).
  email: 'Email me this report',
  emailConfirm: (masked: string) => `We'll email a link to this report to ${masked}. We only send to the address you entered.`,
  emailSend: 'Send',
  emailCancel: 'Cancel',
  emailSent: 'Sent. It should arrive in a minute or two; check your spam folder if not.',
  emailFailed: "We couldn't send the email just now. Copy the link instead.",
  emailAlready: "We've already emailed this report.",
} as const;

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
  session_expired: () => ACTIONS.sessionExpired,
  not_ready: () => ACTIONS.waiting,
  already_sent: () => ACTIONS.emailAlready,
  share_unavailable: () => ACTIONS.shareUnavailable,
  email_failed: () => ACTIONS.emailFailed,
};

export const COPY = {
  hero: {
    title: 'Does your website win the customers you want, and where could AI save you time?',
    sub: 'Free, and website results usually take under 30 seconds; customer fit and AI ideas follow on the report.',
    getsLabel: 'What you get',
    gets: [
      'A customer-fit score, with quotes from your own pages',
      'Security, search (SEO) and speed checks, with a fix-first list',
      'AI ideas matched to your business',
    ],
  },

  form: {
    urlLabel: 'Your website',
    urlPlaceholder: 'yourcompany.com',
    urlHint: 'Your homepage address. We read it and up to four key pages.',
    urlRequired: 'Please enter your website address.',
    urlInvalid: "That doesn't look like a website address. Please check it and try again.",
    optional: 'Optional',
    industryLabel: 'Your industry',
    industryNotSure: 'Not sure – work it out from my site',
    industryHelp: 'Helps us match automations that are common in businesses like yours.',
    businessToggle: 'More about your business',
    businessHelp: 'A few quick answers make the AI ideas more specific to how your team works.',
    buyerToggle: 'Who are you trying to win?',
    buyerHelp:
      "Describe the customer you want to attract and we'll show you what they see. Leave it blank and we'll work out who your site appears to be aimed at.",
    seeExample: 'See example',
    clearExample: 'Clear',
    businessTypeLabel: 'What kind of business are you?',
    businessTypePlaceholder: 'For example: family law firm',
    businessTypeHelp: 'In your own words. We use it for the AI ideas and to judge your site from your customer’s point of view.',
    roleLabel: 'Their job title',
    rolePlaceholder: 'For example: Founder',
    sizeLabel: 'Their company size',
    sizePlaceholder: 'For example: 20-person agency',
    sectorLabel: 'Their industry (not yours)',
    sectorPlaceholder: 'For example: B2B SaaS',
    triggerLabel: 'Why they are looking now',
    triggerPlaceholder: 'For example: outgrown freelancers',
    timeSinkCount: (used: number, max: number) => `${used} of ${max} characters`,
    toolsLabel: 'Which tools does your team use day to day?',
    toolsPlaceholder: 'For example: spreadsheets, a CRM, an accounts package, shared inbox',
    teamSizeLabel: 'How big is your team?',
    teamSizePlaceholder: 'Choose a size',
    regionLabel: 'Where are you based?',
    regionNotSure: 'Not sure / prefer not to say',
    timeSinkLabel: "What eats most of your team's week?",
    timeSinkPlaceholder: 'For example: typing up quotes, chasing invoices, answering the same customer emails',
    timeSinkMaxLength: 200,
    emailLabel: 'Your email',
    emailPlaceholder: 'you@yourcompany.com',
    emailRequired: 'Please enter your email address.',
    emailInvalid: "That doesn't look like an email address. Please check it and try again.",
    nameLabel: 'Your name',
    namePlaceholder: 'For example: Sam Taylor',
    leadNotice:
      "We'll add your email, the site you audit, your answers and its results to Offshorly's CRM so we can follow up about this audit. One free audit per email.",
    marketingOptIn: 'Email me occasional ideas and offers from Offshorly. You can unsubscribe at any time.',
    submit: 'Run my free audit',
    privacyNotice:
      "We read the public pages of the site you enter and use Anthropic's Claude to analyse them, with any answers you add. Your email is never sent to Anthropic.",
    privacyLinkLabel: 'Privacy policy',
    emailUsedContact: "Or tell us what you're building",
  },

  loading: {
    heading: 'Running your audit',
    sub: 'The website audit takes a few seconds. Customer fit and AI ideas follow on the report.',
  },

  report: {
    heading: (domain: string) => `Website audit for ${domain}`,
    tabsLabel: 'Report sections',
    tabWebsite: 'Website audit',
    tabAi: 'Where AI can help',
    /** One line under each tab label; short enough for a 375px screen. */
    tabWebsiteHint: 'Customer fit, security, speed',
    tabAiHint: 'Ideas for your business',
    /** The unselected tab's hint is an action. */
    tabWebsiteAction: 'See your scores',
    tabAiAction: (n: number) => `See ${n} ${n === 1 ? 'idea' : 'ideas'}`,
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
      'You left some customer details blank, so we filled them in with the customer your site appears to be aimed at.',
    buyerFitUnavailable:
      "We couldn't assess customer fit this time, so the measured checks below stand alone.",
    buyerFitThin:
      'Your homepage came back almost empty when we read it, so we skipped the customer-fit assessment. The measured checks below still stand.',
  },

  verdict: {
    scoreLabel: 'Customer fit',
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
    empty: 'Nothing stood out as a clear strength for this customer.',
  },

  buyerFit: {
    heading: 'Customer fit',
    summary: (n: number, weakest: string, score: number) =>
      `${n} things this customer looks for. Weakest: ${weakest} (${score}/10)`,
    intro:
      'Each criterion is scored out of 10 from what your pages actually say. The overall score is an average in which the criteria that matter most to this customer count more: critical three times, important twice and supporting once, so it can differ slightly from a simple average.',
    weight: { high: 'Critical', medium: 'Important', low: 'Supporting' },
    outOfTen: (n: number) => `${n} out of 10`,
    viewPage: (label: string) => `See it on: ${label}`,
    mismatchHeading: 'Where your site undercuts itself',
    mismatchSummary: (n: number) => `${n} ${n === 1 ? 'place that weakens' : 'places that weaken'} your message`,
    actionsHeading: 'How to win this customer',
    actionsSummary: (now: number, later: number) => {
      const parts = [now && `${now} to do first`, later && `${later} to do later`].filter(Boolean).join(', ');
      return `${plural(now + later, 'change', 'changes')}: ${parts}`;
    },
    doNow: (n: number) => `Do first (${n})`,
    longerTerm: (n: number) => `Do later (${n})`,
    fixSectionLabel: 'Customer fit',
  },

  detail: {
    show: 'Show detail',
    hide: 'Hide detail',
    messageHeading: 'Content checks',
    technicalHeading: 'Technical checks',
  },

  header: {
    auditedOn: (date: string) => `Audited ${date}`,
    whatWeThinkYouDo: 'What we think you do',
  },

  ai: {
    intro: "Ideas to test in a free consultation, not promises. We've only read your public website.",
    whyWeThinkSo: 'Why we think so',
    howAiCouldHelp: 'How AI could help',
    likelyBenefit: 'Likely benefit',
    measureFirst: 'Measure first',
    inYourIndustry: 'In your industry',
    industryBadgeInferred: 'inferred from your site',
    siteGroupHeading: 'From what we read on your site',
    /** With no label (the generic fallback industry), a heading that names no industry. */
    industryGroupHeading: (label?: string) => (label ? `Common in your industry: ${label}` : 'Common in businesses like yours'),
    industryGroupIntro: 'Common ways businesses like yours use AI. Not checked against your site.',
    /** Same wording as the group heading; no label (the generic fallback) names no industry. */
    basisIndustry: (label?: string) => (label ? `Common in your industry: ${label}` : 'Common in businesses like yours'),
    basisTools: (tools: string) => `Your tools: ${tools}`,
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
    // Phase 5: examples from an industry web search.
    /** `phrase` is the in-sentence form (industryPhrase), e.g. "software and SaaS". */
    examplesHeading: (phrase?: string) => (phrase ? `What others in ${phrase} are doing` : 'What others in your industry are doing'),
    examplesIntro: (date: string) => `From a web search on ${date}. Third-party sources we haven't checked: follow the links to read them.`,
    examplesSource: 'Source:',
    basisSource: 'Seen elsewhere',
  },

  fixFirst: {
    heading: 'Fix these first',
    intro: 'The changes we would make first, across everything we checked.',
    empty: 'Nothing urgent stood out. Everything we checked is in order or close to it.',
  },

  security: {
    heading: 'Website security',
    intro:
      'We checked the security settings your site shows to every visitor, and whether your domain stops other people sending fake emails in your name. We did not try to break in.',
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
    why: 'Why:',
  },

  checks: {
    passedCount: (n: number) => `${plural(n, 'check', 'checks')} passed`,
    showPassed: 'Show passed checks',
    hidePassed: 'Hide passed checks',
    allClear: 'Everything we checked is in order',
  },

  offshorlyCanHelp: 'Offshorly can help with this',

  sectionLabels: {
    security: 'Website security',
    health: 'Website health',
    'buyer-fit': 'Customer fit',
  },

  whatWeRead: {
    heading: 'Pages we analysed',
    summary: (n: number) => `${n} ${n === 1 ? 'page' : 'pages'} from your public website`,
    /** Phase 5: only when web-search results were used for this report. */
    /** `phrase` is the in-sentence form (industryPhrase), e.g. "construction and trades". */
    searched: (phrase: string) => `We also searched the web for examples from ${phrase}. Nothing about you or your site was sent.`,
  },

  cta: {
    heading: 'Want to test one of these ideas?',
    text: "One process first, measured before the next. In a free consultation we look at your real numbers, and we'll tell you straight if AI isn't worth it.",
    secondaryHeading: 'Talk it through with us',
    secondaryText: "Book a call, or tell us what you're working on.",
    pitchHeading: 'Talk to us about where AI would pay off',
    websiteHeading: 'Want help with these fixes?',
    websiteText:
      "We build and look after websites, and we'll tell you straight which fixes matter and which can wait.",
    primary: CTA.consultation.label,
    secondary: "Tell us what you're building",
  },

  footer: {
    heading: 'About this report',
    disclaimer: 'We only look at what your site shows any visitor. This is not a penetration test.',
    ai: "Your pages and answers are analysed by Anthropic's Claude. Your email is never sent to Anthropic.",
    crm: 'We keep your email, your site, your answers and a summary of the results in our CRM so we can follow up.',
    /** The <summary> of the folded list. */
    more: 'How we handle your data',
    savedLabel: 'Saved reports',
    /** When sharing is off. */
    savedOff: "We don't save reports or create share links. Results are otherwise held briefly in memory.",
    /** When sharing is on (Amendment 5). */
    savedOn: (days: number) =>
      `We only save a report if you share or email it. A saved report has no email address attached, can be seen by anyone with its link, is hidden from search engines, and is deleted after ${days} days or as soon as you delete the link. Otherwise results are held briefly in memory.`,
    ratingsLabel: 'Idea ratings',
    ratings: "If you rate an idea, we keep your rating, the idea and the site's address for up to a year, with no email attached.",
    countsLabel: 'Usage counts',
    counts: 'We also count audits, report views and booking-button clicks as daily totals, with nothing that identifies you.',
    /** Only when report email is on (Phase 4). */
    emailLabel: 'Emailed reports',
    privacyEmail: 'If you ask us to email the report, we send it to the address you entered through our email provider, Resend.',
    sourcesLabel: 'Data sources',
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

  actions: ACTIONS,

  feedback: {
    question: 'Was this idea useful?',
    up: 'Useful',
    down: 'Not useful',
    thanks: 'Thanks for telling us.',
  },

  shared: {
    banner: (domain: string, created: string, expires: string) =>
      `Shared report for ${domain}, created ${created}. This link stops working on ${expires}.`,
    disclaimer: (domain: string, date: string) =>
      `Generated automatically from the public pages of ${domain} on ${date}. Quotes are that site's own words, and the site may have changed since.`,
    expired: 'This report link has expired or been deleted.',
    cta: 'Run a free audit of your own site',
    loading: 'Loading the shared report…',
  },

  print: {
    header: (domain: string, date: string) => `Website audit for ${domain} · ${date} · Offshorly`,
    websiteHeading: 'Website audit',
    aiHeading: 'Where AI can help',
  },
} as const;
