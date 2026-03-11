const fetch = require('node-fetch');

const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

/**
 * Uses Gemini with Google Search grounding to find a hotel's contact email.
 * Returns { email, source, confidence, notes } — never guesses.
 */
async function findHotelEmail(hotelName, hotelAddress, hotelCountry) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const prompt = `You are a hotel contact research assistant. Your job is to find a real, deliverable email address for a specific hotel.

Hotel name: ${hotelName}
Hotel address: ${hotelAddress}
Country: ${hotelCountry}

INSTRUCTIONS:
- Search the web for this hotel's official contact email address.
- Only return an email you found at a real, identifiable source (hotel website, booking platform, official directory).
- If you find multiple emails, prefer: reservations@ or info@ over generic contact forms.
- If you cannot find a verified email with a clear source, return null. Do NOT guess or infer an email address.

Return ONLY a JSON object in this exact format, no other text, no markdown:
{
  "email": "reservations@hotelname.com or null",
  "source": "URL or description of where this was found, or null",
  "confidence": "high or medium or low",
  "notes": "anything relevant, e.g. found on Booking.com profile page"
}`;

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ googleSearch: {} }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = await response.json();

  // Extract text from response
  const rawText = data?.candidates?.[0]?.content?.parts
    ?.map(p => p.text || '')
    .join('') || '';

  // Strip any accidental markdown fences
  const cleaned = rawText.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    console.error('Gemini returned non-JSON:', rawText);
    return {
      email: null,
      source: null,
      confidence: 'low',
      notes: `Gemini response could not be parsed: ${rawText.slice(0, 200)}`,
    };
  }
}

module.exports = { findHotelEmail };
