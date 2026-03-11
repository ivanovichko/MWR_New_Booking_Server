require('dotenv').config();
const express = require('express');
const { findHotelEmail } = require('./services/geminiService');
const { addNote, sendEmail, setTicketPending } = require('./services/freshdeskService');

const app = express();
app.use(express.json());

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Step 1: Gemini email search + post Freshdesk note ───────────────────────
// Booking data is pre-parsed by the userscript (TA auth handled by browser).
// Returns all data to agent for review. Does NOT send email yet.
app.post('/new-booking', async (req, res) => {
  const { booking, freshdeskTicketId } = req.body;

  if (!booking || !freshdeskTicketId) {
    return res.status(400).json({ error: 'booking and freshdeskTicketId are required' });
  }

  console.log(`\n📦 New booking — hotel=${booking.hotelName} ticketId=${freshdeskTicketId}`);

  try {
    // ── Find hotel email via Gemini ────────────────────────────────────────
    console.log('⏳ Searching for hotel email via Gemini...');
    const geminiResult = await findHotelEmail(
      booking.hotelName,
      booking.hotelAddress,
      booking.hotelCountry
    );
    console.log(`✅ Gemini result: ${geminiResult.email} (${geminiResult.confidence})`);

    // ── Post internal note to Freshdesk ───────────────────────────────────
    console.log('⏳ Adding internal note to Freshdesk ticket...');
    await addNote(freshdeskTicketId, buildNoteHtml(booking, geminiResult));
    console.log('✅ Note added — awaiting agent confirmation to send email');

    res.json({
      success: true,
      booking,
      hotelEmail:      geminiResult.email,
      emailSource:     geminiResult.source,
      emailConfidence: geminiResult.confidence,
      emailNotes:      geminiResult.notes,
    });

  } catch (err) {
    console.error('❌ Error in /new-booking:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Step 2: Agent confirmed — send email + set ticket pending ────────────────
app.post('/send-hotel-email', async (req, res) => {
  const { freshdeskTicketId, hotelEmail, booking } = req.body;

  if (!freshdeskTicketId || !hotelEmail || !booking) {
    return res.status(400).json({ error: 'freshdeskTicketId, hotelEmail, and booking are required' });
  }

  console.log(`\n✉️  Sending hotel email — ticketId=${freshdeskTicketId} to=${hotelEmail}`);

  try {
    const emailBody = buildEmailHtml(booking);
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

// ─── Email template builder ───────────────────────────────────────────────────
function buildEmailHtml(booking) {
  const lines = [
    `<strong>Hotel:</strong> ${booking.hotelName}`,
    `<strong>Guest Name(s):</strong> ${booking.guestName}`,
    `<strong>Check-in:</strong> ${booking.checkIn}`,
    `<strong>Check-out:</strong> ${booking.checkOut}`,
    `<strong>Room Details:</strong> ${booking.roomType}${booking.boardCode ? ' | ' + booking.boardCode : ''}`,
    `<strong>Adults:</strong> ${booking.adults} &nbsp; <strong>Children:</strong> ${booking.children || 0}`,
    `<strong>Vendor Confirmation Number:</strong> ${booking.vendorConfirmationNumber}`,
    `<strong>Reservation:</strong> ${booking.internalBookingId}`,
  ];

  if (booking.estimatedArrivalTime) {
    lines.push(`<strong>Estimated Time of Arrival:</strong> ${booking.estimatedArrivalTime}`);
  }
  if (booking.specialRequests) {
    lines.push(`<strong>Special Requests:</strong> ${booking.specialRequests}`);
  }

  return `
<p>Hi, dear hotel team,</p>
<p>My name is Ivan, and I'm here with TravelAdvantage support team. I'm contacting you to confirm the prepaid reservation.</p>
<p>The details are as follows:</p>
<p>${lines.join('<br>')}</p>
<p>Kindly double-check and confirm the reservation, including the room and bed type, and please make a note of the customer arrival time or special requests (if listed).</p>
<p>Please let me know if you need any additional information from my end.</p>
<p>Thanks and looking forward to your reply</p>
  `.trim();
}

// ─── Internal note builder ────────────────────────────────────────────────────
function buildNoteHtml(booking, geminiResult) {
  return `
<p><strong>📦 New Booking Flow — Auto-generated note</strong></p>
<hr>
<p>
  <strong>Hotel:</strong> ${booking.hotelName}<br>
  <strong>Address:</strong> ${booking.hotelAddress}<br>
  <strong>Guest:</strong> ${booking.guestName}<br>
  <strong>Check-in:</strong> ${booking.checkIn}<br>
  <strong>Check-out:</strong> ${booking.checkOut}<br>
  <strong>Room:</strong> ${booking.roomType} | ${booking.boardCode}<br>
  <strong>Adults:</strong> ${booking.adults} / <strong>Children:</strong> ${booking.children || 0}<br>
  <strong>Vendor Confirmation:</strong> ${booking.vendorConfirmationNumber}<br>
  <strong>Internal Booking ID:</strong> ${booking.internalBookingId}<br>
  ${booking.estimatedArrivalTime ? `<strong>Arrival Time:</strong> ${booking.estimatedArrivalTime}<br>` : ''}
  ${booking.specialRequests ? `<strong>Special Requests:</strong> ${booking.specialRequests}<br>` : ''}
</p>
<hr>
<p>
  <strong>🤖 Hotel email lookup (Gemini)</strong><br>
  <strong>Email:</strong> ${geminiResult.email || 'Not found'}<br>
  <strong>Source:</strong> ${geminiResult.source || 'N/A'}<br>
  <strong>Confidence:</strong> ${geminiResult.confidence}<br>
  <strong>Notes:</strong> ${geminiResult.notes || 'N/A'}
</p>
  `.trim();
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
