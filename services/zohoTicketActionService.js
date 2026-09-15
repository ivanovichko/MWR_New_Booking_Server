const { getCachedBooking } = require('./dbService');
const { lookupSupplier } = require('./supplierService');
const { buildNoteHtml } = require('./noteBuilder');
const { parseBookingHtml } = require('./parserService');
const { postComment } = require('./zohoDeskService');

/**
 * Zoho counterpart to ticketActionService.confirmTicket — posts the booking
 * note through zohoDeskService instead of freshdeskService. Unlike the
 * Freshdesk path it does NOT tag: Zoho Desk tags aren't part of this workflow,
 * so the date/country tags the Freshdesk Pendings job relies on are dropped.
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

  return { notePosted: true };
}

module.exports = { confirmTicketZoho };
