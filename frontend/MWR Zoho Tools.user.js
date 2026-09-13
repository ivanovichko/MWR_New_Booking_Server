// ==UserScript==
// @name         MWR Zoho Tools
// @namespace    https://traveladvantage.com
// @version      0.1.0
// @description  TA booking tools for Zoho Desk — booking panel, notes, member lookup
// @match        https://desk.zoho.com/agent/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      mwr-new-booking-server.onrender.com
// @run-at       document-start
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
// Everything TA-side (booking parse, note HTML, member profile) is unchanged from
// the Freshdesk build — those backend routes were always helpdesk-agnostic.

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
  const fromAddressCache = {};    // ticketId -> fromEmailAddress for sendReply

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
      const du = window.desk_urls;
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

    const origFetch = window.fetch;
    window.fetch = function (input, init) {
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

  function getCsrfHeader() {
    return observedCsrfHeader;
  }

  async function zdRequest(path, opts = {}) {
    const method = opts.method || 'GET';
    const headers = { orgId: resolveOrgId() };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') {
      const token = getCsrfHeader();
      if (!token) {
        throw new Error(
          'Zoho Desk write token not seen yet — open or reload a ticket once, then retry.'
        );
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
      const msg = (json && (json.message || json.errorCode)) || `HTTP ${res.status}`;
      throw new Error(`Zoho Desk ${method} ${path} failed: ${msg}`);
    }
    return json;
  }

  const zdGet  = (path)       => zdRequest(path);
  const zdPost = (path, body) => zdRequest(path, { method: 'POST', body });

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

  const api = {
    extract:          (body)   => gmPost(`${BACKEND_URL}/zoho/extract`, body),
    booking:          (id)     => gmGet(`${BACKEND_URL}/guided-prewarm/booking/${encodeURIComponent(id)}`),
    findUser:         (query)  => gmPost(`${BACKEND_URL}/find-user`, { query }),
    userReservations: (userId) => gmGet(`${BACKEND_URL}/user/${encodeURIComponent(userId)}/reservations`),
    translate:        (text, target = 'en') => gmPost(`${BACKEND_URL}/translate`, { text, target }),
    hotelEmailLookup: (body)   => gmPost(`${BACKEND_URL}/zoho/hotel-email/lookup`, body),
    linkTicketBooking: (body)  => gmPost(`${BACKEND_URL}/zoho/ticket-booking`, body),
    bookingTickets:   (bookingId, exclude) =>
      gmGet(`${BACKEND_URL}/zoho/booking-tickets/${encodeURIComponent(bookingId)}` +
            (exclude ? `?exclude=${encodeURIComponent(exclude)}` : '')),
  };

  // ===== UI HELPERS (ported from the Freshdesk script — DOM-framework agnostic) =====
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
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
    let description = htmlToText(ticket.description);

    try {
      const threads = await zdGet(`/tickets/${ticketId}/threads?limit=10`);
      const list = (threads && threads.data) || [];
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

    return { subject: ticket.subject || '', description, ticket };
  }

  // ===== BOOKING PANEL =====
  function injectBookingPanel() {
    if (document.getElementById('taBookingPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'taBookingPanel';
    panel.style.cssText = `position:fixed;top:80px;right:18px;width:340px;max-height:calc(100vh - 110px);background:#fff;border-radius:${THEME.radius};box-shadow:${THEME.shadow};z-index:999998;font-family:${THEME.font};display:flex;flex-direction:column;`;

    const header = document.createElement('div');
    header.id = 'taBookingPanelHeader';
    header.style.cssText = `padding:10px 14px;border-bottom:1px solid ${THEME.border};display:flex;justify-content:space-between;align-items:center;flex-shrink:0;`;
    const title = document.createElement('span');
    title.id = 'taPanelTitle';
    title.style.cssText = `font-weight:600;font-size:13px;color:${THEME.primary};`;
    title.textContent = 'TA Booking';
    const controls = document.createElement('span');
    const gear = document.createElement('button');
    gear.textContent = '⚙';
    gear.title = 'Set backend key';
    gear.style.cssText = 'background:none;border:none;font-size:14px;color:#bbb;cursor:pointer;margin-right:4px;';
    gear.onclick = () => promptForSecret(true);
    const collapse = document.createElement('button');
    collapse.textContent = '–';
    collapse.style.cssText = 'background:none;border:none;font-size:16px;color:#aaa;cursor:pointer;';
    controls.appendChild(gear);
    controls.appendChild(collapse);
    header.appendChild(title);
    header.appendChild(controls);

    const body = document.createElement('div');
    body.id = 'taBookingPanelBody';
    body.style.cssText = 'flex:1;overflow-y:auto;padding:12px 14px;';
    body.innerHTML = `<div style="color:${THEME.subtle};font-size:13px;">Loading…</div>`;

    collapse.onclick = () => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? 'block' : 'none';
      collapse.textContent = hidden ? '–' : '+';
    };

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);
    makeDraggable(panel, header);
  }

  function panelBody() {
    return document.getElementById('taBookingPanelBody');
  }

  function renderPanelMessage(html) {
    const body = panelBody();
    if (body) body.innerHTML = html;
  }

  // TA's AI-reconfirmation status chip. Kept byte-identical to the Freshdesk and
  // widget versions so all three panels read the same.
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

  // Row-for-row mirror of the Freshdesk panel and TA_Zoho_beta/app/widget.js.
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
          ${isHotel ? `<button id="taSupplierEmailBtn" style="flex:1;padding:7px 6px;border:1px solid ${THEME.info};border-radius:5px;background:#fff;color:${THEME.info};font-size:12px;font-weight:600;cursor:pointer;">✉ Supplier</button>` : ''}
          <button id="taChangeBooking" style="flex:1;padding:7px 6px;border:1px solid #d3d8de;border-radius:5px;background:#fff;color:${THEME.text};font-size:12px;cursor:pointer;">Change</button>
        </div>
        <div id="taChangeRow" style="display:none;gap:6px;margin-top:8px;">
          <input id="taChangeInput" type="text" placeholder="Booking ID…" style="flex:1;min-width:0;padding:6px 9px;border:1px solid #d3d8de;border-radius:4px;font-size:13px;" />
          <button id="taChangeFetch" style="flex:0 0 auto;padding:6px 10px;border:1px solid #d3d8de;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;">Fetch</button>
        </div>
        ${openBookingHtml}
        <div id="taDuplicates"></div>
      `;
      document.getElementById('taPostNote').addEventListener('click', onPostNote);
      document.getElementById('taViewNote').addEventListener('click', onViewNote);
      const supBtn = document.getElementById('taSupplierEmailBtn');
      if (supBtn) supBtn.addEventListener('click', onSupplierEmail);
      wireChangeBooking();
      loadDuplicates();
    } else {
      body.innerHTML = `<div style="color:${THEME.subtle};font-size:13px;">No booking reference found in this ticket.</div>
        <div style="display:flex;gap:6px;margin-top:10px;">
          <button id="taChangeBooking" style="flex:1;padding:7px 6px;border:1px solid #d3d8de;border-radius:5px;background:#fff;color:${THEME.text};font-size:12px;cursor:pointer;">Enter booking ID</button>
        </div>
        <div id="taChangeRow" style="display:none;gap:6px;margin-top:8px;">
          <input id="taChangeInput" type="text" placeholder="Booking ID…" style="flex:1;min-width:0;padding:6px 9px;border:1px solid #d3d8de;border-radius:4px;font-size:13px;" />
          <button id="taChangeFetch" style="flex:0 0 auto;padding:6px 10px;border:1px solid #d3d8de;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;">Fetch</button>
        </div>`;
      wireChangeBooking();
    }

    appendMemberSection(body, getDisplayUser());
  }

  function wireChangeBooking() {
    const toggle = document.getElementById('taChangeBooking');
    const row = document.getElementById('taChangeRow');
    const input = document.getElementById('taChangeInput');
    const fetchBtn = document.getElementById('taChangeFetch');
    if (!toggle || !row || !input || !fetchBtn) return;
    input.value = currentBookingId || '';
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
      if (isPrimary && user.id && !user.loginLink)   user.loginLink   = `${TA_BASE}/admin/account/webadminCustomerLogin/${user.id}`;
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

    const doFind = async () => {
      const q = findInput.value.trim();
      if (!q) return;
      await withButtonLoading(findBtn, '⏳', async () => {
        const res = await api.findUser(q);
        findResults.innerHTML = '';
        if (!res.ok) { findResults.textContent = 'Search failed: ' + (res.data.error || ''); return; }
        const results = res.data.results || [];
        if (!results.length) { findResults.textContent = 'No results.'; return; }
        results.slice(0, 5).forEach((u) => {
          const item = document.createElement('div');
          item.style.cssText = 'padding:5px 0;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between;gap:8px;';
          const lbl = document.createElement('span');
          lbl.style.cssText = `color:${THEME.text};font-size:12px;`;
          lbl.textContent = `${u.name || ''}${u.email ? ' — ' + u.email : ''}`;
          const pickBtn = document.createElement('button');
          pickBtn.textContent = 'Select';
          pickBtn.style.cssText = `flex:0 0 auto;padding:3px 8px;border:1px solid ${THEME.primary};border-radius:3px;background:#fff;color:${THEME.primary};font-size:11px;cursor:pointer;`;
          pickBtn.onclick = () => {
            const primary = !u.type || u.type === 'primary';
            panelUserOverride = primary
              ? Object.assign({}, u, {
                  loginLink: `${TA_BASE}/admin/account/webadminCustomerLogin/${u.id}`,
                  profileLink: `${TA_BASE}/admin/account/viewCustomer/${u.id}`,
                })
              : Object.assign({}, u);
            if (!primary) showToast('Secondary traveler — no Login-as-User available.', 'warning');
            renderBookingPanel();
          };
          item.appendChild(lbl);
          item.appendChild(pickBtn);
          findResults.appendChild(item);
        });
      });
    };
    findBtn.addEventListener('click', doFind);
    findInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doFind(); });
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
  // the same guard freshdeskService.searchTicketsStrict applied.
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

  function normalizeSearchRow(t, matchedBy) {
    const a = t.assignee;
    return {
      id: String(t.id),
      ticketNumber: t.ticketNumber || null,
      subject: t.subject || '',
      status: t.status || null,
      statusType: t.statusType || null,
      assignee: a ? [a.firstName, a.lastName].filter(Boolean).join(' ') : null,
      createdTime: t.createdTime || null,
      matchedBy: [matchedBy],
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
      assignee: null,
      createdTime: r.created_at || null,
      matchedBy: ['linked booking'],
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
        row.matchedBy.forEach((m) => { if (!existing.matchedBy.includes(m)) existing.matchedBy.push(m); });
        existing.linked = existing.linked || row.linked;
        // Search rows carry richer data than DB rows; let them fill the gaps.
        ['ticketNumber', 'subject', 'status', 'statusType', 'assignee'].forEach((k) => {
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
      } catch (e) { /* leave unenriched; it still renders */ }
    }));
    return rows;
  }

  async function loadDuplicates(force) {
    const host = document.getElementById('taDuplicates');
    if (!host || !currentTicketId) return;
    if (!force && duplicateCache[currentTicketId]) { renderDuplicates(); return; }

    const bd = ticketBookingCache[currentTicketId];
    const booking = bd && bd.booking;
    const user = getDisplayUser();
    const internalId = booking && booking.internalBookingId;
    const supplierRef = booking && booking.supplierId;
    const email = user && user.email;

    if (!internalId && !supplierRef && !email) { host.innerHTML = ''; return; }

    host.innerHTML = `<div style="margin-top:12px;padding-top:10px;border-top:1px solid ${THEME.border};color:${THEME.subtle};font-size:11px;">⏳ Checking for duplicates…</div>`;

    const [dbRows, byInternal, bySupplier, byEmail] = await Promise.all([
      currentBookingId
        ? api.bookingTickets(currentBookingId, currentTicketId)
            .then((r) => (r.ok ? (r.data.tickets || []).map(normalizeDbRow) : []))
            .catch(() => [])
        : Promise.resolve([]),
      internalId  ? zdSearchTickets(internalId).then((rs) => rs.map((t) => normalizeSearchRow(t, 'booking ID'))) : [],
      supplierRef ? zdSearchTickets(supplierRef).then((rs) => rs.map((t) => normalizeSearchRow(t, 'supplier ref'))) : [],
      email       ? zdSearchTickets(email).then((rs) => rs.map((t) => normalizeSearchRow(t, 'member email'))) : [],
    ]);

    const merged = await enrichLinkedRows(mergeDuplicates([dbRows, byInternal, bySupplier, byEmail]));
    duplicateCache[currentTicketId] = merged;
    renderDuplicates();
  }

  async function runManualDuplicateSearch(term) {
    const rows = await zdSearchTickets(term, { verify: false });
    const existing = duplicateCache[currentTicketId] || [];
    duplicateCache[currentTicketId] = mergeDuplicates([
      existing,
      rows.map((t) => normalizeSearchRow(t, 'manual search')),
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

    const badge = (m) => {
      const colors = {
        'linked booking': THEME.success,
        'booking ID': THEME.primary,
        'supplier ref': THEME.info,
        'member email': '#fd7e14',
        'manual search': THEME.muted,
      };
      return `<span style="display:inline-block;padding:1px 5px;border-radius:8px;background:${colors[m] || THEME.muted};color:#fff;font-size:9px;margin-right:3px;">${escapeHtml(m)}</span>`;
    };

    const items = rows.map((r) => {
      const label = r.ticketNumber ? '#' + escapeHtml(r.ticketNumber) : escapeHtml(r.id);
      const subj = r.subject ? escapeHtml(String(r.subject).slice(0, 70)) : '';
      const closed = r.statusType === 'Closed';
      const status = r.status
        ? `<span style="color:${closed ? THEME.muted : THEME.success};font-size:10px;">${escapeHtml(r.status)}</span>`
        : '';
      const who = r.assignee ? `<span style="color:${THEME.subtle};font-size:9px;">${escapeHtml(r.assignee)}</span>` : '';
      return `<a href="${ticketUrl(r.id)}" style="display:block;padding:5px 7px;border:1px solid ${THEME.border};border-radius:4px;margin-bottom:4px;text-decoration:none;color:${THEME.text};background:${closed ? '#fafafa' : '#fff'};">
        <div style="display:flex;justify-content:space-between;gap:6px;align-items:center;"><strong style="font-size:11px;">${label}</strong>${status}</div>
        <div style="color:#666;font-size:10px;margin:2px 0;">${subj}</div>
        <div>${r.matchedBy.map(badge).join('')}${who}</div></a>`;
    }).join('');

    const hiddenCount = all.length - rows.length;
    host.innerHTML = `
      <div style="margin-top:12px;padding-top:10px;border-top:1px solid ${THEME.border};">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-weight:600;font-size:11px;color:${rows.length ? '#b8860b' : THEME.muted};text-transform:uppercase;letter-spacing:.04em;">
            ${rows.length ? '⚠ ' + rows.length + ' possible duplicate' + (rows.length === 1 ? '' : 's') : 'No duplicates'}</span>
          <button id="taDupRefresh" title="Re-run search" style="background:none;border:none;color:${THEME.subtle};font-size:11px;cursor:pointer;">⟳</button>
        </div>
        ${items}
        <label style="display:flex;align-items:center;gap:5px;color:${THEME.subtle};font-size:10px;margin-top:4px;cursor:pointer;">
          <input type="checkbox" id="taDupClosed" ${dupIncludeClosed ? 'checked' : ''} style="margin:0;" />
          incl. closed${hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ''}
        </label>
        <div style="display:flex;gap:5px;margin-top:6px;">
          <input id="taDupQuery" type="text" placeholder="Search tickets…" style="flex:1;min-width:0;padding:5px 8px;border:1px solid #ddd;border-radius:4px;font-size:11px;" />
          <button id="taDupGo" style="flex:0 0 auto;padding:5px 9px;border:1px solid #d3d8de;border-radius:4px;background:#fff;cursor:pointer;font-size:11px;">🔍</button>
        </div>
      </div>`;

    document.getElementById('taDupRefresh').onclick = () => loadDuplicates(true);
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

  // ===== ACTIONS =====
  // Posted through the agent's own session, so Desk attributes the note to
  // whoever clicked — the reason this is an overlay and not the OAuth widget.
  async function onPostNote(e) {
    const btn = e.currentTarget;
    const bd = ticketBookingCache[currentTicketId];
    if (!bd || !bd.noteHtml) { showToast('No note to post.', 'error'); return; }
    await withButtonLoading(btn, 'Posting…', async () => {
      try {
        await zdPost(`/tickets/${currentTicketId}/comments`, {
          content: bd.noteHtml,
          contentType: 'html',
          isPublic: false,
        });
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
        await zdPost(`/tickets/${currentTicketId}/comments`, { content: noteHtml, contentType: 'html', isPublic: false });
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

  // ===== SUPPLIER (HOTEL) EMAIL =====
  // Two phases, same as the Freshdesk flow: the backend resolves the hotel
  // address and builds the body, then the agent confirms/edits and sends.
  // The send itself goes through Desk's own sendReply from the agent's session,
  // so the outbound mail is attributed to them — the backend never sends.

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

  // sendReply requires a fromEmailAddress. Rather than hardcode a support
  // address, reuse whatever this ticket's own outbound mail already used.
  async function resolveFromAddress(ticketId) {
    if (fromAddressCache[ticketId]) return fromAddressCache[ticketId];
    const threads = await zdGet(`/tickets/${ticketId}/threads?limit=10`);
    const list = (threads && threads.data) || [];
    const outbound = list.find((t) => t.direction === 'out' && t.fromEmailAddress);
    const any = list.find((t) => t.fromEmailAddress);
    const from = (outbound || any || {}).fromEmailAddress || null;
    if (from) fromAddressCache[ticketId] = from;
    return from;
  }

  async function runSupplierEmailLookup() {
    const bd = ticketBookingCache[currentTicketId];
    if (!bd || !bd.booking) { showToast('No booking loaded.', 'error'); return; }
    const agentName = promptForAgentName(false);
    if (!agentName) { showToast('A sender name is needed to send supplier email.', 'warning'); return; }

    const res = await api.hotelEmailLookup({
      bookingId: currentBookingId || bd.booking.internalBookingId,
      agentName,
    });
    if (!res.ok || !res.data.success) {
      showToast('Lookup failed: ' + ((res.data && res.data.error) || res.status), 'error');
      return;
    }
    showSupplierEmailModal(res.data);
  }

  function onSupplierEmail(e) {
    return withButtonLoading(e.currentTarget, '⏳', runSupplierEmailLookup);
  }

  function showSupplierEmailModal(data) {
    const found = (data.emailResult && (data.emailResult.email || data.emailResult.hotelEmail)) || '';
    const confidence = data.emailResult && data.emailResult.confidence;
    const source = data.emailResult && (data.emailResult.source || data.emailResult.url);

    const { body } = createModal('taSupplierEmail', '✉ Email supplier', {
      style: 'top:50%;left:50%;transform:translate(-50%,-50%);width:720px;max-height:84vh;',
    });

    body.innerHTML = `
      <div style="font-size:12px;color:${THEME.muted};margin-bottom:10px;">
        ${escapeHtml(data.hotelName || '')}
        ${confidence ? ` · confidence: <strong>${escapeHtml(String(confidence))}</strong>` : ''}
        ${source ? ` · <a href="${escapeHtml(String(source))}" target="_blank" rel="noopener">source</a>` : ''}
      </div>
      <label style="display:block;font-size:11px;color:${THEME.muted};margin-bottom:3px;">To</label>
      <input id="taSupTo" type="text" value="${escapeHtml(found)}" placeholder="hotel@example.com"
        style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid ${found ? '#d3d8de' : THEME.danger};border-radius:4px;font-size:13px;margin-bottom:10px;" />
      <label style="display:block;font-size:11px;color:${THEME.muted};margin-bottom:3px;">Subject</label>
      <input id="taSupSubject" type="text" value="${escapeHtml(data.subject || '')}"
        style="width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #d3d8de;border-radius:4px;font-size:13px;margin-bottom:10px;" />
      <label style="display:block;font-size:11px;color:${THEME.muted};margin-bottom:3px;">
        Body — signing as ${escapeHtml(getAgentName())}
        <button id="taSupRename" style="background:none;border:none;color:${THEME.primary};font-size:11px;cursor:pointer;text-decoration:underline;">change</button>
      </label>
      <div id="taSupBody" contenteditable="true"
        style="border:1px solid #d3d8de;border-radius:4px;padding:10px;max-height:38vh;overflow-y:auto;font-size:13px;line-height:1.5;background:#fff;"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px;">
        <button id="taSupCancel" style="padding:8px 14px;border:1px solid #d3d8de;border-radius:5px;background:#fff;cursor:pointer;font-size:13px;">Cancel</button>
        <button id="taSupSend" style="padding:8px 18px;border:none;border-radius:5px;background:${THEME.success};color:#fff;font-weight:600;cursor:pointer;font-size:13px;">Send</button>
      </div>`;

    document.getElementById('taSupBody').innerHTML = data.emailHtmlPreview || '';
    if (!found) showToast('No hotel address found — enter one before sending.', 'warning');

    document.getElementById('taSupCancel').onclick = () => document.getElementById('taSupplierEmail').remove();
    document.getElementById('taSupRename').onclick = (ev) => {
      ev.preventDefault();
      const name = promptForAgentName(true);
      if (name) {
        document.getElementById('taSupplierEmail').remove();
        // Re-run the lookup so the rebuilt body carries the new signature.
        runSupplierEmailLookup();
      }
    };

    const sendBtn = document.getElementById('taSupSend');
    sendBtn.onclick = async () => {
      const to = document.getElementById('taSupTo').value.trim();
      const subject = document.getElementById('taSupSubject').value.trim();
      const content = document.getElementById('taSupBody').innerHTML;
      if (!to) { showToast('Enter a recipient address.', 'error'); return; }
      if (!window.confirm(`Send this email to ${to}?`)) return;

      await withButtonLoading(sendBtn, 'Sending…', async () => {
        try {
          const fromEmailAddress = await resolveFromAddress(currentTicketId);
          if (!fromEmailAddress) {
            showToast('Could not determine a From address for this ticket.', 'error');
            return;
          }
          // Field set established by probing sendReply's validator: content,
          // channel and fromEmailAddress are mandatory; `to` defaults to the
          // contact when omitted, which is exactly why it must be set here.
          await zdPost(`/tickets/${currentTicketId}/sendReply`, {
            content,
            contentType: 'html',
            channel: 'EMAIL',
            fromEmailAddress,
            to,
            subject,
          });
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
  async function loadTicket(ticketId) {
    currentTicketId = ticketId;
    panelUserOverride = null;
    currentTicketMeta = null;
    injectBookingPanel();

    const titleEl = document.getElementById('taPanelTitle');
    if (titleEl) titleEl.textContent = 'TA Booking';

    if (ticketBookingCache[ticketId]) {
      const cached = ticketBookingCache[ticketId];
      currentBookingId = cached && cached.booking ? cached.booking.internalBookingId : null;
      renderBookingPanel();
      return;
    }

    if (!getSecret()) {
      renderPanelMessage(`<div style="color:${THEME.subtle};font-size:13px;">No backend key set. Click ⚙ above to enter it.</div>`);
      return;
    }

    renderPanelMessage(`<div style="color:${THEME.subtle};font-size:13px;">Reading ticket…</div>`);
    try {
      const ctx = await fetchTicketContext(ticketId);
      currentTicketMeta = {
        ticketNumber: ctx.ticket.ticketNumber || null,
        subject: ctx.ticket.subject || null,
        status: ctx.ticket.status || null,
      };

      renderPanelMessage(`<div style="color:${THEME.subtle};font-size:13px;">Finding booking reference…</div>`);
      const ext = await api.extract({ subject: ctx.subject, description: ctx.description });
      if (!ext.ok) {
        renderPanelMessage(`<div style="color:${THEME.danger};font-size:13px;">${escapeHtml(ext.data.error || 'Extraction failed')}</div>`);
        return;
      }
      const bookingId = ext.data.bookingId;
      if (!bookingId) {
        ticketBookingCache[ticketId] = null;
        currentBookingId = null;
        renderBookingPanel();
        return;
      }

      renderPanelMessage(`<div style="color:${THEME.subtle};font-size:13px;">Loading booking ${escapeHtml(bookingId)}…</div>`);
      const res = await api.booking(bookingId);
      if (!res.ok || !res.data.success) {
        renderPanelMessage(`<div style="color:${THEME.danger};font-size:13px;">${escapeHtml((res.data && res.data.error) || 'Booking lookup failed')}</div>`);
        return;
      }
      currentBookingId = bookingId;
      ticketBookingCache[ticketId] = res.data.bookingData;
      renderBookingPanel();
      recordBookingLink(bookingId, 'auto');
    } catch (err) {
      console.error('[ta] load failed:', err);
      renderPanelMessage(`<div style="color:${THEME.danger};font-size:13px;">${escapeHtml(err.message)}</div>`);
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
      const panel = document.getElementById('taBookingPanel');
      if (panel) panel.remove();
      currentTicketId = null;
      return;
    }
    if (id === currentTicketId && document.getElementById('taBookingPanel')) return;
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
