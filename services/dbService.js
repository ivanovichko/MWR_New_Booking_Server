const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── Initialize schema ────────────────────────────────────────────────────────
async function initDb() {
  await pool.query(`
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
  `);
  console.log('✅ DB schema ready');
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

module.exports = { initDb, storeSession, getSession, cacheBooking, getCachedBooking, storeTicketSummary, getTicketSummaries, pool };
