require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const CATEGORIES = [
  'UNDERLAYMENT','HIP AND RIDGE','STARTER','DRIP EDGE','VENTS',
  'PIPE FLASHING','COIL NAILS','ICE AND WATER','TOOLS/SAFETY',
  'OTHER FASTENERS','GUTTER/ALUMINUM/COIL','SIDING','SKYLIGHTS',
  'W-VALLEY','SPRAY PAINT','CAULK',
];

const top = (counter, n = 10) =>
  Object.entries(counter).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([k,v])=>`${k}(${v})`);

async function fetchAll(category) {
  // Products
  const { data: products, error: pe } = await supabase
    .from('srs_products')
    .select('product_id, product_name, manufacturer_norm')
    .eq('product_category', category)
    .eq('exclude_default', false);
  if (pe) throw new Error(`Products ${category}: ${pe.message}`);

  const pids = products.map(p => p.product_id);
  if (!pids.length) return { products, variants: [] };

  // Variants — fetch in pages of 1000
  let variants = [], from = 0, done = false;
  while (!done) {
    const { data: vpage, error: ve } = await supabase
      .from('srs_variants')
      .select('variant_id, product_id, color_name, size_name, order_uom')
      .in('product_id', pids)
      .eq('is_restricted', false)
      .range(from, from + 999);
    if (ve) throw new Error(`Variants ${category}: ${ve.message}`);
    variants.push(...vpage);
    done = vpage.length < 1000;
    from += 1000;
  }
  return { products, variants };
}

function analyze(category, products, variants) {
  const brandCount = {};
  const sampleProducts = [];
  const productMap = {};
  products.forEach(p => {
    brandCount[p.manufacturer_norm] = (brandCount[p.manufacturer_norm] || 0) + 1;
    productMap[p.product_id] = p;
    if (sampleProducts.length < 10) sampleProducts.push(p.product_name);
  });

  const colorCount = {}, sizeCount = {}, uomCount = {};
  variants.forEach(v => {
    const c = (v.color_name || '').trim();
    const s = (v.size_name  || '').trim();
    const u = (v.order_uom  || '').trim();
    if (c) colorCount[c] = (colorCount[c] || 0) + 1;
    if (s) sizeCount[s]  = (sizeCount[s]  || 0) + 1;
    if (u) uomCount[u]   = (uomCount[u]   || 0) + 1;
  });

  const avgVariants = products.length ? (variants.length / products.length).toFixed(1) : 0;

  return {
    category,
    productCount:  products.length,
    brandCount:    Object.keys(brandCount).length,
    uniqueColors:  Object.keys(colorCount).length,
    uniqueSizes:   Object.keys(sizeCount).length,
    totalVariants: variants.length,
    avgVariants,
    topBrands:     top(brandCount, 5),
    topColors:     top(colorCount, 10),
    topSizes:      top(sizeCount, 10),
    topUoms:       top(uomCount, 5),
    sampleProducts,
  };
}

async function main() {
  const results = [];
  for (const cat of CATEGORIES) {
    process.stdout.write(`Fetching ${cat} …\r`);
    const { products, variants } = await fetchAll(cat);
    results.push(analyze(cat, products, variants));
  }
  console.log('\n');

  // ── Per-category output ──────────────────────────────────────────────────
  for (const r of results) {
    console.log('━'.repeat(72));
    console.log(`CATEGORY: ${r.category}`);
    console.log(`  Products: ${r.productCount} | Brands: ${r.brandCount} | Variants: ${r.totalVariants} | Avg variants/product: ${r.avgVariants}`);
    console.log(`  Unique sizes: ${r.uniqueSizes} | Unique colors: ${r.uniqueColors}`);
    console.log(`  Top brands:  ${r.topBrands.join(' | ')}`);
    console.log(`  Top sizes:   ${r.topSizes.join(' | ')}`);
    console.log(`  Top colors:  ${r.topColors.join(' | ')}`);
    console.log(`  Top UoMs:    ${r.topUoms.join(' | ')}`);
    console.log(`  Sample products:`);
    r.sampleProducts.forEach(n => console.log(`    • ${n}`));
    console.log();
  }

  // ── Raw data for master table (JSON for reference) ───────────────────────
  console.log('\n═══ RAW STATS (copy for analysis) ═══');
  results.forEach(r => {
    console.log(JSON.stringify({
      category: r.category,
      products: r.productCount,
      brands: r.brandCount,
      sizes: r.uniqueSizes,
      colors: r.uniqueColors,
      variants: r.totalVariants,
      avg: r.avgVariants,
      topBrands: r.topBrands.slice(0,5),
      topSizes: r.topSizes.slice(0,5),
      topColors: r.topColors.slice(0,3),
    }));
  });
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
