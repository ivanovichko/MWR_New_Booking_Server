# Backlog — deferred work

Forward-looking list. `todo.md` holds the session-by-session log of what's
done; this file is what's still open.

## 1. Refactoring sweep — DONE (session 18, @version 6.53)

- [x] Killed the Guided modal — `showGuidedPrewarmModal` (~1747 lines) + the
      `🎯 Guided` / `🎯 Open Here` toolbar buttons.
- [x] Server prune — removed `/prewarm/start|stop|status` + `prewarmJob`,
      `/tag-ticket`, `/guided-prewarm/tickets` + `GUIDED_FILTERS`,
      `/update-ticket`, `/close-ticket`, all `/settings/macros` routes.
- [x] `prewarmService.js` rewritten — kept `extractBookingId`,
      `fetchAndCacheBooking`, `checkInPriority`, `checkPendings`,
      `setTicketStatus`, `extractDateFromTags`. Dropped `prewarm()` batch,
      `fetchLowPriorityTickets`, `setTicketPriority`, `postNote`,
      `extractDateFromTagsWithGroq`.
- [x] `ticketActionService.confirmTicket` — note-only now; posts via
      `freshdeskService.addNoteWithImages`. `call_hotel` + `voucher` dropped.
- [x] `dbService` — macro CRUD removed.
- [x] Userscript dead helpers removed: `attachMacroTrigger`, `substituteVars`,
      `autoTagTicket`, `parseBookingDate`, `formatMonthYear`, standalone
      `checkDuplicates`, `markDuplicate`, `gmPut`, `gmDelete`,
      `gmFreshdeskNote`, `showConfirmModal`.
- [x] Deleted orphan files: `services/server.js` (stale 497-line duplicate,
      broken require paths), `services/bookingService.js` (0 imports).
- [x] `.gitignore` — Tampermonkey cache files added.

**Deviations from plan:**
- `freshdeskService.tagTicket` **kept** — still used internally by
  `ticketActionService` (confirmTicket + lookupHotelEmail) to write the
  month/country date tags that the Pendings job reads. Only the `/tag-ticket`
  HTTP route + userscript `api.tagTicket` were removed.
- `freshdeskService.updateTicket` left in place (1 unused export, low value
  to chase).
- `agent_macros` DB table left in place — see §5.

Net: userscript 5300 → 2720 lines; `services/` lost 2 files.

## 2. Naming debt (after the sweep)

- [ ] Rename `api.guided.*` → `api.booking.*` (or similar) — "guided" is a
      dead concept once the modal is gone.
- [ ] Rename `/guided-prewarm/*` server routes — drop the `guided-prewarm`
      prefix. Coordinate with the userscript `api` object.

## 3. Reply / composer

- [ ] Agent signature from Freshdesk — `buildReplySignature` still hardcodes
      "Ivan K. / Travel Advantage Support / ...". Discover FD's `/api/_/me`
      (or `/api/_/agents/me`) endpoint, pull `signature_html`, cache per
      session. Needed before multi-agent use.
- [ ] Programmatic To: for the Forward composer — currently supplier email is
      copied to clipboard for manual paste. FD's To: input is Ember-managed;
      revisit if a reliable approach surfaces (or use a draft endpoint).
- [ ] Translate target picker — replace `prompt()` with a small dropdown of
      common languages.

## 4. Conversation controls

- [ ] Bulk "Collapse all / Expand all" notes control.
- [ ] Persist per-ticket collapse state across SPA navigation (currently
      resets to default-collapse on every re-inject).
- [ ] Per-conversation 🌐 Google translate — auto-detect source language and
      show it inline instead of always assuming English target.

## 5. Loose ends to verify

- [ ] Login as User URL — `console.log` added (6.48). Confirm the
      `webadminCustomerLogin/{id}` pattern is correct for primary members; if
      not, capture the real URL from TA.
- [ ] `refreshFreshdeskTicket` — 7-selector fallback chain (6.42). Confirm one
      actually matches current FD DOM; if the console still warns "refresh
      button not found", grab the real HTML.
- [ ] DB `macros` table — drop via migration once the macros code is removed
      (left in place during the sweep to avoid a migration mid-refactor).

## 6. Future capabilities (not committed)

- [ ] RTS real-time channel — the `rts` WebSocket config found early on
      (`rts-us-fd.freshworksapi.com`, `rts-min.js`). Could replace polling and
      give live ticket/queue updates. ~20-min reverse-engineering spike to
      map the event shapes. Bookmarked, not scheduled.
- [ ] Settings button + prompt editor — the translate-chat prompt lives in the
      DB (`/settings/prompts`) but there's no in-UI editor. Decide placement
      (gear icon in the booking panel header?) if agents need to tune prompts.
- [ ] Note edit/delete — FD owns this natively; revisit only if a need
      appears.
- [ ] `.claude/CLAUDE.md` is stale after the sweep — still documents the
      Guided modal, the prewarm batch, `bookingService.js`. Refresh the
      architecture section when convenient.
