// Visitor-facing wording per check, for a non-technical business owner. UK English.
// label: short name. fix: why it matters and what to do. action: imperative for "Fix these first".
//
// Rules: never use the word "vulnerable". Do not use "insecure" here at all: the server
// detail line says "insecure" only when WordPress.org's stable-check says so.
import type { CheckId } from '../../shared/types.js';

export interface CheckText {
  label: string;
  fix: string;
  action: string;
}

export const CHECK_TEXT: Record<CheckId, CheckText> = {
  // ---------- Security basics ----------
  'sec-https': {
    label: 'Secure connection',
    fix: 'Visitors should see the padlock in their browser. Without it, browsers warn people away and anything typed into your forms can be read in transit. Your host can usually switch on a free certificate in minutes.',
    action: 'Serve the whole site over HTTPS',
  },
  'sec-redirect': {
    label: 'Old address redirects',
    fix: 'People and links that use the old "http://" address should be sent to the secure version automatically. Ask your developer or host to add a permanent redirect.',
    action: 'Redirect http:// to https:// automatically',
  },
  'sec-hsts': {
    label: 'Always-secure instruction',
    fix: 'A setting called HSTS tells browsers to use only the secure version of your site, even if someone types the old address. It is a one-line change for your developer or host.',
    action: 'Add an HSTS header so browsers always use HTTPS',
  },
  'sec-csp': {
    label: 'Script controls',
    fix: 'A Content Security Policy lists which sources your pages may load scripts from. If something malicious is ever injected, the browser refuses to run it. It takes some testing to set up without breaking things, so start in report-only mode.',
    action: 'Add a Content Security Policy, starting in report-only mode',
  },
  'sec-frame': {
    label: 'Framing protection',
    fix: 'This stops other sites from showing your pages inside theirs to trick visitors into clicking things. It is a single setting for your developer.',
    action: 'Stop other sites from framing your pages',
  },
  'sec-nosniff': {
    label: 'File-type protection',
    fix: 'This setting stops browsers from guessing what a file is, which closes off a class of tricks. It is a one-line change.',
    action: 'Add the X-Content-Type-Options: nosniff header',
  },
  'sec-referrer': {
    label: 'Referrer privacy',
    fix: 'A referrer policy controls how much of your page addresses is passed on when visitors click links to other sites. A sensible default keeps private details in addresses from leaking.',
    action: 'Set a Referrer-Policy header',
  },
  'sec-cookies': {
    label: 'Cookie settings',
    fix: 'Cookies should be marked so they are only sent over secure connections and not shared with other sites unnecessarily. Your developer can add the "Secure" and "SameSite" flags.',
    action: 'Mark cookies Secure and SameSite',
  },
  'sec-disclosure': {
    label: 'Software version hidden',
    fix: 'Your server announces exactly which software version it runs. That helps attackers pick their tools. Ask your host or developer to hide the version number.',
    action: 'Hide server software version numbers',
  },
  'sec-mixed': {
    label: 'All content loads securely',
    fix: 'Some images, scripts or files load over plain "http://" on a secure page. Browsers may block them or show a warning. Update those links to "https://".',
    action: 'Load every image, script and file over HTTPS',
  },
  'sec-spf': {
    label: 'Email sender list (SPF)',
    fix: 'An SPF record lists the services allowed to send email using your domain. Without it, scammers find it easier to send emails that look like they come from you, and your own emails are more likely to land in spam.',
    action: 'Add an SPF record listing who may send your email',
  },
  'sec-dmarc': {
    label: 'Email forgery policy (DMARC)',
    fix: 'DMARC tells other mail systems to reject forged emails using your name. Add a record, start in monitoring mode, then move to "quarantine" or "reject".',
    action: 'Add or enforce a DMARC record to block forged emails',
  },

  // ---------- WordPress ----------
  'wp-core-version': {
    label: 'WordPress version',
    fix: 'WordPress releases updates regularly, and updates often include security fixes. Running an older version leaves known problems unfixed. Ask your developer to update WordPress and keep it updated.',
    action: 'Update WordPress to the latest version',
  },
  'wp-plugins': {
    label: 'Plugins up to date',
    fix: 'Plugins add features to WordPress, and most problems on WordPress sites start with an out-of-date or abandoned plugin. Updates often include security fixes. Update them, and replace any that are no longer maintained or have been removed from the WordPress directory.',
    action: 'Update or replace out-of-date plugins',
  },
  'wp-theme': {
    label: 'Theme up to date',
    fix: 'Your theme controls how the site looks and also runs code. Keep it updated. If it is no longer maintained, plan a replacement.',
    action: 'Update your WordPress theme',
  },
  'wp-xmlrpc': {
    label: 'Old remote-access feature (XML-RPC)',
    fix: 'XML-RPC is an old way for apps to talk to WordPress. Most sites no longer need it, and it is a common target for automated password guessing. Your developer can switch it off unless something relies on it.',
    action: 'Switch off XML-RPC if nothing uses it',
  },
  'wp-version-exposed': {
    label: 'WordPress version shown publicly',
    fix: 'Your site tells anyone which WordPress version it runs. Hiding it is not a fix on its own, but it makes automated scanning a little less useful. Keeping WordPress updated matters more.',
    action: 'Stop publishing your WordPress version number',
  },

  // ---------- Website health: SEO ----------
  'seo-title': {
    label: 'Page title',
    fix: 'The page title is the blue link people see in Google. Aim for roughly 25 to 65 characters that say what you do and for whom.',
    action: 'Write a clear page title that says what you do',
  },
  'seo-description': {
    label: 'Search result description',
    fix: 'The description is the short text under your link in search results. A clear one of 70 to 165 characters gets more of the right people to click.',
    action: 'Write a search result description',
  },
  'seo-h1': {
    label: 'Main heading',
    fix: 'Each page should have one main heading that tells visitors and search engines what the page is about.',
    action: 'Give the homepage one clear main heading',
  },
  'seo-indexable': {
    label: 'Visible to search engines',
    fix: 'Your homepage tells search engines not to list it, so people cannot find it on Google. This is often left over from building the site. Ask your developer to remove the "noindex" setting.',
    action: 'Remove the setting that hides your site from Google',
  },
  'seo-content': {
    label: 'Enough to read',
    fix: 'Search engines and AI tools need words to understand what you do. A homepage with very little text gives them, and your visitors, little to go on. Add a few clear paragraphs about who you help and how.',
    action: 'Add more plain text about what you do and for whom',
  },
  'seo-sitemap': {
    label: 'Sitemap',
    fix: 'A sitemap is a list of your pages that helps search engines find them all. Most website platforms can create one automatically.',
    action: 'Publish a sitemap and list it in robots.txt',
  },
  'seo-canonical': {
    label: 'Preferred address',
    fix: 'A canonical tag tells search engines which address is the main one for a page, so similar copies do not compete with each other.',
    action: 'Add canonical tags to your pages',
  },
  'seo-og': {
    label: 'Link previews',
    fix: 'When someone shares your site on LinkedIn, WhatsApp or Slack, these tags control the title and image shown. Without them the preview looks bare.',
    action: 'Add a share title and image for link previews',
  },
  'seo-alt': {
    label: 'Image descriptions',
    fix: 'Short text descriptions of images help people using screen readers, and help search engines understand your pages.',
    action: 'Add short descriptions to your images',
  },

  // ---------- Website health: AI readiness ----------
  'geo-bots': {
    label: 'AI tools allowed in',
    fix: 'Your robots.txt file blocks some AI tools, such as ChatGPT or Claude, from reading your site. If you want them to describe and recommend you, let them in. If blocking them is a deliberate choice, you can ignore this.',
    action: 'Let AI tools read your site in robots.txt',
  },
  'geo-nojs': {
    label: 'Readable without JavaScript',
    fix: 'Much of your text only appears once the page runs code in the browser. Many AI tools and some search tools do not run that code, so they see an almost empty page. Your developer can make the main text part of the page itself.',
    action: 'Make your main text readable without JavaScript',
  },
  'geo-structured': {
    label: 'Business described for machines',
    fix: 'Structured data is a short hidden description of your business (name, what you do, where) that search engines and AI tools can read reliably. Your developer or an SEO plugin can add it.',
    action: 'Add structured data describing your business',
  },
  'geo-questions': {
    label: "Answers buyers' questions",
    fix: 'AI tools and search engines often answer questions directly. Pages that clearly answer the questions your buyers ask, such as cost, timescales or how you work, are more likely to be used.',
    action: "Add answers to your buyers' common questions",
  },

  // ---------- Website health: speed basics ----------
  'spd-ttfb': {
    label: 'Server response time',
    fix: 'This is how long your server takes to start sending the page. A slow response delays everything else. Caching or better hosting usually helps.',
    action: 'Speed up how quickly your server responds',
  },
  'spd-viewport': {
    label: 'Fits phone screens',
    fix: 'Without this setting, phones show a shrunken desktop page that people have to pinch and zoom. It is a one-line fix for your developer.',
    action: 'Make the site fit phone screens',
  },
  'spd-compression': {
    label: 'Compression',
    fix: 'Compressing pages before sending them makes them load faster at no cost to quality. Most hosts can switch it on.',
    action: 'Switch on compression for your pages',
  },
  'spd-html-size': {
    label: 'Page weight',
    fix: 'The homepage code itself is large, which slows loading on phones. This usually takes a developer some work to trim.',
    action: 'Reduce the size of your homepage code',
  },
  'spd-blocking-scripts': {
    label: 'Scripts that delay the page',
    fix: 'Several scripts must finish loading before visitors see anything. Your developer can load them later so the page appears sooner.',
    action: 'Load scripts later so the page shows sooner',
  },

  // ---------- Website health: Google PageSpeed ----------
  'spd-google-score': {
    label: 'Google mobile speed score',
    fix: "This is Google's own test of how fast your homepage loads on a phone. It varies a little between tests. The other speed checks show what is holding it back.",
    action: 'Improve your Google mobile speed score',
  },
  'spd-lcp': {
    label: 'Time until main content shows',
    fix: 'This is how long visitors wait before the main part of the page appears. Large images and slow servers are the usual causes.',
    action: 'Make the main content appear sooner',
  },
  'spd-cls': {
    label: 'Page stability',
    fix: 'Parts of the page jump around while it loads, so people click the wrong thing. Reserving space for images and banners fixes most of it.',
    action: 'Stop the page jumping around while it loads',
  },
  'spd-tbt': {
    label: 'Responsiveness while loading',
    fix: 'The page is busy running code while it loads, so taps and clicks are slow to respond. Trimming or delaying heavy scripts helps.',
    action: 'Reduce the code that slows the page while loading',
  },
};
