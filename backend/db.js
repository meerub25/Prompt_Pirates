const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function waitForDb() {
  for (let i = 0; i < 60; i++) {
    try { await pool.query('SELECT 1'); return; }
    catch (e) { await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error('database not reachable');
}
module.exports = { pool, waitForDb };
