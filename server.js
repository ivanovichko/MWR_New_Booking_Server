require('dotenv').config();
const express = require('express');
const path    = require('path');
const multer  = require('multer');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const { parseDataRow, parseBookingHtml } = require('./services/parserService');
const { parseUserHtml, findUser }        = require('./services/userService');
const { buildNoteHtml }                  = require('./services/noteBuilder');
const { lookupSupplier }                 = require('./services/supplierService');
const { aiAssist, findHotelEmail }       = require('./services/aiService');
const { getAuthHeader, fdGet, addNote, addNoteWithImages, sendEmail, sendEmailWithAttachments, setTicketPending, tagTicket, updateTicket, searchDuplicates, getTicketContext } = require('./services/freshdeskService');
const { fetchAgentMap, fetchAllAgents, fillMissingAgentNames } = require('./services/agentService');
const { fetchTicket } = require('./services/ticketService');
const { initDb, getCachedBooking, cacheBooking, storeSession, getPrompts, createPrompt, updatePrompt, deletePrompt, getMacros, createMacro, updateMacro, deleteMacro, storeFreshdeskSession } = require('./services/dbService');
const { prewarm, fetchAndCacheBooking, extractBookingId, checkPendings, checkInPriority, setTicketPriority, postNote } = require('./services/prewarmService');
const { taGet, taPost }                  = require('./services/taAuthService');
const { buildHotelEmailHtml }            = require('./services/hotelEmailBuilder');
const { confirmTicket }                  = require('./services/ticketActionService');
const { FD_STATUS, PREWARM_CONVERSATION_THRESHOLD } = require('./config');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname)));

// ─── Init DB on startup ───────────────────────────────────────────────────────
initDb().catch(err => console.error('[db] init failed:', err.message));

// ─── Route helper: catch async errors and respond uniformly ──────────────────
// Routes can throw — the wrapper logs and responds with { error: msg }.
// Throw with `err.statusCode = 4xx` for non-500 responses.
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

// Throw an HttpError to short-circuit a safeRoute with a specific status.
class HttpError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Auth page ────────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'auth.html')));

// ─── Freshdesk Session ────────────────────────────────────────────────────────
app.post('/freshdesk-session', safeRoute(async (req, res) => {
  const { cookie, csrfToken } = req.body;
  if (!cookie) throw new HttpError('cookie is required');
  await storeFreshdeskSession(cookie, csrfToken || null);
  console.log(`[freshdesk-session] stored (cookie len: ${cookie.length}, csrf: ${csrfToken ? 'yes' : 'no'})`);
  res.json({ success: true });
}));

// ─── TA Session: manually paste cookie value ──────────────────────────────────
app.post('/ta-session', safeRoute(async (req, res) => {
  const { cookie } = req.body;
  if (!cookie) throw new HttpError('cookie is required');
  await storeSession(cookie);
  console.log(`[ta-session] stored (length: ${cookie.length})`);
  res.json({ success: true });
}));

// ─── Prewarm: polling-based progress ─────────────────────────────────────────
// In-memory job store (single job at a time is fine)
const prewarmJob = { running: false, log: [], done: false, error: null, results: null, stopped: false };

app.post('/prewarm/start', async (req, res) => {
  if (prewarmJob.running) {
    return res.json({ success: true, message: 'Already running' });
  }

  // Reset
  prewarmJob.running = true;
  prewarmJob.done    = false;
  prewarmJob.error   = null;
  prewarmJob.results = null;
  prewarmJob.log     = [];
  prewarmJob.stopped = false;

  res.json({ success: true, message: 'Prewarm started' });

  // Run async in background
  prewarm((msg) => prewarmJob.log.push(msg), () => prewarmJob.stopped)
    .then(results => {
      prewarmJob.results = results;
      prewarmJob.done    = true;
      prewarmJob.running = false;
    })
    .catch(err => {
      prewarmJob.error   = err.message;
      prewarmJob.done    = true;
      prewarmJob.running = false;
    });
});

app.post('/prewarm/stop', (req, res) => {
  prewarmJob.stopped = true;
  res.json({ success: true });
});

app.get('/prewarm/status', (req, res) => {
  res.json({
    running: prewarmJob.running,
    done:    prewarmJob.done,
    error:   prewarmJob.error,
    log:     prewarmJob.log,
    results: prewarmJob.results,
    stopped: prewarmJob.stopped,
  });
});


const pendingsJob = { running: false, log: [], done: false, error: null, results: null, stopped: false };

app.post('/check-pendings/start', async (req, res) => {
  if (pendingsJob.running) return res.json({ success: true, message: 'Already running' });
  pendingsJob.running = true;
  pendingsJob.done    = false;
  pendingsJob.error   = null;
  pendingsJob.results = null;
  pendingsJob.log     = [];
  pendingsJob.stopped = false;
  res.json({ success: true, message: 'Check pendings started' });
  checkPendings((msg) => pendingsJob.log.push(msg), () => pendingsJob.stopped)
    .then(results => { pendingsJob.results = results; pendingsJob.done = true; pendingsJob.running = false; })
    .catch(err  => { pendingsJob.error = err.message; pendingsJob.done = true; pendingsJob.running = false; });
});

app.post('/check-pendings/stop', (req, res) => {
  pendingsJob.stopped = true;
  res.json({ success: true });
});

app.get('/check-pendings/status', (req, res) => {
  res.json({ running: pendingsJob.running, done: pendingsJob.done, error: pendingsJob.error, log: pendingsJob.log, results: pendingsJob.results, stopped: pendingsJob.stopped });
});


app.get('/booking/:id', async (req, res) => {
  const bookingId = req.params.id;
  console.log(`[booking] lookup ${bookingId}`);

  try {
    let cached = await getCachedBooking(bookingId);
    let fromCache = true;

    if (!cached) {
      console.log(`[booking] cache miss — live fetching ${bookingId}`);
      fromCache = false;
      await fetchAndCacheBooking(bookingId);
      cached = await getCachedBooking(bookingId);
    }

    if (!cached) return res.status(404).json({ error: `Booking ${bookingId} not found` });

    const parsed  = cached.parsed;
    const booking = parsed.booking;
    const details = parsed.details;
    const user    = parsed.user;
    const supplier = lookupSupplier(booking.supplierName);
    const { cleanHtml } = parseBookingHtml(cached.booking_html);
    const noteHtml = buildNoteHtml(booking, cleanHtml, details, user, supplier);

    res.json({
      success: true,
      fromCache,
      fetchedAt: cached.fetched_at,
      booking,
      details,
      user,
      supplier,
      noteHtml,
      hotelName:   details?.hotelName,
      productType: booking.productType,
    });

  } catch (err) {
    console.error('[booking] lookup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── Parse + build note — DEPRECATED, now handled by /booking/:id ─────────────
// Kept for backward compatibility only. Proxies through the same logic.
app.post('/new-booking', async (req, res) => {
  const { dataRow, bookingHtml, userHtml, freshdeskTicketId } = req.body;

  if (!dataRow || !bookingHtml || !userHtml || !freshdeskTicketId) {
    return res.status(400).json({ error: 'dataRow, bookingHtml, userHtml, and freshdeskTicketId are required' });
  }

  console.log(`[new-booking] legacy — ticketId=${freshdeskTicketId}`);

  try {
    const booking              = parseDataRow(dataRow);
    const { cleanHtml, details } = parseBookingHtml(bookingHtml);
    const user                 = parseUserHtml(userHtml);
    const supplier             = lookupSupplier(booking.supplierName);

    console.log(`[new-booking] parsed ${booking.productType} — ${booking.guestName} — ${booking.supplierName}`);

    const noteHtml = buildNoteHtml(booking, cleanHtml, details, user, supplier);

    if (booking.internalBookingId) {
      cacheBooking({
        bookingId: booking.internalBookingId,
        dataRow, bookingHtml, userHtml,
        parsed: { booking, details, user },
      }).catch(e => console.warn('[new-booking] cache write failed:', e.message));
    }

    res.json({
      success:     true,
      noteHtml,
      booking,
      details,
      hotelName:   details.hotelName,
      productType: booking.productType,
    });

  } catch (err) {
    console.error('[new-booking] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Post note to Freshdesk (agent confirmed) ─────────────────────────────────
app.post('/post-note', safeRoute(async (req, res) => {
  const { freshdeskTicketId, noteHtml } = req.body;
  if (!freshdeskTicketId || !noteHtml) throw new HttpError('freshdeskTicketId and noteHtml are required');
  await addNoteWithImages(freshdeskTicketId, noteHtml);
  console.log(`[post-note] posted to ticket ${freshdeskTicketId}`);
  res.json({ success: true });
}));

// ─── Find hotel email via Groq (hotels only) ──────────────────────────────────
app.post('/find-hotel-email', safeRoute(async (req, res) => {
  const { hotelName, hotelAddress, hotelCountry } = req.body;
  if (!hotelName) throw new HttpError('hotelName is required');
  console.log(`[hotel-email] search — ${hotelName}`);
  const result = await findHotelEmail(hotelName, hotelAddress, hotelCountry);
  console.log(`[hotel-email] groq → ${result.email} (${result.confidence})`);
  res.json({ success: true, ...result });
}));

// ─── Send hotel email + set ticket pending (agent confirmed) ──────────────────
app.post('/send-hotel-email', safeRoute(async (req, res) => {
  const { freshdeskTicketId, hotelEmail, booking, details } = req.body;
  if (!freshdeskTicketId || !hotelEmail || !booking) {
    throw new HttpError('freshdeskTicketId, hotelEmail, and booking are required');
  }
  console.log(`[hotel-email] sending — ticket=${freshdeskTicketId} to=${hotelEmail}`);
  const emailBody = buildHotelEmailHtml(booking, details || {});
  await sendEmail(
    freshdeskTicketId,
    hotelEmail,
    `Prepaid Reservation Confirmation — ${booking.guestName} / ${booking.checkIn}`,
    emailBody
  );
  console.log('[hotel-email] sent to', hotelEmail);
  await setTicketPending(freshdeskTicketId);
  console.log('[hotel-email] ticket → Pending');
  res.json({ success: true, emailSent: true, hotelEmail });
}));

// ─── Tag ticket + set type ────────────────────────────────────────────────────
app.post('/tag-ticket', safeRoute(async (req, res) => {
  const { freshdeskTicketId, tags, type } = req.body;
  if (!freshdeskTicketId || !tags) throw new HttpError('freshdeskTicketId and tags are required');
  await tagTicket(freshdeskTicketId, tags, type);
  console.log(`[tag-ticket] ticket ${freshdeskTicketId}: ${tags.join(', ')}`);
  res.json({ success: true });
}));

// ─── Merge ticket ─────────────────────────────────────────────────────────────
app.post('/merge-ticket', async (req, res) => {
  const { sourceTicketId, targetTicketId, description } = req.body;
  if (!sourceTicketId || !targetTicketId) return res.status(400).json({ error: 'sourceTicketId and targetTicketId required' });

  const domain = process.env.FRESHDESK_DOMAIN;
  const auth   = getAuthHeader();

  try {
    const sourceLink = `https://mwrlife.freshdesk.com/a/tickets/${sourceTicketId}`;
    const descHtml = description || '';
    console.log(`[merge] desc length: ${descHtml.length}`);
    const noteHtml = `<p><a href="${sourceLink}">${sourceLink}</a></p>${descHtml}`;

    // Post note on target (duplicate) ticket: source link + description
    const noteRes = await fetch(`https://${domain}/api/v2/tickets/${targetTicketId}/notes`, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: noteHtml, private: true }),
    });
    if (!noteRes.ok) { const b = await noteRes.text(); throw new Error(`Note on target failed: ${b.slice(0,100)}`); }

    // Post note on source ticket: link to where it was merged
    const targetLink = `https://mwrlife.freshdesk.com/a/tickets/${targetTicketId}`;
    const sourceNoteHtml = `<p>Merged into ticket <a href="${targetLink}">#${targetTicketId}</a></p><p>${targetLink}</p>`;
    const sourceNoteRes = await fetch(`https://${domain}/api/v2/tickets/${sourceTicketId}/notes`, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: sourceNoteHtml, private: true }),
    });
    if (!sourceNoteRes.ok) { const b = await sourceNoteRes.text(); console.warn(`[merge] note on source failed: ${b.slice(0,100)}`); }

    // Close source ticket
    const closeBody = JSON.stringify({ status: FD_STATUS.CLOSED, type: 'Reservations' });
    console.log(`[merge] closing ticket ${sourceTicketId}`);
    const closeRes = await fetch(`https://${domain}/api/v2/tickets/${sourceTicketId}`, {
      method: 'PUT',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: closeBody,
    });
    if (!closeRes.ok) { const b = await closeRes.text(); console.error(`[merge] close failed ${closeRes.status}: ${b}`); throw new Error(`Close failed: ${b.slice(0,200)}`); }

    console.log(`[merge] #${sourceTicketId} → #${targetTicketId}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[merge] error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Close ticket ─────────────────────────────────────────────────────────────
app.post('/close-ticket', async (req, res) => {
  const { ticketId } = req.body;
  if (!ticketId) return res.status(400).json({ error: 'ticketId is required' });
  try {
    const domain = process.env.FRESHDESK_DOMAIN;
    const closeBody2 = JSON.stringify({ status: FD_STATUS.CLOSED, type: 'Reservations' });
    console.log(`[close] ticket ${ticketId}`);
    const r = await fetch(`https://${domain}/api/v2/tickets/${ticketId}`, {
      method: 'PUT',
      headers: {
        'Authorization': getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: closeBody2,
    });
    if (!r.ok) { const b = await r.text(); console.error(`[close] failed ${r.status}: ${b}`); throw new Error(`${r.status}: ${b.slice(0,200)}`); }
    console.log(`[close] ticket ${ticketId} closed`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[close] error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Update ticket fields (tags, status, priority, etc.) ─────────────────────
app.post('/update-ticket', safeRoute(async (req, res) => {
  const { ticketId, fields } = req.body;
  if (!ticketId || !fields) throw new HttpError('ticketId and fields required');
  await updateTicket(String(ticketId), fields);
  res.json({ success: true });
}));

// Agent name resolution lives in services/agentService.js.

// ─── Check for duplicate tickets ─────────────────────────────────────────────
app.post('/check-duplicates', safeRoute(async (req, res) => {
  const { vendorConf, internalId, memberEmail, freshdeskTicketId } = req.body;
  const [byVendor, byInternal, byEmail, agentMap] = await Promise.all([
    vendorConf  ? searchDuplicates(vendorConf,  freshdeskTicketId) : [],
    internalId  ? searchDuplicates(internalId,  freshdeskTicketId) : [],
    memberEmail ? searchDuplicates(memberEmail, freshdeskTicketId, true) : [],
    fetchAgentMap(),
  ]);
  // Tag each result with its match source, merge and deduplicate by ticket id
  const seen = new Map();
  for (const t of byVendor)  { if (!seen.has(t.id)) seen.set(t.id, { ...t, matchedBy: ['supplier ref'] }); else seen.get(t.id).matchedBy.push('supplier ref'); }
  for (const t of byInternal){ if (!seen.has(t.id)) seen.set(t.id, { ...t, matchedBy: ['booking ID'] }); else seen.get(t.id).matchedBy.push('booking ID'); }
  for (const t of byEmail)   { if (!seen.has(t.id)) seen.set(t.id, { ...t, matchedBy: ['member email'] }); else seen.get(t.id).matchedBy.push('member email'); }
  const duplicates = [...seen.values()].map(t => ({
    ...t,
    responder_name: t.responder_id ? (agentMap[t.responder_id] || null) : null,
  }));
  console.log(`[check-duplicates] ${vendorConf}/${internalId}/${memberEmail}: ${duplicates.length} found`);
  res.json({ success: true, duplicates });
}));

// ─── Manual ticket search (for merge) ────────────────────────────────────────
app.post('/search-tickets', safeRoute(async (req, res) => {
  const { query, includeClosed, freshdeskTicketId } = req.body;
  if (!query) throw new HttpError('query required');
  const [results, agentMap] = await Promise.all([
    searchDuplicates(query, freshdeskTicketId || null, false, !!includeClosed),
    fetchAgentMap(),
  ]);
  const duplicates = results.map(t => ({
    ...t,
    matchedBy: ['manual search'],
    responder_name: t.responder_id ? (agentMap[t.responder_id] || null) : null,
  }));
  console.log(`[search-tickets] "${query}": ${duplicates.length} found`);
  res.json({ success: true, duplicates });
}));

// ─── Find user (search primary + secondary) ───────────────────────────────────
app.post('/find-user', safeRoute(async (req, res) => {
  const { query } = req.body;
  if (!query) throw new HttpError('query is required');
  console.log(`[find-user] "${query}"`);
  const results = await findUser(query);
  console.log(`[find-user] ${results.length} result(s)`);
  res.json({ success: true, results });
}));

// ─── Full user profile ────────────────────────────────────────────────────────
app.get('/user/:id', safeRoute(async (req, res) => {
  const { id } = req.params;
  console.log(`[user] profile — ${id}`);
  const html = await taGet(`https://traveladvantage.com/admin/account/viewCustomer/${id}`);
  const user = parseUserHtml(html);
  res.json({ success: true, user });
}));

// ─── User reservation history ─────────────────────────────────────────────────
app.get('/user/:id/reservations', async (req, res) => {
  const { id } = req.params;
  console.log(`[reservations] user ${id}`);
  try {
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
    const extractHref = (s) => { const m = (s||'').match(/href="([^"]+)"/); return m ? m[1] : null; };

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
  } catch (err) {
    console.error('[reservations] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[server] listening on port ${PORT}`));

// ─── Extract booking ID from ticket + fetch + cache ───────────────────────────
app.post('/extract-booking-id', safeRoute(async (req, res) => {
  const { freshdeskTicketId } = req.body;
  if (!freshdeskTicketId) throw new HttpError('freshdeskTicketId is required');
  console.log(`[extract-booking] ticket ${freshdeskTicketId}`);
  const ticketContext = await getTicketContext(freshdeskTicketId);
  const { bookingId } = await extractBookingId({
    subject:          ticketContext.subject,
    description_text: ticketContext.description,
  });
  if (!bookingId) return res.json({ success: true, bookingId: null });
  console.log(`[extract-booking] ${bookingId} — fetching from TA`);
  await fetchAndCacheBooking(bookingId);
  console.log(`[extract-booking] ${bookingId} cached`);
  res.json({ success: true, bookingId });
}));

// ─── Send outbound reply to supplier or customer ──────────────────────────────
// Accepts multipart/form-data (with files[]) or plain JSON (no attachments).
app.post('/send-reply', upload.array('files'), async (req, res) => {
  const { freshdeskTicketId, toEmail, bodyHtml } = req.body;
  if (!freshdeskTicketId || !toEmail || !bodyHtml)
    return res.status(400).json({ error: 'freshdeskTicketId, toEmail, and bodyHtml are required' });

  const files = req.files || [];
  console.log(`[send-reply] ticket ${freshdeskTicketId} → ${toEmail} (${files.length} attachment(s))`);
  try {
    if (files.length > 0) {
      await sendEmailWithAttachments(freshdeskTicketId, toEmail, bodyHtml, files);
    } else {
      await sendEmail(freshdeskTicketId, toEmail, null, bodyHtml);
    }
    console.log(`[send-reply] sent to ${toEmail}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[send-reply] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Attachment proxy — fetches Freshdesk attachment ──────────────────────────
// Usage: GET /attachment?url=<encoded attachment_url>
// Most attachment URLs are tokenized signed URLs on CDN hosts
// (attachment.freshdesk.com, cache.freshdesk.com) and need NO auth — sending
// Basic auth to a CDN often causes the CDN to reject the request. Only attach
// our API-key header when the host is the actual Freshdesk API domain.
app.get('/attachment', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('url param required');
  try {
    const apiHost = process.env.FRESHDESK_DOMAIN;
    const targetHost = (() => { try { return new URL(url).host; } catch { return null; } })();
    const headers = (targetHost === apiHost) ? { Authorization: getAuthHeader() } : {};
    const upstream = await fetch(url, { headers });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      console.warn(`[/attachment] upstream ${upstream.status} for ${targetHost} — ${text.slice(0, 200)}`);
      return res.status(upstream.status).send(`Upstream error ${upstream.status}: ${text.slice(0, 300)}`);
    }
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    const cd = upstream.headers.get('content-disposition');
    res.set('Content-Type', ct);
    if (cd) res.set('Content-Disposition', cd);
    upstream.body.pipe(res);
  } catch (err) {
    console.error(`[/attachment] fetch failed: ${err.message}`);
    res.status(500).send(err.message);
  }
});

// Fast ticket fetch — ticket + full conversation thread, no Groq.
// Heavy lifting (session-cookie + API-key fallback, conversation pagination)
// lives in services/ticketService.js. This handler just composes the agent
// map on top of the returned data.
app.get('/guided-prewarm/ticket/:id', safeRoute(async (req, res) => {
  const ticketId = req.params.id;
  const { ticket, conversations } = await fetchTicket(ticketId);
  const agents = await fetchAllAgents();
  // Augment agents map from inline conversation requesters (handles deactivated
  // agents the bootstrap endpoint excludes — only available on the session path).
  conversations.forEach(c => {
    if (c.user_id && !agents[c.user_id] && c.requester) {
      const name = c.requester.name || c.requester.email || null;
      if (name) agents[c.user_id] = name;
    }
  });
  // Last resort: per-id lookup for anything still unresolved.
  const candidateIds = [ticket.responder_id, ...conversations.map(c => c.user_id)];
  await fillMissingAgentNames(agents, candidateIds);
  res.json({ success: true, ticket, conversations, agents });
}));


// filter → { priority, status } mapping — Freshdesk priority: 1=Low, 2=Medium, 3=High, 4=Urgent
const GUIDED_FILTERS = {
  low:     { priorities: [1],    status: FD_STATUS.OPEN },
  medium:  { priorities: [2],    status: FD_STATUS.OPEN },
  high:    { priorities: [3, 4], status: FD_STATUS.OPEN },
  pending: { priorities: [],     status: FD_STATUS.PENDING },
};

app.get('/guided-prewarm/tickets', async (req, res) => {
  const domain  = process.env.FRESHDESK_DOMAIN;
  const agentId = process.env.FRESHDESK_AGENT_ID;
  if (!agentId) return res.status(500).json({ error: 'FRESHDESK_AGENT_ID not set' });
  const auth = getAuthHeader();

  const filterKey = (req.query.filter || 'low').toLowerCase();
  const filter = GUIDED_FILTERS[filterKey] || GUIDED_FILTERS.low;
  console.log(`[guided-prewarm] fetching ${filterKey} tickets for agent ${agentId}`);

  // Fetch each priority bucket separately (Freshdesk search has no OR operator)
  const priorityBuckets = filter.priorities.length ? filter.priorities : [null];
  let tickets = [];
  const seenIds = new Set();

  for (const priority of priorityBuckets) {
    for (let page = 1; page <= 10; page++) {
      const parts = [`agent_id:${agentId}`, `status:${filter.status}`];
      if (priority) parts.push(`priority:${priority}`);
      const q = parts.join(' AND ');
      const url = `https://${domain}/api/v2/search/tickets?query="${q.replace(/ /g, '%20')}"&page=${page}`;
      console.log(`[guided-prewarm] fetching ${url}`);
      const r = await fetch(url, { headers: { Authorization: auth } });
      if (!r.ok) {
        const b = await r.text();
        console.error(`[guided-prewarm] freshdesk error ${r.status}: ${b.slice(0,200)}`);
        return res.status(500).json({ error: `Freshdesk error: ${b.slice(0,200)}` });
      }
      const data = await r.json();
      const batch = data.results || [];
      console.log(`[guided-prewarm] priority ${priority ?? 'any'} page ${page}: ${batch.length} tickets`);
      for (const t of batch) {
        if (!seenIds.has(t.id)) { seenIds.add(t.id); tickets.push(t); }
      }
      if (batch.length < 30) break;
    }
  }
  console.log(`[guided-prewarm] total: ${tickets.length} tickets`);
  res.json({ success: true, tickets });
});

// Analyse a single ticket — conversation check + Groq booking ID extraction
app.get('/guided-prewarm/analyse/:id', async (req, res) => {
  const ticketId = req.params.id;
  const domain   = process.env.FRESHDESK_DOMAIN;
  const auth     = getAuthHeader();
  console.log(`[analyse] ticket #${ticketId}`);

  try {
    // Ticket + conversations via the unified ticket service (session cookie
    // primary, API-key fallback). Inline-requester data on each conversation
    // is currently unused here but may help future refinements.
    const { ticket, conversations: convData } = await fetchTicket(ticketId);
    const requesterEmail = ticket.requester?.email || null;
    const conversationCount = convData.length;
    console.log(`[analyse] ticket #${ticketId} — ${conversationCount} conversations`);

    // Groq: extract booking ID
    console.log(`[analyse] running Groq extraction`);
    const { bookingId, isNewBooking } = await extractBookingId(ticket, conversationCount);
    console.log(`[analyse] bookingId=${bookingId} isNewBooking=${isNewBooking}`);

    // Try to fetch booking
    let bookingData = null;
    let cleanHtmlForNote = null;
    if (bookingId) {
      try {
        const cached = await (require('./services/dbService').getCachedBooking)(bookingId);
        if (cached && cached.parsed) {
          console.log(`[analyse] booking ${bookingId} from cache`);
          bookingData = cached.parsed;
          if (!bookingData.supplier) bookingData.supplier = lookupSupplier(bookingData.booking.supplierName);
          if (cached.booking_html) cleanHtmlForNote = parseBookingHtml(cached.booking_html).cleanHtml;
        } else {
          console.log(`[analyse] fetching booking ${bookingId} from TA`);
          const fetched = await fetchAndCacheBooking(bookingId);
          bookingData = fetched;
          cleanHtmlForNote = fetched.cleanHtml;
        }
      } catch (e) {
        console.warn(`[analyse] could not fetch booking ${bookingId}: ${e.message}`);
      }
    }

    // Attach noteHtml to bookingData
    if (bookingData) {
      const { booking, details, user, supplier } = bookingData;
      bookingData.noteHtml = buildNoteHtml(booking, cleanHtmlForNote || '', details, user, supplier || lookupSupplier(booking.supplierName));
    }

    // Fallback: if no booking found, look up member by requester email
    let userData = null;
    if (!bookingData && requesterEmail) {
      try {
        console.log(`[analyse] no booking — searching user by email: ${requesterEmail}`);
        const results = await findUser(requesterEmail);
        if (results.length > 0) {
          const u = results[0];
          const TA_BASE = process.env.TA_BASE_URL || 'https://traveladvantage.com';
          userData = {
            ...u,
            loginLink:   `${TA_BASE}/admin/account/webadminCustomerLogin/${u.id}`,
            profileLink: `${TA_BASE}/admin/account/viewCustomer/${u.id}`,
          };
          console.log(`[analyse] user found: ${u.name} (${u.email})`);
        }
      } catch (e) {
        console.warn(`[analyse] user fallback failed: ${e.message}`);
      }
    }

    res.json({ skip: false, conversationCount, bookingId, isNewBooking, bookingData, userData });
  } catch (err) {
    console.error(`[analyse] error for ticket #${ticketId}: ${err.message}`, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Fetch booking by ID (for manual entry)
app.get('/guided-prewarm/booking/:id', async (req, res) => {
  const bookingId = req.params.id;
  try {
    let bookingData;
    let cleanHtmlForNote = null;
    const cached = await (require('./services/dbService').getCachedBooking)(bookingId);
    if (cached && cached.parsed) {
      bookingData = cached.parsed;
      if (!bookingData.supplier) bookingData.supplier = lookupSupplier(bookingData.booking.supplierName);
      if (cached.booking_html) cleanHtmlForNote = parseBookingHtml(cached.booking_html).cleanHtml;
    } else {
      const fetched = await fetchAndCacheBooking(bookingId);
      bookingData = fetched;
      cleanHtmlForNote = fetched.cleanHtml;
    }
    const { booking, details, user, supplier } = bookingData;
    bookingData.noteHtml = buildNoteHtml(booking, cleanHtmlForNote || '', details, user, supplier || lookupSupplier(booking.supplierName));
    res.json({ success: true, bookingData });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Execute actions for a confirmed ticket
app.post('/guided-prewarm/confirm', async (req, res) => {
  const { ticketId, bookingId, action, noteHtml } = req.body;
  if (!ticketId || !bookingId || !action) return res.status(400).json({ error: 'ticketId, bookingId, and action are required' });
  try {
    const results = await confirmTicket(ticketId, bookingId, action, noteHtml || null);
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bulk confirm ─────────────────────────────────────────────────────────────
app.post('/bulk-confirm', async (req, res) => {
  const { tag } = req.body;
  if (!tag) return res.status(400).json({ error: 'tag is required' });

  const domain = process.env.FRESHDESK_DOMAIN;
  const auth   = getAuthHeader();

  console.log(`[bulk-confirm] fetching tickets with tag "${tag}"`);

  // Debug: try bare tag query first
  const testUrl = `https://${domain}/api/v2/search/tickets?query="tag:'${tag}'"`;
  console.log(`[bulk-confirm] test query: ${testUrl}`);
  const testR = await fetch(testUrl, { headers: { Authorization: auth } });
  const testData = await testR.json();
  console.log(`[bulk-confirm] bare tag results: ${testData.total || 0} total, ${(testData.results||[]).length} returned`);

  // Fetch open tickets with tag, then pending — merge results
  let tickets = [];
  for (const status of [2, 3]) {
    for (let page = 1; page <= 10; page++) {
      const q = `tag:'${tag}' AND status:${status}`;
      const url = `https://${domain}/api/v2/search/tickets?query="${q.replace(/ /g, '%20')}"&page=${page}`;
      console.log(`[bulk-confirm] fetching ${url}`);
      const r = await fetch(url, { headers: { Authorization: auth } });
      if (!r.ok) {
        const body = await r.text();
        console.warn(`[bulk-confirm] freshdesk search error ${r.status}: ${body.slice(0,200)}`);
        break;
      }
      const data = await r.json();
      const batch = data.results || [];
      console.log(`[bulk-confirm] status=${status} page=${page} → ${batch.length} results`);
      tickets.push(...batch);
      if (batch.length < 30) break;
    }
  }

  // Deduplicate by ticket id
  const seen = new Set();
  tickets = tickets.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
  console.log(`[bulk-confirm] total unique tickets: ${tickets.length}`);

  const bookings = [];
  const errors   = [];

  for (const ticket of tickets) {
    try {
      // Check cache first
      let parsed = null;
      const cached = await getCachedBooking(ticket.id.toString());

      if (cached && cached.parsed) {
        parsed = cached.parsed;
      } else {
        // Try to extract booking ID from subject/description
        const content = [ticket.subject || '', ticket.description_text || ticket.description || ''].join('\n').slice(0, 2000);
        const idMatch = content.match(/\b([A-Z0-9]{5,20})\b/g);
        if (!idMatch) { errors.push({ ticketId: ticket.id, subject: ticket.subject, reason: 'No booking ID found' }); continue; }

        // Try each candidate
        let found = false;
        for (const candidate of idMatch.slice(0, 5)) {
          try {
            const fetched = await fetchAndCacheBooking(candidate);
            if (fetched) { parsed = fetched; found = true; break; }
          } catch (e) { /* try next */ }
        }
        if (!found) { errors.push({ ticketId: ticket.id, subject: ticket.subject, reason: 'Could not fetch booking' }); continue; }
      }

      const { booking, details } = parsed;
      bookings.push({
        ticketId:        ticket.id,
        subject:         ticket.subject,
        internalId:      booking.internalBookingId,
        supplierId:      booking.supplierId,
        guestName:       booking.guestName,
        checkIn:         booking.checkIn,
        checkOut:        booking.checkOut,
        roomType:        booking.mwrRoomType || booking.supplierRoomType,
        paxLine:         details?.paxLine || null,
        requests:        details?.requests || null,
        hotelName:       details?.hotelName || booking.supplierName,
      });
    } catch (err) {
      errors.push({ ticketId: ticket.id, subject: ticket.subject, reason: err.message });
    }
  }

  res.json({ success: true, bookings, errors, total: tickets.length });
});

// ─── Chat prep — resolve requester email from ticket ─────────────────────────
app.get('/chat-prep/:ticketId', async (req, res) => {
  const ticketId = req.params.ticketId;
  const domain   = process.env.FRESHDESK_DOMAIN;
  const auth     = getAuthHeader();
  try {
    const tRes = await fetch(`https://${domain}/api/v2/tickets/${ticketId}`, { headers: { Authorization: auth } });
    if (!tRes.ok) return res.status(500).json({ error: 'Could not fetch ticket' });
    const ticket = await tRes.json();
    const requesterId = ticket.requester_id;
    if (!requesterId) return res.status(404).json({ error: 'No requester on ticket' });

    const cRes = await fetch(`https://${domain}/api/v2/contacts/${requesterId}`, { headers: { Authorization: auth } });
    if (!cRes.ok) return res.status(500).json({ error: 'Could not fetch contact' });
    const contact = await cRes.json();
    res.json({ success: true, email: contact.email, name: contact.name, subject: ticket.subject });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Settings: Prompts ────────────────────────────────────────────────────────
app.get('/settings/prompts', async (req, res) => {
  try { res.json(await getPrompts()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/settings/prompts', async (req, res) => {
  const { label, text } = req.body;
  if (!label || !text) return res.status(400).json({ error: 'label and text required' });
  try { res.json(await createPrompt({ label, text })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/settings/prompts/:id', async (req, res) => {
  const { label, text } = req.body;
  if (!label || !text) return res.status(400).json({ error: 'label and text required' });
  try { res.json(await updatePrompt(req.params.id, { label, text })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/settings/prompts/:id', async (req, res) => {
  try { await deletePrompt(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Settings: Macros ─────────────────────────────────────────────────────────
app.get('/settings/macros', async (req, res) => {
  try { res.json(await getMacros()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/settings/macros', async (req, res) => {
  const { name, text } = req.body;
  if (!name || !text) return res.status(400).json({ error: 'name and text required' });
  try { res.json(await createMacro({ name, text })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/settings/macros/:id', async (req, res) => {
  const { name, text } = req.body;
  if (!name || !text) return res.status(400).json({ error: 'name and text required' });
  try { res.json(await updateMacro(req.params.id, { name, text })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/settings/macros/:id', async (req, res) => {
  try { await deleteMacro(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Quick translation via Google Translate (free public endpoint) ───────────
// Used by per-message and per-reply translate buttons. Faster + cheaper than
// routing through Groq for simple translations. The chat cleanup flow stays
// on Groq because it does cleanup + translation + summary in one shot.
const LANG_NAME_TO_CODE = {
  english:'en', spanish:'es', french:'fr', portuguese:'pt', italian:'it',
  german:'de', russian:'ru', dutch:'nl', arabic:'ar', chinese:'zh-CN',
  japanese:'ja', korean:'ko', polish:'pl', turkish:'tr', hindi:'hi',
  greek:'el', hebrew:'he', romanian:'ro', czech:'cs', swedish:'sv',
  danish:'da', finnish:'fi', norwegian:'no', hungarian:'hu', ukrainian:'uk',
  bulgarian:'bg', vietnamese:'vi', thai:'th', indonesian:'id', malay:'ms',
  filipino:'tl', tagalog:'tl', mongolian:'mn', persian:'fa', farsi:'fa',
  urdu:'ur', bengali:'bn', tamil:'ta', telugu:'te', marathi:'mr',
  croatian:'hr', serbian:'sr', slovak:'sk', slovene:'sl', slovenian:'sl',
  estonian:'et', latvian:'lv', lithuanian:'lt', albanian:'sq',
  catalan:'ca', galician:'gl', basque:'eu', welsh:'cy', irish:'ga',
  swahili:'sw',
};

function normalizeLang(input, fallback = 'en') {
  if (!input) return fallback;
  const t = String(input).trim().toLowerCase();
  if (t === 'auto') return 'auto';
  if (/^[a-z]{2}(-[a-z]{2,4})?$/i.test(t)) return t;
  return LANG_NAME_TO_CODE[t] || fallback;
}

app.post('/translate', async (req, res) => {
  const { text, target = 'en', source = 'auto' } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text required' });
  const tl = normalizeLang(target, 'en');
  const sl = normalizeLang(source, 'auto');
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error(`Google Translate returned ${r.status}`);
    const data = await r.json();
    // Google's response is an array of segments — each is
    // [translated, original, ...]. Whitespace/newline segments often have an
    // empty translation but carry the original chunk in seg[1]; falling back
    // to seg[1] preserves paragraph breaks and other inter-sentence whitespace.
    const translated = (Array.isArray(data?.[0]) ? data[0] : [])
      .map(seg => seg?.[0] || seg?.[1] || '')
      .join('');
    const detectedLang = data?.[2] || null;
    res.json({ success: true, text: translated, detectedLang });
  } catch (err) {
    console.error('[/translate] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── AI assist ────────────────────────────────────────────────────────────────
app.post('/ai-assist', async (req, res) => {
  const { booking, details, user, supplier, prompt, freshdeskTicketId } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  console.log(`[ai-assist] prompt: "${prompt.slice(0, 60)}..."`);
  try {
    let ticketContext = null;
    if (freshdeskTicketId) {
      try {
        ticketContext = await getTicketContext(freshdeskTicketId);
        console.log(`[ai-assist] ticket context: "${ticketContext.subject}"`);
      } catch (e) {
        console.warn(`[ai-assist] could not fetch ticket context: ${e.message}`);
      }
    }

    const text = await aiAssist({ booking, details, user, supplier, ticketContext, prompt });
    console.log(`[ai-assist] ${text.length} chars`);
    res.json({ success: true, text });
  } catch (err) {
    console.error('[ai-assist] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
