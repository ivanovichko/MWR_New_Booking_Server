const fetch = require('node-fetch');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Builds a context string from booking + user + supplier data.
 */
function buildContext(booking, user, supplier) {
  const lines = [
    '=== BOOKING ===',
    booking.productType   ? `Type: ${booking.productType}`                : null,
    booking.internalBookingId ? `Booking ID (TA): ${booking.internalBookingId}` : null,
    booking.supplierId    ? `Booking ID (Supplier): ${booking.supplierId}` : null,
    booking.bookingStatus ? `Status: ${booking.bookingStatus}`            : null,
    booking.bookingDate   ? `Booked: ${booking.bookingDate}`              : null,
    booking.checkIn       ? `Check-in: ${booking.checkIn}`                : null,
    booking.checkOut      ? `Check-out: ${booking.checkOut}`              : null,
    booking.supplierName  ? `Supplier: ${booking.supplierName}`           : null,
    booking.mwrRoomType   ? `Room Type: ${booking.mwrRoomType}`           : null,
    booking.guestName     ? `Guest: ${booking.guestName}`                 : null,
    booking.destinationCountry ? `Country: ${booking.destinationCountry}` : null,
    booking.destinationCity    ? `City: ${booking.destinationCity}`       : null,
    supplier?.email       ? `Supplier Email: ${supplier.email}`           : null,

    user ? '\n=== MEMBER ===' : null,
    user?.fullName    ? `Name: ${user.fullName}`       : null,
    user?.email       ? `Email: ${user.email}`         : null,
    user?.phone       ? `Phone: ${user.phone}`         : null,
    user?.instance    ? `Instance: ${user.instance}`   : null,
    user?.status      ? `Status: ${user.status}`       : null,
    user?.country     ? `Country: ${user.country}`     : null,
    user?.city        ? `City: ${user.city}`           : null,
  ].filter(Boolean);

  return lines.join('\n');
}

/**
 * Calls Groq with a system context + user prompt.
 * Returns the generated text string.
 */
async function aiAssist({ booking, user, supplier, prompt }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const context = buildContext(booking, user, supplier);

  const systemPrompt = `You are a travel support assistant at MWR TravelAdvantage. 
You have the following booking and member information available:

${context}

Use this data to help the agent. Be concise, professional, and ready to use.
Do not include placeholders — use the actual data provided.
Write in English unless instructed otherwise.`;

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: prompt },
        ],
        temperature: 0.4,
        max_tokens: 1000,
      }),
    });

    if (response.status === 429) {
      if (attempt === MAX_RETRIES) throw new Error('Groq rate limit hit — try again in a minute.');
      await sleep(attempt * 10000);
      continue;
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Groq API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Groq returned empty response');
    return text.trim();
  }
}

module.exports = { aiAssist };
