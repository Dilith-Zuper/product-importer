/**
 * STX Roofing: rename each mapped Zuper product to its SRS catalog name, preserving the
 * current Zuper name in a "Legacy Part Name" PRODUCT custom field.
 *
 * Driven by the same customer match sheet (SRS_STX_Matched.xlsx) as stx-srs-options-tags.js
 * (Zuper P#### product_id → SRS product_id + SRS Name). For each matched product:
 *   - legacy = the product's CURRENT live name (GET, not the sheet's "Zuper Name" column —
 *     they differ, e.g. P0020 is stored "Top Shield Aluminum Slant ")
 *   - rename product_name → the SRS Name
 *   - store legacy in the "Legacy Part Name" custom field (created if missing)
 *
 * Idempotent: once "Legacy Part Name" is non-empty we skip the product (a re-run won't
 * clobber the original name with the already-renamed value). Writes are MINIMAL merge-PUTs
 * — `{ product: { product_uid, product_name, meta_data } }` — so price/category/option/etc.
 * are untouched. meta_data REPLACES, so we always send the full existing array + the legacy
 * entry (and preserve the tags="srs catalog" entry already there).
 *
 * Modes (read-only by default):
 *   (none)        audit — show planned renames, NO writes, writes <label>-rename-audit.xlsx
 *   --test-one    rename a single product (first that needs it), before/after
 *   --apply [--limit N]   live rename, bounded concurrency
 *
 *   node stx-rename-to-srs.js
 *   node stx-rename-to-srs.js --test-one
 *   node stx-rename-to-srs.js --apply
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');
const { fetchAll } = require('./lib/utils');

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
const CONCURRENCY = 5;
const LEGACY_LABEL = 'Legacy Part Name';
// --no-rematch disables the SRS-DB re-match (use the sheet's assigned SRS name verbatim).
const REMATCH = !ARGS['no-rematch'];
// A fresh SRS-DB match overrides the sheet's assigned name only when it's CLEARLY and
// SAFELY better. A loose token search over 19,807 products picks cross-category garbage for
// generic names, so we require BOTH a strong absolute similarity and a wide margin over the
// sheet match. Tunable via --margin / --min-score.
const REMATCH_MARGIN = typeof ARGS.margin !== 'undefined' ? Number(ARGS.margin) : 0.15;
const REMATCH_MIN_SCORE = typeof ARGS['min-score'] !== 'undefined' ? Number(ARGS['min-score']) : 0.55;

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

async function loadSheet() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.worksheets[0];
  const rows = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const v = ws.getRow(i).values;
    if (!v[1]) continue;
    rows.push({ zid: String(v[1]).trim(), zno: String(v[2] ?? '').trim(), zname: v[3] || '', srsId: v[10] != null ? Number(v[10]) : null, srsName: String(v[11] || '').trim() });
  }
  return rows;
}

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
  console.log(`\nFetched ${prods.length} Zuper products.`);
  const byId = new Map(), byNo = new Map();
  for (const p of prods) {
    if (p.product_id != null) byId.set(String(p.product_id).trim(), p);
    if (p.product_no != null) byNo.set(String(p.product_no).trim(), p);
  }
  return { byId, byNo };
}

// ── SRS-DB re-match ─────────────────────────────────────────────────────────────
// Token-set Dice similarity on product names. Generic enough to surface a better SRS
// name than the customer sheet's fuzzy pick. Drops pure-number tokens and a few
// packaging units so "1-1/4 Coil Nails" still aligns with "Coil Nails".
const UNIT_STOP = new Set(['bx', 'pal', 'pc', 'ea', 'bd', 'bdl', 'rl', 'ctn', 'lf', 'tb', 'oz', 'lb', 'lbs', '5g', 'bag', 'sq', 'msf', 'mlf', 'x', 'and', 'the', 'of', 'in', 'with', 'for']);
function tokens(name) {
  return [...new Set(String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter(t => t && !/^\d+$/.test(t) && !UNIT_STOP.has(t)))];
}
function dice(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of aTokens) if (b.has(t)) inter++;
  return (2 * inter) / (aTokens.length + bTokens.length);
}
let SRS_CATALOG = null; // [{ id, name, toks }]
async function loadSrsCatalog() {
  if (SRS_CATALOG) return SRS_CATALOG;
  const rows = await fetchAll(supabase, 'srs_products', 'product_id,product_name', { orderBy: 'product_id' });
  SRS_CATALOG = rows.filter(r => r.product_name).map(r => ({ id: r.product_id, name: r.product_name, toks: tokens(r.product_name) }));
  return SRS_CATALOG;
}
// Best SRS name for a Zuper product name. Returns { id, name, score }.
function bestSrsMatch(zname, catalog) {
  const zt = tokens(zname);
  let best = { id: null, name: '', score: 0 };
  if (!zt.length) return best;
  for (const c of catalog) {
    const s = dice(zt, c.toks);
    if (s > best.score) best = { id: c.id, name: c.name, score: s };
  }
  return best;
}

// Find the "Legacy Part Name" PRODUCT custom field, creating it if absent. Returns uid + type.
async function ensureLegacyField({ create }) {
  const list = await getJson(`${BASE}settings/custom_fields?module_name=PRODUCT`);
  const fields = list.json?.data || [];
  const found = fields.find(f => norm(f.field_name || f.label) === norm(LEGACY_LABEL));
  if (found) return { uid: found.custom_field_uid, type: found.field_type || 'SINGLE_LINE', created: false };
  if (!create) return { uid: null, type: 'SINGLE_LINE', created: false };
  const cr = await getJson(`${BASE}settings/custom_fields/new`, {
    method: 'POST',
    body: JSON.stringify({
      module_name: 'PRODUCT',
      custom_field: {
        display_order: (fields.length || 1) + 1,
        label: LEGACY_LABEL, description: '', field_type: 'SINGLE_LINE', group: 'Default',
        required: false, component: 'text', read_only: false, hide_field: false, hide_to_fe: false,
        restrict_to_access_role: { is_enabled: false, roles: [] }, is_dependent: false, dependent_on: '', dependent_options: [],
      },
    }),
  });
  const uid = cr.json?.data?.custom_field_uid;
  if (!uid) throw new Error(`Failed to create "${LEGACY_LABEL}" field — ${JSON.stringify(cr.json).slice(0, 300)}`);
  return { uid, type: 'SINGLE_LINE', created: true };
}

// Build merge-PUT: rename + full meta_data (existing entries + legacy). meta_data REPLACES.
function buildRenamePut(g, newName, legacyVal, legacyUid) {
  const meta = (g.meta_data || []).map((m, i) => ({
    hide_field: !!m.hide_field, hide_to_fe: !!m.hide_to_fe, id: i, label: m.label,
    read_only: false, type: m.type, dependent_on: '', dependent_options: [],
    module_name: m.module_name ?? 'PRODUCT', value: m.value ?? '',
  }));
  const existing = meta.find(m => norm(m.label) === norm(LEGACY_LABEL));
  if (existing) existing.value = legacyVal;
  else meta.push({
    hide_field: false, hide_to_fe: false, id: meta.length, label: LEGACY_LABEL, read_only: false,
    type: 'SINGLE_LINE', dependent_on: '', dependent_options: [], module_name: 'PRODUCT',
    value: legacyVal, custom_field_uid: legacyUid,
  });
  return { product: { product_uid: g.product_uid, product_name: newName, meta_data: meta }, vendor: [] };
}

function legacyValue(g) {
  const e = (g.meta_data || []).find(m => norm(m.label) === norm(LEGACY_LABEL));
  return e ? String(e.value || '').trim() : '';
}

async function main() {
  console.log(`\n=== STX rename → SRS names  [${MODE}]  ${BASE} ===\n`);
  const ver = await getJson(`${BASE}user/company`);
  const company = ver.json?.data?.company_name ?? ver.json?.company_name ?? null;
  if (!ver.ok || !company) { console.log(`Connection failed (status ${ver.status}).`); process.exit(1); }
  console.log(`Account: ${company}`);
  const label = (typeof ARGS.label === 'string' && ARGS.label) || company;

  const rows = await loadSheet();
  const { byId, byNo } = await loadZuper();
  const legacy = await ensureLegacyField({ create: MODE !== 'audit' });
  console.log(`"${LEGACY_LABEL}" field: ${legacy.uid ? legacy.uid + (legacy.created ? ' (created)' : ' (existing)') : 'NOT present (audit — would create on --apply)'}`);

  const recs = rows.map(r => {
    const z = byId.get(r.zid) || byNo.get(r.zno) || null;
    return { r, z };
  });
  const matched = recs.filter(x => x.z);
  const unmatched = recs.filter(x => !x.z);

  // SRS-DB re-match: for each matched product, search srs_products for a better name than
  // the sheet's assigned SRS Name. Match against the product's CURRENT live Zuper name.
  // We override the sheet pick only when the fresh Dice score beats the sheet name's Dice
  // by REMATCH_MARGIN — high-confidence sheet matches are left alone, weak ones get fixed.
  let catalog = null;
  if (REMATCH) {
    catalog = await loadSrsCatalog();
    console.log(`SRS catalog loaded for re-match: ${catalog.length} products.`);
  }
  for (const x of matched) {
    x.cur = String(x.z.product_name || '').trim();
    x.effective = x.r.srsName;          // default: sheet's assigned SRS name
    x.rematch = null;
    if (REMATCH) {
      const sheetScore = dice(tokens(x.cur), tokens(x.r.srsName));
      const fresh = bestSrsMatch(x.cur, catalog);
      const better = fresh.name && norm(fresh.name) !== norm(x.r.srsName)
        && fresh.score >= REMATCH_MIN_SCORE && fresh.score >= sheetScore + REMATCH_MARGIN;
      x.rematch = { sheetScore, freshScore: fresh.score, freshName: fresh.name, freshId: fresh.id, used: better };
      if (better) x.effective = fresh.name;
    }
  }

  // Classify each matched product's current state from the LIST shape (good enough for the
  // plan; apply re-GETs fresh to capture the true live name + meta before writing).
  const plan = matched.map(x => {
    const cur = x.cur;
    const lg = legacyValue(x.z);
    let action = 'rename';
    if (lg) action = 'already_done';            // legacy already captured → skip
    else if (norm(cur) === norm(x.effective)) action = 'already_named';  // names equal, nothing to store
    return { ...x, cur, lg, srsName: x.effective, action };
  });
  const rematched = matched.filter(x => x.rematch && x.rematch.used);
  if (REMATCH) {
    console.log(`\nSRS-DB re-match overrode the sheet name on ${rematched.length} product(s):`);
    rematched.slice(0, 40).forEach(x => console.log(`    ${x.r.zid} "${x.cur}"\n        sheet:  "${x.r.srsName}"  (${x.rematch.sheetScore.toFixed(2)})\n        SRS db: "${x.rematch.freshName}"  (${x.rematch.freshScore.toFixed(2)})  ← used`));
  }
  const toRename = plan.filter(p => p.action === 'rename');

  console.log('\n--- Plan ---');
  console.log(`  mapped rows:                 ${recs.length}`);
  console.log(`  matched to a product:        ${matched.length}  (unmatched: ${unmatched.length})`);
  console.log(`  will rename + store legacy:  ${toRename.length}`);
  console.log(`  already renamed (skip):      ${plan.filter(p => p.action === 'already_done').length}`);
  console.log(`  name already == SRS (skip):  ${plan.filter(p => p.action === 'already_named').length}`);
  if (unmatched.length) unmatched.forEach(x => console.log(`    ⚠ no product: ${x.r.zid} "${x.r.zname}"`));
  console.log('\n  Sample renames (first 25):');
  toRename.slice(0, 25).forEach(p => console.log(`    ${p.r.zid}: "${p.cur}"  →  "${p.srsName}"`));

  // Audit Excel
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Renames', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { key: 'zid', header: 'Zuper Product ID', width: 16 },
    { key: 'cur', header: 'Current name (→ Legacy Part Name)', width: 50 },
    { key: 'srsName', header: 'New name (chosen)', width: 50 },
    { key: 'nameSource', header: 'Name source', width: 12 },
    { key: 'sheetName', header: 'Sheet SRS name', width: 44 },
    { key: 'sheetScore', header: 'Sheet score', width: 11 },
    { key: 'dbName', header: 'SRS-DB best match', width: 44 },
    { key: 'dbScore', header: 'DB score', width: 10 },
    { key: 'action', header: 'Action', width: 16 },
    { key: 'uid', header: 'product_uid', width: 38 },
  ];
  ws.getRow(1).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } }; });
  plan.forEach(p => {
    const rm = p.rematch;
    const row = ws.addRow({
      zid: p.r.zid, cur: p.cur, srsName: p.srsName, nameSource: rm?.used ? 'SRS-DB' : 'sheet',
      sheetName: p.r.srsName, sheetScore: rm ? +rm.sheetScore.toFixed(2) : '',
      dbName: rm?.freshName || '', dbScore: rm ? +rm.freshScore.toFixed(2) : '',
      action: p.action, uid: p.z.product_uid,
    });
    const bg = rm?.used ? 'FFD6E4FA' : p.action === 'rename' ? 'FFFDF3D6' : 'FFD9F2D9';
    row.eachCell({ includeEmpty: true }, c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } }; c.font = { size: 9 }; });
  });
  unmatched.forEach(x => ws.addRow({ zid: x.r.zid, cur: x.r.zname, srsName: x.r.srsName, action: 'NO PRODUCT', uid: '' }));
  const auditOut = path.join(__dirname, `${slug(label)}-rename-audit.xlsx`);
  await wb.xlsx.writeFile(auditOut);
  console.log(`\n✓ Wrote ${path.basename(auditOut)}`);

  if (MODE === 'audit') { console.log('\nAudit only. Re-run with --test-one or --apply to write.'); return; }

  const targetName = x => x.srsName ?? x.effective ?? x.r.srsName;
  async function applyOne(x) {
    const newName = targetName(x);
    const { json } = await getJson(`${BASE}product/${x.z.product_uid}`);
    const g = Array.isArray(json?.data) ? json.data[0] : json?.data;
    if (!g) return { zid: x.r.zid, status: 'get_failed' };
    const cur = String(g.product_name || '').trim();
    const lg = legacyValue(g);
    if (lg) return { zid: x.r.zid, status: 'already_done', legacy: lg };
    if (norm(cur) === norm(newName)) return { zid: x.r.zid, status: 'already_named' };
    const payload = buildRenamePut(g, newName, cur, legacy.uid);
    const res = await getJson(`${BASE}product/${x.z.product_uid}`, { method: 'PUT', body: JSON.stringify(payload) });
    const ok = res.ok && (res.json?.type === 'success' || res.json?.data);
    return { zid: x.r.zid, status: ok ? 'renamed' : 'put_failed', from: cur, to: newName, source: x.rematch?.used ? 'srs-db' : 'sheet', message: ok ? '' : (res.json?.message ?? JSON.stringify(res.json)) };
  }

  if (MODE === 'test-one') {
    const x = toRename[0] || matched[0];
    if (!x) { console.log('Nothing to test.'); return; }
    console.log(`\nTest: ${x.r.zid} uid=${x.z.product_uid}`);
    const r = await applyOne(x);
    console.log(`  status: ${r.status}  "${r.from || ''}" → "${r.to || ''}"  ${r.message || ''}`);
    const after = await getJson(`${BASE}product/${x.z.product_uid}`);
    const ag = Array.isArray(after.json?.data) ? after.json.data[0] : after.json?.data;
    console.log(`  AFTER name: ${JSON.stringify(ag?.product_name)}`);
    console.log(`  AFTER legacy: ${JSON.stringify(legacyValue(ag))}`);
    console.log(`  AFTER tags: ${JSON.stringify((ag?.meta_data || []).find(m => norm(m.label) === 'tags')?.value)}`);
    console.log(`  preserved price=${ag?.price} cat=${ag?.product_category?.category_name} options=${(ag?.option?.option_values || []).length}`);
    return;
  }

  let work = toRename;
  if (Number.isFinite(LIMIT)) work = work.slice(0, LIMIT);
  console.log(`\nRenaming ${work.length} products at concurrency ${CONCURRENCY} …`);
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
  for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
  console.log('\n\n--- Result ---');
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k}: ${v}`);
  const outFile = path.join(__dirname, `${slug(label)}-rename-apply.json`);
  fs.writeFileSync(outFile, JSON.stringify({ account: company, legacyFieldUid: legacy.uid, results }, null, 2));
  const fails = results.filter(r => ['put_failed', 'error', 'get_failed'].includes(r.status));
  if (fails.length) { console.log(`  ⚠ ${fails.length} failures:`); fails.slice(0, 20).forEach(r => console.log(`     ${r.zid}: ${r.status} ${r.message || ''}`)); }
  console.log(`✓ Wrote ${path.basename(outFile)}`);
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
