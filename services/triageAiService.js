const { groqJson } = require('./aiService');

const TRIAGE_MODEL = process.env.TRIAGE_MODEL || 'llama-3.3-70b-versatile';

const strip = (html) => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Drops quoted reply chains. Freshdesk threads carry the whole history in every
 * message, which would blow the token budget several times over.
 */
function dropQuoted(text) {
  return text
    .split('\n')
    .filter(l => !/^\s*>/.test(l))
    .join('\n')
    .split(/\bFrom:\s/)[0]
    .split(/On .{0,40}wrote:/)[0]
    .trim();
}

function roleOf(c) {
  if (c.private) return 'NOTE';
  return c.incoming ? 'CUSTOMER' : 'AGENT';
}

/**
 * Flattens ticket + conversations into a compact transcript for the LLM.
 * Keeps the first 2 and last (max - 2) messages when the thread is long —
 * the opening establishes what the thread is, the tail decides who owes whom.
 */
function serializeThread(ticket, conversations, { max = 12, chars = 1200 } = {}) {
  const all = [
    { role: 'CUSTOMER', at: ticket?.created_at, body: strip(ticket?.description || ticket?.description_text || '') },
    ...(conversations || []).map(c => ({
      role: roleOf(c),
      at:   c.created_at,
      body: dropQuoted(strip(c.body || c.body_text || '')),
    })),
  ].filter(m => m.body);

  const kept = all.length <= max ? all : [...all.slice(0, 2), ...all.slice(-(max - 2))];
  const elided = all.length - kept.length;

  const lines = kept.map(m => {
    const date = m.at ? String(m.at).slice(0, 10) : '';
    return `[${m.role}${date ? ' ' + date : ''}] ${m.body.slice(0, chars)}`;
  });

  if (elided > 0) lines.splice(2, 0, `[... ${elided} earlier message(s) omitted ...]`);
  return lines.join('\n');
}

/**
 * Splits hotel/getaway threads into booking-reconfirmation vs customer-driven.
 * Returns { threadType, confidence, reason }.
 */
async function classifyThread(ticket, conversations) {
  const prompt = `Classify what KIND of support thread this Freshdesk ticket is. Two options only.

"booking_reconf" — the thread exists so the agent can reconfirm/secure a prepaid
hotel reservation with the supplier or the property. Signals: opened by an
automated or forwarded booking confirmation; all messages are agent<->supplier or
agent-internal; no question or complaint from the traveller; the point of the
thread is obtaining or chasing a confirmation.

"customer" — a traveller (or someone acting for them) is asking for or reporting
something: a question, a change, a cancellation, a complaint, a refund, a special
request, "did my booking go through?". If a real person is waiting on support, it
is "customer".

If the thread contains BOTH (started as reconfirmation, then the traveller wrote
in), classify as "customer".

SUBJECT: ${ticket?.subject || '(none)'}
THREAD (oldest first):
${serializeThread(ticket, conversations)}

Return ONLY JSON, no markdown:
{"thread_type":"booking_reconf" or "customer","confidence":"high" or "medium" or "low","reason":"max 20 words"}`;

  const out = await groqJson({ model: TRIAGE_MODEL, prompt, maxTokens: 150, scope: 'triage' });
  if (!out || !out.thread_type) return null;
  return {
    threadType: out.thread_type === 'booking_reconf' ? 'booking_reconf' : 'customer',
    confidence: (out.confidence || 'low').toLowerCase(),
    reason:     out.reason || null,
  };
}

/**
 * For customer threads: who is everyone waiting on?
 * Returns { verdict, waitingOn, lastSpeaker, summary, nextAction }.
 */
async function assessCustomerThread(ticket, conversations) {
  const prompt = `A traveller-facing support thread. Decide what support must do next.

"needs_response"   — the last substantive message is from the customer (or from a
                     supplier answering us) and nobody from support has replied.
                     Support owes someone an answer now.
"pending_supplier" — support already asked the supplier/hotel/airline something
                     and is waiting for their answer; no supplier reply since.
"pending_customer" — support already answered and is waiting on the traveller (we
                     asked a question, requested documents, offered options) and
                     the traveller has not replied since.
"resolved"         — the request was completed; nobody is waiting on anything.

Decide from WHO SPOKE LAST and WHETHER THAT MESSAGE ASKED FOR ANYTHING.
Internal notes are not replies to anyone. Automated acknowledgements are not replies.

SUBJECT: ${ticket?.subject || '(none)'}
THREAD (oldest first):
${serializeThread(ticket, conversations)}

Return ONLY JSON, no markdown:
{"verdict":"needs_response" or "pending_supplier" or "pending_customer" or "resolved",
 "waiting_on":"customer" or "supplier" or "support" or "nobody",
 "last_speaker":"customer" or "agent" or "supplier" or "note",
 "summary":"max 20 words, what the thread is about",
 "next_action":"max 15 words, what support should do"}`;

  const out = await groqJson({ model: TRIAGE_MODEL, prompt, maxTokens: 250, scope: 'triage' });
  if (!out || !out.verdict) return null;
  return {
    verdict:     out.verdict,
    waitingOn:   out.waiting_on   || null,
    lastSpeaker: out.last_speaker || null,
    summary:     out.summary      || null,
    nextAction:  out.next_action  || null,
  };
}

module.exports = { serializeThread, classifyThread, assessCustomerThread };
