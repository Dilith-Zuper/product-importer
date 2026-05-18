/**
 * Ingest QXO branch-SKU availability matrix into qxo_branch_sku.
 *
 *   Source : QXO Catalog/branchSku/branchSku-*.csv  (628 files, ~3.14M rows)
 *   Target : qxo_branch_sku  (PK = branch_num + variant_sku)
 *
 * We ingest ONLY rows where brn_avail=1 — cuts the table from ~3.14M to ~512K.
 * Absence of a row is equivalent to "not stocked at that branch", which is the
 * only state the wizard needs. To capture the full matrix later, set
 * INGEST_UNAVAILABLE=1.
 *
 * Requires qxo_branches to already be populated (FK constraint).
 *
 *   node ingest-qxo-branch-sku.js                # avail only
 *   INGEST_UNAVAILABLE=1 node ingest-qxo-branch-sku.js
 *   FILES=5 node ingest-qxo-branch-sku.js        # process N files, useful for testing
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
  INGEST_UNAVAILABLE,
  FILES,
} = process.env;

const CSV_DIR    = path.join(__dirname, 'QXO Catalog', 'branchSku');
const BATCH      = 1000;
const FILE_LIMIT = FILES ? parseInt(FILES, 10) : Infinity;
const AVAIL_ONLY = !INGEST_UNAVAILABLE;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

function toInt(v) {
  if (v === '' || v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function transformRow(row) {
  return {
    branch_num:       toInt(row['branchid']),
    variant_sku:      toInt(row['itemnumber']),
    branch_available: row['brn avail'] === '1',
    region_available: row['reg avail'] === '1',
    region_id:        toInt(row['reg id']),
    market_id:        toInt(row['market id']),
  };
}

async function flushBatch(rows) {
  // Use the shared upserter so progress reporting + error msgs are consistent.
  await upsertInBatches(supabase, 'qxo_branch_sku', rows, {
    batchSize:  BATCH,
    onConflict: 'branch_num,variant_sku',
  });
}

async function main() {
  console.log('\n=== QXO Branch-SKU Availability Ingest ===');
  console.log(`Supabase project : ${SUPABASE_URL}`);
  console.log(`Mode             : ${AVAIL_ONLY ? 'AVAIL ONLY (brn_avail=1)' : 'FULL MATRIX'}`);
  console.log(`File limit       : ${FILE_LIMIT === Infinity ? 'all 628' : FILE_LIMIT}`);

  const files = fs.readdirSync(CSV_DIR)
    .filter(f => f.startsWith('branchSku-') && f.endsWith('.csv'))
    .sort((a, b) => {
      const na = parseInt(a.match(/(\d+)/)?.[1] ?? '0', 10);
      const nb = parseInt(b.match(/(\d+)/)?.[1] ?? '0', 10);
      return na - nb;
    })
    .slice(0, FILE_LIMIT);

  console.log(`\nProcessing ${files.length} CSV files from ${CSV_DIR}`);

  // ── Clear existing rows ───────────────────────────────────────────────────
  // The delete().gt() filter targets every row (variant_sku is always > 0).
  console.log('\nClearing qxo_branch_sku …');
  const { error: dErr } = await supabase.from('qxo_branch_sku').delete().gt('variant_sku', 0);
  if (dErr) throw new Error(`Clear qxo_branch_sku: ${dErr.message}`);

  // ── Stream + flush ────────────────────────────────────────────────────────
  let buf = [];
  let totalSeen = 0;
  let totalKept = 0;
  let skippedBadRow = 0;
  let flushCount = 0;
  const tStart = Date.now();

  const STREAM_BATCH = 5000; // collect this many before flushing to keep peak memory tame

  for (let i = 0; i < files.length; i++) {
    const fp = path.join(CSV_DIR, files[i]);
    const fileStart = Date.now();
    let localKept = 0;

    await new Promise((resolve, reject) => {
      fs.createReadStream(fp)
        .pipe(parse({
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_quotes: true,
          relax_column_count: true,
        }))
        .on('data', (row) => {
          totalSeen++;
          const t = transformRow(row);
          if (t.branch_num == null || t.variant_sku == null) {
            skippedBadRow++;
            return;
          }
          if (AVAIL_ONLY && !t.branch_available) return;
          buf.push(t);
          localKept++;
          totalKept++;
        })
        .on('error', reject)
        .on('end', resolve);
    });

    // Flush whenever the buffer crosses STREAM_BATCH between files.
    while (buf.length >= STREAM_BATCH) {
      const chunk = buf.splice(0, STREAM_BATCH);
      await flushBatch(chunk);
      flushCount++;
    }

    const elapsed = ((Date.now() - fileStart) / 1000).toFixed(1);
    process.stdout.write(
      `  [${String(i + 1).padStart(3)}/${files.length}] ${files[i]}  ` +
      `kept ${String(localKept).padStart(5)}  total kept ${totalKept.toLocaleString().padStart(8)}  ${elapsed}s\n`
    );
  }

  // Drain remainder
  if (buf.length) {
    await flushBatch(buf);
    flushCount++;
    buf = [];
  }

  const totalElapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`\n--- Ingest summary ---`);
  console.log(`  Rows seen      : ${totalSeen.toLocaleString()}`);
  console.log(`  Rows kept      : ${totalKept.toLocaleString()}  (${AVAIL_ONLY ? 'avail=1 only' : 'all'})`);
  console.log(`  Skipped (bad)  : ${skippedBadRow.toLocaleString()}`);
  console.log(`  Flush batches  : ${flushCount.toLocaleString()}`);
  console.log(`  Elapsed        : ${totalElapsed}s`);

  // ── Verify ────────────────────────────────────────────────────────────────
  const { count, error } = await supabase
    .from('qxo_branch_sku')
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(`Count verify: ${error.message}`);
  console.log(`\n✓ qxo_branch_sku now has ${count?.toLocaleString()} rows.`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
