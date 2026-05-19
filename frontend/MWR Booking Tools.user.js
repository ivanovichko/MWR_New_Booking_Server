// ==UserScript==
// @name         MWR Booking Tools
// @namespace    https://traveladvantage.com
// @version      6.47
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
  // Wraps gmGet / gmPost / gmPostForm in named methods so URLs and request
  // shapes live in one place. Each method returns `{ ok, status, data }`.
  const api = {
    guided: {
      tickets: (filter)        => gmGet(`${BACKEND_URL}/guided-prewarm/tickets?filter=${encodeURIComponent(filter)}`),
      ticket:  (id)            => gmGet(`${BACKEND_URL}/guided-prewarm/ticket/${id}`),
      analyse: (id)            => gmGet(`${BACKEND_URL}/guided-prewarm/analyse/${id}`),
      booking: (id)            => gmGet(`${BACKEND_URL}/guided-prewarm/booking/${encodeURIComponent(id)}`),
      confirm: (body)          => gmPost(`${BACKEND_URL}/guided-prewarm/confirm`, body),
      hotelEmailLookup: (body) => gmPost(`${BACKEND_URL}/guided-prewarm/hotel-email/lookup`, body),
      hotelEmailSend:   (body) => gmPost(`${BACKEND_URL}/guided-prewarm/hotel-email/send`, body),
    },
    postNote:        (ticketId, noteHtml)         => gmPost(`${BACKEND_URL}/post-note`, { freshdeskTicketId: String(ticketId), noteHtml }),
    updateTicket:    (ticketId, fields)           => gmPost(`${BACKEND_URL}/update-ticket`, { ticketId: String(ticketId), fields }),
    closeTicket:     (ticketId)                   => gmPost(`${BACKEND_URL}/close-ticket`, { ticketId: String(ticketId) }),
    mergeTicket:     (body)                       => gmPost(`${BACKEND_URL}/merge-ticket`, body),
    tagTicket:       (body)                       => gmPost(`${BACKEND_URL}/tag-ticket`, body),
    sendReply:       (body)                       => gmPost(`${BACKEND_URL}/send-reply`, body),
    sendReplyForm:   (formData)                   => gmPostForm(`${BACKEND_URL}/send-reply`, formData),
    findUser:        (query)                      => gmPost(`${BACKEND_URL}/find-user`, { query }),
    userReservations:(userId)                     => gmGet(`${BACKEND_URL}/user/${userId}/reservations`),
    searchTickets:   (body)                       => gmPost(`${BACKEND_URL}/search-tickets`, body),
    checkDuplicates: (body)                       => gmPost(`${BACKEND_URL}/check-duplicates`, body),
    translate:       (text, target='en')          => gmPost(`${BACKEND_URL}/translate`, { text, target }),
    aiAssist:        (body)                       => gmPost(`${BACKEND_URL}/ai-assist`, body),
    prompts:         ()                           => gmGet(`${BACKEND_URL}/settings/prompts`),
    macros:          ()                           => gmGet(`${BACKEND_URL}/settings/macros`),
    bulkConfirm:     (tag)                        => gmPost(`${BACKEND_URL}/bulk-confirm`, { tag }),
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
  return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;' +
         'background:' + c.bg + ';color:' + c.fg + ';font-size:11px;font-weight:600;" ' +
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
    'position:fixed;right:20px;top:120px;width:380px;max-height:75vh;' +
    'background:#fff;border:1px solid #e3e3e3;border-radius:10px;' +
    'box-shadow:0 8px 30px rgba(0,0,0,0.2);font-family:system-ui,sans-serif;' +
    'font-size:13px;color:#333;z-index:9998;display:flex;flex-direction:column;overflow:hidden;';
  panel.innerHTML =
    '<div id="' + BOOKING_PANEL_ID + '_header" style="padding:8px 12px;background:#f7f7f7;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;gap:8px;">' +
      '<span style="font-weight:600;display:flex;align-items:center;gap:6px;">📦 Booking' +
        '<span id="' + BOOKING_PANEL_ID + '_spinner" style="display:none;width:10px;height:10px;border:2px solid #ccc;border-top-color:#6f42c1;border-radius:50%;animation:taSpin 0.8s linear infinite;"></span>' +
      '</span>' +
      '<span id="' + BOOKING_PANEL_ID + '_queueCount" style="flex:1;font-size:11px;color:#888;font-weight:400;text-align:right;"></span>' +
      '<span id="' + BOOKING_PANEL_ID + '_toggle" style="cursor:pointer;padding:0 6px;font-size:14px;line-height:1;">−</span>' +
    '</div>' +
    '<div id="' + BOOKING_PANEL_ID + '_body" style="padding:10px;overflow-y:auto;flex:1;"></div>';
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
    body.innerHTML = '<div style="color:#888;">No ticket on this page.</div>';
    return;
  }
  const cached = ticketBookingCache.get(String(ticketId));
  if (cached === undefined) {
    body.innerHTML = '<div style="color:#888;">Loading details, please wait…</div>';
    return;
  }

  body.innerHTML = '';

  // ── No booking case ────────────────────────────────────────────────────────
  if (cached === null || !cached.bookingData) {
    const msg = document.createElement('div');
    msg.style.cssText = 'color:#dc3545;font-size:12px;margin-bottom:8px;';
    msg.textContent = '⚠️ No booking ID found in this ticket.';
    body.appendChild(msg);

    const manualRow = document.createElement('div');
    manualRow.style.cssText = 'display:flex;gap:6px;';
    const manualInput = document.createElement('input');
    manualInput.type = 'text'; manualInput.placeholder = 'Enter booking ID manually...';
    manualInput.style.cssText = 'flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:5px;font-size:12px;';
    const fetchManualBtn = document.createElement('button');
    fetchManualBtn.textContent = '🔍 Fetch';
    fetchManualBtn.style.cssText = 'padding:6px 12px;border:none;border-radius:5px;background:#6f42c1;color:#fff;font-size:12px;cursor:pointer;';
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
    body.appendChild(manualRow);

    // Customer section (fallback path)
    appendCustomerSection(body, getDisplayUser(ticketId, cached), ticketId);
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
    ['Supplier Ref', booking.supplierId || '—'],
    ['Type', booking.productType || '—'],
    ['Supplier', cleanSupplierName(booking.supplierName) || '—'],
    isHotel  ? ['Hotel',   (details && details.hotelName) || '—'] : null,
    isFlight ? ['Airline', (details && details.departAirline) || '—'] : null,
    ['Guest', booking.guestName || '—'],
    ['Check-In', booking.checkIn || '—'],
    ['Check-Out', booking.checkOut || '—'],
    daysUntil !== null ? ['Days until', `${daysUntil} days`] : null,
    booking.mwrRoomType ? ['Room Type', booking.mwrRoomType] : null,
    details && details.arrivalTime ? ['ETA', details.arrivalTime] : null,
    details && details.requests ? ['Requests', '<span style="color:#5d4037;">' + details.requests + '</span>'] : null,
    booking.aiReconfirmation ? ['AI Reconfirm', renderAiReconfirmBadge(booking.aiReconfirmation)] : null,
  ].filter(Boolean);
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
  rows.forEach(([label, val]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th style="padding:4px 8px;text-align:left;color:#888;font-weight:500;width:35%;white-space:nowrap;vertical-align:top;">${label}</th><td style="padding:4px 8px;color:#333;">${val}</td>`;
    table.appendChild(tr);
  });
  body.appendChild(table);

  // Change booking inline row (toggled)
  const changeBookingRow = document.createElement('div');
  changeBookingRow.style.cssText = 'display:none;gap:6px;margin-top:6px;';
  const changeBookingInput = document.createElement('input');
  changeBookingInput.type = 'text'; changeBookingInput.placeholder = 'Enter booking ID...';
  changeBookingInput.value = cached.bookingId || '';
  changeBookingInput.style.cssText = 'flex:1;padding:4px 8px;border:1px solid #ddd;border-radius:4px;font-size:11px;';
  const changeBookingBtn = document.createElement('button');
  changeBookingBtn.textContent = '🔍 Fetch';
  changeBookingBtn.style.cssText = 'padding:4px 10px;border:none;border-radius:4px;background:#6f42c1;color:#fff;font-size:11px;cursor:pointer;';
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
  changeBookingToggle.style.cssText = 'margin-top:6px;padding:2px 8px;border:1px dashed #aaa;border-radius:4px;background:transparent;color:#888;font-size:10px;cursor:pointer;';
  changeBookingToggle.onclick = () => {
    const open = changeBookingRow.style.display !== 'none';
    changeBookingRow.style.display = open ? 'none' : 'flex';
    if (!open) changeBookingInput.focus();
  };
  body.appendChild(changeBookingToggle);
  body.appendChild(changeBookingRow);

  // Always-visible action row: Post Note · View Note · Hotel Email · Chat.
  // 2×2 grid so four buttons fit comfortably in the 380px panel.
  const actionRow = document.createElement('div');
  actionRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:12px;';

  const postNoteBtn = document.createElement('button');
  postNoteBtn.textContent = '📋 Post Note';
  postNoteBtn.style.cssText = 'padding:8px 10px;border:none;border-radius:6px;background:#007bff;color:#fff;font-size:13px;font-weight:600;cursor:pointer;';
  postNoteBtn.onclick = () => withPanelBusy(async () => {
    postNoteBtn.disabled = true; postNoteBtn.textContent = '⏳';
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
      refreshFreshdeskTicket();
    } else {
      postNoteBtn.disabled = false; postNoteBtn.textContent = '📋 Post Note';
      showToast('Post failed: ' + (data?.error || 'unknown'), 'error');
    }
  });

  const hotelEmailBtn = document.createElement('button');
  hotelEmailBtn.textContent = '📧 Hotel Email';
  hotelEmailBtn.style.cssText = 'padding:8px 10px;border:1px solid #28a745;border-radius:6px;background:#fff;color:#28a745;font-size:13px;font-weight:600;cursor:pointer;';
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
        const { ok: sok, data: sd } = await api.guided.hotelEmailSend({
          ticketId: String(ticketId), bookingId: bid, hotelEmail: addr,
        });
        if (!sok) throw new Error(sd?.error || 'Send failed');
        showToast(`✅ Email sent → ${addr}`, 'success', 3000);
        refreshFreshdeskTicket();
      }),
    });
  });

  // View Note — opens the prebuilt noteHtml in a read-only modal.
  const viewNoteBtn = document.createElement('button');
  viewNoteBtn.textContent = '👁️ View Note';
  viewNoteBtn.style.cssText = 'padding:8px 10px;border:1px solid #17a2b8;border-radius:6px;background:#fff;color:#17a2b8;font-size:13px;font-weight:600;cursor:pointer;';
  viewNoteBtn.onclick = () => {
    const noteHtml = cached.bookingData.noteHtml;
    if (!noteHtml) { showToast('Note not built yet.', 'warning'); return; }
    showNoteModal(noteHtml);
  };

  // 💬 Chat — opens the translated-chat modal (AI cleans + translates the
  // conversation thread, optional post-as-note). Migrated from Guided toolbar.
  const chatBtn = document.createElement('button');
  chatBtn.textContent = '💬 Chat';
  chatBtn.style.cssText = 'padding:8px 10px;border:1px solid #e83e8c;border-radius:6px;background:#fff;color:#e83e8c;font-size:13px;font-weight:600;cursor:pointer;';
  chatBtn.onclick = () => showChatModal(String(ticketId), () => refreshFreshdeskTicket());

  actionRow.appendChild(postNoteBtn);
  actionRow.appendChild(viewNoteBtn);
  actionRow.appendChild(hotelEmailBtn);
  actionRow.appendChild(chatBtn);
  body.appendChild(actionRow);

  // Customer section
  appendCustomerSection(body, getDisplayUser(ticketId, cached), ticketId);
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

  const sec = document.createElement('div');
  sec.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px solid #eee;';

  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-weight:600;font-size:11px;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;';
  hdr.textContent = 'Member';
  sec.appendChild(hdr);

  if (user) {
    // Backfill login/profile links if the user came from bookingData (no links added there).
    if (user.id && !user.loginLink)   user.loginLink   = `${TA_BASE}/admin/account/webadminCustomerLogin/${user.id}`;
    if (user.id && !user.profileLink) user.profileLink = `${TA_BASE}/admin/account/viewCustomer/${user.id}`;

    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;border-bottom:1px solid #eee;margin-bottom:8px;';
    const makeTabBtn = (label, active) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `flex:1;padding:5px;border:none;border-bottom:2px solid ${active ? '#007bff' : 'transparent'};background:${active ? '#f8f8f8' : 'transparent'};font-size:11px;font-weight:${active ? '600' : '400'};cursor:pointer;`;
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
      actionRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-bottom:8px;';
      if (user.loginLink) {
        const a = document.createElement('a'); a.href = user.loginLink; a.target = '_blank';
        a.textContent = '🔑 Login as User';
        a.style.cssText = 'display:block;background:#007bff;color:#fff;padding:4px 8px;border-radius:4px;text-decoration:none;font-size:11px;text-align:center;';
        actionRow.appendChild(a);
      }
      if (user.profileLink) {
        const a = document.createElement('a'); a.href = user.profileLink; a.target = '_blank';
        a.textContent = '👤 Open Full Profile';
        a.style.cssText = 'display:block;background:#0056d2;color:#fff;padding:4px 8px;border-radius:4px;text-decoration:none;font-size:11px;text-align:center;';
        actionRow.appendChild(a);
      }
      const memberNoteBtn = document.createElement('button');
      memberNoteBtn.textContent = '📋 Post Member Note';
      memberNoteBtn.style.cssText = 'padding:4px 8px;border:1px solid #28a745;border-radius:4px;background:#fff;color:#28a745;font-size:11px;cursor:pointer;font-weight:500;';
      memberNoteBtn.onclick = () => withPanelBusy(async () => {
        memberNoteBtn.disabled = true; memberNoteBtn.textContent = '⏳';
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
          refreshFreshdeskTicket();
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
        ['Language', user.language],
        ['Status', user.status],
      ].filter(([, val]) => val);
      const uTable = document.createElement('table');
      uTable.style.cssText = 'width:100%;border-collapse:collapse;';
      uRows.forEach(([label, val]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<th style="padding:3px 4px;text-align:left;color:#aaa;font-weight:500;font-size:11px;white-space:nowrap;">${label}</th><td style="padding:3px 4px;color:#333;font-size:11px;word-break:break-all;">${val}</td>`;
        uTable.appendChild(tr);
      });
      tabContent.appendChild(uTable);
    };

    const renderReservationsList = (reservations) => {
      if (!reservations || !reservations.length) return '<div style="color:#888;font-size:11px;">No reservations found.</div>';
      let html = '';
      reservations.forEach((r) => {
        const sc = r.status && r.status.toLowerCase().includes('confirm') ? '#28a745'
                 : r.status && r.status.toLowerCase().includes('cancel')  ? '#6c757d'
                 : r.status && r.status.toLowerCase().includes('fail')    ? '#dc3545' : '#007bff';
        html += `<div data-bookingid="${r.bookingId}" style="padding:5px 7px;border:1px solid #eee;border-radius:4px;margin-bottom:4px;cursor:pointer;font-size:11px;background:#fff;">`;
        html += `<div style="display:flex;justify-content:space-between;align-items:center;">`;
        html += `<span><strong>#${r.bookingId}</strong> <span style="color:#666;font-size:10px;">${r.type || ''}</span></span>`;
        html += `<span style="color:${sc};font-size:10px;font-weight:600;">${r.status || ''}</span>`;
        html += `</div><div style="font-size:10px;color:#666;margin-top:1px;">${r.guest || ''}`;
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
    emptyMsg.style.cssText = 'color:#999;font-size:11px;margin-bottom:6px;';
    emptyMsg.textContent = 'No member data.';
    sec.appendChild(emptyMsg);
  }

  // Find member toggle (always shown)
  const findRow = document.createElement('div');
  findRow.style.cssText = 'display:none;gap:6px;margin-top:6px;';
  const findInput = document.createElement('input');
  findInput.type = 'text'; findInput.placeholder = 'Email or name...';
  findInput.style.cssText = 'flex:1;padding:4px 8px;border:1px solid #ddd;border-radius:4px;font-size:11px;';
  const findBtn = document.createElement('button');
  findBtn.textContent = '🔍 Search';
  findBtn.style.cssText = 'padding:4px 10px;border:none;border-radius:4px;background:#6f42c1;color:#fff;font-size:11px;cursor:pointer;';
  const findResults = document.createElement('div');
  findResults.style.cssText = 'margin-top:4px;font-size:11px;';
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
      item.style.cssText = 'padding:3px 0;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between;gap:8px;';
      const lbl = document.createElement('span');
      lbl.style.cssText = 'color:#333;font-size:11px;';
      lbl.textContent = `${u.name || ''}${u.email ? ' — ' + u.email : ''}`;
      const pickBtn = document.createElement('button');
      pickBtn.textContent = 'Select';
      pickBtn.style.cssText = 'padding:2px 7px;border:1px solid #6f42c1;border-radius:3px;background:#fff;color:#6f42c1;font-size:10px;cursor:pointer;flex-shrink:0;';
      pickBtn.onclick = () => {
        const picked = { ...u, loginLink: `${TA_BASE}/admin/account/webadminCustomerLogin/${u.id}`, profileLink: `${TA_BASE}/admin/account/viewCustomer/${u.id}` };
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
  findToggle.style.cssText = 'margin-top:8px;padding:2px 8px;border:1px dashed #aaa;border-radius:4px;background:transparent;color:#888;font-size:10px;cursor:pointer;';
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
  const wrapper = document.querySelector('.reply-bar-wrapper');
  if (!wrapper || !wrapper.parentElement) return;
  if (document.getElementById(DUP_STRIP_ID)) return;

  const strip = document.createElement('div');
  strip.id = DUP_STRIP_ID;
  strip.style.cssText =
    'margin:12px 0;padding:12px 16px;background:#fff8e1;border:1px solid #ffe082;' +
    'border-radius:8px;font-family:system-ui,sans-serif;font-size:12px;color:#5d4037;' +
    'width:100%;box-sizing:border-box;';
  strip.innerHTML = '<div id="' + DUP_STRIP_ID + '_content">—</div>';
  wrapper.parentElement.insertBefore(strip, wrapper);
  refreshDuplicateStrip();
}

function refreshDuplicateStrip() {
  const content = document.getElementById(DUP_STRIP_ID + '_content');
  if (!content) return;
  const ticketId = getFreshdeskTicketId();
  if (!ticketId) { content.textContent = '—'; return; }
  const cached = ticketBookingCache.get(String(ticketId));
  if (cached === undefined) { content.textContent = 'not prewarmed'; return; }
  if (!cached || !cached.bookingData) {
    // Member fallback (no booking ID) — try email-only duplicate search
    if (cached?.userData?.email) {
      kickDuplicateSearch(ticketId, null, null, cached.userData.email, content);
      return;
    }
    content.textContent = 'no booking ID — nothing to compare';
    return;
  }
  const b = cached.bookingData.booking;
  const u = cached.bookingData.user;
  kickDuplicateSearch(ticketId, b.supplierId, b.internalBookingId, u?.email, content);
}

// Fires /check-duplicates if not already cached; renders results into `content`.
function kickDuplicateSearch(ticketId, vendorConf, internalId, memberEmail, content) {
  const tid = String(ticketId);
  const existing = ticketDuplicatesCache.get(tid);
  if (existing === 'loading') {
    content.textContent = 'searching...';
    return;
  }
  if (Array.isArray(existing)) {
    renderDuplicates(content, existing, ticketId);
    return;
  }
  content.textContent = 'searching...';
  ticketDuplicatesCache.set(tid, 'loading');
  api.checkDuplicates({ vendorConf, internalId, memberEmail, freshdeskTicketId: ticketId }).then(({ ok, data }) => {
    const dups = ok ? (data?.duplicates || []) : [];
    ticketDuplicatesCache.set(tid, dups);
    // Mark badges on the left rail list as well
    dups.forEach((d) => { if (d.id) duplicateTicketIds.add(String(d.id)); });
    if (dups.length) injectTicketListBadges();
    // Only re-render if user is still on this ticket
    if (String(getFreshdeskTicketId()) === tid) {
      const live = document.getElementById(DUP_STRIP_ID + '_content');
      if (live) renderDuplicates(live, dups, ticketId);
    }
  });
}

function renderDuplicates(content, dups, currentTicketId) {
  content.innerHTML = '';
  if (!dups.length) {
    const noRes = document.createElement('div');
    noRes.style.cssText = 'color:#28a745;font-weight:500;margin-bottom:6px;';
    noRes.textContent = '✓ No open threads found.';
    content.appendChild(noRes);
  } else {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-weight:700;font-size:16px;color:#856404;margin-bottom:10px;letter-spacing:0.2px;';
    hdr.textContent = `⚠️ ${dups.length} open thread${dups.length > 1 ? 's' : ''} found`;
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
  row.innerHTML = `<a href="https://${window.location.hostname}/a/tickets/${dup.id}" target="_blank" style="color:#007bff;font-weight:600;font-size:14px;white-space:nowrap;">#${dup.id}</a><span style="flex:1;color:#444;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:120px;">${(dup.subject||'—').replace(/</g,'&lt;')}</span>${statusBadge}${priorityBadge}<span style="color:#6f42c1;font-size:12px;white-space:nowrap;font-weight:500;" title="Assigned to">${assigneeName}</span><span style="color:#aaa;font-size:11px;white-space:nowrap;">${(dup.matchedBy||[]).join(', ')}</span>`;

  const previewBtn = document.createElement('button');
  previewBtn.textContent = 'Preview / Merge';
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

// Preview / Merge: shows the duplicate's messages, each with "Merge into #{current}".
async function showStripDupPreviewModal(dup, currentTicketId, triggerBtn) {
  triggerBtn.disabled = true; triggerBtn.textContent = '⏳';
  const { ok, data: td } = await api.guided.ticket(dup.id);
  triggerBtn.disabled = false; triggerBtn.textContent = 'Preview / Merge';
  if (!ok || !td?.ticket) { showToast('Could not load ticket.', 'error'); return; }

  const pop = document.createElement('div');
  pop.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:660px;max-width:92vw;max-height:78vh;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.3);z-index:1000001;font-family:system-ui,sans-serif;display:flex;flex-direction:column;';
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
}

// Per-conversation controls: clicking the header collapses/expands the
// content; a Translate button lives in the action container next to FD's
// Edit/Delete. All notes except the last two are collapsed by default.
function injectConversationControls() {
  const wrappers = Array.from(document.querySelectorAll('[data-test-id="conversation-wrapper"]'));
  const keepExpanded = new Set(wrappers.slice(-2)); // last two stay open
  wrappers.forEach((wrapper) => {
    if (wrapper.dataset.taControlsInjected) return;
    const header = wrapper.querySelector('.conversation-header');
    const actions = wrapper.querySelector('.conversation-header .ticket-actions-container');
    const content = wrapper.querySelector('[data-test-id="conversation-content-wrapper"]');
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

    // Translate button — lives in the actions container so it doesn't conflict
    // with the header click target.
    if (actions) {
      const noteEl = wrapper.querySelector('[data-test-conversation="conversation-text"]')
                  || wrapper.querySelector('.ticket_note');
      let originalHtml = null;
      let translatedHtml = null;
      let showingTranslated = false;
      const translateBtn = document.createElement('button');
      translateBtn.type = 'button';
      translateBtn.className = 'nucleus-button nucleus-button--small nucleus-button--text ticket-actions';
      translateBtn.title = 'Translate to English';
      translateBtn.style.cssText = 'padding:4px 8px;color:#1976d2;font-size:14px;cursor:pointer;background:transparent;border:none;';
      translateBtn.textContent = '🌐';
      translateBtn.onclick = async (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!noteEl) { showToast('Could not find note content.', 'error'); return; }
        if (showingTranslated) {
          noteEl.innerHTML = originalHtml;
          showingTranslated = false;
          translateBtn.textContent = '🌐'; translateBtn.title = 'Translate to English';
          return;
        }
        if (translatedHtml) {
          originalHtml = noteEl.innerHTML;
          noteEl.innerHTML = translatedHtml;
          showingTranslated = true;
          translateBtn.textContent = '↩'; translateBtn.title = 'Show original';
          return;
        }
        originalHtml = noteEl.innerHTML;
        const text = (noteEl.innerText || '').trim();
        if (!text) { showToast('No text to translate.', 'warning'); return; }
        translateBtn.textContent = '…'; translateBtn.disabled = true;
        const { ok, data } = await api.translate(text, 'en');
        translateBtn.disabled = false;
        if (!ok) {
          translateBtn.textContent = '🌐';
          showToast('Translation failed: ' + (data?.error || 'unknown'), 'error');
          return;
        }
        translatedHtml = (data?.text || '').replace(/\n/g, '<br>');
        noteEl.innerHTML = translatedHtml;
        showingTranslated = true;
        translateBtn.textContent = '↩'; translateBtn.title = 'Show original';
      };
      actions.insertBefore(translateBtn, actions.firstChild);

      // AI Translate (Groq) — passes only this conversation's text to the
      // "translate chat" prompt and opens the result in showChatModal.
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
        const noteId = wrapper.dataset.album || wrapper.id || '';
        const scopeLabel = noteId.replace(/^note_/, 'note ');
        showChatModal(getFreshdeskTicketId(), () => refreshFreshdeskTicket(), {
          content: text,
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
    // Each re-inject (after FD wipes the DOM) sets fresh content via
    // refreshDuplicateStrip() called inside injectDuplicateStrip.
  }, 1500);
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
    modal.style.left = (e.clientX - ox) + 'px';
    modal.style.top  = (e.clientY - oy) + 'px';
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

// ── Confirm modal (replaces confirm()) ────────────────────────────────────────
function showConfirmModal(title, lines, confirmLabel, onConfirm, onCancel, confirmColor = THEME.primary) {
  const { modal, body, closeBtn } = createModal('taConfirmModal', title, {
    style: 'top:120px;left:50%;transform:translateX(-50%);width:420px;',
    bodyStyle: 'padding:14px 18px;font-size:13px;color:#444;line-height:1.8;',
    zIndex: 1000001,
  });
  body.innerHTML = lines.map(l => `<div>${l}</div>`).join('');

  const close = () => modal.remove();
  closeBtn.onclick = () => { close(); onCancel?.(); };

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'padding:0 18px 16px;display:flex;gap:8px;justify-content:flex-end;';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:8px 16px;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#666;';
  cancelBtn.onclick = () => { close(); onCancel?.(); };
  const okBtn = document.createElement('button');
  okBtn.textContent = confirmLabel;
  okBtn.style.cssText = `padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:${confirmColor};color:#fff;`;
  okBtn.onclick = () => { close(); onConfirm(); };
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(okBtn);
  modal.appendChild(btnRow);
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
// 800ms initial delay — gives FD's backend time to index the just-posted
// note/reply before we ask the UI to refetch. Without it, the refresh races
// the write and we see stale data.
function refreshFreshdeskTicket() {
  const candidates = [
    '[data-test-toggle-activity]',
    '[data-test-id="toggle-activity"]',
    '[data-test-id="conversation-refresh"]',
    '[data-test-id="refresh-conversations"]',
    '[aria-label="Refresh"]',
    '[aria-label="Refresh conversations"]',
    'button.refresh-conversation',
  ];
  let btn = null;
  for (const sel of candidates) {
    btn = document.querySelector(sel);
    if (btn) break;
  }
  if (!btn) { console.warn('⚠️ FD refresh button not found — tried', candidates.join(', ')); return; }
  const click = () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  setTimeout(() => {
    click();
    setTimeout(click, 350);
  }, 800);
}



function showNoteModal(noteHtml) {
  const { body } = createModal('taNoteModal', '👁️ Note Preview', {
    style: 'top:60px;left:24px;width:860px;max-width:95vw;',
    bodyStyle: 'max-height:80vh;font-size:13px;line-height:1.6;',
    zIndex: 1000000,
  });
  body.innerHTML = noteHtml;
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
    const noteHtml = '<p>' + text.replace(/\n/g, '<br>') + '</p>';
    const { ok } = await api.postNote(freshdeskTicketId, noteHtml);
    postChatNoteBtn.disabled = false; postChatNoteBtn.textContent = '📋 Post as Note';
    if (ok) { showToast('✅ Note posted!', 'success'); refreshFreshdeskTicket(); onNotePosted?.(); }
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

// ── Guided Prewarm ────────────────────────────────────────────────────────────
async function showGuidedPrewarmModal(singleTicketId = null) {
  const { modal, header: modalHeader, body, closeBtn: modalCloseBtn } = createModal('taGuidedModal', '🎯 Guided Prewarm', {
    style: 'top:40px;left:50%;transform:translateX(-50%);width:2080px;max-width:calc(100vw - 24px);max-height:96vh;',
    bodyStyle: 'display:flex;flex-direction:column;gap:8px;overflow-y:auto;',
    noDrag: true,
  });

  // ── Resume state ───────────────────────────────────────────────────────────
  const GUIDED_STATE_KEY = 'ta_guided_state';
  const savedState = (() => { try { return JSON.parse(localStorage.getItem(GUIDED_STATE_KEY)); } catch { return null; } })();

  let filterKey, resumeTicketId, tickets;

  if (singleTicketId) {
    // ── Single-ticket mode — skip queue picker and list fetch ──────────────
    filterKey = 'single';
    resumeTicketId = null;
    tickets = [{ id: singleTicketId }];
    body.innerHTML = '';
  } else {
    // ── Priority picker ──────────────────────────────────────────────────────
    ({ filterKey, resumeTicketId } = await new Promise((resolve) => {
      body.innerHTML = '';

      // Resume banner
      if (savedState && savedState.filterKey && savedState.ticketId) {
        const filterLabels = { high: '🔴 High', medium: '🟡 Medium', low: '🟢 Low', pending: '⏳ Pending' };
        const banner = document.createElement('div');
        banner.style.cssText = 'background:#f0f5ff;border:1px solid #0056d2;border-radius:8px;padding:10px 16px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;';
        const bannerText = document.createElement('span');
        bannerText.style.cssText = 'font-size:12px;color:#0056d2;';
        bannerText.innerHTML = `<strong>Resume?</strong> Last session: ${filterLabels[savedState.filterKey] || savedState.filterKey} queue — ticket <strong>#${savedState.ticketId}</strong>`;
        const resumeBtn = document.createElement('button');
        resumeBtn.textContent = '▶ Resume';
        resumeBtn.style.cssText = 'padding:6px 14px;border:none;border-radius:6px;background:#0056d2;color:#fff;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;';
        resumeBtn.onclick = () => resolve({ filterKey: savedState.filterKey, resumeTicketId: String(savedState.ticketId) });
        const discardBtn = document.createElement('button');
        discardBtn.textContent = 'Start fresh';
        discardBtn.style.cssText = 'padding:6px 12px;border:1px solid #aaa;border-radius:6px;background:#fff;color:#666;font-size:12px;cursor:pointer;flex-shrink:0;';
        discardBtn.onclick = () => { localStorage.removeItem(GUIDED_STATE_KEY); banner.remove(); };
        banner.appendChild(bannerText); banner.appendChild(resumeBtn); banner.appendChild(discardBtn);
        body.appendChild(banner);
      }

      const label = document.createElement('div');
      label.style.cssText = 'font-size:13px;color:#555;margin-bottom:8px;text-align:center;';
      label.textContent = 'Which queue would you like to work on?';
      body.appendChild(label);

      const grid = document.createElement('div');
      grid.style.cssText = 'display:flex;gap:10px;justify-content:center;';

      const options = [
        { key: 'high',    label: 'High',    color: '#dc3545', bg: '#fff5f5', icon: '🔴' },
        { key: 'medium',  label: 'Medium',  color: '#fd7e14', bg: '#fff8f0', icon: '🟡' },
        { key: 'low',     label: 'Low',     color: '#28a745', bg: '#f5fff8', icon: '🟢' },
        { key: 'pending', label: 'Pending', color: '#0056d2', bg: '#f0f5ff', icon: '⏳' },
      ];
      options.forEach(function(opt) {
        const btn = document.createElement('button');
        btn.style.cssText = 'padding:14px 22px;border:2px solid ' + opt.color + ';border-radius:8px;background:' + opt.bg + ';color:' + opt.color + ';font-size:14px;font-weight:600;cursor:pointer;min-width:100px;';
        btn.innerHTML = opt.icon + '<br><span style="font-size:13px;">' + opt.label + '</span>';
        btn.onclick = function() { resolve({ filterKey: opt.key, resumeTicketId: null }); };
        grid.appendChild(btn);
      });
      body.appendChild(grid);
    }));

    body.innerHTML = '<div style="color:#999;font-size:13px;">Loading tickets...</div>';

    const { ok, data } = await api.guided.tickets(filterKey);
    if (!ok || !data.tickets) {
      body.innerHTML = '<div style="color:red;">❌ Could not load tickets.</div>';
      return;
    }

    tickets = data.tickets;
    if (!tickets.length) { body.innerHTML = '<div style="color:#999;font-size:13px;">No ' + filterKey + ' tickets found.</div>'; return; }
  }

  let idx = 0;
  if (resumeTicketId) {
    const ri = tickets.findIndex(t => String(t.id) === resumeTicketId);
    if (ri >= 0) idx = ri;
  }
  let stopped = false;

  // Pre-fetch cache: fires /ticket and /analyse requests for upcoming tickets
  // so they're ready by the time renderTicket() reaches them.
  const prefetchCache = new Map();
  const prefetch = (i) => {
    if (i < 0 || i >= tickets.length) return;
    const tid = String(tickets[i].id);
    if (prefetchCache.has(tid)) return;
    prefetchCache.set(tid, {
      ticketPromise:  api.guided.ticket(tid),
      analysePromise: api.guided.analyse(tid),
    });
  };

  const renderTicket = async () => {
    if (stopped || idx >= tickets.length) {
      if (!singleTicketId) localStorage.removeItem(GUIDED_STATE_KEY);
      body.innerHTML = `<div style="font-size:13px;color:#333;text-align:center;padding:24px;">${stopped ? '🛑 Stopped.' : '✅ All tickets reviewed!'} (${idx}/${tickets.length})</div>`;
      return;
    }

    const t = tickets[idx];
    // Fire pre-fetch for the next two tickets immediately — gives maximum lead time
    prefetch(idx + 1);
    prefetch(idx + 2);
    if (!singleTicketId) localStorage.setItem(GUIDED_STATE_KEY, JSON.stringify({ filterKey, ticketId: String(t.id) }));
    body.innerHTML = '';

    const prog = document.createElement('div');
    prog.style.cssText = 'font-size:12px;color:#999;margin-bottom:4px;';
    prog.textContent = `Ticket ${idx + 1} of ${tickets.length} — #${t.id}`;
    body.appendChild(prog);

    // ── Button row — inserted into modal header ────────────────────────────────
    const btnRow = document.createElement('div');
    btnRow.id = 'taGuidedBtnRow';
    btnRow.style.cssText = 'display:flex;gap:6px;flex:1;justify-content:center;padding:0 10px;';
    const confirmBtn = document.createElement('button');
    confirmBtn.style.cssText = 'flex:1;max-width:140px;padding:5px 8px;border:none;border-radius:6px;background:#28a745;color:#fff;font-size:12px;font-weight:600;cursor:pointer;opacity:0.4;';
    confirmBtn.textContent = '✅ Confirm';
    confirmBtn.disabled = true;
    const backBtn = document.createElement('button');
    backBtn.style.cssText = 'padding:5px 12px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#666;font-size:12px;cursor:pointer;';
    backBtn.textContent = '◀ Back';
    backBtn.disabled = idx === 0;
    backBtn.style.opacity = idx === 0 ? '0.35' : '1';
    backBtn.onclick = () => { if (idx > 0) { idx--; renderTicket(); } };
    const skipBtn = document.createElement('button');
    skipBtn.style.cssText = 'padding:5px 12px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#666;font-size:12px;cursor:pointer;';
    skipBtn.textContent = '▶ Next';
    skipBtn.onclick = () => { idx++; renderTicket(); };
    const stopBtn = document.createElement('button');
    stopBtn.style.cssText = 'padding:5px 12px;border:1px solid #dc3545;border-radius:6px;background:#fff;color:#dc3545;font-size:12px;cursor:pointer;';
    stopBtn.textContent = '🛑 Stop';
    stopBtn.onclick = () => { stopped = true; renderTicket(); };
    const closeTicketBtn = document.createElement('button');
    closeTicketBtn.style.cssText = 'padding:5px 10px;border:1px solid #6c757d;border-radius:6px;background:#fff;color:#6c757d;font-size:12px;cursor:pointer;';
    closeTicketBtn.textContent = '✖ Close';
    closeTicketBtn.onclick = async () => {
      if (!confirm(`Close ticket #${t.id}?`)) return;
      closeTicketBtn.disabled = true; closeTicketBtn.textContent = '⏳';
      const { ok } = await api.closeTicket(String(t.id) );
      if (ok) { showToast('✅ Ticket closed.', 'success', 2000); idx++; setTimeout(() => renderTicket(), 1000); }
      else { showToast('❌ Could not close ticket.', 'error'); closeTicketBtn.disabled = false; closeTicketBtn.textContent = '✖ Close'; }
    };
    const chatBtnEl = document.createElement('button');
    chatBtnEl.textContent = '💬 Chat';
    chatBtnEl.style.cssText = 'padding:5px 10px;border:1px solid #e83e8c;border-radius:6px;background:#fff;color:#e83e8c;font-size:12px;font-weight:600;cursor:pointer;';
    chatBtnEl.onclick = () => showChatModal(String(t.id), refreshThread);
    btnRow.appendChild(confirmBtn);
    btnRow.appendChild(backBtn);
    btnRow.appendChild(skipBtn);
    btnRow.appendChild(closeTicketBtn);
    btnRow.appendChild(chatBtnEl);
    btnRow.appendChild(stopBtn);
    // Replace any previous btnRow in the modal header
    document.getElementById('taGuidedBtnRow')?.remove();
    modalHeader.insertBefore(btnRow, modalCloseBtn);

    // ── Duplicate / open-threads (collapsible, above columns) ─────────────────
    const dupWrapper = document.createElement('div');
    dupWrapper.style.cssText = 'border:1px solid #eee;border-radius:8px;overflow:hidden;flex-shrink:0;';
    let dupExpanded = false;
    const dupToggle = document.createElement('div');
    dupToggle.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:5px 12px;background:#f8f9fa;cursor:pointer;user-select:none;';
    const dupToggleTitle = document.createElement('span');
    dupToggleTitle.style.cssText = 'font-size:11px;font-weight:600;color:#666;';
    dupToggleTitle.textContent = '🔗 Open Threads';
    const dupToggleArrow = document.createElement('span');
    dupToggleArrow.style.cssText = 'font-size:10px;color:#aaa;';
    dupToggleArrow.textContent = '▶ expand';
    dupToggle.appendChild(dupToggleTitle); dupToggle.appendChild(dupToggleArrow);
    const dupBodyEl = document.createElement('div');
    dupBodyEl.style.cssText = 'padding:8px 12px;display:none;border-top:1px solid #eee;';
    const dupSection = document.createElement('div');
    dupSection.style.cssText = 'font-size:12px;';
    dupSection.innerHTML = '<div style="color:#999;font-size:11px;">⏳ Checking threads...</div>';
    dupBodyEl.appendChild(dupSection);
    dupToggle.onclick = () => {
      dupExpanded = !dupExpanded;
      dupBodyEl.style.display = dupExpanded ? '' : 'none';
      dupToggleArrow.textContent = dupExpanded ? '▼ collapse' : '▶ expand';
    };
    dupWrapper.appendChild(dupToggle); dupWrapper.appendChild(dupBodyEl);
    body.appendChild(dupWrapper);

    // Two-column layout built immediately
    const columns = document.createElement('div');
    columns.style.cssText = 'display:flex;gap:12px;flex:1;min-height:500px;';
    const leftCol = document.createElement('div');
    leftCol.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:8px;min-width:0;';
    const rightCol = document.createElement('div');
    rightCol.style.cssText = 'width:540px;flex-shrink:0;display:flex;flex-direction:column;gap:8px;';
    const infoRow = document.createElement('div');
    infoRow.style.cssText = 'display:flex;flex-direction:column;gap:8px;flex-shrink:0;';
    const bookingSection = document.createElement('div');
    bookingSection.style.cssText = 'border:1px solid #eee;border-radius:8px;padding:12px 14px;font-size:12px;overflow-y:auto;max-height:320px;';
    bookingSection.innerHTML = '<div style="color:#999;font-size:11px;">⏳ Loading booking...</div>';
    const customerSection = document.createElement('div');
    customerSection.style.cssText = 'border:1px solid #eee;border-radius:8px;padding:12px 14px;font-size:12px;overflow-y:auto;max-height:320px;';
    customerSection.innerHTML = '<div style="color:#999;font-size:11px;">No member data</div>';
    infoRow.appendChild(bookingSection); infoRow.appendChild(customerSection);
    rightCol.appendChild(infoRow);

    // Reply panel (collapsible) — sits below booking+customer in rightCol
    const replyPanelWrapper = document.createElement('div');
    replyPanelWrapper.style.cssText = 'display:none;border:1px solid #eee;border-radius:8px;overflow:hidden;flex-shrink:0;';

    let replyPanelExpanded = false;
    const replyPanelToggle = document.createElement('div');
    replyPanelToggle.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:#f8f9fa;cursor:pointer;user-select:none;border-bottom:1px solid transparent;';
    replyPanelToggle.innerHTML = '<span style="font-size:12px;font-weight:600;color:#555;">💬 Reply</span><span style="font-size:11px;color:#aaa;">▶ expand</span>';
    const replyPanelContent = document.createElement('div');
    replyPanelContent.style.display = 'none';

    replyPanelToggle.onclick = () => {
      replyPanelExpanded = !replyPanelExpanded;
      replyPanelContent.style.display = replyPanelExpanded ? '' : 'none';
      replyPanelToggle.style.borderBottomColor = replyPanelExpanded ? '#eee' : 'transparent';
      replyPanelToggle.querySelector('span:last-child').textContent = replyPanelExpanded ? '▼ collapse' : '▶ expand';
    };

    replyPanelWrapper.appendChild(replyPanelToggle);
    replyPanelWrapper.appendChild(replyPanelContent);

    // ── Note panel — its own collapsible, sibling of Reply ─────────────────
    const notePanelWrapper = document.createElement('div');
    notePanelWrapper.style.cssText = 'border:1px solid #eee;border-radius:8px;overflow:hidden;flex-shrink:0;';
    let notePanelExpanded = false;
    let notePanelInitialized = false;
    const notePanelToggle = document.createElement('div');
    notePanelToggle.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:#f8f9fa;cursor:pointer;user-select:none;border-bottom:1px solid transparent;';
    notePanelToggle.innerHTML = '<span style="font-size:12px;font-weight:600;color:#6f42c1;">📝 Note</span><span style="font-size:11px;color:#aaa;">▶ expand</span>';
    const notePanelContent = document.createElement('div');
    notePanelContent.style.display = 'none';
    notePanelContent.style.padding = '10px 14px';
    notePanelToggle.onclick = () => {
      notePanelExpanded = !notePanelExpanded;
      notePanelContent.style.display = notePanelExpanded ? '' : 'none';
      notePanelToggle.style.borderBottomColor = notePanelExpanded ? '#eee' : 'transparent';
      notePanelToggle.querySelector('span:last-child').textContent = notePanelExpanded ? '▼ collapse' : '▶ expand';
      // Lazy-render the editor on first expand so we capture the (by then defined) buildNoteTabContent.
      if (notePanelExpanded && !notePanelInitialized) {
        buildNoteTabContent(notePanelContent);
        notePanelInitialized = true;
      }
    };
    notePanelWrapper.appendChild(notePanelToggle);
    notePanelWrapper.appendChild(notePanelContent);

    columns.appendChild(leftCol); columns.appendChild(rightCol);
    body.appendChild(columns);
    body.appendChild(replyPanelWrapper);
    body.appendChild(notePanelWrapper);

    // Ticket card with description — fetch immediately (fast, no Groq)
    const card = document.createElement('div');
    card.style.cssText = 'border:1px solid #eee;border-radius:8px;overflow:hidden;display:flex;flex-direction:column;flex:1;';
    const cardHeader = document.createElement('div');
    cardHeader.style.cssText = 'background:#f8f9fa;padding:10px 14px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';
    const cardTitleSpan = document.createElement('span');
    cardTitleSpan.style.cssText = 'font-weight:600;font-size:13px;color:#333;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    cardTitleSpan.textContent = `#${t.id} — ${t.subject || '(no subject)'}`;
    const cardActions = document.createElement('div');
    cardActions.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0;';
    const summarizeBtn = document.createElement('button');
    summarizeBtn.textContent = '✨ Summarize';
    summarizeBtn.style.cssText = 'padding:3px 9px;border:1px solid #6f42c1;border-radius:4px;background:#fff;color:#6f42c1;font-size:11px;font-weight:500;cursor:pointer;';
    // Collapse All — sits next to Summarize in the card header. Visibility +
    // state are reset by refreshThread (which builds the message list).
    const collapseAllBtn = document.createElement('button');
    collapseAllBtn.textContent = '⊟ Collapse All';
    collapseAllBtn.style.cssText = 'padding:3px 9px;border:1px solid #ccc;border-radius:4px;background:#fff;color:#666;font-size:11px;font-weight:500;cursor:pointer;display:none;';
    let collapseAllState = false;
    collapseAllBtn.onclick = () => {
      collapseAllState = !collapseAllState;
      descEl.querySelectorAll('[data-collapsible]').forEach(el => {
        el.style.display = collapseAllState ? 'none' : '';
      });
      descEl.querySelectorAll('[data-chevron]').forEach(el => {
        el.style.transform = collapseAllState ? '' : 'rotate(90deg)';
      });
      collapseAllBtn.textContent = collapseAllState ? '⊞ Expand All' : '⊟ Collapse All';
    };
    // ── Inline subject editor ──────────────────────────────────────────────────
    const editSubjectBtn = document.createElement('button');
    editSubjectBtn.textContent = '✏️';
    editSubjectBtn.title = 'Edit subject';
    editSubjectBtn.style.cssText = 'padding:3px 7px;border:1px solid #aaa;border-radius:4px;background:#fff;color:#555;font-size:11px;cursor:pointer;';
    editSubjectBtn.onclick = () => {
      // Replace title span with input
      const currentSubject = t.subject || '';
      const subjectInput = document.createElement('input');
      subjectInput.type = 'text';
      subjectInput.value = currentSubject;
      subjectInput.style.cssText = 'flex:1;min-width:0;padding:3px 8px;border:1px solid #007bff;border-radius:4px;font-size:13px;font-weight:600;color:#333;outline:none;';
      const saveBtn = document.createElement('button');
      saveBtn.textContent = '✓';
      saveBtn.style.cssText = 'padding:3px 8px;border:none;border-radius:4px;background:#007bff;color:#fff;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = '✕';
      cancelBtn.style.cssText = 'padding:3px 8px;border:1px solid #ddd;border-radius:4px;background:#fff;color:#666;font-size:12px;cursor:pointer;flex-shrink:0;';
      cardTitleSpan.replaceWith(subjectInput);
      editSubjectBtn.replaceWith(saveBtn);
      cardActions.insertBefore(cancelBtn, saveBtn.nextSibling);
      subjectInput.focus(); subjectInput.select();
      const doSave = async () => {
        const newSubject = subjectInput.value.trim();
        if (!newSubject) { showToast('Subject cannot be empty.', 'warning'); return; }
        saveBtn.disabled = true; saveBtn.textContent = '⏳';
        const { ok } = await api.updateTicket(String(t.id), { subject: newSubject });
        if (ok) {
          t.subject = newSubject;
          cardTitleSpan.textContent = `#${t.id} — ${newSubject}`;
          subjectInput.replaceWith(cardTitleSpan);
          saveBtn.replaceWith(editSubjectBtn);
          cancelBtn.remove();
          showToast('Subject updated.', 'success');
        } else {
          saveBtn.disabled = false; saveBtn.textContent = '✓';
          showToast('Failed to update subject.', 'error');
        }
      };
      const doCancel = () => {
        subjectInput.replaceWith(cardTitleSpan);
        saveBtn.replaceWith(editSubjectBtn);
        cancelBtn.remove();
      };
      saveBtn.onclick = doSave;
      cancelBtn.onclick = doCancel;
      subjectInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSave();
        if (e.key === 'Escape') doCancel();
      });
    };
    const openLink = document.createElement('a');
    openLink.href = `https://mwrlife.freshdesk.com/a/tickets/${t.id}`;
    openLink.target = '_blank';
    openLink.style.cssText = 'font-size:11px;color:#007bff;';
    openLink.textContent = 'Open ↗';
    const copyLinkBtn = document.createElement('button');
    copyLinkBtn.textContent = '🔗 Copy';
    copyLinkBtn.style.cssText = 'padding:3px 9px;border:1px solid #aaa;border-radius:4px;background:#fff;color:#555;font-size:11px;cursor:pointer;';
    copyLinkBtn.onclick = () => {
      navigator.clipboard.writeText(`https://mwrlife.freshdesk.com/a/tickets/${t.id}`).then(() => {
        copyLinkBtn.textContent = '✅ Copied';
        setTimeout(() => { copyLinkBtn.textContent = '🔗 Copy'; }, 1500);
      });
    };
    cardActions.appendChild(collapseAllBtn);
    cardActions.appendChild(summarizeBtn);
    cardActions.appendChild(editSubjectBtn);
    cardActions.appendChild(copyLinkBtn);
    cardActions.appendChild(openLink);
    cardHeader.appendChild(cardTitleSpan);
    cardHeader.appendChild(cardActions);
    const descEl = document.createElement('div');
    descEl.style.cssText = 'padding:12px 14px;font-size:12px;color:#555;line-height:1.6;overflow-y:auto;flex:1;';
    descEl.innerHTML = '<div style="color:#999;">⏳ Loading...</div>';
    // Status + tags bar — populated by refreshThread after full ticket loads
    const statusTagBar = document.createElement('div');
    statusTagBar.style.cssText = 'display:flex;align-items:center;gap:16px;padding:6px 14px;border-bottom:1px solid #eee;background:#fafafa;font-size:12px;flex-shrink:0;flex-wrap:wrap;';
    statusTagBar.innerHTML = '<span style="color:#ccc;font-size:11px;">⏳</span>';

    card.appendChild(cardHeader);
    card.appendChild(statusTagBar);
    card.appendChild(descEl);
    leftCol.appendChild(card);

    // Shared agent name map — populated when ticket thread loads, used by buildDupRow
    // ── Per-ticket cross-closure state ───────────────────────────────────────
    // Mutable bag shared by nested closures (refreshThread, renderBookingSection,
    // analyse callback, confirm button, etc.). Each field is documented at its
    // declaration so the data flow stays legible.
    const state = {
      agents:    {},   // id → name map; populated when the thread loads
      bookingId: null, // currently-displayed booking id (null until analyse or manual fetch)
      action:    null, // selected confirm-action key: 'note_only' | 'call_hotel' | 'voucher' | ...
      dupCheck:  null, // (booking, user) => void; assigned once the duplicate panel is wired up
    };

    // Fetch / refresh ticket thread
    let _threadCacheUsed = false;
    const refreshThread = () => {
      descEl.innerHTML = '<div style="color:#999;font-size:11px;">⏳ Loading thread...</div>';
      const _pc = !_threadCacheUsed && prefetchCache.get(String(t.id));
      _threadCacheUsed = true;
      const _ticketReq = _pc ? _pc.ticketPromise : api.guided.ticket(t.id);
      _ticketReq.then(({ ok, data: td }) => {
        if (!ok || !td.ticket) { descEl.innerHTML = '<span style="color:#999;">(could not load)</span>'; return; }

        const strip = (html) => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        descEl.innerHTML = '';

        const makeTranslateBtn = (getText) => {
          const btn = document.createElement('button');
          btn.textContent = '🌐 Translate';
          btn.style.cssText = 'margin-top:6px;padding:2px 8px;border:1px solid #17a2b8;border-radius:4px;background:#fff;color:#17a2b8;font-size:11px;cursor:pointer;';
          btn.onclick = async () => {
            btn.disabled = true; btn.textContent = '⏳';
            const text = getText();
            const { ok, data } = await api.translate(text, 'en');
            const parent = btn.parentElement;
            btn.remove();
            const resultEl = document.createElement('div');
            resultEl.style.cssText = 'margin-top:6px;padding:6px 8px;background:#f0fffe;border:1px solid #17a2b8;border-radius:4px;font-size:12px;color:#333;white-space:pre-wrap;';
            resultEl.textContent = (ok && data?.text) ? data.text : '❌ Translation failed.';
            parent && parent.appendChild(resultEl);
          };
          return btn;
        };

        const agents = td.agents || {};
        state.agents = agents; // shared with buildDupRow + status-bar dropdown
        const fmtDate = (iso) => {
          if (!iso) return '';
          const d = new Date(iso);
          return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
            + ' ' + d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
        };

        const addMsg = (label, bg, border, bodyHtml, rawText, meta, defaultCollapsed = false) => {
          const wrap = document.createElement('div');
          wrap.style.cssText = `margin-bottom:6px;background:${bg};border-left:3px solid ${border};border-radius:3px;font-size:12px;line-height:1.5;overflow:hidden;`;

          // Header row — click to collapse/expand
          const hdr = document.createElement('div');
          hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 10px;cursor:pointer;user-select:none;gap:4px;';

          const hdrLeft = document.createElement('div');
          hdrLeft.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;flex:1;';

          const chevron = document.createElement('span');
          chevron.dataset.chevron = '1';
          chevron.style.cssText = 'font-size:10px;color:#bbb;flex-shrink:0;transition:transform .15s;';
          chevron.textContent = '▶';

          const typeSpan = document.createElement('span');
          typeSpan.style.cssText = 'font-size:10px;color:#999;font-weight:600;white-space:nowrap;flex-shrink:0;';
          typeSpan.textContent = label;

          // Author shown inline in header for all types, especially prominent for notes
          const authorSpan = document.createElement('span');
          authorSpan.style.cssText = 'font-size:11px;color:#555;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          if (meta && meta.author) authorSpan.textContent = meta.author;

          hdrLeft.appendChild(chevron);
          hdrLeft.appendChild(typeSpan);
          if (meta && meta.author) hdrLeft.appendChild(authorSpan);

          const metaSpan = document.createElement('span');
          metaSpan.style.cssText = 'font-size:11px;color:#aaa;white-space:nowrap;flex-shrink:0;';
          if (meta && meta.date) metaSpan.textContent = meta.date;

          hdr.appendChild(hdrLeft);
          hdr.appendChild(metaSpan);

          // Collapsible body
          const collapsible = document.createElement('div');
          collapsible.dataset.collapsible = '1';
          collapsible.style.cssText = 'padding:0 10px 8px;';

          if (meta && meta.notified && meta.notified.length) {
            const notifEl = document.createElement('div');
            notifEl.style.cssText = 'font-size:10px;color:#888;margin-bottom:4px;';
            notifEl.textContent = '→ ' + meta.notified.join(', ');
            collapsible.appendChild(notifEl);
          }

          const content = document.createElement('div');
          content.style.cssText = 'word-break:break-word;overflow-wrap:anywhere;';
          content.innerHTML = bodyHtml;
          // Force images / tables to fit the column — original message HTML
          // often has fixed-pixel widths that overflow the (overflow:hidden) wrap.
          content.querySelectorAll('img').forEach(img => {
            img.style.maxWidth = '100%';
            img.style.height = 'auto';
          });
          content.querySelectorAll('table').forEach(t => {
            t.style.maxWidth = '100%';
            t.style.tableLayout = 'auto';
          });
          collapsible.appendChild(content);

          // Attachments
          const atts = (meta && meta.attachments) || [];
          if (atts.length) {
            const attRow = document.createElement('div');
            attRow.style.cssText = 'margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:flex-start;';
            atts.forEach(att => {
              const proxied = `${BACKEND_URL}/attachment?url=${encodeURIComponent(att.attachment_url)}`;
              if (att.content_type && att.content_type.startsWith('image/')) {
                const img = document.createElement('img');
                img.src = proxied;
                img.style.cssText = 'max-width:180px;max-height:130px;border-radius:3px;border:1px solid #ddd;cursor:pointer;object-fit:cover;';
                img.title = att.name;
                img.onclick = () => window.open(proxied, '_blank');
                attRow.appendChild(img);
              } else {
                const link = document.createElement('a');
                link.href = proxied;
                link.target = '_blank';
                link.title = att.name;
                link.style.cssText = 'font-size:11px;color:#0056d2;text-decoration:none;background:#f0f4ff;border:1px solid #b8ccff;border-radius:3px;padding:2px 7px;white-space:nowrap;display:inline-flex;align-items:center;gap:3px;';
                link.textContent = '📎 ' + att.name;
                attRow.appendChild(link);
              }
            });
            collapsible.appendChild(attRow);
          }
          collapsible.appendChild(makeTranslateBtn(() => rawText || strip(bodyHtml)));

          // Apply initial collapsed state
          if (defaultCollapsed) {
            collapsible.style.display = 'none';
            chevron.style.transform = '';
          } else {
            chevron.style.transform = 'rotate(90deg)';
          }

          hdr.onclick = () => {
            const collapsed = collapsible.style.display === 'none';
            collapsible.style.display = collapsed ? '' : 'none';
            chevron.style.transform = collapsed ? 'rotate(90deg)' : '';
          };

          wrap.appendChild(hdr);
          wrap.appendChild(collapsible);
          descEl.appendChild(wrap);
        };

        // Opening description (customer)
        const desc = td.ticket.description || td.ticket.description_text || '';
        if (desc) {
          const bodyHtml = td.ticket.description || strip(desc);
          const meta = {
            author: td.ticket.requester?.name || td.ticket.requester?.email || null,
            date:   fmtDate(td.ticket.created_at),
            notified: [],
            attachments: td.ticket.attachments || [],
          };
          addMsg('📩 Customer (opening)', '#f8f9fa', '#6c757d', bodyHtml, strip(desc), meta, false);
        }

        // Conversations (replies + notes)
        const convs = td.conversations || [];
        convs.forEach(c => {
          const isNote     = c.private;
          const isIncoming = !isNote && c.incoming;
          const label  = isNote ? '📌 Agent note' : isIncoming ? '📩 Customer' : '📤 Agent reply';
          const bg     = isNote ? '#fffbf0' : isIncoming ? '#f8f9fa' : '#f0f4ff';
          const border = isNote ? '#fd7e14'  : isIncoming ? '#6c757d'  : '#0056d2';
          const bodyHtml = c.body || strip(c.body_text || '');
          const author = isIncoming
            ? (c.from_email || null)
            : (agents[c.user_id] || c.from_email || (c.user_id ? `#${c.user_id}` : null));
          const notified = isNote
            ? (c.to_emails || [])
            : (c.to_emails || []);
          addMsg(label, bg, border, bodyHtml, strip(c.body_text || c.body || ''), {
            author,
            date: fmtDate(c.created_at),
            notified,
            attachments: c.attachments || [],
          }, !isIncoming);
        });

        if (!descEl.children.length) descEl.innerHTML = '<span style="color:#999;">(no content)</span>';

        // Reset Collapse All button (lives in cardActions). Show it only when
        // there is more than one message; messages start expanded after a refresh.
        collapseAllState = false;
        collapseAllBtn.textContent = '⊟ Collapse All';
        collapseAllBtn.style.display = (descEl.children.length > 1) ? '' : 'none';
        renderStatusTagBar(td.ticket);
        // Scroll to bottom of thread on every load/refresh
        requestAnimationFrame(() => { descEl.scrollTop = descEl.scrollHeight; });

        // Wire Summarize button once thread is loaded
        summarizeBtn.onclick = async () => {
          const allText = [...descEl.querySelectorAll('div > div:last-of-type')].map(el => el.innerText || el.textContent).join('\n\n').trim()
            || strip(descEl.innerHTML);
          summarizeBtn.disabled = true; summarizeBtn.textContent = '⏳ Summarising...';
          const { ok: aok, data: aiData } = await api.aiAssist({
            booking: {}, details: {}, user: null, supplier: null,
            freshdeskTicketId: String(t.id),
            prompt: 'Summarise this support ticket thread in 3-5 sentences. Focus on the customer issue, what has been done so far, and what still needs to be resolved.\n\n' + allText,
          });
          summarizeBtn.disabled = false; summarizeBtn.textContent = '✨ Summarize';
          document.getElementById('taGuidedSummary_' + t.id)?.remove();
          const box = document.createElement('div');
          box.id = 'taGuidedSummary_' + t.id;
          box.style.cssText = 'margin:8px 14px 0;padding:8px 10px;background:#f3e8ff;border-left:3px solid #6f42c1;border-radius:4px;font-size:12px;color:#333;line-height:1.5;white-space:pre-wrap;';
          box.textContent = (aok && aiData.text) ? aiData.text.trim() : '❌ Summarisation failed.';
          descEl.insertAdjacentElement('beforebegin', box);
        };
      });
    };
    refreshThread();

    // ── Note tab content — drops a paste-aware editor + post button into `body` ─
    const buildNoteTabContent = (body) => {
      body.innerHTML = '';
      const phStyle = document.createElement('style');
      phStyle.textContent = '[data-placeholder]:empty:before{content:attr(data-placeholder);color:#aaa;pointer-events:none;}';
      body.appendChild(phStyle);
      const editor = createRichEditor({
        placeholder: 'Type note here… or paste an image (Ctrl+V)',
        style: `min-height:80px;max-height:220px;overflow-y:auto;border:1px solid #ddd;border-radius:5px;padding:8px 10px;font-size:13px;font-family:${THEME.font};line-height:1.5;color:${THEME.text};outline:none;`,
      });
      body.appendChild(editor);
      const actionsRow = document.createElement('div');
      actionsRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
      const postBtn = document.createElement('button');
      postBtn.textContent = '📤 Post Note';
      postBtn.style.cssText = 'padding:7px 16px;border:none;border-radius:6px;background:#6f42c1;color:#fff;font-size:13px;font-weight:600;cursor:pointer;';
      postBtn.onclick = () => withButtonLoading(postBtn, '⏳ Posting...', async () => {
        const html = editor.innerHTML.trim();
        if (!html) { showToast('Note is empty.', 'warning'); return; }
        const { ok } = await api.postNote(String(t.id), html);
        if (ok) { editor.innerHTML = ''; showToast('✅ Note posted!', 'success', 2000); refreshThread(); }
        else showToast('❌ Failed to post note.', 'error');
      });
      const clearBtn = document.createElement('button');
      clearBtn.textContent = 'Clear';
      clearBtn.style.cssText = 'padding:7px 12px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#666;font-size:13px;cursor:pointer;';
      clearBtn.onclick = () => { editor.innerHTML = ''; editor.focus(); };
      actionsRow.appendChild(postBtn); actionsRow.appendChild(clearBtn);
      body.appendChild(actionsRow);
      setTimeout(() => editor.focus(), 30);
    };

    // ── Status + tag bar renderer ──────────────────────────────────────────────
    const renderStatusTagBar = (ticket) => {
      statusTagBar.innerHTML = '';

      // ── Status section ─────────────────────────────────────────────────────
      const statusLabel = document.createElement('span');
      statusLabel.style.cssText = 'color:#888;font-weight:500;white-space:nowrap;';
      statusLabel.textContent = 'Status:';
      statusTagBar.appendChild(statusLabel);

      const statusMap = { 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' };
      const sel = document.createElement('select');
      sel.style.cssText = 'padding:2px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px;background:#fff;cursor:pointer;';
      Object.entries(statusMap).forEach(([val, label]) => {
        const opt = document.createElement('option');
        opt.value = val; opt.textContent = label;
        if (Number(val) === ticket.status) opt.selected = true;
        sel.appendChild(opt);
      });
      statusTagBar.appendChild(sel);

      // ── Divider ────────────────────────────────────────────────────────────
      const divider = document.createElement('span');
      divider.style.cssText = 'color:#ddd;font-size:14px;';
      divider.textContent = '|';
      statusTagBar.appendChild(divider);

      // ── Priority section ───────────────────────────────────────────────────
      const priorityLabel = document.createElement('span');
      priorityLabel.style.cssText = 'color:#888;font-weight:500;white-space:nowrap;';
      priorityLabel.textContent = 'Priority:';
      statusTagBar.appendChild(priorityLabel);

      const priorityMap = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
      const prioritySel = document.createElement('select');
      prioritySel.style.cssText = 'padding:2px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px;background:#fff;cursor:pointer;';
      Object.entries(priorityMap).forEach(([val, label]) => {
        const opt = document.createElement('option');
        opt.value = val; opt.textContent = label;
        if (Number(val) === ticket.priority) opt.selected = true;
        prioritySel.appendChild(opt);
      });
      statusTagBar.appendChild(prioritySel);

      // ── Divider ────────────────────────────────────────────────────────────
      const divider2 = document.createElement('span');
      divider2.style.cssText = 'color:#ddd;font-size:14px;';
      divider2.textContent = '|';
      statusTagBar.appendChild(divider2);

      // ── Assignee section ───────────────────────────────────────────────────
      const agentLabel = document.createElement('span');
      agentLabel.style.cssText = 'color:#888;font-weight:500;white-space:nowrap;';
      agentLabel.textContent = 'Assignee:';
      statusTagBar.appendChild(agentLabel);

      const agentSel = document.createElement('select');
      agentSel.style.cssText = 'padding:2px 6px;border:1px solid #ddd;border-radius:4px;font-size:12px;background:#fff;cursor:pointer;max-width:180px;';
      const unassignedOpt = document.createElement('option');
      unassignedOpt.value = ''; unassignedOpt.textContent = 'Unassigned';
      if (!ticket.responder_id) unassignedOpt.selected = true;
      agentSel.appendChild(unassignedOpt);
      const sortedAgents = Object.entries(state.agents)
        .map(([id, name]) => ({ id, name: name || `#${id}` }))
        .sort((a, b) => a.name.localeCompare(b.name));
      sortedAgents.forEach(({ id, name }) => {
        const opt = document.createElement('option');
        opt.value = id; opt.textContent = name;
        if (Number(id) === ticket.responder_id) opt.selected = true;
        agentSel.appendChild(opt);
      });
      statusTagBar.appendChild(agentSel);

      // ── Single Update button — pushes status, priority, and assignee ───────
      const updateBtn = document.createElement('button');
      updateBtn.textContent = 'Update';
      updateBtn.style.cssText = 'padding:2px 10px;border:none;border-radius:4px;background:#007bff;color:#fff;font-size:11px;cursor:pointer;font-weight:600;margin-left:4px;';
      updateBtn.onclick = () => withButtonLoading(updateBtn, '⏳', async () => {
        const fields = {};
        const newStatus    = Number(sel.value);
        const newPriority  = Number(prioritySel.value);
        const newResponder = agentSel.value === '' ? null : Number(agentSel.value);
        if (newStatus    !== ticket.status)               fields.status        = newStatus;
        if (newPriority  !== ticket.priority)             fields.priority      = newPriority;
        if (newResponder !== (ticket.responder_id||null)) fields.responder_id  = newResponder;
        if (!Object.keys(fields).length) { showToast('No changes to save', 'info', 1500); return; }
        const { ok } = await api.updateTicket(t.id, fields);
        if (ok) { showToast('✅ Ticket updated', 'success', 2000); refreshThread(); }
        else showToast('❌ Update failed', 'error');
      });
      statusTagBar.appendChild(updateBtn);

      // ── Divider before Tags ────────────────────────────────────────────────
      const divider3 = document.createElement('span');
      divider3.style.cssText = 'color:#ddd;font-size:14px;';
      divider3.textContent = '|';
      statusTagBar.appendChild(divider3);

      // ── Tags section ───────────────────────────────────────────────────────
      const tagsLabel = document.createElement('span');
      tagsLabel.style.cssText = 'color:#888;font-weight:500;white-space:nowrap;';
      tagsLabel.textContent = 'Tags:';
      statusTagBar.appendChild(tagsLabel);

      const pillsContainer = document.createElement('span');
      pillsContainer.style.cssText = 'display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px;';
      statusTagBar.appendChild(pillsContainer);

      let currentTags = [...(ticket.tags || [])];

      const saveTags = async () => {
        const { ok } = await api.updateTicket(String(t.id), { tags: currentTags });
        if (ok) { showToast('✅ Tags saved', 'success', 2000); refreshThread(); }
        else showToast('❌ Failed to save tags', 'error');
      };

      const renderPills = () => {
        pillsContainer.innerHTML = '';
        currentTags.forEach((tag, i) => {
          const pill = document.createElement('span');
          pill.style.cssText = 'background:#e9ecef;color:#444;padding:2px 7px;border-radius:10px;font-size:11px;display:inline-flex;align-items:center;gap:3px;';
          const tagText = document.createTextNode(tag);
          const removeBtn = document.createElement('button');
          removeBtn.textContent = '×';
          removeBtn.style.cssText = 'background:none;border:none;color:#aaa;cursor:pointer;font-size:11px;padding:0;line-height:1;';
          removeBtn.onclick = async () => {
            currentTags.splice(i, 1);
            renderPills();
            await saveTags();
          };
          pill.appendChild(tagText);
          pill.appendChild(removeBtn);
          pillsContainer.appendChild(pill);
        });

        // +Add button
        const addBtn = document.createElement('button');
        addBtn.textContent = '+ Add';
        addBtn.style.cssText = 'padding:2px 8px;border:1px dashed #aaa;border-radius:10px;background:transparent;color:#888;font-size:11px;cursor:pointer;';
        addBtn.onclick = () => {
          addBtn.style.display = 'none';
          const input = document.createElement('input');
          input.type = 'text'; input.placeholder = 'new tag...';
          input.style.cssText = 'padding:2px 6px;border:1px solid #ddd;border-radius:4px;font-size:11px;width:90px;';
          const confirmBtn = document.createElement('button');
          confirmBtn.textContent = '✓';
          confirmBtn.style.cssText = 'padding:2px 6px;border:none;border-radius:4px;background:#28a745;color:#fff;font-size:11px;cursor:pointer;margin-left:3px;';
          const doAdd = async () => {
            const val = input.value.trim();
            if (val && !currentTags.includes(val)) {
              currentTags.push(val);
              renderPills();
              await saveTags();
            } else {
              renderPills(); // just re-render to show +Add again
            }
          };
          confirmBtn.onclick = doAdd;
          input.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); if (e.key === 'Escape') renderPills(); });
          pillsContainer.appendChild(input);
          pillsContainer.appendChild(confirmBtn);
          setTimeout(() => input.focus(), 10);
        };
        pillsContainer.appendChild(addBtn);
      };

      renderPills();
    };

    // Inline reservations renderer (compact, smaller than full profile modal)
    const renderLocalReservations = (reservations) => {
      if (!reservations || !reservations.length) return '<div style="color:#888;font-size:11px;">No reservations found.</div>';
      let html = '';
      reservations.forEach(r => {
        const sc = r.status && r.status.toLowerCase().includes('confirm') ? '#28a745' :
                   r.status && r.status.toLowerCase().includes('cancel')  ? '#6c757d' :
                   r.status && r.status.toLowerCase().includes('fail')    ? '#dc3545' : '#007bff';
        html += `<div data-bookingid="${r.bookingId}" style="padding:5px 7px;border:1px solid #eee;border-radius:4px;margin-bottom:4px;cursor:pointer;font-size:11px;background:#fff;">`;
        html += `<div style="display:flex;justify-content:space-between;align-items:center;">`;
        html += `<span><strong>#${r.bookingId}</strong> <span style="color:#666;font-size:10px;">${r.type||''}</span></span>`;
        html += `<span style="color:${sc};font-size:10px;font-weight:600;">${r.status||''}</span>`;
        html += `</div><div style="font-size:10px;color:#666;margin-top:1px;">${r.guest||''}`;
        if (r.checkIn) html += ` · ${r.checkIn} → ${r.checkOut}`;
        html += `</div></div>`;
      });
      return html;
    };

    const renderCustomerSection = (user) => {
      customerSection.innerHTML = '';
      const ct = document.createElement('div');
      ct.style.cssText = 'font-weight:600;font-size:11px;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;';
      ct.textContent = 'Member';
      customerSection.appendChild(ct);

      if (user) {
        // ── Tab bar: Profile | Reservations ──────────────────────────────────
        const tabBar = document.createElement('div');
        tabBar.style.cssText = 'display:flex;border-bottom:1px solid #eee;margin-bottom:8px;';
        const makeTabBtn = (label, active) => {
          const b = document.createElement('button');
          b.textContent = label;
          b.style.cssText = `flex:1;padding:5px;border:none;border-bottom:2px solid ${active ? '#007bff' : 'transparent'};background:${active ? '#f8f8f8' : 'transparent'};font-size:11px;font-weight:${active ? '600' : '400'};cursor:pointer;`;
          return b;
        };
        const profileTabBtn = makeTabBtn('Profile', true);
        const resTabBtn = makeTabBtn('Reservations', false);
        tabBar.appendChild(profileTabBtn); tabBar.appendChild(resTabBtn);
        customerSection.appendChild(tabBar);

        const tabContent = document.createElement('div');
        customerSection.appendChild(tabContent);

        let reservationsData = null;

        const setActiveTab = (btn) => {
          [profileTabBtn, resTabBtn].forEach(b => {
            b.style.borderBottomColor = b === btn ? '#007bff' : 'transparent';
            b.style.background        = b === btn ? '#f8f8f8' : 'transparent';
            b.style.fontWeight        = b === btn ? '600' : '400';
          });
        };

        const showProfileTab = () => {
          setActiveTab(profileTabBtn);
          tabContent.innerHTML = '';
          // Action buttons
          if (user.loginLink || user.profileLink) {
            const actionRow = document.createElement('div');
            actionRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-bottom:8px;';
            if (user.loginLink) {
              const a = document.createElement('a'); a.href = user.loginLink; a.target = '_blank';
              a.textContent = '🔑 Login as User';
              a.style.cssText = 'display:block;background:#007bff;color:#fff;padding:4px 8px;border-radius:4px;text-decoration:none;font-size:11px;text-align:center;';
              actionRow.appendChild(a);
            }
            if (user.profileLink) {
              const a = document.createElement('a'); a.href = user.profileLink; a.target = '_blank';
              a.textContent = '👤 Open Full Profile';
              a.style.cssText = 'display:block;background:#0056d2;color:#fff;padding:4px 8px;border-radius:4px;text-decoration:none;font-size:11px;text-align:center;';
              actionRow.appendChild(a);
            }
            const postNoteBtn2 = document.createElement('button');
            postNoteBtn2.textContent = '📋 Post Member Note';
            postNoteBtn2.style.cssText = 'padding:4px 8px;border:1px solid #28a745;border-radius:4px;background:#fff;color:#28a745;font-size:11px;cursor:pointer;font-weight:500;';
            postNoteBtn2.onclick = async () => {
              postNoteBtn2.disabled = true; postNoteBtn2.textContent = '⏳';
              const v = val => val || '';
              const fields = [['Name', user.fullName||user.name],['Email', user.email],['Phone', user.phone],['Instance', user.instance],['Status', user.status],['Country', user.country]].filter(([,val]) => val);
              const lines = fields.map(([l, val]) => `<div><strong>${l}:</strong> ${v(val)}</div>`).join('');
              const loginLine   = user.loginLink   ? `<div><strong>Login:</strong> <a href="${user.loginLink}" target="_blank">Login as User</a></div>` : '';
              const profileLine = user.profileLink ? `<div><strong>Profile:</strong> <a href="${user.profileLink}" target="_blank">Open Full Profile</a></div>` : '';
              const noteHtml = `<div style="font-family:system-ui,sans-serif;font-size:13px;line-height:1.8;"><h4 style="margin:0 0 8px;font-size:14px;">👤 Member Details</h4>${lines}${loginLine}${profileLine}</div>`;
              const { ok } = await api.postNote(String(t.id), noteHtml);
              postNoteBtn2.disabled = false; postNoteBtn2.textContent = '📋 Post Member Note';
              if (ok) { showToast('✅ Member note posted!', 'success'); refreshThread(); }
              else showToast('❌ Failed to post note.', 'error');
            };
            actionRow.appendChild(postNoteBtn2);
            tabContent.appendChild(actionRow);
          }
          const uRows = [['Name',user.fullName||user.name],['Email',user.email],['Phone',user.phone],['Country',user.country],['Status',user.status]].filter(([,v])=>v);
          const uTable = document.createElement('table'); uTable.style.cssText = 'width:100%;border-collapse:collapse;';
          uRows.forEach(([label,val]) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<th style="padding:3px 4px;text-align:left;color:#aaa;font-weight:500;font-size:11px;white-space:nowrap;">${label}</th><td style="padding:3px 4px;color:#333;font-size:11px;word-break:break-all;">${val}</td>`;
            uTable.appendChild(tr);
          });
          tabContent.appendChild(uTable);
        };

        const showReservationsTab = async () => {
          setActiveTab(resTabBtn);
          if (!user.id) { tabContent.innerHTML = '<div style="color:#999;font-size:11px;">No user ID.</div>'; return; }
          if (!reservationsData) {
            tabContent.innerHTML = '<div style="color:#999;font-size:11px;">⏳ Loading...</div>';
            const { ok: rok, data: rd } = await api.userReservations(user.id);
            if (!rok) { tabContent.innerHTML = '<div style="color:red;font-size:11px;">Failed to load.</div>'; return; }
            reservationsData = rd.reservations || [];
          }
          tabContent.innerHTML = renderLocalReservations(reservationsData);
          tabContent.querySelectorAll('[data-bookingid]').forEach(el => {
            el.onmouseover = () => { el.style.background = '#f5f5f5'; };
            el.onmouseout  = () => { el.style.background = '#fff'; };
            el.onclick = () => {
              const bid = el.dataset.bookingid;
              state.bookingId = bid;
              api.guided.booking(bid).then(({ ok: fok, data: fd }) => {
                if (fok && fd.bookingData) {
                  renderBookingSection(fd.bookingData, user);
                  state.dupCheck?.(fd.bookingData.booking, fd.bookingData.user);
                } else showToast('Booking not found.', 'error');
              });
            };
          });
        };

        profileTabBtn.onclick = showProfileTab;
        resTabBtn.onclick = showReservationsTab;
        showProfileTab();
      }

      // ── Find different member — always shown ──────────────────────────────
      const findMemberRow = document.createElement('div');
      findMemberRow.style.cssText = 'display:none;gap:6px;margin-top:6px;';
      const findMemberInput = document.createElement('input');
      findMemberInput.type = 'text'; findMemberInput.placeholder = 'Email or name...';
      findMemberInput.style.cssText = 'flex:1;padding:4px 8px;border:1px solid #ddd;border-radius:4px;font-size:11px;';
      const findMemberBtn = document.createElement('button');
      findMemberBtn.textContent = '🔍 Search';
      findMemberBtn.style.cssText = 'padding:4px 10px;border:none;border-radius:4px;background:#6f42c1;color:#fff;font-size:11px;cursor:pointer;';
      const findMemberResults = document.createElement('div');
      findMemberResults.style.cssText = 'margin-top:4px;font-size:11px;';
      findMemberBtn.onclick = async () => {
        const q = findMemberInput.value.trim(); if (!q) return;
        findMemberBtn.disabled = true; findMemberBtn.textContent = '⏳';
        const { ok: uok, data: udata } = await api.findUser(q );
        findMemberBtn.disabled = false; findMemberBtn.textContent = '🔍 Search';
        findMemberResults.innerHTML = '';
        const results = (uok && udata.results) ? udata.results : [];
        if (!results.length) { findMemberResults.textContent = 'No results.'; return; }
        const TA_BASE = 'https://traveladvantage.com';
        results.slice(0, 5).forEach(u => {
          const item = document.createElement('div');
          item.style.cssText = 'padding:3px 0;border-bottom:1px solid #f0f0f0;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;';
          const lbl = document.createElement('span');
          lbl.style.cssText = 'color:#333;font-size:11px;';
          lbl.textContent = `${u.name || ''}${u.email ? ' — ' + u.email : ''}`;
          const pickBtn = document.createElement('button');
          pickBtn.textContent = 'Select';
          pickBtn.style.cssText = 'padding:2px 7px;border:1px solid #6f42c1;border-radius:3px;background:#fff;color:#6f42c1;font-size:10px;cursor:pointer;flex-shrink:0;';
          pickBtn.onclick = () => {
            const pickedUser = { ...u, loginLink: `${TA_BASE}/admin/account/webadminCustomerLogin/${u.id}`, profileLink: `${TA_BASE}/admin/account/viewCustomer/${u.id}` };
            renderCustomerSection(pickedUser);
            if (u.email) {
              replyPanelWrapper.style.display = '';
              replyPanelContent.innerHTML = '';
              const rts = (color, active) =>
                `padding:8px 16px;border:none;border-bottom:2px solid ${active?color:'transparent'};background:${active?'#fff':'transparent'};color:${color};font-size:12px;font-weight:600;cursor:pointer;`;
              const tabBar = document.createElement('div');
              tabBar.style.cssText = 'display:flex;background:#f8f9fa;border-bottom:1px solid #eee;';
              const replyBody = document.createElement('div');
              replyBody.style.cssText = 'padding:10px 14px;';
              const custTab = document.createElement('button');
              custTab.textContent = '📩 Customer';
              custTab.style.cssText = rts('#0056d2', true);
              tabBar.appendChild(custTab);
              replyPanelContent.appendChild(tabBar);
              replyPanelContent.appendChild(replyBody);
              showReplyComposer({ recipientType:'customer', toEmail:u.email, booking:{}, details:{}, user:pickedUser, supplier:null, body:replyBody, onSent:refreshThread, ticketId:String(t.id) });
              replyPanelExpanded = true;
              replyPanelContent.style.display = '';
            }
          };
          item.appendChild(lbl); item.appendChild(pickBtn);
          findMemberResults.appendChild(item);
        });
      };
      findMemberInput.addEventListener('keydown', e => { if (e.key === 'Enter') findMemberBtn.click(); });
      findMemberRow.appendChild(findMemberInput); findMemberRow.appendChild(findMemberBtn);
      const findMemberToggle = document.createElement('button');
      findMemberToggle.textContent = '🔍 Find member';
      findMemberToggle.style.cssText = 'margin-top:6px;padding:2px 8px;border:1px dashed #aaa;border-radius:4px;background:transparent;color:#888;font-size:10px;cursor:pointer;';
      findMemberToggle.onclick = () => {
        const open = findMemberRow.style.display !== 'none';
        findMemberRow.style.display = open ? 'none' : 'flex';
        if (!open) setTimeout(() => findMemberInput.focus(), 10);
      };
      customerSection.appendChild(findMemberToggle);
      customerSection.appendChild(findMemberRow);
      customerSection.appendChild(findMemberResults);
    };

    const renderBookingSection = (bd, userData) => {
      bookingSection.innerHTML = '';
      customerSection.innerHTML = '<div style="color:#999;font-size:11px;">No member data</div>';

      if (!bd) {
        replyPanelWrapper.style.display = 'none';
        const msg = document.createElement('div');
        msg.style.cssText = 'color:#dc3545;font-size:12px;margin-bottom:8px;';
        msg.textContent = state.bookingId ? `⚠️ Could not fetch booking for "${state.bookingId}".` : '⚠️ No booking ID found in this ticket.';
        bookingSection.appendChild(msg);
        const manualRow = document.createElement('div');
        manualRow.style.cssText = 'display:flex;gap:6px;';
        const manualInput = document.createElement('input');
        manualInput.type = 'text'; manualInput.placeholder = 'Enter booking ID manually...';
        manualInput.value = state.bookingId || '';
        manualInput.style.cssText = 'flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:5px;font-size:12px;';
        const fetchManualBtn = document.createElement('button');
        fetchManualBtn.textContent = '🔍 Fetch';
        fetchManualBtn.style.cssText = 'padding:6px 12px;border:none;border-radius:5px;background:#6f42c1;color:#fff;font-size:12px;cursor:pointer;';
        fetchManualBtn.onclick = async () => {
          const id = manualInput.value.trim(); if (!id) return;
          fetchManualBtn.disabled = true; fetchManualBtn.textContent = '⏳';
          const { ok: fok, data: fd } = await api.guided.booking(id);
          fetchManualBtn.disabled = false; fetchManualBtn.textContent = '🔍 Fetch';
          if (fok && fd.bookingData) {
            state.bookingId = id;
            renderBookingSection(fd.bookingData);
            state.dupCheck?.(fd.bookingData.booking, fd.bookingData.user);
          } else showToast('Booking not found in TA.', 'error');
        };
        manualInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchManualBtn.click(); });
        manualRow.appendChild(manualInput); manualRow.appendChild(fetchManualBtn);
        bookingSection.appendChild(manualRow);
        confirmBtn.disabled = true; confirmBtn.style.opacity = '0.4';
        // Populate customer section from userData fallback (no booking found)
        renderCustomerSection(userData || null);
        // Enable reply panel if we have a customer email
        if (userData && userData.email) {
          replyPanelWrapper.style.display = '';
          replyPanelContent.innerHTML = '';
          const rTabStyle = (color, active) =>
            `padding:8px 16px;border:none;border-bottom:2px solid ${active ? color : 'transparent'};background:${active ? '#fff' : 'transparent'};color:${color};font-size:12px;font-weight:600;cursor:pointer;`;
          const replyTabBar = document.createElement('div');
          replyTabBar.style.cssText = 'display:flex;background:#f8f9fa;border-bottom:1px solid #eee;';
          const replyBody = document.createElement('div');
          replyBody.style.cssText = 'padding:10px 14px;';
          const custTabBtn = document.createElement('button');
          custTabBtn.textContent = '📩 Customer';
          custTabBtn.style.cssText = rTabStyle('#0056d2', true);
          custTabBtn.onclick = () => showReplyComposer({ recipientType:'customer', toEmail:userData.email, booking:{}, details:{}, user:userData, supplier:null, body:replyBody, onSent:refreshThread, ticketId:String(t.id) });
          replyTabBar.appendChild(custTabBtn);
          replyPanelContent.appendChild(replyTabBar);
          replyPanelContent.appendChild(replyBody);
          showReplyComposer({ recipientType:'customer', toEmail:userData.email, booking:{}, details:{}, user:userData, supplier:null, body:replyBody, onSent:refreshThread, ticketId:String(t.id) });
        }
        return;
      }

      const { booking, details, user } = bd;
      const cleanSupplierName = (name) => (name || '').replace(/\s*\(\d+\)\s*$/g, '').replace(/\bV\d+\b/gi, '').replace(/\bpackage\b/gi, '').trim();
      const productType = (booking.productType || '').toLowerCase();
      const isHotel    = productType.includes('hotel') || productType.includes('getaway');
      const isFlight   = productType.includes('flight');
      const isTransfer = productType.includes('transfer') || productType.includes('ground');

      let daysUntil = null;
      if (booking.checkIn) {
        const months = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11};
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

      let actionLabel = '📋 Post Note'; let actionColor = '#007bff';
      if (isHotel) {
        if (daysUntil !== null && daysUntil < 3) { state.action = 'call_hotel'; actionLabel = '📞 Tag Call Hotel + High Priority'; actionColor = '#dc3545'; }
        else { state.action = 'note_only'; }
      } else if (isTransfer) { state.action = 'voucher'; actionLabel = '🏷️ Tag Voucher & Move On'; actionColor = '#6c757d'; }
      else { state.action = 'note_only'; }

      confirmBtn.textContent = actionLabel; confirmBtn.style.background = actionColor;
      confirmBtn.disabled = false; confirmBtn.style.opacity = '1';

      const rows = [
        ['Booking ID', booking.internalBookingId || '—'], ['Supplier Ref', booking.supplierId || '—'],
        ['Type', booking.productType || '—'],
        ['Supplier', cleanSupplierName(booking.supplierName) || '—'],
        isHotel ? ['Hotel', (details && details.hotelName) || '—'] : null,
        isFlight ? ['Airline', (details && details.departAirline) || '—'] : null,
        ['Guest', booking.guestName || '—'], ['Check-In', booking.checkIn || '—'], ['Check-Out', booking.checkOut || '—'],
        daysUntil !== null ? ['Days until', `${daysUntil} days`] : null,
        booking.mwrRoomType ? ['Room Type', booking.mwrRoomType] : null,
        booking.aiReconfirmation ? ['AI Reconfirm', renderAiReconfirmBadge(booking.aiReconfirmation)] : null,
      ].filter(Boolean);
      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;';
      rows.forEach(([label, val]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<th style="padding:3px 8px;text-align:left;color:#888;font-weight:500;width:35%;white-space:nowrap;">${label}</th><td style="padding:3px 8px;color:#333;">${val}</td>`;
        table.appendChild(tr);
      });
      bookingSection.appendChild(table);

      // ── Change booking inline row ──────────────────────────────────────────
      const changeBookingRow = document.createElement('div');
      changeBookingRow.style.cssText = 'display:none;gap:6px;margin-top:6px;';
      const changeBookingInput = document.createElement('input');
      changeBookingInput.type = 'text'; changeBookingInput.placeholder = 'Enter booking ID...';
      changeBookingInput.value = state.bookingId || '';
      changeBookingInput.style.cssText = 'flex:1;padding:4px 8px;border:1px solid #ddd;border-radius:4px;font-size:11px;';
      const changeBookingBtn = document.createElement('button');
      changeBookingBtn.textContent = '🔍 Fetch';
      changeBookingBtn.style.cssText = 'padding:4px 10px;border:none;border-radius:4px;background:#6f42c1;color:#fff;font-size:11px;cursor:pointer;';
      changeBookingBtn.onclick = async () => {
        const id = changeBookingInput.value.trim(); if (!id) return;
        changeBookingBtn.disabled = true; changeBookingBtn.textContent = '⏳';
        const { ok: fok, data: fd } = await api.guided.booking(id);
        changeBookingBtn.disabled = false; changeBookingBtn.textContent = '🔍 Fetch';
        if (fok && fd.bookingData) {
          state.bookingId = id;
          renderBookingSection(fd.bookingData);
          state.dupCheck?.(fd.bookingData.booking, fd.bookingData.user);
        } else showToast('Booking not found.', 'error');
      };
      changeBookingInput.addEventListener('keydown', e => { if (e.key === 'Enter') changeBookingBtn.click(); });
      changeBookingRow.appendChild(changeBookingInput); changeBookingRow.appendChild(changeBookingBtn);
      const changeBookingToggle = document.createElement('button');
      changeBookingToggle.textContent = '🔍 Change booking';
      changeBookingToggle.style.cssText = 'margin-top:6px;padding:2px 8px;border:1px dashed #aaa;border-radius:4px;background:transparent;color:#888;font-size:10px;cursor:pointer;';
      changeBookingToggle.onclick = () => {
        const open = changeBookingRow.style.display !== 'none';
        changeBookingRow.style.display = open ? 'none' : 'flex';
        if (!open) changeBookingInput.focus();
      };
      bookingSection.appendChild(changeBookingToggle);
      bookingSection.appendChild(changeBookingRow);

      renderCustomerSection(user || null);

      const replyRowEl = document.createElement('div'); replyRowEl.style.cssText = 'margin-top:10px;display:flex;gap:6px;';
      const postNoteBtn = document.createElement('button');
      postNoteBtn.textContent = '📋 Post Note';
      postNoteBtn.style.cssText = 'padding:7px 10px;border:1px solid #6f42c1;border-radius:5px;background:#fff;color:#6f42c1;font-size:12px;font-weight:600;cursor:pointer;';
      postNoteBtn.onclick = () => withButtonLoading(postNoteBtn, '⏳ Posting...', async () => {
        const { ok, data: cr } = await api.guided.confirm({ ticketId: String(t.id), bookingId: state.bookingId, action: 'note_only', noteHtml: bd.noteHtml || null });
        if (ok) { showToast('✅ Note posted!', 'success', 2000); refreshFreshdeskTicket(); refreshThread(); }
        else showToast('❌ ' + (cr?.error || 'Error'), 'error');
      });
      replyRowEl.appendChild(postNoteBtn);
      if (bd.noteHtml) {
        const viewNoteBtn = document.createElement('button');
        viewNoteBtn.textContent = '👁️ View Note';
        viewNoteBtn.style.cssText = 'padding:7px 10px;border:1px solid #17a2b8;border-radius:5px;background:#fff;color:#17a2b8;font-size:12px;cursor:pointer;';
        viewNoteBtn.onclick = () => showNoteModal(bd.noteHtml);
        replyRowEl.appendChild(viewNoteBtn);
      }
      bookingSection.appendChild(replyRowEl);
      if (isHotel) {
        const hotelEmailBtn = document.createElement('button');
        hotelEmailBtn.textContent = '📧 Hotel Email';
        hotelEmailBtn.style.cssText = 'padding:7px 10px;border:1px solid #28a745;border-radius:5px;background:#fff;color:#28a745;font-size:12px;font-weight:600;cursor:pointer;';
        hotelEmailBtn.onclick = () => withButtonLoading(hotelEmailBtn, '⏳ Looking up...', async () => {
          const { ok: lok, data: ld } = await api.guided.hotelEmailLookup({ ticketId: String(t.id), bookingId: state.bookingId });
          if (!lok) { showToast('❌ Lookup failed: ' + (ld?.error || 'Server error'), 'error'); return; }
          if (ld.tagged?.length) {
            showToast('🏷️ Tagged: ' + ld.tagged.join(', '), 'success', 2000);
            refreshFreshdeskTicket();
          }
          showHotelEmailConfirmModal({
            hotelName:        ld.hotelName,
            emailResult:      ld.emailResult,
            emailHtmlPreview: ld.emailHtmlPreview,
            onSend: async (addr) => {
              const { ok: sok, data: sd } = await api.guided.hotelEmailSend({
                ticketId: String(t.id), bookingId: state.bookingId, hotelEmail: addr,
              });
              if (!sok) throw new Error(sd?.error || 'Send failed');
              showToast(`✅ Email sent → ${addr}`, 'success', 3000);
              refreshFreshdeskTicket(); refreshThread();
            },
          });
        });
        confirmBtn.insertAdjacentElement('afterend', hotelEmailBtn);
      }

      // ── Inline reply panel ─────────────────────────────────────────────────
      replyPanelWrapper.style.display = '';
      replyPanelContent.innerHTML = '';

      const supplierObj    = bd.supplier || null;
      const customerEmail  = user && user.email ? user.email : null;
      const suppEmailFill  = supplierObj && supplierObj.email ? supplierObj.email : '';

      const rTabStyle = (color, active) =>
        `padding:8px 16px;border:none;border-bottom:2px solid ${active ? color : 'transparent'};background:${active ? '#fff' : 'transparent'};color:${color};font-size:12px;font-weight:600;cursor:pointer;`;

      const replyTabBar    = document.createElement('div');
      replyTabBar.style.cssText = 'display:flex;background:#f8f9fa;border-bottom:1px solid #eee;';
      const replyBody      = document.createElement('div');
      replyBody.style.cssText = 'padding:10px 14px;';

      const custTabBtn = document.createElement('button');
      custTabBtn.textContent = '📩 Customer';
      const suppTabBtn = document.createElement('button');
      suppTabBtn.textContent = '📤 Supplier';

      const setReplyTab = (type) => {
        custTabBtn.style.cssText = rTabStyle('#0056d2', type === 'customer');
        suppTabBtn.style.cssText = rTabStyle('#28a745', type === 'supplier');
        replyBody.innerHTML = '';

        if (type === 'customer') {
          if (!customerEmail) {
            replyBody.innerHTML = '<div style="color:#999;font-size:12px;padding:4px 0;">No customer email found.</div>';
            return;
          }
          showReplyComposer({ recipientType:'customer', toEmail:customerEmail, booking, details, user, supplier:supplierObj, body:replyBody, onSent:refreshThread, ticketId:String(t.id) });
        } else {
          // Supplier — editable To: field + textarea + send
          const toRow = document.createElement('div');
          toRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:8px;';
          const toLabel = document.createElement('span');
          toLabel.style.cssText = 'font-size:12px;color:#666;font-weight:500;white-space:nowrap;';
          toLabel.textContent = 'To:';
          const toInput = document.createElement('input');
          toInput.type = 'text'; toInput.value = suppEmailFill;
          toInput.placeholder = 'Supplier email address...';
          toInput.style.cssText = 'flex:1;padding:5px 10px;border:1px solid #ddd;border-radius:5px;font-size:12px;';
          toRow.appendChild(toLabel); toRow.appendChild(toInput);
          replyBody.appendChild(toRow);

          const suppTA = createRichEditor({
            style: `width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;font-family:${THEME.font};min-height:200px;line-height:1.5;outline:none;margin-bottom:8px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;`,
          });
          suppTA.textContent = buildReplySignature('supplier', booking, details, user);
          suppTA.innerHTML = suppTA.innerHTML.replace(/\n/g, '<br>');
          attachMacroTrigger(suppTA, booking, details, user);
          setTimeout(() => {
            const walker = document.createTreeWalker(suppTA, NodeFilter.SHOW_TEXT, null, false);
            let node;
            while ((node = walker.nextNode())) {
              const idx = node.textContent.indexOf('[your message here]');
              if (idx !== -1) {
                const range = document.createRange();
                range.setStart(node, idx); range.setEnd(node, idx + '[your message here]'.length);
                const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
                suppTA.focus(); break;
              }
            }
          }, 50);
          replyBody.appendChild(suppTA);

          const { el: suppAttachEl, getFiles: getSuppFiles } = buildAttachmentUI();
          replyBody.appendChild(suppAttachEl);

          const suppActions = document.createElement('div');
          suppActions.style.cssText = 'display:flex;gap:8px;margin-top:4px;';

          const suppSendBtn = document.createElement('button');
          suppSendBtn.textContent = '📤 Send to Supplier';
          suppSendBtn.style.cssText = 'padding:7px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#28a745;color:#fff;';
          suppSendBtn.onclick = async () => {
            const msgBody = suppTA.innerText.trim();
            const toEmail = toInput.value.trim();
            if (!msgBody) { showToast('Message is empty.', 'warning'); return; }
            if (!toEmail) { showToast('Enter supplier email.', 'warning'); return; }
            suppSendBtn.disabled = true; suppSendBtn.textContent = 'Sending...';
            const noteHtml = suppTA.innerHTML;
            const attachedFiles = getSuppFiles();
            var ok;
            if (attachedFiles.length > 0) {
              var fd = new FormData();
              fd.append('freshdeskTicketId', String(t.id));
              fd.append('toEmail', toEmail);
              fd.append('bodyHtml', noteHtml);
              attachedFiles.forEach(function(f) { fd.append('files', f, f.name); });
              ok = (await api.sendReplyForm(fd)).ok;
            } else {
              ok = (await api.sendReply({ freshdeskTicketId: String(t.id), toEmail, bodyHtml: noteHtml })).ok;
            }
            if (ok) { suppSendBtn.textContent = '✅ Sent!'; showToast('Reply sent to supplier.'); refreshFreshdeskTicket(); refreshThread(); }
            else { suppSendBtn.textContent = '❌ Failed'; suppSendBtn.disabled = false; }
          };

          const suppCopyBtn = document.createElement('button');
          suppCopyBtn.textContent = '📋 Copy';
          suppCopyBtn.style.cssText = 'padding:7px 14px;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#555;';
          suppCopyBtn.onclick = () => {
            navigator.clipboard.writeText(suppTA.innerText).then(() => { suppCopyBtn.textContent = '✅ Copied!'; setTimeout(() => { suppCopyBtn.textContent = '📋 Copy'; }, 2000); });
          };

          suppActions.appendChild(suppSendBtn); suppActions.appendChild(suppCopyBtn);
          replyBody.appendChild(suppActions);
        }
      };

      custTabBtn.onclick = () => setReplyTab('customer');
      suppTabBtn.onclick = () => setReplyTab('supplier');
      replyTabBar.appendChild(custTabBtn); replyTabBar.appendChild(suppTabBtn);
      replyPanelContent.innerHTML = '';
      replyPanelContent.appendChild(replyTabBar); replyPanelContent.appendChild(replyBody);
      setReplyTab(customerEmail ? 'customer' : 'supplier');

      confirmBtn.onclick = async () => {
        confirmBtn.disabled = true; confirmBtn.textContent = '⏳ Processing...';
        const { ok: cok, data: cr } = await api.guided.confirm({ ticketId: String(t.id), bookingId: state.bookingId, action: state.action, noteHtml: bd.noteHtml || null });
        if (!cok) { showToast('❌ Error: ' + (cr?.error || 'Server error'), 'error'); confirmBtn.disabled = false; confirmBtn.textContent = actionLabel; return; }
        const r = cr.results; const msgs = [];
        if (r.notePosted) msgs.push('note posted');
        if (r.emailSent) msgs.push(`email → ${r.hotelEmail}`);
        if (r.fallback) msgs.push('no email → tagged call_hotel');
        if (r.tagged?.length) msgs.push('tagged: ' + r.tagged.join(', '));
        if (r.prioritySet) msgs.push('priority: ' + r.prioritySet);
        showToast('✅ ' + (msgs.join(' · ') || 'Done'), 'success', 3000);
        refreshFreshdeskTicket(); refreshThread();
        confirmBtn.disabled = false; confirmBtn.textContent = actionLabel;
      };
    };

    // Analyse async — Groq + booking (use prefetch cache if available)
    const _pcA = prefetchCache.get(String(t.id));
    const _analyseReq = _pcA ? _pcA.analysePromise : api.guided.analyse(t.id);
    _analyseReq.then(({ ok: aok, data: analysis }) => {
      if (!aok) { bookingSection.innerHTML = '<div style="color:red;font-size:12px;">❌ Analysis failed.</div>'; return; }
      if (analysis.skip) { prog.textContent += ` — skipped (${analysis.reason})`; idx++; renderTicket(); return; }

      state.bookingId = analysis.bookingId;
      renderBookingSection(analysis.bookingData, analysis.userData);

      // ── Open threads / duplicates — dupSection already created above ─────────

      // Helper: build a dup row with Preview/Merge and Merge out buttons
      const buildDupRow = (dup) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f5f5f5;';
          const assigneeName = dup.responder_name || (dup.responder_id ? (state.agents[dup.responder_id] || `#${dup.responder_id}`) : '—');
          // Freshdesk status codes: 2=Open, 3=Pending, 4=Resolved, 5=Closed (6+ are custom)
          const statusInfo = (() => {
            switch (dup.status) {
              case 2: return { label: 'Open',     bg: '#e8f4ff', fg: '#0056d2' };
              case 3: return { label: 'Pending',  bg: '#fff3cd', fg: '#856404' };
              case 4: return { label: 'Resolved', bg: '#e6f4ea', fg: '#1e7e34' };
              case 5: return { label: 'Closed',   bg: '#f1f3f5', fg: '#6c757d' };
              default: return dup.status != null
                ? { label: `Status ${dup.status}`, bg: '#f1f3f5', fg: '#6c757d' }
                : null;
            }
          })();
          const statusBadge = statusInfo
            ? `<span style="background:${statusInfo.bg};color:${statusInfo.fg};font-size:11px;font-weight:600;padding:2px 8px;border-radius:8px;white-space:nowrap;">${statusInfo.label}</span>`
            : '';
          // Freshdesk priority codes: 1=Low, 2=Medium, 3=High, 4=Urgent
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
          row.innerHTML = `<a href="https://mwrlife.freshdesk.com/a/tickets/${dup.id}" target="_blank" style="color:#007bff;font-weight:600;font-size:14px;white-space:nowrap;">#${dup.id}</a><span style="flex:1;color:#444;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${dup.subject||'—'}</span>${statusBadge}${priorityBadge}<span style="color:#6f42c1;font-size:12px;white-space:nowrap;font-weight:500;" title="Assigned to">${assigneeName}</span><span style="color:#aaa;font-size:11px;white-space:nowrap;">${(dup.matchedBy||[]).join(', ')}</span>`;
            const previewBtn = document.createElement('button');
            previewBtn.textContent = 'Preview / Merge';
            previewBtn.style.cssText = 'padding:3px 8px;border:1px solid #fd7e14;border-radius:4px;background:#fff;color:#fd7e14;font-size:11px;cursor:pointer;flex-shrink:0;font-weight:500;';
            previewBtn.onclick = async () => {
              previewBtn.disabled = true; previewBtn.textContent = '⏳';
              const { ok: tok, data: td } = await api.guided.ticket(dup.id);
              previewBtn.disabled = false; previewBtn.textContent = 'Preview / Merge';
              if (!tok || !td.ticket) { showToast('Could not load ticket.', 'error'); return; }

              const pop = document.createElement('div');
              pop.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:660px;max-width:92vw;max-height:78vh;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.3);z-index:1000001;font-family:system-ui,sans-serif;display:flex;flex-direction:column;';
              const popHeader = document.createElement('div');
              popHeader.style.cssText = 'padding:10px 14px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:#fff8f0;border-radius:10px 10px 0 0;';
              const popTitle = document.createElement('span');
              popTitle.style.cssText = 'font-weight:600;font-size:13px;color:#333;';
              popTitle.textContent = `#${dup.id} — ${td.ticket.subject || ''}`;
              const popSubtitle = document.createElement('span');
              popSubtitle.style.cssText = 'font-size:11px;color:#888;margin-left:8px;';
              popSubtitle.textContent = '← click a message to merge it into #' + t.id;
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
              const msgStyle = (bg, border) =>
                `margin-bottom:10px;padding:8px 10px;background:${bg};border-left:3px solid ${border};border-radius:3px;font-size:12px;line-height:1.5;`;
              const popAgents = td.agents || {};
              const popFmtDate = (iso) => {
                if (!iso) return '';
                const d = new Date(iso);
                return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
                  + ' ' + d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
              };

              const addPopMsg = (label, bg, border, bodyHtml, meta) => {
                const wrap = document.createElement('div');
                wrap.style.cssText = msgStyle(bg, border);

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

                const mergeThisBtn = document.createElement('button');
                mergeThisBtn.textContent = '📥 Merge into #' + t.id;
                mergeThisBtn.style.cssText = 'padding:2px 8px;border:1px solid #fd7e14;border-radius:4px;background:#fff;color:#fd7e14;font-size:10px;cursor:pointer;font-weight:600;flex-shrink:0;';
                mergeThisBtn.onclick = async () => {
                  if (!confirm(`Post this message as a note on #${t.id} and close #${dup.id}?`)) return;
                  mergeThisBtn.disabled = true; mergeThisBtn.textContent = '⏳ Merging...';
                  const { ok: mok, data: mr } = await api.mergeTicket({
                    sourceTicketId: String(dup.id),
                    targetTicketId: String(t.id),
                    description: bodyHtml,
                  });
                  if (mok) {
                    pop.remove();
                    showToast(`✅ Merged from #${dup.id} — it has been closed.`, 'success', 3000);
                    refreshThread();
                  } else {
                    showToast('❌ Merge failed: ' + (mr?.error || 'Server error'), 'error');
                    mergeThisBtn.disabled = false; mergeThisBtn.textContent = '📥 Merge into #' + t.id;
                  }
                };

                lbl.appendChild(typeWrap); lbl.appendChild(mergeThisBtn);
                const content = document.createElement('div');
                content.innerHTML = bodyHtml;
                wrap.appendChild(lbl); wrap.appendChild(content);
                popBody.appendChild(wrap);
              };

              // Opening description
              const desc = td.ticket.description || td.ticket.description_text || '';
              if (desc) {
                addPopMsg('📩 Customer (opening)', '#f8f9fa', '#6c757d', td.ticket.description || strip(desc), {
                  author: td.ticket.requester?.name || td.ticket.requester?.email || null,
                  date: popFmtDate(td.ticket.created_at),
                  notified: [],
                });
              }

              // Conversations
              (td.conversations || []).forEach(c => {
                const isNote = c.private;
                const isIncoming = !isNote && c.incoming;
                const label  = isNote ? '📌 Agent note' : isIncoming ? '📩 Customer' : '📤 Agent reply';
                const bg     = isNote ? '#fffbf0' : isIncoming ? '#f8f9fa' : '#f0f4ff';
                const border = isNote ? '#fd7e14'  : isIncoming ? '#6c757d' : '#0056d2';
                const author = isIncoming ? (c.from_email || null) : (popAgents[c.user_id] || c.from_email || null);
                addPopMsg(label, bg, border, c.body || strip(c.body_text || ''), {
                  author,
                  date: popFmtDate(c.created_at),
                  notified: c.to_emails || [],
                });
              });

              if (!popBody.children.length) popBody.innerHTML = '<span style="color:#999;">(no content)</span>';
              pop.appendChild(popHeader); pop.appendChild(popBody);
              document.body.appendChild(pop);
            };
            const mergeOutBtn = document.createElement('button');
            mergeOutBtn.textContent = '📤 Merge out';
            mergeOutBtn.style.cssText = 'padding:3px 8px;border:1px solid #6c757d;border-radius:4px;background:#fff;color:#6c757d;font-size:11px;cursor:pointer;flex-shrink:0;font-weight:500;';
            mergeOutBtn.onclick = async () => {
              mergeOutBtn.disabled = true; mergeOutBtn.textContent = '⏳';
              const { ok: tok, data: td } = await api.guided.ticket(t.id);
              mergeOutBtn.disabled = false; mergeOutBtn.textContent = '📤 Merge out';
              if (!tok || !td.ticket) { showToast('Could not load ticket.', 'error'); return; }

              const pop = document.createElement('div');
              pop.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:660px;max-width:92vw;max-height:82vh;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.3);z-index:1000001;font-family:system-ui,sans-serif;display:flex;flex-direction:column;';

              const popHeader = document.createElement('div');
              popHeader.style.cssText = 'padding:10px 14px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:#f8f9fa;border-radius:10px 10px 0 0;';
              const popTitle = document.createElement('span');
              popTitle.style.cssText = 'font-weight:600;font-size:13px;color:#333;';
              popTitle.textContent = `Merge #${t.id} → #${dup.id}`;
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

              // Editor area at the bottom
              const editorArea = document.createElement('div');
              editorArea.style.cssText = 'padding:10px 14px;border-top:2px solid #fd7e14;flex-shrink:0;background:#fffbf0;';
              const editorLabel = document.createElement('div');
              editorLabel.style.cssText = 'font-size:11px;color:#888;margin-bottom:4px;font-weight:600;';
              editorLabel.textContent = `Note to post on #${dup.id}:`;
              const editorEl = createRichEditor({
                pasteImages: false,
                style: 'min-height:60px;max-height:150px;overflow-y:auto;border:1px solid #ddd;border-radius:4px;padding:6px 8px;font-size:12px;background:#fff;outline:none;',
              });
              editorEl.innerHTML = '<span style="color:#aaa;font-style:italic;">Select a message above…</span>';
              const editorActions = document.createElement('div');
              editorActions.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;margin-top:6px;';
              const confirmMergeBtn = document.createElement('button');
              confirmMergeBtn.textContent = `📤 Merge out → #${dup.id}`;
              confirmMergeBtn.style.cssText = 'padding:4px 12px;border:none;border-radius:4px;background:#6c757d;color:#fff;font-size:11px;cursor:pointer;font-weight:600;';
              confirmMergeBtn.onclick = async () => {
                const bodyToPost = editorEl.innerHTML;
                if (!bodyToPost || bodyToPost.includes('Select a message above')) { showToast('Select a message first.', 'error'); return; }
                if (!confirm(`Merge #${t.id} into #${dup.id}? This will post a note on #${dup.id} and close #${t.id}.`)) return;
                confirmMergeBtn.disabled = true; confirmMergeBtn.textContent = '⏳ Merging...';
                const { ok: mok, data: mr } = await api.mergeTicket({
                  sourceTicketId: String(t.id), targetTicketId: String(dup.id), description: bodyToPost,
                });
                if (mok) {
                  pop.remove();
                  showToast(`✅ Merged #${t.id} into #${dup.id} — ticket closed.`, 'success', 3000);
                  refreshThread(); idx++; setTimeout(() => renderTicket(), 1200);
                } else {
                  showToast('❌ Merge failed: ' + (mr?.error || 'Server error'), 'error');
                  confirmMergeBtn.disabled = false; confirmMergeBtn.textContent = `📤 Merge out → #${dup.id}`;
                }
              };
              editorActions.appendChild(confirmMergeBtn);
              editorArea.appendChild(editorLabel); editorArea.appendChild(editorEl); editorArea.appendChild(editorActions);

              // Render messages from current ticket (t.id)
              const moStrip = (html) => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              const moAgents = td.agents || {};
              const moFmtDate = (iso) => {
                if (!iso) return '';
                const d = new Date(iso);
                return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
                  + ' ' + d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
              };

              const addSelectMsg = (label, bg, border, bodyHtml, meta) => {
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

              // Opening description
              const moDesc = td.ticket.description || td.ticket.description_text || '';
              if (moDesc) {
                addSelectMsg('📩 Customer (opening)', '#f8f9fa', '#6c757d', td.ticket.description || moStrip(moDesc), {
                  author: td.ticket.requester?.name || td.ticket.requester?.email || null,
                  date: moFmtDate(td.ticket.created_at),
                });
              }

              // Conversations
              (td.conversations || []).forEach(c => {
                const isNote = c.private;
                const isIncoming = !isNote && c.incoming;
                const label  = isNote ? '📌 Agent note' : isIncoming ? '📩 Customer' : '📤 Agent reply';
                const bg     = isNote ? '#fffbf0' : isIncoming ? '#f8f9fa' : '#f0f4ff';
                const border = isNote ? '#fd7e14'  : isIncoming ? '#6c757d' : '#0056d2';
                const author = isIncoming ? (c.from_email || null) : (moAgents[c.user_id] || c.from_email || null);
                addSelectMsg(label, bg, border, c.body || moStrip(c.body_text || ''), {
                  author,
                  date: moFmtDate(c.created_at),
                });
              });

              if (!popBody.children.length) popBody.innerHTML = '<span style="color:#999;">(no content)</span>';
              pop.appendChild(popHeader); pop.appendChild(popBody); pop.appendChild(editorArea);
              document.body.appendChild(pop);
            };
          row.appendChild(previewBtn); row.appendChild(mergeOutBtn);
          return row;
        };

      // Renders auto-search results + manual search bar into dupSection
      const renderDupResults = (dups) => {
        dupSection.innerHTML = '';
        // Update toggle title and auto-expand if threads found
        dupToggleTitle.textContent = dups.length > 0 ? `🔗 Open Threads (${dups.length})` : '🔗 Open Threads';
        if (dups.length > 0 && !dupExpanded) {
          dupExpanded = true; dupBodyEl.style.display = ''; dupToggleArrow.textContent = '▼ collapse';
        }
        if (dups.length) {
          const hdr = document.createElement('div');
          hdr.style.cssText = 'font-weight:700;font-size:18px;color:#856404;margin-bottom:10px;letter-spacing:0.2px;';
          hdr.textContent = `⚠️ ${dups.length} open thread${dups.length > 1 ? 's' : ''} found`;
          dupSection.appendChild(hdr);
          dups.forEach(dup => dupSection.appendChild(buildDupRow(dup)));
        } else {
          const noRes = document.createElement('div');
          noRes.style.cssText = 'color:#28a745;font-size:11px;margin-bottom:6px;';
          noRes.textContent = 'No open threads found.';
          dupSection.appendChild(noRes);
        }
        // ── Manual search ────────────────────────────────────────────────────
        const divider = document.createElement('div');
        divider.style.cssText = 'border-top:1px solid #eee;margin:8px 0 6px;';
        dupSection.appendChild(divider);
        const searchRow = document.createElement('div');
        searchRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
        const searchInput = document.createElement('input');
        searchInput.type = 'text'; searchInput.placeholder = 'Search tickets to merge…';
        searchInput.style.cssText = 'flex:1;min-width:120px;padding:3px 6px;border:1px solid #ddd;border-radius:4px;font-size:10px;';
        const closedChk = document.createElement('input');
        closedChk.type = 'checkbox'; closedChk.id = 'manualSearchClosed_' + t.id;
        const closedLbl = document.createElement('label');
        closedLbl.htmlFor = closedChk.id; closedLbl.textContent = 'incl. closed';
        closedLbl.style.cssText = 'font-size:10px;color:#888;white-space:nowrap;cursor:pointer;';
        const searchBtn = document.createElement('button');
        searchBtn.textContent = '🔍 Search';
        searchBtn.style.cssText = 'padding:3px 8px;border:none;border-radius:4px;background:#6f42c1;color:#fff;font-size:10px;cursor:pointer;';
        const manualResults = document.createElement('div');
        manualResults.style.cssText = 'width:100%;margin-top:4px;';
        const doSearch = async () => {
          const q = searchInput.value.trim(); if (!q) return;
          searchBtn.disabled = true; searchBtn.textContent = '⏳';
          const { ok: sok, data: sd } = await api.searchTickets({
            query: q, includeClosed: closedChk.checked, freshdeskTicketId: String(t.id),
          });
          searchBtn.disabled = false; searchBtn.textContent = '🔍 Search';
          manualResults.innerHTML = '';
          const found = (sok && sd.duplicates) ? sd.duplicates : [];
          if (!found.length) { manualResults.innerHTML = '<div style="color:#999;font-size:11px;padding:2px 0;">No results.</div>'; return; }
          found.forEach(dup => manualResults.appendChild(buildDupRow(dup)));
        };
        searchBtn.onclick = doSearch;
        searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
        searchRow.appendChild(searchInput); searchRow.appendChild(closedChk);
        searchRow.appendChild(closedLbl); searchRow.appendChild(searchBtn);
        dupSection.appendChild(searchRow); dupSection.appendChild(manualResults);
      };

      // Single helper used for both initial auto-search and manual booking refetches.
      state.dupCheck = (bookingObj, userObj) => {
        const hasRefs = bookingObj && (bookingObj.supplierId || bookingObj.internalBookingId);
        if (hasRefs) {
          dupSection.innerHTML = '<div style="color:#999;font-size:11px;">Checking for open threads...</div>';
          api.checkDuplicates({
            vendorConf: bookingObj.supplierId,
            internalId: bookingObj.internalBookingId,
            memberEmail: userObj?.email || null,
            freshdeskTicketId: String(t.id),
          }).then(({ ok, data: dd }) => renderDupResults((ok && dd.duplicates) ? dd.duplicates : []));
        } else if (userObj?.email) {
          dupSection.innerHTML = '<div style="color:#999;font-size:11px;">Checking for open threads by member email...</div>';
          api.checkDuplicates({
            memberEmail: userObj.email, freshdeskTicketId: String(t.id),
          }).then(({ ok, data: dd }) => renderDupResults((ok && dd.duplicates) ? dd.duplicates : []));
        } else {
          renderDupResults([]);
        }
      };

      // Auto-search: by booking refs if available, by member email if user-only, else skip
      if (analysis.bookingId && analysis.bookingData) {
        const { booking, user } = analysis.bookingData;
        state.dupCheck(booking, user);
      } else if (analysis.userData && analysis.userData.email) {
        state.dupCheck(null, analysis.userData);
      } else {
        state.dupCheck(null, null);
      }
    });

  };

  renderTicket();
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
  attachMacroTrigger(replyArea, booking, details, user);
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

  // Translation — only for customer replies
  if (recipientType === 'customer') {
    const detectedLang = countryToLanguage(user && user.country);
    const userCountry = (user && user.country) || null;

    // Info bar: country + detected language
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

    // Manual language input
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

      // Strip sign-off and everything below it before sending to AI
      const signOffRe = /^\s*(sincerely|best\s+regards?|kind\s+regards?|regards|best|thanks|thank\s+you|warm\s+regards?|yours\s+sincerely|with\s+(?:best\s+)?regards?|cheers|yours\s+truly|faithfully)[,.]?\s*$/i;
      const lines = originalText.split('\n');
      let cutIdx = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (signOffRe.test(lines[i])) { cutIdx = i; break; }
      }
      const textToTranslate = lines.slice(0, cutIdx).join('\n').trim();
      if (!textToTranslate) { showToast('Nothing to translate after stripping sign-off.', 'warning'); return; }

      const lang = langInput.value.trim() || detectedLang || 'en';
      const { ok, data } = await api.translate(textToTranslate, lang );
      if (!ok || !data?.text) { showToast('Translation failed.', 'error'); return; }

      const translatedHtml = data.text.replace(/\n/g, '<br>');
      // Both translation and original go into replyArea so both are sent.
      // No border wrappers — borders were what caused Enter to clone a
      // visually outlined section inside contenteditable.
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

  // Send + cancel actions
  actionsArea.style.display = 'flex';
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
    const noteHtml = replyArea.innerHTML;
    const attachedFiles = getFiles();
    var ok;
    if (attachedFiles.length > 0) {
      var fd = new FormData();
      fd.append('freshdeskTicketId', tid);
      fd.append('toEmail', toEmail);
      fd.append('bodyHtml', noteHtml);
      attachedFiles.forEach(function(f) { fd.append('files', f, f.name); });
      ok = (await api.sendReplyForm(fd)).ok;
    } else {
      ok = (await api.sendReply({ freshdeskTicketId: tid, toEmail, bodyHtml: noteHtml })).ok;
    }
    if (ok) { sendBtn.textContent = '✅ Sent!'; showToast('Reply sent to ' + label + '.'); refreshFreshdeskTicket(); if (onSent) onSent(); }
    else    { sendBtn.textContent = '❌ Failed'; sendBtn.disabled = false; }
  };

  const copyBtn = document.createElement('button');
  copyBtn.textContent = '📋 Copy';
  copyBtn.style.cssText = 'padding:7px 14px;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#555;';
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(replyArea.innerText).then(() => { copyBtn.textContent = '✅ Copied!'; setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000); });
  };

  // Insert into FD's native composer — lets the agent finish the send via
  // Freshdesk's own flow (attachments, CC, etc) instead of api.sendReply.
  const insertBtn = document.createElement('button');
  insertBtn.textContent = '↘️ Insert into FD';
  insertBtn.style.cssText = 'padding:7px 14px;border:1px solid #fd7e14;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#fd7e14;font-weight:500;';
  insertBtn.onclick = async () => {
    const draftHtml = replyArea.innerHTML;
    if (!draftHtml || !replyArea.innerText.trim()) { showToast('Nothing to insert.', 'warning'); return; }
    let editor = document.querySelector('.fr-element.fr-view[contenteditable="true"]');
    if (!editor) {
      const trigger = document.querySelector('[data-test-id="ticket-action-reply"]');
      if (!trigger) { showToast('Could not find FD composer trigger.', 'error'); return; }
      trigger.click();
      const start = Date.now();
      while (!editor && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 100));
        editor = document.querySelector('.fr-element.fr-view[contenteditable="true"]');
      }
      if (!editor) { showToast('FD composer did not open.', 'error'); return; }
    }
    editor.innerHTML = draftHtml;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    insertBtn.textContent = '✅ Inserted';
    setTimeout(() => { insertBtn.textContent = '↘️ Insert into FD'; }, 1500);
    showToast('Inserted into FD composer.', 'success');
  };

  // Quick Translate — always-available alternative to the customer-only
  // translate row above. Defaults to customer's detected language if known,
  // otherwise prompts.
  const quickTranslateBtn = document.createElement('button');
  quickTranslateBtn.textContent = '🌐 Translate';
  quickTranslateBtn.style.cssText = 'padding:7px 14px;border:1px solid #17a2b8;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#17a2b8;font-weight:500;';
  quickTranslateBtn.onclick = async () => {
    const draftText = (replyArea.innerText || '').trim();
    if (!draftText) { showToast('Nothing to translate.', 'warning'); return; }
    const detected = (user && user.country) ? countryToLanguage(user.country) : null;
    let target = detected;
    if (!target || recipientType === 'supplier') {
      target = prompt('Target language (ISO code or name, e.g. "fr", "es", "ru"):', target || 'en');
      if (!target) return;
    }
    // Strip sign-off and below before sending (same heuristic as the customer row).
    const signOffRe = /^\s*(sincerely|best\s+regards?|kind\s+regards?|regards|best|thanks|thank\s+you|warm\s+regards?|yours\s+sincerely|with\s+(?:best\s+)?regards?|cheers|yours\s+truly|faithfully)[,.]?\s*$/i;
    const lines = draftText.split('\n');
    let cutIdx = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) { if (signOffRe.test(lines[i])) { cutIdx = i; break; } }
    const textToTranslate = lines.slice(0, cutIdx).join('\n').trim() || draftText;

    quickTranslateBtn.disabled = true; quickTranslateBtn.textContent = '⏳';
    const { ok, data } = await api.translate(textToTranslate, target);
    quickTranslateBtn.disabled = false; quickTranslateBtn.textContent = '🌐 Translate';
    if (!ok || !data?.text) { showToast('Translation failed.', 'error'); return; }

    const originalHtml = replyArea.innerHTML;
    const translatedHtml = data.text.replace(/\n/g, '<br>');
    replyArea.innerHTML =
      '<div><span style="font-size:10px;color:#00897b;font-weight:600;">🌐 ' + target + '</span></div>' +
      translatedHtml +
      '<br><hr style="border:none;border-top:1px solid #ddd;margin:8px 0;">' +
      '<div><span style="font-size:10px;color:#aaa;font-weight:600;">📄 Original</span></div>' +
      originalHtml;
    showToast('Translated to ' + target + '.', 'success');
  };

  actionsArea.appendChild(sendBtn);
  actionsArea.appendChild(insertBtn);
  actionsArea.appendChild(quickTranslateBtn);
  actionsArea.appendChild(copyBtn);
}

// ── Variable substitution for macros ─────────────────────────────────────────
function substituteVars(text, booking, details, user) {
  if (!text) return text;
  const b = booking || {};
  const d = details  || {};
  const u = user     || {};
  const lang = countryToLanguage(u.country);
  const map = {
    '{{bookingId}}':         b.internalBookingId,
    '{{supplierBookingId}}': b.supplierId,
    '{{guestName}}':         b.guestName,
    '{{checkIn}}':           b.checkIn,
    '{{checkOut}}':          b.checkOut,
    '{{hotelName}}':         d.hotelName || b.supplierName,
    '{{supplierName}}':      b.supplierName,
    '{{roomType}}':          b.mwrRoomType,
    '{{country}}':           b.destinationCountry,
    '{{city}}':              b.destinationCity,
    '{{productType}}':       b.productType,
    '{{memberName}}':        u.fullName || u.name,
    '{{memberFirstName}}':   (u.fullName || u.name || '').split(' ')[0],
    '{{memberEmail}}':       u.email,
    '{{memberPhone}}':       u.phone,
    '{{memberCountry}}':     u.country,
    '{{memberLanguage}}':    lang,
    '{{memberInstance}}':    u.instance,
  };
  return text.replace(/\{\{[^}]+\}\}/g, token => {
    const val = map[token];
    return (val !== undefined && val !== null && val !== '') ? val : token;
  });
}

function attachMacroTrigger(el, booking, details, user) {
  const isCE = el.isContentEditable;
  let macroQuery = null;
  let dropdown = null;

  const dismissDropdown = () => { dropdown?.remove(); dropdown = null; macroQuery = null; };

  const getTextBeforeCursor = () => {
    if (!isCE) return el.value.slice(0, el.selectionStart);
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return '';
    const range = sel.getRangeAt(0).cloneRange();
    range.selectNodeContents(el);
    range.setEnd(sel.focusNode, sel.focusOffset);
    return range.toString();
  };

  const insertMacro = (substituted) => {
    if (!isCE) {
      const cur = el.value;
      const curPos = el.selectionStart;
      const hashPos = cur.slice(0, curPos).lastIndexOf('#');
      el.value = cur.slice(0, hashPos) + substituted + cur.slice(curPos);
      el.selectionStart = el.selectionEnd = hashPos + substituted.length;
    } else {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const node = range.endContainer;
      const offset = range.endOffset;
      if (node.nodeType === Node.TEXT_NODE) {
        const before = node.textContent.slice(0, offset);
        const hashIdx = before.lastIndexOf('#');
        if (hashIdx !== -1) {
          node.textContent = node.textContent.slice(0, hashIdx) + substituted + node.textContent.slice(offset);
          const nr = document.createRange();
          nr.setStart(node, hashIdx + substituted.length);
          nr.collapse(true);
          sel.removeAllRanges();
          sel.addRange(nr);
        }
      }
    }
    el.focus();
  };

  el.addEventListener('keyup', async (e) => {
    const before = getTextBeforeCursor();
    const match = before.match(/#(\w*)$/);
    if (!match) { dismissDropdown(); return; }
    macroQuery = match[1].toLowerCase();

    const { ok, data } = await api.macros();
    const macros = (ok && Array.isArray(data)) ? data : [];
    const filtered = macros.filter(m => m.name.toLowerCase().includes(macroQuery));

    dismissDropdown();
    if (!filtered.length) return;

    dropdown = document.createElement('div');
    dropdown.style.cssText = 'position:fixed;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:1000001;min-width:240px;max-height:200px;overflow-y:auto;font-family:system-ui,sans-serif;font-size:13px;';
    const rect = el.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';
    dropdown.style.bottom = (window.innerHeight - rect.top + 4) + 'px';

    filtered.forEach(m => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:8px 12px;cursor:pointer;border-bottom:1px solid #f5f5f5;';
      item.innerHTML = '<strong>' + m.name + '</strong><span style="color:#888;font-size:11px;margin-left:8px;">' + m.text.slice(0, 40) + (m.text.length > 40 ? '…' : '') + '</span>';
      item.onmouseover = () => { item.style.background = '#f0eaff'; };
      item.onmouseout  = () => { item.style.background = ''; };
      item.onmousedown = (ev) => {
        ev.preventDefault();
        insertMacro(substituteVars(m.text, booking, details, user));
        dismissDropdown();
      };
      dropdown.appendChild(item);
    });

    document.body.appendChild(dropdown);
  });

  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismissDropdown(); });
  el.addEventListener('blur', () => setTimeout(dismissDropdown, 150));
}

// Injects the in-Freshdesk toolbar — Guided is the primary entry point;
// Bulk + Pendings remain for batch workflows. Other historical entry points
// (Find Booking / Pre-warm / View Booking / View User / AI / Reply) are
// gone — same functionality lives inside the Guided modal now.
function addToolbarButtons() {
  const check = setInterval(() => {
    const container = document.querySelector('.ticket-actions, .page-actions');
    if (!container || document.getElementById('taGuidedBtn')) return;

    const mkBtn = (id, text, color, onClick) => {
      const b = document.createElement('button');
      b.id = id;
      b.textContent = text;
      b.style.cssText = `background:${color};color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);`;
      b.onclick = onClick;
      return b;
    };

    container.appendChild(mkBtn('taGuidedBtn',     '🎯 Guided',    '#6f42c1', () => showGuidedPrewarmModal()));

    const assistedToggle = document.createElement('button');
    assistedToggle.id = 'taAssistedToggle';
    assistedToggle.title = 'Assisted mode — auto-prewarm every ticket on navigation';
    assistedToggle.onclick = () => setAssistedMode(!_assistedMode);
    styleAssistedToggle(assistedToggle);
    container.appendChild(assistedToggle);
    container.appendChild(mkBtn('taGuidedHereBtn', '🎯 Open Here', '#9b59b6', () => {
      const tid = getFreshdeskTicketId();
      if (!tid) { showToast('No ticket detected on this page.', 'warning'); return; }
      showGuidedPrewarmModal(tid);
    }));
    container.appendChild(mkBtn('taBulkBtn',     '🏨 Bulk',     '#795548', () => showBulkConfirmModal()));
    container.appendChild(mkBtn('taPendingsBtn', '📋 Pendings', '#6c757d', () => showCheckPendingsModal()));

    clearInterval(check);
  }, 1000);
}

// ── Date normalization ────────────────────────────────────────────────────────
function parseBookingDate(checkIn, checkOut) {
  if (!checkIn) return null;

  // Text format: "May 2, 2026" or "April 22, 2026" — parse manually to avoid UTC shift
  const textMatch = checkIn.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (textMatch) {
    const months = { january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11 };
    const m = months[textMatch[1].toLowerCase()];
    if (m !== undefined) return new Date(parseInt(textMatch[3]), m, parseInt(textMatch[2]));
  }

  // Numeric format — figure out MM/DD vs DD/MM by comparing with checkout
  const inParts  = checkIn.replace(/[-./]/g, '/').split('/');
  const outParts = checkOut ? checkOut.replace(/[-./]/g, '/').split('/') : null;
  if (inParts.length < 2) return null;

  let month, day, year;
  if (outParts && outParts.length >= 2) {
    if (inParts[0] === outParts[0]) {
      month = parseInt(inParts[0]); day = parseInt(inParts[1]);
    } else if (inParts[1] === outParts[1]) {
      day = parseInt(inParts[0]); month = parseInt(inParts[1]);
    } else {
      month = parseInt(inParts[0]); day = parseInt(inParts[1]);
    }
  } else {
    month = parseInt(inParts[0]); day = parseInt(inParts[1]);
  }
  year = inParts[2] ? parseInt(inParts[2]) : new Date().getFullYear();
  if (year < 100) year += 2000;
  return new Date(year, month - 1, day); // local time, no UTC shift
}

function formatMonthYear(date) {
  if (!date || isNaN(date)) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Auto-tag ticket ───────────────────────────────────────────────────────────
function autoTagTicket(freshdeskTicketId, booking) {
  const date    = parseBookingDate(booking.checkIn, booking.checkOut);
  const monthYr = formatMonthYear(date);
  const country = booking.destinationCountry || booking.locationTo?.split(',').pop()?.trim();
  const tags    = [monthYr, country].filter(Boolean);
  if (!tags.length) return;

  api.tagTicket({ freshdeskTicketId, tags, type: 'Reservations' })
    .then(({ ok }) => { if (ok) { console.log(`🏷️ Tagged ${freshdeskTicketId}:`, tags); refreshFreshdeskTicket(); } })
    .catch(e => console.warn('⚠️ Tag error:', e.message));
}

// ── Duplicate check ───────────────────────────────────────────────────────────
async function checkDuplicates(booking, user, freshdeskTicketId) {
  try {
    const { ok, data } = await api.checkDuplicates({
      vendorConf:  booking.supplierId,
      internalId:  booking.internalBookingId,
      memberEmail: user && user.email ? user.email : null,
      freshdeskTicketId,
    });
    return ok ? (data.duplicates || []) : [];
  } catch (e) { return []; }
}

// ── Ticket list duplicate badges ──────────────────────────────────────────────
const duplicateTicketIds = new Set();

function injectTicketListBadges() {
  document.querySelectorAll('a[href*="/tickets/"]').forEach(link => {
    const match = link.href.match(/\/tickets\/(\d+)/);
    if (!match) return;
    const ticketId = match[1];
    if (!duplicateTicketIds.has(ticketId)) return;
    if (link.querySelector('.ta-dup-badge')) return;
    const badge = document.createElement('span');
    badge.className = 'ta-dup-badge';
    badge.textContent = '⚠️ Duplicate';
    badge.style.cssText = 'background:#dc3545;color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;margin-left:6px;vertical-align:middle;pointer-events:none;';
    link.appendChild(badge);
  });
}

function markDuplicate(ticketId) {
  duplicateTicketIds.add(String(ticketId));
  injectTicketListBadges();
}

// Re-scan duplicate badges on SPA navigation between tickets
let _lastTicketId = getFreshdeskTicketId();

function checkTicketChange() {
  const currentTicketId = getFreshdeskTicketId();
  const ticketChanged = currentTicketId && currentTicketId !== _lastTicketId;
  if (ticketChanged) {
    _lastTicketId = currentTicketId;
  }
  const currentFilterId = getFreshdeskFilterId();
  if (currentFilterId) _lastFilterId = currentFilterId;
  setTimeout(injectTicketListBadges, 1500);
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

function gmPostForm(url, formData) {
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url,
      data: formData,
      // No Content-Type header — GM_xmlhttpRequest sets multipart boundary automatically
      onload: (res) => {
        try {
          const json = JSON.parse(res.responseText);
          resolve({ ok: res.status >= 200 && res.status < 300, data: json });
        } catch (e) {
          resolve({ ok: false, data: { error: 'Invalid JSON response' } });
        }
      },
      onerror: () => resolve({ ok: false, data: { error: 'Could not reach server.' } }),
    });
  });
}

function gmPut(url, data) {
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'PUT',
      url,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(data),
      onload: (res) => {
        try { resolve({ ok: res.status >= 200 && res.status < 300, data: JSON.parse(res.responseText) }); }
        catch (e) { resolve({ ok: false, data: { error: 'Invalid JSON' } }); }
      },
      onerror: () => resolve({ ok: false, data: { error: 'Network error' } }),
    });
  });
}

function gmDelete(url) {
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'DELETE',
      url,
      headers: { 'Content-Type': 'application/json' },
      onload: (res) => resolve({ ok: res.status >= 200 && res.status < 300 }),
      onerror: () => resolve({ ok: false }),
    });
  });
}


async function gmFreshdeskNote(ticketId, noteHtml) {
  // Step 1: get last conversation ID for the last_note_id field
  const lastNoteId = await new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://mwrlife.freshdesk.com/api/_/tickets/${ticketId}/conversations?order_type=desc&per_page=1`,
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
      onload: (res) => {
        try {
          const data = JSON.parse(res.responseText);
          const convs = data.conversations || [];
          resolve(convs.length ? convs[0].id : null);
        } catch (e) { resolve(null); }
      },
      onerror: () => resolve(null),
    });
  });

  // Step 2: POST the note using Freshdesk's internal API
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'POST',
      url: `https://mwrlife.freshdesk.com/api/_/tickets/${ticketId}/notes`,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json',
      },
      data: JSON.stringify({
        body: noteHtml,
        private: true,
        notify_emails: [],
        attachment_ids: [],
        cloud_files: [],
        last_note_id: lastNoteId,
      }),
      onload: (res) => {
        resolve({ ok: res.status >= 200 && res.status < 300, status: res.status });
      },
      onerror: () => resolve({ ok: false, status: 0 }),
    });
  });
}



addToolbarButtons();
mountNativeInjections();
})();