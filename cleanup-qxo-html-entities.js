/**
 * One-shot cleanup: decode HTML entities in qxo_products text columns.
 *
 *   The initial QXO ingest stored raw entity strings ("Timberline&reg;") from
 *   the source CSV. Plain-text consumers (classifier, tier matcher, search UI)
 *   need decoded characters ("Timberline®"). The ingest script now decodes on
 *   the way in; this script normalizes rows already in the DB.
 *
 *   Idempotent. Safe to run any time. Run once after the html-entities fix
 *   landed, then re-run dependent enrichments (product_line, family_tier).
 *
 *   node cleanup-qxo-html-entities.js
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchAll, upsertInBatches } = require('./lib/utils');
const { decodeHtmlEntities } = require('./lib/html-entities');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const BATCH = 500;
const COLS = ['product_name', 'category_raw', 'category_norm',
              'description_short', 'description_long',
              'prd_dimensions', 'prd_length', 'prd_width', 'prd_thickness',
              'product_line'];

function needsDecode(s) {
  return typeof s === 'string' && /&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s);
}

async function main() {
  console.log('\n=== QXO HTML-entity cleanup ===\n');

  process.stdout.write('Loading qxo_products …\r');
  const rawProducts = await fetchAll(
    supabase,
    'qxo_products',
    ['product_key', ...COLS].join(', '),
    {
      orderBy: 'product_key',
      onProgress: n => process.stdout.write(`  qxo_products: ${n.toLocaleString()} rows …\r`),
    },
  );
  process.stdout.write('\n');

  // Dedup defensively.
  const seen = new Map();
  for (const p of rawProducts) if (!seen.has(p.product_key)) seen.set(p.product_key, p);
  const products = [...seen.values()];
  console.log(`  ${products.length.toLocaleString()} unique products.\n`);

  const updates = [];
  const fieldHits = {};
  for (const p of products) {
    const next = { product_key: p.product_key, product_name: p.product_name };
    let changed = false;
    for (const c of COLS) {
      if (needsDecode(p[c])) {
        const decoded = decodeHtmlEntities(p[c]);
        if (decoded !== p[c]) {
          next[c] = decoded;
          changed = true;
          fieldHits[c] = (fieldHits[c] || 0) + 1;
        }
      }
    }
    if (changed) {
      // product_name must be NOT NULL — make sure we use the decoded form if it changed.
      if (next.product_name == null) next.product_name = p.product_name;
      updates.push(next);
    }
  }

  console.log('--- Rows-with-entity counts by column ---');
  for (const [c, n] of Object.entries(fieldHits)) {
    console.log(`  ${c.padEnd(20)}: ${n.toLocaleString()}`);
  }
  console.log(`\n  Products needing update: ${updates.length.toLocaleString()}`);

  if (updates.length === 0) {
    console.log('\nNo entities found in DB. Done.');
    return;
  }

  console.log(`\nWriting (batches of ${BATCH}) …`);
  await upsertInBatches(supabase, 'qxo_products', updates, {
    batchSize:  BATCH,
    onConflict: 'product_key',
    onProgress: (d, t) => process.stdout.write(`  ${d}/${t}\r`),
  });
  process.stdout.write('\n');

  // Spot-check a few decoded rows
  const sample = updates.slice(0, 5);
  console.log('\n--- Sample decoded names ---');
  for (const u of sample) console.log(`  ${u.product_key}  ${u.product_name?.slice(0, 80)}`);
  console.log('\n✓ Done.');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
