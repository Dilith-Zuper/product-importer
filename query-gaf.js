require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

function table(rows) {
  if (!rows.length) { console.log('  (no rows)'); return; }
  const cols = Object.keys(rows[0]);
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const sep = widths.map(w => '-'.repeat(w + 2)).join('+');
  const fmt = r => cols.map((c, i) => ` ${String(r[c] ?? '').padEnd(widths[i])} `).join('|');
  console.log(sep);
  console.log(cols.map((c, i) => ` ${c.padEnd(widths[i])} `).join('|'));
  console.log(sep);
  rows.forEach(r => console.log(fmt(r)));
  console.log(sep);
  console.log(`  ${rows.length} row(s)\n`);
}

async function main() {

  // ── Query 1: All GAF shingle products with primaryItem flag ───────────────
  console.log('\n── Query 1: All GAF shingle products ──');
  const { data: q1, error: e1 } = await supabase
    .from('srs_products')
    .select('product_name, primary_item, product_image_url')
    .eq('product_category', 'SHINGLES')
    .eq('manufacturer_norm', 'Gaf')
    .eq('exclude_default', false)
    .order('primary_item', { ascending: false })
    .order('product_name');
  if (e1) throw new Error(e1.message);
  table(q1.map(r => ({
    product_name:  r.product_name,
    primary_item:  r.primary_item,
    has_image:     r.product_image_url ? 'YES' : 'NO',
  })));

  // ── Query 2: primary_item counts across all 3 brands ─────────────────────
  console.log('── Query 2: primary_item breakdown across GAF / CertainTeed / Owens Corning ──');
  const { data: q2, error: e2 } = await supabase
    .from('srs_products')
    .select('manufacturer_norm, primary_item')
    .eq('product_category', 'SHINGLES')
    .in('manufacturer_norm', ['Gaf', 'Certainteed', 'Owens Corning'])
    .eq('exclude_default', false);
  if (e2) throw new Error(e2.message);

  const agg = {};
  q2.forEach(r => {
    if (!agg[r.manufacturer_norm]) agg[r.manufacturer_norm] = { total: 0, primary_items: 0 };
    agg[r.manufacturer_norm].total++;
    if (r.primary_item) agg[r.manufacturer_norm].primary_items++;
  });
  table(
    Object.entries(agg)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([manufacturer_norm, v]) => ({ manufacturer_norm, ...v }))
  );
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
