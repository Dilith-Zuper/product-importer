require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchAll, upsertInBatches, makeChangeLogger, changeLogFlag } = require('./lib/utils');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── Tier rules ────────────────────────────────────────────────────────────────
// Evaluated in order — first match wins.
// Based on: manufacturer_norm + product_line (from DB) + product_category
// Tiers: good | better | best | addon

const RULES = [

  // ═══════════════════════════════════════════════════════════════════════════
  // GAF
  // ═══════════════════════════════════════════════════════════════════════════
  { mfr: 'Gaf', line: 'Timberline HDZ',              tier: 'good'  }, // current standard
  { mfr: 'Gaf', line: 'Timberline UHDZ',             tier: 'better' },
  { mfr: 'Gaf', line: 'Timberline Ultra HD',          tier: 'better' },
  { mfr: 'Gaf', line: 'Grand Sequoia',               tier: 'best'  },
  { mfr: 'Gaf', line: 'Grand Canyon',                tier: 'best'  },
  { mfr: 'Gaf', line: 'Camelot',                     tier: 'best'  },
  { mfr: 'Gaf', line: 'Slateline',                   tier: 'best'  },
  { mfr: 'Gaf', line: 'Woodland',                    tier: 'best'  },
  { mfr: 'Gaf', line: 'Timberline HD',               tier: 'addon' }, // prior gen
  { mfr: 'Gaf', line: 'Royal Sovereign',             tier: 'addon' }, // legacy 3-tab
  { mfr: 'Gaf', line: 'Timberline ArmorShield II',   tier: 'addon' }, // impact upgrade
  { mfr: 'Gaf', line: 'Timberline Solar',            tier: 'addon' }, // solar upgrade
  { mfr: 'Gaf', line: 'Timberline Cool',             tier: 'addon' }, // cool roof specialty
  { mfr: 'Gaf', line: 'Timberline Natural Shadow',   tier: 'addon' },
  { mfr: 'Gaf', line: 'Timberline American Harvest', tier: 'addon' },

  // ═══════════════════════════════════════════════════════════════════════════
  // CertainTeed
  // ═══════════════════════════════════════════════════════════════════════════
  { mfr: 'Certainteed', line: 'Landmark PRO',          tier: 'good'  }, // current standard
  { mfr: 'Certainteed', line: 'Landmark Premium',      tier: 'better' },
  { mfr: 'Certainteed', line: 'Belmont',               tier: 'better' },
  { mfr: 'Certainteed', line: 'Presidential Shake',    tier: 'best'  },
  { mfr: 'Certainteed', line: 'Grand Manor',           tier: 'best'  },
  { mfr: 'Certainteed', line: 'Highland Slate',        tier: 'best'  },
  { mfr: 'Certainteed', line: 'Carriage House',        tier: 'best'  },
  { mfr: 'Certainteed', line: 'Hatteras',              tier: 'best'  },
  { mfr: 'Certainteed', line: 'Landmark',              tier: 'addon' }, // entry — below current standard
  { mfr: 'Certainteed', line: 'XT 25',                 tier: 'addon' }, // legacy 3-tab
  { mfr: 'Certainteed', line: 'Patriot',               tier: 'addon' }, // economy metric
  { mfr: 'Certainteed', line: 'NorthGate',             tier: 'addon' }, // impact upgrade
  { mfr: 'Certainteed', line: 'Landmark IR',           tier: 'addon' }, // impact upgrade
  { mfr: 'Certainteed', line: 'Landmark ClimateFlex',  tier: 'addon' }, // impact upgrade
  { mfr: 'Certainteed', line: 'Landmark TL',           tier: 'addon' }, // specialty thick laminate
  { mfr: 'Certainteed', line: 'Landmark Solaris',      tier: 'addon' }, // cool roof specialty
  { mfr: 'Certainteed', line: 'Solstice',              tier: 'addon' }, // solar upgrade
  { mfr: 'Certainteed', line: 'IR XT 30',              tier: 'addon' }, // impact specialty

  // ═══════════════════════════════════════════════════════════════════════════
  // Owens Corning
  // ═══════════════════════════════════════════════════════════════════════════
  { mfr: 'Owens Corning', line: 'Duration',            tier: 'good'  }, // current standard
  { mfr: 'Owens Corning', line: 'Duration MAX',        tier: 'better' },
  { mfr: 'Owens Corning', line: 'Duration Premium',    tier: 'better' },
  { mfr: 'Owens Corning', line: 'Duration Designer',   tier: 'best'  },
  { mfr: 'Owens Corning', line: 'Woodcrest',           tier: 'best'  },
  { mfr: 'Owens Corning', line: 'Woodmoor',            tier: 'best'  },
  { mfr: 'Owens Corning', line: 'Berkshire',           tier: 'best'  },
  { mfr: 'Owens Corning', line: 'Oakridge',            tier: 'addon' }, // economy entry
  { mfr: 'Owens Corning', line: 'Supreme',             tier: 'addon' }, // legacy 3-tab
  { mfr: 'Owens Corning', line: 'Duration FLEX',       tier: 'addon' }, // impact upgrade
  { mfr: 'Owens Corning', line: 'Duration STORM',      tier: 'addon' }, // impact upgrade
  { mfr: 'Owens Corning', line: 'Duration Cool',       tier: 'addon' }, // cool roof specialty

  // ═══════════════════════════════════════════════════════════════════════════
  // IKO
  // ═══════════════════════════════════════════════════════════════════════════
  { mfr: 'Iko', line: 'Cambridge',    tier: 'good'  },
  { mfr: 'Iko', line: 'Dynasty',      tier: 'better' },
  { mfr: 'Iko', line: 'Crowne Slate', tier: 'best'  },
  { mfr: 'Iko', line: 'Royal Estate', tier: 'best'  },
  { mfr: 'Iko', line: 'Biltmore',     tier: 'best'  },
  { mfr: 'Iko', line: 'Regency',      tier: 'best'  },
  { mfr: 'Iko', line: 'Marathon Plus',tier: 'addon' }, // economy entry
  { mfr: 'Iko', line: 'ArmourShake',  tier: 'addon' }, // impact upgrade
  { mfr: 'Iko', line: 'Nordic',       tier: 'addon' }, // impact upgrade
  { mfr: 'Iko', line: 'RoofShake',    tier: 'addon' }, // specialty

  // ═══════════════════════════════════════════════════════════════════════════
  // TAMKO
  // ═══════════════════════════════════════════════════════════════════════════
  { mfr: 'Tamko', line: 'Heritage',             tier: 'good'  },
  { mfr: 'Tamko', line: 'Titan XT',             tier: 'better' },
  { mfr: 'Tamko', line: 'Heritage Elite',       tier: 'better' },
  { mfr: 'Tamko', line: 'Heritage Vintage',     tier: 'addon' }, // specialty
  { mfr: 'Tamko', line: 'Heritage Woodgate',    tier: 'addon' }, // specialty
  { mfr: 'Tamko', line: 'Heritage StormFighter',tier: 'addon' }, // impact upgrade
  { mfr: 'Tamko', line: 'MetalWorks',           tier: 'addon' }, // stone-coated metal — separate system

  // ═══════════════════════════════════════════════════════════════════════════
  // Malarkey
  // ═══════════════════════════════════════════════════════════════════════════
  { mfr: 'Malarkey', line: 'Vista',          tier: 'good'  },
  { mfr: 'Malarkey', line: 'Highlander NEX', tier: 'good'  },
  { mfr: 'Malarkey', line: 'Legacy NEX',     tier: 'better' },
  { mfr: 'Malarkey', line: 'Windsor',        tier: 'better' },
  { mfr: 'Malarkey', line: 'Ecoasis NEX',    tier: 'best'  }, // polymer modified premium

  // ═══════════════════════════════════════════════════════════════════════════
  // Atlas
  // ═══════════════════════════════════════════════════════════════════════════
  { mfr: 'Atlas', line: 'Pinnacle',     tier: 'good'  }, // Pinnacle Pristine — current standard
  { mfr: 'Atlas', line: 'StormMaster',  tier: 'better' },
  { mfr: 'Atlas', line: 'ProLam',       tier: 'addon' }, // older entry line
  { mfr: 'Atlas', line: 'GlassMaster',  tier: 'addon' }, // legacy
  { mfr: 'Atlas', line: 'Pinnacle IR',  tier: 'addon' }, // impact upgrade
  { mfr: 'Atlas', line: 'Pinnacle Cool',tier: 'addon' }, // cool roof specialty

  // ═══════════════════════════════════════════════════════════════════════════
  // PABCO
  // ═══════════════════════════════════════════════════════════════════════════
  { mfr: 'Pabco', line: 'Paramount',   tier: 'good'  },
  { mfr: 'Pabco', line: 'Premier',     tier: 'good'  },
  { mfr: 'Pabco', line: 'Prestige',    tier: 'better' },
  { mfr: 'Pabco', line: 'Cascade',     tier: 'better' },

  // ═══════════════════════════════════════════════════════════════════════════
  // Stone-coated / tile / specialty roof systems → separate addon
  // ═══════════════════════════════════════════════════════════════════════════
  { mfr: 'Decra',           line: null, tier: 'addon' }, // stone-coated steel — separate system
  { mfr: 'Tilcor',          line: null, tier: 'addon' }, // stone-coated steel
  { mfr: 'Worthouse',       line: null, tier: 'addon' },
  { mfr: 'Tesla',           line: null, tier: 'addon' }, // solar roof tiles
  { mfr: 'Boral',           line: null, tier: 'addon' }, // concrete tile — separate system
  { mfr: 'Eagle',           line: null, tier: 'addon' }, // concrete tile
  { mfr: 'Brava Roof Tile', line: null, tier: 'addon' }, // synthetic tile
  { mfr: 'Davinci Roofscapes', line: null, tier: 'addon' },
  { mfr: 'Ecostar',         line: null, tier: 'addon' },
  { mfr: 'F-wave',          line: null, tier: 'addon' },
  { mfr: 'Inspire',         line: null, tier: 'addon' },
  { mfr: 'Mca',             line: null, tier: 'addon' },
  { mfr: 'Mca Tile',        line: null, tier: 'addon' },
  { mfr: 'Cedur',           line: null, tier: 'addon' },
  { mfr: 'Stoneworth',      line: null, tier: 'addon' },
  { mfr: 'Crown Roof Tiles',line: null, tier: 'addon' },
  { mfr: 'Santafe Tile',    line: null, tier: 'addon' },
  { mfr: 'Verea',           line: null, tier: 'addon' },
  { mfr: 'Claymex',         line: null, tier: 'addon' },
  { mfr: 'Roser',           line: null, tier: 'addon' },
];

// ── Category-level tier defaults (for non-shingle products) ───────────────────
// Based on keywords in product_line or product_name
const CAT_RULES = [
  // UNDERLAYMENT
  { cat: 'UNDERLAYMENT', match: /felt|#15|#30|organic/i,    tier: 'addon'  }, // felt = legacy
  { cat: 'UNDERLAYMENT', match: /ht|high.temp|self.adher/i, tier: 'better' },
  { cat: 'UNDERLAYMENT', match: /synthetic|summit|protec|gorilla|feltbuster|securegrip/i, tier: 'good' },
  // ICE AND WATER
  { cat: 'ICE AND WATER', match: /ht|high.temp|granular/i,  tier: 'better' },
  { cat: 'ICE AND WATER', match: /.*/,                      tier: 'good'   },
  // VENTS
  { cat: 'VENTS', match: /power|electric|solar.powered|solar.attic|attic.fan|1500\s*cfm/i, tier: 'addon' },
  { cat: 'VENTS', match: /ridge|rolled.ridge|shingle.over/i, tier: 'better' },
  { cat: 'VENTS', match: /.*/,                               tier: 'good'   },
  // PIPE FLASHING
  { cat: 'PIPE FLASHING', match: /lead|copper/i,             tier: 'best'  },
  { cat: 'PIPE FLASHING', match: /epdm|rubber/i,             tier: 'better' },
  { cat: 'PIPE FLASHING', match: /.*/,                       tier: 'good'   },
  // DRIP EDGE
  { cat: 'DRIP EDGE', match: /copper|kynar|zinc.alum|galvalume/i, tier: 'best' },
  { cat: 'DRIP EDGE', match: /26\s*ga|heavy/i,               tier: 'better' },
  { cat: 'DRIP EDGE', match: /.*/,                            tier: 'good'   },
  // COIL NAILS
  { cat: 'COIL NAILS', match: /hot.dip|hdg/i,                tier: 'better' },
  { cat: 'COIL NAILS', match: /.*/,                           tier: 'good'   },
  // SKYLIGHTS — always addon (customer explicitly requests)
  { cat: 'SKYLIGHTS', match: /.*/,                            tier: 'addon'  },
  // TOOLS/SAFETY — exclude from proposals
  { cat: 'TOOLS/SAFETY', match: /.*/,                         tier: 'addon'  },
];

// Everything else defaults to 'better' — appears in all 3 proposal levels
const DEFAULT_TIER = 'better';

// ── Classify a product ────────────────────────────────────────────────────────
function getTier(product) {
  const mfr  = product.manufacturer_norm || '';
  const line = (product.product_line || '').trim();
  const cat  = product.product_category || '';
  const name = (product.product_name || '').toLowerCase();

  // 1. Product-line-specific rules (shingle families)
  for (const r of RULES) {
    if (r.mfr !== mfr) continue;
    if (r.line === null || r.line === line) return r.tier;  // null = any line for that brand
    if (line.startsWith(r.line)) return r.tier;              // prefix match
  }

  // 2. Category-level rules
  for (const r of CAT_RULES) {
    if (r.cat !== cat) continue;
    if (r.match.test(name) || r.match.test(line)) return r.tier;
  }

  // 3. Default
  return DEFAULT_TIER;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Family Tier Enrichment ===\n');

  const logChanges = changeLogFlag();
  const logger = makeChangeLogger({ enabled: logChanges, scriptName: 'family-tier' });
  if (logChanges) console.log('Audit logging enabled (--log-changes)\n');

  const cols = logChanges
    ? 'product_id, product_name, product_category, manufacturer_norm, product_line, family_tier'
    : 'product_id, product_name, product_category, manufacturer_norm, product_line';

  const products = await fetchAll(supabase, 'srs_products', cols, {
    onProgress: n => process.stdout.write(`  Loading: ${n} …\r`),
  });
  console.log(`Loaded ${products.length.toLocaleString()} products.\n`);

  // Classify every product
  const tierMap = { good: [], better: [], best: [], addon: [] };
  const rows = products.map(p => {
    const tier = getTier(p);
    tierMap[tier].push(p.product_name);
    if (logChanges) logger.log(p.product_id, 'family_tier', p.family_tier, tier);
    return { product_id: p.product_id, product_name: p.product_name, product_category: p.product_category, family_tier: tier };
  });

  // Distribution summary
  console.log('Tier distribution:');
  Object.entries(tierMap).forEach(([t, items]) =>
    console.log(`  ${t.padEnd(8)}: ${items.length.toLocaleString()} products`)
  );

  // Spot-check — show shingles classification
  console.log('\n--- Shingles spot-check ---');
  products
    .filter(p => p.product_category === 'SHINGLES' && ['Gaf','Certainteed','Owens Corning','Iko','Tamko','Atlas','Malarkey'].includes(p.manufacturer_norm))
    .forEach(p => {
      const tier = getTier(p);
      console.log(`  ${tier.padEnd(8)} [${p.manufacturer_norm}] ${p.product_name}`);
    });

  // Upsert in batches of 500 (include required non-null cols)
  console.log('\nUpserting family_tier …');
  const done = await upsertInBatches(supabase, 'srs_products', rows, {
    onProgress: (d, t) => process.stdout.write(`  ${d.toLocaleString()} / ${t.toLocaleString()} …\r`),
  });
  console.log(`  ${done.toLocaleString()} / ${rows.length.toLocaleString()} ✓\n`);

  if (logChanges && logger.count() > 0) {
    const path = await logger.save();
    console.log(`Audit log: ${logger.count().toLocaleString()} tier changes → ${path}\n`);
  }

  // Verify
  for (const tier of ['good','better','best','addon']) {
    const { count } = await supabase
      .from('srs_products')
      .select('*', { count: 'exact', head: true })
      .eq('family_tier', tier);
    console.log(`  ${tier.padEnd(8)}: ${count?.toLocaleString()} rows in DB`);
  }
  console.log('\n✓ Done.\n');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
