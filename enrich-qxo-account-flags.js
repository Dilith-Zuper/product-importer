/**
 * Enrich qxo_products: is_universal + suggested_price.
 *
 *   - is_universal       — accessory products that auto-load for every account
 *                          regardless of brand selection. Keyed on proposal_line_item.
 *   - suggested_price    — category-tier median prices from real customer data
 *                          (same constants as SRS enrich-account-load-flags.js).
 *
 *   No is_big3_brand column on qxo_products — the wizard's brands route uses a
 *   hardcoded constant for QXO Big 3 detection.
 *
 *   node enrich-qxo-account-flags.js [--log-changes]
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchAll, upsertInBatches, makeChangeLogger, changeLogFlag } = require('./lib/utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const BATCH = 500;

// Same SRS pricing medians — Big 3 brands sell into both distributors.
const PRICE = {
  SHINGLES_GOOD:   131.37, SHINGLES_BETTER: 158.74,
  SHINGLES_BEST:   431.02, SHINGLES_ADDON:   95.00,
  HIP_RIDGE:       183.15, STARTER:          82.59,
  UNDERLAYMENT_SYN:243.46, UNDERLAYMENT_FELT:95.08,
  ICE_WATER:       122.22, DRIP_EDGE:        18.00,
  W_VALLEY:         64.38, STEP_FLASHING:   100.73,
  COIL_NAILS:      109.20, CAP_NAILS:        42.07,
  PIPE_BOOT:        57.86, RIDGE_VENT:       48.22,
  BOX_VENT:         37.88, CAULK:            19.98,
  GUTTER:            9.45,
};

// Universal: auto-load for every account. Keyed by proposal_line_item.
// Non-universal: Shingles / Hip & Ridge Cap / Starter Strip (brand-specific).
// Gated  : Skylight / Siding / Commercial / Roof Decking (only when in scope).
const UNIVERSAL_PLI = new Set([
  'Underlayment — Synthetic',
  'Underlayment — Felt 15#',
  'Underlayment — Felt 30#',
  'Underlayment — Self-Adhered HT',
  'Ice & Water — Standard',
  'Ice & Water — High Temp',
  'Drip Edge',
  'Gutter Apron',
  'W-Valley',
  'Coil Nails',
  'Plastic Cap Nails',
  'Ridge Vent',
  'Box Vent',
  'Soffit Vent',
  'Power Vent / Attic Fan',
  'Dryer / Exhaust Vent Cap',
  'Pipe Boot 2"',
  'Pipe Boot 3"',
  'Pipe Boot 4"',
  'Pipe Boot 6"',
  'Lead Flashing',
  'Caulk / Sealant',
  'Spray Paint',
  'Fasteners',
  'Step Flashing',
  'Counter / Headwall Flashing',
  'Chimney Flashing Kit',
  'Coil Stock / Sheet Metal',
  'Gutter Sections',
  'Downspouts',
  'Gutter End Caps',
  'Gutter Outside Corners',
  'Gutter Inside Corners',
  'Gutter Elbows',
]);

function suggestPrice(p) {
  const pli  = p.proposal_line_item;
  const tier = p.family_tier;
  if (!pli) return null;

  if (pli === 'Shingles') {
    if (tier === 'good')   return PRICE.SHINGLES_GOOD;
    if (tier === 'better') return PRICE.SHINGLES_BETTER;
    if (tier === 'best')   return PRICE.SHINGLES_BEST;
    return PRICE.SHINGLES_ADDON;
  }
  if (pli === 'Hip & Ridge Cap')                return PRICE.HIP_RIDGE;
  if (pli === 'Starter Strip')                  return PRICE.STARTER;
  if (pli.startsWith('Underlayment — Felt'))    return PRICE.UNDERLAYMENT_FELT;
  if (pli.startsWith('Underlayment'))           return PRICE.UNDERLAYMENT_SYN;
  if (pli.startsWith('Ice & Water'))            return PRICE.ICE_WATER;
  if (pli === 'Drip Edge')                      return PRICE.DRIP_EDGE;
  if (pli === 'Gutter Apron')                   return PRICE.DRIP_EDGE;
  if (pli === 'W-Valley')                       return PRICE.W_VALLEY;
  if (pli === 'Coil Nails')                     return PRICE.COIL_NAILS;
  if (pli === 'Plastic Cap Nails')              return PRICE.CAP_NAILS;
  if (pli.startsWith('Pipe Boot'))              return PRICE.PIPE_BOOT;
  if (pli === 'Lead Flashing')                  return PRICE.PIPE_BOOT;
  if (pli === 'Dryer / Exhaust Vent Cap')       return PRICE.PIPE_BOOT;
  if (pli === 'Ridge Vent')                     return PRICE.RIDGE_VENT;
  if (pli === 'Box Vent' || pli === 'Soffit Vent') return PRICE.BOX_VENT;
  if (pli === 'Power Vent / Attic Fan')         return PRICE.BOX_VENT;
  if (pli === 'Caulk / Sealant')                return PRICE.CAULK;
  if (pli === 'Step Flashing')                  return PRICE.STEP_FLASHING;
  if (pli === 'Counter / Headwall Flashing')    return PRICE.STEP_FLASHING;
  if (pli === 'Chimney Flashing Kit')           return PRICE.STEP_FLASHING;
  if (pli === 'Coil Stock / Sheet Metal')       return PRICE.STEP_FLASHING;
  if (pli.startsWith('Gutter') || pli === 'Downspouts') return PRICE.GUTTER;
  return null;
}

async function main() {
  console.log('\n=== QXO Account-load Flags Enrichment ===\n');
  console.log('Columns: is_universal | suggested_price\n');

  const logChanges = changeLogFlag();
  const logger = makeChangeLogger({ enabled: logChanges, scriptName: 'qxo-account-flags' });
  if (logChanges) console.log('Audit logging enabled (--log-changes)\n');

  process.stdout.write('Loading qxo_products …\r');
  const rawProducts = await fetchAll(
    supabase,
    'qxo_products',
    'product_key, product_name, proposal_line_item, family_tier, is_universal, suggested_price',
    {
      orderBy: 'product_key',
      onProgress: n => process.stdout.write(`  qxo_products: ${n.toLocaleString()} rows …\r`),
    },
  );
  process.stdout.write('\n');
  const seen = new Map();
  for (const p of rawProducts) if (!seen.has(p.product_key)) seen.set(p.product_key, p);
  const products = [...seen.values()];
  console.log(`  ${products.length.toLocaleString()} unique products.\n`);

  // ── Classify ─────────────────────────────────────────────────────────────
  const updates = [];
  let univCount = 0;
  let pricedCount = 0;
  for (const p of products) {
    const is_universal    = UNIVERSAL_PLI.has(p.proposal_line_item || '');
    const suggested_price = suggestPrice(p);
    if (is_universal) univCount++;
    if (suggested_price != null) pricedCount++;

    if (logChanges) {
      logger.log(p.product_key, 'is_universal',    p.is_universal,    is_universal);
      logger.log(p.product_key, 'suggested_price', p.suggested_price, suggested_price);
    }
    const oldUniv = !!p.is_universal;
    const oldPrice = p.suggested_price == null ? null : Number(p.suggested_price);
    if (oldUniv !== is_universal || oldPrice !== (suggested_price == null ? null : Number(suggested_price))) {
      updates.push({
        product_key:     p.product_key,
        product_name:    p.product_name,
        is_universal,
        suggested_price,
      });
    }
  }

  console.log('--- Summary ---');
  console.log(`  is_universal=true  : ${univCount.toLocaleString()} / ${products.length.toLocaleString()}`);
  console.log(`  suggested_price set: ${pricedCount.toLocaleString()} / ${products.length.toLocaleString()}`);
  console.log(`  Will update        : ${updates.length.toLocaleString()}`);

  if (updates.length === 0) {
    console.log('\nNothing to write.');
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
    console.log(`\nAudit log: ${logger.count().toLocaleString()} field changes → ${path}`);
  }

  // ── Verify ──────────────────────────────────────────────────────────────
  const { count: univDb } = await supabase
    .from('qxo_products')
    .select('*', { count: 'exact', head: true })
    .eq('is_universal', true);
  const { count: pricedDb } = await supabase
    .from('qxo_products')
    .select('*', { count: 'exact', head: true })
    .not('suggested_price', 'is', null);
  console.log(`\n✓ is_universal=true in DB    : ${univDb?.toLocaleString()}`);
  console.log(`✓ suggested_price set in DB  : ${pricedDb?.toLocaleString()}`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
