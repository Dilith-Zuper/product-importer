/**
 * Identify SRS products for the two known accessory-catalog gaps:
 *   1. Counter / Headwall Flashing — no entry in zuper-importer/lib/accessory-catalog.ts
 *   2. Plastic Cap Nails — present (91472) but currently classified under 'Fasteners'
 *      proposal_line_item, not 'Plastic Cap Nails'
 *
 * Run: `node find-accessory-gaps.js`
 * Output: top 5 candidates per gap, ordered by primary_item + non-restricted variant count.
 *
 * After picking IDs, add them to:
 *   D:\OneDrive - Zuper,inc\Documents\Projects\zuper-importer\lib\accessory-catalog.ts
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const TARGETS = [
  { slot: 'Counter / Headwall Flashing', proposalLineItem: 'Counter / Headwall Flashing' },
  { slot: 'Plastic Cap Nails',           proposalLineItem: 'Plastic Cap Nails' },
];

async function main() {
  console.log('\n=== Accessory Gap Finder ===\n');

  for (const { slot, proposalLineItem } of TARGETS) {
    console.log(`\n── ${slot} (proposal_line_item = "${proposalLineItem}") ──`);

    const { data, error } = await supabase
      .from('srs_products')
      .select('product_id, product_name, manufacturer_norm, product_category, primary_item, suggested_price, family_tier')
      .eq('proposal_line_item', proposalLineItem)
      .eq('exclude_default', false)
      .order('primary_item', { ascending: false })
      .order('manufacturer_norm', { ascending: true })
      .limit(20);

    if (error) {
      console.error('  ERROR:', error.message);
      continue;
    }

    if (!data?.length) {
      console.log('  (no matches — try a broader query below)');

      // Broader fallback: search by category + name keyword
      const keyword = slot.toLowerCase().includes('counter') ? '%headwall%' :
                      slot.toLowerCase().includes('plastic')  ? '%plastic cap%' :
                      `%${slot}%`;
      const cat = slot.toLowerCase().includes('plastic') ? 'PLASTIC CAPS' : 'OTHER FLASHING METAL';
      const { data: fb } = await supabase
        .from('srs_products')
        .select('product_id, product_name, manufacturer_norm, product_category, primary_item, suggested_price')
        .eq('product_category', cat)
        .ilike('product_name', keyword)
        .eq('exclude_default', false)
        .order('primary_item', { ascending: false })
        .limit(10);

      console.log(`  Fallback search (category=${cat}, name ILIKE '${keyword}'):`);
      for (const p of fb ?? []) {
        console.log(`    ${p.primary_item ? '★' : ' '} ${String(p.product_id).padStart(7)}  [${p.manufacturer_norm}] ${p.product_name}  $${p.suggested_price ?? '—'}`);
      }
      continue;
    }

    console.log(`  ${data.length} candidates (showing top 20):`);
    for (const p of data) {
      const mark = p.primary_item ? '★' : ' ';
      const price = p.suggested_price ? `$${p.suggested_price}` : '—';
      console.log(`    ${mark} ${String(p.product_id).padStart(7)}  [${p.manufacturer_norm}] ${p.product_name}  (${price}, tier=${p.family_tier ?? 'none'})`);
    }

    console.log('\n  Recommended (lowest-impact pick):');
    const rec = data.find(p => p.primary_item) ?? data[0];
    if (rec) {
      console.log(`    ${rec.product_id} — ${rec.product_name} [${rec.manufacturer_norm}]`);
      console.log(`\n    Add to accessory-catalog.ts:`);
      console.log(`      ${rec.product_id},  // ${rec.manufacturer_norm} — ${rec.product_name}`);
    }
  }

  console.log('\nDone.\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
