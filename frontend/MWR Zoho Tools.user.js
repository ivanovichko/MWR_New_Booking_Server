// ==UserScript==
// @name         MWR Zoho Tools
// @namespace    https://traveladvantage.com
// @version      0.13.0
// @description  TA booking tools for Zoho Desk — booking panel, duplicates, notes, supplier email, chat translation
// @match        https://desk.zoho.com/agent/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      mwr-new-booking-server.onrender.com
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/ivanovichko/MWR_New_Booking_Server/main/frontend/MWR%20Zoho%20Tools.user.js
// @downloadURL  https://raw.githubusercontent.com/ivanovichko/MWR_New_Booking_Server/main/frontend/MWR%20Zoho%20Tools.user.js
// ==/UserScript==

// Overlay replacement for the Zoho Desk extension in TA_Zoho_beta/. The extension
// works but can only be installed through the marketplace / Developer Space, which
// we have no approval for. An overlay needs no install, no OAuth client and no
// keys — and, decisively, its writes are authored by the agent who clicked, which
// the extension's single org-level OAuth token cannot do.
//
// Two call paths:
//   zdGet/zdPost — same-origin to Zoho Desk. See tasks/zoho-endpoints.md.
//   api.*        — GM_xmlhttpRequest to the Render backend (page-origin XHR to
//                  Render is blocked by Desk's CSP).
//
// Everything TA-side (booking parse, note HTML, member profile) is helpdesk-
// agnostic on the backend; this overlay is now its only client.

(function () {
  'use strict';

  // ===== CONFIG =====
  const BACKEND_URL = 'https://mwr-new-booking-server.onrender.com';

  // Fallback only. resolveOrgId() prefers a value read from the live page so a
  // different org (or the .eu test org) works without editing the script.
  const ORG_ID_FALLBACK = '914515468';

  const TA_BASE = 'https://traveladvantage.com';

  // ===== THEME =====
  const THEME = {
    font:    'system-ui,sans-serif',
    shadow:  '0 8px 30px rgba(0,0,0,0.25)',
    radius:  '10px',
    border:  '#eee',
    text:    '#333',
    muted:   '#888',
    subtle:  '#999',
    primary: '#6f42c1',
    success: '#28a745',
    danger:  '#dc3545',
    warn:    '#ffc107',
    info:    '#17a2b8',
  };

  // Tampermonkey sandboxes `window` whenever @grant is used, so page globals such
  // as desk_urls are only reachable through unsafeWindow.
  const pageWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  // ===== STATE =====
  // Keyed by Zoho ticket id; survives SPA navigation, resets on full reload.
  const ticketBookingCache = {};
  const reservationsCache  = {};
  let panelUserOverride = null;   // member picked via Find member
  let currentTicketId   = null;
  let currentBookingId  = null;
  let currentTicketMeta = null;   // { ticketNumber, subject, status } for the link row
  const duplicateCache  = {};     // ticketId -> merged duplicate rows
  let dupIncludeClosed  = false;  // Zoho returns Closed tickets by default
  let panelNotice       = null;   // { text, bookingId } when a lookup did not land
  let pendingMemberQuery = null;  // consumed by the Member section to auto-search
  let pendingMemberAuto  = false; // true = seeded automatically, so auto-pick a lone hit
  let panelUserSource    = null;  // 'booking' | 'email' | 'name' | 'manual' — gates write-back
  let currentChatThreadId = null; // set when the ticket carries an ONLINE_CHAT thread
  const chatCache       = {};     // ticketId -> { lines, translated, trimmedMetadata }
  const fromAddressCache = {};    // departmentId -> active+verified sender addresses

  // ===== SECRET =====
  // The repo that serves this script is public, so nothing may be hardcoded. The
  // agent enters the backend shared secret once; it lives in Tampermonkey storage.
  function getSecret() {
    return GM_getValue('ta_backend_secret', '');
  }

  function promptForSecret(force) {
    const existing = getSecret();
    if (existing && !force) return existing;
    const entered = window.prompt(
      'MWR Zoho Tools — backend key\n\n' +
      'Paste the backend shared secret (ask Ivan if you do not have it).\n' +
      'It is stored locally in Tampermonkey and never sent anywhere except the ' +
      'MWR backend.',
      ''
    );
    if (entered && entered.trim()) {
      GM_setValue('ta_backend_secret', entered.trim());
      showToast('Backend key saved.', 'success');
      return entered.trim();
    }
    return existing;
  }

  // ===== ZOHO DESK — same-origin =====
  // Portal slug comes from the URL so this is not pinned to one portal:
  //   /agent/{portal}/{department}/tickets/details/{ticketId}
  function getPortalSlug() {
    const m = location.pathname.match(/^\/agent\/([^/]+)\//);
    return m ? m[1] : 'mwrlife';
  }

  function zdBase() {
    return `/supportapi/zd/${getPortalSlug()}/api/v1`;
  }

  function resolveOrgId() {
    try {
      const du = pageWindow.desk_urls;
      if (du) {
        for (const k of ['orgId', 'orgid', 'organizationId', 'zdOrgId']) {
          if (du[k]) return String(du[k]);
        }
      }
    } catch (e) { /* page globals are not guaranteed */ }
    return ORG_ID_FALLBACK;
  }

  // ===== WRITE TOKEN =====
  // Desk rejects any write without `X-ZCSRF-TOKEN: deskcsrfparam=<token>` (a raw
  // value 422s on format; a wrong token 401s). Rather than hardcode where that
  // token lives — it is neither the CSRF_TOKEN cookie nor desk_urls.csrf_token,
  // and Zoho is free to move it — we observe the header on Desk's own outgoing
  // writes and reuse it verbatim.
  //
  // This is deliberately source-agnostic: it keeps working if Zoho changes where
  // the token is stored, and the script never has to go rummaging through cookies
  // or storage. Desk POSTs a "recent items" record every time a ticket is opened,
  // so the header is normally observed before the agent can click anything.
  const CSRF_HEADER = 'X-ZCSRF-TOKEN';
  // Verified against every write endpoint: the parameter is crmcsrfparam (shared
  // Zoho CRM infrastructure), NOT deskcsrfparam, and the token is the page's own
  // desk_urls.csrf_token. With this, comments, sendReply and PATCH all return 404
  // against a nonexistent ticket — i.e. authentication passes.
  const CSRF_PARAM = 'crmcsrfparam';
  let observedCsrfHeader = null;

  function installTokenObserver() {
    const capture = (name, value) => {
      if (String(name).toLowerCase() !== CSRF_HEADER.toLowerCase()) return;
      const v = String(value || '');
      if (v) observedCsrfHeader = v;
    };

    const origSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try { if (!this.__taOwn) capture(name, value); } catch (e) { /* never break the app */ }
      return origSet.apply(this, arguments);
    };

    const origFetch = pageWindow.fetch;
    pageWindow.fetch = function (input, init) {
      try {
        if (!(init && init.__taOwn)) {
          const h = (init && init.headers) || (input && input.headers);
          if (h) {
            if (h.forEach) h.forEach((v, k) => capture(k, v));
            else Object.keys(h).forEach((k) => capture(k, h[k]));
          }
        }
      } catch (e) { /* never break the app */ }
      return origFetch.apply(this, arguments);
    };
  }

  // Read fresh from the page on every write. The previous approach — observing the
  // header on Desk's own writes — was unreliable: Desk emits it only when it
  // happens to write, so the cached copy went stale and produced
  // "You are not authenticated to perform this operation". The observer is kept
  // only as a fallback in case Zoho renames desk_urls.
  function getCsrfHeader() {
    const tok = (pageWindow.desk_urls || {}).csrf_token;
    if (tok) return CSRF_PARAM + '=' + tok;
    return observedCsrfHeader;
  }

  async function zdRequest(path, opts = {}) {
    const method = opts.method || 'GET';
    const headers = { orgId: resolveOrgId() };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') {
      const token = getCsrfHeader();
      if (!token) {
        throw new Error('Zoho Desk write token unavailable — reload the ticket page and retry.');
      }
      headers[CSRF_HEADER] = token;
    }
    const res = await fetch(zdBase() + path, {
      method,
      credentials: 'same-origin',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      __taOwn: true,   // keeps the observer from re-capturing our own header
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      // Zoho's INVALID_DATA carries an errors[] naming the offending field; the
      // top-level message alone ("validation restrictions") is undiagnosable.
      let msg = (json && (json.message || json.errorCode)) || `HTTP ${res.status}`;
      const fields = (json && Array.isArray(json.errors))
        ? json.errors.map((e) => `${String(e.fieldName || '?').replace(/^\//, '')} (${e.errorType || 'invalid'})`)
        : [];
      if (fields.length) msg += ' → ' + fields.join(', ');
      console.error(`[ta] ${method} ${path} failed`, res.status, json);
      throw new Error(`Zoho Desk ${method} ${path} failed: ${msg}`);
    }
    return json;
  }

  // Zoho rejects note content over ~32000 with INVALID_DATA → /content:invalid
  // (boundary measured between 31882 and 32038). A real email body carrying
  // inline base64 images passes that easily, which is what broke merge. The
  // budget is counted in UTF-8 BYTES, not characters: a Cyrillic or accented
  // transcript costs two bytes per character and would otherwise slip through a
  // character-based check.
  const COMMENT_MAX_BYTES = 30000;   // headroom under the limit

  function utf8Bytes(str) {
    try { return new TextEncoder().encode(str).length; } catch (e) { return str.length * 2; }
  }

  function truncateForComment(html) {
    if (utf8Bytes(html) <= COMMENT_MAX_BYTES) return html;
    const notice = '<p><em>… truncated — the original exceeded Zoho\u2019s note size limit. Open the source ticket for the full message.</em></p>';
    const budget = COMMENT_MAX_BYTES - utf8Bytes(notice);
    let lo = 0, hi = html.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (utf8Bytes(html.slice(0, mid)) <= budget) lo = mid; else hi = mid;
    }
    return html.slice(0, lo) + notice;
  }

  // Every note goes through here so the size cap cannot be forgotten at a call site.
  function postComment(ticketId, html, isPublic = false) {
    return zdPost(`/tickets/${ticketId}/comments`, {
      content: truncateForComment(html),
      contentType: 'html',
      isPublic,
    });
  }

  const zdGet   = (path)       => zdRequest(path);
  const zdPost  = (path, body) => zdRequest(path, { method: 'POST', body });
  const zdPatch = (path, body) => zdRequest(path, { method: 'PATCH', body });

  // ===== BACKEND =====
  function gmRequest(method, url, data) {
    return new Promise((resolve) => {
      const headers = { 'Content-Type': 'application/json' };
      const secret = getSecret();
      if (secret) headers.Authorization = 'Bearer ' + secret;
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        timeout: 60000,   // Render free tier can take ~30s to wake
        ontimeout: () => resolve({ ok: false, status: 0, data: { error: 'Request timed out' } }),
        data: data !== undefined ? JSON.stringify(data) : undefined,
        onload: (res) => {
          try {
            resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, data: JSON.parse(res.responseText) });
          } catch (e) {
            // A Render cold start answers with an HTML wake-up page.
            resolve({ ok: false, status: res.status, data: { error: 'Invalid JSON from server (Render may be waking up — retry in ~30s)' } });
          }
        },
        onerror: () => resolve({ ok: false, status: 0, data: { error: 'Could not reach the MWR backend. The first request may take ~30s to wake Render.' } }),
      });
    });
  }

  const gmGet  = (url)       => gmRequest('GET', url);
  const gmPost = (url, data) => gmRequest('POST', url, data);

  // Every backend route lives under /api and requires the shared secret, which
  // gmRequest attaches as a bearer token.
  const api = {
    extract:          (body)   => gmPost(`${BACKEND_URL}/api/extract`, body),
    booking:          (id)     => gmGet(`${BACKEND_URL}/api/booking/${encodeURIComponent(id)}`),
    findUser:         (query)  => gmPost(`${BACKEND_URL}/api/find-user`, { query }),
    user:             (userId) => gmGet(`${BACKEND_URL}/api/user/${encodeURIComponent(userId)}`),
    userReservations: (userId) => gmGet(`${BACKEND_URL}/api/user/${encodeURIComponent(userId)}/reservations`),
    // Retried because it is idempotent and because Render's free tier sleeps: the
    // first call after an idle spell answers with a wake-up page rather than
    // JSON, which otherwise surfaces as a translation failure. Note, reply and
    // merge calls are deliberately NOT retried — repeating those would post
    // twice.
    translate: async (text, target = 'en') => {
      let last = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        last = await gmPost(`${BACKEND_URL}/api/translate`, { text, target });
        if (last.ok && last.data && last.data.text) return last;
        if (attempt < 2) await new Promise((r) => setTimeout(r, attempt === 0 ? 1500 : 4000));
      }
      return last;
    },
    linkTicketBooking: (body)  => gmPost(`${BACKEND_URL}/api/ticket-booking`, body),
    bookingTickets:   (bookingId, exclude) =>
      gmGet(`${BACKEND_URL}/api/booking-tickets/${encodeURIComponent(bookingId)}` +
            (exclude ? `?exclude=${encodeURIComponent(exclude)}` : '')),
  };

  // ===== UI HELPERS (ported from the Freshdesk script — DOM-framework agnostic) =====
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // navigator.clipboard needs a secure context and can be absent inside the
  // userscript sandbox, so fall back to the legacy path rather than failing.
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function showToast(message, type = 'success', duration = 4000) {
    const colors = { success: THEME.success, error: THEME.danger, info: THEME.info, warning: '#fd7e14' };
    const toast = document.createElement('div');
    toast.style.cssText = `position:fixed;bottom:24px;right:24px;background:${colors[type] || THEME.success};color:#fff;padding:12px 18px;border-radius:8px;font-size:13px;font-family:${THEME.font};box-shadow:0 4px 14px rgba(0,0,0,0.25);z-index:9999999;max-width:360px;line-height:1.5;`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  async function withButtonLoading(btn, loadingLabel, fn) {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = loadingLabel || '⏳ Loading...';
    try { return await fn(); }
    finally { btn.disabled = false; btn.textContent = orig; }
  }

  function makeDraggable(modal, handle) {
    let ox = 0, oy = 0, dragging = false;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, a, input, select, textarea')) return;
      dragging = true;
      const rect = modal.getBoundingClientRect();
      modal.style.left = rect.left + 'px';
      modal.style.top = rect.top + 'px';
      modal.style.transform = 'none';
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = modal.getBoundingClientRect();
      const margin = 40;
      const nx = Math.max(margin - rect.width, Math.min(window.innerWidth - margin, e.clientX - ox));
      const ny = Math.max(0, Math.min(window.innerHeight - margin, e.clientY - oy));
      modal.style.left = nx + 'px';
      modal.style.top = ny + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // Stops Desk's own keyboard shortcuts firing while the agent types in our modal.
  function trapKeyEventsForModal(modalElement) {
    const types = ['keydown', 'keyup', 'keypress'];
    const handler = (e) => {
      if (!modalElement.isConnected) {
        types.forEach((t) => window.removeEventListener(t, handler, true));
        return;
      }
      if (modalElement.contains(e.target)) e.stopImmediatePropagation();
    };
    types.forEach((t) => window.addEventListener(t, handler, true));
  }

  function createModal(id, title, opts = {}) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = id;
    modal.style.cssText = `position:fixed;background:#fff;border-radius:${THEME.radius};box-shadow:${THEME.shadow};z-index:${opts.zIndex || 999999};font-family:${THEME.font};display:flex;flex-direction:column;` + (opts.style || '');

    const header = document.createElement('div');
    header.style.cssText = `padding:12px 16px;border-bottom:1px solid ${THEME.border};display:flex;justify-content:space-between;align-items:center;flex-shrink:0;cursor:move;`;
    const titleEl = document.createElement('span');
    titleEl.style.cssText = `font-weight:600;font-size:14px;color:${THEME.text};`;
    titleEl.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;';
    closeBtn.onclick = () => modal.remove();
    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;padding:16px;' + (opts.bodyStyle || '');

    modal.appendChild(header);
    modal.appendChild(body);
    document.body.appendChild(modal);
    if (!opts.noDrag) makeDraggable(modal, header);
    trapKeyEventsForModal(modal);
    return { modal, header, body, closeBtn };
  }

  // ===== TICKET CONTEXT =====
  // /agent/{portal}/{dept}/tickets/details/{ticketId}
  function getZohoTicketId() {
    const m = location.pathname.match(/\/tickets\/details\/(\d+)/);
    return m ? m[1] : null;
  }

  // Migrated tickets carry the old Freshdesk routing address in ticket.email
  // (e.g. traveladvantagecommember@mwrlife.freshdesk.com), not the customer's.
  // Helpdesk system addresses must never be used to identify a member or to hunt
  // for duplicates — they match either nothing or everything.
  const SYSTEM_EMAIL_DOMAINS = /@([a-z0-9-]+\.)*(freshdesk|zohodesk)\.com$/i;

  // Shared company mailboxes. Mail forwarded through member@traveladvantage.com
  // lands on a contact whose own lastName is that address, so treating it as a
  // customer identity searches TA for the mailbox instead of the member and
  // leaves every such ticket attached to the same placeholder contact.
  const SHARED_MAILBOXES = /^(member|support|info|help|noreply|no-reply|bookings?)@(traveladvantage\.com|mwrlife\.com)$/i;

  function isPlaceholderEmail(email) {
    const e = String(email || '').trim();
    if (!e) return true;
    return SYSTEM_EMAIL_DOMAINS.test(e) || SHARED_MAILBOXES.test(e);
  }

  function usableEmail(email) {
    if (!email || typeof email !== 'string') return null;
    const e = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return null;
    if (isPlaceholderEmail(e)) return null;
    return e;
  }

  function htmlToText(html) {
    const div = document.createElement('div');
    div.innerHTML = String(html || '');
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // The extension read this from ZOHODESK.get('ticket'); an overlay is not a
  // widget, so it comes from the API instead.
  //
  // Three things the live API makes necessary here:
  //   - `ticket.description` is frequently null, so the thread text is not a
  //     fallback but the normal path.
  //   - The threads *list* carries only a truncated `summary`; full `content`
  //     only comes from the thread-detail endpoint.
  //   - `isDescriptionThread` is false on every thread in practice, so the
  //     customer's original message is found by taking the oldest inbound
  //     thread (threads come back newest-first), not by that flag.
  async function fetchTicketContext(ticketId) {
    const ticket = await zdGet(`/tickets/${ticketId}`);

    // The contact record is the authoritative source for the customer's address;
    // ticket.email is whatever the channel recorded, which after the Freshdesk
    // migration is often a routing address.
    let contact = null;
    if (ticket.contactId) {
      try { contact = await zdGet(`/contacts/${ticket.contactId}`); } catch (e) { /* optional */ }
    }
    const contactEmail = contact
      ? (usableEmail(contact.email) || usableEmail(contact.secondaryEmail))
      : null;
    const email = contactEmail || usableEmail(ticket.email);
    const contactName = contact
      ? [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || null
      : null;

    let description = htmlToText(ticket.description);

    try {
      const threads = await zdGet(`/tickets/${ticketId}/threads?limit=10`);
      const list = (threads && threads.data) || [];
      const chat = list.find((t) => t.channel === 'ONLINE_CHAT');
      currentChatThreadId = chat ? chat.id : null;
      if (list.length) {
        const inbound = list.filter((t) => t.direction === 'in');
        const pick = (inbound.length ? inbound : list)[(inbound.length ? inbound : list).length - 1];
        const detail = await zdGet(`/tickets/${ticketId}/threads/${pick.id}`);
        const threadText = htmlToText(detail.content || detail.summary || '');
        if (threadText) description = description ? description + '\n\n' + threadText : threadText;
      }
    } catch (e) {
      console.warn('[ta] thread fetch failed, using ticket fields only:', e.message);
    }

    // Booking refs sit near the top of the message; the tail is quoted history
    // and signatures. Capping keeps the extraction call cheap and focused.
    if (description.length > 4000) description = description.slice(0, 4000);

    return {
      subject: ticket.subject || '', description, ticket, email, contactName,
      contactFirstName: contact ? (contact.firstName || null) : null,
      contactLastName: contact ? (contact.lastName || null) : null,
      contactEmailRaw: contact ? (contact.email || null) : (ticket.email || null),
    };
  }

  // ===== PANELS =====
  // Two independent cards in one rail. Duplicates deliberately does NOT live
  // inside the booking card: duplicate detection has to work on tickets where no
  // booking reference was ever found, which is exactly when an agent most needs
  // to know the ticket is a repeat.
  function buildCard(id, titleText, color) {
    const card = document.createElement('div');
    card.id = id;
    card.style.cssText = `background:#fff;border-radius:${THEME.radius};box-shadow:${THEME.shadow};display:flex;flex-direction:column;flex-shrink:0;max-height:100%;`;

    const header = document.createElement('div');
    header.style.cssText = `padding:9px 13px;border-bottom:1px solid ${THEME.border};display:flex;justify-content:space-between;align-items:center;flex-shrink:0;`;
    const title = document.createElement('span');
    title.id = id + 'Title';
    title.style.cssText = `font-weight:600;font-size:13px;color:${color};`;
    title.textContent = titleText;
    const controls = document.createElement('span');
    controls.id = id + 'Controls';
    const collapse = document.createElement('button');
    collapse.textContent = '–';
    collapse.style.cssText = 'background:none;border:none;font-size:16px;color:#aaa;cursor:pointer;';
    controls.appendChild(collapse);
    header.appendChild(title);
    header.appendChild(controls);

    const body = document.createElement('div');
    body.id = id + 'Body';
    body.style.cssText = 'flex:1;overflow-y:auto;padding:11px 13px;';

    collapse.onclick = () => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? 'block' : 'none';
      collapse.textContent = hidden ? '–' : '+';
    };

    card.appendChild(header);
    card.appendChild(body);
    return { card, header, body, controls };
  }

  function injectPanels() {
    // Self-healing rather than a bare existence check: if the rail survived but a
    // card inside it did not, rebuild the whole thing. A half-built rail used to
    // be unrecoverable, and because checkTicketChange keys off the booking card
    // it re-entered loadTicket every tick — a silent request loop.
    const existing = document.getElementById('taRail');
    const intact = existing
      && document.getElementById('taBookingPanel')
      && document.getElementById('taDupPanel');
    if (intact) return;
    if (existing) existing.remove();

    const rail = document.createElement('div');
    rail.id = 'taRail';
    rail.style.cssText = `position:fixed;top:80px;right:18px;width:345px;max-height:calc(100vh - 100px);z-index:999998;font-family:${THEME.font};display:flex;flex-direction:column;gap:10px;overflow-y:auto;`;

    const booking = buildCard('taBookingPanel', 'TA Booking', THEME.primary);
    const gear = document.createElement('button');
    gear.textContent = '⚙';
    gear.title = 'Set backend key';
    gear.style.cssText = 'background:none;border:none;font-size:14px;color:#bbb;cursor:pointer;margin-right:4px;';
    gear.onclick = () => promptForSecret(true);
    booking.controls.insertBefore(gear, booking.controls.firstChild);
    booking.body.innerHTML = `<div style="color:${THEME.subtle};font-size:13px;">Loading…</div>`;

    const dups = buildCard('taDupPanel', 'Duplicates', '#b8860b');
    const refresh = document.createElement('button');
    refresh.textContent = '⟳';
    refresh.title = 'Re-run duplicate search';
    refresh.style.cssText = 'background:none;border:none;font-size:13px;color:#bbb;cursor:pointer;margin-right:4px;';
    refresh.onclick = () => loadDuplicates(true);
    dups.controls.insertBefore(refresh, dups.controls.firstChild);
    dups.body.id = 'taDuplicates';

    rail.appendChild(booking.card);
    rail.appendChild(dups.card);
    document.body.appendChild(rail);
    makeDraggable(rail, booking.header);
  }

  function panelBody() {
    return document.getElementById('taBookingPanelBody');
  }

  function renderPanelMessage(html) {
    const body = panelBody();
    if (body) body.innerHTML = html;
  }

  // TA's AI-reconfirmation status chip. Kept byte-identical to the
  // TA_Zoho_beta widget version so both panels read the same.
  function renderAiReconfirmBadge(r) {
    if (!r) return '';
    if (typeof r === 'string') return r;
    const palette = {
      confirmed: { bg: '#d4edda', fg: '#155724', icon: '✓' },
      failed:    { bg: '#f8d7da', fg: '#721c24', icon: '✗' },
      initiated: { bg: '#fff3cd', fg: '#856404', icon: '🕐' },
    };
    const c = palette[r.status] || palette.initiated;
    const dateSuffix = r.date ? ' · ' + r.date : '';
    const titleAttr = (r.title || 'AI Reconfirmation').replace(/"/g, '&quot;');
    return `<span style="display:inline-block;padding:3px 10px;border-radius:10px;background:${c.bg};color:${c.fg};font-size:13px;font-weight:600;" title="${titleAttr}">${c.icon} ${r.title || 'AI Reconfirmation'}${dateSuffix}</span>`;
  }

  function daysUntilCheckIn(checkIn) {
    if (!checkIn) return null;
    const months = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
    const m = checkIn.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (!m) return null;
    const mi = months[m[1].toLowerCase()];
    if (mi === undefined) return null;
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const ci = new Date(parseInt(m[3], 10), mi, parseInt(m[2], 10));
    return Math.round((ci - now) / 86400000);
  }

  function getDisplayUser() {
    const cached = ticketBookingCache[currentTicketId];
    return panelUserOverride || (cached && cached.user) || null;
  }

  // Row-for-row mirror of TA_Zoho_beta/app/widget.js.
  function renderBookingPanel() {
    const body = panelBody();
    if (!body) return;
    const bd = ticketBookingCache[currentTicketId];

    if (bd && bd.booking) {
      const { booking, details } = bd;
      const cleanSupplierName = (name) => (name || '')
        .replace(/\s*\(\d+\)\s*$/g, '').replace(/\bV\d+\b/gi, '').replace(/\bpackage\b/gi, '').trim();
      const productType = (booking.productType || '').toLowerCase();
      const isHotel  = productType.includes('hotel') || productType.includes('getaway');
      const isFlight = productType.includes('flight');
      const daysUntil = daysUntilCheckIn(booking.checkIn);
      const txt = (v) => escapeHtml(v || '—');

      const rows = [
        ['Booking ID', txt(booking.internalBookingId)],
        ['Supplier ID', txt(booking.supplierId)],
        ['Type', txt(booking.productType)],
        ['Supplier', txt(cleanSupplierName(booking.supplierName))],
        isHotel  ? ['Hotel',   txt(details && details.hotelName)] : null,
        isFlight ? ['Airline', txt(details && details.departAirline)] : null,
        ['Guest', txt(booking.guestName)],
        ['Check-In', txt(booking.checkIn)],
        ['Check-Out', txt(booking.checkOut)],
        daysUntil !== null ? ['Days until', `${daysUntil} days`] : null,
        booking.mwrRoomType ? ['Room Type', escapeHtml(booking.mwrRoomType)] : null,
        details && details.bedTypes ? ['Bed Types', escapeHtml(details.bedTypes)] : null,
        details && details.arrivalTime ? ['Arrival time', escapeHtml(details.arrivalTime)] : null,
        details && details.requests ? ['Requests', `<span style="color:#5d4037;">${escapeHtml(details.requests)}</span>`] : null,
        booking.aiReconfirmation ? ['AI Reconfirm', renderAiReconfirmBadge(booking.aiReconfirmation)] : null,
      ].filter(Boolean);

      const tableHtml = rows.map(([label, valHtml]) =>
        `<tr><th style="padding:5px 8px;text-align:left;color:${THEME.muted};font-weight:500;width:38%;white-space:nowrap;vertical-align:top;font-size:12px;">${escapeHtml(label)}</th>`
        + `<td style="padding:5px 8px;color:${THEME.text};font-size:13px;">${valHtml}</td></tr>`
      ).join('');

      const detailUrl = booking.detailUrl
        ? (String(booking.detailUrl).indexOf('http') === 0 ? booking.detailUrl : TA_BASE + booking.detailUrl)
        : null;
      const openBookingHtml = detailUrl
        ? `<a href="${escapeHtml(detailUrl)}" target="_blank" rel="noopener" style="display:block;margin-top:8px;padding:7px 10px;border:1px solid ${THEME.primary};border-radius:6px;background:#fff;color:${THEME.primary};font-size:13px;font-weight:600;text-align:center;text-decoration:none;">🔗 Open Booking in TA</a>`
        : '';

      body.innerHTML = `
        <table style="width:100%;border-collapse:collapse;">${tableHtml}</table>
        <div style="display:flex;gap:6px;margin-top:10px;">
          <button id="taPostNote" style="flex:1;padding:7px 6px;border:1px solid ${THEME.success};border-radius:5px;background:#fff;color:${THEME.success};font-size:12px;font-weight:600;cursor:pointer;">Post Note</button>
          <button id="taViewNote" style="flex:1;padding:7px 6px;border:1px solid #d3d8de;border-radius:5px;background:#fff;color:${THEME.text};font-size:12px;cursor:pointer;">View Note</button>
        </div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button id="taSupplierEmailBtn" style="flex:1;padding:7px 6px;border:1px solid ${THEME.info};border-radius:5px;background:#fff;color:${THEME.info};font-size:12px;font-weight:600;cursor:pointer;">✉ Supplier</button>
          <button id="taChangeBooking" style="flex:1;padding:7px 6px;border:1px solid #d3d8de;border-radius:5px;background:#fff;color:${THEME.text};font-size:12px;cursor:pointer;">Change</button>
        </div>
        <div id="taChangeRow" style="display:none;gap:6px;margin-top:8px;">
          <input id="taChangeInput" type="text" placeholder="Booking ID…" style="flex:1;min-width:0;padding:6px 9px;border:1px solid #d3d8de;border-radius:4px;font-size:13px;" />
          <button id="taChangeFetch" style="flex:0 0 auto;padding:6px 10px;border:1px solid #d3d8de;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;">Fetch</button>
        </div>
        <div style="margin-top:8px;padding-top:8px;border-top:1px dashed ${THEME.border};">
          <div style="display:flex;gap:5px;">
            <select id="taIssueSel" style="flex:1;min-width:0;padding:6px 8px;border:1px solid #d3d8de;border-radius:4px;font-size:12px;background:#fff;color:${THEME.text};">
              ${SUBJECT_ISSUES.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}
            </select>
            <button id="taRenameBtn" style="flex:0 0 auto;padding:6px 9px;border:1px solid ${THEME.primary};border-radius:4px;background:#fff;color:${THEME.primary};font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;">✏️ Rename</button>
          </div>
          <input id="taIssueOther" type="text" placeholder="Custom issue…" style="display:none;width:100%;box-sizing:border-box;margin-top:5px;padding:6px 8px;border:1px solid #d3d8de;border-radius:4px;font-size:12px;" />
          <div id="taRenamePreview" style="font-size:10px;color:${THEME.muted};margin-top:4px;word-break:break-word;"></div>
        </div>
        ${openBookingHtml}
      `;
      document.getElementById('taPostNote').addEventListener('click', onPostNote);
      document.getElementById('taViewNote').addEventListener('click', onViewNote);
      const supBtn = document.getElementById('taSupplierEmailBtn');
      if (supBtn) supBtn.addEventListener('click', onSupplierEmail);
      wireChangeBooking();
      wireRenameSubject(booking);
    } else {
      // A failed lookup is a starting point, not a dead end: the agent still
      // needs to find the booking by hand or work from the member instead.
      const notice = panelNotice
        ? `<div style="background:#fff3cd;border:1px solid #ffe08a;border-radius:5px;padding:7px 9px;color:#856404;font-size:12px;line-height:1.5;">${escapeHtml(panelNotice.text)}</div>`
        : `<div style="color:${THEME.subtle};font-size:13px;">No booking reference found in this ticket.</div>`;
      body.innerHTML = `${notice}
        <div style="display:flex;gap:6px;margin-top:10px;">
          <button id="taChangeBooking" style="flex:1;padding:7px 6px;border:1px solid ${THEME.primary};border-radius:5px;background:#fff;color:${THEME.primary};font-size:12px;font-weight:600;cursor:pointer;">🔍 Fetch booking</button>
          <button id="taFetchUser" style="flex:1;padding:7px 6px;border:1px solid #007bff;border-radius:5px;background:#fff;color:#007bff;font-size:12px;font-weight:600;cursor:pointer;">👤 Fetch user</button>
        </div>
        <div id="taChangeRow" style="display:none;gap:6px;margin-top:8px;">
          <input id="taChangeInput" type="text" placeholder="Booking ID…" style="flex:1;min-width:0;padding:6px 9px;border:1px solid #d3d8de;border-radius:4px;font-size:13px;" />
          <button id="taChangeFetch" style="flex:0 0 auto;padding:6px 10px;border:1px solid #d3d8de;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;">Fetch</button>
        </div>`;
      wireChangeBooking();
      document.getElementById('taFetchUser').addEventListener('click', onFetchUser);
    }

    appendMemberSection(body, getDisplayUser());
  }

  // Rebuilds the subject as "bookingId / supplierId / Issue" — the Freshdesk
  // convention, which the duplicate search still relies on to match by reference.
  const SUBJECT_ISSUES = ['Reconfirmation', 'Cancellation', 'Modification', 'Complaint', 'Question',
                          'GuaranteeClaim', 'InfoRequest', 'Voucher', 'Info', 'Other'];

  function wireRenameSubject(booking) {
    const sel = document.getElementById('taIssueSel');
    const other = document.getElementById('taIssueOther');
    const btn = document.getElementById('taRenameBtn');
    const preview = document.getElementById('taRenamePreview');
    if (!sel || !other || !btn || !preview) return;

    const currentIssue = () => (sel.value === 'Other' ? other.value.trim() : sel.value);
    const buildSubject = () =>
      [booking.internalBookingId, booking.supplierId, currentIssue()].filter(Boolean).join(' / ');

    const sync = () => {
      other.style.display = sel.value === 'Other' ? '' : 'none';
      const noBooking = !booking.internalBookingId;
      const needsOther = sel.value === 'Other' && !other.value.trim();
      btn.disabled = noBooking || needsOther;
      btn.style.opacity = btn.disabled ? '0.5' : '1';
      btn.style.cursor = btn.disabled ? 'not-allowed' : 'pointer';
      preview.textContent = noBooking ? '⚠️ No booking ID — rename disabled' : '→ ' + buildSubject();
    };
    sel.onchange = sync;
    other.oninput = sync;
    sync();

    btn.onclick = async () => {
      if (btn.disabled) return;
      const subject = buildSubject();
      await withButtonLoading(btn, '⏳', async () => {
        try {
          // classification 'Reservations' is Zoho's counterpart to the ticket
          // type Freshdesk stamped on rename.
          await zdPatch(`/tickets/${currentTicketId}`, { subject, classification: 'Reservations' });
          if (currentTicketMeta) currentTicketMeta.subject = subject;
          showToast('Subject renamed — reload the ticket to see it in Desk.', 'success');
        } catch (err) {
          showToast('Rename failed: ' + err.message, 'error');
        }
      });
      sync();
    };
  }

  function wireChangeBooking() {
    const toggle = document.getElementById('taChangeBooking');
    const row = document.getElementById('taChangeRow');
    const input = document.getElementById('taChangeInput');
    const fetchBtn = document.getElementById('taChangeFetch');
    if (!toggle || !row || !input || !fetchBtn) return;
    input.value = currentBookingId || (panelNotice && panelNotice.bookingId) || '';
    toggle.addEventListener('click', () => {
      const open = row.style.display !== 'none';
      row.style.display = open ? 'none' : 'flex';
      if (!open) input.focus();
    });
    const doFetch = async () => {
      const id = input.value.trim();
      if (!id) return;
      await withButtonLoading(fetchBtn, '…', async () => {
        const res = await api.booking(id);
        if (!res.ok || !res.data.success) {
          showToast('Booking not found: ' + (res.data.error || id), 'error');
          return;
        }
        currentBookingId = id;
        ticketBookingCache[currentTicketId] = res.data.bookingData;
        renderBookingPanel();
        recordBookingLink(id, 'manual');
      });
    };
    fetchBtn.addEventListener('click', doFetch);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFetch(); });
  }

  // When no booking resolves, the ticket's own contact address is the only handle
  // on who this is, so the member lookup runs automatically rather than waiting
  // for a click. When a booking DOES resolve it already carries its member and
  // this never fires.
  function seedMemberLookupFromTicket() {
    if (panelUserOverride) return false;
    const meta = currentTicketMeta || {};
    // Name is a weaker key than email, but on a migrated ticket whose only
    // address is a routing one it is all there is.
    const query = meta.email || meta.contactName;
    if (!query) return false;
    pendingMemberQuery = query;
    pendingMemberAuto = true;
    return true;
  }

  // Fetch user — the second route forward when there is no booking. Defaults to
  // the ticket's own contact address, which is almost always the member, and
  // hands the query to the Member section's existing search rather than building
  // a second results UI.
  function onFetchUser(e) {
    const fromTicket = (currentTicketMeta && currentTicketMeta.email) || '';
    const query = fromTicket
      || window.prompt('Find TA member by email or name:', '');
    if (!query) return;
    pendingMemberQuery = query;
    pendingMemberAuto = false;
    renderBookingPanel();
    if (e && e.currentTarget) e.currentTarget.blur();
  }

  // ===== MEMBER SECTION (ported from TA_Zoho_beta/app/widget.js) =====
  function appendMemberSection(container, user) {
    const sec = document.createElement('div');
    sec.style.cssText = `margin-top:14px;padding-top:12px;border-top:1px solid ${THEME.border};`;

    const hdr = document.createElement('div');
    hdr.style.cssText = `font-weight:600;font-size:11px;color:${THEME.muted};margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em;`;
    hdr.textContent = 'Member';
    sec.appendChild(hdr);

    if (user) {
      // Only PRIMARY members get customer-login / view URLs — secondaries use an
      // editTraveler() handler in TA's UI, so webadminCustomerLogin/{id} would hit
      // the wrong record. bookingData.user is always primary, so absent type =
      // primary.
      const isPrimary = !user.type || user.type === 'primary';
      // profileLink is derivable from the id; the LOGIN url is NOT. TA's real
      // one is /webadminCustomerLogin/<opaque token>, not the numeric id, so it
      // can only come from the member's own profile page (parseUserHtml reads it).
      // Synthesising it from the id produced a link to nothing — and only on
      // members resolved by search, which is why it looked intermittent.
      if (isPrimary && user.id && !user.profileLink) user.profileLink = `${TA_BASE}/admin/account/viewCustomer/${user.id}`;

      const tabBar = document.createElement('div');
      tabBar.style.cssText = `display:flex;border-bottom:1px solid ${THEME.border};margin-bottom:8px;`;
      const makeTabBtn = (label, active) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = `flex:1;padding:6px;border:none;border-bottom:2px solid ${active ? '#007bff' : 'transparent'};background:${active ? '#f8f8f8' : 'transparent'};font-size:12px;font-weight:${active ? '600' : '400'};cursor:pointer;`;
        return b;
      };
      const profileTab = makeTabBtn('Profile', true);
      const resTab = makeTabBtn('Reservations', false);
      tabBar.appendChild(profileTab);
      tabBar.appendChild(resTab);
      sec.appendChild(tabBar);

      const tabContent = document.createElement('div');
      sec.appendChild(tabContent);

      const setActive = (btn) => {
        [profileTab, resTab].forEach((b) => {
          const active = b === btn;
          b.style.borderBottomColor = active ? '#007bff' : 'transparent';
          b.style.background = active ? '#f8f8f8' : 'transparent';
          b.style.fontWeight = active ? '600' : '400';
        });
      };

      const showProfileTab = () => {
        setActive(profileTab);
        tabContent.innerHTML = '';
        const actionRow = document.createElement('div');
        actionRow.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-bottom:10px;';
        if (user.loginLink) {
          const a = document.createElement('a');
          a.href = user.loginLink; a.target = '_blank'; a.rel = 'noopener';
          a.textContent = '🔑 Login as User';
          a.style.cssText = 'display:block;background:#007bff;color:#fff;padding:6px 10px;border-radius:4px;text-decoration:none;font-size:12px;text-align:center;';
          actionRow.appendChild(a);
        }
        if (user.profileLink) {
          const a = document.createElement('a');
          a.href = user.profileLink; a.target = '_blank'; a.rel = 'noopener';
          a.textContent = '👤 Open Full Profile';
          a.style.cssText = 'display:block;background:#0056d2;color:#fff;padding:6px 10px;border-radius:4px;text-decoration:none;font-size:12px;text-align:center;';
          actionRow.appendChild(a);
        }
        const syncBtn = document.createElement('button');
        syncBtn.textContent = '⇪ Fix ticket contact';
        syncBtn.title = 'Point this ticket at the TA member\u2019s contact and reply-to address';
        syncBtn.style.cssText = `padding:6px 10px;border:1px solid ${THEME.primary};border-radius:4px;background:#fff;color:${THEME.primary};font-size:12px;cursor:pointer;font-weight:500;`;
        syncBtn.addEventListener('click', (e) =>
          withButtonLoading(e.currentTarget, '⏳', () => syncTicketContact(user, false)));
        actionRow.appendChild(syncBtn);

        const memberNoteBtn = document.createElement('button');
        memberNoteBtn.textContent = '📋 Post Member Note';
        memberNoteBtn.style.cssText = `padding:6px 10px;border:1px solid ${THEME.success};border-radius:4px;background:#fff;color:${THEME.success};font-size:12px;cursor:pointer;font-weight:500;`;
        memberNoteBtn.addEventListener('click', () => onPostMemberNote(memberNoteBtn, user));
        actionRow.appendChild(memberNoteBtn);
        tabContent.appendChild(actionRow);

        const uRows = [
          ['Name', user.fullName || user.name],
          ['Email', user.email],
          ['Phone', user.phone],
          ['Country', user.country],
          ['Preferred Language', user.language],
          ['Status', user.status],
        ].filter(([, val]) => val);
        const uTable = document.createElement('table');
        uTable.style.cssText = 'width:100%;border-collapse:collapse;';
        uRows.forEach(([label, val]) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `<th style="padding:4px 6px;text-align:left;color:#aaa;font-weight:500;font-size:12px;white-space:nowrap;">${escapeHtml(label)}</th><td style="padding:4px 6px;color:${THEME.text};font-size:12px;word-break:break-all;">${escapeHtml(val)}</td>`;
          uTable.appendChild(tr);
        });
        tabContent.appendChild(uTable);
      };

      const renderReservationsList = (reservations) => {
        if (!reservations || !reservations.length) return `<div style="color:${THEME.muted};font-size:12px;">No reservations found.</div>`;
        return reservations.map((r) => {
          const s = (r.status || '').toLowerCase();
          const sc = s.includes('confirm') ? THEME.success
                   : s.includes('cancel')  ? '#6c757d'
                   : s.includes('fail')    ? THEME.danger : '#007bff';
          return `<div data-bookingid="${escapeHtml(r.bookingId)}" style="padding:6px 8px;border:1px solid ${THEME.border};border-radius:4px;margin-bottom:5px;cursor:pointer;font-size:12px;background:#fff;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span><strong>#${escapeHtml(r.bookingId)}</strong> <span style="color:#666;font-size:11px;">${escapeHtml(r.type || '')}</span></span>
              <span style="color:${sc};font-size:11px;font-weight:600;">${escapeHtml(r.status || '')}</span>
            </div>
            <div style="font-size:11px;color:#666;margin-top:2px;">${escapeHtml(r.guest || '')}${r.checkIn ? ' · ' + escapeHtml(r.checkIn) + ' → ' + escapeHtml(r.checkOut || '') : ''}</div>
          </div>`;
        }).join('');
      };

      const wireReservationRows = () => {
        tabContent.querySelectorAll('[data-bookingid]').forEach((el) => {
          el.onmouseover = () => { el.style.background = '#f5f5f5'; };
          el.onmouseout = () => { el.style.background = '#fff'; };
          el.onclick = async () => {
            const bid = el.dataset.bookingid;
            el.style.opacity = '0.5';
            el.style.background = '#fffbe6';
            const res = await api.booking(bid);
            if (!res.ok || !res.data.success) {
              el.style.opacity = '1';
              el.style.background = '#fff';
              showToast('Booking not found: ' + bid, 'error');
              return;
            }
            currentBookingId = bid;
            ticketBookingCache[currentTicketId] = res.data.bookingData;
            renderBookingPanel();
            recordBookingLink(bid, 'manual');
          };
        });
      };

      const showReservationsTab = async () => {
        setActive(resTab);
        if (!user.id) { tabContent.innerHTML = `<div style="color:${THEME.subtle};font-size:12px;">No user ID.</div>`; return; }
        const cached = reservationsCache[String(user.id)];
        if (cached) {
          tabContent.innerHTML = renderReservationsList(cached);
          wireReservationRows();
          return;
        }
        tabContent.innerHTML = `<div style="color:${THEME.subtle};font-size:12px;">⏳ Loading…</div>`;
        const res = await api.userReservations(user.id);
        if (!res.ok) {
          tabContent.innerHTML = `<div style="color:${THEME.danger};font-size:12px;">Failed to load reservations.</div>`;
          return;
        }
        const reservations = res.data.reservations || [];
        reservationsCache[String(user.id)] = reservations;
        tabContent.innerHTML = renderReservationsList(reservations);
        wireReservationRows();
      };

      profileTab.onclick = showProfileTab;
      resTab.onclick = showReservationsTab;
      showProfileTab();
    } else {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = `color:${THEME.subtle};font-size:12px;margin-bottom:8px;`;
      emptyMsg.textContent = 'No member data — search below.';
      sec.appendChild(emptyMsg);
    }

    // Find member — always available, with or without a loaded member.
    const findRow = document.createElement('div');
    findRow.style.cssText = 'display:none;gap:6px;margin-top:6px;';
    const findInput = document.createElement('input');
    findInput.type = 'text';
    findInput.placeholder = 'Email or name…';
    findInput.style.cssText = 'flex:1;min-width:0;padding:6px 9px;border:1px solid #ddd;border-radius:4px;font-size:12px;';
    const findBtn = document.createElement('button');
    findBtn.textContent = '🔍';
    findBtn.style.cssText = `flex:0 0 auto;padding:6px 11px;border:none;border-radius:4px;background:${THEME.primary};color:#fff;font-size:12px;cursor:pointer;`;
    const findResults = document.createElement('div');
    findResults.style.cssText = 'margin-top:6px;font-size:12px;';

    const selectMember = (u, viaAuto) => {
      const primary = !u.type || u.type === 'primary';
      // 'email' only when an automatic lookup matched on an address; a name-based
      // auto-match is the weak case that must not trigger write-back.
      panelUserSource = viaAuto
        ? (/^[^@\s]+@[^@\s]+$/.test(findInput.value.trim()) ? 'email' : 'name')
        : 'manual';
      panelUserOverride = primary
        ? Object.assign({}, u, { profileLink: `${TA_BASE}/admin/account/viewCustomer/${u.id}` })
        : Object.assign({}, u);
      if (!primary) showToast('Secondary traveler — no Login-as-User available.', 'warning');
      renderBookingPanel();

      // Search results carry no login URL. Pull the member's profile so the
      // genuine token-based link (and the fuller field set) replaces the stub.
      if (primary && u.id) {
        api.user(u.id).then((res) => {
          if (!res.ok || !res.data || !res.data.user) return;
          if (!panelUserOverride || String(panelUserOverride.id) !== String(u.id)) return;
          const full = res.data.user;
          panelUserOverride = Object.assign({}, panelUserOverride, full, {
            id: panelUserOverride.id,
            profileLink: full.profileLink || panelUserOverride.profileLink,
          });
          renderBookingPanel();
          maybeSyncMember(panelUserOverride);
        }).catch(() => { /* the stub profile link still works */ });
      }
    };

    const doFind = async (auto) => {
      const q = findInput.value.trim();
      if (!q) return;
      await withButtonLoading(findBtn, '⏳', async () => {
        const res = await api.findUser(q);
        findResults.innerHTML = '';
        if (!res.ok) { findResults.textContent = 'Search failed: ' + (res.data.error || ''); return; }
        const results = res.data.results || [];
        if (!results.length) {
          findResults.textContent = auto ? 'No TA member matches the ticket contact.' : 'No results.';
          return;
        }
        // A single hit on an automatic lookup is unambiguous, so take it. Several
        // hits stay a choice — guessing which traveller is the right one is
        // exactly the judgement an agent should make.
        if (auto && results.length === 1) { selectMember(results[0], true); return; }
        results.slice(0, 5).forEach((u) => {
          const item = document.createElement('div');
          item.style.cssText = 'padding:5px 0;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between;gap:8px;';
          const lbl = document.createElement('span');
          lbl.style.cssText = `color:${THEME.text};font-size:12px;`;
          lbl.textContent = `${u.name || ''}${u.email ? ' — ' + u.email : ''}`;
          const pickBtn = document.createElement('button');
          pickBtn.textContent = 'Select';
          pickBtn.style.cssText = `flex:0 0 auto;padding:3px 8px;border:1px solid ${THEME.primary};border-radius:3px;background:#fff;color:${THEME.primary};font-size:11px;cursor:pointer;`;
          pickBtn.onclick = () => selectMember(u, false);
          item.appendChild(lbl);
          item.appendChild(pickBtn);
          findResults.appendChild(item);
        });
      });
    };
    findBtn.addEventListener('click', () => doFind(false));
    findInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFind(false); });
    findRow.appendChild(findInput);
    findRow.appendChild(findBtn);

    const findToggle = document.createElement('button');
    findToggle.textContent = '🔍 Find member';
    findToggle.style.cssText = `margin-top:10px;padding:4px 10px;border:1px dashed #aaa;border-radius:4px;background:transparent;color:${THEME.muted};font-size:11px;cursor:pointer;`;
    findToggle.onclick = () => {
      const open = findRow.style.display !== 'none';
      findRow.style.display = open ? 'none' : 'flex';
      if (!open) setTimeout(() => findInput.focus(), 10);
    };
    sec.appendChild(findToggle);
    sec.appendChild(findRow);
    sec.appendChild(findResults);

    container.appendChild(sec);

    // Seeded by "Fetch user": open the search, prefill it and run it once.
    if (pendingMemberQuery) {
      const q = pendingMemberQuery;
      const auto = pendingMemberAuto;
      pendingMemberQuery = null;
      pendingMemberAuto = false;
      findRow.style.display = 'flex';
      findInput.value = q;
      doFind(auto);
    }
  }

  // ===== TICKET ↔ BOOKING LINK =====
  function ticketUrl(ticketId) {
    const m = location.pathname.match(/^\/agent\/([^/]+)\/([^/]+)\//);
    const portal = m ? m[1] : 'mwrlife';
    const dept = m ? m[2] : 'customer-support';
    return `/agent/${portal}/${dept}/tickets/details/${ticketId}`;
  }

  // Recorded as soon as a booking is established for a ticket, so the booking
  // becomes a durable key instead of something re-extracted on every visit.
  // Failure here is non-fatal — the panel still works, we just lose the link.
  async function recordBookingLink(bookingId, source) {
    if (!bookingId || !currentTicketId) return;
    const meta = currentTicketMeta || {};
    try {
      const res = await api.linkTicketBooking({
        ticketId: currentTicketId,
        bookingId,
        ticketNumber: meta.ticketNumber || null,
        subject: meta.subject || null,
        status: meta.status || null,
        source: source || 'auto',
      });
      if (!res.ok) console.warn('[ta] link failed:', (res.data && res.data.error) || res.status);
    } catch (err) {
      console.warn('[ta] link failed:', err.message);
    }
    delete duplicateCache[currentTicketId];
    loadDuplicates(true);
  }

  // ===== DUPLICATE SEARCH =====
  // Two sources, deliberately. The ticket_bookings link is exact but only knows
  // tickets an agent has already opened with this overlay running — a freshly
  // arrived duplicate has never been viewed, so it is simply absent from the DB.
  // Zoho's own search covers those, at the cost of being fuzzy. Neither alone is
  // sufficient; the union is.
  const DUP_SEARCH_LIMIT = 20;
  const DUP_ENRICH_MAX = 6;      // DB-only hits we'll spend a ticket fetch on

  function dupHaystack(t) {
    return [t.subject, t.description, t.lastThread && t.lastThread.summary]
      .filter(Boolean).join(' ').toLowerCase();
  }

  // Zoho search matches loosely — a booking ref returns tickets that do not
  // contain it, and a short numeric string returns pure noise. Verification
  // against the ticket's own text is what makes the result trustworthy; it is
  // the same guard the retired freshdeskService.searchTicketsStrict applied.
  async function zdSearchTickets(term, { verify = true, limit = DUP_SEARCH_LIMIT } = {}) {
    if (!term) return [];
    try {
      const res = await zdGet(`/search?searchStr=${encodeURIComponent(term)}&module=tickets&limit=${limit}`);
      let rows = (res && res.data) || [];
      if (verify) {
        const needle = String(term).toLowerCase();
        rows = rows.filter((t) => dupHaystack(t).includes(needle));
      }
      return rows;
    } catch (err) {
      console.warn(`[ta] search "${term}" failed:`, err.message);
      return [];
    }
  }

  // A match carries both WHAT matched and the VALUE it matched on, because the
  // value is what an agent actually needs to see — "booking ID" tells them
  // nothing, "412468" tells them why this ticket surfaced. Mirrors the Freshdesk
  // strip, which showed the matched value rather than the label.
  function normalizeSearchRow(t, label, value) {
    const a = t.assignee;
    return {
      id: String(t.id),
      ticketNumber: t.ticketNumber || null,
      subject: t.subject || '',
      status: t.status || null,
      statusType: t.statusType || null,
      priority: t.priority || null,
      assignee: a ? [a.firstName, a.lastName].filter(Boolean).join(' ') : null,
      createdTime: t.createdTime || null,
      matchedBy: [{ label, value: value == null ? label : String(value) }],
      linked: false,
    };
  }

  function normalizeDbRow(r) {
    return {
      id: String(r.ticket_id),
      ticketNumber: r.ticket_number || null,
      subject: r.subject || '',
      status: r.status || null,
      statusType: null,          // unknown until enriched
      priority: null,
      assignee: null,
      createdTime: r.created_at || null,
      matchedBy: [{ label: 'linked booking', value: String(r.booking_id || '') }],
      linked: true,
    };
  }

  function mergeDuplicates(groups) {
    const seen = new Map();
    groups.forEach((rows) => {
      rows.forEach((row) => {
        if (String(row.id) === String(currentTicketId)) return;
        const existing = seen.get(row.id);
        if (!existing) { seen.set(row.id, row); return; }
        row.matchedBy.forEach((m) => {
          if (!existing.matchedBy.some((x) => x.label === m.label && x.value === m.value)) {
            existing.matchedBy.push(m);
          }
        });
        existing.linked = existing.linked || row.linked;
        // Search rows carry richer data than DB rows; let them fill the gaps.
        ['ticketNumber', 'subject', 'status', 'statusType', 'priority', 'assignee'].forEach((k) => {
          if (!existing[k] && row[k]) existing[k] = row[k];
        });
      });
    });
    return [...seen.values()];
  }

  // DB-linked tickets that search did not also return have no status, so we
  // cannot honour the open/closed filter for them without a lookup.
  async function enrichLinkedRows(rows) {
    const needy = rows.filter((r) => r.linked && !r.statusType).slice(0, DUP_ENRICH_MAX);
    await Promise.all(needy.map(async (r) => {
      try {
        const t = await zdGet(`/tickets/${r.id}`);
        r.ticketNumber = r.ticketNumber || t.ticketNumber || null;
        r.subject = r.subject || t.subject || '';
        r.status = t.status || r.status;
        r.statusType = t.statusType || null;
        r.priority = r.priority || t.priority || null;
      } catch (e) { /* leave unenriched; it still renders */ }
    }));
    return rows;
  }

  // Every term we can search this ticket on. The contact email comes from the
  // ticket itself, so duplicate detection still works when no booking reference
  // was ever found — which is precisely when an agent is most likely to miss
  // that the ticket is a repeat.
  function collectDuplicateTerms() {
    const bd = ticketBookingCache[currentTicketId];
    const booking = bd && bd.booking;
    const user = getDisplayUser();
    const meta = currentTicketMeta || {};

    const terms = [
      { label: 'booking ID',   value: booking && booking.internalBookingId },
      { label: 'supplier ref', value: booking && booking.supplierId },
      { label: 'member email', value: user && user.email },
      { label: 'contact email', value: meta.email },
    ].filter((t) => t.value);

    // The booking's member and the ticket's contact are usually the same person;
    // searching the same address twice would double-badge every row.
    const seen = new Set();
    return terms.filter((t) => {
      const k = String(t.value).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  async function loadDuplicates(force) {
    const host = document.getElementById('taDuplicates');
    if (!host || !currentTicketId) return;
    if (!force && duplicateCache[currentTicketId]) { renderDuplicates(); return; }

    const terms = collectDuplicateTerms();
    if (!terms.length) {
      host.innerHTML = `<div style="color:${THEME.subtle};font-size:11px;">Nothing to search on yet.</div>`;
      return;
    }

    host.innerHTML = `<div style="color:${THEME.subtle};font-size:11px;">⏳ Searching ${terms.length} reference${terms.length === 1 ? '' : 's'}…</div>`;

    const searches = terms.map((t) =>
      zdSearchTickets(t.value).then((rs) => rs.map((row) => normalizeSearchRow(row, t.label, t.value)))
    );
    const dbLookup = currentBookingId
      ? api.bookingTickets(currentBookingId, currentTicketId)
          .then((r) => (r.ok ? (r.data.tickets || []).map(normalizeDbRow) : []))
          .catch(() => [])
      : Promise.resolve([]);

    const groups = await Promise.all([dbLookup, ...searches]);
    const merged = await enrichLinkedRows(mergeDuplicates(groups));
    duplicateCache[currentTicketId] = merged;
    renderDuplicates();
  }

  async function runManualDuplicateSearch(term) {
    const rows = await zdSearchTickets(term, { verify: false });
    const existing = duplicateCache[currentTicketId] || [];
    duplicateCache[currentTicketId] = mergeDuplicates([
      existing,
      rows.map((t) => normalizeSearchRow(t, 'manual search', term)),
    ]);
    renderDuplicates();
  }

  function renderDuplicates() {
    const host = document.getElementById('taDuplicates');
    if (!host) return;
    const all = duplicateCache[currentTicketId] || [];
    // Closed tickets are in Zoho's results by default and statusType cannot be
    // filtered server-side, so the toggle is applied here.
    const rows = dupIncludeClosed ? all : all.filter((r) => r.statusType !== 'Closed');

    const statusChip = (r) => {
      if (!r.status) return '';
      const closed = r.statusType === 'Closed';
      const c = closed ? { bg: '#f1f3f5', fg: '#6c757d' }
              : r.status === 'Open' ? { bg: '#e8f4ff', fg: '#0056d2' }
              : { bg: '#fff3cd', fg: '#856404' };
      return `<span style="background:${c.bg};color:${c.fg};font-size:9px;font-weight:600;padding:1px 6px;border-radius:7px;white-space:nowrap;">${escapeHtml(r.status)}</span>`;
    };

    const priorityChip = (r) => {
      if (!r.priority) return '';
      const c = { Low: { bg: '#f1f3f5', fg: '#6c757d' }, Medium: { bg: '#e8f4ff', fg: '#0056d2' },
                  High: { bg: '#ffe8d6', fg: '#b35200' }, Urgent: { bg: '#fde2e2', fg: '#c82333' } }[r.priority];
      if (!c) return '';
      return `<span title="Priority" style="background:${c.bg};color:${c.fg};font-size:9px;font-weight:600;padding:1px 6px;border-radius:7px;white-space:nowrap;">${escapeHtml(r.priority)}</span>`;
    };

    // Show the matched VALUE, not the label — this is what the Freshdesk strip
    // did, and it is what tells an agent why a ticket surfaced.
    const matchChip = (r) => {
      const values = r.matchedBy.map((m) => m.value).filter(Boolean);
      if (!values.length) return '';
      const title = r.matchedBy.map((m) => `${m.label}: ${m.value}`).join(' · ');
      return `<span title="${escapeHtml(title)}" style="background:#fff3cd;color:#856404;font-size:9px;font-weight:600;padding:2px 6px;border-radius:7px;display:inline-block;margin-top:3px;word-break:break-all;">🔗 ${escapeHtml(values.join(' · '))}</span>`;
    };

    const items = rows.map((r) => {
      const label = r.ticketNumber ? '#' + escapeHtml(r.ticketNumber) : escapeHtml(r.id);
      const subj = r.subject ? escapeHtml(String(r.subject).slice(0, 70)) : '';
      const closed = r.statusType === 'Closed';
      const who = r.assignee ? `<span style="color:${THEME.primary};font-size:9px;font-weight:500;" title="Assigned to">${escapeHtml(r.assignee)}</span>` : '';
      return `<div style="padding:6px 7px;border:1px solid ${THEME.border};border-radius:4px;margin-bottom:5px;color:${THEME.text};background:${closed ? '#fafafa' : '#fff'};">
        <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
          <a href="${ticketUrl(r.id)}" style="font-size:11px;color:#007bff;font-weight:700;text-decoration:none;">${label}</a>
          <button data-tacopy="${escapeHtml(r.id)}" title="Copy link to this ticket" style="flex:0 0 auto;padding:0 4px;height:18px;line-height:1;border:1px solid rgba(128,128,128,0.4);border-radius:3px;background:transparent;color:inherit;font-size:10px;cursor:pointer;">🔗</button>${statusChip(r)}${priorityChip(r)}${who}
        </div>
        <div style="color:#666;font-size:10px;margin:2px 0 0;">${subj}</div>
        <div>${matchChip(r)}</div>
        <div style="display:flex;gap:4px;margin-top:5px;">
          <button data-taact="in" data-taid="${escapeHtml(r.id)}" style="padding:2px 7px;border:1px solid #fd7e14;border-radius:4px;background:#fff;color:#fd7e14;font-size:10px;cursor:pointer;font-weight:600;">📥 Merge in</button>
          <button data-taact="out" data-taid="${escapeHtml(r.id)}" style="padding:2px 7px;border:1px solid #6c757d;border-radius:4px;background:#fff;color:#6c757d;font-size:10px;cursor:pointer;font-weight:600;">📤 Merge out</button>
        </div>
      </div>`;
    }).join('');

    const hiddenCount = all.length - rows.length;
    const searched = (collectDuplicateTerms() || []).map((t) => t.label).join(', ');

    host.innerHTML = `
      <div style="font-weight:600;font-size:11px;color:${rows.length ? '#b8860b' : THEME.muted};margin-bottom:6px;">
        ${rows.length ? '⚠ ' + rows.length + ' possible duplicate' + (rows.length === 1 ? '' : 's') : 'No duplicates found'}
      </div>
      ${searched ? `<div style="color:${THEME.subtle};font-size:9px;margin-bottom:7px;">searched: ${escapeHtml(searched)}</div>` : ''}
      ${items}
      <label style="display:flex;align-items:center;gap:5px;color:${THEME.subtle};font-size:10px;margin-top:4px;cursor:pointer;">
        <input type="checkbox" id="taDupClosed" ${dupIncludeClosed ? 'checked' : ''} style="margin:0;" />
        incl. closed${hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ''}
      </label>
      <div style="display:flex;gap:5px;margin-top:6px;">
        <input id="taDupQuery" type="text" placeholder="Search tickets…" style="flex:1;min-width:0;padding:5px 8px;border:1px solid #ddd;border-radius:4px;font-size:11px;" />
        <button id="taDupGo" style="flex:0 0 auto;padding:5px 9px;border:1px solid #d3d8de;border-radius:4px;background:#fff;cursor:pointer;font-size:11px;">🔍</button>
      </div>`;

    host.querySelectorAll('[data-tacopy]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = location.origin + ticketUrl(btn.dataset.tacopy);
        const ok = await copyText(url);
        if (ok) {
          const prev = btn.textContent;
          btn.textContent = '✓';
          setTimeout(() => { btn.textContent = prev; }, 1200);
        } else {
          showToast('Could not copy — the link is ' + url, 'warning', 6000);
        }
      };
    });

    host.querySelectorAll('[data-taact]').forEach((btn) => {
      btn.onclick = () => {
        const row = (duplicateCache[currentTicketId] || []).find((x) => String(x.id) === btn.dataset.taid);
        if (!row) return;
        if (btn.dataset.taact === 'in') showMergeInModal(row, btn);
        else showMergeOutModal(row, btn);
      };
    });

    document.getElementById('taDupClosed').onchange = (e) => {
      dupIncludeClosed = e.target.checked;
      renderDuplicates();
    };
    const q = document.getElementById('taDupQuery');
    const go = document.getElementById('taDupGo');
    const run = () => {
      const term = q.value.trim();
      if (term) withButtonLoading(go, '⏳', () => runManualDuplicateSearch(term));
    };
    go.onclick = run;
    q.onkeydown = (e) => { if (e.key === 'Enter') run(); };
  }

  // ===== WRITE BACK TO ZOHO =====
  // Once the TA member is known, Zoho's own record is often the stale one —
  // shouty imported names, and on migrated tickets a Freshdesk routing address
  // that sends replies nowhere useful.

  // TA stores names in caps ("TATIANA"). Title-case them, respecting the
  // separators that appear in real names.
  function titleCaseName(value) {
    return String(value || '').trim().toLowerCase()
      .replace(/(^|[\s'\u2019\-])([a-z\u00e0-\u00ff])/g, (m, sep, ch) => sep + ch.toUpperCase());
  }

  function splitMemberName(user) {
    let first = user.firstName || null;
    let last = user.lastName || null;
    if (!first && !last) {
      const parts = String(user.fullName || user.name || '').trim().split(/\s+/).filter(Boolean);
      if (parts.length) { first = parts[0]; last = parts.slice(1).join(' ') || null; }
    }
    return { first: first ? titleCaseName(first) : null, last: last ? titleCaseName(last) : null };
  }

  // Only write back when the member was identified on strong evidence. A
  // name-only fallback match is precisely the case that could hand a ticket to
  // the wrong contact and redirect a customer's replies to a stranger.
  function mayAutoSync() {
    return panelUserSource === 'booking' || panelUserSource === 'email' || panelUserSource === 'manual';
  }

  // The ticket's contact is often wrong rather than merely untidy: mail relayed
  // through a shared mailbox attaches every such ticket to one placeholder
  // contact, so replies and history land on the wrong record. Once TA identifies
  // the real member we point the ticket at that person's contact, creating it if
  // Zoho has never seen them.
  //
  // Contact NAMES are deliberately never written. They are cosmetic and may have
  // been curated by a human.
  async function findOrCreateContact(user, email) {
    const found = await zdGet(`/contacts/search?email=${encodeURIComponent(email)}`);
    const hit = ((found && found.data) || [])[0];
    if (hit && hit.id) return { id: hit.id, created: false };

    // lastName is the only mandatory field on creation.
    const { first, last } = splitMemberName(user);
    const created = await zdPost('/contacts', {
      lastName: last || first || email,
      firstName: first || undefined,
      email,
    });
    if (!created || !created.id) throw new Error('contact creation returned no id');
    return { id: created.id, created: true };
  }

  async function syncTicketContact(user, silent) {
    const meta = currentTicketMeta || {};
    const memberEmail = usableEmail(user && user.email);
    if (!memberEmail) {
      if (!silent) showToast('This TA member has no usable email address.', 'warning');
      return [];
    }

    const changed = [];
    try {
      const { id: contactId, created } = await findOrCreateContact(user, memberEmail);
      const patch = {};
      if (contactId && String(contactId) !== String(meta.contactId)) patch.contactId = contactId;
      if (memberEmail.toLowerCase() !== String(meta.ticketEmail || '').toLowerCase()) patch.email = memberEmail;

      if (!Object.keys(patch).length) {
        if (!silent) showToast('Ticket already points at this member.', 'info');
        return changed;
      }

      await zdPatch(`/tickets/${currentTicketId}`, patch);
      if (patch.contactId) {
        meta.contactId = patch.contactId;
        changed.push(created ? 'contact created + linked' : 'contact → the member');
      }
      if (patch.email) { meta.ticketEmail = patch.email; changed.push('reply-to → ' + patch.email); }

      showToast('Ticket updated: ' + changed.join(' · ') + ' (reload to see it in Desk)', 'success');
      return changed;
    } catch (err) {
      showToast('Could not update the ticket contact: ' + err.message, 'error');
      console.error('[ta] contact reassign failed:', err);
      return changed;
    }
  }

  // Automatic only when the ticket is sitting on a placeholder contact — that is
  // the broken state worth repairing without being asked. Anything else is a
  // judgement call and waits for the button.
  let syncedForTicket = null;
  function maybeSyncMember(user) {
    if (!user || !mayAutoSync()) return;
    if (syncedForTicket === currentTicketId) return;
    const meta = currentTicketMeta || {};
    if (!isPlaceholderEmail(meta.contactEmailRaw)) return;
    syncedForTicket = currentTicketId;
    syncTicketContact(user, true);
  }

  // ===== ACTIONS =====
  // Posted through the agent's own session, so Desk attributes the note to
  // whoever clicked — the reason this is an overlay and not the OAuth widget.
  async function onPostNote(e) {
    const btn = e.currentTarget;
    const bd = ticketBookingCache[currentTicketId];
    if (!bd || !bd.noteHtml) { showToast('No note to post.', 'error'); return; }
    await withButtonLoading(btn, 'Posting…', async () => {
      try {
        await postComment(currentTicketId, bd.noteHtml);
        showToast('Note posted.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
        console.error('[ta] post note failed:', err);
      }
    });
  }

  async function onPostMemberNote(btn, user) {
    const v = (val) => escapeHtml(val || '');
    const fields = [
      ['Name', user.fullName || user.name], ['Email', user.email], ['Phone', user.phone],
      ['Instance', user.instance], ['Status', user.status], ['Country', user.country],
      ['Language', user.language],
    ].filter(([, val]) => val);
    const lines = fields.map(([l, val]) => `<div><strong>${l}:</strong> ${v(val)}</div>`).join('');
    const loginLine = user.loginLink ? `<div><strong>Login:</strong> <a href="${user.loginLink}" target="_blank">Login as User</a></div>` : '';
    const profileLine = user.profileLink ? `<div><strong>Profile:</strong> <a href="${user.profileLink}" target="_blank">Open Full Profile</a></div>` : '';
    const noteHtml = `<div style="font-family:system-ui,sans-serif;font-size:13px;line-height:1.8;"><h4 style="margin:0 0 8px;font-size:14px;">👤 Member Details</h4>${lines}${loginLine}${profileLine}</div>`;
    await withButtonLoading(btn, '⏳', async () => {
      try {
        await postComment(currentTicketId, noteHtml);
        showToast('Member note posted.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  function onViewNote() {
    const bd = ticketBookingCache[currentTicketId];
    if (!bd || !bd.noteHtml) { showToast('No note to show.', 'error'); return; }
    const { body } = createModal('taNoteModal', 'Booking Note', {
      style: 'top:50%;left:50%;transform:translate(-50%,-50%);width:640px;max-height:80vh;',
    });
    body.innerHTML = bd.noteHtml;
  }

  // ===== CHAT TRANSLATION =====
  // Zoho stores an online-chat ticket as a single ONLINE_CHAT thread whose HTML
  // holds the transcript followed by a "Visitor's Info" metadata table (chat
  // duration, brand, waiting time). The metadata is ~90% of the content and must
  // not be translated or posted.
  //
  // Lines already arrive one per speaker / timestamp / message, so translating
  // line by line preserves attribution and ordering for free. That is what the
  // Freshdesk LLM prompt spent most of its rules defending; Google cannot
  // reorder or invent lines, so the rules become unnecessary.
  const CHAT_METADATA_MARKER = /^visitor'?s info\b/i;
  const CHAT_CHUNK_CHARS = 1200;   // Google's endpoint is a GET; keep q short

  function isTimestampLine(t) {
    return /^\d{1,2}:\d{2}\s?(am|pm)?$/i.test(t)
      || /^\d{1,2}\s\w{3},?\s+\d{1,2}:\d{2}/i.test(t)
      || /^\d{1,2}\s\w{3}\s\d{4}/i.test(t);
  }

  // Flattens the transcript HTML to ordered logical lines, stopping at the
  // metadata table.
  function extractChatLines(html) {
    const host = document.createElement('div');
    host.innerHTML = html || '';
    const parts = [];
    const walk = (node) => {
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) {
          const t = n.textContent.replace(/\s+/g, ' ').trim();
          if (t) parts.push(t);
        } else if (n.nodeType === 1) {
          walk(n);
          if (['div', 'tr', 'p', 'br', 'td', 'li'].includes(n.tagName.toLowerCase())) parts.push('\u0000');
        }
      });
    };
    walk(host);

    let lines = parts.join(' ').split('\u0000')
      .map((x) => x.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const cut = lines.findIndex((l) => CHAT_METADATA_MARKER.test(l));
    const trimmed = cut !== -1;
    if (trimmed) lines = lines.slice(0, cut);
    return { lines, trimmedMetadata: trimmed };
  }

  // Translates only the lines that carry language. Timestamps pass through
  // untouched — Google would happily reformat them.
  async function translateChatLines(lines) {
    const idx = [];
    lines.forEach((l, i) => { if (!isTimestampLine(l)) idx.push(i); });
    if (!idx.length) return { out: lines.slice(), translated: 0, failed: 0, provider: null };

    const out = lines.slice();
    let batch = [];
    let batchIdx = [];
    let translated = 0;
    let failed = 0;
    let provider = null;

    const flush = async () => {
      if (!batch.length) return;
      const res = await api.translate(batch.join('\n'), 'en');
      const back = (res.ok && res.data && res.data.text) ? String(res.data.text).split('\n') : null;
      if (res.ok && res.data && res.data.provider) provider = res.data.provider;

      // Google routinely 429s from Render's shared egress IP, so the Groq
      // fallback usually answers — and an LLM does not reliably preserve line
      // counts. Only trust a batch whose count survived; otherwise translate one
      // line at a time so a merge can never reattribute text to another speaker.
      if (back && back.length === batch.length) {
        batchIdx.forEach((target, k) => {
          const t = back[k].trim();
          if (t) { out[target] = t; translated++; } else { failed++; }
        });
      } else {
        for (let k = 0; k < batch.length; k++) {
          const one = await api.translate(batch[k], 'en');
          if (one.ok && one.data && one.data.text) {
            out[batchIdx[k]] = String(one.data.text).trim();
            translated++;
            if (one.data.provider) provider = one.data.provider;
          } else {
            failed++;   // leave the original in place, but say so
          }
        }
      }
      batch = [];
      batchIdx = [];
    };

    for (const i of idx) {
      if (batch.join('\n').length + lines[i].length > CHAT_CHUNK_CHARS) await flush();
      batch.push(lines[i]);
      batchIdx.push(i);
    }
    await flush();
    return { out, translated, failed, provider };
  }

  // ===== PER-CONVERSATION TRANSLATE =====
  // Injected next to Desk's own per-message icon button, on every entry in the
  // conversation list — the Zoho counterpart of the Freshdesk script's
  // injectConversationControls.
  //
  // Anchored on the semantic class suffixes, never the build hashes. The action
  // holder Desk uses is -subtablistitemwebcommon-visibleOnHover, so the button is
  // placed as a flex sibling in the -commentlistitemcommon-contentWrapper instead:
  // same position, but visible without hovering.
  const CONV_BLOCK_SEL = '[class*="-conversationlist-listContainer"]';
  const CONV_ICON_SEL  = '[class*="-iconbutton-icon_button_center"]';
  const CONV_BODY_SEL  = '[class*="-richtextcontent-"]';
  const CONV_WRAP_SEL  = '[class*="-commentlistitemcommon-contentWrapper"]';

  function injectConversationTranslate() {
    document.querySelectorAll(CONV_BLOCK_SEL).forEach((block) => {
      if (block.querySelector('.ta-conv-translate')) return;
      const body = block.querySelector(CONV_BODY_SEL);
      if (!body || !(body.innerText || '').trim()) return;

      const icon = block.querySelector(CONV_ICON_SEL);
      const host = (icon && icon.closest(CONV_WRAP_SEL))
        || (icon && icon.closest('button') && icon.closest('button').parentElement);
      if (!host) return;

      const btn = document.createElement('button');
      btn.className = 'ta-conv-translate';
      btn.type = 'button';
      btn.textContent = '🌐';
      btn.title = 'Translate this message to English';
      btn.style.cssText = 'flex:0 0 auto;align-self:flex-start;margin-left:6px;width:26px;height:26px;line-height:1;padding:0;'
        + 'border:1px solid rgba(128,128,128,0.45);border-radius:5px;background:transparent;color:inherit;cursor:pointer;font-size:13px;';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleConversationTranslation(block, body, btn);
      });
      host.appendChild(btn);
    });
  }

  async function toggleConversationTranslation(block, body, btn) {
    const existing = block.querySelector('.ta-conv-translation');
    if (existing) {
      const hidden = existing.style.display === 'none';
      existing.style.display = hidden ? 'block' : 'none';
      btn.style.background = hidden ? 'rgba(111,66,193,0.18)' : 'transparent';
      return;
    }

    await withButtonLoading(btn, '⏳', async () => {
      // extractChatLines also trims a chat's "Visitor's Info" metadata table; on
      // an ordinary email or note there is no marker and it simply returns the
      // lines.
      const { lines, trimmedMetadata } = extractChatLines(body.innerHTML);
      if (!lines.length) { showToast('Nothing to translate in this message.', 'warning'); return; }

      const result = await translateChatLines(lines);
      const translated = result.out;
      if (!result.translated) {
        showToast('Translation failed — showing the original text.', 'error');
      } else if (result.failed) {
        showToast(`${result.failed} of ${result.translated + result.failed} lines could not be translated.`, 'warning');
      }
      const box = document.createElement('div');
      box.className = 'ta-conv-translation';
      // Theme-agnostic on purpose. Zoho ships light and dark themes and this box
      // sits inside their message body, so it inherits their text colour and
      // tints the background translucently rather than hardcoding a palette —
      // a fixed light background inherited white text and became unreadable.
      box.style.cssText = `margin-top:8px;padding:8px 10px;border-left:3px solid ${THEME.primary};`
        + `background:rgba(111,66,193,0.12);border-radius:4px;font-size:13px;line-height:1.55;color:inherit;`;
      box.innerHTML =
        `<div style="font-size:10px;opacity:.65;margin-bottom:5px;text-transform:uppercase;letter-spacing:.04em;">🌐 Translated${result.provider ? ' · ' + escapeHtml(result.provider) : ''}${result.failed ? ` · ${result.failed} line(s) untranslated` : ''}${trimmedMetadata ? ' · visitor-info trimmed' : ''}</div>`
        + translated.map((l, i) => (isTimestampLine(lines[i])
            ? `<div style="opacity:.6;font-size:11px;margin-top:5px;">${escapeHtml(l)}</div>`
            : `<div>${escapeHtml(l)}</div>`)).join('')
        + `<div style="margin-top:7px;"><button class="ta-conv-post" style="padding:3px 9px;border:1px solid ${THEME.success};border-radius:4px;background:transparent;color:${THEME.success};font-size:11px;font-weight:600;cursor:pointer;">📋 Post as note</button></div>`;

      body.insertAdjacentElement('afterend', box);
      btn.style.background = 'rgba(111,66,193,0.18)';

      box.querySelector('.ta-conv-post').addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const lineHtml = translated.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
        await withButtonLoading(ev.currentTarget, '⏳', async () => {
          try {
            await postComment(currentTicketId, `<div style="font-family:system-ui,sans-serif;font-size:13px;line-height:1.6;"><h4 style="margin:0 0 8px;">🌐 Translated message</h4>${lineHtml}</div>`);
            showToast('Translation posted as a note.', 'success');
          } catch (err) {
            showToast('Failed to post: ' + err.message, 'error');
          }
        });
      });
    });
  }

  // ===== MERGE =====
  // Freshdesk had no native merge either — /merge-ticket posted a note on the
  // surviving ticket carrying the chosen message, posted a pointer note on the
  // other, and closed it. Reproducing that shape means merge needs no
  // undocumented Zoho endpoint: it is comments plus a status update, both
  // same-origin and both attributed to the acting agent.

  const MSG_FETCH_MAX = 15;   // thread bodies pulled per ticket
  const SUPPLIER_PLACEHOLDER = '[your message here]';

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  // Zoho splits a conversation across two collections: threads (email in/out)
  // and comments (internal notes). Freshdesk returned both in one list, so they
  // are merged chronologically here to give the modals the same shape.
  async function fetchTicketMessages(ticketId) {
    const ticket = await zdGet(`/tickets/${ticketId}`);
    const [threadList, commentList] = await Promise.all([
      zdGet(`/tickets/${ticketId}/threads?limit=20`).then((r) => (r && r.data) || []).catch(() => []),
      zdGet(`/tickets/${ticketId}/comments?limit=20`).then((r) => (r && r.data) || []).catch(() => []),
    ]);

    // The list carries only a truncated summary; real bodies need the detail call.
    const details = await Promise.all(
      threadList.slice(0, MSG_FETCH_MAX).map((t) =>
        zdGet(`/tickets/${ticketId}/threads/${t.id}`).catch(() => null)
      )
    );

    const messages = [];
    details.forEach((d, i) => {
      const t = d || threadList[i];
      if (!t) return;
      const incoming = t.direction === 'in';
      const author = (t.author && (t.author.name || t.author.email)) || t.fromEmailAddress || null;
      messages.push({
        label: incoming ? '📩 Customer' : '📤 Agent reply',
        bg: incoming ? '#f8f9fa' : '#f0f4ff',
        border: incoming ? '#6c757d' : '#0056d2',
        html: d ? (d.content || d.summary || '') : (t.summary || ''),
        author,
        date: t.createdTime,
      });
    });
    commentList.forEach((c) => {
      messages.push({
        label: c.isPublic ? '💬 Public comment' : '📌 Agent note',
        bg: '#fffbf0',
        border: '#fd7e14',
        html: c.content || '',
        author: (c.commenter && (c.commenter.name || c.commenter.email)) || null,
        date: c.commentedTime || c.createdTime,
      });
    });

    messages.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    return { ticket, messages };
  }

  // Posts the carried message onto the survivor, leaves a pointer on the other,
  // then closes it. The close is last and reported separately: if it fails the
  // content has still been preserved, which is the part that cannot be redone.
  async function mergeTickets({ sourceId, sourceNumber, targetId, targetNumber, html }) {
    const sourceLink = location.origin + ticketUrl(sourceId);
    const targetLink = location.origin + ticketUrl(targetId);

    await postComment(targetId, `<p>Merged from <a href="${sourceLink}">#${sourceNumber || sourceId}</a></p>${html}`);

    try {
      await postComment(sourceId, `<p>Merged into <a href="${targetLink}">#${targetNumber || targetId}</a></p>`);
    } catch (err) {
      console.warn('[ta] pointer note on source failed:', err.message);
    }

    await zdPatch(`/tickets/${sourceId}`, { status: 'Closed' });
  }

  function buildMessageList(container, messages, actionLabel, onPick) {
    if (!messages.length) {
      container.innerHTML = `<span style="color:${THEME.subtle};">(no content)</span>`;
      return;
    }
    messages.forEach((m) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = `margin-bottom:10px;padding:8px 10px;background:${m.bg};border-left:3px solid ${m.border};border-radius:3px;font-size:12px;line-height:1.5;`;
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;gap:6px;flex-wrap:wrap;';
      const meta = document.createElement('div');
      meta.innerHTML = `<span style="font-size:10px;color:#999;font-weight:600;">${escapeHtml(m.label)}</span>`
        + ((m.author || m.date)
          ? `<div style="font-size:10px;color:#aaa;margin-top:1px;">${escapeHtml([m.author, fmtDate(m.date)].filter(Boolean).join(' · '))}</div>`
          : '');
      const btn = document.createElement('button');
      btn.textContent = actionLabel;
      btn.style.cssText = 'padding:2px 8px;border:1px solid #fd7e14;border-radius:4px;background:#fff;color:#fd7e14;font-size:10px;cursor:pointer;font-weight:600;flex-shrink:0;';
      btn.onclick = (e) => { e.stopPropagation(); onPick(m.html, btn); };
      head.appendChild(meta);
      head.appendChild(btn);
      const content = document.createElement('div');
      content.innerHTML = m.html;
      wrap.appendChild(head);
      wrap.appendChild(content);
      container.appendChild(wrap);
    });
  }

  // Merge IN: read the duplicate's messages, pick one, bring it into this ticket
  // and close the duplicate.
  async function showMergeInModal(dup, triggerBtn) {
    let data;
    try {
      data = await withButtonLoading(triggerBtn, '⏳', () => fetchTicketMessages(dup.id));
    } catch (err) {
      showToast('Could not load ticket: ' + err.message, 'error');
      return;
    }
    const num = dup.ticketNumber || dup.id;
    const { body } = createModal('taMergeIn', `#${num} — ${data.ticket.subject || ''}`, {
      style: 'top:8%;left:50%;transform:translateX(-50%);width:680px;max-width:92vw;height:78vh;',
      zIndex: 1000001,
    });
    const hint = document.createElement('div');
    hint.style.cssText = `font-size:11px;color:${THEME.subtle};margin-bottom:10px;`;
    hint.textContent = `Pick a message to merge into #${(currentTicketMeta && currentTicketMeta.ticketNumber) || currentTicketId} — #${num} will be closed.`;
    body.appendChild(hint);
    const list = document.createElement('div');
    body.appendChild(list);

    buildMessageList(list, data.messages, '📥 Merge in', async (html, btn) => {
      if (!window.confirm(`Bring this message into #${(currentTicketMeta && currentTicketMeta.ticketNumber) || currentTicketId} and close #${num}?`)) return;
      await withButtonLoading(btn, '⏳ Merging…', async () => {
        try {
          await mergeTickets({
            sourceId: dup.id,
            sourceNumber: dup.ticketNumber,
            targetId: currentTicketId,
            targetNumber: currentTicketMeta && currentTicketMeta.ticketNumber,
            html,
          });
          document.getElementById('taMergeIn').remove();
          showToast(`Merged from #${num} — it has been closed.`, 'success');
          loadDuplicates(true);
        } catch (err) {
          showToast('Merge failed: ' + err.message, 'error');
        }
      });
    });
  }

  // Merge OUT: pick a message from THIS ticket, push it to the duplicate, and
  // close this one. The chosen text is editable before sending.
  async function showMergeOutModal(dup, triggerBtn) {
    let data;
    try {
      data = await withButtonLoading(triggerBtn, '⏳', () => fetchTicketMessages(currentTicketId));
    } catch (err) {
      showToast('Could not load this ticket: ' + err.message, 'error');
      return;
    }
    const num = dup.ticketNumber || dup.id;
    const mine = (currentTicketMeta && currentTicketMeta.ticketNumber) || currentTicketId;
    const { body } = createModal('taMergeOut', `Merge #${mine} → #${num}`, {
      style: 'top:50%;left:50%;transform:translate(-50%,-50%);width:680px;max-width:92vw;max-height:84vh;',
      zIndex: 1000001,
    });

    const hint = document.createElement('div');
    hint.style.cssText = `font-size:11px;color:${THEME.subtle};margin-bottom:10px;`;
    hint.textContent = 'Select a message, edit if needed, then confirm.';
    body.appendChild(hint);
    const list = document.createElement('div');
    body.appendChild(list);

    const editorWrap = document.createElement('div');
    editorWrap.style.cssText = 'position:sticky;bottom:0;background:#fffbf0;border-top:2px solid #fd7e14;margin:10px -16px -16px;padding:10px 16px;';
    editorWrap.innerHTML = `<div style="font-size:11px;color:${THEME.muted};margin-bottom:4px;font-weight:600;">Note to post on #${escapeHtml(String(num))}:</div>`;
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.style.cssText = 'min-height:60px;max-height:150px;overflow-y:auto;border:1px solid #ddd;border-radius:4px;padding:6px 8px;font-size:12px;background:#fff;outline:none;';
    editor.innerHTML = `<span style="color:#aaa;font-style:italic;">Select a message above…</span>`;
    let picked = false;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;margin-top:6px;';
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = `📤 Merge out → #${num}`;
    confirmBtn.style.cssText = 'padding:5px 12px;border:none;border-radius:4px;background:#6c757d;color:#fff;font-size:11px;cursor:pointer;font-weight:600;';
    actions.appendChild(confirmBtn);
    editorWrap.appendChild(editor);
    editorWrap.appendChild(actions);
    body.appendChild(editorWrap);

    buildMessageList(list, data.messages, '✏️ Use this', (html) => {
      editor.innerHTML = html;
      picked = true;
      editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    confirmBtn.onclick = async () => {
      if (!picked) { showToast('Select a message first.', 'error'); return; }
      if (!window.confirm(`Merge #${mine} into #${num}? This posts a note on #${num} and closes #${mine}.`)) return;
      await withButtonLoading(confirmBtn, '⏳ Merging…', async () => {
        try {
          await mergeTickets({
            sourceId: currentTicketId,
            sourceNumber: currentTicketMeta && currentTicketMeta.ticketNumber,
            targetId: dup.id,
            targetNumber: dup.ticketNumber,
            html: editor.innerHTML,
          });
          document.getElementById('taMergeOut').remove();
          showToast(`Merged #${mine} into #${num} — this ticket is closed.`, 'success');
          loadDuplicates(true);
        } catch (err) {
          showToast('Merge failed: ' + err.message, 'error');
        }
      });
    };
  }

  // ===== SUPPLIER (HOTEL) EMAIL =====
  // Entirely client-side: the recipient comes from bookingData.supplier (the
  // backend's SUPPLIER_MAP, already on the booking payload) and the body is
  // built here. The agent confirms/edits, then the send goes through Desk's own
  // sendReply from their session, so the mail is attributed to them.

  function getAgentName() {
    return GM_getValue('ta_agent_name', '');
  }

  // The email signs itself with a name. Desk exposes no reliable "current agent"
  // endpoint (/agents/me is a 404), so the agent states their name once and it is
  // stored locally. Without this every agent would sign as whoever the builder's
  // default names.
  function promptForAgentName(force) {
    const existing = getAgentName();
    if (existing && !force) return existing;
    const entered = window.prompt(
      'Your name for outgoing supplier emails\n\n' +
      'Used in the greeting and signature, e.g. "Maria S."',
      existing || ''
    );
    if (entered && entered.trim()) {
      GM_setValue('ta_agent_name', entered.trim());
      return entered.trim();
    }
    return existing;
  }

  // sendReply requires a fromEmailAddress, and Zoho only accepts an address that
  // is configured, active AND verified for the ticket's department. An earlier
  // version read it off the ticket's threads and fell back to "any thread with a
  // from address" — on a ticket whose only thread is inbound that resolved to the
  // CUSTOMER's address, which Zoho rejected as INVALID_DATA. It would have been
  // worse if it had succeeded.
  async function fetchFromAddresses(departmentId) {
    if (!departmentId) return [];
    if (fromAddressCache[departmentId]) return fromAddressCache[departmentId];
    const res = await zdGet(`/mailReplyAddress?departmentId=${encodeURIComponent(departmentId)}`);
    const rows = ((res && res.data) || [])
      .filter((r) => r.isActive && r.isVerified && r.address)
      .map((r) => ({
        address: r.address,
        displayName: r.displayName || '',
        isDefault: !!r.isDepartmentDefault,
      }));
    fromAddressCache[departmentId] = rows;
    return rows;
  }

  // Preference order: whatever this ticket has already replied from, then the
  // department default, then the first active+verified address.
  async function pickFromAddress(ticketId, departmentId) {
    const options = await fetchFromAddresses(departmentId);
    if (!options.length) return { options: [], chosen: null };

    let priorAddress = null;
    try {
      const threads = await zdGet(`/tickets/${ticketId}/threads?limit=10`);
      const out = ((threads && threads.data) || []).filter((t) => t.direction === 'out' && t.fromEmailAddress);
      if (out.length) priorAddress = String(out[0].fromEmailAddress);
    } catch (e) { /* optional signal */ }

    const matchesPrior = priorAddress
      ? options.find((o) => priorAddress.indexOf(o.address) !== -1)
      : null;
    const chosen = matchesPrior || options.find((o) => o.isDefault) || options[0];
    return { options, chosen };
  }

  // Body structure is a port of the Freshdesk composer's supplier template
  // (buildReplySignature with recipientType 'supplier'): greeting addressed to
  // the supplier team, opener, a reference block identifying the booking, then
  // a placeholder for the agent's actual message, then the support signature.
  function buildSupplierEmailHtml(booking, details, user, agentName) {
    const stripHtml = (x) => (x ? String(x).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
    const supplierName = booking && booking.supplierName
      ? stripHtml(booking.supplierName).replace(/\s*\(\d+\)\s*$/, '')
      : 'team';
    const hotelDisplay = (details && details.hotelName) || (booking && stripHtml(booking.supplierName)) || null;

    const ref = [
      booking && booking.supplierId ? 'This is in reference to ' + escapeHtml(booking.supplierId) : null,
      hotelDisplay ? escapeHtml(hotelDisplay) : null,
      booking && booking.guestName ? escapeHtml(booking.guestName) : null,
      (booking && booking.checkIn && booking.checkOut) ? escapeHtml(booking.checkIn + ' — ' + booking.checkOut) : null,
      booking && booking.mwrRoomType ? escapeHtml(booking.mwrRoomType) : null,
    ].filter(Boolean).join('<br>');

    const sig = [
      'Sincerely,', escapeHtml(agentName || 'Travel Advantage Support'), 'Travel Advantage Support',
      '--------------------------------', 'member@traveladvantage.com',
      'Belgium: +32 71-96-32-66', 'Colombia: +571 514-1218', 'France: +33 27-68-63-387',
      'Germany: +49 911 96 959 007', 'Italy: +39 02-94-755-846', 'Peru: +511 707-3968',
      'Portugal: +35 13-0880-2148', 'Spain: +34 95-156-81-76', 'USA: +1 857 763 2085',
      '<a href="https://www.traveladvantage.com/">https://www.traveladvantage.com/</a>',
    ].join('<br>');

    return `<p>Hello dear ${escapeHtml(supplierName)} team,</p>`
      + `<p>I hope this email finds you well.</p>`
      + (ref ? `<p>${ref}</p>` : '')
      + `<p>${SUPPLIER_PLACEHOLDER}</p>`
      + `<p>${sig}</p>`;
  }

  async function openSupplierEmail() {
    const bd = ticketBookingCache[currentTicketId];
    if (!bd || !bd.booking) { showToast('No booking loaded.', 'error'); return; }
    const agentName = promptForAgentName(false);
    if (!agentName) { showToast('A sender name is needed to send supplier email.', 'warning'); return; }
    let from = { options: [], chosen: null };
    try {
      from = await pickFromAddress(currentTicketId, currentTicketMeta && currentTicketMeta.departmentId);
    } catch (err) {
      console.warn('[ta] from-address lookup failed:', err.message);
    }
    if (!from.options.length) {
      showToast('No active, verified sender address for this department — cannot send.', 'error');
      return;
    }
    showSupplierEmailModal(bd, agentName, from);
  }

  function onSupplierEmail(e) {
    return withButtonLoading(e.currentTarget, '⏳', openSupplierEmail);
  }

  function showSupplierEmailModal(bd, agentName, from) {
    const { booking, details, user, supplier } = bd;
    const stripHtml = (x) => (x ? String(x).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
    const supplierName = stripHtml(booking.supplierName).replace(/\s*\(\d+\)\s*$/, '');
    const to = (supplier && supplier.email) || '';
    const contactUrl = supplier && supplier.contactUrl;
    const note = supplier && supplier.note;

    const { body } = createModal('taSupplierEmail', `✉ Email supplier — ${supplierName}`, {
      style: 'top:50%;left:50%;transform:translate(-50%,-50%);width:720px;max-width:94vw;max-height:86vh;',
    });

    // Several suppliers carry hard requirements here — mandatory CC addresses,
    // exact subject formats, separate emergency/post-travel inboxes. Showing it
    // as a prominent banner rather than a footnote is deliberate.
    const noteBanner = note
      ? `<div style="background:#fff3cd;border:1px solid #ffe08a;border-radius:5px;padding:8px 10px;font-size:12px;color:#856404;margin-bottom:10px;line-height:1.5;"><strong>⚠ ${escapeHtml(supplierName)}:</strong> ${escapeHtml(note)}</div>`
      : '';
    const urlLine = contactUrl
      ? `<div style="font-size:12px;color:${THEME.muted};margin-bottom:10px;">No email on file — contact via <a href="${escapeHtml(contactUrl)}" target="_blank" rel="noopener">${escapeHtml(contactUrl)}</a></div>`
      : '';
    const unknown = !supplier
      ? `<div style="background:#f8d7da;border:1px solid #f5c2c7;border-radius:5px;padding:8px 10px;font-size:12px;color:#721c24;margin-bottom:10px;">No entry in the supplier list for "<strong>${escapeHtml(supplierName)}</strong>". Enter the address manually.</div>`
      : '';

    body.innerHTML = `
      ${unknown}${noteBanner}${urlLine}
      <label style="display:block;font-size:11px;color:${THEME.muted};margin-bottom:3px;">From</label>
      <select id="taSupFrom" style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #d3d8de;border-radius:4px;font-size:13px;margin-bottom:10px;background:#fff;">
        ${from.options.map((o) => `<option value="${escapeHtml(o.address)}" ${o === from.chosen ? 'selected' : ''}>${escapeHtml(o.displayName)} &lt;${escapeHtml(o.address)}&gt;</option>`).join('')}
      </select>
      <label style="display:block;font-size:11px;color:${THEME.muted};margin-bottom:3px;">To</label>
      <input id="taSupTo" type="text" value="${escapeHtml(to)}" placeholder="supplier@example.com"
        style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid ${to ? '#d3d8de' : THEME.danger};border-radius:4px;font-size:13px;margin-bottom:10px;" />
      <label style="display:block;font-size:11px;color:${THEME.muted};margin-bottom:3px;">CC <span style="color:${THEME.subtle};">(check the note above — some suppliers require it)</span></label>
      <input id="taSupCc" type="text" value="" placeholder="optional"
        style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #d3d8de;border-radius:4px;font-size:13px;margin-bottom:10px;" />
      <div style="font-size:11px;color:${THEME.subtle};margin-bottom:10px;">Subject is set by Zoho from the ticket — sendReply rejects a custom one. Suppliers needing an exact subject format (goglobal, w2m, priceline) need the ticket subject renamed first.</div>
      <label style="display:block;font-size:11px;color:${THEME.muted};margin-bottom:3px;">
        Body — signing as ${escapeHtml(agentName)}
        <button id="taSupRename" style="background:none;border:none;color:${THEME.primary};font-size:11px;cursor:pointer;text-decoration:underline;">change</button>
      </label>
      <div id="taSupBody" contenteditable="true"
        style="border:1px solid #d3d8de;border-radius:4px;padding:10px;max-height:34vh;overflow-y:auto;font-size:13px;line-height:1.5;background:#fff;"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">
        <button id="taSupCancel" style="padding:8px 14px;border:1px solid #d3d8de;border-radius:5px;background:#fff;cursor:pointer;font-size:13px;">Cancel</button>
        <button id="taSupSend" style="padding:8px 18px;border:none;border-radius:5px;background:${THEME.success};color:#fff;font-weight:600;cursor:pointer;font-size:13px;">Send</button>
      </div>`;

    document.getElementById('taSupBody').innerHTML = buildSupplierEmailHtml(booking, details, user, agentName);

    document.getElementById('taSupCancel').onclick = () => document.getElementById('taSupplierEmail').remove();
    document.getElementById('taSupRename').onclick = (ev) => {
      ev.preventDefault();
      const name = promptForAgentName(true);
      if (name) {
        document.getElementById('taSupplierEmail').remove();
        showSupplierEmailModal(bd, name, from);
      }
    };

    const sendBtn = document.getElementById('taSupSend');
    sendBtn.onclick = async () => {
      const to = document.getElementById('taSupTo').value.trim();
      const cc = document.getElementById('taSupCc').value.trim();
      const content = document.getElementById('taSupBody').innerHTML;
      if (!to) { showToast('Enter a recipient address.', 'error'); return; }
      if (content.includes(SUPPLIER_PLACEHOLDER)) {
        showToast('Replace the "[your message here]" placeholder first.', 'error');
        return;
      }
      if (!window.confirm(`Send this email to ${to}${cc ? ' (cc ' + cc + ')' : ''}?`)) return;

      await withButtonLoading(sendBtn, 'Sending…', async () => {
        try {
          const fromEmailAddress = document.getElementById('taSupFrom').value;
          if (!fromEmailAddress) {
            showToast('Pick a From address.', 'error');
            return;
          }
          const payload = {
            content,
            contentType: 'html',
            channel: 'EMAIL',
            fromEmailAddress,
            to,
          };
          if (cc) payload.cc = cc;   // comma-separated string; an array is rejected
          await zdPost(`/tickets/${currentTicketId}/sendReply`, payload);
          showToast('Supplier email sent.', 'success');
          document.getElementById('taSupplierEmail').remove();
        } catch (err) {
          showToast('Send failed: ' + err.message, 'error');
          console.error('[ta] supplier email send failed:', err);
        }
      });
    };
  }

  // ===== LOAD =====
  let loadInFlight = null;

  async function loadTicket(ticketId) {
    // A load costs a ticket read, a Groq extraction, a booking lookup and four
    // duplicate searches. Never allow two to overlap, so a repair bug can cost at
    // most one redundant pass rather than an unbounded pile-up.
    if (loadInFlight === ticketId) return;
    loadInFlight = ticketId;
    try {
      await loadTicketInner(ticketId);
    } finally {
      if (loadInFlight === ticketId) loadInFlight = null;
    }
  }

  async function loadTicketInner(ticketId) {
    currentTicketId = ticketId;
    panelUserOverride = null;
    currentTicketMeta = null;
    currentBookingId = null;
    panelNotice = null;
    pendingMemberQuery = null;
    currentChatThreadId = null;
    panelUserSource = null;
    syncedForTicket = null;
    injectPanels();

    const cached = ticketBookingCache[ticketId];
    const haveBooking = cached !== undefined;   // null means "looked, found none"
    if (haveBooking) {
      currentBookingId = cached && cached.booking ? cached.booking.internalBookingId : null;
      renderBookingPanel();
    } else {
      renderPanelMessage(`<div style="color:${THEME.subtle};font-size:13px;">Reading ticket…</div>`);
    }

    // The ticket read serves both halves, so it happens before either. It needs
    // no backend key — it is a same-origin Desk call.
    let ctx = null;
    try {
      ctx = await fetchTicketContext(ticketId);
      currentTicketMeta = {
        ticketNumber: ctx.ticket.ticketNumber || null,
        subject: ctx.ticket.subject || null,
        status: ctx.ticket.status || null,
        email: ctx.email || null,             // contact's real address, not the channel's
        contactName: ctx.contactName || null,
        contactId: ctx.ticket.contactId || null,
        contactEmailRaw: ctx.contactEmailRaw || null,
        contactFirstName: ctx.contactFirstName || null,
        contactLastName: ctx.contactLastName || null,
        ticketEmail: ctx.ticket.email || null,
        departmentId: ctx.ticket.departmentId || null,
      };
    } catch (err) {
      console.error('[ta] ticket read failed:', err);
      if (!haveBooking) {
        panelNotice = { text: 'Could not read the ticket: ' + err.message };
        ticketBookingCache[ticketId] = null;
        renderBookingPanel();
      }
    }


    // Duplicates run on EVERY ticket, whether or not a booking is ever found and
    // whether or not a backend key is set: the search half is same-origin, and a
    // ticket with no booking reference is exactly where a repeat goes unnoticed.
    loadDuplicates(true);

    // Known from cache to have no booking: still identify the member from the
    // ticket contact, since the panel was rendered before the ticket was read.
    if (ctx && ticketBookingCache[ticketId] === null) {
      if (seedMemberLookupFromTicket()) renderBookingPanel();
    }

    if (haveBooking || !ctx) return;

    if (!getSecret()) {
      renderPanelMessage(`<div style="color:${THEME.subtle};font-size:13px;">No backend key set. Click ⚙ above to enter it.</div>`);
      return;
    }

    try {
      renderPanelMessage(`<div style="color:${THEME.subtle};font-size:13px;">Finding booking reference…</div>`);
      const ext = await api.extract({ subject: ctx.subject, description: ctx.description });
      if (!ext.ok) {
        ticketBookingCache[ticketId] = null;
        panelNotice = { text: 'Could not read a booking reference: ' + ((ext.data && ext.data.error) || 'extraction failed') };
        seedMemberLookupFromTicket();
        renderBookingPanel();
        return;
      }
      const bookingId = ext.data.bookingId;
      if (!bookingId) {
        ticketBookingCache[ticketId] = null;
        currentBookingId = null;
        seedMemberLookupFromTicket();
        renderBookingPanel();
        return;
      }

      renderPanelMessage(`<div style="color:${THEME.subtle};font-size:13px;">Loading booking ${escapeHtml(bookingId)}…</div>`);
      const res = await api.booking(bookingId);
      if (!res.ok || !res.data.success) {
        // The reference was read from the ticket but TA has no such booking —
        // a common, recoverable state (typo, supplier ref, cancelled record).
        ticketBookingCache[ticketId] = null;
        panelNotice = {
          text: `Reference "${bookingId}" was found in the ticket but no matching booking exists in TA.`,
          bookingId,
        };
        seedMemberLookupFromTicket();
        renderBookingPanel();
        return;
      }
      currentBookingId = bookingId;
      ticketBookingCache[ticketId] = res.data.bookingData;
      panelUserSource = 'booking';
      renderBookingPanel();
      // Re-runs the duplicate search now that booking ID and supplier ref are
      // available as additional terms.
      recordBookingLink(bookingId, 'auto');
      const bookingUser = res.data.bookingData && res.data.bookingData.user;
      if (bookingUser) maybeSyncMember(bookingUser);
    } catch (err) {
      console.error('[ta] load failed:', err);
      ticketBookingCache[ticketId] = null;
      panelNotice = { text: 'Booking lookup failed: ' + err.message };
      seedMemberLookupFromTicket();
      renderBookingPanel();
    }
  }

  // ===== SPA NAVIGATION =====
  // Desk is a single-page app: pushState replaces the ticket without a reload.
  function hookNavigation() {
    const fire = () => setTimeout(checkTicketChange, 150);
    const origPush = history.pushState;
    history.pushState = function () { const r = origPush.apply(this, arguments); fire(); return r; };
    const origReplace = history.replaceState;
    history.replaceState = function () { const r = origReplace.apply(this, arguments); fire(); return r; };
    window.addEventListener('popstate', fire);
    // Belt and braces: some Desk transitions do not go through history at all.
    setInterval(checkTicketChange, 1500);
  }

  function checkTicketChange() {
    const id = getZohoTicketId();
    if (!id) {
      // Remove the rail entirely. Removing only the booking card left a rail that
      // injectPanels considered present and would not repair.
      const rail = document.getElementById('taRail');
      if (rail) rail.remove();
      currentTicketId = null;
      return;
    }
    // Repair the rail every tick — injectPanels is a no-op when it is intact — and
    // gate the expensive reload purely on the ticket changing. Keying the reload
    // off a DOM element is what turned a missing card into a request loop.
    injectPanels();
    if (id === currentTicketId) return;
    loadTicket(id);
  }

  // ===== BOOT =====
  // The token observer must be installed at document-start, before Desk's own
  // bundle captures references to fetch/XHR — otherwise its writes bypass our
  // patch and the token is never seen. Everything else waits for a body to
  // attach the panel to.
  installTokenObserver();
  console.log('[ta] MWR Zoho Tools loaded');

  function start() {
    hookNavigation();
    checkTicketChange();
    // Desk re-renders the conversation list on SPA nav and lazy load, so the
    // per-message buttons have to be re-applied, as the Freshdesk mount loop did.
    setInterval(injectConversationTranslate, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
