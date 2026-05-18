/**
 * QXO category → proposal_line_item classifier.
 *
 * Maps QXO's 193 free-text `category_norm` strings onto the 41 fixed
 * proposal_line_items used by the G/B/B proposal engine. Two-stage logic:
 *
 *   1. CATEGORY_MAP  — explicit lookup by category name (case-insensitive).
 *      Three result shapes:
 *        - "<line item name>"   → direct assignment
 *        - { sub: "<group>" }   → run sub-classifier in that group
 *        - null                 → category is intentionally excluded (tools, lumber, ...)
 *      Categories not in the map fall through to the heuristic sub-classifier.
 *
 *   2. SUB-CLASSIFIERS — when the category is too coarse, decide by product
 *      name keywords (similar to the SRS enrich-proposal-line-item.js logic
 *      for UNDERLAYMENT / VENTS / PIPE FLASHING / GUTTER / FLASHING).
 *
 * Returns the proposal_line_item display_name (string) or null (excluded).
 */

// ── Direct category lookups ────────────────────────────────────────────────
// Keys MUST be lowercase. Values: string | { sub: name } | null.
const CATEGORY_MAP = new Map([
  // Roofing primary materials
  ['architectural shingles',                'Shingles'],
  ['shingles',                              'Shingles'],
  ['3-tab shingles',                        'Shingles'],
  ['hip and ridge shingles',                'Hip & Ridge Cap'],
  ['hip and ridge',                         'Hip & Ridge Cap'],
  ['starter shingles',                      'Starter Strip'],
  ['starter strip',                         'Starter Strip'],
  ['tile roofing',                          'Shingles'],          // treat tile as shingle line (tier=addon)
  ['slate roofing',                         'Shingles'],
  ['wood roofing',                          'Shingles'],
  ['metal roofing',                         'Shingles'],
  ['metal panels',                          'Shingles'],
  ['low slope metal roofing',               'Commercial Membrane (TPO/EPDM)'],

  // Underlayment + ice & water
  ['underlayment',                          { sub: 'underlayment' }],
  ['synthetic underlayment',                'Underlayment — Synthetic'],
  ['felt underlayment',                     { sub: 'underlayment' }],
  ['self-adhered underlayment',             'Ice & Water — Standard'],

  // Flashing / edge / valley
  ['drip edge',                             'Drip Edge'],
  ['edge flashing',                         'Drip Edge'],
  ['gutter apron',                          'Gutter Apron'],
  ['valley flashing',                       'W-Valley'],
  ['step flashing',                         'Step Flashing'],
  ['flashings',                             { sub: 'flashing' }],
  ['commercial flashings',                  'Coil Stock / Sheet Metal'],
  ['epdm flashings, tapes and walkways',    'Coil Stock / Sheet Metal'],
  ['tpo flashings, tapes and walkways',     'Coil Stock / Sheet Metal'],
  ['flashings and ventilation',             { sub: 'flashing' }],
  ['metal trim',                            'Coil Stock / Sheet Metal'],
  ['trim coil',                             'Coil Stock / Sheet Metal'],
  ['coils',                                 'Coil Stock / Sheet Metal'],
  ['metal sheets',                          'Coil Stock / Sheet Metal'],

  // Vents
  ['ventilation and drainage',              { sub: 'vent' }],
  ['ridge vents',                           'Ridge Vent'],
  ['box vents',                             'Box Vent'],
  ['soffit vents',                          'Soffit Vent'],
  ['power vents',                           'Power Vent / Attic Fan'],
  ['attic ventilation',                     { sub: 'vent' }],

  // Pipe flashing / vent caps
  ['pipe flashings',                        { sub: 'pipe' }],
  ['pipe flashing',                         { sub: 'pipe' }],

  // Skylights
  ['skylights',                             'Skylight'],

  // Gutters
  ['gutters',                               { sub: 'gutter' }],
  ['gutter fittings',                       { sub: 'gutter' }],

  // Caulks / sealants / adhesives
  ['sealants',                              'Caulk / Sealant'],
  ['sealants and coatings',                 'Caulk / Sealant'],
  ['adhesives, caulks and sealants',        'Caulk / Sealant'],
  ['adhesives',                             'Caulk / Sealant'],
  ['caulk',                                 'Caulk / Sealant'],

  // Fasteners / nails
  ['nails',                                 { sub: 'nail' }],
  ['fasteners',                             'Fasteners'],
  ['nails, screws and fasteners',           { sub: 'nail' }],
  ['fasteners and clips',                   'Fasteners'],
  ['staples',                               'Fasteners'],
  ['gutter fasteners',                      'Fasteners'],

  // Siding
  ['vinyl siding',                          'Siding'],
  ['aluminium siding',                      'Siding'],
  ['aluminum siding',                       'Siding'],
  ['fiber cement siding',                   'Siding'],
  ['siding',                                'Siding'],
  ['siding accessories',                    'Siding'],
  ['cedar siding',                          'Siding'],
  ['wood siding',                           'Siding'],
  ['engineered wood siding',                'Siding'],
  ['stone veneer',                          'Siding'],
  ['stucco',                                'Siding'],

  // Commercial membrane + insulation (all map to one Commercial line)
  ['polyiso',                               'Commercial Membrane (TPO/EPDM)'],
  ['insulation materials',                  'Commercial Membrane (TPO/EPDM)'],
  ['expanded polystyrene (eps)',            'Commercial Membrane (TPO/EPDM)'],
  ['extruded polystyrene (xps)',            'Commercial Membrane (TPO/EPDM)'],
  ['coverboard',                            'Commercial Membrane (TPO/EPDM)'],
  ['sbs membranes',                         'Commercial Membrane (TPO/EPDM)'],
  ['apb membranes',                         'Commercial Membrane (TPO/EPDM)'],
  ['tpo membranes',                         'Commercial Membrane (TPO/EPDM)'],
  ['epdm membranes',                        'Commercial Membrane (TPO/EPDM)'],
  ['pvc membranes',                         'Commercial Membrane (TPO/EPDM)'],
  ['modified bitumen',                      'Commercial Membrane (TPO/EPDM)'],
  ['built-up roofing',                      'Commercial Membrane (TPO/EPDM)'],
  ['commercial waterproofing',              'Commercial Membrane (TPO/EPDM)'],
  ['belowgrade waterproofing',              'Commercial Membrane (TPO/EPDM)'],
  ['waterproofing',                         'Commercial Membrane (TPO/EPDM)'],
  ['weatherproofing',                       'Commercial Membrane (TPO/EPDM)'],
  ['air and vapor barriers',                'Commercial Membrane (TPO/EPDM)'],
  ['avb',                                   'Commercial Membrane (TPO/EPDM)'],
  ['commercial accessories',                'Commercial Membrane (TPO/EPDM)'],
  ['drains and scuppers',                   'Commercial Membrane (TPO/EPDM)'],
  ['primers',                               'Commercial Membrane (TPO/EPDM)'],   // membrane primers
  ['coatings',                              'Commercial Membrane (TPO/EPDM)'],   // roof coatings
  ['app membranes',                         'Commercial Membrane (TPO/EPDM)'],
  ['base sheets',                           'Commercial Membrane (TPO/EPDM)'],
  ['fabrics',                               'Commercial Membrane (TPO/EPDM)'],
  ['liquid asphalt',                        'Commercial Membrane (TPO/EPDM)'],
  ['perlite',                               'Commercial Membrane (TPO/EPDM)'],
  ['woodfiber',                             'Commercial Membrane (TPO/EPDM)'],
  ['modified roofing accessories',          { sub: 'accessory' }],
  ['commercial backer rod',                 'Caulk / Sealant'],
  ['commercial waterproofing sealants',     'Caulk / Sealant'],
  ['pvc flashings, tapes and walkways',     'Coil Stock / Sheet Metal'],
  ['metal flashing',                        'Coil Stock / Sheet Metal'],
  ['trim and accessories',                  { sub: 'accessory' }],
  ['commercial ventilation',                { sub: 'vent' }],
  ['vents',                                 { sub: 'vent' }],

  // Decking — keep narrow: only OSB/plywood used as roof deck. Lumber/composite excluded.
  ['plywood and osb',                       'Roof Decking (OSB)'],
  ['osb',                                   'Roof Decking (OSB)'],

  // Catch-all / ambiguous accessory buckets → run heuristic name keywords
  ['accessories',                           { sub: 'accessory' }],
  ['roofing accessories',                   { sub: 'accessory' }],
  ['miscellaneous roofing accessories',     { sub: 'accessory' }],
  ['exterior accessories',                  { sub: 'accessory' }],
  ['exterior materials',                    { sub: 'accessory' }],
  ['building supplies and materials',       { sub: 'accessory' }],

  // Explicitly excluded (non-roofing or never proposal items)
  ['tools and equipment',                   null],
  ['hand tools',                            null],
  ['safety, tools and accessories',         null],
  ['workwear and safety gear',              null],
  ['job-site supplies',                     null],
  ['job-site equipment',                    null],
  ['air tools and compressors',             null],
  ['brushes and rollers',                   null],
  ['waterproofing tools',                   null],
  ['soldering and welding',                 null],
  ['cleaners',                              null],
  ['lumber and composites',                 null],
  ['framing lumber',                        null],
  ['deck and railing',                      null],
  ['windows',                               null],
  ['window accessories',                    null],
  ['columns',                               null],
  ['drywall',                               null],
  ['masonry and rock',                      null],
  ['metal lath and wire',                   null],
  ['concrete restoration and parking',      null],
]);

// ── Sub-classifiers (by product_name keyword) ──────────────────────────────

const SUB = {
  underlayment(name) {
    const n = name.toLowerCase();
    if (/\b(ice\s*&?\s*water|ice\s*and\s*water|iwgs|iws|water\s*shield)\b/.test(n)) {
      return /\bhigh.?temp|\bht\b/.test(n) ? 'Ice & Water — High Temp' : 'Ice & Water — Standard';
    }
    if (/self.?adhered|peel.?and.?stick|high.?temp|\bht\b/.test(n)) {
      return 'Underlayment — Self-Adhered HT';
    }
    if (/felt.*30|30.*felt|#30|\b30#/.test(n)) return 'Underlayment — Felt 30#';
    if (/felt.*15|15.*felt|#15|\b15#/.test(n)) return 'Underlayment — Felt 15#';
    if (/\bfelt\b/.test(n))                    return 'Underlayment — Felt 15#';
    return 'Underlayment — Synthetic';
  },

  flashing(name) {
    const n = name.toLowerCase();
    if (/chimney/.test(n))                                return 'Chimney Flashing Kit';
    if (/\bstep\b/.test(n))                               return 'Step Flashing';
    if (/headwall|counter.?flash|wall flash/.test(n))     return 'Counter / Headwall Flashing';
    if (/valley/.test(n))                                 return 'W-Valley';
    if (/drip.?edge|edge.?metal|gravel\s*guard|eave/.test(n)) return 'Drip Edge';
    if (/gutter.?apron/.test(n))                          return 'Gutter Apron';
    if (/pipe\s*(boot|jack|flash|collar)|vent\s*pipe|roof\s*jack/.test(n)) return 'Pipe Boot 3"';
    if (/coil|flat\s*sheet|roll|sheet\s*metal|trim/.test(n)) return 'Coil Stock / Sheet Metal';
    return 'Step Flashing';     // most common when name is uninformative
  },

  vent(name) {
    const n = name.toLowerCase();
    if (/power|electric|solar.?attic|attic.?fan/.test(n)) return 'Power Vent / Attic Fan';
    if (/ridge/.test(n))                                  return 'Ridge Vent';
    if (/soffit/.test(n))                                 return 'Soffit Vent';
    if (/dryer|exhaust|gooseneck|damper|vent\s*cap/.test(n)) return 'Dryer / Exhaust Vent Cap';
    if (/\bdrain|scupper/.test(n))                         return null; // commercial drain
    return 'Box Vent';
  },

  pipe(name) {
    const n = name.toLowerCase();
    if (/\blead\b/.test(n))                                       return 'Lead Flashing';
    if (/dryer|exhaust|gooseneck|vent\s*cap|damper/.test(n))      return 'Dryer / Exhaust Vent Cap';
    // size detection from name
    const m = n.match(/\b([2346])"\s*(?:pipe|boot|jack|flash|collar)/) || n.match(/\b([2346])\s*inch/);
    if (m) return `Pipe Boot ${m[1]}"`;
    return 'Pipe Boot 3"';
  },

  gutter(name) {
    const n = name.toLowerCase();
    if (/\bdownspout\b/.test(n))                                  return 'Downspouts';
    if (/end\s*cap/.test(n))                                      return 'Gutter End Caps';
    if (/outside\s*(miter|corner)/.test(n))                       return 'Gutter Outside Corners';
    if (/inside\s*(miter|corner)/.test(n))                        return 'Gutter Inside Corners';
    if (/\belbow\b/.test(n))                                      return 'Gutter Elbows';
    if (/strainer|cage|guard|bracket|hanger|screw|spike/.test(n)) return 'Fasteners';
    if (/\bgutter\b/.test(n))                                     return 'Gutter Sections';
    return 'Coil Stock / Sheet Metal';
  },

  nail(name) {
    const n = name.toLowerCase();
    if (/plastic\s*cap|cap\s*nail/.test(n))               return 'Plastic Cap Nails';
    if (/coil.?nail/.test(n))                             return 'Coil Nails';
    if (/staple|brad|screw|anchor|bolt|clip/.test(n))     return 'Fasteners';
    if (/\bnail\b/.test(n))                               return 'Coil Nails';
    return 'Fasteners';
  },

  // "Roofing accessories", "Miscellaneous Roofing Accessories", etc. — anything
  // could be in here. Use name keywords to pick the best line item; fall through
  // to null when nothing matches.
  accessory(name) {
    const n = name.toLowerCase();
    // — Gutter system (no "gutter" prefix needed) —
    if (/\bdownspout\b/.test(n))                          return 'Downspouts';
    if (/\belbow\b/.test(n))                              return 'Gutter Elbows';
    if (/end\s*cap/.test(n))                              return 'Gutter End Caps';
    if (/outside\s*(miter|corner)/.test(n))               return 'Gutter Outside Corners';
    if (/inside\s*(miter|corner)/.test(n))                return 'Gutter Inside Corners';
    if (/gutter\b/.test(n))                               return 'Gutter Sections';
    // — Flashing / edge / valley —
    if (/drip\s*edge|edge\s*metal|gravel\s*guard/.test(n)) return 'Drip Edge';
    if (/gutter\s*apron/.test(n))                         return 'Gutter Apron';
    if (/\bw[- ]?valley\b|valley\s*metal|valley\s*flash/.test(n)) return 'W-Valley';
    if (/step\s*flash/.test(n))                           return 'Step Flashing';
    if (/chimney/.test(n))                                return 'Chimney Flashing Kit';
    if (/headwall|counter\s*flash|wall\s*flash/.test(n))  return 'Counter / Headwall Flashing';
    if (/termination\s*bar|trim\s*coil|j[- ]?channel|f[- ]?channel|coil\s*stock|flat\s*sheet|sheet\s*metal|gauge\s+\w*\s*(aluminum|steel|copper)/.test(n))
                                                          return 'Coil Stock / Sheet Metal';
    // — Underlayment & ice & water —
    if (/ice\s*&?\s*water|water\s*shield|\biws\b|\biwgs\b/.test(n))
                                                          return /high.?temp|\bht\b/.test(n) ? 'Ice & Water — High Temp' : 'Ice & Water — Standard';
    if (/underlayment|synthetic\s*felt|peel.?and.?stick/.test(n)) return SUB.underlayment(name);
    if (/\bfelt\b/.test(n))                               return SUB.underlayment(name);
    // — Vents —
    if (/ridge\s*vent/.test(n))                           return 'Ridge Vent';
    if (/soffit\s*vent/.test(n))                          return 'Soffit Vent';
    if (/power\s*vent|attic\s*fan/.test(n))               return 'Power Vent / Attic Fan';
    if (/box\s*vent|static\s*vent/.test(n))               return 'Box Vent';
    if (/dryer|exhaust|gooseneck|damper|vent\s*cap/.test(n)) return 'Dryer / Exhaust Vent Cap';
    // — Pipe / lead / skylight —
    if (/pipe\s*(boot|jack|flash|collar)|roof\s*jack/.test(n)) return SUB.pipe(name);
    if (/\blead\b.*(boot|jack|flash|collar|pipe)/.test(n)) return 'Lead Flashing';
    if (/skylight/.test(n))                               return 'Skylight';
    // — Shingles —
    if (/starter\s*(strip|shingle)/.test(n))              return 'Starter Strip';
    if (/hip\s*&?\s*ridge|ridge\s*cap/.test(n))           return 'Hip & Ridge Cap';
    if (/\bshingle/.test(n))                              return 'Shingles';
    if (/spray\s*paint|aerosol/.test(n))                  return 'Spray Paint';
    // — Caulks / sealants / adhesives —
    if (/caulk|sealant|adhesive|mastic\s*(seal|cement)|asphalt\s*cement/.test(n)) return 'Caulk / Sealant';
    // — Insulation / commercial —
    if (/foamular|insulation|polyiso|\beps\b|\bxps\b|coverboard|membrane|tpo|epdm|sbs|primer|coating|cold\s*process|hot\s*asphalt/.test(n))
                                                          return 'Commercial Membrane (TPO/EPDM)';
    // — Siding —
    if (/siding|soffit\s*panel|fascia\s*panel/.test(n))   return 'Siding';
    // — Fasteners / nails (broad — late so we don't grab too much) —
    if (/plastic\s*cap.*nail|cap\s*nail/.test(n))         return 'Plastic Cap Nails';
    if (/coil\s*nail|coil\s*ring/.test(n))                return 'Coil Nails';
    if (/\bnail|staple|screw|anchor|rivet|fastener|spike|clip\b/.test(n)) return 'Fasteners';
    return null;
  },
};

/** Main entry. Returns proposal_line_item display_name or null. */
function classifyQxoProduct(categoryNorm, productName) {
  const cat = (categoryNorm || '').trim().toLowerCase();
  const name = productName || '';
  if (!cat) {
    // No category — try the catch-all heuristic on name alone.
    return SUB.accessory(name);
  }
  const hit = CATEGORY_MAP.get(cat);
  if (hit === undefined) {
    // Unknown category — try the catch-all heuristic.
    return SUB.accessory(name);
  }
  if (hit === null) return null;                  // explicit exclude
  if (typeof hit === 'string') return hit;        // direct
  if (hit && hit.sub) return SUB[hit.sub](name);  // sub-classify
  return null;
}

module.exports = {
  classifyQxoProduct,
  CATEGORY_MAP,   // exposed for tests / coverage reports
  SUB,
};
