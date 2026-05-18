require('dotenv').config();
const ExcelJS = require('exceljs');
const path    = require('path');

const rows = [
  // ── Shingles ──────────────────────────────────────────────────────────────────
  {
    type:       'SHINGLES',
    name:       'Shingle Quantity',
    expression: '({Total Roof Area} * (1 + {Suggested Waste Percentage %} / 100)) / 100',
    uom:        'SQ',
    tokens:     'Total Roof Area (SQFT), Suggested Waste Percentage % (PCT)',
    notes:      'Output in squares. 53/54 customer accounts use this exact form',
  },

  // ── Hip & Ridge ───────────────────────────────────────────────────────────────
  {
    type:       'HIP AND RIDGE',
    name:       'Hip & Ridge Quantity',
    expression: 'CEIL(({Total Hip Length} + {Total Ridges Length}) / 33)',
    uom:        'BD',
    tokens:     'Total Hip Length (LF), Total Ridges Length (LF)',
    notes:      '33 LF per bundle — confirmed across 46 customer accounts',
  },

  // ── Starter ───────────────────────────────────────────────────────────────────
  {
    type:       'STARTER',
    name:       'Starter Quantity',
    expression: 'CEIL(({Total Eaves Length} + {Total Rakes Length}) / 120)',
    uom:        'BD',
    tokens:     'Total Eaves Length (LF), Total Rakes Length (LF)',
    notes:      '120 LF per bundle — confirmed across 53 customer accounts',
  },

  // ── Underlayment ──────────────────────────────────────────────────────────────
  {
    type:       'UNDERLAYMENT',
    name:       'Underlayment - Synthetic',
    expression: 'CEIL({Total Roof Area (SQFT)} * (1 + {Suggested Waste Percentage % (PCT)} / 100) / 1000)',
    uom:        'RL',
    tokens:     'Total Roof Area (SQFT), Suggested Waste Percentage % (PCT)',
    notes:      '10 SQ per roll = 1,000 SQFT — default type',
  },
  {
    type:       'UNDERLAYMENT',
    name:       'Underlayment - Felt 15#',
    expression: 'CEIL({Total Roof Area (SQFT)} * (1 + {Suggested Waste Percentage % (PCT)} / 100) / 400)',
    uom:        'RL',
    tokens:     'Total Roof Area (SQFT), Suggested Waste Percentage % (PCT)',
    notes:      '4 SQ per roll = 400 SQFT',
  },
  {
    type:       'UNDERLAYMENT',
    name:       'Underlayment - Felt 30#',
    expression: 'CEIL({Total Roof Area (SQFT)} * (1 + {Suggested Waste Percentage % (PCT)} / 100) / 200)',
    uom:        'RL',
    tokens:     'Total Roof Area (SQFT), Suggested Waste Percentage % (PCT)',
    notes:      '2 SQ per roll = 200 SQFT',
  },
  {
    type:       'UNDERLAYMENT',
    name:       'Underlayment - Self-Adhered HT',
    expression: 'CEIL({Total Roof Area (SQFT)} * (1 + {Suggested Waste Percentage % (PCT)} / 100) / 200)',
    uom:        'RL',
    tokens:     'Total Roof Area (SQFT), Suggested Waste Percentage % (PCT)',
    notes:      '2 SQ per roll = 200 SQFT',
  },

  // ── Ice & Water ───────────────────────────────────────────────────────────────
  {
    type:       'ICE AND WATER',
    name:       'Ice & Water Quantity',
    expression: 'CEIL(({Total Eaves Length} + {Total Valleys Length}) * 1.1 / 66)',
    uom:        'RL',
    tokens:     'Total Eaves Length (LF), Total Valleys Length (LF)',
    notes:      '66 LF per roll (3ft wide). 1.1 = 10% overlap. Confirmed 53 accounts',
  },

  // ── Drip Edge ─────────────────────────────────────────────────────────────────
  {
    type:       'DRIP EDGE',
    name:       'Drip Edge Quantity',
    expression: 'CEIL(({Total Rakes Length} + {Total Eaves Length}) / 10)',
    uom:        'PC',
    tokens:     'Total Rakes Length (LF), Total Eaves Length (LF)',
    notes:      'Standard piece = 10 LF — confirmed 53 customer accounts',
  },

  // ── W-Valley ──────────────────────────────────────────────────────────────────
  {
    type:       'W-VALLEY',
    name:       'W-Valley Quantity',
    expression: 'CEIL({Total Valleys Length (LF)} / 10)',
    uom:        'PC',
    tokens:     'Total Valleys Length (LF)',
    notes:      'Standard piece = 10 LF',
  },

  // ── Coil Nails ────────────────────────────────────────────────────────────────
  {
    type:       'COIL NAILS',
    name:       'Coil Nail Quantity',
    expression: 'CEIL({Total Roof Area (SQFT)} * 3.2 / 3600)',
    uom:        'BX',
    tokens:     'Total Roof Area (SQFT)',
    notes:      '3.2 nails/SQFT (320/SQ), 3,600 nails/box',
  },

  // ── Plastic Caps ──────────────────────────────────────────────────────────────
  {
    type:       'PLASTIC CAPS',
    name:       'Plastic Cap Quantity',
    expression: 'CEIL({Total Roof Area (SQFT)} / 400)',
    uom:        'BX',
    tokens:     'Total Roof Area (SQFT)',
    notes:      '~1 box per 4 SQ = 400 SQFT',
  },

  // ── Vents ─────────────────────────────────────────────────────────────────────
  {
    type:       'VENTS',
    name:       'Ridge Vent Quantity',
    expression: 'CEIL({Total Ridges Length} / 4)',
    uom:        'PC',
    tokens:     'Total Ridges Length (LF)',
    notes:      '4 LF per piece — confirmed 53 customer accounts',
  },
  {
    type:       'VENTS',
    name:       'Box / Soffit Vent Quantity',
    expression: 'Direct Input',
    uom:        'EA',
    tokens:     '—',
    notes:      'Contractor enters qty manually',
  },

  // ── Pipe Flashing ─────────────────────────────────────────────────────────────
  {
    type:       'PIPE FLASHING',
    name:       'Pipe Boot Quantity',
    expression: 'Direct Input',
    uom:        'EA',
    tokens:     '—',
    notes:      'Contractor counts penetrations on site',
  },

  // ── Skylights ─────────────────────────────────────────────────────────────────
  {
    type:       'SKYLIGHTS',
    name:       'Skylight Quantity',
    expression: 'Direct Input',
    uom:        'EA',
    tokens:     '—',
    notes:      'Gated scope question — entered manually',
  },

  // ── Caulk ─────────────────────────────────────────────────────────────────────
  {
    type:       'CAULK',
    name:       'Caulk Quantity',
    expression: 'Direct Input',
    uom:        'TB',
    tokens:     '—',
    notes:      'Contractor enters qty manually',
  },

  // ── Gutter / Aluminum / Coil ──────────────────────────────────────────────────
  {
    type:       'GUTTER/ALUMINUM/COIL',
    name:       'Gutter Sections',
    expression: 'CEIL({Gutter Length (LF)} / 10)',
    uom:        'PC',
    tokens:     'Gutter Length (LF)',
    notes:      '10 LF per section',
  },
  {
    type:       'GUTTER/ALUMINUM/COIL',
    name:       'Downspouts',
    expression: '{No of Downspouts (EA)}',
    uom:        'EA',
    tokens:     'No of Downspouts (EA)',
    notes:      '1:1 direct count',
  },
  {
    type:       'GUTTER/ALUMINUM/COIL',
    name:       'End Caps',
    expression: '{No of End Caps (EA)}',
    uom:        'EA',
    tokens:     'No of End Caps (EA)',
    notes:      '1:1 direct count',
  },
  {
    type:       'GUTTER/ALUMINUM/COIL',
    name:       'Outside Corners',
    expression: '{No of Outside Miters (EA)}',
    uom:        'EA',
    tokens:     'No of Outside Miters (EA)',
    notes:      '1:1 direct count',
  },
  {
    type:       'GUTTER/ALUMINUM/COIL',
    name:       'Inside Corners',
    expression: '{No of Inside Miters (EA)}',
    uom:        'EA',
    tokens:     'No of Inside Miters (EA)',
    notes:      '1:1 direct count',
  },
  {
    type:       'GUTTER/ALUMINUM/COIL',
    name:       'Elbows',
    expression: '{Downspout Elbows (EA)} + {No of Inner Elbows (EA)} + {No of Outer Elbows (EA)}',
    uom:        'EA',
    tokens:     'Downspout Elbows (EA), No of Inner Elbows (EA), No of Outer Elbows (EA)',
    notes:      'Sum of all elbow types',
  },

  // ── Gutter Apron ──────────────────────────────────────────────────────────────
  {
    type:       'GUTTER APRON',
    name:       'Gutter Apron Quantity',
    expression: 'CEIL(({Total Rakes Length} + {Total Eaves Length}) / 10)',
    uom:        'PC',
    tokens:     'Total Rakes Length (LF), Total Eaves Length (LF)',
    notes:      'Follows drip edge perimeter, 10 LF per piece',
  },

  // ── Spray Paint ───────────────────────────────────────────────────────────────
  {
    type:       'SPRAY PAINT',
    name:       'Spray Paint Quantity',
    expression: 'Direct Input',
    uom:        'EA',
    tokens:     '—',
    notes:      'Contractor enters qty manually',
  },

  // ── Other Fasteners ───────────────────────────────────────────────────────────
  {
    type:       'OTHER FASTENERS',
    name:       'Fastener Quantity',
    expression: 'Direct Input',
    uom:        'BX',
    tokens:     '—',
    notes:      'Contractor enters qty manually',
  },

  // ── Other Flashing Metal ──────────────────────────────────────────────────────
  {
    type:       'OTHER FLASHING METAL',
    name:       'Step Flashing Quantity',
    expression: 'CEIL({Total Step Flashing Length (LF)} / 10)',
    uom:        'PC',
    tokens:     'Total Step Flashing Length (LF)',
    notes:      '10 LF per piece',
  },
  {
    type:       'OTHER FLASHING METAL',
    name:       'General Flashing Quantity',
    expression: 'CEIL({Total Flashing Length (LF)} / 10)',
    uom:        'PC',
    tokens:     'Total Flashing Length (LF)',
    notes:      '10 LF per piece',
  },

  // ── Siding ────────────────────────────────────────────────────────────────────
  {
    type:       'SIDING',
    name:       'Siding Quantity',
    expression: 'CEIL({Total Siding Area (SQFT)} * (1 + {Suggested Waste Percentage % (PCT)} / 100) / 100)',
    uom:        'SQ',
    tokens:     'Total Siding Area (SQFT), Suggested Waste Percentage % (PCT)',
    notes:      '100 SQFT per square + waste',
  },

  // ── Commercial ────────────────────────────────────────────────────────────────
  {
    type:       'COMMERCIAL',
    name:       'Commercial Membrane Quantity',
    expression: 'CEIL({Total Roof Area (SQFT)} * (1 + {Suggested Waste Percentage % (PCT)} / 100) / 100)',
    uom:        'SQ',
    tokens:     'Total Roof Area (SQFT), Suggested Waste Percentage % (PCT)',
    notes:      'Flat/low slope — 1 SQ (100 SQFT) per unit',
  },

  // ── Decking ───────────────────────────────────────────────────────────────────
  {
    type:       'DECKING',
    name:       'Decking Sheet Quantity',
    expression: 'CEIL({Total Roof Area (SQFT)} / 32 * (1 + {Suggested Waste Percentage % (PCT)} / 100))',
    uom:        'PC',
    tokens:     'Total Roof Area (SQFT), Suggested Waste Percentage % (PCT)',
    notes:      '4x8 sheet = 32 SQFT + waste',
  },

  // ── Tools / Safety ────────────────────────────────────────────────────────────
  {
    type:       'TOOLS/SAFETY',
    name:       '—',
    expression: 'EXCLUDED',
    uom:        '—',
    tokens:     '—',
    notes:      'Never shown in customer proposals',
  },
];

const CAT_COLORS = {
  'SHINGLES':              'FFE8F4FD',
  'HIP AND RIDGE':         'FFE8F4FD',
  'STARTER':               'FFE8F4FD',
  'UNDERLAYMENT':          'FFEAFAF1',
  'ICE AND WATER':         'FFEAFAF1',
  'DRIP EDGE':             'FFFFF9E6',
  'W-VALLEY':              'FFFFF9E6',
  'COIL NAILS':            'FFFFF9E6',
  'PLASTIC CAPS':          'FFFFF9E6',
  'VENTS':                 'FFF5EEF8',
  'PIPE FLASHING':         'FFF5EEF8',
  'SKYLIGHTS':             'FFF5EEF8',
  'CAULK':                 'FFFDF2F8',
  'GUTTER/ALUMINUM/COIL':  'FFFEF9E7',
  'GUTTER APRON':          'FFFEF9E7',
  'SPRAY PAINT':           'FFFEF9E7',
  'OTHER FASTENERS':       'FFF8F9FA',
  'OTHER FLASHING METAL':  'FFF8F9FA',
  'SIDING':                'FFFCE4EC',
  'COMMERCIAL':            'FFE8EAF6',
  'DECKING':               'FFEDE7F6',
  'TOOLS/SAFETY':          'FFEEEEEE',
};

const COLS = [
  { header: 'Item Type',           key: 'type',       width: 24 },
  { header: 'Formula Name',        key: 'name',        width: 34 },
  { header: 'Expression',          key: 'expression',  width: 80 },
  { header: 'Output UOM',          key: 'uom',         width: 13 },
  { header: 'Tokens Used',         key: 'tokens',      width: 62 },
  { header: 'Notes / Assumptions', key: 'notes',       width: 42 },
];

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SRS Product Importer';
  wb.created = new Date();

  const ws = wb.addWorksheet('Product Formulas', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = COLS.map(c => ({ header: c.header, key: c.key, width: c.width }));

  // Header row
  const hRow = ws.getRow(1);
  hRow.height = 24;
  hRow.eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
    cell.border    = { bottom: { style: 'medium', color: { argb: 'FF4A90D9' } } };
  });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: COLS.length } };

  // Data rows
  rows.forEach(r => {
    const row = ws.addRow(COLS.map(c => r[c.key] ?? ''));
    const bg  = CAT_COLORS[r.type] || 'FFFFFFFF';
    row.height = 18;
    row.eachCell({ includeEmpty: true }, cell => {
      cell.font      = { size: 9, name: 'Calibri' };
      cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      cell.alignment = { vertical: 'middle', wrapText: false };
    });

    row.getCell('type').font       = { size: 9, name: 'Calibri', bold: true };
    row.getCell('expression').font = { size: 9, name: 'Courier New' };

    if (r.expression === 'EXCLUDED' || r.expression === 'Direct Input') {
      row.getCell('expression').font = { size: 9, name: 'Courier New', color: { argb: 'FF888888' }, italic: true };
    }
  });

  const outFile = path.join(__dirname, 'Product Formulas.xlsx');
  await wb.xlsx.writeFile(outFile);
  console.log('Written: ' + outFile);
  console.log('Rows: ' + rows.length);
}

main().catch(e => { console.error(e.message); process.exit(1); });
