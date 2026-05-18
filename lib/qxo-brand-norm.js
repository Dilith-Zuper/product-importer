/**
 * QXO brand canonicalization.
 *
 * QXO has 2,447 raw brand strings — many are sub-brand variants of the same
 * parent ("CertainTeed Siding" vs "CertainTeed Roofing" etc.). This module
 * folds them into stable canonical names that match the SRS convention
 * (title case, single canonical token per parent brand).
 *
 * Coverage: explicit overrides for the top ~50 brands (95%+ of catalog volume).
 * Long-tail brands pass through a title-case normalizer.
 *
 *   normalizeQxoBrand("CertainTeed Siding")  → "Certainteed"
 *   normalizeQxoBrand("GAF")                 → "Gaf"
 *   normalizeQxoBrand("Some Tiny Brand")     → "Some Tiny Brand"
 */

// Explicit overrides — raw exact-match (case-insensitive after .toLowerCase().trim())
// → canonical title-cased form. Lookup is O(1) via Map.
const OVERRIDES = new Map([
  // Big 3 — match the SRS manufacturer_norm spelling exactly.
  ['gaf',                       'Gaf'],
  ['certainteed',               'Certainteed'],
  ['certainteed roofing',       'Certainteed'],
  ['certainteed siding',        'Certainteed'],
  ['certainteed insulation',    'Certainteed'],
  ['owens corning',             'Owens Corning'],

  // Common roofing brands also present in SRS.
  ['iko',                       'Iko'],
  ['malarkey',                  'Malarkey'],
  ['tamko',                     'Tamko'],
  ['atlas',                     'Atlas'],
  ['atlas roofing',             'Atlas'],
  ['boral',                     'Boral'],
  ['decra',                     'Decra'],
  ['tilcor',                    'Tilcor'],
  ['velux',                     'Velux'],

  // QXO-specific private labels and major distributors.
  ['tri-built',                 'Tri-Built'],
  ['tribuilt',                  'Tri-Built'],
  ['generic',                   'Generic'],
  ['mastic',                    'Mastic'],
  ['quality edge',              'Quality Edge'],
  ['berger building products',  'Berger Building Products'],
  ['coastal metal service',     'Coastal Metal Service'],
  ['klauer manufacturing company', 'Klauer Manufacturing Company'],
  ['variform by plygem',        'Variform By PlyGem'],
  ['variform',                  'Variform By PlyGem'],
  ['plygem',                    'PlyGem'],
  ['royal building products',   'Royal Building Products'],
  ['eagle roofing products',    'Eagle Roofing Products'],
  ['eagle roofing',             'Eagle Roofing Products'],
  ['johns manville',            'Johns Manville'],
  ['james hardie',              'James Hardie'],
  ['carlisle syntec',           'Carlisle SynTec'],
  ['carlisle',                  'Carlisle SynTec'],
  ['elevate',                   'Elevate'],
  ['newpoint',                  'Newpoint'],
  ['mid-america',               'Mid-America'],
  ['c&r manufacturing',         'C&R Manufacturing'],
  ['ply gem',                   'PlyGem'],
  ['lp building solutions',     'LP Building Solutions'],
  ['lp smartside',              'LP Building Solutions'],
  ['louisiana pacific',         'LP Building Solutions'],
  ['versico',                   'Versico'],
  ['firestone',                 'Firestone'],
  ['gaco',                      'Gaco'],
  ['henry',                     'Henry'],
  ['polyglass',                 'Polyglass'],
  ['polyglass usa',             'Polyglass'],
  ['soprema',                   'Soprema'],
  ['siplast',                   'Siplast'],
  ['versashield',               'Versashield'],
  ['drexel metals',             'Drexel Metals'],
  ['englert',                   'Englert'],
  ['amerimax',                  'Amerimax'],
  ['euramax',                   'Amerimax'],
  ['gibraltar',                 'Gibraltar'],
  ['airvent',                   'Air Vent'],
  ['air vent',                  'Air Vent'],
  ['lomanco',                   'Lomanco'],
  ['oatey',                     'Oatey'],
  ['dektite',                   'Dektite'],
  ['simpson strong-tie',        'Simpson Strong-Tie'],
  ['stinger',                   'Stinger'],
  ['profit',                    'ProFIT'],
  ['huber',                     'Huber'],
  ['zip system',                'Huber'],
  ['trex',                      'Trex'],
  ['timbertech',                'TimberTech'],
  ['azek',                      'Azek'],
  ['fiberon',                   'Fiberon'],
  ['davinci',                   'DaVinci'],
  ['davinci roofscapes',        'DaVinci'],
  ['brava',                     'Brava'],
  ['cedur',                     'Cedur'],
  ['inspire',                   'Inspire'],
  ['tesla',                     'Tesla'],
  ['gerard',                    'Gerard'],
]);

function toTitleCase(s) {
  return s.split(/\s+/).map(w =>
    w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w
  ).join(' ');
}

function normalizeQxoBrand(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  if (OVERRIDES.has(key)) return OVERRIDES.get(key);
  // Long tail: just title-case the trimmed string.
  return toTitleCase(trimmed);
}

module.exports = { normalizeQxoBrand };
