# Offshorly brand and services reference

Read from offshorly.com on 2026-11-20 (raw HTML and `app.min.css`). Used to style the audit widget and to ground its AI-opportunity suggestions. Re-check before relying on prices or metrics.

## Platform and embedding

- offshorly.com is WordPress (Bedrock paths, custom theme "Offshorly v2", Timber/Twig), UIkit 3, jQuery, WP Rocket, Contact Form 7.
- Theme CSS is scoped under `.wp-front`; a widget must carry its own styles.
- The site sends `X-Frame-Options: SAMEORIGIN` and no CSP. Embedding an external tool into a WP page by iframe or script tag is fine.

## Colours (exact, from the stylesheet)

| Hex | Use |
|---|---|
| `#1c1c22` | Brand dark: header, footer, dark sections, headings on light |
| `#ffffff` | Light sections, cards, text on dark |
| `#2f3037` | Body text |
| `#7f67f6` | Purple accent: gradient start, pill borders, nav hover |
| `#4da1ff` | Blue accent: gradient middle |
| `#5dd9b3` | Mint accent: gradient end, button hover fill |
| `#f9f9fe` | Pale lavender card and section tint |
| `#f7f7fa` | Input background |
| `#dfe1e5` | Card borders |
| `#e0e0e0` | Input borders |
| `#9d9db3` | Outline button border |
| `#8d8d8d` | Muted text |
| `#393939` | Dividers on dark |
| `#e74c3c` | Error |

- Muted text on dark: `rgba(255,255,255,.62)` to `.7`. Dark-surface fill `rgba(255,255,255,.04)`, borders `rgba(255,255,255,.1)` to `.15`.
- Signature gradient: `linear-gradient(88deg,#7f67f6 -1.38%,#4da1ff 53.43%,#5dd9b3 109.9%)`. Also used as gradient text (`background-clip:text`).

## Type

- Headings and UI: **urbane** (Adobe Fonts kit `https://use.typekit.net/qwt7xte.css`), weights 300/500/600/700. The kit is licensed per domain, so a tool on another domain may not be allowed to load it (not verified). Needs a fallback stack.
- Body: **Inter** 300/400 (Google Fonts).
- Hero h1: urbane 500, `clamp(32px,4vw + 16px,80px)`, line-height 1.1. Section h2: urbane 500, `clamp(28px,4vw + 14px,64px)`. Card title: urbane 500, 32px.
- Body: Inter 400, 18px/24px.
- Eyebrow: urbane 500, 18px, uppercase, `letter-spacing:.54px`. Pills: urbane 500, 12px, uppercase, `letter-spacing:.36px`.
- Headings are sentence case, no letter-spacing.

## Components

- Button base: urbane 16px weight 300, radius 6px, padding `10px 15px`, 1px border, `transition:background-color .2s ease`.
- Primary (gradient): signature gradient, white text, weight 600, no border, padding `10px 20px`, hover `opacity:.88`.
- On dark: white background, `#1c1c22` text, hover background `#5dd9b3`.
- Outline: transparent, border `#9d9db3`, hover fills `#5dd9b3` with `#1c1c22` text.
- Cards: `#fff`, `1px solid #dfe1e5`, radius 16px, padding 32px, mostly flat; shadow where used `0 12px 32px rgba(28,28,34,.08)`.
- Gradient-border card: wrapper radius 18px with 2px padding around a 16px card.
- Pills: radius 50px, `1px solid #7f67f6`, padding `8px 16px`.
- Inputs: `1px solid #e0e0e0`, radius 8px, background `#f7f7fa`, padding `14px 16px`, 15px.
- Feel: alternating dark `#1c1c22` and white sections, moderately rounded, airy, large type, restrained gradient accents.

## Logo

- Icon (40x40, used on dark header): `https://offshorly.com/app/uploads/2025/07/offshorly-icon.png`
- Green icon / OG image: `https://offshorly.com/app/uploads/2026/05/cropped-cropped-offshorly-icon-png-green-1500-x-1500.png`
- Favicon: `https://offshorly.com/app/uploads/2025/07/cropped-offshorly-icon-32x32.png`
- No full horizontal wordmark for light or dark backgrounds was found; the header uses the icon only.

## Positioning and tone

- H1: "AI development company, UK-led, built in the Philippines". Recurring lines: "AI that pays for itself"; "One process first. Measured before the next."; "Straight talk in a world of hype".
- Plain, direct, anti-hype, evidence-led, short sentences. Repeatedly promises to say when AI (or Offshorly) is not the right fit.
- UK English. Prices in US dollars.
- Company: Offshorly Ltd, UK-led since 2014, 65+ people, 91% client retention in 2025, 4.9 on Clutch from 27 reviews.

## AI services (all under https://offshorly.com)

| Offering | Path | What it is | Fits when |
|---|---|---|---|
| Free AI Consultation | `/free-ai-consultation/` | ROI diagnostic call that finds the most expensive manual process, then a three-day proof of concept with savings costed in the client's numbers | Any high-volume, rule-heavy, costly-by-hand process; the default first step |
| AI Automation | `/ai-automation-agency/` | Automate the single costliest manual process first, on the client's own systems (CRM, ERP, finance, HR, legacy), measure, then the next | High-volume rule-heavy work done by hand: document review, compliance checks, data extraction, document generation, pricing and valuation, matching and sorting, meeting transcripts, routine admin |
| AI Agent Development | `/ai-agent-development/` | Production multi-step agents with written limits, humans on risky decisions, a named accountable developer. Types: review and extraction, due diligence, diagnosis, operations | Judgement-heavy multi-step work on messy inputs (scans, free text, photos, forms) |
| AI Development Services | `/ai-development-services/` | Staged custom AI: consultation, fixed-price three-day proof of concept, first build, then people to run it; client owns code, IP and data | Wants AI built without hiring a team yet |
| Dedicated AI Teams | `/teams/` | Embedded team working only for one client, from $4,500 per team member per month, month to month | Long, changing roadmap; high-volume operations |
| AI Product Development | `/ai-product-development/` | AI built into the core of an existing product | Companies with a shipped software product |
| AI SaaS Enhancer | `/ai-saas-enhancer/` | Replace or extend SaaS subscriptions with bespoke internal platforms plus a natural-language BI layer | SaaS sprawl (HubSpot, Salesforce, Jira, Xero, Notion and similar) |

The proof of concept is described as free on one page and fixed-price on others; do not state either in the widget.

## Other services

Websites and Web Apps `/websites/`, WordPress Builds `/wordpress/`, Website Redesign `/website-redesign/`, Enterprise Software `/enterprise/`, Rapid Prototypes `/prototypes/`, UI and UX Design `/ui-ux/`, For Agencies `/agency-partner-delivery/`, Startup MVP `/startup-mvp/`.

## Proof points

- theLender (US mortgage lender): appraisal review cut from 45 to 50 minutes down to 15; 12+ AI tools in production; $175,000+ a month saved in under nine months. `/case-study/us-mortgage-lender/`. The first-tool saving is stated inconsistently across the site ($25k+ vs $40k+ a month), so do not quote it.
- Compliance diagnosis agents: daily tickets from 140+ to about 20 in around six weeks.
- Contained Technologies (logistics): two-week prototype, 3x ROI in year one. `/case-study/contained-io/`
- Case study index: `/case-studies/`. Reviews: `/creds/`.

## Calls to action

- "Book a free AI consultation" → `https://offshorly.com/free-ai-consultation/` (Cal.com: `https://cal.com/offshorly/30min`)
- "Tell us what you're building" → `https://offshorly.com/contact/`
