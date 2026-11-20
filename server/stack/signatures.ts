// Tech-stack signatures (PLAN Phase 5). Patterns run against a haystack of asset/link URLs and
// inline script text (not visible page copy), so a mention in body text does not count.
// `signals` is a short hint for the AI prompt about what manual work the tool implies.

export type TechCategory =
  | 'crm'
  | 'chat'
  | 'helpdesk'
  | 'booking'
  | 'forms'
  | 'email-marketing'
  | 'ecommerce'
  | 'payments'
  | 'recruitment'
  | 'analytics';

export interface TechSignature {
  id: string;
  name: string;
  category: TechCategory;
  patterns: RegExp[];
  signals: string;
}

const CRM = 'CRM in use: lead capture, enquiry follow-up and pipeline updates';
const CHAT = 'Live chat: first-line enquiries and repeat questions';
const HELPDESK = 'Helpdesk: support ticket triage, routing and reply drafting';
const BOOKING = 'Online booking: scheduling, reminders and pre-meeting intake';
const FORMS = 'Web forms: intake processing, enquiry sorting and data entry';
const EMAIL = 'Email marketing: list segmentation and campaign content';
const ECOM = 'E-commerce: order handling, catalogue updates and customer queries';
const PAY = 'Online payments: invoicing, reconciliation and payment follow-up';
const ATS = 'Recruitment system: CV screening and candidate communication';
const ANALYTICS = 'Analytics: context only, not evidence of manual work';

export const SIGNATURES: readonly TechSignature[] = [
  // CRM
  { id: 'hubspot', name: 'HubSpot', category: 'crm', signals: CRM, patterns: [/js\.hs-scripts\.com/i, /js\.hs-analytics\.net/i, /js\.hscollectedforms\.net/i, /js\.hs-banner\.com/i, /js\.usemessages\.com/i, /\/\/[a-z0-9.-]*\.hubspot\.com\//i] },
  { id: 'salesforce', name: 'Salesforce / Pardot', category: 'crm', signals: CRM, patterns: [/pardot\.com/i, /\.salesforce\.com\//i, /\.force\.com\//i, /salesforceliveagent\.com/i, /\.salesforce-sites\.com/i] },
  { id: 'pipedrive', name: 'Pipedrive', category: 'crm', signals: CRM, patterns: [/pipedrive\.com/i, /pipedrivewebforms/i, /leadbooster-chat\.pipedrive/i] },
  { id: 'zoho', name: 'Zoho', category: 'crm', signals: CRM, patterns: [/\/\/[a-z0-9.-]*zoho\.(com|eu|in|com\.au)\//i, /zohopublic\./i, /zohocdn\.com/i, /zohostatic\.com/i] },

  // Chat
  { id: 'intercom', name: 'Intercom', category: 'chat', signals: CHAT, patterns: [/widget\.intercom\.io/i, /js\.intercomcdn\.com/i, /\bintercomSettings\b/] },
  { id: 'drift', name: 'Drift', category: 'chat', signals: CHAT, patterns: [/js\.driftt\.com/i, /\/\/[a-z0-9.-]*drift\.com\/(include|core)/i] },
  { id: 'tawk', name: 'Tawk.to', category: 'chat', signals: CHAT, patterns: [/embed\.tawk\.to/i] },
  { id: 'livechat', name: 'LiveChat', category: 'chat', signals: CHAT, patterns: [/cdn\.livechatinc\.com/i, /\b__lc\.license\b/] },
  { id: 'crisp', name: 'Crisp', category: 'chat', signals: CHAT, patterns: [/client\.crisp\.chat/i, /\$crisp\b/] },

  // Helpdesk
  { id: 'zendesk', name: 'Zendesk', category: 'helpdesk', signals: HELPDESK, patterns: [/static\.zdassets\.com/i, /\/\/[a-z0-9-]+\.zendesk\.com/i] },
  { id: 'freshdesk', name: 'Freshdesk', category: 'helpdesk', signals: HELPDESK, patterns: [/\/\/[a-z0-9-]+\.freshdesk\.com/i, /widget\.freshworks\.com/i, /wchat\.freshchat\.com/i] },
  { id: 'gorgias', name: 'Gorgias', category: 'helpdesk', signals: HELPDESK, patterns: [/gorgias\.(chat|io)/i] },

  // Booking
  { id: 'calendly', name: 'Calendly', category: 'booking', signals: BOOKING, patterns: [/(?:\/\/|\.)calendly\.com/i] },
  { id: 'cal-com', name: 'Cal.com', category: 'booking', signals: BOOKING, patterns: [/(?:\/\/|\.)cal\.com(?:\/|\b)/i] },
  { id: 'acuity', name: 'Acuity Scheduling', category: 'booking', signals: BOOKING, patterns: [/acuityscheduling\.com/i, /\/\/[a-z0-9-]+\.as\.me\//i] },
  { id: 'simplybook', name: 'SimplyBook.me', category: 'booking', signals: BOOKING, patterns: [/simplybook\.(me|it|asia|cc)/i] },
  { id: 'resdiary', name: 'ResDiary', category: 'booking', signals: BOOKING, patterns: [/resdiary\.com/i] },
  { id: 'opentable', name: 'OpenTable', category: 'booking', signals: BOOKING, patterns: [/opentable\.(com|co\.uk|ie|de)/i, /otstatic\.com/i] },

  // Forms
  { id: 'typeform', name: 'Typeform', category: 'forms', signals: FORMS, patterns: [/(?:\/\/|\.)typeform\.com/i] },
  { id: 'jotform', name: 'Jotform', category: 'forms', signals: FORMS, patterns: [/jotform\.(com|us|eu)/i, /jotfor\.ms/i] },
  { id: 'gravity-forms', name: 'Gravity Forms', category: 'forms', signals: FORMS, patterns: [/\/plugins\/gravityforms\//i, /\bgform\.initializeOnLoaded\b/] },
  { id: 'cf7', name: 'Contact Form 7', category: 'forms', signals: FORMS, patterns: [/\/plugins\/contact-form-7\//i, /\bwpcf7\b/] },
  { id: 'hubspot-forms', name: 'HubSpot Forms', category: 'forms', signals: FORMS, patterns: [/js\.hsforms\.net/i, /forms\.hsforms\.com/i, /share\.hsforms\.com/i, /\bhbspt\.forms\.create\b/] },
  { id: 'wpforms', name: 'WPForms', category: 'forms', signals: FORMS, patterns: [/\/plugins\/wpforms(-lite)?\//i, /\bwpforms_settings\b/] },

  // Email marketing
  { id: 'mailchimp', name: 'Mailchimp', category: 'email-marketing', signals: EMAIL, patterns: [/chimpstatic\.com/i, /list-manage\.com/i, /\/\/[a-z0-9.-]*mailchimp\.com/i] },
  { id: 'klaviyo', name: 'Klaviyo', category: 'email-marketing', signals: EMAIL, patterns: [/klaviyo\.com/i] },

  // E-commerce
  { id: 'shopify', name: 'Shopify', category: 'ecommerce', signals: ECOM, patterns: [/cdn\.shopify\.com/i, /\.myshopify\.com/i, /\bShopify\.shop\b/] },
  { id: 'woocommerce', name: 'WooCommerce', category: 'ecommerce', signals: ECOM, patterns: [/\/plugins\/woocommerce\//i, /\bwc-ajax=/i, /\bwoocommerce_params\b/, /\bwc_add_to_cart_params\b/] },
  { id: 'bigcommerce', name: 'BigCommerce', category: 'ecommerce', signals: ECOM, patterns: [/bigcommerce\.(com|net)/i] },

  // Payments
  { id: 'stripe', name: 'Stripe', category: 'payments', signals: PAY, patterns: [/js\.stripe\.com/i, /checkout\.stripe\.com/i, /buy\.stripe\.com/i] },
  { id: 'paypal', name: 'PayPal', category: 'payments', signals: PAY, patterns: [/paypal\.com\/sdk/i, /paypalobjects\.com/i, /paypal\.com\/(cgi-bin|donate|checkoutnow)/i] },

  // Recruitment
  { id: 'workable', name: 'Workable', category: 'recruitment', signals: ATS, patterns: [/(?:\/\/|\.)workable\.com/i] },
  { id: 'greenhouse', name: 'Greenhouse', category: 'recruitment', signals: ATS, patterns: [/(?:\/\/|\.)greenhouse\.io/i] },
  { id: 'lever', name: 'Lever', category: 'recruitment', signals: ATS, patterns: [/(?:jobs|api)\.lever\.co\b/i] },
  { id: 'teamtailor', name: 'Teamtailor', category: 'recruitment', signals: ATS, patterns: [/teamtailor\.com/i, /teamtailor-cdn/i] },
  { id: 'bamboohr', name: 'BambooHR', category: 'recruitment', signals: ATS, patterns: [/bamboohr\.com/i] },

  // Analytics (context only)
  { id: 'ga4', name: 'Google Analytics', category: 'analytics', signals: ANALYTICS, patterns: [/googletagmanager\.com\/gtag\/js/i, /google-analytics\.com\/(g\/collect|analytics\.js)/i, /gtag\(\s*['"]config['"]\s*,\s*['"]G-/] },
  { id: 'gtm', name: 'Google Tag Manager', category: 'analytics', signals: ANALYTICS, patterns: [/googletagmanager\.com\/gtm\.js/i, /\bGTM-[A-Z0-9]{4,}\b/] },
  { id: 'hotjar', name: 'Hotjar', category: 'analytics', signals: ANALYTICS, patterns: [/static\.hotjar\.com/i] },
  { id: 'clarity', name: 'Microsoft Clarity', category: 'analytics', signals: ANALYTICS, patterns: [/clarity\.ms/i] },
];
