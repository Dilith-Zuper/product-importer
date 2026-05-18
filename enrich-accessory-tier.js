/**
 * enrich-accessory-tier.js
 *
 * Problem:
 *   74% of products land in `family_tier='better'` because that's the default
 *   bucket for accessories with no brand-line rule. The tier signal collapses
 *   when ~14,750 products share a single value, so proposal builders can't
 *   meaningfully filter "this is a basic accessory vs a premium one".
 *
 * Fix:
 *   Add a parallel `accessory_tier` column. For products in family_tier='better',
 *   split into 3 price-quartile bands within (product_category, manufacturer_norm):
 *     bottom 33% → good_accessory     (cheapest commodity)
 *     middle 33% → better_accessory   (popular middle)
 *     top 33%    → best_accessory     (premium / branded)
 *   Products outside family_tier='better' are NOT touched — shingles stay
 *   tiered good/better/best, addons stay addons.
 *
 *   Products with no suggested_price land in 'better_accessory' (safe default
 *   for the unpriced majority — they appear in all 3 proposal tiers as today).
 *
 * Prerequisite (run once in Supabase SQL Editor):
 *   ALTER TABLE srs_products ADD COLUMN IF NOT EXISTS accessory_tier TEXT;
 *   CREATE INDEX IF NOT EXISTS idx_accessory_tier ON srs_products(accessory_tier);
 *
 * Usage:
 *   node enrich-accessory-tier.js               (apply)
 *   node enrich-accessory-tier.js --log-changes (apply + write audit log)
 *   node enrich-accessory-tier.js --dry-run     (print distribution, no write)
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchAll, upsertInBatches, makeChangeLogger, changeLogFlag } = require('./lib/utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const DRY_RUN = process.argv.includes('--dry-run');

function classifyByQuartiles(products) {
  // Group by (category | brand). Each group sorted by suggested_price asc;
  // products without a price kept in a separate bucket → 'better_accessory'.
  const byGroup = new Map();
  for (const p of products) {
    const key = `${p.product_category}||${p.manufacturer_norm ?? 'unknown'}`;
    if (!byGroup.has(key)) byGroup.set(key, { priced: [], unpriced: [] });
    if (p.suggested_price != null && p.suggested_price > 0) byGroup.get(key).priced.push(p);
    else byGroup.get(key).unpriced.push(p);
  }

  const out = new Map(); // product_id → 'good_accessory' | 'better_accessory' | 'best_accessory'
  for (const { priced, unpriced } of byGroup.values()) {
    for (const p of unpriced) out.set(p.product_id, 'better_accessory');

    priced.sort((a, b) => a.suggested_price - b.suggested_price);
    const n = priced.length;
    if (n === 0) continue;
    if (n <= 2) {
      // Too few priced examples — call them all 'better_accessory'.
      for (const p of priced) out.set(p.product_id, 'better_accessory');
      continue;
    }
    const thirdsCut = Math.floor(n / 3);
    const twoThirdsCut = Math.floor((2 * n) / 3);
    priced.forEach((p, idx) => {
      if (idx < thirdsCut) out.set(p.product_id, 'good_accessory');
      else if (idx < twoThirdsCut) out.set(p.product_id, 'better_accessory');
      else out.set(p.product_id, 'best_accessory');
    });
  }
  return out;
}

async function main() {
  console.log('\n=== Accessory Tier Enrichment ===\n');

  const logChanges = changeLogFlag();
  const logger = makeChangeLogger({ enabled: logChanges, scriptName: 'accessory-tier' });
  if (logChanges) console.log('Audit logging enabled (--log-changes)\n');
  if (DRY_RUN) console.log('DRY RUN — no writes\n');

  const cols = 'product_id, product_name, product_category, manufacturer_norm, family_tier, suggested_price, accessory_tier';
  const all = await fetchAll(supabase, 'srs_products', cols, {
    onProgress: n => process.stdout.write(`  Loading: ${n} …\r`),
  });
  console.log(`Loaded ${all.length.toLocaleString()} products.\n`);

  // Only reclassify products currently tagged 'better'. Other tiers keep
  // accessory_tier = null (signal: "use family_tier, not accessory_tier").
  const target = all.filter(p => p.family_tier === 'better');
  console.log(`${target.length.toLocaleString()} products in family_tier='better' to classify.\n`);

  const assignments = classifyByQuartiles(target);

  // Build upsert payload
  const rows = target.map(p => {
    const newTier = assignments.get(p.product_id) ?? 'better_accessory';
    if (logChanges) logger.log(p.product_id, 'accessory_tier', p.accessory_tier, newTier);
    return {
      product_id: p.product_id,
      product_name: p.product_name,
      product_category: p.product_category,
      accessory_tier: newTier,
    };
  });

  // Distribution
  const dist = {};
  for (const r of rows) dist[r.accessory_tier] = (dist[r.accessory_tier] ?? 0) + 1;
  console.log('New accessory_tier distribution:');
  for (const [tier, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tier.padEnd(18)}: ${n.toLocaleString()}`);
  }
  console.log();

  // Spot-check by category
  console.log('SPOT-CHECK — top groups by accessory_tier distribution:');
  const groups = {};
  for (const p of target) {
    const key = p.product_category;
    if (!groups[key]) groups[key] = { good_accessory: 0, better_accessory: 0, best_accessory: 0 };
    groups[key][assignments.get(p.product_id) ?? 'better_accessory']++;
  }
  Object.entries(groups)
    .sort((a, b) => (b[1].good_accessory + b[1].better_accessory + b[1].best_accessory) - (a[1].good_accessory + a[1].better_accessory + a[1].best_accessory))
    .slice(0, 10)
    .forEach(([cat, d]) => {
      console.log(`  ${cat.padEnd(24)} good=${String(d.good_accessory).padStart(4)} better=${String(d.better_accessory).padStart(4)} best=${String(d.best_accessory).padStart(4)}`);
    });
  console.log();

  if (DRY_RUN) {
    console.log('Dry run — exiting without write.\n');
    return;
  }

  console.log('Upserting accessory_tier …');
  const done = await upsertInBatches(supabase, 'srs_products', rows, {
    onProgress: (d, t) => process.stdout.write(`  ${d.toLocaleString()} / ${t.toLocaleString()} …\r`),
  });
  console.log(`  ${done.toLocaleString()} / ${rows.length.toLocaleString()} updated ✓\n`);

  if (logChanges && logger.count() > 0) {
    const path = await logger.save();
    console.log(`Audit log: ${logger.count().toLocaleString()} changes → ${path}\n`);
  }

  console.log('Done.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
