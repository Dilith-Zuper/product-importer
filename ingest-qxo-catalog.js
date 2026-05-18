/**
 * Ingest QXO product catalog (32 CSVs) into qxo_products + qxo_variants.
 *
 *   Source : QXO Catalog/ct_sku_us/ct_sku-*.csv (~614K rows across 32 files)
 *   Target : qxo_products  (PK = product_key)
 *            qxo_variants  (PK = variant_sku)
 *
 * Each CSV row is one SKU. Products repeat (same `key` across multiple rows).
 * First-occurrence wins for product fields. Variants are keyed by `variants.key`
 * which equals `variants.sku` and equals the int used in qxo_branch_sku.
 *
 * The CSV uses multi-line quoted strings (HTML in long descriptions) — csv-parse
 * with relax_quotes handles this; no need to skip "orphan" rows.
 *
 *   node ingest-qxo-catalog.js                # full run
 *   DRY_RUN=1 node ingest-qxo-catalog.js      # first 2 files only, no DB writes
 *   FILES=3   node ingest-qxo-catalog.js      # process N files, then write
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { createClient } = require('@supabase/supabase-js');
const { upsertInBatches } = require('./lib/utils');
const { normalizeQxoBrand } = require('./lib/qxo-brand-norm');
const { decodeHtmlEntities } = require('./lib/html-entities');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  CATALOG_VERSION = '2026-05-18',
  DRY_RUN,
  FILES,
} = process.env;

const CSV_DIR = path.join(__dirname, 'QXO Catalog', 'ct_sku_us');
const PRODUCT_BATCH = 500;
const VARIANT_BATCH = 1000;
const FILE_LIMIT    = FILES ? parseInt(FILES, 10) : (DRY_RUN ? 2 : Infinity);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── Transforms ──────────────────────────────────────────────────────────────

function toInt(v) {
  if (v === '' || v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function toNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toStr(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
}
// Most QXO catalog text fields embed raw HTML entities (&reg;, &trade;, &deg;,
// &nbsp;). Plain-text consumers (classifier, family-tier matcher) can't match
// against them. Decode once at ingest so the DB holds clean strings.
function toStrDecoded(v) {
  const s = toStr(v);
  return s == null ? null : decodeHtmlEntities(s);
}

function titleCaseCategory(raw) {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  // QXO categories are typically already sentence-cased ("Polyiso", "Architectural shingles").
  // Just collapse whitespace and trim; preserve original casing to avoid lossy renames.
  return t.replace(/\s+/g, ' ');
}

function transformProduct(row) {
  const brandRaw = toStr(row['attributes.prdBrand.en-US']);
  return {
    product_key:       toStr(row['key']),
    product_id:        toStr(row['id']),
    product_name:      toStrDecoded(row['name.en-US']) || toStr(row['key']),
    slug:              toStr(row['slug.en-US']),
    category_raw:      toStrDecoded(row['categories']),
    category_norm:     titleCaseCategory(decodeHtmlEntities(row['categories'] || '')),
    brand_raw:         brandRaw,
    brand_norm:        normalizeQxoBrand(brandRaw),
    brand_image_url:   toStr(row['attributes.prdBrandImageUrl']),
    description_short: toStrDecoded(row['description.en-US']),
    description_long:  toStrDecoded(row['attributes.prdLongDescription.en-US']),
    prd_dimensions:    toStrDecoded(row['attributes.prdDimensions']),
    prd_length:        toStrDecoded(row['attributes.prdLength']),
    prd_width:         toStrDecoded(row['attributes.prdWidth']),
    prd_thickness:     toStrDecoded(row['attributes.prdThickness']),
    site_ids:          toStr(row['attributes.prdSiteIds']),
    catalog_version:   CATALOG_VERSION,
  };
}

function transformVariant(row, productKey) {
  return {
    variant_sku:         toInt(row['variants.key']),
    product_key:         productKey,
    product_id_raw:      toStr(row['variants.id']),
    color:               toStr(row['attributes.skuColor']),
    color_family:        toStr(row['attributes.skuColorFamily']),
    uom:                 toStr(row['attributes.skuUOM']),
    size_height:         toStr(row['attributes.skuHeight']),
    size_width:          toStr(row['attributes.skuWidth']),
    size_length:         toStr(row['attributes.skuLength']),
    size_thickness:      toStr(row['attributes.skuThickness']),
    pieces_per_box:      toNum(row['attributes.skuPiecesPerBox']),
    pieces_per_bundle:   toNum(row['attributes.skuPiecesPerBundle']),
    pieces_per_carton:   toNum(row['attributes.skuPiecesPerCarton']),
    bundles_per_square:  toNum(row['attributes.skuBundlesPerSquare']),
    coverage_per_square: toNum(row['attributes.skuCoveragePerSquare']),
    lineal_per_bundle:   toNum(row['attributes.skuLinealCoveragePerBundle']) ?? toNum(row['attributes.skuLinealFeetPerBundle']),
    lineal_per_box:      toNum(row['attributes.skuLinealCoveragePerBox']),
    lineal_per_carton:   toNum(row['attributes.skuLinealFeetPerCarton']),
    weight:              toNum(row['attributes.skuWeight']) ?? toNum(row['attributes.skuItemWeight']),
    warranty_length:     toStr(row['attributes.skuWarrantyLength']),
    warranty_value:      toStr(row['attributes.skuWarrantyLengthValue']),
    manufacturer_number: toStr(row['attributes.skuManufacturerNumber']),
    material_number:     toStr(row['attributes.skuMaterialNumber']),
    product_number:      toStr(row['attributes.skuProductNumber']),
    image_url:           toStr(row['variants.images.url']),
    short_description:   toStr(row['attributes.skuShortDescription.en-US']),
    catalog_version:     CATALOG_VERSION,
  };
}

// ── Stream a single CSV file ────────────────────────────────────────────────

function streamFile(filePath, onRow) {
  return new Promise((resolve, reject) => {
    let rowCount = 0;
    fs.createReadStream(filePath)
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: false,         // preserve whitespace inside quoted fields; we trim per-column
        relax_quotes: true,
        relax_column_count: true,
      }))
      .on('data', (row) => {
        rowCount++;
        onRow(row);
      })
      .on('error', reject)
      .on('end', () => resolve(rowCount));
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== QXO Catalog Ingest (products + variants) ===');
  console.log(`Supabase project : ${SUPABASE_URL}`);
  console.log(`Catalog version  : ${CATALOG_VERSION}`);
  console.log(`Dry run          : ${DRY_RUN ? 'YES — no DB writes' : 'NO'}`);
  console.log(`File limit       : ${FILE_LIMIT === Infinity ? 'all 32' : FILE_LIMIT}`);

  const files = fs.readdirSync(CSV_DIR)
    .filter(f => f.startsWith('ct_sku-') && f.endsWith('.csv'))
    .sort((a, b) => {
      const na = parseInt(a.match(/(\d+)/)?.[1] ?? '0', 10);
      const nb = parseInt(b.match(/(\d+)/)?.[1] ?? '0', 10);
      return na - nb;
    })
    .slice(0, FILE_LIMIT);

  console.log(`\nProcessing ${files.length} CSV files from ${CSV_DIR}`);

  // ── First pass: stream everything, dedup ──────────────────────────────────
  const productsMap = new Map();   // product_key → product row (first-wins)
  const variantsMap = new Map();   // variant_sku → variant row (last-wins, but rare)
  let rowsTotal = 0;
  let skippedNoKey = 0;
  let skippedNoSku = 0;

  for (let i = 0; i < files.length; i++) {
    const fp = path.join(CSV_DIR, files[i]);
    const start = Date.now();
    const localCount = await streamFile(fp, (row) => {
      rowsTotal++;
      const productKey = toStr(row['key']);
      if (!productKey || !productKey.startsWith('C-')) {
        skippedNoKey++;
        return;
      }
      if (!productsMap.has(productKey)) {
        productsMap.set(productKey, transformProduct(row));
      }
      const variantSku = toInt(row['variants.key']);
      if (variantSku == null) {
        skippedNoSku++;
        return;
      }
      variantsMap.set(variantSku, transformVariant(row, productKey));
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    process.stdout.write(
      `  [${String(i + 1).padStart(2)}/${files.length}] ${files[i]}  ` +
      `${localCount.toLocaleString().padStart(7)} rows  ${elapsed}s  ` +
      `(products so far: ${productsMap.size.toLocaleString()}, ` +
      `variants: ${variantsMap.size.toLocaleString()})\n`
    );
  }

  console.log(`\n--- Parse summary ---`);
  console.log(`  Total rows seen      : ${rowsTotal.toLocaleString()}`);
  console.log(`  Skipped (no C- key)  : ${skippedNoKey.toLocaleString()}`);
  console.log(`  Skipped (no variant) : ${skippedNoSku.toLocaleString()}`);
  console.log(`  Unique products      : ${productsMap.size.toLocaleString()}`);
  console.log(`  Unique variants      : ${variantsMap.size.toLocaleString()}`);

  // ── Spot check ────────────────────────────────────────────────────────────
  console.log('\n--- Sample (first 3 products) ---');
  let n = 0;
  for (const [key, p] of productsMap) {
    if (n++ >= 3) break;
    console.log(`  ${key}  brand=${p.brand_norm}  cat=${p.category_norm}  name="${p.product_name?.slice(0, 60)}"`);
  }
  console.log('--- Sample (first 3 variants) ---');
  n = 0;
  for (const [sku, v] of variantsMap) {
    if (n++ >= 3) break;
    console.log(`  ${sku}  product=${v.product_key}  color=${v.color}  uom=${v.uom}`);
  }

  // ── Brand-norm distribution check (top 20)
  const brandCounts = new Map();
  for (const p of productsMap.values()) {
    const b = p.brand_norm || '(none)';
    brandCounts.set(b, (brandCounts.get(b) ?? 0) + 1);
  }
  const topBrands = [...brandCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log('\n--- Top 20 normalized brands ---');
  topBrands.forEach(([b, c]) => console.log(`  ${String(c).padStart(6)}  ${b}`));
  console.log(`  ... (${brandCounts.size.toLocaleString()} total unique brand_norm values)`);

  if (DRY_RUN) {
    console.log('\nDRY_RUN=1 — exiting before DB writes.');
    return;
  }

  // ── Clear existing data (variants first — FK) ─────────────────────────────
  console.log('\nClearing qxo_variants + qxo_products …');
  const { error: dvErr } = await supabase.from('qxo_variants').delete().gt('variant_sku', 0);
  if (dvErr) throw new Error(`Clear qxo_variants: ${dvErr.message}`);
  const { error: dpErr } = await supabase.from('qxo_products').delete().not('product_key', 'is', null);
  if (dpErr) throw new Error(`Clear qxo_products: ${dpErr.message}`);

  // ── Upsert products ───────────────────────────────────────────────────────
  const productRows = [...productsMap.values()];
  console.log(`\nUpserting ${productRows.length.toLocaleString()} products (batches of ${PRODUCT_BATCH}) …`);
  await upsertInBatches(supabase, 'qxo_products', productRows, {
    batchSize:  PRODUCT_BATCH,
    onConflict: 'product_key',
    onProgress: (done, total) => process.stdout.write(`  ${done}/${total}\r`),
  });
  process.stdout.write('\n');

  // ── Upsert variants ───────────────────────────────────────────────────────
  const variantRows = [...variantsMap.values()];
  console.log(`\nUpserting ${variantRows.length.toLocaleString()} variants (batches of ${VARIANT_BATCH}) …`);
  await upsertInBatches(supabase, 'qxo_variants', variantRows, {
    batchSize:  VARIANT_BATCH,
    onConflict: 'variant_sku',
    onProgress: (done, total) => process.stdout.write(`  ${done}/${total}\r`),
  });
  process.stdout.write('\n');

  // ── Verify counts ─────────────────────────────────────────────────────────
  const [{ count: pCount }, { count: vCount }] = await Promise.all([
    supabase.from('qxo_products').select('*', { count: 'exact', head: true }),
    supabase.from('qxo_variants').select('*', { count: 'exact', head: true }),
  ]);
  console.log(`\n✓ qxo_products : ${pCount?.toLocaleString()} rows`);
  console.log(`✓ qxo_variants : ${vCount?.toLocaleString()} rows`);
  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
