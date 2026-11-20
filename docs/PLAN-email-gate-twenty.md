# Amendment 3: email gate, Twenty CRM, Cal.com CTA, Render disk

Owner request, 2026-11-20. Overrides docs/PLAN.md where they conflict.

Master agent: claude-opus-5-5 - high

## Plan

**Ground truth I read:** `server/routes/audit.ts`, `server/routes/lead.ts`, `server/app.ts`, `server/index.ts`, `server/config.ts`, `server/http/limits.ts`, `server/http/security.ts`, `server/audit/runAudit.ts`, `server/ai/client.ts`, `shared/services.ts`, `shared/types.ts`, `src/components/Form.tsx`, `src/components/Cta.tsx`, `src/App.tsx`, `src/lib/form.ts`, `src/content/copy.ts`, `render.yaml`, `README.md`, `docs/PLAN.md`.

Main fact behind the boot fix: `index.ts` calls `process.exit(1)` on `ModelConfigError` (bad key or model). A wrong key would fail the first Blueprint deploy. No key is already fine: production with no key gives `aiMode: 'off'`.

### 1. Email gate (one audit per email)
- **Fields:**
  - `email` is required. Label "Your email", `type=email`, `autocomplete=email`.
  - `name` is optional (one field). Sales want a name for follow-up, and Twenty's Person has a name. Optional keeps completions up.
  - No company field. The company comes from the email domain (§4).
  - `marketingOptIn`: unticked checkbox (§6).
- **Validation (server is the authority):**
  - Trim. Length ≤254. Reuse `EMAIL_RE` from `lead.ts`.
  - Reject the domain if it is on a small static disposable-domain list (about 100 domains, `server/lead/disposable.ts`).
  - MX check: `dns.resolveMx`, falling back to A/AAAA. 2 s timeout. Fails open on timeout or SERVFAIL; rejects only on NXDOMAIN or no records. Cheap, and it catches typos (`gmial.com`) and made-up domains. Code `email_invalid`, 400.
- **Canonical gate key** (used only for the gate, never for the CRM):
  - lowercase the whole address
  - strip `+tag` on every domain
  - remove dots and map `googlemail.com`→`gmail.com` for Gmail only
  - key = `HMAC-SHA256(EMAIL_HASH_SECRET, canonical)`, first 32 hex characters
  - These few lines are proportionate. They stop lazy repeats. They don't stop new addresses.
- **What uses up the allowance:** only a 200 response where AI actually ran or legitimately didn't apply. That means the *initial* report (`entry.report`) does not have both `aiStatus` and `buyerFitStatus` equal to `'unavailable'`. Consequences:
  - Unreadable site (422), `busy` (503), 500, AI off (no key), daily AI cap reached, AI skipped for lack of slots: **not used up**.
  - `thin`: used up, because the visitor got the full audit that site allows.
  - AI that fails *after* the response still counts. Accepted; see Risks.
- **Same email, same site:** allowed again. Compare the input host (`www.` stripped) with the domains stored for that key: the input host and `report.domain`. This covers refresh and back, and it hits the URL cache. Per-IP limits still apply.
- **Same email, different site:** 409 `email_used`.
- **Order in `POST /api/audit`:**
  1. origin
  2. validate (URL fields + lead fields)
  3. `normaliseInputUrl`
  4. **per-IP limiter `hit`**. It runs first so email enumeration costs IP allowance. No refund on `email_used`.
  5. email syntax, disposable list, MX
  6. allow-list check (skip gate)
  7. `gate.check(key, domain)`. If the ledger throws: fail open and log `ledger_unavailable`.
  8. in-memory `pending: Map<key, domain>`. The same key with a *different* domain in flight → 503 `busy` "An audit for this email is already running", plus an IP refund.
  9. the existing cache/run path
  10. on 200 + rule met → `ledger.record(key, domains)`
  11. `pending.delete` in a `finally`
- **Cache:** the email never enters `AuditRequest`, `cacheKey`, `runAudit` or any prompt. The route splits the body into `{ audit: AuditRequest, lead: LeadFields }`. A cached report served to a new email is that email's audit: record it and sync it.
- **Second attempt, what the visitor sees:** an alert in place of the form error, with a primary button to Cal.com and a secondary contact link. It must not reveal which site was audited before.
  > "This email has already been used for a free audit. Want to go further? Book a free 30-minute call and we'll walk through your site and where AI could help."
- **No verification, said plainly:** anyone can type any address. That means unlimited audits with fresh addresses, and CRM records created for addresses whose owners never asked.
  - The gate is a speed bump, not a control. Per-IP limits (5/h, 20/day) and `DAILY_AI_AUDITS` remain the real cost controls.
  - The disposable list and MX check are worth having now: about 40 lines, and they improve CRM data quality.
  - The real fix is a code by email. Defer it.
  - Every CRM Note says "Email not verified".
- **Kill switch:** `EMAIL_GATE=on|off`, default `on`. With `off`, email is still required and synced, with no one-per-email limit.

### 2. Persistence: **Render persistent disk + append-only JSONL file**, behind an interface
- **(a) Twenty as the record: rejected.**
  - It needs a custom field or a Note search to tell "has audited" apart from existing contacts.
  - It adds CRM latency to every audit.
  - Failing open when Twenty is down means no gate at all.
  - It couples the gate to the CRM vendor and its rate limits.
- **(c) Key Value or Postgres: deferred.**
  - The free Key Value tier has no persistence. Persistent Key Value or Postgres is about $7–10/month, plus a client dependency and connection handling.
  - It is the right next step when we need zero-downtime deploys or a second instance.
- **(b) chosen:** 1 GB disk at about $0.25/month, no new dependency, about 80 lines.
  - Cost: **a service with a disk loses zero-downtime deploys.** Each deploy stops the old instance first, so expect roughly 30–60 s of downtime. It also cannot scale beyond 1 instance, which is already the case.
  - The worker confirms both against Render's docs.
- **`server/lead/ledger.ts`:**
  - `interface AuditLedger { kind; get(key); record(key, domains): Promise<{created}>; close() }`
  - `MemoryLedger`
  - `FileLedger(path, retentionDays, now)`
- **`FileLedger` behaviour:**
  - At boot: read the file into a `Map`, skip unparseable lines (a torn last line). If any entries are older than the retention period, rewrite the file (write `tmp`, then `rename`).
  - `record`: `appendFile`, serialised through a promise chain.
- **`createLedger(config, log)`:**
  - `LEDGER_PATH` unset → `MemoryLedger`, with a warning in production.
  - Directory missing or unwritable at boot → log an error and use `MemoryLedger`.
- **Failure policy: fail open.**
  - `get` throws → allow.
  - `record` throws → log an error and keep the record in memory.
  - Reason: a broken store must not block a lead-gen widget. The cost backstops stay in place.
- `/healthz` reports `ledger: 'disk'|'memory'`.

### 3. Staff/testing allow-list
- `AUDIT_ALLOWLIST`: space- or comma-separated. Each entry is an exact email or `@domain` (exact domain, no subdomains). Default `@offshorly.com`. Matched on the canonical address.
- Allow-listed addresses skip the gate and are **not recorded**. Per-IP limits still apply. For heavy testing, raise `RATE_LIMIT_HOURLY` temporarily.
- CRM: **skipped** for allow-listed addresses unless `CRM_SYNC_ALLOWLISTED=true`. When synced, the Note title is prefixed `[Test] `. This avoids junk Companies and Notes from test audits of random sites, and still lets the owner test the CRM path on purpose.
- Document that the allow-list is a convenience, not security. Anyone can type `x@offshorly.com`, which gains nothing beyond what unverified email already allows, and those audits skip the CRM.

### 4. Twenty CRM lead
- **Split:**
  - `server/crm/twenty.ts`: the only file that knows endpoint shapes.
  - `server/crm/summary.ts`: pure, builds the title and markdown.
  - `server/crm/sync.ts`: queue and retries.
- **Worker verifies on twenty.com/developers before coding:**
  - REST base and paths (`/rest/people` etc.)
  - Bearer auth
  - filter syntax (e.g. `emails.primaryEmail[eq]`)
  - the Note body field (`bodyV2.markdown` versus legacy `body`)
  - `noteTargets`
  - the `domainName` shape
  - whether `?upsert=true` exists
  - rate limits
  - that records carry `createdBy { source:'API', name:<key name> }`
- **Trigger:** after `ledger.record` (or, when the gate is off or not used up, still on 200). Dedupe through an in-memory TTL set, 24 h, keyed on `key|domain`. Allow-list rule as in §3. `crm.enqueue({lead, entry})`. Fire-and-forget: **never awaited by the route, never affects the response**.
- **Job:**
  1. Await `entry.buyerFit` and `entry.ai`. They never reject. Cap the wait at 100 s.
  2. Build the summary.
  3. **Person:** find by email, lowercased as typed (not the canonical form).
     - Found: update only blank fields (name, company link). Never overwrite.
     - Not found: create with `name {firstName: first token, lastName: rest}` (blank if no name) and `emails.primaryEmail`.
  4. **Company:** only when the email domain equals the audited domain, or one is a subdomain of the other, and the email domain is not free-mail (static list in `server/lead/freemail.ts`). Find by `domainName`, else create (name = domain), then link it to the Person if the Person has none.
     - Agency audits of a client's site therefore create no junk companies. The audited URL lives in the Note.
  5. **Note**, linked to the Person and to the Company when linked.
     - Title: `Website audit: example.com`
     - Body markdown: audited URL; audit date; buyer-fit score and the one-sentence verdict; Security and Health scores; up to 5 "Fix these first" lines (check items use `CheckResult.detail`, buyer-fit items use `buyerFit.actions[i].text`); AI idea titles with service names (or "AI ideas: not run"); "Email not verified"; "Marketing opt-in: yes/no (notice v1, ISO time)"; "Source: audit widget"; "Booking link shown: https://cal.com/offshorly/30min".
- **No Opportunity and no Task now** (Decision Point 3).
- **Queue:**
  - In memory, concurrency **1**, so two jobs for one email can't create duplicate People. Bounded at 500; drop the oldest with a warning.
  - Per request: 8 s timeout. 3 attempts on 429, 5xx or network, with 2 s / 10 s / 60 s backoff. Other 4xx: no retry, log status only.
  - On SIGTERM, drain for up to 7 s, then log the dropped count.
  - Logs: `{emailHash: key.slice(0,12), domain, step, status}`. Never the email, and never Twenty response bodies (they may echo it).
- **Env:**
  - `TWENTY_API_URL`: origin. Cloud `https://api.twenty.com` (verify); self-hosted is the server origin. https only; `http://localhost` allowed outside production.
  - `TWENTY_API_KEY`
  - Either one missing → CRM off. Log `crm: off` at boot; `/healthz` shows `crm: false`.
- **No custom fields needed.** Source attribution comes from `createdBy` (the API key name). Consent goes in the Note text.
- **`scripts/twenty-check.ts`** (`npm run twenty:check`): one read-only call (list 1 person). Prints OK, or the status plus a hint (401 = key, 403 = role).

### 5. Consultation CTA
- Change `CTA.consultation` to `{label: 'Book a free 30-minute consultation', url: 'https://cal.com/offshorly/30min'}`. Remove the duplicate `calCom`. Set `COPY.cta.primary` to the same label.
- A **plain link in a new tab** (existing `ExternalLink`, `rel=noopener`). Not an inline embed, because the embed needs:
  - `frame-src` plus Cal's script in `script-src` (loosening the CSP)
  - a nested iframe inside our auto-resizing iframe on a WP Rocket page
- No CSP change is needed for a link.
- **No name or email prefill.** The no-personal-data-in-URLs rule wins: the details would sit in browser history and Cal logs, and saving 10 seconds of typing doesn't justify it.
- Optional `?utm_source=offshorly-audit` only if Cal.com's docs confirm the booking keeps it. Otherwise use the bare URL.
- Twenty learning about bookings: **out of scope.** Do it with a Cal.com webhook into a Twenty workflow (or Cal's own integration or Zapier) later. No code here.

### 6. Privacy (UK GDPR / PECR): copy to put in `src/content/copy.ts`
- **Under the email/name row:**
  > "We'll add your email, the site you audit and its results to Offshorly's CRM so we can follow up about this audit. One free audit per email. [Privacy policy]"
- **Checkbox (unticked, optional):**
  > "Email me occasional ideas and offers from Offshorly. You can unsubscribe at any time."
- **Replace `form.privacyNotice`:**
  > "We read the public pages of the site you enter and use Anthropic's Claude to analyse them. Your email is never sent to Anthropic."
- **Replace `footer.privacy`:**
  > "We don't save reports or create share links. We keep your email, the site you audited and a summary of the results in our CRM to follow up. Results are otherwise held briefly in memory. The text of the pages we read is sent to Anthropic's Claude for analysis."
- **Lawful basis, for the owner to confirm:** legitimate interests (Art. 6(1)(f)) for storing the lead and one follow-up about the audit the visitor asked for. Further marketing emails only with the ticked box (PECR), unless the owner relies on the corporate-subscriber rule for company addresses.
- **What is stored where:**

  | Where | What | How long |
  |---|---|---|
  | Disk ledger | HMAC hash, domain(s), timestamp (pseudonymous) | `LEDGER_RETENTION_DAYS` = 365 |
  | Twenty | email, name, Note | owner's CRM retention policy; suggest 24 months without contact |
  | Logs | hash only | |
  | Anthropic | no email | |

- The owner updates the privacy policy to name Twenty (CRM) and Render (hosting) as processors, alongside Anthropic.

### 7. Dormant webhook lead route: **remove it**
Delete:
- `server/routes/lead.ts` and `registerLeadRoute`
- `LeadFetch`, `LEAD_LIMIT_HOURLY` and `leadFetch` in `app.ts`
- `leadWebhookUrl` in config, `.env.example`, `render.yaml` and the README
- `AuditReport.leadCapture` (types, `runAudit`, `mockApi`, tests)

Move `EMAIL_RE` and `sanitiseLeadName` into `server/lead/email.ts`. Lead capture then has one path.

### 8. Boot resilience and Render blueprint
- **`server/ai/init.ts`:** `initAi(config, {createAnthropic, probe})` returns `{ai, aiMode, aiConfigError}`.
  - `ModelConfigError` → log `"AI disabled: <message>"` and return `ai:null, aiMode:'off', aiConfigError:true`. **Do not exit.**
  - `index.ts` passes the effective `aiMode` to `buildApp`.
  - `/healthz` → `{ok, aiMode, aiConfigError?, version, ledger, crm}`.
  - `AI_MODE=live` with no key still throws `ConfigError` (explicit misconfiguration). The README says to leave `AI_MODE` empty.
- **`render.yaml` changes:**
  - Remove `LEAD_WEBHOOK_URL`.
  - Add:
    ```yaml
    disk: { name: audit-data, mountPath: /var/data, sizeGB: 1 }
    - key: EMAIL_HASH_SECRET   # generateValue: true  (never change: resets the one-per-email record)
    - key: LEDGER_PATH         value: /var/data/audit-ledger.jsonl
    - key: LEDGER_RETENTION_DAYS value: "365"
    - key: EMAIL_GATE          value: "on"
    - key: AUDIT_ALLOWLIST     value: "@offshorly.com"
    - key: CRM_SYNC_ALLOWLISTED value: "false"
    - key: TWENTY_API_URL      sync: false
    - key: TWENTY_API_KEY      sync: false
    ```
  - Comment: "disk ⇒ no zero-downtime deploys; keep numInstances 1".
  - The disk is only mounted at runtime. Nothing in the build touches `/var/data`.
  - `PUBLIC_ORIGIN` stays `sync:false`, **left blank on the first deploy**. `originAllowed` already accepts the request's own Host, and the iframe calls same-origin. Set it once `audit.offshorly.com` exists.
- **Owner's first deploy, click by click:**
  1. Confirm `render.yaml` is at the repo root on `main`.
  2. Render dashboard → **New +** → **Blueprint** → connect GitHub and grant access to `alexcatlin/Offshorlyaudit` → pick the repo and branch `main` → name it `offshorly-audit`.
  3. Review the resources: web service (Starter, Frankfurt) + 1 GB disk.
  4. Fill the prompted variables (table below). Blank is fine for everything on a smoke test.
  5. **Apply**. Wait for build, deploy and a green health check.
  6. Open `https://<service>.onrender.com/healthz`. Expect `ledger:"disk"`, plus `aiMode` and `crm` as configured.
  7. Run an audit with your `@offshorly.com` email (allow-listed).
  8. Add keys later in **Environment** → Save. This redeploys.
  9. Set a monthly spend limit in the Anthropic console.
  10. Note: with AI off, gate testing shows nothing, because nothing is used up.
- **Env vars to fill:**

  | Var | Status |
  |---|---|
  | `ANTHROPIC_API_KEY` | required for the full audit; blank = measured-only, gate inactive |
  | `TWENTY_API_URL`, `TWENTY_API_KEY` | required for CRM; blank = CRM off |
  | `PAGESPEED_API_KEY` | optional |
  | `AUDIT_MODEL` | optional |
  | `TYPEKIT_KIT_URL` | optional |
  | `PUBLIC_ORIGIN` | after the custom domain |
  | `AI_MODE`, `WORDFENCE_API_KEY` | leave blank |
  | `EMAIL_HASH_SECRET` | auto-generated |
  | everything else | preset in the yaml |

### 9. Front end
- **`FormValues`** gains `email`, `name`, `marketingOptIn`. `buildRequest` adds `email` (trimmed), `name?`, and `marketingOptIn` only when true.
- **Layout:** URL input (the submit button moves out of the URL row) → 2-column Email* / Name (optional) → checkbox → **Run the audit** → notice → the existing expanders.
- **Client email check:** simple regex, focus the field on error. Server errors with `email_invalid` focus email too.
- **`ErrorCode`** gains `email_invalid` and `email_used`, with entries in `ERROR_COPY`.
- **`App.tsx`:** on `email_used`, render the alert with the Cal button and contact link. `Form` takes an `errorCode` prop.
- **`mockApi`:** `?mock=1&emailUsed=1` simulates the 409.

### 10. Docs
- `docs/PLAN.md`: append "Amendment 3 (owner request, 2026-11-20): email gate, Twenty CRM, Cal.com CTA, Render disk" summarising §1–9.
- README: API, env table, Deploy and Twenty sections; remove "Lead capture (dormant)".
- `.env.example`
- `.gitignore`: add `.data/`

### 11. Tests
- **`email.test.ts`:** normalisation (case, whitespace, `+tag`, Gmail dots, googlemail); HMAC stable per secret, different across secrets; length and syntax rejects; disposable reject; MX with an injected resolver (MX ok; A-only ok; NXDOMAIN reject; timeout/SERVFAIL → ok); allow-list parsing (`@offshorly.com` matches `a@offshorly.com`, not `a@x.offshorly.com`; exact entries).
- **`ledger.test.ts`** (tmp dir): record → a new instance reloads it; torn last line skipped; retention prune rewrites the file; unwritable path → `kind:'memory'`; serialised appends under concurrency.
- **`crm.test.ts`** (fake fetch):
  - new Person + Note + target
  - existing Person: name not overwritten, Note added
  - Company only on a matching non-free-mail domain
  - 429 → retry → ok; 400 → no retry
  - jobs run serially; bound drops the oldest
  - captured logs contain no email
  - summary contains scores, idea titles, "Email not verified" and the consent line
  - "AI ideas: not run" when AI was off
- **`app.inject`:**
  - missing or invalid or disposable email → 400 `email_invalid`
  - first audit → 200 and recorded
  - same email, other domain → 409 `email_used`
  - same email, same domain → 200
  - cached URL + new email → 200 and recorded
  - 422 unreadable → not recorded, then a different site → 200
  - 503 busy → not recorded
  - `ai:null` → 200, not recorded
  - allow-listed → repeated 200s, no record, no CRM call (and a call plus `[Test]` with the flag)
  - `ledger.get` throws → 200
  - concurrent same email on two domains → one 503
  - CRM fake throws → still 200
  - the email is absent from the log stream, from the `runAudit` request (spy) and from the cache key
  - `/api/lead` → 404
  - `/healthz` has `ledger` and `crm`
- **`config.test.ts`:** new vars, https rule for `TWENTY_API_URL`, `EMAIL_GATE` enum, retention range, allow-list default.
- **`ai.init`:** refused key → AI off, `aiConfigError` true, no exit.
- **`frontend.test.ts`:** `buildRequest` lead fields; `ERROR_COPY` covers the new codes; CTA href is the Cal URL, `target=_blank`.

### 12. Verification
- **Local, no Twenty credentials:**
  - `npm test`, `npm run typecheck`, `npm run build`.
  - `LEDGER_PATH=./.data/ledger.jsonl node dist/server/index.js` (fixture AI, so the allowance is used up). Then curl: first email/site 200 → other site 409 → same site 200 → restart the server → still 409.
  - `grep -c '@' ` on the log output for the test email is 0.
  - `/healthz` shows `ledger:"disk", crm:false`.
- **With the owner's credentials:**
  - `npm run twenty:check` passes.
  - On Render, set `CRM_SYNC_ALLOWLISTED=true`, run one audit, confirm the Person, Note and (matching domain) Company in Twenty, filterable by Created by = the API key name.
  - Delete the test records and set the flag back to false.
- **Render:**
  - `/healthz` shows `ledger:"disk"`.
  - Redeploy → the gate persists.
  - Use a non-allow-listed address with AI on to test the 409.
  - `curl -I /` CSP unchanged.
  - Per-IP hash check as before.

## Data shapes

```ts
// POST /api/audit body (shared/types.ts)
interface LeadFields { email: string; name?: string /* ≤100, sanitiseLeadName */; marketingOptIn?: boolean }
type AuditStartBody = AuditRequest & LeadFields;          // route splits; runAudit sees AuditRequest only
type ErrorCode = /* existing */ | 'email_invalid' | 'email_used';   // 400 / 409
// AuditReport: remove leadCapture

// Ledger line (JSONL, v1)
{ "v":1, "k":"<32 hex HMAC>", "d":["example.com"], "t":"2026-11-20T10:00:00.000Z" }
interface LedgerEntry { domains: string[]; at: number }
interface AuditLedger {
  readonly kind: 'disk' | 'memory';
  get(key: string): Promise<LedgerEntry | null>;           // may throw → caller fails open
  record(key: string, domains: string[]): Promise<{ created: boolean }>;
  close(): Promise<void>;
}

// CRM
interface CrmLead { email: string; name?: string; marketingOptIn: boolean; consentAt: string;
                    noticeVersion: 'v1'; emailHash: string; test: boolean }
interface CrmSync { enqueue(lead: CrmLead, entry: AuditEntry): void; drain(ms: number): Promise<number /*dropped*/> }
interface TwentyClient {                                   // shapes confirmed from docs
  findPersonByEmail(email: string): Promise<{ id: string; hasName: boolean; companyId: string | null } | null>;
  createPerson(p: { firstName: string; lastName: string; email: string; companyId?: string }): Promise<string>;
  updatePerson(id: string, patch: { firstName?: string; lastName?: string; companyId?: string }): Promise<void>;
  findCompanyByDomain(domain: string): Promise<string | null>;
  createCompany(c: { name: string; domain: string }): Promise<string>;
  createNote(n: { title: string; markdown: string; personId: string; companyId?: string }): Promise<void>;
}

// /healthz
{ ok: true, aiMode, aiConfigError?: true, version, ledger: 'disk'|'memory', crm: boolean }
```

| New env var | Default | Notes |
|---|---|---|
| `EMAIL_GATE` | `on` | `off` = no one-per-email limit |
| `EMAIL_HASH_SECRET` | random per process (warn) | Render `generateValue`; changing it resets the gate |
| `LEDGER_PATH` | none → memory | Render `/var/data/audit-ledger.jsonl` |
| `LEDGER_RETENTION_DAYS` | 365 | 30–1825 |
| `AUDIT_ALLOWLIST` | `@offshorly.com` | emails or `@domain` |
| `CRM_SYNC_ALLOWLISTED` | `false` | |
| `TWENTY_API_URL` | none | https; localhost http outside production |
| `TWENTY_API_KEY` | none | secret |
| ~~`LEAD_WEBHOOK_URL`~~ | removed | |

## Risks
- **Unverified email.** Unlimited audits with fresh addresses, and CRM records for third-party addresses. Mitigated by per-IP limits, the AI cap, "Email not verified" on every Note, and no email ever being sent to the address. Verification is the later fix.
- **Disk.** Deploys have downtime (no zero-downtime), and the service is pinned to 1 instance. Losing the disk or changing `EMAIL_HASH_SECRET` resets the gate (fail-open by design).
- **Late AI failure.** It still uses up the allowance (the response already went out). This is rare, and the visitor can book the call.
- **Twenty API drift** (Note body field, filter syntax, `domainName` shape, key roles). Contained to `twenty.ts` and caught by `twenty:check`. Retries are in memory, so jobs are lost on restart and logged.
- **Company duplication.** If Twenty stores `domainName` with a different scheme or `www`, matching may miss. Normalise both sides and filter with a contains/ilike match as the docs allow.
- **Email enumeration** through 409. It costs IP allowance and never reveals the domain.
- **MX lookups** add up to 2 s in the worst case. They fail open.

## Decision Points (build proceeds on these defaults)
1. **Store:** Render disk + JSONL (about $0.25/month, deploy downtime). Alternative: Render Postgres or Key Value (about $7–10/month, keeps zero-downtime). Default: **disk**.
2. **What uses up the allowance:** only when AI ran or the site was thin. AI off, cap or busy don't count. Default: **as stated**.
3. **Twenty records:** Person + Note, plus Company only when the email domain matches the audited domain. No Opportunity or Task. Default: **as stated**. Easy to add a "Follow up" Task later.
4. **Allow-listed CRM sync:** skip unless `CRM_SYNC_ALLOWLISTED=true` (then a `[Test]` prefix). Default: **skip**.
5. **Cal.com:** a link in a new tab, no prefill, `utm_source` only if Cal keeps it. Default: **as stated**.
6. **Marketing checkbox:** included, unticked. Lawful basis is legitimate interests for the follow-up. **The owner confirms the wording with whoever advises on GDPR.**
7. **Name field:** optional. Default: **include**.
8. **Bad key at boot:** start with AI off and flag it in `/healthz`, instead of exiting. Default: **degrade**.

## What the owner must provide
- [ ] **Twenty:** whether it is cloud or self-hosted, and its URL. That gives `TWENTY_API_URL` (cloud is likely `https://api.twenty.com`; the worker confirms).
- [ ] **Twenty API key:** Settings → APIs & Webhooks → Create key named `audit-widget`. Note the expiry date. If the workspace uses roles, give it read + create + update on People, Companies and Notes (including note targets). No delete.
- [ ] No custom fields are needed. To see audit leads, filter People by Created by = `audit-widget`.
- [ ] **Anthropic API key**, with a monthly spend limit set in the console.
- [ ] Optional: `PAGESPEED_API_KEY`.
- [ ] Confirm the privacy wording and lawful basis (§6), and update the offshorly.com privacy policy to name Twenty, Render and Anthropic.
- [ ] Confirm `https://cal.com/offshorly/30min` is the booking link to use, and whether the Cal event should collect company or website.
- [ ] After the first deploy, send the service URL. Later, add the `audit.offshorly.com` CNAME, then set `PUBLIC_ORIGIN`.
- [ ] Optional, later: a Cal.com webhook into Twenty so bookings show up in the CRM.

There is no code yet, so I have not run `/dw review`. Run it when this work comes back for review.