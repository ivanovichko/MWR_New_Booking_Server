// ============================================================
// USERSCRIPT PATCH — replace addNewBookingButton() in your
// existing TA_Booking_Lookup script with this version.
// ============================================================

// ── CONFIG ───────────────────────────────────────────────────
const BACKEND_URL = 'http://localhost:3000'; // Change to your Railway/Render URL in prod
// ─────────────────────────────────────────────────────────────

function getFreshdeskTicketId() {
  // Freshdesk ticket URLs look like: /helpdesk/tickets/12345
  const match = window.location.pathname.match(/\/tickets\/(\d+)/);
  return match ? match[1] : null;
}

function addNewBookingButton() {
  const check = setInterval(() => {
    const container = document.querySelector('.ticket-actions, .page-actions');
    if (container && !document.getElementById('taNewBookingBtn')) {
      const btn = document.createElement('button');
      btn.id = 'taNewBookingBtn';
      btn.textContent = '📦 New Booking';
      btn.style.cssText =
        'background:#6f42c1;color:white;border:none;padding:8px 14px;border-radius:6px;margin-left:10px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.2);';

      btn.onclick = () => {
        const bookingId = prompt('Enter TravelAdvantage Booking ID:');
        if (!bookingId) return;

        const freshdeskTicketId = getFreshdeskTicketId();
        if (!freshdeskTicketId) {
          alert('Could not detect Freshdesk ticket ID from URL. Are you on a ticket page?');
          return;
        }

        const cookie = getCurrentTaCookie(); // already defined in existing script
        if (cookie.includes('__PLACEHOLDER__')) {
          alert('TravelAdvantage cookie not found. Make sure you are logged in.');
          return;
        }

        triggerNewBookingFlow(bookingId.trim(), cookie, freshdeskTicketId);
      };

      const pageScanBtn = document.getElementById('taPageScanBtn');
      if (pageScanBtn) {
        pageScanBtn.parentNode.insertBefore(btn, pageScanBtn.nextSibling);
      } else {
        container.appendChild(btn);
      }
      clearInterval(check);
    }
  }, 1000);
}

async function triggerNewBookingFlow(bookingId, cookie, freshdeskTicketId) {
  showLoader('📦 Running new booking flow...');

  try {
    const response = await fetch(`${BACKEND_URL}/new-booking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId, cookie, freshdeskTicketId }),
    });

    const result = await response.json();
    hideLoader();

    if (!response.ok) {
      alert(`❌ Error: ${result.error}`);
      return;
    }

    // Success — show summary to agent
    const lines = [
      `✅ New booking flow complete!`,
      ``,
      `🏨 Hotel: ${result.hotelName}`,
      `📧 Email: ${result.hotelEmail || 'Not found'}`,
      `🔍 Source: ${result.emailSource || 'N/A'}`,
      `📊 Confidence: ${result.emailConfidence}`,
      ``,
      result.emailSent
        ? `✉️  Email sent to hotel & ticket set to Pending.`
        : `⚠️  ${result.warning}`,
    ];

    alert(lines.join('\n'));

  } catch (err) {
    hideLoader();
    console.error('❌ New booking flow error:', err);
    alert(`❌ Could not reach backend server.\n\nMake sure the server is running at:\n${BACKEND_URL}`);
  }
}
