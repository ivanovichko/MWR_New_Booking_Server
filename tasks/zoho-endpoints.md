# Zoho Desk — endpoint reference for the overlay

How the Tampermonkey overlay talks to Zoho Desk. Everything here is **same-origin
from inside the `desk.zoho.com` agent page**: no OAuth, no API-console client, no
marketplace install. Session cookie + `orgId` header is the whole auth story for
reads; writes add a CSRF header.

Org: **MWR LIFE `914515468`**, `.com` data centre. Portal slug: `mwrlife`.

## Base

```
/supportapi/zd/mwrlife/api/v1
```

The paths and payloads mirror the **documented REST v1 API** — so Zoho's public API
docs are a valid reference for request/response shapes, even though we never touch
the public `desk.zoho.com/api/v1` host or an OAuth token.

## URL shapes

| Thing | Shape |
|---|---|
| Ticket detail | `https://desk.zoho.com/agent/mwrlife/customer-support/tickets/details/{ticketId}` |
| List view | `https://desk.zoho.com/agent/mwrlife/customer-support/tickets/list/{slug}` |
| `{ticketId}` | long internal id, e.g. `1260212000047145349` — this is what the API takes |
| Display number | `#415512` — only in `document.title`, never in the URL |

## Headers

| Header | Value | When |
|---|---|---|
| `orgId` | `914515468` | **every** call — omitting it returns `422 UNPROCESSABLE_ENTITY` "The value passed for the 'orgId' parameter is invalid." |
| `Content-Type` | `application/json` | writes |
| `X-ZCSRF-TOKEN` | copied verbatim from Desk's own writes | writes — see "Write token" below |

`credentials: 'same-origin'` on every `fetch`.

## Verified reads (200, cookie + orgId only)

| Call | Notes |
|---|---|
| `GET /tickets/{id}` | full ticket: `subject`, `status`, `statusType`, `priority`, `contactId`, `threadCount`, `commentCount`, `departmentId`, … |
| `GET /tickets/{id}/threads?limit=n` | `{data:[…]}`, **newest first**. Carries only a truncated `summary` — not full content. Per-thread: `direction` (`in`/`out`), `to`, `cc`, `bcc`, `fromEmailAddress`, `createdTime`, `isDescriptionThread` |
| `GET /tickets/{id}/threads/{threadId}` | full thread: `content` (complete body), `attachments`, `replyTo`, `isContentTruncated`, `fullContentURL`, plus all list fields |
| `GET /tickets/{id}/comments?limit=n` | `{data:[…]}` |
| `GET /agents?limit=n` | `{data:[{zuid, emailId, firstName, lastName, name, status, roleId, photoURL}]}` — agent-name resolution + reply signature |
| `GET /search?searchStr=…&module=tickets&limit=n&from=n&sortBy=relevance` | `{data:[ticket…]}` — duplicate search. See "Duplicate search" below |

`GET /agents/me` does **not** exist (404). Resolve the logged-in agent by matching
against `/agents`.

### Reading a ticket's text — three traps

1. **`ticket.description` is often `null`.** Thread text is the normal source, not
   a fallback.
2. **The threads list gives only a truncated `summary`.** Full body requires the
   per-thread detail call.
3. **`isDescriptionThread` was `false` on every thread observed.** Do not use it to
   find the customer's original message — filter `direction === 'in'` and take the
   oldest (the list is newest-first).

The thread-detail fields `to` / `cc` / `bcc` / `fromEmailAddress` / `replyTo` are
what the reply composer needs, so Phase 3 has its inputs already.

## Writes

`POST /tickets/{id}/comments` — internal note. Body (REST v1 shape):

```json
{ "content": "<html>", "contentType": "html", "isPublic": false }
```

Returns `401 UNAUTHORIZED` without a valid `X-ZCSRF-TOKEN`.

`POST /tickets/{id}/sendReply` — customer/supplier reply. **Body contract
established by probing the validator, not from docs** (2026-09-13):

```json
{ "content": "<html>", "contentType": "html", "channel": "EMAIL",
  "fromEmailAddress": "\"MWR Life Support\"<support@mwrlife.com>",
  "to": "someone@example.com", "subject": "…" }
```

- **Mandatory:** `content`, `channel` (`EMAIL`; anything else → `invalid`),
  `fromEmailAddress`. With those three present the call reached `404 URL_NOT_FOUND`
  against a fake ticket id — i.e. the body validated and only the ticket was
  missing.
- **`to` is NOT mandatory** — it defaults to the ticket's contact. That is exactly
  why the supplier-email flow must set it explicitly, or the hotel mail would go
  to the customer.
- Probing technique: **body validation runs before the ticket-existence check**,
  so posting to `000000000000000001` reports missing fields one at a time with no
  possibility of sending mail. Errors come back as
  `{errorCode:'INVALID_DATA', errors:[{fieldName:'/content', errorType:'missing'}]}`.
- `fromEmailAddress` is not hardcoded: the overlay reads it from the ticket's own
  latest outbound thread (`direction === 'out'`), falling back to any thread that
  has one.

## Write token — how writes are authorised

Desk rejects any write without `X-ZCSRF-TOKEN`. The value format is
`deskcsrfparam=<token>` (a raw token 422s on format; a wrong token 401s), but the
token is **not** in the `CSRF_TOKEN` cookie or `desk_urls.csrf_token`, and its real
home was never established.

**We do not need to know.** The overlay installs a `document-start` observer that
patches `XMLHttpRequest.prototype.setRequestHeader` and `window.fetch`, records the
`X-ZCSRF-TOKEN` header off Desk's *own* outgoing writes, and reuses it verbatim.
Desk POSTs a "recent items" record whenever a ticket is opened, so the header is
normally observed before the agent can click anything.

Why this rather than reading the source directly:

- It is source-agnostic, so it keeps working if Zoho moves the token.
- The script never rummages through cookies or storage.
- `@run-at document-start` is **required** — patch after Desk's bundle captures its
  own `fetch`/XHR references and its writes bypass the observer, so the token is
  never seen.

Mark our own requests with `__taOwn: true` so the observer does not re-capture the
header it just set.

**Verified end-to-end 2026-09-13:** with an observed header, a POST to
`/tickets/000000000000000001/comments` (a deliberately nonexistent id) returned
`404 URL_NOT_FOUND` rather than `401 UNAUTHORIZED` — auth passed, and the only
failure was the fake ticket. Writes are unblocked.

## Open items

- ~~CSRF token source~~ — **RESOLVED 2026-09-13, see "Write token" below.**
- **Merge — DEFERRED, not captured.** No disposable tickets were available to merge
  against (2026-09-13). Zoho exposes no documented REST merge endpoint; it exists in
  Deluge as `zoho.desk.ticket.merge` and in the UI, so the in-page call shape has to
  come from a live capture. Until then the duplicate strip ships with preview +
  link-out and no merge button. **To finish: merge two scratch tickets with the
  capture harness armed, then fill in this section.**
- ~~`sendReply` body~~ — **RESOLVED** by validator probing, see Writes above. Still
  unproven end-to-end: no real email has been sent through this path yet.
- **Composer DOM anchors** — the reply editor is absent from the DOM until Reply is
  clicked, so anchors must be read from an open composer.

## DOM anchoring rule

Classes are build-hashed (`zd_v2a69d467274`) but every hashed class sits next to a
stable semantic one:

```
zd_v2-detailviewlayout-rightPanel
zd_v2-rightpanelwidgets-rhsextension
zd_v2-conversationlistwrapper-posRel
```

Semantic `data-id` / `data-test-id` values also exist (`ConversationList`,
`AppContainer`, `statusContainer`).

**Match on the `-<component>-<part>` suffix or on `data-id`. Never on a hash.**

The booking panel avoids this entirely by being viewport-anchored on `document.body`
rather than injected into Zoho's rail.

## Recon technique

Desk is an SPA, so the devtools network panel shows nothing after a hard
navigation. Patch `window.fetch` and `XMLHttpRequest.prototype.open/send` in-page,
then navigate *within* the app. A page reload clears the patch — persist captures to
`sessionStorage` as they happen.

Probe writes only against a deliberately nonexistent ticket id (e.g.
`000000000000000001`), which cannot create anything.

## Backend calls must use GM_xmlhttpRequest

Verified in-page on 2026-09-13: a page-origin `fetch()` from `desk.zoho.com` to
`https://mwr-new-booking-server.onrender.com/health` fails with
`TypeError: Failed to fetch` — Desk's CSP blocks it. Every Render call therefore
goes through `GM_xmlhttpRequest` with `@connect mwr-new-booking-server.onrender.com`.
Only Zoho's own same-origin API is reachable with plain `fetch`.


## Duplicate search

Two sources, and **neither is sufficient alone**:

1. **`ticket_bookings` (DB)** — exact, but only covers tickets an agent has
   already opened with the overlay running. A duplicate that just arrived has
   never been viewed, so it is simply not in the table.
2. **Zoho `/search`** — covers everything, but matches loosely.

The overlay queries both and merges, deduping by ticket id and unioning a
`matchedBy` label per row (`linked booking`, `booking ID`, `supplier ref`,
`member email`, `manual search`).

### Search behaviour — measured, not assumed (2026-09-13)

- **Accepted params:** `searchStr`, `module`, `limit`, `from`, `sortBy`.
  **`statusType` is rejected** (`422 Extra query parameter`) — open/closed
  filtering must happen client-side on the `statusType` field.
- **Closed tickets are included by default.** One probe returned 4 results, all
  `Closed`.
- **Matching is fuzzy and needs verification.** Searching a booking ref returned
  tickets that do not contain it; a short numeric (`12345`) returned 20 results of
  noise. The overlay filters results to those whose
  `subject + description + lastThread.summary` actually contains the needle —
  the same guard `freshdeskService.searchTicketsStrict` applied. Manual searches
  skip verification, since the agent typed the term deliberately.
- **One term is not enough.** Live example: booking ID `412468` verified to a
  single ticket (#571713), while supplier ref `GO31086415-33726973-A(US)` found
  **two** (#571713 + #571719) — a real duplicate pair the booking-ID search missed
  because #571719 never quotes the internal ID. Searching all available refs and
  merging is what catches these.
- **Results are rich enough to render directly:** `ticketNumber`, `subject`,
  `status`, `statusType`, `createdTime`, plus embedded `assignee`
  (`firstName`/`lastName`/`emailId`) and `contact` objects. No separate agent-map
  lookup is needed, unlike the Freshdesk path which called `fetchAgentMap()`.
- `webUrl` on a result is the **legacy** `ShowHomePage.do#Cases/dv/{id}` form —
  build the agent URL from the ticket id instead.

DB-linked rows carry no `statusType`, so the overlay enriches up to 6 of them with
a `GET /tickets/{id}` before applying the open/closed filter.
