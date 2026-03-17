const fetch = require('node-fetch');
const { storeSession, getSession } = require('./dbService');

const TA_BASE = 'https://www.traveladvantage.com';

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
  const sessionCookie = rawCookies
    .map(c => c.split(';')[0])
    .join('; ');

  if (!sessionCookie) throw new Error('No cookies returned from TA login — check credentials');

  // Store interim cookie (needed to submit OTP)
  await storeSession(sessionCookie);
  console.log('✅ TA login step 1 — OTP should be sent to email');
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
  const fullCookie = rawCookies
    .map(c => c.split(';')[0])
    .join('; ');

  // Merge with existing cookie
  const mergedCookie = [cookie, fullCookie].filter(Boolean).join('; ');
  await storeSession(mergedCookie);
  console.log('✅ TA login complete — session stored');
  return { ok: true };
}

// ─── Make an authenticated GET request to TA ─────────────────────────────────
async function taGet(url) {
  const cookie = await getSession();
  if (!cookie) throw new Error('No TA session — please authenticate first via /auth');
  console.log(`🍪 taGet ${url.slice(0, 80)} — cookie length: ${cookie.length}`);

  const res = await fetch(url, {
    headers: {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    },
  });

  console.log(`🌐 taGet response: ${res.status} ${res.url?.slice(0, 80)}`);
  if (res.status === 401 || res.status === 403) {
    throw new Error('TA session expired — please re-authenticate via /auth');
  }

  return res.text();
}

// ─── Make an authenticated POST request to TA ────────────────────────────────
async function taPost(url, body, extraHeaders = {}) {
  const cookie = await getSession();
  if (!cookie) throw new Error('No TA session — please authenticate first via /auth');
  console.log(`🍪 taPost ${url.slice(0, 80)} — cookie length: ${cookie.length}`);

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

  console.log(`🌐 taPost response: ${res.status}`);
  if (res.status === 401 || res.status === 403) {
    throw new Error('TA session expired — please re-authenticate via /auth');
  }

  const text = await res.text();
  try { return JSON.parse(text); }
  catch { console.error('taPost non-JSON response:', text.slice(0, 200)); throw new Error('TA returned non-JSON response — session may be expired'); }
}

module.exports = { initiateLogin, submitOtp, taGet, taPost };
