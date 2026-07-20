// ==UserScript==
// @name         MWR Booking Tools
// @namespace    https://traveladvantage.com
// @version      6.65
// @description  Find booking data from Freshdesk — notes, email, tagging, duplicate detection
// @match        https://*.freshdesk.com/*
// @grant        GM_xmlhttpRequest
// @connect      mwr-new-booking-server.onrender.com
// @connect      mwrlife.freshdesk.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js
// @updateURL    https://raw.githubusercontent.com/ivanovichko/MWR_New_Booking_Server/main/frontend/MWR%20Booking%20Tools.user.js
// @downloadURL  https://raw.githubusercontent.com/ivanovichko/MWR_New_Booking_Server/main/frontend/MWR%20Booking%20Tools.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ===== CONFIG =====
  const BACKEND_URL = 'https://mwr-new-booking-server.onrender.com';

  // ===== THEME TOKENS =====
  // Shared visual constants. createModal and modal-builder helpers read these
  // so a single edit propagates across every floating panel.
  const THEME = {
    font:    'system-ui,sans-serif',
    shadow:  '0 8px 30px rgba(0,0,0,0.25)',
    radius:  '10px',
    border:  '#eee',
    text:    '#333',
    muted:   '#888',
    subtle:  '#999',
    primary: '#6f42c1', // purple
    success: '#28a745',
    danger:  '#dc3545',
    warn:    '#ffc107',
    info:    '#17a2b8',
  };

  // ===== API LAYER =====
  // Wraps gmGet / gmPost in named methods so URLs and request
  // shapes live in one place. Each method returns `{ ok, status, data }`.
  const api = {
    guided: {
      ticket:  (id)            => gmGet(`${BACKEND_URL}/guided-prewarm/ticket/${id}`),
      analyse: (id)            => gmGet(`${BACKEND_URL}/guided-prewarm/analyse/${id}`),
      booking: (id)            => gmGet(`${BACKEND_URL}/guided-prewarm/booking/${encodeURIComponent(id)}`),
      confirm: (body)          => gmPost(`${BACKEND_URL}/guided-prewarm/confirm`, body),
      hotelEmailLookup: (body) => gmPost(`${BACKEND_URL}/guided-prewarm/hotel-email/lookup`, body),
      hotelEmailSend:   (body) => gmPost(`${BACKEND_URL}/guided-prewarm/hotel-email/send`, body),
    },
    postNote:        (ticketId, noteHtml)         => gmPost(`${BACKEND_URL}/post-note`, { freshdeskTicketId: String(ticketId), noteHtml }),
    renameSubject:   (ticketId, subject)          => gmPost(`${BACKEND_URL}/rename-subject`, { ticketId: String(ticketId), subject }),
    mergeTicket:     (body)                       => gmPost(`${BACKEND_URL}/merge-ticket`, body),
    sendReply:       (body)                       => gmPost(`${BACKEND_URL}/send-reply`, body),
    findUser:        (query)                      => gmPost(`${BACKEND_URL}/find-user`, { query }),
    userReservations:(userId)                     => gmGet(`${BACKEND_URL}/user/${userId}/reservations`),
    searchTickets:   (body)                       => gmPost(`${BACKEND_URL}/search-tickets`, body),
    checkDuplicates: (body)                       => gmPost(`${BACKEND_URL}/check-duplicates`, body),
    translate:       (text, target='en')          => gmPost(`${BACKEND_URL}/translate`, { text, target }),
    aiAssist:        (body)                       => gmPost(`${BACKEND_URL}/ai-assist`, body),
    prompts:         ()                           => gmGet(`${BACKEND_URL}/settings/prompts`),
    bulkConfirm:     (tag)                        => gmPost(`${BACKEND_URL}/bulk-confirm`, { tag }),
    triage: {
      start:  (body) => gmPost(`${BACKEND_URL}/batch-triage/start`, body),
      stop:   ()     => gmPost(`${BACKEND_URL}/batch-triage/stop`, {}),
      status: ()     => gmGet(`${BACKEND_URL}/batch-triage/status`),
    },
    attachmentUrl:   (url)                        => `${BACKEND_URL}/attachment?url=${encodeURIComponent(url)}`,
  };


function showLoader(message = "Loading...") {
        const existing = document.getElementById("taLoader");
        if (existing) {
          existing.querySelector(".ta-loader-msg").textContent = message;
          return existing;
        }

        const loader = document.createElement("div");
        loader.id = "taLoader";
        loader.style.cssText = `
    position: fixed;
    top: 12px; left: 50%;
    transform: translateX(-50%);
    background: rgba(0,0,0,0.8);
    display: flex;
    align-items: center;
    gap: 10px;
    color: #fff;
    font-family: system-ui, sans-serif;
    font-size: 14px;
    z-index: 999999;
    padding: 10px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;
        loader.innerHTML = `
    <div style="border:3px solid rgba(255,255,255,0.3);border-top:3px solid #fff;border-radius:50%;
      width:20px;height:20px;animation:spin 1s linear infinite;flex-shrink:0;"></div>
    <div class="ta-loader-msg">${message}</div>
    <style>@keyframes spin{0%{transform:rotate(0deg);}100%{transform:rotate(360deg);}}</style>
  `;
        document.body.appendChild(loader);
        return loader;
    }
function hideLoader() {
  const loader = document.getElementById("taLoader");
  if (loader) loader.remove();
}

// ===== BOOKING TOOLS =====

// Filter view URL: /a/tickets/filters/{id}. Returns null when not on a filter view.
function getFreshdeskFilterId() {
  const m = window.location.pathname.match(/\/a\/tickets\/filters\/(\d+)/);
  return m ? m[1] : null;
}

// Same-origin GET against Freshdesk's internal API. Browser sends the session
// cookie automatically. Throws on non-2xx.
async function fdGet(path) {
  const url = path.startsWith('http') ? path : `https://${window.location.hostname}${path}`;
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`fdGet ${path} → ${res.status}`);
  return res.json();
}

// Render TA's AI reconfirmation badge as a self-contained styled chip.
// Accepts the structured { status, title, date } parsed server-side, or
// (for backward-compat with anything still passing raw HTML) returns the
// input unchanged.
function renderAiReconfirmBadge(r) {
  if (!r) return '';
  if (typeof r === 'string') return r; // legacy pass-through
  const palette = {
    confirmed: { bg: '#d4edda', fg: '#155724', icon: '✓' },
    failed:    { bg: '#f8d7da', fg: '#721c24', icon: '✗' },
    initiated: { bg: '#fff3cd', fg: '#856404', icon: '🕐' },
  };
  const c = palette[r.status] || palette.initiated;
  const dateSuffix = r.date ? ' · ' + r.date : '';
  const titleAttr = (r.title || 'AI Reconfirmation').replace(/"/g, '&quot;');
  return '<span style="display:inline-block;padding:3px 10px;border-radius:10px;' +
         'background:' + c.bg + ';color:' + c.fg + ';font-size:13px;font-weight:600;" ' +
         'title="' + titleAttr + '">' + c.icon + ' ' + (r.title || 'AI Reconfirmation') + dateSuffix + '</span>';
}

// Prewarm caches — Map<filterId, ticketId[]> and Map<ticketId, analyseResult>.
// In-memory only; survives SPA navigation but resets on full reload.
const viewQueueCache = new Map();
const ticketBookingCache = new Map();
// Cached duplicate-search results, keyed by ticket ID. Value is the array
// returned from /check-duplicates, or 'loading' while a request is in flight.
const ticketDuplicatesCache = new Map();
// Booking panel "picked member" overrides, keyed by ticket ID. Set when the
// agent uses Find Member to swap the displayed customer; cleared on reload.
const panelUserOverride = new Map();
// Cached /user/{id}/reservations payloads, keyed by user ID, so re-opening
// the Reservations tab doesn't refetch.
const userReservationsCache = new Map();

// Latest filter the agent visited. Captured on navigation (see checkTicketChange).
let _lastFilterId = getFreshdeskFilterId();

// Assisted mode — when ON, every ticket navigation auto-fires prewarmWindow.
// Persisted via localStorage so the toggle survives reloads.
let _assistedMode = (() => {
  try { return localStorage.getItem('ta_assisted_mode') === '1'; } catch (e) { return false; }
})();
function setAssistedMode(on) {
  _assistedMode = !!on;
  try { localStorage.setItem('ta_assisted_mode', _assistedMode ? '1' : '0'); } catch (e) {}
  const btn = document.getElementById('taAssistedToggle');
  if (btn) styleAssistedToggle(btn);
  if (_assistedMode) {
    showToast('Assisted mode ON — auto-prewarming on navigation.', 'success', 2200);
    prewarmWindow();
  } else {
    showToast('Assisted mode OFF.', 'info', 1500);
  }
}
function styleAssistedToggle(btn) {
  if (_assistedMode) {
    btn.textContent = '🟢 Assisted';
    btn.style.cssText = 'background:#16a085;color:#fff;border:none;padding:4px 10px;border-radius:14px;margin-left:6px;cursor:pointer;font-size:11px;font-weight:600;';
  } else {
    btn.textContent = '⚪ Assisted';
    btn.style.cssText = 'background:#fff;color:#888;border:1px solid #ccc;padding:4px 10px;border-radius:14px;margin-left:6px;cursor:pointer;font-size:11px;font-weight:500;';
  }
}

// Prewarm current ticket + next two from the agent's most-recently-visited
// filter view. POC scope: results land in ticketBookingCache, logged to console.
async function prewarmWindow() {
  const ticketId = getFreshdeskTicketId();
  if (!ticketId) { showToast('No ticket on this page.', 'warning'); return; }
  const filterId = _lastFilterId;
  console.log(`[prewarm] start — ticket=${ticketId} filter=${filterId || '(none)'}`);

  // Resolve the prewarm window. Three cases:
  //   1. No filter ID yet → just this ticket.
  //   2. Filter ID but ticket not in queue (e.g. opened via search) → just this ticket.
  //   3. Ticket found in queue → [i, i+1, i+2].
  let windowIds;
  if (!filterId) {
    console.log(`[prewarm] no filter captured — single-ticket fallback`);
    windowIds = [String(ticketId)];
  } else {
    let queue = viewQueueCache.get(filterId);
    if (!queue) {
      try {
        const data = await fdGet(`/api/_/tickets?filter=${filterId}&per_page=30&include=requester,stats`);
        queue = (data.tickets || []).map(t => String(t.id));
        viewQueueCache.set(filterId, queue);
        console.log(`[prewarm] queue fetched — ${queue.length} tickets`);
      } catch (e) {
        console.error(`[prewarm] queue fetch failed`, e);
        showToast(`Queue fetch failed: ${e.message} — prewarming this ticket only.`, 'warning', 2500);
        queue = null;
      }
    } else {
      console.log(`[prewarm] queue cache hit — ${queue.length} tickets`);
    }

    if (queue) {
      const idx = queue.indexOf(String(ticketId));
      if (idx === -1) {
        console.warn(`[prewarm] current ticket ${ticketId} not in queue — single-ticket fallback`);
        showToast('Ticket not in queue — prewarming this one only.', 'info', 2000);
        windowIds = [String(ticketId)];
      } else {
        windowIds = queue.slice(idx, idx + 3);
      }
    } else {
      windowIds = [String(ticketId)];
    }
  }
  console.log(`[prewarm] window: [${windowIds.join(', ')}]`);

  // Fire all analyses in parallel. Each task refreshes the panel as soon as
  // its result lands — so the ticket the agent is on updates the moment its
  // response comes back, not when the slowest one in the batch finishes.
  await withPanelBusy(async () => {
    showToast(`Prewarming ${windowIds.length} ticket(s)...`, 'info', 1500);
    const tasks = windowIds.map(async (tid) => {
      if (ticketBookingCache.has(tid)) {
        console.log(`[prewarm] ${tid} — cache hit, skip`);
        return;
      }
      console.log(`[prewarm] ${tid} — analysing`);
      const { ok, data } = await api.guided.analyse(tid);
      if (!ok) {
        console.warn(`[prewarm] ${tid} — analyse failed`, data);
        ticketBookingCache.set(tid, null);
      } else {
        ticketBookingCache.set(tid, data);
        console.log(`[prewarm] ${tid} — cached`, {
          bookingId: data?.bookingId || null,
          hasBookingData: !!data?.bookingData,
          hasUserData: !!data?.userData,
        });
      }
      // Live update: if the agent is on this ticket, refresh immediately
      // so they see data the instant their ticket's response lands.
      if (String(getFreshdeskTicketId()) === tid) {
        refreshNativeInjections();
      }
    });
    await Promise.all(tasks);
    console.log(`[prewarm] done — cache size: ${ticketBookingCache.size}`);
    refreshNativeInjections();
  });
}

// ── Native FD injections ──────────────────────────────────────────────────────
// Three pieces inject into Freshdesk's own DOM (vs. floating modal):
//   1. Booking panel — fixed right-rail panel showing the current ticket's
//      prewarmed booking data from ticketBookingCache.
//   2. Reply-bar buttons — "Reply Customer" / "Reply Supplier" appended to
//      Freshdesk's reply/note/forward bar as new <li> items.
//   3. Duplicate search strip — banner injected just above the reply bar.
// FD re-renders its conversation tree on navigation, so #2 and #3 are mounted
// by a polling loop that re-injects when missing. #1 lives on document.body
// and only needs to be created once.

const BOOKING_PANEL_ID = 'taBookingPanel';
const REPLY_CUSTOMER_LI_ID = 'taReplyCustomerLi';
const REPLY_SUPPLIER_LI_ID = 'taReplySupplierLi';
const DUP_STRIP_ID = 'taDupStrip';

function injectBookingPanel() {
  if (document.getElementById(BOOKING_PANEL_ID)) return;
  const panel = document.createElement('div');
  panel.id = BOOKING_PANEL_ID;
  panel.style.cssText =
    'position:fixed;right:20px;top:100px;width:820px;max-width:calc(100vw - 40px);max-height:82vh;' +
    'background:#fff;border:1px solid #e3e3e3;border-radius:10px;' +
    'box-shadow:0 8px 30px rgba(0,0,0,0.2);font-family:system-ui,sans-serif;' +
    'font-size:16px;color:#333;z-index:9998;display:flex;flex-direction:column;overflow:hidden;';
  panel.innerHTML =
    '<div id="' + BOOKING_PANEL_ID + '_header" style="padding:10px 14px;background:#f7f7f7;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;gap:10px;">' +
      '<span style="font-weight:600;display:flex;align-items:center;gap:8px;">📦 Booking' +
        '<span id="' + BOOKING_PANEL_ID + '_spinner" style="display:none;width:12px;height:12px;border:2px solid #ccc;border-top-color:#6f42c1;border-radius:50%;animation:taSpin 0.8s linear infinite;"></span>' +
      '</span>' +
      '<span id="' + BOOKING_PANEL_ID + '_queueCount" style="flex:1;font-size:13px;color:#888;font-weight:400;text-align:right;"></span>' +
      '<span id="' + BOOKING_PANEL_ID + '_toggle" style="cursor:pointer;padding:0 8px;font-size:17px;line-height:1;">−</span>' +
    '</div>' +
    '<div id="' + BOOKING_PANEL_ID + '_body" style="padding:12px;overflow-y:auto;flex:1;"></div>';
  if (!document.getElementById('taSpinKeyframes')) {
    const sty = document.createElement('style');
    sty.id = 'taSpinKeyframes';
    sty.textContent = '@keyframes taSpin{to{transform:rotate(360deg);}}';
    document.head.appendChild(sty);
  }
  document.body.appendChild(panel);

  const body = panel.querySelector('#' + BOOKING_PANEL_ID + '_body');
  const toggle = panel.querySelector('#' + BOOKING_PANEL_ID + '_toggle');
  let collapsed = false;
  toggle.onclick = () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : 'block';
    toggle.textContent = collapsed ? '+' : '−';
  };

  // Reuse existing draggable helper, defined further down.
  try { makeDraggable(panel, panel.querySelector('#' + BOOKING_PANEL_ID + '_header')); } catch (e) {}
}

// Header-level busy counter. Multiple concurrent async ops increment; spinner
// stays visible until all complete. Avoids flicker when ops overlap.
let _panelBusyCount = 0;
function setPanelBusy(busy) {
  _panelBusyCount = Math.max(0, _panelBusyCount + (busy ? 1 : -1));
  const sp = document.getElementById(BOOKING_PANEL_ID + '_spinner');
  if (sp) sp.style.display = _panelBusyCount > 0 ? 'inline-block' : 'none';
}
async function withPanelBusy(fn) {
  setPanelBusy(true);
  try { return await fn(); }
  finally { setPanelBusy(false); }
}

// Renders the booking panel content. Mirrors the Guided modal's booking +
// customer sections. Tag/Call-Hotel logic is intentionally absent — the panel
// always exposes "📋 Post Note" and "📧 Hotel Email" as fixed actions.
function renderBookingPanel() {
  const body = document.getElementById(BOOKING_PANEL_ID + '_body');
  if (!body) return;
  const ticketId = getFreshdeskTicketId();
  if (!ticketId) {
    body.style.display = 'block';
    body.innerHTML = '<div style="color:#888;">No ticket on this page.</div>';
    return;
  }
  const cached = ticketBookingCache.get(String(ticketId));
  if (cached === undefined) {
    body.style.display = 'block';
    body.innerHTML = '<div style="color:#888;font-size:15px;padding:8px 4px;">Loading details, please wait…</div>';
    return;
  }

  body.innerHTML = '';

  // Two-column layout: booking info on the left, member panel on the right.
  body.style.display = 'flex';
  body.style.gap = '0';
  body.style.alignItems = 'flex-start';
  const leftCol = document.createElement('div');
  leftCol.style.cssText = 'flex:1 1 0;min-width:0;padding-right:16px;';
  const rightCol = document.createElement('div');
  rightCol.style.cssText = 'flex:0 0 300px;min-width:0;padding-left:16px;border-left:1px solid #eee;';
  body.appendChild(leftCol);
  body.appendChild(rightCol);

  // ── No booking case ────────────────────────────────────────────────────────
  if (cached === null || !cached.bookingData) {
    const msg = document.createElement('div');
    msg.style.cssText = 'color:#dc3545;font-size:15px;margin-bottom:10px;';
    msg.textContent = '⚠️ No booking ID found in this ticket.';
    leftCol.appendChild(msg);

    const manualRow = document.createElement('div');
    manualRow.style.cssText = 'display:flex;gap:8px;';
    const manualInput = document.createElement('input');
    manualInput.type = 'text'; manualInput.placeholder = 'Enter booking ID manually...';
    manualInput.style.cssText = 'flex:1;padding:8px 12px;border:1px solid #ddd;border-radius:5px;font-size:15px;';
    const fetchManualBtn = document.createElement('button');
    fetchManualBtn.textContent = '🔍 Fetch';
    fetchManualBtn.style.cssText = 'padding:8px 14px;border:none;border-radius:5px;background:#6f42c1;color:#fff;font-size:15px;cursor:pointer;';
    fetchManualBtn.onclick = () => withPanelBusy(async () => {
      const id = manualInput.value.trim(); if (!id) return;
      fetchManualBtn.disabled = true; fetchManualBtn.textContent = '⏳';
      const { ok: fok, data: fd } = await api.guided.booking(id);
      fetchManualBtn.disabled = false; fetchManualBtn.textContent = '🔍 Fetch';
      if (fok && fd.bookingData) {
        ticketBookingCache.set(String(ticketId), { ...cached, bookingId: id, bookingData: fd.bookingData });
        ticketDuplicatesCache.delete(String(ticketId));
        refreshNativeInjections();
      } else showToast('Booking not found in TA.', 'error');
    });
    manualInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchManualBtn.click(); });
    manualRow.appendChild(manualInput); manualRow.appendChild(fetchManualBtn);
    leftCol.appendChild(manualRow);

    // Customer section (fallback path)
    appendCustomerSection(rightCol, getDisplayUser(ticketId, cached), ticketId);
    return;
  }

  // ── With booking ───────────────────────────────────────────────────────────
  const { booking, details } = cached.bookingData;
  const cleanSupplierName = (name) => (name || '').replace(/\s*\(\d+\)\s*$/g, '').replace(/\bV\d+\b/gi, '').replace(/\bpackage\b/gi, '').trim();
  const productType = (booking.productType || '').toLowerCase();
  const isHotel    = productType.includes('hotel') || productType.includes('getaway');
  const isFlight   = productType.includes('flight');

  let daysUntil = null;
  if (booking.checkIn) {
    const months = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
    const m = booking.checkIn.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
    if (m) {
      const mi = months[m[1].toLowerCase()];
      if (mi !== undefined) {
        const now = new Date(); now.setHours(0,0,0,0);
        const ci = new Date(parseInt(m[3]), mi, parseInt(m[2]));
        daysUntil = Math.round((ci - now) / 86400000);
      }
    }
  }

  // Booking table
  const rows = [
    ['Booking ID', booking.internalBookingId || '—'],
    ['Supplier ID', booking.supplierId || '—'],
    ['Type', booking.productType || '—'],
    ['Supplier', cleanSupplierName(booking.supplierName) || '—'],
    isHotel  ? ['Hotel',   (details && details.hotelName) || '—'] : null,
    isFlight ? ['Airline', (details && details.departAirline) || '—'] : null,
    ['Guest', booking.guestName || '—'],
    ['Check-In', booking.checkIn || '—'],
    ['Check-Out', booking.checkOut || '—'],
    daysUntil !== null ? ['Days until', `${daysUntil} days`] : null,
    booking.mwrRoomType ? ['Room Type', booking.mwrRoomType] : null,
    details && details.bedTypes ? ['Bed Types', details.bedTypes] : null,
    details && details.arrivalTime ? ['Arrival time', details.arrivalTime] : null,
    details && details.requests ? ['Requests', '<span style="color:#5d4037;">' + details.requests + '</span>'] : null,
    booking.aiReconfirmation ? ['AI Reconfirm', renderAiReconfirmBadge(booking.aiReconfirmation)] : null,
  ].filter(Boolean);
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:16px;';
  rows.forEach(([label, val]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th style="padding:5px 10px;text-align:left;color:#888;font-weight:500;width:35%;white-space:nowrap;vertical-align:top;">${label}</th><td style="padding:5px 10px;color:#333;">${val}</td>`;
    table.appendChild(tr);
  });
  leftCol.appendChild(table);

  // Change booking inline row (toggled)
  const changeBookingRow = document.createElement('div');
  changeBookingRow.style.cssText = 'display:none;gap:6px;margin-top:6px;';
  const changeBookingInput = document.createElement('input');
  changeBookingInput.type = 'text'; changeBookingInput.placeholder = 'Enter booking ID...';
  changeBookingInput.value = cached.bookingId || '';
  changeBookingInput.style.cssText = 'flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:4px;font-size:14px;';
  const changeBookingBtn = document.createElement('button');
  changeBookingBtn.textContent = '🔍 Fetch';
  changeBookingBtn.style.cssText = 'padding:6px 12px;border:none;border-radius:4px;background:#6f42c1;color:#fff;font-size:14px;cursor:pointer;';
  changeBookingBtn.onclick = () => withPanelBusy(async () => {
    const id = changeBookingInput.value.trim(); if (!id) return;
    changeBookingBtn.disabled = true; changeBookingBtn.textContent = '⏳';
    const { ok: fok, data: fd } = await api.guided.booking(id);
    changeBookingBtn.disabled = false; changeBookingBtn.textContent = '🔍 Fetch';
    if (fok && fd.bookingData) {
      ticketBookingCache.set(String(ticketId), { ...cached, bookingId: id, bookingData: fd.bookingData });
      ticketDuplicatesCache.delete(String(ticketId));
      refreshNativeInjections();
    } else showToast('Booking not found.', 'error');
  });
  changeBookingInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') changeBookingBtn.click(); });
  changeBookingRow.appendChild(changeBookingInput); changeBookingRow.appendChild(changeBookingBtn);
  const changeBookingToggle = document.createElement('button');
  changeBookingToggle.textContent = '🔍 Change booking';
  changeBookingToggle.style.cssText = 'margin-top:8px;padding:4px 10px;border:1px dashed #aaa;border-radius:4px;background:transparent;color:#888;font-size:12px;cursor:pointer;';
  changeBookingToggle.onclick = () => {
    const open = changeBookingRow.style.display !== 'none';
    changeBookingRow.style.display = open ? 'none' : 'flex';
    if (!open) changeBookingInput.focus();
  };
  leftCol.appendChild(changeBookingToggle);
  leftCol.appendChild(changeBookingRow);

  // Always-visible action row: Post Note · View Note (row 1), Hotel Email
  // (full width, row 2).
  const actionRow = document.createElement('div');
  actionRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:12px;';

  const postNoteBtn = document.createElement('button');
  postNoteBtn.textContent = '📋 Post Note';
  postNoteBtn.style.cssText = 'padding:10px 12px;border:none;border-radius:6px;background:#007bff;color:#fff;font-size:16px;font-weight:600;cursor:pointer;';
  postNoteBtn.onclick = () => withPanelBusy(async () => {
    postNoteBtn.disabled = true; postNoteBtn.textContent = '⏳';
    const refresh = await captureRefresh(ticketId);
    const noteHtml = cached.bookingData.noteHtml || null;
    const { ok, data } = await api.guided.confirm({
      ticketId: String(ticketId),
      bookingId: cached.bookingId || booking.internalBookingId,
      action: 'note_only',
      noteHtml,
    });
    if (ok) {
      postNoteBtn.style.background = '#28a745';
      postNoteBtn.textContent = '✅ Posted';
      showToast('Note posted.', 'success');
      refresh();
    } else {
      postNoteBtn.disabled = false; postNoteBtn.textContent = '📋 Post Note';
      showToast('Post failed: ' + (data?.error || 'unknown'), 'error');
    }
  });

  const hotelEmailBtn = document.createElement('button');
  hotelEmailBtn.textContent = '📧 Hotel Email';
  hotelEmailBtn.style.cssText = 'grid-column:1/-1;padding:10px 12px;border:1px solid #28a745;border-radius:6px;background:#fff;color:#28a745;font-size:16px;font-weight:600;cursor:pointer;';
  hotelEmailBtn.onclick = () => withPanelBusy(async () => {
    const bid = cached.bookingId || booking.internalBookingId;
    if (!bid) { showToast('No booking ID.', 'error'); return; }
    hotelEmailBtn.disabled = true; hotelEmailBtn.textContent = '⏳ Looking up...';
    const { ok: lok, data: ld } = await api.guided.hotelEmailLookup({ ticketId: String(ticketId), bookingId: bid });
    hotelEmailBtn.disabled = false; hotelEmailBtn.textContent = '📧 Hotel Email';
    if (!lok) { showToast('❌ Lookup failed: ' + (ld?.error || 'Server error'), 'error'); return; }
    if (ld.tagged?.length) showToast('🏷️ Tagged: ' + ld.tagged.join(', '), 'success', 2000);
    showHotelEmailConfirmModal({
      hotelName:        ld.hotelName,
      emailResult:      ld.emailResult,
      emailHtmlPreview: ld.emailHtmlPreview,
      onSend: async (addr) => withPanelBusy(async () => {
        const refresh = await captureRefresh(ticketId);
        const { ok: sok, data: sd } = await api.guided.hotelEmailSend({
          ticketId: String(ticketId), bookingId: bid, hotelEmail: addr,
        });
        if (!sok) throw new Error(sd?.error || 'Send failed');
        showToast(`✅ Email sent → ${addr}`, 'success', 3000);
        refresh();
      }),
    });
  });

  // View Note — opens the prebuilt noteHtml in a read-only modal.
  const viewNoteBtn = document.createElement('button');
  viewNoteBtn.textContent = '👁️ View Note';
  viewNoteBtn.style.cssText = 'padding:10px 12px;border:1px solid #17a2b8;border-radius:6px;background:#fff;color:#17a2b8;font-size:16px;font-weight:600;cursor:pointer;';
  viewNoteBtn.onclick = () => {
    const noteHtml = cached.bookingData.noteHtml;
    if (!noteHtml) { showToast('Note not built yet.', 'warning'); return; }
    showNoteModal(noteHtml);
  };

  actionRow.appendChild(postNoteBtn);
  actionRow.appendChild(viewNoteBtn);
  actionRow.appendChild(hotelEmailBtn);
  leftCol.appendChild(actionRow);

  // ── Rename Subject — standalone: builds "bookingId / supplierId / Issue".
  const SUBJECT_ISSUES = ['Reconfirmation','Cancellation','Modification','Complaint','Question','GuaranteeClaim','InfoRequest','Voucher','Info','Other'];
  const renameRow = document.createElement('div');
  renameRow.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:8px;padding-top:8px;border-top:1px dashed #eee;';

  const renameTop = document.createElement('div');
  renameTop.style.cssText = 'display:flex;gap:6px;align-items:center;';
  const issueSel = document.createElement('select');
  issueSel.style.cssText = 'flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px;background:#fff;color:#333;';
  for (const opt of SUBJECT_ISSUES) {
    const o = document.createElement('option'); o.value = opt; o.textContent = opt; issueSel.appendChild(o);
  }
  const otherInput = document.createElement('input');
  otherInput.type = 'text'; otherInput.placeholder = 'Custom issue…';
  otherInput.style.cssText = 'flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px;display:none;';
  const renameBtn = document.createElement('button');
  renameBtn.textContent = '✏️ Rename Subject';
  renameBtn.style.cssText = 'padding:8px 12px;border:1px solid #6f42c1;border-radius:6px;background:#fff;color:#6f42c1;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;';
  renameTop.appendChild(issueSel);
  renameTop.appendChild(otherInput);
  renameTop.appendChild(renameBtn);

  const preview = document.createElement('div');
  preview.style.cssText = 'font-size:12px;color:#888;font-family:system-ui,sans-serif;word-break:break-word;';

  const currentIssue = () => issueSel.value === 'Other' ? otherInput.value.trim() : issueSel.value;
  const buildSubject = () => [booking.internalBookingId, booking.supplierId, currentIssue()].filter(Boolean).join(' / ');
  const syncRename = () => {
    otherInput.style.display = issueSel.value === 'Other' ? '' : 'none';
    const subject = buildSubject();
    const noBooking = !booking.internalBookingId;
    const needsOther = issueSel.value === 'Other' && !otherInput.value.trim();
    renameBtn.disabled = noBooking || needsOther;
    renameBtn.style.opacity = renameBtn.disabled ? '0.5' : '1';
    renameBtn.style.cursor = renameBtn.disabled ? 'not-allowed' : 'pointer';
    renameBtn.title = noBooking ? "No booking ID — can't rename" : '';
    preview.textContent = noBooking ? '⚠️ No booking ID — rename disabled' : `→ ${subject}`;
  };
  issueSel.onchange = syncRename;
  otherInput.oninput = syncRename;
  syncRename();

  renameBtn.onclick = () => withPanelBusy(async () => {
    if (renameBtn.disabled) return;
    const subject = buildSubject();
    renameBtn.disabled = true; renameBtn.textContent = '⏳';
    const refresh = await captureRefresh(ticketId);
    const { ok, data } = await api.renameSubject(ticketId, subject);
    renameBtn.textContent = '✏️ Rename Subject';
    if (ok) {
      showToast('Subject renamed.', 'success');
      refresh();
    } else {
      showToast('Rename failed: ' + (data?.error || 'unknown'), 'error');
    }
    syncRename();
  });

  renameRow.appendChild(renameTop);
  renameRow.appendChild(preview);
  leftCol.appendChild(renameRow);

  // Customer section — right column.
  appendCustomerSection(rightCol, getDisplayUser(ticketId, cached), ticketId);
}

// Returns the user to display in the panel — picked override wins, then
// bookingData.user, then userData fallback.
function getDisplayUser(ticketId, cached) {
  const override = panelUserOverride.get(String(ticketId));
  if (override) return override;
  return cached?.bookingData?.user || cached?.userData || null;
}

// Renders the member section: Profile / Reservations tabs + Find Member.
// Mirrors the Guided modal's renderCustomerSection.
function appendCustomerSection(body, user, ticketId) {
  const TA_BASE = 'https://traveladvantage.com';

  // Sits in the panel's right column — no top border (the column has a
  // left border instead).
  const sec = document.createElement('div');

  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-weight:600;font-size:13px;color:#888;margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em;';
  hdr.textContent = 'Member';
  sec.appendChild(hdr);

  if (user) {
    // Backfill login/profile links if the user came from bookingData (no links added there).
    // Only primary members have customer login + view URLs. Secondary travelers
    // (u.type === 'secondary') get an editTraveler() JS handler in TA's UI,
    // not a URL — building webadminCustomerLogin/{travelerId} hits the wrong
    // customer record. bookingData.user always comes through as a primary so
    // missing/undefined type means primary.
    const isPrimary = !user.type || user.type === 'primary';
    if (isPrimary && user.id && !user.loginLink)   user.loginLink   = `${TA_BASE}/admin/account/webadminCustomerLogin/${user.id}`;
    if (isPrimary && user.id && !user.profileLink) user.profileLink = `${TA_BASE}/admin/account/viewCustomer/${user.id}`;

    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;border-bottom:1px solid #eee;margin-bottom:8px;';
    const makeTabBtn = (label, active) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `flex:1;padding:7px;border:none;border-bottom:2px solid ${active ? '#007bff' : 'transparent'};background:${active ? '#f8f8f8' : 'transparent'};font-size:14px;font-weight:${active ? '600' : '400'};cursor:pointer;`;
      return b;
    };
    const profileTab = makeTabBtn('Profile', true);
    const resTab     = makeTabBtn('Reservations', false);
    tabBar.appendChild(profileTab); tabBar.appendChild(resTab);
    sec.appendChild(tabBar);

    const tabContent = document.createElement('div');
    sec.appendChild(tabContent);

    const setActive = (btn) => {
      [profileTab, resTab].forEach((b) => {
        const active = b === btn;
        b.style.borderBottomColor = active ? '#007bff' : 'transparent';
        b.style.background        = active ? '#f8f8f8' : 'transparent';
        b.style.fontWeight        = active ? '600' : '400';
      });
    };

    const showProfileTab = () => {
      setActive(profileTab);
      tabContent.innerHTML = '';
      // Quick-action buttons
      const actionRow = document.createElement('div');
      actionRow.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:10px;';
      if (user.loginLink) {
        const a = document.createElement('a'); a.href = user.loginLink; a.target = '_blank';
        a.textContent = '🔑 Login as User';
        a.style.cssText = 'display:block;background:#007bff;color:#fff;padding:6px 10px;border-radius:4px;text-decoration:none;font-size:14px;text-align:center;';
        a.addEventListener('click', () => console.log('[booking-panel] Login as User →', a.href));
        actionRow.appendChild(a);
      }
      if (user.profileLink) {
        const a = document.createElement('a'); a.href = user.profileLink; a.target = '_blank';
        a.textContent = '👤 Open Full Profile';
        a.style.cssText = 'display:block;background:#0056d2;color:#fff;padding:6px 10px;border-radius:4px;text-decoration:none;font-size:14px;text-align:center;';
        a.addEventListener('click', () => console.log('[booking-panel] Open Profile →', a.href));
        actionRow.appendChild(a);
      }
      const memberNoteBtn = document.createElement('button');
      memberNoteBtn.textContent = '📋 Post Member Note';
      memberNoteBtn.style.cssText = 'padding:6px 10px;border:1px solid #28a745;border-radius:4px;background:#fff;color:#28a745;font-size:14px;cursor:pointer;font-weight:500;';
      memberNoteBtn.onclick = () => withPanelBusy(async () => {
        memberNoteBtn.disabled = true; memberNoteBtn.textContent = '⏳';
        const refresh = await captureRefresh(ticketId);
        const v = (val) => val || '';
        const fields = [['Name', user.fullName || user.name], ['Email', user.email], ['Phone', user.phone], ['Instance', user.instance], ['Status', user.status], ['Country', user.country], ['Language', user.language]].filter(([, val]) => val);
        const lines = fields.map(([l, val]) => `<div><strong>${l}:</strong> ${v(val)}</div>`).join('');
        const loginLine   = user.loginLink   ? `<div><strong>Login:</strong> <a href="${user.loginLink}" target="_blank">Login as User</a></div>` : '';
        const profileLine = user.profileLink ? `<div><strong>Profile:</strong> <a href="${user.profileLink}" target="_blank">Open Full Profile</a></div>` : '';
        const noteHtml = `<div style="font-family:system-ui,sans-serif;font-size:13px;line-height:1.8;"><h4 style="margin:0 0 8px;font-size:14px;">👤 Member Details</h4>${lines}${loginLine}${profileLine}</div>`;
        const { ok } = await api.postNote(String(ticketId), noteHtml);
        memberNoteBtn.disabled = false; memberNoteBtn.textContent = '📋 Post Member Note';
        if (ok) {
          showToast('✅ Member note posted!', 'success');
          refresh();
        } else {
          showToast('❌ Failed to post note.', 'error');
        }
      });
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
        tr.innerHTML = `<th style="padding:4px 6px;text-align:left;color:#aaa;font-weight:500;font-size:14px;white-space:nowrap;">${label}</th><td style="padding:4px 6px;color:#333;font-size:14px;word-break:break-all;">${val}</td>`;
        uTable.appendChild(tr);
      });
      tabContent.appendChild(uTable);
    };

    const renderReservationsList = (reservations) => {
      if (!reservations || !reservations.length) return '<div style="color:#888;font-size:14px;">No reservations found.</div>';
      let html = '';
      reservations.forEach((r) => {
        const sc = r.status && r.status.toLowerCase().includes('confirm') ? '#28a745'
                 : r.status && r.status.toLowerCase().includes('cancel')  ? '#6c757d'
                 : r.status && r.status.toLowerCase().includes('fail')    ? '#dc3545' : '#007bff';
        html += `<div data-bookingid="${r.bookingId}" style="padding:7px 9px;border:1px solid #eee;border-radius:4px;margin-bottom:5px;cursor:pointer;font-size:14px;background:#fff;">`;
        html += `<div style="display:flex;justify-content:space-between;align-items:center;">`;
        html += `<span><strong>#${r.bookingId}</strong> <span style="color:#666;font-size:12px;">${r.type || ''}</span></span>`;
        html += `<span style="color:${sc};font-size:12px;font-weight:600;">${r.status || ''}</span>`;
        html += `</div><div style="font-size:12px;color:#666;margin-top:2px;">${r.guest || ''}`;
        if (r.checkIn) html += ` · ${r.checkIn} → ${r.checkOut}`;
        html += `</div></div>`;
      });
      return html;
    };

    const showReservationsTab = () => withPanelBusy(async () => {
      setActive(resTab);
      if (!user.id) { tabContent.innerHTML = '<div style="color:#999;font-size:11px;">No user ID.</div>'; return; }
      let reservations = userReservationsCache.get(String(user.id));
      if (!reservations) {
        tabContent.innerHTML = '<div style="color:#999;font-size:11px;">⏳ Loading...</div>';
        const { ok, data } = await api.userReservations(user.id);
        if (!ok) { tabContent.innerHTML = '<div style="color:red;font-size:11px;">Failed to load.</div>'; return; }
        reservations = data.reservations || [];
        userReservationsCache.set(String(user.id), reservations);
      }
      tabContent.innerHTML = renderReservationsList(reservations);
      tabContent.querySelectorAll('[data-bookingid]').forEach((el) => {
        el.onmouseover = () => { el.style.background = '#f5f5f5'; };
        el.onmouseout  = () => { el.style.background = '#fff'; };
        el.onclick = () => withPanelBusy(async () => {
          const bid = el.dataset.bookingid;
          el.style.opacity = '0.5';
          el.style.background = '#fffbe6';
          const prevText = el.querySelector('strong')?.textContent;
          if (prevText) el.querySelector('strong').textContent = prevText + ' ⏳';
          const { ok, data } = await api.guided.booking(bid);
          if (!ok || !data.bookingData) {
            el.style.opacity = '1'; el.style.background = '#fff';
            if (prevText) el.querySelector('strong').textContent = prevText;
            showToast('Booking not found.', 'error');
            return;
          }
          const prev = ticketBookingCache.get(String(ticketId)) || {};
          ticketBookingCache.set(String(ticketId), { ...prev, bookingId: bid, bookingData: data.bookingData });
          ticketDuplicatesCache.delete(String(ticketId));
          refreshNativeInjections();
        });
      });
    });

    profileTab.onclick = showProfileTab;
    resTab.onclick = showReservationsTab;
    showProfileTab();
  } else {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.cssText = 'color:#999;font-size:14px;margin-bottom:8px;';
    emptyMsg.textContent = 'No member data.';
    sec.appendChild(emptyMsg);
  }

  // Find member toggle (always shown)
  const findRow = document.createElement('div');
  findRow.style.cssText = 'display:none;gap:6px;margin-top:6px;';
  const findInput = document.createElement('input');
  findInput.type = 'text'; findInput.placeholder = 'Email or name...';
  findInput.style.cssText = 'flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:4px;font-size:14px;';
  const findBtn = document.createElement('button');
  findBtn.textContent = '🔍 Search';
  findBtn.style.cssText = 'padding:6px 12px;border:none;border-radius:4px;background:#6f42c1;color:#fff;font-size:14px;cursor:pointer;';
  const findResults = document.createElement('div');
  findResults.style.cssText = 'margin-top:6px;font-size:14px;';
  findBtn.onclick = () => withPanelBusy(async () => {
    const q = findInput.value.trim(); if (!q) return;
    findBtn.disabled = true; findBtn.textContent = '⏳';
    const { ok, data } = await api.findUser(q);
    findBtn.disabled = false; findBtn.textContent = '🔍 Search';
    findResults.innerHTML = '';
    const results = (ok && data.results) ? data.results : [];
    if (!results.length) { findResults.textContent = 'No results.'; return; }
    results.slice(0, 5).forEach((u) => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:5px 0;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between;gap:8px;';
      const lbl = document.createElement('span');
      lbl.style.cssText = 'color:#333;font-size:14px;';
      lbl.textContent = `${u.name || ''}${u.email ? ' — ' + u.email : ''}`;
      const pickBtn = document.createElement('button');
      pickBtn.textContent = 'Select';
      pickBtn.style.cssText = 'padding:4px 9px;border:1px solid #6f42c1;border-radius:3px;background:#fff;color:#6f42c1;font-size:12px;cursor:pointer;flex-shrink:0;';
      pickBtn.onclick = () => {
        const isPrimary = !u.type || u.type === 'primary';
        const picked = isPrimary
          ? { ...u, loginLink: `${TA_BASE}/admin/account/webadminCustomerLogin/${u.id}`, profileLink: `${TA_BASE}/admin/account/viewCustomer/${u.id}` }
          : { ...u };
        if (!isPrimary) showToast('Picked a secondary traveler — no Login-as-User available.', 'info', 2500);
        panelUserOverride.set(String(ticketId), picked);
        refreshNativeInjections();
      };
      item.appendChild(lbl); item.appendChild(pickBtn);
      findResults.appendChild(item);
    });
  });
  findInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') findBtn.click(); });
  findRow.appendChild(findInput); findRow.appendChild(findBtn);

  const findToggle = document.createElement('button');
  findToggle.textContent = '🔍 Find member';
  findToggle.style.cssText = 'margin-top:10px;padding:4px 10px;border:1px dashed #aaa;border-radius:4px;background:transparent;color:#888;font-size:12px;cursor:pointer;';
  findToggle.onclick = () => {
    const open = findRow.style.display !== 'none';
    findRow.style.display = open ? 'none' : 'flex';
    if (!open) setTimeout(() => findInput.focus(), 10);
  };
  sec.appendChild(findToggle);
  sec.appendChild(findRow);
  sec.appendChild(findResults);

  body.appendChild(sec);
}

function injectReplyBarButtons() {
  const bar = document.querySelector('ul.reply-bar');
  if (!bar) return;
  if (document.getElementById(REPLY_CUSTOMER_LI_ID)) return;

  const mkLi = (id, label, color, onClick) => {
    const li = document.createElement('li');
    li.id = id;
    li.className = 'reply-bar__item';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nucleus-button nucleus-button--secondary app-icon-btn--text';
    btn.style.cssText = 'color:' + color + ';';
    btn.textContent = label;
    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
    li.appendChild(btn);
    return li;
  };

  bar.appendChild(mkLi(REPLY_CUSTOMER_LI_ID, '💬 Reply Customer', '#1976d2', () => openMimickedComposer('customer')));
  bar.appendChild(mkLi(REPLY_SUPPLIER_LI_ID, '🏨 Reply Supplier', '#6f42c1', () => openMimickedComposer('supplier')));
}

// Inject "Reply Customer" / "Reply Supplier" tabs into FD's composer toolbar
// (.ticket-actions-list — only present when the composer is open). Clicking
// a tab opens our mimicked composer (a floating modal) so we control To:,
// template body, signature, and send via /api/_/tickets/{id}/reply.
function injectReplyComposerTabs() {
  const list = document.querySelector('.ticket-actions-list');
  if (!list) return;
  if (list.querySelector('.ta-reply-customer-tab')) return;

  const mkTab = (cls, label, color, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ticket-action-button element-flex gap-4 justify-content--space-between ' + cls;
    b.style.cssText = 'color:' + color + ';';
    b.innerHTML = '<span style="font-size:14px;">✉️</span> ' + label;
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
    return b;
  };

  list.appendChild(mkTab('ta-reply-customer-tab', 'Reply Customer', '#1976d2', () => openMimickedComposer('customer')));
  list.appendChild(mkTab('ta-reply-supplier-tab', 'Reply Supplier', '#6f42c1', () => openMimickedComposer('supplier')));
}

// Insert a 🌐 Translate button into FD's composer footer, immediately before
// the Send button. Click translates whatever the agent typed into FD's own
// contenteditable in-place (preserves original below a divider).
function injectTranslateNearSend() {
  const wrapper = document.querySelector('.ticket-editor__footer .reply-btn-wrapper');
  if (!wrapper) return;
  if (wrapper.querySelector('.ta-translate-near-send')) return;
  const replyBtn = wrapper.querySelector('.reply-btn');
  if (!replyBtn) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ta-translate-near-send';
  btn.title = 'Translate the current draft';
  btn.textContent = '🌐 Translate';
  btn.style.cssText = 'background:#fff;border:1px solid #17a2b8;color:#17a2b8;padding:6px 12px;border-radius:4px;font-size:13px;font-weight:500;cursor:pointer;margin-right:8px;';
  btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); translateFdComposer(); };

  wrapper.insertBefore(btn, replyBtn);
}

// Floating mimicked composer — opens via the reply-customer/supplier tabs.
// Reuses showReplyComposer for the body, mounted into a draggable modal.
// Customer replies work without a booking (member fallback via cached.userData);
// supplier replies require booking data (supplier email comes from it).
function openMimickedComposer(recipientType) {
  const tid = getFreshdeskTicketId();
  if (!tid) { showToast('No ticket on this page.', 'error'); return; }
  const cached = ticketBookingCache.get(String(tid));
  if (cached === undefined) {
    showToast('Loading details — try again in a moment.', 'warning');
    return;
  }

  const bookingData = cached?.bookingData || null;
  const userFallback = cached?.userData || null;

  let booking = {};
  let details = {};
  let user    = {};
  let supplier = null;
  if (bookingData) {
    booking  = bookingData.booking  || {};
    details  = bookingData.details  || {};
    user     = bookingData.user     || userFallback || {};
    supplier = bookingData.supplier || null;
  } else if (userFallback) {
    user = userFallback;
  }

  // Resolve To:
  let toEmail = '';
  if (recipientType === 'supplier') {
    toEmail = supplier?.email || '';
    if (!toEmail) {
      showToast('No supplier email — needs booking data with a supplier match.', 'warning');
      return;
    }
  } else {
    toEmail = user?.email || '';
    if (!toEmail) {
      showToast('No customer email found for this ticket.', 'warning');
      return;
    }
  }

  const titleEmoji = recipientType === 'supplier' ? '🏨' : '💬';
  const titleText  = recipientType === 'supplier' ? 'Reply to Supplier' : 'Reply to Customer';
  const { modal, body } = createModal('taMimickedComposer', titleEmoji + ' ' + titleText, {
    style: 'top:60px;left:50%;transform:translateX(-50%);width:680px;max-width:95vw;max-height:88vh;',
    bodyStyle: 'padding:14px 18px;',
  });
  trapKeyEventsForModal(modal);

  showReplyComposer({
    recipientType,
    toEmail,
    booking,
    details,
    user,
    supplier,
    body,
    ticketId: String(tid),
    onSent: () => { modal.remove(); },
  });
}

// Translate the current FD composer draft in-place. Target language defaults
// to the customer's detected country language (if available), otherwise
// prompts. Preserves the original below a divider.
async function translateFdComposer() {
  const editor = document.querySelector('.fr-element.fr-view[contenteditable="true"]');
  if (!editor) { showToast('Composer is not open.', 'warning'); return; }
  const text = (editor.innerText || '').trim();
  if (!text) { showToast('Nothing to translate.', 'warning'); return; }

  const tid = getFreshdeskTicketId();
  const cached = ticketBookingCache.get(String(tid));
  const country = cached?.bookingData?.user?.country || cached?.userData?.country || null;
  const detected = country ? countryToLanguage(country) : null;
  const target = prompt('Target language (ISO code or name):', detected || 'en');
  if (!target) return;

  // Strip sign-off + signature before sending to the API to avoid translating
  // boilerplate phone numbers and links.
  const signOffRe = /^\s*(sincerely|best\s+regards?|kind\s+regards?|regards|best|thanks|thank\s+you|warm\s+regards?|yours\s+sincerely|with\s+(?:best\s+)?regards?|cheers|yours\s+truly|faithfully)[,.]?\s*$/i;
  const lines = text.split('\n');
  let cutIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) { if (signOffRe.test(lines[i])) { cutIdx = i; break; } }
  const textToTranslate = lines.slice(0, cutIdx).join('\n').trim() || text;

  const originalHtml = editor.innerHTML;
  const { ok, data } = await api.translate(textToTranslate, target);
  if (!ok || !data?.text) { showToast('Translation failed.', 'error'); return; }
  const translatedHtml = data.text.replace(/\n/g, '<br>');
  editor.innerHTML =
    '<div><span style="font-size:10px;color:#00897b;font-weight:600;">🌐 ' + target + '</span></div>' +
    translatedHtml +
    '<br><hr style="border:none;border-top:1px solid #ddd;margin:8px 0;">' +
    '<div><span style="font-size:10px;color:#aaa;font-weight:600;">📄 Original</span></div>' +
    originalHtml;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  showToast('Translated to ' + target + '.', 'success');
}

function injectDuplicateStrip() {
  if (document.getElementById(DUP_STRIP_ID)) return;
  // Anchor before the reply bar (composer closed) OR the editor (composer
  // open) — whichever is present — so the strip stays visible in both states.
  const anchor = document.querySelector('.reply-bar-wrapper')
              || document.querySelector('.ticket-editor');
  if (!anchor || !anchor.parentElement) return;

  const strip = document.createElement('div');
  strip.id = DUP_STRIP_ID;
  strip.style.cssText =
    'margin:12px 0;padding:12px 16px;background:#fff8e1;border:1px solid #ffe082;' +
    'border-radius:8px;font-family:system-ui,sans-serif;font-size:12px;color:#5d4037;' +
    'width:100%;box-sizing:border-box;';
  strip.innerHTML = '<div id="' + DUP_STRIP_ID + '_content">—</div>';
  anchor.parentElement.insertBefore(strip, anchor);
  refreshDuplicateStrip();
}

function refreshDuplicateStrip() {
  const content = document.getElementById(DUP_STRIP_ID + '_content');
  if (!content) return;
  const ticketId = getFreshdeskTicketId();
  if (!ticketId) { content.textContent = '—'; return; }
  const cached = ticketBookingCache.get(String(ticketId));
  if (cached === undefined) {
    // Not prewarmed yet — still expose manual search.
    renderDuplicates(content, [], ticketId, { emptyMessage: 'No info loaded yet.' });
    return;
  }

  // Collect anything we can auto-search on. Falls back to member-only email
  // when there's no booking. When even that's missing we still render the
  // manual search bar via renderDuplicates with an empty result set.
  const booking = cached?.bookingData?.booking;
  const user    = cached?.bookingData?.user;
  const vendorConf  = booking?.supplierId || null;
  const internalId  = booking?.internalBookingId || null;
  const memberEmail = user?.email || cached?.userData?.email || null;

  if (vendorConf || internalId || memberEmail) {
    kickDuplicateSearch(ticketId, vendorConf, internalId, memberEmail, content);
  } else {
    renderDuplicates(content, [], ticketId, {
      emptyMessage: 'No booking or member to auto-search — use manual search below.',
    });
  }
}

// Fires /check-duplicates if not already cached; renders results into `content`.
function kickDuplicateSearch(ticketId, vendorConf, internalId, memberEmail, content) {
  const tid = String(ticketId);
  const existing = ticketDuplicatesCache.get(tid);
  if (existing === 'loading') {
    renderDuplicates(content, [], ticketId, { emptyMessage: 'Searching Freshdesk…' });
    return;
  }
  if (Array.isArray(existing)) {
    renderDuplicates(content, existing, ticketId);
    return;
  }
  renderDuplicates(content, [], ticketId, { emptyMessage: 'Searching Freshdesk…' });
  ticketDuplicatesCache.set(tid, 'loading');
  api.checkDuplicates({ vendorConf, internalId, memberEmail, freshdeskTicketId: ticketId }).then(({ ok, data }) => {
    const dups = ok ? (data?.duplicates || []) : [];
    ticketDuplicatesCache.set(tid, dups);
    // Only re-render if user is still on this ticket
    if (String(getFreshdeskTicketId()) === tid) {
      const live = document.getElementById(DUP_STRIP_ID + '_content');
      if (live) renderDuplicates(live, dups, ticketId);
    }
  });
}

function renderDuplicates(content, dups, currentTicketId, opts = {}) {
  content.innerHTML = '';
  if (!dups.length) {
    const noRes = document.createElement('div');
    const isInfo = !!opts.emptyMessage;
    noRes.style.cssText = `color:${isInfo ? '#856404' : '#28a745'};font-weight:500;margin-bottom:6px;`;
    noRes.textContent = opts.emptyMessage || '✓ No open/pending tickets found.';
    content.appendChild(noRes);
  } else {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-weight:700;font-size:16px;color:#856404;margin-bottom:10px;letter-spacing:0.2px;';
    hdr.textContent = `⚠️ ${dups.length} Open/Pending ticket${dups.length > 1 ? 's' : ''} found`;
    content.appendChild(hdr);
    dups.forEach((dup) => content.appendChild(buildStripDupRow(dup, currentTicketId)));
  }

  // ── Manual search bar (Guided parity) ────────────────────────────────────
  const divider = document.createElement('div');
  divider.style.cssText = 'border-top:1px solid #eee;margin:10px 0 8px;';
  content.appendChild(divider);

  const searchRow = document.createElement('div');
  searchRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search tickets to merge…';
  searchInput.style.cssText = 'flex:1;min-width:140px;padding:3px 8px;border:1px solid #ddd;border-radius:4px;font-size:11px;';
  const closedChk = document.createElement('input');
  closedChk.type = 'checkbox';
  closedChk.id = 'taStripDupClosed_' + currentTicketId;
  const closedLbl = document.createElement('label');
  closedLbl.htmlFor = closedChk.id;
  closedLbl.textContent = 'incl. closed';
  closedLbl.style.cssText = 'font-size:11px;color:#6c757d;white-space:nowrap;cursor:pointer;user-select:none;';
  const searchBtn = document.createElement('button');
  searchBtn.textContent = '🔍 Search';
  searchBtn.style.cssText = 'padding:3px 10px;border:none;border-radius:4px;background:#6f42c1;color:#fff;font-size:11px;cursor:pointer;';
  const manualResults = document.createElement('div');
  manualResults.style.cssText = 'width:100%;margin-top:6px;';

  const doSearch = async () => {
    const q = searchInput.value.trim();
    if (!q) return;
    searchBtn.disabled = true; searchBtn.textContent = '⏳';
    const { ok, data } = await api.searchTickets({
      query: q,
      includeClosed: closedChk.checked,
      freshdeskTicketId: String(currentTicketId),
    });
    searchBtn.disabled = false; searchBtn.textContent = '🔍 Search';
    manualResults.innerHTML = '';
    const found = (ok && data?.duplicates) ? data.duplicates : [];
    if (!found.length) {
      manualResults.innerHTML = '<div style="color:#999;font-size:11px;padding:2px 0;">No results.</div>';
      return;
    }
    found.forEach((dup) => manualResults.appendChild(buildStripDupRow(dup, currentTicketId)));
  };
  searchBtn.onclick = doSearch;
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  searchRow.appendChild(searchInput);
  searchRow.appendChild(closedChk);
  searchRow.appendChild(closedLbl);
  searchRow.appendChild(searchBtn);
  content.appendChild(searchRow);
  content.appendChild(manualResults);
}

// Row factory mirroring the Guided modal's buildDupRow. Self-contained so the
// strip can render without the Guided modal's enclosing state.
function buildStripDupRow(dup, currentTicketId) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f5f5f5;flex-wrap:wrap;';
  const assigneeName = dup.responder_name || (dup.responder_id ? `#${dup.responder_id}` : '—');
  const statusInfo = (() => {
    switch (dup.status) {
      case 2: return { label: 'Open',     bg: '#e8f4ff', fg: '#0056d2' };
      case 3: return { label: 'Pending',  bg: '#fff3cd', fg: '#856404' };
      case 4: return { label: 'Resolved', bg: '#e6f4ea', fg: '#1e7e34' };
      case 5: return { label: 'Closed',   bg: '#f1f3f5', fg: '#6c757d' };
      default: return dup.status != null ? { label: `Status ${dup.status}`, bg: '#f1f3f5', fg: '#6c757d' } : null;
    }
  })();
  const statusBadge = statusInfo
    ? `<span style="background:${statusInfo.bg};color:${statusInfo.fg};font-size:11px;font-weight:600;padding:2px 8px;border-radius:8px;white-space:nowrap;">${statusInfo.label}</span>`
    : '';
  const priorityInfo = (() => {
    switch (dup.priority) {
      case 1: return { label: 'Low',    bg: '#f1f3f5', fg: '#6c757d' };
      case 2: return { label: 'Medium', bg: '#e8f4ff', fg: '#0056d2' };
      case 3: return { label: 'High',   bg: '#ffe8d6', fg: '#b35200' };
      case 4: return { label: 'Urgent', bg: '#fde2e2', fg: '#c82333' };
      default: return null;
    }
  })();
  const priorityBadge = priorityInfo
    ? `<span style="background:${priorityInfo.bg};color:${priorityInfo.fg};font-size:11px;font-weight:600;padding:2px 8px;border-radius:8px;white-space:nowrap;" title="Priority">${priorityInfo.label}</span>`
    : '';

  // Matched-by — show the actual matched value (the real booking ID / supplier
  // ref / member email) rather than the generic label. Values come from the
  // current ticket's cached booking.
  const matchCache = ticketBookingCache.get(String(currentTicketId));
  const mb = matchCache?.bookingData?.booking || {};
  const mu = matchCache?.bookingData?.user || matchCache?.userData || {};
  const matchValueMap = {
    'booking id':   mb.internalBookingId,
    'supplier ref': mb.supplierId,
    'member email': mu.email,
  };
  const matchedValues = (dup.matchedBy || []).map((label) =>
    matchValueMap[String(label).toLowerCase()] || label
  );
  const matchedBadge = matchedValues.length
    ? `<span style="background:#fff3cd;color:#856404;font-size:12px;font-weight:600;padding:3px 9px;border-radius:8px;white-space:nowrap;" title="Matched on">🔗 ${matchedValues.join(' · ').replace(/</g,'&lt;')}</span>`
    : '';

  row.innerHTML = `<a href="https://${window.location.hostname}/a/tickets/${dup.id}" target="_blank" style="color:#007bff;font-weight:600;font-size:14px;white-space:nowrap;">#${dup.id}</a><span style="flex:1;color:#444;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:120px;">${(dup.subject||'—').replace(/</g,'&lt;')}</span>${statusBadge}${priorityBadge}<span style="color:#6f42c1;font-size:12px;white-space:nowrap;font-weight:500;" title="Assigned to">${assigneeName}</span>${matchedBadge}`;

  const previewBtn = document.createElement('button');
  previewBtn.textContent = 'Merge In';
  previewBtn.style.cssText = 'padding:3px 8px;border:1px solid #fd7e14;border-radius:4px;background:#fff;color:#fd7e14;font-size:11px;cursor:pointer;flex-shrink:0;font-weight:500;';
  previewBtn.onclick = () => showStripDupPreviewModal(dup, currentTicketId, previewBtn);
  const mergeOutBtn = document.createElement('button');
  mergeOutBtn.textContent = '📤 Merge out';
  mergeOutBtn.style.cssText = 'padding:3px 8px;border:1px solid #6c757d;border-radius:4px;background:#fff;color:#6c757d;font-size:11px;cursor:pointer;flex-shrink:0;font-weight:500;';
  mergeOutBtn.onclick = () => showStripDupMergeOutModal(dup, currentTicketId, mergeOutBtn);
  row.appendChild(previewBtn);
  row.appendChild(mergeOutBtn);
  return row;
}

// Merge In: shows the duplicate's messages, each with "Merge into #{current}".
async function showStripDupPreviewModal(dup, currentTicketId, triggerBtn) {
  triggerBtn.disabled = true; triggerBtn.textContent = '⏳';
  const { ok, data: td } = await api.guided.ticket(dup.id);
  triggerBtn.disabled = false; triggerBtn.textContent = 'Merge In';
  if (!ok || !td?.ticket) { showToast('Could not load ticket.', 'error'); return; }

  const pop = document.createElement('div');
  pop.style.cssText = 'position:fixed;top:8%;left:50%;transform:translateX(-50%);width:660px;max-width:92vw;height:78vh;min-width:380px;min-height:300px;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.3);z-index:1000001;font-family:system-ui,sans-serif;display:flex;flex-direction:column;resize:both;overflow:hidden;';
  const popHeader = document.createElement('div');
  popHeader.style.cssText = 'padding:10px 14px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:#fff8f0;border-radius:10px 10px 0 0;';
  const popTitle = document.createElement('span');
  popTitle.style.cssText = 'font-weight:600;font-size:13px;color:#333;';
  popTitle.textContent = `#${dup.id} — ${td.ticket.subject || ''}`;
  const popSubtitle = document.createElement('span');
  popSubtitle.style.cssText = 'font-size:11px;color:#888;margin-left:8px;';
  popSubtitle.textContent = '← click a message to merge it into #' + currentTicketId;
  const popClose = document.createElement('button');
  popClose.textContent = '×'; popClose.style.cssText = 'background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;margin-left:8px;';
  popClose.onclick = () => pop.remove();
  const titleWrap = document.createElement('div');
  titleWrap.style.cssText = 'display:flex;align-items:center;min-width:0;overflow:hidden;';
  titleWrap.appendChild(popTitle); titleWrap.appendChild(popSubtitle);
  popHeader.appendChild(titleWrap); popHeader.appendChild(popClose);

  const popBody = document.createElement('div');
  popBody.style.cssText = 'padding:12px 14px;overflow-y:auto;flex:1;font-size:12px;color:#555;line-height:1.6;';

  const strip = (html) => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) + ' ' + d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  };
  const popAgents = td.agents || {};

  const addMsg = (label, bg, border, bodyHtml, meta) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = `margin-bottom:10px;padding:8px 10px;background:${bg};border-left:3px solid ${border};border-radius:3px;font-size:12px;line-height:1.5;`;
    const lbl = document.createElement('div');
    lbl.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;flex-wrap:wrap;gap:4px;';
    const typeWrap = document.createElement('div');
    const lblText = document.createElement('span');
    lblText.style.cssText = 'font-size:10px;color:#999;font-weight:600;';
    lblText.textContent = label;
    typeWrap.appendChild(lblText);
    if (meta) {
      const metaParts = [meta.author, meta.date].filter(Boolean);
      if (metaParts.length) {
        const metaEl = document.createElement('div');
        metaEl.style.cssText = 'font-size:10px;color:#aaa;margin-top:1px;';
        metaEl.textContent = metaParts.join(' · ');
        typeWrap.appendChild(metaEl);
      }
      if (meta.notified && meta.notified.length) {
        const notifEl = document.createElement('div');
        notifEl.style.cssText = 'font-size:10px;color:#aaa;margin-top:1px;';
        notifEl.textContent = '→ ' + meta.notified.join(', ');
        typeWrap.appendChild(notifEl);
      }
    }
    const mergeBtn = document.createElement('button');
    mergeBtn.textContent = '📥 Merge into #' + currentTicketId;
    mergeBtn.style.cssText = 'padding:2px 8px;border:1px solid #fd7e14;border-radius:4px;background:#fff;color:#fd7e14;font-size:10px;cursor:pointer;font-weight:600;flex-shrink:0;';
    mergeBtn.onclick = async () => {
      if (!confirm(`Post this message as a note on #${currentTicketId} and close #${dup.id}?`)) return;
      mergeBtn.disabled = true; mergeBtn.textContent = '⏳ Merging...';
      const { ok: mok, data: mr } = await api.mergeTicket({
        sourceTicketId: String(dup.id),
        targetTicketId: String(currentTicketId),
        description: bodyHtml,
      });
      if (mok) {
        pop.remove();
        showToast(`✅ Merged from #${dup.id} — it has been closed.`, 'success', 3000);
        ticketDuplicatesCache.delete(String(currentTicketId));
        refreshNativeInjections();
      } else {
        showToast('❌ Merge failed: ' + (mr?.error || 'Server error'), 'error');
        mergeBtn.disabled = false; mergeBtn.textContent = '📥 Merge into #' + currentTicketId;
      }
    };
    lbl.appendChild(typeWrap); lbl.appendChild(mergeBtn);
    const content = document.createElement('div');
    content.innerHTML = bodyHtml;
    wrap.appendChild(lbl); wrap.appendChild(content);
    popBody.appendChild(wrap);
  };

  const desc = td.ticket.description || td.ticket.description_text || '';
  if (desc) {
    addMsg('📩 Customer (opening)', '#f8f9fa', '#6c757d', td.ticket.description || strip(desc), {
      author: td.ticket.requester?.name || td.ticket.requester?.email || null,
      date: fmtDate(td.ticket.created_at),
      notified: [],
    });
  }
  (td.conversations || []).forEach((c) => {
    const isNote = c.private;
    const isIncoming = !isNote && c.incoming;
    const label  = isNote ? '📌 Agent note' : isIncoming ? '📩 Customer' : '📤 Agent reply';
    const bg     = isNote ? '#fffbf0' : isIncoming ? '#f8f9fa' : '#f0f4ff';
    const border = isNote ? '#fd7e14' : isIncoming ? '#6c757d' : '#0056d2';
    const author = isIncoming ? (c.from_email || null) : (popAgents[c.user_id] || c.from_email || null);
    addMsg(label, bg, border, c.body || strip(c.body_text || ''), {
      author, date: fmtDate(c.created_at), notified: c.to_emails || [],
    });
  });
  if (!popBody.children.length) popBody.innerHTML = '<span style="color:#999;">(no content)</span>';
  pop.appendChild(popHeader); pop.appendChild(popBody);
  document.body.appendChild(pop);
  trapKeyEventsForModal(pop);
  makeDraggable(pop, popHeader);
}

// Merge out: select a message from the current ticket, edit, then post it on
// the duplicate and close the current ticket.
async function showStripDupMergeOutModal(dup, currentTicketId, triggerBtn) {
  triggerBtn.disabled = true; triggerBtn.textContent = '⏳';
  const { ok, data: td } = await api.guided.ticket(currentTicketId);
  triggerBtn.disabled = false; triggerBtn.textContent = '📤 Merge out';
  if (!ok || !td?.ticket) { showToast('Could not load current ticket.', 'error'); return; }

  const pop = document.createElement('div');
  pop.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:660px;max-width:92vw;max-height:82vh;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.3);z-index:1000001;font-family:system-ui,sans-serif;display:flex;flex-direction:column;';
  const popHeader = document.createElement('div');
  popHeader.style.cssText = 'padding:10px 14px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:#f8f9fa;border-radius:10px 10px 0 0;';
  const popTitle = document.createElement('span');
  popTitle.style.cssText = 'font-weight:600;font-size:13px;color:#333;';
  popTitle.textContent = `Merge #${currentTicketId} → #${dup.id}`;
  const popSubtitle = document.createElement('span');
  popSubtitle.style.cssText = 'font-size:11px;color:#888;margin-left:8px;';
  popSubtitle.textContent = '← select a message, edit if needed, then confirm';
  const popClose = document.createElement('button');
  popClose.textContent = '×'; popClose.style.cssText = 'background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;margin-left:8px;';
  popClose.onclick = () => pop.remove();
  const titleWrap = document.createElement('div');
  titleWrap.style.cssText = 'display:flex;align-items:center;min-width:0;overflow:hidden;';
  titleWrap.appendChild(popTitle); titleWrap.appendChild(popSubtitle);
  popHeader.appendChild(titleWrap); popHeader.appendChild(popClose);

  const popBody = document.createElement('div');
  popBody.style.cssText = 'padding:12px 14px;overflow-y:auto;flex:1;font-size:12px;color:#555;line-height:1.6;';

  const editorArea = document.createElement('div');
  editorArea.style.cssText = 'padding:10px 14px;border-top:2px solid #fd7e14;flex-shrink:0;background:#fffbf0;';
  const editorLabel = document.createElement('div');
  editorLabel.style.cssText = 'font-size:11px;color:#888;margin-bottom:4px;font-weight:600;';
  editorLabel.textContent = `Note to post on #${dup.id}:`;
  const editorEl = document.createElement('div');
  editorEl.contentEditable = 'true';
  editorEl.style.cssText = 'min-height:60px;max-height:150px;overflow-y:auto;border:1px solid #ddd;border-radius:4px;padding:6px 8px;font-size:12px;background:#fff;outline:none;';
  editorEl.innerHTML = '<span style="color:#aaa;font-style:italic;">Select a message above…</span>';
  const editorActions = document.createElement('div');
  editorActions.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;margin-top:6px;';
  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = `📤 Merge out → #${dup.id}`;
  confirmBtn.style.cssText = 'padding:4px 12px;border:none;border-radius:4px;background:#6c757d;color:#fff;font-size:11px;cursor:pointer;font-weight:600;';
  confirmBtn.onclick = async () => {
    const bodyToPost = editorEl.innerHTML;
    if (!bodyToPost || bodyToPost.includes('Select a message above')) { showToast('Select a message first.', 'error'); return; }
    if (!confirm(`Merge #${currentTicketId} into #${dup.id}? This will post a note on #${dup.id} and close #${currentTicketId}.`)) return;
    confirmBtn.disabled = true; confirmBtn.textContent = '⏳ Merging...';
    const { ok: mok, data: mr } = await api.mergeTicket({
      sourceTicketId: String(currentTicketId), targetTicketId: String(dup.id), description: bodyToPost,
    });
    if (mok) {
      pop.remove();
      showToast(`✅ Merged #${currentTicketId} into #${dup.id} — ticket closed.`, 'success', 3000);
      ticketDuplicatesCache.delete(String(currentTicketId));
      refreshNativeInjections();
    } else {
      showToast('❌ Merge failed: ' + (mr?.error || 'Server error'), 'error');
      confirmBtn.disabled = false; confirmBtn.textContent = `📤 Merge out → #${dup.id}`;
    }
  };
  editorActions.appendChild(confirmBtn);
  editorArea.appendChild(editorLabel); editorArea.appendChild(editorEl); editorArea.appendChild(editorActions);

  const moStrip = (html) => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const moAgents = td.agents || {};
  const moFmt = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) + ' ' + d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  };
  const addSelect = (label, bg, border, bodyHtml, meta) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = `margin-bottom:10px;padding:8px 10px;background:${bg};border-left:3px solid ${border};border-radius:3px;font-size:12px;line-height:1.5;cursor:pointer;transition:box-shadow 0.1s;`;
    wrap.onmouseenter = () => { wrap.style.boxShadow = '0 0 0 2px #fd7e14'; };
    wrap.onmouseleave = () => { wrap.style.boxShadow = ''; };
    const lbl = document.createElement('div');
    lbl.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;flex-wrap:wrap;gap:4px;';
    const typeWrap = document.createElement('div');
    const lblText = document.createElement('span');
    lblText.style.cssText = 'font-size:10px;color:#999;font-weight:600;';
    lblText.textContent = label;
    typeWrap.appendChild(lblText);
    if (meta) {
      const metaParts = [meta.author, meta.date].filter(Boolean);
      if (metaParts.length) {
        const metaEl = document.createElement('div');
        metaEl.style.cssText = 'font-size:10px;color:#aaa;margin-top:1px;';
        metaEl.textContent = metaParts.join(' · ');
        typeWrap.appendChild(metaEl);
      }
    }
    const useBtn = document.createElement('button');
    useBtn.textContent = '✏️ Use this';
    useBtn.style.cssText = 'padding:2px 8px;border:1px solid #fd7e14;border-radius:4px;background:#fff;color:#fd7e14;font-size:10px;cursor:pointer;font-weight:600;flex-shrink:0;';
    useBtn.onclick = (e) => { e.stopPropagation(); editorEl.innerHTML = bodyHtml; editorEl.scrollIntoView({ behavior:'smooth', block:'nearest' }); };
    lbl.appendChild(typeWrap); lbl.appendChild(useBtn);
    const content = document.createElement('div');
    content.innerHTML = bodyHtml;
    wrap.appendChild(lbl); wrap.appendChild(content);
    wrap.onclick = () => { editorEl.innerHTML = bodyHtml; editorEl.scrollIntoView({ behavior:'smooth', block:'nearest' }); };
    popBody.appendChild(wrap);
  };

  const moDesc = td.ticket.description || td.ticket.description_text || '';
  if (moDesc) {
    addSelect('📩 Customer (opening)', '#f8f9fa', '#6c757d', td.ticket.description || moStrip(moDesc), {
      author: td.ticket.requester?.name || td.ticket.requester?.email || null,
      date: moFmt(td.ticket.created_at),
    });
  }
  (td.conversations || []).forEach((c) => {
    const isNote = c.private;
    const isIncoming = !isNote && c.incoming;
    const label  = isNote ? '📌 Agent note' : isIncoming ? '📩 Customer' : '📤 Agent reply';
    const bg     = isNote ? '#fffbf0' : isIncoming ? '#f8f9fa' : '#f0f4ff';
    const border = isNote ? '#fd7e14' : isIncoming ? '#6c757d' : '#0056d2';
    const author = isIncoming ? (c.from_email || null) : (moAgents[c.user_id] || c.from_email || null);
    addSelect(label, bg, border, c.body || moStrip(c.body_text || ''), {
      author, date: moFmt(c.created_at),
    });
  });
  if (!popBody.children.length) popBody.innerHTML = '<span style="color:#999;">(no content)</span>';
  pop.appendChild(popHeader); pop.appendChild(popBody); pop.appendChild(editorArea);
  document.body.appendChild(pop);
  trapKeyEventsForModal(pop);
}

// Strip quoted-email tail from a conversation body so translation only runs
// against the latest reply. Walks lines top-down, cuts at the first quote
// marker. Covers common clients (Gmail, Outlook, Apple Mail) + FR/DE/ES/IT.
function stripQuotedTail(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  // First-line patterns that mark the start of a quoted previous message.
  const quoteStart = [
    /^\s*>+\s?/,                                  // leading > quote marker
    /^\s*On\b.*\bwrote\s*:\s*$/i,                 // "On <date>, <name> wrote:"
    /^-{2,}\s*Original Message\s*-{2,}\s*$/i,     // Outlook
    /^_{5,}\s*$/,                                 // Outlook underline divider
    /^-{5,}\s*$/,                                 // generic divider line
    /^\s*From:\s+.+/i,                            // Outlook header block
    /^\s*De\s*:\s+.+/i,                           // French
    /^\s*Von\s*:\s+.+/i,                          // German
    /^\s*Le\s+\d.*\ba?\s+écrit\s*:?\s*$/i,        // French "Le <date> a écrit:"
    /^\s*El\s+\d.*\bescribió\s*:?\s*$/i,          // Spanish "El <date> escribió:"
    /^\s*Il\s+\d.*\bha\s+scritto\s*:?\s*$/i,      // Italian "Il <date> ha scritto:"
    /^\s*Am\s+\d.*\bschrieb\b.*:?\s*$/i,          // German "Am <date> schrieb ..."
    /^>+\s*$/,                                    // bare ">" delimiter
  ];
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (quoteStart.some(re => re.test(l))) { cut = i; break; }
  }
  const out = lines.slice(0, cut).join('\n').trim();
  // If we cut everything, the source was entirely a quote — fall back to full
  // text so the agent isn't left with nothing to translate.
  return out || String(text).trim();
}

// Floating popover near the source element with a read-only translation +
// copy button. Does NOT mutate the source DOM — Freshdesk re-renders if you
// touch its conversation nodes. Positioned right of the anchor; clamped to
// the viewport.
function showTranslatePopover(anchorEl, sourceText, opts) {
  opts = opts || {};
  const title = opts.title || 'Translation';
  const target = opts.target || 'en';

  // Single-instance: replace any previous popover.
  const existing = document.getElementById('taTranslatePopover');
  if (existing) existing.remove();

  const pop = document.createElement('div');
  pop.id = 'taTranslatePopover';
  pop.style.cssText = 'position:fixed;width:380px;max-width:92vw;max-height:60vh;background:#fff;border:1px solid #d0d7de;border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,0.18);z-index:1000002;font-family:' + THEME.font + ';display:flex;flex-direction:column;overflow:hidden;';

  // Anchor next to the source. Default: right of the anchor's right edge.
  const rect = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
  let top = 80;
  let left = window.innerWidth - 420;
  if (rect) {
    top = Math.max(12, Math.min(rect.top, window.innerHeight - 240));
    left = Math.min(rect.right + 12, window.innerWidth - 400);
    if (left < 12) left = 12;
  }
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';

  const head = document.createElement('div');
  head.style.cssText = 'padding:8px 12px;background:#f6f8fa;border-bottom:1px solid #e1e4e8;display:flex;align-items:center;justify-content:space-between;cursor:move;';
  const h = document.createElement('div');
  h.style.cssText = 'font-size:12px;font-weight:600;color:#444;';
  h.textContent = '🌐 ' + title + ' → ' + target;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background:none;border:none;font-size:18px;color:#888;cursor:pointer;padding:0 4px;line-height:1;';
  closeBtn.onclick = () => pop.remove();
  head.appendChild(h); head.appendChild(closeBtn);

  // Simple drag on the header.
  let dragging = false, dx = 0, dy = 0;
  head.addEventListener('mousedown', (e) => {
    if (e.target === closeBtn) return;
    dragging = true;
    const r = pop.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    pop.style.left = Math.max(0, e.clientX - dx) + 'px';
    pop.style.top  = Math.max(0, e.clientY - dy) + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  const ta = document.createElement('textarea');
  ta.readOnly = true;
  ta.style.cssText = 'flex:1;min-height:160px;padding:10px 12px;border:none;outline:none;resize:none;font-size:13px;line-height:1.55;font-family:' + THEME.font + ';background:#fff;color:#222;white-space:pre-wrap;';
  ta.value = '⏳ Translating…';

  const footer = document.createElement('div');
  footer.style.cssText = 'padding:8px 12px;border-top:1px solid #e1e4e8;display:flex;gap:8px;justify-content:flex-end;background:#fafbfc;';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = '📋 Copy';
  copyBtn.style.cssText = 'padding:5px 12px;border:1px solid ' + THEME.primary + ';border-radius:5px;background:#fff;color:' + THEME.primary + ';font-size:12px;cursor:pointer;';
  copyBtn.disabled = true;
  copyBtn.style.opacity = '0.5';
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(ta.value); showToast('Copied.', 'success', 1200); }
    catch { ta.select(); document.execCommand('copy'); showToast('Copied.', 'success', 1200); }
  };
  footer.appendChild(copyBtn);

  pop.appendChild(head);
  pop.appendChild(ta);
  pop.appendChild(footer);
  document.body.appendChild(pop);
  trapKeyEventsForModal(pop);

  // Kick off the translation. Strip quoted tail first so we only translate
  // the latest reply, not the entire quoted email chain.
  const cleanSource = stripQuotedTail(sourceText);
  api.translate(cleanSource, target).then(({ ok, data }) => {
    if (!ok || !data || !data.text) {
      ta.value = '❌ Translation failed: ' + ((data && data.error) || 'unknown');
      return;
    }
    ta.value = data.text;
    copyBtn.disabled = false; copyBtn.style.opacity = '1';
  });
}

// Per-conversation controls: clicking the header collapses/expands the
// content; 🌐 / 🤖 translate buttons live in the action container next to
// FD's Edit/Delete. Translations open in a popover/modal — never mutate
// FD's own DOM. All notes except the last two are collapsed by default.
function injectConversationControls() {
  const conversationWrappers = Array.from(document.querySelectorAll('[data-test-id="conversation-wrapper"]'));
  const description = document.querySelector('[data-test-id="ticket-description"]');
  // Last two conversations + the description stay open by default. Older
  // conversations collapse.
  const keepExpanded = new Set(conversationWrappers.slice(-2));
  if (description) keepExpanded.add(description);
  const wrappers = description ? [description, ...conversationWrappers] : conversationWrappers;
  wrappers.forEach((wrapper) => {
    if (wrapper.dataset.taControlsInjected) return;
    // Conversation wrappers use `.conversation-header` + the
    // [data-test-id="conversation-content-wrapper"]; the description wrapper
    // uses the generic `.ticket-details__item__header` + `.ticket-details__item__content`.
    const header = wrapper.querySelector('.conversation-header')
                || wrapper.querySelector('.ticket-details__item__header');
    const actions = header?.querySelector('.ticket-actions-container');
    const content = wrapper.querySelector('[data-test-id="conversation-content-wrapper"]')
                 || wrapper.querySelector('.ticket-details__item__content');
    if (!header || !content) return;

    // Click-anywhere-on-header toggle. Skips clicks on interactive children so
    // Edit/Delete/Translate buttons keep working.
    const setCollapsed = (collapsed) => {
      content.style.display = collapsed ? 'none' : '';
      wrapper.dataset.taCollapsed = collapsed ? '1' : '0';
      const chev = header.querySelector('.ta-chev');
      if (chev) chev.textContent = collapsed ? '▸' : '▾';
    };
    const toggleFromHeader = (e) => {
      if (e.target.closest('button, a, input, textarea, select, .nucleus-button')) return;
      setCollapsed(wrapper.dataset.taCollapsed !== '1');
    };
    header.style.cursor = 'pointer';
    header.addEventListener('click', toggleFromHeader);

    // Tiny chevron prepended to the sender-info span so the state is visible.
    const sender = header.querySelector('.sender-info') || header.firstElementChild;
    if (sender && !sender.querySelector('.ta-chev')) {
      const chev = document.createElement('span');
      chev.className = 'ta-chev';
      chev.style.cssText = 'display:inline-block;width:14px;color:#888;font-size:11px;margin-right:4px;user-select:none;';
      chev.textContent = '▾';
      sender.insertBefore(chev, sender.firstChild);
    }

    // Translate buttons — live in the actions container so they don't conflict
    // with the header click target. Both open a popover/modal — they NEVER
    // mutate FD's own conversation DOM (FD's framework re-renders on touch).
    if (actions) {
      // Conversations: `[data-test-conversation="conversation-text"]` or `.ticket_note`.
      // Description: `#ticket_original_request`. Fall back to the generic
      // `.text-content-wrapper` if nothing matches.
      const noteEl = wrapper.querySelector('[data-test-conversation="conversation-text"]')
                  || wrapper.querySelector('#ticket_original_request')
                  || wrapper.querySelector('.ticket_note')
                  || wrapper.querySelector('.text-content-wrapper');
      const translateBtn = document.createElement('button');
      translateBtn.type = 'button';
      translateBtn.className = 'nucleus-button nucleus-button--small nucleus-button--text ticket-actions';
      translateBtn.title = 'Translate to English (popover)';
      translateBtn.style.cssText = 'padding:4px 8px;color:#1976d2;font-size:14px;cursor:pointer;background:transparent;border:none;';
      translateBtn.textContent = '🌐';
      translateBtn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!noteEl) { showToast('Could not find note content.', 'error'); return; }
        const text = (noteEl.innerText || '').trim();
        if (!text) { showToast('No text to translate.', 'warning'); return; }
        const isDescription = wrapper === description;
        const scopeLabel = isDescription ? 'description'
          : (wrapper.dataset.album || '').replace(/^note_/, 'note ') || (wrapper.id || 'reply');
        showTranslatePopover(translateBtn, text, { title: scopeLabel, target: 'en' });
      };
      actions.insertBefore(translateBtn, actions.firstChild);

      // AI Translate (Groq) — passes only this conversation's text (with
      // quoted tail stripped) to the "translate chat" prompt and opens the
      // result in showChatModal. Modal-only, no FD-DOM mutation.
      const aiBtn = document.createElement('button');
      aiBtn.type = 'button';
      aiBtn.className = 'nucleus-button nucleus-button--small nucleus-button--text ticket-actions';
      aiBtn.title = 'AI translate this chat';
      aiBtn.style.cssText = 'padding:4px 8px;color:#e83e8c;font-size:14px;cursor:pointer;background:transparent;border:none;';
      aiBtn.textContent = '🤖';
      aiBtn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!noteEl) { showToast('Could not find note content.', 'error'); return; }
        const text = (noteEl.innerText || '').trim();
        if (!text) { showToast('No text to translate.', 'warning'); return; }
        const isDescription = wrapper === description;
        const scopeLabel = isDescription
          ? 'description'
          : (wrapper.dataset.album || '').replace(/^note_/, 'note ') || (wrapper.id || '');
        showChatModal(getFreshdeskTicketId(), null, {
          content: stripQuotedTail(text),
          scopeLabel,
        });
      };
      actions.insertBefore(aiBtn, actions.firstChild);
    }

    // Default state: collapsed unless this is one of the last two.
    setCollapsed(!keepExpanded.has(wrapper));
    wrapper.dataset.taControlsInjected = '1';
  });
}

// Show "tickets left in this queue: X" in the booking panel header. Reads
// from viewQueueCache + the agent's most-recently-visited filter. Hidden
// when we have no queue context.
function updateQueueCounter() {
  const el = document.getElementById(BOOKING_PANEL_ID + '_queueCount');
  if (!el) return;
  const tid = getFreshdeskTicketId();
  const fid = _lastFilterId;
  if (!tid || !fid) { el.textContent = ''; return; }
  const queue = viewQueueCache.get(fid);
  if (!queue || !queue.length) { el.textContent = ''; return; }
  const idx = queue.indexOf(String(tid));
  if (idx === -1) { el.textContent = ''; return; }
  const remaining = queue.length - idx - 1;
  el.textContent = 'tickets left in this queue: ' + remaining;
  el.title = remaining + ' more after this one (queue size ' + queue.length + ')';
}

function refreshNativeInjections() {
  renderBookingPanel();
  refreshDuplicateStrip();
  updateQueueCounter();
}

// Polling mount loop — covers FD re-renders on SPA nav. Injection functions
// short-circuit when their target already exists, so the loop is cheap.
// Content refresh (renderBookingPanel / refreshDuplicateStrip) is NOT in the
// loop to avoid flicker; it fires on ticket change and after prewarm.
function mountNativeInjections() {
  injectBookingPanel();
  renderBookingPanel();
  // Initial assisted-mode fire on cold page load — pushState/popstate hooks
  // miss the very first navigation.
  if (_assistedMode) {
    setTimeout(() => { if (getFreshdeskTicketId()) prewarmWindow(); }, 1500);
  }
  setInterval(() => {
    injectBookingPanel();
    injectReplyBarButtons();
    injectReplyComposerTabs();
    injectTranslateNearSend();
    injectDuplicateStrip();
    injectConversationControls();
    injectSummaryButton();
    // Each re-inject (after FD wipes the DOM) sets fresh content via
    // refreshDuplicateStrip() called inside injectDuplicateStrip.
  }, 1500);
}

// Inject "✨ AI Summary" into FD's ticket header, beside the native Summary
// button (.ticket-header-end). FD re-renders the header on navigation so the
// polling loop re-injects when missing.
function injectSummaryButton() {
  const headerEnd = document.querySelector('.ticket-header-end');
  if (!headerEnd) return;
  if (headerEnd.querySelector('.ta-ai-summary-btn')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ta-ai-summary-btn ticket-header-end-item';
  btn.style.cssText = 'margin-right:12px;padding:5px 12px;border:1px solid #6f42c1;' +
    'border-radius:6px;background:#fff;color:#6f42c1;font-size:13px;font-weight:600;cursor:pointer;';
  btn.textContent = '✨ AI Summary';
  btn.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    showSummaryModal(getFreshdeskTicketId());
  };

  // Sit just before FD's native Summary button when present.
  const fdSummary = headerEnd.querySelector('[data-test-id="add-summary-button"]');
  if (fdSummary) headerEnd.insertBefore(btn, fdSummary);
  else headerEnd.appendChild(btn);
}

function getFreshdeskTicketId() {
  const match = window.location.pathname.match(/\/(?:a\/)?tickets\/(\d+)/);
  if (!match) console.warn('⚠️ getFreshdeskTicketId: no match on', window.location.pathname);
  return match ? match[1] : null;
}

// ── Shared: make a modal draggable by its handle ──────────────────────────────
function makeDraggable(modal, handle) {
  let ox = 0, oy = 0, dragging = false;
  handle.style.cursor = 'move';
  handle.addEventListener('mousedown', (e) => {
    // Don't start drag when clicking interactive elements inside the handle
    if (e.target.closest('button, a, input, select, textarea')) return;
    dragging = true;
    const rect = modal.getBoundingClientRect();
    // Snap to rect position first so transform doesn't cause a jump
    modal.style.left      = rect.left + 'px';
    modal.style.top       = rect.top  + 'px';
    modal.style.transform = 'none';
    ox = e.clientX - rect.left;
    oy = e.clientY - rect.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = modal.getBoundingClientRect();
    const margin = 40; // keep at least this much of the modal on-screen
    // top:0 floor keeps the drag handle reachable so it can always be pulled back.
    const nx = Math.max(margin - rect.width, Math.min(window.innerWidth - margin, e.clientX - ox));
    const ny = Math.max(0, Math.min(window.innerHeight - margin, e.clientY - oy));
    modal.style.left = nx + 'px';
    modal.style.top  = ny + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });
}

// ── Toast (replaces alert for success/info) ───────────────────────────────────
function showToast(message, type = 'success', duration = 4000) {
  const colors = { success: '#28a745', error: '#dc3545', info: '#17a2b8', warning: '#fd7e14' };
  const toast = document.createElement('div');
  toast.style.cssText = `position:fixed;bottom:24px;right:24px;background:${colors[type]||'#28a745'};color:#fff;padding:12px 18px;border-radius:8px;font-size:13px;font-family:system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,0.25);z-index:9999999;max-width:360px;line-height:1.5;`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ── Button loading state helper ───────────────────────────────────────────────
async function withButtonLoading(btn, loadingLabel, fn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = loadingLabel || '⏳ Loading...';
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

// ── Modal factory — creates a standard draggable modal shell ─────────────────
// opts.style      — extra CSS appended to the modal container (position, width, etc.)
// opts.bodyStyle  — extra CSS appended to the scrollable body div
// Returns { modal, header, body, closeBtn }
// Prevents FD's keyboard shortcuts from firing while the agent types inside
// one of our modals. Attaches at window-capture (earliest possible) so we beat
// any FD listener registered on document/window. Auto-cleans when the modal
// element is detached.
function trapKeyEventsForModal(modalElement) {
  const types = ['keydown', 'keyup', 'keypress'];
  const handler = (e) => {
    if (!modalElement.isConnected) {
      types.forEach((t) => window.removeEventListener(t, handler, true));
      return;
    }
    if (modalElement.contains(e.target)) {
      e.stopImmediatePropagation();
    }
  };
  types.forEach((t) => window.addEventListener(t, handler, true));
}

function createModal(id, title, opts = {}) {
  document.getElementById(id)?.remove();
  const zIndex = opts.zIndex || 999999;
  const modal = document.createElement('div');
  modal.id = id;
  modal.style.cssText = `position:fixed;background:#fff;border-radius:${THEME.radius};box-shadow:${THEME.shadow};z-index:${zIndex};font-family:${THEME.font};display:flex;flex-direction:column;` + (opts.style || '');

  const header = document.createElement('div');
  header.id = id + 'Handle';
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
  return { modal, header, body, closeBtn };
}

// ── Rich editor — contentEditable div with optional image-paste support ─────
// opts.style         — full style override for the editor element
// opts.placeholder   — data-placeholder text shown when empty
// opts.pasteImages   — when true (default), pasted images are inlined as base64
// Returns the editor element. Caller is responsible for appending it.
function createRichEditor(opts = {}) {
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  editor.style.cssText = opts.style || `border:1px solid #ddd;border-radius:6px;padding:9px 12px;font-size:13px;font-family:${THEME.font};line-height:1.5;outline:none;min-height:120px;overflow-y:auto;`;
  if (opts.placeholder) {
    editor.setAttribute('data-placeholder', opts.placeholder);
  }
  if (opts.pasteImages !== false) {
    editor.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          const reader = new FileReader();
          reader.onload = (ev) => {
            const img = document.createElement('img');
            img.src = ev.target.result;
            img.style.cssText = 'max-width:100%;height:auto;display:block;margin:4px 0;border-radius:3px;';
            const sel = window.getSelection();
            if (sel && sel.rangeCount) {
              const range = sel.getRangeAt(0);
              range.deleteContents();
              range.insertNode(img);
              range.setStartAfter(img);
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
            } else {
              editor.appendChild(img);
            }
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    });
  }
  return editor;
}

// ── RTF formatting toolbar for createRichEditor ──────────────────────────────
// Returns a toolbar element to be appended just before the editor. Uses
// document.execCommand — deprecated but still works in every current browser
// for contenteditable. onmousedown preventDefault keeps focus inside the
// editor while the button is clicked.
function buildRtfToolbar(editor) {
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:2px;padding:4px 6px;border:1px solid #ddd;border-bottom:none;border-radius:6px 6px 0 0;background:#f8f9fa;';

  const mkBtn = (label, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = label;
    b.title = title;
    b.style.cssText = 'background:transparent;border:none;padding:4px 8px;cursor:pointer;font-size:13px;color:#444;border-radius:3px;line-height:1;';
    b.onmouseenter = () => { b.style.background = '#e9ecef'; };
    b.onmouseleave = () => { b.style.background = 'transparent'; };
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = (e) => { e.preventDefault(); editor.focus(); fn(); };
    return b;
  };
  const cmd = (name, arg) => () => document.execCommand(name, false, arg || null);
  const divider = () => {
    const d = document.createElement('span');
    d.style.cssText = 'display:inline-block;width:1px;height:16px;background:#ddd;margin:0 4px;';
    return d;
  };

  bar.appendChild(mkBtn('<b>B</b>',  'Bold',          cmd('bold')));
  bar.appendChild(mkBtn('<i>I</i>',  'Italic',        cmd('italic')));
  bar.appendChild(mkBtn('<u>U</u>',  'Underline',     cmd('underline')));
  bar.appendChild(divider());
  bar.appendChild(mkBtn('•',         'Bulleted list', cmd('insertUnorderedList')));
  bar.appendChild(mkBtn('1.',        'Numbered list', cmd('insertOrderedList')));
  bar.appendChild(divider());
  bar.appendChild(mkBtn('🔗',        'Insert link',   () => {
    const url = prompt('Link URL:');
    if (url) document.execCommand('createLink', false, url);
  }));
  bar.appendChild(mkBtn('✕',         'Clear formatting', cmd('removeFormat')));

  return bar;
}

// ── Hotel email confirmation modal ───────────────────────────────────────────
// Always opens after a Groq lookup. Lets the agent edit the address before
// sending. opts: { hotelName, emailResult, emailHtmlPreview, onSend(addr, ctx) }
function showHotelEmailConfirmModal(opts) {
  const { hotelName, emailResult, emailHtmlPreview, onSend } = opts;
  const e = emailResult || {};
  const hasEmail = !!e.email;
  const isLow   = e.confidence === 'low';
  const chip = !hasEmail
    ? { bg:'#f8d7da', fg:'#dc3545', text:'❌ Not found' }
    : isLow
    ? { bg:'#fff3cd', fg:'#fd7e14', text:'⚠️ Low confidence' }
    : { bg:'#d4edda', fg:'#28a745', text:'✅ ' + (e.confidence || 'found') };

  const { modal, body, closeBtn } = createModal('taHotelEmailModal', '📧 Send Hotel Email', {
    style: 'top:80px;left:50%;transform:translateX(-50%);width:560px;max-width:95vw;max-height:85vh;',
    bodyStyle: 'padding:14px 18px;font-size:13px;color:#333;line-height:1.5;',
    zIndex: 1000001,
  });

  const hotelRow = document.createElement('div');
  hotelRow.style.cssText = 'margin-bottom:10px;';
  hotelRow.innerHTML = `<div style="color:${THEME.muted};font-size:11px;text-transform:uppercase;letter-spacing:0.4px;">Hotel</div>
    <div style="font-weight:600;">${hotelName || '(unknown)'}</div>`;
  body.appendChild(hotelRow);

  const chipEl = document.createElement('div');
  chipEl.style.cssText = `display:inline-block;background:${chip.bg};color:${chip.fg};padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;margin-bottom:10px;`;
  chipEl.textContent = chip.text;
  body.appendChild(chipEl);

  if (e.website) {
    const w = document.createElement('div');
    w.style.cssText = `font-size:11px;color:${THEME.muted};margin-bottom:6px;`;
    const safeUrl = String(e.website).replace(/"/g, '&quot;');
    w.innerHTML = `<strong>Website:</strong> <a href="${safeUrl}" target="_blank" rel="noopener" style="color:${THEME.primary};">${e.website}</a>`;
    body.appendChild(w);
  }
  if (e.source) {
    const src = document.createElement('div');
    src.style.cssText = `font-size:11px;color:${THEME.muted};margin-bottom:6px;`;
    src.innerHTML = `<strong>Source:</strong> ${e.source}`;
    body.appendChild(src);
  }
  if (e.notes) {
    const nt = document.createElement('div');
    nt.style.cssText = `font-size:11px;color:${THEME.muted};margin-bottom:10px;`;
    nt.innerHTML = `<strong>Notes:</strong> ${e.notes}`;
    body.appendChild(nt);
  }

  const emailLabel = document.createElement('div');
  emailLabel.style.cssText = `color:${THEME.muted};font-size:11px;text-transform:uppercase;letter-spacing:0.4px;margin-top:6px;`;
  emailLabel.textContent = 'Send to';
  body.appendChild(emailLabel);
  const emailInput = document.createElement('input');
  emailInput.type = 'email';
  emailInput.value = e.email || '';
  emailInput.placeholder = 'hotel@example.com';
  emailInput.style.cssText = `width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;font-family:${THEME.font};margin-top:4px;margin-bottom:12px;`;
  body.appendChild(emailInput);

  if (emailHtmlPreview) {
    const previewToggle = document.createElement('button');
    previewToggle.textContent = '▸ Preview email body';
    previewToggle.style.cssText = `background:none;border:none;color:${THEME.primary};font-size:12px;cursor:pointer;padding:0;margin-bottom:6px;`;
    const previewBox = document.createElement('div');
    previewBox.style.cssText = `display:none;border:1px solid ${THEME.border};border-radius:6px;padding:10px;background:#fafafa;max-height:240px;overflow-y:auto;font-size:12px;`;
    previewBox.innerHTML = emailHtmlPreview;
    previewToggle.onclick = () => {
      const open = previewBox.style.display !== 'none';
      previewBox.style.display = open ? 'none' : 'block';
      previewToggle.textContent = (open ? '▸' : '▾') + ' Preview email body';
    };
    body.appendChild(previewToggle);
    body.appendChild(previewBox);
  }

  const errLine = document.createElement('div');
  errLine.style.cssText = `color:${THEME.danger};font-size:12px;margin-top:8px;display:none;`;
  body.appendChild(errLine);

  const close = () => modal.remove();
  closeBtn.onclick = close;

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'padding:0 18px 16px;display:flex;gap:8px;justify-content:flex-end;';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:8px 16px;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#666;';
  cancelBtn.onclick = close;
  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send';
  sendBtn.style.cssText = `padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:${THEME.success};color:#fff;`;
  sendBtn.onclick = async () => {
    const addr = (emailInput.value || '').trim();
    if (!addr || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      errLine.textContent = 'Please enter a valid email address.';
      errLine.style.display = 'block';
      emailInput.focus();
      return;
    }
    errLine.style.display = 'none';
    sendBtn.disabled = true; cancelBtn.disabled = true;
    const original = sendBtn.textContent;
    sendBtn.textContent = '⏳ Sending...';
    try {
      await onSend(addr);
      close();
    } catch (err) {
      errLine.textContent = err && err.message ? err.message : 'Send failed.';
      errLine.style.display = 'block';
      sendBtn.disabled = false; cancelBtn.disabled = false;
      sendBtn.textContent = original;
    }
  };
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(sendBtn);
  modal.appendChild(btnRow);

  setTimeout(() => emailInput.focus(), 50);
}

// ── Refresh Freshdesk ticket timeline without full page reload ────────────────
// Force Freshdesk to refetch the conversation thread by double-clicking the
// activities toggle (collapse → expand triggers a refetch). FD has changed
// the data-test-id over time, so we try multiple known selectors. Console
// warns when none match so we know to grab the new attribute.
const FD_REFRESH_SELECTORS = [
  '[data-test-toggle-activity]',
  '[data-test-id="toggle-activity"]',
  '[data-test-id="conversation-refresh"]',
  '[data-test-id="refresh-conversations"]',
  '[aria-label="Refresh"]',
  '[aria-label="Refresh conversations"]',
  'button.refresh-conversation',
];
function findFdRefreshButton() {
  for (const sel of FD_REFRESH_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

// Probe FD's conversations API for the top conversation id. Used as a
// "baseline" before a write so the refresh poll can detect when FD's
// backend has indexed the new entry.
async function getMaxConversationId(ticketId) {
  if (!ticketId) return 0;
  try {
    const r = await fdGet(`/api/_/tickets/${ticketId}/conversations?per_page=1&order_type=desc`);
    const convs = r?.conversations || r?.results || [];
    return Number(convs[0]?.id) || 0;
  } catch { return 0; }
}

// Capture the current state before a write so the post-write refresh
// can poll until FD's backend has indexed the new conversation, then
// click immediately. Use:
//   const refresh = await captureRefresh(ticketId);
//   const { ok } = await api.postSomething(...);
//   if (ok) refresh();
async function captureRefresh(ticketId) {
  const id = ticketId ? String(ticketId) : null;
  const baseline = id ? await getMaxConversationId(id) : 0;
  return () => refreshFreshdeskTicket(id, baseline);
}

// Trigger FD to refetch the conversation thread.
// - With (ticketId, lastSeenId): polls FD's conversations API every 200ms
//   until the top id exceeds lastSeenId (FD has indexed the new write),
//   then fires the click. Ceiling 5s — falls back to a blind click after.
// - With no args (legacy callers): blind 1500ms wait, same as before.
async function refreshFreshdeskTicket(ticketId, lastSeenId) {
  const btn = findFdRefreshButton();
  if (!btn) { console.warn('⚠️ FD refresh button not found — tried', FD_REFRESH_SELECTORS.join(', ')); return; }
  const click = () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const doubleClick = () => { click(); setTimeout(click, 350); };

  if (ticketId && Number.isFinite(lastSeenId)) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const topId = await getMaxConversationId(ticketId);
      if (topId > lastSeenId) { doubleClick(); return; }
    }
    // Timeout — FD's backend hasn't shown the write yet. Click anyway;
    // the user can hit the toggle manually if it's still stale.
    console.warn('[refresh] timed out waiting for new conv on ticket', ticketId, '(last seen', lastSeenId, ')');
    doubleClick();
    return;
  }

  // Legacy blind path.
  setTimeout(doubleClick, 1500);
}



function showNoteModal(noteHtml) {
  const { body } = createModal('taNoteModal', '👁️ Note Preview', {
    style: 'top:60px;left:24px;width:860px;max-width:95vw;',
    bodyStyle: 'max-height:80vh;font-size:13px;line-height:1.6;',
    zIndex: 1000000,
  });
  body.innerHTML = noteHtml;
}


// ── AI Summary modal ──────────────────────────────────────────────────────────
// Migrated from the Guided modal's ✨ Summarize button. /ai-assist fetches the
// ticket thread server-side via getTicketContext, so we just pass the ticket ID.
async function showSummaryModal(ticketId) {
  const tid = ticketId || getFreshdeskTicketId();
  if (!tid) { showToast('No ticket detected.', 'error'); return; }
  const { modal, body } = createModal('taSummaryModal', `✨ AI Summary — #${tid}`, {
    style: 'top:80px;left:50%;transform:translateX(-50%);width:600px;max-width:92vw;max-height:80vh;',
    bodyStyle: 'padding:14px 18px;font-size:14px;line-height:1.6;color:#333;',
  });
  trapKeyEventsForModal(modal);
  body.innerHTML = '<div style="color:#999;">⏳ Summarising ticket thread…</div>';
  const { ok, data } = await api.aiAssist({
    booking: {}, details: {}, user: null, supplier: null,
    freshdeskTicketId: String(tid),
    prompt: 'Summarise this support ticket. What was done by which agent and when, be concise and well structured. Propose the next step.',
  });
  body.innerHTML = '';
  if (ok && data && data.text) {
    const box = document.createElement('div');
    box.style.cssText = 'padding:2px;';
    // Render markdown — the model returns headings/bullets/bold.
    box.innerHTML = (typeof marked !== 'undefined' && marked.parse)
      ? marked.parse(data.text.trim())
      : data.text.trim().replace(/\n/g, '<br>');
    body.appendChild(box);
  } else {
    body.innerHTML = '<div style="color:#dc3545;">❌ Summarisation failed.</div>';
  }
}

// ── Chat modal ────────────────────────────────────────────────────────────────
// opts.content — when set, send this text to AI instead of pulling the whole
// ticket thread. Used by the per-conversation 🤖 button to translate one chat.
// opts.scopeLabel — subtitle shown in the modal title (e.g. "conversation #123").
async function showChatModal(ticketId, onNotePosted, opts = {}) {
  const freshdeskTicketId = ticketId || getFreshdeskTicketId();
  if (!freshdeskTicketId) { showToast('No ticket detected.', 'error'); return; }
  const title = opts.scopeLabel
    ? `💬 Chat — #${freshdeskTicketId} · ${opts.scopeLabel}`
    : `💬 Chat — #${freshdeskTicketId}`;

  const { modal, body } = createModal('taChatModal', title, {
    style: 'top:60px;right:24px;width:700px;max-width:calc(100vw - 48px);max-height:92vh;resize:both;overflow:auto;min-width:400px;',
    bodyStyle: 'padding:14px 16px;display:flex;flex-direction:column;gap:12px;',
  });
  trapKeyEventsForModal(modal);

  // Chat translation section
  const chatSection = document.createElement('div');
  chatSection.style.cssText = 'border:1px solid #eee;border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;';
  const chatTitle = document.createElement('div');
  chatTitle.style.cssText = 'font-weight:600;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.04em;';
  chatTitle.textContent = '🌐 Translated Chat';
  const chatTextarea = document.createElement('textarea');
  chatTextarea.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:12px;font-family:system-ui,sans-serif;resize:vertical;min-height:220px;line-height:1.6;outline:none;white-space:pre-wrap;';
  chatTextarea.value = '⏳ Translating chat...';
  chatTextarea.readOnly = true;
  const chatBtnRow = document.createElement('div');
  chatBtnRow.style.cssText = 'display:flex;gap:8px;';
  const postChatNoteBtn = document.createElement('button');
  postChatNoteBtn.textContent = '📋 Post as Note';
  postChatNoteBtn.disabled = true;
  postChatNoteBtn.style.cssText = 'padding:7px 14px;border:none;border-radius:6px;background:#6f42c1;color:#fff;font-size:12px;font-weight:600;cursor:pointer;opacity:0.4;';
  postChatNoteBtn.onclick = async () => {
    const text = chatTextarea.value.trim();
    if (!text) { showToast('Nothing to post.', 'warning'); return; }
    postChatNoteBtn.disabled = true; postChatNoteBtn.textContent = '⏳ Posting...';
    const refresh = await captureRefresh(freshdeskTicketId);
    const noteHtml = '<p>' + text.replace(/\n/g, '<br>') + '</p>';
    const { ok } = await api.postNote(freshdeskTicketId, noteHtml);
    postChatNoteBtn.disabled = false; postChatNoteBtn.textContent = '📋 Post as Note';
    // onNotePosted is itself refreshFreshdeskTicket on the caller side
    // (booking-panel 🤖 button); skip it to avoid double-firing.
    if (ok) { showToast('✅ Note posted!', 'success'); refresh(); }
    else showToast('❌ Failed to post note.', 'error');
  };
  chatBtnRow.appendChild(postChatNoteBtn);
  chatSection.appendChild(chatTitle);
  chatSection.appendChild(chatTextarea);
  chatSection.appendChild(chatBtnRow);
  body.appendChild(chatSection);

  // Translate Chat — fetch prompt from DB then send with ticket context
  api.prompts().then(async ({ ok: pok, data: pdata }) => {
    const translatePrompt = (pok && Array.isArray(pdata))
      ? pdata.find(p => p.label && p.label.toLowerCase().includes('translate chat'))
      : null;
    const promptText = translatePrompt ? translatePrompt.text : 'Clean and translate this chat transcript to English. Format as BOT/CUSTOMER/AGENT. Add a 2-sentence summary at the end. Output only the formatted transcript and summary — no headers, no labels, no markdown, no reasoning, no extra commentary.';

    const aiBody = opts.content
      ? { booking: {}, details: {}, user: null, supplier: null, content: opts.content, prompt: promptText }
      : { booking: {}, details: {}, user: null, supplier: null, freshdeskTicketId, prompt: promptText };
    const { ok: aiOk, data: aiData } = await api.aiAssist(aiBody);
    if (aiOk && aiData.text) {
      chatTextarea.value = aiData.text;
      chatTextarea.readOnly = false;
      postChatNoteBtn.disabled = false; postChatNoteBtn.style.opacity = '1';
    } else {
      chatTextarea.value = '❌ Translation failed.';
    }
  });
}

// ── Prewarm progress modal ────────────────────────────────────────────────────
function showBulkConfirmModal() {
  const { modal, body: outputArea } = createModal('taBulkModal', '🏨 Bulk Confirm', {
    style: 'top:60px;left:50%;transform:translateX(-50%);width:1100px;max-width:calc(100vw - 48px);max-height:92vh;resize:both;overflow:auto;min-width:500px;',
    bodyStyle: 'padding:14px 16px;display:flex;flex-direction:column;gap:16px;',
  });

  // Tag input row — inserted between header and the body created above
  const inputRow = document.createElement('div');
  inputRow.style.cssText = `padding:12px 16px;border-bottom:1px solid ${THEME.border};display:flex;gap:8px;align-items:center;flex-shrink:0;`;
  const tagInput = document.createElement('input');
  tagInput.type = 'text';
  tagInput.placeholder = 'Enter Freshdesk tag (e.g. belenli)';
  tagInput.style.cssText = 'flex:1;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;';
  const fetchBtn = document.createElement('button');
  fetchBtn.textContent = '🔍 Fetch Bookings';
  fetchBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:6px;background:#795548;color:#fff;font-size:13px;font-weight:600;cursor:pointer;';
  inputRow.appendChild(tagInput);
  inputRow.appendChild(fetchBtn);

  fetchBtn.onclick = () => withButtonLoading(fetchBtn, '⏳ Fetching...', async () => {
    const tag = tagInput.value.trim();
    if (!tag) { showToast('Enter a tag first.', 'warning'); return; }
    outputArea.innerHTML = '<div style="color:#999;font-size:13px;">Loading...</div>';

    const { ok, data } = await api.bulkConfirm(tag);

    if (!ok) { outputArea.innerHTML = `<div style="color:red;">❌ Error: ${data?.error || 'Server error'}</div>`; return; }

    const { bookings, errors, total } = data;
    outputArea.innerHTML = '';

    // Status line
    const statusLine = document.createElement('div');
    statusLine.style.cssText = 'font-size:12px;color:#666;';
    statusLine.textContent = `Found ${total} tickets — ${bookings.length} fetched, ${errors.length} skipped`;
    outputArea.appendChild(statusLine);

    if (errors.length > 0) {
      const errDiv = document.createElement('div');
      errDiv.style.cssText = 'background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:10px 14px;font-size:12px;color:#856404;';
      errDiv.innerHTML = '<strong>⚠️ Skipped tickets:</strong><br>' +
        errors.map(e => `#${e.ticketId} — ${e.subject?.slice(0,50) || '?'} (${e.reason})`).join('<br>');
      outputArea.appendChild(errDiv);
    }

    if (bookings.length === 0) { outputArea.innerHTML += '<div style="color:#999;font-size:13px;">No bookings fetched.</div>'; return; }

    // ── Internal note output ────────────────────────────────────────────────
    const fdBase = 'https://mwrlife.freshdesk.com/a/tickets/';
    const noteSection = document.createElement('div');
    noteSection.innerHTML = '<div style="font-weight:600;font-size:13px;margin-bottom:6px;">📋 Internal Note</div>';
    const noteTable = `<table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="background:#f5f5f5;">
        <th style="padding:5px 8px;border:1px solid #ddd;text-align:left;">Ticket</th>
        <th style="padding:5px 8px;border:1px solid #ddd;text-align:left;">Supplier Ref</th>
        <th style="padding:5px 8px;border:1px solid #ddd;text-align:left;">TA Booking ID</th>
        <th style="padding:5px 8px;border:1px solid #ddd;text-align:left;">Guest</th>
      </tr></thead>
      <tbody>${bookings.map(b =>
        `<tr>
          <td style="padding:5px 8px;border:1px solid #ddd;"><a href="${fdBase}${b.ticketId}" target="_blank">#${b.ticketId}</a></td>
          <td style="padding:5px 8px;border:1px solid #ddd;">${b.supplierId || '—'}</td>
          <td style="padding:5px 8px;border:1px solid #ddd;">${b.internalId || '—'}</td>
          <td style="padding:5px 8px;border:1px solid #ddd;">${b.guestName || '—'}</td>
        </tr>`).join('')}
      </tbody></table>`;

    const notePlain = bookings.map(b =>
      `#${b.ticketId} (${fdBase}${b.ticketId}) | Supplier: ${b.supplierId || '—'} | TA: ${b.internalId || '—'} | Guest: ${b.guestName || '—'}`
    ).join('\n');

    const noteCopyBtn = document.createElement('button');
    noteCopyBtn.textContent = '📋 Copy';
    noteCopyBtn.style.cssText = 'margin-top:6px;padding:5px 12px;border:1px solid #6c757d;border-radius:5px;background:#fff;color:#6c757d;font-size:12px;cursor:pointer;';
    noteCopyBtn.onclick = () => { navigator.clipboard.writeText(notePlain); showToast('Copied!', 'success', 1500); };

    noteSection.innerHTML += noteTable;
    noteSection.appendChild(noteCopyBtn);
    outputArea.appendChild(noteSection);

    // ── Hotel email output ──────────────────────────────────────────────────
    const emailSection = document.createElement('div');
    emailSection.innerHTML = '<div style="font-weight:600;font-size:13px;margin-bottom:6px;">✉️ Hotel Email</div>';

    const emailTable = `<table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="background:#f5f5f5;">
        <th style="padding:5px 8px;border:1px solid #ddd;text-align:left;">Guest Name</th>
        <th style="padding:5px 8px;border:1px solid #ddd;text-align:left;">Check-In</th>
        <th style="padding:5px 8px;border:1px solid #ddd;text-align:left;">Check-Out</th>
        <th style="padding:5px 8px;border:1px solid #ddd;text-align:left;">Room Type</th>
        <th style="padding:5px 8px;border:1px solid #ddd;text-align:left;">Guests</th>
        <th style="padding:5px 8px;border:1px solid #ddd;text-align:left;">Special Requests</th>
      </tr></thead>
      <tbody>${bookings.map(b =>
        `<tr>
          <td style="padding:5px 8px;border:1px solid #ddd;">${b.guestName || '—'}</td>
          <td style="padding:5px 8px;border:1px solid #ddd;">${b.checkIn || '—'}</td>
          <td style="padding:5px 8px;border:1px solid #ddd;">${b.checkOut || '—'}</td>
          <td style="padding:5px 8px;border:1px solid #ddd;">${b.roomType || '—'}</td>
          <td style="padding:5px 8px;border:1px solid #ddd;">${b.paxLine || '—'}</td>
          <td style="padding:5px 8px;border:1px solid #ddd;">${b.requests || '—'}</td>
        </tr>`).join('')}
      </tbody></table>`;

    const emailBody = `Dear ${bookings[0]?.hotelName || 'Hotel Team'},\n\nWe would like to request confirmation for the following reservations:\n\n` +
      bookings.map(b =>
        `Guest: ${b.guestName || '—'}\nCheck-In: ${b.checkIn || '—'} | Check-Out: ${b.checkOut || '—'}\nRoom Type: ${b.roomType || '—'}\nGuests: ${b.paxLine || '—'}\nSpecial Requests: ${b.requests || 'None'}\n`
      ).join('\n---\n\n') +
      `\nPlease confirm each reservation at your earliest convenience.\n\nBest regards,\nTravel Advantage Support`;

    const emailCopyBtn = document.createElement('button');
    emailCopyBtn.textContent = '📋 Copy Email';
    emailCopyBtn.style.cssText = 'margin-top:6px;padding:5px 12px;border:1px solid #28a745;border-radius:5px;background:#fff;color:#28a745;font-size:12px;cursor:pointer;';
    emailCopyBtn.onclick = () => { navigator.clipboard.writeText(emailBody); showToast('Email copied!', 'success', 1500); };

    emailSection.innerHTML += emailTable;
    emailSection.appendChild(emailCopyBtn);
    outputArea.appendChild(emailSection);
  });

  tagInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchBtn.click(); });

  modal.insertBefore(inputRow, outputArea);
  setTimeout(() => tagInput.focus(), 100);
}

// ── Check Pendings modal ──────────────────────────────────────────────────────
function showCheckPendingsModal() {
  const { modal, header, body, closeBtn } = createModal('taPendingsModal', '📋 Checking pending tickets...', {
    style: 'bottom:24px;right:24px;width:440px;',
    bodyStyle: 'max-height:280px;font-size:12px;font-family:monospace;background:#f8f8f8;padding:10px 12px;line-height:1.8;',
  });
  closeBtn.disabled = true;

  const stopBtn = document.createElement('button');
  stopBtn.textContent = 'Stop';
  stopBtn.style.cssText = `padding:3px 10px;border:1px solid ${THEME.danger};border-radius:4px;background:#fff;color:${THEME.danger};font-size:12px;cursor:pointer;font-weight:500;margin-right:8px;`;
  header.insertBefore(stopBtn, closeBtn);

  const log = body;
  stopBtn.onclick = () => {
    stopBtn.disabled = true; stopBtn.textContent = 'Stopping...';
    GM_xmlhttpRequest({ method: 'POST', url: `${BACKEND_URL}/check-pendings/stop`, headers: { 'Content-Type': 'application/json' }, data: '{}', onload: () => {} });
  };

  let lastLogLength = 0;
  let pollInterval  = null;

  const addLines = (lines) => {
    lines.slice(lastLogLength).forEach(msg => { log.innerHTML += `<div>${msg}</div>`; });
    lastLogLength = lines.length;
    log.scrollTop = log.scrollHeight;
  };

  const stopPolling = () => {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    closeBtn.disabled = false;
    closeBtn.style.color = '#333';
    stopBtn.disabled = true; stopBtn.style.opacity = '0.4';
  };

  const poll = () => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: `${BACKEND_URL}/check-pendings/status`,
      onload: (res) => {
        try {
          const d = JSON.parse(res.responseText);
          addLines(d.log || []);
          if (d.done || d.error) {
            stopPolling();
            log.innerHTML += `<div style="margin-top:8px;font-weight:600;">${d.error ? '❌ ' + d.error : '✅ Done!'}</div>`;
            log.scrollTop = log.scrollHeight;
          }
        } catch (e) { console.warn('Pendings poll parse error', e); }
      },
      onerror: () => { stopPolling(); log.innerHTML += '<div style="color:red;">❌ Connection lost</div>'; },
    });
  };

  GM_xmlhttpRequest({
    method: 'POST',
    url: `${BACKEND_URL}/check-pendings/start`,
    headers: { 'Content-Type': 'application/json' },
    data: '{}',
    onload: (res) => {
      try {
        const d = JSON.parse(res.responseText);
        if (!d.success) {
          log.innerHTML += `<div style="color:red;">❌ Failed to start: ${d.error || 'unknown'}</div>`;
          stopPolling(); return;
        }
        pollInterval = setInterval(poll, 2000);
        poll();
      } catch (e) {
        log.innerHTML += '<div style="color:red;">❌ Failed to start check</div>';
        stopPolling();
      }
    },
    onerror: () => { log.innerHTML += '<div style="color:red;">❌ Could not reach server</div>'; stopPolling(); },
  });
}

// ── Batch Triage ─────────────────────────────────────────────────────────────
// Walks the LOW-priority tickets in the agent's current filter view through the
// backend triage pipeline. Dry-run by default: the whole pipeline runs but
// note-posting, tagging and hotel emails are simulated, so the table shows what
// WOULD happen. Flipping to live requires an explicit confirm.

// Outcome → [label, colour]. Anything not listed renders grey.
const TRIAGE_OUTCOMES = {
  reconf_hotel_email_sent:       ['📧 Hotel emailed',     '#28a745'],
  reconf_call_hotel:             ['📞 Call hotel',        '#fd7e14'],
  reconf_duplicates_found:       ['🔗 Related tickets',   '#17a2b8'],
  reconf_already_emailed:        ['✓ Already emailed',    '#6c757d'],
  reconf_hotel_email_no_address: ['❓ No address',        '#ffc107'],
  reconf_search_failed:          ['⚠️ Search failed',     '#dc3545'],
  reconf_no_checkin_date:        ['❓ No check-in date',  '#ffc107'],
  reconf_past_checkin:           ['⏮ Past check-in',     '#6c757d'],
  customer_needs_response:       ['💬 Needs response',    '#dc3545'],
  customer_pending_supplier:     ['⏳ Pending supplier',  '#6f42c1'],
  customer_pending_customer:     ['⏳ Pending customer',  '#17a2b8'],
  customer_resolved:             ['✓ Resolved',          '#28a745'],
  booking_voucher:               ['🎟 Voucher — skipped', '#6c757d'],
  unsupported_product:           ['⏭ Unsupported type',  '#6c757d'],
  needs_manual_classification:   ['🤔 Manual review',     '#ffc107'],
  no_booking_id:                 ['❓ No booking ref',    '#ffc107'],
  booking_not_found:             ['❓ Booking not in TA', '#ffc107'],
  error_ticket_fetch:            ['❌ Fetch failed',      '#dc3545'],
  error_booking_fetch:           ['❌ Booking failed',    '#dc3545'],
  error_classify:                ['❌ Classify failed',   '#dc3545'],
  error:                         ['❌ Error',             '#dc3545'],
};

/** Pulls every page of the filter view, then narrows to LOW priority. */
async function collectLowPriorityQueue(filterId, maxPages = 10) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const d = await fdGet(`/api/_/tickets?filter=${filterId}&per_page=30&page=${page}&include=requester,stats`);
    const batch = d.tickets || [];
    for (const t of batch) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
    if (batch.length < 30) break;
  }
  return out.filter(t => t.priority === 1).map(t => ({
    id: t.id,
    subject: t.subject,
    priority: t.priority,
    status: t.status,
    tags: t.tags || [],
    requesterEmail: t.requester?.email || null,
  }));
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function triageOutcomeChip(outcome) {
  const [label, color] = TRIAGE_OUTCOMES[outcome] || [outcome || '—', '#6c757d'];
  return `<span style="display:inline-block;padding:2px 7px;border-radius:10px;background:${color};color:#fff;font-size:11px;white-space:nowrap;">${esc(label)}</span>`;
}

function triageNoteCell(row) {
  const map = {
    already_posted: ['✓ existed', '#6c757d'],
    posted:         ['📝 posted', '#28a745'],
    simulated:      ['🧪 would post', '#b8860b'],
    failed:         ['✗ failed', '#dc3545'],
    skipped:        ['—', '#999'],
  };
  const [label, color] = map[row.noteState] || ['—', '#999'];
  const via = row.noteDetectMethod ? ` title="detected via ${esc(row.noteDetectMethod)}${row.noteEvidence ? ': ' + esc(row.noteEvidence) : ''}"` : '';
  return `<span style="color:${color};"${via}>${label}</span>`;
}

/** The "what did it actually do" cell — the point of the whole table. */
function triageActionCell(row) {
  const bits = [];
  if (row.hotelEmail?.address) {
    const state = row.hotelEmail.state === 'simulated' ? '🧪 ' : (row.hotelEmail.state === 'sent' ? '📧 ' : '');
    bits.push(`${state}${esc(row.hotelEmail.address)}`);
  } else if (row.hotelEmail?.state === 'not_found') {
    bits.push('no address found');
  }
  if (row.relatedTickets?.length) {
    bits.push(row.relatedTickets.map(t => `<a href="${t.url}" target="_blank">#${t.id}</a>`).join(' '));
  }
  if (row.tagsAdded?.length) {
    bits.push(`<span style="color:#6f42c1;">${row.tagsMode === 'simulated' ? '🧪 ' : ''}+${esc(row.tagsAdded.join(', '))}</span>`);
  }
  return bits.length ? bits.join('<br>') : '—';
}

function triageStepsHtml(row) {
  const modeColor = { read: '#666', live: '#28a745', simulated: '#b8860b', error: '#dc3545' };
  const lines = (row.steps || []).map(s =>
    `<div style="padding:1px 0;"><span style="color:#999;">${esc(s.t.slice(11, 19))}</span> ` +
    `<span style="display:inline-block;min-width:78px;color:#6f42c1;">${esc(s.stage)}</span> ` +
    `<span style="color:${modeColor[s.mode] || '#666'};">${esc(s.msg)}</span></div>`
  ).join('');
  const extra = [];
  if (row.classifyReason) extra.push(`<div style="margin-top:4px;color:#666;"><b>Why:</b> ${esc(row.classifyReason)}</div>`);
  if (row.threadSummary)  extra.push(`<div style="color:#666;"><b>Thread:</b> ${esc(row.threadSummary)}</div>`);
  if (row.nextAction)     extra.push(`<div style="color:#666;"><b>Next:</b> ${esc(row.nextAction)}</div>`);
  if (row.error)          extra.push(`<div style="color:#dc3545;"><b>Error:</b> ${esc(row.error)}</div>`);
  return `<div style="font-family:monospace;font-size:11px;background:#fafafa;padding:8px 10px;border-left:3px solid #6f42c1;">${lines}${extra.join('')}</div>`;
}

function renderTriageRows(rows, dryRun) {
  if (!rows.length) return '<div style="color:#888;font-size:12px;padding:8px 0;">No results yet…</div>';
  const th = 'padding:5px 8px;border:1px solid #ddd;text-align:left;';
  const td = 'padding:5px 8px;border:1px solid #ddd;vertical-align:top;';
  const body = rows.map((r, i) => {
    const tint = dryRun ? 'background:#fffdf5;' : '';
    const days = r.daysUntil == null ? '' :
      `<span style="color:${r.daysUntil <= 3 ? '#dc3545' : '#666'};font-weight:${r.daysUntil <= 3 ? '600' : '400'};">d+${r.daysUntil}</span>`;
    const cls = r.classification
      ? ({ booking_reconf: '🏨 reconf', customer: '💬 customer', booking_voucher: '🎟 voucher', unsupported_product: '⏭ n/a' }[r.classification] || esc(r.classification))
      : '—';
    const conf = r.confidence && r.confidence !== 'high' ? ` <span style="color:#b8860b;font-size:10px;">(${esc(r.confidence)})</span>` : '';
    return `
      <tr style="${tint}">
        <td style="${td}"><a href="${r.url}" target="_blank">#${r.ticketId}</a></td>
        <td style="${td}" title="${esc(r.subject)}">${esc((r.subject || '').slice(0, 42))}</td>
        <td style="${td}">${esc(r.internalId || r.bookingId || '—')}${r.supplierId ? `<br><span style="color:#888;">${esc(r.supplierId)}</span>` : ''}</td>
        <td style="${td}">${esc(r.productType || '—')}</td>
        <td style="${td}">${esc(r.checkIn || '—')}${days ? '<br>' + days : ''}</td>
        <td style="${td}">${cls}${conf}</td>
        <td style="${td}">${triageNoteCell(r)}</td>
        <td style="${td}">${triageActionCell(r)}</td>
        <td style="${td}">${esc(r.verdict || '—')}</td>
        <td style="${td}">${triageOutcomeChip(r.outcome)}</td>
        <td style="${td}"><button data-steps="${i}" style="border:none;background:none;cursor:pointer;color:#6f42c1;font-size:13px;">▸</button></td>
      </tr>
      <tr data-stepsrow="${i}" style="display:none;"><td style="${td}" colspan="11">${triageStepsHtml(r)}</td></tr>`;
  }).join('');

  return `<table style="width:100%;border-collapse:collapse;font-size:12px;">
    <thead><tr style="background:#f5f5f5;">
      <th style="${th}">#</th><th style="${th}">Subject</th><th style="${th}">Booking</th>
      <th style="${th}">Type</th><th style="${th}">Check-in</th><th style="${th}">Class</th>
      <th style="${th}">Note</th><th style="${th}">Action</th><th style="${th}">Verdict</th>
      <th style="${th}">Outcome</th><th style="${th}"></th>
    </tr></thead>
    <tbody>${body}</tbody></table>`;
}

function triageRowsToText(rows) {
  return rows.map(r => [
    `#${r.ticketId}`,
    r.internalId || r.bookingId || '—',
    r.productType || '—',
    r.classification || '—',
    `note:${r.noteState}`,
    r.verdict || '',
    r.outcome,
    r.hotelEmail?.address ? `email:${r.hotelEmail.address}` : '',
    r.relatedTickets?.length ? `related:${r.relatedTickets.map(t => '#' + t.id).join('/')}` : '',
    r.tagsAdded?.length ? `tags:+${r.tagsAdded.join('/')}` : '',
    r.error ? `err:${r.error}` : '',
  ].filter(Boolean).join(' | ')).join('\n');
}

function showBatchTriageModal() {
  const { modal, body } = createModal('taTriageModal', '⚡ Batch Triage', {
    style: 'top:40px;left:50%;transform:translateX(-50%);width:1280px;max-width:calc(100vw - 48px);max-height:92vh;resize:both;overflow:auto;min-width:600px;',
    bodyStyle: 'padding:14px 16px;display:flex;flex-direction:column;gap:12px;',
  });

  // ── Control row ──
  const ctrl = document.createElement('div');
  ctrl.style.cssText = `padding:12px 16px;border-bottom:1px solid ${THEME.border};display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex-shrink:0;`;

  // Mode is picked from two explicit choices rather than one toggle: a toggle
  // whose label shows the CURRENT state reads like a command, and clicking it
  // to "run a dry-run" would actually arm live mode.
  let dryRun = true;
  const modeWrap = document.createElement('div');
  modeWrap.style.cssText = 'display:flex;border:1px solid #ddd;border-radius:6px;overflow:hidden;';

  const dryBtn  = document.createElement('button');
  const liveBtn = document.createElement('button');
  dryBtn.textContent  = '🧪 Dry-run';
  liveBtn.textContent = '🔴 Live';
  dryBtn.title  = 'Analyse everything for real, but only simulate notes, tags and emails. Nothing is modified.';
  liveBtn.title = 'Really post notes, write tags and SEND hotel emails.';

  const styleModeBtns = () => {
    dryBtn.style.cssText = dryRun
      ? 'background:#b8860b;color:#fff;border:none;padding:5px 14px;cursor:pointer;font-size:12px;font-weight:700;'
      : 'background:#fff;color:#999;border:none;padding:5px 14px;cursor:pointer;font-size:12px;font-weight:500;';
    liveBtn.style.cssText = !dryRun
      ? 'background:#dc3545;color:#fff;border:none;padding:5px 14px;cursor:pointer;font-size:12px;font-weight:700;'
      : 'background:#fff;color:#999;border:none;padding:5px 14px;cursor:pointer;font-size:12px;font-weight:500;';
    startBtn.textContent = dryRun ? '▶ Start dry-run' : '▶ Start LIVE run';
    startBtn.style.background = dryRun ? '#6f42c1' : '#dc3545';
  };

  dryBtn.onclick = () => { dryRun = true; styleModeBtns(); };
  liveBtn.onclick = () => {
    if (!dryRun) return;
    const n = selected().length;
    if (!confirm(`Arm LIVE mode?\n\nThis does NOT start the run — it only switches the mode.\n\nWhen you then press Start, ${n} ticket(s) will be really modified: booking notes posted, tags written, and hotel emails SENT to real properties. This cannot be undone.`)) return;
    dryRun = false;
    styleModeBtns();
  };
  modeWrap.append(dryBtn, liveBtn);

  const startBtn = document.createElement('button');
  startBtn.textContent = '▶ Start';
  startBtn.style.cssText = 'background:#6f42c1;color:#fff;border:none;padding:5px 14px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:600;';

  const stopBtn = document.createElement('button');
  stopBtn.textContent = '■ Stop';
  stopBtn.disabled = true;
  stopBtn.style.cssText = `padding:5px 12px;border:1px solid ${THEME.danger};border-radius:5px;background:#fff;color:${THEME.danger};font-size:12px;cursor:pointer;opacity:0.4;`;

  const queueInfo = document.createElement('div');
  queueInfo.style.cssText = 'font-size:12px;color:#666;margin-left:auto;';
  queueInfo.textContent = 'Loading queue…';

  ctrl.append(modeWrap, startBtn, stopBtn, queueInfo);
  modal.insertBefore(ctrl, body);
  styleModeBtns(); // after startBtn exists — it styles that too

  // ── Queue preview (checkbox list) ──
  const preview = document.createElement('details');
  preview.style.cssText = 'font-size:12px;';
  preview.innerHTML = '<summary style="cursor:pointer;color:#6f42c1;font-weight:600;">Queue</summary>';
  const previewList = document.createElement('div');
  previewList.style.cssText = 'max-height:180px;overflow-y:auto;margin-top:6px;border:1px solid #eee;border-radius:5px;padding:6px 8px;';
  preview.appendChild(previewList);

  const progress = document.createElement('div');
  progress.style.cssText = 'font-size:12px;color:#666;';

  const results = document.createElement('div');
  results.style.cssText = 'overflow-x:auto;';

  const logPane = document.createElement('details');
  logPane.style.cssText = 'font-size:11px;';
  logPane.innerHTML = '<summary style="cursor:pointer;color:#888;">Log</summary>';
  const logBox = document.createElement('div');
  logBox.style.cssText = 'font-family:monospace;background:#f8f8f8;padding:8px 10px;max-height:200px;overflow-y:auto;line-height:1.6;margin-top:6px;';
  logPane.appendChild(logBox);

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;';

  body.append(preview, progress, results, footer, logPane);

  let queue = [];
  const selected = () => queue.filter(t => t._checked !== false);

  // Expand/collapse the per-ticket step trail.
  results.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-steps]');
    if (!btn) return;
    const tr = results.querySelector(`[data-stepsrow="${btn.dataset.steps}"]`);
    if (!tr) return;
    const open = tr.style.display !== 'none';
    tr.style.display = open ? 'none' : '';
    btn.textContent = open ? '▸' : '▾';
  });

  // ── Load the queue from the agent's current filter view ──
  (async () => {
    const filterId = _lastFilterId;
    if (!filterId) {
      queueInfo.textContent = 'No filter view captured';
      previewList.innerHTML = '<div style="color:#dc3545;">Open a ticket list / filter view in Freshdesk first, then reopen this panel.</div>';
      startBtn.disabled = true; startBtn.style.opacity = '0.4';
      return;
    }
    try {
      queue = await collectLowPriorityQueue(filterId);
      queueInfo.textContent = `Filter #${filterId} · ${queue.length} LOW ticket(s)`;
      if (!queue.length) {
        previewList.innerHTML = '<div style="color:#888;">No LOW-priority tickets in this view.</div>';
        startBtn.disabled = true; startBtn.style.opacity = '0.4';
        return;
      }
      previewList.innerHTML = queue.map((t, i) =>
        `<label style="display:block;padding:2px 0;cursor:pointer;">
           <input type="checkbox" data-q="${i}" checked style="margin-right:6px;">
           <a href="https://${window.location.hostname}/a/tickets/${t.id}" target="_blank" onclick="event.stopPropagation()">#${t.id}</a>
           <span style="color:#555;">${esc((t.subject || '').slice(0, 80))}</span>
         </label>`).join('');
      previewList.addEventListener('change', (e) => {
        const cb = e.target.closest('[data-q]');
        if (!cb) return;
        queue[Number(cb.dataset.q)]._checked = cb.checked;
        queueInfo.textContent = `Filter #${filterId} · ${selected().length} of ${queue.length} selected`;
      });
    } catch (err) {
      queueInfo.textContent = 'Queue fetch failed';
      previewList.innerHTML = `<div style="color:#dc3545;">${esc(err.message)}</div>`;
      startBtn.disabled = true; startBtn.style.opacity = '0.4';
    }
  })();

  // ── Run ──
  let pollInterval = null;
  const stopPolling = () => {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    startBtn.disabled = false; startBtn.style.opacity = '1';
    stopBtn.disabled = true; stopBtn.style.opacity = '0.4';
    modeWrap.style.pointerEvents = 'auto'; modeWrap.style.opacity = '1';
  };

  let lastLogLen = 0;
  const render = (d) => {
    progress.innerHTML = `<b>${d.processed || 0}</b> / ${d.total || 0} processed` +
      (d.dryRun ? ' <span style="color:#b8860b;">· dry-run, nothing was modified</span>' : ' <span style="color:#dc3545;font-weight:600;">· LIVE</span>') +
      (d.stopped ? ' · <span style="color:#dc3545;">stopped</span>' : '');
    results.innerHTML = renderTriageRows(d.rows || [], d.dryRun);

    (d.log || []).slice(lastLogLen).forEach(m => { logBox.innerHTML += `<div>${esc(m)}</div>`; });
    if ((d.log || []).length !== lastLogLen) { lastLogLen = (d.log || []).length; logBox.scrollTop = logBox.scrollHeight; }

    const counts = Object.entries(d.summary || {}).sort((a, b) => b[1] - a[1]);
    footer.innerHTML = counts.map(([o, n]) => `${triageOutcomeChip(o)} <b>${n}</b>`).join(' &nbsp; ');
    if (d.error) footer.innerHTML += `<div style="color:#dc3545;font-weight:600;width:100%;">❌ ${esc(d.error)}</div>`;
    if ((d.rows || []).length) {
      const copy = document.createElement('button');
      copy.textContent = '📋 Copy';
      copy.style.cssText = 'margin-left:auto;padding:4px 12px;border:1px solid #6c757d;border-radius:5px;background:#fff;color:#6c757d;font-size:12px;cursor:pointer;';
      copy.onclick = () => { navigator.clipboard.writeText(triageRowsToText(d.rows)); showToast('Copied.', 'success', 1500); };
      footer.appendChild(copy);
    }
  };

  const poll = async () => {
    const { ok, data } = await api.triage.status();
    if (!ok) { stopPolling(); logBox.innerHTML += '<div style="color:red;">Status poll failed</div>'; return; }
    render(data);
    if (data.done || data.error) {
      stopPolling();
      showToast(data.error ? `Triage aborted: ${data.error}` : `Triage done — ${data.processed} ticket(s)`, data.error ? 'error' : 'success', 3000);
    }
  };

  startBtn.onclick = async () => {
    const tickets = selected();
    if (!tickets.length) { showToast('No tickets selected.', 'warning'); return; }
    startBtn.disabled = true; startBtn.style.opacity = '0.4';
    stopBtn.disabled = false; stopBtn.style.opacity = '1';
    modeWrap.style.pointerEvents = 'none'; modeWrap.style.opacity = '0.5';
    logBox.innerHTML = ''; lastLogLen = 0;

    const { ok, data } = await api.triage.start({
      tickets: tickets.map(({ _checked, ...t }) => t),
      dryRun,
    });
    if (!ok) {
      logBox.innerHTML += `<div style="color:red;">Failed to start: ${esc(data?.error || 'unknown')}</div>`;
      stopPolling();
      return;
    }
    pollInterval = setInterval(poll, 2000);
    poll();
  };

  stopBtn.onclick = () => {
    stopBtn.disabled = true; stopBtn.textContent = 'Stopping…';
    api.triage.stop().then(() => { stopBtn.textContent = '■ Stop'; });
  };
}

function buildAttachmentUI() {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:6px;display:flex;flex-wrap:wrap;align-items:center;gap:6px;';

  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.multiple = true;
  fileInput.style.display = 'none';

  const attachBtn = document.createElement('button');
  attachBtn.type = 'button'; attachBtn.textContent = '📎 Attach files';
  attachBtn.style.cssText = 'padding:4px 10px;border:1px solid #ddd;border-radius:5px;background:#fff;color:#555;font-size:12px;cursor:pointer;';
  attachBtn.onclick = () => fileInput.click();

  const fileList = document.createElement('div');
  fileList.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';

  let files = [];

  fileInput.onchange = () => {
    files = Array.from(fileInput.files);
    fileList.innerHTML = '';
    files.forEach(function(f, i) {
      const tag = document.createElement('span');
      tag.style.cssText = 'display:flex;align-items:center;gap:4px;padding:2px 8px;background:#e9ecef;border-radius:12px;font-size:11px;color:#333;';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button'; removeBtn.textContent = '×';
      removeBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:#999;font-size:13px;padding:0;line-height:1;';
      removeBtn.onclick = (function(idx, el) { return function() { files.splice(idx, 1); fileList.removeChild(el); }; })(i, tag);
      tag.appendChild(document.createTextNode('📄 ' + f.name + ' '));
      tag.appendChild(removeBtn);
      fileList.appendChild(tag);
    });
  };

  wrap.appendChild(attachBtn); wrap.appendChild(fileInput); wrap.appendChild(fileList);
  return { el: wrap, getFiles: function() { return files; } };
}

function buildReplySignature(recipientType, booking, details, user) {
  const stripHtml = (s) => s ? s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const rawFirst = user && (user.firstName || user.fullName || user.name)
    ? String(user.firstName || user.fullName || user.name).split(' ')[0]
    : '';
  const firstName = rawFirst
    ? rawFirst.charAt(0).toUpperCase() + rawFirst.slice(1).toLowerCase()
    : '';
  const supplierName = booking && booking.supplierName
    ? stripHtml(booking.supplierName).replace(/\s*\(\d+\)\s*$/, '')
    : 'team';

  const greeting = recipientType === 'supplier'
    ? 'Hello dear ' + supplierName + ' team,'
    : (firstName ? 'Hello ' + firstName + ',' : 'Hello,');
  const opener   = 'I hope this email finds you well.';

  const sig = [
    'Sincerely,',
    'Ivan K.',
    'Travel Advantage Support',
    '--------------------------------',
    'member@traveladvantage.com',
    'Belgium: +32 71-96-32-66',
    'Colombia: +571 514-1218',
    'France: +33 27-68-63-387',
    'Germany: +49 911 96 959 007',
    'Italy: +39 02-94-755-846',
    'Peru: +511 707-3968',
    'Portugal: +35 13-0880-2148',
    'Spain: +34 95-156-81-76',
    'USA: +1 857 763 2085',
    'https://www.traveladvantage.com/',
  ].join('\n');

  let body = '[your message here]';
  if (recipientType === 'supplier' && booking) {
    const hotelDisplay = (details && details.hotelName) ? details.hotelName : (booking.supplierName ? stripHtml(booking.supplierName) : null);
    const ref = [
      booking.supplierId ? 'This is in reference to ' + booking.supplierId : null,
      hotelDisplay,
      booking.guestName,
      (booking.checkIn && booking.checkOut) ? booking.checkIn + ' — ' + booking.checkOut : null,
      booking.mwrRoomType,
    ].filter(Boolean).join('\n');
    body = ref + '\n\n[your message here]';
  }

  // Customer-only language disclaimer block sandwiched between body and sign-off.
  const disclaimer = recipientType === 'customer'
    ? [
        '',
        '--',
        'This email is written in English by default. Use your e-mail provider\'s or your browser\'s translation tool / extension to view the contents in your language.',
        '',
        'You can always reply to us in your own language.',
        '--',
      ].join('\n')
    : '';

  return greeting + '\n\n' + opener + '\n\n' + body + disclaimer + '\n\n' + sig;
}

function countryToLanguage(countryCode) {
  const map = {
    RU:'Russian', UA:'Ukrainian', DE:'German', FR:'French', ES:'Spanish',
    IT:'Italian', PT:'Portuguese', BR:'Portuguese', PL:'Polish', NL:'Dutch',
    TR:'Turkish', AR:'Arabic', JA:'Japanese', ZH:'Chinese', KO:'Korean',
    VI:'Vietnamese', TH:'Thai', HI:'Hindi', ID:'Indonesian', SV:'Swedish',
    NO:'Norwegian', DA:'Danish', FI:'Finnish', CS:'Czech', HU:'Hungarian',
    RO:'Romanian', BG:'Bulgarian', HR:'Croatian', SK:'Slovak', SL:'Slovenian',
    HE:'Hebrew', FA:'Persian', MS:'Malay', GR:'Greek', EL:'Greek',
    SR:'Serbian', MK:'Macedonian', KA:'Georgian', AZ:'Azerbaijani',
    AM:'Armenian', HY:'Armenian', ET:'Estonian', LV:'Latvian', LT:'Lithuanian',
  };
  if (!countryCode) return null;
  return map[countryCode.toUpperCase()] || null;
}

// ── Reply composer (supplier / customer) ──────────────────────────────────────
// opts: { recipientType, toEmail, booking, details, user, supplier, body, onSent, ticketId }
//   body — DOM element to render the composer into
//   recipientType — 'customer' | 'supplier'
//   ticketId — overrides the auto-detected Freshdesk ticket id when set
function showReplyComposer(opts) {
  const { recipientType, toEmail, booking, details, user, supplier, body, onSent, ticketId } = opts;
  const overrideTicketId = ticketId || null;
  const bodyEl = body;
  const label = recipientType === 'supplier' ? 'Supplier' : 'Customer';
  bodyEl.innerHTML = '';
  const container = bodyEl;

  // To: header
  const toInfo = document.createElement('div');
  toInfo.style.cssText = 'font-size:12px;color:#666;margin-bottom:6px;';
  toInfo.innerHTML = '<strong>To:</strong> ' + toEmail;
  container.appendChild(toInfo);

  const actionsArea = document.createElement('div');
  actionsArea.style.cssText = 'display:flex;gap:8px;flex-shrink:0;';

  // Header info

  // Editable reply area (contenteditable — preserves pasted HTML, images, links)
  const replyArea = createRichEditor({
    style: `width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #ddd;border-top:none;border-radius:0 0 6px 6px;font-size:13px;font-family:${THEME.font};min-height:200px;line-height:1.5;outline:none;overflow-y:auto;white-space:pre-wrap;word-break:break-word;`,
  });

  // RTF toolbar — basic execCommand-driven formatting. Sits flush above the
  // editor so the two visually form one unit.
  const toolbar = buildRtfToolbar(replyArea);
  container.appendChild(toolbar);
  // Set initial signature as plain text, converting newlines to <br>
  replyArea.textContent = buildReplySignature(recipientType, booking, details, user);
  replyArea.innerHTML = replyArea.innerHTML.replace(/\n/g, '<br>');
  // Place cursor at [your message here]
  setTimeout(() => {
    const walker = document.createTreeWalker(replyArea, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.textContent.indexOf('[your message here]');
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + '[your message here]'.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        replyArea.focus();
        break;
      }
    }
  }, 50);

  container.appendChild(replyArea);

  // Translation row — customer replies only. Country/language info, a manual
  // language field, and a Translate button that translates the draft in-place
  // (original kept below a divider).
  if (recipientType === 'customer') {
    const detectedLang = countryToLanguage(user && user.country);
    const userCountry = (user && user.country) || null;

    const translateRow = document.createElement('div');
    translateRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;';

    if (userCountry || detectedLang) {
      const infoSpan = document.createElement('span');
      infoSpan.style.cssText = 'font-size:11px;color:#888;';
      const parts = [];
      if (userCountry) parts.push('🌍 ' + userCountry);
      if (detectedLang) parts.push('🗣 ' + detectedLang);
      infoSpan.textContent = parts.join('  ·  ');
      translateRow.appendChild(infoSpan);
    }

    const langInput = document.createElement('input');
    langInput.type = 'text';
    langInput.placeholder = detectedLang ? detectedLang : 'Language…';
    langInput.value = detectedLang || '';
    langInput.style.cssText = 'padding:3px 8px;border:1px solid #ccc;border-radius:6px;font-size:12px;width:120px;color:#333;';

    const translateBtn = document.createElement('button');
    translateBtn.textContent = '🌐 Translate';
    translateBtn.style.cssText = 'padding:5px 12px;border:1px solid #17a2b8;border-radius:6px;background:#fff;color:#17a2b8;font-size:12px;cursor:pointer;font-weight:500;';

    translateRow.appendChild(langInput);
    translateRow.appendChild(translateBtn);
    container.appendChild(translateRow);

    translateBtn.onclick = () => withButtonLoading(translateBtn, '⏳ Translating...', async () => {
      const originalHtml = replyArea.innerHTML;
      const originalText = replyArea.innerText.trim();
      if (!originalText) { showToast('Nothing to translate.', 'warning'); return; }

      // Strip sign-off and everything below it before sending to translate.
      const signOffRe = /^\s*(sincerely|best\s+regards?|kind\s+regards?|regards|best|thanks|thank\s+you|warm\s+regards?|yours\s+sincerely|with\s+(?:best\s+)?regards?|cheers|yours\s+truly|faithfully)[,.]?\s*$/i;
      const lines = originalText.split('\n');
      let cutIdx = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (signOffRe.test(lines[i])) { cutIdx = i; break; }
      }
      const textToTranslate = lines.slice(0, cutIdx).join('\n').trim();
      if (!textToTranslate) { showToast('Nothing to translate after stripping sign-off.', 'warning'); return; }

      const lang = langInput.value.trim() || detectedLang || 'en';
      const { ok, data } = await api.translate(textToTranslate, lang);
      if (!ok || !data?.text) { showToast('Translation failed.', 'error'); return; }

      const translatedHtml = data.text.replace(/\n/g, '<br>');
      replyArea.innerHTML =
        `<div><span style="font-size:10px;color:#00897b;font-weight:600;">🌐 ${lang}</span></div>` +
        translatedHtml +
        `<br><hr style="border:none;border-top:1px solid #ddd;margin:8px 0;">` +
        `<div><span style="font-size:10px;color:#aaa;font-weight:600;">📄 Original</span></div>` +
        originalHtml;
    });
  }

  // Attachment picker
  const { el: attachEl, getFiles } = buildAttachmentUI();
  container.appendChild(attachEl);

  // Send action — right-aligned, mimicking Freshdesk's own composer.
  actionsArea.style.display = 'flex';
  actionsArea.style.justifyContent = 'flex-end';
  container.appendChild(actionsArea);

  const sendBtn = document.createElement('button');
  sendBtn.textContent = '📤 Send to ' + label;
  sendBtn.style.cssText = 'padding:7px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#28a745;color:#fff;';
  sendBtn.onclick = async () => {
    const body = replyArea.innerText.trim();
    if (!body) { showToast('Message is empty.', 'warning'); return; }
    const tid = overrideTicketId || getFreshdeskTicketId();
    if (!tid) { showToast('No ticket detected.', 'error'); return; }
    sendBtn.disabled = true; sendBtn.textContent = 'Sending...';
    const refresh = await captureRefresh(tid);
    const noteHtml = replyArea.innerHTML;
    const attachedFiles = getFiles();
    // Send via JSON with base64-encoded files. GM_xmlhttpRequest on
    // Tampermonkey MV3 cannot ferry File objects through the background
    // service worker — multipart bodies arrive empty and FD records an
    // empty stub attachment named after the userscript file.
    let filesPayload = [];
    if (attachedFiles.length > 0) {
      filesPayload = await Promise.all(attachedFiles.map(f => new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
          const result = String(r.result || '');
          const b64 = result.includes(',') ? result.split(',')[1] : result;
          resolve({ name: f.name, type: f.type || 'application/octet-stream', dataBase64: b64 });
        };
        r.onerror = () => reject(new Error('read failed: ' + f.name));
        r.readAsDataURL(f);
      })));
    }
    const { ok } = await api.sendReply({ freshdeskTicketId: tid, toEmail, bodyHtml: noteHtml, files: filesPayload });
    if (ok) { sendBtn.textContent = '✅ Sent!'; showToast('Reply sent to ' + label + '.'); refresh(); if (onSent) onSent(); }
    else    { sendBtn.textContent = '❌ Failed'; sendBtn.disabled = false; }
  };

  actionsArea.appendChild(sendBtn);
}

// Injects the in-Freshdesk toolbar — the Assisted toggle drives prewarming;
// Bulk + Pendings remain for batch workflows. Per-ticket functionality lives
// in the native booking panel + injected strips, not a modal.
function addToolbarButtons() {
  const check = setInterval(() => {
    const container = document.querySelector('.ticket-actions, .page-actions');
    if (!container || document.getElementById('taAssistedToggle')) return;

    const mkBtn = (id, text, color, onClick) => {
      const b = document.createElement('button');
      b.id = id;
      b.textContent = text;
      b.style.cssText = `background:${color};color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);`;
      b.onclick = onClick;
      return b;
    };

    const assistedToggle = document.createElement('button');
    assistedToggle.id = 'taAssistedToggle';
    assistedToggle.title = 'Assisted mode — auto-prewarm every ticket on navigation';
    assistedToggle.onclick = () => setAssistedMode(!_assistedMode);
    styleAssistedToggle(assistedToggle);
    container.appendChild(assistedToggle);
    container.appendChild(mkBtn('taBulkBtn',     '🏨 Bulk',     '#795548', () => showBulkConfirmModal()));
    container.appendChild(mkBtn('taPendingsBtn', '📋 Pendings', '#6c757d', () => showCheckPendingsModal()));
    container.appendChild(mkBtn('taTriageBtn',   '⚡ Triage',   '#6f42c1', () => showBatchTriageModal()));

    clearInterval(check);
  }, 1000);
}

// Track the active ticket so SPA navigation can re-fire injections.
let _lastTicketId = getFreshdeskTicketId();

function checkTicketChange() {
  const currentTicketId = getFreshdeskTicketId();
  const ticketChanged = currentTicketId && currentTicketId !== _lastTicketId;
  if (ticketChanged) {
    _lastTicketId = currentTicketId;
  }
  const currentFilterId = getFreshdeskFilterId();
  if (currentFilterId) _lastFilterId = currentFilterId;
  setTimeout(refreshNativeInjections, 200);
  // Assisted mode: prewarm whenever we land on a new ticket. Small delay so
  // FD's URL/state has settled before we read the current ticket ID.
  if (ticketChanged && _assistedMode) {
    setTimeout(() => prewarmWindow(), 400);
  }
}
const _origPushState = history.pushState;
history.pushState = function(...args) {
  _origPushState.apply(this, args);
  checkTicketChange();
};
window.addEventListener('popstate', () => checkTicketChange());
function gmGet(url) {
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      headers: { 'Content-Type': 'application/json' },
      onload: (res) => {
        try {
          const json = JSON.parse(res.responseText);
          resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, data: json });
        } catch (e) {
          resolve({ ok: false, status: res.status, data: { error: 'Invalid JSON response from server' } });
        }
      },
      onerror: () => resolve({ ok: false, status: 0, data: { error: `Could not reach server at ${url}` } }),
    });
  });
}


function gmPost(url, data) {
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(data),
      onload: (res) => {
        try {
          const json = JSON.parse(res.responseText);
          resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, data: json });
        } catch (e) {
          resolve({ ok: false, status: res.status, data: { error: 'Invalid JSON response from server' } });
        }
      },
      onerror: () => resolve({ ok: false, status: 0, data: { error: `Could not reach server. First request may take ~30s to wake up Render.` } }),
    });
  });
}

addToolbarButtons();
mountNativeInjections();
})();