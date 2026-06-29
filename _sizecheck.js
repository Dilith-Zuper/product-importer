require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchAll } = require('./lib/utils');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const real = s => s && String(s).trim() && !['n/a','na'].includes(String(s).trim().toLowerCase());
(async () => {
  const v = await fetchAll(supabase, 'srs_variants', 'product_id,color_name,size_name,is_restricted',
    { filters: [{ op: 'eq', args: ['is_restricted', false] }], orderBy: 'variant_id' });
  const byPid = new Map();
  for (const r of v) {
    const e = byPid.get(r.product_id) || { colors: new Set(), sizes: new Set() };
    if (real(r.color_name)) e.colors.add(r.color_name.trim());
    if (real(r.size_name)) e.sizes.add(r.size_name.trim());
    byPid.set(r.product_id, e);
  }
  let colorMulti=0, sizeOnlyMulti=0, both=0, neither=0;
  for (const [,e] of byPid) {
    const c = e.colors.size, s = e.sizes.size;
    if (c>1 && s>1) both++;
    else if (c>1) colorMulti++;
    else if (s>1) sizeOnlyMulti++;
    else neither++;
  }
  console.log('products with multiple COLORS (no multi-size):', colorMulti);
  console.log('products with multiple SIZES but NOT multiple colors (size-only):', sizeOnlyMulti);
  console.log('products with BOTH multi color & multi size:', both);
  console.log('products with neither (single variant / N/A):', neither);
  console.log('total products with variants:', byPid.size);
})().catch(e => { console.error(e.message); process.exit(1); });
