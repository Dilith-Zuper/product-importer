require('dotenv').config();
const ExcelJS = require('exceljs');
const path    = require('path');
const fs      = require('fs');
const { createClient } = require('@supabase/supabase-js');

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const OUT_DIR   = path.join(__dirname, 'brandwise catalog');
const MIN_PRODS = 10;
const PAGE      = 1000;

const csv = v => Array.isArray(v) ? v.filter(Boolean).join(', ') : (v || '');
const safeName = s => s.replace(/[*?:/\\[\]]/g, '-').trim();


const COLUMNS = [
  { header: 'Category',         key: 'category',      width: 24 },
  { header: 'Brand',            key: 'brand',         width: 22 },
  { header: 'Product Line',     key: 'product_line',        width: 26 },
  { header: 'Tier',             key: 'family_tier',         width: 10 },
  { header: 'Proposal Line Item', key: 'proposal_line_item', width: 30 },
  { header: 'Product Name',     key: 'product_name',        width: 52 },
  { header: '# Variants',       key: 'variant_count', width: 11 },
  { header: 'Available Colors', key: 'colors',        width: 55 },
  { header: 'Available Sizes',  key: 'sizes',         width: 32 },
  { header: 'Order UOM(s)',     key: 'uoms',          width: 18 },
  { header: 'Sample SKUs',      key: 'skus',          width: 35 },
  { header: 'Product UOM',      key: 'product_uom',   width: 15 },
  { header: 'Description',      key: 'description',   width: 65 },
  { header: 'Image URL',        key: 'image_url',     width: 45 },
];

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function fetchAllProducts() {
  const rows = []; let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('srs_products')
      .select('product_id,product_name,product_category,manufacturer,manufacturer_norm,product_description,product_uom,product_image_url,product_line,family_tier,proposal_line_item')
      .eq('exclude_default', false)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function fetchVariantsForIds(productIds) {
  if (!productIds.length) return [];
  const rows = []; let from = 0;
  // Fetch in chunks of 500 ids to avoid URL length limits
  const chunks = [];
  for (let i = 0; i < productIds.length; i += 500) chunks.push(productIds.slice(i, i + 500));
  for (const chunk of chunks) {
    let cf = 0;
    while (true) {
      const { data, error } = await supabase
        .from('srs_variants')
        .select('variant_id,product_id,variant_code,order_uom,color_name,size_name,uoms,variant_image_url')
        .in('product_id', chunk)
        .eq('is_restricted', false)
        .range(cf, cf + PAGE - 1);
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < PAGE) break;
      cf += PAGE;
    }
  }
  return rows;
}

function buildVarSummary(variants) {
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

// ── Excel writer ──────────────────────────────────────────────────────────────
async function writeExcel(brandName, rows) {
  const fileName = `${safeName(brandName)} Catalog.xlsx`;
  const filePath = path.join(OUT_DIR, fileName);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'SRS Product Importer'; wb.created = new Date();

  const ws = wb.addWorksheet(`${brandName} Catalog`, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.width }));

  // Header
  const hRow = ws.getRow(1);
  hRow.height = 22;
  hRow.eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border    = { bottom: { style: 'medium', color: { argb: 'FF4A90D9' } } };
  });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: COLUMNS.length } };

  // Data rows — alternate white / light blue
  rows.forEach((r, i) => {
    const row = ws.addRow(COLUMNS.map(c => r[c.key] ?? ''));
    const bg  = i % 2 === 0 ? 'FFFFFFFF' : 'FFF0F4FF';
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font      = { size: 9, name: 'Calibri' };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { vertical: 'top', wrapText: false };
    });
  });

  await wb.xlsx.writeFile(filePath);
  return fileName;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Brandwise Catalog Export ===\n');

  // 1. Load all products
  process.stdout.write('Loading all products from Supabase …\r');
  const allProducts = await fetchAllProducts();
  console.log(`Loaded ${allProducts.length.toLocaleString()} products.      `);

  // 2. Group by manufacturer_norm, filter to 10+, skip "Manufacturer Varies"
  const brandMap = {};
  allProducts.forEach(p => {
    const b = p.manufacturer_norm;
    if (!b || b.toLowerCase().includes('manufacturer varies')) return;
    if (!brandMap[b]) brandMap[b] = [];
    brandMap[b].push(p);
  });

  const brands = Object.entries(brandMap)
    .filter(([, prods]) => prods.length >= MIN_PRODS)
    .sort((a, b) => b[1].length - a[1].length);

  console.log(`Brands with ${MIN_PRODS}+ products: ${brands.length}\n`);

  // 3. Load ALL variants in one pass (more efficient than per-brand)
  process.stdout.write('Loading all variants …\r');
  const qualifyingIds = brands.flatMap(([, prods]) => prods.map(p => p.product_id));
  const allVariants   = await fetchVariantsForIds(qualifyingIds);
  const vSummary      = buildVarSummary(allVariants);
  console.log(`Loaded ${allVariants.length.toLocaleString()} variants.      \n`);

  // 4. Write one Excel per brand
  let done = 0;
  const results = [];

  for (const [brandNorm, products] of brands) {
    // Use the original manufacturer name from first product for display
    const displayName = products[0].manufacturer || brandNorm;
    const rows = products
      .sort((a, b) => a.product_category.localeCompare(b.product_category) || a.product_name.localeCompare(b.product_name))
      .map(p => {
        const v = vSummary[p.product_id] || {};
        return {
          category:      p.product_category,
          brand:         p.manufacturer || '',
          product_line:       p.product_line || '',
          family_tier:        p.family_tier || '',
          proposal_line_item: p.proposal_line_item || '',
          product_name:       p.product_name,
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

    const fileName = await writeExcel(displayName, rows);
    done++;
    results.push({ brand: displayName, products: products.length, file: fileName });
    process.stdout.write(`  [${done}/${brands.length}] ${displayName.padEnd(30)} ${products.length} products\r`);
  }

  console.log(`\n\n✓ All ${done} catalogs written to:\n  ${OUT_DIR}\n`);
  console.log('Top 20 by product count:');
  results.slice(0, 20).forEach(r => console.log(`  ${String(r.products).padStart(4)}  ${r.brand}`));
  console.log(`  ...\n  Total files: ${done}`);
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
