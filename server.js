require('dotenv').config();
const express = require('express');
const path    = require('path');
const { parseDataRow, parseBookingHtml } = require('./services/parserService');
const { parseUserHtml }                  = require('./services/userService');
const { buildNoteHtml }                  = require('./services/noteBuilder');
const { lookupSupplier }                 = require('./services/supplierService');
const { aiAssist, findHotelEmail }       = require('./services/aiService');
const { addNote, sendEmail, setTicketPending, tagTicket, searchDuplicates, getTicketContext } = require('./services/freshdeskService');
const { initDb, getCachedBooking, cacheBooking, storeSession, getPrompts, createPrompt, updatePrompt, deletePrompt, getMacros, createMacro, updateMacro, deleteMacro, storeFreshdeskSession } = require('./services/dbService');
const { prewarm, fetchAndCacheBooking, extractBookingId, checkPendings } = require('./services/prewarmService');
const { taGet, taPost }                                        = require('./services/taAuthService');

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

// ─── Hotel confirmation email builder ─────────────────────────────────────────
function buildHotelEmailHtml(booking, details = {}) {
  const v = (val) => val || '—';

  // Room details: MWR room type | board (from details.roomDetails which has full string)
  // details.roomDetails = "Standard room (standard room land view) | All-Inclusive x 1"
  // We want just the MWR part from booking.mwrRoomType + board from roomDetails
  let roomLine = null;
  if (details.roomDetails) {
    // Strip supplier room type in parentheses: "Standard room (standard room land view) | AI x 1"
    // → "Standard room | AI x 1"
    roomLine = details.roomDetails.replace(/\s*\([^)]*\)/, '').replace(/\s+/g, ' ').trim();
  } else if (booking.mwrRoomType) {
    roomLine = booking.mwrRoomType;
  }

  const lines = [
    details.hotelName    ? `<strong>${details.hotelName}</strong>` : null,
    details.hotelAddress ? details.hotelAddress : null,
    details.hotelPhone   ? details.hotelPhone   : null,
    ``,
    `<strong>Check-in:</strong> ${v(details.checkIn  || booking.checkIn)}`,
    `<strong>Check-out:</strong> ${v(details.checkOut || booking.checkOut)}`,
    roomLine             ? `<strong>Room Details:</strong> ${roomLine}` : null,
    details.bedTypes     ? `<strong>Bed Types:</strong> ${details.bedTypes}` : null,
    details.paxLine      ? details.paxLine : null,
    `<strong>Guest Name(s):</strong> ${v(details.guestName || booking.guestName)}`,
    details.requests     ? `<strong>Requests for the hotel:</strong> ${details.requests}` : null,
    details.arrivalTime  ? `<strong>Estimated Time of Arrival:</strong> ${details.arrivalTime}` : null,
    ``,
    `<strong>Vendor Confirmation Number:</strong> ${v(details.vendorConf || booking.supplierId)}`,
    `<strong>Reservation:</strong> ${v(details.reservation || booking.internalBookingId)}`,
  ].filter(l => l !== null);

  const signature = `
<br>
<p>Sincerely,<br>
Ivan K.<br>
Travel Advantage Support<br>
<span style="border-top:1px solid #ccc;display:block;padding-top:6px;margin-top:6px;">
member@traveladvantage.com<br>
Belgium: +32 71-96-32-66<br>
Colombia: +571 514-1218<br>
France: +33 27-68-63-387<br>
Germany: +49 911 96 959 007<br>
Italy: +39 02-94-755-846<br>
Peru: +511 707-3968<br>
Portugal: +35 13-0880-2148<br>
Spain: +34 95-156-81-76<br>
USA: +1 857 763 2085<br>
<a href="https://www.traveladvantage.com/">https://www.traveladvantage.com/</a>
</span></p>`;

  return `
<p>Hi, dear hotel team,</p>
<p>My name is Ivan, and I'm here with TravelAdvantage support team. I'm contacting you to confirm the prepaid reservation.</p>
<p>The details are as follows:</p>
<p>${lines.join('<br>')}</p>
<p>Kindly double-check and confirm the reservation, including the room and bed type, and please make a note of the customer arrival time or special requests (if listed).</p>
<p>Please let me know if you need any additional information from my end.</p>
<p>Thanks and looking forward to your reply</p>
${signature}`.trim();
}

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
    // Primary: name in URL path, email in POST body search[value]
    // Run both in parallel and merge results
    const primaryParams = (searchValue) => {
      const p = new URLSearchParams({
        draw: '1', start: '0', length: '10',
        'order[0][column]': '1', 'order[0][dir]': 'desc',
        'search[value]': searchValue, 'search[regex]': 'false',
      });
      const nonOrderable = [0, 8, 9, 10, 12, 14];
      for (let i = 0; i < 15; i++) {
        p.append(`columns[${i}][data]`, i.toString());
        p.append(`columns[${i}][name]`, '');
        p.append(`columns[${i}][searchable]`, 'true');
        p.append(`columns[${i}][orderable]`, nonOrderable.includes(i) ? 'false' : 'true');
        p.append(`columns[${i}][search][value]`, '');
        p.append(`columns[${i}][search][regex]`, 'false');
      }
      return p.toString();
    };

    // Secondary: query always goes in search[value] body
    // Orderable: only cols 1-8 are orderable (0 and 9 are not)
    const secondaryParams = new URLSearchParams({
      draw: '1', start: '0', length: '10',
      'order[0][column]': '1', 'order[0][dir]': 'desc',
      'search[value]': query, 'search[regex]': 'false',
    });
    for (let i = 0; i < 10; i++) {
      secondaryParams.append(`columns[${i}][data]`, i.toString());
      secondaryParams.append(`columns[${i}][name]`, '');
      secondaryParams.append(`columns[${i}][searchable]`, 'true');
      secondaryParams.append(`columns[${i}][orderable]`, (i === 0 || i === 9) ? 'false' : 'true');
      secondaryParams.append(`columns[${i}][search][value]`, '');
      secondaryParams.append(`columns[${i}][search][regex]`, 'false');
    }

    const primaryUrl = `https://traveladvantage.com/admin/account/customersList/All/All/null/null/All/All/${query.replace(/\//g, '%2F')}`;

    const primaryReferer   = { 'Referer': 'https://traveladvantage.com/admin/account/manageCustomers' };
    const secondaryReferer = { 'Referer': 'https://traveladvantage.com/admin/account/manageTravelers' };

    const [primaryRes, secondaryRes] = await Promise.all([
      taPost(primaryUrl, primaryParams(''), primaryReferer),
      taPost(`https://traveladvantage.com/admin/account/travelersList`, secondaryParams.toString(), secondaryReferer),
    ]);

    console.log(`👤 Primary: recordsFiltered=${primaryRes.recordsFiltered}, rows=${(primaryRes.data||[]).length}`);
    console.log(`👤 Secondary: recordsFiltered=${secondaryRes.recordsFiltered}, rows=${(secondaryRes.data||[]).length}`);

    const strip = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const extractCustomerId = (cell) => { const m = (cell||'').match(/viewCustomer\/(\d+)/); return m ? m[1] : null; };
    const extractTravelerId = (cell) => { const m = (cell||'').match(/editTraveler\((\d+)\)/); return m ? m[1] : null; };

    const primary = (primaryRes.data || []).map(row => ({
      type:     'primary',
      id:       extractCustomerId(row[0]),
      name:     strip(row[2]),
      memberId: strip(row[3]),
      instance: strip(row[4]),
      email:    strip(row[5]),
      phone:    strip(row[6]),
      country:  strip(row[7]),
      status:   strip(row[11]),
    })).filter(u => u.id);

    const secondary = (secondaryRes.data || []).map(row => ({
      type:          'secondary',
      id:            extractTravelerId(row[0]),
      name:          strip(row[2]),
      primaryMember: strip(row[3]),
      instance:      strip(row[4]),
      email:         strip(row[5]),
      phone:         strip(row[6]),
      status:        strip(row[7]),
    })).filter(u => u.id);

    const results = [...primary, ...secondary];
    console.log(`✅ User search: ${primary.length} primary, ${secondary.length} secondary`);
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

// ─── Bulk confirm ─────────────────────────────────────────────────────────────
app.post('/bulk-confirm', async (req, res) => {
  const { tag } = req.body;
  if (!tag) return res.status(400).json({ error: 'tag is required' });

  const domain = process.env.FRESHDESK_DOMAIN;
  const apiKey = process.env.FRESHDESK_API_KEY;
  const auth   = 'Basic ' + Buffer.from(`${apiKey}:X`).toString('base64');

  console.log(`🏨 Bulk confirm: fetching tickets with tag "${tag}"`);

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
  if (!booking || !prompt) return res.status(400).json({ error: 'booking and prompt are required' });

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
