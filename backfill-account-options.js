/**
 * Reusable: backfill missing COLOR options on any Zuper account that was imported
 * from the SRS catalog. Products that have colors in SRS but were uploaded with an
 * empty option block get their `option.option_values` repopulated via GET → PUT
 * (round-trips the whole product, changes ONLY `option`). This is the generalized
 * form of the High Impact Roofing remediation.
 *
 * Flags match the wizard builder by default: SHINGLES → customer_selection/mandate
 * = true; everything else → false (use --selection all to make every color product
 * customer-selectable). Colors come from srs_variants (deduped, N/A stripped, cap 50).
 * No SKUs here — those are the separate vendor catalog.
 *
 * Read-only against SRS (Supabase). Writes to Zuper only in --test-one / --run.
 *
 * Connection (pick one):
 *   --login  <name>    resolve region from the company login name (accounts config)
 *   --region <region>  e.g. us-west-1c  → https://us-west-1c.zuperpro.com/api/
 *   --base   <url>     full base, e.g. https://us-west-1c.zuperpro.com/api/
 * Auth:
 *   --key <apiKey>     (or set ZUPER_API_KEY in the environment)
 *
 * Mode (required, safety):
 *   --test-one              PUT a single product, show before/after
 *   --dry-run [--limit N]   build payloads, write JSON sample, no writes
 *   --run [--limit N]       live backfill (bounded concurrency)
 * Options:
 *   --label "Name"          output-file prefix (default: resolved company name)
 *   --selection wizard|all  customer_selection behavior (default: wizard)
 *
 * Examples:
 *   node backfill-account-options.js --key XXX --region us-west-1c --label "High Impact" --test-one
 *   node backfill-account-options.js --key XXX --login HPACT --run
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { fetchAll } = require('./lib/utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const realOpt = s => s && String(s).trim() && !['n/a', 'na'].includes(String(s).trim().toLowerCase());
const slug = s => String(s || 'account').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'account';

// ── args ──────────────────────────────────────────────────────────────────────
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
const MODE = ARGS.run ? 'run' : ARGS['test-one'] ? 'test-one' : ARGS['dry-run'] ? 'dry-run' : null;
const LIMIT = typeof ARGS.limit !== 'undefined' ? Number(ARGS.limit) : Infinity;
const SELECTION = ARGS.selection === 'all' ? 'all' : 'wizard';
const CONCURRENCY = 6;

let H;   // set after we have the key

// ── connection ──────────────────────────────────────────────────────────────
async function resolveBaseUrl() {
  if (typeof ARGS.base === 'string') {
    let b = ARGS.base.trim().replace(/\/+$/, '');
    if (!b.endsWith('/api')) b += '/api';
    return b + '/';
  }
  if (typeof ARGS.region === 'string') return `https://${ARGS.region}.zuperpro.com/api/`;
  if (typeof ARGS.login === 'string') {
    const r = await fetch('https://accounts.zuperpro.com/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ company_name: ARGS.login }),
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

// Product-list segment differs by data-center: `product` (singular) vs `products`.
async function resolveListSegment(base) {
  const r = await getJson(`${base}product?count=1&page=1`);
  if (r.ok && Array.isArray(r.json?.data)) return 'product';
  return 'products';
}

// ── payload (GET → PUT, replace only `option`) ────────────────────────────────
function buildPutPayload(g, colors, isShingles) {
  const sel = SELECTION === 'all' ? { cs: true, mc: false } : { cs: isShingles, mc: isShingles };
  const metaData = (g.meta_data || []).map((m, i) => ({
    hide_field: !!m.hide_field, hide_to_fe: !!m.hide_to_fe, id: i, label: m.label,
    read_only: false, type: m.type, dependent_on: '', dependent_options: [],
    module_name: m.module_name ?? 'PRODUCT', value: m.value ?? '',
  }));
  const loc = (g.location_availability || [])[0];
  const product = {
    prefix: g.prefix ?? '', product_name: g.product_name, product_id: g.product_id,
    is_available: g.is_available ?? true, product_category: g.product_category?.category_uid ?? '',
    price: g.price ?? 0, min_quantity: g.min_quantity ?? 1, currency: g.currency ?? '',
    quantity: g.quantity ?? 1, product_manual_link: g.product_manual_link ?? '',
    product_description: g.product_description ?? '', product_image: g.product_image ?? '',
    product_type: g.product_type ?? 'PARTS', purchase_price: g.purchase_price ?? null,
    brand: g.brand ?? '', track_quantity: g.track_quantity ?? true, specification: g.specification ?? '',
    has_custom_tax: g.has_custom_tax ?? false, meta_data: metaData, uom: g.uom ?? '',
    is_billable: g.is_billable ?? true, consider_profitability: g.consider_profitability ?? true,
    is_commissionable: g.is_commissionable ?? true, bu_uids: null, product_uid: g.product_uid,
    product_barcode: g.product_barcode ?? '',
    location_availability: loc ? [{ location: loc.location?.location_uid ?? loc.location, min_quantity: loc.min_quantity ?? 1, quantity: loc.quantity ?? 1, serial_nos: [] }] : [],
    tax: { tax_exempt: g.tax?.tax_exempt ?? false, tax_name: '', tax_rate: '' },
    markup: g.markup ?? null, product_files: g.product_files ?? [],
    option: {
      customer_selection: sel.cs, mandate_customer_selection: sel.mc, option_label: 'Color',
      option_values: colors.map(c => ({ option_value: c, option_image: '', is_available: true })),
    },
  };
  if (g.formula?.formula_uid) product.formula = g.formula.formula_uid;
  return { product, vendor: [] };
}

// ── load the missing set (SRS) ────────────────────────────────────────────────
async function loadMissing(base, listSegment) {
  const prods = [];
  let page = 1, total = null;
  while (true) {
    const { json } = await getJson(`${base}${listSegment}?page=${page}&count=100`);
    const rows = json?.data || [];
    if (total === null) total = json?.total_records;
    prods.push(...rows);
    process.stdout.write(`  scanning ${prods.length}/${total ?? '?'}\r`);
    if (rows.length < 100) break;
    page++; if (page > 200) break;
  }
  console.log(`\nScanned ${prods.length} products.`);
  const candidates = prods
    .filter(p => p.product_type === 'PARTS' && /^\d+$/.test(String(p.product_id ?? '')))
    .filter(p => !(Array.isArray(p.option?.option_values) && p.option.option_values.length > 0))
    .map(p => ({ uid: p.product_uid, pid: Number(p.product_id), name: p.product_name }));

  const ids = candidates.map(c => c.pid);
  const colorsByPid = new Map();
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const v = await fetchAll(supabase, 'srs_variants', 'product_id,color_name,is_restricted',
      { filters: [{ op: 'in', args: ['product_id', chunk] }, { op: 'eq', args: ['is_restricted', false] }], orderBy: 'variant_id' });
    for (const r of v) {
      if (!realOpt(r.color_name)) continue;
      const set = colorsByPid.get(r.product_id) || new Set();
      set.add(r.color_name.trim());
      colorsByPid.set(r.product_id, set);
    }
  }
  const missing = candidates.filter(c => (colorsByPid.get(c.pid)?.size ?? 0) > 0);
  console.log(`Color-bearing SRS parts missing options in Zuper: ${missing.length}`);
  return { missing, colorsByPid };
}

async function processOne({ uid, pid }, colorsByPid, base, { write }) {
  const { json } = await getJson(`${base}product/${uid}`);
  const g = Array.isArray(json?.data) ? json.data[0] : json?.data;
  if (!g) return { uid, pid, status: 'get_failed' };
  if (Array.isArray(g.option?.option_values) && g.option.option_values.length > 0) return { uid, pid, status: 'already_has_options' };
  const colors = [...(colorsByPid.get(pid) || [])].slice(0, 50);
  if (colors.length === 0) return { uid, pid, status: 'no_srs_colors' };
  const isShingles = (g.product_category?.category_name || '').toUpperCase() === 'SHINGLES';
  const payload = buildPutPayload(g, colors, isShingles);
  if (!write) return { uid, pid, status: 'dry_run', colors: colors.length, isShingles, payload, before: g };
  const res = await getJson(`${base}product/${uid}`, { method: 'PUT', body: JSON.stringify(payload) });
  const ok = res.ok && (res.json?.type === 'success' || res.json?.data);
  return { uid, pid, status: ok ? 'updated' : 'put_failed', colors: colors.length, message: ok ? '' : (res.json?.message ?? JSON.stringify(res.json)) };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!MODE) { console.log('Specify a mode: --test-one | --dry-run [--limit N] | --run [--limit N]'); process.exit(1); }
  if (!API_KEY) { console.log('Provide --key <apiKey> or set ZUPER_API_KEY'); process.exit(1); }
  H = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };

  const base = await resolveBaseUrl();
  const ver = await getJson(`${base}user/company`);
  const company = ver.json?.data?.company_name ?? ver.json?.company_name ?? null;
  if (!ver.ok || !company) { console.log(`Key/connection check failed (status ${ver.status}) for ${base}`); process.exit(1); }
  const label = (typeof ARGS.label === 'string' && ARGS.label) || company;
  const prefix = slug(label);
  console.log(`\n=== Color-option backfill  [${MODE}]  account: ${company}  (${base}) ===`);
  console.log(`Selection mode: ${SELECTION}\n`);

  const listSegment = await resolveListSegment(base);
  const { missing, colorsByPid } = await loadMissing(base, listSegment);

  let work = missing;
  if (MODE === 'test-one') work = missing.slice(0, 1);
  else if (Number.isFinite(LIMIT)) work = missing.slice(0, LIMIT);

  if (MODE === 'test-one') {
    if (!work.length) { console.log('Nothing missing — no test product to update.'); return; }
    const m = work[0];
    console.log(`\nTest product: pid=${m.pid} uid=${m.uid}  "${m.name}"`);
    const before = await getJson(`${base}product/${m.uid}`);
    const bg = Array.isArray(before.json?.data) ? before.json.data[0] : before.json?.data;
    console.log(`  BEFORE option_values: ${JSON.stringify(bg?.option?.option_values)}`);
    const r = await processOne(m, colorsByPid, base, { write: true });
    console.log(`  PUT status: ${r.status}  colors sent: ${r.colors}  ${r.message || ''}`);
    const after = await getJson(`${base}product/${m.uid}`);
    const ag = Array.isArray(after.json?.data) ? after.json.data[0] : after.json?.data;
    console.log(`  AFTER option_values: ${JSON.stringify((ag?.option?.option_values || []).map(o => o.option_value))}`);
    console.log('\n  Field-preservation check:');
    for (const f of ['product_name', 'price', 'purchase_price', 'uom', 'brand']) console.log(`    ${f}: ${JSON.stringify(bg?.[f])} -> ${JSON.stringify(ag?.[f])}`);
    console.log(`    category_uid: ${bg?.product_category?.category_uid} -> ${ag?.product_category?.category_uid}`);
    console.log(`    formula_uid: ${bg?.formula?.formula_uid} -> ${ag?.formula?.formula_uid}`);
    console.log(`    customer_selection: ${ag?.option?.customer_selection}  mandate: ${ag?.option?.mandate_customer_selection}`);
    return;
  }

  if (MODE === 'dry-run') {
    const sample = [];
    for (const m of work.slice(0, Math.min(work.length, 50))) sample.push(await processOne(m, colorsByPid, base, { write: false }));
    const outFile = path.join(__dirname, `${prefix}-backfill-dryrun.json`);
    fs.writeFileSync(outFile, JSON.stringify({ account: company, count: work.length, sample }, null, 2));
    console.log(`Dry-run: ${work.length} products would be updated. Sample of ${sample.length} payloads → ${path.basename(outFile)}.`);
    return;
  }

  console.log(`Live backfill of ${work.length} products at concurrency ${CONCURRENCY} …`);
  const results = [];
  let done = 0;
  for (let i = 0; i < work.length; i += CONCURRENCY) {
    const batch = work.slice(i, i + CONCURRENCY);
    const r = await Promise.all(batch.map(m => processOne(m, colorsByPid, base, { write: true }).catch(e => ({ uid: m.uid, pid: m.pid, status: 'error', message: e.message }))));
    results.push(...r);
    done += batch.length;
    process.stdout.write(`  ${done}/${work.length}\r`);
  }
  const tally = {};
  for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
  console.log('\n\n--- Result ---');
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`);
  const outFile = path.join(__dirname, `${prefix}-backfill-results.json`);
  fs.writeFileSync(outFile, JSON.stringify({ account: company, results }, null, 2));
  const fails = results.filter(r => ['put_failed', 'error', 'get_failed'].includes(r.status));
  if (fails.length) console.log(`  ${fails.length} failures — see ${path.basename(outFile)}`);
  console.log(`✓ Wrote ${path.basename(outFile)}`);
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
