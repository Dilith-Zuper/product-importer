/**
 * Reusable: populate a Zuper vendor's catalog with the correct vendor_sku from the
 * source catalog DB. Zuper's vendor catalog holds ONE vendor_sku per product (the schema
 * is { product, vendor_sku, vendor_cost, remarks } — there is NO per-option/per-color
 * SKU support anywhere: option_values carry only option_uid/option_value). So this writes
 * one entry per matched product.
 *
 * For variant-sku-keyed sources (qxo-sku) the Zuper product_id IS a specific QXO
 * variant_sku, so each product maps to exactly one catalog variant — no representative-
 * color guessing. The vendor_sku is taken from that variant via --sku-field
 * (variant_sku | product_number | manufacturer_number; default variant_sku). vendor_cost
 * is the product's purchase_price (falls back to price, else 0).
 *
 * Pairs with the option backfill: backfill writes the color options for the customer-
 * facing picker; this writes the single orderable SKU for the vendor.
 *
 * Zuper quirks (learned the hard way): vendor_cost must be a STRING and remarks is
 * required — a numeric cost is rejected with a misleading "Vendor SKU should be unique"
 * 400. The batch POST is non-atomic (it persists rows before erroring). The catalog is
 * listed via GET /vendor_catalogs?filter.vendor (the vendor GET never returns it), and
 * each entry's per-color options[] are derived live from the product's option_values.
 *
 * Read-only against Supabase. Writes to Zuper only with --run (appends to the vendor's
 * catalog; products already present are skipped). The vendor must already exist.
 *
 * Connection (pick one):  --login <name> | --region <region> | --base <url>
 * Auth:                    --key <apiKey>  (or ZUPER_API_KEY in the environment)
 * Catalog:                 --source qxo-sku            (variant-sku keyed; required for now)
 *                          --sku-field variant_sku|product_number|manufacturer_number
 *                          --vendor "<name>"           (default per source)
 * Mode (required, safety): --dry-run [--limit N]  | --run [--limit N]
 * Options:                 --label "Name"  (output-file prefix; default company name)
 *
 *   node update-vendor-catalog.js --key XXX --login elite-options-contracting \
 *        --source qxo-sku --vendor "QXO" --dry-run
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { getCatalogConfig, resolveOwnVariantSkus } = require('./lib/account-catalog');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
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
const SOURCE = (typeof ARGS.source === 'string' ? ARGS.source : 'srs').toLowerCase();
const SKU_FIELD = (typeof ARGS['sku-field'] === 'string' ? ARGS['sku-field'] : 'variant_sku');
const MODE = ARGS.run ? 'run' : ARGS['dry-run'] ? 'dry-run' : null;
const LIMIT = typeof ARGS.limit !== 'undefined' ? Number(ARGS.limit) : Infinity;
const POST_CHUNK = 200;

const DEFAULT_VENDORS = {
  srs: ['SRS Distribution Inc', 'SRS'],
  abc: ['ABC Supply Co Inc', 'ABC Supply', 'ABC'],
  qxo: ['QXO Inc', 'QXO'],
  'qxo-sku': ['QXO Inc', 'QXO'],
};

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

async function reqJson(url, opts = {}) {
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
  const r = await reqJson(`${base}product?count=1&page=1`);
  if (r.ok && Array.isArray(r.json?.data)) return 'product';
  return 'products';
}

async function main() {
  if (!MODE) { console.log('Specify a mode: --dry-run [--limit N] | --run [--limit N]'); process.exit(1); }
  if (!API_KEY) { console.log('Provide --key <apiKey> or set ZUPER_API_KEY'); process.exit(1); }
  // Resolve config early so an unsupported source / sku-field fails before any network I/O.
  const cfg = getCatalogConfig(SOURCE);
  if ((cfg.keyMode || '') !== 'variant-sku') {
    console.log(`--source ${SOURCE} is not supported yet: a single vendor_sku per product is only well-defined for variant-sku-keyed sources (qxo-sku), where the product_id IS one variant. For SRS/ABC/QXO the product maps to a parent with many variants — pick a representative-variant rule first.`);
    process.exit(1);
  }
  H = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };

  const base = await resolveBaseUrl();
  const ver = await reqJson(`${base}user/company`);
  const company = ver.json?.data?.company_name ?? ver.json?.company_name ?? null;
  if (!ver.ok || !company) { console.log(`Key/connection check failed (status ${ver.status}) for ${base}`); process.exit(1); }
  const label = (typeof ARGS.label === 'string' && ARGS.label) || company;
  const prefix = slug(label);
  console.log(`\n=== Vendor catalog update  [${MODE}]  account: ${company}  catalog: ${SOURCE.toUpperCase()}  sku-field: ${SKU_FIELD}  (${base}) ===\n`);

  // 1. Target vendor.
  const wanted = (typeof ARGS.vendor === 'string' && ARGS.vendor) ? [ARGS.vendor] : (DEFAULT_VENDORS[SOURCE] || []);
  const wantedLc = wanted.map(s => s.trim().toLowerCase());
  const vendors = [];
  for (let page = 1; page < 50; page++) {
    const r = await reqJson(`${base}vendors?count=100&page=${page}`);
    const rows = r.json?.data || [];
    vendors.push(...rows);
    if (rows.length < 100) break;
  }
  const vendor = vendors.find(v => wantedLc.includes(String(v.vendor_name || '').trim().toLowerCase()));
  if (!vendor) {
    console.log(`Vendor not found. Looked for: ${wanted.join(' / ')}`);
    console.log(`Vendors on account: ${vendors.map(v => `"${v.vendor_name}"`).join(', ') || '(none)'}`);
    console.log('Pass --vendor "<exact name>" to choose one.');
    process.exit(1);
  }
  console.log(`Target vendor: "${vendor.vendor_name}"  (${vendor.vendor_uid})`);

  // 2. Existing catalog → product uids already present (skip those products).
  // NB: GET /vendors/{uid} does NOT return the catalog (its vendor_catalog field is
  // always empty); the catalog is only listed via GET /vendor_catalogs?filter.vendor.
  const existingUids = new Set();
  const existingSkus = new Set();
  for (let page = 1; page < 100; page++) {
    const r = await reqJson(`${base}vendor_catalogs?filter.vendor=${vendor.vendor_uid}&count=100&page=${page}`);
    const rows = r.json?.data || [];
    for (const e of rows) {
      const uid = typeof e.product === 'string' ? e.product : e.product?.product_uid;
      if (uid) existingUids.add(uid);
      if (e.vendor_sku != null) existingSkus.add(String(e.vendor_sku));
    }
    if (rows.length < 100) break;
  }
  console.log(`Existing catalog covers ${existingUids.size} products / ${existingSkus.size} SKUs (skipped).`);

  // 3. Page products; keep numeric PARTS.
  const listSegment = await resolveListSegment(base);
  const products = [];
  let page = 1, total = null;
  while (true) {
    const { json } = await reqJson(`${base}${listSegment}?page=${page}&count=100`);
    const rows = json?.data || [];
    if (total === null) total = json?.total_records;
    products.push(...rows);
    process.stdout.write(`  scanning ${products.length}/${total ?? '?'}\r`);
    if (rows.length < 100) break;
    page++; if (page > 200) break;
  }
  const numericParts = products.filter(p => p.product_type === 'PARTS' && /^\d+$/.test(String(p.product_id ?? '')));
  console.log(`\nNumeric PARTS: ${numericParts.length}`);

  // 4. Each product's own-variant SKU from the DB.
  const ids = [...new Set(numericParts.map(p => Number(p.product_id)))];
  const skuByPid = await resolveOwnVariantSkus(supabase, SOURCE, ids, SKU_FIELD);
  console.log(`Matched to ${SOURCE.toUpperCase()} catalog (own variant has ${SKU_FIELD}): ${skuByPid.size}  (not matched: ${ids.length - skuByPid.size})`);

  // 5. Build one entry per product (skip those already in the catalog).
  let candidates = numericParts.filter(p => skuByPid.has(Number(p.product_id)) && !existingUids.has(p.product_uid));
  const alreadyInCatalog = numericParts.filter(p => skuByPid.has(Number(p.product_id)) && existingUids.has(p.product_uid)).length;
  if (Number.isFinite(LIMIT)) candidates = candidates.slice(0, LIMIT);

  // Zuper requires vendor_sku unique across the catalog. The account can hold duplicate
  // product records sharing one product_id (→ same variant_sku), so dedupe by vendor_sku:
  // keep the first product, drop the rest (a SKU can only point at one product).
  const cost = p => Number(p.purchase_price ?? p.price ?? 0) || 0;
  const entries = [];
  const usedSku = new Set();
  const dupSkipped = [];
  for (const p of candidates) {
    const sku = String(skuByPid.get(Number(p.product_id)));
    // A vendor_sku must be unique across the whole catalog — skip if already present
    // (an existing entry, or an earlier candidate sharing this variant_sku).
    if (usedSku.has(sku) || existingSkus.has(sku)) { dupSkipped.push({ product_id: p.product_id, product_uid: p.product_uid, vendor_sku: sku }); continue; }
    usedSku.add(sku);
    // vendor_cost MUST be a string and remarks is required — Zuper rejects a numeric
    // cost with a misleading "Vendor SKU should be unique" 400. The catalog's per-color
    // options are derived live from the product's option_values, so we don't send them.
    entries.push({ product: p.product_uid, vendor_sku: String(sku), vendor_cost: String(cost(p)), remarks: '' });
  }
  console.log(`Entries to write: ${entries.length}  (already in vendor catalog: ${alreadyInCatalog}; duplicate-SKU products skipped: ${dupSkipped.length})`);
  if (dupSkipped.length) console.log(`  duplicate-SKU skipped sample: ${dupSkipped.slice(0, 8).map(d => `${d.product_id}`).join(', ')}`);

  if (MODE === 'dry-run') {
    const outFile = path.join(__dirname, `${prefix}-vendor-catalog-dryrun.json`);
    fs.writeFileSync(outFile, JSON.stringify({
      account: company, vendor: vendor.vendor_name, vendor_uid: vendor.vendor_uid, sku_field: SKU_FIELD,
      entries: entries.length, sample: entries.slice(0, 60),
    }, null, 2));
    console.log(`\nDry-run: would POST ${entries.length} entries to "${vendor.vendor_name}". Sample → ${path.basename(outFile)}.`);
    return;
  }

  if (!entries.length) { console.log('\nNothing to write.'); return; }
  console.log(`\nWriting ${entries.length} entries to "${vendor.vendor_name}" in chunks of ${POST_CHUNK} …`);
  const results = { posted: 0, chunks_ok: 0, chunks_failed: 0, failures: [] };
  for (let i = 0; i < entries.length; i += POST_CHUNK) {
    const chunk = entries.slice(i, i + POST_CHUNK);
    const res = await reqJson(`${base}vendors/${vendor.vendor_uid}/catalog`, { method: 'POST', body: JSON.stringify({ vendor_catalog: chunk }) });
    const ok = res.ok && (res.json?.type === 'success' || res.json?.data || res.status < 300);
    if (ok) { results.posted += chunk.length; results.chunks_ok++; }
    else { results.chunks_failed++; results.failures.push({ at: i, status: res.status, message: res.json?.message ?? JSON.stringify(res.json) }); }
    process.stdout.write(`  ${Math.min(i + POST_CHUNK, entries.length)}/${entries.length}\r`);
  }
  console.log('\n\n--- Result ---');
  console.log(`  entries posted: ${results.posted}/${entries.length}`);
  console.log(`  chunks ok: ${results.chunks_ok}  failed: ${results.chunks_failed}`);
  const outFile = path.join(__dirname, `${prefix}-vendor-catalog-results.json`);
  fs.writeFileSync(outFile, JSON.stringify({ account: company, vendor: vendor.vendor_name, vendor_uid: vendor.vendor_uid, sku_field: SKU_FIELD, ...results }, null, 2));
  if (results.failures.length) {
    console.log(`  ${results.failures.length} chunk(s) failed — see ${path.basename(outFile)}`);
    for (const f of results.failures.slice(0, 5)) console.log(`    @${f.at} status ${f.status}: ${String(f.message).slice(0, 140)}`);
  }
  console.log(`✓ Wrote ${path.basename(outFile)}`);
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
