const fetch = require('node-fetch');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Builds a context string from booking + user + supplier data.
 */
function buildContext(booking, details, user, supplier, ticketContext) {
  const lines = [
    '=== BOOKING ===',
    booking.productType       ? `Type: ${booking.productType}`                     : null,
    booking.internalBookingId ? `Booking ID (TA): ${booking.internalBookingId}`    : null,
    booking.supplierId        ? `Booking ID (Supplier): ${booking.supplierId}`      : null,
    booking.bookingStatus     ? `Status: ${booking.bookingStatus}`                  : null,
    booking.bookingDate       ? `Booked: ${booking.bookingDate}`                    : null,
    booking.checkIn           ? `Check-in: ${booking.checkIn}`                      : null,
    booking.checkOut          ? `Check-out: ${booking.checkOut}`                    : null,
    booking.mwrRoomType       ? `Room Type: ${booking.mwrRoomType}`                 : null,
    booking.guestName         ? `Guest: ${booking.guestName}`                       : null,
    booking.destinationCountry ? `Country: ${booking.destinationCountry}`           : null,
    booking.destinationCity    ? `City: ${booking.destinationCity}`                 : null,

    '\n=== HOTEL ===',
    details && details.hotelName    ? `Hotel Name: ${details.hotelName}`       : (booking.supplierName ? `Hotel Name: ${booking.supplierName}` : null),
    details && details.hotelAddress ? `Hotel Address: ${details.hotelAddress}` : null,
    details && details.hotelPhone   ? `Hotel Phone: ${details.hotelPhone}`     : null,
    supplier && supplier.email      ? `Hotel/Supplier Email: ${supplier.email}` : null,
    supplier && supplier.name       ? `Supplier: ${supplier.name}`              : (booking.supplierName ? `Supplier: ${booking.supplierName}` : null),

    user ? '\n=== MEMBER ===' : null,
    user && user.fullName    ? `Name: ${user.fullName}`       : null,
    user && user.email       ? `Email: ${user.email}`         : null,
    user && user.phone       ? `Phone: ${user.phone}`         : null,
    user && user.instance    ? `Instance: ${user.instance}`   : null,
    user && user.status      ? `Status: ${user.status}`       : null,
    user && user.country     ? `Country: ${user.country}`     : null,
    user && user.city        ? `City: ${user.city}`           : null,

    ticketContext ? '\n=== TICKET ===' : null,
    ticketContext && ticketContext.subject     ? `Subject: ${ticketContext.subject}`     : null,
    ticketContext && ticketContext.description ? `Description: ${ticketContext.description.slice(0, 800)}` : null,
  ].filter(Boolean);


  // Append conversation history
  if (ticketContext && ticketContext.conversations && ticketContext.conversations.length) {
    const convLines = ['\n=== CONVERSATION ==='];
    ticketContext.conversations.forEach(c => {
      convLines.push(`[${c.type.toUpperCase()}] ${c.from ? c.from + ': ' : ''}${c.body.slice(0, 400)}`);
    });
    return lines.join('\n') + '\n' + convLines.join('\n');
  }
  return lines.join('\n');
}

/**
 * Calls Groq with a system context + user prompt.
 * Returns the generated text string.
 */
async function aiAssist({ booking, details, user, supplier, ticketContext, prompt }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const context = buildContext(booking, details, user, supplier, ticketContext);

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

/**
 * Finds a hotel's contact email using Groq compound-beta-mini (web search enabled).
 * Returns { email, source, confidence, notes }
 */
async function findHotelEmail(hotelName, hotelAddress, hotelCountry) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const prompt = `Find the reservations or contact email address for this specific hotel:

Hotel name: ${hotelName}
${hotelAddress ? `Address: ${hotelAddress}` : ''}
${hotelCountry ? `Country: ${hotelCountry}` : ''}

Search for this hotel's official contact email. Prefer reservations@ or info@ addresses from the hotel's own website.
Only return a real verified email — do NOT guess or invent one.

Return ONLY a JSON object, no markdown:
{
  "email": "the email address or null",
  "source": "URL or description of where found, or null",
  "confidence": "high or medium or low",
  "notes": "anything relevant"
}`;

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'compound-beta-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 300,
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
    const rawText = data?.choices?.[0]?.message?.content || '';
    const cleaned = rawText.replace(/```json|```/g, '').trim();

    try {
      return JSON.parse(cleaned);
    } catch {
      console.error('Groq returned non-JSON:', rawText);
      return { email: null, source: null, confidence: 'low', notes: `Could not parse: ${rawText.slice(0, 200)}` };
    }
  }
}

module.exports = { aiAssist, findHotelEmail };
