/**
 * Builds the HTML for the Freshdesk internal note.
 * Sections:
 *   1. Booking Summary (simplified)
 *   2. Financial Details (collapsible)
 *   3. Service Details (raw cleaned HTML from booking page)
 *   4. Primary Member + Secondary Members
 */
function buildNoteHtml(booking, cleanHtml, details, user, supplier = null) {
  const v = (val) => (val !== null && val !== undefined && val !== '' && val !== '-') ? val : '—';
  const currency = v(booking.currency);

  const price = (val) => {
    if (!val || val === '—' || val === '0' || val === 0 || val === '-') return null;
    return `${val} ${currency}`;
  };

  const tableStyle = 'width:100%;border-collapse:collapse;margin-bottom:12px;font-size:13px;';
  const thStyle    = 'padding:6px 10px;background:#f5f5f5;border:1px solid #ddd;text-align:left;font-weight:600;white-space:nowrap;width:38%;color:#444;';
  const tdStyle    = 'padding:6px 10px;border:1px solid #ddd;color:#222;';
  const h4Style    = 'margin:20px 0 8px;font-size:14px;color:#1a1a1a;border-bottom:2px solid #007bff;padding-bottom:4px;';
  const btnStyle   = (color) => `background:${color};color:#fff;padding:4px 10px;border-radius:4px;text-decoration:none;font-size:12px;margin-right:6px;display:inline-block;`;

  const renderTable = (rows) => {
    const filtered = rows.filter(Boolean);
    if (!filtered.length) return '';
    return '<table style="' + tableStyle + '"><tbody>' +
      filtered.map(([label, val]) =>
        '<tr><th style="' + thStyle + '">' + label + '</th><td style="' + tdStyle + '">' + val + '</td></tr>'
      ).join('') +
      '</tbody></table>';
  };

  // ── Supplier display ───────────────────────────────────────────────────────
  let supplierDisplay = v(booking.supplierName);
  if (supplier) {
    if (supplier.email)
      supplierDisplay += ' <a href="mailto:' + supplier.email + '" style="color:#007bff;margin-left:8px;">' + supplier.email + '</a>';
    else if (supplier.contactUrl)
      supplierDisplay += ' <a href="' + supplier.contactUrl + '" target="_blank" style="color:#007bff;margin-left:8px;">' + supplier.contactUrl + '</a>';
    if (supplier.note)
      supplierDisplay += '<div style="margin-top:4px;font-size:12px;color:#856404;background:#fff3cd;padding:3px 6px;border-radius:3px;">' + supplier.note + '</div>';
  }

  const isflight   = booking.productType && booking.productType.toLowerCase().includes('flight');
  const iscar      = booking.productType && booking.productType.toLowerCase().includes('car');
  const istransfer = booking.productType && booking.productType.toLowerCase().includes('transfer');
  const isground   = booking.productType && booking.productType.toLowerCase().includes('ground');
  const ishotel    = booking.productType && booking.productType.toLowerCase().includes('hotel');

  const typeRows = isflight ? [
    details && details.departAirline ? ['Depart Airline', v(details.departAirline)] : null,
    details && details.returnAirline ? ['Return Airline', v(details.returnAirline)] : null,
    details && details.pnr           ? ['PNR',            v(details.pnr)]           : null,
    details && details.ticketNo      ? ['Ticket No.',     v(details.ticketNo)]      : null,
  ].filter(Boolean) : iscar ? [
    details && details.carVehicle    ? ['Vehicle',        v(details.carVehicle)]    : null,
    details && details.carFlightInfo ? ['Flight',         v(details.carFlightInfo)] : null,
    details && details.pickupDetails ? ['Pickup',         v(details.pickupDetails)] : null,
    details && details.dropoffDetails ? ['Dropoff',       v(details.dropoffDetails)] : null,
  ].filter(Boolean) : istransfer ? [
    details && details.transferFrom         ? ['From',          v(details.transferFrom)]         : null,
    details && details.transferTo           ? ['To',            v(details.transferTo)]           : null,
    details && details.transferDate         ? ['Transfer Date', v(details.transferDate)]         : null,
    details && details.transferFlightTrain  ? ['Flight/Train',  v(details.transferFlightTrain)]  : null,
    details && details.transferVehicle      ? ['Vehicle',       v(details.transferVehicle)]      : null,
    details && details.transferCarrier      ? ['Carrier',       v(details.transferCarrier)]      : null,
    details && details.transferCarrierEmail ? ['Carrier Email', v(details.transferCarrierEmail)] : null,
    details && details.transferCarrierPhone ? ['Carrier Phone', v(details.transferCarrierPhone)] : null,
  ].filter(Boolean) : isground ? [
    details && details.departCompany ? ['Company',  v(details.departCompany)] : null,
  ].filter(Boolean) : ishotel ? [
    ['Hotel', v(details && details.hotelName ? details.hotelName : booking.supplierName)],
  ] : [];

  // ── 1. Booking Summary ─────────────────────────────────────────────────────
  const summaryRows = [
    ['Booking Date',          v(booking.bookingDate)],
    ['Booking ID (TA)',        v(booking.internalBookingId)],
    ['Booking ID (Supplier)', v(booking.supplierId)],
    ['Supplier',              supplierDisplay],
    ...typeRows,
    ['Guest',                 v(booking.guestName)],
    booking.mwrRoomType && booking.mwrRoomType !== '—' ? ['Room Type', v(booking.mwrRoomType)] : null,
    ['Check-In',  v(booking.checkIn)],
    ['Check-Out', v(booking.checkOut)],
    booking.destinationCountry && booking.destinationCountry !== '—' ? ['Country', v(booking.destinationCountry)] : null,
    booking.destinationCity    && booking.destinationCity    !== '—' ? ['City',    v(booking.destinationCity)]    : null,
    booking.voucherUrl ? ['Voucher', `<a href="${booking.voucherUrl}" target="_blank">View Voucher ↗</a>`] : null,
  ];

  // ── 2. Financial Details ───────────────────────────────────────────────────
  const financialRows = [
    price(booking.totalPrice)             ? ['Total Price',                 price(booking.totalPrice)]             : null,
    price(booking.memberPrice)            ? ['Member Price',                price(booking.memberPrice)]            : null,
    price(booking.memberPriceLessCredits) ? ['Member Price (less TCs/LPs)', price(booking.memberPriceLessCredits)] : null,
    booking.redeemedTCs && booking.redeemedTCs !== '0' ? ['Travel Credits Used', booking.redeemedTCs] : null,
    booking.redeemedLPs && booking.redeemedLPs !== '0' ? ['Loyalty Points Used', booking.redeemedLPs] : null,
    booking.earnedTC    && booking.earnedTC    !== '0' ? ['Earned TCs',          booking.earnedTC]    : null,
    price(booking.netPrice)               ? ['NET Price',        price(booking.netPrice)]             : null,
    price(booking.membershipPrice)        ? ['Membership Price', price(booking.membershipPrice)]      : null,
    price(booking.tripProtectionPrice)    ? ['Trip Protection',  price(booking.tripProtectionPrice)]  : null,
    price(booking.healthInsurancePrice)   ? ['Health Insurance', price(booking.healthInsurancePrice)] : null,
    ['Gateway',        v(booking.gateway)],
    ['Transaction ID', v(booking.transactionId)],
  ];

  // ── 3. Member rows ─────────────────────────────────────────────────────────
  const memberRows = [
    user.fullName    ? ['Name',         user.fullName]    : null,
    user.email       ? ['Email',        user.email]       : null,
    user.phone       ? ['Phone',        user.phone]       : null,
    user.instance    ? ['Instance',     user.instance]    : null,
    user.status      ? ['Status',       user.status]      : null,
    user.turbo       ? ['Turbo',        user.turbo]       : null,
    user.dob         ? ['Date of Birth',user.dob]         : null,
    user.country     ? ['Country',      user.country]     : null,
    user.state       ? ['State',        user.state]       : null,
    user.city        ? ['City',         user.city]        : null,
    user.nationality ? ['Nationality',  user.nationality] : null,
  ];

  // ── Links ──────────────────────────────────────────────────────────────────
  const adminLink = booking.detailUrl
    ? '<a href="' + booking.detailUrl + '" target="_blank" style="' + btnStyle('#28a745') + '">Open in Admin</a>'
    : '';
  const userLinks = [
    user.loginLink   ? '<a href="' + user.loginLink   + '" target="_blank" style="' + btnStyle('#007bff') + '">Login as User</a>'     : '',
    user.profileLink ? '<a href="' + user.profileLink + '" target="_blank" style="' + btnStyle('#0056d2') + '">Open Full Profile</a>' : '',
  ].filter(Boolean).join('');

  // ── Secondary members ──────────────────────────────────────────────────────
  let secondarySection = '';
  if (user.secondaryMembers && user.secondaryMembers.length) {
    secondarySection = '<h4 style="' + h4Style + '">👥 Secondary Members</h4><div style="font-size:13px;line-height:1.8;">';
    user.secondaryMembers.forEach(function(m) {
      secondarySection += '<div><strong>' + m.name + '</strong>';
      if (m.country) secondarySection += ' — ' + m.country;
      if (m.status)  secondarySection += ' <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:#28a745;color:#fff;margin-left:6px;">' + m.status + '</span>';
      secondarySection += '</div>';
    });
    secondarySection += '</div>';
  }

  return (
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#222;max-width:900px;">' +

    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">' +
      '<h3 style="margin:0;font-size:16px;color:#1a1a1a;">📦 ' + v(booking.productType) + ' — #' + v(booking.internalBookingId) + '</h3>' +
      '<div>' + adminLink + '</div>' +
    '</div>' +

    '<h4 style="' + h4Style + '">📋 Booking Summary</h4>' +
    renderTable(summaryRows) +

    '<h4 style="' + h4Style + '">💰 Financial Details</h4>' +
    '<details style="margin-bottom:12px;">' +
      '<summary style="cursor:pointer;font-size:13px;color:#007bff;padding:6px 0;user-select:none;">Show / Hide Financials</summary>' +
      '<div style="margin-top:8px;">' + renderTable(financialRows) + '</div>' +
    '</details>' +

    '<h4 style="' + h4Style + '">🗓 Service Details</h4>' +
    '<div style="border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:16px;font-size:13px;line-height:1.6;background:#fafafa;">' +
      (cleanHtml || '') +
    '</div>' +

    '<h4 style="' + h4Style + '">👤 Primary Member</h4>' +
    (userLinks ? '<div style="margin-bottom:10px;">' + userLinks + '</div>' : '') +
    renderTable(memberRows) +

    secondarySection +

    '</div>'
  ).trim();
}

/**
 * Builds a short booking-only note (no member details, no financials).
 * Used when multiple bookings exist on a single ticket.
 */
function buildShortNoteHtml(booking, details) {
  const v = (val) => (val !== null && val !== undefined && val !== '' && val !== '-') ? val : '—';
  const tableStyle = 'width:100%;border-collapse:collapse;margin-bottom:12px;font-size:13px;';
  const thStyle    = 'padding:5px 10px;background:#f5f5f5;border:1px solid #ddd;text-align:left;font-weight:600;white-space:nowrap;width:38%;color:#444;';
  const tdStyle    = 'padding:5px 10px;border:1px solid #ddd;color:#222;';

  const productType = (booking.productType || '').toLowerCase();
  const isFlight    = productType.includes('flight');

  const rows = [
    ['Booking ID (TA)',        v(booking.internalBookingId)],
    ['Booking ID (Supplier)', v(booking.supplierId)],
    ['Supplier',              v(booking.supplierName)],
    isFlight
      ? ['Airline', v(details && details.departAirline ? details.departAirline : booking.supplierName)]
      : ['Hotel',   v(details && details.hotelName    ? details.hotelName    : booking.supplierName)],
    !isFlight && booking.mwrRoomType ? ['Room Type', v(booking.mwrRoomType)] : null,
    ['Guest',     v(booking.guestName)],
    ['Check-In',  v(booking.checkIn)],
    ['Check-Out', v(booking.checkOut)],
    isFlight && booking.locationTo ? ['Destination', v(booking.locationTo)] : null,
    booking.destinationCity ? ['City', v(booking.destinationCity)] : null,
  ].filter(Boolean);

  const tableHtml = '<table style="' + tableStyle + '"><tbody>' +
    rows.map(([label, val]) =>
      '<tr><th style="' + thStyle + '">' + label + '</th><td style="' + tdStyle + '">' + val + '</td></tr>'
    ).join('') +
    '</tbody></table>';

  return (
    '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#222;max-width:900px;">' +
    '<h4 style="margin:0 0 10px;font-size:14px;color:#1a1a1a;border-bottom:2px solid #17a2b8;padding-bottom:4px;">📌 ' +
      v(booking.productType) + ' — #' + v(booking.internalBookingId) +
    '</h4>' +
    tableHtml +
    '</div>'
  );
}

module.exports = { buildNoteHtml, buildShortNoteHtml };
