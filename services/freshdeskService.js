const fetch    = require('node-fetch');
const FormData = require('form-data');

function getBaseUrl() {
  return `https://${process.env.FRESHDESK_DOMAIN}/api/v2`;
}

function getAuthHeader() {
  const key = process.env.FRESHDESK_API_KEY;
  if (!key) throw new Error('FRESHDESK_API_KEY not set');
  // Freshdesk uses HTTP Basic: API_KEY:X (any string as password)
  return 'Basic ' + Buffer.from(`${key}:X`).toString('base64');
}

/**
 * Posts an internal (private) note to a ticket.
 */
async function addNote(ticketId, bodyHtml) {
  const response = await fetch(`${getBaseUrl()}/tickets/${ticketId}/notes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': getAuthHeader(),
    },
    body: JSON.stringify({
      body: bodyHtml,
      private: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Freshdesk addNote failed ${response.status}: ${err}`);
  }

  return response.json();
}

/**
 * Posts an internal note with inline images.
 *
 * Freshdesk's API strips data: URLs from the note body. This function:
 *   1. Extracts each base64 data-URL <img> and replaces it with a sentinel.
 *   2. Posts the note as multipart/form-data with the images as attachments[].
 *   3. Freshdesk stores the images and returns attachment_url for each.
 *   4. Patches the note body, replacing sentinels with proxy URLs that
 *      route through our /attachment endpoint (which adds the auth header).
 *
 * Falls back to plain addNote if no data-URL images are found, or on error.
 */
async function addNoteWithImages(ticketId, bodyHtml) {
  const BACKEND_URL = process.env.BACKEND_URL || 'https://mwr-new-booking-server.onrender.com';
  const dataUrlRe = /src="(data:([^;]+);base64,([^"]+))"/g;
  const images = [];
  let processedHtml = bodyHtml;
  let idx = 0;
  let m;

  while ((m = dataUrlRe.exec(bodyHtml)) !== null) {
    const [, dataUrl, mimeType, base64Data] = m;
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const filename = `inline-image-${idx}.${ext}`;
    const sentinel = `__INLINE_IMG_${idx}__`;
    images.push({ dataUrl, mimeType, filename, sentinel, buffer: Buffer.from(base64Data, 'base64') });
    processedHtml = processedHtml.replace(dataUrl, sentinel);
    idx++;
  }

  if (images.length === 0) return addNote(ticketId, bodyHtml);

  try {
    // Step 1 — post note with attachments
    const fd = new FormData();
    fd.append('body', processedHtml);
    fd.append('private', 'true');
    for (const img of images) {
      fd.append('attachments[]', img.buffer, { filename: img.filename, contentType: img.mimeType });
    }

    const postRes = await fetch(`${getBaseUrl()}/tickets/${ticketId}/notes`, {
      method: 'POST',
      headers: { 'Authorization': getAuthHeader(), ...fd.getHeaders() },
      body: fd,
    });

    if (!postRes.ok) {
      const err = await postRes.text();
      throw new Error(`Freshdesk note POST failed ${postRes.status}: ${err}`);
    }

    const note = await postRes.json();
    const noteId = note.id;
    const attachments = note.attachments || [];

    // Step 2 — replace sentinels with proxy URLs pointing at our /attachment endpoint
    let finalHtml = processedHtml;
    for (let i = 0; i < images.length; i++) {
      const att = attachments[i];
      if (!att) continue;
      const proxyUrl = `${BACKEND_URL}/attachment?url=${encodeURIComponent(att.attachment_url)}`;
      finalHtml = finalHtml.replace(
        images[i].sentinel,
        `${proxyUrl}" style="max-width:100%;height:auto;display:block;margin:4px 0;`
      );
    }

    // Step 3 — patch note body with final inline URLs
    const patchRes = await fetch(`${getBaseUrl()}/tickets/${ticketId}/notes/${noteId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': getAuthHeader() },
      body: JSON.stringify({ body: finalHtml }),
    });

    if (!patchRes.ok) {
      console.warn(`⚠️ Note body patch failed ${patchRes.status} — images posted as attachments only`);
    }

    return note;
  } catch (err) {
    console.warn(`⚠️ addNoteWithImages failed (${err.message}) — falling back to plain note`);
    return addNote(ticketId, bodyHtml);
  }
}

/**
 * Sends an outbound reply email from the ticket to the hotel.
 */
async function sendEmail(ticketId, toEmail, subject, bodyHtml) {
  const response = await fetch(`${getBaseUrl()}/tickets/${ticketId}/reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': getAuthHeader(),
    },
    body: JSON.stringify({
      body: bodyHtml,
      to_emails: [toEmail],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Freshdesk sendEmail failed ${response.status}: ${err}`);
  }

  return response.json();
}

/**
 * Sets a ticket status to Pending (status code 3).
 * Freshdesk statuses: 2=Open, 3=Pending, 4=Resolved, 5=Closed
 */
async function setTicketPending(ticketId) {
  const response = await fetch(`${getBaseUrl()}/tickets/${ticketId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': getAuthHeader(),
    },
    body: JSON.stringify({ status: FD_STATUS.PENDING }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Freshdesk setTicketPending failed ${response.status}: ${err}`);
  }

  return response.json();
}

/**
 * Generic ticket update — pass any fields to update.
 */
async function updateTicket(ticketId, fields) {
  const response = await fetch(`${getBaseUrl()}/tickets/${ticketId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': getAuthHeader(),
    },
    body: JSON.stringify(fields),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Freshdesk updateTicket failed ${response.status}: ${err}`);
  }

  return response.json();
}

/**
 * Sets tags and type on a ticket in one call.
 * Replaces ALL existing tags.
 */
async function tagTicket(ticketId, tags, type) {
  const fields = { tags };
  if (type) fields.type = type;
  return updateTicket(ticketId, fields);
}

/**
 * Search for tickets containing a reference number.
 * Returns array of matching tickets (excluding the current ticket).
 */
const { getFreshdeskSession } = require('./dbService');
const { FD_STATUS } = require('../config');

/**
 * GET using Freshdesk internal session cookie — for api/_ endpoints.
 */
async function fdGet(path) {
  const cookie = await getFreshdeskSession();
  if (!cookie) throw new Error('No Freshdesk session stored. Visit /freshdesk-auth to set one.');
  const url = `https://${process.env.FRESHDESK_DOMAIN}${path}`;
  const response = await fetch(url, {
    headers: {
      'Cookie': cookie,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json',
    },
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('FRESHDESK_SESSION_EXPIRED');
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Freshdesk internal API error ${response.status}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

/**
 * Search for duplicate tickets using Freshdesk internal full-text search.
 * Falls back to empty array on session errors so callers degrade gracefully.
 */
async function searchDuplicates(ref, excludeTicketId, isEmail = false, includeClosed = false) {
  if (!ref) return [];
  console.log(`🔍 searchDuplicates: ref="${ref}"`);
  try {
    const data = await fdGet(`/api/_/search/tickets?term=${encodeURIComponent(ref)}&context=spotlight`);
    const results = data.results || data.tickets || data || [];
    if (isEmail && Array.isArray(results) && results.length > 0) {
      console.log(`🔍 email result sample:`, JSON.stringify(results[0]).slice(0, 400));
    }
    const filtered = Array.isArray(results)
      ? results.filter(t => {
          if (String(t.id) === String(excludeTicketId)) return false;
          if (includeClosed) return true;
          return t.status === FD_STATUS.OPEN || t.status === FD_STATUS.PENDING;
        })
      : [];
    console.log(`🔍 searchDuplicates: ${filtered.length} found (excluding current)`);
    return filtered;
  } catch (err) {
    if (err.message === 'FRESHDESK_SESSION_EXPIRED') {
      console.warn('⚠️ Freshdesk session expired — duplicate check skipped');
    } else {
      console.warn(`⚠️ searchDuplicates error: ${err.message}`);
    }
    return [];
  }
}

/**
 * Fetches ticket subject, description, and conversation history.
 * Returns a structured object ready for AI context injection.
 */
async function getTicketContext(ticketId) {
  const headers = { 'Authorization': getAuthHeader() };
  const base    = getBaseUrl();
  const domain  = process.env.FRESHDESK_DOMAIN;

  const ticketRes = await fetch(`${base}/tickets/${ticketId}`, { headers });
  if (!ticketRes.ok) throw new Error(`Failed to fetch ticket ${ticketId}: ${ticketRes.status}`);
  const ticket = await ticketRes.json();

  // Paginate conversations (Freshdesk max 100/page)
  const conversations = [];
  let page = 1;
  while (true) {
    const r = await fetch(`${base}/tickets/${ticketId}/conversations?per_page=100&page=${page}`, { headers });
    if (!r.ok) break;
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    conversations.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  // Strip HTML tags from text
  const strip = (html) => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    subject:     ticket.subject || '',
    description: strip(ticket.description || ''),
    status:      ticket.status,
    priority:    ticket.priority,
    conversations: conversations.map(c => ({
      type:   c.private ? 'note' : (c.incoming ? 'customer' : 'agent'),
      body:   strip(c.body || ''),
      from:   c.from_email || '',
    })).filter(c => c.body),
  };
}

/**
 * Sends an outbound reply with file attachments (multipart/form-data).
 * files: array of multer file objects { buffer, originalname, mimetype }
 */
async function sendEmailWithAttachments(ticketId, toEmail, bodyHtml, files = []) {
  const fd = new FormData();
  fd.append('body', bodyHtml);
  fd.append('to_emails[]', toEmail);
  for (const f of files) {
    fd.append('attachments[]', f.buffer, { filename: f.originalname, contentType: f.mimetype });
  }
  const response = await fetch(`${getBaseUrl()}/tickets/${ticketId}/reply`, {
    method: 'POST',
    headers: { 'Authorization': getAuthHeader(), ...fd.getHeaders() },
    body: fd,
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Freshdesk sendEmailWithAttachments failed ${response.status}: ${err}`);
  }
  return response.json();
}

module.exports = { getAuthHeader, addNote, addNoteWithImages, sendEmail, sendEmailWithAttachments, setTicketPending, updateTicket, tagTicket, searchDuplicates, getTicketContext };
