require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const StreamArray = require('stream-json/streamers/StreamArray');
const { parser } = require('stream-json');

// ── Config ────────────────────────────────────────────────────────────────────
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  CATALOG_VERSION = '2025-05-01',
} = process.env;

const CATALOG_PATH  = path.join(__dirname, 'SRS catalog.json');
const PRODUCT_BATCH = 100;   // rows per upsert call for products
const VARIANT_BATCH = 500;   // rows per upsert call for variants
const DRY_RUN_LIMIT = Infinity; // 50 for dry run, Infinity for full ingest

// ── Supabase client ───────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── Transforms ────────────────────────────────────────────────────────────────
function toTitleCase(str) {
  return str
    .split(' ')
    .map(w => w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(' ');
}

function normManufacturer(name) {
  if (!name || !name.trim()) return '';
  const trimmed = name.trim();
  // Collapse all "Manufacturer Varies …" variants to one canonical value
  if (trimmed.toLowerCase().startsWith('manufacturer varies')) return 'Manufacturer Varies';
  return toTitleCase(trimmed);
}

function transformProduct(r) {
  return {
    product_id:          r.productId,
    product_name:        r.productName,
    product_category:    r.productCategory,
    manufacturer:        r.manufacturer?.trim() || null,
    manufacturer_norm:   normManufacturer(r.manufacturer),
    product_description: r.productDescription?.trim() || null,
    product_features:    r.productFeatures?.length ? r.productFeatures : null,
    product_uom:         r.productUOM?.length      ? r.productUOM      : null,
    product_options:     r.productOptions?.length   ? r.productOptions  : null,
    product_image_url:   r.productImageUrl || null,
    primary_item:        r.primaryItem        ?? false,
    is_generic:          r.isGeneric          ?? false,
    allow_substitution:  r.allowSubstitution  ?? false,
    is_private_label:    false,   // rule engine will populate this later
    exclude_default:     false,   // rule engine will populate this later
    catalog_version:     CATALOG_VERSION,
  };
}

function transformVariant(v, productId) {
  const isRestricted = typeof v.customerRestrictions === 'string'
    && v.customerRestrictions.trim().length > 0;
  return {
    variant_id:            v.productOptionsId,
    product_id:            productId,
    variant_code:          v.variantCode,
    order_uom:             v.orderUOM    || null,
    color_name:            v.colorName?.trim()  || null,
    size_name:             v.sizeName?.trim()   || null,
    selected_option:       v.selectedOption     || null,
    variant_image_url:     v.variantImageURL    || null,
    uoms:                  v.uoMs?.length ? v.uoMs : null,
    customer_restrictions: v.customerRestrictions || '',
    is_restricted:         isRestricted,
    is_private_label:      false,
    catalog_version:       CATALOG_VERSION,
  };
}

// ── Upsert helper ─────────────────────────────────────────────────────────────
async function upsertBatch(table, rows, conflictCol) {
  const { error } = await supabase
    .from(table)
    .upsert(rows, { onConflict: conflictCol });
  if (error) {
    throw new Error(`[${table}] upsert failed: ${error.message} (code: ${error.code})`);
  }
}

async function upsertAll(table, rows, conflictCol, batchSize, label) {
  const total = rows.length;
  for (let i = 0; i < total; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const end   = Math.min(i + batchSize, total);
    process.stdout.write(`  ${label} ${i + 1}–${end} / ${total} … `);
    await upsertBatch(table, batch, conflictCol);
    process.stdout.write('✓\n');
  }
}

// ── Streaming load ────────────────────────────────────────────────────────────
// The SRS catalog JSON is ~500MB. Loading it via JSON.parse(readFileSync) needs
// 1-2GB heap and is a frequent OOM source on smaller dev boxes. Stream the
// top-level array and transform products as they arrive — peak memory drops to
// well under 1GB even for the full catalog.
async function streamProducts() {
  const productRows = [];
  const variantMap = new Map();
  let totalRawVariants = 0;
  let totalSeen = 0;
  let isDryRun = DRY_RUN_LIMIT !== Infinity;

  await new Promise((resolve, reject) => {
    const pipeline = fs.createReadStream(CATALOG_PATH)
      .pipe(parser())
      .pipe(StreamArray.streamArray());

    pipeline.on('data', ({ value: r }) => {
      totalSeen++;
      if (productRows.length >= DRY_RUN_LIMIT) return;
      productRows.push(transformProduct(r));
      for (const v of r.productVariants || []) {
        totalRawVariants++;
        variantMap.set(v.productOptionsId, transformVariant(v, r.productId));
      }
      if (productRows.length % 1000 === 0) {
        process.stdout.write(`  …loaded ${productRows.length.toLocaleString()} products\r`);
      }
    });
    pipeline.on('error', reject);
    pipeline.on('end', resolve);
  });

  return { productRows, variantRows: [...variantMap.values()], totalSeen, totalRawVariants, isDryRun };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const isDryRun = DRY_RUN_LIMIT !== Infinity;
  console.log(`\n=== SRS Catalog Ingest ${isDryRun ? `(DRY RUN — first ${DRY_RUN_LIMIT} products)` : '(FULL)'} ===`);
  console.log(`Supabase project : ${SUPABASE_URL}`);
  console.log(`Catalog version  : ${CATALOG_VERSION}`);

  // ── Load catalog (streaming) ────────────────────────────────────────────────
  console.log('\nStreaming catalog …');
  const { productRows, variantRows, totalSeen, totalRawVariants } = await streamProducts();
  const restrictedVariants = variantRows.filter(v => v.is_restricted).length;
  const dedupedOut = totalRawVariants - variantRows.length;
  console.log(`  Total in file  : ${totalSeen.toLocaleString()} products`);
  console.log(`  Processing     : ${productRows.length.toLocaleString()} products`);
  console.log(`  Variants       : ${variantRows.length} (${restrictedVariants} restricted, ${dedupedOut} duplicates removed)`);

  // ── Sample manufacturer_norm values (confirm title case)
  console.log('\n--- manufacturer_norm sample (10 unique values) ---');
  const normSample = [...new Set(productRows.map(r => r.manufacturer_norm))].slice(0, 10);
  normSample.forEach(v => console.log(`  ${v}`));

  // ── Clear existing data (delete variants first — FK constraint)
  console.log('\nClearing existing data from tables …');
  const { error: dvErr } = await supabase.from('srs_variants').delete().neq('variant_id', 0);
  if (dvErr) throw new Error(`Clear srs_variants: ${dvErr.message}`);
  const { error: dpErr } = await supabase.from('srs_products').delete().neq('product_id', 0);
  if (dpErr) throw new Error(`Clear srs_products: ${dpErr.message}`);

  // Confirm both tables empty
  const [{ count: emptyP }, { count: emptyV }] = await Promise.all([
    supabase.from('srs_products').select('*', { count: 'exact', head: true }),
    supabase.from('srs_variants').select('*', { count: 'exact', head: true }),
  ]);
  console.log(`  srs_products after delete : ${emptyP} rows`);
  console.log(`  srs_variants after delete : ${emptyV} rows`);
  if (emptyP !== 0 || emptyV !== 0) throw new Error('Tables not empty after delete — aborting.');
  console.log('  Both tables confirmed empty. ✓');

  // ── Upsert products
  console.log('\nUpserting products …');
  await upsertAll('srs_products', productRows, 'product_id', PRODUCT_BATCH, 'Products');

  // ── Upsert variants
  console.log('\nUpserting variants …');
  await upsertAll('srs_variants', variantRows, 'variant_id', VARIANT_BATCH, 'Variants');

  // ── Verify counts in DB
  console.log('\nVerifying row counts in Supabase …');
  const [{ count: pCount, error: pErr }, { count: vCount, error: vErr }] = await Promise.all([
    supabase.from('srs_products').select('*', { count: 'exact', head: true }),
    supabase.from('srs_variants').select('*', { count: 'exact', head: true }),
  ]);
  if (pErr) throw new Error(`srs_products count: ${pErr.message}`);
  if (vErr) throw new Error(`srs_variants count: ${vErr.message}`);

  console.log(`  srs_products : ${pCount} rows in DB`);
  console.log(`  srs_variants : ${vCount} rows in DB`);

  // ── Spot-check: read back first product
  const { data: check, error: cErr } = await supabase
    .from('srs_products')
    .select('product_id, product_name, product_category, manufacturer, catalog_version')
    .eq('product_id', productRows[0].product_id)
    .single();
  if (cErr) throw new Error(`Spot-check read: ${cErr.message}`);
  console.log('\n--- Spot-check read-back ---');
  console.log(JSON.stringify(check, null, 2));

  console.log('\n✓ Full ingest complete.\n');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
