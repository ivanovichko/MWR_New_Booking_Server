# Backlog — deferred work

Forward-looking list. `todo.md` holds the session-by-session log of what's
done; this file is what's still open.

Everything Freshdesk-related was closed by deletion in session 22 (see
`todo.md` § Session 22). What follows is the Zoho list — overlay first, then
the dormant extension.

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
- [ ] Drop the dead tables — `freshdesk_sessions`, `ticket_summaries`,
      `agent_prompts`, `agent_macros`. `initDb` no longer creates them;
      removing them from the live DB is a deliberate migration, not a code
      change. **Not `zoho_sessions`** — that one is live for the extension.

## 3. Loose ends to verify

- [ ] **Login as User URL** — confirm the `webadminCustomerLogin/{id}` pattern
      is correct for primary members; if not, capture the real URL from TA.
- [x] ~~`GET /api/ticket-booking/:ticketId` has no caller~~ — it does now: with
      AI extraction deprecated, it is how the panel resolves a booking (§5).
- [ ] `DELETE /api/ticket-booking/:ticketId` still has no caller. Either give
      the overlay an unlink affordance or delete the route.

## 4. Zoho Desk extension (TA_Zoho_beta/) — dormant, maintained

Blocked on a marketplace / Developer Space approval, not on code. Kept working
because it is the form MWR would license if they buy the app. Its widget writes
through an org-level OAuth token, which the overlay deliberately does not use.

- [x] ~~Widget's booking lookup reachable unauthenticated by plain `fetch`~~ —
      closed 2026-09-15: now `/zoho/booking/:id` through `ZOHODESK.request`
      with the secret placeholder. No plain-fetch path remains, so the CORS
      middleware went with it.
- [ ] The extension has never been installed. `zet pack` produces a valid zip;
      everything past that waits on approval.
- [ ] Feature gap vs the overlay: no duplicate strip, no supplier email, no
      chat translation, no merge. Port only if the app is actually licensed —
      the overlay is where daily work happens.
- [ ] If it is ever abandoned for good, this is the deletion list:
      `services/zohoDeskService.js`, `services/zohoTicketActionService.js`, the
      `/zoho/*` extension routes, `zoho_sessions`, and the `ZOHO_CLIENT_ID` /
      `ZOHO_CLIENT_SECRET` / `ZOHO_ORG_ID` Render vars. **Ask first.**

## 5. AI — deprecated, disconnected 2026-09-15

Zoho Desk ships AI out of the box. Groq extraction and Google/Groq translation
are switched off behind `AI_ENABLED` (false in `server.js` and in the
userscript). Nothing removed — both flags flip back on.

- [ ] Replace extraction with Zia. `GET /api/ticket-booking/:ticketId` covers
      already-linked tickets; a fresh ticket still needs its booking ref read
      from the text. See the Zia Smart Prompt notes — it needs a provisioned
      GenAI model, which the trial org did not have.
- [ ] Replace 🌐 message translation with Desk's own, or accept the loss.
- [ ] A stale link row now surfaces as "Reference X is linked to this ticket but
      no matching booking exists in TA" — the DELETE route above is the fix.
- [ ] Fix before ever re-enabling: `api.translate` retries **any** failure 3×
      (1.5s + 4s), including terminal 4xx, and `translateChatLines` falls back
      to one call per line — each also retried. A 25-line message against a
      dead endpoint hangs the button for ~2.5 minutes; against a timeout
      (`gmRequest` uses 60s) far longer. Classify retryable vs terminal, and
      abort the per-line fan-out on a terminal error.
- [ ] `injectConversationTranslate` had no `getSecret()` check, so the 🌐
      buttons appeared on tickets whose panel said "No backend key set". Moot
      while AI is off (the whole injection is skipped) — fix it if AI returns.

## 6. Future capabilities (not committed)

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
