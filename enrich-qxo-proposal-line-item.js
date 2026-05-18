/**
 * Enrich qxo_products.proposal_line_item via lib/qxo-category-classifier.
 *
 *   Source : qxo_products.category_norm + product_name
 *   Target : qxo_products.proposal_line_item
 *
 *   At the end, writes  qxo-unmapped-categories.json  — a coverage report of
 *   QXO category strings that produced null (excluded or unhandled) plus
 *   per-category sample product names. Use it to refine the classifier rules.
 *
 *   node enrich-qxo-proposal-line-item.js [--log-changes]
 */

require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { fetchAll, upsertInBatches, makeChangeLogger, changeLogFlag } = require('./lib/utils');
const { classifyQxoProduct } = require('./lib/qxo-category-classifier');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const BATCH = 500;

async function main() {
  console.log('\n=== QXO proposal_line_item Enrichment ===\n');

  const logChanges = changeLogFlag();
  const logger = makeChangeLogger({ enabled: logChanges, scriptName: 'qxo-proposal-line-item' });
  if (logChanges) console.log('Audit logging enabled (--log-changes)\n');

  process.stdout.write('Loading qxo_products …\r');
  const rawProducts = await fetchAll(
    supabase,
    'qxo_products',
    'product_key, product_name, category_norm, is_stocked_anywhere, proposal_line_item',
    {
      orderBy: 'product_key',
      onProgress: n => process.stdout.write(`  qxo_products: ${n.toLocaleString()} rows …\r`),
    },
  );
  process.stdout.write('\n');

  // Defensive dedup (PostgREST pagination caveat).
  const seen = new Map();
  for (const p of rawProducts) if (!seen.has(p.product_key)) seen.set(p.product_key, p);
  const products = [...seen.values()];
  console.log(`  ${rawProducts.length.toLocaleString()} rows / ${products.length.toLocaleString()} unique.`);

  // ── Classify ─────────────────────────────────────────────────────────────
  const updates = [];
  const distribution = new Map();
  const nullByCategory = new Map();        // category → { count, stockedCount, samples: [...] }

  for (const p of products) {
    const li = classifyQxoProduct(p.category_norm, p.product_name);
    const key = li || '(none)';
    distribution.set(key, (distribution.get(key) || 0) + 1);

    if (!li) {
      const cat = p.category_norm || '(no category)';
      if (!nullByCategory.has(cat)) {
        nullByCategory.set(cat, { count: 0, stockedCount: 0, samples: [] });
      }
      const entry = nullByCategory.get(cat);
      entry.count++;
      if (p.is_stocked_anywhere) entry.stockedCount++;
      if (entry.samples.length < 5) entry.samples.push(p.product_name);
    }

    if (logChanges) logger.log(p.product_key, 'proposal_line_item', p.proposal_line_item, li);
    if ((p.proposal_line_item || null) !== (li || null)) {
      updates.push({
        product_key:        p.product_key,
        product_name:       p.product_name,
        proposal_line_item: li,
      });
    }
  }

  // ── Distribution summary ─────────────────────────────────────────────────
  console.log('\n--- Line item distribution ---');
  [...distribution.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`  ${String(n).padStart(6)}  ${k}`));

  const totalMapped = products.length - (distribution.get('(none)') || 0);
  const pct = ((totalMapped / products.length) * 100).toFixed(1);
  console.log(`\n  Mapped: ${totalMapped.toLocaleString()} / ${products.length.toLocaleString()} (${pct}%)`);

  // ── Unmapped-category coverage report ────────────────────────────────────
  const reportRows = [...nullByCategory.entries()]
    .map(([cat, info]) => ({ category: cat, ...info }))
    .sort((a, b) => b.stockedCount - a.stockedCount || b.count - a.count);

  const reportPath = 'qxo-unmapped-categories.json';
  fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalUnmapped: distribution.get('(none)') || 0,
    distinctCategories: reportRows.length,
    rows: reportRows,
  }, null, 2));
  console.log(`\n--- Top 20 unmapped categories (by stocked product count) ---`);
  reportRows.slice(0, 20).forEach(r =>
    console.log(`  ${String(r.count).padStart(5)} / ${String(r.stockedCount).padStart(5)} stocked  ${r.category}`)
  );
  console.log(`  → full report: ${reportPath}`);

  // ── Write ────────────────────────────────────────────────────────────────
  if (updates.length === 0) {
    console.log('\nNothing to write.');
  } else {
    console.log(`\nWriting ${updates.length.toLocaleString()} changes (batches of ${BATCH}) …`);
    await upsertInBatches(supabase, 'qxo_products', updates, {
      batchSize:  BATCH,
      onConflict: 'product_key',
      onProgress: (d, t) => process.stdout.write(`  ${d}/${t}\r`),
    });
    process.stdout.write('\n');
  }

  if (logChanges && logger.count() > 0) {
    const auditPath = await logger.save();
    console.log(`Audit log: ${logger.count().toLocaleString()} changes → ${auditPath}`);
  }

  // ── Verify ───────────────────────────────────────────────────────────────
  const { count, error } = await supabase
    .from('qxo_products')
    .select('*', { count: 'exact', head: true })
    .not('proposal_line_item', 'is', null);
  if (error) throw new Error(`Verify: ${error.message}`);
  console.log(`\n✓ ${count?.toLocaleString()} products have proposal_line_item populated.`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
