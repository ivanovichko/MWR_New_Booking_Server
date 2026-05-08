# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- `FRESHDESK_AGENT_ID` — numeric agent ID for prewarm ticket filtering
- `GROQ_API_KEY` — used by `aiService.js` and `prewarmService.js` for LLM calls
- `TA_BASE_URL` — defaults to `https://www.traveladvantage.com`
- `BACKEND_URL` — used when constructing attachment proxy URLs in notes

## Architecture

### Request flow

1. **Userscript** (`frontend/MWR Booking Tools.user.js`) detects the agent opening a Freshdesk ticket, injects a floating panel, and calls the backend via `GM_xmlhttpRequest`.
2. **Backend** (`server.js`) handles all Express routes, orchestrates service calls, and returns structured data.
3. **Userscript** renders the returned `noteHtml` or other data in its floating panel, then lets the agent confirm before posting.

### Backend services

| File | Responsibility |
|------|---------------|
| `services/parserService.js` | Parses the TA booking list `dataRow` array (DataTables format) into a structured `booking` object; also parses raw booking detail HTML into `cleanHtml` + `details` |
| `services/bookingService.js` | Fetches the TA booking detail page by ID, extracts the `bookingData` JS object injected in the HTML, returns structured hotel/guest details |
| `services/userService.js` | Parses the TA member profile HTML into a `user` object |
| `services/noteBuilder.js` | Builds the styled HTML for Freshdesk internal notes from booking + details + user + supplier data |
| `services/hotelEmailBuilder.js` | Builds the styled HTML body for outbound hotel emails |
| `services/freshdeskService.js` | Freshdesk API wrapper — post notes (`addNoteWithImages`), send emails, tag tickets, set status/priority, search duplicates, get ticket context. POSTs to `/api/_/` use `fdPost`, which attaches the stored session cookie + CSRF token |
| `services/agentService.js` | Resolves agent IDs to names. Bulk fetch via `/api/_/bootstrap/agents_groups`, per-id fallback via `/api/_/contacts/{id}`. 10-min in-memory cache; per-id cache survives across requests |
| `services/ticketService.js` | Dual-path ticket fetch: session cookie (`/api/_/tickets/{id}` + conversations) primary, API-key (`/api/v2/...`) fallback. Returns `{ ticket, conversations }` |
| `services/dbService.js` | PostgreSQL via `pg` — caches bookings, stores TA/Freshdesk sessions (cookie + CSRF), manages agent prompts and macros |
| `services/taAuthService.js` | Authenticates with TravelAdvantage (cookie-based, 2-step OTP flow); `taGet`/`taPost` helpers attach the stored session cookie and log a request/response summary (body redacted, response truncated) |
| `services/aiService.js` | Groq LLM calls for AI assist (reply drafting, translation) and hotel email lookup |
| `services/prewarmService.js` | Batch job: fetches low-priority assigned tickets, extracts booking IDs via Groq, caches booking data, posts notes, sets priorities |
| `services/supplierService.js` | Static map of supplier names → contact email / URL / notes |
| `services/ticketActionService.js` | Higher-level ticket actions that combine multiple services: `confirmTicket` orchestrates the post-note + hotel email + tagging flow |
| `config.js` | Shared constants: Freshdesk status codes, TA base URL, prewarm conversation threshold |

### Backend route conventions

- All Express routes are wrapped in `safeRoute(handler)` (defined in `server.js`). The wrapper turns thrown errors into a unified `{ error, code? }` JSON response and logs them with a `[scope]` prefix. Throw `new HttpError(message, status, code?)` for user-visible failures with a non-500 status.
- Diagnostic logs use `[scope]` prefixes (e.g. `[ta]`, `[freshdesk]`, `[agentService]`). No emoji decoration.

### Key data objects

- **`booking`** — parsed from the TA booking list row via `parseDataRow()`. Contains IDs, pricing, product type, dates, guest name, status.
- **`details`** — parsed from the TA booking detail page. Hotel name, address, room type, board code, special requests.
- **`user`** — parsed from the TA member profile page. Name, email, phone, membership status, instance.
- **`supplier`** — looked up from the static `SUPPLIER_MAP` by `booking.supplierName`. Adds contact email, URL, and any special notes to the rendered note.

### Session management

TravelAdvantage requires cookie-based auth. Agents paste their TA cookie at `/auth` (served by the backend). The cookie is stored in the `ta_sessions` DB table and retrieved per-request by `taAuthService`. Similarly, Freshdesk session cookies are stored in `freshdesk_sessions` for prewarm jobs that need to scrape TA on behalf of agents.

### Prewarm

The prewarm job (`POST /prewarm/start`) runs in-process as a background async task. It polls via `GET /prewarm/status`. Only one job runs at a time (in-memory `prewarmJob` state object). The userscript surfaces a prewarm UI for starting/stopping and showing live log output.

### Userscript

The userscript (`frontend/MWR Booking Tools.user.js`) is a single self-contained IIFE. It injects floating draggable modals into Freshdesk ticket pages. Key patterns:
- `THEME` — shared visual constants (font, colors, shadow, radius). Read by `createModal` and other helpers so a single edit propagates.
- `createModal(id, title, opts)` — standard draggable modal factory; returns `{ modal, header, body, closeBtn }`.
- `createRichEditor(opts)` — contentEditable div with optional image-paste-to-base64 handler. Used by the Note tab, supplier reply, merge-out and customer reply panes.
- `api` — single object wrapping every backend call (`api.guided.ticket(id)`, `api.postNote(...)`, etc.). All URL/body shapes live here; call sites never touch `BACKEND_URL` or `gmGet/gmPost` directly.
- `bookingCache` / `userCache` — in-memory Maps that survive panel re-opens within the same page session.
- All backend calls go through `GM_xmlhttpRequest` (not `fetch`) because Freshdesk's CSP blocks direct XHR to external domains.
- `BACKEND_URL` is hardcoded at the top of the userscript; update it when deploying to a new Render URL.
- Bump `@version` on every release — Tampermonkey uses it to trigger auto-update from the GitHub raw URLs.

The userscript auto-updates from GitHub raw URLs set in the `@updateURL` / `@downloadURL` headers.

### Attachment proxy

Freshdesk strips `data:` URLs from note bodies. `freshdeskService.addNoteWithImages()` works around this by uploading images as multipart attachments, then patching the note body to use `/attachment?url=...&ticket_id=...` proxy URLs. The backend's `/attachment` route adds the Freshdesk auth header when proxying the image fetch.
