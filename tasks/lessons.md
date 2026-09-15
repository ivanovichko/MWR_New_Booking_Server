# Lessons

## Diagnose before coding
When the user reports a symptom ("hitting 429 for X"), explain the root cause and
the options first — do not open an editor and start patching. Wait for them to
pick a direction. Editing files on a bare bug report reads as "randomly coding".

## "No caller" is not "dead"

Session 22: I deleted the whole Zoho Desk *extension* backend
(`zohoDeskService`, `zohoTicketActionService`, the `/zoho/*` action routes,
`zoho_sessions`) because the overlay never calls it. Wrong reason. It was
**dormant, not obsolete** — the extension is the shape MWR would buy if they
license the app, and its org-level OAuth write path is exactly what the overlay
cannot do.

Before deleting code with no live caller, separate the two cases:

- **Obsolete** — the thing it served is gone and is not coming back
  (Freshdesk). Delete.
- **Dormant** — the thing it served is blocked, unfinished, or waiting on a
  commercial decision (the marketplace approval). Keep, and say why in a comment.

The tell is *why* it has no caller. "Superseded by a better approach" still
needs the question asked: superseded for us, or superseded for everyone? And
when a plan proposes deleting a whole subsystem, name the consequence in the
plan in plain terms — "this ends the extension as a product option" — not just
the file list. I listed the files and got a "go" that was never consent to that.
