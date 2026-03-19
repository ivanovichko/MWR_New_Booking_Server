const fetch = require('node-fetch');
const { taPost, taGet } = require('./taAuthService');
const { parseDataRow, parseBookingHtml } = require('./parserService');
const { parseUserHtml } = require('./userService');
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
async function extractBookingId(ticket) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const content = [
    ticket.subject || '',
    ticket.description_text || ticket.description || '',
  ].join('\n').slice(0, 2000);

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
{
  "bookingId": "the reference number or null if not found",
  "summary": "one-line issue summary (max 10 words)"
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
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { bookingId: null, summary: 'Could not parse' };
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
  const user = parseUserHtml(userHtml);

  await cacheBooking({
    bookingId,
    dataRow,
    bookingHtml,
    userHtml,
    parsed: { booking, details, user },
  });

  return { booking, details, user };
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
      const { bookingId, summary } = await extractBookingId(fullTicket);

      if (!bookingId) {
        progress(`⚠️  #${ticket.id} — no booking ID found`);
        await storeTicketSummary({ ticketId: String(ticket.id), bookingId: null, summary });
        results.push({ ticketId: ticket.id, status: 'no_booking_id', summary });
        continue;
      }

      progress(`📦 Fetching booking ${bookingId} for ticket #${ticket.id}...`);
      await fetchAndCacheBooking(bookingId);
      await storeTicketSummary({ ticketId: String(ticket.id), bookingId, summary });

      progress(`✅ #${ticket.id} → ${bookingId} cached`);
      results.push({ ticketId: ticket.id, bookingId, status: 'cached', summary });

    } catch (err) {
      progress(`❌ #${ticket.id} — ${err.message}`);
      results.push({ ticketId: ticket.id, status: 'error', error: err.message });
    }

    await new Promise(r => setTimeout(r, 500));
  }

  progress(`🎉 Prewarm complete — ${results.filter(r => r.status === 'cached').length}/${tickets.length} cached`);
  return results;
}

module.exports = { prewarm, fetchAndCacheBooking, extractBookingId };
