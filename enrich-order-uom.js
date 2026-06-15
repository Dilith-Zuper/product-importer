/**
 * enrich-order-uom.js
 *
 * Problem:
 *   srs_products.product_uom is the raw source array (productUOM). zuper-importer's
 *   toZuperUom() picks product_uom[0] as "the" Zuper UOM, but the first array
 *   element is frequently "PAL" (pallet, a near-universal secondary/bulk unit
 *   listed on almost every variant) rather than the actual order unit — wrong
 *   for ~38% of products (verified 2026-06-15, same class of bug fixed for ABC
 *   in commit 9c1e6a2).
 *
 * Fix:
 *   Populate srs_products.order_uom with the dominant order_uom across that
 *   product's unrestricted srs_variants (mode by frequency). Falls back to
 *   product_uom[0] for products with no variants/order_uom data.
 *
 * Prerequisite:
 *   node apply-srs-order-uom-column.js   (adds the order_uom column + index)
 *
 * Usage:
 *   node enrich-order-uom.js               (apply)
 *   node enrich-order-uom.js --log-changes (apply + write audit log)
 *   node enrich-order-uom.js --dry-run     (print summary, no write)
 *
 * Connection: pg session pooler (SUPABASE_DB_URL) — bulk UPDATE via VALUES
 * lists, since Supabase upsert() goes through INSERT ... ON CONFLICT, which
 * Postgres validates against NOT NULL columns not present in the payload.
 */
require('dotenv').config();
const { Client } = require('pg');
const { makeChangeLogger, changeLogFlag } = require('./lib/utils');

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = 1000;

function modeUom(tally) {
  let best = null;
  let bestCount = -1;
  for (const [uom, count] of tally) {
    if (count > bestCount) { best = uom; bestCount = count; }
  }
  return best;
}

(async () => {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query('SET default_transaction_read_only = off');
  await client.query('SET statement_timeout = 0');

  console.log('Fetching srs_variants...');
  const { rows: variants } = await client.query(
    `SELECT product_id, order_uom FROM srs_variants WHERE is_restricted = false AND order_uom IS NOT NULL`
  );

  console.log('Fetching srs_products...');
  const { rows: products } = await client.query(
    `SELECT product_id, product_uom, order_uom FROM srs_products`
  );

  // Tally order_uom per product from unrestricted variants with a non-null order_uom
  const tallies = new Map(); // product_id -> Map<uom, count>
  for (const v of variants) {
    let t = tallies.get(v.product_id);
    if (!t) { t = new Map(); tallies.set(v.product_id, t); }
    t.set(v.order_uom, (t.get(v.order_uom) ?? 0) + 1);
  }

  const logger = makeChangeLogger({ enabled: changeLogFlag(), scriptName: 'order-uom' });
  const updates = [];
  let fromVariants = 0;
  let fromArrayFallback = 0;

  for (const p of products) {
    const tally = tallies.get(p.product_id);
    let newUom;
    if (tally && tally.size > 0) {
      newUom = modeUom(tally);
      fromVariants++;
    } else {
      const arr = Array.isArray(p.product_uom) ? p.product_uom : [];
      newUom = arr[0] ?? null;
      fromArrayFallback++;
    }
    if (newUom !== p.order_uom) {
      logger.log(p.product_id, 'order_uom', p.order_uom, newUom);
      updates.push({ product_id: p.product_id, order_uom: newUom });
    }
  }

  console.log(`\n${products.length} products total — ${fromVariants} resolved from variant order_uom mode, ${fromArrayFallback} fell back to product_uom[0]`);
  console.log(`${updates.length} products need order_uom set/changed`);

  if (DRY_RUN) {
    console.log('Dry run — no writes.');
    await client.end();
    return;
  }

  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    const values = [];
    const params = [];
    batch.forEach((u, idx) => {
      params.push(u.product_id, u.order_uom);
      values.push(`($${idx * 2 + 1}::int, $${idx * 2 + 2}::text)`);
    });
    await client.query(
      `UPDATE srs_products AS p SET order_uom = v.order_uom
       FROM (VALUES ${values.join(', ')}) AS v(product_id, order_uom)
       WHERE p.product_id = v.product_id`,
      params
    );
    process.stdout.write(`\r  updated ${Math.min(i + BATCH, updates.length)}/${updates.length}`);
  }
  console.log('\nDone.');

  if (changeLogFlag()) {
    const file = await logger.save();
    console.log(`Wrote ${logger.count()} changes to ${file}`);
  }

  await client.end();
})().catch(e => { console.error(e.message); process.exit(1); });
