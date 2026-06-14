const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.error('CRITICAL: DATABASE_URL is not set in environment variables!');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Supabase-hosted Postgres
  }
});

// Verify the connection works on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('PostgreSQL pool failed to initialize:', err.message);
  } else {
    console.log('PostgreSQL pool ready. Server time:', res.rows[0].now);
  }
});

module.exports = {
  // Always call db.query(text, params) — never build SQL with string concatenation.
  // The params array is the only safe way to pass user input into a query.
  query: (text, params) => pool.query(text, params),
  pool
};