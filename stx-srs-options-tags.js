/**
 * One-off (but re-runnable) job for the STX Roofing Zuper account.
 *
 * Driven by a customer-supplied match sheet (SRS_STX_Matched.xlsx) that maps each STX
 * Zuper product (keyed by its P#### `product_id`) to an SRS catalog product_id. STX is
 * NOT an SRS-keyed account (its product_ids are P####, not the numeric SRS PK), so the
 * generic audit/backfill key-schemes don't apply — the Excel mapping is the only link.
 *
 * Three things, per the request:
 *   1. Verify every SRS product_id in the sheet actually exists in srs_products.
 *   2. Compare the color/size options SRS implies (from srs_variants, is_restricted=false)
 *      against what each STX Zuper product currently exposes; report what's missing.
 *   3. ADD the missing option values (merge — existing option_values + their option_uids
 *      are preserved, only genuinely-absent values are appended) and stamp the "srs
 *      catalog" tag onto every mapped product's `tags` custom field.
 *
 * Writes use a MINIMAL merge PUT — `{ product: { product_uid, option?, meta_data? } }`.
 * Zuper merges top-level keys, so price/category/brand/formula/etc. are untouched; only
 * the keys we send change. (Verified shape — see memory zuper-product-meta-update.)
 *
 * Option axis: STX products are color-axis. We keep each product's existing option_label
 * and axis and only append missing values of the SRS axis that matches what's already
 * there (color vs size decided by overlap with the live values; empty-option products
 * take the axis that varies in SRS, color preferred). Comparison is trim + case-insensitive
 * so "Onyx Black" isn't re-added; the SRS canonical string is used when appending. 50-cap
 * honored (Zuper rejects >50 option_values atomically).
 *
 * Modes (safety — read-only by default):
 *   (none)            audit only — console summary + <label>-srs-match-audit.xlsx, NO writes
 *   --test-one        apply to a single product (first that needs a change), before/after
 *   --apply [--limit N]   live: add missing options + tag, bounded concurrency
 * Scope of writes (with --apply / --test-one):
 *   --do options|tags|both   default both
 *
 *   node stx-srs-options-tags.js                 # audit
 *   node stx-srs-options-tags.js --test-one
 *   node stx-srs-options-tags.js --apply
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
const DO = (typeof ARGS.do === 'string' ? ARGS.do : 'both').toLowerCase(); // options | tags | both
const DO_OPTS = DO === 'both' || DO === 'options';
const DO_TAGS = DO === 'both' || DO === 'tags';
const LIMIT = typeof ARGS.limit !== 'undefined' ? Number(ARGS.limit) : Infinity;
const CONCURRENCY = 5;
const OPTION_CAP = 50;
const TAG_VALUE = 'srs catalog';
// Contractor private-label leak filter. SRS has ~480 account-specific variants flagged
// is_restricted=true, but some leak unflagged and surface as garbage "sizes"/"colors"
// naming OTHER contractors (e.g. "42\" x 286' Window World", "Bob & Jerry's RFG"). We must
// not inject those into STX's catalog. Conservative company-keyword pattern (see memory
// zuper-product-meta-update — not exhaustive, but catches the egregious ones).
const PRIVATE_LABEL_RE = /\b(window world|ready roofing|bob ?& ?jerry|everest|\brfg\b|construction|exteriors|contractors?)\b/i;
const isPrivateLabel = v => PRIVATE_LABEL_RE.test(String(v));
const TAGS_FIELD = { label: 'tags', uid: 'd6444782-e062-441e-8cd4-9723b7902161', type: 'MULTI_LINE', hide_to_fe: true };

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

// ── load the customer match sheet ───────────────────────────────────────────────
async function loadSheet() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.worksheets[0];
  const rows = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const v = ws.getRow(i).values; // 1-indexed
    if (!v[1]) continue;
    rows.push({
      zid: String(v[1]).trim(), zno: String(v[2] ?? '').trim(), zname: v[3] || '',
      zcat: v[4] || '', zbrand: v[5] || '', score: Number(v[9]) || 0,
      srsId: v[10] != null ? Number(v[10]) : null, srsName: v[11] || '', srsCat: v[12] || '', srsMfr: v[13] || '',
    });
  }
  return rows;
}

// ── SRS catalog: which ids exist + their color/size axes ─────────────────────────
async function loadSrs(srsIds) {
  const ids = [...new Set(srsIds.filter(x => Number.isFinite(x)))];
  const exists = new Set();
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const rows = await fetchAll(supabase, 'srs_products', 'product_id', { filters: [{ op: 'in', args: ['product_id', chunk] }], orderBy: 'product_id' });
    rows.forEach(r => exists.add(r.product_id));
  }
  const opts = new Map(); // srsId -> { colors:Set, sizes:Set }
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const rows = await fetchAll(supabase, 'srs_variants', 'product_id,color_name,size_name',
      { filters: [{ op: 'in', args: ['product_id', chunk] }, { op: 'eq', args: ['is_restricted', false] }], orderBy: 'variant_id' });
    for (const r of rows) {
      const c = realOpt(r.color_name) ? String(r.color_name).trim() : null;
      const s = realOpt(r.size_name) ? String(r.size_name).trim() : null;
      if (!c && !s) continue;
      let e = opts.get(r.product_id);
      if (!e) { e = { colors: new Set(), sizes: new Set() }; opts.set(r.product_id, e); }
      if (c) e.colors.add(c);
      if (s) e.sizes.add(s);
    }
  }
  return { exists, opts };
}

// ── fetch all Zuper products, index by product_id (P####) and product_no ─────────
async function loadZuper() {
  const prods = [];
  let page = 1, total = null;
  while (true) {
    const { json } = await getJson(`${BASE}product?page=${page}&count=100`);
    const rows = json?.data || [];
    if (total === null) total = json?.total_records;
    prods.push(...rows);
    process.stdout.write(`  fetched ${prods.length}/${total ?? '?'}\r`);
    if (rows.length < 100) break;
    page++; if (page > 200) break;
  }
  console.log(`\nFetched ${prods.length} Zuper products (total_records ${total}).`);
  const byId = new Map(), byNo = new Map();
  for (const p of prods) {
    if (p.product_id != null) byId.set(String(p.product_id).trim(), p);
    if (p.product_no != null) byNo.set(String(p.product_no).trim(), p);
  }
  return { byId, byNo };
}

// Pick the SRS axis to compare against, given the product's live option_values.
// Returns { axis:'color'|'size'|null, expected:string[] (canonical SRS strings) }.
function srsAxis(srs, liveValues) {
  if (!srs) return { axis: null, expected: [] };
  const colors = [...srs.colors], sizes = [...srs.sizes];
  const cVary = colors.length > 1, sVary = sizes.length > 1;
  if (liveValues && liveValues.length) {
    const live = new Set(liveValues.map(norm));
    const cHit = colors.filter(c => live.has(norm(c))).length;
    const sHit = sizes.filter(s => live.has(norm(s))).length;
    if (cHit || sHit) {
      if (cHit >= sHit && colors.length) return { axis: 'color', expected: colors };
      if (sizes.length) return { axis: 'size', expected: sizes };
    }
  }
  // No live values (or no overlap): take the axis that varies, color preferred.
  if (cVary) return { axis: 'color', expected: colors };
  if (sVary) return { axis: 'size', expected: sizes };
  if (colors.length) return { axis: 'color', expected: colors };
  if (sizes.length) return { axis: 'size', expected: sizes };
  return { axis: null, expected: [] };
}

// Build the merge-PUT body. Sends only the keys we changed.
function buildMergePut(g, { newOption, addTag }) {
  const product = { product_uid: g.product_uid };
  if (newOption) product.option = newOption;
  if (addTag) {
    const existing = (g.meta_data || []).map((m, i) => ({
      hide_field: !!m.hide_field, hide_to_fe: !!m.hide_to_fe, id: i, label: m.label,
      read_only: false, type: m.type, dependent_on: '', dependent_options: [],
      module_name: m.module_name ?? 'PRODUCT', value: m.value ?? '',
    }));
    const hasTags = existing.find(m => norm(m.label) === norm(TAGS_FIELD.label));
    if (hasTags) hasTags.value = TAG_VALUE;
    else existing.push({
      hide_field: false, hide_to_fe: TAGS_FIELD.hide_to_fe, id: existing.length, label: TAGS_FIELD.label,
      read_only: false, type: TAGS_FIELD.type, dependent_on: '', dependent_options: [],
      module_name: 'PRODUCT', value: TAG_VALUE, custom_field_uid: TAGS_FIELD.uid,
    });
    product.meta_data = existing;
  }
  return { product, vendor: [] };
}

// Decide what changes a product needs. Returns { optionPlan, tagPlan, ... } describing the diff.
function diffProduct(g, srs) {
  const opt = g.option || {};
  const liveVals = Array.isArray(opt.option_values) ? opt.option_values.map(o => String(o.option_value)) : [];
  const { axis, expected } = srsAxis(srs, liveVals);
  const liveSet = new Set(liveVals.map(norm));
  const missingAll = expected.filter(v => !liveSet.has(norm(v)));
  const filtered = missingAll.filter(isPrivateLabel);          // private-label leaks dropped
  const missing = missingAll.filter(v => !isPrivateLabel(v));
  const extra = liveVals.filter(v => !expected.some(e => norm(e) === norm(v)));
  const capped = liveVals.length + missing.length > OPTION_CAP;
  let toAdd = missing;
  let note = '';
  if (capped) {
    const room = Math.max(0, OPTION_CAP - liveVals.length);
    toAdd = missing.slice(0, room);
    note = `would exceed ${OPTION_CAP}-cap (live ${liveVals.length} + missing ${missing.length}); adding only ${toAdd.length}`;
  }
  return { axis, expectedCount: expected.length, liveCount: liveVals.length, missing, filtered, extra, toAdd, note, opt, liveVals };
}

async function main() {
  if (!API_KEY) { console.log('No API key.'); process.exit(1); }
  console.log(`\n=== STX × SRS  [${MODE}]  ${BASE}  do=${DO} ===\n`);

  const ver = await getJson(`${BASE}user/company`);
  const company = ver.json?.data?.company_name ?? ver.json?.company_name ?? null;
  if (!ver.ok || !company) { console.log(`Connection failed (status ${ver.status}).`); process.exit(1); }
  console.log(`Account: ${company}`);
  const label = (typeof ARGS.label === 'string' && ARGS.label) || company;

  const rows = await loadSheet();
  console.log(`Sheet: ${rows.length} mapped rows, ${new Set(rows.map(r => r.srsId)).size} unique SRS ids.`);
  const { exists, opts } = await loadSrs(rows.map(r => r.srsId));
  const { byId, byNo } = await loadZuper();

  // Build per-row records.
  const recs = rows.map(r => {
    const srsExists = r.srsId != null && exists.has(r.srsId);
    let z = byId.get(r.zid) || byNo.get(r.zno) || null;
    const matchedBy = byId.get(r.zid) ? 'product_id' : (z ? 'product_no' : 'none');
    const srs = opts.get(r.srsId) || null;
    let diff = null;
    if (z) diff = diffProduct(z, srs);
    return { r, srsExists, z, matchedBy, srs, diff };
  });

  // ── Audit summary ──────────────────────────────────────────────────────────
  const missingSrs = recs.filter(x => !x.srsExists);
  const unmatchedZ = recs.filter(x => !x.z);
  const needOpts = recs.filter(x => x.z && x.diff && x.diff.toAdd.length > 0);
  const okOpts = recs.filter(x => x.z && x.diff && x.diff.missing.length === 0 && x.diff.expectedCount > 0);
  const noSrsOpts = recs.filter(x => x.z && (!x.srs || x.diff.expectedCount === 0));
  const capped = recs.filter(x => x.z && x.diff && x.diff.note);
  const leaks = recs.filter(x => x.z && x.diff && x.diff.filtered.length);

  console.log('\n--- Audit ---');
  console.log(`  mapped rows:                       ${recs.length}`);
  console.log(`  SRS id present in srs_products:    ${recs.length - missingSrs.length}  (missing: ${missingSrs.length})`);
  console.log(`  matched to a Zuper product:        ${recs.length - unmatchedZ.length}  (unmatched: ${unmatchedZ.length})`);
  console.log(`  options already complete:          ${okOpts.length}`);
  console.log(`  options MISSING (will add):        ${needOpts.length}`);
  console.log(`  no selectable SRS options:         ${noSrsOpts.length}`);
  console.log(`  hit ${OPTION_CAP}-option cap:                 ${capped.length}`);
  console.log(`  private-label leaks filtered out:  ${leaks.length} product(s), ${leaks.reduce((n, x) => n + x.diff.filtered.length, 0)} value(s)`);
  if (leaks.length) leaks.forEach(x => console.log(`      ${x.r.zid} "${x.r.zname}"  dropped: ${x.diff.filtered.join(', ')}`));
  if (missingSrs.length) {
    console.log(`\n  ⚠ SRS ids NOT in srs_products:`);
    missingSrs.forEach(x => console.log(`      ${x.r.zid} "${x.r.zname}" → SRS ${x.r.srsId} "${x.r.srsName}"`));
  }
  if (unmatchedZ.length) {
    console.log(`\n  ⚠ Sheet rows with NO matching Zuper product:`);
    unmatchedZ.forEach(x => console.log(`      ${x.r.zid} (no ${x.r.zno}) "${x.r.zname}"`));
  }
  if (needOpts.length) {
    console.log(`\n  Products that will gain options (first 40):`);
    needOpts.slice(0, 40).forEach(x => console.log(`      ${x.r.zid} "${x.r.zname}"  [${x.diff.axis}] live ${x.diff.liveCount} + add ${x.diff.toAdd.length}: ${x.diff.toAdd.slice(0, 8).join(', ')}${x.diff.toAdd.length > 8 ? ' …' : ''}${x.diff.note ? '  ⚠ ' + x.diff.note : ''}`));
  }

  // Write audit Excel
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Audit', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { key: 'zid', header: 'Zuper Product ID', width: 16 },
    { key: 'zno', header: 'Zuper No', width: 10 },
    { key: 'zname', header: 'Zuper Name', width: 46 },
    { key: 'srsId', header: 'SRS ID', width: 10 },
    { key: 'srsName', header: 'SRS Name', width: 46 },
    { key: 'srsExists', header: 'SRS in DB?', width: 11 },
    { key: 'matchedBy', header: 'Matched by', width: 12 },
    { key: 'axis', header: 'Axis', width: 8 },
    { key: 'liveCount', header: 'Zuper opts', width: 11 },
    { key: 'expectedCount', header: 'SRS opts', width: 10 },
    { key: 'missingCount', header: '# missing', width: 10 },
    { key: 'missing', header: 'Missing option values', width: 60 },
    { key: 'extra', header: 'Extra in Zuper (kept)', width: 40 },
    { key: 'note', header: 'Note', width: 40 },
    { key: 'uid', header: 'Zuper product_uid', width: 38 },
  ];
  ws.getRow(1).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } }; });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: 15 } };
  for (const x of recs) {
    const d = x.diff;
    const row = ws.addRow({
      zid: x.r.zid, zno: x.r.zno, zname: x.r.zname, srsId: x.r.srsId, srsName: x.r.srsName,
      srsExists: x.srsExists ? 'yes' : 'NO', matchedBy: x.matchedBy,
      axis: d?.axis || '', liveCount: d?.liveCount ?? '', expectedCount: d?.expectedCount ?? '',
      missingCount: d?.missing.length ?? '', missing: d ? d.missing.join(', ') : '',
      extra: d ? d.extra.join(', ') : '', note: d?.note || '', uid: x.z?.product_uid || '',
    });
    let bg = null;
    if (!x.srsExists || !x.z) bg = 'FFF8C9C9';            // red — problem
    else if (d && d.toAdd.length) bg = 'FFFDF3D6';        // yellow — will add
    else if (d && d.expectedCount > 0) bg = 'FFD9F2D9';   // green — ok
    if (bg) row.eachCell({ includeEmpty: true }, c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }; c.font = { size: 9 }; });
  }
  const auditOut = path.join(__dirname, `${slug(label)}-srs-match-audit.xlsx`);
  await wb.xlsx.writeFile(auditOut);
  console.log(`\n✓ Wrote ${path.basename(auditOut)}`);

  if (MODE === 'audit') {
    console.log(`\nAudit only. Re-run with --test-one (one product) or --apply to write.`);
    return;
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  // Worklist = every matched Zuper product (tagging covers all; options where needed).
  let work = recs.filter(x => x.z);
  if (MODE === 'test-one') {
    const pref = DO_OPTS ? work.find(x => x.diff && x.diff.toAdd.length) : null;
    work = [pref || work[0]].filter(Boolean);
  } else if (Number.isFinite(LIMIT)) {
    work = work.slice(0, LIMIT);
  }
  console.log(`\nApplying to ${work.length} product(s)  (options=${DO_OPTS} tags=${DO_TAGS}) at concurrency ${CONCURRENCY} …`);

  async function applyOne(x) {
    // Fresh GET so we merge against current state (and capture option_uids to preserve).
    const { json } = await getJson(`${BASE}product/${x.z.product_uid}`);
    const g = Array.isArray(json?.data) ? json.data[0] : json?.data;
    if (!g) return { zid: x.r.zid, status: 'get_failed' };
    const d = diffProduct(g, x.srs);

    let newOption = null;
    if (DO_OPTS && d.toAdd.length) {
      const baseOpt = g.option || {};
      const existingVals = (baseOpt.option_values || []).map(o => ({
        option_value: o.option_value, option_image: o.option_image || '', is_available: o.is_available !== false,
        ...(o.option_uid ? { option_uid: o.option_uid } : {}),
      }));
      const addVals = d.toAdd.map(v => ({ option_value: v, option_image: '', is_available: true }));
      newOption = {
        customer_selection: baseOpt.customer_selection ?? true,
        mandate_customer_selection: baseOpt.mandate_customer_selection ?? false,
        option_label: baseOpt.option_label || (d.axis === 'size' ? 'Size' : 'Color'),
        option_values: [...existingVals, ...addVals],
      };
    }
    const addTag = DO_TAGS && norm(((g.meta_data || []).find(m => norm(m.label) === norm(TAGS_FIELD.label)) || {}).value) !== norm(TAG_VALUE);
    if (!newOption && !addTag) return { zid: x.r.zid, status: 'nothing_to_do', added: 0 };

    const payload = buildMergePut(g, { newOption, addTag });
    const res = await getJson(`${BASE}product/${x.z.product_uid}`, { method: 'PUT', body: JSON.stringify(payload) });
    const ok = res.ok && (res.json?.type === 'success' || res.json?.data);
    return {
      zid: x.r.zid, name: x.r.zname, status: ok ? 'updated' : 'put_failed',
      added: newOption ? d.toAdd.length : 0, axis: d.axis, tagged: addTag,
      note: d.note, message: ok ? '' : (res.json?.message ?? JSON.stringify(res.json)),
    };
  }

  if (MODE === 'test-one') {
    const x = work[0];
    if (!x) { console.log('No product to test.'); return; }
    console.log(`\nTest product: ${x.r.zid} "${x.r.zname}" uid=${x.z.product_uid}`);
    const before = await getJson(`${BASE}product/${x.z.product_uid}`);
    const bg = Array.isArray(before.json?.data) ? before.json.data[0] : before.json?.data;
    console.log(`  BEFORE option_values: ${JSON.stringify((bg?.option?.option_values || []).map(o => o.option_value))}`);
    console.log(`  BEFORE tags: ${JSON.stringify((bg?.meta_data || []).find(m => norm(m.label) === 'tags')?.value)}`);
    const r = await applyOne(x);
    console.log(`  PUT status: ${r.status}  added ${r.added} ${r.axis || ''} option(s)  tagged=${r.tagged}  ${r.message || ''}`);
    if (r.note) console.log(`  ⚠ ${r.note}`);
    const after = await getJson(`${BASE}product/${x.z.product_uid}`);
    const ag = Array.isArray(after.json?.data) ? after.json.data[0] : after.json?.data;
    console.log(`  AFTER option_values: ${JSON.stringify((ag?.option?.option_values || []).map(o => o.option_value))}`);
    console.log(`  AFTER tags: ${JSON.stringify((ag?.meta_data || []).find(m => norm(m.label) === 'tags')?.value)}`);
    console.log('\n  Field-preservation check:');
    for (const f of ['product_name', 'price', 'purchase_price', 'uom', 'brand', 'product_id']) console.log(`    ${f}: ${JSON.stringify(bg?.[f])} -> ${JSON.stringify(ag?.[f])}`);
    console.log(`    category_uid: ${bg?.product_category?.category_uid} -> ${ag?.product_category?.category_uid}`);
    console.log(`    option_label: ${JSON.stringify(bg?.option?.option_label)} -> ${JSON.stringify(ag?.option?.option_label)}`);
    return;
  }

  const results = [];
  let done = 0;
  for (let i = 0; i < work.length; i += CONCURRENCY) {
    const batch = work.slice(i, i + CONCURRENCY);
    const r = await Promise.all(batch.map(x => applyOne(x).catch(e => ({ zid: x.r.zid, status: 'error', message: e.message }))));
    results.push(...r);
    done += batch.length;
    process.stdout.write(`  ${done}/${work.length}\r`);
  }
  const tally = {};
  let totalOpts = 0, totalTagged = 0;
  for (const r of results) { tally[r.status] = (tally[r.status] || 0) + 1; totalOpts += r.added || 0; if (r.tagged) totalTagged++; }
  console.log('\n\n--- Apply result ---');
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`);
  console.log(`  option values added: ${totalOpts}`);
  console.log(`  products tagged "${TAG_VALUE}": ${totalTagged}`);
  const fails = results.filter(r => ['put_failed', 'error', 'get_failed'].includes(r.status));
  const outFile = path.join(__dirname, `${slug(label)}-srs-match-apply.json`);
  fs.writeFileSync(outFile, JSON.stringify({ account: company, results }, null, 2));
  if (fails.length) {
    console.log(`  ⚠ ${fails.length} failures:`);
    fails.slice(0, 20).forEach(r => console.log(`      ${r.zid}: ${r.status} ${r.message || ''}`));
  }
  console.log(`✓ Wrote ${path.basename(outFile)}`);
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
