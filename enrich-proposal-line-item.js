require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchAll, upsertInBatches, makeChangeLogger, changeLogFlag } = require('./lib/utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const PAGE       = 1000;
const BATCH_SIZE = 500;

function classifyProduct(product, variantSizes) {
  const name = product.product_name.toLowerCase();
  const cat  = product.product_category;

  switch (cat) {
    case 'SHINGLES':          return 'Shingles';
    case 'HIP AND RIDGE':     return 'Hip & Ridge Cap';
    case 'STARTER':           return 'Starter Strip';
    case 'DRIP EDGE':         return 'Drip Edge';
    case 'W-VALLEY':          return 'W-Valley';
    case 'COIL NAILS':        return 'Coil Nails';
    case 'PLASTIC CAPS':      return 'Plastic Cap Nails';
    case 'SKYLIGHTS':         return 'Skylight';
    case 'CAULK':             return 'Caulk / Sealant';
    case 'GUTTER APRON':      return 'Gutter Apron';
    case 'SPRAY PAINT':       return 'Spray Paint';
    case 'OTHER FASTENERS':   return 'Fasteners';
    case 'SIDING':            return 'Siding';
    case 'COMMERCIAL':        return 'Commercial Membrane (TPO/EPDM)';
    case 'DECKING':           return 'Roof Decking (OSB)';
    case 'TOOLS/SAFETY':      return null; // excluded

    case 'UNDERLAYMENT':
      if (/self.?adhered|high.?temp|\bht\b/i.test(name))      return 'Underlayment — Self-Adhered HT';
      if (/felt.*30|30.*felt|#30|30#/i.test(name))            return 'Underlayment — Felt 30#';
      if (/felt.*15|15.*felt|#15|15#/i.test(name))            return 'Underlayment — Felt 15#';
      return 'Underlayment — Synthetic';

    case 'ICE AND WATER':
      if (/high.?temp|\bht\b/i.test(name)) return 'Ice & Water — High Temp';
      return 'Ice & Water — Standard';

    case 'VENTS':
      if (/power|electric|solar.?attic|attic.?fan/i.test(name)) return 'Power Vent / Attic Fan';
      if (/ridge/i.test(name))                                   return 'Ridge Vent';
      if (/soffit/i.test(name))                                  return 'Soffit Vent';
      return 'Box Vent';

    case 'PIPE FLASHING': {
      if (/\blead\b/i.test(name))                                        return 'Lead Flashing';
      if (/vent cap|gooseneck|dryer|exhaust|damper/i.test(name))         return 'Dryer / Exhaust Vent Cap';
      // Size-based pipe boot classification — count variant occurrences per size
      // rather than treating any presence as "this product is this size". A product
      // with 100x 4" boots and 1x 3" boot is a 4" product, not a 3" product.
      const counts = { 2: 0, 3: 0, 4: 0, 6: 0 };
      for (const s of variantSizes) {
        if (/^2"/.test(s)) counts[2]++;
        else if (/^3"/.test(s)) counts[3]++;
        else if (/^4"/.test(s)) counts[4]++;
        else if (/^6"/.test(s)) counts[6]++;
      }
      const present = Object.entries(counts).filter(([, n]) => n > 0);
      if (present.length === 0) return 'Pipe Boot 3"'; // fallback — no size info
      // Pick size with max count; tie-break by residential priority 3 > 4 > 2 > 6
      const priority = { 3: 4, 4: 3, 2: 2, 6: 1 };
      present.sort((a, b) => b[1] - a[1] || priority[b[0]] - priority[a[0]]);
      return `Pipe Boot ${present[0][0]}"`;
    }

    case 'GUTTER/ALUMINUM/COIL':
      if (/\bdownspout\b/i.test(name))       return 'Downspouts';
      if (/end cap/i.test(name))             return 'Gutter End Caps';
      if (/outside miter|outside corner/i.test(name)) return 'Gutter Outside Corners';
      if (/inside miter|inside corner/i.test(name))   return 'Gutter Inside Corners';
      if (/\belbow\b/i.test(name))           return 'Gutter Elbows';
      if (/\bgutter\b/i.test(name))          return 'Gutter Sections';
      return 'Coil Stock / Sheet Metal';

    case 'OTHER FLASHING METAL':
      if (/chimney/i.test(name))                         return 'Chimney Flashing Kit';
      if (/\bstep\b/i.test(name))                        return 'Step Flashing';
      if (/headwall|counter.?flash|wall flash/i.test(name)) return 'Counter / Headwall Flashing';
      if (/coil|flat sheet|roll/i.test(name))            return 'Coil Stock / Sheet Metal';
      return 'Step Flashing'; // most common flashing type

    default:
      return null; // OTHER, etc. — no line item
  }
}

async function fetchVariantSizes(productIds) {
  const map = {};
  const chunks = [];
  for (let i = 0; i < productIds.length; i += 500) chunks.push(productIds.slice(i, i + 500));
  for (const chunk of chunks) {
    let cf = 0;
    while (true) {
      const { data, error } = await supabase
        .from('srs_variants')
        .select('product_id, size_name')
        .in('product_id', chunk)
        .eq('is_restricted', false)
        .range(cf, cf + PAGE - 1);
      if (error) throw new Error(error.message);
      data.forEach(v => {
        if (!map[v.product_id]) map[v.product_id] = [];
        if (v.size_name?.trim()) map[v.product_id].push(v.size_name.trim());
      });
      if (data.length < PAGE) break;
      cf += PAGE;
    }
  }
  return map;
}

async function main() {
  console.log('\n=== Proposal Line Item Enrichment ===\n');

  const logChanges = changeLogFlag();
  const logger = makeChangeLogger({ enabled: logChanges, scriptName: 'proposal-line-item' });
  if (logChanges) console.log('Audit logging enabled (--log-changes)\n');

  const cols = logChanges
    ? 'product_id, product_name, product_category, proposal_line_item'
    : 'product_id, product_name, product_category';
  const products = await fetchAll(supabase, 'srs_products', cols, {
    onProgress: n => process.stdout.write(`  Loading products: ${n} …\r`),
  });
  console.log(`Loaded ${products.length.toLocaleString()} products.\n`);

  // Only need variant sizes for PIPE FLASHING products
  const pipeFlasingIds = products
    .filter(p => p.product_category === 'PIPE FLASHING')
    .map(p => p.product_id);

  process.stdout.write('Loading pipe flashing variant sizes …\r');
  const variantSizeMap = await fetchVariantSizes(pipeFlasingIds);
  console.log(`Loaded variant sizes for ${pipeFlasingIds.length} pipe flashing products.\n`);

  // Classify every product
  const enriched = products.map(p => {
    const newVal = classifyProduct(p, variantSizeMap[p.product_id] || []);
    if (logChanges) logger.log(p.product_id, 'proposal_line_item', p.proposal_line_item, newVal);
    return {
      product_id:         p.product_id,
      product_name:       p.product_name,
      product_category:   p.product_category,
      proposal_line_item: newVal,
    };
  });

  // Distribution summary
  const dist = {};
  enriched.forEach(r => {
    const k = r.proposal_line_item || '(none)';
    dist[k] = (dist[k] || 0) + 1;
  });
  console.log('Line item distribution:');
  Object.entries(dist).sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));
  console.log();

  // Upsert in batches of 500
  console.log(`Upserting proposal_line_item …`);
  const done = await upsertInBatches(supabase, 'srs_products', enriched, {
    batchSize: BATCH_SIZE,
    onProgress: (d, t) => process.stdout.write(`  ${d.toLocaleString()} / ${t.toLocaleString()} …\r`),
  });

  console.log(`  ${done.toLocaleString()} / ${enriched.length.toLocaleString()} updated ✓\n`);

  if (logChanges && logger.count() > 0) {
    const path = await logger.save();
    console.log(`Audit log: ${logger.count().toLocaleString()} proposal_line_item changes → ${path}\n`);
  }

  console.log('Done.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
