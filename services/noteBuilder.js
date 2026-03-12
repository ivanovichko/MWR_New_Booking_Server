/**
 * Builds the HTML for the Freshdesk internal note.
 * Takes parsed booking (from DataTables), cleaned booking HTML (from detail page),
 * and parsed user object.
 */
function buildNoteHtml(booking, bookingHtml, user) {
  const v  = (val) => val || '—';
  const currency = v(booking.currency);

  const price = (val) => val && val !== '—' && val !== '0' && val !== 0
    ? `${val} ${currency}`
    : null;

  // ── Section: Booking Summary ───────────────────────────────────────────────
  const summaryRows = [
    ['Booking Date',    v(booking.bookingDate)],
    ['Booking ID',      v(booking.internalBookingId)],
    ['Supplier ID',     v(booking.supplierId)],
    ['Service Type',    v(booking.productType)],
    ['Supplier',        v(booking.supplierName)],
    ['Booking Status',  v(booking.bookingStatus)],
    ['Guest',           v(booking.guestName)],
    booking.supplierRoomType ? ['Supplier Room Type', v(booking.supplierRoomType)] : null,
    booking.mwrRoomType      ? ['MWR Room Type',      v(booking.mwrRoomType)]      : null,
    ['Check-In',        v(booking.checkIn)],
    ['Check-Out',       v(booking.checkOut)],
    booking.locationFrom ? ['From', v(booking.locationFrom)] : null,
    booking.locationTo   ? ['To',   v(booking.locationTo)]   : null,
    booking.returnLocationFrom ? ['Return From', v(booking.returnLocationFrom)] : null,
    booking.returnLocationTo   ? ['Return To',   v(booking.returnLocationTo)]   : null,
    booking.destinationCity    ? ['Destination', `${v(booking.destinationCity)}, ${v(booking.destinationCountry)}`] : null,
  ].filter(Boolean);

  // ── Section: Financial Details ─────────────────────────────────────────────
  const financialRows = [
    ['Total Price',                 price(booking.totalPrice)],
    ['Member Price',                price(booking.memberPrice)],
    ['Member Price (less TCs/LPs)', price(booking.memberPriceLessCredits)],
    ['Travel Credits Used',         booking.redeemedTCs && booking.redeemedTCs !== '0' ? booking.redeemedTCs : null],
    ['Loyalty Points Used',         booking.redeemedLPs && booking.redeemedLPs !== '0' ? booking.redeemedLPs : null],
    ['Earned TCs',                  booking.earnedTC    && booking.earnedTC !== '0'    ? booking.earnedTC    : null],
    ['NET Price',                   price(booking.netPrice)],
    ['Membership Price',            price(booking.membershipPrice)],
    ['Trip Protection',             price(booking.tripProtectionPrice)],
    ['Health Insurance',            price(booking.healthInsurancePrice)],
    ['Gateway',                     v(booking.gateway)],
    ['Transaction ID',              v(booking.transactionId)],
  ].filter(([, val]) => val !== null && val !== undefined);

  // ── Section: Primary Member ────────────────────────────────────────────────
  const memberRows = [
    ['Name',        v(user.fullName)],
    ['Email',       v(user.email)],
    ['Phone',       v(user.phone)],
    ['Instance',    v(user.instance)],
    ['Status',      v(user.status)],
    ['Turbo',       v(user.turbo)],
    ['Date of Birth', v(user.dob)],
    ['Country',     v(user.country)],
    ['State',       v(user.state)],
    ['City',        v(user.city)],
    ['Nationality', v(user.nationality)],
  ].filter(([, val]) => val && val !== '—');

  // ── Render helpers ─────────────────────────────────────────────────────────
  const tableStyle = 'width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;';
  const thStyle    = 'padding:6px 10px;background:#f0f0f0;border:1px solid #ccc;text-align:left;font-weight:600;white-space:nowrap;width:35%;';
  const tdStyle    = 'padding:6px 10px;border:1px solid #ddd;';
  const h4Style    = 'margin:20px 0 8px;font-size:14px;color:#333;border-bottom:2px solid #007bff;padding-bottom:4px;';

  const renderTable = (rows) => `
    <table style="${tableStyle}">
      <tbody>
        ${rows.map(([label, val]) => `
          <tr>
            <th style="${thStyle}">${label}</th>
            <td style="${tdStyle}">${val}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  // ── Secondary members ──────────────────────────────────────────────────────
  const secondarySection = user.secondaryMembers?.length
    ? `<h4 style="${h4Style}">👥 Secondary Members</h4>
       ${user.secondaryMembers.map(m => `
         <p style="margin:4px 0;font-size:13px;">
           <strong>${m.name}</strong>${m.country ? ` — ${m.country}` : ''}
           ${m.status ? `<span style="margin-left:6px;background:#28a745;color:#fff;padding:1px 6px;border-radius:10px;font-size:11px;">${m.status}</span>` : ''}
         </p>
       `).join('')}`
    : '';

  // ── User action links ──────────────────────────────────────────────────────
  const userLinks = [
    user.loginLink   ? `<a href="${user.loginLink}"   target="_blank" style="background:#007bff;color:#fff;padding:4px 10px;border-radius:4px;text-decoration:none;font-size:12px;margin-right:6px;">Login as User</a>` : '',
    user.profileLink ? `<a href="${user.profileLink}" target="_blank" style="background:#0056d2;color:#fff;padding:4px 10px;border-radius:4px;text-decoration:none;font-size:12px;">Open Full Profile</a>` : '',
  ].filter(Boolean).join('');

  // ── Admin link ─────────────────────────────────────────────────────────────
  const adminLink = booking.detailUrl
    ? `<a href="${booking.detailUrl}" target="_blank" style="background:#007bff;color:#fff;padding:4px 10px;border-radius:4px;text-decoration:none;font-size:12px;">Open in Admin</a>`
    : '';

  // ── Build full note ────────────────────────────────────────────────────────
  return `
<div style="font-family:system-ui,sans-serif;font-size:13px;color:#222;">

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
    <h3 style="margin:0;font-size:16px;">
      📦 ${v(booking.productType)} Booking — #${v(booking.internalBookingId)}
    </h3>
    <div>${adminLink}</div>
  </div>

  <h4 style="${h4Style}">📋 Booking Summary</h4>
  ${renderTable(summaryRows)}

  <h4 style="${h4Style}">💰 Financial Details</h4>
  ${renderTable(financialRows)}

  <h4 style="${h4Style}">🗓 Service Details</h4>
  <div style="border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:16px;font-size:13px;line-height:1.6;">
    ${bookingHtml}
  </div>

  <h4 style="${h4Style}">👤 Primary Member</h4>
  ${userLinks ? `<div style="margin-bottom:10px;">${userLinks}</div>` : ''}
  ${renderTable(memberRows)}
  ${secondarySection}

</div>
  `.trim();
}

module.exports = { buildNoteHtml };
