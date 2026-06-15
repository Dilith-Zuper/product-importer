/**
 * One-off DDL runner for srs-add-order-uom-column.sql.
 *
 * Usage: node apply-srs-order-uom-column.js
 *
 * Connection: uses SUPABASE_DB_URL from .env (session pooler) — same pattern
 * as refresh-abc-products.js. Pooler session defaults to read-only; flipped
 * for this session only.
 */
require('dotenv').config();
const fs = require('fs');
const { Client } = require('pg');

const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const conn = process.env.SUPABASE_DB_URL
  || `postgresql://postgres:${encodeURIComponent(process.env.SUPABASE_DB_PASSWORD)}@db.${ref}.supabase.co:5432/postgres`;

(async () => {
  const sql = fs.readFileSync('./srs-add-order-uom-column.sql', 'utf8');
  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query('SET default_transaction_read_only = off');
  console.log('Connected. Applying srs-add-order-uom-column.sql...');
  await client.query(sql);
  console.log('Done.');
  await client.end();
})().catch(e => { console.error('Failed:', e.message); process.exit(1); });
