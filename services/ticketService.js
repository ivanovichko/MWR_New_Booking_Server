// Freshdesk ticket fetch with session-cookie + API-key fallback.
//
// Primary path: internal /api/_/tickets/{id} + /api/_/tickets/{id}/conversations
//   - Uses the agent's stored browser session via fdGet, no API rate limit.
//   - Conversations come back with an inline `requester` object, so the
//     agent map gets augmented for deactivated/legacy posters for free.
//
// Fallback path: public /api/v2/tickets/{id} + /api/v2/.../conversations
//   - Uses the static FRESHDESK_API_KEY (HTTP basic).
//   - No inline requester data, so the per-id agent lookup has to do more work.
//
// Both paths return the same shape: { ticket, conversations }.

const fetch = require('node-fetch');
const { fdGet, getAuthHeader } = require('./freshdeskService');

async function fetchAllConversationsViaSession(ticketId) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await fdGet(`/api/_/tickets/${ticketId}/conversations?per_page=100&page=${page}&order_type=asc&include=requester`);
    const batch = data?.conversations || [];
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

async function fetchAllConversationsViaApiKey(ticketId) {
  const domain = process.env.FRESHDESK_DOMAIN;
  const auth   = getAuthHeader();
  const all = [];
  let page = 1;
  while (true) {
    const url = `https://${domain}/api/v2/tickets/${ticketId}/conversations?per_page=100&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) break;
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

async function fetchTicketViaSession(ticketId) {
  const [tWrap, conversations] = await Promise.all([
    fdGet(`/api/_/tickets/${ticketId}?include=requester,stats`),
    fetchAllConversationsViaSession(ticketId),
  ]);
  if (!tWrap?.ticket) throw new Error('Internal ticket endpoint returned no ticket');
  return { ticket: tWrap.ticket, conversations };
}

async function fetchTicketViaApiKey(ticketId) {
  const domain = process.env.FRESHDESK_DOMAIN;
  const auth   = getAuthHeader();
  const tRes = await fetch(`https://${domain}/api/v2/tickets/${ticketId}?include=requester`, { headers: { Authorization: auth } });
  if (!tRes.ok) throw new Error(`API-key ticket fetch failed ${tRes.status}`);
  const [ticket, conversations] = await Promise.all([
    tRes.json(),
    fetchAllConversationsViaApiKey(ticketId),
  ]);
  return { ticket, conversations };
}

// Try the session path first; on any failure fall back to the API-key path.
// Returns { ticket, conversations } or throws if both paths fail.
async function fetchTicket(ticketId) {
  try {
    return await fetchTicketViaSession(ticketId);
  } catch (err) {
    console.warn(`[ticketService] session path failed for ${ticketId} (${err.message}) — falling back to API key`);
    return await fetchTicketViaApiKey(ticketId);
  }
}

module.exports = {
  fetchTicket,
  fetchTicketViaSession,
  fetchTicketViaApiKey,
  fetchAllConversationsViaSession,
  fetchAllConversationsViaApiKey,
};
