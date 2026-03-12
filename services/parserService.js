const { JSDOM } = require('jsdom');

// ─── Strip HTML tags from a string ───────────────────────────────────────────
function stripHtml(str) {
  if (!str || typeof str !== 'string') return str ?? '—';
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '—';
}

// ─── Extract href from an HTML string ────────────────────────────────────────
function extractHref(str) {
  if (!str) return null;
  const match = str.match(/href=['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

// ─── Format gateway cell: "NMI<br>[<small><strong>Credit Card</strong></small>]"
// → "NMI / Credit Card"
function formatGateway(str) {
  if (!str) return '—';
  const clean = stripHtml(str).replace(/[\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return clean || '—';
}

// ─── Parse DataTables row into structured booking object ─────────────────────
function parseDataRow(row) {
  const v = (i) => {
    const val = row[i];
    if (val === null || val === undefined || val === '-' || val === '') return null;
    if (typeof val === 'string') return val.trim() || null;
    return val;
  };

  return {
    // Identifiers
    detailUrl:              extractHref(row[0]),
    bookingDate:            v(1),
    internalBookingId:      v(2),
    supplierId:             v(3),
    primaryMember:          stripHtml(v(4)),
    primaryMemberUrl:       extractHref(row[4]),
    instance:               stripHtml(v(5))?.replace('<br>', '').trim() || null,
    turboUser:              v(6),
    guestName:              v(7),
    productType:            v(8),   // Hotel / Flight / Transfer / Activities / etc.
    supplierName:           v(9),
    supplierRoomType:       v(10),
    mwrRoomType:            v(11),
    bookingStatus:          stripHtml(v(12)),
    gateway:                formatGateway(row[13]),
    refundable:             v(14),
    transactionId:          v(15),
    currency:               v(16),
    memberCountry:          v(17),

    // Pricing
    totalPrice:             v(18),
    publicPrice:            v(19),
    memberPriceLessCredits: v(20),
    memberPrice:            v(21),
    redeemedTCs:            v(22),
    redeemedLPs:            v(23),
    memberSavings:          v(24),
    earnedTC:               v(25),
    netPrice:               v(26),
    netPlusFactor:          v(27),
    pAndL:                  v(28),
    turboDiscount:          v(29),
    membershipPrice:        v(31),
    tripProtectionPrice:    v(32),
    healthInsurancePrice:   v(33),

    // Destination & dates
    destinationCountry:     v(34),
    destinationCity:        v(35),
    checkIn:                v(36),
    checkOut:               v(37),
    locationFrom:           v(38),
    locationTo:             v(39),
    returnLocationFrom:     v(40),
    returnLocationTo:       v(41),
  };
}

// ─── Parse booking detail page HTML ──────────────────────────────────────────
// Returns cleaned HTML of the service section (strips T&Cs and billing).
function parseBookingHtml(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const body = doc.querySelector('.card .body');
  if (!body) return { cleanHtml: '<p>Could not parse booking details.</p>', raw: {} };

  // Remove T&Cs, billing, scripts, styles, modals
  ['script', 'style', '.modal', '.important_note_banner'].forEach(sel => {
    body.querySelectorAll(sel).forEach(el => el.remove());
  });

  // Remove "Terms and Conditions" header and everything after it
  const termsHeader = [...body.querySelectorAll('h5')].find(
    h => h.textContent.trim().toLowerCase() === 'terms and conditions' ||
         h.textContent.trim().toLowerCase().includes('cancellation policy')
  );
  if (termsHeader) {
    let el = termsHeader;
    while (el) {
      const next = el.nextElementSibling;
      el.remove();
      el = next;
    }
  }

  // Remove billing information section
  const billingDivs = body.querySelectorAll('.confirmation_billling_info, .billing_info');
  billingDivs.forEach(el => el.remove());

  // Also cut at "Billing Information" text if present
  const allParas = body.querySelectorAll('p, h5, hr');
  let cutting = false;
  allParas.forEach(el => {
    if (el.textContent.trim().toLowerCase().includes('billing information')) cutting = true;
    if (cutting) el.remove();
  });

  // ── Extract hotel name from rendered text ────────────────────────────────
  let hotelName = null;
  const bodyText = body.textContent || '';
  const lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const hotelIdx = lines.indexOf('Hotel');
  if (hotelIdx !== -1 && hotelIdx + 1 < lines.length) {
    hotelName = lines[hotelIdx + 1];
  }

  return {
    cleanHtml: body.innerHTML.trim(),
    hotelName,
  };
}

module.exports = { parseDataRow, parseBookingHtml, stripHtml, extractHref };
