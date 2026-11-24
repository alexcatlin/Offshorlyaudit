# Offshorly audit widget

A free website check for business owners: security (with WordPress checks), website health, and where AI could take repetitive work off their team. Fastify server plus a Preact front end, embedded on offshorly.com by iframe.

Plan and spec: [`docs/PLAN.md`](docs/PLAN.md). Brand and services: [`docs/offshorly-brand-and-services.md`](docs/offshorly-brand-and-services.md).

## Develop

Node 20 (see `.node-version`).

```bash
npm install
cp .env.example .env.local   # fill in what you need; leave keys empty for fixture AI
npm run dev                  # server on :8787 (tsx watch), Vite on :5173 with /api proxied
```

Open http://localhost:5173. Without `ANTHROPIC_API_KEY`, AI runs in fixture mode outside production.

Other scripts:

- `npm test`: unit tests (vitest, `test/unit/*.test.ts`)
- `npm run typecheck`: client and server TypeScript checks
- `npm run build`: client to `dist/client`, server to `dist/server` (shared code to `dist/shared`)
- `npm start`: run the production build
- `npm run twenty:check`: three read-only calls to Twenty with `TWENTY_API_URL`/`TWENTY_API_KEY` (list 1 person, find a person by a probe email, find a company by a probe domain); prints OK or FAILED with the status and a hint for each (401 = key, 403 = role), and warns if a Person record has no `companyId` key. It never writes, and prints counts and field presence only
- `npm run harness -- '{"url":"https://example.com"}' [--out file] [--read-only] [--live-smoke] [--raw]`: run one audit from the command line. `--live-smoke` needs `ANTHROPIC_API_KEY`: it checks the model, runs the audit with live AI and prints each AI call (label, model, stop reason, usage, seconds) with a cost estimate (prices in `server/ai/pricing.ts`; check current pricing). `--raw` also prints each live AI call's raw model JSON before validation (local use only)

Module setup: ESM throughout, server compiled with `NodeNext`, so every relative import (including `shared/`) uses a `.js` extension, which Vite and vitest also resolve.

## Run the built service locally

```bash
npm run build
PORT=8799 node dist/server/index.js     # NODE_ENV unset → fixture AI allowed
curl -s localhost:8799/healthz          # {"ok":true,"aiMode":"fixture","version":"0.1.0","ledger":"memory","crm":false}
```

To keep the one-per-email record across restarts locally, add `LEDGER_PATH=./.data/ledger.jsonl` (`.data/` is gitignored).

`npm start` sets `NODE_ENV=production`, so it needs `ANTHROPIC_API_KEY` (or `AI_MODE=off`); production with `AI_MODE=fixture` refuses to start.

## API

- `POST /api/audit` `{url, email, name?, marketingOptIn?, industry?, businessType?, teamSize?, tools?, timeSink?, persona?}` (8 KB max; `industry` is a playbook id from `shared/industries.ts`, `tools` ≤150 characters; email addresses typed into any free-text answer are replaced with `[email removed]` before anything else sees them) → `AuditReport` as soon as the measured checks finish (usually 3–10 s, hard limit 60 s). `buyerFitStatus` and `aiStatus` are `pending` while the AI runs. Errors: `{code, error, retryAfterSec?}` with 400/403/405/409/413/422/429/503/500. `400 email_invalid`: email missing, malformed, on the disposable list, or its domain has no mail records. `409 email_used`: this email already had its free audit of another site.
- `GET /api/audit/:auditId/buyer-fit` → `BuyerFitResult` (waits up to 80 s, then `unavailable`; carries the re-ranked "Fix these first").
- `GET /api/audit/:auditId/ai` → `AiResult` (waits up to 80 s, then `unavailable`). Up to 5 ideas: up to 3 from the site ("site"), then up to 2 from the industry playbook ("industry", never more than "worth checking"), plus the resolved industry. Unknown or expired id → 404 `not_found`. Both limited to 30 requests per IP per hour.
- Every `200` from `POST /api/audit` also carries `session` (22 characters, per response, never cached, never in a URL or log line) and `features: {share, email, feedback, shareRetentionDays}` (Amendment 5). Share and feedback act through the session, never the `auditId` (a cache hit shares that with other visitors). Sessions live in memory for `SESSION_TTL_HOURS`; after a restart the routes answer `410 session_expired`.
- `POST /api/feedback` `{session, ideaIndex, vote: 'up'|'down'|null}` → `204`. One JSONL line per click (ids, the idea's service/pattern/title, the vote; no email, email hash or IP); `null` clears. `410 session_expired`, `409 not_ready` (AI ideas not settled), `400` bad index or vote. 60 per IP per hour, and at most 3 writes per idea per session (`429 rate_limited` beyond, nothing written). Memory keeps only the last vote per visitor and idea (at most 50,000); the file is compacted to that at boot. A store failure is logged and still answers `204`.
- `POST /api/share` `{session}` → `201 {shareId, url, expiresAt}`, idempotent per session. The server builds the snapshot from its own copy of the audit (waits up to 15 s for buyer fit and AI, else `409 not_ready`), strips `auditId` and the URL query, and keeps only the answers the report shows (`timeSink`, `tools`, `teamSize`, `industry`, `businessType`). `503 share_unavailable` when the store is full, the disk is low or the snapshot is over 100 KB. `DELETE /api/share` `{session}` → `204`. Both 10 per IP per hour. `url` uses `PUBLIC_ORIGIN`, else the request's host.
- `GET /api/share/:shareId` → `SharedReport` (`X-Robots-Tag: noindex, nofollow, noarchive`; 404 when missing or expired; 60 per IP per hour). `GET /r/:shareId` serves the shared page with the same robots header and meta, `Referrer-Policy: no-referrer` and `cache-control: no-store`. Share ids are logged as `:id`. `/r/` is deliberately not in robots.txt.
- `POST /api/share/email` `{session, email}` → `202 {sent: true, expiresAt}` (Amendment 5 Phase 4; the route exists only when report email is on). The address must pass the gate's syntax rule (`EMAIL_RE`; else `400 email_invalid`) and be the one the audit was run with (same HMAC gate key; else `403`); only that trimmed, validated value is sent to, and is used for that one send only: never stored or logged. Creates the share link if there is none, then sends one email (link, domain, date, scores, expiry; no model prose, quotes, images or tracking). `409 already_sent` (one per session), `429` after 3 sends per address per 24 h or 5 requests per IP per hour, `503 busy` past `MAIL_DAILY_MAX`, `502 email_failed` when the provider fails (status code logged only), `410`/`409 not_ready`/`503 share_unavailable` as for sharing.
- `GET /print` serves the app's print window ("Save as PDF") with `X-Robots-Tag: noindex`.
- Admin (only when `ADMIN_TOKEN` is set; otherwise 404), `Authorization: Bearer $ADMIN_TOKEN`, 10 per IP per hour, no origin check: `GET /api/admin/feedback.csv` (one row per visitor and idea, last vote wins; columns date, domain, industry, source, service, pattern, title, vote, sourcesCited; cells starting `= + - @` tab or CR are prefixed with `'`) `DELETE /api/admin/share/:shareId` for deletion requests, and `GET /api/admin/research` (`{provider, entries, outcomes, pausedUntil}`: cached industry search results, plus the last audit and refresh outcome per industry: cache state, refresh status, reason code, timestamps, any active negative-cache expiry; `pausedUntil` is the ISO end of an account-wide provider pause, or null; `outcomes` is kept in memory and resets on restart; 404 when search is off).
- `GET /healthz` → `{ok, aiMode, aiConfigError?, version, ledger: 'disk'|'memory', crm, feedback: 'disk'|'memory', shares: 'disk'|'memory'|'off', mail, search}`. `aiConfigError: true` means the Anthropic key or model was refused at start-up and AI is off. `mail` is true only when report email is fully configured (see "Email the report"); `search` only when a search provider and key are set (see "Web-search grounding").

API calls must come from the tool's own origin, `PUBLIC_ORIGIN` or `ALLOWED_ORIGINS`. Repeat audits of the same URL and answers within `CACHE_TTL_MIN` return the cached report (same `auditId`) and still count toward the per-IP limit. A run whose buyer fit or AI result came back `unavailable` is dropped from the URL cache once that is known, so the next request runs afresh. A `503 busy` refusal because the server is full does not count; one because the same email is running on another site does (and uses the same wording). Limits are per IP; IPv6 addresses count per /64.

### Email gate (one free audit per email)

The server splits the body into the audit request and the lead fields. The email never reaches the audit, the cache key, a prompt or a log line: logs carry the first 12 hex characters of `HMAC-SHA256(EMAIL_HASH_SECRET, canonical address)` only. Canonical = lowercased, `+tag` removed, and for Gmail dots removed and `googlemail.com` mapped to `gmail.com`.

Order: origin → body → URL → per-IP limit (so probing addresses costs allowance) → email syntax, disposable list, MX (2 s, fails open on timeout/SERVFAIL) → allow-list → ledger → audit. A 200 uses up the email's allowance only when AI ran or legitimately didn't apply (a thin site counts; AI off, the daily cap and AI busy don't). The same email may audit the same site again (refresh, back); another site gets `409 email_used`. The same email on two sites at once gets `503 busy`. If the ledger fails, the gate fails open.

This is a speed bump, not a control: addresses are not verified, so anyone can use fresh addresses. Per-IP limits and `DAILY_AI_AUDITS` remain the cost controls, and every CRM Note says "Email not verified". The allow-list (`AUDIT_ALLOWLIST`) is a convenience for staff and testing, not security: allow-listed addresses skip the gate, are never recorded and skip the CRM unless `CRM_SYNC_ALLOWLISTED=true`. For heavy testing, raise `RATE_LIMIT_HOURLY` temporarily.

### Email the report (built, off until keys are set)

"Email me this report" appears only when all of these hold: `MAIL_PROVIDER=resend`, `MAIL_API_KEY`, a valid `MAIL_FROM`, an `https` `PUBLIC_ORIGIN`, and share links on. Anything missing, or an unknown `MAIL_PROVIDER`, switches it off with a warning in the logs; the service still starts. The recipient must pass the gate's address syntax check (`400 email_invalid` otherwise) and match the address the report was requested with (`403`). The adapter (`server/mail/resend.ts`) was written against Resend's docs: `POST https://api.resend.com/emails`, Bearer key, a `User-Agent` header (required), `Idempotency-Key = sha256(session + ':' + shareId)` (a retry never sends twice), 10 s timeout, one retry on 5xx, network failure or a `429` whose `retry-after` is 3 s or less (a longer or missing `retry-after` is treated as a quota and not retried), no retry on other 4xx (`409` included). Response bodies are never read or logged. **Unverified until the first live send:** the REST field name for Reply-To (`reply_to`, kept in one constant).

Setup: Resend account → add the domain `mail.offshorly.com` (EU region if offered) → add the DNS records Resend shows → create an API key limited to that domain → set `MAIL_PROVIDER=resend`, `MAIL_API_KEY`, `MAIL_FROM` (`Offshorly audit <audit@mail.offshorly.com>`), `MAIL_REPLY_TO` (a monitored inbox) and `MAIL_FOOTER_LINE` (registered name, number and office; until set the footer says "Offshorly Ltd"). Leave open and click tracking off (a per-domain setting in Resend). The free tier allows 100 emails a day, hence `MAIL_DAILY_MAX=90`. When email is on, the report footer adds: "If you ask us to email the report, we send it to the address you entered through our email provider, Resend."

### Web-search grounding (built, off until keys are set)

With `SEARCH_PROVIDER=serpapi` and `SEARCH_API_KEY`, the AI ideas can cite a web search about the business's industry ("What others in {industry} are doing", plus "Seen elsewhere" on industry ideas). The industry is the visitor's choice, else a keyword guess from the pages; no industry, no search. The two queries per industry are fixed strings in `shared/industries.ts` (`searchQueries`): nothing about the visitor, their answers, email or site is ever sent. Results are cached per industry for `SEARCH_CACHE_DAYS` (file at `SEARCH_CACHE_PATH`; entries with no results are dropped when the file is loaded). A failed refresh is negatively cached with backoff per industry: 30 minutes, then 2 hours, then 6 hours for each further consecutive failure; a success resets it. A refresh where every query succeeded but nothing usable came back is not cached and is retried after 24 hours (reason `no_results`; this also resets the backoff). When a refresh fails with `http_401` or `http_403` the provider is paused for every industry for 6 hours, and with `http_429` for that failure's backoff time: while paused, audits get no research, no provider call is made and nothing is taken from the daily count. `SEARCH_DAILY_MAX` caps provider requests per UTC day; failed runs count too. Each audit waits at most 4 s for a cache miss and then continues without results; the search itself is not tied to the audit and has up to 20 s (the provider request timeout), so a slow answer still fills the cache for the next audit. Only a real provider failure or that 20 s timeout is negatively cached, never the audit's 4 s wait. Each `industry_research` log line carries `status` (`ok`, `failed`, `capped`, `wait_timeout`, or `paused`, logged once when an account-wide pause is set), `ms` and, on failure, a `reason` code (`http_401`, `http_429`, `timeout`, `network`, `bad_json`, `too_large`, `provider_error` for a SerpApi 200 with an unknown `error`, `error` for an unexpected failure, `no_results`, `daily_cap`, `wait_timeout`): never the request URL, key, response body or provider error message. Results are cleaned (no HTML or control characters, length caps, http(s) only, no IP hosts, social/video sites and offshorly.com blocked, one per host, the audited site removed) and given to the model without URLs. We never fetch the result pages. Validation drops any example that cites nothing, has a figure, banned word, adoption claim or a name not in its cited results, or comes from a different industry than the one searched; the server attaches the links.

SerpApi (`server/search/serpapi.ts`) is the only provider built: its API was checked against serpapi.com's docs (`GET https://serpapi.com/search`, `engine=google`, `gl=uk`, `hl=en`, `google_domain=google.co.uk`, no `num` parameter). Its key travels in the query string, so the request URL is never logged or put in an error. The test fixture is hand-written from the documented shape (no live search was run); record a real response once the account exists. Serper's API could not be verified from official docs, so no Serper adapter exists yet; one can be added behind `SearchProvider` once it is. `SEARCH_PROVIDER=fixture` (three `[Sample]` results on example domains) works outside production only; in production it, like an unknown `SEARCH_PROVIDER`, leaves search off with a warning (the service still starts). SerpApi's free plan allows 250 searches a month. `SEARCH_DAILY_MAX=20` alone could reach about 600 a month, above that; the 7-day cache keeps real use near 140 a month (16 industries × 2 queries, each refreshed at most weekly). The monthly cap is SerpApi's own usage limit, not something this service enforces. Run `npm run harness -- '<body>' --live-smoke` with search on before enabling it in production (the opportunities schema grew).

### Twenty CRM

With `TWENTY_API_URL` and `TWENTY_API_KEY` set, every successful audit (deduped per email and site for 24 h) is queued for Twenty after the response has gone out. The queue never affects a response. In order:

1. Wait for the buyer-fit and AI results (up to 100 s).
2. **Company**, only when the email domain matches the audited domain (or one is a subdomain of the other) and isn't free-mail: found by domain, else created (name = domain). If this step fails it is logged and the job carries on without the Company.
3. **Person**, found by email (lowercased as typed): blanks filled (name, company), never overwritten; else created.
4. **Note** `Website audit: <domain>`, then linked to the Person (and Company) in separate steps, so a retried link never duplicates the Note. Site-derived lines are markdown-escaped and the URL is an autolink. Contents: URL, date, scores, buyer-fit verdict, the visitor's answers (industry given or inferred, business type, team size, tools, what eats the week), up to 5 "Fix these first" lines, AI idea titles with their service and `[site]`/`[industry]` tag, the estimated AI cost when known, "Email not verified", marketing opt-in with notice version and time, source and the booking link.

One job at a time, at most 500 waiting (oldest dropped). Each step retries 429/5xx/network after 2 s, 10 s and 60 s; other 4xx are logged by status only. On shutdown the queue drains for up to 7 s, then logs how many jobs were dropped (jobs live in memory only). Records are attributed by Twenty's `createdBy` (the API key's name), so no custom fields are needed: filter People by Created by = `audit-widget`. All Twenty endpoint shapes, with their sources, are in `server/crm/twenty.ts`.

Setup: in Twenty, Settings → Developers → API → **+ Create key**, named `audit-widget` (note its expiry). If the workspace uses roles, give it read + create + update on People, Companies, Notes and note targets, and no delete. Set `TWENTY_API_URL` (cloud: `https://api.twenty.com`; self-hosted: your server origin) and `TWENTY_API_KEY`, then run `npm run twenty:check`.

## Environment

All variables are listed in [`.env.example`](.env.example) with defaults. Secrets: `ANTHROPIC_API_KEY`, `PAGESPEED_API_KEY`, `WORDFENCE_API_KEY`, `TWENTY_API_KEY`, `EMAIL_HASH_SECRET`, `ADMIN_TOKEN`, `MAIL_API_KEY`, `SEARCH_API_KEY`. Never commit them. `.env.local` is loaded only outside production.

| Name | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Turns AI on (`live`). |
| `AUDIT_MODEL` | Sonnet-class default | Model id for all three AI calls. |
| `AI_MODE` | `live` with a key; else `fixture` (dev) / `off` (production) | `fixture` in production refuses to start. Leave empty in production. |
| `PAGESPEED_API_KEY` | none | Adds Google speed checks. |
| `WORDFENCE_API_KEY` | none | Dormant: leave unset. See "Wordfence (dormant)" below. |
| `PUBLIC_ORIGIN` | none | e.g. `https://audit.offshorly.com`. Must be `https` for report email. |
| `ALLOWED_ORIGINS` | dev: `http://localhost:5173 http://localhost:8787`; production: none | Extra API origins. |
| `ALLOWED_FRAME_ANCESTORS` | `https://offshorly.com https://www.offshorly.com` | CSP `frame-ancestors`. |
| `RATE_LIMIT_HOURLY` / `RATE_LIMIT_DAILY` | 5 / 20 | Per IP. |
| `DAILY_AI_AUDITS` | 50 | Beyond it, measured-only reports. Resets at midnight UTC. Kept low until live runs give real cost numbers (`npm run harness -- '<body>' --live-smoke`). |
| `MAX_CONCURRENT_AUDITS` | 4 | Beyond it, 503 `busy`. |
| `CACHE_TTL_MIN` | 360 | Report and result cache (500 entries). |
| `TRUST_PROXY_HOPS` | 1 | Proxies in front of the app (Render = 1). 0 ignores `X-Forwarded-For`. |
| `EMAIL_GATE` | `on` | `off` = email still required and synced, no one-per-email limit. |
| `EMAIL_HASH_SECRET` | random per process (warned) | 16+ characters. Render generates it. Changing it resets the gate. |
| `LEDGER_PATH` | none (memory) | Render: `/var/data/audit-ledger.jsonl`. A missing directory in production falls back to memory (logged). |
| `LEDGER_RETENTION_DAYS` | 365 | 30–1825. |
| `AUDIT_ALLOWLIST` | `@offshorly.com` | Emails or `@domain` (exact domain). |
| `CRM_SYNC_ALLOWLISTED` | `false` | `true` syncs allow-listed audits with a `[Test] ` title. |
| `SESSION_TTL_HOURS` | 24 | 1–72. How long a report's share/feedback session lives in memory. |
| `FEEDBACK_PATH` | none (memory) | Idea feedback JSONL. Render: `/var/data/idea-feedback.jsonl`. Unwritable in production falls back to memory (logged). |
| `FEEDBACK_RETENTION_DAYS` | 365 | 1–365. The footer and privacy copy say "up to a year" (`src/content/copy.ts`, `footer.privacy` and `footer.privacyShare`): change that copy if you change this. |
| `ADMIN_TOKEN` | none (admin off) | 32+ characters. Render generates it. Enables `/api/admin/*`. |
| `SHARE_LINKS` | `on` | `off` = no share store; Copy link is hidden. |
| `REPORTS_DIR` | none (memory) | One JSON file per shared report. Render: `/var/data/reports` (created on first boot under the mount). Missing mount in production falls back to memory (logged). |
| `SHARE_RETENTION_DAYS` | 30 | 1–365. Also shown in the footer and the link notice. |
| `SHARE_MAX_FILES` | 5000 | Beyond it, `503 share_unavailable`. |
| `SHARE_MIN_FREE_MB` | 150 | Below this much free disk, `503 share_unavailable`. |
| `MAIL_PROVIDER` | none (email off) | `resend`. See "Email the report". |
| `MAIL_API_KEY` | none | Secret. |
| `MAIL_FROM` | none | `Name <address>` or `address`. Unparseable → email off (warned). |
| `MAIL_REPLY_TO` | none | A monitored inbox. Invalid → ignored (warned). |
| `MAIL_FOOTER_LINE` | `Offshorly Ltd` | One line of registered company details, ≤200 characters (longer is cut, warned). |
| `MAIL_DAILY_MAX` | 90 | Report emails per UTC day. Resend free tier: 100/day. |
| `SEARCH_PROVIDER` | none (search off) | `serpapi`, or `fixture` outside production. See "Web-search grounding". |
| `SEARCH_API_KEY` | none | Secret. Missing with `serpapi` → search off (warned). |
| `SEARCH_CACHE_PATH` | none (memory) | Render: `/var/data/search-cache.json`. |
| `SEARCH_CACHE_DAYS` | 7 | 1–30. |
| `SEARCH_DAILY_MAX` | 20 | Provider requests per UTC day (two per industry refresh). 20/day could reach ~600/month, above SerpApi's free 250; the 7-day cache keeps real use near 140/month. The monthly cap is the provider's own limit. |
| `TWENTY_API_URL` | none | Origin, https (`http://localhost` outside production). Blank = CRM off. |
| `TWENTY_API_KEY` | none | Secret. Blank = CRM off. |
| `TYPEKIT_KIT_URL` | none | `https://use.typekit.net/<kit>.css`; injected into index.html and allowed in the CSP. |
| `PORT`, `NODE_ENV`, `LOG_LEVEL` | 8787, development, info | |

### Switch AI to live

1. Create an Anthropic API key and set a monthly spend limit in the Anthropic console.
2. Set `ANTHROPIC_API_KEY` (Render dashboard, or `.env.local` for development). Leave `AI_MODE` empty: a key means `live`.
3. Optional: set `AUDIT_MODEL`. At start-up the server checks the model with the Models API. If it is unknown or retired, or the key is refused, the server still starts with AI off, logs `AI disabled: …` and shows `"aiConfigError":true` in `/healthz` (a network failure is logged and it starts live with conservative settings). Check `/healthz` shows `"aiMode":"live"`, then run `npm run harness -- '{"url":"https://offshorly.com"}' --live-smoke` and confirm `buyerFit=ok ai=ok`, no `max_tokens` events, and the cost line. Repeat for a thin site and a site that refuses the reader before launch.

Cost logging: every `ai_call` log line carries `cost_usd` (an estimate from `server/ai/pricing.ts`; `null` for a model with no price row), and each audit logs one `ai_audit_cost` line (`auditId`, `domain`, calls, input/output/thinking tokens, `cost_usd`) once both AI analyses settle, retries included. Each opportunities run also logs one `ai_opportunities` line with ids and counts only (kept and dropped ideas by reason, service remaps, industry and where it came from). None of these lines carry prompt text, answers or email.

The AI client reads the model's thinking capabilities: thinking off where the model allows it (`between_tools` on Claude Sonnet 5.5, which refuses `disabled`), otherwise adaptive with extra `max_tokens` headroom. No sampling parameters are sent (the API refuses them). A reply cut off at `max_tokens` is logged and retried once with a higher cap.

To turn AI off without removing the key, set `AI_MODE=off`.

### Wordfence (dormant)

`server/cms/wordfence.ts` was built for the retired v2 scanner feed shape. It must be rebuilt against the current Wordfence Intelligence API, and its terms of use (attribution, commercial use) confirmed, before anyone sets `WORDFENCE_API_KEY`. Until then leave the key unset; the module stays idle.

## Deploy (Render)

One web service, one instance, with a 1 GB persistent disk for the email ledger, shared reports, idea feedback and the industry search cache. [`render.yaml`](render.yaml) is a Blueprint for it.

**The disk has a cost:** a service with a persistent disk gets no zero-downtime deploys (Render stops the old instance before starting the new one, so each deploy has a short outage) and can't scale beyond one instance ([Render: Persistent disks](https://render.com/docs/disks), "Disk limitations and considerations"). The disk is mounted at runtime only; the build never touches `/var/data`.

First deploy, click by click:

1. Confirm `render.yaml` is at the repo root on `main`.
2. Render dashboard → **New +** → **Blueprint** → connect GitHub and grant access to the repo → pick it and branch `main` → name it `offshorly-audit`.
3. Review the resources: web service (Starter, Frankfurt) plus a 1 GB disk.
4. Fill the prompted `sync: false` variables (table below). Blank is fine for every one of them on a smoke test.
5. **Apply**. Wait for the build, deploy and a green health check.
6. Open `https://<service>.onrender.com/healthz`. Expect `"ledger":"disk"`, `"feedback":"disk"`, `"shares":"disk"`, plus `aiMode` and `crm` as configured.
7. Run an audit with your `@offshorly.com` email (allow-listed).
8. Add keys later in the service's **Environment** page → Save (this redeploys). Render prompts for `sync: false` values only when the Blueprint is first created; later Blueprint syncs ignore them.
9. Set a monthly spend limit in the Anthropic console.
10. With AI off, gate testing shows nothing: nothing uses up an allowance.

| Variable | Status |
|---|---|
| `ANTHROPIC_API_KEY` | Needed for the full audit. Blank = measured-only, gate inactive. |
| `TWENTY_API_URL`, `TWENTY_API_KEY` | Needed for the CRM. Blank = CRM off. |
| `PAGESPEED_API_KEY`, `AUDIT_MODEL`, `TYPEKIT_KIT_URL` | Optional. |
| `PUBLIC_ORIGIN` | Blank at first (the widget calls its own origin); set after the custom domain exists. |
| `AI_MODE`, `WORDFENCE_API_KEY` | Leave blank. |
| `EMAIL_HASH_SECRET` | Generated by Render (`generateValue: true`). Never change it. |
| `ADMIN_TOKEN` | Generated by Render (`generateValue: true`). Copy it from the Environment page to download feedback. |
| Everything else | Preset in the yaml. |

After the first deploy:

- `curl https://<app>/healthz`
- `curl -i -X POST https://<app>/api/audit -H 'Origin: https://<app>' -H 'Content-Type: application/json' -d '{"url":"offshorly.com","email":"you@offshorly.com"}'`
- Check `curl -I https://<app>/` shows `content-security-policy` with `frame-ancestors` and no `x-frame-options`.
- Run an audit from two different networks and compare the `ip` hash in the Render logs; identical hashes mean `TRUST_PROXY_HOPS` is wrong.
- Redeploy and confirm the gate persists (a non-allow-listed address with AI on gets `409` for a second site).

Read idea feedback: `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<app>/api/admin/feedback.csv > feedback.csv`. `idea_feedback` lines also show in the Render logs. Delete a shared report on request: `curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" https://<app>/api/admin/share/<shareId>`.

Custom domain: add `audit.offshorly.com` in Render, CNAME it, then set `PUBLIC_ORIGIN` (share links then use it).

Keep the instance count at 1. Scaling out needs a shared store (Redis or Postgres) for limits, cache and the ledger, which also brings back zero-downtime deploys.

## Embed on WordPress

Add to a Custom HTML block (replace `<tool>` with the tool's domain):

```html
<div data-offshorly-audit></div>
<script src="https://<tool>/embed.js" async data-no-optimize="1" nowprocket></script>
<noscript>
  <iframe src="https://<tool>/?embed=1" title="Website and AI audit" style="width:100%;min-height:720px;border:0"></iframe>
</noscript>
```

Exclude `embed.js` from WP Rocket's "Delay JavaScript execution". The host site's origin must be listed in the tool's `ALLOWED_FRAME_ANCESTORS` (the default covers offshorly.com).

`embed.js` sets `allow="clipboard-write"` on the iframe (for Copy link) and no `sandbox` attribute: a sandbox would block the "Save as PDF" print window. Without clipboard access the report shows the link selected instead.
