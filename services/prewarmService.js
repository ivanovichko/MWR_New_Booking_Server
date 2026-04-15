const fetch = require('node-fetch');
const { taPost, taGet } = require('./taAuthService');
const { parseDataRow, parseBookingHtml } = require('./parserService');
const { parseUserHtml } = require('./userService');
const { buildNoteHtml } = require('./noteBuilder');
const { lookupSupplier } = require('./supplierService');
const { searchDuplicates } = require('./freshdeskService');
const { cacheBooking, storeTicketSummary, getCachedBooking } = require('./dbService');

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

  // TA status codes: 0=confirmed, 3=pending, 2=cancelled
  // Validate first result matches searched ID to avoid false matches
  for (const status of [0, 3, 2]) {
    const url = `https://traveladvantage.com/admin/bookings/bookingsList/All/${status}/All/null/null/All/${bookingId}`;
    const data = await taPost(url, buildDataTableParams(bookingId));
    if (data?.data?.length > 0) {
      const row = data.data[0];
      const parsed = parseDataRow(row);
      // Validate: either internal ID or supplier ref must match
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

// ─── Set Freshdesk ticket status ─────────────────────────────────────────────
async function setTicketStatus(ticketId, status, priority = null) {
  const domain = process.env.FRESHDESK_DOMAIN;
  const apiKey = process.env.FRESHDESK_API_KEY;
  const body = { status };
  if (priority !== null) body.priority = priority;
  await fetch(`https://${domain}/api/v2/tickets/${ticketId}`, {
    method: 'PUT',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${apiKey}:X`).toString('base64'),
      'Content-Type': 'application/json',
    },
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
      // If this month/day already passed this year, use next year
      const candidate = new Date(year, monthIdx, day);
      if (candidate < now) year++;
      return new Date(year, monthIdx, day).toISOString().split('T')[0];
    }
  }
  return null;
}

async function extractDateFromTagsWithGroq(tags) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !tags?.length) return null;
  const prompt = `Extract a check-in date from these ticket tags: ${JSON.stringify(tags)}
Return ONLY a JSON object, no markdown: { "date": "YYYY-MM-DD or null" }`;
  try {
    const res = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 50,
      }),
    });
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return parsed.date || null;
  } catch { return null; }
}

// ─── Check pending tickets ────────────────────────────────────────────────────
async function checkPendings(onProgress, isStopped = () => false) {
  const progress = (msg) => { console.log(msg); onProgress?.(msg); };
  const domain  = process.env.FRESHDESK_DOMAIN;
  const apiKey  = process.env.FRESHDESK_API_KEY;
  const agentId = process.env.FRESHDESK_AGENT_ID;
  if (!agentId) throw new Error('FRESHDESK_AGENT_ID not set');

  progress('📋 Fetching pending tickets...');
  const query = encodeURIComponent(`status:3 AND agent_id:${agentId}`);
  const tickets = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `https://${domain}/api/v2/search/tickets?query="${query}"&page=${page}`,
      { headers: { 'Authorization': 'Basic ' + Buffer.from(`${apiKey}:X`).toString('base64') } }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to fetch pending tickets: ${res.status} — ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const batch = data.results || [];
    tickets.push(...batch);
    if (batch.length < 30) break; // last page
    page++;
  }
  progress(`📋 Found ${tickets.length} pending ticket(s)`);

  const results = { reopened: 0, skipped: 0, noDate: 0, errors: 0 };

  for (const ticket of tickets) {
    if (isStopped()) { progress('🛑 Stopped by user.'); break; }
    try {
      const tags = ticket.tags || [];

      // Regex only: MMM-DD or MMM DD
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

// ─── Main prewarm function ────────────────────────────────────────────────────
async function prewarm(onProgress, isStopped = () => false) {
  const progress = (msg) => { console.log(msg); onProgress?.(msg); };

  progress('📋 Fetching LOW priority tickets...');
  const tickets = await fetchLowPriorityTickets();
  progress(`📋 Found ${tickets.length} tickets`);

  const results = [];

  for (const ticket of tickets) {
    if (isStopped()) { progress('🛑 Stopped by user.'); break; }
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

      // Check if already cached — skip TA fetch if so
      const existing = await getCachedBooking(bookingId);
      if (existing) {
        progress(`⚡ #${ticket.id} → ${bookingId} already cached, skipping TA fetch`);
        await storeTicketSummary({ ticketId: String(ticket.id), bookingId, summary });
        results.push({ ticketId: ticket.id, bookingId, status: 'already_cached', summary, isNewBooking });
        continue;
      }

      const { booking, cleanHtml, details, user, supplier } = await fetchAndCacheBooking(bookingId);
      await storeTicketSummary({ ticketId: String(ticket.id), bookingId, summary });

      if (!isNewBooking) {
        progress(`📦 #${ticket.id} → ${bookingId} cached (not a new booking, skipping actions)`);
        results.push({ ticketId: ticket.id, bookingId, status: 'cached', summary, isNewBooking, daysUntil: null });
        continue;
      }

      // New booking — check-in date priority
      const dateInfo = checkInPriority(booking.checkIn);
      const actions = ['note_posted'];

      if (dateInfo) {
        progress(`📅 #${ticket.id} — check-in in ${dateInfo.daysUntil} days (${dateInfo.label} priority)`);
        if (dateInfo.priority > 1) {
          await setTicketPriority(ticket.id, dateInfo.priority);
          actions.push(`priority_${dateInfo.label}`);
          progress(`🔺 #${ticket.id} — priority set to ${dateInfo.label.toUpperCase()}`);
        }
      }

      // Post the standard booking note
      const noteHtml = buildNoteHtml(booking, cleanHtml, details, user, supplier);
      await postNote(ticket.id, noteHtml);

      // Duplicate check — run three parallel searches
      let dupCount = 0;
      try {
        const [byVendor, byInternal, byEmail] = await Promise.all([
          booking.supplierId        ? searchDuplicates(booking.supplierId,        ticket.id)        : [],
          booking.internalBookingId ? searchDuplicates(booking.internalBookingId, ticket.id)        : [],
          user?.email               ? searchDuplicates(user.email,                ticket.id, true)  : [],
        ]);

        const seen = new Map();
        for (const t of byVendor)   { if (!seen.has(t.id)) seen.set(t.id, { ...t, matchedBy: ['supplier ref'] }); else seen.get(t.id).matchedBy.push('supplier ref'); }
        for (const t of byInternal) { if (!seen.has(t.id)) seen.set(t.id, { ...t, matchedBy: ['booking ID'] });   else seen.get(t.id).matchedBy.push('booking ID'); }
        for (const t of byEmail)    { if (!seen.has(t.id)) seen.set(t.id, { ...t, matchedBy: ['member email'] }); else seen.get(t.id).matchedBy.push('member email'); }

        const duplicates = [...seen.values()];
        dupCount = duplicates.length;

        if (duplicates.length > 0) {
          actions.push(`duplicates_${duplicates.length}`);
          progress(`⚠️ #${ticket.id} — ${duplicates.length} open thread(s) found`);
          const rows = duplicates.map(t =>
            `<tr><td style="padding:4px 8px;"><a href="https://mwrlife.freshdesk.com/a/tickets/${t.id}" target="_blank">#${t.id}</a></td>` +
            `<td style="padding:4px 8px;">${t.subject || '—'}</td>` +
            `<td style="padding:4px 8px;color:#856404;">matched by: ${(t.matchedBy || []).join(', ')}</td></tr>`
          ).join('');
          const dupNoteHtml =
            `<p><strong>⚠️ Open Threads Found</strong></p>` +
            `<table style="width:100%;border-collapse:collapse;font-size:13px;"><tbody>${rows}</tbody></table>`;
          await postNote(ticket.id, dupNoteHtml);
        }
      } catch (e) {
        progress(`⚠️ #${ticket.id} — duplicate check failed: ${e.message}`);
      }

      progress(`✅ #${ticket.id} → ${bookingId} cached + processed as new booking`);
      results.push({ ticketId: ticket.id, bookingId, status: 'cached', summary, isNewBooking, daysUntil: dateInfo?.daysUntil ?? null, actions, dupCount });

    } catch (err) {
      progress(`❌ #${ticket.id} — ${err.message}`);
      results.push({ ticketId: ticket.id, status: 'error', error: err.message });
    }

    await new Promise(r => setTimeout(r, 500));
  }

  const cached   = results.filter(r => r.status === 'cached').length;
  const skipped  = results.filter(r => r.status === 'already_cached').length;
  const newBooks = results.filter(r => r.isNewBooking).length;
  const prioBumped = results.filter(r => r.actions?.some(a => a.startsWith('priority_'))).length;
  const withDups   = results.filter(r => r.dupCount > 0).length;
  const errors     = results.filter(r => r.status === 'error').length;

  progress(`🎉 Prewarm complete — ${cached} new cached, ${skipped} already cached, ${errors} errors (${tickets.length} total)`);
  if (newBooks)    progress(`🆕 New bookings detected: ${newBooks}`);
  if (prioBumped)  progress(`🔺 Priority bumped: ${prioBumped}`);
  if (withDups)    progress(`⚠️ Open threads found: ${withDups} tickets`);
  return results;
}

module.exports = { prewarm, fetchAndCacheBooking, extractBookingId, checkInPriority, checkPendings, postNote, setTicketPriority };
