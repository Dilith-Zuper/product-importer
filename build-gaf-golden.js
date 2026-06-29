#!/usr/bin/env node
/**
 * Build the GAF Good/Better/Best CPQ template in the Single Job Roofing Golden Account.
 * Blueprint: GAF_GOLDEN_TEMPLATE.md. Mirrors the certainteed-golden build.
 *
 * Phases (pass as argv[2]):
 *   probe     — read-only: resolve base URL, auth, dump formulas/categories/locations/layout/tokens
 *   products  — create the GAF SRS products (POST product), write gaf-golden-products.json
 *   template  — create template + options + line items + publish, write gaf-golden-template-result.json
 *
 * Reuses the account's existing CPQ formulas (incl. the corrected ct_* round-up customs
 * from the CertainTeed build) and account UIDs (catUid/statusUid/layoutUid) proven there.
 */
require('dotenv').config(); // Supabase creds + ZUPER_GOLDEN_API_KEY (product importer/.env, gitignored)
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

async function probe() {
  const base = await resolveBase();
  console.log('BASE:', base);
  const who = await api(base, 'user/company');
  console.log('AUTH:', who.ok ? ('OK — ' + (who.json?.data?.company_name ?? '?')) : ('FAIL ' + who.status));
  if (!who.ok) return;

  const formulas = await getAllFormulas(base);
  const wantKeys = ['shingles_squares','ct_shingles_squares','starter_shingles_bundles','ct_starter_shingles_bundles',
    'hip_ridge_cap_bundles','ice_and_water_shield_rolls','ct_ice_and_water_shield_rolls',
    'synthetic_underlayment_rolls','ct_synthetic_underlayment_rolls','drip_edge_pieces','ridge_vents_pieces',
    'valley_metal_pieces','ct_valley_metal_pieces','coil_nails_boxes'];
  console.log('\n== FORMULAS (wanted keys) ==');
  for (const k of wantKeys) console.log('  ', k.padEnd(34), formulas[k] ? `${formulas[k].uid}  custom=${formulas[k].custom}` : '(MISSING)');
  console.log('  total formulas:', Object.keys(formulas).length);

  const cats = await getCategories(base);
  const wantCats = ['Shingles','Underlayment','Ice & Water','Ice and Water','Starter','Hip & Ridge','Hip and Ridge',
    'Vents','Ventilation','Drip Edge','Other Flashing Metal','Flashing','Roofing Materials','Caulk','Coil Nails'];
  console.log('\n== CATEGORIES (wanted) ==');
  for (const c of wantCats) console.log('  ', c.padEnd(22), cats[c] ?? '(missing)');
  console.log('  all category names:', Object.keys(cats).sort().join(' | '));

  const locs = await api(base, 'products/location?count=100&page=1');
  console.log('\n== LOCATIONS ==');
  (locs.json?.data ?? []).forEach(l => console.log('  ', l.location_uid ?? l.uid, l.location_name ?? l.name));

  const layouts = await api(base, 'layout_templates');
  console.log('\n== LAYOUT TEMPLATES ==');
  (layouts.json?.data ?? []).forEach(l => console.log('  ', l.layout_template_uid ?? l.uid, l.layout_template_name ?? l.name));

  fs.writeFileSync('gaf-golden-probe.json', JSON.stringify({ base, formulas, cats,
    locations: locs.json?.data, layouts: layouts.json?.data }, null, 2));
  console.log('\nwrote gaf-golden-probe.json');
}

async function dumpTemplate(uid) {
  const base = await resolveBase();
  const r = await api(base, `invoice_estimate/proposal_template/${uid}?items_type=LINE_ITEMS`);
  const d = r.json?.data;
  if (!d) { console.log('no data', r.status, JSON.stringify(r.json).slice(0, 300)); return; }
  fs.writeFileSync('gaf-golden-cttemplate.json', JSON.stringify(d, null, 2));
  console.log('TEMPLATE:', d.template_name, '| options:', (d.proposal_options || []).length);
  (d.proposal_options || []).forEach(o => {
    console.log(`\n== ${o.option_name} ==`);
    (o.line_items || []).forEach(li => {
      if (li.line_item_type === 'HEADER') console.log(`  -- [${li.section_type}] ${li.product_name}`);
      else {
        const p = li.product || {};
        console.log(`     * ${(li.product_name||p.product_name||'?').trim()}  prod=${p.product_uid||li.product||'?'}  qty=${li.quantity_type||''}  f=${(li.formula&&(li.formula.formula_uid||li.formula))||'-'}`);
      }
    });
  });
}

// ── Build constants (resolved from probe + CT-template dump) ──────────────────
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
const F = { // formula uids (corrected ct_* customs where they exist, else stock round-up)
  shingles: 'fc3af594-4900-49f6-bf33-b97576aee01c',   // ct_shingles_squares
  starter: 'be281b5e-526a-423c-82e1-d3261d9ddb23',    // ct_starter_shingles_bundles
  hipridge: '5b2f8876-4cf4-4eb0-ad54-10c4abc9d601',   // hip_ridge_cap_bundles (custom, round-up)
  icewater: 'a7690fc2-19fa-4188-bafe-27caecf1fcc2',   // ct_ice_and_water_shield_rolls
  synthetic: '9036b640-0bb9-42b6-b275-95c912a196c1',  // ct_synthetic_underlayment_rolls
  ridgevent: '1a854eb8-90dc-40bf-8539-5060449f811e',  // ridge_vents_pieces (custom)
};
// GAF products to create (SRS id → spec). colorPicker=true loads SRS color variants.
const GAF_PRODUCTS = [
  { id: 75386, name: 'GAF Timberline HDZ Shingles',                 cat: CAT.Shingles,         uom: 'BDL', f: F.shingles,  colorPicker: true,  tiers: ['Good','Better'] },
  { id: 97196, name: 'GAF Timberline UHDZ StainGuard Plus Shingles', cat: CAT.Shingles,        uom: 'BDL', f: F.shingles,  colorPicker: true,  tiers: ['Best'] },
  { id: 75366, name: 'GAF WeatherWatch Ice & Water Leak Barrier',   cat: CAT.IceWater,         uom: 'RL',  f: F.icewater,  colorPicker: false, tiers: ['all'] },
  { id: 75399, name: 'GAF FeltBuster Synthetic Underlayment',       cat: CAT.Underlayment,     uom: 'RL',  f: F.synthetic, colorPicker: false, tiers: ['Good','Better'] },
  { id: 75384, name: 'GAF Tiger Paw Premium Roof Deck Protection',  cat: CAT.Underlayment,     uom: 'RL',  f: F.synthetic, colorPicker: false, tiers: ['Best'] },
  { id: 75388, name: 'GAF Pro-Start Starter',                       cat: CAT.RoofingMaterials, uom: 'BDL', f: F.starter,   colorPicker: false, tiers: ['all'] },
  { id: 75364, name: 'GAF Seal-A-Ridge Ridge Cap Shingles',         cat: CAT.HipRidge,         uom: 'BDL', f: F.hipridge,  colorPicker: false, tiers: ['Good'] },
  { id: 88182, name: 'GAF TimberTex Premium Hip & Ridge',           cat: CAT.HipRidge,         uom: 'BDL', f: F.hipridge,  colorPicker: false, tiers: ['Better','Best'] },
  { id: 75354, name: 'GAF Cobra Rigid Vent 3',                      cat: CAT.Vents,            uom: 'PC',  f: F.ridgevent, colorPicker: false, tiers: ['Good','Better'] },
  { id: 75376, name: 'GAF Cobra SnowCountry Exhaust Ridge Vent',    cat: CAT.Vents,            uom: 'PC',  f: F.ridgevent, colorPicker: false, tiers: ['Best'] },
];
// Existing account products reused verbatim in every tier (from CT template dump).
const COMMON = [
  { name: 'Galvanized Drip Edge',   product: '756e9dd1-8db6-4d3a-b005-f22699a85e3d', f: 'c525c51f-7f01-495a-a01d-53cfc65c2538' },
  { name: 'Steel Roll Valley Metal',product: '24a2d610-d134-4e55-afea-9439d0310f1d', f: '1e2dc692-fe93-4b60-856b-2012a7a403a1' },
  { name: 'Galvanized Step Flashing',product:'fdfb18bc-0774-414e-aaad-d66c89ad41ce', f: null },
  { name: 'Coil Nails',             product: '9bbcfde9-cbe3-4ef0-8315-e761843380e7', f: '162203ae-a869-43fa-8a23-8a2048e2a17f' },
  { name: 'Chem Link DuraSil High Performance Silicone Sealant', product: '011eb6ed-6a49-4b49-9150-8dc3a6bbb346', f: null },
];
const LABOR = [
  { name: 'Roof Tear-Off Labor',      product: '07a1adf8-4915-4a76-a683-2006d08b4c65', f: F.shingles },
  { name: 'Shingle Install - Standard',product:'842309a0-d81c-46a6-b16c-cf82c7726390', f: F.shingles },
];

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

async function buildProducts() {
  const base = await resolveBase();
  console.log('Scanning existing products for idempotency…');
  const existing = await loadExistingProductMap(base);
  const result = {};
  for (const spec of GAF_PRODUCTS) {
    const key = String(spec.id);
    if (existing[key]) {
      console.log(`  SKIP (exists) ${spec.name} -> ${existing[key]}`);
      result[key] = { product_uid: existing[key], name: spec.name, reused: true };
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
      product_image: '', product_type: 'PARTS', pricing_level: 'ROLLUP', brand: 'GAF',
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
  fs.writeFileSync('gaf-golden-products.json', JSON.stringify(result, null, 2));
  console.log('\nwrote gaf-golden-products.json —', Object.keys(result).length, 'products');
}

function tierShingleSpec(tier, products) {
  // returns ordered material line items for a tier: [ {name, product_uid, f} ... ]
  const pick = id => { const p = products[String(id)]; return { name: p.name, product: p.product_uid, f: p.f }; };
  const isBest = tier === 'Best';
  const field = isBest ? pick(97196) : pick(75386);
  const ridge = tier === 'Good' ? pick(75364) : pick(88182);
  const underlay = isBest ? pick(75384) : pick(75399);
  const ridgevent = isBest ? pick(75376) : pick(75354);
  const lines = [
    field,
    ridge,
    pick(75388),       // Pro-Start starter
    pick(75366),       // WeatherWatch ice & water
    underlay,          // synthetic underlayment
    { name: COMMON[0].name, product: COMMON[0].product, f: COMMON[0].f }, // drip edge
    ridgevent,
    ...(isBest ? [{ name: COMMON[1].name, product: COMMON[1].product, f: COMMON[1].f }] : []), // valley — Best only
    { name: COMMON[2].name, product: COMMON[2].product, f: COMMON[2].f }, // step flashing
    { name: COMMON[3].name, product: COMMON[3].product, f: COMMON[3].f }, // coil nails
    { name: COMMON[4].name, product: COMMON[4].product, f: COMMON[4].f }, // chem link
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
  const ok = r.ok; const j = await r.json().catch(() => ({}));
  if (!ok && li.f) { // retry FIXED
    const fb = { line_item: { ...body.line_item, quantity_type: 'FIXED', formula: undefined } };
    await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify(fb) });
  }
  return ok;
}

async function buildTemplate() {
  const base = await resolveBase();
  const products = JSON.parse(fs.readFileSync('gaf-golden-products.json', 'utf8'));
  const TEMPLATE_NAME = 'GAF - Good / Better / Best';
  const TEMPLATE_DESC = 'GAF Essentials / Peace of Mind / Total Home Protection';

  // 1. create template
  const cr = await api(base, 'invoice_estimate/proposal_template', { method: 'POST',
    body: JSON.stringify({ proposal_template: { template_name: TEMPLATE_NAME, template_description: TEMPLATE_DESC, template_type: 'CPQ' } }) });
  const templateUid = cr.json?.data?.template_uid;
  if (!templateUid) throw new Error('template create failed: ' + JSON.stringify(cr.json));
  console.log('template', templateUid);

  // 2. options
  const or = await api(base, `invoice_estimate/proposal_template/${templateUid}/options?items_type=LINE_ITEMS`, {
    method: 'POST', body: JSON.stringify({ proposal_options: [
      { option_name: 'Good',   option_description: 'GAF Essentials Package',          option_image: '', promo: '', is_recommended: false },
      { option_name: 'Better', option_description: 'GAF Peace of Mind Package',        option_image: '', promo: '', is_recommended: true },
      { option_name: 'Best',   option_description: 'GAF Total Home Protection Package', option_image: '', promo: '', is_recommended: false },
    ] }) });
  const options = or.json?.data ?? [];
  const optUid = n => options.find(o => o.option_name === n)?.option_uid;
  console.log('options:', options.map(o => `${o.option_name}=${o.option_uid}`).join(', '));

  // 3. line items per tier (Material header + items, then Labor header + items)
  for (const tier of ['Good', 'Better', 'Best']) {
    const ou = optUid(tier);
    const url = `${base}invoice_estimate/proposal_template/${templateUid}/options/${ou}/line_items?items_type=LINE_ITEMS`;
    // Material header
    const mh = await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify({ line_item: { type: 'HEADER', line_item_type: 'HEADER', product_name: 'Material', section_type: 'EXPANDED', show_section_total: false, show_child_prices: true } }) });
    const mhj = await mh.json(); const mhd = Array.isArray(mhj?.data) ? mhj.data[0] : mhj?.data;
    const matSec = mhd?.section_uid ?? mhd?.line_item_uid;
    let n = 0;
    for (const li of tierShingleSpec(tier, products)) { if (await postLineItem(base, url, { ...li, sectionUid: matSec, sectionName: 'Material' })) n++; await sleep(150); }
    // Labor header
    const lh = await fetch(url, { method: 'POST', headers: hdrs(), body: JSON.stringify({ line_item: { type: 'HEADER', line_item_type: 'HEADER', product_name: 'Labor', section_type: 'EXPANDED', show_section_total: false, show_child_prices: true } }) });
    const lhj = await lh.json(); const lhd = Array.isArray(lhj?.data) ? lhj.data[0] : lhj?.data;
    const labSec = lhd?.section_uid ?? lhd?.line_item_uid;
    for (const li of LABOR) { if (await postLineItem(base, url, { ...li, sectionUid: labSec, sectionName: 'Labor' })) n++; await sleep(150); }
    console.log(`  ${tier}: ${n} line items added`);
  }

  // 4. publish LAST (trigger + layout + is_draft:false)
  const pr = await api(base, `invoice_estimate/proposal_template/${templateUid}`, { method: 'PUT',
    body: JSON.stringify({ proposal_template: {
      template_name: TEMPLATE_NAME, template_description: TEMPLATE_DESC, template_type: 'CPQ', template_uid: templateUid,
      cpq_config: { trigger: [{ job_category_uid: TRIGGER.catUid, job_status_uid: TRIGGER.statusUid }] },
      layout_template_uid: TRIGGER.layoutUid, is_draft: false,
    } }) });
  console.log('publish:', pr.ok ? 'OK' : ('FAIL ' + pr.status + ' ' + JSON.stringify(pr.json).slice(0, 200)));

  fs.writeFileSync('gaf-golden-template-result.json', JSON.stringify({ templateUid, options, ...TRIGGER, published: pr.ok }, null, 2));
  console.log('wrote gaf-golden-template-result.json');
}

// Wire the "Galvanized Step Flashing" line item to step_flashing_pieces on a template,
// across every option, then re-publish (PUT edits revert is_draft→true).
const STEP_PRODUCT_UID = 'fdfb18bc-0774-414e-aaad-d66c89ad41ce';
async function fixStepFlashing(templateUid) {
  const base = await resolveBase();
  const formulas = await getAllFormulas(base);
  const stepF = formulas['step_flashing_pieces']?.uid;
  if (!stepF) throw new Error('step_flashing_pieces formula not found');

  const r = await api(base, `invoice_estimate/proposal_template/${templateUid}?items_type=LINE_ITEMS`);
  const d = r.json?.data;
  console.log(`\nTemplate "${d.template_name}" (${templateUid}) — step_flashing_pieces = ${stepF}`);
  for (const o of (d.proposal_options || [])) {
    const li = (o.line_items || []).find(x => x.line_item_type === 'ITEM' &&
      ((x.product && (x.product.product_uid === STEP_PRODUCT_UID || x.product === STEP_PRODUCT_UID)) ||
       /step flashing/i.test(x.product_name || '')));
    if (!li) { console.log(`  ${o.option_name}: no step-flashing line found`); continue; }
    const liUid = li.line_item_uid || li.uid;
    const body = { line_item: {
      type: 'ITEM', line_item_type: 'ITEM',
      product_name: li.product_name,
      product: (li.product && (li.product.product_uid || li.product)) || STEP_PRODUCT_UID,
      product_type: 'PARTS', quantity: 1,
      quantity_type: 'FORMULA', formula: stepF,
      ...(li.section_uid ? { section_uid: li.section_uid, section_name: li.section_name || 'Material' } : {}),
    } };
    const put = await fetch(`${base}invoice_estimate/proposal_template/${templateUid}/options/${o.option_uid}/line_items/${liUid}?items_type=LINE_ITEMS`,
      { method: 'PUT', headers: hdrs(), body: JSON.stringify(body) });
    console.log(`  ${o.option_name}: PUT step flashing -> FORMULA  ${put.ok ? 'OK' : 'FAIL ' + put.status}`);
    await sleep(200);
  }

  // re-publish (PUT edits reverted is_draft→true) — preserve the template's own name/desc/trigger/layout
  const pub = await api(base, `invoice_estimate/proposal_template/${templateUid}`, { method: 'PUT',
    body: JSON.stringify({ proposal_template: {
      template_name: d.template_name, template_description: d.template_description, template_type: 'CPQ', template_uid: templateUid,
      cpq_config: d.cpq_config || { trigger: [{ job_category_uid: TRIGGER.catUid, job_status_uid: TRIGGER.statusUid }] },
      ...(d.layout_template_uid ? { layout_template_uid: d.layout_template_uid } : { layout_template_uid: TRIGGER.layoutUid }),
      is_draft: false,
    } }) });
  console.log(`  re-publish: ${pub.ok ? 'OK' : 'FAIL ' + pub.status}`);
}

const phase = process.argv[2];
(async () => {
  if (phase === 'probe') return probe();
  if (phase === 'cttemplate') return dumpTemplate(process.argv[3] || '2962f307-5e5a-4a40-a4ef-d229cc250e95');
  if (phase === 'products') return buildProducts();
  if (phase === 'template') return buildTemplate();
  if (phase === 'fixstep') {
    await fixStepFlashing('858f618d-b9a6-41fb-8347-90f2f4b5e44c'); // GAF
    await fixStepFlashing('2962f307-5e5a-4a40-a4ef-d229cc250e95'); // CertainTeed
    return;
  }
  console.log('usage: node build-gaf-golden.js probe|products|template');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
