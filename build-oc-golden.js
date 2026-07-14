#!/usr/bin/env node
/**
 * Build the Owens Corning Good/Better/Best CPQ template in the Single Job Roofing Golden Account.
 * Blueprint: OC_GOLDEN_TEMPLATE.md. Mirrors the gaf-golden / certainteed-golden builds.
 *
 * Scope decision (2026-07-01): lean OC G/B/B (NOT the full 15-option Trust Roofing export).
 * Shingle ladder: Duration (Good) / Duration (Better) / Woodmoor (Best).
 *
 * Phases (argv[2]):
 *   probe     — read-only: base URL, auth, formulas/categories/locations/layout, OC idempotency
 *   products  — create the OC SRS products (POST product), write oc-golden-products.json
 *   template  — create template + options + line items + publish, write oc-golden-template-result.json
 *
 * Reuses the golden account's existing CPQ formulas (ct_* round-up customs) + common/labor
 * product UIDs proven in the GAF build (gaf-golden-products.json / gaf-golden-template-result.json).
 */
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const LOGIN = 'roofing-golden-account';
const API_KEY = process.env.ZUPER_GOLDEN_API_KEY;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hdrs = () => ({ 'x-api-key': API_KEY, 'Content-Type': 'application/json' });

async function api(base, path, opts = {}) {
  const res = await fetch(base + path, { ...opts, headers: { ...hdrs(), ...(opts.headers || {}) } });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function resolveBase() {
  const r = await fetch('https://accounts.zuperpro.com/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ company_name: LOGIN }),
  });
  if (!r.ok) throw new Error('config resolve failed ' + r.status);
  const d = await r.json();
  const dc = d?.config?.dc_api_url;
  if (!dc) throw new Error('no dc_api_url');
  return dc.replace(/\/?$/, '/api/');
}

async function getAllFormulas(base) {
  const map = {}; let page = 1;
  while (true) {
    const r = await api(base, `invoice_estimate/cpq/formulas?count=100&page=${page}`);
    const rows = r.json?.data ?? [];
    for (const f of rows) if (f.formula_key && f.formula_uid) map[f.formula_key] = { uid: f.formula_uid, name: f.formula_name, custom: f.is_custom };
    if (rows.length < 100) break;
    page++;
  }
  return map;
}

async function getCategories(base) {
  const map = {}; let page = 1;
  while (true) {
    const r = await api(base, `products/category?count=100&page=${page}`);
    const rows = r.json?.data ?? [];
    for (const c of rows) map[c.category_name] = c.category_uid;
    if (rows.length < 100) break;
    page++;
  }
  return map;
}

async function loadExistingProductMap(base) {
  const map = {}; let page = 1;
  while (true) {
    const r = await api(base, `product?count=100&page=${page}`);
    const rows = r.json?.data ?? [];
    for (const p of rows) if (p.product_id) map[String(p.product_id)] = p.product_uid;
    if (rows.length < 100) break;
    page++;
    if (page > 200) break;
  }
  return map;
}

// ── Build constants (reused from the GAF/CT golden builds; re-confirmed at probe) ────
const WAREHOUSE = 'b94326f2-e3a6-41cf-bac8-87d1540883ca';
const TRIGGER = { catUid: '96b23fdd-ff1f-4e74-bbb2-f397bde60fa4', statusUid: '590cae00-48ed-441c-829f-fb07d008b8e8', layoutUid: '7c75a34a-ad78-439a-b68a-56928856dc2a' };
const CAT = {
  Shingles: 'ff62617a-7195-49c2-9164-07c50065d280',
  Underlayment: '2ad7f7be-6fda-4b9a-8c35-eaf83628d238',
  IceWater: 'e2993ea3-e09d-4c1b-a667-5b01cd8acaf9',
  HipRidge: '11b8be61-add3-4ba5-ad7e-3b70e994b45a',
  Vents: 'ddb6a35a-dc2a-43e1-a80e-49985149f7bd',
  RoofingMaterials: '112945ab-1546-4baa-94e2-ce4fcd484edd',
};
const F = { // formula uids (corrected ct_* round-up customs, proven in GAF build)
  shingles: 'fc3af594-4900-49f6-bf33-b97576aee01c',
  starter: 'be281b5e-526a-423c-82e1-d3261d9ddb23',
  hipridge: '5b2f8876-4cf4-4eb0-ad54-10c4abc9d601',
  icewater: 'a7690fc2-19fa-4188-bafe-27caecf1fcc2',
  synthetic: '9036b640-0bb9-42b6-b275-95c912a196c1',
  ridgevent: '1a854eb8-90dc-40bf-8539-5060449f811e',
};
// OC products to create (SRS id → spec). colorPicker=true loads SRS color variants.
const OC_PRODUCTS = [
  { id: 688,    name: 'Owens Corning Oakridge Shingles',             cat: CAT.Shingles,         uom: 'BDL', f: F.shingles,  colorPicker: true,  tiers: ['Good'] },
  { id: 75933,  name: 'Owens Corning TruDefinition Duration Shingles', cat: CAT.Shingles,        uom: 'BDL', f: F.shingles,  colorPicker: true,  tiers: ['Better'] },
  { id: 675,    name: 'Owens Corning Woodmoor Shingles',              cat: CAT.Shingles,         uom: 'BDL', f: F.shingles,  colorPicker: true,  tiers: ['Best'] },
  { id: 672,    name: 'Owens Corning ProEdge AR Hip & Ridge',        cat: CAT.HipRidge,         uom: 'BDL', f: F.hipridge,  colorPicker: false, tiers: ['Good','Better'] },
  { id: 685,    name: 'Owens Corning Berkshire Hip & Ridge',         cat: CAT.HipRidge,         uom: 'BDL', f: F.hipridge,  colorPicker: false, tiers: ['Best'] },
  { id: 686,    name: 'Owens Corning Starter Strip',                 cat: CAT.RoofingMaterials, uom: 'BDL', f: F.starter,   colorPicker: false, tiers: ['Good','Better'] },
  { id: 133782, name: 'Owens Corning WoodStart Starter',             cat: CAT.RoofingMaterials, uom: 'BDL', f: F.starter,   colorPicker: false, tiers: ['Best'] },
  { id: 75674,  name: 'Owens Corning RhinoRoof U20 Synthetic Underlayment', cat: CAT.Underlayment, uom: 'RL', f: F.synthetic, colorPicker: false, tiers: ['Good','Better'] },
  { id: 79663,  name: 'Owens Corning Titanium UDL30 Synthetic Underlayment', cat: CAT.Underlayment, uom: 'RL', f: F.synthetic, colorPicker: false, tiers: ['Best'] },
  { id: 684,    name: 'Owens Corning WeatherLock Flex Ice & Water Barrier', cat: CAT.IceWater,   uom: 'RL',  f: F.icewater,  colorPicker: false, tiers: ['all'] },
  { id: 676,    name: 'Owens Corning VentSure Ridge Vent',           cat: CAT.Vents,            uom: 'PC',  f: F.ridgevent, colorPicker: false, tiers: ['all'] },
];
// Existing golden-account products reused verbatim in every tier (from GAF/CT build).
const COMMON = [
  { name: 'Galvanized Drip Edge',    product: '756e9dd1-8db6-4d3a-b005-f22699a85e3d', f: 'c525c51f-7f01-495a-a01d-53cfc65c2538' },
  { name: 'Steel Roll Valley Metal', product: '24a2d610-d134-4e55-afea-9439d0310f1d', f: '1e2dc692-fe93-4b60-856b-2012a7a403a1' },
  { name: 'Galvanized Step Flashing',product: 'fdfb18bc-0774-414e-aaad-d66c89ad41ce', f: null },
  { name: 'Coil Nails',              product: '9bbcfde9-cbe3-4ef0-8315-e761843380e7', f: '162203ae-a869-43fa-8a23-8a2048e2a17f' },
  { name: 'Chem Link DuraSil High Performance Silicone Sealant', product: '011eb6ed-6a49-4b49-9150-8dc3a6bbb346', f: null },
];
const LABOR = [
  { name: 'Roof Tear-Off Labor',       product: '07a1adf8-4915-4a76-a683-2006d08b4c65', f: F.shingles },
  { name: 'Shingle Install - Standard',product: '842309a0-d81c-46a6-b16c-cf82c7726390', f: F.shingles },
  { name: 'Residential Permit',        product: '6548f204-6d81-4785-bfaa-1cf4541f6138', f: null }, // FIXED 1
];
// Per-tier warranty (existing OC warranty products; UOM=SQ, qty = roof squares via F.shingles).
const WARRANTY = {
  Good:   { name: 'Owens Corning Standard Warranty', product: '38e171c5-243a-40f1-a78e-d8e85650763c', f: F.shingles },
  Better: { name: 'Owens Corning System Warranty',   product: '9d54402a-a5e0-455e-998e-8603da1dea32', f: F.shingles },
  Best:   { name: 'Owens Corning Platinum Warranty', product: '26d11c28-7c87-486e-85ff-b058d5157a67', f: F.shingles },
};

const COLOR_META = [
  { hide_field:false,hide_to_fe:false,id:0,label:'Color',read_only:false,type:'MULTI_LINE',dependent_on:'',dependent_options:[],module_name:'PRODUCT',value:'' },
  { hide_field:false,hide_to_fe:false,id:1,label:'Color Selected',read_only:false,type:'SINGLE_LINE',dependent_on:'',dependent_options:[],module_name:'PRODUCT',value:'' },
  { hide_field:false,hide_to_fe:false,id:2,label:'Color Selection Mandatory',read_only:false,type:'RADIO',dependent_on:'',dependent_options:[],module_name:'PRODUCT',value:'' },
  { hide_field:false,hide_to_fe:false,id:3,label:'Display Color Selection',read_only:false,type:'RADIO',dependent_on:'',dependent_options:[],module_name:'PRODUCT',value:'' },
];

async function loadColors(productId) {
  const rows = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.from('srs_variants')
      .select('color_name').eq('product_id', productId).eq('is_restricted', false)
      .order('variant_id').range(offset, offset + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  const real = s => s && s.trim() && !['n/a','na'].includes(s.trim().toLowerCase());
  return Array.from(new Set(rows.map(r => r.color_name).filter(real).map(s => s.trim()))).slice(0, 50);
}

async function probe() {
  const base = await resolveBase();
  console.log('BASE:', base);
  const who = await api(base, 'user/company');
  console.log('AUTH:', who.ok ? ('OK — ' + (who.json?.data?.company_name ?? '?')) : ('FAIL ' + who.status));
  if (!who.ok) return;

  const formulas = await getAllFormulas(base);
  const byUid = Object.fromEntries(Object.values(formulas).map(f => [f.uid, f]));
  console.log('\n== FORMULAS in use (by uid) ==');
  for (const [k, v] of Object.entries(F)) console.log('  ', k.padEnd(12), v, byUid[v] ? `OK "${byUid[v].name}" custom=${byUid[v].custom}` : '(MISSING!)');
  for (const c of COMMON) if (c.f) console.log('  ', ('common:'+c.name).slice(0,24).padEnd(24), c.f, byUid[c.f] ? 'OK' : '(MISSING!)');
  console.log('  total formulas:', Object.keys(formulas).length);

  const cats = await getCategories(base);
  const byCatUid = Object.fromEntries(Object.entries(cats).map(([n, u]) => [u, n]));
  console.log('\n== CATEGORIES (by uid) ==');
  for (const [k, v] of Object.entries(CAT)) console.log('  ', k.padEnd(18), v, byCatUid[v] ? `OK "${byCatUid[v]}"` : '(MISSING!)');

  const existing = await loadExistingProductMap(base);
  console.log('\n== OC PRODUCT IDEMPOTENCY (SRS id -> existing account uid) ==');
  for (const p of OC_PRODUCTS) console.log('  ', String(p.id).padEnd(8), p.name.slice(0,40).padEnd(40), existing[String(p.id)] ? 'EXISTS '+existing[String(p.id)] : 'new');
  console.log('\n== COMMON/LABOR product uids present? ==');
  const allExistUids = new Set(Object.values(existing));
  for (const c of [...COMMON, ...LABOR]) console.log('  ', c.name.slice(0,42).padEnd(42), allExistUids.has(c.product) ? 'OK' : '(verify — not in product_id map, may still exist)');

  const locs = await api(base, 'products/location?count=100&page=1');
  console.log('\n== LOCATIONS ==');
  (locs.json?.data ?? []).forEach(l => console.log('  ', l.location_uid ?? l.uid, l.location_name ?? l.name));

  const layouts = await api(base, 'layout_templates');
  console.log('\n== LAYOUT TEMPLATES ==');
  (layouts.json?.data ?? []).forEach(l => console.log('  ', l.layout_template_uid ?? l.uid, l.layout_template_name ?? l.name));

  fs.writeFileSync('oc-golden-probe.json', JSON.stringify({ base, formulas, cats, existingOc: Object.fromEntries(OC_PRODUCTS.map(p => [p.id, existing[String(p.id)] || null])), locations: locs.json?.data, layouts: layouts.json?.data }, null, 2));
  console.log('\nwrote oc-golden-probe.json');
}

async function buildProducts() {
  const base = await resolveBase();
  console.log('Scanning existing products for idempotency…');
  const existing = await loadExistingProductMap(base);
  const result = {};
  for (const spec of OC_PRODUCTS) {
    const key = String(spec.id);
    if (existing[key]) {
      console.log(`  SKIP (exists) ${spec.name} -> ${existing[key]}`);
      result[key] = { product_uid: existing[key], name: spec.name, reused: true, tiers: spec.tiers, cat: spec.cat, f: spec.f };
      continue;
    }
    const { data: prow } = await supabase.from('srs_products')
      .select('product_description,suggested_price,purchase_price').eq('product_id', spec.id).single();
    const colors = spec.colorPicker ? await loadColors(spec.id) : [];
    const option = spec.colorPicker
      ? { customer_selection: true, mandate_customer_selection: true, option_label: 'Color',
          option_values: colors.map(c => ({ option_value: c, option_image: '', is_available: true })) }
      : { customer_selection: false, mandate_customer_selection: false, option_label: 'Color', option_values: [] };

    const body = { product: {
      prefix: '', product_name: spec.name, product_id: key, is_available: true,
      product_category: spec.cat, price: prow?.suggested_price ?? 0,
      purchase_price: prow?.purchase_price ?? null, min_quantity: 1, quantity: 1, currency: '',
      product_manual_link: '', product_description: prow?.product_description ? `<p>${prow.product_description.slice(0,2000)}</p>` : '',
      product_image: '', product_type: 'PARTS', pricing_level: 'ROLLUP', brand: 'Owens Corning',
      track_quantity: true, specification: '', has_custom_tax: false, uom: spec.uom, is_billable: true,
      consider_profitability: true, is_commissionable: true, bu_uids: null,
      location_availability: [{ location: WAREHOUSE, min_quantity: 1, quantity: 1, serial_nos: [] }],
      tax: { tax_exempt: false, tax_name: '', tax_rate: '' }, markup: null, product_files: [],
      meta_data: COLOR_META, option, formula: spec.f,
    }, vendor: [] };

    const r = await api(base, 'product', { method: 'POST', body: JSON.stringify(body) });
    const pd = Array.isArray(r.json?.data) ? r.json.data[0] : r.json?.data;
    const uid = pd?.product_uid;
    if (!r.ok || !uid) { console.log(`  FAIL ${spec.name}: ${r.status} ${JSON.stringify(r.json).slice(0,200)}`); continue; }
    console.log(`  CREATED ${spec.name} -> ${uid}  (${colors.length} colors)`);
    result[key] = { product_uid: uid, name: spec.name, colors: colors.length, tiers: spec.tiers, cat: spec.cat, f: spec.f };
    await sleep(300);
  }
  fs.writeFileSync('oc-golden-products.json', JSON.stringify(result, null, 2));
  console.log('\nwrote oc-golden-products.json —', Object.keys(result).length, 'products');
}

function tierSpec(tier, products) {
  const pick = id => { const p = products[String(id)]; if (!p) throw new Error('missing product '+id+' — run products phase'); return { name: p.name, product: p.product_uid, f: p.f }; };
  const isBest = tier === 'Best';
  // True 3-shingle ladder: Oakridge (Good) → Duration (Better) → Woodmoor (Best).
  const field    = tier === 'Good' ? pick(688) : tier === 'Better' ? pick(75933) : pick(675);
  const ridge    = isBest ? pick(685)    : pick(672);      // Berkshire on Best, else ProEdge
  const starter  = isBest ? pick(133782) : pick(686);      // WoodStart on Best, else Starter Strip
  const underlay = tier === 'Good' ? pick(75674) : pick(79663); // RhinoRoof on Good, Titanium on Better/Best
  const lines = [
    field,
    ridge,
    starter,
    pick(684),   // WeatherLock ice & water (all)
    underlay,    // synthetic underlayment
    { name: COMMON[0].name, product: COMMON[0].product, f: COMMON[0].f }, // drip edge
    pick(676),   // VentSure ridge vent (all)
    ...(isBest ? [{ name: COMMON[1].name, product: COMMON[1].product, f: COMMON[1].f }] : []), // valley — Best only
    { name: COMMON[2].name, product: COMMON[2].product, f: COMMON[2].f }, // step flashing
    { name: COMMON[3].name, product: COMMON[3].product, f: COMMON[3].f }, // coil nails
    { name: COMMON[4].name, product: COMMON[4].product, f: COMMON[4].f }, // sealant
  ];
  return lines;
}

async function postLineItem(base, url, li) {
  const body = { line_item: {
    type: 'ITEM', line_item_type: 'ITEM', product_name: li.name, product: li.product,
    product_type: 'PARTS', quantity: 1,
    ...(li.f ? { quantity_type: 'FORMULA', formula: li.f } : { quantity_type: 'FIXED' }),
    ...(li.sectionUid ? { section_uid: li.sectionUid, section_name: li.sectionName } : {}),
  } };
  const r = await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify(body) });
  const ok = r.ok;
  if (!ok && li.f) {
    const fb = { line_item: { ...body.line_item, quantity_type: 'FIXED', formula: undefined } };
    await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify(fb) });
  }
  return ok;
}

async function buildTemplate() {
  const base = await resolveBase();
  const products = JSON.parse(fs.readFileSync('oc-golden-products.json', 'utf8'));
  const TEMPLATE_NAME = 'Owens Corning - Good / Better / Best';
  const TEMPLATE_DESC = 'Owens Corning Oakridge / Duration / Woodmoor — golden G/B/B';

  const cr = await api(base, 'invoice_estimate/proposal_template', { method: 'POST',
    body: JSON.stringify({ proposal_template: { template_name: TEMPLATE_NAME, template_description: TEMPLATE_DESC, template_type: 'CPQ' } }) });
  const templateUid = cr.json?.data?.template_uid;
  if (!templateUid) throw new Error('template create failed: ' + JSON.stringify(cr.json));
  console.log('template', templateUid);

  const or = await api(base, `invoice_estimate/proposal_template/${templateUid}/options?items_type=LINE_ITEMS`, {
    method: 'POST', body: JSON.stringify({ proposal_options: [
      { option_name: 'Good',   option_description: 'Owens Corning Oakridge Package',            option_image: '', promo: '', is_recommended: false },
      { option_name: 'Better', option_description: 'Owens Corning Duration Package',            option_image: '', promo: '', is_recommended: true },
      { option_name: 'Best',   option_description: 'Owens Corning Woodmoor Luxury Package',      option_image: '', promo: '', is_recommended: false },
    ] }) });
  const options = or.json?.data ?? [];
  const optUid = n => options.find(o => o.option_name === n)?.option_uid;
  console.log('options:', options.map(o => `${o.option_name}=${o.option_uid}`).join(', '));

  for (const tier of ['Good', 'Better', 'Best']) {
    const ou = optUid(tier);
    const url = `${base}invoice_estimate/proposal_template/${templateUid}/options/${ou}/line_items?items_type=LINE_ITEMS`;
    const mh = await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify({ line_item: { type: 'HEADER', line_item_type: 'HEADER', product_name: 'Material', section_type: 'EXPANDED', show_section_total: false, show_child_prices: true } }) });
    const mhj = await mh.json(); const mhd = Array.isArray(mhj?.data) ? mhj.data[0] : mhj?.data;
    const matSec = mhd?.section_uid ?? mhd?.line_item_uid;
    let n = 0;
    for (const li of tierSpec(tier, products)) { if (await postLineItem(base, url, { ...li, sectionUid: matSec, sectionName: 'Material' })) n++; await sleep(150); }
    const lh = await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify({ line_item: { type: 'HEADER', line_item_type: 'HEADER', product_name: 'Labor', section_type: 'EXPANDED', show_section_total: false, show_child_prices: true } }) });
    const lhj = await lh.json(); const lhd = Array.isArray(lhj?.data) ? lhj.data[0] : lhj?.data;
    const labSec = lhd?.section_uid ?? lhd?.line_item_uid;
    for (const li of LABOR) { if (await postLineItem(base, url, { ...li, sectionUid: labSec, sectionName: 'Labor' })) n++; await sleep(150); }
    // Warranty header + per-tier warranty row
    const wh = await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify({ line_item: { type: 'HEADER', line_item_type: 'HEADER', product_name: 'Warranty', section_type: 'EXPANDED', show_section_total: false, show_child_prices: true } }) });
    const whj = await wh.json(); const whd = Array.isArray(whj?.data) ? whj.data[0] : whj?.data;
    const warSec = whd?.section_uid ?? whd?.line_item_uid;
    if (await postLineItem(base, url, { ...WARRANTY[tier], sectionUid: warSec, sectionName: 'Warranty' })) n++; await sleep(150);
    console.log(`  ${tier}: ${n} line items added`);
  }

  const pr = await api(base, `invoice_estimate/proposal_template/${templateUid}`, { method: 'PUT',
    body: JSON.stringify({ proposal_template: {
      template_name: TEMPLATE_NAME, template_description: TEMPLATE_DESC, template_type: 'CPQ', template_uid: templateUid,
      cpq_config: { trigger: [{ job_category_uid: TRIGGER.catUid, job_status_uid: TRIGGER.statusUid }] },
      layout_template_uid: TRIGGER.layoutUid, is_draft: false,
    } }) });
  console.log('publish:', pr.ok ? 'OK' : ('FAIL ' + pr.status + ' ' + JSON.stringify(pr.json).slice(0, 200)));

  fs.writeFileSync('oc-golden-template-result.json', JSON.stringify({ templateUid, options, ...TRIGGER, published: pr.ok }, null, 2));
  console.log('wrote oc-golden-template-result.json');
}

const phase = process.argv[2];
(async () => {
  if (phase === 'probe') return probe();
  if (phase === 'products') return buildProducts();
  if (phase === 'template') return buildTemplate();
  console.log('usage: node build-oc-golden.js probe|products|template');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
