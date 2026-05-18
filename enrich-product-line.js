require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchAll, upsertInBatches, makeChangeLogger, changeLogFlag } = require('./lib/utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const BATCH_SIZE = 500;

// ── Extraction logic ──────────────────────────────────────────────────────────
function extractProductLine(productName, manufacturer, familyName) {
  // 1. DB-classified family name wins
  if (familyName) return familyName;

  const name  = productName.trim();
  const brand = (manufacturer || '').trim();

  // 2. Strip brand prefix (case-insensitive)
  const escaped = brand.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&');
  const stripped = name.replace(new RegExp(`^${escaped}\\s*`, 'i'), '').trim();
  const source   = (!stripped || stripped === name) ? name : stripped;

  // 3. Take first 2–3 meaningful words
  const specOnly = new Set(['ar','ir','xt','hd','non-ar','non-sg','sg','ul','lp',
                            'pvc','tpo','epdm','sbs','ht','hc','sa','hp','xd','db','rs','as']);
  const words  = source.split(/\s+/);
  const result = [];

  for (const w of words) {
    if (result.length >= 3) break;
    // Stop at leading numbers or spec-only tokens as the first word
    if (result.length === 0 && /^\d/.test(w)) { result.push(w); break; }
    if (/^(class|type|grade|#\d)/i.test(w)) break;
    result.push(w);
    // After 2 words, stop if next word is spec-only
    if (result.length === 2 && words[result.length] &&
        specOnly.has(words[result.length].toLowerCase())) break;
  }

  return result.join(' ') || source.split(/\s+/).slice(0, 2).join(' ');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Product Line Enrichment ===\n');

  const logChanges = changeLogFlag();
  const logger = makeChangeLogger({ enabled: logChanges, scriptName: 'product-line' });
  if (logChanges) console.log('Audit logging enabled (--log-changes)\n');

  // Load families map
  process.stdout.write('Loading family classifications …\r');
  const { data: families, error: fErr } = await supabase
    .from('srs_product_families')
    .select('product_id, family_name');
  if (fErr) throw new Error(fErr.message);
  const familyMap = Object.fromEntries(families.map(r => [r.product_id, r.family_name]));
  console.log(`Loaded ${families.length} family classifications.`);

  // Load all products. Pull product_line too if logging diffs.
  const cols = logChanges
    ? 'product_id, product_name, product_category, manufacturer, product_line'
    : 'product_id, product_name, product_category, manufacturer';
  const products = await fetchAll(supabase, 'srs_products', cols, {
    onProgress: n => process.stdout.write(`  Loading products: ${n} …\r`),
  });
  console.log(`Loaded ${products.length.toLocaleString()} products.\n`);

  // Compute product_line for every product
  const enriched = products.map(p => {
    const product_line = extractProductLine(p.product_name, p.manufacturer, familyMap[p.product_id]);
    if (logChanges) logger.log(p.product_id, 'product_line', p.product_line, product_line);
    return { product_id: p.product_id, product_line };
  });

  // ── Spot-check before writing ─────────────────────────────────────────────
  console.log('─'.repeat(70));
  console.log('SPOT-CHECK — 5 samples per category');
  console.log('─'.repeat(70));

  const byCategory = {};
  products.forEach((p, i) => {
    if (!byCategory[p.product_category]) byCategory[p.product_category] = [];
    byCategory[p.product_category].push({ ...p, product_line: enriched[i].product_line });
  });

  Object.entries(byCategory)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([cat, items]) => {
      console.log(`\n[${cat}]`);
      items.slice(0, 5).forEach(p =>
        console.log(`  ${p.product_line.padEnd(28)} ← ${p.product_name}`)
      );
    });

  console.log('\n' + '─'.repeat(70));
  console.log(`\nFrom DB (families): ${families.length} products`);
  console.log(`Extracted from name: ${products.length - families.length} products`);
  console.log(`\nWriting to srs_products.product_line …\n`);

  // ── Upsert in batches of 500 — include required non-null cols ────────────
  // Build upsert payload with product_id + required cols + product_line
  // ON CONFLICT (product_id) DO UPDATE will only change product_line in practice
  const prodMeta = Object.fromEntries(
    products.map(p => [p.product_id, { product_name: p.product_name, product_category: p.product_category }])
  );
  const upsertRows = enriched.map(r => ({
    product_id:       r.product_id,
    product_name:     prodMeta[r.product_id].product_name,
    product_category: prodMeta[r.product_id].product_category,
    product_line:     r.product_line,
  }));

  console.log(`  Using upsert batches of ${BATCH_SIZE} → ${Math.ceil(upsertRows.length / BATCH_SIZE)} total requests\n`);
  const done = await upsertInBatches(supabase, 'srs_products', upsertRows, {
    batchSize: BATCH_SIZE,
    onProgress: (d, t) => process.stdout.write(`  ${d.toLocaleString()} / ${t.toLocaleString()} updated …\r`),
  });

  console.log(`  ${done.toLocaleString()} / ${enriched.length.toLocaleString()} updated ✓\n`);

  if (logChanges && logger.count() > 0) {
    const path = await logger.save();
    console.log(`Audit log: ${logger.count().toLocaleString()} product_line changes → ${path}\n`);
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  const { count, error: cErr } = await supabase
    .from('srs_products')
    .select('*', { count: 'exact', head: true })
    .not('product_line', 'is', null);
  if (cErr) throw new Error(cErr.message);

  console.log(`✓ Verification: ${count.toLocaleString()} products now have product_line populated`);
  console.log(`  Remaining null: ${(products.length - count).toLocaleString()}\n`);
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
