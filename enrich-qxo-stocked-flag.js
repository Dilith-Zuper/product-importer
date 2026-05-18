/**
 * Enrich qxo_products.is_stocked_anywhere.
 *
 *   A product is "stocked anywhere" if any of its variants appears in
 *   qxo_branch_sku at any branch. This is a denormalization so the brand-list,
 *   product-line, and preview queries don't have to join against the 512K-row
 *   availability matrix just to filter out catalog items no branch carries.
 *
 *   Source : qxo_branch_sku (variant_sku rows)
 *            qxo_variants    (variant_sku → product_key)
 *   Target : qxo_products.is_stocked_anywhere
 *
 *   Idempotent. Run after any branch-SKU re-ingest.
 *
 *   node enrich-qxo-stocked-flag.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchAll, upsertInBatches } = require('./lib/utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const BATCH = 500;

async function main() {
  console.log('\n=== QXO is_stocked_anywhere Enrichment ===\n');

  // ── Load distinct stocked variant_skus from qxo_branch_sku ──────────────
  // We page through the full table; SELECT DISTINCT isn't a thing in PostgREST,
  // so we dedup client-side.
  process.stdout.write('Loading qxo_branch_sku.variant_sku …\r');
  const stockedRows = await fetchAll(supabase, 'qxo_branch_sku', 'variant_sku', {
    onProgress: n => process.stdout.write(`  qxo_branch_sku: ${n.toLocaleString()} rows …\r`),
  });
  process.stdout.write('\n');
  const stockedSkus = new Set(stockedRows.map(r => r.variant_sku));
  console.log(`  ${stockedSkus.size.toLocaleString()} distinct stocked SKUs across all branches.`);

  // ── Load variant → product_key map ──────────────────────────────────────
  process.stdout.write('Loading qxo_variants …\r');
  const variants = await fetchAll(supabase, 'qxo_variants', 'variant_sku, product_key', {
    onProgress: n => process.stdout.write(`  qxo_variants: ${n.toLocaleString()} rows …\r`),
  });
  process.stdout.write('\n');
  console.log(`  ${variants.length.toLocaleString()} variants loaded.`);

  // ── Compute set of product_keys with ≥1 stocked variant ─────────────────
  const stockedProducts = new Set();
  for (const v of variants) {
    if (stockedSkus.has(v.variant_sku)) stockedProducts.add(v.product_key);
  }
  console.log(`  ${stockedProducts.size.toLocaleString()} products have ≥1 stocked variant.`);

  // ── Load all products (need product_name to satisfy NOT NULL on upsert) ──
  process.stdout.write('Loading qxo_products …\r');
  const products = await fetchAll(supabase, 'qxo_products', 'product_key, product_name, is_stocked_anywhere', {
    onProgress: n => process.stdout.write(`  qxo_products: ${n.toLocaleString()} rows …\r`),
  });
  process.stdout.write('\n');
  console.log(`  ${products.length.toLocaleString()} products loaded.`);

  // ── Build upsert payload — only rows whose flag would change ────────────
  const updates = [];
  let nowTrue = 0, nowFalse = 0, unchanged = 0;
  for (const p of products) {
    const next = stockedProducts.has(p.product_key);
    if (next === !!p.is_stocked_anywhere) {
      unchanged++;
      continue;
    }
    updates.push({
      product_key:         p.product_key,
      product_name:        p.product_name,
      is_stocked_anywhere: next,
    });
    if (next) nowTrue++; else nowFalse++;
  }

  console.log(`\n--- Change summary ---`);
  console.log(`  Will flip to TRUE  : ${nowTrue.toLocaleString()}`);
  console.log(`  Will flip to FALSE : ${nowFalse.toLocaleString()}`);
  console.log(`  Unchanged          : ${unchanged.toLocaleString()}`);

  if (updates.length === 0) {
    console.log('\nNothing to write. Done.');
    return;
  }

  console.log(`\nWriting ${updates.length.toLocaleString()} changes (batches of ${BATCH}) …`);
  await upsertInBatches(supabase, 'qxo_products', updates, {
    batchSize:  BATCH,
    onConflict: 'product_key',
    onProgress: (d, t) => process.stdout.write(`  ${d}/${t}\r`),
  });
  process.stdout.write('\n');

  // ── Verify ──────────────────────────────────────────────────────────────
  const { count, error } = await supabase
    .from('qxo_products')
    .select('*', { count: 'exact', head: true })
    .eq('is_stocked_anywhere', true);
  if (error) throw new Error(`Verify: ${error.message}`);
  console.log(`\n✓ ${count?.toLocaleString()} products now flagged is_stocked_anywhere=true.`);
  console.log(`  (${(products.length - (count ?? 0)).toLocaleString()} catalog-only / unstocked.)`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
