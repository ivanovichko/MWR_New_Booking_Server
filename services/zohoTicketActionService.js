const { getCachedBooking } = require('./dbService');
const { lookupSupplier } = require('./supplierService');
const { buildNoteHtml } = require('./noteBuilder');
const { parseBookingHtml } = require('./parserService');
const { postComment, tagTicket } = require('./zohoDeskService');
const { buildBookingTags } = require('./ticketActionService');

/**
 * Zoho counterpart to ticketActionService.confirmTicket — same booking-note
 * + tagging logic, posting through zohoDeskService instead of freshdeskService.
 * Kept as a separate function rather than parameterizing confirmTicket so the
 * production Freshdesk path carries no dependency on this beta code.
 */
async function confirmTicketZoho(ticketId, bookingId, prebuiltNoteHtml = null) {
  const cached = await getCachedBooking(bookingId);
  if (!cached || !cached.parsed) throw new Error('Booking not cached');

  const { booking, details, user } = cached.parsed;
  const supplier = lookupSupplier(booking.supplierName);

  const cleanHtml = (!prebuiltNoteHtml && cached.booking_html)
    ? parseBookingHtml(cached.booking_html).cleanHtml
    : '';
  const noteHtml = prebuiltNoteHtml || buildNoteHtml(booking, cleanHtml, details, user, supplier);

  await postComment(ticketId, noteHtml, false);
  const tags = buildBookingTags(booking);
  await tagTicket(ticketId, tags);

  return { notePosted: true, tagged: tags };
}

module.exports = { confirmTicketZoho };
