const { Pool } = require('pg');
require('dotenv').config();

const { DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_NAME } = process.env;

if (!DB_USER || !DB_PASSWORD || !DB_HOST || !DB_PORT || !DB_NAME) {
  console.error('CRITICAL: One or more DB_* environment variables are missing!');
  process.exit(1);
}

const pool = new Pool({
  user:     DB_USER,
  password: DB_PASSWORD,
  host:     DB_HOST,
  port:     Number(DB_PORT),
  database: DB_NAME,
  ssl:      { rejectUnauthorized: false },
  // Force IPv4 — avoids ETIMEDOUT when DNS resolves to an unreachable IPv6 address
  connectionTimeoutMillis: 10000,
  options:  "-c TimeZone=UTC"
});

// Monkey-patch pg to prefer IPv4
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

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