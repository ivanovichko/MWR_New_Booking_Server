# Backlog — deferred work

Forward-looking list. `todo.md` holds the session-by-session log of what's
done; this file is what's still open.

Everything Freshdesk-related was closed by deletion in session 22 (see
`todo.md` § Session 22). What follows is the Zoho overlay's list.

## 1. Overlay — unfinished features

- [ ] **Reply composer** (customer + supplier). The overlay has supplier email
      only. Port the Freshdesk composer's shape from git history:
      `showReplyComposer` + `buildReplySignature` + attachments, sending via
      `POST /tickets/{id}/sendReply`.
- [ ] **Real agent signature.** `getAgentName` stores a name in `GM_setValue`
      because Desk exposes no current-agent endpoint (`/agents/me` 404s,
      `/myPreferences` carries no identity). Revisit `GET /agents` with a
      filter, or accept the local value permanently.
- [ ] **Supplier email for flights.** The body says "dear hotel team", so the
      button is hidden for non-hotel products. Needs a generic template.
- [ ] **Supplier email has never been sent for real.** Verify on a test ticket
      before trusting it.
- [ ] Translate target picker — replace `prompt()` with a dropdown of common
      languages.
- [ ] Bulk "Collapse all / Expand all" for conversations; persist per-ticket
      collapse state across SPA navigation.

## 2. Security / hygiene

- [x] ~~`/guided-prewarm/booking/:id` reachable unauthenticated~~ — closed in
      session 22: every route moved under `/api/*` behind one `app.use` guard.
- [x] ~~`express.static` on the repo root served `server.js` and
      `services/*.js` publicly~~ — closed in session 22.
- [ ] `POST /ta-session` is still unauthenticated. It is how `auth.html` stores
      the TA cookie, so guarding it means giving that page a secret too. Low
      risk (write-only, overwrites one row) but it is the last open door.
- [ ] Drop the dead tables — `freshdesk_sessions`, `zoho_sessions`,
      `ticket_summaries`, `agent_prompts`, `agent_macros`. `initDb` no longer
      creates them; removing them from the live DB is a deliberate migration,
      not a code change.

## 3. Loose ends to verify

- [ ] **Login as User URL** — confirm the `webadminCustomerLogin/{id}` pattern
      is correct for primary members; if not, capture the real URL from TA.
- [ ] `GET`/`DELETE /api/ticket-booking/:ticketId` have no caller. Either give
      the overlay an unlink affordance or delete the routes.

## 4. Future capabilities (not committed)

- [ ] Zoho's built-in AI — the reason `/ai-assist` was retired. If a summary or
      draft-reply feature is wanted, wire Desk's own rather than re-adding a
      Groq route.
- [ ] Triage automation. Freshdesk had a batch triage job (LLM classification →
      auto note / hotel email / status) and a Pendings job (reopen pending
      tickets nearing check-in). Both deleted in session 22 as FD-wired. If
      either is wanted on Zoho, git history has a working reference —
      `services/batchTriageService.js`, `triageAiService.js`,
      `noteDetectionService.js`, `prewarmService.checkPendings`.
- [ ] Hotel Email — AI-resolved hotel address + prepaid-confirmation body.
      Retired in session 22. `hotelEmailBuilder.js` and `aiService.findHotelEmail`
      are in git history if it comes back.
