require('dotenv').config();
const ExcelJS  = require('exceljs');
const path     = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const OUT_FILE = path.join(__dirname, 'SRS Catalog Export.xlsx');
const PAGE     = 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────
const csv = v => {
  if (!v) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join(', ');
  return String(v);
};

async function fetchAll(table, select, filters = []) {
  const rows = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    for (const [col, val] of filters) q = q.eq(col, val);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    process.stdout.write(`  ${table}: ${rows.length} rows …\r`);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`  ${table}: ${rows.length} rows ✓          `);
  return rows;
}

function styleHeader(row, color = '1F4E79') {
  row.eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${color}` } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
    cell.border    = {
      bottom: { style: 'thin', color: { argb: 'FFAAAAAA' } },
    };
  });
}

function addSheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 15 },
  });

  // Column definitions
  ws.columns = columns.map(c => ({
    header: c.header,
    key:    c.key,
    width:  c.width || 18,
  }));

  // Style header row
  styleHeader(ws.getRow(1));

  // Add data rows
  const colors = ['FFFFFFFF', 'FFF2F7FF'];
  rows.forEach((r, i) => {
    const row = ws.addRow(columns.map(c => c.value ? c.value(r) : (r[c.key] ?? '')));
    const bg = colors[i % 2];
    row.eachCell(cell => {
      cell.font      = { size: 9 };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { vertical: 'top', wrapText: false };
    });
  });

  // Auto-filter on header
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  return ws;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== SRS Catalog Excel Export ===\n');
  console.log('Fetching data from Supabase …');

  const [products, variants, families] = await Promise.all([
    fetchAll('srs_products', '*'),
    fetchAll('srs_variants', '*', [['is_restricted', false]]),
    fetchAll('srs_product_families', '*'),
  ]);

  console.log(`\nBuilding workbook …`);
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'SRS Product Importer';
  wb.created  = new Date();
  wb.modified = new Date();

  // ── Sheet 1: Products ──────────────────────────────────────────────────────
  addSheet(wb, '📦 Products', [
    { header: 'Product ID',       key: 'product_id',          width: 12 },
    { header: 'Product Name',     key: 'product_name',        width: 45 },
    { header: 'Category',         key: 'product_category',    width: 20 },
    { header: 'Manufacturer',     key: 'manufacturer',        width: 22 },
    { header: 'Manufacturer Norm',key: 'manufacturer_norm',   width: 22 },
    { header: 'Description',      key: 'product_description', width: 50 },
    { header: 'Features',         key: 'product_features',    width: 40,
      value: r => csv(r.product_features) },
    { header: 'UOM',              key: 'product_uom',         width: 16,
      value: r => csv(r.product_uom) },
    { header: 'Options',          key: 'product_options',     width: 30,
      value: r => csv(r.product_options) },
    { header: 'Image URL',        key: 'product_image_url',   width: 40 },
    { header: 'Primary Item',     key: 'primary_item',        width: 13 },
    { header: 'Is Generic',       key: 'is_generic',          width: 12 },
    { header: 'Allow Substitution',key:'allow_substitution',  width: 18 },
    { header: 'Is Private Label', key: 'is_private_label',    width: 16 },
    { header: 'Exclude Default',  key: 'exclude_default',     width: 15 },
    { header: 'Catalog Version',  key: 'catalog_version',     width: 15 },
    { header: 'Created At',       key: 'created_at',          width: 22 },
  ], products);

  // ── Sheet 2: Variants ──────────────────────────────────────────────────────
  addSheet(wb, '🎨 Variants', [
    { header: 'Variant ID',           key: 'variant_id',            width: 12 },
    { header: 'Product ID',           key: 'product_id',            width: 12 },
    { header: 'SKU / Variant Code',   key: 'variant_code',          width: 22 },
    { header: 'Order UOM',            key: 'order_uom',             width: 12 },
    { header: 'Color Name',           key: 'color_name',            width: 25 },
    { header: 'Size Name',            key: 'size_name',             width: 25 },
    { header: 'Selected Option',      key: 'selected_option',       width: 28 },
    { header: 'Variant Image URL',    key: 'variant_image_url',     width: 40 },
    { header: 'All UOMs',             key: 'uoms',                  width: 20,
      value: r => csv(r.uoms) },
    { header: 'Customer Restrictions',key: 'customer_restrictions', width: 22 },
    { header: 'Is Private Label',     key: 'is_private_label',      width: 16 },
    { header: 'Catalog Version',      key: 'catalog_version',       width: 15 },
  ], variants);

  // ── Sheet 3: Product Families ──────────────────────────────────────────────
  addSheet(wb, '🏷️ Families', [
    { header: 'Product ID',       key: 'product_id',        width: 12 },
    { header: 'Manufacturer Norm',key: 'manufacturer_norm', width: 22 },
    { header: 'Family Name',      key: 'family_name',       width: 28 },
    { header: 'Family Tier',      key: 'family_tier',       width: 14 },
    { header: 'Is Default',       key: 'is_default',        width: 12 },
  ], families);

  // ── Summary sheet ──────────────────────────────────────────────────────────
  const ws4 = wb.addWorksheet('📊 Summary');
  ws4.columns = [{ width: 30 }, { width: 20 }];
  const summaryRows = [
    ['SRS Catalog Export', ''],
    ['Export Date', new Date().toLocaleDateString()],
    ['', ''],
    ['Table', 'Row Count'],
    ['Products', products.length],
    ['Variants (unrestricted)', variants.length],
    ['Product Families', families.length],
    ['', ''],
    ['Unique Categories', new Set(products.map(p => p.product_category)).size],
    ['Unique Brands', new Set(products.map(p => p.manufacturer_norm)).size],
    ['Products with Images', products.filter(p => p.product_image_url).length],
    ['Products without Images', products.filter(p => !p.product_image_url).length],
  ];
  summaryRows.forEach((r, i) => {
    const row = ws4.addRow(r);
    if (i === 0) {
      row.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF1F4E79' } };
    } else if (i === 3) {
      styleHeader(row);
    }
  });

  // ── Write file ─────────────────────────────────────────────────────────────
  console.log(`Writing to: ${OUT_FILE}`);
  await wb.xlsx.writeFile(OUT_FILE);
  console.log('\n✓ Done!\n');
  console.log(`  📦 Products sheet   : ${products.length.toLocaleString()} rows`);
  console.log(`  🎨 Variants sheet   : ${variants.length.toLocaleString()} rows`);
  console.log(`  🏷️  Families sheet   : ${families.length.toLocaleString()} rows`);
  console.log(`\n  File saved: ${OUT_FILE}\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
