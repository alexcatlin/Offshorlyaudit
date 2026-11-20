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
- `npm run harness -- '{"url":"https://example.com"}' [--out file] [--read-only] [--live-smoke]`: run one audit from the command line. `--live-smoke` needs `ANTHROPIC_API_KEY`: it checks the model, runs the audit with live AI and prints each AI call (label, model, stop reason, usage, seconds) with a cost estimate (prices are constants at the top of `scripts/harness.ts`; check current pricing)

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

- `POST /api/audit` `{url, email, name?, marketingOptIn?, businessType?, persona?, teamSize?, timeSink?}` (8 KB max) → `AuditReport` as soon as the measured checks finish (usually 3–10 s, hard limit 60 s). `buyerFitStatus` and `aiStatus` are `pending` while the AI runs. Errors: `{code, error, retryAfterSec?}` with 400/403/405/409/413/422/429/503/500. `400 email_invalid`: email missing, malformed, on the disposable list, or its domain has no mail records. `409 email_used`: this email already had its free audit of another site.
- `GET /api/audit/:auditId/buyer-fit` → `BuyerFitResult` (waits up to 80 s, then `unavailable`; carries the re-ranked "Fix these first").
- `GET /api/audit/:auditId/ai` → `AiResult` (waits up to 50 s, then `unavailable`). Unknown or expired id → 404 `not_found`. Both limited to 30 requests per IP per hour.
- `GET /healthz` → `{ok, aiMode, aiConfigError?, version, ledger: 'disk'|'memory', crm}`. `aiConfigError: true` means the Anthropic key or model was refused at start-up and AI is off.

API calls must come from the tool's own origin, `PUBLIC_ORIGIN` or `ALLOWED_ORIGINS`. Repeat audits of the same URL and answers within `CACHE_TTL_MIN` return the cached report (same `auditId`) and still count toward the per-IP limit. A run whose buyer fit or AI result came back `unavailable` is dropped from the URL cache once that is known, so the next request runs afresh. A `503 busy` refusal because the server is full does not count; one because the same email is running on another site does (and uses the same wording). Limits are per IP; IPv6 addresses count per /64.

### Email gate (one free audit per email)

The server splits the body into the audit request and the lead fields. The email never reaches the audit, the cache key, a prompt or a log line: logs carry the first 12 hex characters of `HMAC-SHA256(EMAIL_HASH_SECRET, canonical address)` only. Canonical = lowercased, `+tag` removed, and for Gmail dots removed and `googlemail.com` mapped to `gmail.com`.

Order: origin → body → URL → per-IP limit (so probing addresses costs allowance) → email syntax, disposable list, MX (2 s, fails open on timeout/SERVFAIL) → allow-list → ledger → audit. A 200 uses up the email's allowance only when AI ran or legitimately didn't apply (a thin site counts; AI off, the daily cap and AI busy don't). The same email may audit the same site again (refresh, back); another site gets `409 email_used`. The same email on two sites at once gets `503 busy`. If the ledger fails, the gate fails open.

This is a speed bump, not a control: addresses are not verified, so anyone can use fresh addresses. Per-IP limits and `DAILY_AI_AUDITS` remain the cost controls, and every CRM Note says "Email not verified". The allow-list (`AUDIT_ALLOWLIST`) is a convenience for staff and testing, not security: allow-listed addresses skip the gate, are never recorded and skip the CRM unless `CRM_SYNC_ALLOWLISTED=true`. For heavy testing, raise `RATE_LIMIT_HOURLY` temporarily.

### Twenty CRM

With `TWENTY_API_URL` and `TWENTY_API_KEY` set, every successful audit (deduped per email and site for 24 h) is queued for Twenty after the response has gone out. The queue never affects a response. In order:

1. Wait for the buyer-fit and AI results (up to 100 s).
2. **Company**, only when the email domain matches the audited domain (or one is a subdomain of the other) and isn't free-mail: found by domain, else created (name = domain). If this step fails it is logged and the job carries on without the Company.
3. **Person**, found by email (lowercased as typed): blanks filled (name, company), never overwritten; else created.
4. **Note** `Website audit: <domain>`, then linked to the Person (and Company) in separate steps, so a retried link never duplicates the Note. Site-derived lines are markdown-escaped and the URL is an autolink. Contents: URL, date, scores, buyer-fit verdict, up to 5 "Fix these first" lines, AI idea titles, "Email not verified", marketing opt-in with notice version and time, source and the booking link.

One job at a time, at most 500 waiting (oldest dropped). Each step retries 429/5xx/network after 2 s, 10 s and 60 s; other 4xx are logged by status only. On shutdown the queue drains for up to 7 s, then logs how many jobs were dropped (jobs live in memory only). Records are attributed by Twenty's `createdBy` (the API key's name), so no custom fields are needed: filter People by Created by = `audit-widget`. All Twenty endpoint shapes, with their sources, are in `server/crm/twenty.ts`.

Setup: in Twenty, Settings → Developers → API → **+ Create key**, named `audit-widget` (note its expiry). If the workspace uses roles, give it read + create + update on People, Companies, Notes and note targets, and no delete. Set `TWENTY_API_URL` (cloud: `https://api.twenty.com`; self-hosted: your server origin) and `TWENTY_API_KEY`, then run `npm run twenty:check`.

## Environment

All variables are listed in [`.env.example`](.env.example) with defaults. Secrets: `ANTHROPIC_API_KEY`, `PAGESPEED_API_KEY`, `WORDFENCE_API_KEY`, `TWENTY_API_KEY`, `EMAIL_HASH_SECRET`. Never commit them. `.env.local` is loaded only outside production.

| Name | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Turns AI on (`live`). |
| `AUDIT_MODEL` | Sonnet-class default | Model id for all three AI calls. |
| `AI_MODE` | `live` with a key; else `fixture` (dev) / `off` (production) | `fixture` in production refuses to start. Leave empty in production. |
| `PAGESPEED_API_KEY` | none | Adds Google speed checks. |
| `WORDFENCE_API_KEY` | none | Dormant: leave unset. See "Wordfence (dormant)" below. |
| `PUBLIC_ORIGIN` | none | e.g. `https://audit.offshorly.com`. |
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
| `TWENTY_API_URL` | none | Origin, https (`http://localhost` outside production). Blank = CRM off. |
| `TWENTY_API_KEY` | none | Secret. Blank = CRM off. |
| `TYPEKIT_KIT_URL` | none | `https://use.typekit.net/<kit>.css`; injected into index.html and allowed in the CSP. |
| `PORT`, `NODE_ENV`, `LOG_LEVEL` | 8787, development, info | |

### Switch AI to live

1. Create an Anthropic API key and set a monthly spend limit in the Anthropic console.
2. Set `ANTHROPIC_API_KEY` (Render dashboard, or `.env.local` for development). Leave `AI_MODE` empty: a key means `live`.
3. Optional: set `AUDIT_MODEL`. At start-up the server checks the model with the Models API. If it is unknown or retired, or the key is refused, the server still starts with AI off, logs `AI disabled: …` and shows `"aiConfigError":true` in `/healthz` (a network failure is logged and it starts live with conservative settings). Check `/healthz` shows `"aiMode":"live"`, then run `npm run harness -- '{"url":"https://offshorly.com"}' --live-smoke` and confirm `buyerFit=ok ai=ok`, no `max_tokens` events, and the cost line. Repeat for a thin site and a site that refuses the reader before launch.

The AI client reads the model's thinking capabilities: thinking off where the model allows it (`between_tools` on Claude Sonnet 5.5, which refuses `disabled`), otherwise adaptive with extra `max_tokens` headroom. No sampling parameters are sent (the API refuses them). A reply cut off at `max_tokens` is logged and retried once with a higher cap.

To turn AI off without removing the key, set `AI_MODE=off`.

### Wordfence (dormant)

`server/cms/wordfence.ts` was built for the retired v2 scanner feed shape. It must be rebuilt against the current Wordfence Intelligence API, and its terms of use (attribution, commercial use) confirmed, before anyone sets `WORDFENCE_API_KEY`. Until then leave the key unset; the module stays idle.

## Deploy (Render)

One web service, one instance, with a 1 GB persistent disk for the email ledger. [`render.yaml`](render.yaml) is a Blueprint for it.

**The disk has a cost:** a service with a persistent disk gets no zero-downtime deploys (Render stops the old instance before starting the new one, so each deploy has a short outage) and can't scale beyond one instance ([Render: Persistent disks](https://render.com/docs/disks), "Disk limitations and considerations"). The disk is mounted at runtime only; the build never touches `/var/data`.

First deploy, click by click:

1. Confirm `render.yaml` is at the repo root on `main`.
2. Render dashboard → **New +** → **Blueprint** → connect GitHub and grant access to the repo → pick it and branch `main` → name it `offshorly-audit`.
3. Review the resources: web service (Starter, Frankfurt) plus a 1 GB disk.
4. Fill the prompted `sync: false` variables (table below). Blank is fine for every one of them on a smoke test.
5. **Apply**. Wait for the build, deploy and a green health check.
6. Open `https://<service>.onrender.com/healthz`. Expect `"ledger":"disk"`, plus `aiMode` and `crm` as configured.
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
| Everything else | Preset in the yaml. |

After the first deploy:

- `curl https://<app>/healthz`
- `curl -i -X POST https://<app>/api/audit -H 'Origin: https://<app>' -H 'Content-Type: application/json' -d '{"url":"offshorly.com","email":"you@offshorly.com"}'`
- Check `curl -I https://<app>/` shows `content-security-policy` with `frame-ancestors` and no `x-frame-options`.
- Run an audit from two different networks and compare the `ip` hash in the Render logs; identical hashes mean `TRUST_PROXY_HOPS` is wrong.
- Redeploy and confirm the gate persists (a non-allow-listed address with AI on gets `409` for a second site).

Custom domain: add `audit.offshorly.com` in Render, CNAME it, then set `PUBLIC_ORIGIN`.

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
