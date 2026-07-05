const fetch = require('node-fetch');
const { taPost, taGet } = require('./taAuthService');
const { parseDataRow, parseBookingHtml } = require('./parserService');
const { parseUserHtml } = require('./userService');
const { lookupSupplier } = require('./supplierService');
const { getAuthHeader } = require('./freshdeskService');
const { FD_STATUS } = require('../config');
const { cacheBooking } = require('./dbService');

// Defaults to Groq direct. Set GROQ_API_URL to a proxy endpoint (e.g. a
// Cloudflare Worker) when Groq blocks the host's egress IP with a 403
// "Access denied. Please check your network settings."
const GROQ_API_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';

// ─── Extract booking ID from ticket using Groq ───────────────────────────────
async function extractBookingId(ticket, conversationCount = null) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const content = [
    ticket.subject || '',
    ticket.description_text || ticket.description || '',
  ].join('\n').slice(0, 2000);

  // Short-circuit: if more than 1 conversation, definitely not a new booking
  const isDefinitelyOld = conversationCount !== null && conversationCount > 1;

  const prompt = `Extract the booking or reservation reference number from this travel support ticket.

RULES:
- Extract ANY booking reference: TravelAdvantage IDs, supplier confirmation numbers, file numbers, order numbers, reservation numbers, voucher references — all are valid
- Examples of valid references: MWRLMA032625243, XN3GJM, 72221376, 53948866, 352528, 9086256618297
- If multiple references exist, pick the most prominent one (usually in the subject or at the top of the ticket)
- Do NOT return email addresses, phone numbers, prices, or dates
- If no reference can be found, return null

NEW BOOKING DETECTION:
- Set isNewBooking to true ONLY if ALL of the following are true:
  1. The body reads like a forwarded supplier confirmation (structured data, dates, booking details)
  2. No customer questions, requests, or complaints present
  3. No quoted reply chains or previous correspondence (no "> " lines, no "From:" headers)
- If ANY doubt exists, set isNewBooking to false

Ticket:
${content}

Return ONLY a JSON object, no markdown:
{
  "bookingId": "the reference number or null if not found",
  "summary": "one-line issue summary (max 10 words)",
  "isNewBooking": true or false
}`;

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 100,
    }),
  });

  const data = await res.json();
  const raw  = data?.choices?.[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (isDefinitelyOld) parsed.isNewBooking = false;
    return parsed;
  } catch {
    return { bookingId: null, summary: 'Could not parse', isNewBooking: false };
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

// ─── Check-in date priority logic ────────────────────────────────────────────
// Returns { priority: 1|2|3, label: 'low'|'medium'|'high', daysUntil: N }
function checkInPriority(checkInStr) {
  if (!checkInStr) return null;

  const months = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
  const match = checkInStr.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  let checkIn;
  if (match) {
    const m = months[match[1].toLowerCase()];
    if (m === undefined) return null;
    checkIn = new Date(parseInt(match[3]), m, parseInt(match[2]));
  } else {
    checkIn = new Date(checkInStr);
    if (isNaN(checkIn)) return null;
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  checkIn.setHours(0, 0, 0, 0);
  const daysUntil = Math.round((checkIn - now) / (1000 * 60 * 60 * 24));

  if (daysUntil < 3)  return { priority: 3, label: 'high',   daysUntil };
  if (daysUntil < 7)  return { priority: 2, label: 'medium', daysUntil };
  return                     { priority: 1, label: 'low',    daysUntil };
}

// ─── Set Freshdesk ticket status ─────────────────────────────────────────────
async function setTicketStatus(ticketId, status, priority = null) {
  const domain = process.env.FRESHDESK_DOMAIN;
  const body = { status };
  if (priority !== null) body.priority = priority;
  await fetch(`https://${domain}/api/v2/tickets/${ticketId}`, {
    method: 'PUT',
    headers: { 'Authorization': getAuthHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Extract check-in date from tags ─────────────────────────────────────────
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function extractDateFromTags(tags) {
  for (const tag of (tags || [])) {
    // Match MMM-DD or MMM DD (e.g. Mar-25, Apr 02)
    const m = tag.match(/^([A-Za-z]{3})[-\s](\d{1,2})$/);
    if (m) {
      const monthIdx = MONTHS[m[1].toLowerCase()];
      if (monthIdx === undefined) continue;
      const day = parseInt(m[2]);
      const now = new Date();
      let year = now.getFullYear();
      const candidate = new Date(year, monthIdx, day);
      if (candidate < now) year++;
      return new Date(year, monthIdx, day).toISOString().split('T')[0];
    }
  }
  return null;
}

// ─── Check pending tickets ────────────────────────────────────────────────────
// Reopens pending tickets whose tagged check-in date is within 7 days.
async function checkPendings(onProgress, isStopped = () => false) {
  const progress = (msg) => { console.log(msg); onProgress?.(msg); };
  const domain  = process.env.FRESHDESK_DOMAIN;
  const agentId = process.env.FRESHDESK_AGENT_ID;
  if (!agentId) throw new Error('FRESHDESK_AGENT_ID not set');

  progress('📋 Fetching pending tickets...');
  const query = encodeURIComponent(`status:${FD_STATUS.PENDING} AND agent_id:${agentId}`);
  const tickets = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://${domain}/api/v2/search/tickets?query="${query}"&page=${page}`,
      { headers: { 'Authorization': getAuthHeader() } }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to fetch pending tickets: ${res.status} — ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const batch = data.results || [];
    tickets.push(...batch);
    if (batch.length < 30) break;
    page++;
  }
  progress(`📋 Found ${tickets.length} pending ticket(s)`);

  const results = { reopened: 0, skipped: 0, noDate: 0, errors: 0 };

  for (const ticket of tickets) {
    if (isStopped()) { progress('🛑 Stopped by user.'); break; }
    try {
      const tags = ticket.tags || [];
      const dateStr = extractDateFromTags(tags);

      if (!dateStr) {
        progress(`⚠️  #${ticket.id} — no date found in tags: [${tags.join(', ')}]`);
        results.noDate++;
        continue;
      }

      const dateInfo = checkInPriority(dateStr);
      if (!dateInfo) {
        progress(`⚠️  #${ticket.id} — could not parse date: ${dateStr}`);
        results.noDate++;
        continue;
      }

      if (dateInfo.daysUntil < 7) {
        const priorityLabel = dateInfo.daysUntil < 3 ? 'HIGH' : 'MEDIUM';
        const priority = dateInfo.daysUntil < 3 ? 3 : 2;
        await setTicketStatus(ticket.id, 2, priority); // 2 = Open
        progress(`🔺 #${ticket.id} — check-in in ${dateInfo.daysUntil} days → reopened (${priorityLabel})`);
        results.reopened++;
      } else {
        progress(`✅ #${ticket.id} — check-in in ${dateInfo.daysUntil} days, leaving pending`);
        results.skipped++;
      }
    } catch (err) {
      progress(`❌ #${ticket.id} — ${err.message}`);
      results.errors++;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  progress(`🎉 Done — ${results.reopened} reopened, ${results.skipped} left pending, ${results.noDate} no date, ${results.errors} errors`);
  if (results.reopened > 0) progress(`🔺 Reopened tickets: ${results.reopened} (within 7 days of check-in)`);
  return results;
}

module.exports = { fetchAndCacheBooking, extractBookingId, checkInPriority, checkPendings };
