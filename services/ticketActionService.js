const { getCachedBooking } = require('./dbService');
const { lookupSupplier } = require('./supplierService');
const { buildNoteHtml } = require('./noteBuilder');
const { parseBookingHtml } = require('./parserService');
const { findHotelEmail } = require('./aiService');
const { tagTicket, sendEmail } = require('./freshdeskService');
const { postNote, setTicketPriority } = require('./prewarmService');
const { buildHotelEmailHtml } = require('./hotelEmailBuilder');

/**
 * Builds the standard tag set for a booking:
 * month tag (e.g. "May 14"), destination country, plus any existing tags.
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
      if (mi >= 0) monthTag = `${months[mi]} ${m[2]}`;
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
      <strong>❌ Hotel Email Not Found</strong>
    </div>`;
  }
  if (emailResult.confidence === 'low') {
    return `<div style="padding:10px 14px;background:#fff3cd;border-left:4px solid #fd7e14;border-radius:4px;font-size:13px;font-family:system-ui,sans-serif;">
      <strong>⚠️ Hotel Email — Low Confidence</strong><br>
      <strong>Email:</strong> ${emailResult.email}<br>
      ${emailResult.notes ? `<strong>Notes:</strong> ${emailResult.notes}<br>` : ''}
    </div>`;
  }
  return `<div style="padding:10px 14px;background:#d4edda;border-left:4px solid #28a745;border-radius:4px;font-size:13px;font-family:system-ui,sans-serif;">
    <strong>📧 Hotel Email Found</strong><br>
    <strong>Email:</strong> ${emailResult.email}<br>
    <strong>Confidence:</strong> ${emailResult.confidence}<br>
    ${emailResult.source ? `<strong>Source:</strong> ${emailResult.source}<br>` : ''}
  </div>`;
}

/**
 * Executes the guided-prewarm action for a confirmed ticket.
 * action: 'call_hotel' | 'voucher' | 'note_only'
 * (hotel_email moved to lookupHotelEmail + sendHotelEmailConfirmed)
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

  if (action === 'call_hotel') {
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

/**
 * Phase 1 of the hotel-email flow: tag the ticket with booking tags, run the
 * Groq lookup, and return a preview package for the agent to confirm/edit.
 * No email is sent and no result note is posted at this stage.
 */
async function lookupHotelEmail(ticketId, bookingId) {
  const cached = await getCachedBooking(bookingId);
  if (!cached || !cached.parsed) throw new Error('Booking not cached');

  const { booking, details } = cached.parsed;

  const tags = buildBookingTags(booking);
  await tagTicket(ticketId, tags, 'Reservations');

  const emailResult = await findHotelEmail(
    details.hotelName || booking.supplierName,
    booking.locationTo,
    booking.destinationCountry
  );

  const emailHtmlPreview = buildHotelEmailHtml(booking, details || {});

  return {
    emailResult,
    booking,
    details,
    hotelName: details.hotelName || booking.supplierName,
    tagged: tags,
    emailHtmlPreview,
  };
}

/**
 * Phase 2 of the hotel-email flow: agent has confirmed (and possibly edited)
 * the address. Send the email; only on success post the result note.
 * Status is NOT auto-set to Pending — that's now an explicit agent choice.
 */
async function sendHotelEmailConfirmed(ticketId, bookingId, hotelEmail) {
  const cached = await getCachedBooking(bookingId);
  if (!cached || !cached.parsed) throw new Error('Booking not cached');

  const { booking, details } = cached.parsed;
  const emailBody = buildHotelEmailHtml(booking, details || {});

  await sendEmail(
    ticketId,
    hotelEmail,
    `Prepaid Reservation Confirmation — ${booking.guestName} / ${booking.checkIn}`,
    emailBody
  );

  await postNote(ticketId, buildEmailResultHtml({
    email: hotelEmail,
    confidence: 'confirmed',
    source: 'agent confirmed',
  }));

  return { emailSent: true, hotelEmail, notePosted: true };
}

module.exports = { confirmTicket, buildBookingTags, lookupHotelEmail, sendHotelEmailConfirmed };
