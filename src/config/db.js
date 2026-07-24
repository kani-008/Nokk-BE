const dns = require("dns");
// Commented out to allow IPv6-only connection resolution (such as Supabase direct DB URL)
// dns.setDefaultResultOrder("ipv4first");

const { Pool } = require('pg');
require('dotenv').config();

const { DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, DB_NAME, DATABASE_URL } = process.env;

if (!DATABASE_URL && (!DB_USER || !DB_PASSWORD || !DB_HOST || !DB_PORT || !DB_NAME)) {
  console.error('CRITICAL: Set DATABASE_URL or all DB_* environment variables!');
  process.exit(1);
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    })
  : new Pool({
      user:     DB_USER,
      password: DB_PASSWORD,
      host:     DB_HOST,
      port:     Number(DB_PORT),
      database: DB_NAME,
      ssl:      { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    });

pool.query('SELECT NOW()', (err) => {
  if (err) {
    console.error('PostgreSQL pool failed to initialize:', err.message);
  } else {
    console.log('db connected successfully');
  }
});

module.exports = {
  query:     (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};
