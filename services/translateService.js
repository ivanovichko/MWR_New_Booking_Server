// DEPRECATED 2026-09-15 — disconnected, not removed.
// Zoho Desk ships AI out of the box. This module is still complete and still
// imported; the routes that reach it answer 410 while server.js's AI_ENABLED
// is false. Keep it working — flip AI_ENABLED to bring it back.
//
// Translation for the overlay's 🌐 / 🤖 buttons and chat cleanup.
//
// Two providers, in order: Google's free endpoint first (fast, free, good
// enough for short support text), Groq as the fallback. Google quotas per
// client IP and Render's egress IP is shared, so 429s there are routine —
// the fallback is the normal path, not an error path.

const fetch = require('node-fetch');

// Defaults to Groq direct. Set GROQ_API_URL to a proxy endpoint (e.g. a
// Cloudflare Worker) when Groq blocks the host's egress IP with a 403
// "Access denied. Please check your network settings."
const GROQ_API_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Groq call gate ──────────────────────────────────────────────────────────
// Chat cleanup translates a transcript line by line, so calls are gated to keep
// a burst under Groq's rate limit rather than relying on 429 backoff alone.
const MAX_CONCURRENT = Number(process.env.GROQ_MAX_CONCURRENCY || 2);
const MIN_GAP_MS     = Number(process.env.GROQ_MIN_GAP_MS || 350);

let _inFlight = 0;
let _lastCallAt = 0;
const _waiting = [];

async function acquireSlot() {
  if (_inFlight >= MAX_CONCURRENT) {
    await new Promise(resolve => _waiting.push(resolve));
  }
  _inFlight++;
  const gap = MIN_GAP_MS - (Date.now() - _lastCallAt);
  if (gap > 0) await sleep(gap);
  _lastCallAt = Date.now();
}

function releaseSlot() {
  _inFlight--;
  const next = _waiting.shift();
  if (next) next();
}

/**
 * Plain-text translation via Groq. Used as the fallback when Google's
 * free endpoint rate-limits the host IP. Returns the translation only.
 */
async function groqTranslate({ text, target = 'en', source = 'auto' }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');

  const model = process.env.TRANSLATE_MODEL || 'openai/gpt-oss-20b';
  const from = source && source !== 'auto' ? ` from ${source}` : '';
  const systemPrompt = `You are a translation engine. Translate the user's message${from} into ${target}.
Preserve line breaks, names, numbers, codes and booking references exactly.
If the text is already in ${target}, return it unchanged.
Output ONLY the translation — no preamble, no notes, no quotes.`;

  await acquireSlot();
  try {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: text },
          ],
          temperature: 0,
          max_tokens: 8000,
        }),
      });

      if (response.status === 429) {
        if (attempt === MAX_RETRIES) throw new Error('Groq rate limit hit — try again in a minute.');
        await sleep(attempt * 5000);
        continue;
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Groq API error ${response.status}: ${err.slice(0, 200)}`);
      }

      const data = await response.json();
      const out  = data?.choices?.[0]?.message?.content || '';
      if (!out.trim()) throw new Error('Groq returned empty translation');
      return out.trim();
    }
  } finally {
    releaseSlot();
  }
}

// ─── Language names → ISO codes ──────────────────────────────────────────────
// The overlay lets an agent type "Spanish" as readily as "es".
const LANG_NAME_TO_CODE = {
  english:'en', spanish:'es', french:'fr', portuguese:'pt', italian:'it',
  german:'de', russian:'ru', dutch:'nl', arabic:'ar', chinese:'zh-CN',
  japanese:'ja', korean:'ko', polish:'pl', turkish:'tr', hindi:'hi',
  greek:'el', hebrew:'he', romanian:'ro', czech:'cs', swedish:'sv',
  danish:'da', finnish:'fi', norwegian:'no', hungarian:'hu', ukrainian:'uk',
  bulgarian:'bg', vietnamese:'vi', thai:'th', indonesian:'id', malay:'ms',
  filipino:'tl', tagalog:'tl', mongolian:'mn', persian:'fa', farsi:'fa',
  urdu:'ur', bengali:'bn', tamil:'ta', telugu:'te', marathi:'mr',
  croatian:'hr', serbian:'sr', slovak:'sk', slovene:'sl', slovenian:'sl',
  estonian:'et', latvian:'lv', lithuanian:'lt', albanian:'sq',
  catalan:'ca', galician:'gl', basque:'eu', welsh:'cy', irish:'ga',
  swahili:'sw',
};

function normalizeLang(input, fallback = 'en') {
  if (!input) return fallback;
  const t = String(input).trim().toLowerCase();
  if (t === 'auto') return 'auto';
  if (/^[a-z]{2}(-[a-z]{2,4})?$/i.test(t)) return t;
  return LANG_NAME_TO_CODE[t] || fallback;
}

// ─── Google Translate (free public endpoint) ─────────────────────────────────
async function googleTranslate(text, tl, sl) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Google Translate returned ${r.status}`);
  const data = await r.json();
  // The response is an array of segments, each [translated, original, ...].
  // Whitespace/newline segments often have an empty translation but carry the
  // original chunk in seg[1]; falling back to it preserves paragraph breaks.
  const translated = (Array.isArray(data?.[0]) ? data[0] : [])
    .map(seg => seg?.[0] || seg?.[1] || '')
    .join('');
  if (!translated.trim()) throw new Error('Google Translate returned no text');
  return { text: translated, detectedLang: data?.[2] || null, provider: 'google' };
}

/**
 * Translate `text` into `target`. Tries Google, falls back to Groq.
 * Throws only when both providers fail.
 */
async function translate({ text, target = 'en', source = 'auto' }) {
  const tl = normalizeLang(target, 'en');
  const sl = normalizeLang(source, 'auto');
  try {
    return await googleTranslate(text, tl, sl);
  } catch (err) {
    console.warn(`[translate] google failed: ${err.message} — falling back to Groq`);
    const translated = await groqTranslate({ text, target: tl, source: sl });
    return { text: translated, detectedLang: null, provider: 'groq' };
  }
}

module.exports = { translate, normalizeLang };
