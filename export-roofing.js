require('dotenv').config();
const ExcelJS = require('exceljs');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const OUT_FILE = path.join(__dirname, 'SRS Roofing Catalog.xlsx');
const PAGE     = 1000;

const ROOFING_CATEGORIES = [
  'UNDERLAYMENT',
  'ICE AND WATER',
  'HIP AND RIDGE',
  'STARTER',
  'DRIP EDGE',
  'W-VALLEY',
  'PIPE FLASHING',
  'COIL NAILS',
  'VENTS',
  'CAULK',
  'SPRAY PAINT',
  'OTHER FASTENERS',
  'GUTTER/ALUMINUM/COIL',
];

const SHEET_META = {
  'UNDERLAYMENT':         { emoji: '🟫', color: '4A235A' },
  'ICE AND WATER':        { emoji: '🧊', color: '1A5276' },
  'HIP AND RIDGE':        { emoji: '🔺', color: '1F618D' },
  'STARTER':              { emoji: '▶️',  color: '117A65' },
  'DRIP EDGE':            { emoji: '💧', color: '1E8449' },
  'W-VALLEY':             { emoji: '〰️', color: '196F3D' },
  'PIPE FLASHING':        { emoji: '🔩', color: '7D6608' },
  'COIL NAILS':           { emoji: '📌', color: '784212' },
  'VENTS':                { emoji: '💨', color: '922B21' },
  'CAULK':                { emoji: '🔧', color: '7B241C' },
  'SPRAY PAINT':          { emoji: '🎨', color: '6C3483' },
  'OTHER FASTENERS':      { emoji: '🔗', color: '1F618D' },
  'GUTTER/ALUMINUM/COIL': { emoji: '🌧️', color: '2E4057' },
};

const csv = v => Array.isArray(v) ? v.filter(Boolean).join(', ') : (v || '');

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function fetchPaged(table, select, filters = []) {
  const rows = []; let from = 0;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    for (const [col, val] of filters) q = q.eq(col, val);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function getProductsForCategory(category) {
  return fetchPaged('srs_products',
    'product_id,product_name,manufacturer,manufacturer_norm,product_description,product_uom,product_options,product_image_url',
    [['product_category', category], ['exclude_default', false]]
  );
}

async function getVariantsForProducts(productIds) {
  if (!productIds.length) return [];
  const rows = []; let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('srs_variants')
      .select('variant_id,product_id,variant_code,order_uom,color_name,size_name,selected_option,variant_image_url,uoms')
      .in('product_id', productIds)
      .eq('is_restricted', false)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`variants: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

// Build a map: product_id → aggregated variant summary
function buildVariantSummary(variants) {
  const map = {};
  for (const v of variants) {
    if (!map[v.product_id]) map[v.product_id] = { colors: new Set(), sizes: new Set(), skus: [], uoms: new Set(), variantCount: 0, imageUrl: null };
    const s = map[v.product_id];
    s.variantCount++;
    if (v.color_name?.trim()) s.colors.add(v.color_name.trim());
    if (v.size_name?.trim())  s.sizes.add(v.size_name.trim());
    if (v.variant_code)       s.skus.push(v.variant_code);
    if (v.uoms) v.uoms.forEach(u => s.uoms.add(u));
    if (v.variant_image_url && !s.imageUrl) s.imageUrl = v.variant_image_url;
  }
  return map;
}

// ── Worksheet styling ─────────────────────────────────────────────────────────
function makeHeader(ws, columns, hexColor) {
  ws.columns = columns.map(c => ({ header: c.label, key: c.key, width: c.width || 18 }));
  const hRow = ws.getRow(1);
  hRow.height = 20;
  hRow.eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hexColor}` } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border    = { bottom: { style: 'medium', color: { argb: 'FFCCCCCC' } } };
  });
  ws.autoFilter  = { from: 'A1', to: { row: 1, column: columns.length } };
  ws.views       = [{ state: 'frozen', ySplit: 1 }];
}

function addDataRow(ws, values, rowIndex) {
  const row = ws.addRow(values);
  const bg  = rowIndex % 2 === 0 ? 'FFFFFFFF' : 'FFF4F6F9';
  row.eachCell({ includeEmpty: true }, cell => {
    cell.font      = { size: 9, name: 'Calibri' };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    cell.alignment = { vertical: 'top', wrapText: false };
  });
  return row;
}

// ── Column definitions ────────────────────────────────────────────────────────
const PRODUCT_COLS = [
  { key: 'manufacturer',      label: 'Brand',            width: 22 },
  { key: 'product_name',      label: 'Product Name',     width: 48 },
  { key: 'variant_count',     label: '# Variants',       width: 11 },
  { key: 'colors',            label: 'Available Colors',  width: 55 },
  { key: 'sizes',             label: 'Available Sizes',   width: 35 },
  { key: 'order_uoms',        label: 'Order UOM(s)',      width: 18 },
  { key: 'sample_skus',       label: 'Sample SKUs',       width: 30 },
  { key: 'product_uom',       label: 'Product UOM',       width: 16 },
  { key: 'description',       label: 'Description',       width: 60 },
  { key: 'image_url',         label: 'Image URL',         width: 45 },
];

const PINNACLE_COLS = [
  { key: 'product_name',      label: 'Product Name',     width: 40 },
  { key: 'family',            label: 'Family',           width: 20 },
  { key: 'sku',               label: 'SKU',              width: 22 },
  { key: 'color_name',        label: 'Color',            width: 25 },
  { key: 'size_name',         label: 'Size',             width: 16 },
  { key: 'order_uom',         label: 'Order UOM',        width: 12 },
  { key: 'all_uoms',          label: 'All UOMs',         width: 16 },
  { key: 'variant_image_url', label: 'Variant Image URL',width: 45 },
  { key: 'product_image_url', label: 'Product Image URL',width: 45 },
  { key: 'description',       label: 'Description',      width: 60 },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== SRS Roofing Catalog Export ===\n');

  const wb = new ExcelJS.Workbook();
  wb.creator = 'SRS Product Importer'; wb.created = new Date();

  // ── SHEET 1: Atlas Pinnacle Shingles ──────────────────────────────────────
  console.log('Building Atlas Pinnacle sheet …');
  const { data: pinnacleProducts } = await supabase
    .from('srs_products')
    .select('product_id,product_name,manufacturer,product_description,product_image_url')
    .ilike('product_name', '%pinnacle%')
    .order('product_name');

  const pinnacleIds = pinnacleProducts.map(p => p.product_id);
  const { data: pinnacleVariants } = await supabase
    .from('srs_variants')
    .select('*')
    .in('product_id', pinnacleIds)
    .eq('is_restricted', false)
    .order('product_id').order('color_name');

  const pinnacleMap = Object.fromEntries(pinnacleProducts.map(p => [p.product_id, p]));
  const familyName = name => {
    if (/impact/i.test(name)) return 'Pinnacle Impact IR';
    if (/cool|sun/i.test(name)) return 'Pinnacle Cool Sun';
    return 'Pinnacle Pristine';
  };

  const ws1 = wb.addWorksheet('🔺 Atlas Pinnacle Shingles');
  makeHeader(ws1, PINNACLE_COLS, '1B2A4A');
  pinnacleVariants.forEach((v, i) => {
    const p = pinnacleMap[v.product_id];
    addDataRow(ws1, [
      p.product_name,
      familyName(p.product_name),
      v.variant_code,
      v.color_name || '',
      v.size_name  || '',
      v.order_uom  || '',
      csv(v.uoms),
      v.variant_image_url || '',
      p.product_image_url  || '',
      p.product_description ? p.product_description.slice(0, 200) : '',
    ], i);
  });
  console.log(`  ✓ Pinnacle: ${pinnacleVariants.length} variant rows`);

  // ── SHEETS 2–N: One per roofing category ──────────────────────────────────
  const stats = [];
  for (const cat of ROOFING_CATEGORIES) {
    process.stdout.write(`Fetching ${cat} …\r`);
    const products  = await getProductsForCategory(cat);
    const pids      = products.map(p => p.product_id);
    const variants  = await getVariantsForProducts(pids);
    const vSummary  = buildVariantSummary(variants);

    const meta      = SHEET_META[cat] || { emoji: '📋', color: '2E4057' };
    const sheetName = `${meta.emoji} ${cat.replace(/[*/\\?:\[\]]/g, '-').slice(0, 25)}`;
    const ws        = wb.addWorksheet(sheetName);
    makeHeader(ws, PRODUCT_COLS, meta.color);

    products.forEach((p, i) => {
      const v = vSummary[p.product_id] || {};
      addDataRow(ws, [
        p.manufacturer || '',
        p.product_name,
        v.variantCount || 0,
        [...(v.colors || [])].join(', '),
        [...(v.sizes  || [])].join(', '),
        [...(v.uoms   || [])].join(', '),
        (v.skus || []).slice(0, 3).join(', '),
        csv(p.product_uom),
        p.product_description ? p.product_description.slice(0, 200) : '',
        v.imageUrl || p.product_image_url || '',
      ], i);
    });

    stats.push({ cat, products: products.length, variants: variants.length });
    console.log(`  ✓ ${cat}: ${products.length} products, ${variants.length} variants          `);
  }

  // ── Summary sheet ──────────────────────────────────────────────────────────
  const wsSummary = wb.addWorksheet('📊 Summary', { state: 'veryHidden' });
  wsSummary.addRow(['Sheet', 'Products', 'Variants']);
  wsSummary.getRow(1).font = { bold: true };
  wsSummary.addRow(['Atlas Pinnacle Shingles', pinnacleProducts.length, pinnacleVariants.length]);
  stats.forEach(s => wsSummary.addRow([s.cat, s.products, s.variants]));
  const totalP = stats.reduce((a, s) => a + s.products, 0) + pinnacleProducts.length;
  const totalV = stats.reduce((a, s) => a + s.variants, 0) + pinnacleVariants.length;
  wsSummary.addRow(['TOTAL', totalP, totalV]);
  wsSummary.columns = [{ width: 32 }, { width: 14 }, { width: 14 }];

  // ── Write ──────────────────────────────────────────────────────────────────
  console.log(`\nWriting file …`);
  await wb.xlsx.writeFile(OUT_FILE);

  console.log('\n✓ Done!\n');
  console.log(`  File: ${OUT_FILE}\n`);
  console.log('  Sheets:');
  console.log(`  ├─ 🔺 Atlas Pinnacle Shingles  — ${pinnacleVariants.length} variant rows`);
  stats.forEach((s, i) => {
    const icon = i === stats.length - 1 ? '└─' : '├─';
    const meta = SHEET_META[s.cat];
    console.log(`  ${icon} ${meta.emoji} ${s.cat.padEnd(26)} — ${s.products} products`);
  });
  console.log(`\n  Total products: ${totalP.toLocaleString()}`);
  console.log(`  Total variants: ${totalV.toLocaleString()}\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
