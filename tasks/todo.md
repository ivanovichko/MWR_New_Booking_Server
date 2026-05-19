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
