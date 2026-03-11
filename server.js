require('dotenv').config();
const express = require('express');
const { fetchBookingDetails } = require('./services/bookingService');
const { findHotelEmail } = require('./services/geminiService');
const { addNote, sendEmail, setTicketPending } = require('./services/freshdeskService');

const app = express();
app.use(express.json());

// ─── In-memory cookie store ───────────────────────────────────────────────────
// Updated automatically by TA Cookie Sync userscript on every TA page load
let taCookie = null;

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', cookieStored: !!taCookie }));

// ─── Cookie sync (called by TA Cookie Sync userscript) ───────────────────────
app.post('/update-cookie', (req, res) => {
  const { cookie } = req.body;
  if (!cookie) return res.status(400).json({ error: 'cookie is required' });
  taCookie = cookie;
  console.log('🍪 TA cookie updated');
  res.json({ success: true });
});

// ─── Step 1: Fetch booking + Gemini + post note ──────────────────────────────
// Returns all data to agent for review. Does NOT send email yet.
app.post('/new-booking', async (req, res) => {
  const { bookingId, freshdeskTicketId } = req.body;

  if (!bookingId || !freshdeskTicketId) {
    return res.status(400).json({ error: 'bookingId and freshdeskTicketId are required' });
  }

  if (!taCookie) {
    return res.status(400).json({
      error: 'No TravelAdvantage cookie stored. Open any TravelAdvantage admin page first to sync it.'
    });
  }

  console.log(`\n📦 New booking flow — bookingId=${bookingId} ticketId=${freshdeskTicketId}`);

  try {
    // ── Step 1: Fetch booking details from TravelAdvantage ─────────────────
    console.log('⏳ Step 1: Fetching booking details from TravelAdvantage...');
    const booking = await fetchBookingDetails(bookingId, taCookie);
    console.log('✅ Booking fetched:', booking.hotelName);

    // ── Step 2: Find hotel email via Gemini ────────────────────────────────
    console.log('⏳ Step 2: Searching for hotel email via Gemini...');
    const geminiResult = await findHotelEmail(
      booking.hotelName,
      booking.hotelAddress,
      booking.hotelCountry
    );
    console.log(`✅ Gemini result: ${geminiResult.email} (${geminiResult.confidence})`);

    // ── Step 3: Post internal note to Freshdesk ────────────────────────────
    console.log('⏳ Step 3: Adding internal note to Freshdesk ticket...');
    const noteBody = buildNoteHtml(booking, geminiResult);
    await addNote(freshdeskTicketId, noteBody);
    console.log('✅ Note added — awaiting agent confirmation to send email');

    // ── Return to agent for confirmation ───────────────────────────────────
    res.json({
      success: true,
      booking: {
        hotelName: booking.hotelName,
        hotelAddress: booking.hotelAddress,
        guestName: booking.guestName,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        roomType: booking.roomType,
        boardCode: booking.boardCode,
        adults: booking.adults,
        children: booking.children,
        vendorConfirmationNumber: booking.vendorConfirmationNumber,
        internalBookingId: booking.internalBookingId,
        estimatedArrivalTime: booking.estimatedArrivalTime,
        specialRequests: booking.specialRequests,
      },
      hotelEmail: geminiResult.email,
      emailSource: geminiResult.source,
      emailConfidence: geminiResult.confidence,
      emailNotes: geminiResult.notes,
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
