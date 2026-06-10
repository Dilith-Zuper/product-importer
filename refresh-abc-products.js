/**
 * Refresh the abc_products materialized view.
 *
 * REQUIRED after every ABC sync or enrich-abc-* run — the wizard reads the
 * materialized view, not abc_items, so until this runs the wizard serves
 * stale data. (The view exists because GROUP BY over 316K abc_items rows
 * blows PostgREST's 8s statement timeout; see abc-materialize-product-view.sql.)
 *
 * Usage: node refresh-abc-products.js
 *
 * Connection: uses SUPABASE_DB_URL from .env if set; otherwise builds the
 * direct connection string from SUPABASE_URL + SUPABASE_DB_PASSWORD. If the
 * direct host fails (IPv6-only on some networks), set SUPABASE_DB_URL to the
 * session-pooler string from the Supabase dashboard (Connect → Session mode).
 */
require('dotenv').config();
const { Client } = require('pg');

const ref = new URL(process.env.SUPABASE_URL).hostname.split('.')[0];
const conn = process.env.SUPABASE_DB_URL
  || `postgresql://postgres:${encodeURIComponent(process.env.SUPABASE_DB_PASSWORD)}@db.${ref}.supabase.co:5432/postgres`;

(async () => {
  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  await client.connect();
  // The pooler session defaults to read-only on this project; it's not a
  // replica (pg_is_in_recovery() = false), so flip it for this session.
  await client.query('SET default_transaction_read_only = off');
  // The refresh re-aggregates 316K rows (~2-3 min) — disable the statement timeout.
  await client.query('SET statement_timeout = 0');
  console.log('Connected. Refreshing abc_products materialized view...');
  const t0 = Date.now();
  await client.query('REFRESH MATERIALIZED VIEW abc_products');
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const { rows } = await client.query('SELECT COUNT(*)::int AS products FROM abc_products');
  console.log(`abc_products now has ${rows[0].products.toLocaleString()} rows`);
  await client.end();
})().catch(e => { console.error('Refresh failed:', e.message); process.exit(1); });
