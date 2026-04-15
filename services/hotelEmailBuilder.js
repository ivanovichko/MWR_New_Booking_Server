const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Builds the HTML body for a hotel prepaid confirmation email.
 */
function buildHotelEmailHtml(booking, details = {}) {
  const v = (val) => esc(val || '—');

  let roomLine = null;
  if (details.roomDetails) {
    roomLine = details.roomDetails.replace(/\s*\([^)]*\)/, '').replace(/\s+/g, ' ').trim();
  } else if (booking.mwrRoomType) {
    roomLine = booking.mwrRoomType;
  }

  const lines = [
    details.hotelName    ? `<strong>${esc(details.hotelName)}</strong>` : null,
    details.hotelAddress ? esc(details.hotelAddress) : null,
    details.hotelPhone   ? esc(details.hotelPhone)   : null,
    ``,
    `<strong>Check-in:</strong> ${v(details.checkIn  || booking.checkIn)}`,
    `<strong>Check-out:</strong> ${v(details.checkOut || booking.checkOut)}`,
    roomLine             ? `<strong>Room Details:</strong> ${esc(roomLine)}` : null,
    details.bedTypes     ? `<strong>Bed Types:</strong> ${esc(details.bedTypes)}` : null,
    details.paxLine      ? esc(details.paxLine) : null,
    `<strong>Guest Name(s):</strong> ${v(details.guestName || booking.guestName)}`,
    details.requests     ? `<strong>Requests for the hotel:</strong> ${esc(details.requests)}` : null,
    details.arrivalTime  ? `<strong>Estimated Time of Arrival:</strong> ${esc(details.arrivalTime)}` : null,
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

module.exports = { buildHotelEmailHtml };
