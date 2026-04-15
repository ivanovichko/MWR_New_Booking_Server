require('dotenv').config();
const express = require('express');
const path    = require('path');
const { parseDataRow, parseBookingHtml } = require('./services/parserService');
const { parseUserHtml, findUser }        = require('./services/userService');
const { buildNoteHtml }                  = require('./services/noteBuilder');
const { lookupSupplier }                 = require('./services/supplierService');
const { aiAssist, findHotelEmail }       = require('./services/aiService');
const { getAuthHeader, addNote, sendEmail, setTicketPending, tagTicket, searchDuplicates, getTicketContext } = require('./services/freshdeskService');
const { initDb, getCachedBooking, cacheBooking, storeSession, getPrompts, createPrompt, updatePrompt, deletePrompt, getMacros, createMacro, updateMacro, deleteMacro, storeFreshdeskSession } = require('./services/dbService');
const { prewarm, fetchAndCacheBooking, extractBookingId, checkPendings, checkInPriority, setTicketPriority, postNote } = require('./services/prewarmService');
const { taGet, taPost }                  = require('./services/taAuthService');
const { buildHotelEmailHtml }            = require('./services/hotelEmailBuilder');
const { confirmTicket }                  = require('./services/ticketActionService');
const { FD_STATUS, PREWARM_CONVERSATION_THRESHOLD } = require('./config');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// ─── Init DB on startup ───────────────────────────────────────────────────────
initDb().catch(err => console.error('❌ DB init failed:', err.message));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Auth page ────────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'auth.html')));

// ─── Freshdesk Session ────────────────────────────────────────────────────────
app.post('/freshdesk-session', async (req, res) => {
  const { cookie } = req.body;
  if (!cookie) return res.status(400).json({ error: 'cookie is required' });
  try {
    await storeFreshdeskSession(cookie);
    console.log(`✅ Freshdesk session stored (length: ${cookie.length})`);
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
    await addNote(freshdeskTicketId, noteHtml);
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

// ─── Check for duplicate tickets ─────────────────────────────────────────────
app.post('/check-duplicates', async (req, res) => {
  const { vendorConf, internalId, memberEmail, freshdeskTicketId } = req.body;
  try {
    const [byVendor, byInternal, byEmail] = await Promise.all([
      vendorConf  ? searchDuplicates(vendorConf,  freshdeskTicketId) : [],
      internalId  ? searchDuplicates(internalId,  freshdeskTicketId) : [],
      memberEmail ? searchDuplicates(memberEmail, freshdeskTicketId, true) : [],
    ]);

    // Tag each result with its match source, merge and deduplicate by ticket id
    const seen = new Map();
    for (const t of byVendor)  { if (!seen.has(t.id)) seen.set(t.id, { ...t, matchedBy: ['supplier ref'] }); else seen.get(t.id).matchedBy.push('supplier ref'); }
    for (const t of byInternal){ if (!seen.has(t.id)) seen.set(t.id, { ...t, matchedBy: ['booking ID'] }); else seen.get(t.id).matchedBy.push('booking ID'); }
    for (const t of byEmail)   { if (!seen.has(t.id)) seen.set(t.id, { ...t, matchedBy: ['member email'] }); else seen.get(t.id).matchedBy.push('member email'); }

    const duplicates = [...seen.values()];
    console.log(`🔍 Duplicate check for ${vendorConf}/${internalId}/${memberEmail}: ${duplicates.length} found`);
    res.json({ success: true, duplicates });
  } catch (err) {
    console.error('❌ Error in /check-duplicates:', err.message);
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
app.post('/send-reply', async (req, res) => {
  const { freshdeskTicketId, toEmail, bodyHtml } = req.body;
  if (!freshdeskTicketId || !toEmail || !bodyHtml)
    return res.status(400).json({ error: 'freshdeskTicketId, toEmail, and bodyHtml are required' });

  console.log(`\n📤 Outbound reply — ticket ${freshdeskTicketId} → ${toEmail}`);
  try {
    await sendEmail(freshdeskTicketId, toEmail, null, bodyHtml);
    console.log(`✅ Reply sent to ${toEmail}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error in /send-reply:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fast ticket fetch — just HTML, no Groq
app.get('/guided-prewarm/ticket/:id', async (req, res) => {
  const ticketId = req.params.id;
  const domain   = process.env.FRESHDESK_DOMAIN;
  const auth     = getAuthHeader();
  const tRes = await fetch(`https://${domain}/api/v2/tickets/${ticketId}`, { headers: { Authorization: auth } });
  if (!tRes.ok) return res.status(500).json({ error: 'Could not fetch ticket' });
  const ticket = await tRes.json();
  res.json({ success: true, ticket });
});


app.get('/guided-prewarm/tickets', async (req, res) => {
  const domain  = process.env.FRESHDESK_DOMAIN;
  const agentId = process.env.FRESHDESK_AGENT_ID;
  if (!agentId) return res.status(500).json({ error: 'FRESHDESK_AGENT_ID not set' });
  const auth = getAuthHeader();
  console.log(`🎯 Guided prewarm: fetching low-priority tickets for agent ${agentId}`);

  let tickets = [];
  for (let page = 1; page <= 10; page++) {
    const q = `priority:1 AND agent_id:${agentId} AND status:${FD_STATUS.OPEN}`;
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
    console.log(`📋 Page ${page}: ${batch.length} tickets`);
    tickets.push(...batch);
    if (batch.length < 30) break;
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
    // Fetch ticket for Groq (needs subject + description_text)
    const tRes = await fetch(`https://${domain}/api/v2/tickets/${ticketId}`, { headers: { Authorization: auth } });
    if (!tRes.ok) return res.status(500).json({ error: `Could not fetch ticket: ${tRes.status}` });
    const ticket = await tRes.json();

    // Fetch conversation count in parallel
    const cRes = await fetch(`https://${domain}/api/v2/tickets/${ticketId}/conversations`, { headers: { Authorization: auth } });
    const convData = cRes.ok ? await cRes.json() : [];
    const conversationCount = Array.isArray(convData) ? convData.length : 0;
    console.log(`💬 Conversations: ${conversationCount}`);

    if (conversationCount > PREWARM_CONVERSATION_THRESHOLD) {
      console.log(`⏭ Skipping — convs > ${PREWARM_CONVERSATION_THRESHOLD}`);
      return res.json({ skip: true, reason: `conversations > ${PREWARM_CONVERSATION_THRESHOLD}` });
    }

    // Groq: extract booking ID
    console.log(`🤖 Running Groq extraction...`);
    const { bookingId, isNewBooking } = await extractBookingId(ticket, conversationCount);
    console.log(`📦 bookingId=${bookingId} isNewBooking=${isNewBooking}`);

    // Try to fetch booking
    let bookingData = null;
    if (bookingId) {
      try {
        const cached = await (require('./services/dbService').getCachedBooking)(bookingId);
        if (cached && cached.parsed) {
          console.log(`⚡ Booking ${bookingId} from cache`);
          bookingData = cached.parsed;
        } else {
          console.log(`📡 Fetching booking ${bookingId} from TA...`);
          bookingData = await fetchAndCacheBooking(bookingId);
        }
      } catch (e) {
        console.warn(`⚠️ Could not fetch booking ${bookingId}: ${e.message}`);
      }
    }

    res.json({ skip: false, conversationCount, bookingId, isNewBooking, bookingData });
  } catch (err) {
    console.error(`❌ Analyse error for ticket #${ticketId}: ${err.message}`, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Fetch booking by ID (for manual entry)
app.get('/guided-prewarm/booking/:id', async (req, res) => {
  const bookingId = req.params.id;
  try {
    const cached = await (require('./services/dbService').getCachedBooking)(bookingId);
    if (cached && cached.parsed) return res.json({ success: true, bookingData: cached.parsed });
    const bookingData = await fetchAndCacheBooking(bookingId);
    res.json({ success: true, bookingData });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Execute actions for a confirmed ticket
app.post('/guided-prewarm/confirm', async (req, res) => {
  const { ticketId, bookingId, action } = req.body;
  if (!ticketId || !bookingId || !action) return res.status(400).json({ error: 'ticketId, bookingId, and action are required' });
  try {
    const results = await confirmTicket(ticketId, bookingId, action);
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
