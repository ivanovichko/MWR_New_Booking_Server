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
const {
  initDb, storeSession, getCachedBooking,
  linkTicketBooking, getTicketBooking, getTicketsForBooking, unlinkTicket,
} = require('./services/dbService');

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

// ─── /api/* — everything the overlay calls, behind one shared secret ─────────
// The overlay (frontend/MWR Zoho Tools.user.js) sends the secret as a bearer
// token on every call; agents enter it once into Tampermonkey storage. Applied
// as middleware rather than per-route so a new route cannot be added unguarded
// by accident.
//
// Env var is still named ZOHO_BACKEND_SHARED_SECRET — it is already set on
// Render, and renaming it buys nothing but a dashboard edit and an outage
// window if the two halves are changed out of step.
app.use('/api', (req, res, next) => {
  const expected = process.env.ZOHO_BACKEND_SHARED_SECRET;
  if (!expected) return res.status(500).json({ error: 'ZOHO_BACKEND_SHARED_SECRET not configured on server' });
  const got = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (got !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ─── Booking-reference extraction ────────────────────────────────────────────
app.post('/api/extract', safeRoute(async (req, res) => {
  const { subject, description } = req.body;
  if (!subject && !description) throw new HttpError('subject or description is required');
  const result = await extractBookingId({ subject: subject || '', description: description || '' });
  console.log(`[extract] → ${result.bookingId || 'none'}`);
  res.json({ success: true, ...result });
}));

// ─── Booking lookup ──────────────────────────────────────────────────────────
// Cache first, live TA fetch on a miss. data_row and user_html are always
// re-parsed on read so new parser fields (aiReconfirmation, user.language)
// reach cached bookings without dropping the cache.
app.get('/api/booking/:id', safeRoute(async (req, res) => {
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
}));

// ─── Member search + profile ─────────────────────────────────────────────────
app.post('/api/find-user', safeRoute(async (req, res) => {
  const { query } = req.body;
  if (!query) throw new HttpError('query is required');
  const results = await findUser(query);
  console.log(`[find-user] "${query}" → ${results.length} result(s)`);
  res.json({ success: true, results });
}));

app.get('/api/user/:id', safeRoute(async (req, res) => {
  const { id } = req.params;
  console.log(`[user] profile — ${id}`);
  const html = await taGet(`https://traveladvantage.com/admin/account/viewCustomer/${id}`);
  res.json({ success: true, user: parseUserHtml(html) });
}));

// ─── Member reservation history ──────────────────────────────────────────────
app.get('/api/user/:id/reservations', safeRoute(async (req, res) => {
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
}));

// ─── Ticket ↔ booking link ───────────────────────────────────────────────────
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

// ─── Translation ─────────────────────────────────────────────────────────────
app.post('/api/translate', safeRoute(async (req, res) => {
  const { text, target = 'en', source = 'auto' } = req.body || {};
  if (!text || typeof text !== 'string') throw new HttpError('text required');
  try {
    const result = await translate({ text, target, source });
    res.json({ success: true, ...result });
  } catch (err) {
    throw new HttpError(`Translation unavailable: ${err.message}`, 502);
  }
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[server] listening on port ${PORT}`));
