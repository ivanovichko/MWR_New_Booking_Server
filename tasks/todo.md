# Session 22 — Freshdesk retirement

Freshdesk is gone. The Zoho Desk overlay (`frontend/MWR Zoho Tools.user.js`) is
the only client, and it calls exactly 8 backend routes out of ~41. Everything
else served Freshdesk or the abandoned Zoho Desk *extension*.

Decisions taken up front:
- Pendings + Batch Triage: **retired completely**, not kept as portable parts.
- Hotel Email: **retired**. The overlay's supplier email builds its own HTML.
- `/ai-assist`: **retired** — Zoho has AI out of the box.
- Route namespace: **`/api/*`**, guarded as one middleware.
- `TA_Zoho_beta/`: **kept on disk, untouched** (gitignored, no history to
  recover from). Its backend half goes; the directory stays as a reference.

## Phase 1 — Freshdesk client
- [x] `frontend/MWR Booking Tools.user.js` (3351)
- [x] `frontend/MWR Booking Tools.options.json` + `.storage.json`
- [x] `userscript-patch.js` (95, points at localhost:3000, pre-dates everything)

## Phase 2 — Freshdesk backend
- [x] `services/freshdeskService.js` (441)
- [x] `services/agentService.js` (80)
- [x] `services/ticketService.js` (87)
- [x] `services/ticketActionService.js` (112)
- [x] `services/batchTriageService.js` (403)
- [x] `services/triageAiService.js` (132)
- [x] `services/noteDetectionService.js` (115)
- [x] `services/hotelEmailBuilder.js` (71)
- [x] `config.js` (15) — nothing imports `TA_BASE` or the prewarm threshold
- [x] 29 routes out of `server.js`

## Phase 3 — Zoho extension backend
The overlay authors its writes same-origin as the signed-in agent (`zdPost`),
so the org-level OAuth path has no caller.
- [x] `services/zohoDeskService.js` (147)
- [x] `services/zohoTicketActionService.js` (32)
- [x] `/zoho/oauth-session`, `/zoho/config`, `/zoho/orgs`, `/zoho/post-note`,
      `/zoho/member-note`, `/zoho/hotel-email/lookup`
- [x] `zoho_sessions` table + accessors

## Phase 4 — trim survivors
- [x] `prewarmService.js` → `bookingService.js`; keep `extractBookingId`,
      `fetchAndCacheBooking`. `checkInPriority` dropped too — its only callers
      were batch triage and Pendings; the overlay computes days-to-check-in
      client-side in `daysUntilCheckIn`.
- [x] `aiService.js` → **`translateService.js`**. With only translation left,
      the Google-then-Groq fallback moved out of `server.js` into it, so the
      whole translation concern is one module and the route is 8 lines.
- [x] `dbService.js` — drop `freshdesk_sessions`, `ticket_summaries`,
      `agent_prompts`, `agent_macros`, `zoho_sessions` from `initDb` and the
      accessors. No destructive migration: existing tables are left in the DB.
- [x] `auth.html` — TA cookie only
- [x] `package.json` — drop `multer`, `form-data`

## Phase 5 — one guarded namespace
- [x] Every route under `/api/*`, `requireApiSecret` as `app.use` middleware
- [x] Delete `allowZohoWidgetOrigin` + both CORS mounts (extension-only)
- [x] Replace `app.use(express.static(__dirname))` — it currently serves the
      whole repo; `server.js` and `services/*.js` are publicly fetchable
- [x] Userscript: repointed 8 `api.*` URLs, `@version` 0.13.0. **No first-run
      prompt added** — `loadTicketInner` already checks `getSecret()` and
      renders "No backend key set. Click ⚙ above to enter it.", which beats a
      `window.prompt` on page load.

## Phase 6 — docs
- [x] Rewrite `.claude/CLAUDE.md` (still documents the Guided modal, prewarm
      batch, Freshdesk-first architecture)
- [x] `tasks/backlog.md` — close §2, §3, §4, §4b, §5

## Verification
- [x] Server boots, schema applies
- [x] No `freshdesk` / `guided-prewarm` references left outside `tasks/` and history
- [x] Every surviving `require()` resolves
- [x] Every userscript `api.*` URL matches a live route
- [x] `/health` 200; `/api/*` 401 without bearer, 200 with

## Review

**Net: 6,957 lines deleted, 478 added across 25 code files.** 41 routes → 13.
20 source files → 9 (18 services + `server.js` + `config.js` → 8 services + `server.js`). Every deletion is recoverable from git history.

### What went as planned

Phases 1–4 were pure subtraction and nothing pushed back. The dependency graph
was cleaner than expected: `parserService`, `userService`, `noteBuilder` and
`supplierService` had zero Freshdesk coupling, and `prewarmService` had exactly
two lines of it (the `freshdeskService` and `FD_STATUS` imports).

### Three findings that were not in the plan

1. **The Zoho extension backend was dead too.** `zohoDeskService.js`,
   `zohoTicketActionService.js` and six `/zoho/*` routes existed only for
   `TA_Zoho_beta/`. The overlay posts notes same-origin as the signed-in agent
   via `zdPost` and never touches the org-level OAuth token — so the entire
   OAuth path, the `zoho_sessions` table and three Render env vars had no
   caller. Deleted; `TA_Zoho_beta/` itself kept on disk per instruction.

2. **`app.use(express.static(__dirname))` served the whole repo.** Verified
   against `HEAD` before the change: `/server.js` and `/services/dbService.js`
   both returned 200. Now 404 — `auth.html` is served by an explicit route.
   No credentials were exposed (dotfiles are not served, and secrets live in
   env vars), but the source was public.

3. **Four dead DB tables and a dead settings API.** `/settings/prompts` had no
   client and `aiService` never read prompts from the DB — the table had been
   orphaned since the prompt text was inlined. `ticket_summaries` was exported
   but never imported.

### Deliberate non-deletions

- `GET`/`DELETE /api/ticket-booking/:ticketId` have no caller. Kept as the
  read/delete half of a table the overlay actively writes; filed in backlog §3.
- The env var is still `ZOHO_BACKEND_SHARED_SECRET`. Renaming it to match the
  `/api` namespace buys nothing but a Render dashboard edit and an outage
  window if the two halves change out of step.
- `SYSTEM_EMAIL_DOMAINS` in the overlay still matches `freshdesk.com` —
  migrated tickets carry the old FD routing address in `ticket.email`. That is
  data reality, not dead code.

### Verification performed

- Server boots; all 13 routes mount.
- `/health` 200, `/auth` 200.
- `/api/extract` → 401 with no bearer and with a wrong bearer; a correct bearer
  reaches the handler.
- `/server.js`, `/services/dbService.js`, `/package.json` → 404 (were 200).
- Every `require()` in the 9 surviving files resolves.
- All 7 distinct `api.*` paths in the userscript match a declared route.
- `node --check` clean on the userscript.

**Not verified:** no live DB or TA session locally, so no route was exercised
end-to-end. The overlay needs a run against a real Zoho ticket before this
reaches Render. Not pushed.

---

# Groq model deprecation fix — llama-3.3-70b-versatile shut down 2026-08-16

Every backend LLM call except `groq/compound` was pointed at a retired model.

- `llama-3.3-70b-versatile` — deprecation announced 2026-06-17, **shut down
  2026-08-16**. Groq's recommended replacements: `openai/gpt-oss-120b` or
  `qwen/qwen3.6-27b`.
- `compound-beta-mini` — delisted; the compound systems are now `groq/compound`
  and `groq/compound-mini`.
- `groq/compound` (aiService.js:169) is still current — untouched.

Chose `openai/gpt-oss-20b` for the extraction/triage calls: $0.075/$0.30 per M
and ~1000 tok/s, which matters because Assisted mode prewarms 3 tickets in
parallel on every ticket navigation. These are simple structured-extraction
prompts, well inside its range.

**gpt-oss is a reasoning model.** Reasoning text lands in `message.reasoning`,
not `message.content`, so the existing content + regex-JSON parsing is
unaffected — but reasoning tokens spend the completion budget, so the old
`max_tokens` caps (100/120/150/250) would have returned empty content. Every
budget was raised and `reasoning_effort: 'low'` set.

## Tasks

- [x] `services/prewarmService.js:61` — model → `openai/gpt-oss-20b`,
      `reasoning_effort: 'low'`, `max_tokens` 100 → 512
- [x] `services/prewarmService.js` — add the missing `res.ok` check in
      `extractBookingId`. Without it a decommissioned-model 400 was parsed as
      JSON, failed, and fell through to `{ bookingId: null }` — so prewarm
      reported "no booking found" instead of erroring. This is why the outage
      was silent.
- [x] `services/aiService.js` — `groqJson` takes `reasoningEffort` (default
      `'low'`) and sends it; both triage services inherit it
- [x] `services/aiService.js:233` — `compound-beta-mini` → `groq/compound-mini`
      (+ stale docstring on line 198)
- [x] `services/noteDetectionService.js:3` / `services/triageAiService.js:3` —
      `TRIAGE_MODEL` default → `openai/gpt-oss-20b`; `process.env.TRIAGE_MODEL`
      override kept
- [x] Triage token budgets: noteDetection 120 → 512; triageAi 150 → 512, 250 → 768
- [ ] Live smoke test (needs `GROQ_API_KEY`, not present in this checkout)
- [ ] Redeploy Render — no env-var change needed

## Review

Static verification done: no `llama-3\*` or `compound-beta*` strings remain
anywhere outside `node_modules`; all four patched services pass `node --check`
and `require()` clean.

Not yet verified live — this checkout has no `.env` / `GROQ_API_KEY`. The smoke
test written for it hits `/openai/v1/models` (asserting the new IDs are present
and the old ones gone) and then exercises all five changed call paths, asserting
a *parsed* result, which is what catches a too-small reasoning budget:

    GROQ_API_KEY=gsk_… node <scratchpad>/groq-smoke.js

Residual risk if that isn't run: the 512/768-token budgets are an estimate. If
`reasoning_effort: 'low'` still overruns them, the symptom is `groqJson`
returning `null` and the `[triage] Groq returned non-JSON` warning in the logs.

# Zoho: merge-field substitution vindicated + secretless widget (session 21)

The "Deluge function" dead-end from session 20 is resolved — in the opposite
direction than recorded. **Zoho DOES substitute `{{...}}` merge fields**; the
2026-07-20 abandonment proof was invalid.

## Root cause of the false negative

1. The old widget percent-encoded the placeholders while assembling the Sigma
   Execution URL (`%7B%7BsigmaInstallId%7D%7D`). Substitution is a literal
   text-match performed **server-side in the ZOHODESK.request proxy** — an
   encoded token matches nothing, so the raw placeholder went out as the API
   key and Sigma rejected every call before the function body ran.
2. The "proof" was a browser console log — but the browser is *supposed* to
   see raw placeholders; substitution happens after the browser, in the proxy.
   And plain `fetch` bypasses the proxy entirely and never substitutes.

## Live probes (MWR_TEST widget console → Render /zoho/extract)

- `Bearer {{backend_shared_secret}}` raw in headers → passed
  `requireZohoSecret` (400 on missing body = auth OK); wrong-bearer control
  got 401. **Substitution confirmed.**
- Final probe → **200** `{success, bookingId, summary}` end-to-end via proxy.
- Probe traps found: no top-level `contentType` param exists (Content-Type
  must go inside `headers`, else `req.body` arrives as `{}`); the promise
  RESOLVES even on 4xx/5xx with a JSON-string envelope
  `{responseHeaders, response, statusCode}`; Render hibernation returns an
  HTML wake page mid-probe.

## What changed

- `widget.js`: `callBackend()` now goes through `ZOHODESK.request` with the
  literal placeholder in the Authorization header; `getSharedSecret()` + the
  `extension.config` read deleted. **The org-level secret no longer reaches
  the browser** — the beta devtools-exposure trade-off is closed.
- No manifest change needed (Render host was already in `whiteListedDomains`).
- `zet validate` clean; `zet pack` → `dist/TA_Zoho_beta.zip` (8 files).
- Deluge/`functions/*.dg` stay dead — not needed for any of this.

## Booking table parity (session 21, cont.)

- `widget.js` `renderBooking` rewritten as a **row-for-row mirror** of the
  Freshdesk userscript's `renderBookingPanel`: same rows (Booking ID, Supplier
  ID, Type, Supplier, Hotel/Airline by product type, Guest, Check-In/Out, Days
  until, Room Type, Bed Types, Arrival time, Requests, AI Reconfirm), same
  order + conditional logic, same inline table styling (16px, th #888 / 35% /
  nowrap, td #333). `cleanSupplierName`, `daysUntil`, and
  `renderAiReconfirmBadge` ported verbatim. Both panels read from the same
  `/guided-prewarm/booking/:id` shape, so no new fields needed.
- Buttons now **Post Note · View Note · Change Booking** (Hotel Email dropped
  for now). Change Booking toggles an inline input (pre-filled with the current
  ID) → `fetchBooking(id)` → re-render. `fetchBooking` factored out and shared
  with the initial load.
- Fixed the stale `widget.html` comment that still claimed Zoho never
  substitutes merge fields.
- `node --check` + `zet validate` clean; repacked `dist/TA_Zoho_beta.zip`.

## Member section under booking (session 21, cont.)

- Ported the Freshdesk `appendCustomerSection` into the widget as
  `appendMemberSection`, rendered directly under the booking table: **Profile**
  tab (Login as User / Open Full Profile links + Post Member Note + member
  details table), **Reservations** tab (lazy-loaded list; row click loads that
  booking into the panel), and **Find member** search (Select overrides the
  displayed member for the session).
- Refactored render flow: `renderBooking` is now a thin setter →
  `renderPanel()` paints booking-or-no-booking + always the member section.
  Every re-render path funnels through `renderPanel`. No-booking tickets now
  still show Find member (was a dead end before).
- **Request-helper generalized:** `callBackend` → thin wrapper over a new
  `proxyRequest(path, {method, body, withSecret})`. All backend traffic now
  goes through Zoho's request proxy, including the unauthenticated read routes
  `/find-user` and `/user/:id/reservations` — they carry no CORS headers for
  the sandbox origin, but the proxy is server-side so CORS never applies (host
  already in `whiteListedDomains`). Reservation-row booking loads still use the
  plain-fetch `fetchBooking` (that route has CORS).
- Backend: added `POST /zoho/member-note` (behind `requireZohoSecret`, CORS via
  the existing `/zoho` mount) — posts arbitrary prebuilt HTML via `postComment`
  with no booking/tagging, for the member note. **Needs a Render redeploy.**
- `node --check` (both files) + `zet validate` clean; repacked.
- Caveat: the member-note write is still cross-DC blocked like Post Note
  (backend on prod `.com`, test org on `.eu`) — reads (reservations, find) work
  now; the write won't land until the backend is repointed.

## View Note → native Zoho modal (session 21, cont.)

- **Original bug:** View Note threw `Cannot read properties of undefined
  (reading 'indexOf')`. Root cause was the **argument shape**, not a missing
  API: `App.instance.modal()` IS real but takes a single options **object**
  `{ url, title }`. The earlier call passed `(url, title)` positionally, so the
  SDK read `.url` off a string / undefined → the indexOf throw.
- First fix was an in-widget overlay, but it's trapped in the narrow right-panel
  iframe (a sandboxed cross-origin iframe can't paint over the parent page), so
  it was cramped. **Replaced with the native modal**, which Zoho renders
  centered over the whole Desk page.
- `onViewNote` now calls `App.instance.modal({ url:
  '/app/modal-note.html?bookingId=' + id, title: 'Booking Note' })`. Restored
  the `App` handle from onload.
- Recreated `app/modal-note.html` as a **self-fetching page**: reads
  `?bookingId`, re-fetches `/guided-prewarm/booking/:id` (CORS-enabled, plain
  fetch), renders `noteHtml`. Only the id travels in the URL — no note-size
  limit. Best-effort `ZOHODESK.invoke('RESIZE', {width:'70%',height:'80%'})` to
  enlarge; rendering never depends on the SDK.
- `node --check` + `zet validate` clean; repacked (8 files again). **No backend
  redeploy needed** — the booking route already exists.
- **First-side-load risks to watch:** (1) whether the modal page needs a
  `plugin-manifest.json` declaration (docs unclear — went without, matching the
  documented example); (2) whether RESIZE fires / the default modal size.

### Modal 400 — Zoho double-'?' (fixed)

- **Symptom:** modal opened but `modal-note.html` request 400'd. URL was
  `.../modal-note.html?bookingId=X?serviceOrigin=...` — **two `?`**. Zoho
  appends its own params (serviceOrigin, frameorigin, _iam_*) to the modal URL
  with a literal `?`, assuming the passed URL has **no query of its own**. Our
  `?bookingId=` collided → malformed URL → 400.
- **Fix:** pass the id in the **hash** (`#bookingId=`), not the query. Zoho's
  `?`-append then lands inside the fragment, so the file request stays
  query-clean. `modal-note.html` parses the id via
  `(location.hash + '&' + location.search).match(/bookingId=([^?&#]+)/)` — robust
  to Zoho's trailing params landing in either hash or search.
- Residual (unlikely) risk: if the appfiles server *requires* serviceOrigin as
  a real query param to serve the file, the hash puts it in the fragment and it
  could still 400. If so, fall back to passing no data in the URL (ZOHODESK
  storage, or re-extract in the modal). Judged unlikely — the file path is
  signed/versioned, so the 400 was the malformed double-`?`, not a missing param.

## Next

- [x] Re-publish + reinstall the new zip on MWR_TEST — **verified live
      2026-07-22**: extract renders through the proxied secretless path.
- Backlog §4b is now cleaner: `GET /zoho/booking/:id` behind
  `requireZohoSecret`, called via `ZOHODESK.request` with the placeholder;
  then drop the `/guided-prewarm` CORS mount.
- Post Note still blocked cross-DC (backend on prod `.com`, test org on `.eu`).

---

# Zoho Desk extension setup (session 20)

Getting `TA_Zoho_beta/` from hand-authored prototype to a package that
`zet validate` accepts, so the only remaining work is console-side.

## Backend state (done this session)

- OAuth self-client grant exchanged — durable `refresh_token` in `zoho_sessions`.
- `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_BACKEND_SHARED_SECRET` live on Render.
- Org confirmed via new `GET /zoho/orgs`: **`914515468` ("MWR LIFE")**, on the
  **`.com` data center** — no `ZOHO_ACCOUNTS_URL` / `ZOHO_API_DOMAIN` overrides needed.
- `ZOHO_ORG_ID` set on Render.

## Key finding

`zet validate` runs **offline, no login**, and the authoritative reference
manifest ships inside the installed CLI at
`$(npm root -g)/zoho-extension-toolkit/apptemplate/desk/plugin-manifest.json`.
That retires the README's "manifest shape not confidently verified" caveat.
(`zet init`'s `--zoho-service` flag is broken for every casing of `desk`, but
it's moot — the template is readable directly.)

## Checklist

- [x] Merge the four missing manifest keys (`type`, `zohoAuthorisation`,
      `connectors`, `moduleSupport`); drop the non-template `secret` key
- [x] Copy real `icon.png` / `logo.png` from the template into `app/img/`
- [x] `zet validate` until clean
- [x] `.gitignore` the `zet` crash artifacts (`ZET_INIT/`, `ZET-debug.log`)
- [x] Refresh `TA_Zoho_beta/README.md` with what's now confirmed

## Deferred deliberately

Not restructuring around the suspected `secure: true` config problem
(`plugin-manifest.json` marks `backend_shared_secret` secure, but `widget.js`
reads it client-side via `ZOHODESK.get('extension.config')`). If Zoho won't
expose it to client JS, Post Note 401s and the call must move into the Deluge
function. Can't be tested offline — confirm on first side-load rather than
rebuilding on a suspicion.

## Still needs Zoho console access

- Create the `analyzeTicket` function, verify the guessed `Zia[... parameters:]`
  provider key, paste its Execution URL into `widget.js:12`
- Side-load and test Post Note against a sandbox ticket

## Review

**What landed**

`plugin-manifest.json` gained `type: "personal"`, `zohoAuthorisation: {}`,
`connectors: []`, `moduleSupport: false`; the non-template `secret` key was
dropped. Added `resources.json` and `app/translations/en.json` (empty `{}`
stubs — the `desk` template omits translations, but validation requires it
when `locale` is set). Real 512×512 `icon.png` / `logo.png` copied from the
template into the previously-empty `app/img/`.

**Verification**

- `zet validate` → `Validation Rules passed successfully.`
- `zet pack` → `dist/TA_Zoho_beta.zip`, 8 files, 24.5 KB. Contents confirmed
  by `unzip -l`: manifest, resources, both images, all three app files,
  translations. `functions/analyzeTicket.dg` correctly absent (console-side).
- Backend `GET /zoho/orgs` returned `{"success":true,"orgs":[{"id":914515468,
  "name":"MWR LIFE"}]}` — first proof a stored session reaches Desk.

**Iteration path** (worth recording — each `zet validate` run surfaces only
the first error class): missing `connectors` → missing translations +
`resources.json` → clean.

**Not done / next**

Console-side only: create `analyzeTicket`, verify the guessed Zia provider
key, paste the Execution URL into `widget.js:12`, install the zip, enter
`backend_shared_secret`. Then the `secure: true` question resolves itself on
the first Post Note.

## Install attempt — Developer Mode failed (unresolved)

Desk Developer Mode enabled, `zet run` serving `https://127.0.0.1:5000`, cert
trusted in Chrome's nssdb. Zoho fetches `plugin-manifest.json` +
`resources.json` (200) then **never requests `/app/widget.html`** — rejects at
parse with "Unable to load your extension. Please check your plugin-manifest
or Resources.json."

Ruled out by direct test, each confirmed via the dev server's request log
(byte sizes track each edit, so we know Zoho re-fetched every version):

1. `config` block → served `"config": []`, same error
2. widget `location` → `desk.ticket.detail.rightpanel` is in the CLI's own
   valid-location list
3. `resources.json` → `{}` is what the template ships; no template has content
4. extension name → `server/index.js` injects the *directory* name
   (`TA_Zoho_beta`); patched to serve the registered `MWR_BOOKING_MODULE`,
   same error

**Zoho's pristine template manifest fails identically**, which is what proves
this isn't manifest content. Cause still unknown.

`zet validate` passing means less than it appears — it's a local lint that
never contacts Zoho. A manifest can pass it and still be rejected on load.

**Next route:** publish-as-private (Sigma Drafts → Publish → Visibility
Private → Installation URL → select portal/departments/profiles → Install),
using the already-validated zip. Slower iteration, but doesn't depend on the
local-server handshake.

Dev harness now in `TA_Zoho_beta/` (gitignored): `package.json`,
`server/index.js`, self-signed certs, `node_modules`. `zet pack` excludes all
of it — zip stays at 8 files.

---

# Batch Triage module (session 19)

Walks every LOW-priority ticket in the agent's current Freshdesk filter view through a
triage pipeline and reports what happened as a step-by-step table. **Dry-run by default** —
the full pipeline runs for real but notes/tags/emails are simulated, so the table shows what
*would* happen. Built for hot testing before trusting it with live mail.

## Pipeline
```
fetch ticket → extract booking ref → resolve booking
  → product bucket (deterministic, no LLM):
      voucherUrl set, or car/transfer/ground/activity → voucher
      hotel/getaway                                   → continue
      anything else (flight, cruise, unknown)         → unsupported_product
  → note already posted? (marker scan, Groq only on a miss) → post if not
  → voucher: stop here
  → Groq: booking_reconf vs customer
      customer → Groq pending-state → report only, no writes
      reconf   → search other live tickets by internal + supplier ref
                   found        → collect links, stop
                   check-in >3d → find hotel address → send → tag → Pending
                   check-in ≤3d → tag call_hotel
```
23 terminal outcomes; every one is a distinct chip in the results table.

## New files
- `services/batchTriageService.js` — job runner, state machine, dry-run effects factory
- `services/triageAiService.js` — thread serializer + `classifyThread` / `assessCustomerThread`
- `services/noteDetectionService.js` — two-tier note detection

## Modified
- `services/freshdeskService.js` — `getTicketTags`, `addTags` (**merging**), `searchTicketsStrict` (**throws**);
  `searchDuplicates` is now a swallow-wrapper over the strict one, contract unchanged
- `services/aiService.js` — `groqJson()`: one JSON caller with a concurrency gate (`GROQ_MAX_CONCURRENCY`,
  `GROQ_MIN_GAP_MS`) + the existing 429 backoff
- `services/ticketActionService.js` — `buildBookingTags(booking, existingTags = [])`
- `server.js` — `triageJob` + `/batch-triage/start|stop|status`, following the `pendingsJob` pattern
- Userscript → **@version 6.64** — `api.triage.*`, `⚡ Triage` toolbar button, `showBatchTriageModal`,
  `collectLowPriorityQueue` (paginates the filter view, narrows to `priority === 1`)

## Design notes
- **One code path.** `makeEffects(dryRun, step)` is the only place that branches on dry-run.
  The state machine is written once, so a dry-run genuinely exercises the live path.
  Reads stay live in dry-run — including `fetchAndCacheBooking`'s DB write, which is our own
  booking cache, not a customer-visible mutation.
- **Hotel email sends BEFORE tagging.** Tagging first would let a failed send be recorded as
  done and never retried — a silent gap on a prepaid booking. This ordering trades that for a
  possible duplicate email, which is at least visible in the FD thread.
- **`hotel_emailed` tag** makes the email branch idempotent across re-runs.
- **Session expiry aborts the whole job** rather than degrading to "no related tickets found",
  which would otherwise push every ticket into the email branch.

## Hazards fixed in existing code
1. `tagTicket` replaces ALL tags, and `buildBookingTags`'s `existing` was always `[]` because
   `parseDataRow` emits no `tags` field. Batch-tagging would have wiped every ticket's tags →
   new merging `addTags`.
2. `searchDuplicates` swallowed `FRESHDESK_SESSION_EXPIRED` into `[]` → new `searchTicketsStrict`.
3. Spotlight search is fuzzy full-text → added an `exact` post-filter requiring the ref to
   literally appear in the subject/description.
4. Flights would have fallen through classification into the hotel-email branch → third
   `unsupported_product` bucket.

## Verification done
Offline, no network (scripts in scratchpad, not committed):
- Marker detection 6/6 — a real `buildNoteHtml` note scores 7 markers; a customer email, a
  merge note, an outbound hotel email (which carries its own `Check-in:` labels) and a bare
  booking-ID mention all correctly score 0.
- Product bucketing 8/8 including `Hotel + voucherUrl → voucher` and `null → unsupported`.
- State machine 14/14 branch outcomes, **with zero writes in dry-run on every branch**;
  the same scenarios in live mode do write (`note,tags,email,update`).
- Session-expiry abort: throws on ticket 1 of 3, no emails attempted.
- `addTags` 4/4 — merges supplied tags, reads current tags when not supplied, no-ops when
  nothing is new; `tagTicket` still replaces (unchanged).

## Still to verify against the real system
Dry-run on a live LOW queue and read the table by hand — the classification accuracy check is
the whole point of the hot test and cannot be done offline. Then narrow to one ticket before
flipping to LIVE.

## Open questions
- `call_hotel` currently tags only. The removed pre-refactor code also bumped priority to High —
  reinstate?
- Customer-thread verdicts are report-only. Should `pending_supplier`/`pending_customer`
  actually set FD status to Pending?
- Live actions require `high` classification confidence. `options.actOnMediumConfidence` exists
  but is off; revisit once the dry-run accuracy is known.

---

# Mimicked composer + Translate near Send + RTF toolbar (session 17)

## Architectural shift
Replied tab buttons no longer drive FD's contenteditable. Instead they open **our own composer** in a floating modal — same flow Guided's reply pane already used, just hosted standalone. To: is set explicitly per recipient type, send goes through `/send-reply` → `freshdeskService.sendEmail` → FD's `/api/_/tickets/{id}/reply`. No Ember pill-input fight needed.

## Changes
- **`openMimickedComposer(recipientType)`** — creates a draggable floating modal (`createModal`, width 680px), reads `cached.bookingData.{booking, details, user, supplier}`, picks `toEmail` (`user.email` for customer, `supplier.email` for supplier), and mounts `showReplyComposer` into the modal body. `onSent` closes the modal.
- **Reply Customer / Reply Supplier tabs** in `.ticket-actions-list` now call `openMimickedComposer(...)`. Translate tab removed.
- **`ul.reply-bar` Reply Customer / Reply Supplier buttons** also call `openMimickedComposer(...)` (was `openComposerAndInjectTemplate`, now deleted).
- **`injectTranslateNearSend()`** — new helper that inserts `🌐 Translate` into FD's `.reply-btn-wrapper` immediately before `.reply-btn`. Click → existing `translateFdComposer()`. Wired into the 1.5s polling loop.
- **RTF toolbar in `showReplyComposer`** — new `buildRtfToolbar(editor)` returns a strip with B / I / U / • / 1. / 🔗 / ✕ buttons driven by `document.execCommand`. Appended just before the editor; the editor's top border-radius is now `0 0 6px 6px` and top border removed so the two flush.
- **Dead code removal**: `injectReplyTemplate` and `openComposerAndInjectTemplate` deleted — the FD-contenteditable injection path is gone.

Bumped `@version` 6.39 → 6.40.

## Deferred
- Agent signature pulled from FD's `/api/_/me` (or `/api/_/agents/me`) — still using hardcoded signature inside `buildReplySignature`. Endpoint discovery is a DevTools task before code.

---

# Reply wiring fixes (session 16)

## Problems addressed
1. **Customer template had no name** — `buildReplySignature` was greeting with a bare "Hello,". Now uses first name from `user.firstName || user.fullName || user.name`, capitalized: `Hello {FirstName},`. Supplier greeting restored to `Hello dear {SupplierName} team,` (supplierName stripped of trailing `(id)`).
2. **Supplier email never went anywhere** — clicking Reply Supplier opened FD's Reply composer (which auto-fills To: with the customer), and we never touched the supplier address. Now:
   - **Reply Supplier** (`ul.reply-bar` button) → clicks `[data-test-id="ticket-action-forward"]` instead of Reply, giving a clean To: input.
   - `injectReplyTemplate('supplier')` copies `cached.bookingData.supplier.email` to clipboard + toasts the address so the agent pastes with one keystroke. (FD's To: input is Ember-managed — programmatic DOM writes don't reliably trigger its internal state, so we don't try.)
   - If no supplier email is cached, the toast warns to fill To: manually.
3. **Translate not available in FD's composer** — added a third tab `Translate` to `.ticket-actions-list`, sibling to Reply Customer / Reply Supplier. Click → auto-detects target from booking cache (customer country → language), prompts to confirm, strips sign-off before sending, translates draft in-place with original preserved below a divider.

Bumped `@version` 6.38 → 6.39.

## Test
1. Reload, confirm @version 6.39.
2. On a prewarmed ticket with a booking — click 💬 **Reply Customer** in the reply bar → FD's Reply composer opens, body fills with `Hello {Name}, / I hope this email finds you well. / [your message here] / disclaimer / signature`.
3. Click 🏨 **Reply Supplier** → FD's Forward composer opens (To: empty), body fills with `Hello dear {Supplier} team,` and the booking-ref block. Toast shows the supplier email and copies it to clipboard. Cmd+V / Ctrl+V to paste into To:.
4. With FD's composer already open, click the new **Translate** tab → prompt appears with detected language → confirm → draft replaces with translation, original preserved below.

## Deferred
- Programmatic To: setting for Forward composer — Ember internals make it fragile. Clipboard-paste is the safer UX for now.
- Translate target picker UX could be a dropdown rather than `prompt()` later.

---

# Language + inline note collapse + default-collapse (session 15)

## Changes
- **`Language` field added to `parseUserHtml`** — pulled from TA's profile grid via `getValue('Language')`. Returned on the user object as `user.language`.
- **Customer Profile tab** now shows the `Language` row (Name / Email / Phone / Country / Language / Status).
- **Post Member Note** includes Language in the synthesized note.
- **Conversation collapse rewritten** — click anywhere on the header to toggle. Small `▾`/`▸` chevron prepended to the sender block shows state. Interactive children (buttons, links, inputs, FD's Edit/Delete) are excluded from the click target so they keep working.
- **Default-collapse** — all conversation wrappers are collapsed on inject *except the last two* (most recent). Computed once per inject pass via `wrappers.slice(-2)`.
- The 🌐 Translate button stays in `.ticket-actions-container` (sibling to Edit/Delete) and is excluded from the header click target.

Bumped `@version` 6.37 → 6.38.

## Deferred
- Reply wiring — flagged for next session. Topic kept open.

---

# Hotel email note off + ETA/Requests on panel + larger text (session 14)

## Changes
- **Disabled the hotel-email result note.** `sendHotelEmailConfirmed` no longer posts a synthetic note after sending — FD already records the outbound email in the conversation thread so the note was duplicative. Returns `notePosted: false`.
- **Booking panel now shows `ETA` and `Requests`** rows when present, pulled from the existing `details.arrivalTime` and `details.requests` parsed by `parseBookingHtml`. Same fields hotel-email already uses.
- **Larger panel text.** Base font 12 → 13px, table font 13px with 4/8 cell padding, action buttons 12 → 13px. Panel width 360 → 380px so the larger text breathes.

Bumped `@version` 6.36 → 6.37.

---

# Prewarm: parallel + live update + spinner (session 13)

## Problems
1. The for-loop awaited each `analyse` call sequentially — the ticket the agent was on couldn't render until all three finished, even when its response was the first to land.
2. `prewarmWindow` didn't wrap in `withPanelBusy`, so the header spinner stayed off during the whole batch.

## Fix
- Map `windowIds` to an array of async tasks, fire with `Promise.all`. Each task:
  - Checks cache (skip if hit)
  - Awaits its own `analyse` call
  - Stores result in `ticketBookingCache`
  - If the agent is currently on that ticket, calls `refreshNativeInjections()` *immediately* — the panel updates as soon as its response lands, not after the batch completes
- Whole batch wrapped in `withPanelBusy(...)` so the header spinner spins until every task settles.

Bumped `@version` 6.34 → 6.35.

---

# Open Threads: manual search bar migration (session 12)

## Change
`renderDuplicates` in the duplicate strip now appends the Guided modal's manual search bar after the auto-search results:
- Text input (`flex:1`, search any term)
- `incl. closed` checkbox (default unchecked)
- 🔍 Search button (and Enter on the input)

On search → `api.searchTickets({ query, includeClosed, freshdeskTicketId })` → results rendered via the same `buildStripDupRow` so Preview/Merge + Merge Out modals work identically to the auto-search rows.

Bumped `@version` 6.33 → 6.34.

---

# Assisted mode toggle (session 11)

## Changes
- Renamed `🚀 Prewarm` to **Assisted** — a small toggle chip in the toolbar.
  - OFF (default): white background, gray text, ⚪ icon.
  - ON: green background, white text, 🟢 icon.
- State persisted via `localStorage.ta_assisted_mode`.
- When ON, prewarm auto-fires whenever the agent navigates to a new ticket (via `checkTicketChange` SPA hook, 400ms debounce). Also fires once on cold page load (1500ms after `mountNativeInjections`).
- When OFF, no auto-fire — agent can still toggle on to prewarm on demand.
- Click handler shows a toast confirming on/off state.

## Bumped `@version` 6.32 → 6.33.

## Test
1. Reinstall, confirm @version 6.33.
2. Toolbar shows `⚪ Assisted` (off).
3. Click it → toast "Assisted mode ON", chip turns green, current ticket prewarms.
4. Navigate to another ticket → prewarm fires automatically (header spinner spins briefly, panel populates).
5. Reload the page → chip stays green, prewarms current ticket on load.
6. Click chip again → toast "OFF", chip greys out, future navigations no longer auto-fire.

---

# View Note + Quick Translate + AI reconf surfacing (session 10)

## Changes
- **👁️ View Note button** migrated from the Guided modal into the booking panel's action row (now Post Note / View Note / Hotel Email side-by-side). Opens `cached.bookingData.noteHtml` via the existing `showNoteModal`.
- **🌐 Translate button** added to `showReplyComposer`'s action area, sibling to Send / Insert / Copy. Defaults target to the customer's detected country language (when known); falls back to a prompt. Strips sign-off via the same regex used by the customer-only translate row. Replaces the draft in-place with translated text + original preserved below a divider.
- Bumped `@version` 6.30 → 6.31.

## AI reconf badge — where it surfaces
Three places, all driven by `booking.aiReconfirmation` (the raw `<a>` anchor TA returns):
1. **Booking panel** — `renderBookingPanel` table row labeled "AI Reconfirm" (line ~376). Visible whenever the field is truthy.
2. **Guided modal booking section** — same table row (line ~2726).
3. **Freshdesk note body** — `noteBuilder.js` includes it in the summary block (line ~90), so any posted note carries it.

If the row isn't showing in the panel post-deploy, the cause is server-side cache staleness (fixed in session 9 by re-parsing `data_row` on every read).

---

# Backend: re-parse cached bookings on read (session 9)

## Problem
`booking.aiReconfirmation` was being parsed correctly on fresh TA fetches but never surfaced in the panel for previously-cached bookings. The analyse + booking-by-id routes read `cached.parsed` directly from the DB, so any field added to the parser after a booking was cached never appeared.

## Fix
Three server.js routes now re-parse `cached.data_row` on every cache read instead of using `cached.parsed.booking` verbatim:

- `GET /booking/:id` (line ~165)
- `GET /guided-prewarm/analyse/:id` (line ~647)
- `GET /guided-prewarm/booking/:id` (line ~706)

Pattern:
```js
bookingData = { ...cached.parsed, booking: parseDataRow(cached.data_row) };
```

The raw `data_row` is already stored in the `booking_cache` table, so no DB migration is needed. Future parser improvements (new fields, fixes) will automatically propagate to cached bookings on next read.

`details` (booking_html, JSDOM-parsed) and `user` (user_html, JSDOM-parsed) stay cached as-is — JSDOM re-parse is heavy and those parsers haven't changed.

## Deploy
Server change only — needs a Render redeploy. Userscript unchanged.

## Verify
1. After deploy, open a prewarmed ticket with a known AI-reconfirmation booking (e.g. booking 379509 / 381286 from earlier samples).
2. Panel should now show the **AI Reconfirm** row with the badge TA gave us.
3. If TA's badge uses `fa-check`/`text-success` and FD ships Font Awesome, you'll see ✓. If `icon-clock` (TA-specific font) — blank glyph, but the title tooltip still works.

## Deferred
- Switch from pass-through anchor to structured badge if the icon glyphs render broken in practice (proposed earlier; user opted for pass-through).

---

# Booking panel: unified loading indicator (session 8)

## Why
The panel hits async in ~7 places. Most have inline button spinners (📋 Post Note, 📧 Hotel Email lookup/send, 🔍 Change booking, 🔍 Find member, 📋 Post Member Note, Reservations tab load), but two were silent:
- **Reservation row click** — fetches new booking, panel re-renders, no visual cue.
- **Find member → Select** — sync swap, but the re-render delay was uncued.

## Changes
- Added a small spinner (10px, CSS `@keyframes taSpin`) in the panel header next to `📦 Booking`. Hidden by default.
- `setPanelBusy(busy)` — increment/decrement a busy counter; spinner visible while `>0`. Multiple concurrent ops handled without flicker.
- `withPanelBusy(fn)` — wraps an async fn with `setPanelBusy(true)` / `setPanelBusy(false)` in a try/finally.
- Wrapped every async site:
  - Manual booking fetch (no-booking case)
  - Change booking fetch
  - Post Note
  - Hotel Email lookup + Send
  - Post Member Note
  - Reservations tab load
  - **Reservation row click** — also dims the clicked row + appends `⏳` to its booking ID for inline feedback
  - Find member search
- Bumped `@version` 6.29 → 6.30.

## Test
1. Reinstall, confirm @version 6.30.
2. Click any panel action — header spinner appears, disappears on completion.
3. Click a Reservations row — row dims + shows ⏳ + header spinner spins until panel re-renders with the new booking.
4. Trigger overlapping async (e.g. Find member while Reservations is still loading) — spinner stays visible until all complete.

---

# Booking panel: customer section + always-on actions (session 7)

## Changes

- **Scrapped the Tag/Call-Hotel + Voucher action variants** from the booking panel. No more conditional action labels based on product type or check-in proximity.
- **Always-visible action row** below the booking table:
  - **📋 Post Note** → `api.guided.confirm({ action: 'note_only', noteHtml })`. Posts the standard booking note.
  - **📧 Hotel Email** → `api.guided.hotelEmailLookup(...)` → opens existing `showHotelEmailConfirmModal` → on confirm, `api.guided.hotelEmailSend(...)`.
- **Customer section migrated** from the Guided modal into the booking panel:
  - Header `Member`
  - Tab bar: **Profile** / **Reservations**
  - Profile tab: action buttons (🔑 Login as User, 👤 Open Full Profile, 📋 Post Member Note) + details table (Name, Email, Phone, Country, Status)
  - Reservations tab: lazy-loads via `api.userReservations(user.id)` (cached in `userReservationsCache`), each row clickable to switch the panel's booking
  - Find member toggle: searches via `api.findUser`, top 5 results with Select buttons
- **panelUserOverride** Map tracks agent's manual member pick per ticket — overrides `bookingData.user` and `userData` fallback when set.
- **Login/profile links** auto-backfilled when `user.id` is present but `loginLink`/`profileLink` are missing (the analyse endpoint only fills them on the userData fallback path).
- Bumped `@version` 6.28 → 6.29.

## Test
1. Reinstall, confirm @version 6.29.
2. Open a prewarmed ticket with a booking — panel shows booking table + 📋 Post Note + 📧 Hotel Email side-by-side + Member section below.
3. Click 📋 Post Note → standard booking note appears on the ticket via FD.
4. Click 📧 Hotel Email → lookup runs, hotel email confirm modal opens, agent picks/confirms address → send fires.
5. In Member section, click Reservations tab → past bookings load, click one → panel re-renders with the new booking.
6. Open Find member, search by name/email → Select → panel re-renders with the picked member.
7. Open a ticket with no booking ID — panel shows the manual booking input + (if userData fallback exists) the full Member section.

## Deferred
- Tag/Call-Hotel logic remains server-side in `/guided-prewarm/confirm` if `action: 'call_hotel'` is passed, but nothing in the panel hits it anymore. Future: scrub backend too if confirmed unused elsewhere.
- Reservations switch loses any agent-typed state in the Change booking input.

---

# Migration: booking panel + reply template + Insert (session 6)

## Changes

- **Booking panel parity with Guided** — `renderBookingPanel` rewritten to mirror the Guided modal's `renderBookingSection`:
  - No-booking case: red warning + manual booking ID input + member fallback section
  - With booking: action label inferred from product type + check-in proximity (`📋 Post Note` / `📞 Tag Call Hotel + High` / `🏷️ Tag Voucher & Move On`)
  - Full row table: Booking ID, Supplier Ref, Type, Supplier, Hotel/Airline, Guest, Check-In/Out, Days until, Room Type, AI Reconfirm
  - "Change booking" toggle row (Enter to fetch via `/guided-prewarm/booking/:id`)
  - Member section (name / email / country)
  - Confirm button at the bottom — calls existing `api.guided.confirm({ ticketId, bookingId, action, noteHtml })` with confirmation prompt
- **Reply template updated** — `buildReplySignature` rewritten to match the agreed format:
  - Greeting: `Hello,` (no name)
  - Opener: `I hope this email finds you well.`
  - Body placeholder: `[your message here]` (with supplier-only booking reference block above it)
  - Customer-only disclaimer block (`-- This email is written in English by default...`)
  - Standard signature
- **↘️ Insert into FD composer** — new button added to `showReplyComposer` (Guided's reply pane), sibling to Send + Copy. Takes the current draft HTML, opens FD's composer if closed (clicks `[data-test-id="ticket-action-reply"]`, polls up to 3s), writes the draft into `.fr-element.fr-view[contenteditable="true"]`, dispatches `input` + `change` for Froala/Ember.

Template change propagates automatically to all entry points (reply-bar buttons, composer toolbar tabs, Guided reply pane) — all routes go through `buildReplySignature`.

## Test
1. Reinstall, confirm @version 6.28.
2. Open a prewarmed ticket — panel shows full Guided-style booking table with action label and Change booking toggle.
3. Click "🔍 Change booking" → input appears → enter a different booking ID → Enter → panel re-renders + dup cache invalidated.
4. Click the action label button at the bottom → confirms → calls `/guided-prewarm/confirm` → toast.
5. Open the Guided modal as before. Click into the reply composer pane. Body now uses the new template (`Hello,` / `I hope this email finds you well.` / disclaimer).
6. In the Guided reply pane, click **↘️ Insert into FD** → FD's composer opens (if closed), body fills with the draft HTML.
7. Click the new Reply Customer / Supplier tabs in FD's composer toolbar → template inserts with the new format.

## Deferred
- Booking panel does not host its own reply composer; per user, reply composer stays in Guided modal.
- Action button does not refresh the panel state after confirm (single-shot; ticket usually moves to another state via FD anyway).

---

# Polish: Guided-parity dup strip + prewarm fallback (session 5)

## Changes

- **Prewarm fallback** — if no filter ID was ever captured, or the current ticket is not in the cached queue, fall back to prewarming just the current ticket. No more bail-out toast.
- **Duplicate strip → Guided modal parity** — rewrite the strip's render path:
  - Header: `⚠️ N open thread(s) found` (or `✓ No open threads found.`)
  - Each row: ticket link, subject, status badge (Open/Pending/Resolved/Closed), priority badge (Low/Medium/High/Urgent), assignee name, matched-by tag, **Preview / Merge** button, **📤 Merge out** button — identical visual to the Guided modal's `buildDupRow`.
  - **Preview / Merge modal** — opens duplicate's messages, each with a `📥 Merge into #{current}` button. Confirm posts a note + closes duplicate. `api.guided.ticket(dupId)` + `api.mergeTicket(...)`.
  - **Merge out modal** — selectable list of current ticket's messages, contenteditable editor, `📤 Merge out → #{dup}` button. Confirm posts a note on duplicate + closes current. Same backend as Guided.
- **Wider strip** — padding 12/16px, 100% width, box-sizing border-box. No more inline `🔍 Duplicates:` prefix — header lives in the rendered content.

## Helpers added
- `buildStripDupRow(dup, currentTicketId)`
- `showStripDupPreviewModal(dup, currentTicketId, triggerBtn)`
- `showStripDupMergeOutModal(dup, currentTicketId, triggerBtn)`

Helpers are self-contained (no reliance on Guided modal's enclosing state) — agent map is fetched via `api.guided.ticket(...)` inside each modal.

## Test
1. Reinstall, confirm @version 6.27.
2. Open a ticket directly (no filter view) — press 🚀 Prewarm — should work (single-ticket fallback, no warning).
3. Open a filter view → click a ticket not in the top-30 (search-deep) → 🚀 Prewarm — should prewarm just that ticket with an info toast.
4. On a prewarmed ticket with known duplicates — strip shows the full Guided-style row.
5. Click Preview / Merge → modal opens with duplicate's messages → click a `📥 Merge into #{current}` → confirm → toast + strip refreshes.
6. Click 📤 Merge out → modal with current ticket's messages → click a message → editor populates → confirm → toast + strip refreshes.

## Deferred
- Manual search bar (`search-tickets`) inside the strip — Guided has it; defer until needed.
- Auto-expand behaviour like Guided's `dupToggleArrow` — strip is always expanded for now.
- Pop dialog z-index / focus trap polish.

---

# Wiring TBD → real (session 4)

## Scope
Replace the `wiring TBD` placeholders with real behaviour for:
1. **Duplicate search strip** — auto-fires after prewarm, renders clickable ticket links.
2. **Reply Customer / Reply Supplier** — injects templated body into FD's contenteditable composer. Two injection points:
   - Existing `ul.reply-bar` buttons (closed-composer state) — open FD's Reply first, then inject.
   - New tabs in `.ticket-actions-list` (open-composer toolbar, sibling to Reply / Note / Forward) — inject directly.

## Backend
Unchanged. Reuses `/check-duplicates` and the existing `buildReplySignature(...)` userscript helper.

## Userscript changes
- `ticketDuplicatesCache` — `Map<ticketId, duplicates[] | 'loading'>`.
- `refreshDuplicateStrip` now reads from booking cache, calls `kickDuplicateSearch` if uncached.
- `kickDuplicateSearch` fires `/check-duplicates`, caches result, re-renders if user still on the ticket, and adds duplicate IDs to `duplicateTicketIds` so left-rail badges light up.
- `renderDuplicates` formats results as inline clickable links with matched-by tags.
- `injectReplyComposerTabs` — adds `.ta-reply-customer-tab` and `.ta-reply-supplier-tab` siblings to FD's Reply/Note/Forward buttons inside `.ticket-actions-list`.
- `injectReplyTemplate(recipientType)` — finds `.fr-element.fr-view[contenteditable="true"]`, generates plaintext via `buildReplySignature`, converts to paragraphed HTML, writes via `innerHTML`, dispatches `input` + `change` events for Froala/Ember.
- `openComposerAndInjectTemplate(recipientType)` — wrapper used by `ul.reply-bar` buttons: clicks FD's native Reply if composer is closed, polls up to 3s for the contenteditable, then calls `injectReplyTemplate`.
- Old reply-bar handlers rewired to `openComposerAndInjectTemplate` (no more TBD toast).
- Bumped `@version` 6.25 → 6.26.

## Test
1. Reinstall, confirm @version 6.26.
2. Open a prewarmed ticket — strip changes from "ready for ..." to "searching..." to either "no duplicates found" or "N open thread(s): #X subject (matched by ...) · ..."
3. Click a duplicate link → opens in new tab.
4. On the same ticket, left-rail ticket list shows ⚠️ Duplicate badges next to the matched IDs.
5. Click 💬 Reply Customer in `ul.reply-bar` (composer closed) — composer opens, body fills with greeting + signature.
6. Click ✉️ Reply Customer tab inside the composer — body replaced with the template.
7. Click ✉️ Reply Supplier — body includes a "This is in reference to {supplierId}, {hotel}, {guest}, {dates}" block above the body placeholder.
8. Navigate to next prewarmed ticket — strip + composer tabs re-mount within ~1.5s.

## Deferred
- Setting To: programmatically for supplier replies (agent still picks Forward and sets it manually).
- Hotel Email button injection (separate flow with lookup + agent confirmation).
- Translate auto-detection (highlight language tag inline).
- Replacing the Guided modal's reply composer pane with native injection.

---

# Per-conversation controls (session 3)

## Scope
Add a **collapse toggle** and a **Translate** button to each conversation/note's existing `.ticket-actions-container` (sibling to FD's Edit/Delete). Read-only on FD's DOM; no behavioural changes to FD itself.

## Userscript changes
- `injectConversationControls()` — iterates every `[data-test-id="conversation-wrapper"]`, finds the header's `.ticket-actions-container`, and prepends two buttons. Marks each wrapper with `data-ta-controls-injected="1"` to dedupe.
- **Collapse**: toggles `display:none` on the wrapper's `[data-test-id="conversation-content-wrapper"]`. Icon flips between `▼` and `▶`.
- **Translate**: reads the inner `[data-test-conversation="conversation-text"]` (or `.ticket_note`) innerText, POSTs to `/translate` (returns `{ text }`), replaces innerHTML in-place. Second click reverts; third re-applies the cached translation (no re-fetch).
- Hooked into the existing 1.5s polling loop in `mountNativeInjections()` — handles FD's re-renders.
- Bumped `@version` 6.24 → 6.25.

## Test
1. Reinstall, confirm @version 6.25.
2. Open a ticket — every conversation header shows `🌐` and `▼` before its Edit/Delete.
3. Click `▼` on a note → content hides, icon becomes `▶`. Click again → restores.
4. Click `🌐` on a foreign-language reply → spinner `…` → translated text replaces inline, icon becomes `↩`. Click `↩` → original restored. Click `🌐` again → instant flip (cached).
5. Navigate to another ticket and back — controls re-mount within 1.5s.

## Deferred
- Bulk "Collapse all notes" / "Translate all" controls.
- Persisting collapse state per-ticket across SPA nav (currently resets on re-mount).
- Per-post Translate that detects source language and shows the detected lang inline.

---

# Native FD injections (session 2)

## Scope this session

- Wire `ticketBookingCache` into a visible **booking panel** — floating, draggable, collapsible, pinned top-right.
- Inject **Reply Customer** / **Reply Supplier** buttons into Freshdesk's `<ul class="reply-bar">` as new `<li>` items, sibling to Reply/Note/Forward. Click handlers log + toast; actual reply wiring deferred.
- Inject a **duplicate search strip** as a banner just above `.reply-bar-wrapper`. Content reads from the cache; actual cross-ticket duplicate search deferred.

All three injections live in the userscript. No backend changes.

## Userscript changes

- `BOOKING_PANEL_ID` / `REPLY_CUSTOMER_LI_ID` / `REPLY_SUPPLIER_LI_ID` / `DUP_STRIP_ID` — namespaced element IDs.
- `injectBookingPanel()` — creates the fixed panel once, attaches `makeDraggable` to the header, wires the collapse toggle.
- `renderBookingPanel()` — reads `getFreshdeskTicketId()` + `ticketBookingCache.get(...)`, renders a compact details table (or "not prewarmed" / "no booking" / member fallback states).
- `injectReplyBarButtons()` — finds `ul.reply-bar`, appends two `<li>` items reusing FD's `nucleus-button` classes for visual consistency.
- `injectDuplicateStrip()` + `refreshDuplicateStrip()` — banner inserted before `.reply-bar-wrapper`, content reads from cache.
- `refreshNativeInjections()` — re-renders panel + dup strip. Called from `checkTicketChange` and at the end of `prewarmWindow()`.
- `mountNativeInjections()` — polls every 1.5s to re-inject the FD-nested pieces (panel is one-shot since it's on `document.body`). Content refresh stays out of the polling loop to avoid flicker.
- Bumped `@version` 6.23 → 6.24.

## How to test

1. Reinstall userscript, confirm @version 6.24.
2. Open any Freshdesk ticket — booking panel appears top-right with "Not prewarmed for ticket #..." message.
3. Visit a filter view, open a ticket, press 🚀 Prewarm. Panel populates with booking data; the dup strip above the reply bar shows "ready for {bookingId}".
4. Click "💬 Reply Customer" or "🏨 Reply Supplier" in the reply bar — toast appears, console logs ticket ID.
5. Navigate to next ticket in the queue (one that was prewarmed). Panel + dup strip update within ~200ms (via SPA nav hook).
6. Navigate to a non-prewarmed ticket. Panel shows "Not prewarmed" message; dup strip shows "not prewarmed".
7. Click the `−` toggle on the panel — body collapses to header only.
8. Drag the header — panel moves with cursor.

## What's deferred

- Actual reply-customer / reply-supplier behavior (opening FD composer, inserting templated reply).
- Actual duplicate cross-ticket search (the `/check-duplicates` backend already exists; wiring left for next session).
- Hotel email button injection in reply bar.
- Per-conversation Translate buttons.
- Retiring the legacy Guided modal + `/prewarm/start` batch.

---

# Prewarm rebuild

## Behavior

- Agent presses Guided button on a ticket page.
- Userscript reads filter ID from page URL and current ticket ID.
- Userscript fetches `GET /api/_/tickets?filter={id}&per_page=30&include=requester,stats` from Freshdesk same-origin. Caches ordered queue in memory keyed by filter ID.
- Locates current ticket in the queue, identifies window `[i, i+1, i+2]`.
- For each ticket in window:
  - If in session cache (keyed by ticket ID), skip.
  - Else: fetch ticket detail from Freshdesk same-origin to get `description`. Send `{ ticketId, description }` to backend.
- Backend extracts booking ID via Groq, checks DB booking cache, fetches TA + member if needed, returns `{ bookingId, bookingData, userData } | { bookingId: null }`.
- Userscript stores result in session cache by ticket ID. Renders current ticket's booking immediately; next two sit in cache for instant load when agent navigates.

## Scope this session (POC)

Confirmed with user:
- Render target: **console only** — verify the cache works, no UI yet
- Legacy code: **leave alone** — old Guided modal and `/prewarm/start` batch stay
- Trigger: **new dedicated button** in the toolbar, sibling to Guided

Backend: **no changes** — reuse existing `GET /guided-prewarm/analyse/:id` for per-ticket extraction + TA fetch + cache.

## Userscript changes

- `fdGet(path)` — same-origin `fetch` to `/api/_/...`, returns parsed JSON
- `viewQueueCache` — `Map<filterId, ticketId[]>`
- `ticketBookingCache` — `Map<ticketId, AnalyseResult | null>`
- `lastFilterId` — module state, updated on URL change when matching `/a/tickets/filters/{id}`
- `prewarmWindow()` — reads current ticket ID + last filter ID, fetches queue if not cached, computes `[i, i+1, i+2]`, calls `api.guided.analyse` for any uncached ticket, stores result, logs each step to console
- New toolbar button "🚀 Prewarm" sibling to `taGuidedBtn`
- Bump `@version`

## Checklist

- [x] Read current `prewarmService.js`, prewarm routes, and userscript prewarm UI
- [x] Confirm scope with user (POC, console-only, dedicated button, no legacy churn)
- [x] Userscript: add `fdGet` helper
- [x] Userscript: add `viewQueueCache` + `ticketBookingCache`
- [x] Userscript: capture filter ID on URL change (via `checkTicketChange`)
- [x] Userscript: implement `prewarmWindow()`
- [x] Userscript: add toolbar button `taPrewarmBtn`
- [x] Userscript: bump `@version` 6.22 → 6.23

## Review

**What landed**
- New helper `fdGet(path)` — same-origin `fetch` to Freshdesk's `/api/_/` from inside the FD page; relies on the browser's existing session cookie.
- Two in-memory Maps: `viewQueueCache` (filter ID → ordered ticket IDs) and `ticketBookingCache` (ticket ID → analyse result or null).
- `_lastFilterId` module state seeded on script load, updated by the existing `checkTicketChange` SPA hook whenever the agent visits a `/a/tickets/filters/{id}` URL.
- `prewarmWindow()` — reads current ticket ID + last filter ID, fetches the FD queue (caching by filter), locates the current ticket, computes the `[i, i+1, i+2]` window, and calls `api.guided.analyse` for any uncached ticket. Everything else (Groq + TA + DB cache) reuses the existing `/guided-prewarm/analyse/:id` route. No backend changes.
- New toolbar button `🚀 Prewarm` (id `taPrewarmBtn`) next to Guided.

**How to test**
1. Reinstall the userscript (auto-update or manual). Confirm @version reads 6.23.
2. In Freshdesk, visit a custom filter view: `/a/tickets/filters/{id}`. This seeds `_lastFilterId`.
3. Click a ticket in that view to land on its page.
4. Click the new `🚀 Prewarm` button.
5. Open DevTools → Console — should see:
   - `[prewarm] start — ticket=X filter=Y`
   - `[prewarm] queue fetched — N tickets`
   - `[prewarm] window: [a, b, c]`
   - One `[prewarm] {tid} — cached ...` line per ticket (or `cache hit, skip` on repeat)
6. Click Prewarm again on the same ticket — all three should be cache hits, no network.
7. Navigate to ticket `b` (next in queue), click Prewarm — `a`/`b` already cached, `c` re-confirmed cached, `d` is the only new fetch.

**What's not done (out of scope this session)**
- Rendering the prewarmed data anywhere visible (still console-only).
- Auto-fire on ticket page load (still button-triggered).
- Retiring the legacy `/prewarm/start` batch + Guided modal.
- Native FD UI injection (booking panel, duplicate search, reply composer buttons, per-post translate).

**Known limits**
- `_lastFilterId` is only captured when the agent visits a filter view URL. If they land directly on a ticket without visiting a view first, the button shows a "Visit a filter view first" toast.
- Queue is fetched once per filter and cached for the session. New tickets entering the queue won't appear until the agent re-clicks Prewarm after a fresh filter-view navigation (which invalidates via the SPA hook re-firing — actually no, it doesn't invalidate; we may want a manual refresh or staleness timer later).

## Review

_To be filled in after implementation._

---

# Session 22 — Zoho Desk overlay (replaces the blocked widget)

Full plan: `~/.claude/plans/tranquil-riding-pumpkin.md`.

Scope this release: widget parity + duplicates + reply composer. Freshdesk code
untouched (full deprecation is a separate refactor). Writes must be attributed to
the **acting agent**, which forces the in-page same-origin path over backend OAuth.

## Phase 0 — live endpoint capture (blocks everything else)
- [x] Arm fetch/XHR capture harness on a test ticket (v1 lost to a page reload;
      v2 persists captures to `sessionStorage`)
- [x] Capture internal-comment POST → **resolved differently and better**: rather
      than hardcoding a token source, the overlay observes `X-ZCSRF-TOKEN` off
      Desk's own writes at `document-start` and reuses it. Verified live: probe
      write returned `404 URL_NOT_FOUND`, not `401` — auth passes.
- [ ] ~~Capture Reply send~~ → deferred; `sendReply` shape taken from public REST v1
      docs, verify at test time
- [ ] ~~Capture merge~~ → **deferred: no disposable tickets available 2026-09-13.**
      Duplicate strip ships with preview + link-out, no merge button, until two
      scratch tickets can be merged with the harness armed
- [x] Write findings to `tasks/zoho-endpoints.md`

## Phase 1 — widget parity
- [ ] `frontend/MWR Zoho Tools.user.js` skeleton (@match desk.zoho.com/agent/*)
- [ ] Secret prompt + `GM_setValue` storage (repo is public — nothing hardcoded)
- [ ] `zdGet`/`zdPost` (same-origin, `orgId: 914515468`, CSRF on writes)
- [ ] `api` object over `GM_xmlhttpRequest` to the Render backend
- [ ] SPA nav hook + `getZohoTicketId()`
- [ ] Booking flow: ticket fetch -> `/zoho/extract` -> `/guided-prewarm/booking/:id`
- [ ] `renderBookingPanel` (port from `TA_Zoho_beta/app/widget.js`)
- [ ] Post Note via `POST /tickets/{id}/comments` (agent-attributed)
- [ ] View Note modal + Change Booking
- [ ] Member section: Profile / Reservations / Find Member / Post Member Note

## Phase 1b — ticket ↔ booking link (DB)
- [x] `ticket_bookings` table in `services/dbService.js` — `ticket_id` PK,
      `booking_id` + index (one booking → many tickets), plus `ticket_number`,
      `subject`, `status`, `linked_by`, `source` ('auto' | 'manual')
- [x] `linkTicketBooking` / `getTicketBooking` / `getTicketsForBooking` /
      `unlinkTicket`
- [x] Routes: `POST /zoho/ticket-booking`, `GET /zoho/ticket-booking/:ticketId`,
      `GET /zoho/booking-tickets/:bookingId?exclude=`, `DELETE /zoho/ticket-booking/:ticketId`
- [x] Overlay records the link on every booking establish (auto extraction,
      Change Booking, reservation click) and renders an "N other tickets on this
      booking" block in the panel
- [ ] **UNVERIFIED — no DB access locally** (no `.env`, no local Postgres, no
      docker perms). The SQL has never been executed. Confirm on first deploy:
      `initDb` should create the table, then link two tickets to one booking and
      check `GET /zoho/booking-tickets/:id` returns the sibling.

## Phase 2 — duplicate search
- [x] Merged search: `ticket_bookings` (exact, seen tickets only) UNION Zoho
      `/search` by booking ID + supplier ref + member email. Neither source is
      sufficient alone — unviewed duplicates are absent from the DB.
- [x] Containment verification against subject/description/lastThread — Zoho
      search is fuzzy (a short numeric returned 20 noise rows)
- [x] Dedupe by ticket id, union `matchedBy` badges per row
- [x] Client-side open/closed filter (`statusType` is rejected as a query param)
      + "incl. closed" toggle showing the hidden count
- [x] Manual search box (unverified — the agent typed it deliberately) + refresh
- [x] Own card in the rail, independent of the booking card — duplicate search
      runs on EVERY ticket, including those with no booking reference and even
      with no backend key (the Zoho search half is same-origin)
- [x] Searches the ticket's own contact email as well as booking ID / supplier
      ref / member email; duplicate terms are de-duped so the same address is
      not searched twice
- [x] Rows show the **matched value** (`🔗 412468 · GO31086415…`), not a generic
      label — matching the Freshdesk strip — plus status/priority/assignee chips
      and a "searched: …" line naming which references were used
- [ ] Move to a strip above the reply bar (needs the composer anchor, Phase 0)
- [x] Preview + Merge in / Merge out — ported from the Freshdesk modals. Merge
      needs NO Zoho merge endpoint: Freshdesk's own merge was a note on the
      survivor + a pointer note + closing the other, which is reproducible with
      comments + a status PATCH
- [x] `fetchTicketMessages` merges Zoho's split threads/comments collections into
      one chronological list, so both modals get the Freshdesk shape
- [x] **Merge verified end-to-end on production 2026-09-13.** A real merge-in
      posted the note and closed the source: #577860 → `status:'Closed'`,
      `closedTime:'2026-09-13T06:45:04Z'`. `PATCH {status:'Closed'}` is correct.
- [ ] Port `renderDuplicates` / `buildStripDupRow`, remap FD int codes -> Zoho strings
- [ ] Preview modal; Merge + Merge-out

## Phase 2b — supplier (hotel) email
- [x] `POST /zoho/hotel-email/lookup` — Groq address lookup + body preview, no
      tagging, no sending (the Freshdesk twin tags via Freshdesk and sends itself)
- [x] `buildHotelEmailHtml` takes an `agentName` (defaults to 'Ivan K.', so the
      Freshdesk path is byte-identical) — used in greeting AND signature
- [x] Agent name stored per-agent in `GM_setValue`; Desk exposes no current-agent
      endpoint (`/agents/me` 404s, `/myPreferences` carries no identity)
- [x] `✉ Supplier` button on hotel/getaway bookings; confirm modal with editable
      To / Subject / body, "signing as … change", confirm-before-send
- [x] Send via `POST /tickets/{id}/sendReply` from the agent's session; `from`
      taken from the ticket's own latest outbound thread
- [ ] **Never sent a real email through this path** — verify on a test ticket
- [ ] Non-hotel suppliers: the body says "dear hotel team", so the button is
      hidden for flights. Needs a generic template if flight suppliers are wanted

## Phase 3 — reply composer
- [ ] Reply Customer / Reply Supplier buttons on captured anchors
- [ ] Port `showReplyComposer` + `buildReplySignature` + attachments
- [ ] Send via `POST /tickets/{id}/sendReply`
- [ ] Real agent signature from `GET /agents` (retires hardcoded "Ivan K.")

## Review

_To be filled in after implementation._
