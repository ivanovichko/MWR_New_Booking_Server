const { fetchTicket } = require('./ticketService');
const { extractBookingId, fetchAndCacheBooking, checkInPriority } = require('./prewarmService');
const { getCachedBooking } = require('./dbService');
const { parseDataRow, parseBookingHtml } = require('./parserService');
const { parseUserHtml } = require('./userService');
const { lookupSupplier } = require('./supplierService');
const { buildNoteHtml } = require('./noteBuilder');
const { buildBookingTags, sendHotelEmailConfirmed } = require('./ticketActionService');
const { findHotelEmail } = require('./aiService');
const { addNoteWithImages, addTags, searchTicketsStrict, updateTicket } = require('./freshdeskService');
const { detectNotePosted } = require('./noteDetectionService');
const { classifyThread, assessCustomerThread } = require('./triageAiService');
const { FD_STATUS } = require('../config');

const TAG_CALL_HOTEL   = 'call_hotel';
const TAG_HOTEL_EMAILED = 'hotel_emailed';
const FD_BASE = 'https://mwrlife.freshdesk.com/a/tickets/';

// Check-in cutoff: strictly more than this many days out → hotel email.
// At or inside it, the property has to be phoned instead.
const HOTEL_EMAIL_MIN_DAYS = 3;

const MAX_BATCH        = 100;
const INTER_TICKET_MS  = 300;

/**
 * Thrown when the run hit something that invalidates every subsequent ticket
 * (an expired session, most importantly). Aborts the whole job loudly rather
 * than letting every ticket silently report "nothing found".
 */
class JobAbort extends Error {}

/**
 * True for failures that will repeat identically on every remaining ticket —
 * a dead session, essentially. Matches the messages taAuthService and
 * freshdeskService actually throw, so keep it in sync with them.
 */
function isFatalSessionError(message) {
  return /FRESHDESK_SESSION_EXPIRED/.test(message)
      || /TA session expired/i.test(message)
      || /No TA session/i.test(message)
      || /No session found/i.test(message)
      || /No Freshdesk session stored/i.test(message)
      || /session may be expired/i.test(message);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Dry-run effects ─────────────────────────────────────────────────────────
/**
 * Wraps the four mutating operations. This is the ONLY place that branches on
 * dryRun — the state machine below is written once and runs identically either
 * way, so a dry-run genuinely exercises the live code path.
 *
 * Note that reads stay live in dry-run, including fetchAndCacheBooking's DB
 * write: that's our own booking cache, not a customer-visible mutation.
 */
function makeEffects(dryRun, step) {
  const run = async (kind, label, fn, simulated) => {
    if (dryRun) { step(kind, label, 'simulated'); return simulated; }
    const out = await fn();
    step(kind, label, 'live');
    return out;
  };
  return {
    dryRun,

    postNote: (ticketId, html) =>
      run('note', `post booking note → #${ticketId}`,
        () => addNoteWithImages(ticketId, html), { simulated: true }),

    addTags: (ticketId, existing, add) =>
      run('tags', `tag +[${add.join(', ')}]`,
        () => addTags(ticketId, existing, add), { tags: [...new Set([...(existing || []), ...add])] }),

    sendHotelEmail: (ticketId, bookingId, to) =>
      run('email', `hotel email → ${to}`,
        () => sendHotelEmailConfirmed(ticketId, bookingId, to), { emailSent: false, hotelEmail: to }),

    setStatus: (ticketId, status) =>
      run('status', `status → ${status}`,
        () => updateTicket(ticketId, { status }), { ok: true }),
  };
}

// ─── Deterministic product classification ────────────────────────────────────
/**
 * Buckets a booking by product type before any LLM is involved.
 *   'voucher'     — car rental / transfer / activity: skipped by design
 *   'hotel'       — hotel or getaway: the only kind that proceeds to triage
 *   'unsupported' — flights, cruises, anything unrecognised
 *
 * The 'unsupported' bucket matters: without it a flight booking would fall
 * through to classification and could reach the hotel-email branch.
 */
function classifyProduct(booking) {
  const type = (booking?.productType || '').toLowerCase();
  if (booking?.voucherUrl) return 'voucher';
  if (/car|transfer|ground|activit/.test(type)) return 'voucher';
  if (/hotel|getaway/.test(type)) return 'hotel';
  return 'unsupported';
}

// ─── Booking resolution ──────────────────────────────────────────────────────
/**
 * Rehydrates a cached booking the same way the analyse route does — re-parsing
 * data_row and user_html so parser changes reach cached rows without a migration.
 */
function rehydrate(cached) {
  const data = { ...cached.parsed, booking: parseDataRow(cached.data_row) };
  if (cached.user_html)    data.user = parseUserHtml(cached.user_html);
  if (!data.supplier)      data.supplier = lookupSupplier(data.booking.supplierName);
  data.cleanHtml = cached.booking_html ? parseBookingHtml(cached.booking_html).cleanHtml : '';
  return data;
}

async function resolveBooking(bookingId) {
  const cached = await getCachedBooking(bookingId);
  if (cached && cached.parsed) return rehydrate(cached);
  return fetchAndCacheBooking(bookingId);
}

// ─── Per-ticket state machine ────────────────────────────────────────────────
async function triageTicket(ticketMeta, effects, step, row, options) {
  const ticketId = String(ticketMeta.id);

  // 1 — ticket + conversations
  step('fetch', `fetching ticket #${ticketId}`, 'read');
  let ticket, conversations;
  try {
    ({ ticket, conversations } = await fetchTicket(ticketId));
  } catch (err) {
    if (isFatalSessionError(err.message)) throw new JobAbort(`Freshdesk session problem on #${ticketId}: ${err.message}`);
    row.error = err.message;
    return 'error_ticket_fetch';
  }
  const existingTags = ticket.tags || ticketMeta.tags || [];
  row.requester = ticket.requester?.email || ticketMeta.requesterEmail || null;
  step('fetch', `${conversations.length} conversation(s), ${existingTags.length} existing tag(s)`, 'read');

  // 2 — booking reference
  step('booking-id', 'extracting booking reference', 'read');
  const extracted = await extractBookingId(ticket, conversations.length);
  const bookingId = extracted?.bookingId || null;
  if (!bookingId) { step('booking-id', 'no reference found', 'read'); return 'no_booking_id'; }
  row.bookingId = bookingId;
  step('booking-id', `reference: ${bookingId}`, 'read');

  // 3 — booking data
  let data;
  try {
    data = await resolveBooking(bookingId);
  } catch (err) {
    if (isFatalSessionError(err.message)) {
      throw new JobAbort(`TravelAdvantage session problem on #${ticketId}: ${err.message}`);
    }
    row.error = err.message;
    step('booking', err.message, 'error');
    return /not found/i.test(err.message) ? 'booking_not_found' : 'error_booking_fetch';
  }
  const { booking, details, user, supplier, cleanHtml } = data;
  row.internalId  = booking.internalBookingId || null;
  row.supplierId  = booking.supplierId || null;
  row.productType = booking.productType || null;
  row.guestName   = booking.guestName || null;
  row.hotelName   = details?.hotelName || booking.supplierName || null;
  row.checkIn     = booking.checkIn || null;
  step('booking', `${booking.productType || 'unknown type'} — ${row.hotelName || '?'} — check-in ${row.checkIn || '?'}`, 'read');

  // 4 — deterministic product bucket
  const bucket = classifyProduct(booking);
  row.classificationSource = 'deterministic';
  step('classify', `product bucket: ${bucket}`, 'read');

  if (bucket === 'unsupported') {
    row.classification = 'unsupported_product';
    return 'unsupported_product';
  }

  // 5 — booking note
  const detection = await detectNotePosted(conversations, booking, details);
  row.noteDetectMethod = detection.method;
  row.noteEvidence     = detection.evidence;
  step('note', `already posted: ${detection.posted ? 'yes' : 'no'} (via ${detection.method})`, 'read');

  if (detection.posted) {
    row.noteState = 'already_posted';
  } else if (bucket === 'voucher' && !options.postNoteOnVoucher) {
    row.noteState = 'skipped';
    step('note', 'voucher ticket, note posting disabled', 'read');
  } else {
    try {
      const noteHtml = buildNoteHtml(booking, cleanHtml || '', details, user, supplier || lookupSupplier(booking.supplierName));
      await effects.postNote(ticketId, noteHtml);
      const tags = buildBookingTags(booking, existingTags);
      const added = tags.filter(t => !existingTags.includes(t));
      if (added.length) {
        await effects.addTags(ticketId, existingTags, added);
        row.tagsAdded.push(...added);
      }
      row.noteState = effects.dryRun ? 'simulated' : 'posted';
    } catch (err) {
      // Non-terminal: the triage verdict is still worth having.
      row.noteState = 'failed';
      row.error = `note: ${err.message}`;
      step('note', `post failed: ${err.message}`, 'error');
    }
  }

  // 7a — voucher threads stop here
  if (bucket === 'voucher') {
    row.classification = 'booking_voucher';
    return 'booking_voucher';
  }

  // 6 — thread classification (hotel/getaway only)
  const cls = await classifyThread(ticket, conversations);
  if (!cls) { step('classify', 'classification failed', 'error'); return 'error_classify'; }
  row.classification       = cls.threadType;
  row.classificationSource = 'llm';
  row.confidence           = cls.confidence;
  row.classifyReason       = cls.reason;
  step('classify', `${cls.threadType} (${cls.confidence}) — ${cls.reason || ''}`, 'read');

  // 7b — customer thread: report only, no writes
  if (cls.threadType === 'customer') {
    const assessment = await assessCustomerThread(ticket, conversations);
    if (!assessment) return 'error_classify';
    row.verdict       = assessment.verdict;
    row.waitingOn     = assessment.waitingOn;
    row.lastSpeaker   = assessment.lastSpeaker;
    row.threadSummary = assessment.summary;
    row.nextAction    = assessment.nextAction;
    step('assess', `${assessment.verdict} — waiting on ${assessment.waitingOn || '?'}`, 'read');
    return {
      needs_response:    'customer_needs_response',
      pending_supplier:  'customer_pending_supplier',
      pending_customer:  'customer_pending_customer',
      resolved:          'customer_resolved',
    }[assessment.verdict] || 'customer_needs_response';
  }

  // 7c — booking reconfirmation
  // The email branch can send real mail, so a shaky classification stops here.
  const allowed = options.actOnMediumConfidence ? ['high', 'medium'] : ['high'];
  if (!allowed.includes(cls.confidence)) {
    step('classify', `confidence ${cls.confidence} below threshold — no action`, 'read');
    return 'needs_manual_classification';
  }

  // Look for other live tickets carrying the same booking reference.
  const refs = [booking.internalBookingId, booking.supplierId].filter(Boolean);
  let related = [];
  try {
    for (const ref of refs) {
      const hits = await searchTicketsStrict(ref, { excludeTicketId: ticketId, exact: true });
      for (const t of hits) {
        if (related.some(r => String(r.id) === String(t.id))) continue;
        related.push({ id: t.id, subject: t.subject, status: t.status, matchedBy: ref, url: FD_BASE + t.id });
      }
    }
    row.searchState = 'searched';
  } catch (err) {
    if (isFatalSessionError(err.message)) {
      throw new JobAbort(`Freshdesk session problem during related-ticket search: ${err.message}`);
    }
    // Never fall through to the email branch on a failed search — a silent []
    // here would mean mailing a hotel that another ticket is already handling.
    row.searchState = 'failed';
    row.error = `search: ${err.message}`;
    step('search', `failed: ${err.message}`, 'error');
    return 'reconf_search_failed';
  }

  if (related.length) {
    row.relatedTickets = related;
    step('search', `${related.length} related open ticket(s)`, 'read');
    return 'reconf_duplicates_found';
  }
  step('search', 'no related open tickets', 'read');

  // No duplicates — decide by proximity to check-in.
  const dateInfo = checkInPriority(booking.checkIn);
  if (!dateInfo) { step('date', 'no parseable check-in date', 'read'); return 'reconf_no_checkin_date'; }
  row.daysUntil = dateInfo.daysUntil;
  step('date', `check-in in ${dateInfo.daysUntil} day(s)`, 'read');

  if (dateInfo.daysUntil < 0) return 'reconf_past_checkin';

  if (dateInfo.daysUntil <= HOTEL_EMAIL_MIN_DAYS) {
    if (!existingTags.includes(TAG_CALL_HOTEL)) {
      await effects.addTags(ticketId, existingTags, [TAG_CALL_HOTEL]);
      row.tagsAdded.push(TAG_CALL_HOTEL);
    }
    return 'reconf_call_hotel';
  }

  // Idempotency guard — without this a second run re-mails the same property.
  if (existingTags.includes(TAG_HOTEL_EMAILED)) {
    step('email', `already tagged ${TAG_HOTEL_EMAILED} — skipping`, 'read');
    return 'reconf_already_emailed';
  }

  step('email', 'looking up hotel address', 'read');
  const lookup = await findHotelEmail(
    details?.hotelName || booking.supplierName,
    booking.locationTo,
    booking.destinationCountry
  );
  row.hotelEmail = { address: lookup?.email || null, confidence: lookup?.confidence || null, source: lookup?.source || null, state: 'not_run' };
  if (!lookup?.email) {
    row.hotelEmail.state = 'not_found';
    step('email', 'no address found', 'read');
    return 'reconf_hotel_email_no_address';
  }
  step('email', `address: ${lookup.email} (${lookup.confidence || 'n/a'})`, 'read');

  // Send first, then tag. If the tag write fails afterwards the worst case is a
  // duplicate email on the next run (visible in the FD thread); tagging first
  // would instead let a failed send be recorded as done and never retried.
  await effects.sendHotelEmail(ticketId, bookingId, lookup.email);

  const bookingTags = buildBookingTags(booking, existingTags);
  const toAdd = [...new Set([...bookingTags, TAG_HOTEL_EMAILED])].filter(t => !existingTags.includes(t));
  if (toAdd.length) {
    await effects.addTags(ticketId, existingTags, toAdd);
    row.tagsAdded.push(...toAdd);
  }
  await effects.setStatus(ticketId, FD_STATUS.PENDING);
  row.hotelEmail.state = effects.dryRun ? 'simulated' : 'sent';
  return 'reconf_hotel_email_sent';
}

// ─── Job runner ──────────────────────────────────────────────────────────────
/**
 * Runs the triage pipeline over a list of tickets collected by the userscript.
 * Reports progress through `job` (log lines, rows, counters) so the frontend
 * can poll it, mirroring the checkPendings/pendingsJob pattern.
 */
async function runBatchTriage(tickets, { dryRun = true, options = {} }, job, isStopped = () => false) {
  const opts = { postNoteOnVoucher: true, actOnMediumConfidence: false, ...options };
  const progress = (msg) => { console.log(`[triage] ${msg}`); job.log.push(msg); };

  const queue = tickets.slice(0, MAX_BATCH);
  job.total = queue.length;
  progress(`${dryRun ? 'DRY-RUN' : 'LIVE'} — ${queue.length} ticket(s) queued`);

  for (const meta of queue) {
    if (isStopped()) { progress('Stopped by user.'); break; }

    const startedAt = Date.now();
    const row = {
      ticketId: String(meta.id),
      subject:  meta.subject || null,
      url:      FD_BASE + meta.id,
      requester: meta.requesterEmail || null,
      bookingId: null, internalId: null, supplierId: null,
      productType: null, hotelName: null, guestName: null, checkIn: null, daysUntil: null,
      classification: null, classificationSource: null, confidence: null, classifyReason: null,
      noteState: 'skipped', noteDetectMethod: null, noteEvidence: null,
      tagsAdded: [], tagsMode: dryRun ? 'simulated' : 'live',
      searchState: 'not_run', relatedTickets: [],
      hotelEmail: null,
      verdict: null, waitingOn: null, lastSpeaker: null, threadSummary: null, nextAction: null,
      outcome: null, error: null, durationMs: null,
      steps: [],
    };
    const step = (stage, msg, mode = 'read') => {
      row.steps.push({ t: new Date().toISOString(), stage, msg, mode });
    };
    const effects = makeEffects(dryRun, step);

    try {
      row.outcome = await triageTicket(meta, effects, step, row, opts);
    } catch (err) {
      if (err instanceof JobAbort) {
        row.outcome = 'error';
        row.error = err.message;
        row.durationMs = Date.now() - startedAt;
        job.rows.push(row);
        job.processed++;
        progress(`ABORT — ${err.message}`);
        throw err;
      }
      row.outcome = 'error';
      row.error = err.message;
      step('error', err.message, 'error');
    }

    row.durationMs = Date.now() - startedAt;
    job.rows.push(row);
    job.processed++;
    job.summary[row.outcome] = (job.summary[row.outcome] || 0) + 1;
    progress(`#${row.ticketId} → ${row.outcome}${row.error ? ` (${row.error})` : ''}`);

    await sleep(INTER_TICKET_MS);
  }

  progress(`Done — ${job.processed}/${job.total} processed`);
  return job.summary;
}

module.exports = { runBatchTriage, classifyProduct, JobAbort, MAX_BATCH, TAG_CALL_HOTEL, TAG_HOTEL_EMAILED };
