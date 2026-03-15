require('dotenv').config();
const express = require('express');
const { parseDataRow, parseBookingHtml } = require('./services/parserService');
const { parseUserHtml }                  = require('./services/userService');
const { buildNoteHtml }                  = require('./services/noteBuilder');
const { lookupSupplier }                 = require('./services/supplierService');
const { findHotelEmail }                 = require('./services/geminiService');
const { addNote, sendEmail, setTicketPending } = require('./services/freshdeskService');

const app = express();
app.use(express.json({ limit: '5mb' }));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Parse + build note (no Freshdesk write yet) ──────────────────────────────
// Receives raw HTML pages and DataTables row from userscript.
// Returns formatted note HTML for agent preview.
app.post('/new-booking', async (req, res) => {
  const { dataRow, bookingHtml, userHtml, freshdeskTicketId } = req.body;

  if (!dataRow || !bookingHtml || !userHtml || !freshdeskTicketId) {
    return res.status(400).json({ error: 'dataRow, bookingHtml, userHtml, and freshdeskTicketId are required' });
  }

  console.log(`\n📦 New booking — ticketId=${freshdeskTicketId}`);

  try {
    const booking              = parseDataRow(dataRow);
    const { cleanHtml, details } = parseBookingHtml(bookingHtml);
    const user                 = parseUserHtml(userHtml);
    const supplier             = lookupSupplier(booking.supplierName);

    console.log(`✅ Parsed: ${booking.productType} — ${booking.guestName} — ${booking.supplierName}`);
    if (supplier) console.log(`📬 Supplier contact found: ${supplier.email || supplier.contactUrl}`);

    const noteHtml = buildNoteHtml(booking, cleanHtml, user, supplier);

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

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
