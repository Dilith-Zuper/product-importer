/**
 * Enrich qxo_products.product_line.
 *
 *   Derives a short product-line label from product_name by stripping the brand
 *   prefix (using brand_raw / brand_norm) and taking the first 2-3 meaningful
 *   tokens. Mirrors the SRS extractor (enrich-product-line.js) but without the
 *   families table — QXO has no manual family classification yet.
 *
 *   Source : qxo_products.product_name + brand_raw / brand_norm
 *   Target : qxo_products.product_line
 *
 *   Idempotent. Run with --log-changes for audit.
 *
 *   node enrich-qxo-product-line.js [--log-changes]
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchAll, upsertInBatches, makeChangeLogger, changeLogFlag } = require('./lib/utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const BATCH = 500;

// Spec-only single tokens that aren't really product-line words.
const SPEC_ONLY = new Set([
  'ar','ir','xt','hd','non-ar','non-sg','sg','ul','lp',
  'pvc','tpo','epdm','sbs','ht','hc','sa','hp','xd','db','rs','as',
  'bdl','bx','ctn','pc','ea','rl','sq','tb','pal','bag','msf','mlf','lf',
]);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&'); }

// True if the token is "spec only" — pure size/measurement, no semantic value.
// We skip these when scanning for the first meaningful words.
function isSpecToken(w) {
  if (!w) return true;
  // Pure punctuation
  if (/^[\d/.\-x'"”’`#°×+,()]+$/.test(w)) return true;
  // Numeric + unit suffix: 26ga, 16d, 1-1/2", 1/2", 3', 5lb, etc.
  if (/^[\d.\-/]+(ga|d|"|'|lb|kg|in|oz|mm|cm|mil|psi)?$/i.test(w)) return true;
  if (SPEC_ONLY.has(w.toLowerCase())) return true;
  return false;
}

function extractProductLine(name, brandRaw, brandNorm) {
  if (!name) return null;
  let s = name.trim();

  // Strip a leading quote pair if the source CSV embedded the whole name in quotes.
  s = s.replace(/^"(.+)"$/s, '$1').trim();

  // Strip brand prefix (try raw then norm — raw is often the literal in the name).
  for (const b of [brandRaw, brandNorm].filter(Boolean)) {
    const re = new RegExp(`^${escapeRe(b)}\\s+`, 'i');
    if (re.test(s)) { s = s.replace(re, '').trim(); break; }
  }

  // Tokenize. Skip leading spec tokens; take the first 3 meaningful words.
  const words = s.split(/\s+/);
  const out = [];
  let started = false;
  for (const w of words) {
    if (!started && isSpecToken(w)) continue;   // still in the spec prefix
    started = true;
    if (out.length >= 3) break;
    if (out.length >= 2 && SPEC_ONLY.has(w.toLowerCase())) break;
    out.push(w);
  }

  // Fallback: if we couldn't find any meaningful words, take the first 2
  // tokens from the original name so we never return null for a non-empty name.
  if (out.length === 0) {
    const tail = s.split(/\s+/).slice(0, 2).join(' ');
    return tail || null;
  }

  // Strip trailing punctuation on the last token.
  out[out.length - 1] = out[out.length - 1].replace(/[,;:.\-]+$/, '');
  return out.join(' ') || null;
}

async function main() {
  console.log('\n=== QXO product_line Enrichment ===\n');

  const logChanges = changeLogFlag();
  const logger = makeChangeLogger({ enabled: logChanges, scriptName: 'qxo-product-line' });
  if (logChanges) console.log('Audit logging enabled (--log-changes)\n');

  process.stdout.write('Loading qxo_products …\r');
  const cols = 'product_key, product_name, brand_raw, brand_norm, product_line';
  const rawProducts = await fetchAll(supabase, 'qxo_products', cols, {
    orderBy: 'product_key',
    onProgress: n => process.stdout.write(`  qxo_products: ${n.toLocaleString()} rows …\r`),
  });
  process.stdout.write('\n');

  // Defensive dedup by product_key. Pagination boundaries can yield repeats
  // when the underlying order isn't a strict total order on the select cols.
  const seen = new Map();
  for (const p of rawProducts) {
    if (!seen.has(p.product_key)) seen.set(p.product_key, p);
  }
  const products = [...seen.values()];
  console.log(`  ${rawProducts.length.toLocaleString()} rows loaded (${products.length.toLocaleString()} unique product_keys).\n`);

  // ── Compute ───────────────────────────────────────────────────────────────
  const updates = [];
  for (const p of products) {
    const pl = extractProductLine(p.product_name, p.brand_raw, p.brand_norm);
    if (logChanges) logger.log(p.product_key, 'product_line', p.product_line, pl);
    if ((p.product_line || null) !== (pl || null)) {
      updates.push({
        product_key:  p.product_key,
        product_name: p.product_name,
        product_line: pl,
      });
    }
  }

  // ── Spot-check by brand_norm (top 8) ──────────────────────────────────────
  console.log('─'.repeat(80));
  console.log('SPOT-CHECK — 5 samples per top brand');
  console.log('─'.repeat(80));
  const byBrand = new Map();
  for (let i = 0; i < products.length; i++) {
    const b = products[i].brand_norm || '(none)';
    if (!byBrand.has(b)) byBrand.set(b, []);
    byBrand.get(b).push({
      ...products[i],
      product_line: extractProductLine(products[i].product_name, products[i].brand_raw, products[i].brand_norm),
    });
  }
  const top = [...byBrand.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8);
  for (const [brand, items] of top) {
    console.log(`\n[${brand}]  (${items.length} products)`);
    for (const p of items.slice(0, 5)) {
      const line = (p.product_line || '∅').padEnd(28).slice(0, 28);
      const name = (p.product_name || '').slice(0, 60);
      console.log(`  ${line}  ← ${name}`);
    }
  }
  console.log('─'.repeat(80));

  console.log(`\nWill update ${updates.length.toLocaleString()} of ${products.length.toLocaleString()} products.`);
  if (updates.length === 0) {
    console.log('Nothing to write. Done.');
    return;
  }

  console.log(`\nWriting (batches of ${BATCH}) …`);
  await upsertInBatches(supabase, 'qxo_products', updates, {
    batchSize:  BATCH,
    onConflict: 'product_key',
    onProgress: (d, t) => process.stdout.write(`  ${d}/${t}\r`),
  });
  process.stdout.write('\n');

  if (logChanges && logger.count() > 0) {
    const path = await logger.save();
    console.log(`\nAudit log: ${logger.count().toLocaleString()} changes → ${path}`);
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  const { count, error } = await supabase
    .from('qxo_products')
    .select('*', { count: 'exact', head: true })
    .not('product_line', 'is', null);
  if (error) throw new Error(`Verify: ${error.message}`);
  console.log(`\n✓ ${count?.toLocaleString()} products have product_line populated.`);
  console.log(`  Null remaining: ${(products.length - (count ?? 0)).toLocaleString()}`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
