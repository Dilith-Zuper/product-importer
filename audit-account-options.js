/**
 * Reusable READ-ONLY audit: for any Zuper account imported from SRS, report which
 * products SHOULD have options (color, size, or composite per srs_variants) but were
 * uploaded with an empty option block. Pairs with backfill-account-options.js (run
 * this to check, that to fix) — the buckets here mirror exactly what the backfill
 * will load: color, size-only (>1 size), and both → composite.
 *
 * Does NOT write to Zuper. GETs against Zuper + reads against Supabase + a local
 * Excel report.
 *
 * Connection (pick one):  --login <name> | --region <region> | --base <url>
 * Auth:                    --key <apiKey>   (or ZUPER_API_KEY in the environment)
 * Options:                 --label "Name"   (output-file prefix; default company name)
 *
 *   node audit-account-options.js --key XXX --region us-west-1c --label "High Impact"
 */

require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');
const { fetchAll } = require('./lib/utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const realOpt = s => s && String(s).trim() && !['n/a', 'na'].includes(String(s).trim().toLowerCase());
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

async function main() {
  if (!API_KEY) { console.log('Provide --key <apiKey> or set ZUPER_API_KEY'); process.exit(1); }
  H = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };

  const base = await resolveBaseUrl();
  const ver = await getJson(`${base}user/company`);
  const company = ver.json?.data?.company_name ?? ver.json?.company_name ?? null;
  if (!ver.ok || !company) { console.log(`Key/connection check failed (status ${ver.status}) for ${base}`); process.exit(1); }
  const label = (typeof ARGS.label === 'string' && ARGS.label) || company;
  const OUT = path.join(__dirname, `${slug(label)}-options-audit.xlsx`);
  console.log(`\n=== Options audit (read-only)  account: ${company}  (${base}) ===\n`);

  // 1. Page through all Zuper products
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

  // 2. Numeric (SRS) PARTS → option_values count
  const zByPid = new Map();
  for (const p of products) {
    if (p.product_type !== 'PARTS') continue;
    const id = String(p.product_id ?? '');
    if (!/^\d+$/.test(id)) continue;
    const ov = p.option?.option_values;
    zByPid.set(Number(id), { name: p.product_name || '', uid: p.product_uid, optCount: Array.isArray(ov) ? ov.length : 0 });
  }
  const ids = [...zByPid.keys()];
  console.log(`Numeric SRS PARTS in account: ${ids.length}`);

  // 3. SRS variants + products for cross-reference
  const srsByPid = new Map();
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const v = await fetchAll(supabase, 'srs_variants', 'product_id,color_name,size_name,is_restricted',
      { filters: [{ op: 'in', args: ['product_id', chunk] }, { op: 'eq', args: ['is_restricted', false] }], orderBy: 'variant_id' });
    for (const r of v) {
      const c = realOpt(r.color_name) ? r.color_name.trim() : null;
      const sz = realOpt(r.size_name) ? r.size_name.trim() : null;
      if (!c && !sz) continue;
      const e = srsByPid.get(r.product_id) || { colors: new Set(), sizes: new Set(), pairs: [] };
      if (c) e.colors.add(c);
      if (sz) e.sizes.add(sz);
      e.pairs.push([c, sz]);   // real combos in variant order — composite preview uses these, not a cartesian
      srsByPid.set(r.product_id, e);
    }
  }
  const srsProd = new Map();
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const rows = await fetchAll(supabase, 'srs_products', 'product_id,product_name,product_category,manufacturer_norm',
      { filters: [{ op: 'in', args: ['product_id', chunk] }], orderBy: 'product_id' });
    for (const r of rows) srsProd.set(r.product_id, r);
  }

  // 4. Classify — buckets mirror the backfill's axis choice:
  //    both color & size vary → composite; color present → color; only size>1 → size.
  const rowsOut = [];
  let inSrs = 0, shouldOpt = 0, hasOpt = 0, missedColor = 0, missedSize = 0, missedComposite = 0, okOpt = 0, notInSrs = 0;
  for (const pid of ids) {
    const z = zByPid.get(pid), s = srsByPid.get(pid);
    if (!s) { notInSrs++; continue; }
    inSrs++;
    const colors = [...s.colors], sizes = [...s.sizes];
    const cVary = colors.length > 1, sVary = sizes.length > 1;
    // What the backfill would load for this product (null = nothing selectable).
    // Mirror backfill's buildOptionValues precedence: load the axis that VARIES.
    let axis = null, expected = [];
    if (cVary && sVary) {
      axis = 'composite';
      const seen = new Set();
      for (const [c, sz] of (s.pairs || [])) {
        const label = [c, sz].filter(Boolean).join(' — ');
        if (label && !seen.has(label)) { seen.add(label); expected.push(label); }
      }
    }
    else if (cVary) { axis = 'color'; expected = colors; }
    else if (sVary) { axis = 'size'; expected = sizes; }
    else if (colors.length >= 1) { axis = 'color'; expected = colors; }
    const zHas = z.optCount > 0;
    if (zHas) hasOpt++;
    if (axis) shouldOpt++;
    const base2 = { product_id: pid, name: srsProd.get(pid)?.product_name || z.name, category: srsProd.get(pid)?.product_category || '', brand: srsProd.get(pid)?.manufacturer_norm || '', zuper_uid: z.uid, zuper_optvalues: z.optCount };
    if (axis && !zHas) {
      if (axis === 'color') missedColor++;
      else if (axis === 'size') missedSize++;
      else missedComposite++;
      rowsOut.push({ ...base2, kind: `MISSED ${axis} options (fixable)`, expected_count: expected.length, expected: expected.slice(0, 20).join(', ') });
    } else if (axis && zHas) okOpt++;
  }

  // 5. Report
  const missedTotal = missedColor + missedSize + missedComposite;
  console.log('\n--- Summary ---');
  console.log(`  account numeric PARTS:                 ${ids.length}`);
  console.log(`  matched to SRS catalog:                ${inSrs}  (not in SRS: ${notInSrs})`);
  console.log(`  should have options (SRS):             ${shouldOpt}`);
  console.log(`    ✓ present in Zuper:                  ${okOpt}`);
  console.log(`    ✗ MISSED (empty in Zuper):           ${missedTotal}`);
  console.log(`        color:                           ${missedColor}`);
  console.log(`        size-only:                       ${missedSize}`);
  console.log(`        composite (color+size):          ${missedComposite}`);
  console.log(`  any product with non-empty options:    ${hasOpt}`);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Missing options', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { key: 'product_id', header: 'SRS product_id', width: 14 },
    { key: 'name', header: 'Product Name', width: 50 },
    { key: 'category', header: 'Category', width: 22 },
    { key: 'brand', header: 'Brand', width: 18 },
    { key: 'kind', header: 'Issue', width: 34 },
    { key: 'expected_count', header: '# expected options', width: 16 },
    { key: 'expected', header: 'Expected option values', width: 60 },
    { key: 'zuper_optvalues', header: 'Zuper option_values', width: 16 },
    { key: 'zuper_uid', header: 'Zuper product_uid', width: 40 },
  ];
  ws.getRow(1).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } }; });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: 9 } };
  rowsOut.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || b.expected_count - a.expected_count);
  rowsOut.forEach(r => {
    const row = ws.addRow(r);
    // color = pink, size = yellow, composite = blue
    const bg = r.kind.includes('color') ? 'FFFAD9D5' : r.kind.includes('size') ? 'FFFDF3D6' : 'FFD6E4FA';
    row.eachCell({ includeEmpty: true }, c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }; c.font = { size: 9 }; });
  });
  await wb.xlsx.writeFile(OUT);
  console.log(`\n✓ Wrote ${path.basename(OUT)}  (${rowsOut.length} rows: ${missedColor} color + ${missedSize} size-only + ${missedComposite} composite)`);
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
