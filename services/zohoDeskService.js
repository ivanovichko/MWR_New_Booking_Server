const fetch = require('node-fetch');
const { getZohoSession, storeZohoSession, updateZohoAccessToken } = require('./dbService');

// Zoho is multi-datacenter (.com/.eu/.in/...) — override via env if the org
// lives outside the default .com accounts/API shard.
const ZOHO_ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ZOHO_API_DOMAIN   = process.env.ZOHO_API_DOMAIN || 'https://desk.zoho.com';

function getOrgId() {
  const orgId = process.env.ZOHO_ORG_ID;
  if (!orgId) throw new Error('ZOHO_ORG_ID not set');
  return orgId;
}

function getClientCreds() {
  const clientId     = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('ZOHO_CLIENT_ID/ZOHO_CLIENT_SECRET not set');
  return { clientId, clientSecret };
}

/**
 * One-time exchange of a self-client grant token (generated in the Zoho API
 * console, valid ~10 minutes, single use) for a durable refresh_token. Stores
 * the resulting session; callers should not need to call this again unless
 * the refresh_token itself is revoked.
 */
async function exchangeGrantToken(grantCode) {
  const { clientId, clientSecret } = getClientCreds();
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code: grantCode,
  });
  const response = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, { method: 'POST', body: params });
  const data = await response.json();
  if (!data.refresh_token) {
    throw new Error(`Zoho grant exchange failed: ${data.error || JSON.stringify(data)}`);
  }
  const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);
  await storeZohoSession({ accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt });
  console.log('[zohoDesk] stored new session from grant token exchange');
  return { success: true };
}

async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getClientCreds();
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  const response = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, { method: 'POST', body: params });
  const data = await response.json();
  if (!data.access_token) {
    throw new Error(`Zoho token refresh failed: ${data.error || JSON.stringify(data)}`);
  }
  const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000);
  await updateZohoAccessToken(data.access_token, expiresAt);
  return data.access_token;
}

/**
 * Returns a valid access token, refreshing it first if it's missing or about
 * to expire. A 60s buffer avoids racing the expiry against in-flight requests.
 */
async function getAccessToken() {
  const session = await getZohoSession();
  if (!session) throw new Error('No Zoho session stored. Exchange a self-client grant token via /zoho/oauth-session.');
  const expiresAt = session.expires_at ? new Date(session.expires_at).getTime() : 0;
  if (session.access_token && expiresAt - Date.now() > 60_000) {
    return session.access_token;
  }
  return refreshAccessToken(session.refresh_token);
}

async function bearerHeaders() {
  const token = await getAccessToken();
  return { 'Authorization': `Zoho-oauthtoken ${token}` };
}

async function authHeaders() {
  return { ...(await bearerHeaders()), 'orgId': getOrgId() };
}

/**
 * Reports which Zoho config the server is actually running with, so a failed
 * exchange can be diagnosed without guessing at Render's env. Secrets are
 * never returned — only whether they're set, plus a short non-reversible
 * fingerprint of the client ID to tell two credentials apart.
 */
function describeConfig() {
  const clientId = process.env.ZOHO_CLIENT_ID || '';
  return {
    accountsUrl: ZOHO_ACCOUNTS_URL,
    apiDomain: ZOHO_API_DOMAIN,
    orgIdSet: Boolean(process.env.ZOHO_ORG_ID),
    clientIdSet: Boolean(clientId),
    clientIdTail: clientId ? `…${clientId.slice(-6)}` : null,
    clientSecretSet: Boolean(process.env.ZOHO_CLIENT_SECRET),
  };
}

/**
 * Lists the orgs this token can reach. Deliberately uses bearerHeaders rather
 * than authHeaders — this is the one Desk endpoint that must work *before*
 * ZOHO_ORG_ID is known, so it can't depend on getOrgId(). Doubles as the
 * cheapest end-to-end health check that the stored session actually works.
 */
async function listOrganizations() {
  const headers = await bearerHeaders();
  const response = await fetch(`${ZOHO_API_DOMAIN}/api/v1/organizations`, { headers });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Zoho listOrganizations failed ${response.status}: ${err}`);
  }
  const data = await response.json();
  return (data.data || []).map(o => ({ id: o.id, name: o.companyName || o.portalName }));
}

/**
 * Posts a comment (Zoho's equivalent of a Freshdesk note) to a ticket.
 * isPublic=false posts a private/internal comment, matching addNoteWithImages'
 * default behavior on the Freshdesk side.
 *
 * OPEN ITEM (see plan verification step): unverified whether Zoho accepts
 * inline data: base64 images in `content` directly or strips them the way
 * Freshdesk does. Test against a real sandbox ticket before relying on this
 * for note bodies that contain pasted screenshots.
 */
async function postComment(ticketId, html, isPublic = false) {
  const headers = await authHeaders();
  const response = await fetch(`${ZOHO_API_DOMAIN}/api/v1/tickets/${ticketId}/comments`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: html, contentType: 'html', isPublic }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Zoho postComment failed ${response.status}: ${err}`);
  }
  return response.json();
}

/**
 * Replaces a ticket's tags. Mirrors freshdeskService.tagTicket's signature
 * (minus the Freshdesk-only `type` field, which Zoho Desk doesn't have).
 */
async function tagTicket(ticketId, tags) {
  const headers = await authHeaders();
  const response = await fetch(`${ZOHO_API_DOMAIN}/api/v1/tickets/${ticketId}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Zoho tagTicket failed ${response.status}: ${err}`);
  }
  return response.json();
}

module.exports = { exchangeGrantToken, getAccessToken, describeConfig, listOrganizations, postComment, tagTicket };
