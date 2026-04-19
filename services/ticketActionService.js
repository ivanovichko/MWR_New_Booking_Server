const { getCachedBooking } = require('./dbService');
const { lookupSupplier } = require('./supplierService');
const { buildNoteHtml } = require('./noteBuilder');
const { parseBookingHtml } = require('./parserService');
const { findHotelEmail } = require('./aiService');
const { tagTicket, sendEmail, setTicketPending } = require('./freshdeskService');
const { postNote, setTicketPriority } = require('./prewarmService');
const { buildHotelEmailHtml } = require('./hotelEmailBuilder');

/**
 * Builds the standard tag set for a booking:
 * month tag (e.g. "May 25"), destination country, plus any existing tags.
 */
function buildBookingTags(booking) {
  const existing = booking.tags || [];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let monthTag = null;
  if (booking.checkIn) {
    const m = booking.checkIn.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (m) {
      const mi = ['january','february','march','april','may','june','july','august',
                  'september','october','november','december'].indexOf(m[1].toLowerCase());
      if (mi >= 0) monthTag = `${months[mi]} ${m[3].slice(-2)}`;
    }
  }
  const country = booking.destinationCountry || null;
  return [...new Set([...existing, monthTag, country].filter(Boolean))];
}

/**
 * Builds a standalone HTML note summarising the hotel email search result.
 */
function buildEmailResultHtml(emailResult) {
  if (!emailResult || !emailResult.email) {
    return `<div style="padding:10px 14px;background:#f8d7da;border-left:4px solid #dc3545;border-radius:4px;font-size:13px;font-family:system-ui,sans-serif;">
      <strong>❌ Hotel Email Not Found</strong><br>
      <em style="color:#555;">Tagged call_hotel — please contact hotel by phone.</em>
    </div>`;
  }
  if (emailResult.confidence === 'low') {
    return `<div style="padding:10px 14px;background:#fff3cd;border-left:4px solid #fd7e14;border-radius:4px;font-size:13px;font-family:system-ui,sans-serif;">
      <strong>⚠️ Hotel Email — Low Confidence</strong><br>
      <strong>Email:</strong> ${emailResult.email}<br>
      ${emailResult.notes ? `<strong>Notes:</strong> ${emailResult.notes}<br>` : ''}
      <em style="color:#555;">Tagged call_hotel — verify and send manually if correct.</em>
    </div>`;
  }
  return `<div style="padding:10px 14px;background:#d4edda;border-left:4px solid #28a745;border-radius:4px;font-size:13px;font-family:system-ui,sans-serif;">
    <strong>📧 Hotel Email Found</strong><br>
    <strong>Email:</strong> ${emailResult.email}<br>
    <strong>Confidence:</strong> ${emailResult.confidence}<br>
    ${emailResult.source ? `<strong>Source:</strong> ${emailResult.source}<br>` : ''}
    <em style="color:#555;">Email sent automatically — ticket set to Pending.</em>
  </div>`;
}

/**
 * Executes the guided-prewarm action for a confirmed ticket.
 * action: 'hotel_email' | 'call_hotel' | 'voucher' | 'note_only'
 * prebuiltNoteHtml: optional — if supplied for note_only/call_hotel, skips
 *   the DB booking_html re-parse and note rebuild (already done during analyse).
 */
async function confirmTicket(ticketId, bookingId, action, prebuiltNoteHtml = null) {
  const cached = await getCachedBooking(bookingId);
  if (!cached || !cached.parsed) throw new Error('Booking not cached');

  const { booking, details, user } = cached.parsed;
  const supplier = lookupSupplier(booking.supplierName);

  // Only parse booking_html when we actually need to build the note ourselves
  const needsNoteBuild = (action === 'note_only' || action === 'call_hotel') && !prebuiltNoteHtml;
  const cachedCleanHtml = needsNoteBuild && cached.booking_html
    ? parseBookingHtml(cached.booking_html).cleanHtml
    : '';

  const results = { notePosted: false, emailSent: false, tagged: [], prioritySet: null };

  if (action === 'hotel_email') {
    // 1. Tag ticket
    const tags = buildBookingTags(booking);
    await tagTicket(ticketId, tags, 'Reservations');
    results.tagged.push(...tags);

    // 2. Find hotel email
    const emailResult = await findHotelEmail(
      details.hotelName || booking.supplierName,
      booking.locationTo,
      booking.destinationCountry
    );

    // 3. Always post a separate note with the email search outcome
    await postNote(ticketId, buildEmailResultHtml(emailResult));

    // 4. Send email or fall back to call_hotel tag
    if (emailResult && emailResult.email && emailResult.confidence !== 'low') {
      const emailBody = buildHotelEmailHtml(booking, details || {});
      await sendEmail(ticketId, emailResult.email, null, emailBody);
      await setTicketPending(ticketId);
      results.emailSent = true;
      results.hotelEmail = emailResult.email;
    } else {
      await tagTicket(ticketId, [...buildBookingTags(booking), 'call_hotel'], 'Reservations');
      results.tagged.push('call_hotel');
      results.fallback = true;
    }

  } else if (action === 'call_hotel') {
    const noteHtml = prebuiltNoteHtml || buildNoteHtml(booking, cachedCleanHtml, details, user, supplier);
    await postNote(ticketId, noteHtml);
    results.notePosted = true;
    const tags = [...buildBookingTags(booking), 'call_hotel'];
    await tagTicket(ticketId, tags, 'Reservations');
    await setTicketPriority(ticketId, 3);
    results.tagged.push(...tags);
    results.prioritySet = 'high';

  } else if (action === 'voucher') {
    const tags = [...buildBookingTags(booking), 'voucher'];
    await tagTicket(ticketId, tags, 'Reservations');
    results.tagged.push(...tags);

  } else if (action === 'note_only') {
    const noteHtml = prebuiltNoteHtml || buildNoteHtml(booking, cachedCleanHtml, details, user, supplier);
    await postNote(ticketId, noteHtml);
    results.notePosted = true;
    const tags = buildBookingTags(booking);
    await tagTicket(ticketId, tags, 'Reservations');
    results.tagged.push(...tags);
  }

  return results;
}

module.exports = { confirmTicket, buildBookingTags };
