# 1. Plan Mode Default
Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
If something goes sideways, STOP and re-plan immediately
Use plan mode for verification steps, not just building
Write detailed specs upfront to reduce ambiguity
3. Subagent Strategy
Use subagents liberally to keep main context window clean
Offload research, exploration, and parallel analysis to subagents
For complex problems, throw more compute at it via subagents
One task per subagent for focused execution
3. Self-Improvement Loop
After ANY correction from the user: update tasks/lessons.md with the pattern
Write rules for yourself that prevent the same mistake
Ruthlessly iterate on these lessons until mistake rate drops
Review lessons at session start for relevant project
4. Verification Before Done
Never mark a task complete without proving it works
Diff behavior between main and your changes when relevant
Ask yourself: “Would a staff engineer approve this?”
Run tests, check logs, demonstrate correctness
5. Demand Elegance (Balanced)
For non-trivial changes: pause and ask “is there a more elegant way?”
If a fix feels hacky: “Knowing everything I know now, implement the elegant solution”
Skip this for simple, obvious fixes — don’t over-engineer
Challenge your own work before presenting it
6. Autonomous Bug Fixing
When given a bug report: just fix it. Don’t ask for hand-holding
Point at logs, errors, failing tests — then resolve them
Zero context switching required from the user
Go fix failing CI tests without being told how
Task Management
Plan First: Write plan to tasks/todo.md with checkable items
Verify Plan: Check in before starting implementation
Track Progress: Mark items complete as you go
Explain Changes: High-level summary at each step
Document Results: Add review section to tasks/todo.md
Capture Lessons: Update tasks/lessons.md after corrections
Core Principles
KISS: Keep changes as simple as possible. Impact minimal code.
No Lazyness: Find root causes. No temporary fixes. Senior developer standards.
Minimal Impact: Only touch what’s necessary. No side effects with new bugs.

Overlay labels on the right side:
Workflow
Tasks
Principles

## Overview

A **Node.js/Express backend** paired with a **Tampermonkey overlay** that injects
TA booking tools into Zoho Desk. Agents working a Zoho Desk ticket get a booking
panel, member lookup, duplicate detection, internal notes, supplier email and
chat translation — all inside the Desk page.

The backend is deployed on Render (`mwr-new-booking-server.onrender.com`). The
frontend is a single userscript (`frontend/MWR Zoho Tools.user.js`) installed in
the agent's browser.

A second client exists and is **kept working**: the Zoho Desk extension in
`TA_Zoho_beta/`. It is dormant — the marketplace / Developer Space install was
never approved — but it is the shape MWR would license if they buy the app, so
its backend half (`/zoho/*`, org-level OAuth) stays live. Do not delete it for
having no daily caller.

**Freshdesk was retired in session 22 (2026-09-15).** The Freshdesk userscript,
its eight backend services and ~29 routes are gone. Look in git history before
re-implementing anything that sounds familiar.

## Running the server

```bash
npm install          # first time
npm run dev          # nodemon with auto-reload
npm start            # production (node server.js)
```

Requires a `.env` (not committed):

- `DATABASE_URL` — PostgreSQL connection string (Neon)
- `ZOHO_BACKEND_SHARED_SECRET` — bearer token guarding every `/api/*` and
  `/zoho/*` route. Agents paste the same value into the userscript once (⚙ in
  the panel header); the extension gets it from Zoho's request proxy.
- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_ORG_ID` — extension only, for
  the org-level OAuth write path. Org is `914515468` ("MWR LIFE") on `.com`.
- `AI_ENABLED` — `true` restores the deprecated AI routes. Absent/anything else
  = off, which is the current state.
- `GROQ_API_KEY` — booking-reference extraction and the translation fallback.
  Unused while AI is off; leave it set so the flag stays flippable.
- `GROQ_API_URL` — optional; point at `tools/groq-proxy-worker.js` when Groq
  blocks Render's egress IP with a 403
- `TA_BASE_URL` — defaults to `https://www.traveladvantage.com`

## Architecture

### Two clients, three call paths

**The overlay** runs *inside* the Desk page, which gives it two ways out:

1. **`zdGet` / `zdPost`** — same-origin to Zoho Desk's own API
   (`/supportapi/zd/mwrlife/api/v1`, cookie auth + org header). Every **write**
   goes this way, so notes, replies and status changes are authored by the agent
   who clicked. See `tasks/zoho-endpoints.md`.
2. **`api.*`** — `GM_xmlhttpRequest` to the Render backend. Desk's CSP blocks
   page-origin XHR to external domains, so this cannot be a plain `fetch`.

**The extension** runs in a Zoho-hosted widget sandbox and has neither:

3. **`ZOHODESK.request`** — Zoho's server-side request proxy. It substitutes the
   literal `{{backend_shared_secret}}` placeholder into the Authorization
   header, so the secret never reaches browser JS, and because it runs
   server-side, CORS never applies. Its writes go through the backend's
   org-level OAuth token (`/zoho/post-note`), not the acting agent's session —
   that limitation is precisely why the overlay was built.

Because the proxy handles the cross-origin problem, the backend needs **no CORS
middleware at all**. An earlier `allowZohoWidgetOrigin` mount existed only for a
plain-`fetch` booking lookup that has since moved behind the guard.

### The backend is small on purpose

Two guarded namespaces, one secret. `/api/*` is the overlay's, `/zoho/*` is the
extension's, and each is guarded by an `app.use` middleware rather than a
per-route call — so a new route cannot be added unguarded by accident. Nothing
outside `/health`, `/auth` and `POST /ta-session` is reachable without the
bearer token.

**Unguarded** — `GET /health` (liveness) and `GET /auth` + `POST /ta-session`
(the page where agents paste their TA cookie; it has no secret to send, so this
is the last open door — backlog §2).

**Shared** — mounted under both prefixes from one handler each:

| Route | Purpose |
|---|---|
| `GET …/booking/:id` | booking lookup — DB cache first, live TA fetch on a miss |
| `POST …/find-user`, `GET …/user/:id`, `GET …/user/:id/reservations` | TA member search, profile, reservation history |
| `POST …/extract` | **deprecated** — Groq booking-reference extraction; 410 while AI is off |
| `POST …/translate` | **deprecated** — Google first, Groq fallback; 410 while AI is off |

**Overlay only** — `POST /api/ticket-booking`, `GET /api/ticket-booking/:ticketId`,
`GET /api/booking-tickets/:bookingId`, `DELETE /api/ticket-booking/:ticketId`.
The last two have no caller yet; kept as the read/delete half of a table the
overlay actively writes.

**Extension only** — `POST /zoho/oauth-session` (one-time grant→refresh_token
exchange), `GET /zoho/config` (diagnostic, returns no secrets), `GET /zoho/orgs`
(proves the stored session reaches Desk), `POST /zoho/post-note`,
`POST /zoho/member-note`. These write through the org-level OAuth token, which
is why they have no `/api` twin.

### AI is deprecated and disconnected

Zoho Desk ships AI out of the box, so as of **2026-09-15** the Groq-backed
booking-reference extraction and the Google/Groq translation are switched off.
**Disconnected, not removed** — every implementation is intact and still
imported. One flag on each side:

- `server.js` → `const AI_ENABLED = process.env.AI_ENABLED === 'true'` (false by
  default; set `AI_ENABLED=true` on Render to restore without a code change).
  While off, `…/extract` and `…/translate` answer **410** with
  `code: "AI_DISABLED"` — 410 rather than 404 so a caller can tell "switched
  off" from "wrong URL".
- `frontend/MWR Zoho Tools.user.js` → `const AI_ENABLED = false`. While off the
  🌐 per-message buttons are not injected and extraction is skipped.

**Turn both on together.** The server flag alone leaves the overlay silent; the
overlay flag alone gets 410s.

Consequence for the panel: with extraction off it resolves a booking from the
`ticket_bookings` link table instead (`GET /api/ticket-booking/:ticketId` — this
is what finally gave that route a caller). A ticket with no link yet waits for
the agent to pick one via **Change Booking**, which writes the link so the next
visit resolves instantly.

Consequence for the extension: its flow begins with `/zoho/extract`, so while AI
is off the widget shows the 410 message and goes no further. It is dormant
anyway; re-enabling AI restores it.

`GROQ_API_KEY` and `GROQ_API_URL` are unused while AI is off. Leave them set —
they cost nothing and the flag is meant to be flippable.

### Services

| File | Responsibility |
|---|---|
| `services/parserService.js` | Parses the TA booking list `dataRow` (DataTables format) into a `booking`; parses booking detail HTML into `cleanHtml` + `details`; extracts the Zeal AI-reconfirmation status from `row[0]` |
| `services/userService.js` | Parses the TA member profile HTML into a `user`; `findUser` for member search |
| `services/bookingService.js` | `fetchAndCacheBooking` (TA fetch + DB cache) and `extractBookingId` (Groq, **deprecated**). Helpdesk-agnostic — its only inputs are text and a reference. Was `prewarmService.js` |
| `services/noteBuilder.js` | Builds the styled HTML for an internal note from booking + details + user + supplier |
| `services/supplierService.js` | Static map of supplier names → contact email / URL / notes |
| `services/translateService.js` | **Deprecated, still complete.** Google's free endpoint first, Groq as fallback. Google quotas per client IP and Render's egress IP is shared, so the fallback is the normal path, not an error path |
| `services/taAuthService.js` | TravelAdvantage cookie auth; `taGet`/`taPost` attach the stored session cookie and log a redacted request summary |
| `services/dbService.js` | PostgreSQL via `pg` — TA session, Zoho OAuth session, booking cache, ticket ↔ booking links |
| `services/zohoDeskService.js` | Extension only. Self-client grant exchange, self-refreshing access token, `listOrganizations`, `postComment` |
| `services/zohoTicketActionService.js` | Extension only. Posts the standard booking note through the OAuth token — the counterpart of what the overlay does with `zdPost` |

### Route conventions

- Every route is wrapped in `safeRoute(handler)`. Thrown errors become a uniform
  `{ error }` JSON response, logged with a `[scope]` prefix. Throw
  `new HttpError(message, status)` for a user-visible non-500.
- Diagnostic logs use `[scope]` prefixes (`[booking]`, `[extract]`, `[link]`).
  No emoji decoration.
- **No `express.static` on the repo root.** It used to be mounted there, which
  served `server.js` and `services/*.js` publicly. `auth.html` is served by an
  explicit route.

### Key data objects

- **`booking`** — from `parseDataRow()`. IDs, pricing, product type, dates,
  guest name, status.
- **`details`** — from the TA booking detail page. Hotel name, address, room
  type, board code, special requests, estimated arrival.
- **`user`** — from the TA member profile. Name, email, phone, membership
  status, instance, country, language.
- **`supplier`** — from `SUPPLIER_MAP` by `booking.supplierName`. Contact email,
  URL, special notes.

### Ticket ↔ booking link table

`ticket_bookings` maps one ticket → at most one booking, but one booking → many
tickets. That one-to-many side is the duplicate signal: siblings of the same
`booking_id` are far more reliable than matching subject strings. The overlay
writes the link as soon as a booking is established for a ticket.

Dead tables left in the DB but no longer created by `initDb`:
`freshdesk_sessions`, `ticket_summaries`, `agent_prompts`, `agent_macros`.
Dropping them is a separate, deliberate migration.

### Session management

TravelAdvantage requires cookie-based auth. Agents paste their TA cookie at
`/auth`; it is stored in `ta_sessions` and retrieved per-request by
`taAuthService`. Valid roughly three days.

### Userscript

`frontend/MWR Zoho Tools.user.js` is a single self-contained IIFE. Bump
`@version` on every release — Tampermonkey auto-updates from the GitHub raw
`@updateURL` / `@downloadURL`.

**Injected UI:**
- **Booking panel** — floating right-rail panel. Booking table, action row
  (Post Note / View Note / Supplier Email / Rename Subject / Change Booking),
  Member section (Profile + Reservations, Find Member, Post Member Note),
  duplicates.
- **Duplicates** — merged from a Desk ticket search and the link table, with
  Preview / Merge in / Merge out modals. Desk has no merge endpoint; merge is
  reproduced as a note on the survivor + a pointer note + a status PATCH.
- **Per-conversation controls** — 🌐 Google translate and 🤖 AI translate,
  injected into each conversation header by a 1.5s polling loop (Desk re-renders
  the list on SPA nav and lazy load).
- **Supplier email** — entirely client-side; recipient from
  `bookingData.supplier`, body built in the overlay, sent via Desk's `sendReply`
  from the agent's session.

**Key helpers:**
- `THEME` — shared visual constants.
- `createModal(id, title, opts)` — draggable modal factory.
  `trapKeyEventsForModal` stops Desk hotkeys firing while typing.
- `api` — one object holding every backend call; all URL and body shapes live
  there.
- `zdRequest` / `installTokenObserver` — same-origin Desk calls; the CSRF token
  is captured by patching `fetch` and `XMLHttpRequest.setRequestHeader`.
- In-memory caches, reset on full reload: `ticketBookingCache`,
  `reservationsCache`, `duplicateCache`, `chatCache`, `fromAddressCache`.

### TA_Zoho_beta/

The Zoho Desk *extension*: `zet`-packaged, `zet validate` clean, OAuth exchanged
and org confirmed. Gitignored, so **it exists only on disk — deleting it is
unrecoverable. Do not.**

It is dormant, not dead. The marketplace / Developer Space install was never
approved, and its single org-level OAuth token cannot author writes as the
clicking agent — which is why the overlay was built and is what agents run. But
the extension is the form MWR would license if they buy the app, so its backend
half is maintained alongside the overlay's.

Its widget calls `/zoho/extract`, `/zoho/booking/:id`, `/zoho/find-user`,
`/zoho/user/:id/reservations`, `/zoho/post-note` and `/zoho/member-note` — all
through `ZOHODESK.request` with the secret placeholder, no plain `fetch`
anywhere.
