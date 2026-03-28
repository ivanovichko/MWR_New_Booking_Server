const fetch = require('node-fetch');

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
    body: JSON.stringify({ status: 3 }),
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
async function searchDuplicates(ref, excludeTicketId) {
  if (!ref) return [];
  console.log(`🔍 searchDuplicates: ref="${ref}"`);
  try {
    const data = await fdGet(`/api/_/search/tickets?term=${encodeURIComponent(ref)}&context=spotlight`);
    const results = data.results || data.tickets || data || [];
    const filtered = Array.isArray(results)
      ? results.filter(t => String(t.id) !== String(excludeTicketId))
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

module.exports = { addNote, sendEmail, setTicketPending, updateTicket, tagTicket, searchDuplicates, getTicketContext };
