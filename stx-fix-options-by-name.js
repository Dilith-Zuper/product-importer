/**
 * STX Roofing: reconcile each mapped product's color/size OPTIONS to the SRS product its
 * (now-exact) NAME matches — fixing the inconsistency left by stx-rename-to-srs.js.
 *
 * Background: stx-srs-options-tags.js uploaded options keyed to the match sheet's SRS
 * product_id. For the rows the sheet matched weakly, stx-rename-to-srs.js later renamed the
 * product to a BETTER SRS product (via the SRS-DB re-match) but did NOT re-pull options — so
 * the product now carries the right name but the old/empty option set. This script resolves
 * each STX product to its SRS product by EXACT (normalized) name and sets the option block to
 * that product's real options.
 *
 * Axis: single-axis only (matches how the account models products — one option_label each).
 * Whichever of color/size has more distinct values wins (ties → color); composite is NOT used
 * (it overflows the 50-cap and collapses to the wrong axis). Private-label leaks filtered.
 * 50-option cap honored. Existing option_uids are preserved for values that survive (so vendor
 * catalog / proposal references aren't broken); values not in SRS are dropped, missing added.
 *
 * Resolution: exact name → srs_products. On multiple ids with the same name, the one with the
 * most unrestricted variants (richest option set) wins. Products whose live name matches no SRS
 * name are reported as "no_exact_srs" and left untouched.
 *
 * Scope (default = the categories the request named): nails + underlayment + shingles + hip&ridge.
 *   --scope all        every mapped product with an exact SRS name + option mismatch
 *   --scope <csv>      any of: nails,underlayment,shingles,hipridge,all
 * Modes (read-only by default): (none) audit | --test-one | --apply [--limit N]
 *
 *   node stx-fix-options-by-name.js
 *   node stx-fix-options-by-name.js --apply
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');
const { fetchAll } = require('./lib/utils');
const { realOpt } = require('./lib/account-catalog');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => String(s || 'account').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'account';
const norm = s => String(s ?? '').trim().toLowerCase();

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
const API_KEY = (typeof ARGS.key === 'string' && ARGS.key) || process.env.STX_API_KEY || '753634d6034031a07a0619fe1eb14e63';
const REGION = (typeof ARGS.region === 'string' && ARGS.region) || 'us-east-1';
const XLSX = (typeof ARGS.xlsx === 'string' && ARGS.xlsx) || 'SRS_STX_Matched.xlsx';
const MODE = ARGS.apply ? 'apply' : ARGS['test-one'] ? 'test-one' : 'audit';
const LIMIT = typeof ARGS.limit !== 'undefined' ? Number(ARGS.limit) : Infinity;
const SCOPE = String(typeof ARGS.scope === 'string' ? ARGS.scope : 'nails,underlayment,shingles,hipridge').toLowerCase().split(',').map(s => s.trim());
const CONCURRENCY = 5;
const OPTION_CAP = 50;
const PRIVATE_LABEL_RE = /\b(window world|ready roofing|bob ?& ?jerry|everest|\brfg\b|construction|exteriors|contractors?)\b/i;
const isPrivateLabel = v => PRIVATE_LABEL_RE.test(String(v));

// SRS category → scope bucket.
const CAT_BUCKET = {
  'OTHER FASTENERS': 'nails', 'COIL NAILS': 'nails', 'PLASTIC CAPS': 'nails',
  'UNDERLAYMENT': 'underlayment', 'SHINGLES': 'shingles', 'HIP AND RIDGE': 'hipridge',
};

const BASE = `https://${REGION}.zuperpro.com/api/`;
const H = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };

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

async function loadSheetZids() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.worksheets[0];
  const zids = new Set();
  for (let i = 2; i <= ws.rowCount; i++) { const v = ws.getRow(i).values; if (v[1]) zids.add(String(v[1]).trim()); }
  return zids;
}

async function loadZuper() {
  const prods = [];
  let page = 1;
  while (true) {
    const { json } = await getJson(`${BASE}product?page=${page}&count=100`);
    const rows = json?.data || [];
    prods.push(...rows);
    if (rows.length < 100) break;
    page++; if (page > 200) break;
  }
  return prods;
}

// Build a normalized-name index over srs_products, with each product's color/size sets and
// variant count (for tie-break). One pass over variants for all ids in the matched names.
async function loadSrsByName(neededNames) {
  const all = await fetchAll(supabase, 'srs_products', 'product_id,product_name,product_category', { orderBy: 'product_id' });
  const byName = new Map(); // norm(name) -> [{id,cat}]
  for (const r of all) {
    if (!r.product_name) continue;
    const k = norm(r.product_name);
    if (!neededNames.has(k)) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push({ id: r.product_id, cat: r.product_category });
  }
  // variants for all candidate ids
  const ids = [...new Set([...byName.values()].flat().map(x => x.id))];
  const opt = new Map(); // id -> { colors:Set, sizes:Set, n }
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const rows = await fetchAll(supabase, 'srs_variants', 'product_id,color_name,size_name',
      { filters: [{ op: 'in', args: ['product_id', chunk] }, { op: 'eq', args: ['is_restricted', false] }], orderBy: 'variant_id' });
    for (const r of rows) {
      let e = opt.get(r.product_id);
      if (!e) { e = { colors: new Set(), sizes: new Set(), n: 0 }; opt.set(r.product_id, e); }
      e.n++;
      if (realOpt(r.color_name)) e.colors.add(String(r.color_name).trim());
      if (realOpt(r.size_name)) e.sizes.add(String(r.size_name).trim());
    }
  }
  return { byName, opt };
}

// Pick which SRS axis to source values from, given the product's CURRENT live option
// values. ADDITIVE semantics — we keep the product's existing axis and only add missing
// values; we never drop or flip an axis (that's what caused regressions like 27→1 sizes
// or color↔size flips). For an empty product, take the axis that VARIES in SRS (color
// preferred). Private-label filtered. Returns { axis, expected:[canonical SRS strings] }.
function srsAxisFor(srsOpt, liveValues) {
  if (!srsOpt) return { axis: null, expected: [] };
  const colors = [...srsOpt.colors].filter(v => !isPrivateLabel(v));
  const sizes = [...srsOpt.sizes].filter(v => !isPrivateLabel(v));
  if (liveValues && liveValues.length) {
    const live = new Set(liveValues.map(norm));
    const cHit = colors.filter(c => live.has(norm(c))).length;
    const sHit = sizes.filter(s => live.has(norm(s))).length;
    if (cHit || sHit) {
      if (cHit >= sHit && colors.length) return { axis: 'color', expected: colors };
      if (sizes.length) return { axis: 'size', expected: sizes };
    }
    // No overlap with either SRS axis — keep current axis (don't guess), add nothing.
    return { axis: 'unknown', expected: [] };
  }
  // Empty product: take the axis that varies, color preferred.
  const cVary = colors.length > 1, sVary = sizes.length > 1;
  if (cVary) return { axis: 'color', expected: colors };
  if (sVary) return { axis: 'size', expected: sizes };
  if (colors.length) return { axis: 'color', expected: colors };
  if (sizes.length) return { axis: 'size', expected: sizes };
  return { axis: null, expected: [] };
}

function resolveSrs(name, byName, opt) {
  const cands = byName.get(norm(name)) || [];
  if (!cands.length) return null;
  // richest variant set wins on ties
  let best = null;
  for (const c of cands) {
    const e = opt.get(c.id) || { colors: new Set(), sizes: new Set(), n: 0 };
    const score = e.colors.size + e.sizes.size;
    if (!best || score > best.score) best = { ...c, e, score };
  }
  return best;
}

// ADDITIVE option block: existing values (with their option_uids) + missing SRS values,
// capped at 50. Existing values are never dropped.
function buildOptionBlock(g, plan) {
  const cur = g.option || {};
  const existing = (cur.option_values || []).map(o => ({
    option_value: o.option_value, option_image: o.option_image || '', is_available: o.is_available !== false,
    ...(o.option_uid ? { option_uid: o.option_uid } : {}),
  }));
  const room = Math.max(0, OPTION_CAP - existing.length);
  const add = plan.toAdd.slice(0, room).map(v => ({ option_value: v, option_image: '', is_available: true }));
  const label = cur.option_label || (plan.axis === 'size' ? 'Size' : 'Color');
  return {
    customer_selection: cur.customer_selection ?? true,
    mandate_customer_selection: cur.mandate_customer_selection ?? false,
    option_label: label, option_values: [...existing, ...add],
  };
}

// Merge-PUT: only option changes; everything else preserved.
function buildPut(g, option) {
  return { product: { product_uid: g.product_uid, option }, vendor: [] };
}

// Additive diff: what SRS values are missing from the current set (never drops).
function planAdds(curVals, srsOpt) {
  const { axis, expected } = srsAxisFor(srsOpt, curVals);
  const live = new Set(curVals.map(norm));
  const toAdd = expected.filter(v => !live.has(norm(v)));
  return { axis, expected, toAdd };
}

async function main() {
  console.log(`\n=== STX fix options by name  [${MODE}]  scope=${SCOPE.join(',')}  ${BASE} ===\n`);
  const ver = await getJson(`${BASE}user/company`);
  const company = ver.json?.data?.company_name ?? ver.json?.company_name ?? null;
  if (!ver.ok || !company) { console.log(`Connection failed (status ${ver.status}).`); process.exit(1); }
  const label = (typeof ARGS.label === 'string' && ARGS.label) || company;

  const zids = await loadSheetZids();
  const prods = await loadZuper();
  const mapped = prods.filter(p => zids.has(String(p.product_id)));
  console.log(`Account: ${company} — ${mapped.length} mapped products.`);

  const neededNames = new Set(mapped.map(p => norm(p.product_name)));
  const { byName, opt } = await loadSrsByName(neededNames);

  const recs = [];
  for (const p of mapped) {
    const srs = resolveSrs(p.product_name, byName, opt);
    if (!srs) { recs.push({ p, status: 'no_exact_srs' }); continue; }
    const bucket = CAT_BUCKET[srs.cat] || 'other';
    const curVals = (p.option?.option_values || []).map(o => o.option_value);
    const plan = planAdds(curVals, srs.e);
    if (!plan.expected.length && !curVals.length) { recs.push({ p, srs, bucket, status: 'srs_has_no_options' }); continue; }
    const newCount = Math.min(OPTION_CAP, curVals.length + plan.toAdd.length);
    const capped = curVals.length + plan.toAdd.length > OPTION_CAP;
    recs.push({ p, srs, bucket, plan, curCount: curVals.length, newCount, capped, status: plan.toAdd.length ? 'mismatch' : 'already_ok' });
  }

  const inScope = r => SCOPE.includes('all') || SCOPE.includes(r.bucket);
  const work = recs.filter(r => r.status === 'mismatch' && inScope(r));

  console.log('\n--- Plan ---');
  const byStatus = {};
  recs.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  Object.entries(byStatus).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  const byBucket = {};
  work.forEach(r => { byBucket[r.bucket] = (byBucket[r.bucket] || 0) + 1; });
  console.log(`  → in scope to fix: ${work.length}  (${Object.entries(byBucket).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  console.log('\n  Products to fix — adding missing options (first 60):');
  work.slice(0, 60).forEach(r => console.log(`    ${r.p.product_id} [${r.bucket}/${r.plan.axis}] "${r.p.product_name}"  ${r.curCount} → ${r.newCount}${r.capped ? ' (capped 50)' : ''}  +${r.plan.toAdd.length}: ${r.plan.toAdd.slice(0, 6).join(', ')}${r.plan.toAdd.length > 6 ? ' …' : ''}`));
  const outOfScope = recs.filter(r => r.status === 'mismatch' && !inScope(r));
  if (outOfScope.length) {
    console.log(`\n  (${outOfScope.length} more would-add OUT of scope — run --scope all to include):`);
    outOfScope.slice(0, 20).forEach(r => console.log(`    ${r.p.product_id} [${r.bucket}] "${r.p.product_name}"  ${r.curCount} → ${r.newCount}  +${r.plan.toAdd.length}`));
  }
  const noSrs = recs.filter(r => r.status === 'no_exact_srs');
  if (noSrs.length) { console.log(`\n  (${noSrs.length} products' live name has no exact SRS match — left untouched):`); noSrs.slice(0, 20).forEach(r => console.log(`    ${r.p.product_id} "${r.p.product_name}"`)); }

  // Audit Excel
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Fix options', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { key: 'zid', header: 'Zuper Product ID', width: 16 }, { key: 'name', header: 'Product (name = SRS)', width: 48 },
    { key: 'bucket', header: 'Scope', width: 13 }, { key: 'srsId', header: 'SRS id', width: 10 }, { key: 'cat', header: 'SRS cat', width: 16 },
    { key: 'axis', header: 'Axis', width: 8 }, { key: 'cur', header: 'Cur opts', width: 9 }, { key: 'new', header: 'New opts', width: 9 },
    { key: 'add', header: 'Added (SRS)', width: 60 }, { key: 'status', header: 'Status', width: 16 }, { key: 'uid', header: 'product_uid', width: 38 },
  ];
  ws.getRow(1).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } }; });
  recs.forEach(r => {
    const row = ws.addRow({
      zid: r.p.product_id, name: r.p.product_name, bucket: r.bucket || '', srsId: r.srs?.id || '', cat: r.srs?.cat || '',
      axis: r.plan?.axis || '', cur: r.curCount ?? '', new: r.newCount ?? '',
      add: r.plan ? r.plan.toAdd.join(', ') : '', status: r.status, uid: r.p.product_uid,
    });
    const bg = r.status === 'mismatch' ? (inScope(r) ? 'FFFDF3D6' : 'FFEDEDED') : r.status === 'already_ok' ? 'FFD9F2D9' : 'FFF8C9C9';
    row.eachCell({ includeEmpty: true }, c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }; c.font = { size: 9 }; });
  });
  const auditOut = path.join(__dirname, `${slug(label)}-fix-options-audit.xlsx`);
  await wb.xlsx.writeFile(auditOut);
  console.log(`\n✓ Wrote ${path.basename(auditOut)}`);

  if (MODE === 'audit') { console.log('\nAudit only. Re-run with --test-one or --apply.'); return; }

  async function applyOne(r) {
    const { json } = await getJson(`${BASE}product/${r.p.product_uid}`);
    const g = Array.isArray(json?.data) ? json.data[0] : json?.data;
    if (!g) return { zid: r.p.product_id, status: 'get_failed' };
    // Re-plan against fresh live options (preserves uids, additive).
    const liveVals = (g.option?.option_values || []).map(o => o.option_value);
    const plan = planAdds(liveVals, r.srs.e);
    if (!plan.toAdd.length) return { zid: r.p.product_id, status: 'already_ok', added: 0 };
    const option = buildOptionBlock(g, plan);
    const res = await getJson(`${BASE}product/${r.p.product_uid}`, { method: 'PUT', body: JSON.stringify(buildPut(g, option)) });
    const ok = res.ok && (res.json?.type === 'success' || res.json?.data);
    return { zid: r.p.product_id, status: ok ? 'fixed' : 'put_failed', axis: plan.axis, added: plan.toAdd.length, count: option.option_values.length, message: ok ? '' : (res.json?.message ?? JSON.stringify(res.json)) };
  }

  let todo = work;
  if (MODE === 'test-one') todo = work.slice(0, 1);
  else if (Number.isFinite(LIMIT)) todo = work.slice(0, LIMIT);

  if (MODE === 'test-one') {
    const r = todo[0];
    if (!r) { console.log('Nothing in scope to test.'); return; }
    console.log(`\nTest: ${r.p.product_id} "${r.p.product_name}"  uid=${r.p.product_uid}`);
    const before = await getJson(`${BASE}product/${r.p.product_uid}`);
    const bg = Array.isArray(before.json?.data) ? before.json.data[0] : before.json?.data;
    console.log(`  BEFORE [${bg?.option?.option_label}] (${(bg?.option?.option_values || []).length}): ${JSON.stringify((bg?.option?.option_values || []).map(o => o.option_value))}`);
    const res = await applyOne(r);
    console.log(`  status: ${res.status} axis=${res.axis} → ${res.count} (+${res.added}) ${res.message}`);
    const after = await getJson(`${BASE}product/${r.p.product_uid}`);
    const ag = Array.isArray(after.json?.data) ? after.json.data[0] : after.json?.data;
    console.log(`  AFTER  [${ag?.option?.option_label}] (${(ag?.option?.option_values || []).length}): ${JSON.stringify((ag?.option?.option_values || []).map(o => o.option_value))}`);
    console.log(`  preserved: name="${ag?.product_name}" price=${ag?.price} cat=${ag?.product_category?.category_name} tags=${JSON.stringify((ag?.meta_data || []).find(m => norm(m.label) === 'tags')?.value)}`);
    return;
  }

  console.log(`\nFixing ${todo.length} products at concurrency ${CONCURRENCY} …`);
  const results = [];
  let done = 0;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    const r = await Promise.all(batch.map(x => applyOne(x).catch(e => ({ zid: x.p.product_id, status: 'error', message: e.message }))));
    results.push(...r);
    done += batch.length;
    process.stdout.write(`  ${done}/${todo.length}\r`);
  }
  const tally = {};
  let addedTot = 0;
  for (const r of results) { tally[r.status] = (tally[r.status] || 0) + 1; addedTot += r.added || 0; }
  console.log('\n\n--- Result ---');
  Object.entries(tally).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
  console.log(`  option values added: ${addedTot}`);
  const outFile = path.join(__dirname, `${slug(label)}-fix-options-apply.json`);
  fs.writeFileSync(outFile, JSON.stringify({ account: company, results }, null, 2));
  const fails = results.filter(r => ['put_failed', 'error', 'get_failed'].includes(r.status));
  if (fails.length) { console.log(`  ⚠ ${fails.length} failures:`); fails.slice(0, 20).forEach(r => console.log(`     ${r.zid}: ${r.status} ${r.message}`)); }
  console.log(`✓ Wrote ${path.basename(outFile)}`);
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
