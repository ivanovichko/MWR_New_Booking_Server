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
 * month tag (e.g. "May-02"), destination country, plus any existing tags.
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
      if (mi >= 0) monthTag = `${months[mi]}-${m[2].padStart(2, '0')}`;
    }
  }
  const country = booking.destinationCountry || null;
  return [...new Set([...existing, monthTag, country].filter(Boolean))];
}

/**
 * Executes the guided-prewarm action for a confirmed ticket.
 * action: 'hotel_email' | 'call_hotel' | 'voucher' | 'note_only'
 */
async function confirmTicket(ticketId, bookingId, action) {
  const cached = await getCachedBooking(bookingId);
  if (!cached || !cached.parsed) throw new Error('Booking not cached');

  const { booking, details, user } = cached.parsed;
  const supplier = lookupSupplier(booking.supplierName);
  const { cleanHtml: cachedCleanHtml } = cached.booking_html
    ? parseBookingHtml(cached.booking_html)
    : { cleanHtml: '' };

  const results = { notePosted: false, emailSent: false, tagged: [], prioritySet: null };

  if (action === 'hotel_email') {
    const noteHtml = buildNoteHtml(booking, cachedCleanHtml, details, user, supplier);
    await postNote(ticketId, noteHtml);
    results.notePosted = true;

    const tags = buildBookingTags(booking);
    await tagTicket(ticketId, tags, 'Reservations');
    results.tagged.push(...tags);

    const emailResult = await findHotelEmail(
      details.hotelName || booking.supplierName,
      booking.locationTo,
      booking.destinationCountry
    );

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
    const noteHtml = buildNoteHtml(booking, cachedCleanHtml, details, user, supplier);
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
    const noteHtml = buildNoteHtml(booking, cachedCleanHtml, details, user, supplier);
    await postNote(ticketId, noteHtml);
    results.notePosted = true;
    const tags = buildBookingTags(booking);
    await tagTicket(ticketId, tags, 'Reservations');
    results.tagged.push(...tags);
  }

  return results;
}

module.exports = { confirmTicket, buildBookingTags };
