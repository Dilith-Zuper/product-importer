require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ExcelJS = require('exceljs');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const THRESHOLD = 50; // "more than 50 options"

// Paginate past Supabase's hard 1000-row cap.
async function fetchAll(table, select, tune) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (tune) q = tune(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

async function main() {
  // Exact server-side counts for reconciliation
  const { count: totalVariants } = await supabase
    .from('srs_variants').select('*', { count: 'exact', head: true });
  const { count: restrictedTrue } = await supabase
    .from('srs_variants').select('*', { count: 'exact', head: true }).eq('is_restricted', true);
  console.log(`Server counts → total variants: ${totalVariants}, is_restricted=true: ${restrictedTrue}`);

  console.log('Fetching all products…');
  const products = await fetchAll(
    'srs_products',
    'product_id, product_name, product_category, manufacturer_norm'
  );
  console.log(`  ${products.length} products`);

  // Pull EVERY variant with its flags — filter in JS so NULL is_restricted is NOT dropped.
  console.log('Fetching ALL variants (unfiltered)…');
  const allVariants = await fetchAll(
    'srs_variants',
    'product_id, is_restricted, color_name, size_name, variant_code'
  );
  console.log(`  ${allVariants.length} variants pulled`);

  const unrestricted = allVariants.filter(v => v.is_restricted !== true);
  console.log(`  ${unrestricted.length} unrestricted (is_restricted !== true)`);

  // Count options (= distinct selectable color/size variants) per product.
  const counts = new Map();
  const samplesByPid = new Map();
  for (const v of unrestricted) {
    counts.set(v.product_id, (counts.get(v.product_id) || 0) + 1);
    if (!samplesByPid.has(v.product_id)) samplesByPid.set(v.product_id, []);
    const s = samplesByPid.get(v.product_id);
    if (s.length < 6) s.push(v);
  }

  const rows = products
    .map(p => ({
      product_name: p.product_name,
      product_id: p.product_id,
      category: p.product_category,
      manufacturer: p.manufacturer_norm,
      num_options: counts.get(p.product_id) || 0,
    }))
    .filter(r => r.num_options > THRESHOLD)
    .sort((a, b) => b.num_options - a.num_options);

  console.log(`\n${rows.length} products have more than ${THRESHOLD} options.`);

  // ── Build Excel ──────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();

  // Sheet 1: the full list
  const ws = wb.addWorksheet('50+ Options');
  ws.columns = [
    { header: 'Item Name', key: 'product_name', width: 60 },
    { header: 'SRS Product ID', key: 'product_id', width: 16 },
    { header: 'Number of Options', key: 'num_options', width: 18 },
    { header: 'Category', key: 'category', width: 24 },
    { header: 'Manufacturer', key: 'manufacturer', width: 28 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F3' } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: 'E1' };
  rows.forEach(r => ws.addRow(r));

  // Sheet 2: examples — top products expanded into a few of their actual options
  const ex = wb.addWorksheet('Examples');
  ex.columns = [
    { header: 'Item Name', key: 'product_name', width: 55 },
    { header: 'SRS Product ID', key: 'product_id', width: 16 },
    { header: 'Total Options', key: 'num_options', width: 14 },
    { header: 'Example SKU', key: 'variant_code', width: 22 },
    { header: 'Color', key: 'color_name', width: 26 },
    { header: 'Size', key: 'size_name', width: 22 },
  ];
  ex.getRow(1).font = { bold: true };
  ex.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F3' } };
  ex.views = [{ state: 'frozen', ySplit: 1 }];
  // take the top 8 products and show up to 6 sample options each
  rows.slice(0, 8).forEach(r => {
    const samples = samplesByPid.get(r.product_id) || [];
    samples.forEach((v, i) => {
      ex.addRow({
        product_name: i === 0 ? r.product_name : '',
        product_id: i === 0 ? r.product_id : '',
        num_options: i === 0 ? r.num_options : '',
        variant_code: v.variant_code,
        color_name: v.color_name,
        size_name: v.size_name,
      });
    });
    ex.addRow({}); // spacer between products
  });

  const out = 'SRS Products with 50+ Options.xlsx';
  await wb.xlsx.writeFile(out);
  console.log(`\nWrote ${out}  (Sheet 1: full list, Sheet 2: examples)`);

  console.log('\nTop 15:');
  rows.slice(0, 15).forEach(r =>
    console.log(`  ${String(r.num_options).padStart(4)}  [${r.product_id}]  ${r.product_name}`)
  );
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
