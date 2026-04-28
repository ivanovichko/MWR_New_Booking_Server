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
initDb().catch(err => console.error('❌ DB init failed:', err.message));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Auth page ────────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'auth.html')));

// ─── Freshdesk Session ────────────────────────────────────────────────────────
app.post('/freshdesk-session', async (req, res) => {
  const { cookie, csrfToken } = req.body;
  if (!cookie) return res.status(400).json({ error: 'cookie is required' });
  try {
    await storeFreshdeskSession(cookie, csrfToken || null);
    console.log(`✅ Freshdesk session stored (cookie len: ${cookie.length}, csrf: ${csrfToken ? 'yes' : 'no'})`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Freshdesk session store error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── TA Session: manually paste cookie value ──────────────────────────────────
app.post('/ta-session', async (req, res) => {
  const { cookie } = req.body;
  if (!cookie) return res.status(400).json({ error: 'cookie is required' });
  try {
    await storeSession(cookie);
    console.log(`✅ TA session stored (length: ${cookie.length})`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Session store error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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
  console.log(`\n🔍 Booking lookup — ${bookingId}`);

  try {
    let cached = await getCachedBooking(bookingId);
    let fromCache = true;

    if (!cached) {
      console.log(`⚠️  Cache miss — live fetching ${bookingId}`);
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
    console.error('❌ Booking lookup error:', err.message);
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

  console.log(`\n📦 /new-booking (legacy) — ticketId=${freshdeskTicketId}`);

  try {
    const booking              = parseDataRow(dataRow);
    const { cleanHtml, details } = parseBookingHtml(bookingHtml);
    const user                 = parseUserHtml(userHtml);
    const supplier             = lookupSupplier(booking.supplierName);

    console.log(`✅ Parsed: ${booking.productType} — ${booking.guestName} — ${booking.supplierName}`);

    const noteHtml = buildNoteHtml(booking, cleanHtml, details, user, supplier);

    if (booking.internalBookingId) {
      cacheBooking({
        bookingId: booking.internalBookingId,
        dataRow, bookingHtml, userHtml,
        parsed: { booking, details, user },
      }).catch(e => console.warn('⚠️ Cache write failed:', e.message));
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
    console.error('❌ Error in /new-booking:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Post note to Freshdesk (agent confirmed) ─────────────────────────────────
app.post('/post-note', async (req, res) => {
  const { freshdeskTicketId, noteHtml } = req.body;

  if (!freshdeskTicketId || !noteHtml) {
    return res.status(400).json({ error: 'freshdeskTicketId and noteHtml are required' });
  }

  try {
    await addNoteWithImages(freshdeskTicketId, noteHtml);
    console.log(`✅ Note posted to ticket ${freshdeskTicketId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error in /post-note:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Find hotel email via Groq (hotels only) ──────────────────────────────────
app.post('/find-hotel-email', async (req, res) => {
  const { hotelName, hotelAddress, hotelCountry } = req.body;

  if (!hotelName) {
    return res.status(400).json({ error: 'hotelName is required' });
  }

  console.log(`\n🔍 Hotel email search — ${hotelName}`);

  try {
    const result = await findHotelEmail(hotelName, hotelAddress, hotelCountry);
    console.log(`✅ Groq result: ${result.email} (${result.confidence})`);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ Error in /find-hotel-email:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Send hotel email + set ticket pending (agent confirmed) ──────────────────
app.post('/send-hotel-email', async (req, res) => {
  const { freshdeskTicketId, hotelEmail, booking, details } = req.body;

  if (!freshdeskTicketId || !hotelEmail || !booking) {
    return res.status(400).json({ error: 'freshdeskTicketId, hotelEmail, and booking are required' });
  }

  console.log(`\n✉️  Sending hotel email — ticketId=${freshdeskTicketId} to=${hotelEmail}`);

  try {
    const emailBody = buildHotelEmailHtml(booking, details || {});
    await sendEmail(
      freshdeskTicketId,
      hotelEmail,
      `Prepaid Reservation Confirmation — ${booking.guestName} / ${booking.checkIn}`,
      emailBody
    );
    console.log('✅ Email sent to', hotelEmail);

    await setTicketPending(freshdeskTicketId);
    console.log('✅ Ticket set to Pending');

    res.json({ success: true, emailSent: true, hotelEmail });
  } catch (err) {
    console.error('❌ Error in /send-hotel-email:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Tag ticket + set type ────────────────────────────────────────────────────
app.post('/tag-ticket', async (req, res) => {
  const { freshdeskTicketId, tags, type } = req.body;
  if (!freshdeskTicketId || !tags) {
    return res.status(400).json({ error: 'freshdeskTicketId and tags are required' });
  }
  try {
    await tagTicket(freshdeskTicketId, tags, type);
    console.log(`🏷️  Tagged ticket ${freshdeskTicketId}: ${tags.join(', ')}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error in /tag-ticket:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Merge ticket ─────────────────────────────────────────────────────────────
app.post('/merge-ticket', async (req, res) => {
  const { sourceTicketId, targetTicketId, description } = req.body;
  if (!sourceTicketId || !targetTicketId) return res.status(400).json({ error: 'sourceTicketId and targetTicketId required' });

  const domain = process.env.FRESHDESK_DOMAIN;
  const auth   = getAuthHeader();

  try {
    const sourceLink = `https://mwrlife.freshdesk.com/a/tickets/${sourceTicketId}`;
    const descHtml = description || '';
    console.log(`🔀 desc length: ${descHtml.length}`);
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
    if (!sourceNoteRes.ok) { const b = await sourceNoteRes.text(); console.warn(`⚠️ Note on source failed: ${b.slice(0,100)}`); }

    // Close source ticket
    const closeBody = JSON.stringify({ status: FD_STATUS.CLOSED, type: 'Reservations' });
    console.log(`🔒 Closing ticket ${sourceTicketId} with body: ${closeBody}`);
    const closeRes = await fetch(`https://${domain}/api/v2/tickets/${sourceTicketId}`, {
      method: 'PUT',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: closeBody,
    });
    if (!closeRes.ok) { const b = await closeRes.text(); console.error(`❌ Close failed ${closeRes.status}: ${b}`); throw new Error(`Close failed: ${b.slice(0,200)}`); }

    console.log(`🔀 Merged ticket #${sourceTicketId} → #${targetTicketId}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`❌ Merge error: ${err.message}`);
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
    console.log(`🔒 Closing ticket ${ticketId} with body: ${closeBody2}`);
    const r = await fetch(`https://${domain}/api/v2/tickets/${ticketId}`, {
      method: 'PUT',
      headers: {
        'Authorization': getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: closeBody2,
    });
    if (!r.ok) { const b = await r.text(); console.error(`❌ Close failed ${r.status}: ${b}`); throw new Error(`${r.status}: ${b.slice(0,200)}`); }
    console.log(`✅ Closed ticket ${ticketId}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`❌ Close ticket error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Update ticket fields (tags, status, priority, etc.) ─────────────────────
app.post('/update-ticket', async (req, res) => {
  const { ticketId, fields } = req.body;
  if (!ticketId || !fields) return res.status(400).json({ error: 'ticketId and fields required' });
  try {
    await updateTicket(String(ticketId), fields);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Shared: fetch agent id→name map (uses session cookie via fdGet) ─────────
// /api/v2/agents requires admin scope (403 for non-admin keys & sessions).
// /api/_/bootstrap/agents_groups is the internal endpoint the Freshdesk web
// UI uses to populate assignee dropdowns — works for any logged-in agent.
// In-memory cache keeps Render hot — agent rosters rarely change.
let _agentMapCache = null;
let _agentMapCacheTime = 0;
const AGENT_MAP_TTL_MS = 10 * 60 * 1000; // 10 min

async function fetchAgentMap() {
  if (_agentMapCache && Date.now() - _agentMapCacheTime < AGENT_MAP_TTL_MS) {
    return _agentMapCache;
  }
  try {
    const data = await fdGet('/api/_/bootstrap/agents_groups');
    const agents = data?.data?.agents || [];
    const map = {};
    agents.forEach(a => {
      const name = a.contact?.name || a.contact?.email || null;
      if (name) map[a.id] = name;
    });
    _agentMapCache = map;
    _agentMapCacheTime = Date.now();
    return map;
  } catch (e) {
    console.warn(`[fetchAgentMap] fdGet failed: ${e.message}`);
    return _agentMapCache || {};
  }
}

// ─── Check for duplicate tickets ─────────────────────────────────────────────
app.post('/check-duplicates', async (req, res) => {
  const { vendorConf, internalId, memberEmail, freshdeskTicketId } = req.body;
  try {
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
    console.log(`🔍 Duplicate check for ${vendorConf}/${internalId}/${memberEmail}: ${duplicates.length} found`);
    res.json({ success: true, duplicates });
  } catch (err) {
    console.error('❌ Error in /check-duplicates:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual ticket search (for merge) ────────────────────────────────────────
app.post('/search-tickets', async (req, res) => {
  const { query, includeClosed, freshdeskTicketId } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    const [results, agentMap] = await Promise.all([
      searchDuplicates(query, freshdeskTicketId || null, false, !!includeClosed),
      fetchAgentMap(),
    ]);
    const duplicates = results.map(t => ({
      ...t,
      matchedBy: ['manual search'],
      responder_name: t.responder_id ? (agentMap[t.responder_id] || null) : null,
    }));
    console.log(`🔍 Manual ticket search "${query}": ${duplicates.length} found`);
    res.json({ success: true, duplicates });
  } catch (err) {
    console.error('❌ Error in /search-tickets:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Find user (search primary + secondary) ───────────────────────────────────
app.post('/find-user', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });
  console.log(`\n👤 User search — "${query}"`);
  try {
    const results = await findUser(query);
    console.log(`✅ User search: ${results.length} result(s)`);
    res.json({ success: true, results });
  } catch (err) {
    console.error('❌ Error in /find-user:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Full user profile ────────────────────────────────────────────────────────
app.get('/user/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`\n👤 User profile — ${id}`);
  try {
    const html = await taGet(`https://traveladvantage.com/admin/account/viewCustomer/${id}`);
    const user = parseUserHtml(html);
    res.json({ success: true, user });
  } catch (err) {
    console.error('❌ Error in /user/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── User reservation history ─────────────────────────────────────────────────
app.get('/user/:id/reservations', async (req, res) => {
  const { id } = req.params;
  console.log(`\n📋 Reservation history — user ${id}`);
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
    console.error('❌ Error in /user/:id/reservations:', err.message);
    res.status(500).json({ error: err.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// ─── Extract booking ID from ticket + fetch + cache ───────────────────────────
app.post('/extract-booking-id', async (req, res) => {
  const { freshdeskTicketId } = req.body;
  if (!freshdeskTicketId) return res.status(400).json({ error: 'freshdeskTicketId is required' });

  console.log(`\n🔍 Extract booking ID — ticket ${freshdeskTicketId}`);
  try {
    const ticketContext = await getTicketContext(freshdeskTicketId);
    const { bookingId } = await extractBookingId({
      subject:          ticketContext.subject,
      description_text: ticketContext.description,
    });

    if (!bookingId) return res.json({ success: true, bookingId: null });

    console.log(`📦 Found booking ID: ${bookingId} — fetching from TA...`);
    await fetchAndCacheBooking(bookingId);
    console.log(`✅ Booking ${bookingId} cached`);
    res.json({ success: true, bookingId });
  } catch (err) {
    console.error('❌ Error in /extract-booking-id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Send outbound reply to supplier or customer ──────────────────────────────
// Accepts multipart/form-data (with files[]) or plain JSON (no attachments).
app.post('/send-reply', upload.array('files'), async (req, res) => {
  const { freshdeskTicketId, toEmail, bodyHtml } = req.body;
  if (!freshdeskTicketId || !toEmail || !bodyHtml)
    return res.status(400).json({ error: 'freshdeskTicketId, toEmail, and bodyHtml are required' });

  const files = req.files || [];
  console.log(`\n📤 Outbound reply — ticket ${freshdeskTicketId} → ${toEmail} (${files.length} attachment(s))`);
  try {
    if (files.length > 0) {
      await sendEmailWithAttachments(freshdeskTicketId, toEmail, bodyHtml, files);
    } else {
      await sendEmail(freshdeskTicketId, toEmail, null, bodyHtml);
    }
    console.log(`✅ Reply sent to ${toEmail}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error in /send-reply:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Attachment proxy — fetches Freshdesk attachment with API auth ────────────
// Usage: GET /attachment?url=<encoded attachment_url>
app.get('/attachment', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('url param required');
  try {
    const upstream = await fetch(url, { headers: { Authorization: getAuthHeader() } });
    if (!upstream.ok) return res.status(upstream.status).send('Upstream error');
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    const cd = upstream.headers.get('content-disposition');
    res.set('Content-Type', ct);
    if (cd) res.set('Content-Disposition', cd);
    upstream.body.pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

/**
 * Fetches all pages of a ticket's conversations (Freshdesk max 100/page).
 * Returns a flat array of all conversation objects.
 */
// Bulk agent map for ticket conversations — same source as fetchAgentMap.
// Kept as a separate function name for clarity at call sites and to allow
// future divergence (e.g. caching tier or shape).
async function fetchAllAgents() {
  return { ...(await fetchAgentMap()) };
}

// Per-id resolution cache (survives across requests; agent names rarely change)
const _agentNameCache = new Map(); // id -> name | false (false = confirmed unresolvable)

async function resolveAgentName(id) {
  if (id == null) return null;
  if (_agentNameCache.has(id)) {
    const v = _agentNameCache.get(id);
    return v === false ? null : v;
  }
  const tryGet = async (path) => {
    try { return await fdGet(path); } catch { return null; }
  };
  const a = await tryGet(`/api/v2/agents/${id}`);
  if (a) {
    const name = a.contact?.name || a.name || a.contact?.email || null;
    if (name) { _agentNameCache.set(id, name); return name; }
  }
  const c = await tryGet(`/api/v2/contacts/${id}`);
  if (c) {
    const name = c.name || c.email || null;
    if (name) { _agentNameCache.set(id, name); return name; }
  }
  _agentNameCache.set(id, false);
  return null;
}

// Given a base map and a list of candidate IDs, resolve missing entries via per-ID lookup.
async function fillMissingAgentNames(baseMap, ids) {
  const missing = [...new Set(ids.filter(id => id != null && baseMap[id] == null))];
  if (!missing.length) return baseMap;
  const resolved = await Promise.all(missing.map(id => resolveAgentName(id).then(name => [id, name])));
  for (const [id, name] of resolved) {
    if (name) baseMap[id] = name;
  }
  return baseMap;
}

async function fetchAllConversations(domain, auth, ticketId) {
  const all = [];
  let page = 1;
  while (true) {
    const url = `https://${domain}/api/v2/tickets/${ticketId}/conversations?per_page=100&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) break;
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break; // last page
    page++;
  }
  return all;
}

// Fast ticket fetch — ticket + full conversation thread, no Groq
app.get('/guided-prewarm/ticket/:id', async (req, res) => {
  const ticketId = req.params.id;
  const domain   = process.env.FRESHDESK_DOMAIN;
  const auth     = getAuthHeader();
  const headers  = { Authorization: auth };
  const tRes = await fetch(`https://${domain}/api/v2/tickets/${ticketId}?include=requester`, { headers });
  if (!tRes.ok) return res.status(500).json({ error: 'Could not fetch ticket' });
  const [ticket, conversations, agents] = await Promise.all([
    tRes.json(),
    fetchAllConversations(domain, auth, ticketId),
    fetchAllAgents(),
  ]);
  // Fill in any user_ids the bulk agent list missed (deactivated agents, contacts who posted notes, etc.)
  const candidateIds = [ticket.responder_id, ...conversations.map(c => c.user_id)];
  await fillMissingAgentNames(agents, candidateIds);
  res.json({ success: true, ticket, conversations, agents });
});


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
  console.log(`🎯 Guided prewarm: fetching ${filterKey} tickets for agent ${agentId}`);

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
      console.log(`🔍 Fetching: ${url}`);
      const r = await fetch(url, { headers: { Authorization: auth } });
      if (!r.ok) {
        const b = await r.text();
        console.error(`❌ Freshdesk error ${r.status}: ${b.slice(0,200)}`);
        return res.status(500).json({ error: `Freshdesk error: ${b.slice(0,200)}` });
      }
      const data = await r.json();
      const batch = data.results || [];
      console.log(`📋 Priority ${priority ?? 'any'} page ${page}: ${batch.length} tickets`);
      for (const t of batch) {
        if (!seenIds.has(t.id)) { seenIds.add(t.id); tickets.push(t); }
      }
      if (batch.length < 30) break;
    }
  }
  console.log(`📋 Total: ${tickets.length} tickets`);
  res.json({ success: true, tickets });
});

// Analyse a single ticket — conversation check + Groq booking ID extraction
app.get('/guided-prewarm/analyse/:id', async (req, res) => {
  const ticketId = req.params.id;
  const domain   = process.env.FRESHDESK_DOMAIN;
  const auth     = getAuthHeader();
  console.log(`🎯 Analysing ticket #${ticketId}`);

  try {
    // Fetch ticket (include requester for email fallback)
    const tRes = await fetch(`https://${domain}/api/v2/tickets/${ticketId}?include=requester`, { headers: { Authorization: auth } });
    if (!tRes.ok) return res.status(500).json({ error: `Could not fetch ticket: ${tRes.status}` });
    const ticket = await tRes.json();
    const requesterEmail = ticket.requester?.email || null;

    // Fetch all conversations (paginated)
    const convData = await fetchAllConversations(domain, auth, ticketId);
    const conversationCount = convData.length;
    console.log(`💬 Conversations: ${conversationCount}`);

    // Groq: extract booking ID
    console.log(`🤖 Running Groq extraction...`);
    const { bookingId, isNewBooking } = await extractBookingId(ticket, conversationCount);
    console.log(`📦 bookingId=${bookingId} isNewBooking=${isNewBooking}`);

    // Try to fetch booking
    let bookingData = null;
    let cleanHtmlForNote = null;
    if (bookingId) {
      try {
        const cached = await (require('./services/dbService').getCachedBooking)(bookingId);
        if (cached && cached.parsed) {
          console.log(`⚡ Booking ${bookingId} from cache`);
          bookingData = cached.parsed;
          if (!bookingData.supplier) bookingData.supplier = lookupSupplier(bookingData.booking.supplierName);
          if (cached.booking_html) cleanHtmlForNote = parseBookingHtml(cached.booking_html).cleanHtml;
        } else {
          console.log(`📡 Fetching booking ${bookingId} from TA...`);
          const fetched = await fetchAndCacheBooking(bookingId);
          bookingData = fetched;
          cleanHtmlForNote = fetched.cleanHtml;
        }
      } catch (e) {
        console.warn(`⚠️ Could not fetch booking ${bookingId}: ${e.message}`);
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
        console.log(`👤 No booking — searching user by email: ${requesterEmail}`);
        const results = await findUser(requesterEmail);
        if (results.length > 0) {
          const u = results[0];
          const TA_BASE = process.env.TA_BASE_URL || 'https://traveladvantage.com';
          userData = {
            ...u,
            loginLink:   `${TA_BASE}/admin/account/webadminCustomerLogin/${u.id}`,
            profileLink: `${TA_BASE}/admin/account/viewCustomer/${u.id}`,
          };
          console.log(`✅ User found: ${u.name} (${u.email})`);
        }
      } catch (e) {
        console.warn(`⚠️ User fallback failed: ${e.message}`);
      }
    }

    res.json({ skip: false, conversationCount, bookingId, isNewBooking, bookingData, userData });
  } catch (err) {
    console.error(`❌ Analyse error for ticket #${ticketId}: ${err.message}`, err.stack);
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

  console.log(`🏨 Bulk confirm: fetching tickets with tag "${tag}"`);

  // Debug: try bare tag query first
  const testUrl = `https://${domain}/api/v2/search/tickets?query="tag:'${tag}'"`;
  console.log(`🧪 Test query: ${testUrl}`);
  const testR = await fetch(testUrl, { headers: { Authorization: auth } });
  const testData = await testR.json();
  console.log(`🧪 Bare tag results: ${testData.total || 0} total, ${(testData.results||[]).length} returned`);

  // Fetch open tickets with tag, then pending — merge results
  let tickets = [];
  for (const status of [2, 3]) {
    for (let page = 1; page <= 10; page++) {
      const q = `tag:'${tag}' AND status:${status}`;
      const url = `https://${domain}/api/v2/search/tickets?query="${q.replace(/ /g, '%20')}"&page=${page}`;
      console.log(`🔍 Fetching: ${url}`);
      const r = await fetch(url, { headers: { Authorization: auth } });
      if (!r.ok) {
        const body = await r.text();
        console.warn(`⚠️ Freshdesk search error ${r.status}: ${body.slice(0,200)}`);
        break;
      }
      const data = await r.json();
      const batch = data.results || [];
      console.log(`📋 status:${status} page:${page} — ${batch.length} results`);
      tickets.push(...batch);
      if (batch.length < 30) break;
    }
  }

  // Deduplicate by ticket id
  const seen = new Set();
  tickets = tickets.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
  console.log(`📋 Total unique tickets: ${tickets.length}`);

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

// ─── AI assist ────────────────────────────────────────────────────────────────
app.post('/ai-assist', async (req, res) => {
  const { booking, details, user, supplier, prompt, freshdeskTicketId } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  console.log(`\n🤖 AI assist — prompt: "${prompt.slice(0, 60)}..."`);
  try {
    let ticketContext = null;
    if (freshdeskTicketId) {
      try {
        ticketContext = await getTicketContext(freshdeskTicketId);
        console.log(`📋 Ticket context fetched: "${ticketContext.subject}"`);
      } catch (e) {
        console.warn(`⚠️ Could not fetch ticket context: ${e.message}`);
      }
    }

    const text = await aiAssist({ booking, details, user, supplier, ticketContext, prompt });
    console.log(`✅ AI assist — ${text.length} chars`);
    res.json({ success: true, text });
  } catch (err) {
    console.error('❌ AI assist error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
