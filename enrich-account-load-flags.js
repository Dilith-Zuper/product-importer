require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchAll, upsertInBatches, makeChangeLogger, changeLogFlag } = require('./lib/utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── Suggested prices derived from real customer pricing medians ───────────────
// Source: us_east_zuper_service.products.csv + us_west_zuper_service.products.csv
// Prices are per the product's native ordering UOM (BD, RL, PC, EA, BX etc.)
const SUGGESTED_PRICES = {
  // Shingles — priced per bundle (BD), 3 bundles = 1 square
  SHINGLES_GOOD:    131.37,   // Timberline HDZ, Duration, Landmark PRO, Cambridge, Heritage
  SHINGLES_BETTER:  158.74,   // UHDZ, Duration MAX, Landmark Premium, Dynasty
  SHINGLES_BEST:    431.02,   // Grand Sequoia, Presidential, Woodmoor, Berkshire, Grand Manor
  SHINGLES_ADDON:    95.00,   // Legacy/specialty — estimated

  // Accessories
  HIP_RIDGE:        183.15,   // per bundle
  STARTER:           82.59,   // per bundle
  UNDERLAYMENT_SYN: 243.46,   // per roll (synthetic)
  UNDERLAYMENT_FELT: 95.08,   // per roll (felt)
  ICE_WATER:        122.22,   // per roll
  DRIP_EDGE:         18.00,   // per piece (10 LF)
  W_VALLEY:          64.38,   // per piece (10 LF)
  STEP_FLASHING:    100.73,   // per piece/bundle
  COIL_NAILS:       109.20,   // per box
  CAP_NAILS:         42.07,   // per box
  PIPE_BOOT:         57.86,   // per each
  RIDGE_VENT:        48.22,   // per piece
  BOX_VENT:          37.88,   // per each
  CAULK:             19.98,   // per tube
  GUTTER:             9.45,   // per piece (10 LF)
};

// ── Universal categories — loaded for every account regardless of brand ───────
// Non-universal: SHINGLES, HIP AND RIDGE, STARTER (brand-specific)
// Gated: SKYLIGHTS, SIDING, COMMERCIAL, DECKING
// Excluded: TOOLS/SAFETY, OTHER (solar/misc)
const UNIVERSAL_CATEGORIES = new Set([
  'UNDERLAYMENT',
  'ICE AND WATER',
  'DRIP EDGE',
  'W-VALLEY',
  'COIL NAILS',
  'PLASTIC CAPS',
  'VENTS',
  'PIPE FLASHING',
  'CAULK',
  'SPRAY PAINT',
  'OTHER FASTENERS',
  'OTHER FLASHING METAL',
  'GUTTER/ALUMINUM/COIL',
  'GUTTER APRON',
]);

// ── Big 3 brands — auto-loaded for every account ─────────────────────────────
const BIG3 = new Set(['Gaf', 'Certainteed', 'Owens Corning']);

// ── Price assignment logic ────────────────────────────────────────────────────
function suggestPrice(product) {
  const cat  = product.product_category;
  const tier = product.family_tier;
  const name = (product.product_name || '').toLowerCase();
  const line = (product.product_line || '').toLowerCase();

  switch (cat) {
    case 'SHINGLES':
      if (tier === 'good')   return SUGGESTED_PRICES.SHINGLES_GOOD;
      if (tier === 'better') return SUGGESTED_PRICES.SHINGLES_BETTER;
      if (tier === 'best')   return SUGGESTED_PRICES.SHINGLES_BEST;
      return SUGGESTED_PRICES.SHINGLES_ADDON;

    case 'HIP AND RIDGE':    return SUGGESTED_PRICES.HIP_RIDGE;
    case 'STARTER':          return SUGGESTED_PRICES.STARTER;

    case 'UNDERLAYMENT':
      if (/felt|#15|#30/i.test(name)) return SUGGESTED_PRICES.UNDERLAYMENT_FELT;
      return SUGGESTED_PRICES.UNDERLAYMENT_SYN;

    case 'ICE AND WATER':    return SUGGESTED_PRICES.ICE_WATER;
    case 'DRIP EDGE':        return SUGGESTED_PRICES.DRIP_EDGE;
    case 'W-VALLEY':         return SUGGESTED_PRICES.W_VALLEY;
    case 'COIL NAILS':       return SUGGESTED_PRICES.COIL_NAILS;
    case 'PLASTIC CAPS':     return SUGGESTED_PRICES.CAP_NAILS;
    case 'PIPE FLASHING':    return SUGGESTED_PRICES.PIPE_BOOT;
    case 'CAULK':            return SUGGESTED_PRICES.CAULK;
    case 'GUTTER/ALUMINUM/COIL': return SUGGESTED_PRICES.GUTTER;
    case 'GUTTER APRON':     return SUGGESTED_PRICES.DRIP_EDGE;

    case 'VENTS':
      if (/ridge/i.test(name)) return SUGGESTED_PRICES.RIDGE_VENT;
      return SUGGESTED_PRICES.BOX_VENT;

    case 'OTHER FLASHING METAL':
      return SUGGESTED_PRICES.STEP_FLASHING;

    default:
      return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Account Load Flags Enrichment ===\n');
  console.log('Columns: is_universal | is_big3_brand | suggested_price\n');

  const logChanges = changeLogFlag();
  const logger = makeChangeLogger({ enabled: logChanges, scriptName: 'account-load-flags' });
  if (logChanges) console.log('Audit logging enabled (--log-changes)\n');

  // When auditing, include the enriched cols in the select so we can diff.
  const cols = logChanges
    ? 'product_id, product_name, product_category, manufacturer_norm, family_tier, product_line, is_universal, is_big3_brand, suggested_price'
    : 'product_id, product_name, product_category, manufacturer_norm, family_tier, product_line';

  const products = await fetchAll(supabase, 'srs_products', cols, {
    onProgress: n => process.stdout.write(`  Loading: ${n} …\r`),
  });
  console.log(`Loaded ${products.length.toLocaleString()} products.\n`);

  // Classify every product
  const enriched = products.map(p => {
    const row = {
      product_id:       p.product_id,
      product_name:     p.product_name,
      product_category: p.product_category,
      is_universal:     UNIVERSAL_CATEGORIES.has(p.product_category),
      is_big3_brand:    BIG3.has(p.manufacturer_norm),
      suggested_price:  suggestPrice(p),
    };
    if (logChanges) {
      logger.log(p.product_id, 'is_universal',    p.is_universal,    row.is_universal);
      logger.log(p.product_id, 'is_big3_brand',   p.is_big3_brand,   row.is_big3_brand);
      logger.log(p.product_id, 'suggested_price', p.suggested_price, row.suggested_price);
    }
    return row;
  });

  // Summary
  const univCount  = enriched.filter(r => r.is_universal).length;
  const big3Count  = enriched.filter(r => r.is_big3_brand).length;
  const pricedCount= enriched.filter(r => r.suggested_price !== null).length;

  console.log(`is_universal   = true  : ${univCount.toLocaleString()} products`);
  console.log(`is_big3_brand  = true  : ${big3Count.toLocaleString()} products`);
  console.log(`suggested_price set    : ${pricedCount.toLocaleString()} products\n`);

  // Spot-check
  console.log('─'.repeat(60));
  console.log('SPOT-CHECK — 3 samples per key category');
  console.log('─'.repeat(60));
  const bycat = {};
  enriched.forEach(r => {
    if (!bycat[r.product_category]) bycat[r.product_category] = [];
    bycat[r.product_category].push(r);
  });
  ['SHINGLES','HIP AND RIDGE','UNDERLAYMENT','DRIP EDGE','VENTS','PIPE FLASHING'].forEach(cat => {
    const items = bycat[cat] || [];
    console.log(`\n[${cat}]`);
    items.slice(0, 3).forEach(r =>
      console.log(`  universal=${String(r.is_universal).padEnd(5)} big3=${String(r.is_big3_brand).padEnd(5)} price=$${(r.suggested_price||0).toFixed(2).padStart(7)}  ${r.product_name.slice(0,50)}`)
    );
  });
  console.log('\n' + '─'.repeat(60) + '\n');

  // Upsert in batches
  console.log('Upserting …');
  const done = await upsertInBatches(supabase, 'srs_products', enriched, {
    onProgress: (d, t) => process.stdout.write(`  ${d.toLocaleString()} / ${t.toLocaleString()} …\r`),
  });

  console.log(`  ${done.toLocaleString()} / ${enriched.length.toLocaleString()} updated ✓\n`);

  if (logChanges && logger.count() > 0) {
    const path = await logger.save();
    console.log(`Audit log: ${logger.count().toLocaleString()} field changes → ${path}\n`);
  }

  console.log('Done.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
