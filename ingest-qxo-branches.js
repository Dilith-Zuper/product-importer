/**
 * Ingest QXO branches into qxo_branches.
 *
 *   Source : QXO Catalog/branch/branch-1.csv (1,154 rows, single file)
 *   Target : qxo_branches  (PK = branch_num)
 *
 * Idempotent — upserts on branch_num. Run anytime to refresh.
 *
 *   node ingest-qxo-branches.js
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const { createClient } = require('@supabase/supabase-js');
const { upsertInBatches } = require('./lib/utils');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  CATALOG_VERSION = '2026-05-18',
} = process.env;

const CSV_PATH = path.join(__dirname, 'QXO Catalog', 'branch', 'branch-1.csv');
const BATCH    = 500;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

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
function toBool(v) {
  return v === '1' || v === 1 || v === 'true' || v === true;
}

function transformBranch(row) {
  return {
    branch_num:        toInt(row['branch num']),
    code:              row['code']?.trim() || null,
    name:              row['name']?.trim() || null,
    region_name:       row['region name']?.trim() || null,
    reg_num:           toInt(row['reg num']),
    market_num:        toInt(row['market num']),
    address1:          row['address1']?.trim() || null,
    address2:          row['address2']?.trim() || null,
    city:              row['city']?.trim() || null,
    state:             row['state']?.trim() || null,
    postalcode:        row['postalcode']?.trim() || null,
    lat:               toNum(row['lat']),
    lng:               toNum(row['lng']),
    phone:             row['phone']?.trim() || null,
    delivery_types:    row['deliverytypes']?.trim() || null,
    delivery_tracking: toBool(row['Delivery Tracking Enabled']),
    catalog_version:   CATALOG_VERSION,
  };
}

async function main() {
  console.log('\n=== QXO Branches Ingest ===');
  console.log(`Supabase project : ${SUPABASE_URL}`);
  console.log(`Catalog version  : ${CATALOG_VERSION}`);
  console.log(`CSV              : ${CSV_PATH}`);

  // ── Stream + parse CSV ────────────────────────────────────────────────────
  const rows = [];
  const skipped = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(CSV_PATH)
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_quotes: true,
        relax_column_count: true,
      }))
      .on('data', (row) => {
        const t = transformBranch(row);
        if (t.branch_num == null || !t.name) {
          skipped.push({ row, reason: 'missing branch_num or name' });
          return;
        }
        rows.push(t);
      })
      .on('error', reject)
      .on('end', resolve);
  });

  console.log(`\nParsed ${rows.length.toLocaleString()} branches (skipped ${skipped.length})`);
  if (skipped.length) {
    console.log('First skipped rows:', skipped.slice(0, 3));
  }

  // ── Sanity sample ─────────────────────────────────────────────────────────
  console.log('\n--- Sample (first 3) ---');
  rows.slice(0, 3).forEach(r => console.log(`  ${r.branch_num}  ${r.name}  (${r.city}, ${r.state})`));

  // ── Upsert ────────────────────────────────────────────────────────────────
  console.log(`\nUpserting in batches of ${BATCH} …`);
  await upsertInBatches(supabase, 'qxo_branches', rows, {
    batchSize:  BATCH,
    onConflict: 'branch_num',
    onProgress: (done, total) => process.stdout.write(`  ${done}/${total}\r`),
  });
  process.stdout.write('\n');

  // ── Verify ────────────────────────────────────────────────────────────────
  const { count, error } = await supabase
    .from('qxo_branches')
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(`Count verify: ${error.message}`);
  console.log(`\n✓ qxo_branches now has ${count} rows.`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
