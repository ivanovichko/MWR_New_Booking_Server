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

    -- Ticket ↔ booking link. One ticket resolves to at most one booking (hence
    -- ticket_id as PK), but a booking commonly spans several tickets — the guest
    -- writes again, replies land as new tickets, a supplier thread forks. That
    -- one-to-many side is the duplicate signal: siblings of the same booking_id
    -- are far more reliable than matching on subject text.
    CREATE TABLE IF NOT EXISTS ticket_bookings (
      ticket_id     TEXT PRIMARY KEY,
      booking_id    TEXT NOT NULL,
      helpdesk      TEXT NOT NULL DEFAULT 'zoho',
      ticket_number TEXT,
      subject       TEXT,
      status        TEXT,
      linked_by     TEXT,
      source        TEXT NOT NULL DEFAULT 'auto',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_bookings_booking_id ON ticket_bookings (booking_id);
  `);

  console.log('[db] schema ready');
}

// Retired with Freshdesk (session 22): freshdesk_sessions, zoho_sessions,
// ticket_summaries, agent_prompts, agent_macros. They are no longer created,
// but any that already exist are left alone — dropping them is a separate,
// deliberate migration, not a side effect of a code cleanup.

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

// ─── Ticket ↔ booking link ────────────────────────────────────────────────────
// Written whenever the overlay establishes a booking for a ticket, whether by
// extraction (source 'auto') or by an agent picking one (source 'manual'). A
// re-link overwrites rather than accumulating, so the row always reflects the
// booking currently shown in the panel.
async function linkTicketBooking({ ticketId, bookingId, helpdesk = 'zoho', ticketNumber = null, subject = null, status = null, linkedBy = null, source = 'auto' }) {
  const res = await pool.query(`
    INSERT INTO ticket_bookings (ticket_id, booking_id, helpdesk, ticket_number, subject, status, linked_by, source, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (ticket_id) DO UPDATE
      SET booking_id = $2, helpdesk = $3, ticket_number = $4, subject = $5,
          status = $6, linked_by = COALESCE($7, ticket_bookings.linked_by),
          source = $8, updated_at = NOW()
    RETURNING *
  `, [String(ticketId), String(bookingId), helpdesk, ticketNumber, subject, status, linkedBy, source]);
  return res.rows[0];
}

async function getTicketBooking(ticketId) {
  const res = await pool.query(`SELECT * FROM ticket_bookings WHERE ticket_id = $1`, [String(ticketId)]);
  return res.rows[0] || null;
}

// The duplicate query: every other ticket already linked to this booking.
async function getTicketsForBooking(bookingId, excludeTicketId = null) {
  const res = await pool.query(`
    SELECT * FROM ticket_bookings
    WHERE booking_id = $1 AND ($2::text IS NULL OR ticket_id <> $2)
    ORDER BY updated_at DESC
  `, [String(bookingId), excludeTicketId ? String(excludeTicketId) : null]);
  return res.rows;
}

async function unlinkTicket(ticketId) {
  await pool.query(`DELETE FROM ticket_bookings WHERE ticket_id = $1`, [String(ticketId)]);
}

module.exports = {
  initDb, pool,
  storeSession, getSession,
  cacheBooking, getCachedBooking,
  linkTicketBooking, getTicketBooking, getTicketsForBooking, unlinkTicket,
};
