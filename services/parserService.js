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
// Returns cleaned HTML + structured hotel fields for email building.
function parseBookingHtml(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const body = doc.querySelector('.card .body') || doc.querySelector('.body');
  if (!body) return { cleanHtml: '<p>Could not parse booking details.</p>', details: {} };

  // ── Helper: get text after a <strong> label ───────────────────────────────
  const getField = (labelText) => {
    const strongs = [...body.querySelectorAll('strong')];
    const strong = strongs.find(s => s.textContent.trim().toLowerCase().startsWith(labelText.toLowerCase()));
    if (!strong) return null;
    // Text is either a sibling span, next sibling text node, or parent p's remaining text
    const parent = strong.closest('p') || strong.parentElement;
    if (!parent) return null;
    // Clone and remove the strong to get the remaining text
    const clone = parent.cloneNode(true);
    clone.querySelectorAll('strong').forEach(s => s.remove());
    // Also remove <small> for bed types (we'll keep it separately)
    const small = clone.querySelector('small');
    const smallText = small?.textContent?.trim() || null;
    small?.remove();
    const text = clone.textContent.replace(/\s+/g, ' ').trim();
    return text || null;
  };

  // ── Hotel name ────────────────────────────────────────────────────────────
  // First <strong> inside the Hotel section (after <h5>Hotel</h5>)
  const h5s = [...body.querySelectorAll('h5')];
  const hotelH5 = h5s.find(h => h.textContent.trim() === 'Hotel');
  let hotelName = null;
  let hotelAddress = null;
  let hotelPhone = null;

  if (hotelH5) {
    // hotel name is in the first <strong> after the h5
    let el = hotelH5.nextElementSibling;
    while (el && !hotelName) {
      const strong = el.querySelector('strong');
      if (strong) hotelName = strong.textContent.trim();
      el = el.nextElementSibling;
    }
    // address is in the <span> after the map link paragraph
    el = hotelH5.nextElementSibling;
    let foundMap = false;
    while (el) {
      if (el.textContent.includes('View Map')) { foundMap = true; el = el.nextElementSibling; continue; }
      if (foundMap && el.tagName === 'P' && !hotelAddress) {
        hotelAddress = el.textContent.trim();
        el = el.nextElementSibling;
        // phone is the next <p> with just a number
        if (el && /^\d[\d\s]+$/.test(el.textContent.trim())) {
          hotelPhone = el.textContent.trim();
        }
        break;
      }
      el = el.nextElementSibling;
    }
  }

  // ── Structured fields ─────────────────────────────────────────────────────
  const checkIn      = getField('Check-in:');
  const checkOut     = getField('Check-out:');
  const roomDetails  = getField('Room Details:');
  const guestName    = getField('Guest Name(s):');
  const vendorConf   = body.querySelector('.cls_api_booking_id')?.textContent?.trim()
                       || getField('Vendor confirmation number:');
  const reservation  = getField('Reservation:');
  const requests     = getField('Requests for the hotel:');
  const arrivalTime  = getField('Estimated Time of Arrival:');

  // Bed types — keep <small> text too
  const bedStrong = [...body.querySelectorAll('strong')].find(s => s.textContent.trim().startsWith('Bed Types'));
  let bedTypes = null;
  if (bedStrong) {
    const p = bedStrong.closest('p') || bedStrong.parentElement;
    if (p) bedTypes = p.textContent.replace('Bed Types:', '').replace(/\s+/g, ' ').trim();
  }

  // Adults / Child / Room
  const adultsStrong = [...body.querySelectorAll('strong')].find(s => s.textContent.trim().startsWith('Adults:'));
  let paxLine = null;
  if (adultsStrong) {
    const p = adultsStrong.closest('p') || adultsStrong.parentElement;
    if (p) paxLine = p.textContent.replace(/\s+/g, ' ').trim();
  }

  // ── Clean HTML for note display ───────────────────────────────────────────
  // Remove T&Cs, billing, scripts, styles, modals, forms
  ['script', 'style', '.modal', '.important_note_banner', 'form', 'link'].forEach(sel => {
    body.querySelectorAll(sel).forEach(el => el.remove());
  });

  const termsHeader = [...body.querySelectorAll('h5')].find(
    h => h.textContent.trim().toLowerCase().includes('terms and conditions') ||
         h.textContent.trim().toLowerCase().includes('cancellation policy')
  );
  if (termsHeader) {
    let el = termsHeader;
    while (el) { const next = el.nextElementSibling; el.remove(); el = next; }
  }

  body.querySelectorAll('.confirmation_billling_info, .billing_info, .TripProtection').forEach(el => el.remove());

  return {
    cleanHtml: body.innerHTML.trim(),
    details: {
      hotelName,
      hotelAddress,
      hotelPhone,
      checkIn,
      checkOut,
      roomDetails,
      bedTypes,
      paxLine,
      guestName,
      vendorConf,
      reservation,
      requests,
      arrivalTime,
    },
  };
}

module.exports = { parseDataRow, parseBookingHtml, stripHtml, extractHref };
