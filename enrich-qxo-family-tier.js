/**
 * Enrich qxo_products.family_tier — good / better / best / addon.
 *
 *   Mirrors enrich-family-tier.js (SRS) but keyed on QXO's signals:
 *     - brand_norm + product_line  → shingle family rules (Big 3 + IKO/TAMKO/Atlas/Malarkey/Pabco etc.)
 *     - proposal_line_item         → category-level defaults (no SRS srs_category enum)
 *     - product_name keywords      → underlayment / vent / pipe / drip-edge sub-tiers
 *
 *   Rules:
 *     1. Brand + line match wins (e.g. Gaf + Timberline HDZ → good)
 *     2. proposal_line_item keyword rules (e.g. Underlayment + felt → addon)
 *     3. Skylights, Spray Paint, Lead Flashing, stone-coated tile brands → addon
 *     4. proposal_line_item = null AND category looks non-roofing → addon
 *     5. Default → better (so commodity accessories appear in all 3 tiers)
 *
 *   node enrich-qxo-family-tier.js [--log-changes]
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchAll, upsertInBatches, makeChangeLogger, changeLogFlag } = require('./lib/utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const BATCH = 500;

// ── Shingle family rules — copy of SRS RULES with brand_norm matching ─────
// (Same brands sell into both distributors, so tiers should match.)
const RULES = [
  // GAF
  { mfr: 'Gaf', line: 'Timberline HDZ',              tier: 'good'  },
  { mfr: 'Gaf', line: 'Timberline UHDZ',             tier: 'better' },
  { mfr: 'Gaf', line: 'Timberline Ultra HD',         tier: 'better' },
  { mfr: 'Gaf', line: 'Grand Sequoia',               tier: 'best'  },
  { mfr: 'Gaf', line: 'Grand Canyon',                tier: 'best'  },
  { mfr: 'Gaf', line: 'Camelot',                     tier: 'best'  },
  { mfr: 'Gaf', line: 'Slateline',                   tier: 'best'  },
  { mfr: 'Gaf', line: 'Woodland',                    tier: 'best'  },
  { mfr: 'Gaf', line: 'Timberline HD',               tier: 'addon' },
  { mfr: 'Gaf', line: 'Royal Sovereign',             tier: 'addon' },
  { mfr: 'Gaf', line: 'Timberline ArmorShield',      tier: 'addon' },
  { mfr: 'Gaf', line: 'Timberline Solar',            tier: 'addon' },
  { mfr: 'Gaf', line: 'Timberline Cool',             tier: 'addon' },
  { mfr: 'Gaf', line: 'Timberline Natural Shadow',   tier: 'addon' },
  { mfr: 'Gaf', line: 'Timberline American Harvest', tier: 'addon' },

  // CertainTeed
  { mfr: 'Certainteed', line: 'Landmark PRO',          tier: 'good'  },
  { mfr: 'Certainteed', line: 'Landmark Premium',      tier: 'better' },
  { mfr: 'Certainteed', line: 'Belmont',               tier: 'better' },
  { mfr: 'Certainteed', line: 'Presidential Shake',    tier: 'best'  },
  { mfr: 'Certainteed', line: 'Grand Manor',           tier: 'best'  },
  { mfr: 'Certainteed', line: 'Highland Slate',        tier: 'best'  },
  { mfr: 'Certainteed', line: 'Carriage House',        tier: 'best'  },
  { mfr: 'Certainteed', line: 'Hatteras',              tier: 'best'  },
  { mfr: 'Certainteed', line: 'Landmark',              tier: 'addon' },
  { mfr: 'Certainteed', line: 'XT 25',                 tier: 'addon' },
  { mfr: 'Certainteed', line: 'Patriot',               tier: 'addon' },
  { mfr: 'Certainteed', line: 'NorthGate',             tier: 'addon' },
  { mfr: 'Certainteed', line: 'Landmark IR',           tier: 'addon' },
  { mfr: 'Certainteed', line: 'Landmark ClimateFlex',  tier: 'addon' },
  { mfr: 'Certainteed', line: 'Landmark TL',           tier: 'addon' },
  { mfr: 'Certainteed', line: 'Landmark Solaris',      tier: 'addon' },
  { mfr: 'Certainteed', line: 'Solstice',              tier: 'addon' },
  { mfr: 'Certainteed', line: 'IR XT 30',              tier: 'addon' },

  // Owens Corning
  { mfr: 'Owens Corning', line: 'Duration',            tier: 'good'  },
  { mfr: 'Owens Corning', line: 'Duration MAX',        tier: 'better' },
  { mfr: 'Owens Corning', line: 'Duration Premium',    tier: 'better' },
  { mfr: 'Owens Corning', line: 'Duration Designer',   tier: 'best'  },
  { mfr: 'Owens Corning', line: 'Woodcrest',           tier: 'best'  },
  { mfr: 'Owens Corning', line: 'Woodmoor',            tier: 'best'  },
  { mfr: 'Owens Corning', line: 'Berkshire',           tier: 'best'  },
  { mfr: 'Owens Corning', line: 'Oakridge',            tier: 'addon' },
  { mfr: 'Owens Corning', line: 'Supreme',             tier: 'addon' },
  { mfr: 'Owens Corning', line: 'Duration FLEX',       tier: 'addon' },
  { mfr: 'Owens Corning', line: 'Duration STORM',      tier: 'addon' },
  { mfr: 'Owens Corning', line: 'Duration Cool',       tier: 'addon' },

  // IKO
  { mfr: 'Iko', line: 'Cambridge',    tier: 'good'  },
  { mfr: 'Iko', line: 'Dynasty',      tier: 'better' },
  { mfr: 'Iko', line: 'Crowne Slate', tier: 'best'  },
  { mfr: 'Iko', line: 'Royal Estate', tier: 'best'  },
  { mfr: 'Iko', line: 'Biltmore',     tier: 'best'  },
  { mfr: 'Iko', line: 'Regency',      tier: 'best'  },
  { mfr: 'Iko', line: 'Marathon Plus',tier: 'addon' },
  { mfr: 'Iko', line: 'ArmourShake',  tier: 'addon' },
  { mfr: 'Iko', line: 'Nordic',       tier: 'addon' },
  { mfr: 'Iko', line: 'RoofShake',    tier: 'addon' },

  // TAMKO
  { mfr: 'Tamko', line: 'Heritage',              tier: 'good'  },
  { mfr: 'Tamko', line: 'Titan XT',              tier: 'better' },
  { mfr: 'Tamko', line: 'Heritage Elite',        tier: 'better' },
  { mfr: 'Tamko', line: 'Heritage Vintage',      tier: 'addon' },
  { mfr: 'Tamko', line: 'Heritage Woodgate',     tier: 'addon' },
  { mfr: 'Tamko', line: 'Heritage StormFighter', tier: 'addon' },
  { mfr: 'Tamko', line: 'MetalWorks',            tier: 'addon' },

  // Malarkey
  { mfr: 'Malarkey', line: 'Vista',          tier: 'good'  },
  { mfr: 'Malarkey', line: 'Highlander NEX', tier: 'good'  },
  { mfr: 'Malarkey', line: 'Legacy NEX',     tier: 'better' },
  { mfr: 'Malarkey', line: 'Windsor',        tier: 'better' },
  { mfr: 'Malarkey', line: 'Ecoasis NEX',    tier: 'best'  },

  // Atlas
  { mfr: 'Atlas', line: 'Pinnacle',     tier: 'good'  },
  { mfr: 'Atlas', line: 'StormMaster',  tier: 'better' },
  { mfr: 'Atlas', line: 'ProLam',       tier: 'addon' },
  { mfr: 'Atlas', line: 'GlassMaster',  tier: 'addon' },
  { mfr: 'Atlas', line: 'Pinnacle IR',  tier: 'addon' },
  { mfr: 'Atlas', line: 'Pinnacle Cool',tier: 'addon' },

  // PABCO
  { mfr: 'Pabco', line: 'Paramount',   tier: 'good'  },
  { mfr: 'Pabco', line: 'Premier',     tier: 'good'  },
  { mfr: 'Pabco', line: 'Prestige',    tier: 'better' },
  { mfr: 'Pabco', line: 'Cascade',     tier: 'better' },

  // Specialty / stone-coated / tile — wildcard brand match → addon
  { mfr: 'Decra',              line: null, tier: 'addon' },
  { mfr: 'Tilcor',             line: null, tier: 'addon' },
  { mfr: 'Worthouse',          line: null, tier: 'addon' },
  { mfr: 'Tesla',              line: null, tier: 'addon' },
  { mfr: 'Boral',              line: null, tier: 'addon' },
  { mfr: 'Eagle Roofing Products', line: null, tier: 'addon' },
  { mfr: 'Brava',              line: null, tier: 'addon' },
  { mfr: 'DaVinci',            line: null, tier: 'addon' },
  { mfr: 'Ecostar',            line: null, tier: 'addon' },
  { mfr: 'F-wave',             line: null, tier: 'addon' },
  { mfr: 'Inspire',            line: null, tier: 'addon' },
  { mfr: 'Cedur',              line: null, tier: 'addon' },
];

// ── Tier rules keyed on proposal_line_item + name keywords ─────────────────
// Evaluated in order — first match wins.
const PLI_RULES = [
  // Underlayment sub-tiers
  { pli: /^Underlayment — Felt/,           match: /.*/,                tier: 'addon'  },
  { pli: /^Underlayment — Self-Adhered/,   match: /.*/,                tier: 'better' },
  { pli: /^Underlayment — Synthetic/,      match: /.*/,                tier: 'good'   },
  // Ice & water
  { pli: /^Ice & Water — High Temp/,       match: /.*/,                tier: 'better' },
  { pli: /^Ice & Water — Standard/,        match: /.*/,                tier: 'good'   },
  // Vents
  { pli: /^Power Vent/,                    match: /.*/,                tier: 'addon'  },
  { pli: /^Ridge Vent/,                    match: /.*/,                tier: 'better' },
  { pli: /^Box Vent|^Soffit Vent/,         match: /.*/,                tier: 'good'   },
  // Pipe / lead
  { pli: /^Lead Flashing/,                 match: /.*/,                tier: 'best'   },
  { pli: /^Pipe Boot/,                     match: /epdm|rubber/i,      tier: 'better' },
  { pli: /^Pipe Boot/,                     match: /.*/,                tier: 'good'   },
  { pli: /^Dryer/,                         match: /.*/,                tier: 'addon'  },
  // Drip edge — material grade
  { pli: /^Drip Edge/,                     match: /copper|kynar|zinc.alum|galvalume/i, tier: 'best'   },
  { pli: /^Drip Edge/,                     match: /26\s*ga|heavy/i,    tier: 'better' },
  { pli: /^Drip Edge/,                     match: /.*/,                tier: 'good'   },
  // Coil nails
  { pli: /^Coil Nails/,                    match: /hot.dip|hdg/i,      tier: 'better' },
  { pli: /^Coil Nails/,                    match: /.*/,                tier: 'good'   },
  // Always-addon line items
  { pli: /^Skylight/,                      match: /.*/,                tier: 'addon'  },
  { pli: /^Spray Paint/,                   match: /.*/,                tier: 'addon'  },
];

// Normalize a product_line for rule matching. QXO names embed ® ™ © markers
// inline ("Timberline® HDZ"); strip them so rules can use plain text.
function normLine(s) {
  return (s || '')
    .replace(/[®™©]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pre-sort RULES so longer (more specific) line strings are evaluated before
// shorter (more generic) ones within each brand. Without this, "Duration"
// would catch "Duration Premium" before the more specific "Duration Premium"
// rule fires. Wildcard (line=null) rules sort last for their brand.
const SORTED_RULES = [...RULES].sort((a, b) => {
  if (a.mfr !== b.mfr) return 0;  // preserve brand grouping
  const al = a.line == null ? -1 : a.line.length;
  const bl = b.line == null ? -1 : b.line.length;
  return bl - al;
});

function getTier(p) {
  const mfr  = p.brand_norm || '';
  const line = normLine(p.product_line);
  const lineLc = line.toLowerCase();
  const name = (p.product_name || '').toLowerCase();
  const pli  = p.proposal_line_item || '';

  // 1. Brand-line shingle rules. Match case-insensitive AND tolerate the rule
  //    label appearing anywhere in the product_line (not just at the start) —
  //    e.g. "Landmark® Premium" should match the "Landmark Premium" rule.
  for (const r of SORTED_RULES) {
    if (r.mfr !== mfr) continue;
    if (r.line === null) return r.tier;
    const rule = r.line.toLowerCase();
    if (lineLc === rule || lineLc.startsWith(rule) || lineLc.includes(rule)) return r.tier;
  }

  // 2. proposal_line_item-based rules
  for (const r of PLI_RULES) {
    if (!r.pli.test(pli)) continue;
    if (r.match.test(name) || r.match.test(line)) return r.tier;
  }

  // 3. Products with no proposal_line_item (already filtered out of the
  //    proposal engine) → addon. Keeps them from appearing in G/B/B by default.
  if (!pli) return 'addon';

  // 4. Everything else (commodity accessories) → better
  return 'better';
}

async function main() {
  console.log('\n=== QXO family_tier Enrichment ===\n');

  const logChanges = changeLogFlag();
  const logger = makeChangeLogger({ enabled: logChanges, scriptName: 'qxo-family-tier' });
  if (logChanges) console.log('Audit logging enabled (--log-changes)\n');

  process.stdout.write('Loading qxo_products …\r');
  const rawProducts = await fetchAll(
    supabase,
    'qxo_products',
    'product_key, product_name, brand_norm, product_line, proposal_line_item, family_tier',
    {
      orderBy: 'product_key',
      onProgress: n => process.stdout.write(`  qxo_products: ${n.toLocaleString()} rows …\r`),
    },
  );
  process.stdout.write('\n');
  const seen = new Map();
  for (const p of rawProducts) if (!seen.has(p.product_key)) seen.set(p.product_key, p);
  const products = [...seen.values()];
  console.log(`  ${products.length.toLocaleString()} unique products.`);

  // ── Classify ─────────────────────────────────────────────────────────────
  const tierCount = { good: 0, better: 0, best: 0, addon: 0 };
  const updates = [];
  for (const p of products) {
    const tier = getTier(p);
    tierCount[tier]++;
    if (logChanges) logger.log(p.product_key, 'family_tier', p.family_tier, tier);
    if ((p.family_tier || null) !== tier) {
      updates.push({
        product_key:  p.product_key,
        product_name: p.product_name,
        family_tier:  tier,
      });
    }
  }

  console.log('\n--- Tier distribution ---');
  for (const t of ['good','better','best','addon']) {
    console.log(`  ${t.padEnd(8)}: ${tierCount[t].toLocaleString()}`);
  }

  // ── Big 3 shingle spot-check ────────────────────────────────────────────
  console.log('\n--- Big 3 shingle spot-check (proposal_line_item=Shingles) ---');
  const big3 = products
    .filter(p => p.proposal_line_item === 'Shingles' &&
                 ['Gaf','Certainteed','Owens Corning'].includes(p.brand_norm))
    .slice(0, 30);
  for (const p of big3) {
    const tier = getTier(p);
    console.log(`  ${tier.padEnd(8)} [${p.brand_norm}] ${(p.product_line || '∅').padEnd(28)} ← ${p.product_name?.slice(0,50)}`);
  }

  if (updates.length === 0) {
    console.log('\nNothing to write.');
    return;
  }
  console.log(`\nWriting ${updates.length.toLocaleString()} changes (batches of ${BATCH}) …`);
  await upsertInBatches(supabase, 'qxo_products', updates, {
    batchSize:  BATCH,
    onConflict: 'product_key',
    onProgress: (d, t) => process.stdout.write(`  ${d}/${t}\r`),
  });
  process.stdout.write('\n');

  if (logChanges && logger.count() > 0) {
    const path = await logger.save();
    console.log(`\nAudit log: ${logger.count().toLocaleString()} changes → ${path}`);
  }

  // ── Verify ──────────────────────────────────────────────────────────────
  console.log('\n--- DB counts after write ---');
  for (const tier of ['good','better','best','addon']) {
    const { count } = await supabase
      .from('qxo_products')
      .select('*', { count: 'exact', head: true })
      .eq('family_tier', tier);
    console.log(`  ${tier.padEnd(8)}: ${count?.toLocaleString()}`);
  }
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
