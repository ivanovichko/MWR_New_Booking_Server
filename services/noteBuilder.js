/**
 * Builds the HTML for the Freshdesk internal note.
 * Takes:
 *   booking    — parsed DataTables row (from parserService)
 *   bookingHtml — cleaned service detail HTML (from parserService)
 *   user       — parsed user profile (from userService)
 *   supplier   — supplier contact info (from supplierService), optional
 */
function buildNoteHtml(booking, bookingHtml, user, supplier = null) {
  const v = (val) => (val !== null && val !== undefined && val !== '' && val !== '-') ? val : '—';
  const currency = v(booking.currency);

  const price = (val) => {
    if (!val || val === '—' || val === '0' || val === 0 || val === '-') return null;
    return `${val} ${currency}`;
  };

  // ── Styles ─────────────────────────────────────────────────────────────────
  const tableStyle   = 'width:100%;border-collapse:collapse;margin-bottom:12px;font-size:13px;';
  const thStyle      = 'padding:6px 10px;background:#f5f5f5;border:1px solid #ddd;text-align:left;font-weight:600;white-space:nowrap;width:38%;color:#444;';
  const tdStyle      = 'padding:6px 10px;border:1px solid #ddd;color:#222;';
  const h4Style      = 'margin:20px 0 8px;font-size:14px;color:#1a1a1a;border-bottom:2px solid #007bff;padding-bottom:4px;';
  const badgeStyle   = (color) => `display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${color};color:#fff;margin-left:6px;`;

  const renderTable = (rows) => `
    <table style="${tableStyle}">
      <tbody>
        ${rows.filter(Boolean).map(([label, val]) => `
          <tr>
            <th style="${thStyle}">${label}</th>
            <td style="${tdStyle}">${val}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  // ── Booking summary rows ───────────────────────────────────────────────────
  const summaryRows = [
    ['Booking Date',    v(booking.bookingDate)],
    ['Booking ID',      v(booking.internalBookingId)],
    ['Supplier ID',     v(booking.supplierId)],
    ['Service Type',    v(booking.productType)],
    ['Supplier', (() => {
      let display = v(booking.supplierName);
      if (supplier) {
        const contact = supplier.email
          ? `<a href="mailto:${supplier.email}" style="color:#007bff;margin-left:8px;">${supplier.email}</a>`
          : supplier.contactUrl
            ? `<a href="${supplier.contactUrl}" target="_blank" style="color:#007bff;margin-left:8px;">${supplier.contactUrl}</a>`
            : '';
        if (contact) display += contact;
        if (supplier.note) display += `<div style="margin-top:4px;font-size:12px;color:#856404;background:#fff3cd;padding:3px 6px;border-radius:3px;">${supplier.note}</div>`;
      }
      return display;
    })()],
    ['Status',          v(booking.bookingStatus)],
    ['Guest',           v(booking.guestName)],
    booking.supplierRoomType && booking.supplierRoomType !== '—'
      ? ['Supplier Room Type', v(booking.supplierRoomType)] : null,
    booking.mwrRoomType && booking.mwrRoomType !== '—'
      ? ['MWR Room Type', v(booking.mwrRoomType)] : null,
    ['Check-In',        v(booking.checkIn)],
    ['Check-Out',       v(booking.checkOut)],
    booking.locationFrom && booking.locationFrom !== '—'
      ? ['From', v(booking.locationFrom)] : null,
    booking.locationTo && booking.locationTo !== '—'
      ? ['To',   v(booking.locationTo)]   : null,
    booking.returnLocationFrom && booking.returnLocationFrom !== '—'
      ? ['Return From', v(booking.returnLocationFrom)] : null,
    booking.returnLocationTo && booking.returnLocationTo !== '—'
      ? ['Return To',   v(booking.returnLocationTo)]   : null,
    booking.destinationCity && booking.destinationCity !== '—'
      ? ['Destination', `${v(booking.destinationCity)}, ${v(booking.destinationCountry)}`] : null,
  ];

  // ── Financial rows ─────────────────────────────────────────────────────────
  const financialRows = [
    price(booking.totalPrice)           ? ['Total Price',                 price(booking.totalPrice)]           : null,
    price(booking.memberPrice)          ? ['Member Price',                price(booking.memberPrice)]          : null,
    price(booking.memberPriceLessCredits) ? ['Member Price (less TCs/LPs)', price(booking.memberPriceLessCredits)] : null,
    booking.redeemedTCs && booking.redeemedTCs !== '0'
      ? ['Travel Credits Used', booking.redeemedTCs] : null,
    booking.redeemedLPs && booking.redeemedLPs !== '0'
      ? ['Loyalty Points Used', booking.redeemedLPs] : null,
    booking.earnedTC && booking.earnedTC !== '0'
      ? ['Earned TCs', booking.earnedTC] : null,
    price(booking.netPrice)             ? ['NET Price',          price(booking.netPrice)]             : null,
    price(booking.membershipPrice)      ? ['Membership Price',   price(booking.membershipPrice)]      : null,
    price(booking.tripProtectionPrice)  ? ['Trip Protection',    price(booking.tripProtectionPrice)]  : null,
    price(booking.healthInsurancePrice) ? ['Health Insurance',   price(booking.healthInsurancePrice)] : null,
    ['Gateway',        v(booking.gateway)],
    ['Transaction ID', v(booking.transactionId)],
  ];

  // ── Member rows ────────────────────────────────────────────────────────────
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

  // ── User action links ──────────────────────────────────────────────────────
  const btnStyle = (color) => `background:${color};color:#fff;padding:4px 10px;border-radius:4px;text-decoration:none;font-size:12px;margin-right:6px;display:inline-block;`;
  const userLinks = [
    user.loginLink   ? `<a href="${user.loginLink}"   target="_blank" style="${btnStyle('#007bff')}">Login as User</a>` : '',
    user.profileLink ? `<a href="${user.profileLink}" target="_blank" style="${btnStyle('#0056d2')}">Open Full Profile</a>` : '',
  ].filter(Boolean).join('');

  // ── Admin link ─────────────────────────────────────────────────────────────
  const adminLink = booking.detailUrl
    ? `<a href="${booking.detailUrl}" target="_blank" style="${btnStyle('#28a745')}">Open in Admin</a>`
    : '';

  // ── Secondary members ──────────────────────────────────────────────────────
  const secondarySection = user.secondaryMembers?.length
    ? `<h4 style="${h4Style}">👥 Secondary Members</h4>
       <div style="font-size:13px;line-height:1.8;">
         ${user.secondaryMembers.map(m => `
           <div>
             <strong>${m.name}</strong>
             ${m.country ? ` — ${m.country}` : ''}
             ${m.status  ? `<span style="${badgeStyle('#28a745')}">${m.status}</span>` : ''}
           </div>`).join('')}
       </div>`
    : '';

  // ── Collapsible financials (details/summary — degrades gracefully) ─────────
  const financialSection = `
    <h4 style="${h4Style}">💰 Financial Details</h4>
    <details style="margin-bottom:12px;">
      <summary style="cursor:pointer;font-size:13px;color:#007bff;padding:6px 0;user-select:none;">
        Show / Hide Financials
      </summary>
      <div style="margin-top:8px;">
        ${renderTable(financialRows)}
      </div>
    </details>`;

  // ── Assemble note ──────────────────────────────────────────────────────────
  return `
<div style="font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#222;max-width:900px;">

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
    <h3 style="margin:0;font-size:16px;color:#1a1a1a;">
      📦 ${v(booking.productType)} Booking — #${v(booking.internalBookingId)}
    </h3>
    <div>${adminLink}</div>
  </div>

  <h4 style="${h4Style}">📋 Booking Summary</h4>
  ${renderTable(summaryRows)}

  ${financialSection}

  <h4 style="${h4Style}">🗓 Service Details</h4>
  <div style="border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:16px;font-size:13px;line-height:1.6;background:#fafafa;">
    ${bookingHtml}
  </div>

  <h4 style="${h4Style}">👤 Primary Member</h4>
  ${userLinks ? `<div style="margin-bottom:10px;">${userLinks}</div>` : ''}
  ${renderTable(memberRows)}

  ${secondarySection}

</div>`.trim();
}

module.exports = { buildNoteHtml };
