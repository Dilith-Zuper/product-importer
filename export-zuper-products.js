/**
 * Read-only export of a Zuper account's product catalog to an .xlsx that
 * match-account-to-srs.js can consume. For accounts NOT imported by the SRS tool
 * (text product_ids, manual entry) where the ID-based options audit finds nothing —
 * dump the products here, then run the name-based matcher to see SRS coverage.
 *
 * GETs only. Never writes to Zuper.
 *
 * Connection (pick one):  --login <name> | --region <region> | --base <url>
 * Auth:                    --key <apiKey>   (or ZUPER_API_KEY in the environment)
 * Options:                 --label "Name"   (output-file prefix; default company name)
 *                          --parts-only     (skip SERVICE rows)
 *
 *   node export-zuper-products.js --key XXX --region us-east-1 --label "STX Roofing"
 */

require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => String(s || 'account').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'account';

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) { const k = t.slice(2); const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true; a[k] = v; }
    else a._.push(t);
  }
  return a;
}
const ARGS = parseArgs(process.argv.slice(2));
const API_KEY = (typeof ARGS.key === 'string' && ARGS.key) || process.env.ZUPER_API_KEY;
let H;

async function resolveBaseUrl() {
  if (typeof ARGS.base === 'string') {
    let b = ARGS.base.trim().replace(/\/+$/, '');
    if (!b.endsWith('/api')) b += '/api';
    return b + '/';
  }
  if (typeof ARGS.region === 'string') return `https://${ARGS.region}.zuperpro.com/api/`;
  if (typeof ARGS.login === 'string') {
    const r = await fetch('https://accounts.zuperpro.com/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company_name: ARGS.login }),
    });
    const j = await r.json().catch(() => null);
    const dc = j?.config?.dc_api_url;
    if (!dc) throw new Error(`Could not resolve region from login name "${ARGS.login}"`);
    return dc.replace(/\/+$/, '') + '/api/';
  }
  throw new Error('Provide a connection: --login <name> | --region <region> | --base <url>');
}

async function getJson(url, opts = {}) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: H, ...opts });
      if (r.status === 429 || r.status >= 500) { await sleep(700 * (a + 1)); continue; }
      const j = await r.json().catch(() => null);
      return { ok: r.ok, status: r.status, json: j };
    } catch { await sleep(700 * (a + 1)); }
  }
  throw new Error('fetch failed: ' + url);
}

async function resolveListSegment(base) {
  const r = await getJson(`${base}product?count=1&page=1`);
  if (r.ok && Array.isArray(r.json?.data)) return 'product';
  return 'products';
}

// brand can be a string, an object ({ brand_name }), or null/empty.
const brandText = b => {
  if (!b) return '';
  if (typeof b === 'string') return b.trim();
  return String(b.brand_name || b.name || b.value || '').trim();
};

async function main() {
  if (!API_KEY) { console.log('Provide --key <apiKey> or set ZUPER_API_KEY'); process.exit(1); }
  H = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };

  const base = await resolveBaseUrl();
  const ver = await getJson(`${base}user/company`);
  const company = ver.json?.data?.company_name ?? ver.json?.company_name ?? null;
  if (!ver.ok || !company) { console.log(`Key/connection check failed (status ${ver.status}) for ${base}`); process.exit(1); }
  const label = (typeof ARGS.label === 'string' && ARGS.label) || company;
  const OUT = path.join(__dirname, `${slug(label)}-zuper-products.xlsx`);
  console.log(`\n=== Zuper product export (read-only)  account: ${company}  (${base}) ===\n`);

  const listSegment = await resolveListSegment(base);
  const products = [];
  let page = 1, total = null;
  while (true) {
    const { json } = await getJson(`${base}${listSegment}?page=${page}&count=100`);
    const rows = json?.data || [];
    if (total === null) total = json?.total_records;
    products.push(...rows);
    process.stdout.write(`  fetched ${products.length}/${total ?? '?'}\r`);
    if (rows.length < 100) break;
    page++; if (page > 200) break;
  }
  console.log(`\nFetched ${products.length} products (total_records ${total}).`);

  const partsOnly = !!ARGS['parts-only'];
  const rows = [];
  let n = 0, skippedSvc = 0;
  for (const p of products) {
    if (partsOnly && p.product_type !== 'PARTS') { skippedSvc++; continue; }
    rows.push({
      num: ++n,
      product_id: p.product_id ?? '',
      type: p.product_type ?? '',
      category: p.product_category?.category_name ?? '',
      name: p.product_name ?? '',
      description: p.plain_text_description || p.product_description || '',
      brand: brandText(p.brand),
      uom: p.uom ?? '',
      price: p.price ?? '',
    });
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Zuper product export'; wb.created = new Date();
  const ws = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { key: 'num', header: '#', width: 6 },
    { key: 'product_id', header: 'Zuper product_id', width: 16 },
    { key: 'type', header: 'Type', width: 10 },
    { key: 'category', header: 'Category', width: 26 },
    { key: 'name', header: 'Product Name', width: 50 },
    { key: 'description', header: 'Product Description', width: 60 },
    { key: 'brand', header: 'Brand', width: 20 },
    { key: 'uom', header: 'UOM', width: 8 },
    { key: 'price', header: 'Price', width: 12 },
  ];
  ws.getRow(1).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } }; });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: 9 } };
  rows.forEach(r => ws.addRow(r));

  await wb.xlsx.writeFile(OUT);
  const types = rows.reduce((m, r) => (m[r.type] = (m[r.type] || 0) + 1, m), {});
  console.log(`\n✓ Wrote ${path.basename(OUT)}  (${rows.length} rows${skippedSvc ? `, skipped ${skippedSvc} non-PARTS` : ''})`);
  console.log(`  by type: ${Object.entries(types).map(([k, v]) => `${k || '—'}:${v}`).join('  ')}`);
  console.log(`\nNext: node match-account-to-srs.js "${path.basename(OUT)}" --label "${label}" --out "${slug(label)}"`);
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
