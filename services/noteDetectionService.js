const { groqJson } = require('./aiService');

const TRIAGE_MODEL = process.env.TRIAGE_MODEL || 'llama-3.3-70b-versatile';

// ─── Tier 1: deterministic marker scan ───────────────────────────────────────
// Markers emitted by noteBuilder.buildNoteHtml / buildShortNoteHtml. Anything
// the current code posts is caught here for free, so Groq only ever sees notes
// in older or hand-written formats.
const NOTE_MARKERS = [
  '📋 Booking Summary',
  '💰 Financial Details',
  '🗓 Service Details',
  '👤 Primary Member',
  'Show / Hide Financials',
  'border-bottom:2px solid #007bff', // buildNoteHtml h4 underline
  'border-bottom:2px solid #17a2b8', // buildShortNoteHtml h4 underline
];

// Two independent hits is the threshold: a single marker could plausibly be
// quoted back inside a forwarded email, but two rarely co-occur by accident.
const MARKER_THRESHOLD = 2;

/**
 * Scans a conversation body for booking-note markers.
 * Returns the number of distinct markers found.
 */
function countMarkers(body, internalBookingId) {
  if (!body) return 0;
  let hits = NOTE_MARKERS.filter(m => body.includes(m)).length;
  // The heading carries the booking ID: "📦 Hotel — #MWRLMA032625243"
  if (internalBookingId && /📦|📌/.test(body) && body.includes(String(internalBookingId))) hits++;
  return hits;
}

/**
 * Tier 1 — free scan across every conversation on the ticket.
 * Returns { posted, method, evidence } or null when nothing matched.
 */
function scanForNoteMarkers(conversations, booking) {
  const internalId = booking?.internalBookingId || null;
  for (const c of conversations || []) {
    const hits = countMarkers(c.body || c.body_text || '', internalId);
    if (hits >= MARKER_THRESHOLD) {
      return { posted: 1, method: 'markers', evidence: `${hits} note markers matched` };
    }
  }
  return null;
}

// ─── Tier 2: Groq over the private notes ─────────────────────────────────────
const strip = (html) => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Serializes the first N private notes. The booking note is always private, so
 * scanning notes rather than "the first 5 conversations" avoids wasting the
 * window on customer email at the top of a long thread.
 */
function serializeNotes(conversations, limit = 5) {
  return (conversations || [])
    .filter(c => c.private)
    .slice(0, limit)
    .map((c, i) => `[NOTE ${i + 1}] ${strip(c.body || c.body_text || '').slice(0, 1500)}`)
    .filter(l => l.length > 12);
}

async function askGroqNotePosted(conversations, booking, details) {
  const notes = serializeNotes(conversations);
  if (!notes.length) return { posted: 0, method: 'llm', evidence: 'no internal notes on ticket' };

  const prompt = `You are checking whether an internal "booking summary" note has ALREADY been
posted on this support ticket.

A booking summary note is an agent-written INTERNAL note reproducing reservation
data pulled from the TravelAdvantage admin: booking/confirmation IDs, guest name,
hotel/supplier name, check-in and check-out dates, room type, prices. Over the
years it has been posted in many formats: a styled HTML card with emoji headings,
a plain bullet list, a bare "Booking: X / Guest: Y / Check-in: Z" block, or a
pasted table. Format does not matter — content does.

Count it as POSTED if any note reproduces the booking's core fields: a booking
reference AND at least one of (check-in date, guest name, hotel name).
Do NOT count: customer messages, supplier emails, agent replies to the customer,
one-line remarks ("called hotel", "waiting on supplier"), bare links, merge notes
("Merged into ticket #123").

Booking we expect to see:
  reference: ${booking?.internalBookingId || '?'} / ${booking?.supplierId || '?'}
  guest: ${booking?.guestName || '?'}   hotel: ${details?.hotelName || booking?.supplierName || '?'}   check-in: ${booking?.checkIn || '?'}

NOTES (oldest first):
${notes.join('\n')}

Return ONLY JSON, no markdown:
{"note_posted": 0 or 1, "evidence": "max 15 words quoting what matched, or null"}`;

  const out = await groqJson({ model: TRIAGE_MODEL, prompt, maxTokens: 120, scope: 'triage' });
  if (!out) return { posted: 0, method: 'llm', evidence: 'could not parse Groq response' };
  return {
    posted: out.note_posted === 1 || out.note_posted === true ? 1 : 0,
    method: 'llm',
    evidence: out.evidence || null,
  };
}

/**
 * Two-tier check: free marker scan first, Groq only on a miss.
 * Returns { posted: 0|1, method: 'markers'|'llm', evidence }.
 */
async function detectNotePosted(conversations, booking, details) {
  const byMarkers = scanForNoteMarkers(conversations, booking);
  if (byMarkers) return byMarkers;
  return askGroqNotePosted(conversations, booking, details);
}

module.exports = { detectNotePosted, scanForNoteMarkers, countMarkers, NOTE_MARKERS, MARKER_THRESHOLD };
