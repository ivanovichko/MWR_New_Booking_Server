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
 * Primary path (session cookie, mirrors what the Freshdesk web editor does):
 *   1. POST each data-URL image to /api/_/attachments → get { id, inline_url }.
 *   2. Replace each data: src in the body with the tokenized inline_url.
 *   3. POST /api/_/tickets/{id}/notes with inline_attachment_ids: [...].
 *   inline_url is a Freshdesk-hosted tokenized URL — renders without our proxy.
 *
 * Fallback (API-key multipart): if the session path fails, use the old flow
 * that uploads via attachments[] and patches the body with /attachment proxy URLs.
 */
async function addNoteWithImages(ticketId, bodyHtml) {
  const dataUrlRe = /src="(data:([^;]+);base64,([^"]+))"/g;
  const images = [];
  let m;
  while ((m = dataUrlRe.exec(bodyHtml)) !== null) {
    const [, fullDataUrl, mimeType, base64Data] = m;
    images.push({ fullDataUrl, mimeType, buffer: Buffer.from(base64Data, 'base64') });
  }
  if (images.length === 0) return addNote(ticketId, bodyHtml);

  // ── Primary path: session cookie via /api/_/... ────────────────────────────
  try {
    const uploaded = await Promise.all(images.map((img, i) => {
      const ext = img.mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      return uploadInlineAttachment(img.buffer, `inline-${Date.now()}-${i}.${ext}`, img.mimeType);
    }));

    let finalHtml = bodyHtml;
    const inlineIds = [];
    images.forEach((img, i) => {
      const att = uploaded[i];
      inlineIds.push(att.id);
      // Replace the entire src="data:..." with src="<inline_url>" data-id="<id>"
      finalHtml = finalHtml.replace(
        `src="${img.fullDataUrl}"`,
        `src="${att.inline_url}" data-id="${att.id}"`
      );
    });

    return await fdPost(`/api/_/tickets/${ticketId}/notes`, JSON.stringify({
      body: finalHtml,
      attachment_ids: [],
      cloud_files: [],
      notify_emails: [],
      private: true,
      inline_attachment_ids: inlineIds,
    }), { 'Content-Type': 'application/json' });
  } catch (err) {
    console.warn(`⚠️ addNoteWithImages session path failed (${err.message}) — falling back to API-key multipart`);
  }

  // ── Fallback: API-key multipart (old flow) ─────────────────────────────────
  return addNoteWithImagesViaApiKey(ticketId, bodyHtml);
}

// Old API-key + /attachment-proxy flow, kept as a fallback when the session
// path fails (expired cookie, internal endpoint changes, etc.).
async function addNoteWithImagesViaApiKey(ticketId, bodyHtml) {
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
    console.warn(`⚠️ addNoteWithImagesViaApiKey failed (${err.message}) — falling back to plain note`);
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
 * POST using Freshdesk internal session cookie. body can be a JSON string
 * (set extraHeaders['Content-Type'] = 'application/json') or a FormData
 * (pass form.getHeaders() as extraHeaders).
 */
async function fdPost(path, body, extraHeaders = {}) {
  const cookie = await getFreshdeskSession();
  if (!cookie) throw new Error('No Freshdesk session stored. Visit /freshdesk-auth to set one.');
  const url = `https://${process.env.FRESHDESK_DOMAIN}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Cookie': cookie,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json',
      ...extraHeaders,
    },
    body,
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('FRESHDESK_SESSION_EXPIRED');
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Freshdesk internal API error ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

/**
 * Upload an inline image to Freshdesk via the internal /api/_/attachments
 * endpoint. Returns the attachment object (id, inline_url, attachment_url, ...).
 * The inline_url is tokenized and renderable directly in note bodies — no
 * need to proxy it through our backend.
 */
async function uploadInlineAttachment(buffer, filename, mimeType) {
  const fd = new FormData();
  fd.append('inline', 'true');
  fd.append('inline_type', '1');
  fd.append('content', buffer, { filename, contentType: mimeType });
  const data = await fdPost('/api/_/attachments', fd, fd.getHeaders());
  return data.attachment;
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

module.exports = { getAuthHeader, fdGet, fdPost, addNote, addNoteWithImages, uploadInlineAttachment, sendEmail, sendEmailWithAttachments, setTicketPending, updateTicket, tagTicket, searchDuplicates, getTicketContext };
