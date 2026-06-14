const db = require('./db');

async function runMigrations() {
  try {
    console.log('Checking database table configurations...');
    
    // Add password_hash column if it doesn't exist
    await db.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
    `);
    
    console.log('Database schema check: "password_hash" column verified.');
  } catch (err) {
    console.error('Failed to run database migrations:', err.message);
  }
}

module.exports = runMigrations;
