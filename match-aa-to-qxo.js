/**
 * Match A&A's free-text parts list against the QXO catalog and emit a SKU map.
 *
 *   Input  : a&a_product_import.xlsx  (sheet "Zuper Product Report", 128 parts)
 *   Source : qxo_products / qxo_variants / qxo_branches / qxo_branch_sku (Supabase)
 *   Output : A&A_QXO_Match.xlsx       (one row per A&A part)
 *
 * A&A rows are bare product names with no brand/SKU/key. We score each against
 * every QXO product using token overlap + brand + dimension signals, keep the
 * best (and 2 alternates), resolve the matched product's variant SKUs, and
 * annotate whether any variant is stocked at a Washington branch.
 *
 * Read-only against the DB. Decisions (per plan):
 *   - WA branches: annotate, don't filter.
 *   - SKUs: return variant_sku + manufacturer_number + product_number.
 *   - Coverage: best guess for every part + confidence; flag labor/service rows.
 *
 *   node match-aa-to-qxo.js
 */

require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');
const { fetchAll } = require('./lib/utils');
const { decodeHtmlEntities } = require('./lib/html-entities');
const { normalizeQxoBrand } = require('./lib/qxo-brand-norm');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const IN_FILE  = path.join(__dirname, 'a&a_product_import.xlsx');
const OUT_FILE = path.join(__dirname, 'A&A_QXO_Match.xlsx');

// ── Text normalization ────────────────────────────────────────────────────────
// Noise tokens — packaging/UOM/filler that carry no matching signal. NB: "ct" is
// deliberately NOT here (it's CertainTeed in A&A names); brand detection runs first.
const NOISE = new Set([
  'gallon','gallons','gal','pail','pails','can','cans','box','boxes','bx','bundle',
  'bundles','bdl','roll','rolls','rl','sq','square','ft','feet','foot','lf','pc','pcs',
  'piece','pieces','each','ea','carton','cartons','ctn','pack','pkg','bag','bags','tube',
  'tubes','tb','case','cases','unit','units','count','the','with','and','for','of','per',
  'a','an','to','in','on','set','kit','new','used','per','x','size','color','colors',
]);

// Labor / service / non-product signals (checked on name + description).
const NON_PRODUCT_RE = /\b(labor|tear[\s-]?off|tearoff|removal|dumpster|permit|warranty|clean[\s-]?up|haul|disposal|dispose|mobiliz|trip charge|restock|delivery fee|freight|misc charge|additional .*cost|.*labor cost)\b/i;

// Brand aliases (A&A shorthand → a token that appears in QXO brand_norm, lowercased).
const BRAND_ALIAS = new Map([
  ['ct', 'certainteed'],
  ['oc', 'owens corning'],
  ['gaf', 'gaf'],
  ['apoc', 'apoc'],
  ['certainteed', 'certainteed'],
  ['owens', 'owens corning'],
]);

function cleanText(s) {
  if (s == null) return '';
  let t = decodeHtmlEntities(String(s));
  // Kill the U+FFFD replacement char + common mojibake left by the export.
  t = t.replace(/�/g, ' ').replace(/â€[]?/g, ' ');
  // Normalize smart quotes / dashes to ascii.
  t = t.replace(/[‘’“”]/g, ' ').replace(/[–—]/g, ' ');
  return t;
}

// Tokenize a cleaned string into lowercased alphanumeric tokens, keeping dimension
// tokens like "2x3", "4x10", "1", "1/2" intact (slashes/x preserved within tokens).
function tokenize(s) {
  const cleaned = cleanText(s).toLowerCase();
  const raw = cleaned
    .replace(/["()®™©°•·…]/g, ' ')
    .replace(/[^a-z0-9/.\-x]+/g, ' ')      // keep digits, x, /, ., -
    .split(/\s+/)
    .filter(Boolean);
  const tokens = [];
  for (let tok of raw) {
    tok = tok.replace(/^[-.]+|[-.]+$/g, '');     // strip leading/trailing punct
    if (!tok) continue;
    // crude singularization
    if (tok.length > 4 && tok.endsWith('s') && !tok.endsWith('ss')) tok = tok.slice(0, -1);
    tokens.push(tok);
  }
  return tokens;
}

// A token is "numeric/dimension signal" if it contains a digit.
const isNumToken = t => /\d/.test(t);

// Build the matchable representation of a name: content tokens (noise removed),
// the full set, and the numeric/dimension tokens.
function buildRep(name) {
  const all = tokenize(name);
  const content = all.filter(t => !NOISE.has(t));
  return {
    all,
    content,
    set: new Set(content.length ? content : all),
    nums: new Set(all.filter(isNumToken)),
  };
}

// Detect the brand referenced by an A&A name (lowercased canonical-ish token).
function detectAaBrand(name, brandVocab) {
  const lc = ' ' + cleanText(name).toLowerCase() + ' ';
  for (const tok of tokenize(name)) {
    if (BRAND_ALIAS.has(tok)) return BRAND_ALIAS.get(tok);
  }
  // substring scan against known QXO brand_norm vocabulary (longest first)
  for (const b of brandVocab) {
    if (lc.includes(' ' + b + ' ') || lc.includes(' ' + b)) return b;
  }
  return null;
}

// ── Scoring ─────────────────────────────────────────────────────────────────
function scoreMatch(aRep, aBrand, prod) {
  const aSet = aRep.set;
  const pSet = prod.rep.set;
  if (aSet.size === 0 || pSet.size === 0) return 0;

  let inter = 0;
  for (const t of aSet) if (pSet.has(t)) inter++;
  const overlap = inter / aSet.size;                 // recall of A&A tokens
  let union = aSet.size + pSet.size - inter;
  const jaccard = inter / union;

  // numeric/dimension agreement
  let numInter = 0;
  for (const n of aRep.nums) if (prod.rep.nums.has(n)) numInter++;
  const aNumCount = aRep.nums.size;
  const numScore = aNumCount ? numInter / aNumCount : 0;

  // brand agreement
  let brandBoost = 0;
  if (aBrand && prod.brandLc) {
    if (prod.brandLc === aBrand || prod.brandLc.includes(aBrand) || aBrand.includes(prod.brandLc)) {
      brandBoost = 0.15;
    }
  }

  let score = 0.55 * overlap + 0.20 * jaccard + 0.10 * numScore + brandBoost;
  // Penalize A&A numbers that the product lacks (e.g. "103" primer vs generic primer)
  if (aNumCount && numInter < aNumCount) score -= 0.05 * (aNumCount - numInter);
  return score;
}

function bucket(best, aRep) {
  if (!best || best.score < 0.32) return 'none';
  // exact = every A&A content token present AND product isn't hugely diluted
  let inter = 0;
  for (const t of aRep.set) if (best.prod.rep.set.has(t)) inter++;
  const fullCover = inter === aRep.set.size;
  if (fullCover && best.score >= 0.7) return 'exact';
  if (best.score >= 0.55) return 'strong';
  return 'weak';
}

// Display-clean a QXO string for the output sheet (strips the raw U+FFFD that
// QXO stored in place of ®/™ and collapses whitespace).
const clean = s => cleanText(s).replace(/\s+/g, ' ').trim();

// ── Excel I/O ─────────────────────────────────────────────────────────────────
async function readAaParts() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(IN_FILE);
  const ws = wb.worksheets[0];
  const header = ws.getRow(1).values; // 1-indexed array
  const col = {};
  header.forEach((h, i) => { if (h) col[String(h).trim()] = i; });

  const parts = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const get = name => (col[name] ? row.getCell(col[name]).value : null);
    const num  = get('#');
    const name = cleanText(get('Product Name'));
    if (!name) return;
    parts.push({
      num,
      name,
      description: cleanText(get('Product Description')),
      uom:   get('UOM') || '',
      price: get('Price') || '',
    });
  });
  return parts;
}

const HEADERS = [
  ['aa_num', 'A&A #', 8],
  ['aa_name', 'A&A Product Name', 42],
  ['aa_uom', 'A&A UOM', 10],
  ['aa_price', 'A&A Price', 10],
  ['confidence', 'Match Confidence', 16],
  ['non_product', 'Non-product?', 13],
  ['qxo_key', 'QXO product_key', 16],
  ['qxo_name', 'QXO Product Name', 50],
  ['qxo_brand', 'QXO Brand', 22],
  ['qxo_cat', 'QXO Category', 24],
  ['qxo_pli', 'QXO Proposal Line Item', 30],
  ['variant_sku', 'variant_sku', 14],
  ['mfr_num', 'manufacturer_number', 22],
  ['prod_num', 'product_number', 18],
  ['wa_stock', 'Stocked in WA?', 14],
  ['wa_branches', 'WA Branches (stocking)', 40],
  ['alt1', 'Alt match 1', 46],
  ['alt2', 'Alt match 2', 46],
  ['score', 'Score', 9],
];

async function writeExcel(rows, summary) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'A&A↔QXO Matcher'; wb.created = new Date();
  const ws = wb.addWorksheet('A&A to QXO match', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = HEADERS.map(([key, header, width]) => ({ key, header, width }));

  const hRow = ws.getRow(1);
  hRow.height = 24;
  hRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: HEADERS.length } };

  const CONF_FILL = { exact: 'FFD7F2DD', strong: 'FFEAF6E1', weak: 'FFFDF3D6', none: 'FFFAD9D5' };
  rows.forEach(r => {
    const row = ws.addRow(r);
    const bg = CONF_FILL[r.confidence] || 'FFFFFFFF';
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { size: 9 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { vertical: 'top', wrapText: false };
    });
  });

  await wb.xlsx.writeFile(OUT_FILE);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== A&A → QXO catalog matcher ===\n');

  // 1. A&A parts
  const parts = await readAaParts();
  console.log(`Loaded ${parts.length} A&A parts from ${path.basename(IN_FILE)}`);

  // 2. QXO products
  process.stdout.write('Loading QXO products …\r');
  const products = await fetchAll(
    supabase, 'qxo_products',
    'product_key,product_name,brand_norm,category_norm,proposal_line_item',
    { orderBy: 'product_key' }
  );
  console.log(`Loaded ${products.length.toLocaleString()} QXO products.      `);

  // Precompute reps + brand vocabulary
  const brandVocab = new Set();
  for (const p of products) {
    p.rep = buildRep(p.product_name);
    p.brandLc = p.brand_norm ? String(p.brand_norm).toLowerCase().trim() : null;
    if (p.brandLc) brandVocab.add(p.brandLc);
  }
  // longest brand strings first for substring scan
  const brandVocabArr = [...brandVocab].filter(b => b.length >= 3).sort((a, b) => b.length - a.length);

  // 3. Score every part
  console.log('Scoring …');
  for (const part of parts) {
    part.rep = buildRep(part.name);
    part.aBrand = detectAaBrand(part.name, brandVocabArr);
    part.isNonProduct = NON_PRODUCT_RE.test(part.name) || NON_PRODUCT_RE.test(part.description);

    let best = null, second = null, third = null;
    for (const prod of products) {
      const s = scoreMatch(part.rep, part.aBrand, prod);
      if (!best || s > best.score) { third = second; second = best; best = { prod, score: s }; }
      else if (!second || s > second.score) { third = second; second = { prod, score: s }; }
      else if (!third || s > third.score) { third = { prod, score: s }; }
    }
    part.best = best; part.second = second; part.third = third;
    part.confidence = part.isNonProduct ? 'none' : bucket(best, part.rep);
  }

  // 4. Resolve variants + WA stock for the chosen (matchable) products
  const matchKeys = [...new Set(
    parts.filter(p => p.confidence !== 'none' && p.best).map(p => p.best.prod.product_key)
  )];
  console.log(`Resolving variants for ${matchKeys.length} matched products …`);

  const variants = [];
  for (let i = 0; i < matchKeys.length; i += 150) {
    const chunk = matchKeys.slice(i, i + 150);
    const v = await fetchAll(
      supabase, 'qxo_variants',
      'variant_sku,product_key,manufacturer_number,material_number,product_number,color,uom',
      { filters: [{ op: 'in', args: ['product_key', chunk] }], orderBy: 'variant_sku' }
    );
    variants.push(...v);
  }
  const varsByKey = {};
  for (const v of variants) (varsByKey[v.product_key] ||= []).push(v);

  // WA branches
  const waBranches = await fetchAll(supabase, 'qxo_branches', 'branch_num,name,city,state',
    { filters: [{ op: 'eq', args: ['state', 'WA'] }], orderBy: 'branch_num' });
  const waNums = waBranches.map(b => b.branch_num);
  const waName = Object.fromEntries(waBranches.map(b => [b.branch_num, b.name || b.city || `#${b.branch_num}`]));
  console.log(`WA branches: ${waNums.length}`);

  // Which of the matched variant SKUs are stocked at a WA branch?
  const allSkus = variants.map(v => v.variant_sku);
  const skuToWaBranches = {}; // sku -> Set(branch_num)
  for (let i = 0; i < allSkus.length; i += 150) {
    const chunk = allSkus.slice(i, i + 150);
    const rows = await fetchAll(supabase, 'qxo_branch_sku', 'variant_sku,branch_num',
      { filters: [
          { op: 'in', args: ['variant_sku', chunk] },
          { op: 'in', args: ['branch_num', waNums] },
        ] });
    for (const r of rows) (skuToWaBranches[r.variant_sku] ||= new Set()).add(r.branch_num);
  }

  // 5. Build output rows
  const fmtAlt = m => (m && m.prod) ? `${clean(m.prod.product_name)} [${m.prod.brand_norm || '—'}] (${m.score.toFixed(2)})` : '';
  const outRows = parts.map(part => {
    const base = {
      aa_num: part.num, aa_name: part.name, aa_uom: part.uom, aa_price: part.price,
      confidence: part.confidence, non_product: part.isNonProduct ? 'YES' : '',
      qxo_key: '', qxo_name: '', qxo_brand: '', qxo_cat: '', qxo_pli: '',
      variant_sku: '', mfr_num: '', prod_num: '',
      wa_stock: '', wa_branches: '',
      alt1: fmtAlt(part.second), alt2: fmtAlt(part.third),
      score: part.best ? Number(part.best.score.toFixed(3)) : '',
    };
    if (part.confidence === 'none' || !part.best) return base;

    const prod = part.best.prod;
    const vs = varsByKey[prod.product_key] || [];
    // representative variant: prefer one stocked in WA
    const repVar = vs.find(v => skuToWaBranches[v.variant_sku]) || vs[0] || null;
    const waSet = new Set();
    for (const v of vs) (skuToWaBranches[v.variant_sku] || []).forEach(b => waSet.add(b));

    return {
      ...base,
      qxo_key: prod.product_key,
      qxo_name: clean(prod.product_name),
      qxo_brand: prod.brand_norm || '',
      qxo_cat: prod.category_norm || '',
      qxo_pli: prod.proposal_line_item || '',
      variant_sku: repVar ? repVar.variant_sku : '',
      mfr_num: repVar ? (repVar.manufacturer_number || '') : '',
      prod_num: repVar ? (repVar.product_number || '') : '',
      wa_stock: waSet.size ? 'YES' : 'No',
      wa_branches: [...waSet].map(b => waName[b]).join(', '),
    };
  });

  // Sort: confidence rank, then A&A #
  const rank = { exact: 0, strong: 1, weak: 2, none: 3 };
  outRows.sort((a, b) => (rank[a.confidence] - rank[b.confidence]) || (Number(a.aa_num) - Number(b.aa_num)));

  await writeExcel(outRows);

  // 6. Summary
  const tally = { exact: 0, strong: 0, weak: 0, none: 0 };
  let nonProd = 0, waStocked = 0;
  for (const r of outRows) {
    tally[r.confidence]++;
    if (r.non_product === 'YES') nonProd++;
    if (r.wa_stock === 'YES') waStocked++;
  }
  console.log('\n--- Summary ---');
  console.log(`  exact  : ${tally.exact}`);
  console.log(`  strong : ${tally.strong}`);
  console.log(`  weak   : ${tally.weak}`);
  console.log(`  none   : ${tally.none}`);
  console.log(`  non-product rows flagged : ${nonProd}`);
  console.log(`  matched & WA-stocked     : ${waStocked}`);
  console.log(`\n✓ Wrote ${path.basename(OUT_FILE)}  (${outRows.length} rows)`);
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
