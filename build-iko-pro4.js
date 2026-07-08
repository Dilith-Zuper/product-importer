#!/usr/bin/env node
/**
 * Build the IKO Pro4 catalog + Good/Better/Best CPQ template in a customer account.
 *
 * Unlike the golden builds (build-oc-golden.js / build-gaf-golden.js) which reuse
 * the roofing-golden-account's pre-existing categories/formulas/warehouse UIDs, this
 * script targets an ARBITRARY account (default: fisher-roofing) that may be fresh, so
 * it BOOTSTRAPS everything it needs: measurement tokens, CPQ formulas, product
 * categories, then resolves warehouse/layout/trigger by probe.
 *
 * "IKO Pro4" is IKO's system-warranty bundle: IKO shingles + 4 qualifying IKO
 * accessories (starter, hip&ridge, ice&water, underlayment). We load all 32
 * residential IKO SKUs as products and build a G/B/B template where each tier is a
 * complete Pro4 system.
 *
 * Auth: set IKO_API_KEY in the environment (never commit the key).
 * Connection: --login <name> (default fisher-roofing) | --region <r> | --base <url>
 *
 * Phases (argv[2]):
 *   probe      read-only inventory: base/auth/uoms/categories/formulas/tokens/
 *              warehouse/layouts/job-categories + IKO product idempotency
 *   bootstrap  create missing measurement tokens, CPQ formulas, product categories
 *   products   create the 32 IKO products (POST product) -> iko-pro4-products.json
 *   template   create the Pro4 G/B/B template + options + line items + publish
 *   all        bootstrap -> products -> template
 */
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) { const k = t.slice(2); const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true; a[k] = v; }
    else a._.push(t);
  }
  return a;
}
const ARGS = parseArgs(process.argv.slice(3));
const LOGIN = (typeof ARGS.login === 'string' && ARGS.login) || 'fisher-roofing';
const API_KEY = process.env.IKO_API_KEY;
const PROBE_FILE = 'iko-pro4-probe.json';
const PRODUCTS_FILE = 'iko-pro4-products.json';
const BOOT_FILE = 'iko-pro4-bootstrap.json';
const TEMPLATE_FILE = 'iko-pro4-template-result.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hdrs = () => ({ 'x-api-key': API_KEY, 'Content-Type': 'application/json' });
const norm = s => String(s || '').trim().toLowerCase();

async function api(base, path, opts = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(base + path, { ...opts, headers: { ...hdrs(), ...(opts.headers || {}) } });
      if (res.status === 429 || res.status >= 500) { await sleep(700 * (attempt + 1)); continue; }
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
      return { ok: res.ok, status: res.status, json };
    } catch (e) { if (attempt === 3) throw e; await sleep(700 * (attempt + 1)); }
  }
}

async function resolveBase() {
  if (typeof ARGS.base === 'string') { let b = ARGS.base.trim().replace(/\/+$/, ''); if (!b.endsWith('/api')) b += '/api'; return b + '/'; }
  if (typeof ARGS.region === 'string') return `https://${ARGS.region}.zuperpro.com/api/`;
  const r = await fetch('https://accounts.zuperpro.com/api/config', {
    method: 'POST', headers: { 'content-type': 'application/json;charset=UTF-8' }, body: JSON.stringify({ company_name: LOGIN }),
  });
  if (!r.ok) throw new Error('config resolve failed ' + r.status);
  const d = await r.json();
  const dc = d?.config?.dc_api_url;
  if (!dc) throw new Error('no dc_api_url for login ' + LOGIN);
  return dc.replace(/\/?$/, '/api/');
}

// ── The 32 residential IKO SKUs, by Pro4 slot ────────────────────────────────
const CAT_NAMES = { Shingles: 'Shingles', Starter: 'Starter', HipRidge: 'Hip & Ridge', IceWater: 'Ice & Water', Underlayment: 'Underlayment' };
const IKO_PRODUCTS = [
  // Shingles (17) — colorPicker loads SRS color variants
  { id: 75747,  name: 'IKO Cambridge Non-AR Shingles',                 cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 92747,  name: 'IKO Cambridge Shingles',                        cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 75735,  name: 'IKO Cambridge Cool Plus Non-AR Shingles',       cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 136532, name: 'IKO Cambridge Cool Plus AR Shingles',           cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 92749,  name: 'IKO Cambridge IR ArmourZone Shingles',          cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 75734,  name: 'IKO Dynasty AR Class 3 IR with ArmourZone Shingles', cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 75746,  name: 'IKO Dynasty AR Shingles',                       cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 113070, name: 'IKO Dynasty Cool Plus AR Shingles',             cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 75743,  name: 'IKO Nordic IR ArmourZone AR Shingles',          cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 3911,   name: 'IKO Marathon Plus AR Shingles',                 cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 137994, name: 'IKO Regency AR IR ArmourZone Shingles',         cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 96356,  name: 'IKO Biltmore AR Shingles',                      cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 119521, name: 'IKO Armourshake Class 3 IR AR Shingles',        cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 75748,  name: 'IKO Armourshake IR Shingles',                   cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 4617,   name: 'IKO Crowne Slate IR Shingles',                  cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 3902,   name: 'IKO RoofShake HW Shingles',                     cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  { id: 3896,   name: 'IKO Royal Estate IR Shingles',                  cat: 'Shingles', uom: 'SQ', fk: 'shingles_squares', colorPicker: true },
  // Starter (3)
  { id: 75741,  name: 'IKO Leading Edge Plus Starter',                 cat: 'Starter', uom: 'BDL', fk: 'starter_strip_bundles', colorPicker: false },
  { id: 75744,  name: 'IKO Armour Shingle Starter',                    cat: 'Starter', uom: 'BDL', fk: 'starter_strip_bundles', colorPicker: false },
  { id: 75751,  name: 'IKO EdgeSeal Roof Starter',                     cat: 'Starter', uom: 'RL', fk: 'starter_strip_bundles', colorPicker: false },
  // Hip & Ridge (4)
  { id: 75739,  name: 'IKO Hip & Ridge 12',                            cat: 'HipRidge', uom: 'BDL', fk: 'hip_ridge_cap_bundles', colorPicker: false },
  { id: 75752,  name: 'IKO UltraHP Hip & Ridge',                       cat: 'HipRidge', uom: 'BDL', fk: 'hip_ridge_cap_bundles', colorPicker: false },
  { id: 75749,  name: 'IKO UltraHP IR Hip & Ridge',                    cat: 'HipRidge', uom: 'BDL', fk: 'hip_ridge_cap_bundles', colorPicker: false },
  { id: 88171,  name: 'IKO UltraHP Cool Hip & Ridge',                  cat: 'HipRidge', uom: 'BDL', fk: 'hip_ridge_cap_bundles', colorPicker: false },
  // Ice & Water (6)
  { id: 4680,   name: 'IKO StormShield Ice & Water Protector',        cat: 'IceWater', uom: 'RL', fk: 'ice_and_water_shield_rolls', colorPicker: false },
  { id: 4681,   name: 'IKO GoldShield Ice & Water Protector',        cat: 'IceWater', uom: 'RL', fk: 'ice_and_water_shield_rolls', colorPicker: false },
  { id: 4682,   name: 'IKO ArmourGard Ice & Water Protector',       cat: 'IceWater', uom: 'RL', fk: 'ice_and_water_shield_rolls', colorPicker: false },
  { id: 184039, name: 'IKO ArmourGard Pro Ice & Water Protector',   cat: 'IceWater', uom: 'RL', fk: 'ice_and_water_shield_rolls', colorPicker: false },
  { id: 4683,   name: 'IKO StormTamer Ice & Water Protector',       cat: 'IceWater', uom: 'RL', fk: 'ice_and_water_shield_rolls', colorPicker: false },
  { id: 88194,  name: 'IKO Protecto Ice & Water',                    cat: 'IceWater', uom: 'RL', fk: 'ice_and_water_shield_rolls', colorPicker: false },
  // Underlayment (2)
  { id: 4679,   name: 'IKO Roofgard Synthetic Underlayment',         cat: 'Underlayment', uom: 'RL', fk: 'underlayment_synthetic_rolls', colorPicker: false },
  { id: 4685,   name: 'IKO Stormtite Synthetic Underlayment',        cat: 'Underlayment', uom: 'RL', fk: 'underlayment_synthetic_rolls', colorPicker: false },
];

// ── Bootstrap definitions ────────────────────────────────────────────────────
const TOKEN_CATEGORY = 'CPQ Tokens';
const TOKENS = [
  { name: 'Total Roof Area', uom: 'SQ' }, { name: 'Suggested Waste Percentage %', uom: 'PCT' },
  { name: 'Total Hip Length', uom: 'LF' }, { name: 'Total Ridges Length', uom: 'LF' },
  { name: 'Total Eaves Length', uom: 'LF' }, { name: 'Total Rakes Length', uom: 'LF' },
  { name: 'Total Valleys Length', uom: 'LF' },
];
const m = field_name => ({ type: 'MEASUREMENT', field_name });
const c = value => ({ type: 'CONSTANT', value });
const FORMULAS = [
  { formula_name: 'Shingles (squares)', formula_key: 'shingles_squares', formula_description: 'Roof area with waste factor, output in squares',
    expression: '($1*(1+$2/$3))/$4', expression_map: [m('Total Roof Area'), m('Suggested Waste Percentage %'), c(100), c(100)], rounding_mechanism: 'NO_ROUNDING' },
  { formula_name: 'Starter Strip (bundles)', formula_key: 'starter_strip_bundles', formula_description: 'Eaves + rakes / 120 LF per bundle',
    expression: '($1+$2)/$3', expression_map: [m('Total Eaves Length'), m('Total Rakes Length'), c(120)], rounding_mechanism: 'NEXT_WHOLE_NUMBER' },
  { formula_name: 'Hip & Ridge Cap (bundles)', formula_key: 'hip_ridge_cap_bundles', formula_description: 'Hip + ridge / 33 LF per bundle',
    expression: '($1+$2)/$3', expression_map: [m('Total Hip Length'), m('Total Ridges Length'), c(33)], rounding_mechanism: 'NEXT_WHOLE_NUMBER' },
  { formula_name: 'Ice & Water Shield (rolls)', formula_key: 'ice_and_water_shield_rolls', formula_description: '(Eaves + Valleys) * 1.1 / 66 LF per roll',
    expression: '($1+$2)*$3/$4', expression_map: [m('Total Eaves Length'), m('Total Valleys Length'), c(1.1), c(66)], rounding_mechanism: 'NEXT_WHOLE_NUMBER' },
  { formula_name: 'Underlayment Synthetic (rolls)', formula_key: 'underlayment_synthetic_rolls', formula_description: 'Roof area with waste / 1000 SQFT per roll',
    expression: '$1*(1+$2/$3)/$4', expression_map: [m('Total Roof Area'), m('Suggested Waste Percentage %'), c(100), c(1000)], rounding_mechanism: 'NEXT_WHOLE_NUMBER' },
];

const COLOR_META = [
  { hide_field:false,hide_to_fe:false,id:0,label:'Color',read_only:false,type:'MULTI_LINE',dependent_on:'',dependent_options:[],module_name:'PRODUCT',value:'' },
  { hide_field:false,hide_to_fe:false,id:1,label:'Color Selected',read_only:false,type:'SINGLE_LINE',dependent_on:'',dependent_options:[],module_name:'PRODUCT',value:'' },
  { hide_field:false,hide_to_fe:false,id:2,label:'Color Selection Mandatory',read_only:false,type:'RADIO',dependent_on:'',dependent_options:[],module_name:'PRODUCT',value:'' },
  { hide_field:false,hide_to_fe:false,id:3,label:'Display Color Selection',read_only:false,type:'RADIO',dependent_on:'',dependent_options:[],module_name:'PRODUCT',value:'' },
];

// ── Read helpers ─────────────────────────────────────────────────────────────
async function getFormulas(base) {
  const map = {}; let page = 1;
  while (true) {
    const r = await api(base, `invoice_estimate/cpq/formulas?count=100&page=${page}`);
    const rows = r.json?.data ?? [];
    for (const f of rows) { if (f.formula_key) map[f.formula_key] = f.formula_uid; }
    if (rows.length < 100) break; page++;
  }
  return map;
}
async function getCategories(base) {
  const map = {}; let page = 1;
  while (true) {
    const r = await api(base, `products/category?count=100&page=${page}`);
    const rows = r.json?.data ?? [];
    for (const cat of rows) map[norm(cat.category_name)] = cat.category_uid;
    if (rows.length < 100) break; page++;
  }
  return map;
}
async function getTokenCategories(base) {
  const r = await api(base, `measurements/categories?sort=ASC&sort_by=created_at`);
  return r.json?.data ?? [];
}
async function loadExistingProductMap(base) {
  const map = {}; let page = 1;
  while (true) {
    const r = await api(base, `product?count=100&page=${page}`);
    const rows = r.json?.data ?? [];
    for (const p of rows) if (p.product_id) map[String(p.product_id)] = p.product_uid;
    if (rows.length < 100) break; page++;
    if (page > 300) break;
  }
  return map;
}
async function loadColors(productId) {
  const rows = []; let offset = 0;
  while (true) {
    const { data, error } = await supabase.from('srs_variants')
      .select('color_name').eq('product_id', productId).eq('is_restricted', false).order('variant_id').range(offset, offset + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) break; offset += 1000;
  }
  const real = s => s && s.trim() && !['n/a', 'na'].includes(s.trim().toLowerCase());
  return Array.from(new Set(rows.map(r => r.color_name).filter(real).map(s => s.trim()))).slice(0, 50);
}

// ── PROBE ────────────────────────────────────────────────────────────────────
async function probe() {
  if (!API_KEY) throw new Error('Set IKO_API_KEY in the environment.');
  const base = await resolveBase();
  console.log('BASE:', base, '\nLOGIN:', LOGIN);
  const who = await api(base, 'user/company');
  console.log('AUTH:', who.ok ? ('OK — ' + (who.json?.data?.company_name ?? '?')) : ('FAIL ' + who.status + ' ' + JSON.stringify(who.json).slice(0, 200)));
  if (!who.ok) return;

  const uomRes = await api(base, 'misc/uom?filter.industry=roofing');
  const uoms = (uomRes.json?.data ?? []).map(u => u.value);
  const neededUoms = Array.from(new Set(IKO_PRODUCTS.map(p => p.uom)));
  console.log('\n== UOMs (roofing) ==', uoms.join(', ') || '(none)');
  for (const u of neededUoms) console.log('  need', u.padEnd(4), uoms.includes(u) ? 'OK' : '(MISSING)');

  const cats = await getCategories(base);
  console.log('\n== PRODUCT CATEGORIES ==');
  for (const [k, disp] of Object.entries(CAT_NAMES)) console.log('  ', disp.padEnd(14), cats[norm(disp)] ? 'OK ' + cats[norm(disp)] : '(missing — will create)');

  const formulas = await getFormulas(base);
  console.log('\n== CPQ FORMULAS (needed) ==');
  for (const f of FORMULAS) console.log('  ', f.formula_key.padEnd(30), formulas[f.formula_key] ? 'OK ' + formulas[f.formula_key] : '(missing — will create)');
  console.log('  total formulas in account:', Object.keys(formulas).length);

  const tokenCats = await getTokenCategories(base);
  const haveTokens = new Set();
  for (const tc of tokenCats) for (const t of (tc.measurement_tokens ?? [])) haveTokens.add(norm(t.measurement_token_name));
  console.log('\n== MEASUREMENT TOKENS (needed) ==');
  for (const t of TOKENS) console.log('  ', t.name.padEnd(30), haveTokens.has(norm(t.name)) ? 'OK' : '(missing — will create)');
  console.log('  token categories present:', tokenCats.map(t => t.measurement_category_name).join(', ') || '(none)');

  const locs = await api(base, 'products/location?count=100&page=1');
  const locations = locs.json?.data ?? [];
  console.log('\n== LOCATIONS / WAREHOUSES ==');
  locations.forEach(l => console.log('  ', l.location_uid ?? l.uid, l.location_name ?? l.name, l.is_default ? '(default)' : ''));

  const layouts = await api(base, 'layout_templates');
  const layoutRows = layouts.json?.data ?? [];
  console.log('\n== LAYOUT TEMPLATES ==');
  layoutRows.forEach(l => console.log('  ', l.layout_template_uid ?? l.uid, l.layout_template_name ?? l.name));

  // Try candidate endpoints for job categories + statuses (for CPQ trigger).
  const jobCats = { endpoint: null, rows: [] };
  for (const ep of ['jobs/category?count=100&page=1', 'job/category?count=100&page=1', 'settings/job_category?count=100&page=1', 'jobs/categories?count=100&page=1']) {
    const r = await api(base, ep);
    if (r.ok && Array.isArray(r.json?.data) && r.json.data.length) { jobCats.endpoint = ep; jobCats.rows = r.json.data; break; }
  }
  console.log('\n== JOB CATEGORIES ==', jobCats.endpoint || '(none of the candidate endpoints returned data)');
  jobCats.rows.slice(0, 10).forEach(j => console.log('  ', j.category_uid ?? j.job_category_uid ?? j.uid, j.category_name ?? j.job_category_name ?? j.name));

  const existing = await loadExistingProductMap(base);
  const already = IKO_PRODUCTS.filter(p => existing[String(p.id)]).length;
  console.log('\n== IKO PRODUCT IDEMPOTENCY ==', `${already}/${IKO_PRODUCTS.length} already in account`);

  fs.writeFileSync(PROBE_FILE, JSON.stringify({
    base, company: who.json?.data?.company_name, uoms, cats, formulas,
    tokenCategories: tokenCats.map(t => ({ uid: t.measurement_category_uid, name: t.measurement_category_name, tokens: (t.measurement_tokens ?? []).map(x => x.measurement_token_name) })),
    locations, layouts: layoutRows, jobCategories: jobCats,
    existingIko: Object.fromEntries(IKO_PRODUCTS.map(p => [p.id, existing[String(p.id)] || null])),
  }, null, 2));
  console.log('\nwrote', PROBE_FILE);
}

// ── BOOTSTRAP: tokens, formulas, product categories ──────────────────────────
async function bootstrap() {
  if (!API_KEY) throw new Error('Set IKO_API_KEY in the environment.');
  const base = await resolveBase();
  const who = await api(base, 'user/company');
  if (!who.ok) throw new Error('auth failed ' + who.status);
  console.log('Bootstrapping', who.json?.data?.company_name, '(' + base + ')');
  const out = { tokens: {}, formulas: {}, categories: {} };

  // 1. Tokens — index every existing token across ALL categories first; only create
  //    a "CPQ Tokens" category if some needed token is genuinely missing (avoids
  //    polluting an established account whose tokens already live in other categories).
  let tokenCats = await getTokenCategories(base);
  const tokenMap = {}; // name -> { measurement_token_uid, measurement_category_uid }
  for (const cat of tokenCats) for (const t of (cat.measurement_tokens ?? [])) if (!tokenMap[t.measurement_token_name]) tokenMap[t.measurement_token_name] = { measurement_token_uid: t.measurement_token_uid, measurement_category_uid: cat.measurement_category_uid };
  const missingTokens = TOKENS.filter(t => !tokenMap[t.name]);
  if (missingTokens.length) {
    let tcat = tokenCats.find(t => norm(t.measurement_category_name) === norm(TOKEN_CATEGORY));
    if (!tcat) {
      const cr = await api(base, 'measurements/categories', { method: 'POST', body: JSON.stringify({ measurement_category: { measurement_category_name: TOKEN_CATEGORY } }) });
      let uid = cr.json?.data?.measurement_category_uid;
      if (!uid) { tokenCats = await getTokenCategories(base); uid = tokenCats.find(t => norm(t.measurement_category_name) === norm(TOKEN_CATEGORY))?.measurement_category_uid; }
      tcat = { measurement_category_uid: uid };
      console.log('  created token category', uid);
    }
    for (const t of missingTokens) {
      const r = await api(base, `measurements/categories/${tcat.measurement_category_uid}/tokens`, { method: 'POST', body: JSON.stringify({ measurement_token: { measurement_token_name: t.name, uom: t.uom } }) });
      const uid = r.json?.data?.measurement_token_uid;
      if (!uid) throw new Error('token create failed: ' + t.name + ' ' + JSON.stringify(r.json).slice(0, 150));
      tokenMap[t.name] = { measurement_token_uid: uid, measurement_category_uid: tcat.measurement_category_uid };
      console.log('  + token', t.name, uid); await sleep(150);
    }
  } else {
    console.log('  = all', TOKENS.length, 'tokens already present');
  }
  out.tokens = tokenMap;

  // 2. Formulas
  const existingF = await getFormulas(base);
  for (const def of FORMULAS) {
    if (existingF[def.formula_key]) { out.formulas[def.formula_key] = existingF[def.formula_key]; console.log('  = formula', def.formula_key); continue; }
    const expression_map = def.expression_map.map((entry, idx) => {
      const key = `$${idx + 1}`;
      if (entry.type === 'CONSTANT') return { key, type: 'CONSTANT', value: entry.value };
      const ti = tokenMap[entry.field_name];
      if (!ti) throw new Error('token missing for formula ' + def.formula_key + ': ' + entry.field_name);
      return { key, type: 'MEASUREMENT', field_name: entry.field_name, measurement_token_uid: ti.measurement_token_uid, measurement_category_uid: ti.measurement_category_uid };
    });
    const r = await api(base, 'invoice_estimate/cpq/formulas', { method: 'POST', body: JSON.stringify({
      formula: { formula_name: def.formula_name, formula_key: def.formula_key, formula_category: 'AREA_MEASUREMENT', formula_description: def.formula_description, formula: { expression: def.expression, expression_map, rounding_mechanism: def.rounding_mechanism } },
    }) });
    let uid = r.json?.data?.formula_uid;
    if (!uid) { const again = await getFormulas(base); uid = again[def.formula_key]; }
    if (!uid) throw new Error('formula create failed: ' + def.formula_name + ' ' + JSON.stringify(r.json).slice(0, 200));
    out.formulas[def.formula_key] = uid; console.log('  + formula', def.formula_key, uid); await sleep(200);
  }

  // 3. Product categories
  const cats = await getCategories(base);
  for (const disp of Object.values(CAT_NAMES)) {
    if (cats[norm(disp)]) { out.categories[disp] = cats[norm(disp)]; console.log('  = category', disp); continue; }
    const r = await api(base, 'products/category', { method: 'POST', body: JSON.stringify({ product_category: { category_name: disp, category_description: '', bu_uids: [], parent_category_uid: null } }) });
    let uid = r.json?.data?.category_uid ?? r.json?.data?.product_category_uid ?? (Array.isArray(r.json?.data) ? r.json.data[0]?.category_uid : null);
    if (!uid) { const again = await getCategories(base); uid = again[norm(disp)]; }
    if (!uid) throw new Error('category create failed: ' + disp + ' ' + JSON.stringify(r.json).slice(0, 200));
    out.categories[disp] = uid; console.log('  + category', disp, uid); await sleep(200);
  }

  fs.writeFileSync(BOOT_FILE, JSON.stringify(out, null, 2));
  console.log('\nwrote', BOOT_FILE);
}

// ── PRODUCTS ─────────────────────────────────────────────────────────────────
async function buildProducts() {
  if (!API_KEY) throw new Error('Set IKO_API_KEY in the environment.');
  const base = await resolveBase();
  const boot = JSON.parse(fs.readFileSync(BOOT_FILE, 'utf8'));
  // resolve default warehouse
  const locs = await api(base, 'products/location?count=100&page=1');
  const locations = locs.json?.data ?? [];
  const warehouse = (locations.find(l => l.is_default) ?? locations[0])?.location_uid ?? (locations.find(l => l.is_default) ?? locations[0])?.uid;
  if (!warehouse) throw new Error('no warehouse/location found in account');
  console.log('warehouse:', warehouse);

  const existing = await loadExistingProductMap(base);
  const result = {};
  for (const spec of IKO_PRODUCTS) {
    const key = String(spec.id);
    if (existing[key]) { console.log('  SKIP (exists)', spec.name, '->', existing[key]); result[key] = { product_uid: existing[key], name: spec.name, reused: true, cat: spec.cat, fk: spec.fk }; continue; }
    const { data: prow } = await supabase.from('srs_products').select('product_description,suggested_price,purchase_price').eq('product_id', spec.id).single();
    const colors = spec.colorPicker ? await loadColors(spec.id) : [];
    const option = spec.colorPicker
      ? { customer_selection: true, mandate_customer_selection: true, option_label: 'Color', option_values: colors.map(cl => ({ option_value: cl, option_image: '', is_available: true })) }
      : { customer_selection: false, mandate_customer_selection: false, option_label: 'Color', option_values: [] };
    const body = { product: {
      prefix: '', product_name: spec.name, product_id: key, is_available: true,
      product_category: boot.categories[CAT_NAMES[spec.cat]], price: prow?.suggested_price ?? 0,
      purchase_price: prow?.purchase_price ?? null, min_quantity: 1, quantity: 1, currency: '',
      product_manual_link: '', product_description: prow?.product_description ? `<p>${prow.product_description.slice(0, 2000)}</p>` : '',
      product_image: '', product_type: 'PARTS', pricing_level: 'ROLLUP', brand: 'IKO',
      track_quantity: true, specification: '', has_custom_tax: false, uom: spec.uom, is_billable: true,
      consider_profitability: true, is_commissionable: true, bu_uids: null,
      location_availability: [{ location: warehouse, min_quantity: 1, quantity: 1, serial_nos: [] }],
      tax: { tax_exempt: false, tax_name: '', tax_rate: '' }, markup: null, product_files: [],
      meta_data: COLOR_META, option, formula: boot.formulas[spec.fk],
    }, vendor: [] };
    const r = await api(base, 'product', { method: 'POST', body: JSON.stringify(body) });
    const pd = Array.isArray(r.json?.data) ? r.json.data[0] : r.json?.data;
    const uid = pd?.product_uid;
    if (!r.ok || !uid) { console.log('  FAIL', spec.name, r.status, JSON.stringify(r.json).slice(0, 200)); continue; }
    console.log('  CREATED', spec.name, '->', uid, `(${colors.length} colors)`);
    result[key] = { product_uid: uid, name: spec.name, colors: colors.length, cat: spec.cat, fk: spec.fk };
    await sleep(300);
  }
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(result, null, 2));
  console.log('\nwrote', PRODUCTS_FILE, '—', Object.keys(result).length, 'products');
}

// ── TEMPLATE ─────────────────────────────────────────────────────────────────
// Trigger + layout resolved from the fisher-roofing probe: the account's live CPQ
// templates all fire on Inspection / "Create Proposal" (non-exclusive — 6 live
// templates already share it, so this coexists, doesn't hijack). Layout = the
// proposal layout the reference "Residential Roofing" CPQ template uses.
const TRIGGER = {
  job_category_uid: '04461702-eb3f-405e-b1eb-28d54d02cc24', job_category_name: 'Inspection',
  job_status_uid: '6d37b358-504b-4854-935f-f94a2ec8ef99', job_status_name: 'Create Proposal',
};
const LAYOUT_UID = 'b41150e0-e196-4a7a-8bdd-960c5e95a02c';

// Each Pro4 tier = a complete IKO system (shingle + 4 qualifying accessories).
const TIER_PLAN = {
  Good:   { shingle: 92747, starter: 75741, hipridge: 75752, icewater: 4680,   underlay: 4679, desc: 'IKO Pro4 — Cambridge System' },
  Better: { shingle: 75746, starter: 75741, hipridge: 75752, icewater: 4680,   underlay: 4685, desc: 'IKO Pro4 — Dynasty System (ArmourZone)' },
  Best:   { shingle: 4617,  starter: 75744, hipridge: 75749, icewater: 184039, underlay: 4685, desc: 'IKO Pro4 — Crowne Slate Designer System' },
};

async function postLineItem(base, url, li) {
  const body = { line_item: {
    type: 'ITEM', line_item_type: 'ITEM', product_name: li.name, product: li.product, product_type: 'PARTS', quantity: 1,
    ...(li.f ? { quantity_type: 'FORMULA', formula: li.f } : { quantity_type: 'FIXED' }),
    ...(li.sectionUid ? { section_uid: li.sectionUid, section_name: li.sectionName } : {}),
  } };
  const r = await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify(body) });
  if (!r.ok && li.f) { const fb = { line_item: { ...body.line_item, quantity_type: 'FIXED', formula: undefined } }; await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify(fb) }); }
  return r.ok;
}

async function buildTemplate() {
  if (!API_KEY) throw new Error('Set IKO_API_KEY in the environment.');
  const base = await resolveBase();
  const products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
  const boot = JSON.parse(fs.readFileSync(BOOT_FILE, 'utf8'));
  const pick = id => { const p = products[String(id)]; if (!p) throw new Error('missing product ' + id + ' — run products phase'); return { name: p.name, product: p.product_uid, f: boot.formulas[p.fk] }; };

  const TEMPLATE_NAME = 'IKO Pro4 - Good / Better / Best';
  const TEMPLATE_DESC = 'IKO Pro4 system warranty — Cambridge / Dynasty / Armourshake, each with 4 qualifying IKO components';

  const cr = await api(base, 'invoice_estimate/proposal_template', { method: 'POST', body: JSON.stringify({ proposal_template: { template_name: TEMPLATE_NAME, template_description: TEMPLATE_DESC, template_type: 'CPQ' } }) });
  const templateUid = cr.json?.data?.template_uid;
  if (!templateUid) throw new Error('template create failed: ' + JSON.stringify(cr.json));
  console.log('template', templateUid);

  const or = await api(base, `invoice_estimate/proposal_template/${templateUid}/options?items_type=LINE_ITEMS`, { method: 'POST', body: JSON.stringify({ proposal_options: [
    { option_name: 'Good',   option_description: TIER_PLAN.Good.desc,   option_image: '', promo: '', is_recommended: false },
    { option_name: 'Better', option_description: TIER_PLAN.Better.desc, option_image: '', promo: '', is_recommended: true },
    { option_name: 'Best',   option_description: TIER_PLAN.Best.desc,   option_image: '', promo: '', is_recommended: false },
  ] }) });
  const options = or.json?.data ?? [];
  const optUid = n => options.find(o => o.option_name === n)?.option_uid;
  console.log('options:', options.map(o => `${o.option_name}=${o.option_uid}`).join(', '));

  for (const tier of ['Good', 'Better', 'Best']) {
    const plan = TIER_PLAN[tier];
    const ou = optUid(tier);
    const url = `${base}invoice_estimate/proposal_template/${templateUid}/options/${ou}/line_items?items_type=LINE_ITEMS`;
    const mh = await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify({ line_item: { type: 'HEADER', line_item_type: 'HEADER', product_name: 'Material', section_type: 'EXPANDED', show_section_total: false, show_child_prices: true } }) });
    const mhj = await mh.json(); const mhd = Array.isArray(mhj?.data) ? mhj.data[0] : mhj?.data;
    const matSec = mhd?.section_uid ?? mhd?.line_item_uid;
    let n = 0;
    for (const id of [plan.shingle, plan.starter, plan.hipridge, plan.icewater, plan.underlay]) {
      if (await postLineItem(base, url, { ...pick(id), sectionUid: matSec, sectionName: 'Material' })) n++;
      await sleep(150);
    }
    console.log(`  ${tier}: ${n} line items added`);
  }

  // publish LAST — Inspection/Create Proposal trigger + reference layout, is_draft:false
  const pubBody = { proposal_template: { template_name: TEMPLATE_NAME, template_description: TEMPLATE_DESC, template_type: 'CPQ', template_uid: templateUid,
    cpq_config: { trigger: [TRIGGER] }, layout_template_uid: LAYOUT_UID, is_draft: false } };
  const pr = await api(base, `invoice_estimate/proposal_template/${templateUid}`, { method: 'PUT', body: JSON.stringify(pubBody) });
  console.log('publish:', pr.ok ? 'OK (published, Inspection/Create Proposal)' : ('FAIL ' + pr.status + ' ' + JSON.stringify(pr.json).slice(0, 200)));

  fs.writeFileSync(TEMPLATE_FILE, JSON.stringify({ templateUid, options, trigger: TRIGGER, layoutUid: LAYOUT_UID, published: pr.ok }, null, 2));
  console.log('wrote', TEMPLATE_FILE);
}

const phase = process.argv[2];
(async () => {
  if (phase === 'probe') return probe();
  if (phase === 'bootstrap') return bootstrap();
  if (phase === 'products') return buildProducts();
  if (phase === 'template') return buildTemplate();
  if (phase === 'all') { await bootstrap(); await buildProducts(); await buildTemplate(); return; }
  console.log('usage: IKO_API_KEY=xxx node build-iko-pro4.js probe|bootstrap|products|template|all [--login fisher-roofing]');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
