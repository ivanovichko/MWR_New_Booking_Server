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

This is a **Node.js/Express backend** paired with a **Tampermonkey userscript** frontend for automating MWR Life travel support operations in Freshdesk. Agents working a Freshdesk ticket can trigger booking lookups, post internal notes, send hotel emails, and detect duplicate tickets — all from a floating UI injected into the Freshdesk page.

The backend is deployed on Render (`mwr-new-booking-server.onrender.com`). The frontend is a single Tampermonkey userscript (`frontend/MWR Booking Tools.user.js`) installed in the agent's browser.

## Running the server

```bash
npm install          # first time
npm run dev          # nodemon with auto-reload
npm start            # production (node server.js)
```

The server requires a `.env` file (not committed). Required variables:
- `DATABASE_URL` — PostgreSQL connection string (Neon or similar)
- `FRESHDESK_DOMAIN` — e.g. `mwrlife.freshdesk.com`
- `FRESHDESK_API_KEY` — Freshdesk API key
- `FRESHDESK_AGENT_ID` — numeric agent ID, used by the Pendings job to filter tickets
- `GROQ_API_KEY` — used by `aiService.js` and `prewarmService.js` (`extractBookingId`) for LLM calls
- `TA_BASE_URL` — defaults to `https://www.traveladvantage.com`
- `BACKEND_URL` — used when constructing attachment proxy URLs in notes

## Architecture

### Request flow

1. **Userscript** (`frontend/MWR Booking Tools.user.js`) runs inside the Freshdesk ticket page. It injects native UI directly into Freshdesk's DOM (a floating booking panel, a duplicate-search strip above the reply bar, reply tabs in the composer, per-conversation controls) and calls the backend via `GM_xmlhttpRequest`.
2. **Backend** (`server.js`) handles all Express routes, orchestrates service calls, and returns structured data.
3. **Userscript** renders the returned booking/note/duplicate data into the injected panels, then lets the agent confirm before posting.
4. For Freshdesk's own data the userscript also calls FD's internal `/api/_/` endpoints **directly** (same-origin `fetch`, no `GM_xmlhttpRequest` needed) — e.g. fetching the agent's filter queue for prewarm.

### Backend services

| File | Responsibility |
|------|---------------|
| `services/parserService.js` | Parses the TA booking list `dataRow` array (DataTables format) into a structured `booking` object; also parses raw booking detail HTML into `cleanHtml` + `details`; extracts the Zeal AI-reconfirmation status from `row[0]` |
| `services/userService.js` | Parses the TA member profile HTML into a `user` object; also `findUser` for member search |
| `services/noteBuilder.js` | Builds the styled HTML for Freshdesk internal notes from booking + details + user + supplier data |
| `services/hotelEmailBuilder.js` | Builds the styled HTML body for outbound hotel emails |
| `services/freshdeskService.js` | Freshdesk API wrapper — post notes (`addNoteWithImages`), send emails, tag tickets, set status/priority, search duplicates, get ticket context. POSTs to `/api/_/` use `fdPost`, which attaches the stored session cookie + CSRF token |
| `services/agentService.js` | Resolves agent IDs to names. Bulk fetch via `/api/_/bootstrap/agents_groups`, per-id fallback via `/api/_/contacts/{id}`. 10-min in-memory cache; per-id cache survives across requests |
| `services/ticketService.js` | Dual-path ticket fetch: session cookie (`/api/_/tickets/{id}` + conversations) primary, API-key (`/api/v2/...`) fallback. Returns `{ ticket, conversations }` |
| `services/dbService.js` | PostgreSQL via `pg` — caches bookings, stores TA/Freshdesk sessions (cookie + CSRF), manages agent prompts |
| `services/taAuthService.js` | Authenticates with TravelAdvantage (cookie-based, 2-step OTP flow); `taGet`/`taPost` helpers attach the stored session cookie and log a request/response summary (body redacted, response truncated) |
| `services/aiService.js` | Groq LLM calls for AI assist (reply drafting, summary, chat translation) and hotel email lookup |
| `services/prewarmService.js` | Per-ticket helpers — `extractBookingId` (Groq), `fetchAndCacheBooking` (TA fetch + DB cache), `checkInPriority` (date → priority). Also hosts `checkPendings`, the Pendings batch job that reopens pending tickets nearing check-in |
| `services/supplierService.js` | Static map of supplier names → contact email / URL / notes |
| `services/ticketActionService.js` | Higher-level ticket actions: `confirmTicket` posts the booking note + applies date/country tags; `lookupHotelEmail` + `sendHotelEmailConfirmed` run the two-phase hotel-email flow |
| `config.js` | Shared constants: Freshdesk status codes, TA base URL |

### Backend route conventions

- All Express routes are wrapped in `safeRoute(handler)` (defined in `server.js`). The wrapper turns thrown errors into a unified `{ error, code? }` JSON response and logs them with a `[scope]` prefix. Throw `new HttpError(message, status, code?)` for user-visible failures with a non-500 status.
- Diagnostic logs use `[scope]` prefixes (e.g. `[ta]`, `[freshdesk]`, `[agentService]`). No emoji decoration.

### Key data objects

- **`booking`** — parsed from the TA booking list row via `parseDataRow()`. Contains IDs, pricing, product type, dates, guest name, status.
- **`details`** — parsed from the TA booking detail page. Hotel name, address, room type, board code, special requests, estimated arrival time.
- **`user`** — parsed from the TA member profile page. Name, email, phone, membership status, instance, country, language.
- **`supplier`** — looked up from the static `SUPPLIER_MAP` by `booking.supplierName`. Adds contact email, URL, and any special notes to the rendered note.

### Session management

TravelAdvantage requires cookie-based auth. Agents paste their TA cookie at `/auth` (served by the backend). The cookie is stored in the `ta_sessions` DB table and retrieved per-request by `taAuthService`. Similarly, Freshdesk session cookies are stored in `freshdesk_sessions` for prewarm jobs that need to scrape TA on behalf of agents.

### Prewarm (Assisted Mode)

Prewarm is per-ticket and demand-driven — there is no batch job. Flow:

1. The agent presses the **Assisted** toggle in the toolbar (state persisted in `localStorage`). While on, every ticket navigation auto-fires a prewarm; it also fires once on cold page load.
2. `prewarmWindow()` reads the current ticket ID + the last-visited filter ID from the URL, fetches the agent's filter queue from FD's `/api/_/tickets?filter={id}` (same-origin `fdGet`), and computes a window of `[current, +1, +2]`.
3. For each ticket in the window not already cached, it calls `GET /guided-prewarm/analyse/:id` in parallel — that route fetches the ticket, runs Groq booking-ID extraction, hits the DB booking cache, and TA-fetches on a miss.
4. Results land in `ticketBookingCache` (keyed by ticket ID). Opening a prewarmed ticket renders the booking panel instantly.

If no filter is captured or the ticket isn't in the queue, it falls back to a single-ticket prewarm.

The legacy batch routes (`/prewarm/start|stop|status`) and the Guided modal were removed in the May 2026 refactor — see `tasks/backlog.md`.

### Userscript

The userscript (`frontend/MWR Booking Tools.user.js`) is a single self-contained IIFE that injects native UI into Freshdesk's own DOM. It runs *inside* the FD page, so it can call FD's internal `/api/_/` endpoints same-origin.

**Injected UI** (re-applied by a 1.5s polling loop in `mountNativeInjections` because FD re-renders its DOM on SPA navigation):
- **Booking panel** — fixed floating right-rail panel (`injectBookingPanel` / `renderBookingPanel`). Shows the booking details table, action row (Post Note / View Note / Hotel Email / Chat / AI Summary), Member section (Profile + Reservations tabs, Find Member, Post Member Note), Change Booking, and a header queue counter. Reads from `ticketBookingCache`.
- **Duplicate strip** — injected above the reply bar (`injectDuplicateStrip`). Auto-search by booking refs + member email, manual search with "incl. closed", and Preview/Merge + Merge Out modals.
- **Reply Customer / Supplier** — tabs in FD's composer toolbar (`.ticket-actions-list`) and buttons in `ul.reply-bar`. Both open a *mimicked composer* — `showReplyComposer` mounted in a floating modal with an RTF toolbar, templated body (`buildReplySignature`), translate, attachments. Send → `/send-reply` → FD's `/api/_/tickets/{id}/reply`.
- **Per-conversation controls** — collapse toggle + 🌐 Google translate + 🤖 AI translate, injected into each conversation/description header. Old notes collapse by default; last two stay open.
- **Translate near Send** — button in FD's composer footer; translates the current draft in-place.

**Key helpers / patterns:**
- `THEME` — shared visual constants (font, colors, shadow, radius).
- `createModal(id, title, opts)` — draggable modal factory; returns `{ modal, header, body, closeBtn }`. `trapKeyEventsForModal(modal)` stops FD hotkeys firing while typing in a modal.
- `createRichEditor(opts)` — contentEditable div with image-paste-to-base64; `buildRtfToolbar` adds B/I/U/list/link formatting.
- `api` — single object wrapping every backend call (`api.guided.ticket(id)`, `api.postNote(...)`, etc.). All URL/body shapes live here.
- `fdGet(path)` — same-origin `fetch` to FD's `/api/_/`. Used for the filter queue. (Backend calls still go through `GM_xmlhttpRequest` because FD's CSP blocks XHR to external domains.)
- In-memory caches (survive SPA nav, reset on full reload): `ticketBookingCache` (ticketId → analyse result), `viewQueueCache` (filterId → ordered ticket IDs), `ticketDuplicatesCache`, `userReservationsCache`, `panelUserOverride`.
- `refreshFreshdeskTicket()` — forces FD to refetch the conversation thread after a post/send (800ms delay so FD's backend has indexed the new entry; tries several toggle selectors).
- `BACKEND_URL` is hardcoded at the top; update it when deploying to a new Render URL.
- Bump `@version` on every release — Tampermonkey auto-updates from the GitHub raw `@updateURL` / `@downloadURL`.

The toolbar (`addToolbarButtons`) carries the **Assisted** toggle, **Bulk**, and **Pendings** buttons.

### Attachment proxy

Freshdesk strips `data:` URLs from note bodies. `freshdeskService.addNoteWithImages()` works around this by uploading images as multipart attachments, then patching the note body to use `/attachment?url=...&ticket_id=...` proxy URLs. The backend's `/attachment` route adds the Freshdesk auth header when proxying the image fetch.
