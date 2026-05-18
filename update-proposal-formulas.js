require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// Corrected formulas — plain Zuper token names (no braces), matching real customer formula format.
// Waste token standardised to: Suggested Waste Percentage %  (no variants)
const UPDATES = [
  {
    display_name: 'Shingles',
    formula_type: 'token_formula',
    formula_expr: '(Total Roof Area * (1 + Suggested Waste Percentage % / 100)) / 100',
    output_uom:   'SQ',   // changed from BD — industry standard output is squares
  },
  {
    display_name: 'Hip & Ridge Cap',
    formula_type: 'token_formula',
    formula_expr: 'CEIL((Total Hip Length + Total Ridges Length) / 33)',
    output_uom:   'BD',   // 33 LF/bundle confirmed across 46 accounts (was 35)
  },
  {
    display_name: 'Starter Strip',
    formula_type: 'token_formula',
    formula_expr: 'CEIL((Total Eaves Length + Total Rakes Length) / 120)',
    output_uom:   'BD',   // 120 LF/bundle confirmed 53 accounts (was 105, wrong token)
  },
  {
    display_name: 'Ice & Water — Standard',
    formula_type: 'token_formula',
    formula_expr: 'CEIL((Total Eaves Length + Total Valleys Length) * 1.1 / 66)',
    output_uom:   'RL',   // 66 LF/roll @ 3ft wide, 1.1 = 10% overlap — confirmed 53 accounts
  },
  {
    display_name: 'Drip Edge',
    formula_type: 'token_formula',
    formula_expr: 'CEIL((Total Rakes Length + Total Eaves Length) / 10)',
    output_uom:   'PC',   // same divisor, corrected tokens — confirmed 53 accounts
  },
  {
    display_name: 'Ridge Vent',
    formula_type: 'token_formula',
    formula_expr: 'CEIL(Total Ridges Length / 4)',
    output_uom:   'PC',   // corrected token (was RidgeCap LF) — confirmed 53 accounts
  },
  {
    display_name: 'Gutter Apron',
    formula_type: 'token_formula',
    formula_expr: 'CEIL((Total Rakes Length + Total Eaves Length) / 10)',
    output_uom:   'PC',   // aligned with drip edge — same perimeter
  },
];

async function main() {
  console.log('\n=== Update Proposal Line Item Formulas ===\n');

  for (const u of UPDATES) {
    const { data, error } = await supabase
      .from('proposal_line_items')
      .update({
        formula_type: u.formula_type,
        formula_expr: u.formula_expr,
        output_uom:   u.output_uom,
      })
      .eq('display_name', u.display_name)
      .select('id, display_name, formula_expr, output_uom');

    if (error) {
      console.error(`  ERR [${u.display_name}]: ${error.message}`);
    } else if (!data.length) {
      console.warn(`  NOT FOUND: ${u.display_name}`);
    } else {
      console.log(`  ✓ [${String(data[0].id).padStart(2)}] ${data[0].display_name}`);
      console.log(`       expr : ${data[0].formula_expr}`);
      console.log(`       uom  : ${data[0].output_uom}\n`);
    }
  }

  // Verify — print all formula-driven rows
  const { data: all } = await supabase
    .from('proposal_line_items')
    .select('id, display_name, formula_expr, output_uom')
    .eq('formula_type', 'token_formula')
    .order('sort_order');

  console.log('─'.repeat(70));
  console.log('ALL TOKEN FORMULA ROWS IN DB:\n');
  all.forEach(r => {
    console.log(`  [${String(r.id).padStart(2)}] ${r.display_name.padEnd(35)} ${r.output_uom.padEnd(5)} ${r.formula_expr}`);
  });

  console.log('\nDone.');
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
