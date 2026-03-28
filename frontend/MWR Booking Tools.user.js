// ==UserScript==
// @name         MWR Booking Tools
// @namespace    https://traveladvantage.com
// @version      2.0
// @description  Find booking data from Freshdesk — notes, email, tagging, duplicate detection
// @match        https://*.freshdesk.com/*
// @grant        GM_xmlhttpRequest
// @connect      mwr-new-booking-server.onrender.com
// @connect      mwrlife.freshdesk.com
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

// ── Prewarm progress modal ────────────────────────────────────────────────────
function showPrewarmModal() {
  document.getElementById('taPrewarmModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'taPrewarmModal';
  modal.style.cssText = 'position:fixed;bottom:24px;left:24px;width:440px;background:#fff;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,0.25);z-index:999999;font-family:system-ui,sans-serif;';
  modal.innerHTML = `
    <div id="taPrewarmHandle" style="padding:12px 16px 10px;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-weight:600;font-size:13px;">🔄 Pre-warming bookings...</span>
      <button id="taPrewarmClose" style="background:none;border:none;font-size:18px;color:#aaa;cursor:pointer;" disabled>×</button>
    </div>
    <div id="taPrewarmLog" style="max-height:280px;overflow-y:auto;font-size:12px;font-family:monospace;background:#f8f8f8;padding:10px 12px;line-height:1.8;border-radius:0 0 10px 10px;"></div>`;
  document.body.appendChild(modal);
  makeDraggable(modal, document.getElementById('taPrewarmHandle'));

  const log      = document.getElementById('taPrewarmLog');
  const closeBtn = document.getElementById('taPrewarmClose');
  closeBtn.onclick = () => modal.remove();

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
  activateViewButton('taAiBtn');

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

  // Message Supplier button
  const supplierEmail = (data.supplier && data.supplier.email) || null;
  if (hasBooking && supplierEmail) {
    const msgSupplierBtn = document.createElement('button');
    msgSupplierBtn.textContent = '↗ Message Supplier';
    msgSupplierBtn.style.cssText = 'padding:5px 11px;border:1px solid #28a745;border-radius:16px;background:#fff;color:#28a745;font-size:12px;cursor:pointer;font-weight:500;';
    msgSupplierBtn.onmouseover = () => { msgSupplierBtn.style.background = '#28a745'; msgSupplierBtn.style.color = '#fff'; msgSupplierBtn.title = supplierEmail; };
    msgSupplierBtn.onmouseout  = () => { msgSupplierBtn.style.background = '#fff';    msgSupplierBtn.style.color = '#28a745'; };
    msgSupplierBtn.onclick = () => showReplyComposer('supplier', supplierEmail, booking, details, user, supplier, outputArea, actionsArea);
    promptBar.appendChild(msgSupplierBtn);
  }

  // Message Customer button
  const customerEmail = (user && user.email) || null;
  if (customerEmail) {
    const msgCustomerBtn = document.createElement('button');
    msgCustomerBtn.textContent = '↙ Message Customer';
    msgCustomerBtn.style.cssText = 'padding:5px 11px;border:1px solid #007bff;border-radius:16px;background:#fff;color:#007bff;font-size:12px;cursor:pointer;font-weight:500;';
    msgCustomerBtn.onmouseover = () => { msgCustomerBtn.style.background = '#007bff'; msgCustomerBtn.style.color = '#fff'; msgCustomerBtn.title = customerEmail; };
    msgCustomerBtn.onmouseout  = () => { msgCustomerBtn.style.background = '#fff';    msgCustomerBtn.style.color = '#007bff'; };
    msgCustomerBtn.onclick = () => showReplyComposer('customer', customerEmail, booking, details, user, supplier, outputArea, actionsArea);
    promptBar.appendChild(msgCustomerBtn);
  }

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
  modal.appendChild(inputArea);
  modal.appendChild(outputArea);
  modal.appendChild(actionsArea);
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

  outputArea.textContent = data.text;

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
    activateViewButton('taAiBtn');
    outputArea.textContent = '✅ Booking #' + bookingId + ' loaded — ' + (bData.booking.productType || '') + ' · ' + (bData.booking.guestName || '') + ' · ' + (bData.booking.checkIn || '') + ' → ' + (bData.booking.checkOut || '');
  } else {
    outputArea.textContent = '✅ Booking ID extracted: ' + bookingId + ' (server cached, reload preview to view)';
  }
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
function showReplyComposer(recipientType, toEmail, booking, details, user, supplier, outputArea, actionsArea) {
  const label = recipientType === 'supplier' ? 'Supplier' : 'Customer';

  outputArea.innerHTML = '';
  actionsArea.innerHTML = '';
  actionsArea.style.display = 'none';

  // Header info
  const info = document.createElement('div');
  info.style.cssText = 'font-size:12px;color:var(--color-text-secondary, #666);margin-bottom:8px;';
  info.innerHTML = '<strong>To:</strong> ' + toEmail;
  outputArea.appendChild(info);

  // Editable reply textarea — pre-populated with greeting + signature
  const replyArea = document.createElement('textarea');
  replyArea.style.cssText = 'width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;font-family:system-ui,sans-serif;resize:vertical;min-height:200px;line-height:1.5;outline:none;';
  replyArea.value = buildReplySignature(recipientType, booking, details, user);
  // Note: replyArea is appended inside the two-col layout below (customer) or directly (supplier)
  attachMacroTrigger(replyArea, booking, details, user);
  // Place cursor at the [your message here] placeholder
  setTimeout(() => {
    const pos = replyArea.value.indexOf('[your message here]');
    if (pos !== -1) {
      replyArea.focus();
      replyArea.setSelectionRange(pos, pos + '[your message here]'.length);
    }
  }, 50);

  // Translation panel — only for customer replies
  if (recipientType === 'customer') {
    const targetLang = countryToLanguage(user && user.country);

    // Wrap both textareas in a flex row
    const twoCol = document.createElement('div');
    twoCol.style.cssText = 'display:flex;gap:8px;margin-top:8px;';

    // Move replyArea into left column
    const leftCol = document.createElement('div');
    leftCol.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:6px;';
    replyArea.style.marginTop = '0';
    replyArea.style.minHeight = '160px';
    leftCol.appendChild(replyArea);

    // Right column — translate button + read-only output
    const rightCol = document.createElement('div');
    rightCol.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:6px;';

    const translateBtn = document.createElement('button');
    translateBtn.textContent = '🌐 ' + (targetLang ? 'Translate to ' + targetLang : 'Translate');
    translateBtn.style.cssText = 'padding:5px 12px;border:1px solid #17a2b8;border-radius:6px;background:#fff;color:#17a2b8;font-size:12px;cursor:pointer;font-weight:500;align-self:flex-start;';

    const translationArea = document.createElement('textarea');
    translationArea.readOnly = true;
    translationArea.placeholder = (targetLang ? targetLang : 'Translation') + ' will appear here...';
    translationArea.style.cssText = 'flex:1;width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #17a2b8;border-radius:6px;font-size:13px;font-family:system-ui,sans-serif;resize:none;min-height:160px;line-height:1.5;background:#f8fffe;color:#333;';

    translateBtn.onclick = async () => {
      const body = replyArea.value.trim();
      if (!body) { showToast('Nothing to translate.', 'warning'); return; }
      const lang = targetLang || 'the customer\'s language';
      const prompt = 'Translate the following text to ' + lang + '. Translate everything including greetings and sign-offs. Return only the translated text — no explanation, no extra content.\n\n' + body;
      translateBtn.disabled = true; translateBtn.textContent = '⏳ Translating...';
      translationArea.value = 'Translating...';
      const { ok, data: aiData } = await gmPost(BACKEND_URL + '/ai-assist', {
        booking: booking || {}, details: details || {}, user, supplier: supplier || null,
        freshdeskTicketId: getFreshdeskTicketId(), prompt,
      });
      translateBtn.disabled = false;
      translateBtn.textContent = '🌐 ' + (targetLang ? 'Translate to ' + targetLang : 'Translate');
      translationArea.value = (ok && aiData.text) ? aiData.text.trim() : 'Translation failed.';
    };

    rightCol.appendChild(translateBtn);
    rightCol.appendChild(translationArea);
    twoCol.appendChild(leftCol);
    twoCol.appendChild(rightCol);
    outputArea.appendChild(twoCol);
  } else {
    outputArea.appendChild(replyArea);
  }

  // Send + cancel actions
  actionsArea.style.display = 'flex';

  const sendBtn = document.createElement('button');
  sendBtn.textContent = '📤 Send to ' + label;
  sendBtn.style.cssText = 'padding:7px 14px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;background:#28a745;color:#fff;';
  sendBtn.onclick = async () => {
    const body = replyArea.value.trim();
    if (!body) { showToast('Message is empty.', 'warning'); return; }
    const tid = getFreshdeskTicketId();
    if (!tid) { showToast('No ticket detected.', 'error'); return; }
    sendBtn.disabled = true; sendBtn.textContent = 'Sending...';
    const noteHtml = '<p>' + body.replace(/\n/g, '<br>') + '</p>';
    const { ok } = await gmPost(BACKEND_URL + '/send-reply', { freshdeskTicketId: tid, toEmail, bodyHtml: noteHtml });
    if (ok) { sendBtn.textContent = '✅ Sent!'; showToast('Reply sent to ' + label + '.'); refreshFreshdeskTicket(); }
    else    { sendBtn.textContent = '❌ Failed'; sendBtn.disabled = false; }
  };

  const copyBtn = document.createElement('button');
  copyBtn.textContent = '📋 Copy';
  copyBtn.style.cssText = 'padding:7px 14px;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;background:#fff;color:#555;';
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(replyArea.value).then(() => { copyBtn.textContent = '✅ Copied!'; setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000); });
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
function attachMacroTrigger(textarea, booking, details, user) {
  let macroQuery = null;
  let dropdown = null;

  const dismissDropdown = () => {
    dropdown?.remove();
    dropdown = null;
    macroQuery = null;
  };

  textarea.addEventListener('keyup', async (e) => {
    const val = textarea.value;
    const pos = textarea.selectionStart;
    const before = val.slice(0, pos);
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

    // Position above textarea
    const rect = textarea.getBoundingClientRect();
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
        const substituted = substituteVars(m.text, booking, details, user);
        const cur = textarea.value;
        const curPos = textarea.selectionStart;
        const hashPos = cur.slice(0, curPos).lastIndexOf('#');
        textarea.value = cur.slice(0, hashPos) + substituted + cur.slice(curPos);
        textarea.selectionStart = textarea.selectionEnd = hashPos + substituted.length;
        dismissDropdown();
        textarea.focus();
      };
      dropdown.appendChild(item);
    });

    document.body.appendChild(dropdown);
  });

  textarea.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismissDropdown(); });
  textarea.addEventListener('blur', () => setTimeout(dismissDropdown, 150));
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

      // 🔄 Pre-warm
      const prewarmBtn = document.createElement('button');
      prewarmBtn.id = 'taPrewarmBtn';
      prewarmBtn.textContent = '🔄 Pre-warm';
      prewarmBtn.style.cssText = 'background:#17a2b8;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);';
      prewarmBtn.onclick = () => showPrewarmModal();

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

      // 🤖 AI Assist
      const aiBtn = document.createElement('button');
      aiBtn.id = 'taAiBtn';
      aiBtn.textContent = '🤖 AI';
      aiBtn.style.cssText = 'background:#343a40;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);opacity:0.45;';
      aiBtn.onclick = () => showAiModal();

      container.appendChild(btn);
      container.appendChild(prewarmBtn);
      container.appendChild(viewBookingBtn);
      container.appendChild(viewUserBtn);
      container.appendChild(aiBtn);
      activateViewButton('taAiBtn');
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
async function triggerActions(bookingId, freshdeskTicketId, serverData, mode) {
  const doNote  = mode === 'full' || mode === 'note';
  const doEmail = mode === 'full' || mode === 'email';
  const { noteHtml, booking, details, hotelName, productType } = serverData;

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
      activateViewButton('taAiBtn');
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
    activateViewButton('taAiBtn');
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