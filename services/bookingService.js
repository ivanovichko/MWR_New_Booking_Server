const fetch = require('node-fetch');

const TA_BASE_URL = 'https://traveladvantage.com';

/**
 * Fetches the booking detail page and extracts the bookingData JS object.
 * Language-independent: reads from injected JSON, not DOM labels.
 */
async function fetchBookingDetails(bookingId, cookie) {
  const url = `${TA_BASE_URL}/admin/hotels/bookingDetails/${bookingId}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0',
    },
  });

  if (!response.ok) {
    throw new Error(`TA detail page returned ${response.status}`);
  }

  const html = await response.text();

  // Extract the bookingData JSON object injected in the <script> tag
  const match = html.match(/var bookingData = ({.*?});[\s\n]/s);
  if (!match) {
    throw new Error('Could not find bookingData in page. Cookie may be expired.');
  }

  const raw = JSON.parse(match[1]);

  // resource_info and room_info are JSON strings — parse them
  const resourceInfo = JSON.parse(raw.resource_info || '{}');
  const roomInfo = JSON.parse(raw.room_info || '{}');

  return {
    // IDs
    internalBookingId: raw.booking_id,
    vendorConfirmationNumber: raw.api_booking_id,

    // Hotel
    hotelName: resourceInfo.hotel_name || null,
    hotelAddress: resourceInfo.address || null,
    hotelCountry: raw.country || null,
    hotelCity: raw.city || null,

    // Dates
    checkIn: resourceInfo.checkin || null,   // YYYY-MM-DD
    checkOut: resourceInfo.checkout || null, // YYYY-MM-DD

    // Room
    roomType: roomInfo.room_type || null,
    boardCode: roomInfo.board_code || null,   // RO, AI, BB, etc.

    // Guest
    guestName: raw.guest_name || null,
    adults: raw.adult || null,
    children: raw.child || null,

    // Special requests
    specialRequests: roomInfo.acc_request?.trim() || null,
    estimatedArrivalTime: roomInfo.estimated_arrival_time?.trim() || null,
  };
}

module.exports = { fetchBookingDetails };
