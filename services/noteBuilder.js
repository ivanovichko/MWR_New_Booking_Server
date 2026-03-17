/**
 * Builds the HTML for the Freshdesk internal note.
 * Simplified to show only the key booking fields.
 */
function buildNoteHtml(booking, details, user, supplier = null) {
  const v = (val) => (val !== null && val !== undefined && val !== '' && val !== '-') ? val : '—';

  const tableStyle = 'width:100%;border-collapse:collapse;font-size:13px;';
  const thStyle    = 'padding:6px 10px;background:#f5f5f5;border:1px solid #ddd;text-align:left;font-weight:600;white-space:nowrap;width:38%;color:#444;';
  const tdStyle    = 'padding:6px 10px;border:1px solid #ddd;color:#222;';

  // Supplier: name + email inline
  let supplierDisplay = v(booking.supplierName);
  if (supplier) {
    if (supplier.email)
      supplierDisplay += ` <a href="mailto:${supplier.email}" style="color:#007bff;margin-left:8px;">${supplier.email}</a>`;
    else if (supplier.contactUrl)
      supplierDisplay += ` <a href="${supplier.contactUrl}" target="_blank" style="color:#007bff;margin-left:8px;">${supplier.contactUrl}</a>`;
    if (supplier.note)
      supplierDisplay += `<div style="margin-top:4px;font-size:12px;color:#856404;background:#fff3cd;padding:3px 6px;border-radius:3px;">${supplier.note}</div>`;
  }

  // Hotel name from parsed details, fall back to supplier name
  const hotelName = details?.hotelName || booking.supplierName || '—';

  const rows = [
    ['Booking Date',        v(booking.bookingDate)],
    ['Booking ID (TA)',     v(booking.internalBookingId)],
    ['Booking ID (Supplier)', v(booking.supplierId)],
    ['Supplier',            supplierDisplay],
    ['Hotel',               v(hotelName)],
    ['Guest',               v(booking.guestName)],
    booking.mwrRoomType && booking.mwrRoomType !== '—'
      ? ['Room Type', v(booking.mwrRoomType)] : null,
    ['Check-In',            v(booking.checkIn)],
    ['Check-Out',           v(booking.checkOut)],
  ].filter(Boolean);

  const tableRows = rows.map(([label, val]) =>
    `<tr><th style="${thStyle}">${label}</th><td style="${tdStyle}">${val}</td></tr>`
  ).join('');

  const adminLink = booking.detailUrl
    ? `<a href="${booking.detailUrl}" target="_blank" style="background:#28a745;color:#fff;padding:4px 10px;border-radius:4px;text-decoration:none;font-size:12px;">Open in Admin</a>`
    : '';

  return `
<div style="font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#222;max-width:700px;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
    <h3 style="margin:0;font-size:15px;color:#1a1a1a;">📦 ${v(booking.productType)} — #${v(booking.internalBookingId)}</h3>
    <div>${adminLink}</div>
  </div>
  <table style="${tableStyle}"><tbody>${tableRows}</tbody></table>
</div>`.trim();
}

module.exports = { buildNoteHtml };
