const fetch = require('node-fetch');
const { storeSession, getSession } = require('./dbService');

const TA_BASE = 'https://www.traveladvantage.com';

// ─── Logging helpers ─────────────────────────────────────────────────────────
const SNIPPET_LEN = 400;

// Compact summary of a request body (string, URLSearchParams, etc.). Truncates
// long values; redacts likely-sensitive fields by name.
function summarizeBody(body) {
  if (body == null) return '';
  let str = '';
  if (typeof body === 'string') str = body;
  else if (body instanceof URLSearchParams) str = body.toString();
  else if (Buffer.isBuffer(body)) return `<buffer ${body.length}b>`;
  else { try { str = String(body); } catch { return '<unprintable>'; } }
  // Redact obvious secrets in form-encoded bodies
  str = str.replace(/(password|otp|token|csrf)=([^&]*)/gi, (_, k) => `${k}=<redacted>`);
  return str.length > SNIPPET_LEN ? `${str.slice(0, SNIPPET_LEN)}…(${str.length}b)` : str;
}

// Trim a path/URL for log output. Keeps query string but cuts long values.
function shortUrl(url) {
  if (!url) return '';
  return url.length > 120 ? `${url.slice(0, 120)}…` : url;
}

// Compact summary of a response body (likely JSON or HTML).
function summarizeResponse(text, contentType = '') {
  if (!text) return '<empty>';
  const len = text.length;
  if (contentType.includes('application/json') || /^[\s\n]*[\[{]/.test(text)) {
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json)) return `<array len=${json.length}>`;
      const keys = Object.keys(json);
      const summary = keys.slice(0, 8).map(k => {
        const v = json[k];
        if (Array.isArray(v)) return `${k}=[${v.length}]`;
        if (v && typeof v === 'object') return `${k}={...}`;
        if (typeof v === 'string') return `${k}="${v.slice(0, 30)}${v.length > 30 ? '…' : ''}"`;
        return `${k}=${v}`;
      }).join(' ');
      return `<json ${len}b: ${summary}${keys.length > 8 ? ' …' : ''}>`;
    } catch { /* fall through to raw snippet */ }
  }
  const snippet = text.slice(0, SNIPPET_LEN).replace(/\s+/g, ' ');
  return `<${len}b: ${snippet}${len > SNIPPET_LEN ? '…' : ''}>`;
}

// ─── Step 1: POST credentials, get OTP sent to email ─────────────────────────
async function initiateLogin(username, password) {
  const res = await fetch(`${TA_BASE}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    },
    body: new URLSearchParams({ email: username, password }),
    redirect: 'manual',
  });

  // Collect Set-Cookie headers from login response
  const rawCookies = res.headers.raw()['set-cookie'] || [];
  const sessionCookie = rawCookies.map(c => c.split(';')[0]).join('; ');

  if (!sessionCookie) throw new Error('No cookies returned from TA login — check credentials');

  await storeSession(sessionCookie);
  console.log(`[ta] login step 1 — OTP sent (cookie len ${sessionCookie.length})`);
  return { ok: true };
}

// ─── Step 2: Submit OTP ───────────────────────────────────────────────────────
async function submitOtp(otp) {
  const cookie = await getSession();
  if (!cookie) throw new Error('No session found — initiate login first');

  const res = await fetch(`${TA_BASE}/verify-otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    },
    body: new URLSearchParams({ otp }),
    redirect: 'manual',
  });

  const rawCookies = res.headers.raw()['set-cookie'] || [];
  const fullCookie = rawCookies.map(c => c.split(';')[0]).join('; ');
  const mergedCookie = [cookie, fullCookie].filter(Boolean).join('; ');
  await storeSession(mergedCookie);
  console.log(`[ta] login complete — session stored (len ${mergedCookie.length})`);
  return { ok: true };
}

// ─── Make an authenticated GET request to TA ─────────────────────────────────
async function taGet(url) {
  const cookie = await getSession();
  if (!cookie) throw new Error('No TA session — please authenticate first via /auth');

  const t0 = Date.now();
  const res = await fetch(url, {
    headers: {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    },
  });
  const ms = Date.now() - t0;
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  console.log(`[ta] GET ${shortUrl(url)} → ${res.status} (${ms}ms, ${ct.split(';')[0]}) ${summarizeResponse(text, ct)}`);

  if (res.status === 401 || res.status === 403) {
    throw new Error('TA session expired — please re-authenticate via /auth');
  }
  return text;
}

// ─── Make an authenticated POST request to TA ────────────────────────────────
async function taPost(url, body, extraHeaders = {}) {
  const cookie = await getSession();
  if (!cookie) throw new Error('No TA session — please authenticate first via /auth');

  console.log(`[ta] POST ${shortUrl(url)} body=${summarizeBody(body)}`);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      ...extraHeaders,
    },
    body,
  });
  const ms = Date.now() - t0;
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  console.log(`[ta] POST ${shortUrl(url)} → ${res.status} (${ms}ms, ${ct.split(';')[0]}) ${summarizeResponse(text, ct)}`);

  if (res.status === 401 || res.status === 403) {
    throw new Error('TA session expired — please re-authenticate via /auth');
  }

  try { return JSON.parse(text); }
  catch {
    console.error(`[ta] POST ${shortUrl(url)} non-JSON response: ${text.slice(0, 200)}`);
    throw new Error('TA returned non-JSON response — session may be expired');
  }
}

module.exports = { initiateLogin, submitOtp, taGet, taPost };
