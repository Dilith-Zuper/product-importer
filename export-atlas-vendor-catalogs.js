/**
 * Export Atlas brand catalogs from ABC and QXO, in the same visual format as the
 * SRS `brandwise catalog/` Excel files (export-brandwise.js).
 *
 * Output (project root, into `brandwise catalog/`):
 *   Atlas Catalog - ABC.xlsx   (108 Atlas products from ABC)
 *   Atlas Catalog - QXO.xlsx   (379 Atlas products from QXO)
 *
 *   node export-atlas-vendor-catalogs.js
 */
require('dotenv').config();
const ExcelJS = require('exceljs');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const OUT_DIR  = path.join(__dirname, 'brandwise catalog');
const PAGE     = 1000;

const csv = v => Array.isArray(v) ? v.filter(Boolean).join(', ') : (v || '');
const uniq = arr => [...new Set(arr.filter(x => x != null && String(x).trim() !== ''))];

// Same column contract as export-brandwise.js
const COLUMNS = [
  { header: 'Category',           key: 'category',           width: 26 },
  { header: 'Brand',              key: 'brand',              width: 16 },
  { header: 'Product Line',       key: 'product_line',       width: 28 },
  { header: 'Tier',               key: 'family_tier',        width: 10 },
  { header: 'Proposal Line Item', key: 'proposal_line_item', width: 30 },
  { header: 'Product Name',       key: 'product_name',       width: 60 },
  { header: '# Variants',         key: 'variant_count',      width: 11 },
  { header: 'Available Colors',   key: 'colors',             width: 50 },
  { header: 'Available Sizes',    key: 'sizes',              width: 34 },
  { header: 'Order UOM(s)',       key: 'uoms',               width: 18 },
  { header: 'Sample SKUs',        key: 'skus',               width: 38 },
  { header: 'Product UOM',        key: 'product_uom',        width: 15 },
  { header: 'Description',        key: 'description',        width: 65 },
  { header: 'Image URL',          key: 'image_url',          width: 45 },
];

async function fetchAll(table, select, applyFilter) {
  const rows = []; let from = 0;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    q = applyFilter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function fetchVariantsByKey(table, select, keyCol, keys) {
  const rows = [];
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from(table).select(select).in(keyCol, chunk).range(from, from + PAGE - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      rows.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
  return rows;
}

// ── Excel writer (identical styling to export-brandwise.js) ──────────────────
async function writeExcel(fileName, sheetTitle, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SRS Product Importer'; wb.created = new Date();
  const ws = wb.addWorksheet(sheetTitle, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.width }));

  const hRow = ws.getRow(1);
  hRow.height = 22;
  hRow.eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border    = { bottom: { style: 'medium', color: { argb: 'FF4A90D9' } } };
  });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };

  rows.forEach((r, i) => {
    const row = ws.addRow(COLUMNS.map(c => r[c.key] ?? ''));
    const bg  = i % 2 === 0 ? 'FFFFFFFF' : 'FFF0F4FF';
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font      = { size: 9, name: 'Calibri' };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { vertical: 'top', wrapText: false };
    });
  });

  const filePath = path.join(OUT_DIR, fileName);
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

// ── ABC ──────────────────────────────────────────────────────────────────────
async function buildAbc() {
  const products = await fetchAll(
    'abc_products',
    'product_id,product_name,product_category,manufacturer_norm,product_line,family_tier,proposal_line_item,product_uom,product_description,product_image_url',
    q => q.eq('manufacturer_norm', 'Atlas'),
  );
  const variants = await fetchVariantsByKey(
    'abc_variants',
    'variant_id,product_id,variant_code,order_uom,color_name,size_name,variant_image_url,uoms',
    'product_id',
    products.map(p => p.product_id),
  );
  const vmap = {};
  for (const v of variants) {
    (vmap[v.product_id] ||= { colors: [], sizes: [], skus: [], uoms: [], count: 0, img: null }).count++;
    const s = vmap[v.product_id];
    if (v.color_name) s.colors.push(v.color_name.trim());
    if (v.size_name)  s.sizes.push(v.size_name.trim());
    if (v.variant_code) s.skus.push(v.variant_code);
    if (v.order_uom) s.uoms.push(v.order_uom);
    // abc_variants.uoms is an array of { code, name, description } objects.
    if (Array.isArray(v.uoms)) v.uoms.forEach(u => s.uoms.push(typeof u === 'string' ? u : u?.code));
    if (v.variant_image_url && !s.img) s.img = v.variant_image_url;
  }

  const rows = products
    .sort((a, b) => (a.product_category || '').localeCompare(b.product_category || '') || (a.product_name || '').localeCompare(b.product_name || ''))
    .map(p => {
      const v = vmap[p.product_id] || {};
      return {
        category:           p.product_category || '',
        brand:              'Atlas',
        product_line:       p.product_line || '',
        family_tier:        p.family_tier || '',
        proposal_line_item: p.proposal_line_item || '',
        product_name:       p.product_name || '',
        variant_count:      v.count || 0,
        colors:             uniq(v.colors || []).join(', '),
        sizes:              uniq(v.sizes || []).join(', '),
        uoms:               uniq(v.uoms || []).join(', '),
        skus:               uniq(v.skus || []).slice(0, 4).join(', '),
        product_uom:        csv(p.product_uom),
        description:        p.product_description ? p.product_description.slice(0, 250) : '',
        image_url:          v.img || p.product_image_url || '',
      };
    });
  return rows;
}

// ── QXO ──────────────────────────────────────────────────────────────────────
function qxoSize(v) {
  // Compose a human size from the dimension fields QXO exposes per SKU.
  const parts = [];
  if (v.size_thickness) parts.push(String(v.size_thickness).trim());
  const wl = [v.size_width, v.size_length].filter(Boolean).map(s => String(s).trim());
  if (wl.length) parts.push(wl.join(' x '));
  else if (v.size_height) parts.push(String(v.size_height).trim());
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function buildQxo() {
  const products = await fetchAll(
    'qxo_products',
    'product_key,product_name,category_norm,brand_norm,product_line,family_tier,proposal_line_item,description_short,description_long,brand_image_url',
    q => q.eq('brand_norm', 'Atlas'),
  );
  const variants = await fetchVariantsByKey(
    'qxo_variants',
    'variant_sku,product_key,color,color_family,uom,size_height,size_width,size_length,size_thickness,manufacturer_number,product_number,image_url',
    'product_key',
    products.map(p => p.product_key),
  );
  const vmap = {};
  for (const v of variants) {
    (vmap[v.product_key] ||= { colors: [], sizes: [], skus: [], uoms: [], count: 0, img: null }).count++;
    const s = vmap[v.product_key];
    if (v.color) s.colors.push(v.color.trim());
    else if (v.color_family) s.colors.push(v.color_family.trim());
    const size = qxoSize(v);
    if (size) s.sizes.push(size);
    if (v.uom) s.uoms.push(v.uom);
    // Prefer the manufacturer part number as the "SKU"; fall back to QXO product number / sku key.
    const sku = v.manufacturer_number || v.product_number || (v.variant_sku != null ? String(v.variant_sku) : null);
    if (sku) s.skus.push(sku);
    if (v.image_url && !s.img) s.img = v.image_url;
  }

  const rows = products
    .sort((a, b) => (a.category_norm || '').localeCompare(b.category_norm || '') || (a.product_name || '').localeCompare(b.product_name || ''))
    .map(p => {
      const v = vmap[p.product_key] || {};
      const desc = (p.description_short || p.description_long || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return {
        category:           p.category_norm || '',
        brand:              'Atlas',
        product_line:       p.product_line || '',
        family_tier:        p.family_tier || '',
        proposal_line_item: p.proposal_line_item || '',
        product_name:       p.product_name || '',
        variant_count:      v.count || 0,
        colors:             uniq(v.colors || []).join(', '),
        sizes:              uniq(v.sizes || []).join(', '),
        uoms:               uniq(v.uoms || []).join(', '),
        skus:               uniq(v.skus || []).slice(0, 4).join(', '),
        product_uom:        uniq(v.uoms || []).join(', '),
        description:        desc ? desc.slice(0, 250) : '',
        image_url:          v.img || '',
      };
    });
  return rows;
}

async function main() {
  console.log('\n=== Atlas Vendor Catalog Export (ABC + QXO) ===\n');

  process.stdout.write('Building ABC Atlas catalog …\r');
  const abcRows = await buildAbc();
  const abcPath = await writeExcel('Atlas Catalog - ABC.xlsx', 'Atlas Catalog (ABC)', abcRows);
  console.log(`✓ ABC : ${abcRows.length} products → ${path.basename(abcPath)}`);

  process.stdout.write('Building QXO Atlas catalog …\r');
  const qxoRows = await buildQxo();
  const qxoPath = await writeExcel('Atlas Catalog - QXO.xlsx', 'Atlas Catalog (QXO)', qxoRows);
  console.log(`✓ QXO : ${qxoRows.length} products → ${path.basename(qxoPath)}`);

  // Category breakdowns
  const breakdown = (rows) => {
    const c = {};
    rows.forEach(r => c[r.category] = (c[r.category] || 0) + 1);
    return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `      ${String(v).padStart(3)}  ${k}`).join('\n');
  };
  console.log('\nABC categories:\n' + breakdown(abcRows));
  console.log('\nQXO categories:\n' + breakdown(qxoRows));
  console.log(`\nOutput folder: ${OUT_DIR}\n`);
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
