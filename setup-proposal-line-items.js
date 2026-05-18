require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const LINE_ITEMS = [
  // ── Core shingle system ───────────────────────────────────────────────────────
  { display_name: 'Shingles',                    srs_category: 'SHINGLES',             type_filter: null,                          size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL(({Total Roof Area (SQFT)} / 100) * (1 + {Suggested Waste Percentage % (PCT)} / 100) * 3)', output_uom: 'BD',  is_gated: false, gate_question: null,                          sort_order: 10  },
  { display_name: 'Hip & Ridge Cap',             srs_category: 'HIP AND RIDGE',        type_filter: null,                          size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({RidgeCap (LF)} / 35)',                                                                   output_uom: 'BD',  is_gated: false, gate_question: null,                          sort_order: 20  },
  { display_name: 'Starter Strip',               srs_category: 'STARTER',              type_filter: null,                          size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Starter (LF)} / 105)',                                                                    output_uom: 'BD',  is_gated: false, gate_question: null,                          sort_order: 30  },

  // ── Underlayment ──────────────────────────────────────────────────────────────
  { display_name: 'Underlayment — Synthetic',    srs_category: 'UNDERLAYMENT',         type_filter: 'synthetic',                   size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Total Roof Area (SQFT)} * (1 + {Suggested Waste Percentage % (PCT)} / 100) / 1000)',   output_uom: 'RL',  is_gated: false, gate_question: null,                          sort_order: 40  },
  { display_name: 'Underlayment — Felt 15#',     srs_category: 'UNDERLAYMENT',         type_filter: 'felt 15,#15',                 size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Total Roof Area (SQFT)} * (1 + {Suggested Waste Percentage % (PCT)} / 100) / 400)',    output_uom: 'RL',  is_gated: false, gate_question: null,                          sort_order: 41  },
  { display_name: 'Underlayment — Felt 30#',     srs_category: 'UNDERLAYMENT',         type_filter: 'felt 30,#30',                 size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Total Roof Area (SQFT)} * (1 + {Suggested Waste Percentage % (PCT)} / 100) / 200)',    output_uom: 'RL',  is_gated: false, gate_question: null,                          sort_order: 42  },
  { display_name: 'Underlayment — Self-Adhered HT', srs_category: 'UNDERLAYMENT',      type_filter: 'self-adhered,ht,high temp',   size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Total Roof Area (SQFT)} * (1 + {Suggested Waste Percentage % (PCT)} / 100) / 200)',    output_uom: 'RL',  is_gated: false, gate_question: null,                          sort_order: 43  },

  // ── Ice & Water ───────────────────────────────────────────────────────────────
  { display_name: 'Ice & Water — Standard',      srs_category: 'ICE AND WATER',        type_filter: null,                          size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Ice & Water Barrier (SQFT)} / 200)',                                                     output_uom: 'RL',  is_gated: false, gate_question: null,                          sort_order: 50  },
  { display_name: 'Ice & Water — High Temp',     srs_category: 'ICE AND WATER',        type_filter: 'high temp,ht',                size_filter: null, formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'RL',  is_gated: true,  gate_question: 'Is high-temp ice & water required (chimneys/skylights)?', sort_order: 51 },

  // ── Metal / edge ──────────────────────────────────────────────────────────────
  { display_name: 'Drip Edge',                   srs_category: 'DRIP EDGE',            type_filter: null,                          size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Drip Edge (LF)} / 10)',                                                                  output_uom: 'PC',  is_gated: false, gate_question: null,                          sort_order: 60  },
  { display_name: 'W-Valley',                    srs_category: 'W-VALLEY',             type_filter: null,                          size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Total Valleys Length (LF)} / 10)',                                                       output_uom: 'PC',  is_gated: false, gate_question: null,                          sort_order: 70  },
  { display_name: 'Gutter Apron',                srs_category: 'GUTTER APRON',         type_filter: null,                          size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Drip Edge (LF)} / 10)',                                                                  output_uom: 'PC',  is_gated: false, gate_question: null,                          sort_order: 75  },

  // ── Nails & caps ──────────────────────────────────────────────────────────────
  { display_name: 'Coil Nails',                  srs_category: 'COIL NAILS',           type_filter: null,                          size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Total Roof Area (SQFT)} * 3.2 / 3600)',                                                  output_uom: 'BX',  is_gated: false, gate_question: null,                          sort_order: 80  },
  { display_name: 'Plastic Cap Nails',           srs_category: 'PLASTIC CAPS',         type_filter: null,                          size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Total Roof Area (SQFT)} / 400)',                                                         output_uom: 'BX',  is_gated: false, gate_question: null,                          sort_order: 85  },

  // ── Vents ─────────────────────────────────────────────────────────────────────
  { display_name: 'Ridge Vent',                  srs_category: 'VENTS',                type_filter: 'ridge',                       size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({RidgeCap (LF)} / 4)',                                                                    output_uom: 'PC',  is_gated: false, gate_question: null,                          sort_order: 90  },
  { display_name: 'Box Vent',                    srs_category: 'VENTS',                type_filter: 'box',                         size_filter: null, formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'EA',  is_gated: false, gate_question: null,                          sort_order: 91  },
  { display_name: 'Power Vent / Attic Fan',      srs_category: 'VENTS',                type_filter: 'power,electric,solar attic',  size_filter: null, formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'EA',  is_gated: true,  gate_question: 'Is a power vent / attic fan required?',               sort_order: 92  },
  { display_name: 'Soffit Vent',                 srs_category: 'VENTS',                type_filter: 'soffit',                      size_filter: null, formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'EA',  is_gated: false, gate_question: null,                          sort_order: 93  },

  // ── Pipe flashing ─────────────────────────────────────────────────────────────
  { display_name: 'Pipe Boot 2"',                srs_category: 'PIPE FLASHING',        type_filter: 'boot,jack,flashing',          size_filter: '2"', formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'EA',  is_gated: false, gate_question: null,                          sort_order: 100 },
  { display_name: 'Pipe Boot 3"',                srs_category: 'PIPE FLASHING',        type_filter: 'boot,jack,flashing',          size_filter: '3"', formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'EA',  is_gated: false, gate_question: null,                          sort_order: 101 },
  { display_name: 'Pipe Boot 4"',                srs_category: 'PIPE FLASHING',        type_filter: 'boot,jack,flashing',          size_filter: '4"', formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'EA',  is_gated: false, gate_question: null,                          sort_order: 102 },
  { display_name: 'Pipe Boot 6"',                srs_category: 'PIPE FLASHING',        type_filter: 'boot,jack,flashing',          size_filter: '6"', formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'EA',  is_gated: true,  gate_question: 'Are 6"+ pipe penetrations present?',                 sort_order: 103 },
  { display_name: 'Dryer / Exhaust Vent Cap',    srs_category: 'PIPE FLASHING',        type_filter: 'vent cap,gooseneck,dryer,damper', size_filter: null, formula_type: 'direct_input', formula_expr: null,                                                                                        output_uom: 'EA',  is_gated: false, gate_question: null,                          sort_order: 104 },
  { display_name: 'Lead Flashing',               srs_category: 'PIPE FLASHING',        type_filter: 'lead',                        size_filter: null, formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'EA',  is_gated: false, gate_question: null,                          sort_order: 105 },

  // ── Skylights ─────────────────────────────────────────────────────────────────
  { display_name: 'Skylight',                    srs_category: 'SKYLIGHTS',            type_filter: null,                          size_filter: null, formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'EA',  is_gated: true,  gate_question: 'Are skylights in scope?',                             sort_order: 110 },

  // ── Sealant & paint ───────────────────────────────────────────────────────────
  { display_name: 'Caulk / Sealant',             srs_category: 'CAULK',               type_filter: null,                          size_filter: null, formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'TB',  is_gated: false, gate_question: null,                          sort_order: 120 },
  { display_name: 'Spray Paint',                 srs_category: 'SPRAY PAINT',          type_filter: null,                          size_filter: null, formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'EA',  is_gated: false, gate_question: null,                          sort_order: 125 },

  // ── Gutters ───────────────────────────────────────────────────────────────────
  { display_name: 'Gutter Sections',             srs_category: 'GUTTER/ALUMINUM/COIL', type_filter: 'gutter',                     size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Gutter Length (LF)} / 10)',                                                              output_uom: 'PC',  is_gated: true,  gate_question: 'Are gutters in scope?',                               sort_order: 130 },
  { display_name: 'Downspouts',                  srs_category: 'GUTTER/ALUMINUM/COIL', type_filter: 'downspout',                  size_filter: null, formula_type: 'token_formula', formula_expr: '{No of Downspouts (EA)}',                                                                      output_uom: 'EA',  is_gated: true,  gate_question: 'Are gutters in scope?',                               sort_order: 131 },
  { display_name: 'Gutter End Caps',             srs_category: 'GUTTER/ALUMINUM/COIL', type_filter: 'end cap',                    size_filter: null, formula_type: 'token_formula', formula_expr: '{No of End Caps (EA)}',                                                                        output_uom: 'EA',  is_gated: true,  gate_question: 'Are gutters in scope?',                               sort_order: 132 },
  { display_name: 'Gutter Outside Corners',      srs_category: 'GUTTER/ALUMINUM/COIL', type_filter: 'miter,outside corner',       size_filter: null, formula_type: 'token_formula', formula_expr: '{No of Outside Miters (EA)}',                                                                  output_uom: 'EA',  is_gated: true,  gate_question: 'Are gutters in scope?',                               sort_order: 133 },
  { display_name: 'Gutter Inside Corners',       srs_category: 'GUTTER/ALUMINUM/COIL', type_filter: 'inside corner',              size_filter: null, formula_type: 'token_formula', formula_expr: '{No of Inside Miters (EA)}',                                                                   output_uom: 'EA',  is_gated: true,  gate_question: 'Are gutters in scope?',                               sort_order: 134 },
  { display_name: 'Gutter Elbows',               srs_category: 'GUTTER/ALUMINUM/COIL', type_filter: 'elbow',                      size_filter: null, formula_type: 'token_formula', formula_expr: '{Downspout Elbows (EA)} + {No of Inner Elbows (EA)} + {No of Outer Elbows (EA)}',             output_uom: 'EA',  is_gated: true,  gate_question: 'Are gutters in scope?',                               sort_order: 135 },

  // ── Flashing metal ────────────────────────────────────────────────────────────
  { display_name: 'Step Flashing',               srs_category: 'OTHER FLASHING METAL', type_filter: 'step',                       size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Total Step Flashing Length (LF)} / 10)',                                                 output_uom: 'PC',  is_gated: false, gate_question: null,                          sort_order: 150 },
  { display_name: 'Counter / Headwall Flashing', srs_category: 'OTHER FLASHING METAL', type_filter: 'headwall,counter,wall',       size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Headwall Flashing (LF)} / 10)',                                                         output_uom: 'PC',  is_gated: false, gate_question: null,                          sort_order: 151 },
  { display_name: 'Chimney Flashing Kit',        srs_category: 'OTHER FLASHING METAL', type_filter: 'chimney',                     size_filter: null, formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'EA',  is_gated: false, gate_question: null,                          sort_order: 152 },
  { display_name: 'Coil Stock / Sheet Metal',    srs_category: 'OTHER FLASHING METAL', type_filter: 'coil,sheet',                  size_filter: null, formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'RL',  is_gated: false, gate_question: null,                          sort_order: 153 },

  // ── Fasteners ─────────────────────────────────────────────────────────────────
  { display_name: 'Fasteners',                   srs_category: 'OTHER FASTENERS',      type_filter: null,                          size_filter: null, formula_type: 'direct_input',  formula_expr: null,                                                                                           output_uom: 'BX',  is_gated: false, gate_question: null,                          sort_order: 170 },

  // ── Gated / specialty ─────────────────────────────────────────────────────────
  { display_name: 'Siding',                      srs_category: 'SIDING',               type_filter: null,                          size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Total Siding Area (SQFT)} * (1 + {Suggested Waste Percentage % (PCT)} / 100) / 100)',   output_uom: 'SQ',  is_gated: true,  gate_question: 'Is siding in scope?',                                 sort_order: 180 },
  { display_name: 'Commercial Membrane (TPO/EPDM)', srs_category: 'COMMERCIAL',        type_filter: null,                          size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Total Roof Area (SQFT)} * (1 + {Suggested Waste Percentage % (PCT)} / 100) / 100)',   output_uom: 'SQ',  is_gated: true,  gate_question: 'Is this a flat/commercial roof?',                     sort_order: 190 },
  { display_name: 'Roof Decking (OSB)',           srs_category: 'DECKING',              type_filter: null,                          size_filter: null, formula_type: 'token_formula', formula_expr: 'CEIL({Total Roof Area (SQFT)} / 32 * (1 + {Suggested Waste Percentage % (PCT)} / 100))',     output_uom: 'PC',  is_gated: true,  gate_question: 'Is decking replacement required?',                    sort_order: 200 },
];

async function main() {
  console.log('\n=== Setup Proposal Line Items ===\n');

  // Clear existing
  await supabase.from('proposal_line_items').delete().gte('id', 0);

  const { data, error } = await supabase
    .from('proposal_line_items')
    .insert(LINE_ITEMS)
    .select('id, display_name, sort_order');

  if (error) throw new Error(error.message);

  console.log(`Inserted ${data.length} proposal line items:\n`);
  data.sort((a, b) => a.sort_order - b.sort_order)
      .forEach(r => console.log(`  [${String(r.id).padStart(2)}] ${r.display_name}`));
  console.log('\nDone.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
