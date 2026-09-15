// TravelAdvantage booking lookup + booking-reference extraction.
//
// Helpdesk-agnostic by construction: the only inputs are a subject/description
// pair and a booking reference, so nothing here knows or cares which helpdesk
// the ticket came from. Formerly prewarmService.js, named for the Freshdesk
// Assisted-mode prewarm that no longer exists.

const fetch = require('node-fetch');
const { taPost, taGet } = require('./taAuthService');
const { parseDataRow, parseBookingHtml } = require('./parserService');
const { parseUserHtml } = require('./userService');
const { lookupSupplier } = require('./supplierService');
const { cacheBooking } = require('./dbService');

// Defaults to Groq direct. Set GROQ_API_URL to a proxy endpoint (e.g. a
// Cloudflare Worker) when Groq blocks the host's egress IP with a 403
// "Access denied. Please check your network settings."
const GROQ_API_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';

// ─── Extract a booking reference from ticket text using Groq ─────────────────
// Returns { bookingId } — null when the ticket carries no usable reference.
async function extractBookingId({ subject = '', description = '' }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const content = [subject, description].join('\n').slice(0, 2000);

  const prompt = `Extract the booking or reservation reference number from this travel support ticket.

RULES:
- Extract ANY booking reference: TravelAdvantage IDs, supplier confirmation numbers, file numbers, order numbers, reservation numbers, voucher references — all are valid
- Examples of valid references: MWRLMA032625243, XN3GJM, 72221376, 53948866, 352528, 9086256618297
- If multiple references exist, pick the most prominent one (usually in the subject or at the top of the ticket)
- Do NOT return email addresses, phone numbers, prices, or dates
- If no reference can be found, return null

Ticket:
${content}

Return ONLY a JSON object, no markdown:
{ "bookingId": "the reference number or null if not found" }`;

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-20b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      reasoning_effort: 'low',
      // gpt-oss spends completion tokens on reasoning before it emits any
      // content, so the budget has to cover both — the JSON itself is ~40.
      max_tokens: 512,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw  = data?.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { bookingId: null };
  }
}

// ─── Build DataTables POST params ─────────────────────────────────────────────
function buildDataTableParams(bookingId) {
  const params = new URLSearchParams({
    draw: '1', start: '0', length: '10',
    'order[0][column]': '1', 'order[0][dir]': 'desc',
    'search[value]': bookingId, 'search[regex]': 'false',
  });
  const nonOrderable = [0, 9, 10, 19, 24, 25, 26, 27, 29, 30, 37, 38, 39];
  for (let i = 0; i <= 44; i++) {
    params.append(`columns[${i}][data]`, i.toString());
    params.append(`columns[${i}][name]`, '');
    params.append(`columns[${i}][searchable]`, 'true');
    params.append(`columns[${i}][orderable]`, nonOrderable.includes(i) ? 'false' : 'true');
    params.append(`columns[${i}][search][value]`, '');
    params.append(`columns[${i}][search][regex]`, 'false');
  }
  return params.toString();
}

// ─── Booking-list date range ─────────────────────────────────────────────────
// TA's bookingsList now filters on a date range (the two date slots in the path
// that used to be `null/null`). Flights in particular no longer return without
// one. Default window: 1 year in the past → today (YYYY-MM-DD, path-safe).
function fmtDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function bookingDateRange() {
  const to   = new Date();
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  return { from: fmtDate(from), to: fmtDate(to) };
}

// ─── Extract href from HTML string ───────────────────────────────────────────
function extractHref(str) {
  if (!str) return null;
  const match = str.match(/href=['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

// ─── Fetch and cache a single booking ────────────────────────────────────────
async function fetchAndCacheBooking(bookingId) {
  let dataRow = null;

  // TA status codes: 0=confirmed, 3=pending, 2=cancelled
  // Validate first result matches searched ID to avoid false matches
  const { from, to } = bookingDateRange();
  for (const status of [0, 3, 2]) {
    const url = `https://traveladvantage.com/admin/bookings/bookingsList/All/${status}/All/${from}/${to}/All/null/null/${bookingId}`;
    const data = await taPost(url, buildDataTableParams(bookingId));
    if (data?.data?.length > 0) {
      const row = data.data[0];
      const parsed = parseDataRow(row);
      const idMatch = parsed.internalBookingId === bookingId ||
                      parsed.supplierId === bookingId ||
                      (parsed.internalBookingId || '').includes(bookingId) ||
                      bookingId.includes(parsed.internalBookingId || '') ||
                      (parsed.supplierId || '').toLowerCase() === bookingId.toLowerCase();
      if (idMatch) { dataRow = row; break; }
    }
  }

  if (!dataRow) throw new Error(`Booking ${bookingId} not found in TA`);

  const detailUrl = extractHref(dataRow[0]);
  const userUrl   = extractHref(dataRow[4]);

  if (!detailUrl) throw new Error(`No detail URL for booking ${bookingId}`);

  const [bookingHtml, userHtml] = await Promise.all([
    taGet(detailUrl),
    userUrl ? taGet(userUrl) : Promise.resolve('<div></div>'),
  ]);

  const booking = parseDataRow(dataRow);
  const { cleanHtml, details } = parseBookingHtml(bookingHtml);
  const user     = parseUserHtml(userHtml);
  const supplier = lookupSupplier(booking.supplierName);

  await cacheBooking({
    bookingId,
    dataRow,
    bookingHtml,
    userHtml,
    parsed: { booking, details, user },
  });

  return { booking, details, user, supplier, cleanHtml };
}

module.exports = { extractBookingId, fetchAndCacheBooking };
