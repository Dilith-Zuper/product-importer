/**
 * Reusable: backfill missing COLOR / SIZE options on any Zuper account that was
 * imported from a source catalog (SRS or QXO). Products that vary in the catalog but
 * were uploaded with an empty option block get their `option.option_values`
 * repopulated via GET → PUT (round-trips the whole product, changes ONLY `option`).
 * This is the generalized form of the High Impact Roofing remediation.
 *
 * --source qxo audits/fixes a QXO-imported account: account product_ids are matched
 * back to qxo_products by digit-stripping the "C-…" product_key (the wizard upload's
 * own stamping rule), and options are COLOR-ONLY — QXO has no single size column and
 * the wizard uploads it color-only. The SRS↔QXO difference lives in
 * lib/account-catalog.js, shared with audit-account-options.js.
 *
 * Option axis is chosen per product from srs_variants (deduped, N/A stripped, cap 50):
 *   - both color & size vary  → COMPOSITE values ("Black — 36\" x 144'"), built from
 *                               the REAL variant combinations (not a cartesian product);
 *                               option_label 'Variant'
 *   - color present            → color values; option_label 'Color'
 *   - only size varies (>1)    → size values;  option_label 'Size'
 * Use --colors-only to reproduce the legacy color-only behavior.
 *
 * Zuper hard-caps option_values at 50. When a composite would exceed that, we fall back
 * to the largest single axis that fits (loading it in full beats an arbitrary 50-combo
 * slice); only if even that axis is >50 do we truncate. Every fallback/truncation is
 * reported on screen and as a `note` in the results JSON.
 *
 * Selection flags by default: SHINGLES color → customer_selection/mandate = true;
 * everything else (color, size, composite) → false, i.e. a non-mandatory tag
 * (--selection all makes every product customer-selectable, non-mandatory).
 * No SKUs here — those are the separate vendor catalog (keyed by color).
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
 *   --source srs|qxo        catalog to resolve options from (default srs)
 *   --label "Name"          output-file prefix (default: resolved company name)
 *   --selection wizard|all  customer_selection behavior (default: wizard)
 *   --colors-only           legacy: load color options only, skip size/composite
 *   --upgrade               also re-write products that already have options when the
 *                           catalog now implies a different set (e.g. color → composite)
 *
 * Examples:
 *   node backfill-account-options.js --key XXX --region us-west-1c --label "High Impact" --test-one
 *   node backfill-account-options.js --key XXX --login HPACT --run
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { getCatalogConfig, indexAccountProducts, realOpt } = require('./lib/account-catalog');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
const SOURCE = (typeof ARGS.source === 'string' ? ARGS.source : 'srs').toLowerCase();
const CFG = getCatalogConfig(SOURCE);     // throws on an unknown --source
// Whether the source carries a usable size axis. QXO is color-only (no single size
// column; the wizard uploads it color-only), so size/composite are disabled for it.
const INCLUDE_SIZE = CFG.includeSize;
const MODE = ARGS.run ? 'run' : ARGS['test-one'] ? 'test-one' : ARGS['dry-run'] ? 'dry-run' : null;
const LIMIT = typeof ARGS.limit !== 'undefined' ? Number(ARGS.limit) : Infinity;
const SELECTION = ARGS.selection === 'all' ? 'all' : 'wizard';
const COLORS_ONLY = !!ARGS['colors-only'] || !INCLUDE_SIZE;
// --upgrade: also re-process products that ALREADY have an option block, replacing it
// when the catalog now implies a different set (e.g. a color-only product that should
// become composite once sizes are loaded). Off by default — default only fills empties.
const UPGRADE = !!ARGS.upgrade;
const CONCURRENCY = 6;
const OPTION_CAP = 50;

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

// ── option axis selection ─────────────────────────────────────────────────────
// Decide what to load for a product from its SRS variants. `pairs` is the list of
// real (color, size) tuples in variant order (each side may be null when N/A). We
// load whichever axis actually VARIES — a constant color (e.g. one "Bronze") on a
// product whose real choice is its 5 sizes must not collapse to just ["Bronze"].
// Returns { kind, option_label, values, note } or null when there's nothing selectable.
//   - both axes vary (>1 each) → composite ("Color — Size") from REAL pairs (no cartesian)
//   - only color varies        → color values
//   - only size varies         → size values
//   - neither varies, 1 color  → that single color (legacy behavior)
//
// Zuper hard-caps option_values at OPTION_CAP (50). When a composite exceeds that, we
// fall back to the largest SINGLE axis that still fits (loading it in full beats an
// arbitrary 50-combo slice); only if even that axis is >50 do we truncate. `note` is
// set whenever we fell back or truncated, so callers can surface it.
// --colors-only collapses size/composite out, leaving only the color paths.
function buildOptionValues(colors, sizes, pairs) {
  const cap = (arr) => arr.slice(0, OPTION_CAP);
  const cVary = colors.size > 1, sVary = sizes.size > 1;
  const colorVals = [...colors], sizeVals = [...sizes];

  if (!COLORS_ONLY && cVary && sVary) {
    const seen = new Set(), combos = [];
    for (const [c, s] of pairs) {
      const label = [c, s].filter(realOpt).map(x => x.trim()).join(' — ');
      if (!label || seen.has(label)) continue;
      seen.add(label); combos.push(label);
    }
    if (combos.length) {
      if (combos.length <= OPTION_CAP) return { kind: 'composite', option_label: 'Variant', values: combos, note: '' };
      // Overflow — pick the largest single axis that fits; else the largest, capped.
      const axes = [
        { kind: 'color', option_label: 'Color', vals: colorVals },
        { kind: 'size',  option_label: 'Size',  vals: sizeVals },
      ].sort((a, b) => b.vals.length - a.vals.length);
      const pick = axes.find(a => a.vals.length <= OPTION_CAP) || axes[0];
      const truncated = pick.vals.length > OPTION_CAP;
      const note = `composite ${combos.length} combos > ${OPTION_CAP} cap → fell back to ${pick.kind} axis (${Math.min(pick.vals.length, OPTION_CAP)}${truncated ? ` of ${pick.vals.length}, still truncated` : ' — full'})`;
      return { kind: pick.kind, option_label: pick.option_label, values: cap(pick.vals), note };
    }
  }
  if (cVary) return { kind: 'color', option_label: 'Color', values: cap(colorVals), note: capNote('color', colorVals.length) };
  if (!COLORS_ONLY && sVary) return { kind: 'size', option_label: 'Size', values: cap(sizeVals), note: capNote('size', sizeVals.length) };
  if (colors.size >= 1) return { kind: 'color', option_label: 'Color', values: cap(colorVals), note: capNote('color', colorVals.length) };
  return null;
}

function capNote(kind, n) {
  return n > OPTION_CAP ? `${kind} ${n} > ${OPTION_CAP} cap → truncated to ${OPTION_CAP}` : '';
}

// ── payload (GET → PUT, replace only `option`) ────────────────────────────────
function buildPutPayload(g, opt, isShingles) {
  // SHINGLES color stays a mandatory customer choice; size/composite/other color are
  // non-mandatory tags. --selection all makes everything customer-selectable (non-mandatory).
  const mandatory = isShingles && opt.kind === 'color';
  const sel = SELECTION === 'all' ? { cs: true, mc: false } : { cs: mandatory, mc: mandatory };
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
      customer_selection: sel.cs, mandate_customer_selection: sel.mc, option_label: opt.option_label,
      option_values: opt.values.map(v => ({ option_value: v, option_image: '', is_available: true })),
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
    // Default: only products with an empty option block. --upgrade also considers
    // already-optioned products (processOne then no-ops unless the set changed).
    .filter(p => UPGRADE || !(Array.isArray(p.option?.option_values) && p.option.option_values.length > 0))
    .map(p => ({ uid: p.product_uid, pid: Number(p.product_id), name: p.product_name }));

  const ids = candidates.map(c => c.pid);
  // Per-pid: distinct colors, distinct sizes, and real (color,size) pairs in variant
  // order (the pairing is what composite needs — a cartesian product would invent
  // combos that don't exist in the catalog). Source-specific resolution (SRS numeric
  // PK vs QXO digit-stripped product_key; color_name/size_name vs color-only) lives in
  // lib/account-catalog.js.
  const { optsByZid: optsByPid, collisions } = await indexAccountProducts(supabase, SOURCE, ids);
  if (collisions.length) {
    console.log(`⚠ ${collisions.length} account id(s) had >1 ${SOURCE.toUpperCase()} key digit-strip to the same product_id (using first).`);
  }
  // Keep a product only if it actually has something selectable to load. A lone
  // single size is not an option (mirrors the audit's `sizes > 1` rule).
  const missing = candidates.filter(c => {
    const e = optsByPid.get(c.pid);
    if (!e) return false;
    return e.colors.size >= 1 || (!COLORS_ONLY && e.sizes.size > 1);
  });
  console.log(`SRS parts missing options in Zuper (color/size/composite): ${missing.length}`);
  return { missing, optsByPid };
}

// Same set of option_value strings already live in Zuper? Then there's nothing to do.
function sameValues(existingOptionValues, values) {
  const cur = new Set((existingOptionValues || []).map(o => String(o.option_value)));
  if (cur.size !== values.length) return false;
  return values.every(v => cur.has(v));
}

async function processOne({ uid, pid }, optsByPid, base, { write }) {
  const { json } = await getJson(`${base}product/${uid}`);
  const g = Array.isArray(json?.data) ? json.data[0] : json?.data;
  if (!g) return { uid, pid, status: 'get_failed' };
  const existing = Array.isArray(g.option?.option_values) ? g.option.option_values : [];
  const hadOptions = existing.length > 0;
  // Without --upgrade we never touch a product that already has options.
  if (hadOptions && !UPGRADE) return { uid, pid, status: 'already_has_options' };
  const e = optsByPid.get(pid);
  const opt = e ? buildOptionValues(e.colors, e.sizes, e.pairs) : null;
  if (!opt) return { uid, pid, status: 'no_srs_options' };
  // --upgrade: skip when the live option set already matches what we'd write.
  if (hadOptions && sameValues(existing, opt.values)) return { uid, pid, status: 'already_ok', kind: opt.kind, count: opt.values.length };
  const isShingles = (g.product_category?.category_name || '').toUpperCase() === 'SHINGLES';
  const payload = buildPutPayload(g, opt, isShingles);
  const action = hadOptions ? 'upgraded' : 'updated';
  if (!write) return { uid, pid, status: 'dry_run', action, kind: opt.kind, count: opt.values.length, note: opt.note, isShingles, payload, before: g };
  const res = await getJson(`${base}product/${uid}`, { method: 'PUT', body: JSON.stringify(payload) });
  const ok = res.ok && (res.json?.type === 'success' || res.json?.data);
  return { uid, pid, status: ok ? action : 'put_failed', kind: opt.kind, count: opt.values.length, note: opt.note, message: ok ? '' : (res.json?.message ?? JSON.stringify(res.json)) };
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
  console.log(`\n=== Option backfill  [${MODE}]  account: ${company}  catalog: ${SOURCE.toUpperCase()}  (${base}) ===`);
  console.log(`Selection mode: ${SELECTION}${COLORS_ONLY ? (INCLUDE_SIZE ? '   (colors-only)' : '   (colors-only — source has no size axis)') : '   (color + size + composite)'}${UPGRADE ? '   (--upgrade: re-write changed sets)' : ''}\n`);

  const listSegment = await resolveListSegment(base);
  const { missing, optsByPid } = await loadMissing(base, listSegment);

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
    const r = await processOne(m, optsByPid, base, { write: true });
    console.log(`  PUT status: ${r.status}  kind: ${r.kind ?? '-'}  values sent: ${r.count ?? 0}  ${r.message || ''}`);
    if (r.note) console.log(`  ⚠ ${r.note}`);
    const after = await getJson(`${base}product/${m.uid}`);
    const ag = Array.isArray(after.json?.data) ? after.json.data[0] : after.json?.data;
    console.log(`  AFTER option_values: ${JSON.stringify((ag?.option?.option_values || []).map(o => o.option_value))}`);
    console.log('\n  Field-preservation check:');
    for (const f of ['product_name', 'price', 'purchase_price', 'uom', 'brand']) console.log(`    ${f}: ${JSON.stringify(bg?.[f])} -> ${JSON.stringify(ag?.[f])}`);
    console.log(`    category_uid: ${bg?.product_category?.category_uid} -> ${ag?.product_category?.category_uid}`);
    console.log(`    formula_uid: ${bg?.formula?.formula_uid} -> ${ag?.formula?.formula_uid}`);
    console.log(`    option_label: ${JSON.stringify(ag?.option?.option_label)}  customer_selection: ${ag?.option?.customer_selection}  mandate: ${ag?.option?.mandate_customer_selection}`);
    return;
  }

  if (MODE === 'dry-run') {
    const sample = [];
    for (const m of work.slice(0, Math.min(work.length, 50))) sample.push(await processOne(m, optsByPid, base, { write: false }));
    const outFile = path.join(__dirname, `${prefix}-backfill-dryrun.json`);
    fs.writeFileSync(outFile, JSON.stringify({ account: company, count: work.length, sample }, null, 2));
    if (UPGRADE) {
      // Under --upgrade most candidates already match (no-op); only sampled rows tell
      // us the real change rate, so report that instead of the full candidate count.
      const changed = sample.filter(r => r.status === 'dry_run').length;
      const noop = sample.filter(r => r.status === 'already_ok').length;
      console.log(`Dry-run (--upgrade): ${work.length} candidates scanned. In the ${sample.length}-product sample, ${changed} would change, ${noop} already match. Payloads → ${path.basename(outFile)}.`);
    } else {
      console.log(`Dry-run: ${work.length} products would be updated. Sample of ${sample.length} payloads → ${path.basename(outFile)}.`);
    }
    const noted = sample.filter(r => r.note);
    if (noted.length) {
      console.log(`\n⚠ ${noted.length}/${sample.length} sampled products hit the ${OPTION_CAP}-option cap (full live run may have more):`);
      for (const r of noted.slice(0, 20)) console.log(`    pid=${r.pid}  ${r.note}`);
    }
    return;
  }

  console.log(`Live backfill of ${work.length} products at concurrency ${CONCURRENCY} …`);
  const results = [];
  let done = 0;
  for (let i = 0; i < work.length; i += CONCURRENCY) {
    const batch = work.slice(i, i + CONCURRENCY);
    const r = await Promise.all(batch.map(m => processOne(m, optsByPid, base, { write: true }).catch(e => ({ uid: m.uid, pid: m.pid, status: 'error', message: e.message }))));
    results.push(...r);
    done += batch.length;
    process.stdout.write(`  ${done}/${work.length}\r`);
  }
  const tally = {}, kindTally = {};
  for (const r of results) {
    tally[r.status] = (tally[r.status] || 0) + 1;
    if ((r.status === 'updated' || r.status === 'upgraded') && r.kind) kindTally[r.kind] = (kindTally[r.kind] || 0) + 1;
  }
  console.log('\n\n--- Result ---');
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`);
  if (Object.keys(kindTally).length) console.log(`  updated by axis: ${Object.entries(kindTally).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const outFile = path.join(__dirname, `${prefix}-backfill-results.json`);
  fs.writeFileSync(outFile, JSON.stringify({ account: company, results }, null, 2));
  const fails = results.filter(r => ['put_failed', 'error', 'get_failed'].includes(r.status));
  if (fails.length) console.log(`  ${fails.length} failures — see ${path.basename(outFile)}`);
  const noted = results.filter(r => r.note);
  if (noted.length) {
    console.log(`\n⚠ ${noted.length} product(s) exceeded Zuper's ${OPTION_CAP}-option cap (fell back to a single axis / truncated — see "note" in ${path.basename(outFile)}):`);
    for (const r of noted.slice(0, 20)) console.log(`    pid=${r.pid}  ${r.note}`);
    if (noted.length > 20) console.log(`    … and ${noted.length - 20} more`);
  }
  console.log(`✓ Wrote ${path.basename(outFile)}`);
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
