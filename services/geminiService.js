const fetch = require('node-fetch');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Uses Groq (llama-3.3-70b) with web search tool to find a hotel's contact email.
 * Returns { email, source, confidence, notes }
 */
async function findHotelEmail(hotelName, hotelAddress, hotelCountry) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const prompt = `You are a hotel contact research assistant. Find a real, deliverable email address for this specific hotel.

Hotel name: ${hotelName}
Hotel address: ${hotelAddress}
Country: ${hotelCountry}

INSTRUCTIONS:
- Search for this hotel's official contact email address.
- Only return an email from a real, identifiable source (hotel website, booking platform, official directory).
- Prefer: reservations@ or info@ over generic contact forms.
- If you cannot find a verified email, return null. Do NOT guess or infer.

Return ONLY a JSON object, no other text, no markdown:
{
  "email": "reservations@hotelname.com or null",
  "source": "URL or description of where this was found, or null",
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
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 300,
      }),
    });

    if (response.status === 429) {
      if (attempt === MAX_RETRIES) {
        throw new Error('Groq rate limit hit after 3 attempts. Try again in a minute.');
      }
      const wait = attempt * 10000;
      console.warn(`⚠️  Groq 429 — retrying in ${wait / 1000}s (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(wait);
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
      return {
        email: null,
        source: null,
        confidence: 'low',
        notes: `Response could not be parsed: ${rawText.slice(0, 200)}`,
      };
    }
  }
}

module.exports = { findHotelEmail };
