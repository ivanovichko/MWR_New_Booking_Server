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
 * Posts an internal note, extracting any base64 data-URL images and
 * re-attaching them as multipart inline attachments (cid: references).
 * Falls back to plain JSON if no images are present.
 */
async function addNoteWithImages(ticketId, bodyHtml) {
  const dataUrlRe = /src="(data:([^;]+);base64,([^"]+))"/g;
  const images = [];
  let idx = 0;
  let processedHtml = bodyHtml;

  let m;
  while ((m = dataUrlRe.exec(bodyHtml)) !== null) {
    const [, dataUrl, mimeType, base64Data] = m;
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const filename = `image_${++idx}.${ext}`;
    images.push({ dataUrl, filename, mimeType, buffer: Buffer.from(base64Data, 'base64') });
  }

  if (images.length === 0) {
    return addNote(ticketId, bodyHtml);
  }

  // Replace data URLs with cid: references for inline embedding
  for (const img of images) {
    processedHtml = processedHtml.replace(img.dataUrl, `cid:${img.filename}`);
  }

  const fd = new FormData();
  fd.append('body', processedHtml);
  fd.append('private', 'true');
  for (const img of images) {
    fd.append('attachments[]', img.buffer, { filename: img.filename, contentType: img.mimeType });
  }

  const response = await fetch(`${getBaseUrl()}/tickets/${ticketId}/notes`, {
    method: 'POST',
    headers: { 'Authorization': getAuthHeader(), ...fd.getHeaders() },
    body: fd,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Freshdesk addNoteWithImages failed ${response.status}: ${err}`);
  }

  return response.json();
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

  const [ticketRes, convRes] = await Promise.all([
    fetch(`${base}/tickets/${ticketId}`, { headers }),
    fetch(`${base}/tickets/${ticketId}/conversations`, { headers }),
  ]);

  if (!ticketRes.ok) throw new Error(`Failed to fetch ticket ${ticketId}: ${ticketRes.status}`);

  const ticket = await ticketRes.json();
  const conversations = convRes.ok ? await convRes.json() : [];

  // Strip HTML tags from text
  const strip = (html) => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    subject:     ticket.subject || '',
    description: strip(ticket.description || ''),
    status:      ticket.status,
    priority:    ticket.priority,
    conversations: conversations.slice(0, 30).map(c => ({
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
