const { getCachedBooking } = require('./dbService');
const { lookupSupplier } = require('./supplierService');
const { buildNoteHtml } = require('./noteBuilder');
const { parseBookingHtml } = require('./parserService');
const { findHotelEmail } = require('./aiService');
const { tagTicket, sendEmail, addNoteWithImages } = require('./freshdeskService');
const { buildHotelEmailHtml } = require('./hotelEmailBuilder');

/**
 * Builds the standard tag set for a booking: month tag (e.g. "May 14"),
 * destination country, plus any existing tags. These date tags are what the
 * Pendings job later reads to decide when to reopen a ticket.
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
 * Posts the standard booking note and applies the date/country tags.
 * The `action` parameter is legacy (only 'note_only' is used now) and ignored.
 * prebuiltNoteHtml: optional — when supplied, skips the booking_html re-parse
 *   and note rebuild (already done during analyse).
 */
async function confirmTicket(ticketId, bookingId, action, prebuiltNoteHtml = null) {
  const cached = await getCachedBooking(bookingId);
  if (!cached || !cached.parsed) throw new Error('Booking not cached');

  const { booking, details, user } = cached.parsed;
  const supplier = lookupSupplier(booking.supplierName);

  const cleanHtml = (!prebuiltNoteHtml && cached.booking_html)
    ? parseBookingHtml(cached.booking_html).cleanHtml
    : '';
  const noteHtml = prebuiltNoteHtml || buildNoteHtml(booking, cleanHtml, details, user, supplier);

  await addNoteWithImages(ticketId, noteHtml);
  const tags = buildBookingTags(booking);
  await tagTicket(ticketId, tags, 'Reservations');

  return { notePosted: true, tagged: tags };
}

/**
 * Phase 1 of the hotel-email flow: tag the ticket with booking tags, run the
 * Groq lookup, and return a preview package for the agent to confirm/edit.
 * No email is sent at this stage.
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
 * the address. Sends the email. No result note — Freshdesk records the
 * outbound email in the conversation thread on its own.
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

  return { emailSent: true, hotelEmail, notePosted: false };
}

module.exports = { confirmTicket, buildBookingTags, lookupHotelEmail, sendHotelEmailConfirmed };
