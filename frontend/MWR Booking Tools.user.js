// ==UserScript==
// @name         MWR Booking Tools
// @namespace    https://traveladvantage.com
// @version      4.9
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

  // ===== FRONTEND CACHE =====
  const bookingCache = new Map(); // bookingId → full booking data
  const userCache    = new Map(); // userId → full profile data
  let lastViewedBookingId   = null;
  let lastViewedUserId      = null;
  let lastViewedUserSummary = null;
  let _suppressCacheClear   = false;

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
    dragging = true;
    ox = e.clientX - modal.offsetLeft;
    oy = e.clientY - modal.offsetTop;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    modal.style.left      = (e.clientX - ox) + 'px';
    modal.style.top       = (e.clientY - oy) + 'px';
    modal.style.transform = 'none';
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
function createModal(id, title, opts = {}) {
  document.getElementById(id)?.remove();
  const modal = document.createElement('div');
  modal.id = id;
  modal.style.cssText = 'position:fixed;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:999999;font-family:system-ui,sans-serif;display:flex;flex-direction:column;' + (opts.style || '');

  const header = document.createElement('div');
  header.id = id + 'Handle';
  header.style.cssText = 'padding:12px 16px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;cursor:move;';
  const titleEl = document.createElement('span');
  titleEl.style.cssText = 'font-weight:600;font-size:14px;color:#333;';
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
  makeDraggable(modal, header);
  return { modal, header, body, closeBtn };
}

// ── Confirm modal (replaces confirm()) ────────────────────────────────────────
function showConfirmModal(title, lines, confirmLabel, onConfirm, onCancel, confirmColor = '#6f42c1') {
  document.getElementById('taConfirmModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'taConfirmModal';
  modal.style.cssText = 'position:fixed;top:120px;left:50%;transform:translateX(-50%);width:420px;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:1000001;font-family:system-ui,sans-serif;';
  modal.innerHTML = `
    <div id="taConfirmHandle" style="padding:14px 18px 10px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-weight:600;font-size:14px;color:#333;">${title}</span>
      <button id="taConfirmX" style="background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;">×</button>
    </div>
    <div style="padding:14px 18px;font-size:13px;color:#444;line-height:1.8;">
      ${lines.map(l => `<div>${l}</div>`).join('')}
    </div>
    <div style="padding:0 18px 16px;display:flex;gap:8px;justify-content:flex-end;">
      <button id="taConfirmCancel" style="padding:8px 16px;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#666;">Cancel</button>
      <button id="taConfirmOk" style="padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:${confirmColor};color:#fff;">${confirmLabel}</button>
    </div>`;
  document.body.appendChild(modal);
  makeDraggable(modal, document.getElementById('taConfirmHandle'));
  const close = () => modal.remove();
  document.getElementById('taConfirmX').onclick      = () => { close(); onCancel?.(); };
  document.getElementById('taConfirmCancel').onclick = () => { close(); onCancel?.(); };
  document.getElementById('taConfirmOk').onclick     = () => { close(); onConfirm(); };
}

// ── Refresh Freshdesk ticket timeline without full page reload ────────────────
function refreshFreshdeskTicket() {
  const btn = document.querySelector('[data-test-toggle-activity]');
  if (!btn) { console.warn('⚠️ Activities toggle button not found'); return; }
  const click = () => btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  click();
  setTimeout(click, 350);
}



function showBookingSearchModal() {
  document.getElementById('taSearchModal')?.remove();
  const freshdeskTicketId = getFreshdeskTicketId();
  const modal = document.createElement('div');
  modal.id = 'taSearchModal';
  modal.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);width:380px;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:999998;font-family:system-ui,sans-serif;';
  modal.innerHTML = `
    <div id="taSearchHandle" style="padding:14px 18px 10px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-weight:600;font-size:14px;color:#333;">🔍 Find Booking</span>
      <button id="taSearchClose" style="background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;">×</button>
    </div>
    <div style="padding:16px 18px;">
      ${!freshdeskTicketId ? `<div style="background:#fff3cd;color:#856404;padding:8px 10px;border-radius:6px;font-size:12px;margin-bottom:12px;">⚠️ No ticket detected — note/tag actions unavailable.</div>` : ''}
      <input id="taSearchInput" type="text" placeholder="Booking ID or supplier reference..."
        style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;box-sizing:border-box;margin-bottom:10px;">
      <button id="taSearchBtn" style="width:100%;padding:10px;background:#6f42c1;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">Search →</button>
    </div>`;
  document.body.appendChild(modal);
  makeDraggable(modal, document.getElementById('taSearchHandle'));
  const input = document.getElementById('taSearchInput');
  const close = () => modal.remove();
  document.getElementById('taSearchClose').onclick = close;
  const doSearch = () => {
    const bookingId = input.value.trim();
    if (!bookingId) return;
    if (!freshdeskTicketId) { showToast('No Freshdesk ticket detected.', 'error'); return; }
    close();
    triggerNewBookingFlow(bookingId, freshdeskTicketId);
  };
  document.getElementById('taSearchBtn').onclick = doSearch;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  setTimeout(() => input.focus(), 100);
}

// ── Preview modal — shows booking data then action buttons ────────────────────
function showPreviewModal(bookingId, data, freshdeskTicketId) {
  document.getElementById('taPreviewModal')?.remove();
  const { booking, details, fetchedAt, fromCache, duplicates = [] } = data;

  const field = (label, val) => val && val !== '—'
    ? `<tr><td style="padding:4px 8px;color:#888;font-size:12px;white-space:nowrap;">${label}</td><td style="padding:4px 8px;font-size:13px;font-weight:500;">${val}</td></tr>`
    : '';

  const cacheInfo = fromCache && fetchedAt
    ? `<div style="font-size:11px;color:#888;margin-top:6px;">📦 Cached ${new Date(fetchedAt).toLocaleString()}</div>`
    : `<div style="font-size:11px;color:#28a745;margin-top:6px;">🔄 Freshly fetched</div>`;

  const dupWarning = duplicates.length
    ? `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:12px;color:#856404;">
        ⚠️ <strong>${duplicates.length} duplicate ticket${duplicates.length > 1 ? 's' : ''} found:</strong>
        ${duplicates.map(t => `<div style="margin-top:4px;"><a href="https://mwrlife.freshdesk.com/a/tickets/${t.id}" target="_blank" style="color:#856404;font-weight:600;">#${t.id}</a>${t.subject ? ` <span style="color:#a07010;font-size:11px;">— ${t.subject}</span>` : ''} <span style="color:#b08020;font-size:11px;">(matched by: ${(t.matchedBy||[]).join(', ')})</span></div>`).join('')}
       </div>`
    : '';

  const supplierDisplay = (() => {
    const supplier = data.supplier || null;
    let s = booking.supplierName || '—';
    if (supplier?.email) s += ` <a href="mailto:${supplier.email}" style="color:#007bff;font-size:11px;margin-left:6px;">${supplier.email}</a>`;
    else if (supplier?.contactUrl) s += ` <a href="${supplier.contactUrl}" target="_blank" style="color:#007bff;font-size:11px;margin-left:6px;">Contact</a>`;
    return s;
  })();

  const modal = document.createElement('div');
  modal.id = 'taPreviewModal';
  modal.style.cssText = 'position:fixed;top:80px;right:24px;width:480px;max-height:90vh;display:flex;flex-direction:column;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:999999;font-family:system-ui,sans-serif;';

  modal.innerHTML = `
    <div id="taPreviewHandle" style="padding:14px 18px 10px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-weight:600;font-size:14px;color:#333;">📦 Booking #${bookingId}</span>
      <button id="taPreviewClose" style="background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;">×</button>
    </div>
    <div style="padding:14px 18px;overflow-y:auto;flex:1;">
      ${dupWarning}
      <table style="width:100%;border-collapse:collapse;margin-bottom:6px;">
        ${field('Booking Date',          booking.bookingDate)}
        ${field('Booking ID (TA)',        booking.internalBookingId)}
        ${field('Booking ID (Supplier)', booking.supplierId)}
        <tr><td style="padding:4px 8px;color:#888;font-size:12px;white-space:nowrap;">Supplier</td><td style="padding:4px 8px;font-size:13px;font-weight:500;">${supplierDisplay}</td></tr>
        ${(() => {
          const pt = (booking.productType || '').toLowerCase();
          const d  = data.details || {};
          if (pt.includes('hotel'))
            return field('Hotel', data.hotelName || booking.supplierName);
          if (pt.includes('flight'))
            return field('Airline', d.departAirline || '—') + (d.pnr ? field('PNR', d.pnr) : '');
          if (pt.includes('car'))
            return (d.carVehicle    ? field('Vehicle',  d.carVehicle)    : '') +
                   (d.carFlightInfo ? field('Flight',   d.carFlightInfo) : '') +
                   (d.pickupDetails ? field('Pickup',   d.pickupDetails) : '') +
                   (d.dropoffDetails ? field('Dropoff', d.dropoffDetails) : '');
          if (pt.includes('transfer'))
            return (d.transferFrom  ? field('From',          d.transferFrom)         : '') +
                   (d.transferTo    ? field('To',             d.transferTo)           : '') +
                   (d.transferDate  ? field('Transfer Date',  d.transferDate)         : '') +
                   (d.transferFlightTrain ? field('Flight/Train', d.transferFlightTrain) : '') +
                   (d.transferVehicle    ? field('Vehicle',       d.transferVehicle)     : '') +
                   (d.transferCarrier    ? field('Carrier',       d.transferCarrier)     : '');
          if (pt.includes('ground'))
            return d.departCompany ? field('Company', d.departCompany) : '';
          return '';
        })()}
        ${field('Guest',      booking.guestName || booking.primaryMember)}
        ${field('Room Type',  booking.mwrRoomType)}
        ${field('Check-In',   booking.checkIn)}
        ${field('Check-Out',  booking.checkOut)}
        ${field('Country',    booking.destinationCountry)}
        ${field('City',       booking.destinationCity)}
        ${booking.voucherUrl ? `<tr><td style="padding:4px 8px;color:#888;font-size:12px;white-space:nowrap;">Voucher</td><td style="padding:4px 8px;font-size:13px;font-weight:500;"><a href="${booking.voucherUrl}" target="_blank" style="color:#007bff;">View Voucher ↗</a></td></tr>` : ''}
      </table>

      ${(() => {
        const u = data.user;
        if (!u || !u.fullName) return '';
        const uf = (label, val) => val && val !== '—'
          ? '<tr><td style="padding:3px 8px;color:#888;font-size:11px;white-space:nowrap;">'+label+'</td><td style="padding:3px 8px;font-size:12px;">'+val+'</td></tr>'
          : '';
        return '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #eee;">'
          + '<div style="font-size:11px;font-weight:600;color:#555;margin-bottom:4px;">👤 Member</div>'
          + '<table style="width:100%;border-collapse:collapse;">'
          + uf('Name',        u.fullName)
          + uf('Email',       u.email)
          + uf('Phone',       u.phone)
          + uf('Instance',    u.instance)
          + uf('Status',      u.status)
          + uf('Turbo',       u.turbo)
          + uf('DOB',         u.dob)
          + uf('Country',     u.country)
          + uf('State',       u.state)
          + uf('City',        u.city)
          + uf('Nationality', u.nationality)
          + '</table>'
          + (u.loginLink ? '<a href="'+u.loginLink+'" target="_blank" style="display:inline-block;margin-top:6px;font-size:11px;background:#007bff;color:#fff;padding:2px 8px;border-radius:4px;text-decoration:none;">Login as User</a>' : '')
          + '</div>';
      })()}

      ${cacheInfo}
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:14px;">
        <button id="taActFull"   style="padding:9px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#6f42c1;color:#fff;text-align:left;">📋 + ✉️ &nbsp; Post note &amp; send hotel email</button>
        <button id="taActNote"   style="padding:9px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#007bff;color:#fff;text-align:left;">📋 &nbsp; Post note only</button>
        <button id="taActShortNote" style="padding:9px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#17a2b8;color:#fff;text-align:left;">📌 &nbsp; Post short note</button>
        <button id="taActEmail"  style="padding:9px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#28a745;color:#fff;text-align:left;">✉️ &nbsp; Send hotel email only</button>
        <div style="display:flex;gap:8px;">
          <button id="taActTag"      style="flex:1;padding:7px 14px;border:1px solid #fd7e14;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#fd7e14;font-weight:600;">🏷️ Tag ticket</button>
          <button id="taActViewNote" style="flex:1;padding:7px 14px;border:1px solid #6c757d;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#6c757d;font-weight:600;">👁️ View note</button>
        </div>
        <button id="taActClose" style="padding:7px 14px;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#666;">Close</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  makeDraggable(modal, document.getElementById('taPreviewHandle'));

  const close = () => modal.remove();
  document.getElementById('taPreviewClose').onclick = close;
  document.getElementById('taActClose').onclick     = close;

  document.getElementById('taActFull').onclick  = () => { close(); triggerActions(bookingId, freshdeskTicketId, data, 'full'); };
  document.getElementById('taActNote').onclick  = () => { close(); triggerActions(bookingId, freshdeskTicketId, data, 'note'); };
  document.getElementById('taActShortNote').onclick = () => { close(); triggerActions(bookingId, freshdeskTicketId, data, 'short_note'); };
  document.getElementById('taActEmail').onclick = () => { close(); triggerActions(bookingId, freshdeskTicketId, data, 'email'); };

  document.getElementById('taActTag').onclick = () => {
    autoTagTicket(freshdeskTicketId, booking);
    const btn = document.getElementById('taActTag');
    if (btn) { btn.textContent = '✅ Tagged!'; btn.disabled = true; }
  };

  document.getElementById('taActViewNote').onclick = () => showNoteModal(data.noteHtml);
}

// ── Note preview modal ────────────────────────────────────────────────────────
function showNoteModal(noteHtml) {
  document.getElementById('taNoteModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'taNoteModal';
  modal.style.cssText = 'position:fixed;top:60px;left:24px;width:860px;max-width:95vw;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:1000000;font-family:system-ui,sans-serif;';
  modal.innerHTML = `
    <div id="taNoteHandle" style="padding:14px 18px 10px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-weight:600;font-size:14px;color:#333;">👁️ Note Preview</span>
      <button id="taNoteClose" style="background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;">×</button>
    </div>
    <div style="overflow-y:auto;max-height:80vh;padding:16px 18px;font-size:13px;line-height:1.6;">
      ${noteHtml}
    </div>`;
  document.body.appendChild(modal);
  makeDraggable(modal, document.getElementById('taNoteHandle'));
  document.getElementById('taNoteClose').onclick = () => modal.remove();
}


// ── Chat modal ────────────────────────────────────────────────────────────────
async function showChatModal(ticketId) {
  const freshdeskTicketId = ticketId || getFreshdeskTicketId();
  if (!freshdeskTicketId) { showToast('No ticket detected.', 'error'); return; }

  document.getElementById('taChatModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'taChatModal';
  modal.style.cssText = 'position:fixed;top:60px;right:24px;width:700px;max-width:calc(100vw - 48px);max-height:92vh;display:flex;flex-direction:column;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.3);z-index:999999;font-family:system-ui,sans-serif;resize:both;overflow:auto;min-width:400px;';

  const header = document.createElement('div');
  header.id = 'taChatHandle';
  header.style.cssText = 'padding:12px 16px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;cursor:move;';
  header.innerHTML = `<span style="font-weight:600;font-size:14px;color:#333;">💬 Chat — #${freshdeskTicketId}</span>`;
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;';
  closeBtn.onclick = () => modal.remove();
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px;';

  // Member section
  const memberSection = document.createElement('div');
  memberSection.style.cssText = 'border:1px solid #eee;border-radius:8px;padding:12px 14px;';
  memberSection.innerHTML = '<div style="color:#999;font-size:12px;">👤 Looking up member...</div>';
  body.appendChild(memberSection);

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
    const { ok } = await gmPost(`${BACKEND_URL}/post-note`, { freshdeskTicketId, noteHtml });
    postChatNoteBtn.disabled = false; postChatNoteBtn.textContent = '📋 Post as Note';
    if (ok) { showToast('✅ Note posted!', 'success'); refreshFreshdeskTicket(); }
    else showToast('❌ Failed to post note.', 'error');
  };
  chatBtnRow.appendChild(postChatNoteBtn);
  chatSection.appendChild(chatTitle);
  chatSection.appendChild(chatTextarea);
  chatSection.appendChild(chatBtnRow);
  body.appendChild(chatSection);

  modal.appendChild(header);
  modal.appendChild(body);
  document.body.appendChild(modal);
  makeDraggable(modal, header);

  // 1. Get requester email from ticket
  const { ok: prepOk, data: prepData } = await gmGet(`${BACKEND_URL}/chat-prep/${freshdeskTicketId}`);
  if (!prepOk || !prepData.email) {
    memberSection.innerHTML = '<div style="color:#dc3545;font-size:12px;">❌ Could not resolve requester email.</div>';
  } else {
    const email = prepData.email;

    // 2a. Find User — async
    gmPost(`${BACKEND_URL}/find-user`, { query: email }).then(async ({ ok: uok, data: udata }) => {
      memberSection.innerHTML = '';
      const results = uok && udata.results ? udata.results : [];
      // Take first result whose email matches
      const match = results.find(r => r.email && r.email.toLowerCase() === email.toLowerCase()) || results[0];
      if (!match) {
        memberSection.innerHTML = `<div style="color:#999;font-size:12px;">No member found for ${email}</div>`;
        return;
      }
      // Fetch full profile
      const { ok: profOk, data: profData } = await gmGet(`${BACKEND_URL}/user/${match.id}`);
      const u = profOk && profData.user ? profData.user : match;
      const titleEl = document.createElement('div');
      titleEl.style.cssText = 'font-weight:600;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px;';
      titleEl.textContent = '👤 Member';
      memberSection.appendChild(titleEl);

      const rows = [['Name', u.fullName||u.name], ['Email', u.email], ['Phone', u.phone], ['Country', u.country], ['Status', u.status], ['Instance', u.instance]].filter(([,v]) => v);
      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;margin-bottom:10px;';
      rows.forEach(([label, val]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<th style="padding:3px 8px;text-align:left;color:#888;font-weight:500;width:35%;white-space:nowrap;">${label}</th><td style="padding:3px 8px;color:#333;">${val}</td>`;
        table.appendChild(tr);
      });
      memberSection.appendChild(table);

      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
      if (u.loginLink) {
        const lb = document.createElement('a');
        lb.href = u.loginLink; lb.target = '_blank';
        lb.style.cssText = 'padding:4px 10px;border-radius:4px;background:#007bff;color:#fff;font-size:11px;text-decoration:none;';
        lb.textContent = 'Login as User';
        btnRow.appendChild(lb);
      }
      if (u.profileLink) {
        const pb = document.createElement('a');
        pb.href = u.profileLink; pb.target = '_blank';
        pb.style.cssText = 'padding:4px 10px;border-radius:4px;background:#0056d2;color:#fff;font-size:11px;text-decoration:none;';
        pb.textContent = 'Open Profile';
        btnRow.appendChild(pb);
      }
      const noteBtn = document.createElement('button');
      noteBtn.textContent = '📋 Post Member Note';
      noteBtn.style.cssText = 'padding:4px 10px;border:none;border-radius:4px;background:#28a745;color:#fff;font-size:11px;cursor:pointer;';
      noteBtn.onclick = async () => {
        noteBtn.disabled = true; noteBtn.textContent = '⏳';
        const { buildUserNoteHtml } = await (async () => {
          // Build simple member note HTML inline
          const v = val => val || '—';
          const th = 'padding:5px 8px;background:#f5f5f5;border:1px solid #ddd;text-align:left;font-weight:600;font-size:12px;color:#444;';
          const td = 'padding:5px 8px;border:1px solid #ddd;color:#222;font-size:12px;';
          const rowsHtml = rows.map(([l,val]) => `<tr><th style="${th}">${l}</th><td style="${td}">${val}</td></tr>`).join('');
          const noteHtml = `<div style="font-family:system-ui,sans-serif;"><h4 style="margin:0 0 8px;font-size:14px;">👤 Member — ${v(u.fullName||u.name)}</h4><table style="width:100%;border-collapse:collapse;">${rowsHtml}</table></div>`;
          return { buildUserNoteHtml: () => noteHtml };
        })();
        const noteHtml = buildUserNoteHtml();
        const { ok } = await gmPost(`${BACKEND_URL}/post-note`, { freshdeskTicketId, noteHtml });
        noteBtn.disabled = false; noteBtn.textContent = '📋 Post Member Note';
        if (ok) { showToast('✅ Member note posted!', 'success'); refreshFreshdeskTicket(); }
        else showToast('❌ Failed.', 'error');
      };
      btnRow.appendChild(noteBtn);
      memberSection.appendChild(btnRow);
    });

    // 2b. Translate Chat — fetch prompt from DB then send with ticket context
    gmGet(`${BACKEND_URL}/settings/prompts`).then(async ({ ok: pok, data: pdata }) => {
      const translatePrompt = (pok && Array.isArray(pdata))
        ? pdata.find(p => p.label && p.label.toLowerCase().includes('translate chat'))
        : null;
      const promptText = translatePrompt ? translatePrompt.text : 'Clean and translate this chat transcript to English. Format as BOT/CUSTOMER/AGENT. Add a 2-sentence summary at the end.';

      const { ok: aiOk, data: aiData } = await gmPost(`${BACKEND_URL}/ai-assist`, {
        booking: {}, details: {}, user: null, supplier: null,
        freshdeskTicketId, prompt: promptText,
      });
      if (aiOk && aiData.text) {
        chatTextarea.value = aiData.text;
        chatTextarea.readOnly = false;
        postChatNoteBtn.disabled = false; postChatNoteBtn.style.opacity = '1';
      } else {
        chatTextarea.value = '❌ Translation failed.';
      }
    });
  }
}

// ── Guided Prewarm ────────────────────────────────────────────────────────────
async function showGuidedPrewarmModal(singleTicketId = null) {
  const { modal, body } = createModal('taGuidedModal', '🎯 Guided Prewarm', {
    style: 'top:40px;left:50%;transform:translateX(-50%);width:1600px;max-width:calc(100vw - 24px);max-height:96vh;',
    bodyStyle: 'display:flex;flex-direction:column;gap:12px;',
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

    const { ok, data } = await gmGet(`${BACKEND_URL}/guided-prewarm/tickets?filter=${filterKey}`);
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
      ticketPromise:  gmGet(`${BACKEND_URL}/guided-prewarm/ticket/${tid}`),
      analysePromise: gmGet(`${BACKEND_URL}/guided-prewarm/analyse/${tid}`),
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

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-shrink:0;';
    const confirmBtn = document.createElement('button');
    confirmBtn.style.cssText = 'flex:1;padding:10px;border:none;border-radius:6px;background:#28a745;color:#fff;font-size:12px;font-weight:600;cursor:pointer;opacity:0.4;';
    confirmBtn.textContent = '✅ Confirm';
    confirmBtn.disabled = true;
    const skipBtn = document.createElement('button');
    skipBtn.style.cssText = 'padding:10px 18px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#666;font-size:13px;cursor:pointer;';
    skipBtn.textContent = '⏭ Skip';
    skipBtn.onclick = () => { idx++; renderTicket(); };
    const stopBtn = document.createElement('button');
    stopBtn.style.cssText = 'padding:10px 18px;border:1px solid #dc3545;border-radius:6px;background:#fff;color:#dc3545;font-size:13px;cursor:pointer;';
    stopBtn.textContent = '🛑 Stop';
    stopBtn.onclick = () => { stopped = true; renderTicket(); };
    const closeTicketBtn = document.createElement('button');
    closeTicketBtn.style.cssText = 'padding:10px 14px;border:1px solid #6c757d;border-radius:6px;background:#fff;color:#6c757d;font-size:13px;cursor:pointer;';
    closeTicketBtn.textContent = '✖ Close Ticket';
    closeTicketBtn.onclick = async () => {
      closeTicketBtn.disabled = true; closeTicketBtn.textContent = '⏳ Closing...';
      const { ok } = await gmPost(`${BACKEND_URL}/close-ticket`, { ticketId: String(t.id) });
      if (ok) { showToast('✅ Ticket closed.', 'success', 2000); idx++; setTimeout(() => renderTicket(), 1000); }
      else { showToast('❌ Could not close ticket.', 'error'); closeTicketBtn.disabled = false; closeTicketBtn.textContent = '✖ Close Ticket'; }
    };
    const chatBtnEl = document.createElement('button');
    chatBtnEl.textContent = '💬 Chat';
    chatBtnEl.style.cssText = 'padding:10px 14px;border:1px solid #e83e8c;border-radius:6px;background:#fff;color:#e83e8c;font-size:13px;font-weight:600;cursor:pointer;';
    chatBtnEl.onclick = () => showChatModal(String(t.id));
    const addNoteBtn = document.createElement('button');
    addNoteBtn.textContent = '📝 Add Note';
    addNoteBtn.style.cssText = 'padding:10px 14px;border:1px solid #6f42c1;border-radius:6px;background:#fff;color:#6f42c1;font-size:13px;font-weight:600;cursor:pointer;';
    btnRow.appendChild(confirmBtn);
    btnRow.appendChild(addNoteBtn);
    btnRow.appendChild(skipBtn);
    btnRow.appendChild(closeTicketBtn);
    btnRow.appendChild(chatBtnEl);
    btnRow.appendChild(stopBtn);

    // Two-column layout built immediately
    const columns = document.createElement('div');
    columns.style.cssText = 'display:flex;gap:12px;flex:1;min-height:0;';
    const leftCol = document.createElement('div');
    leftCol.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:8px;min-width:0;';
    const rightCol = document.createElement('div');
    rightCol.style.cssText = 'width:520px;flex-shrink:0;display:flex;gap:8px;';
    const bookingSection = document.createElement('div');
    bookingSection.style.cssText = 'flex:1;border:1px solid #eee;border-radius:8px;padding:12px 14px;font-size:12px;overflow-y:auto;max-height:360px;';
    bookingSection.innerHTML = '<div style="color:#999;font-size:11px;">⏳ Loading booking...</div>';
    const customerSection = document.createElement('div');
    customerSection.style.cssText = 'width:180px;flex-shrink:0;border:1px solid #eee;border-radius:8px;padding:12px 14px;font-size:12px;overflow-y:auto;max-height:360px;';
    customerSection.innerHTML = '<div style="color:#999;font-size:11px;">No member data</div>';
    rightCol.appendChild(bookingSection);
    rightCol.appendChild(customerSection);
    columns.appendChild(leftCol);
    columns.appendChild(rightCol);
    body.appendChild(columns);

    // Reply panel placeholder — populated when booking loads, collapsed by default
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
    body.appendChild(replyPanelWrapper);

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
    const openLink = document.createElement('a');
    openLink.href = `https://mwrlife.freshdesk.com/a/tickets/${t.id}`;
    openLink.target = '_blank';
    openLink.style.cssText = 'font-size:11px;color:#007bff;';
    openLink.textContent = 'Open ↗';
    cardActions.appendChild(summarizeBtn);
    cardActions.appendChild(openLink);
    cardHeader.appendChild(cardTitleSpan);
    cardHeader.appendChild(cardActions);
    const descEl = document.createElement('div');
    descEl.style.cssText = 'padding:12px 14px;font-size:12px;color:#555;line-height:1.6;overflow-y:auto;flex:1;max-height:320px;';
    descEl.innerHTML = '<div style="color:#999;">⏳ Loading...</div>';
    // Status + tags bar — populated by refreshThread after full ticket loads
    const statusTagBar = document.createElement('div');
    statusTagBar.style.cssText = 'display:flex;align-items:center;gap:16px;padding:6px 14px;border-bottom:1px solid #eee;background:#fafafa;font-size:12px;flex-shrink:0;flex-wrap:wrap;';
    statusTagBar.innerHTML = '<span style="color:#ccc;font-size:11px;">⏳</span>';

    card.appendChild(cardHeader);
    card.appendChild(statusTagBar);
    card.appendChild(descEl);
    leftCol.appendChild(card);

    // Fetch / refresh ticket thread
    let _threadCacheUsed = false;
    const refreshThread = () => {
      descEl.innerHTML = '<div style="color:#999;font-size:11px;">⏳ Loading thread...</div>';
      const _pc = !_threadCacheUsed && prefetchCache.get(String(t.id));
      _threadCacheUsed = true;
      const _ticketReq = _pc ? _pc.ticketPromise : gmGet(`${BACKEND_URL}/guided-prewarm/ticket/${t.id}`);
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
            const prompt = 'Translate the following to English. Return only the translated text — no explanation.\n\n' + text;
            const { ok: aok, data: aiData } = await gmPost(BACKEND_URL + '/ai-assist', {
              booking: {}, details: {}, user: null, supplier: null,
              freshdeskTicketId: String(t.id), prompt,
            });
            const parent = btn.parentElement;
            btn.remove();
            const resultEl = document.createElement('div');
            resultEl.style.cssText = 'margin-top:6px;padding:6px 8px;background:#f0fffe;border:1px solid #17a2b8;border-radius:4px;font-size:12px;color:#333;white-space:pre-wrap;';
            resultEl.textContent = (aok && aiData.text) ? aiData.text.trim() : '❌ Translation failed.';
            parent && parent.appendChild(resultEl);
          };
          return btn;
        };

        const agents = td.agents || {};
        const fmtDate = (iso) => {
          if (!iso) return '';
          const d = new Date(iso);
          return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
            + ' ' + d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
        };

        const addMsg = (label, bg, border, bodyHtml, rawText, meta) => {
          const wrap = document.createElement('div');
          wrap.style.cssText = `margin-bottom:10px;padding:8px 10px;background:${bg};border-left:3px solid ${border};border-radius:3px;font-size:12px;line-height:1.5;`;

          // Header row: type label + metadata
          const hdr = document.createElement('div');
          hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;flex-wrap:wrap;gap:4px;';

          const typeSpan = document.createElement('span');
          typeSpan.style.cssText = 'font-size:10px;color:#999;font-weight:600;';
          typeSpan.textContent = label;

          const metaSpan = document.createElement('span');
          metaSpan.style.cssText = 'font-size:10px;color:#aaa;text-align:right;';
          if (meta) {
            const parts = [];
            if (meta.author) parts.push(meta.author);
            if (meta.date)   parts.push(meta.date);
            metaSpan.textContent = parts.join(' · ');
            if (meta.notified && meta.notified.length) {
              const notifEl = document.createElement('div');
              notifEl.style.cssText = 'font-size:10px;color:#aaa;margin-top:1px;';
              notifEl.textContent = '→ ' + meta.notified.join(', ');
              metaSpan.appendChild(notifEl);
            }
          }

          hdr.appendChild(typeSpan);
          hdr.appendChild(metaSpan);

          const content = document.createElement('div');
          content.innerHTML = bodyHtml;
          wrap.appendChild(hdr);
          wrap.appendChild(content);
          wrap.appendChild(makeTranslateBtn(() => rawText || strip(bodyHtml)));
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
          };
          addMsg('📩 Customer (opening)', '#f8f9fa', '#6c757d', bodyHtml, strip(desc), meta);
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
            : (agents[c.user_id] || c.from_email || null);
          const notified = isNote
            ? (c.to_emails || [])
            : (c.to_emails || []);
          addMsg(label, bg, border, bodyHtml, strip(c.body_text || c.body || ''), {
            author,
            date: fmtDate(c.created_at),
            notified,
          });
        });

        if (!descEl.children.length) descEl.innerHTML = '<span style="color:#999;">(no content)</span>';
        renderStatusTagBar(td.ticket);

        // Wire Summarize button once thread is loaded
        summarizeBtn.onclick = async () => {
          const allText = [...descEl.querySelectorAll('div > div:last-of-type')].map(el => el.innerText || el.textContent).join('\n\n').trim()
            || strip(descEl.innerHTML);
          summarizeBtn.disabled = true; summarizeBtn.textContent = '⏳ Summarising...';
          const { ok: aok, data: aiData } = await gmPost(BACKEND_URL + '/ai-assist', {
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

      const updateStatusBtn = document.createElement('button');
      updateStatusBtn.textContent = 'Update';
      updateStatusBtn.style.cssText = 'padding:2px 8px;border:none;border-radius:4px;background:#007bff;color:#fff;font-size:11px;cursor:pointer;font-weight:500;';
      updateStatusBtn.onclick = () => withButtonLoading(updateStatusBtn, '⏳', async () => {
        const { ok } = await gmPost(`${BACKEND_URL}/update-ticket`, { ticketId: String(t.id), fields: { status: Number(sel.value) } });
        if (ok) { showToast('✅ Status updated', 'success', 2000); refreshThread(); }
        else showToast('❌ Failed to update status', 'error');
      });
      statusTagBar.appendChild(updateStatusBtn);

      // ── Divider ────────────────────────────────────────────────────────────
      const divider = document.createElement('span');
      divider.style.cssText = 'color:#ddd;font-size:14px;';
      divider.textContent = '|';
      statusTagBar.appendChild(divider);

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
        const { ok } = await gmPost(`${BACKEND_URL}/update-ticket`, { ticketId: String(t.id), fields: { tags: currentTags } });
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

    let currentBookingId = null;
    let currentAction = null;

    const renderCustomerSection = (user) => {
      customerSection.innerHTML = '';
      const ct = document.createElement('div');
      ct.style.cssText = 'font-weight:600;font-size:11px;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;';
      ct.textContent = 'Member';
      customerSection.appendChild(ct);

      // Action buttons — Login as User, Open Full Profile, Post Member Note
      const hasLinks = user.loginLink || user.profileLink;
      if (hasLinks) {
        const actionRow = document.createElement('div');
        actionRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-bottom:8px;';
        if (user.loginLink) {
          const a = document.createElement('a');
          a.href = user.loginLink; a.target = '_blank';
          a.textContent = '🔑 Login as User';
          a.style.cssText = 'display:block;background:#007bff;color:#fff;padding:4px 8px;border-radius:4px;text-decoration:none;font-size:11px;text-align:center;';
          actionRow.appendChild(a);
        }
        if (user.profileLink) {
          const a = document.createElement('a');
          a.href = user.profileLink; a.target = '_blank';
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
          const fields = [
            ['Name',     user.fullName || user.name],
            ['Email',    user.email],
            ['Phone',    user.phone],
            ['Instance', user.instance],
            ['Status',   user.status],
            ['Country',  user.country],
          ].filter(([,val]) => val);
          const lines = fields.map(([l, val]) => `<div><strong>${l}:</strong> ${v(val)}</div>`).join('');
          const loginLine  = user.loginLink   ? `<div><strong>Login:</strong> <a href="${user.loginLink}" target="_blank">Login as User</a></div>`     : '';
          const profileLine = user.profileLink ? `<div><strong>Profile:</strong> <a href="${user.profileLink}" target="_blank">Open Full Profile</a></div>` : '';
          const noteHtml = `<div style="font-family:system-ui,sans-serif;font-size:13px;line-height:1.8;"><h4 style="margin:0 0 8px;font-size:14px;">👤 Member Details</h4>${lines}${loginLine}${profileLine}</div>`;
          const { ok } = await gmPost(`${BACKEND_URL}/post-note`, { freshdeskTicketId: String(t.id), noteHtml });
          postNoteBtn2.disabled = false; postNoteBtn2.textContent = '📋 Post Member Note';
          if (ok) { showToast('✅ Member note posted!', 'success'); refreshThread(); }
          else showToast('❌ Failed to post note.', 'error');
        };
        actionRow.appendChild(postNoteBtn2);
        customerSection.appendChild(actionRow);
      }

      const uRows = [['Name',user.fullName||user.name],['Email',user.email],['Phone',user.phone],['Country',user.country],['Status',user.status]].filter(([,v])=>v);
      const uTable = document.createElement('table'); uTable.style.cssText = 'width:100%;border-collapse:collapse;';
      uRows.forEach(([label,val]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<th style="padding:3px 4px;text-align:left;color:#aaa;font-weight:500;font-size:11px;white-space:nowrap;">${label}</th><td style="padding:3px 4px;color:#333;font-size:11px;word-break:break-all;">${val}</td>`;
        uTable.appendChild(tr);
      });
      customerSection.appendChild(uTable);

      // ── Find different member inline row ───────────────────────────────────
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
        const { ok: uok, data: udata } = await gmPost(`${BACKEND_URL}/find-user`, { query: q });
        findMemberBtn.disabled = false; findMemberBtn.textContent = '🔍 Search';
        findMemberResults.innerHTML = '';
        const results = (uok && udata.results) ? udata.results : [];
        if (!results.length) { findMemberResults.textContent = 'No results.'; return; }
        const TA_BASE = 'https://traveladvantage.com';
        results.slice(0, 5).forEach(u => {
          const item = document.createElement('div');
          item.style.cssText = 'padding:3px 0;border-bottom:1px solid #f0f0f0;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;';
          const label = document.createElement('span');
          label.style.cssText = 'color:#333;font-size:11px;';
          label.textContent = `${u.name || ''}${u.email ? ' — ' + u.email : ''}`;
          const pickBtn = document.createElement('button');
          pickBtn.textContent = 'Select';
          pickBtn.style.cssText = 'padding:2px 7px;border:1px solid #6f42c1;border-radius:3px;background:#fff;color:#6f42c1;font-size:10px;cursor:pointer;flex-shrink:0;';
          pickBtn.onclick = () => {
            const userData = {
              ...u,
              loginLink:   `${TA_BASE}/admin/account/webadminCustomerLogin/${u.id}`,
              profileLink: `${TA_BASE}/admin/account/viewCustomer/${u.id}`,
            };
            renderCustomerSection(userData);
          };
          item.appendChild(label); item.appendChild(pickBtn);
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
        msg.textContent = currentBookingId ? `⚠️ Could not fetch booking for "${currentBookingId}".` : '⚠️ No booking ID found in this ticket.';
        bookingSection.appendChild(msg);
        const manualRow = document.createElement('div');
        manualRow.style.cssText = 'display:flex;gap:6px;';
        const manualInput = document.createElement('input');
        manualInput.type = 'text'; manualInput.placeholder = 'Enter booking ID manually...';
        manualInput.value = currentBookingId || '';
        manualInput.style.cssText = 'flex:1;padding:6px 10px;border:1px solid #ddd;border-radius:5px;font-size:12px;';
        const fetchManualBtn = document.createElement('button');
        fetchManualBtn.textContent = '🔍 Fetch';
        fetchManualBtn.style.cssText = 'padding:6px 12px;border:none;border-radius:5px;background:#6f42c1;color:#fff;font-size:12px;cursor:pointer;';
        fetchManualBtn.onclick = async () => {
          const id = manualInput.value.trim(); if (!id) return;
          fetchManualBtn.disabled = true; fetchManualBtn.textContent = '⏳';
          const { ok: fok, data: fd } = await gmGet(`${BACKEND_URL}/guided-prewarm/booking/${encodeURIComponent(id)}`);
          fetchManualBtn.disabled = false; fetchManualBtn.textContent = '🔍 Fetch';
          if (fok && fd.bookingData) { currentBookingId = id; renderBookingSection(fd.bookingData); }
          else showToast('Booking not found in TA.', 'error');
        };
        manualInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchManualBtn.click(); });
        manualRow.appendChild(manualInput); manualRow.appendChild(fetchManualBtn);
        bookingSection.appendChild(manualRow);
        confirmBtn.disabled = true; confirmBtn.style.opacity = '0.4';
        // Populate customer section from userData fallback (no booking found)
        if (userData) {
          renderCustomerSection(userData);
          // Enable reply panel if we have a customer email
          if (userData.email) {
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
            custTabBtn.onclick = () => {
              custTabBtn.style.cssText = rTabStyle('#0056d2', true);
              showReplyComposer('customer', userData.email, {}, {}, userData, null, replyBody, refreshThread, String(t.id));
            };
            replyTabBar.appendChild(custTabBtn);
            replyPanelContent.appendChild(replyTabBar);
            replyPanelContent.appendChild(replyBody);
            showReplyComposer('customer', userData.email, {}, {}, userData, null, replyBody, refreshThread, String(t.id));
          }
        }
        return;
      }

      const { booking, details, user } = bd;
      const cleanSupplierName = (name) => (name || '').replace(/\s*\(\d+\)\s*$/g, '').replace(/\bV\d+\b/gi, '').replace(/\bpackage\b/gi, '').trim();
      const productType = (booking.productType || '').toLowerCase();
      const isHotel    = productType.includes('hotel');
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
        if (daysUntil !== null && daysUntil < 3) { currentAction = 'call_hotel'; actionLabel = '📞 Tag Call Hotel + High Priority'; actionColor = '#dc3545'; }
        else { currentAction = 'note_only'; }
      } else if (isTransfer) { currentAction = 'voucher'; actionLabel = '🏷️ Tag Voucher & Move On'; actionColor = '#6c757d'; }
      else { currentAction = 'note_only'; }

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
      changeBookingInput.value = currentBookingId || '';
      changeBookingInput.style.cssText = 'flex:1;padding:4px 8px;border:1px solid #ddd;border-radius:4px;font-size:11px;';
      const changeBookingBtn = document.createElement('button');
      changeBookingBtn.textContent = '🔍 Fetch';
      changeBookingBtn.style.cssText = 'padding:4px 10px;border:none;border-radius:4px;background:#6f42c1;color:#fff;font-size:11px;cursor:pointer;';
      changeBookingBtn.onclick = async () => {
        const id = changeBookingInput.value.trim(); if (!id) return;
        changeBookingBtn.disabled = true; changeBookingBtn.textContent = '⏳';
        const { ok: fok, data: fd } = await gmGet(`${BACKEND_URL}/guided-prewarm/booking/${encodeURIComponent(id)}`);
        changeBookingBtn.disabled = false; changeBookingBtn.textContent = '🔍 Fetch';
        if (fok && fd.bookingData) { currentBookingId = id; renderBookingSection(fd.bookingData); }
        else showToast('Booking not found.', 'error');
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

      if (user) renderCustomerSection(user);

      const replyRowEl = document.createElement('div'); replyRowEl.style.cssText = 'margin-top:10px;display:flex;gap:6px;';
      const postNoteBtn = document.createElement('button');
      postNoteBtn.textContent = '📋 Post Note';
      postNoteBtn.style.cssText = 'padding:7px 10px;border:1px solid #6f42c1;border-radius:5px;background:#fff;color:#6f42c1;font-size:12px;font-weight:600;cursor:pointer;';
      postNoteBtn.onclick = () => withButtonLoading(postNoteBtn, '⏳ Posting...', async () => {
        const { ok, data: cr } = await gmPost(`${BACKEND_URL}/guided-prewarm/confirm`, { ticketId: String(t.id), bookingId: currentBookingId, action: 'note_only' });
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
      if (isHotel && !(daysUntil !== null && daysUntil < 3)) {
        const hotelEmailBtn = document.createElement('button');
        hotelEmailBtn.textContent = '📧 Hotel confirmation email';
        hotelEmailBtn.style.cssText = 'flex:1;padding:10px;border:none;border-radius:6px;background:#28a745;color:#fff;font-size:12px;font-weight:600;cursor:pointer;';
        hotelEmailBtn.onclick = () => withButtonLoading(hotelEmailBtn, '⏳ Sending...', async () => {
          const { ok: cok, data: cr } = await gmPost(`${BACKEND_URL}/guided-prewarm/confirm`, { ticketId: String(t.id), bookingId: currentBookingId, action: 'hotel_email' });
          if (!cok) { showToast('❌ Error: ' + (cr?.error || 'Server error'), 'error'); return; }
          const r = cr.results; const msgs = [];
          if (r.emailSent) msgs.push(`email → ${r.hotelEmail}`);
          if (r.fallback) msgs.push('no email found — tagged call_hotel');
          if (r.tagged?.length) msgs.push('tagged: ' + r.tagged.join(', '));
          showToast('✅ ' + (msgs.join(' · ') || 'Done'), 'success', 3000);
          refreshFreshdeskTicket(); refreshThread();
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
          showReplyComposer('customer', customerEmail, booking, details, user, supplierObj, replyBody, refreshThread, String(t.id));
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

          const suppTA = document.createElement('div');
          suppTA.contentEditable = 'true';
          suppTA.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;font-family:system-ui,sans-serif;min-height:200px;line-height:1.5;outline:none;margin-bottom:8px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;';
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
          suppTA.addEventListener('paste', (e) => {
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (const item of items) {
              if (item.type.startsWith('image/')) {
                e.preventDefault();
                const reader = new FileReader();
                reader.onload = (ev) => {
                  const img = document.createElement('img');
                  img.src = ev.target.result;
                  img.style.cssText = 'max-width:100%;height:auto;display:block;margin:4px 0;border-radius:3px;';
                  const sel = window.getSelection();
                  if (sel && sel.rangeCount) {
                    const range = sel.getRangeAt(0); range.deleteContents(); range.insertNode(img);
                    range.setStartAfter(img); range.collapse(true); sel.removeAllRanges(); sel.addRange(range);
                  } else { suppTA.appendChild(img); }
                };
                reader.readAsDataURL(item.getAsFile()); return;
              }
            }
          });
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
              ok = (await gmPostForm(BACKEND_URL + '/send-reply', fd)).ok;
            } else {
              ok = (await gmPost(BACKEND_URL + '/send-reply', { freshdeskTicketId: String(t.id), toEmail, bodyHtml: noteHtml })).ok;
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
        const { ok: cok, data: cr } = await gmPost(`${BACKEND_URL}/guided-prewarm/confirm`, { ticketId: String(t.id), bookingId: currentBookingId, action: currentAction });
        if (!cok) { showToast('❌ Error: ' + (cr?.error || 'Server error'), 'error'); confirmBtn.disabled = false; confirmBtn.textContent = actionLabel; return; }
        const r = cr.results; const msgs = [];
        if (r.notePosted) msgs.push('note posted');
        if (r.emailSent) msgs.push(`email → ${r.hotelEmail}`);
        if (r.fallback) msgs.push('no email → tagged call_hotel');
        if (r.tagged?.length) msgs.push('tagged: ' + r.tagged.join(', '));
        if (r.prioritySet) msgs.push('priority: ' + r.prioritySet);
        showToast('✅ ' + (msgs.join(' · ') || 'Done'), 'success', 3000);
        refreshFreshdeskTicket(); idx++; setTimeout(() => renderTicket(), 1200);
      };
    };

    // Analyse async — Groq + booking (use prefetch cache if available)
    const _pcA = prefetchCache.get(String(t.id));
    const _analyseReq = _pcA ? _pcA.analysePromise : gmGet(`${BACKEND_URL}/guided-prewarm/analyse/${t.id}`);
    _analyseReq.then(({ ok: aok, data: analysis }) => {
      if (!aok) { bookingSection.innerHTML = '<div style="color:red;font-size:12px;">❌ Analysis failed.</div>'; return; }
      if (analysis.skip) { prog.textContent += ` — skipped (${analysis.reason})`; idx++; renderTicket(); return; }

      currentBookingId = analysis.bookingId;
      renderBookingSection(analysis.bookingData, analysis.userData);

      // ── Open threads / duplicates — always shown ───────────────────────────
      const dupSection = document.createElement('div');
      dupSection.style.cssText = 'border:1px solid #eee;border-radius:8px;padding:10px 14px;font-size:12px;';
      body.appendChild(dupSection);

      // Helper: build a dup row with Preview/Merge and Merge out buttons
      const buildDupRow = (dup) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #f5f5f5;';
          row.innerHTML = `<a href="https://mwrlife.freshdesk.com/a/tickets/${dup.id}" target="_blank" style="color:#007bff;font-weight:600;font-size:12px;white-space:nowrap;">#${dup.id}</a><span style="flex:1;color:#555;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${dup.subject||'—'}</span><span style="color:#aaa;font-size:10px;white-space:nowrap;">${(dup.matchedBy||[]).join(', ')}</span>`;
            const previewBtn = document.createElement('button');
            previewBtn.textContent = 'Preview / Merge';
            previewBtn.style.cssText = 'padding:2px 8px;border:1px solid #fd7e14;border-radius:4px;background:#fff;color:#fd7e14;font-size:11px;cursor:pointer;flex-shrink:0;font-weight:500;';
            previewBtn.onclick = async () => {
              previewBtn.disabled = true; previewBtn.textContent = '⏳';
              const { ok: tok, data: td } = await gmGet(`${BACKEND_URL}/guided-prewarm/ticket/${dup.id}`);
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
                  const { ok: mok, data: mr } = await gmPost(`${BACKEND_URL}/merge-ticket`, {
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
            mergeOutBtn.style.cssText = 'padding:2px 8px;border:1px solid #6c757d;border-radius:4px;background:#fff;color:#6c757d;font-size:11px;cursor:pointer;flex-shrink:0;font-weight:500;';
            mergeOutBtn.onclick = async () => {
              if (!confirm(`Merge #${t.id} into #${dup.id}? This will post a note on #${dup.id} and close #${t.id}.`)) return;
              mergeOutBtn.disabled = true; mergeOutBtn.textContent = '⏳';
              const { ok: ftok, data: ftd } = await gmGet(`${BACKEND_URL}/guided-prewarm/ticket/${t.id}`);
              const desc = (ftok && ftd.ticket) ? (ftd.ticket.description || ftd.ticket.description_text || '') : '';
              const { ok: mok, data: mr } = await gmPost(`${BACKEND_URL}/merge-ticket`, { sourceTicketId: String(t.id), targetTicketId: String(dup.id), description: desc });
              if (mok) { showToast(`✅ Merged #${t.id} into #${dup.id} — ticket closed.`, 'success', 3000); idx++; setTimeout(() => renderTicket(), 1200); }
              else { showToast('❌ Merge failed: ' + (mr?.error || 'Server error'), 'error'); mergeOutBtn.disabled = false; mergeOutBtn.textContent = '📤 Merge out'; }
            };
          row.appendChild(previewBtn); row.appendChild(mergeOutBtn);
          return row;
        };

      // Renders auto-search results + manual search bar into dupSection
      const renderDupResults = (dups) => {
        dupSection.innerHTML = '';
        if (dups.length) {
          const hdr = document.createElement('div');
          hdr.style.cssText = 'font-weight:600;font-size:11px;color:#856404;margin-bottom:6px;';
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
        searchInput.style.cssText = 'flex:1;min-width:120px;padding:4px 8px;border:1px solid #ddd;border-radius:4px;font-size:11px;';
        const closedChk = document.createElement('input');
        closedChk.type = 'checkbox'; closedChk.id = 'manualSearchClosed_' + t.id;
        const closedLbl = document.createElement('label');
        closedLbl.htmlFor = closedChk.id; closedLbl.textContent = 'incl. closed';
        closedLbl.style.cssText = 'font-size:10px;color:#888;white-space:nowrap;cursor:pointer;';
        const searchBtn = document.createElement('button');
        searchBtn.textContent = '🔍 Search';
        searchBtn.style.cssText = 'padding:4px 10px;border:none;border-radius:4px;background:#6f42c1;color:#fff;font-size:11px;cursor:pointer;';
        const manualResults = document.createElement('div');
        manualResults.style.cssText = 'width:100%;margin-top:4px;';
        const doSearch = async () => {
          const q = searchInput.value.trim(); if (!q) return;
          searchBtn.disabled = true; searchBtn.textContent = '⏳';
          const { ok: sok, data: sd } = await gmPost(`${BACKEND_URL}/search-tickets`, {
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

      // Auto-search: by booking refs if available, by member email if user-only, else skip
      if (analysis.bookingId && analysis.bookingData) {
        dupSection.innerHTML = '<div style="color:#999;font-size:11px;">Checking for open threads...</div>';
        const { booking, user } = analysis.bookingData;
        gmPost(`${BACKEND_URL}/check-duplicates`, {
          vendorConf: booking.supplierId, internalId: booking.internalBookingId,
          memberEmail: user?.email || null, freshdeskTicketId: String(t.id),
        }).then(({ ok, data: dd }) => renderDupResults((ok && dd.duplicates) ? dd.duplicates : []));
      } else if (analysis.userData && analysis.userData.email) {
        dupSection.innerHTML = '<div style="color:#999;font-size:11px;">Checking for open threads by member email...</div>';
        gmPost(`${BACKEND_URL}/check-duplicates`, {
          memberEmail: analysis.userData.email, freshdeskTicketId: String(t.id),
        }).then(({ ok, data: dd }) => renderDupResults((ok && dd.duplicates) ? dd.duplicates : []));
      } else {
        renderDupResults([]);
      }
    });

    // ── Add Note panel ─────────────────────────────────────────────────────
    const notePanelWrapper = document.createElement('div');
    notePanelWrapper.style.cssText = 'display:none;border:1px solid #ddd;border-radius:8px;overflow:hidden;flex-shrink:0;background:#fff;';

    const notePanelHeader = document.createElement('div');
    notePanelHeader.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:7px 12px;background:#f8f9fa;border-bottom:1px solid #eee;cursor:pointer;';
    const notePanelTitle = document.createElement('span');
    notePanelTitle.style.cssText = 'font-size:12px;font-weight:600;color:#6f42c1;';
    notePanelTitle.textContent = '📝 Add Note';
    const notePanelClose = document.createElement('button');
    notePanelClose.textContent = '×';
    notePanelClose.style.cssText = 'background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;line-height:1;padding:0;';
    notePanelHeader.appendChild(notePanelTitle);
    notePanelHeader.appendChild(notePanelClose);

    const notePanelBody = document.createElement('div');
    notePanelBody.style.cssText = 'padding:10px 12px;display:flex;flex-direction:column;gap:8px;';

    const noteEditor = document.createElement('div');
    noteEditor.contentEditable = 'true';
    noteEditor.style.cssText = 'min-height:80px;max-height:220px;overflow-y:auto;border:1px solid #ddd;border-radius:5px;padding:8px 10px;font-size:13px;font-family:system-ui,sans-serif;line-height:1.5;color:#333;outline:none;';
    noteEditor.setAttribute('data-placeholder', 'Type note here… or paste an image (Ctrl+V)');

    // Placeholder styling via attribute
    const notePlaceholderStyle = document.createElement('style');
    notePlaceholderStyle.textContent = '[data-placeholder]:empty:before{content:attr(data-placeholder);color:#aaa;pointer-events:none;}';
    notePanelBody.appendChild(notePlaceholderStyle);

    // Intercept paste to convert image blobs → base64 data URLs
    noteEditor.addEventListener('paste', (e) => {
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
              noteEditor.appendChild(img);
            }
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    });

    const noteActionsRow = document.createElement('div');
    noteActionsRow.style.cssText = 'display:flex;gap:8px;';

    const notePostBtn = document.createElement('button');
    notePostBtn.textContent = '📤 Post Note';
    notePostBtn.style.cssText = 'padding:7px 16px;border:none;border-radius:6px;background:#6f42c1;color:#fff;font-size:13px;font-weight:600;cursor:pointer;';
    notePostBtn.onclick = () => withButtonLoading(notePostBtn, '⏳ Posting...', async () => {
      const html = noteEditor.innerHTML.trim();
      if (!html || html === '') { showToast('Note is empty.', 'warning'); return; }
      const { ok } = await gmPost(`${BACKEND_URL}/post-note`, { freshdeskTicketId: String(t.id), noteHtml: html });
      if (ok) {
        noteEditor.innerHTML = '';
        notePanelWrapper.style.display = 'none';
        showToast('✅ Note posted!', 'success', 2000);
        refreshThread();
      } else {
        showToast('❌ Failed to post note.', 'error');
      }
    });

    const noteClearBtn = document.createElement('button');
    noteClearBtn.textContent = 'Clear';
    noteClearBtn.style.cssText = 'padding:7px 12px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#666;font-size:13px;cursor:pointer;';
    noteClearBtn.onclick = () => { noteEditor.innerHTML = ''; noteEditor.focus(); };

    noteActionsRow.appendChild(notePostBtn);
    noteActionsRow.appendChild(noteClearBtn);
    notePanelBody.appendChild(noteEditor);
    notePanelBody.appendChild(noteActionsRow);
    notePanelWrapper.appendChild(notePanelHeader);
    notePanelWrapper.appendChild(notePanelBody);

    addNoteBtn.onclick = () => {
      const open = notePanelWrapper.style.display !== 'none';
      notePanelWrapper.style.display = open ? 'none' : '';
      if (!open) setTimeout(() => noteEditor.focus(), 30);
    };
    notePanelClose.onclick = () => { notePanelWrapper.style.display = 'none'; };

    body.appendChild(notePanelWrapper);
    body.appendChild(btnRow);
  };

  renderTicket();
}

// ── Prewarm progress modal ────────────────────────────────────────────────────
function showPrewarmModal() {
  document.getElementById('taPrewarmModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'taPrewarmModal';
  modal.style.cssText = 'position:fixed;bottom:24px;left:24px;width:440px;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:999999;font-family:system-ui,sans-serif;';
  modal.innerHTML = `
    <div id="taPrewarmHandle" style="padding:12px 16px 10px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-weight:600;font-size:13px;">🔄 Pre-warming bookings...</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="taPrewarmStop" style="padding:3px 10px;border:1px solid #dc3545;border-radius:4px;background:#fff;color:#dc3545;font-size:12px;cursor:pointer;font-weight:500;">Stop</button>
        <button id="taPrewarmClose" style="background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;" disabled>×</button>
      </div>
    </div>
    <div id="taPrewarmLog" style="max-height:280px;overflow-y:auto;font-size:12px;font-family:monospace;background:#f8f8f8;padding:10px 12px;line-height:1.8;border-radius:0 0 10px 10px;"></div>`;
  document.body.appendChild(modal);
  makeDraggable(modal, document.getElementById('taPrewarmHandle'));

  const log      = document.getElementById('taPrewarmLog');
  const closeBtn = document.getElementById('taPrewarmClose');
  const stopBtn  = document.getElementById('taPrewarmStop');
  closeBtn.onclick = () => modal.remove();
  stopBtn.onclick = () => {
    stopBtn.disabled = true; stopBtn.textContent = 'Stopping...';
    GM_xmlhttpRequest({ method: 'POST', url: `${BACKEND_URL}/prewarm/stop`, headers: { 'Content-Type': 'application/json' }, data: '{}', onload: () => {} });
  };

  let lastLogLength = 0;
  let pollInterval  = null;

  const addLines = (lines) => {
    lines.slice(lastLogLength).forEach(msg => {
      log.innerHTML += `<div>${msg}</div>`;
    });
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
      url: `${BACKEND_URL}/prewarm/status`,
      onload: (res) => {
        try {
          const d = JSON.parse(res.responseText);
          addLines(d.log || []);
          if (d.done || d.error) {
            stopPolling();
            log.innerHTML += `<div style="margin-top:8px;font-weight:600;">${d.error ? '❌ ' + d.error : '✅ Done!'}</div>`;
            log.scrollTop = log.scrollHeight;
          }
        } catch (e) { console.warn('Prewarm poll parse error', e); }
      },
      onerror: () => { stopPolling(); log.innerHTML += '<div style="color:red;">❌ Connection lost</div>'; },
    });
  };

  // Start the job
  GM_xmlhttpRequest({
    method: 'POST',
    url: `${BACKEND_URL}/prewarm/start`,
    headers: { 'Content-Type': 'application/json' },
    data: '{}',
    onload: (res) => {
      try {
        const d = JSON.parse(res.responseText);
        if (!d.success) {
          log.innerHTML += `<div style="color:red;">❌ Failed to start: ${d.error || 'unknown'}</div>`;
          stopPolling();
          return;
        }
        // Poll every 2 seconds
        pollInterval = setInterval(poll, 2000);
        poll(); // immediate first poll
      } catch (e) {
        log.innerHTML += '<div style="color:red;">❌ Failed to start prewarm</div>';
        stopPolling();
      }
    },
    onerror: () => {
      log.innerHTML += '<div style="color:red;">❌ Could not reach server</div>';
      stopPolling();
    },
  });
}

// ── Bulk Confirm modal ────────────────────────────────────────────────────────
function showBulkConfirmModal() {
  document.getElementById('taBulkModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'taBulkModal';
  modal.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);width:1100px;max-width:calc(100vw - 48px);max-height:92vh;display:flex;flex-direction:column;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:999999;font-family:system-ui,sans-serif;resize:both;overflow:auto;min-width:500px;';

  const header = document.createElement('div');
  header.id = 'taBulkHandle';
  header.style.cssText = 'padding:12px 16px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;cursor:move;';
  header.innerHTML = '<span style="font-weight:600;font-size:14px;color:#333;">🏨 Bulk Confirm</span>';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;';
  closeBtn.onclick = () => modal.remove();
  header.appendChild(closeBtn);

  // Tag input row
  const inputRow = document.createElement('div');
  inputRow.style.cssText = 'padding:12px 16px;border-bottom:1px solid #eee;display:flex;gap:8px;align-items:center;flex-shrink:0;';
  const tagInput = document.createElement('input');
  tagInput.type = 'text';
  tagInput.placeholder = 'Enter Freshdesk tag (e.g. belenli)';
  tagInput.style.cssText = 'flex:1;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;';
  const fetchBtn = document.createElement('button');
  fetchBtn.textContent = '🔍 Fetch Bookings';
  fetchBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:6px;background:#795548;color:#fff;font-size:13px;font-weight:600;cursor:pointer;';
  inputRow.appendChild(tagInput);
  inputRow.appendChild(fetchBtn);

  // Output area
  const outputArea = document.createElement('div');
  outputArea.style.cssText = 'flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:16px;';

  fetchBtn.onclick = () => withButtonLoading(fetchBtn, '⏳ Fetching...', async () => {
    const tag = tagInput.value.trim();
    if (!tag) { showToast('Enter a tag first.', 'warning'); return; }
    outputArea.innerHTML = '<div style="color:#999;font-size:13px;">Loading...</div>';

    const { ok, data } = await gmPost(`${BACKEND_URL}/bulk-confirm`, { tag });

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

  modal.appendChild(header);
  modal.appendChild(inputRow);
  modal.appendChild(outputArea);
  document.body.appendChild(modal);
  makeDraggable(modal, header);
  setTimeout(() => tagInput.focus(), 100);
}

// ── Check Pendings modal ──────────────────────────────────────────────────────
function showCheckPendingsModal() {
  document.getElementById('taPendingsModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'taPendingsModal';
  modal.style.cssText = 'position:fixed;bottom:24px;right:24px;width:440px;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:999999;font-family:system-ui,sans-serif;';
  modal.innerHTML = `
    <div id="taPendingsHandle" style="padding:12px 16px 10px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-weight:600;font-size:13px;">📋 Checking pending tickets...</span>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="taPendingsStop" style="padding:3px 10px;border:1px solid #dc3545;border-radius:4px;background:#fff;color:#dc3545;font-size:12px;cursor:pointer;font-weight:500;">Stop</button>
        <button id="taPendingsClose" style="background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;" disabled>×</button>
      </div>
    </div>
    <div id="taPendingsLog" style="max-height:280px;overflow-y:auto;font-size:12px;font-family:monospace;background:#f8f8f8;padding:10px 12px;line-height:1.8;border-radius:0 0 10px 10px;"></div>`;
  document.body.appendChild(modal);
  makeDraggable(modal, document.getElementById('taPendingsHandle'));

  const log      = document.getElementById('taPendingsLog');
  const closeBtn = document.getElementById('taPendingsClose');
  const stopBtn  = document.getElementById('taPendingsStop');
  closeBtn.onclick = () => modal.remove();
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

// ── Find User flow ────────────────────────────────────────────────────────────
function showUserSearchModal() {
  document.getElementById('taUserSearchModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'taUserSearchModal';
  modal.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);width:380px;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:999998;font-family:system-ui,sans-serif;';
  modal.innerHTML = `
    <div id="taUserSearchHandle" style="padding:14px 18px 10px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-weight:600;font-size:14px;color:#333;">👤 Find User</span>
      <button id="taUserSearchClose" style="background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;">×</button>
    </div>
    <div style="padding:16px 18px;">
      <input id="taUserSearchInput" type="text" placeholder="Name, email, or phone..."
        style="width:100%;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;box-sizing:border-box;margin-bottom:10px;">
      <button id="taUserSearchBtn" style="width:100%;padding:10px;background:#0056d2;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;">Search →</button>
      <div id="taUserSearchResults" style="margin-top:12px;"></div>
    </div>`;
  document.body.appendChild(modal);
  makeDraggable(modal, document.getElementById('taUserSearchHandle'));

  const input   = document.getElementById('taUserSearchInput');
  const results = document.getElementById('taUserSearchResults');
  document.getElementById('taUserSearchClose').onclick = () => modal.remove();

  const doSearch = async () => {
    const query = input.value.trim();
    if (!query) return;
    results.innerHTML = '<div style="font-size:12px;color:#888;padding:8px 0;">Searching...</div>';
    const { ok, data } = await gmPost(`${BACKEND_URL}/find-user`, { query });
    if (!ok || !data.results?.length) {
      results.innerHTML = '<div style="font-size:12px;color:#dc3545;padding:8px 0;">No users found.</div>';
      return;
    }
    let html = '';
    data.results.forEach((u, i) => {
      const badge = u.type === 'primary' ? '#007bff' : '#17a2b8';
      html += '<div data-idx="' + i + '" style="padding:8px 10px;border:1px solid #eee;border-radius:6px;margin-bottom:6px;cursor:pointer;font-size:13px;">';
      html += '<div style="font-weight:600;">' + u.name;
      if (u.instance) html += ' <span style="font-size:11px;color:#6f42c1;margin-left:4px;">' + u.instance + '</span>';
      html += ' <span style="font-size:10px;background:' + badge + ';color:#fff;padding:1px 6px;border-radius:8px;margin-left:4px;">' + u.type + '</span></div>';
      html += '<div style="font-size:12px;color:#666;">' + (u.email || '');
      if (u.phone) html += ' · ' + u.phone;
      if (u.country) html += ' · ' + u.country;
      html += '</div>';
      if (u.primaryMember) html += '<div style="font-size:11px;color:#888;">Primary: ' + u.primaryMember + '</div>';
      html += '</div>';
    });
    results.innerHTML = html;

    data.results.forEach((u, i) => {
      const el = results.querySelector('[data-idx="' + i + '"]');
      el.onmouseover = () => { el.style.background = '#f5f5f5'; };
      el.onmouseout  = () => { el.style.background = '#fff'; };
      el.onclick = () => { modal.remove(); showUserProfileModal(u); };
    });

    // Preload full profiles in background for primary members
    data.results.forEach(u => {
      if (u.type === 'primary' && !userCache.has(u.id)) {
        gmGetUrl(BACKEND_URL + '/user/' + u.id)
          .then(res => { if (res.ok) userCache.set(u.id, res.data.user); })
          .catch(() => {});
      }
    });
  };

  document.getElementById('taUserSearchBtn').onclick = doSearch;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  setTimeout(() => input.focus(), 100);
}

// Override gmGet to support query params properly
function gmGetUrl(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET', url,
      headers: { 'Content-Type': 'application/json' },
      onload: (res) => {
        try { resolve({ ok: res.status >= 200 && res.status < 300, data: JSON.parse(res.responseText) }); }
        catch (e) { reject(new Error('Invalid JSON')); }
      },
      onerror: () => reject(new Error(`Could not reach ${url}`)),
    });
  });
}

// ── User profile modal ────────────────────────────────────────────────────────
// ── User profile modal ────────────────────────────────────────────────────────
async function showUserProfileModal(userSummary) {
  document.getElementById('taUserProfileModal')?.remove();
  lastViewedUserId      = userSummary.id;
  lastViewedUserSummary = userSummary;
  activateViewButton('taViewUserBtn');
  activateViewButton('taAiBtn'); activateViewButton('taReplyBtn');

  const modal = document.createElement('div');
  modal.id = 'taUserProfileModal';
  modal.style.cssText = 'position:fixed;top:60px;right:24px;width:500px;max-height:90vh;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:999999;font-family:system-ui,sans-serif;display:flex;flex-direction:column;';

  const header = document.createElement('div');
  header.id = 'taUserProfileHandle';
  header.style.cssText = 'padding:14px 18px 10px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';
  header.innerHTML = '<span style="font-weight:600;font-size:14px;color:#333;">👤 ' + userSummary.name + '</span>';
  const closeBtn = document.createElement('button');
  closeBtn.style.cssText = 'background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;';
  closeBtn.textContent = '×';
  closeBtn.onclick = () => modal.remove();
  header.appendChild(closeBtn);

  const tabs = document.createElement('div');
  tabs.style.cssText = 'display:flex;border-bottom:1px solid #eee;flex-shrink:0;';
  const tabProfile = document.createElement('button');
  tabProfile.className = 'ta-user-tab';
  tabProfile.dataset.tab = 'profile';
  tabProfile.textContent = 'Profile';
  tabProfile.style.cssText = 'flex:1;padding:9px;border:none;background:#f8f8f8;font-size:13px;font-weight:600;cursor:pointer;border-bottom:2px solid #007bff;';
  const tabRes = document.createElement('button');
  tabRes.className = 'ta-user-tab';
  tabRes.dataset.tab = 'reservations';
  tabRes.textContent = 'Reservations';
  tabRes.style.cssText = 'flex:1;padding:9px;border:none;background:#fff;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;';
  tabs.appendChild(tabProfile);
  tabs.appendChild(tabRes);

  const content = document.createElement('div');
  content.id = 'taUserTabContent';
  content.style.cssText = 'overflow-y:auto;flex:1;padding:14px 18px;';
  content.innerHTML = '<div style="color:#888;font-size:13px;">Loading...</div>';

  modal.appendChild(header);
  modal.appendChild(tabs);
  modal.appendChild(content);
  document.body.appendChild(modal);
  makeDraggable(modal, header);

  let profileData = null;
  let reservationsData = null;

  const row = (label, val) => {
    if (!val || val === '—') return '';
    return '<tr><td style="padding:4px 8px;color:#888;font-size:12px;white-space:nowrap;">' + label +
           '</td><td style="padding:4px 8px;font-size:13px;">' + val + '</td></tr>';
  };

  const renderProfile = (user) => {
    const freshdeskTicketId = getFreshdeskTicketId();
    let html = '';
    if (user.loginLink || user.profileLink || freshdeskTicketId) {
      html += '<div style="margin-bottom:10px;display:flex;flex-wrap:wrap;gap:6px;">';
      if (user.loginLink)   html += '<a href="' + user.loginLink   + '" target="_blank" style="background:#007bff;color:#fff;padding:4px 10px;border-radius:4px;text-decoration:none;font-size:12px;">Login as User</a>';
      if (user.profileLink) html += '<a href="' + user.profileLink + '" target="_blank" style="background:#0056d2;color:#fff;padding:4px 10px;border-radius:4px;text-decoration:none;font-size:12px;">Open Full Profile</a>';
      if (freshdeskTicketId) html += '<button id="taUserAddNoteBtn" style="background:#28a745;color:#fff;padding:4px 10px;border-radius:4px;border:none;font-size:12px;cursor:pointer;">📋 Add Note</button>';
      html += '</div>';
    }
    html += '<table style="width:100%;border-collapse:collapse;">';
    html += row('Name', user.fullName) + row('Email', user.email) + row('Phone', user.phone);
    html += row('Instance', user.instance) + row('Status', user.status) + row('Turbo', user.turbo);
    html += row('DOB', user.dob) + row('Country', user.country) + row('State', user.state);
    html += row('City', user.city) + row('Nationality', user.nationality) + row('Expiry', user.expiry);
    html += '</table>';
    if (user.secondaryMembers && user.secondaryMembers.length) {
      html += '<div style="margin-top:12px;font-size:13px;font-weight:600;color:#333;">Secondary Members</div>';
      user.secondaryMembers.forEach(function(m) {
        html += '<div style="padding:4px 0;font-size:13px;"><strong>' + m.name + '</strong>';
        if (m.country) html += ' — ' + m.country;
        html += '<span style="background:#28a745;color:#fff;padding:1px 6px;border-radius:8px;font-size:11px;margin-left:4px;">' + (m.status || '') + '</span></div>';
      });
    }
    return html;
  };

  const renderReservations = (reservations) => {
    if (!reservations.length) return '<div style="color:#888;font-size:13px;">No reservations found.</div>';
    let html = '';
    reservations.forEach(function(r) {
      const sc = r.status && r.status.toLowerCase().includes('confirm') ? '#28a745' :
                 r.status && r.status.toLowerCase().includes('cancel') ? '#6c757d' :
                 r.status && r.status.toLowerCase().includes('fail')   ? '#dc3545' : '#007bff';
      html += '<div data-bookingid="' + r.bookingId + '" style="padding:8px 10px;border:1px solid #eee;border-radius:6px;margin-bottom:6px;cursor:pointer;font-size:13px;">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
      html += '<span><strong>#' + r.bookingId + '</strong> <span style="color:#666;font-size:12px;">' + (r.type || '') + '</span></span>';
      html += '<span style="color:' + sc + ';font-size:12px;font-weight:600;">' + (r.status || '') + '</span>';
      html += '</div>';
      html += '<div style="font-size:12px;color:#666;margin-top:2px;">' + (r.guest || '');
      if (r.checkIn) html += ' · ' + r.checkIn + ' → ' + r.checkOut;
      html += '</div></div>';
    });
    return html;
  };

  const setTab = async (tab) => {
    modal.querySelectorAll('.ta-user-tab').forEach(function(btn) {
      const active = btn.dataset.tab === tab;
      btn.style.background    = active ? '#f8f8f8' : '#fff';
      btn.style.fontWeight    = active ? '600' : '400';
      btn.style.borderBottom  = active ? '2px solid #007bff' : '2px solid transparent';
    });

    if (tab === 'profile') {
      if (!profileData) {
        if (userCache.has(userSummary.id)) {
          profileData = userCache.get(userSummary.id);
        } else {
          content.innerHTML = '<div style="color:#888;font-size:13px;">Loading...</div>';
          const res = await gmGetUrl(BACKEND_URL + '/user/' + userSummary.id);
          if (!res.ok) { content.innerHTML = '<div style="color:red;font-size:13px;">Failed to load profile.</div>'; return; }
          profileData = res.data.user;
          userCache.set(userSummary.id, profileData);
        }
      }
      content.innerHTML = renderProfile(profileData);
      const addNoteBtn = document.getElementById('taUserAddNoteBtn');
      if (addNoteBtn) {
        addNoteBtn.onclick = async () => {
          const tid = getFreshdeskTicketId();
          if (!tid) { showToast('No ticket detected.', 'error'); return; }
          addNoteBtn.disabled = true;
          addNoteBtn.textContent = 'Posting...';
          const u = profileData;
          const lines = [
            u.fullName    ? '<strong>Name:</strong> '        + u.fullName    : null,
            u.email       ? '<strong>Email:</strong> '       + u.email       : null,
            u.phone       ? '<strong>Phone:</strong> '       + u.phone       : null,
            u.instance    ? '<strong>Instance:</strong> '    + u.instance    : null,
            u.status      ? '<strong>Status:</strong> '      + u.status      : null,
            u.country     ? '<strong>Country:</strong> '     + u.country     : null,
            u.loginLink   ? '<strong>Login:</strong> <a href="' + u.loginLink + '" target="_blank">Login as User</a>' : null,
            u.profileLink ? '<strong>Profile:</strong> <a href="' + u.profileLink + '" target="_blank">Open Full Profile</a>' : null,
          ].filter(Boolean);
          const noteHtml = '<p><strong>👤 Member Details</strong></p><p>' + lines.join('<br>') + '</p>';
          const { ok } = await gmPost(BACKEND_URL + '/post-note', { freshdeskTicketId: tid, noteHtml });
          if (ok) { addNoteBtn.textContent = '✅ Posted!'; showToast('✅ Member note posted.'); refreshFreshdeskTicket(); }
          else    { addNoteBtn.textContent = '❌ Failed';  addNoteBtn.disabled = false; showToast('Failed to post note.', 'error'); }
        };
      }
    } else {
      if (!reservationsData) {
        content.innerHTML = '<div style="color:#888;font-size:13px;">Loading reservations...</div>';
        const res = await gmGetUrl(BACKEND_URL + '/user/' + userSummary.id + '/reservations');
        if (!res.ok) { content.innerHTML = '<div style="color:red;font-size:13px;">Failed to load reservations.</div>'; return; }
        reservationsData = res.data.reservations;
      }
      content.innerHTML = renderReservations(reservationsData);
      content.querySelectorAll('[data-bookingid]').forEach(function(el) {
        el.onmouseover = function() { el.style.background = '#f5f5f5'; };
        el.onmouseout  = function() { el.style.background = '#fff'; };
        el.onclick = function() {
          modal.remove();
          const tid = getFreshdeskTicketId();
          if (tid) triggerNewBookingFlow(el.dataset.bookingid, tid);
          else showToast('No ticket detected — open a ticket first.', 'warning');
        };
      });
    }
  };

  tabProfile.onclick = () => setTab('profile');
  tabRes.onclick     = () => setTab('reservations');

  if (userSummary.type === 'primary') {
    setTab('profile');
  } else {
    let html = '<table style="width:100%;border-collapse:collapse;">';
    [['Name', userSummary.name], ['Email', userSummary.email], ['Phone', userSummary.phone],
     ['Instance', userSummary.instance], ['Status', userSummary.status],
     ['Primary Member', userSummary.primaryMember]].forEach(function(pair) {
      if (pair[1]) html += row(pair[0], pair[1]);
    });
    html += '</table>';
    content.innerHTML = html;
  }
}

function addFindUserButton() {
  const check = setInterval(() => {
    const container = document.querySelector('.ticket-actions, .page-actions');
    if (container && !document.getElementById('taFindUserBtn')) {
      const btn = document.createElement('button');
      btn.id = 'taFindUserBtn';
      btn.textContent = '👤 Find User';
      btn.style.cssText = 'background:#0056d2;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);';
      btn.onclick = () => showUserSearchModal();

      // Listen for booking click from reservation history
      btn.addEventListener('findBooking', (e) => {
        const freshdeskTicketId = getFreshdeskTicketId();
        if (freshdeskTicketId) triggerNewBookingFlow(e.detail, freshdeskTicketId);
      });

      const prewarmBtn = document.getElementById('taPrewarmBtn');
      if (prewarmBtn) prewarmBtn.parentNode.insertBefore(btn, prewarmBtn.nextSibling);
      else container.appendChild(btn);
      clearInterval(check);
    }
  }, 1000);
}

function activateViewButton(id) {
  const btn = document.getElementById(id);
  if (btn) { btn.style.opacity = '1'; }
}

// ── Variable substitution for prompts and macros ─────────────────────────────
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

// ── Reply modal ───────────────────────────────────────────────────────────────
function showReplyModal(overrideTicketId = null) {
  document.getElementById('taReplyModal')?.remove();

  const hasBooking = lastViewedBookingId && bookingCache.has(lastViewedBookingId);
  const hasUser    = lastViewedUserSummary !== null;
  if (!hasBooking && !hasUser) { showToast('Load a booking or user first.', 'warning'); return; }

  const data     = hasBooking ? bookingCache.get(lastViewedBookingId) : {};
  const booking  = data.booking  || null;
  const details  = data.details  || null;
  const supplier = data.supplier || null;
  const user     = (hasBooking && data.user) ? data.user
    : (lastViewedUserId && userCache.has(lastViewedUserId) ? userCache.get(lastViewedUserId) : lastViewedUserSummary);

  const supplierEmail = supplier && supplier.email ? supplier.email : null;
  const customerEmail = user && user.email ? user.email : null;

  if (!supplierEmail && !customerEmail) { showToast('No email addresses available.', 'warning'); return; }

  const modal = document.createElement('div');
  modal.id = 'taReplyModal';
  modal.style.cssText = 'position:fixed;top:60px;right:24px;width:960px;max-width:calc(100vw - 48px);max-height:92vh;display:flex;flex-direction:column;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:999999;font-family:system-ui,sans-serif;resize:both;overflow:auto;min-width:500px;min-height:300px;';

  // ── Header ──────────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.id = 'taReplyHandle';
  header.style.cssText = 'padding:12px 16px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;cursor:move;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;';
  closeBtn.onclick = () => modal.remove();

  const selectorRow = document.createElement('div');
  selectorRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
  const titleEl = document.createElement('span');
  titleEl.style.cssText = 'font-weight:600;font-size:14px;color:#333;';
  titleEl.textContent = '💬 Reply';
  selectorRow.appendChild(titleEl);

  // ── Context bar ─────────────────────────────────────────────────────────────
  const contextBar = document.createElement('div');
  contextBar.style.cssText = 'padding:10px 16px;background:#f8f9fa;border-bottom:1px solid #eee;flex-shrink:0;display:flex;gap:24px;flex-wrap:wrap;font-size:12px;color:#555;';

  const ctxItems = [];

  // Customer info
  if (user) {
    const name = user.fullName || user.name || null;
    if (name) ctxItems.push({ label: 'Customer', value: name });
    if (user.country) ctxItems.push({ label: 'Country', value: user.country });
  }

  // Booking info
  if (booking) {
    if (booking.internalBookingId) ctxItems.push({ label: 'Booking', value: booking.internalBookingId });
    const productType = (booking.productType || '').toLowerCase();
    if (productType === 'hotel' || !productType) {
      if (details && details.hotelName) ctxItems.push({ label: 'Hotel', value: details.hotelName });
      if (booking.mwrRoomType) ctxItems.push({ label: 'Room', value: booking.mwrRoomType });
    } else if (productType === 'flight') {
      if (details && details.departAirline) ctxItems.push({ label: 'Airline', value: details.departAirline });
      if (booking.locationTo) ctxItems.push({ label: 'Destination', value: booking.locationTo });
    } else {
      if (booking.supplierName) ctxItems.push({ label: 'Supplier', value: booking.supplierName });
    }
    if (booking.checkIn) ctxItems.push({ label: 'Check-in', value: booking.checkIn });
  }

  ctxItems.forEach(({ label, value }) => {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;gap:4px;align-items:baseline;';
    item.innerHTML = `<span style="color:#999;font-weight:500;">${label}:</span><span style="color:#333;font-weight:500;">${value}</span>`;
    contextBar.appendChild(item);
  });

  const body = document.createElement('div');
  body.style.cssText = 'padding:14px 16px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:8px;';

  const renderComposer = (type) => {
    body.innerHTML = '';
    const email = type === 'supplier' ? supplierEmail : customerEmail;
    showReplyComposer(type, email, booking, details, user, supplier, body, null, overrideTicketId);
  };

  if (supplierEmail) {
    const sBtn = document.createElement('button');
    sBtn.textContent = '↗ Supplier';
    sBtn.style.cssText = 'padding:4px 10px;border:1px solid #28a745;border-radius:14px;background:#fff;color:#28a745;font-size:12px;cursor:pointer;font-weight:500;';
    sBtn.title = supplierEmail;
    sBtn.onmouseover = () => { sBtn.style.background = '#28a745'; sBtn.style.color = '#fff'; };
    sBtn.onmouseout  = () => { sBtn.style.background = '#fff'; sBtn.style.color = '#28a745'; };
    sBtn.onclick = () => renderComposer('supplier');
    selectorRow.appendChild(sBtn);
  }
  if (customerEmail) {
    const cBtn = document.createElement('button');
    cBtn.textContent = '↙ Customer';
    cBtn.style.cssText = 'padding:4px 10px;border:1px solid #007bff;border-radius:14px;background:#fff;color:#007bff;font-size:12px;cursor:pointer;font-weight:500;';
    cBtn.title = customerEmail;
    cBtn.onmouseover = () => { cBtn.style.background = '#007bff'; cBtn.style.color = '#fff'; };
    cBtn.onmouseout  = () => { cBtn.style.background = '#fff'; cBtn.style.color = '#007bff'; };
    cBtn.onclick = () => renderComposer('customer');
    selectorRow.appendChild(cBtn);
  }

  header.appendChild(selectorRow);
  header.appendChild(closeBtn);
  modal.appendChild(header);
  if (ctxItems.length > 0) modal.appendChild(contextBar);
  modal.appendChild(body);
  document.body.appendChild(modal);
  makeDraggable(modal, header);

  if (customerEmail) renderComposer('customer');
  else renderComposer('supplier');
}

// ── AI Assist modal ───────────────────────────────────────────────────────────
function showAiModal() {
  document.getElementById('taAiModal')?.remove();

  const hasBooking = lastViewedBookingId && bookingCache.has(lastViewedBookingId);
  const hasUser    = lastViewedUserSummary !== null;

  const data     = hasBooking ? bookingCache.get(lastViewedBookingId) : {};
  const booking  = data.booking  || null;
  const details  = data.details  || null;
  const supplier = data.supplier || null;

  // Use cached user profile if available, fall back to summary
  const user = (hasBooking && data.user)
    ? data.user
    : (lastViewedUserId && userCache.has(lastViewedUserId) ? userCache.get(lastViewedUserId) : lastViewedUserSummary);

  const modalTitle = hasBooking
    ? '🤖 AI Assist — #' + lastViewedBookingId
    : hasUser
      ? '🤖 AI Assist — ' + (user?.fullName || user?.name || 'Member')
      : '🤖 AI Assist — Ticket #' + (getFreshdeskTicketId() || '?');


  const modal = document.createElement('div');
  modal.id = 'taAiModal';
  modal.style.cssText = 'position:fixed;top:60px;left:24px;width:1230px;max-width:calc(100vw - 48px);max-height:92vh;display:flex;flex-direction:column;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:999999;font-family:system-ui,sans-serif;resize:both;overflow:auto;min-width:500px;min-height:200px;';

  // Header
  const header = document.createElement('div');
  header.id = 'taAiHandle';
  header.style.cssText = 'padding:12px 16px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;cursor:move;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;';
  closeBtn.onclick = () => modal.remove();
  header.innerHTML = '<span style="font-weight:600;font-size:14px;color:#333;">' + modalTitle + '</span>';
  const headerBtns = document.createElement('div');
  headerBtns.style.cssText = 'display:flex;align-items:center;gap:8px;';
  const settingsBtn = document.createElement('button');
  settingsBtn.textContent = '⚙️';
  settingsBtn.title = 'Settings';
  settingsBtn.style.cssText = 'background:none;border:none;font-size:16px;cursor:pointer;padding:2px 4px;';
  settingsBtn.onclick = () => showAiSettingsModal(booking, details, user, supplier);
  headerBtns.appendChild(settingsBtn);
  headerBtns.appendChild(closeBtn);
  header.appendChild(headerBtns);

  // Prompt preset buttons — loaded dynamically from server
  const promptBar = document.createElement('div');
  promptBar.style.cssText = 'padding:10px 16px;border-bottom:1px solid #eee;display:flex;flex-wrap:wrap;gap:6px;flex-shrink:0;align-items:center;';

  // Editable prompt textarea
  const promptArea = document.createElement('textarea');
  promptArea.id = 'taAiPromptText';
  promptArea.placeholder = 'Select a preset above or type your own prompt...';
  promptArea.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;font-family:system-ui,sans-serif;resize:vertical;min-height:80px;line-height:1.5;outline:none;';

  // Async: load prompts from server and render buttons
  gmGet(BACKEND_URL + '/settings/prompts').then(({ ok, data: promptsData }) => {
    const list = (ok && Array.isArray(promptsData)) ? promptsData : [];
    list.forEach(p => {
      const btn = document.createElement('button');
      btn.textContent = p.label;
      btn.style.cssText = 'padding:5px 11px;border:1px solid #6f42c1;border-radius:16px;background:#fff;color:#6f42c1;font-size:12px;cursor:pointer;font-weight:500;';
      btn.onmouseover = () => { btn.style.background = '#6f42c1'; btn.style.color = '#fff'; };
      btn.onmouseout  = () => { btn.style.background = '#fff';    btn.style.color = '#6f42c1'; };
      btn.onclick = () => {
        promptArea.value = substituteVars(p.text, booking, details, user);
        promptArea.focus();
      };
      promptBar.insertBefore(btn, promptBar.lastElementChild);
    });
  });

  // Dedicated Find Hotel Email button — only for hotel bookings
  if (hasBooking && booking && booking.productType?.toLowerCase() === 'hotel') {
    const hotelEmailBtn = document.createElement('button');
    hotelEmailBtn.textContent = '🔍 Find Hotel Email';
    hotelEmailBtn.style.cssText = 'padding:5px 11px;border:1px solid #17a2b8;border-radius:16px;background:#fff;color:#17a2b8;font-size:12px;cursor:pointer;font-weight:500;';
    hotelEmailBtn.onmouseover = () => { hotelEmailBtn.style.background = '#17a2b8'; hotelEmailBtn.style.color = '#fff'; };
    hotelEmailBtn.onmouseout  = () => { hotelEmailBtn.style.background = '#fff';    hotelEmailBtn.style.color = '#17a2b8'; };
    hotelEmailBtn.onclick = () => runHotelEmailSearch(booking, details, outputArea, actionsArea, hotelEmailBtn);
    promptBar.appendChild(hotelEmailBtn);
  }

  // Extract Booking ID button
  const extractBtn = document.createElement('button');
  extractBtn.textContent = '🔎 Extract Booking ID';
  extractBtn.style.cssText = 'padding:5px 11px;border:1px solid #fd7e14;border-radius:16px;background:#fff;color:#fd7e14;font-size:12px;cursor:pointer;font-weight:500;';
  extractBtn.onmouseover = () => { extractBtn.style.background = '#fd7e14'; extractBtn.style.color = '#fff'; };
  extractBtn.onmouseout  = () => { extractBtn.style.background = '#fff';    extractBtn.style.color = '#fd7e14'; };
  extractBtn.onclick = () => runExtractBookingId(extractBtn, outputArea);
  promptBar.appendChild(extractBtn);

  // Prompt input area
  const inputArea = document.createElement('div');
  inputArea.style.cssText = 'padding:10px 16px;border-bottom:1px solid #eee;flex-shrink:0;display:flex;flex-direction:column;gap:8px;';

  const runBtn = document.createElement('button');
  runBtn.textContent = '▶ Run';
  runBtn.style.cssText = 'align-self:flex-end;padding:7px 20px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#6f42c1;color:#fff;';
  runBtn.onclick = () => {
    const prompt = promptArea.value.trim();
    if (!prompt) { showToast('Enter a prompt first.', 'warning'); return; }
    runAiPrompt(prompt, booking, details, user, supplier, outputArea, actionsArea, runBtn);
  };
  promptArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runBtn.click();
  });

  inputArea.appendChild(promptArea);
  inputArea.appendChild(runBtn);

  // Output area
  const outputArea = document.createElement('div');
  outputArea.style.cssText = 'padding:14px 16px;overflow-y:auto;flex:1;font-size:13px;line-height:1.6;color:#555;white-space:pre-wrap;min-height:100px;';
  outputArea.textContent = 'Output will appear here.';

  // Actions area
  const actionsArea = document.createElement('div');
  actionsArea.style.cssText = 'padding:10px 16px;border-top:1px solid #eee;display:none;gap:8px;flex-shrink:0;';

  modal.appendChild(header);
  modal.appendChild(promptBar);
  modal.appendChild(outputArea);
  modal.appendChild(actionsArea);
  modal.appendChild(inputArea);
  document.body.appendChild(modal);
  makeDraggable(modal, header);
  promptArea.focus();
}

async function runAiPrompt(prompt, booking, details, user, supplier, outputArea, actionsArea, runBtn) {
  outputArea.textContent = '⏳ Generating...';
  actionsArea.style.display = 'none';
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '⏳ Running...'; }

  const { ok, data } = await gmPost(BACKEND_URL + '/ai-assist', {
    booking:  booking || {},
    details:  details || {},
    user,
    supplier: supplier || null,
    freshdeskTicketId: getFreshdeskTicketId(),
    prompt,
  });

  if (runBtn) { runBtn.disabled = false; runBtn.textContent = '▶ Run'; }

  if (!ok) {
    outputArea.textContent = '❌ Error: ' + (data?.error || 'Unknown error');
    return;
  }

  const hasMarkdown = /^#{1,6}\s|^\*{1,2}[^*]|\*{1,2}[^*].*\*{1,2}|^[-*+]\s|\[.+\]\(.+\)|^```|^>/m.test(data.text);
  try {
    if (hasMarkdown && typeof marked !== 'undefined') {
      outputArea.innerHTML = marked.parse(data.text);
      outputArea.style.whiteSpace = 'normal';
    } else {
      outputArea.textContent = data.text;
      outputArea.style.whiteSpace = 'pre-wrap';
    }
  } catch(e) { outputArea.textContent = data.text; outputArea.style.whiteSpace = 'pre-wrap'; }

  // Show action buttons
  actionsArea.innerHTML = '';
  actionsArea.style.display = 'flex';

  const noteBtn = document.createElement('button');
  noteBtn.textContent = '📋 Post as Note';
  noteBtn.style.cssText = 'padding:7px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#007bff;color:#fff;';
  noteBtn.onclick = async () => {
    const tid = getFreshdeskTicketId();
    if (!tid) { showToast('No ticket detected.', 'error'); return; }
    noteBtn.disabled = true; noteBtn.textContent = 'Posting...';
    const noteHtml = '<p>' + data.text.replace(/\n/g, '<br>') + '</p>';
    const { ok: noteOk } = await gmPost(BACKEND_URL + '/post-note', { freshdeskTicketId: tid, noteHtml });
    if (noteOk) { noteBtn.textContent = '✅ Posted!'; showToast('Note posted.'); refreshFreshdeskTicket(); }
    else        { noteBtn.textContent = '❌ Failed';  noteBtn.disabled = false; }
  };

  const copyBtn = document.createElement('button');
  copyBtn.textContent = '📋 Copy';
  copyBtn.style.cssText = 'padding:7px 14px;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#555;';
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(data.text).then(() => { copyBtn.textContent = '✅ Copied!'; setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000); });
  };

  actionsArea.appendChild(noteBtn);
  actionsArea.appendChild(copyBtn);
}

async function runHotelEmailSearch(booking, details, outputArea, actionsArea, triggerBtn) {
  const hotelName    = (details && details.hotelName) || booking.supplierName;
  const hotelAddress = (details && details.hotelAddress) || booking.locationTo || '';
  const hotelCountry = booking.destinationCountry || '';

  outputArea.textContent = '🔍 Searching for hotel email...';
  actionsArea.innerHTML  = '';
  actionsArea.style.display = 'none';
  if (triggerBtn) { triggerBtn.disabled = true; }

  const { ok, data } = await gmPost(BACKEND_URL + '/find-hotel-email', {
    hotelName, hotelAddress, hotelCountry,
  });

  if (triggerBtn) { triggerBtn.disabled = false; }

  if (!ok) {
    outputArea.textContent = '❌ Error: ' + (data?.error || 'Unknown error');
    return;
  }

  const { email, source, confidence, notes } = data;
  const confColor = confidence === 'high' ? '#28a745' : confidence === 'medium' ? '#fd7e14' : '#dc3545';

  // Render structured result
  let html = '<div style="font-size:13px;line-height:1.8;">';
  html += '<div><strong>Hotel:</strong> ' + hotelName + '</div>';
  if (hotelAddress) html += '<div><strong>Address:</strong> ' + hotelAddress + '</div>';
  html += '<hr style="margin:8px 0;border:none;border-top:1px solid #eee;">';
  if (email) {
    html += '<div><strong>Email:</strong> <a href="mailto:' + email + '" style="color:#007bff;">' + email + '</a></div>';
  } else {
    html += '<div style="color:#dc3545;"><strong>Email:</strong> Not found</div>';
  }
  if (source) html += '<div><strong>Source:</strong> <span style="font-size:12px;color:#666;">' + source + '</span></div>';
  html += '<div><strong>Confidence:</strong> <span style="color:' + confColor + ';font-weight:600;">' + (confidence || '—') + '</span></div>';
  if (notes) html += '<div><strong>Notes:</strong> <span style="font-size:12px;color:#666;">' + notes + '</span></div>';
  html += '</div>';
  outputArea.innerHTML = html;

  // Action buttons
  actionsArea.style.display = 'flex';

  if (email) {
    const sendBtn = document.createElement('button');
    sendBtn.textContent = '✉️ Send Hotel Email';
    sendBtn.style.cssText = 'padding:7px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#28a745;color:#fff;';
    sendBtn.onclick = async () => {
      const tid = getFreshdeskTicketId();
      if (!tid) { showToast('No ticket detected.', 'error'); return; }
      if (confidence === 'low') {
        const confirmed = await new Promise(resolve => {
          showConfirmModal('⚠️ Low Confidence', ['Confidence is low — are you sure you want to send?'], 'Send Anyway', () => resolve(true), () => resolve(false), '#fd7e14');
        });
        if (!confirmed) return;
      }
      sendBtn.disabled = true; sendBtn.textContent = 'Sending...';
      const { ok: sendOk } = await gmPost(BACKEND_URL + '/send-hotel-email', {
        freshdeskTicketId: tid, hotelEmail: email, booking, details,
      });
      if (sendOk) { sendBtn.textContent = '✅ Sent!'; showToast('Email sent to hotel.'); refreshFreshdeskTicket(); }
      else        { sendBtn.textContent = '❌ Failed'; sendBtn.disabled = false; }
    };
    actionsArea.appendChild(sendBtn);
  }

  const copyBtn = document.createElement('button');
  copyBtn.textContent = '📋 Copy Email';
  copyBtn.style.cssText = 'padding:7px 14px;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#555;';
  copyBtn.onclick = () => {
    if (!email) { showToast('No email to copy.', 'warning'); return; }
    navigator.clipboard.writeText(email).then(() => { copyBtn.textContent = '✅ Copied!'; setTimeout(() => { copyBtn.textContent = '📋 Copy Email'; }, 2000); });
  };
  actionsArea.appendChild(copyBtn);
}



async function runExtractBookingId(triggerBtn, outputArea) {
  const tid = getFreshdeskTicketId();
  if (!tid) { showToast('No ticket detected.', 'error'); return; }

  triggerBtn.disabled = true; triggerBtn.textContent = '⏳ Extracting...';
  outputArea.textContent = '🔎 Extracting booking ID from ticket...';

  const { ok, data } = await gmPost(BACKEND_URL + '/extract-booking-id', { freshdeskTicketId: tid });

  triggerBtn.disabled = false; triggerBtn.textContent = '🔎 Extract Booking ID';

  if (!ok) { outputArea.textContent = '❌ Error: ' + (data?.error || 'Unknown'); return; }
  if (!data.bookingId) { outputArea.textContent = '⚠️ No booking reference found in this ticket.'; return; }

  // Cache the result in frontend
  const bookingId = data.bookingId;
  const { ok: bOk, data: bData } = await gmGet(BACKEND_URL + '/booking/' + bookingId);
  if (bOk && bData.booking) {
    const fullData = { ...bData, duplicates: [] };
    bookingCache.set(bookingId, fullData);
    lastViewedBookingId = bookingId;
    activateViewButton('taViewBookingBtn');
    activateViewButton('taAiBtn'); activateViewButton('taReplyBtn');
    outputArea.textContent = '✅ Booking #' + bookingId + ' loaded — ' + (bData.booking.productType || '') + ' · ' + (bData.booking.guestName || '') + ' · ' + (bData.booking.checkIn || '') + ' → ' + (bData.booking.checkOut || '');
  } else {
    outputArea.textContent = '✅ Booking ID extracted: ' + bookingId + ' (server cached, reload preview to view)';
  }
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
  const rawName = user && (user.fullName || user.name) ? (user.fullName || user.name).split(' ')[0] : 'there';
  const firstName = rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
  const supplierName = booking && booking.supplierName ? stripHtml(booking.supplierName) : 'hotel';
  const hotelName    = booking && booking.supplierName ? stripHtml(booking.supplierName) : null;

  const greeting = recipientType === 'supplier'
    ? 'Hi, dear ' + supplierName + ' team,'
    : 'Hi, ' + firstName + ',';

  const sig = [
    'If you have any questions, I\'m here for you.',
    '',
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

  return greeting + '\nHope you\'re well.\n\n' + body + '\n\n' + sig;
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
function showReplyComposer(recipientType, toEmail, booking, details, user, supplier, bodyEl, onSent, overrideTicketId = null) {
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
  const replyArea = document.createElement('div');
  replyArea.contentEditable = 'true';
  replyArea.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;font-family:system-ui,sans-serif;min-height:200px;line-height:1.5;outline:none;overflow-y:auto;white-space:pre-wrap;word-break:break-word;';
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

  // Intercept image-file pastes — convert blob URL to base64 so images survive in email
  replyArea.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = (ev) => {
          const img = document.createElement('img');
          img.src = ev.target.result;
          img.style.cssText = 'max-width:100%;height:auto;display:block;margin:4px 0;border-radius:3px;';
          const sel = window.getSelection();
          if (sel && sel.rangeCount) {
            const range = sel.getRangeAt(0);
            range.deleteContents(); range.insertNode(img);
            range.setStartAfter(img); range.collapse(true);
            sel.removeAllRanges(); sel.addRange(range);
          } else { replyArea.appendChild(img); }
        };
        reader.readAsDataURL(item.getAsFile());
        return;
      }
    }
  });

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

    const translationArea = document.createElement('textarea');
    translationArea.readOnly = true;
    translationArea.placeholder = 'Translation will appear here...';
    translationArea.style.cssText = 'display:none;width:100%;box-sizing:border-box;margin-top:6px;padding:9px 12px;border:1px solid #17a2b8;border-radius:6px;font-size:13px;font-family:system-ui,sans-serif;resize:vertical;min-height:160px;line-height:1.5;background:#f8fffe;color:#333;';
    container.appendChild(translationArea);

    translateBtn.onclick = () => withButtonLoading(translateBtn, '⏳ Translating...', async () => {
      const body = replyArea.innerText.trim();
      if (!body) { showToast('Nothing to translate.', 'warning'); return; }
      const lang = langInput.value.trim() || detectedLang || 'the customer\'s language';
      const prompt = 'Translate the following text to ' + lang + '. Translate everything including greetings and sign-offs. Return only the translated text — no explanation, no extra content.\n\n' + body;
      translationArea.style.display = '';
      translationArea.value = 'Translating...';
      const { ok, data: aiData } = await gmPost(BACKEND_URL + '/ai-assist', {
        booking: booking || {}, details: details || {}, user, supplier: supplier || null,
        freshdeskTicketId: getFreshdeskTicketId(), prompt,
      });
      translationArea.value = (ok && aiData.text) ? aiData.text.trim() : 'Translation failed.';
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
      ok = (await gmPostForm(BACKEND_URL + '/send-reply', fd)).ok;
    } else {
      ok = (await gmPost(BACKEND_URL + '/send-reply', { freshdeskTicketId: tid, toEmail, bodyHtml: noteHtml })).ok;
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

  actionsArea.appendChild(sendBtn);
  actionsArea.appendChild(copyBtn);
}

// ── AI Settings modal ─────────────────────────────────────────────────────────
function showAiSettingsModal(booking, details, user, supplier) {
  document.getElementById('taAiSettingsModal')?.remove();

  const VARS = [
    ['Booking', [
      '{{bookingId}}', '{{supplierBookingId}}', '{{guestName}}', '{{checkIn}}', '{{checkOut}}',
      '{{hotelName}}', '{{supplierName}}', '{{roomType}}', '{{country}}', '{{city}}', '{{productType}}',
    ]],
    ['Member', [
      '{{memberName}}', '{{memberFirstName}}', '{{memberEmail}}', '{{memberPhone}}',
      '{{memberCountry}}', '{{memberLanguage}}', '{{memberInstance}}',
    ]],
  ];

  const modal = document.createElement('div');
  modal.id = 'taAiSettingsModal';
  modal.style.cssText = 'position:fixed;top:100px;left:50%;transform:translateX(-50%);width:680px;max-width:calc(100vw - 48px);max-height:85vh;display:flex;flex-direction:column;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.3);z-index:1000000;font-family:system-ui,sans-serif;';

  const header = document.createElement('div');
  header.id = 'taAiSettingsHandle';
  header.style.cssText = 'padding:12px 16px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;cursor:move;';

  const titleEl = document.createElement('span');
  titleEl.style.cssText = 'font-weight:600;font-size:14px;color:#333;';
  titleEl.textContent = '⚙️ AI Settings';

  const headerRight = document.createElement('div');
  headerRight.style.cssText = 'display:flex;align-items:center;gap:8px;';

  const varsBtn = document.createElement('button');
  varsBtn.textContent = '{{}}';
  varsBtn.title = 'Available variables';
  varsBtn.style.cssText = 'background:#f5f5f5;border:1px solid #ddd;border-radius:4px;font-size:11px;font-family:monospace;padding:2px 7px;cursor:pointer;color:#555;';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;';
  closeBtn.onclick = () => modal.remove();

  headerRight.appendChild(varsBtn);
  headerRight.appendChild(closeBtn);
  header.appendChild(titleEl);
  header.appendChild(headerRight);

  // Variables panel (hidden by default)
  const varsPanel = document.createElement('div');
  varsPanel.style.cssText = 'display:none;padding:10px 16px;background:#f8f9fa;border-bottom:1px solid #eee;font-size:12px;';
  VARS.forEach(([group, tokens]) => {
    const g = document.createElement('div');
    g.style.cssText = 'margin-bottom:6px;';
    g.innerHTML = '<strong style="color:#555;">' + group + ':</strong> ';
    tokens.forEach(t => {
      const span = document.createElement('code');
      span.textContent = t;
      span.style.cssText = 'background:#e9ecef;padding:1px 5px;border-radius:3px;margin:0 2px;cursor:pointer;font-size:11px;';
      span.onclick = () => { navigator.clipboard.writeText(t); showToast('Copied ' + t, 'success', 1500); };
      g.appendChild(span);
    });
    varsPanel.appendChild(g);
  });
  varsBtn.onclick = () => { varsPanel.style.display = varsPanel.style.display === 'none' ? 'block' : 'none'; };

  // Tabs
  const tabs = document.createElement('div');
  tabs.style.cssText = 'display:flex;border-bottom:1px solid #eee;flex-shrink:0;padding:0 16px;';
  const tabBodies = {};
  ['Prompts', 'Macros'].forEach((name, i) => {
    const tab = document.createElement('button');
    tab.textContent = name;
    tab.style.cssText = 'padding:10px 16px;border:none;background:none;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;font-weight:500;';
    tab.onclick = () => {
      [...tabs.children].forEach(t => { t.style.borderBottomColor = 'transparent'; t.style.color = '#666'; });
      tab.style.borderBottomColor = '#6f42c1'; tab.style.color = '#6f42c1';
      Object.values(tabBodies).forEach(b => { b.style.display = 'none'; });
      tabBodies[name].style.display = 'flex';
    };
    if (i === 0) { tab.style.borderBottomColor = '#6f42c1'; tab.style.color = '#6f42c1'; }
    else { tab.style.color = '#666'; }
    tabs.appendChild(tab);
  });

  // Prompts tab
  const promptsBody = document.createElement('div');
  promptsBody.style.cssText = 'flex:1;overflow-y:auto;flex-direction:column;display:flex;';
  tabBodies['Prompts'] = promptsBody;

  const macrosBody = document.createElement('div');
  macrosBody.style.cssText = 'flex:1;overflow-y:auto;flex-direction:column;display:none;';
  tabBodies['Macros'] = macrosBody;

  function buildItemList(container, items, type) {
    container.innerHTML = '';
    const list = document.createElement('div');
    list.style.cssText = 'flex:1;overflow-y:auto;';
    items.forEach(item => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:10px 16px;border-bottom:1px solid #f0f0f0;';
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;';
      const label = document.createElement('div');
      label.style.cssText = 'font-size:13px;font-weight:500;color:#333;margin-bottom:2px;';
      label.textContent = type === 'prompt' ? item.label : item.name;
      const preview = document.createElement('div');
      preview.style.cssText = 'font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:450px;';
      preview.textContent = item.text;
      info.appendChild(label);
      info.appendChild(preview);

      const editBtn = document.createElement('button');
      editBtn.textContent = '✏️';
      editBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;flex-shrink:0;';
      editBtn.onclick = () => showItemForm(container, items, type, item);

      const delBtn = document.createElement('button');
      delBtn.textContent = '🗑️';
      delBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:14px;flex-shrink:0;';
      delBtn.onclick = async () => {
        const endpoint = type === 'prompt' ? '/settings/prompts/' : '/settings/macros/';
        await gmDelete(BACKEND_URL + endpoint + item.id);
        await refreshSettingsTab(container, type);
      };

      row.appendChild(info);
      row.appendChild(editBtn);
      row.appendChild(delBtn);
      list.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add ' + (type === 'prompt' ? 'Prompt' : 'Macro');
    addBtn.style.cssText = 'margin:12px 16px;padding:8px 14px;border:1px dashed #6f42c1;border-radius:6px;background:#fff;color:#6f42c1;font-size:13px;cursor:pointer;align-self:flex-start;';
    addBtn.onclick = () => showItemForm(container, items, type, null);

    container.appendChild(list);
    container.appendChild(addBtn);
  }

  function showItemForm(container, items, type, item) {
    container.innerHTML = '';
    const form = document.createElement('div');
    form.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:10px;flex:1;';

    const labelInput = document.createElement('input');
    labelInput.placeholder = type === 'prompt' ? 'Button label (e.g. 📋 Summarize)' : 'Macro name (e.g. greeting_en)';
    labelInput.style.cssText = 'padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;';
    labelInput.value = item ? (type === 'prompt' ? item.label : item.name) : '';

    const textArea = document.createElement('textarea');
    textArea.placeholder = type === 'prompt' ? 'Prompt text. Use {{variables}} for dynamic content.' : 'Macro text. Use {{variables}} for dynamic content.';
    textArea.style.cssText = 'padding:8px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;resize:vertical;min-height:180px;font-family:system-ui,sans-serif;line-height:1.5;';
    textArea.value = item ? item.text : '';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '💾 Save';
    saveBtn.style.cssText = 'padding:8px 18px;border:none;border-radius:6px;background:#6f42c1;color:#fff;font-size:13px;font-weight:600;cursor:pointer;';
    saveBtn.onclick = async () => {
      const lv = labelInput.value.trim();
      const tv = textArea.value.trim();
      if (!lv || !tv) { showToast('Both fields required.', 'warning'); return; }
      saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
      const body = type === 'prompt' ? { label: lv, text: tv } : { name: lv, text: tv };
      if (item) {
        await gmPut(BACKEND_URL + '/settings/' + (type === 'prompt' ? 'prompts' : 'macros') + '/' + item.id, body);
      } else {
        await gmPost(BACKEND_URL + '/settings/' + (type === 'prompt' ? 'prompts' : 'macros'), body);
      }
      await refreshSettingsTab(container, type);
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:8px 14px;border:1px solid #ddd;border-radius:6px;background:#fff;color:#666;font-size:13px;cursor:pointer;';
    cancelBtn.onclick = () => refreshSettingsTab(container, type);

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    form.appendChild(labelInput);
    form.appendChild(textArea);
    form.appendChild(btnRow);
    container.appendChild(form);
    labelInput.focus();
  }

  async function refreshSettingsTab(container, type) {
    const endpoint = type === 'prompt' ? '/settings/prompts' : '/settings/macros';
    const { ok, data } = await gmGet(BACKEND_URL + endpoint);
    const items = (ok && Array.isArray(data)) ? data : [];
    buildItemList(container, items, type);
  }

  // Initial load
  refreshSettingsTab(promptsBody, 'prompt');
  refreshSettingsTab(macrosBody, 'macro');

  modal.appendChild(header);
  modal.appendChild(varsPanel);
  modal.appendChild(tabs);
  modal.appendChild(promptsBody);
  modal.appendChild(macrosBody);
  document.body.appendChild(modal);
  makeDraggable(modal, header);
}

// ── Macro # trigger ───────────────────────────────────────────────────────────
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

    const { ok, data } = await gmGet(BACKEND_URL + '/settings/macros');
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

function addFindBookingButton() {
  const check = setInterval(() => {
    const container = document.querySelector('.ticket-actions, .page-actions');
    if (container && !document.getElementById('taFindBookingBtn')) {

      // 🔍 Find Booking
      const btn = document.createElement('button');
      btn.id = 'taFindBookingBtn';
      btn.textContent = '🔍 Find Booking';
      btn.style.cssText = 'background:#6f42c1;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:10px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);';
      btn.onclick = () => showBookingSearchModal();

      // 🔄 Pre-warm (batch)
      const prewarmBtn = document.createElement('button');
      prewarmBtn.id = 'taPrewarmBtn';
      prewarmBtn.textContent = '🔄 Pre-warm';
      prewarmBtn.style.cssText = 'background:#17a2b8;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);';
      prewarmBtn.onclick = () => showPrewarmModal();

      // 🎯 Guided prewarm
      const guidedBtn = document.createElement('button');
      guidedBtn.id = 'taGuidedBtn';
      guidedBtn.textContent = '🎯 Guided';
      guidedBtn.style.cssText = 'background:#6f42c1;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);';
      guidedBtn.onclick = () => showGuidedPrewarmModal();

      // 🎯 Guided — open current ticket directly
      const guidedHereBtn = document.createElement('button');
      guidedHereBtn.id = 'taGuidedHereBtn';
      guidedHereBtn.textContent = '🎯 Open Here';
      guidedHereBtn.style.cssText = 'background:#9b59b6;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:4px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);';
      guidedHereBtn.onclick = () => {
        const tid = getFreshdeskTicketId();
        if (!tid) { showToast('No ticket detected on this page.', 'warning'); return; }
        showGuidedPrewarmModal(tid);
      };

      // 📂 View Booking
      const viewBookingBtn = document.createElement('button');
      viewBookingBtn.id = 'taViewBookingBtn';
      viewBookingBtn.textContent = '📂 View Booking';
      viewBookingBtn.style.cssText = 'background:#5a4a8a;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);opacity:0.45;';
      viewBookingBtn.onclick = () => {
        if (!lastViewedBookingId) { showToast('No booking viewed yet this session.', 'info'); return; }
        const freshdeskTicketId = getFreshdeskTicketId();
        showPreviewModal(lastViewedBookingId, bookingCache.get(lastViewedBookingId), freshdeskTicketId);
      };

      // 👤 View User
      const viewUserBtn = document.createElement('button');
      viewUserBtn.id = 'taViewUserBtn';
      viewUserBtn.textContent = '👤 View User';
      viewUserBtn.style.cssText = 'background:#004aaa;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);opacity:0.45;';
      viewUserBtn.onclick = () => {
        if (!lastViewedUserSummary) { showToast('No user viewed yet this session.', 'info'); return; }
        showUserProfileModal(lastViewedUserSummary);
      };

      // 🏨 Bulk Confirm
      const bulkBtn = document.createElement('button');
      bulkBtn.id = 'taBulkBtn';
      bulkBtn.textContent = '🏨 Bulk';
      bulkBtn.style.cssText = 'background:#795548;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);';
      bulkBtn.onclick = () => showBulkConfirmModal();

      // 📋 Check Pendings
      const pendingsBtn = document.createElement('button');
      pendingsBtn.id = 'taPendingsBtn';
      pendingsBtn.textContent = '📋 Pendings';
      pendingsBtn.style.cssText = 'background:#6c757d;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);';
      pendingsBtn.onclick = () => showCheckPendingsModal();

      // 🤖 AI Assist
      const aiBtn = document.createElement('button');
      aiBtn.id = 'taAiBtn';
      aiBtn.textContent = '🤖 AI';
      aiBtn.style.cssText = 'background:#343a40;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);opacity:0.45;';
      aiBtn.onclick = () => showAiModal();

      // 💬 Reply
      const replyBtn = document.createElement('button');
      replyBtn.id = 'taReplyBtn';
      replyBtn.textContent = '💬 Reply';
      replyBtn.style.cssText = 'background:#0056d2;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);opacity:0.45;';
      replyBtn.onclick = () => showReplyModal();

      container.appendChild(btn);
      container.appendChild(prewarmBtn);
      container.appendChild(guidedBtn);
      container.appendChild(guidedHereBtn);
      container.appendChild(viewBookingBtn);
      container.appendChild(viewUserBtn);
      container.appendChild(bulkBtn);
      container.appendChild(pendingsBtn);
      container.appendChild(aiBtn);
      container.appendChild(replyBtn);
      activateViewButton('taAiBtn'); activateViewButton('taReplyBtn');
      clearInterval(check);
    }
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

  gmPost(`${BACKEND_URL}/tag-ticket`, { freshdeskTicketId, tags, type: 'Reservations' })
    .then(({ ok }) => { if (ok) { console.log(`🏷️ Tagged ${freshdeskTicketId}:`, tags); refreshFreshdeskTicket(); } })
    .catch(e => console.warn('⚠️ Tag error:', e.message));
}

// ── Duplicate check ───────────────────────────────────────────────────────────
async function checkDuplicates(booking, user, freshdeskTicketId) {
  try {
    const { ok, data } = await gmPost(`${BACKEND_URL}/check-duplicates`, {
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

// Re-scan on SPA navigation + clear per-ticket cache on ticket change
let _lastTicketId = getFreshdeskTicketId();

function clearTicketCache() {
  bookingCache.clear();
  userCache.clear();
  lastViewedBookingId   = null;
  lastViewedUserId      = null;
  lastViewedUserSummary = null;
  const dim = id => { const b = document.getElementById(id); if (b) b.style.opacity = '0.45'; };
  dim('taViewBookingBtn');
  dim('taViewUserBtn');
  console.log('🗑️ Ticket cache cleared');
}

function checkTicketChange() {
  const currentTicketId = getFreshdeskTicketId();
  if (currentTicketId && currentTicketId !== _lastTicketId && !_suppressCacheClear) {
    _lastTicketId = currentTicketId;
    clearTicketCache();
  }
  setTimeout(injectTicketListBadges, 1500);
}
const _origPushState = history.pushState;
history.pushState = function(...args) {
  _origPushState.apply(this, args);
  checkTicketChange();
};
window.addEventListener('popstate', () => checkTicketChange());

// ── Load booking from cache/server and show preview modal ─────────────────────
async function loadBookingPreview(bookingId, freshdeskTicketId) {
  triggerNewBookingFlow(bookingId, freshdeskTicketId);
}

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

// ── triggerActions: runs note/email actions using already-fetched data ─────────
// ── Short note builder (client-side) ─────────────────────────────────────────
function buildShortNoteHtml(booking, details) {
  const v = (val) => (val !== null && val !== undefined && val !== '' && val !== '-') ? val : '—';
  const tableStyle = 'width:100%;border-collapse:collapse;margin-bottom:12px;font-size:13px;';
  const thStyle    = 'padding:5px 10px;background:#f5f5f5;border:1px solid #ddd;text-align:left;font-weight:600;white-space:nowrap;width:38%;color:#444;';
  const tdStyle    = 'padding:5px 10px;border:1px solid #ddd;color:#222;';
  const productType = (booking.productType || '').toLowerCase();
  const isFlight    = productType.includes('flight');

  const rows = [
    ['Booking ID (TA)',        v(booking.internalBookingId)],
    ['Booking ID (Supplier)', v(booking.supplierId)],
    ['Supplier',              v(booking.supplierName)],
    isFlight
      ? ['Airline', v(details && details.departAirline ? details.departAirline : booking.supplierName)]
      : ['Hotel',   v(details && details.hotelName    ? details.hotelName    : booking.supplierName)],
    !isFlight && booking.mwrRoomType ? ['Room Type', v(booking.mwrRoomType)] : null,
    ['Guest',     v(booking.guestName)],
    ['Check-In',  v(booking.checkIn)],
    ['Check-Out', v(booking.checkOut)],
    isFlight && booking.locationTo  ? ['Destination', v(booking.locationTo)]  : null,
    booking.destinationCity         ? ['City',         v(booking.destinationCity)] : null,
  ].filter(Boolean);

  const tableHtml = '<table style="' + tableStyle + '"><tbody>' +
    rows.map(([label, val]) =>
      '<tr><th style="' + thStyle + '">' + label + '</th><td style="' + tdStyle + '">' + val + '</td></tr>'
    ).join('') + '</tbody></table>';

  return '<div style="font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#222;max-width:900px;">' +
    '<h4 style="margin:0 0 10px;font-size:14px;color:#1a1a1a;border-bottom:2px solid #17a2b8;padding-bottom:4px;">📌 ' +
    v(booking.productType) + ' — #' + v(booking.internalBookingId) + '</h4>' +
    tableHtml + '</div>';
}

async function triggerActions(bookingId, freshdeskTicketId, serverData, mode) {
  const doNote  = mode === 'full' || mode === 'note';
  const doEmail = mode === 'full' || mode === 'email';
  const { noteHtml, booking, details, hotelName, productType } = serverData;

  // ── Short note (booking info only, no confirmation modal) ─────────────────
  if (mode === 'short_note') {
    showLoader('📌 Posting short note...');
    const shortHtml = buildShortNoteHtml(booking, details);
    const { ok, data: result } = await gmPost(`${BACKEND_URL}/post-note`, { freshdeskTicketId, noteHtml: shortHtml });
    hideLoader();
    if (!ok) showToast(`❌ Failed to post note: ${result?.error || 'Server error'}`, 'error');
    else { showToast('📌 Short note posted!'); refreshFreshdeskTicket(); }
    return;
  }

  // ── Post note ─────────────────────────────────────────────────────────────
  const postNote = () => new Promise((resolve) => {
    if (!doNote) return resolve(true);
    showConfirmModal(
      '📋 Post note to ticket?',
      [
        `<strong>${productType}</strong> — ${booking.guestName || booking.primaryMember}`,
        `📅 ${booking.checkIn || ''} → ${booking.checkOut || ''}`,
        `🏢 ${booking.supplierName || ''}`,
      ],
      'Post Note',
      async () => {
        showLoader('📝 Posting note...');
        const { ok: noteOk, data: noteResult } = await gmPost(`${BACKEND_URL}/post-note`, { freshdeskTicketId, noteHtml });
        hideLoader();
        if (!noteOk) { showToast(`❌ Failed to post note: ${noteResult?.error || 'Server error'}`, 'error'); resolve(false); }
        else { autoTagTicket(freshdeskTicketId, booking); showToast('✅ Note posted!'); refreshFreshdeskTicket(); resolve(true); }
      },
      () => resolve(false)
    );
  });

  const notePosted = await postNote();
  if (!doEmail) return;

  // ── Hotel email flow ───────────────────────────────────────────────────────
  if (productType?.toLowerCase() !== 'hotel') {
    if (notePosted) showToast('✅ Done!');
    return;
  }

  showLoader('🔍 Searching hotel email...');
  const { ok: emailOk, data: emailData } = await gmPost(`${BACKEND_URL}/find-hotel-email`, {
    hotelName:    hotelName || booking.supplierName,
    hotelAddress: booking.locationTo,
    hotelCountry: booking.destinationCountry,
  });
  hideLoader();

  if (!emailOk) { showToast(`⚠️ Hotel email search failed: ${emailData.error}`, 'error'); return; }

  const { email, source, confidence, notes } = emailData;

  if (!email) {
    showToast('⚠️ No hotel email found — send manually from the ticket.', 'warning', 6000);
    return;
  }

  const confidenceColor = confidence === 'high' ? '#28a745' : confidence === 'medium' ? '#fd7e14' : '#dc3545';
  const emailLines = [
    `<strong>Email:</strong> <a href="mailto:${email}" style="color:#007bff;">${email}</a>`,
    `<strong>Source:</strong> ${source || 'N/A'}`,
    `<strong>Confidence:</strong> <span style="color:${confidenceColor};font-weight:600;">${confidence}</span>`,
    notes ? `<strong>Notes:</strong> ${notes}` : null,
    confidence === 'low' ? `<div style="color:#dc3545;margin-top:6px;">⚠️ Low confidence — please verify before sending.</div>` : null,
  ].filter(Boolean);

  showConfirmModal('✉️ Send Hotel Email?', emailLines, 'Send Email', async () => {
    const groqNoteHtml = `<p><strong>🤖 Hotel Email Flow</strong></p><p><strong>Email sent to:</strong> ${email}<br><strong>Source:</strong> ${source || 'N/A'}<br><strong>Confidence:</strong> ${confidence}${notes ? `<br><strong>Notes:</strong> ${notes}` : ''}</p>`;
    gmPost(`${BACKEND_URL}/post-note`, { freshdeskTicketId, noteHtml: groqNoteHtml })
      .catch(e => console.warn('⚠️ Groq note post error:', e.message));

    showLoader('✉️ Sending email to hotel...');
    const { ok: sendOk, data: sendResult } = await gmPost(`${BACKEND_URL}/send-hotel-email`, {
      freshdeskTicketId, hotelEmail: email, booking, details,
    });
    hideLoader();

    if (!sendOk) { showToast(`❌ Email send failed: ${sendResult.error}`, 'error'); return; }
    autoTagTicket(freshdeskTicketId, booking);
    showToast(`✅ Email sent to ${email} — ticket set to Pending.`); refreshFreshdeskTicket();
  }, () => {
    showToast('Email not sent. You can send manually from the ticket.', 'info');
  }, '#28a745');
}

// ── triggerNewBookingFlow — server-side only, with frontend cache ──────────────
async function triggerNewBookingFlow(bookingId, freshdeskTicketId) {
  try {
    // Check frontend cache first
    if (bookingCache.has(bookingId)) {
      console.log(`⚡ Frontend cache hit: ${bookingId}`);
      lastViewedBookingId = bookingId;
      activateViewButton('taViewBookingBtn');
      activateViewButton('taAiBtn'); activateViewButton('taReplyBtn');
      const cached = bookingCache.get(bookingId);
      showPreviewModal(bookingId, cached, freshdeskTicketId);
      return;
    }

    showLoader('📦 Loading booking...');
    const { ok, data } = await gmGet(`${BACKEND_URL}/booking/${bookingId}`);
    hideLoader();

    if (!ok) {
      showToast(`❌ ${data?.error || 'Booking not found'}`, 'error');
      return;
    }

    const duplicates = await checkDuplicates(data.booking, data.user, freshdeskTicketId);
    duplicates.forEach(t => markDuplicate(t.id));

    const fullData = { ...data, duplicates };

    // Store in frontend cache
    bookingCache.set(bookingId, fullData);
    lastViewedBookingId = bookingId;
    activateViewButton('taViewBookingBtn');
    activateViewButton('taAiBtn'); activateViewButton('taReplyBtn');
    console.log(`💾 Cached in frontend: ${bookingId}`);

    showPreviewModal(bookingId, fullData, freshdeskTicketId);

  } catch (err) {
    hideLoader();
    console.error('❌ triggerNewBookingFlow error:', err);
    showToast(`❌ ${err.message || 'Unexpected error — check console.'}`, 'error');
  }
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



addFindBookingButton();
addFindUserButton();
})();