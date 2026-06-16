/**
 * Match any account's free-text product list (a Zuper "Product Report" export)
 * against the SRS catalog and report coverage + whether SRS carries options
 * (colors / sizes / variants) for each part.
 *
 *   Input  : <account>.xlsx   (a Zuper product export; columns auto-detected)
 *   Source : srs_products / srs_variants (Supabase, read-only)
 *   Output : <OUT>_SRS_Match.xlsx           — full: Material matches + Excluded sheets
 *            <OUT>_SRS_Match - simple.xlsx   — 6-col clean view (matched rows)
 *            <OUT>_SRS_Review.xlsx           — weak+none rows, top-3 candidates each
 *
 * Each account part is scored against every SRS product (token overlap + brand +
 * dimension signals), gated by coarse product TYPE (a membrane can't match a primer,
 * decking can't match a fastener) and form-token DISTINGUISHERS, bucketed
 * exact/strong/weak/none. Labor/service/fee/change-order rows are split off and
 * never matched. The matched product's unrestricted variants answer "do we have
 * options for it?".
 *
 * Usage:
 *   node match-account-to-srs.js <input.xlsx> [--label "A&A"] [--out "A&A"]
 *        [--sheet "Sheet name"]
 *        [--name-col H] [--desc-col H] [--brand-col H] [--uom-col H]
 *        [--price-col H] [--num-col H]
 *
 *   --label     prefix shown in the output column headers (default: input basename)
 *   --out       output filename prefix (default: --label, else input basename)
 *   --sheet     worksheet to read (default: first sheet)
 *   --*-col     override a column's header if auto-detection picks the wrong one
 *
 * Examples:
 *   node match-account-to-srs.js aanda_parts_export.xlsx --label "A&A" --out "A&A"
 *   node match-account-to-srs.js "Roof Medic.xlsx" --label "Roof Medic" --out "RoofMedic"
 *
 * Also importable: require('./match-account-to-srs').run({ inFile, label, outPrefix, ... }).
 */

require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');
const { fetchAll } = require('./lib/utils');
const { decodeHtmlEntities } = require('./lib/html-entities');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── Column auto-detection ──────────────────────────────────────────────────────
// Header aliases for the fields we read out of a Zuper product export. Exact (case-
// insensitive) match is tried first, then a substring fallback. Only `name` is
// required; the rest degrade to blank if the export doesn't have them.
const COL_ALIASES = {
  num:   ['#', 'no', 's.no', 'sno', 'sl no', 'serial', 'sr no'],
  name:  ['product name', 'item name', 'part name', 'name', 'product', 'item'],
  desc:  ['product description', 'description', 'desc', 'long description', 'details'],
  brand: ['brand', 'manufacturer', 'make'],
  uom:   ['uom', 'unit of measure', 'unit', 'units', 'u.o.m'],
  price: ['price', 'sell price', 'selling price', 'unit price', 'sales price', 'rate'],
};

function resolveColumns(headerRow, overrides = {}) {
  const map = {};                         // lowercased header text -> 1-based column index
  headerRow.forEach((h, i) => {
    if (h != null && String(h).trim()) map[String(h).trim().toLowerCase()] = i;
  });
  const byHeader = name => (name == null ? null : (map[String(name).trim().toLowerCase()] ?? null));
  const find = aliases => {
    for (const a of aliases) if (map[a] != null) return map[a];          // exact
    for (const a of aliases) {                                           // substring
      const hit = Object.keys(map).find(k => k.includes(a));
      if (hit) return map[hit];
    }
    return null;
  };
  const cols = {};
  for (const key of Object.keys(COL_ALIASES)) {
    cols[key] = overrides[key] != null ? byHeader(overrides[key]) : find(COL_ALIASES[key]);
  }
  return { cols, headers: Object.keys(map) };
}

// ── Text normalization ────────────────────────────────────────────────────────
// Noise tokens — packaging/UOM/filler that carry no matching signal. NB: "ct" is
// deliberately NOT here (it's CertainTeed shorthand); brand detection runs first.
const NOISE = new Set([
  'gallon','gallons','gal','pail','pails','can','cans','box','boxes','bx','bundle',
  'bundles','bdl','roll','rolls','rl','sq','square','ft','feet','foot','lf','pc','pcs',
  'piece','pieces','each','ea','carton','cartons','ctn','pack','pkg','bag','bags','tube',
  'tubes','tb','case','cases','unit','units','count','the','with','and','for','of','per',
  'a','an','to','in','on','set','kit','new','used','per','x','size','color','colors',
]);

// Labor / service / fee / change-order signals — NOT material parts; excluded from
// matching entirely. Checked on the NAME only (descriptions are marketing copy that
// routinely say a part is "installed …", which would wrongly flag real materials).
const NON_MATERIAL_RE = /\b(labor|install(ation|ed|ing)?|tear[\s-]?off|tearoff|remov(e|al|ing)|haul|disposal|dispose|dump\s*fee|dumpster|permit|warranty|clean[\s-]?up|mobiliz|trip charge|restock|delivery|freight|travel|production fee|equipment rental|deposit|change order|sales tax|repair)\b/i;
const NON_MATERIAL_PREFIX_RE = /^\s*(co\s*-|contract\s+to\s+match\b)/i;

function isNonMaterial(name) {
  const n = String(name || '');
  if (NON_MATERIAL_PREFIX_RE.test(n)) return true;
  return NON_MATERIAL_RE.test(n);
}

// Brand aliases (account shorthand → a token that appears in SRS manufacturer_norm).
const BRAND_ALIAS = new Map([
  ['ct', 'certainteed'],
  ['oc', 'owens corning'],
  ['gaf', 'gaf'],
  ['apoc', 'apoc'],
  ['certainteed', 'certainteed'],
  ['owens', 'owens corning'],
  ['norwesco', 'norwesco'],
  ['versico', 'versico'],
  ['pabco', 'pabco'],
  ['quarrix', 'quarrix'],
]);

// Account shorthand → SRS-canonical phrasing, applied to the part name before
// matching (matching only — the original name is still shown). Lets cryptic or
// house-brand names line up with how SRS actually names the same product.
const SYNONYMS = [
  // Georgia-Pacific "Dens Deck" gypsum cover board — SRS stocks it as Elevate-branded
  // "DensDeck … Roof Board". Inject the brand + SRS tokens so it matches.
  [/\bdens[\s-]?deck\b/gi, 'densdeck elevate roof board'],
  // "Tri-Built" is SRS Distribution's own private label — not a manufacturer in our
  // catalog. Strip it so these resolve to the generic equivalent.
  [/\btri[\s-]?built\b/gi, ' '],
  // CertainTeed writes "RoofRunner" (one word); accounts often write "Roof Runner".
  [/\broof\s*runner\b/gi, 'roofrunner'],
];

function applySynonyms(name) {
  let s = String(name || '');
  for (const [re, rep] of SYNONYMS) s = s.replace(re, rep);
  return s;
}

function cleanText(s) {
  if (s == null) return '';
  let t = decodeHtmlEntities(String(s));
  t = t.replace(/�/g, ' ').replace(/â€[]?/g, ' ');
  t = t.replace(/[‘’“”]/g, ' ').replace(/[–—]/g, ' ');
  return t;
}

function tokenize(s) {
  const cleaned = cleanText(s).toLowerCase();
  const raw = cleaned
    .replace(/["()®™©°•·…]/g, ' ')
    .replace(/[^a-z0-9/.\-x]+/g, ' ')      // keep digits, x, /, ., -
    .split(/\s+/)
    .filter(Boolean);
  const tokens = [];
  for (let tok of raw) {
    tok = tok.replace(/^[-.]+|[-.]+$/g, '');
    if (!tok) continue;
    if (tok.length > 4 && tok.endsWith('s') && !tok.endsWith('ss')) tok = tok.slice(0, -1);
    tokens.push(tok);
  }
  return tokens;
}

const isNumToken = t => /\d/.test(t);

// ── Product-type gating ───────────────────────────────────────────────────────
// Token-overlap alone happily matches a membrane to a primer ("Versico TPO" hits
// both) or decking to a fastener ("1/2" hits both). We tag each name with the
// coarse product "type(s)" it implies; when an account part and an SRS product each
// have a confident type but share none, they're incompatible and get penalized.
const TYPE_SIGS = [
  ['shingle',      /\b(shingle|shingles|landmark|timberline|duration|oakridge|heritage|3[\s-]?tab|architectural|laminate[d]?)\b/i],
  ['starter',      /\b(starter|swift[\s-]?start)\b/i],
  ['ridge',        /\b(hip\s*&?\s*ridge|hip and ridge|ridge cap|cap shingle|shadow cap)\b/i],
  ['vent',         /\b(vent|vents|flapper|exhaust|louver|turbine|\brvo\b|\brv[\s-]?\d)\b/i],
  ['siding',       /\b(siding|vinyl|f[\s-]?channel|j[\s-]?channel|soffit|fascia|trim|lap|shake panel)\b/i],
  ['underlayment', /\b(underlayment|felt|roofrunner|synthetic underlay)\b/i],
  ['ice_water',    /\b(ice\s*&?\s*water|ice and water|i&w|winterguard|weatherguard|water\s*shield)\b/i],
  ['flashing',     /\b(flashing|drip edge|valley|step flash|counter flash|pipe boot|pipe flash|l[\s-]?flashing|apron)\b/i],
  ['membrane',     /\b(tpo|epdm|membrane|modified|mod bit|torch|cap sheet|base sheet|base ply|ply sheet|fleece|coil stock)\b/i],
  ['primer_adh',   /\b(primer|prime|cleaner|adhesive|bonding|sealant|sealer|caulk|mastic|cement|coating|cut[\s-]?edge)\b/i],
  ['fastener',     /\b(fastener|fasteners|staple|staples|nail|nails|screw|screws|barbed|termination bar|insulation plate|fastening plate)\b/i],
  ['tool',         /\b(gun|sprayer|spray gun|probe|roller|winch|strap|tie[\s-]?down|blade|knife)\b/i],
  ['decking',      /\b(osb|cdx|plywood|sheathing|nailboard|nail base|deck board|subfloor)\b/i],
  ['insulation',   /\b(polyiso|poly iso|\biso\b|insulation|coverboard|cover board|densdeck|gypsum|fan[\s-]?fold)\b/i],
];

function typesOf(name) {
  const lc = ' ' + cleanText(name).toLowerCase() + ' ';
  const s = new Set();
  for (const [t, re] of TYPE_SIGS) if (re.test(lc)) s.add(t);
  return s;
}

// Form-defining tokens (post-singularization). When a product has one of these and
// the account part doesn't (or vice-versa), it's likely the wrong form of the
// product — e.g. the membrane's *cleaner*, the fastener's *gun*. Penalized per miss.
const DISTINGUISHERS = new Set([
  'primer', 'cleaner', 'adhesive', 'sealer', 'sealant', 'caulk', 'mastic', 'cement',
  'coating', 'gun', 'sprayer', 'probe', 'roller', 'winch', 'strap', 'staple',
  'nailboard', 'tape', 'gypsum', 'knife', 'blade', 'cartridge', 'patch',
  'plate', 'rhinobond', 'kit', 'wheel', 'carriage', 'channel',
]);

function buildRep(name) {
  const all = tokenize(name);
  const content = all.filter(t => !NOISE.has(t));
  return {
    all,
    content,
    set: new Set(content.length ? content : all),
    nums: new Set(all.filter(isNumToken)),
    tok: new Set(all),
    types: typesOf(name),
  };
}

function detectBrand(name, brandVocab) {
  for (const tok of tokenize(name)) {
    if (BRAND_ALIAS.has(tok)) return BRAND_ALIAS.get(tok);
  }
  const lc = ' ' + cleanText(name).toLowerCase() + ' ';
  for (const b of brandVocab) {
    if (lc.includes(' ' + b + ' ') || lc.includes(' ' + b)) return b;
  }
  return null;
}

const brandMatches = (aBrand, brandLc) =>
  !!(aBrand && brandLc && (brandLc === aBrand || brandLc.includes(aBrand) || aBrand.includes(brandLc)));

// ── Scoring ─────────────────────────────────────────────────────────────────
function scoreMatch(aRep, aBrand, aBrandInSrs, prod) {
  const aSet = aRep.set;
  const pSet = prod.rep.set;
  if (aSet.size === 0 || pSet.size === 0) return 0;

  // Token overlap, tracking shared non-brand content (gates the brand boost so
  // brand alone can't carry a match with no real product-word in common).
  const brandToks = aBrand ? new Set(aBrand.split(/\s+/)) : new Set();
  let inter = 0, nonBrandShared = 0;
  for (const t of aSet) {
    if (pSet.has(t)) { inter++; if (!isNumToken(t) && !brandToks.has(t)) nonBrandShared++; }
  }
  const overlap = inter / aSet.size;
  const union = aSet.size + pSet.size - inter;
  const jaccard = inter / union;

  let numInter = 0;
  for (const n of aRep.nums) if (prod.rep.nums.has(n)) numInter++;
  const aNumCount = aRep.nums.size;
  const numScore = aNumCount ? numInter / aNumCount : 0;

  let score = 0.55 * overlap + 0.20 * jaccard + 0.06 * numScore;

  // Brand: boost same-brand only when there's also a shared real product word.
  if (brandMatches(aBrand, prod.brandLc)) {
    score += nonBrandShared >= 1 ? 0.30 : 0.05;
  } else if (aBrandInSrs && prod.brandLc) {
    score -= 0.25;                       // account brand is in SRS but this product is a different brand
  }

  // Product-type compatibility. Both sides confidently typed but sharing no type =
  // wrong kind of product (membrane vs primer, decking vs fastener) → hard penalty.
  const aT = aRep.types, pT = prod.rep.types;
  if (aT.size && pT.size) {
    let common = false;
    for (const t of aT) if (pT.has(t)) { common = true; break; }
    score += common ? 0.12 : -0.40;
  }

  // Form-defining token mismatch (primer/cleaner/gun/staple… on only one side).
  let distPen = 0;
  for (const d of DISTINGUISHERS) {
    if (aRep.tok.has(d) !== prod.rep.tok.has(d)) distPen += 0.16;
  }
  score -= Math.min(distPen, 0.48);

  if (aNumCount && numInter < aNumCount) score -= 0.05 * (aNumCount - numInter);
  return score;
}

function bucket(best, aRep) {
  if (!best || best.score < 0.32) return 'none';
  let inter = 0;
  for (const t of aRep.set) if (best.prod.rep.set.has(t)) inter++;
  const fullCover = inter === aRep.set.size;
  if (fullCover && best.score >= 0.7) return 'exact';
  if (best.score >= 0.55) return 'strong';
  return 'weak';
}

const clean = s => cleanText(s).replace(/\s+/g, ' ').trim();

// ── Excel I/O ─────────────────────────────────────────────────────────────────
async function readParts(inFile, { sheet, overrides } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(inFile);
  const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets[0];
  if (!ws) throw new Error(`Worksheet ${sheet ? `"${sheet}"` : '(first)'} not found in ${path.basename(inFile)}`);

  const { cols, headers } = resolveColumns(ws.getRow(1).values, overrides);
  if (cols.name == null) {
    throw new Error(
      `Could not find a product-name column in ${path.basename(inFile)}.\n` +
      `  Headers seen: ${headers.join(', ')}\n` +
      `  Pass --name-col "<exact header>" to specify it.`
    );
  }

  const get = (row, key) => (cols[key] != null ? row.getCell(cols[key]).value : null);
  const parts = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const name = cleanText(get(row, 'name'));
    if (!name) return;
    parts.push({
      num:   get(row, 'num'),
      name,
      description: cleanText(get(row, 'desc')),
      brand: cleanText(get(row, 'brand')),
      uom:   get(row, 'uom') || '',
      price: get(row, 'price') || '',
    });
  });
  return { parts, cols, sheetName: ws.name };
}

// Header builders — `label` (e.g. "A&A") prefixes the account-side columns; the
// internal row keys stay 'aa_*' so the row-building code is label-agnostic.
const buildHeaders = label => [
  ['aa_num', `${label} #`, 8],
  ['aa_name', `${label} Product Name`, 42],
  ['aa_brand', 'Brand (detected)', 16],
  ['srs_has_brand', 'SRS carries brand?', 17],
  ['aa_uom', `${label} UOM`, 10],
  ['aa_price', `${label} Price`, 10],
  ['confidence', 'In SRS? (confidence)', 18],
  ['srs_id', 'SRS product_id', 14],
  ['srs_name', 'SRS Product Name', 50],
  ['srs_brand', 'SRS Brand', 22],
  ['srs_cat', 'SRS Category', 24],
  ['srs_pli', 'SRS Proposal Line Item', 30],
  ['n_variants', '# Variants', 11],
  ['has_options', 'Has options?', 13],
  ['colors', 'Colors available', 40],
  ['sizes', 'Sizes available', 30],
  ['product_options', 'Product Options', 36],
  ['sample_skus', 'Sample SKUs', 28],
  ['alt1', 'Alt match 1', 46],
  ['alt2', 'Alt match 2', 46],
  ['score', 'Score', 9],
];

const buildExcludedHeaders = label => [
  ['aa_num', `${label} #`, 8],
  ['aa_name', `${label} Product Name`, 50],
  ['aa_uom', `${label} UOM`, 10],
  ['aa_price', `${label} Price`, 10],
  ['reason', 'Why excluded', 30],
];

const buildSimpleHeaders = label => [
  ['aa_name', `${label} Part Name`, 44],
  ['confidence', 'Confidence', 12],
  ['srs_id', 'SRS Product ID', 14],
  ['srs_name', 'SRS Product Name', 50],
  ['srs_cat', 'SRS Category', 24],
  ['options', 'Options', 70],
];

const buildReviewHeaders = label => [
  ['aa_num', `${label} #`, 8],
  ['aa_name', `${label} Part Name`, 40],
  ['brand', 'Brand', 14],
  ['confidence', 'Confidence', 11],
  ['cand1', 'Best guess (id  name <cat> [brand] score)', 56],
  ['cand2', 'Alt 2', 56],
  ['cand3', 'Alt 3', 56],
  ['chosen', 'Correct SRS ID (fill in)', 20],
  ['notes', 'Notes', 26],
];

// Write a workbook, falling back to a timestamped sibling if the target is open in
// Excel (Windows file lock → EBUSY/EPERM). Returns the path actually written.
async function safeWrite(wb, file) {
  try {
    await wb.xlsx.writeFile(file);
    return file;
  } catch (e) {
    if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
    const alt = file.replace(/\.xlsx$/, `_${Date.now()}.xlsx`);
    await wb.xlsx.writeFile(alt);
    console.log(`\n⚠  ${path.basename(file)} is open/locked — wrote ${path.basename(alt)} instead.`);
    return alt;
  }
}

function styleHeader(ws, n) {
  const hRow = ws.getRow(1);
  hRow.height = 24;
  hRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: n } };
}

async function writeExcel(outFile, label, rows, excludedRows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Account↔SRS Matcher'; wb.created = new Date();

  const headers = buildHeaders(label);
  const ws = wb.addWorksheet('Material matches', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = headers.map(([key, header, width]) => ({ key, header, width }));
  styleHeader(ws, headers.length);

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

  const exHeaders = buildExcludedHeaders(label);
  const ex = wb.addWorksheet('Excluded (labor & fees)', { views: [{ state: 'frozen', ySplit: 1 }] });
  ex.columns = exHeaders.map(([key, header, width]) => ({ key, header, width }));
  styleHeader(ex, exHeaders.length);
  excludedRows.forEach(r => {
    const row = ex.addRow(r);
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { size: 9 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
      cell.alignment = { vertical: 'top', wrapText: false };
    });
  });

  return safeWrite(wb, outFile);
}

// Build the human-readable "Options" cell from a matched row's variant rollup.
function optionsCell(r) {
  const bits = [];
  if (r.colors) bits.push('Colors: ' + r.colors);
  if (r.sizes)  bits.push('Sizes: ' + r.sizes);
  if (!r.colors && !r.sizes && r.product_options) bits.push('Options: ' + r.product_options);
  if (!bits.length) bits.push(Number(r.n_variants) > 1 ? `${r.n_variants} variants` : 'No options (single SKU)');
  return bits.join('  |  ');
}

async function writeSimple(outFile, label, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Account↔SRS Matcher'; wb.created = new Date();
  const headers = buildSimpleHeaders(label);
  const ws = wb.addWorksheet(`${label} → SRS`.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = headers.map(([key, header, width]) => ({ key, header, width }));
  styleHeader(ws, headers.length);

  const CONF_FILL = { exact: 'FFD7F2DD', strong: 'FFEAF6E1', weak: 'FFFDF3D6' };
  rows.forEach(r => {
    const row = ws.addRow({
      aa_name: r.aa_name, confidence: r.confidence, srs_id: r.srs_id, srs_name: r.srs_name,
      srs_cat: r.srs_cat, options: optionsCell(r),
    });
    const bg = CONF_FILL[r.confidence] || 'FFFFFFFF';
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { size: 9 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { vertical: 'top', wrapText: true };
    });
  });
  return safeWrite(wb, outFile);
}

function fmtCand(m) {
  if (!m || !m.prod) return '';
  const p = m.prod;
  return `${p.product_id}  ${clean(p.product_name)} <${p.product_category || '?'}> [${p.manufacturer_norm || '—'}] (${m.score.toFixed(2)})`;
}

async function writeReview(outFile, label, parts) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Account↔SRS Matcher'; wb.created = new Date();
  const headers = buildReviewHeaders(label);
  const ws = wb.addWorksheet('Needs review', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = headers.map(([key, header, width]) => ({ key, header, width }));
  styleHeader(ws, headers.length);

  const FILL = { weak: 'FFFDF3D6', none: 'FFFAD9D5' };
  parts.forEach(p => {
    const row = ws.addRow({
      aa_num: p.num, aa_name: p.name, brand: p.aBrand || '', confidence: p.confidence,
      cand1: fmtCand(p.best), cand2: fmtCand(p.second), cand3: fmtCand(p.third),
      chosen: '', notes: '',
    });
    const bg = FILL[p.confidence] || 'FFFFFFFF';
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font = { size: 9 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { vertical: 'top', wrapText: true };
    });
  });
  return safeWrite(wb, outFile);
}

// ── Driver ────────────────────────────────────────────────────────────────────
async function run(opts = {}) {
  const inFile = path.isAbsolute(opts.inFile) ? opts.inFile : path.join(__dirname, opts.inFile);
  const base = path.basename(inFile).replace(/\.[^.]+$/, '');
  const label = opts.label || base;
  const outPrefix = opts.outPrefix || opts.label || base;
  const outFiles = {
    full:   path.join(__dirname, `${outPrefix}_SRS_Match.xlsx`),
    simple: path.join(__dirname, `${outPrefix}_SRS_Match - simple.xlsx`),
    review: path.join(__dirname, `${outPrefix}_SRS_Review.xlsx`),
  };

  console.log(`\n=== ${label} → SRS catalog matcher ===\n`);

  const { parts, cols, sheetName } = await readParts(inFile, { sheet: opts.sheet, overrides: opts.cols });
  const colReport = Object.entries(cols).map(([k, v]) => `${k}:${v == null ? '—' : `col${v}`}`).join('  ');
  console.log(`Loaded ${parts.length} parts from ${path.basename(inFile)} [sheet "${sheetName}"]`);
  console.log(`Columns → ${colReport}`);

  process.stdout.write('Loading SRS products …\r');
  const products = await fetchAll(
    supabase, 'srs_products',
    'product_id,product_name,manufacturer_norm,product_category,proposal_line_item,product_options',
    { orderBy: 'product_id' }
  );
  console.log(`Loaded ${products.length.toLocaleString()} SRS products.      `);

  const brandVocab = new Set();
  for (const p of products) {
    p.rep = buildRep(p.product_name);
    p.brandLc = p.manufacturer_norm ? String(p.manufacturer_norm).toLowerCase().trim() : null;
    if (p.brandLc) brandVocab.add(p.brandLc);
  }
  const brandVocabArr = [...brandVocab].filter(b => b.length >= 3).sort((a, b) => b.length - a.length);
  const srsHasBrand = aBrand => !!aBrand && brandVocabArr.some(b => b.includes(aBrand) || aBrand.includes(b));

  const materialParts = [], excludedParts = [];
  for (const part of parts) {
    if (isNonMaterial(part.name)) excludedParts.push(part);
    else materialParts.push(part);
  }
  console.log(`Material parts: ${materialParts.length}  |  excluded (labor/fees): ${excludedParts.length}`);

  console.log('Scoring …');
  for (const part of materialParts) {
    const matchName = applySynonyms(part.name);
    part.rep = buildRep(matchName);
    part.aBrand = (part.brand && part.brand.trim())
      ? part.brand.toLowerCase().trim()
      : detectBrand(matchName, brandVocabArr);
    part.aBrandInSrs = srsHasBrand(part.aBrand);

    let best = null, second = null, third = null;
    for (const prod of products) {
      const s = scoreMatch(part.rep, part.aBrand, part.aBrandInSrs, prod);
      if (!best || s > best.score) { third = second; second = best; best = { prod, score: s }; }
      else if (!second || s > second.score) { third = second; second = { prod, score: s }; }
      else if (!third || s > third.score) { third = { prod, score: s }; }
    }
    part.best = best; part.second = second; part.third = third;
    part.confidence = bucket(best, part.rep);
  }

  // Resolve unrestricted variants for the matched products → answers "do we have options?"
  const matchIds = [...new Set(
    materialParts.filter(p => p.confidence !== 'none' && p.best).map(p => p.best.prod.product_id)
  )];
  console.log(`Resolving variants for ${matchIds.length} matched products …`);

  const variants = [];
  for (let i = 0; i < matchIds.length; i += 150) {
    const chunk = matchIds.slice(i, i + 150);
    const v = await fetchAll(
      supabase, 'srs_variants',
      'variant_id,product_id,variant_code,color_name,size_name,order_uom,is_restricted',
      { filters: [
          { op: 'in', args: ['product_id', chunk] },
          { op: 'eq', args: ['is_restricted', false] },
        ], orderBy: 'variant_id' }
    );
    variants.push(...v);
  }
  const varsByPid = {};
  for (const v of variants) (varsByPid[v.product_id] ||= []).push(v);

  // ── Build output rows ────────────────────────────────────────────────────────
  const fmtAlt = m => (m && m.prod)
    ? `${clean(m.prod.product_name)} [${m.prod.manufacturer_norm || '—'}] (${m.score.toFixed(2)})`
    : '';
  const uniq = arr => [...new Set(arr.filter(Boolean).map(s => String(s).trim()).filter(Boolean))];

  const outRows = materialParts.map(part => {
    const base2 = {
      aa_num: part.num, aa_name: part.name,
      aa_brand: part.aBrand || '',
      srs_has_brand: part.aBrand ? (part.aBrandInSrs ? 'YES' : 'No') : '',
      aa_uom: part.uom, aa_price: part.price,
      confidence: part.confidence,
      srs_id: '', srs_name: '', srs_brand: '', srs_cat: '', srs_pli: '',
      n_variants: '', has_options: '', colors: '', sizes: '', product_options: '', sample_skus: '',
      alt1: fmtAlt(part.second), alt2: fmtAlt(part.third),
      score: part.best ? Number(part.best.score.toFixed(3)) : '',
    };
    if (part.confidence === 'none' || !part.best) return base2;

    const prod = part.best.prod;
    const vs = varsByPid[prod.product_id] || [];
    const colors = uniq(vs.map(v => v.color_name)).filter(c => c.toUpperCase() !== 'N/A');
    const sizes  = uniq(vs.map(v => v.size_name)).filter(s => s.toUpperCase() !== 'N/A');
    const options = Array.isArray(prod.product_options)
      ? uniq(prod.product_options).filter(o => o.toUpperCase() !== 'N/A')
      : [];
    const hasOptions = vs.length > 1 || colors.length > 0 || sizes.length > 0 || options.length > 0;

    return {
      ...base2,
      srs_id: prod.product_id,
      srs_name: clean(prod.product_name),
      srs_brand: prod.manufacturer_norm || '',
      srs_cat: prod.product_category || '',
      srs_pli: prod.proposal_line_item || '',
      n_variants: vs.length,
      has_options: hasOptions ? 'YES' : 'No',
      colors: colors.slice(0, 25).join(', '),
      sizes: sizes.slice(0, 15).join(', '),
      product_options: options.slice(0, 15).join(', '),
      sample_skus: uniq(vs.map(v => v.variant_code)).slice(0, 5).join(', '),
    };
  });

  const rank = { exact: 0, strong: 1, weak: 2, none: 3 };
  outRows.sort((a, b) => (rank[a.confidence] - rank[b.confidence]) || (Number(a.aa_num) - Number(b.aa_num)));

  const excludedRows = excludedParts
    .map(p => ({ aa_num: p.num, aa_name: p.name, aa_uom: p.uom, aa_price: p.price, reason: 'labor / service / fee / change order' }))
    .sort((a, b) => Number(a.aa_num) - Number(b.aa_num));

  const writtenPath = await writeExcel(outFiles.full, label, outRows, excludedRows);
  const simplePath  = await writeSimple(outFiles.simple, label, outRows.filter(r => r.confidence !== 'none'));

  const reviewParts = materialParts
    .filter(p => p.confidence === 'weak' || p.confidence === 'none')
    .sort((a, b) => (({ weak: 0, none: 1 })[a.confidence] - ({ weak: 0, none: 1 })[b.confidence]) || (Number(a.num) - Number(b.num)));
  const reviewPath = await writeReview(outFiles.review, label, reviewParts);

  // ── Summary ──────────────────────────────────────────────────────────────────
  const tally = { exact: 0, strong: 0, weak: 0, none: 0 };
  let withOptions = 0;
  for (const r of outRows) {
    tally[r.confidence]++;
    if (r.has_options === 'YES') withOptions++;
  }
  const matched = tally.exact + tally.strong + tally.weak;
  console.log('\n--- Summary (material parts only) ---');
  console.log(`  exact  : ${tally.exact}`);
  console.log(`  strong : ${tally.strong}`);
  console.log(`  weak   : ${tally.weak}`);
  console.log(`  none   : ${tally.none}`);
  console.log(`  ────────────────`);
  console.log(`  matched (exact+strong+weak) : ${matched} / ${outRows.length} material parts`);
  console.log(`  matched products WITH options : ${withOptions}`);
  console.log(`  excluded (labor/service/fee)  : ${excludedParts.length}`);
  console.log(`\n✓ Wrote ${path.basename(writtenPath)}  (${outRows.length} material + ${excludedParts.length} excluded)`);
  console.log(`✓ Wrote ${path.basename(simplePath)}  (${matched} matched rows)`);
  console.log(`✓ Wrote ${path.basename(reviewPath)}  (${reviewParts.length} weak+none rows to review)`);

  return { outFiles: { full: writtenPath, simple: simplePath, review: reviewPath }, tally, matched };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      args[key] = val;
    } else {
      args._.push(a);
    }
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const inFile = args._[0];
  if (!inFile) {
    console.error('Usage: node match-account-to-srs.js <input.xlsx> [--label "Name"] [--out "Prefix"] [--sheet "Sheet"] [--name-col H] [--brand-col H] …');
    process.exit(1);
  }
  const cols = {};
  for (const k of ['num', 'name', 'desc', 'brand', 'uom', 'price']) {
    if (args[`${k}-col`]) cols[k] = args[`${k}-col`];
  }
  run({
    inFile,
    label: typeof args.label === 'string' ? args.label : undefined,
    outPrefix: typeof args.out === 'string' ? args.out : undefined,
    sheet: typeof args.sheet === 'string' ? args.sheet : undefined,
    cols: Object.keys(cols).length ? cols : undefined,
  }).catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
}

module.exports = { run };
