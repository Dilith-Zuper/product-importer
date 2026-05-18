require('dotenv').config();
const ExcelJS = require('exceljs');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const OUT_FILE = path.join(__dirname, 'Atlas Roofing Catalog.xlsx');
const PAGE     = 1000;

const csv = v => Array.isArray(v) ? v.filter(Boolean).join(', ') : (v || '');

async function getVariantsForProducts(productIds) {
  if (!productIds.length) return [];
  const rows = []; let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('srs_variants')
      .select('variant_id,product_id,variant_code,order_uom,color_name,size_name,uoms,variant_image_url')
      .in('product_id', productIds)
      .eq('is_restricted', false)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

function buildVariantSummary(variants) {
  const map = {};
  for (const v of variants) {
    if (!map[v.product_id]) map[v.product_id] = { colors: new Set(), sizes: new Set(), skus: [], uoms: new Set(), count: 0, imageUrl: null };
    const s = map[v.product_id];
    s.count++;
    if (v.color_name?.trim()) s.colors.add(v.color_name.trim());
    if (v.size_name?.trim())  s.sizes.add(v.size_name.trim());
    if (v.variant_code)       s.skus.push(v.variant_code);
    if (v.uoms)               v.uoms.forEach(u => s.uoms.add(u));
    if (v.variant_image_url && !s.imageUrl) s.imageUrl = v.variant_image_url;
  }
  return map;
}

const COLUMNS = [
  { header: 'Category',         key: 'category',      width: 22 },
  { header: 'Brand',            key: 'brand',         width: 16 },
  { header: 'Product Name',     key: 'product_name',  width: 52 },
  { header: '# Variants',       key: 'variant_count', width: 11 },
  { header: 'Available Colors', key: 'colors',        width: 55 },
  { header: 'Available Sizes',  key: 'sizes',         width: 30 },
  { header: 'Order UOM(s)',     key: 'uoms',          width: 18 },
  { header: 'Sample SKUs',      key: 'skus',          width: 35 },
  { header: 'Product UOM',      key: 'product_uom',   width: 15 },
  { header: 'Description',      key: 'description',   width: 65 },
  { header: 'Image URL',        key: 'image_url',     width: 45 },
];

const CAT_COLORS = {
  'SHINGLES':        'FFEAF4FB',
  'HIP AND RIDGE':   'FFEAFAF1',
  'STARTER':         'FFEAFAF1',
  'UNDERLAYMENT':    'FFF5EEF8',
  'ICE AND WATER':   'FFEAF4FB',
  'VENTS':           'FFFFFDE7',
  'COMMERCIAL':      'FFFDF2F8',
  'TOOLS/SAFETY':    'FFF8F9FA',
  'OTHER FASTENERS': 'FFF8F9FA',
};

async function main() {
  console.log('\n=== Atlas Catalog Export ===\n');

  // Fetch all Atlas products
  console.log('Fetching all Atlas products …');
  const { data: products, error } = await supabase
    .from('srs_products')
    .select('product_id,product_name,product_category,manufacturer,product_description,product_uom,product_image_url')
    .eq('manufacturer_norm', 'Atlas')
    .order('product_category')
    .order('product_name');
  if (error) throw new Error(error.message);
  console.log(`  ✓ ${products.length} Atlas products found\n`);

  // Fetch variants
  console.log('Fetching variants …');
  const variants = await getVariantsForProducts(products.map(p => p.product_id));
  const vSummary = buildVariantSummary(variants);
  console.log(`  ✓ ${variants.length} variants fetched\n`);

  // Build rows
  const rows = products.map(p => {
    const v = vSummary[p.product_id] || {};
    return {
      category:      p.product_category,
      brand:         p.manufacturer || 'Atlas',
      product_name:  p.product_name,
      variant_count: v.count || 0,
      colors:        [...(v.colors || [])].join(', '),
      sizes:         [...(v.sizes  || [])].join(', '),
      uoms:          [...(v.uoms   || [])].join(', '),
      skus:          (v.skus || []).slice(0, 4).join(', '),
      product_uom:   csv(p.product_uom),
      description:   p.product_description ? p.product_description.slice(0, 250) : '',
      image_url:     v.imageUrl || p.product_image_url || '',
    };
  });

  // Build workbook
  console.log('Building workbook …');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SRS Product Importer'; wb.created = new Date();

  const ws = wb.addWorksheet('Atlas Catalog', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.width }));

  // Header row
  const hRow = ws.getRow(1);
  hRow.height = 22;
  hRow.eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border    = { bottom: { style: 'medium', color: { argb: 'FF4A90D9' } } };
  });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };

  // Data rows
  rows.forEach(r => {
    const row = ws.addRow(COLUMNS.map(c => r[c.key] ?? ''));
    const bg  = CAT_COLORS[r.category] || 'FFFFFFFF';
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font      = { size: 9, name: 'Calibri' };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { vertical: 'top', wrapText: false };
    });
  });

  // Write
  await wb.xlsx.writeFile(OUT_FILE);

  // Summary
  const byCat = {};
  rows.forEach(r => { byCat[r.category] = (byCat[r.category] || 0) + 1; });

  console.log('\n✓ Done!\n');
  console.log(`  File  : ${OUT_FILE}`);
  console.log(`  Sheet : Atlas Catalog`);
  console.log(`  Rows  : ${rows.length} Atlas products\n`);
  Object.entries(byCat).forEach(([cat, n]) => console.log(`  ${cat.padEnd(22)}: ${n}`));
  console.log();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
