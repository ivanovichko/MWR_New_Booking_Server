require('dotenv').config();
const express = require('express');
const path    = require('path');

const { parseDataRow, parseBookingHtml } = require('./services/parserService');
const { parseUserHtml, findUser }        = require('./services/userService');
const { buildNoteHtml }                  = require('./services/noteBuilder');
const { lookupSupplier }                 = require('./services/supplierService');
const { translate }                      = require('./services/translateService');
const { taGet, taPost }                  = require('./services/taAuthService');
const { extractBookingId, fetchAndCacheBooking } = require('./services/bookingService');
const { confirmTicketZoho } = require('./services/zohoTicketActionService');
const { exchangeGrantToken, listOrganizations, describeConfig, postComment } = require('./services/zohoDeskService');
const {
  initDb, storeSession, getCachedBooking,
  linkTicketBooking, getTicketBooking, getTicketsForBooking, unlinkTicket,
} = require('./services/dbService');

// ─── AI functionality — DEPRECATED, disconnected 2026-09-15 ──────────────────
// Zoho Desk ships AI out of the box, so the Groq-backed booking-reference
// extraction and the Google/Groq translation are no longer served. Nothing is
// removed: services/bookingService.js and services/translateService.js are
// intact and the routes still exist, they just answer 410 while this is false.
// Flip the constant, or set AI_ENABLED=true on Render, to bring it all back.
// The overlay has a matching flag — turn both on together.
const AI_ENABLED = process.env.AI_ENABLED === 'true';

const app = express();
app.use(express.json({ limit: '50mb' }));

// ─── Init DB on startup ───────────────────────────────────────────────────────
initDb().catch(err => console.error('[db] init failed:', err.message));

// ─── Route helper: catch async errors and respond uniformly ──────────────────
// Routes can throw — the wrapper logs and responds with { error: msg }.
// Throw an HttpError for a non-500 status.
function safeRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      const status = Number.isInteger(err.statusCode) ? err.statusCode : 500;
      console.error(`[${req.method} ${req.originalUrl}] error: ${err.message}`);
      res.status(status).json({ error: err.message });
    }
  };
}

class HttpError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Auth page: agents paste their TravelAdvantage session cookie ─────────────
// Served by an explicit route rather than express.static on the repo root —
// that mount made server.js and services/*.js publicly fetchable.
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'auth.html')));

app.post('/ta-session', safeRoute(async (req, res) => {
  const { cookie } = req.body;
  if (!cookie) throw new HttpError('cookie is required');
  await storeSession(cookie);
  console.log(`[ta-session] stored (length: ${cookie.length})`);
  res.json({ success: true });
}));

// ─── Two guarded namespaces, one shared secret ───────────────────────────────
//
// /api/*  — the Tampermonkey overlay (frontend/MWR Zoho Tools.user.js), which
//           is what agents run today. It reaches the backend via
//           GM_xmlhttpRequest, so CORS never applies.
//
// /zoho/* — the Zoho Desk extension (TA_Zoho_beta/). Dormant pending a
//           marketplace / Developer Space approval, but kept working: if MWR
//           buys the app, this is the half that has to still be here. Its
//           widget calls the backend through ZOHODESK.request, Zoho's
//           server-side request proxy, which substitutes the literal
//           {{backend_shared_secret}} placeholder into the Authorization
//           header — so the secret never reaches browser JS, and because the
//           proxy runs server-side, CORS never applies there either.
//
// Both carry the same bearer token, applied as middleware rather than per-route
// so a new route cannot be added unguarded by accident. The env var is still
// named ZOHO_BACKEND_SHARED_SECRET: it is already set on Render, and renaming
// it buys nothing but a dashboard edit and an outage window if the halves are
// changed out of step.
function requireSecret(req, res, next) {
  const expected = process.env.ZOHO_BACKEND_SHARED_SECRET;
  if (!expected) return res.status(500).json({ error: 'ZOHO_BACKEND_SHARED_SECRET not configured on server' });
  const got = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (got !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.use('/api',  requireSecret);
app.use('/zoho', requireSecret);

// ─── Shared handlers ─────────────────────────────────────────────────────────
// Mounted under both prefixes. The overlay and the extension ask the same
// questions of TravelAdvantage; only their write paths differ.

// Answers every AI route while AI_ENABLED is false. 410 rather than 404 so a
// caller can tell "deliberately switched off" from "wrong URL".
const aiDisconnected = (req, res) => res.status(410).json({
  error: 'AI functionality is deprecated and disconnected on this server. Set AI_ENABLED=true to restore it.',
  code: 'AI_DISABLED',
});

// DEPRECATED (see AI_ENABLED). Groq: pull a booking reference out of subject +
// description.
const extractHandler = safeRoute(async (req, res) => {
  const { subject, description } = req.body;
  if (!subject && !description) throw new HttpError('subject or description is required');
  const result = await extractBookingId({ subject: subject || '', description: description || '' });
  console.log(`[extract] → ${result.bookingId || 'none'}`);
  res.json({ success: true, ...result });
});

// Booking lookup — cache first, live TA fetch on a miss. data_row and user_html
// are always re-parsed on read so new parser fields (aiReconfirmation,
// user.language) reach cached bookings without dropping the cache.
const bookingHandler = safeRoute(async (req, res) => {
  const bookingId = req.params.id;
  let bookingData;
  let cleanHtmlForNote = null;

  const cached = await getCachedBooking(bookingId);
  if (cached && cached.parsed) {
    bookingData = { ...cached.parsed, booking: parseDataRow(cached.data_row) };
    if (cached.user_html) bookingData.user = parseUserHtml(cached.user_html);
    if (!bookingData.supplier) bookingData.supplier = lookupSupplier(bookingData.booking.supplierName);
    if (cached.booking_html) cleanHtmlForNote = parseBookingHtml(cached.booking_html).cleanHtml;
  } else {
    const fetched = await fetchAndCacheBooking(bookingId);
    bookingData = fetched;
    cleanHtmlForNote = fetched.cleanHtml;
  }

  const { booking, details, user, supplier } = bookingData;
  bookingData.noteHtml = buildNoteHtml(
    booking, cleanHtmlForNote || '', details, user,
    supplier || lookupSupplier(booking.supplierName)
  );
  console.log(`[booking] ${bookingId} (${cached ? 'cache' : 'live'})`);
  res.json({ success: true, bookingData });
});

const findUserHandler = safeRoute(async (req, res) => {
  const { query } = req.body;
  if (!query) throw new HttpError('query is required');
  const results = await findUser(query);
  console.log(`[find-user] "${query}" → ${results.length} result(s)`);
  res.json({ success: true, results });
});

const userHandler = safeRoute(async (req, res) => {
  const { id } = req.params;
  console.log(`[user] profile — ${id}`);
  const html = await taGet(`https://traveladvantage.com/admin/account/viewCustomer/${id}`);
  res.json({ success: true, user: parseUserHtml(html) });
});

const reservationsHandler = safeRoute(async (req, res) => {
  const { id } = req.params;
  console.log(`[reservations] user ${id}`);

  const params = new URLSearchParams({
    draw: '1', start: '0', length: '25',
    'order[0][column]': '6', 'order[0][dir]': 'desc',
    'search[value]': '', 'search[regex]': 'false',
  });
  for (let i = 0; i <= 10; i++) {
    params.append(`columns[${i}][data]`, i.toString());
    params.append(`columns[${i}][name]`, '');
    params.append(`columns[${i}][searchable]`, 'true');
    params.append(`columns[${i}][orderable]`, [0, 2, 8].includes(i) ? 'false' : 'true');
    params.append(`columns[${i}][search][value]`, '');
    params.append(`columns[${i}][search][regex]`, 'false');
  }

  const data = await taPost(
    `https://traveladvantage.com/admin/account/reservationHistoryList/${id}`,
    params.toString()
  );

  const strip = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const extractHref = (s) => { const m = (s || '').match(/href="([^"]+)"/); return m ? m[1] : null; };

  const reservations = (data.data || []).map(row => ({
    detailUrl:  extractHref(row[0]),
    bookingId:  strip(row[1]),
    guest:      strip(row[3]),
    type:       strip(row[4]),
    supplierId: strip(row[5]),
    date:       strip(row[6]),
    status:     strip(row[7]),
    total:      strip(row[8]),
    checkIn:    strip(row[9]),
    checkOut:   strip(row[10]),
  }));

  res.json({ success: true, reservations, total: data.recordsTotal });
});

// DEPRECATED (see AI_ENABLED). Google first, Groq fallback.
const translateHandler = safeRoute(async (req, res) => {
  const { text, target = 'en', source = 'auto' } = req.body || {};
  if (!text || typeof text !== 'string') throw new HttpError('text required');
  try {
    const result = await translate({ text, target, source });
    res.json({ success: true, ...result });
  } catch (err) {
    throw new HttpError(`Translation unavailable: ${err.message}`, 502);
  }
});

for (const prefix of ['/api', '/zoho']) {
  app.get(`${prefix}/booking/:id`,               bookingHandler);
  app.post(`${prefix}/find-user`,                findUserHandler);
  app.get(`${prefix}/user/:id`,                  userHandler);
  app.get(`${prefix}/user/:id/reservations`,     reservationsHandler);

  // Deprecated pair — served only while AI_ENABLED.
  app.post(`${prefix}/extract`,   AI_ENABLED ? extractHandler   : aiDisconnected);
  app.post(`${prefix}/translate`, AI_ENABLED ? translateHandler : aiDisconnected);
}

console.log(`[server] AI functionality ${AI_ENABLED ? 'ENABLED' : 'disconnected (deprecated)'}`);

// ─── Ticket ↔ booking link (overlay only) ────────────────────────────────────
// The overlay records the link as soon as a booking is established for a ticket,
// so the booking becomes a first-class key rather than something re-derived from
// the ticket text on every visit. A booking maps to many tickets, which is what
// makes /api/booking-tickets a reliable duplicate lookup — far better than
// matching subject strings.
app.post('/api/ticket-booking', safeRoute(async (req, res) => {
  const { ticketId, bookingId, ticketNumber, subject, status, linkedBy, source } = req.body;
  if (!ticketId || !bookingId) throw new HttpError('ticketId and bookingId are required');
  const link = await linkTicketBooking({
    ticketId, bookingId, ticketNumber, subject, status, linkedBy,
    source: source || 'auto',
  });
  console.log(`[link] ticket ${ticketId} → booking ${bookingId} (${source || 'auto'})`);
  res.json({ success: true, link });
}));

app.get('/api/ticket-booking/:ticketId', safeRoute(async (req, res) => {
  const link = await getTicketBooking(req.params.ticketId);
  res.json({ success: true, link });
}));

// Every other ticket already linked to this booking — the duplicate set.
app.get('/api/booking-tickets/:bookingId', safeRoute(async (req, res) => {
  const tickets = await getTicketsForBooking(req.params.bookingId, req.query.exclude || null);
  res.json({ success: true, tickets });
}));

app.delete('/api/ticket-booking/:ticketId', safeRoute(async (req, res) => {
  await unlinkTicket(req.params.ticketId);
  console.log(`[link] unlinked ticket ${req.params.ticketId}`);
  res.json({ success: true });
}));

// ─── Zoho Desk extension only ────────────────────────────────────────────────
// The extension writes through an org-level OAuth token rather than the acting
// agent's session — that difference is exactly why the overlay exists, and why
// these routes have no /api twin. Kept working against the day the marketplace
// app is approved.

// One-time exchange of a self-client grant token (generated in the Zoho API
// console, valid ~10 minutes, single use) for a durable refresh_token.
// requireSecret runs *before* the exchange, so a 500 "not configured" response
// does not consume the single-use code.
app.post('/zoho/oauth-session', safeRoute(async (req, res) => {
  const { grantCode } = req.body;
  if (!grantCode) throw new HttpError('grantCode is required');
  res.json(await exchangeGrantToken(grantCode));
}));

// Diagnostic only. Returns no secrets — just which vars are set and which data
// centre the exchange will hit, so an invalid_client can be pinned down.
app.get('/zoho/config', safeRoute(async (req, res) => {
  res.json({ success: true, config: describeConfig() });
}));

// Health check + org ID discovery. Works before ZOHO_ORG_ID is set, so it is the
// first call that proves the stored session can actually reach Desk — the OAuth
// exchange only proves accounts.zoho.
app.get('/zoho/orgs', safeRoute(async (req, res) => {
  const orgs = await listOrganizations();
  res.json({ success: true, orgs });
}));

// Post the standard booking note to a Desk ticket.
app.post('/zoho/post-note', safeRoute(async (req, res) => {
  const { ticketId, bookingId, noteHtml } = req.body;
  if (!ticketId || !bookingId) throw new HttpError('ticketId and bookingId are required');
  const results = await confirmTicketZoho(ticketId, bookingId, noteHtml || null);
  console.log(`[zoho] posted note to ticket ${ticketId}`);
  res.json({ success: true, results });
}));

// The widget's Member section builds member-detail HTML that has no booking
// behind it, so this posts the prebuilt HTML directly — no cached booking.
app.post('/zoho/member-note', safeRoute(async (req, res) => {
  const { ticketId, noteHtml } = req.body;
  if (!ticketId || !noteHtml) throw new HttpError('ticketId and noteHtml are required');
  await postComment(ticketId, noteHtml, false);
  console.log(`[zoho] posted member note to ticket ${ticketId}`);
  res.json({ success: true });
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[server] listening on port ${PORT}`));
