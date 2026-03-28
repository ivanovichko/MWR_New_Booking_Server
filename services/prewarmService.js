const fetch = require('node-fetch');
const { taPost, taGet } = require('./taAuthService');
const { parseDataRow, parseBookingHtml } = require('./parserService');
const { parseUserHtml } = require('./userService');
const { buildNoteHtml } = require('./noteBuilder');
const { lookupSupplier } = require('./supplierService');
const { cacheBooking, storeTicketSummary } = require('./dbService');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ─── Fetch LOW priority tickets assigned to agent ────────────────────────────
async function fetchLowPriorityTickets() {
  const domain  = process.env.FRESHDESK_DOMAIN;
  const apiKey  = process.env.FRESHDESK_API_KEY;
  const agentId = process.env.FRESHDESK_AGENT_ID;

  if (!agentId) throw new Error('FRESHDESK_AGENT_ID not set in environment');

  const headers = {
    'Authorization': 'Basic ' + Buffer.from(`${apiKey}:X`).toString('base64'),
  };

  let allTickets = [];
  let page = 1;

  while (true) {
    const url = `https://${domain}/api/v2/tickets?filter=new_and_my_open&per_page=100&page=${page}`;
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Freshdesk ticket fetch failed: ${res.status} — ${body}`);
    }

    const results = await res.json();
    if (!results.length) break;

    allTickets = allTickets.concat(results);
    if (results.length < 100) break;
    page++;
  }

  // Filter to LOW priority (1) in code
  const filtered = allTickets.filter(t => t.priority === 1);
  console.log(`📋 Total assigned tickets: ${allTickets.length}, LOW priority: ${filtered.length}`);
  return filtered;
}

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
    // Apply conversation count override
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

// ─── Extract href from HTML string ───────────────────────────────────────────
function extractHref(str) {
  if (!str) return null;
  const match = str.match(/href=['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

// ─── Fetch and cache a single booking ────────────────────────────────────────
async function fetchAndCacheBooking(bookingId) {
  let dataRow = null;
  for (const status of [0, 3]) {
    const url = `https://traveladvantage.com/admin/bookings/bookingsList/All/${status}/All/null/null/All/${bookingId}`;
    const data = await taPost(url, buildDataTableParams(bookingId));
    if (data?.data?.length > 0) { dataRow = data.data[0]; break; }
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

// ─── Check-in date priority logic (reusable) ─────────────────────────────────
// Returns { priority: 1|2|3, label: 'low'|'medium'|'high', daysUntil: N }
// Freshdesk priorities: 1=Low, 2=Medium, 3=High, 4=Urgent
function checkInPriority(checkInStr) {
  if (!checkInStr) return null;

  // Parse text date like "April 14, 2026" or "March 25, 2026"
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

// ─── Set Freshdesk ticket priority ───────────────────────────────────────────
async function setTicketPriority(ticketId, priority) {
  const domain = process.env.FRESHDESK_DOMAIN;
  const apiKey = process.env.FRESHDESK_API_KEY;
  await fetch(`https://${domain}/api/v2/tickets/${ticketId}`, {
    method: 'PUT',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${apiKey}:X`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ priority }),
  });
}

// ─── Post Freshdesk note ──────────────────────────────────────────────────────
async function postNote(ticketId, bodyHtml) {
  const domain = process.env.FRESHDESK_DOMAIN;
  const apiKey = process.env.FRESHDESK_API_KEY;
  await fetch(`https://${domain}/api/v2/tickets/${ticketId}/notes`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${apiKey}:X`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: bodyHtml, private: true }),
  });
}

// ─── Main prewarm function ────────────────────────────────────────────────────
async function prewarm(onProgress) {
  const progress = (msg) => { console.log(msg); onProgress?.(msg); };

  progress('📋 Fetching LOW priority tickets...');
  const tickets = await fetchLowPriorityTickets();
  progress(`📋 Found ${tickets.length} tickets`);

  const results = [];

  for (const ticket of tickets) {
    try {
      // Fetch full ticket if description missing
      let fullTicket = ticket;
      if (!ticket.description_text && !ticket.description) {
        const domain = process.env.FRESHDESK_DOMAIN;
        const apiKey = process.env.FRESHDESK_API_KEY;
        const res = await fetch(`https://${domain}/api/v2/tickets/${ticket.id}`, {
          headers: { 'Authorization': 'Basic ' + Buffer.from(`${apiKey}:X`).toString('base64') },
        });
        if (res.ok) fullTicket = await res.json();
      }

      progress(`🔍 Reading ticket #${ticket.id}: ${ticket.subject?.slice(0, 50)}`);

      // Fetch conversation count — 1 = possible new booking, >1 = skip detection
      let conversationCount = null;
      try {
        const domain = process.env.FRESHDESK_DOMAIN;
        const apiKey = process.env.FRESHDESK_API_KEY;
        const convRes = await fetch(`https://${domain}/api/v2/tickets/${ticket.id}/conversations`, {
          headers: { 'Authorization': 'Basic ' + Buffer.from(`${apiKey}:X`).toString('base64') },
        });
        if (convRes.ok) {
          const convData = await convRes.json();
          conversationCount = Array.isArray(convData) ? convData.length : null;
        }
      } catch (e) { /* non-fatal */ }

      const { bookingId, summary, isNewBooking } = await extractBookingId(fullTicket, conversationCount);

      if (isNewBooking) {
        progress(`🆕 #${ticket.id} — detected as new booking`);
        // Tag the ticket with new_booking
        try {
          const domain = process.env.FRESHDESK_DOMAIN;
          const apiKey = process.env.FRESHDESK_API_KEY;
          // First get existing tags to avoid overwriting
          const tRes = await fetch(`https://${domain}/api/v2/tickets/${ticket.id}`, {
            headers: { 'Authorization': 'Basic ' + Buffer.from(`${apiKey}:X`).toString('base64') },
          });
          if (tRes.ok) {
            const tData = await tRes.json();
            const existingTags = tData.tags || [];
            if (!existingTags.includes('new_booking')) {
              await fetch(`https://${domain}/api/v2/tickets/${ticket.id}`, {
                method: 'PUT',
                headers: {
                  'Authorization': 'Basic ' + Buffer.from(`${apiKey}:X`).toString('base64'),
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ tags: [...existingTags, 'new_booking'] }),
              });
            }
          }
        } catch (e) { progress(`⚠️ Could not tag #${ticket.id}: ${e.message}`); }
      }

      if (!bookingId) {
        progress(`⚠️  #${ticket.id} — no booking ID found`);
        await storeTicketSummary({ ticketId: String(ticket.id), bookingId: null, summary });
        results.push({ ticketId: ticket.id, status: 'no_booking_id', summary });
        continue;
      }

      progress(`📦 Fetching booking ${bookingId} for ticket #${ticket.id}...`);
      const { booking, cleanHtml, details, user, supplier } = await fetchAndCacheBooking(bookingId);
      await storeTicketSummary({ ticketId: String(ticket.id), bookingId, summary });

      // Check-in date priority
      const dateInfo = checkInPriority(booking.checkIn);

      if (dateInfo) {
        progress(`📅 #${ticket.id} — check-in in ${dateInfo.daysUntil} days (${dateInfo.label} priority)`);
        if (dateInfo.priority > 1) {
          await setTicketPriority(ticket.id, dateInfo.priority);
          progress(`🔺 #${ticket.id} — priority set to ${dateInfo.label.toUpperCase()}`);
        }
      }

      // Post the standard booking note
      const noteHtml = buildNoteHtml(booking, cleanHtml, details, user, supplier);
      await postNote(ticket.id, noteHtml);

      progress(`✅ #${ticket.id} → ${bookingId} cached`);
      results.push({ ticketId: ticket.id, bookingId, status: 'cached', summary, isNewBooking, daysUntil: dateInfo?.daysUntil ?? null });

    } catch (err) {
      progress(`❌ #${ticket.id} — ${err.message}`);
      results.push({ ticketId: ticket.id, status: 'error', error: err.message });
    }

    await new Promise(r => setTimeout(r, 500));
  }

  progress(`🎉 Prewarm complete — ${results.filter(r => r.status === 'cached').length}/${tickets.length} cached`);
  return results;
}

module.exports = { prewarm, fetchAndCacheBooking, extractBookingId, checkInPriority };
