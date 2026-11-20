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
- `npm run harness -- '{"url":"https://example.com"}' [--out file] [--read-only] [--live-smoke]`: run one audit from the command line. `--live-smoke` needs `ANTHROPIC_API_KEY`: it checks the model, runs the audit with live AI and prints each AI call (label, model, stop reason, usage, seconds) with a cost estimate (prices are constants at the top of `scripts/harness.ts`; check current pricing)

Module setup: ESM throughout, server compiled with `NodeNext`, so every relative import (including `shared/`) uses a `.js` extension, which Vite and vitest also resolve.

## Run the built service locally

```bash
npm run build
PORT=8799 node dist/server/index.js     # NODE_ENV unset → fixture AI allowed
curl -s localhost:8799/healthz          # {"ok":true,"aiMode":"fixture","version":"0.1.0"}
```

`npm start` sets `NODE_ENV=production`, so it needs `ANTHROPIC_API_KEY` (or `AI_MODE=off`); production with `AI_MODE=fixture` refuses to start.

## API

- `POST /api/audit` `{url, businessType?, persona?, teamSize?, timeSink?}` (8 KB max) → `AuditReport` as soon as the measured checks finish (usually 3–10 s, hard limit 60 s). `buyerFitStatus` and `aiStatus` are `pending` while the AI runs. Errors: `{code, error, retryAfterSec?}` with 400/403/405/413/422/429/503/500.
- `GET /api/audit/:auditId/buyer-fit` → `BuyerFitResult` (waits up to 80 s, then `unavailable`; carries the re-ranked "Fix these first").
- `GET /api/audit/:auditId/ai` → `AiResult` (waits up to 50 s, then `unavailable`). Unknown or expired id → 404 `not_found`. Both limited to 30 requests per IP per hour.
- `POST /api/lead` exists only when `LEAD_WEBHOOK_URL` is set; forwards `{email, name?, domain, teamSize?, topIdeas, consentText, consentAt, source}` to the webhook. Nothing stored, emails never logged.
- `GET /healthz` → `{ok, aiMode, version}`.

API calls must come from the tool's own origin, `PUBLIC_ORIGIN` or `ALLOWED_ORIGINS`. Repeat audits of the same URL and answers within `CACHE_TTL_MIN` return the cached report (same `auditId`) and still count toward the per-IP limit. A run whose buyer fit or AI result came back `unavailable` is dropped from the URL cache once that is known, so the next request runs afresh. A `503 busy` refusal does not count. Limits are per IP; IPv6 addresses count per /64.

## Environment

All variables are listed in [`.env.example`](.env.example) with defaults. Secrets: `ANTHROPIC_API_KEY`, `PAGESPEED_API_KEY`, `WORDFENCE_API_KEY`, `LEAD_WEBHOOK_URL`. Never commit them. `.env.local` is loaded only outside production.

| Name | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Turns AI on (`live`). |
| `AUDIT_MODEL` | Sonnet-class default | Model id for all three AI calls. |
| `AI_MODE` | `live` with a key; else `fixture` (dev) / `off` (production) | `fixture` in production refuses to start. |
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
| `LEAD_WEBHOOK_URL` | none | https only. Enables `/api/lead`. |
| `TYPEKIT_KIT_URL` | none | `https://use.typekit.net/<kit>.css`; injected into index.html and allowed in the CSP. |
| `PORT`, `NODE_ENV`, `LOG_LEVEL` | 8787, development, info | |

### Switch AI to live

1. Create an Anthropic API key and set a monthly spend limit in the Anthropic console.
2. Set `ANTHROPIC_API_KEY` (Render dashboard, or `.env.local` for development). Leave `AI_MODE` empty: a key means `live`.
3. Optional: set `AUDIT_MODEL`. At start-up the server checks the model with the Models API and refuses to start if it is unknown or retired, or the key is refused (a network failure is logged and it starts with conservative settings). Check `/healthz` shows `"aiMode":"live"`, then run `npm run harness -- '{"url":"https://offshorly.com"}' --live-smoke` and confirm `buyerFit=ok ai=ok`, no `max_tokens` events, and the cost line. Repeat for a thin site and a site that refuses the reader before launch.

The AI client reads the model's thinking capabilities: thinking off where the model allows it (`between_tools` on Claude Sonnet 5.5, which refuses `disabled`), otherwise adaptive with extra `max_tokens` headroom. No sampling parameters are sent (the API refuses them). A reply cut off at `max_tokens` is logged and retried once with a higher cap.

To turn AI off without removing the key, set `AI_MODE=off`.

### Wordfence (dormant)

`server/cms/wordfence.ts` was built for the retired v2 scanner feed shape. It must be rebuilt against the current Wordfence Intelligence API, and its terms of use (attribution, commercial use) confirmed, before anyone sets `WORDFENCE_API_KEY`. Until then leave the key unset; the module stays idle.

### Lead capture (dormant)

`POST /api/lead` exists only when `LEAD_WEBHOOK_URL` is set, and there is no UI for it yet. Turning it on needs the form plus anti-spam.

## Deploy (Render)

One web service, one instance (rate limits, the AI cap and the cache live in memory). [`render.yaml`](render.yaml) is a Blueprint for it.

1. Push the repo to GitHub. In Render: New → Blueprint → pick the repo. Render reads `render.yaml` (Starter plan, Frankfurt, `npm ci --include=dev && npm run build`, `npm start`, health check `/healthz`).
2. Fill in the `sync: false` variables when prompted: `ANTHROPIC_API_KEY`, and optionally `PAGESPEED_API_KEY`, `TYPEKIT_KIT_URL`, `AUDIT_MODEL`. Leave `WORDFENCE_API_KEY` and `LEAD_WEBHOOK_URL` empty (both dormant, see above). Leave `AI_MODE` empty. Set `PUBLIC_ORIGIN` to the service URL (the `onrender.com` one until a custom domain exists).
3. After the first deploy:
   - `curl https://<app>/healthz`
   - `curl -i -X POST https://<app>/api/audit -H 'Origin: https://<app>' -H 'Content-Type: application/json' -d '{"url":"offshorly.com"}'`
   - Check `curl -I https://<app>/` shows `content-security-policy` with `frame-ancestors` and no `x-frame-options`.
   - Run an audit from two different networks and compare the `ip` hash in the Render logs; identical hashes mean `TRUST_PROXY_HOPS` is wrong.
4. Custom domain: add `audit.offshorly.com` in Render, CNAME it, then update `PUBLIC_ORIGIN`.

Keep the instance count at 1. Scaling out needs a shared store (Redis) for limits and cache.

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
