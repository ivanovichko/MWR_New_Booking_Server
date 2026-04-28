const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const TRANSLATE_CHAT_PROMPT = `You are a multilingual chat transcript cleaner. Produce a clean, English-only version of a customer support chat, followed by a 2-sentence summary.

STRICT RULES:
1. Preserve the exact chronological order of all messages. Do not reorder, skip, or merge messages across different turns.
2. SCOPE: Process only the chat transcript provided. Do not generate, include, or reference any content not present in the input — no email replies, no signatures, no invented messages. Ignore notes.
3. Every message must appear in the output. Do not drop any message.
4. BOT messages repeat the same content in multiple languages separated by " - ". Keep only the English segment verbatim.
5. AGENT messages may appear in pairs — the same message in English then another language (or the reverse). Deduplicate: output only one English version. If the message is in a non-English language only, translate it exactly — do not paraphrase.
6. CUSTOMER messages: translate any non-English text to English exactly — do not paraphrase or add content.
7. If the customer's message appears more than once in identical form, show it only the first time it appears.
8. Never paraphrase, summarize, or add any content not present in the original message.
9. Speaker labels: BOT, CUSTOMER [first name], AGENT [name].

After the transcript, output exactly:
---
SUMMARY: [Two sentences. Sentence 1: what the customer asked. Sentence 2: what the agent did or resolved.]`;

const TRANSLATE_PROMPT = `Translate the following text to {{memberLanguage}}. Translate everything including greetings and sign-offs. Return only the translated text — no explanation, no extra content.

{{replyBody}}`;

// ─── Initialize schema ────────────────────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS freshdesk_sessions (
      id          SERIAL PRIMARY KEY,
      cookie      TEXT NOT NULL,
      csrf_token  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE freshdesk_sessions ADD COLUMN IF NOT EXISTS csrf_token TEXT;

    CREATE TABLE IF NOT EXISTS ta_sessions (
      id          SERIAL PRIMARY KEY,
      cookie      TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS booking_cache (
      booking_id    TEXT PRIMARY KEY,
      data_row      JSONB,
      booking_html  TEXT,
      user_html     TEXT,
      parsed        JSONB,
      fetched_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticket_summaries (
      ticket_id   TEXT PRIMARY KEY,
      booking_id  TEXT,
      summary     TEXT,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_prompts (
      id         SERIAL PRIMARY KEY,
      label      TEXT NOT NULL,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_macros (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      text       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Seed default prompts if table is empty
  const { rows } = await pool.query(`SELECT COUNT(*) FROM agent_prompts`);
  if (parseInt(rows[0].count) === 0) {
    await pool.query(
      `INSERT INTO agent_prompts (label, text) VALUES ($1, $2), ($3, $4)`,
      ['🌐 Translate chat', TRANSLATE_CHAT_PROMPT, '🌐 Translate', TRANSLATE_PROMPT]
    );
    console.log('✅ Seeded default prompts');
  }

  console.log('✅ DB schema ready');
}

// ─── Freshdesk session ────────────────────────────────────────────────────────
async function storeFreshdeskSession(cookie, csrfToken = null) {
  await pool.query(`DELETE FROM freshdesk_sessions`);
  await pool.query(`INSERT INTO freshdesk_sessions (cookie, csrf_token) VALUES ($1, $2)`, [cookie, csrfToken]);
}

async function getFreshdeskSession() {
  const res = await pool.query(`SELECT cookie FROM freshdesk_sessions ORDER BY created_at DESC LIMIT 1`);
  return res.rows[0]?.cookie || null;
}

async function getFreshdeskCsrfToken() {
  const res = await pool.query(`SELECT csrf_token FROM freshdesk_sessions ORDER BY created_at DESC LIMIT 1`);
  return res.rows[0]?.csrf_token || null;
}

// ─── Session ──────────────────────────────────────────────────────────────────
async function storeSession(cookie) {
  await pool.query(`DELETE FROM ta_sessions`);
  await pool.query(`INSERT INTO ta_sessions (cookie) VALUES ($1)`, [cookie]);
}

async function getSession() {
  const res = await pool.query(`SELECT cookie FROM ta_sessions ORDER BY created_at DESC LIMIT 1`);
  return res.rows[0]?.cookie || null;
}

// ─── Booking cache ────────────────────────────────────────────────────────────
async function cacheBooking({ bookingId, dataRow, bookingHtml, userHtml, parsed }) {
  await pool.query(`
    INSERT INTO booking_cache (booking_id, data_row, booking_html, user_html, parsed, fetched_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (booking_id) DO UPDATE
      SET data_row = $2, booking_html = $3, user_html = $4, parsed = $5, fetched_at = NOW()
  `, [bookingId, JSON.stringify(dataRow), bookingHtml, userHtml, JSON.stringify(parsed)]);
}

async function getCachedBooking(bookingId) {
  const res = await pool.query(
    `SELECT * FROM booking_cache WHERE booking_id = $1`,
    [bookingId]
  );
  return res.rows[0] || null;
}

// ─── Ticket summaries ─────────────────────────────────────────────────────────
async function storeTicketSummary({ ticketId, bookingId, summary }) {
  await pool.query(`
    INSERT INTO ticket_summaries (ticket_id, booking_id, summary, processed_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (ticket_id) DO UPDATE
      SET booking_id = $2, summary = $3, processed_at = NOW()
  `, [ticketId, bookingId, summary]);
}

async function getTicketSummaries() {
  const res = await pool.query(`SELECT * FROM ticket_summaries ORDER BY processed_at DESC`);
  return res.rows;
}

// ─── Agent prompts ────────────────────────────────────────────────────────────
async function getPrompts() {
  const res = await pool.query(`SELECT * FROM agent_prompts ORDER BY created_at ASC`);
  return res.rows;
}
async function createPrompt({ label, text }) {
  const res = await pool.query(`INSERT INTO agent_prompts (label, text) VALUES ($1, $2) RETURNING *`, [label, text]);
  return res.rows[0];
}
async function updatePrompt(id, { label, text }) {
  const res = await pool.query(`UPDATE agent_prompts SET label=$1, text=$2 WHERE id=$3 RETURNING *`, [label, text, id]);
  return res.rows[0];
}
async function deletePrompt(id) {
  await pool.query(`DELETE FROM agent_prompts WHERE id=$1`, [id]);
}

// ─── Agent macros ─────────────────────────────────────────────────────────────
async function getMacros() {
  const res = await pool.query(`SELECT * FROM agent_macros ORDER BY created_at ASC`);
  return res.rows;
}
async function createMacro({ name, text }) {
  const res = await pool.query(`INSERT INTO agent_macros (name, text) VALUES ($1, $2) RETURNING *`, [name, text]);
  return res.rows[0];
}
async function updateMacro(id, { name, text }) {
  const res = await pool.query(`UPDATE agent_macros SET name=$1, text=$2 WHERE id=$3 RETURNING *`, [name, text, id]);
  return res.rows[0];
}
async function deleteMacro(id) {
  await pool.query(`DELETE FROM agent_macros WHERE id=$1`, [id]);
}

module.exports = { initDb, storeSession, getSession, cacheBooking, getCachedBooking, storeTicketSummary, getTicketSummaries, pool, getPrompts, createPrompt, updatePrompt, deletePrompt, getMacros, createMacro, updateMacro, deleteMacro, storeFreshdeskSession, getFreshdeskSession, getFreshdeskCsrfToken };
