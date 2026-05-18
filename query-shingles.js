require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

function table(rows) {
  if (!rows.length) { console.log('  (no rows)'); return; }
  const cols = Object.keys(rows[0]);
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  const line = widths.map(w => '-'.repeat(w + 2)).join('+');
  const fmt  = r => cols.map((c, i) => ` ${String(r[c] ?? '').padEnd(widths[i])} `).join('|');
  console.log(line);
  console.log(cols.map((c, i) => ` ${c.padEnd(widths[i])} `).join('|'));
  console.log(line);
  rows.forEach(r => console.log(fmt(r)));
  console.log(line);
}

async function main() {

  // ── Query 5 FIRST — confirm exact manufacturer_norm values stored ─────────
  console.log('\n── Query 5: Exact manufacturer_norm values for GAF / CertainTeed / Owens Corning ──');
  const { data: q5, error: e5 } = await supabase
    .from('srs_products')
    .select('manufacturer_norm')
    .eq('product_category', 'SHINGLES')
    .or('manufacturer_norm.ilike.%gaf%,manufacturer_norm.ilike.%certainteed%,manufacturer_norm.ilike.%owens%');
  if (e5) throw new Error(e5.message);
  const exactNorms = [...new Set(q5.map(r => r.manufacturer_norm))].sort();
  table(exactNorms.map(v => ({ manufacturer_norm: v })));

  // Use these exact values for all subsequent queries
  const norms = exactNorms;
  console.log(`  → Using: ${norms.join(', ')}\n`);

  // ── Query 1 — Total SHINGLES products for the three brands ────────────────
  console.log('── Query 1: Total SHINGLES products (all three brands combined) ──');
  const { data: q1all, error: e1 } = await supabase
    .from('srs_products')
    .select('product_id')
    .eq('product_category', 'SHINGLES')
    .in('manufacturer_norm', norms)
    .eq('exclude_default', false);
  if (e1) throw new Error(e1.message);
  table([{ total_shingle_products: q1all.length }]);

  // ── Query 2 — Breakdown by brand ─────────────────────────────────────────
  console.log('\n── Query 2: Breakdown by brand ──');
  const { data: q2all, error: e2 } = await supabase
    .from('srs_products')
    .select('manufacturer_norm')
    .eq('product_category', 'SHINGLES')
    .in('manufacturer_norm', norms)
    .eq('exclude_default', false);
  if (e2) throw new Error(e2.message);
  const byBrand = {};
  q2all.forEach(r => { byBrand[r.manufacturer_norm] = (byBrand[r.manufacturer_norm] || 0) + 1; });
  const q2rows = Object.entries(byBrand).map(([manufacturer_norm, products]) => ({ manufacturer_norm, products }))
    .sort((a, b) => b.products - a.products);
  table(q2rows);

  // ── Query 3 — Variants (color options) per brand, excl. restricted ────────
  console.log('\n── Query 3: Products and variants per brand (unrestricted, non-private-label) ──');
  const { data: q3products, error: e3p } = await supabase
    .from('srs_products')
    .select('product_id, manufacturer_norm')
    .eq('product_category', 'SHINGLES')
    .in('manufacturer_norm', norms)
    .eq('exclude_default', false);
  if (e3p) throw new Error(e3p.message);

  const productIds = q3products.map(r => r.product_id);
  const { data: q3variants, error: e3v } = await supabase
    .from('srs_variants')
    .select('variant_id, product_id')
    .in('product_id', productIds)
    .eq('is_restricted', false)
    .eq('is_private_label', false);
  if (e3v) throw new Error(e3v.message);

  // Map product_id → manufacturer_norm
  const pidToNorm = {};
  q3products.forEach(r => { pidToNorm[r.product_id] = r.manufacturer_norm; });

  const q3agg = {};
  norms.forEach(n => { q3agg[n] = { manufacturer_norm: n, products: 0, variants: 0 }; });
  q3products.forEach(r => { q3agg[r.manufacturer_norm].products++; });
  q3variants.forEach(v => {
    const norm = pidToNorm[v.product_id];
    if (norm && q3agg[norm]) q3agg[norm].variants++;
  });
  table(Object.values(q3agg).sort((a, b) => b.products - a.products));

  // ── Query 4 — 10 sample product names ────────────────────────────────────
  console.log('\n── Query 4: Sample — 10 product names included ──');
  const { data: q4, error: e4 } = await supabase
    .from('srs_products')
    .select('product_name, manufacturer_norm, product_image_url')
    .eq('product_category', 'SHINGLES')
    .in('manufacturer_norm', norms)
    .eq('exclude_default', false)
    .order('manufacturer_norm')
    .order('product_name')
    .limit(10);
  if (e4) throw new Error(e4.message);
  table(q4.map(r => ({
    product_name:     r.product_name,
    manufacturer_norm: r.manufacturer_norm,
    has_image:        r.product_image_url ? 'YES' : 'NO',
  })));
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
