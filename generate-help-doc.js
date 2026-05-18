/**
 * Generates two files:
 *   1. catalog-description.txt — short blurb for tool catalogs / Notion pages
 *   2. SRS Importer — Help Article.docx — full CSM help article
 *
 * Run: node generate-help-doc.js
 */
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  BorderStyle, Table, TableRow, TableCell, WidthType, ShadingType,
  UnderlineType, PageBreak, LevelFormat, convertInchesToTwip,
} = require('docx');
const fs = require('fs');

// ─── Catalog description ─────────────────────────────────────────────────────

const catalogDescription = `SRS Product Importer — Zuper Internal Tool

The SRS Product Importer is a Zuper internal tool used by Customer Success Managers during customer onboarding. It connects to a Zuper customer account and imports the full SRS Distribution roofing catalog — products, services, and pricing — in minutes.

What it does:
• Pulls the right SRS products into Zuper based on the brands and trades the contractor works with (roofing, gutters, siding)
• Uploads 28 pre-configured services with slope-based pricing
• Automatically creates Good / Better / Best CPQ proposal templates per brand, pre-loaded with the right products, formulas, and quantities
• Handles ~1,200 products per typical roofing account in a single run

What used to take days of manual Zuper setup now runs in under 10 minutes.

Live at: (Vercel URL)
Internal use only — Zuper Customer Success team.
`;

fs.writeFileSync('catalog-description.txt', catalogDescription);
console.log('✓ catalog-description.txt written');

// ─── Helper style functions ───────────────────────────────────────────────────

const ORANGE = 'F97316';
const DARK   = '1A1A1A';
const GRAY   = '6B7280';
const LIGHT  = 'F5F3F0';
const BORDER_COLOR = 'E5E2DC';

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 120 },
    children: [new TextRun({ text, bold: true, size: 36, color: DARK })],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 320, after: 80 },
    children: [new TextRun({ text, bold: true, size: 26, color: ORANGE })],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 240, after: 60 },
    children: [new TextRun({ text, bold: true, size: 22, color: DARK })],
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    spacing: { before: 60, after: 80 },
    children: [new TextRun({ text, size: 20, color: opts.color ?? GRAY, bold: opts.bold ?? false })],
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    bullet: { level },
    spacing: { before: 40, after: 40 },
    indent: { left: convertInchesToTwip(0.3 + level * 0.25) },
    children: [new TextRun({ text, size: 20, color: DARK })],
  });
}

function note(text) {
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    shading: { type: ShadingType.SOLID, color: 'FFF7ED' },
    border: {
      left: { style: BorderStyle.SINGLE, size: 12, color: ORANGE },
    },
    indent: { left: convertInchesToTwip(0.2) },
    children: [new TextRun({ text: '💡  ' + text, size: 19, color: '92400E', italics: true })],
  });
}

function tip(text) {
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    shading: { type: ShadingType.SOLID, color: 'F0FDF4' },
    border: {
      left: { style: BorderStyle.SINGLE, size: 12, color: '16A34A' },
    },
    indent: { left: convertInchesToTwip(0.2) },
    children: [new TextRun({ text: '✅  ' + text, size: 19, color: '166534', italics: true })],
  });
}

function divider() {
  return new Paragraph({
    spacing: { before: 200, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR } },
    children: [],
  });
}

function stepHeading(num, title) {
  return new Paragraph({
    spacing: { before: 280, after: 60 },
    children: [
      new TextRun({ text: `Step ${num}  `, bold: true, size: 24, color: ORANGE }),
      new TextRun({ text: title, bold: true, size: 24, color: DARK }),
    ],
  });
}

function stepTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(([label, value]) =>
      new TableRow({
        children: [
          new TableCell({
            width: { size: 28, type: WidthType.PERCENTAGE },
            shading: { type: ShadingType.SOLID, color: LIGHT },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 18, color: DARK })] })],
          }),
          new TableCell({
            width: { size: 72, type: WidthType.PERCENTAGE },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: value, size: 18, color: GRAY })] })],
          }),
        ],
      })
    ),
  });
}

function space() {
  return new Paragraph({ children: [], spacing: { before: 80, after: 80 } });
}

// ─── Document ─────────────────────────────────────────────────────────────────

const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: 'Calibri', size: 20, color: DARK },
        paragraph: { spacing: { after: 80 } },
      },
    },
  },
  sections: [{
    properties: {
      page: {
        margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
      },
    },
    children: [

      // ── Cover ──────────────────────────────────────────────────────────────
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 720, after: 200 },
        children: [new TextRun({ text: 'SRS Product Importer', bold: true, size: 52, color: ORANGE })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 160 },
        children: [new TextRun({ text: 'CSM Help Guide', size: 28, color: GRAY })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 720 },
        children: [new TextRun({ text: 'For internal use — Zuper Customer Success team', size: 18, color: GRAY, italics: true })],
      }),
      divider(),

      // ── What is this tool ──────────────────────────────────────────────────
      h2('What is the SRS Product Importer?'),
      body('The SRS Product Importer is a Zuper internal tool that automates the product catalog setup step during roofing contractor onboarding. It connects to a customer\'s Zuper account and populates it with the right products, services, and proposal templates — in minutes, not days.'),
      space(),
      body('Instead of manually creating hundreds of products in Zuper, a CSM runs this wizard once at the start of onboarding. The result is a fully configured Zuper account ready for quoting.', { bold: false }),

      space(),
      h3('What it sets up in one run'),
      bullet('All SRS Distribution products for the selected brands (roofing, gutters, and/or siding)'),
      bullet('Universal accessories — drip edge, underlayment, ice & water, coil nails, flashing, pipe boots, ridge vent, caulk, and more'),
      bullet('28 pre-priced services including slope-based tear-off and installation tiers'),
      bullet('Good / Better / Best CPQ proposal templates per brand, with formulas pre-wired so quantities auto-calculate from measurements'),

      space(),
      tip('A typical roofing account (GAF + CertainTeed + OC + 1–2 secondary brands) runs in under 10 minutes.'),

      divider(),

      // ── Who uses it ────────────────────────────────────────────────────────
      h2('Who uses this tool?'),
      body('Customer Success Managers (CSMs) at Zuper. It is only available to internal Zuper staff — customers do not see or use this tool directly.'),

      divider(),

      // ── Before you start ──────────────────────────────────────────────────
      h2('Before You Start'),
      body('You\'ll need the following for the customer account you\'re onboarding:'),
      space(),
      stepTable([
        ['Company login name', 'The subdomain the customer uses to log into Zuper (e.g. johnson-roofing). Find it in the Zuper admin panel.'],
        ['API key', 'Generate from the customer account: Settings → Developer Hub → API Key → New API Key'],
        ['Brands they carry', 'Ask the customer which shingle brands they use. GAF, CertainTeed, and Owens Corning are always included automatically.'],
        ['Trades in scope', 'Roofing only? Roofing + gutters? Roofing + siding? Confirm before starting.'],
      ]),
      space(),
      note('The API key is only held in memory for this session. It is never saved or logged. You\'ll need to enter it again if you refresh the page.'),

      divider(),

      // ── Step by step ──────────────────────────────────────────────────────
      h2('Step-by-Step Walkthrough'),

      // Step 1
      stepHeading(1, 'Connect to the account'),
      body('Enter the customer\'s company login name and API key. The tool resolves the correct Zuper server for that account automatically.'),
      bullet('Company login name — the subdomain, not the full URL'),
      bullet('API key — paste from Developer Hub'),
      body('Click Connect. If successful you\'ll see the company name confirmed and move to Step 2.'),
      note('If you see "Company not found" — double-check the login name is the short subdomain, not the email or full URL. If you see "Invalid API key" — regenerate the key in Zuper and try again.'),
      space(),
      body('First time here? Need to look up an SRS SKU for a product that\'s already in the account?', { bold: true }),
      body('Use the SRS SKU Fetcher instead — there\'s a link on this page below the Connect button.'),

      space(),

      // Step 2
      stepHeading(2, 'Select trades'),
      body('Choose which trades you\'re importing for this account:'),
      bullet('Roofing — always selected, cannot be deselected'),
      bullet('Gutters — include if the contractor sells gutters through Zuper'),
      bullet('Siding — include if the contractor sells siding through Zuper'),

      space(),

      // Step 3
      stepHeading(3, 'Select brands'),
      body('Choose which manufacturer brands to include for each selected trade.'),
      bullet('GAF, CertainTeed, and Owens Corning are always included for roofing (pre-selected, cannot be removed)'),
      bullet('IKO, Malarkey, TAMKO, Atlas, Boral, and DECRA are shown as quick-select tiles'),
      bullet('Any other brand can be found via the search box — it handles typos (e.g. "malarki" finds Malarkey)'),
      space(),
      tip('Only select brands the contractor actually carries. Adding too many brands creates clutter in Zuper that the customer has to deal with.'),

      space(),

      // Step 4
      stepHeading(4, 'Filter product lines'),
      body('For each selected brand, choose which product lines to include. Non-residential and specialty lines (impact, solar, stone-coated, 3-tab legacy) are unchecked by default.'),
      bullet('Residential lines are pre-selected — this covers most accounts'),
      bullet('Expand the "Specialty / Addon" section if the contractor specifically needs impact or solar products'),
      bullet('Click "Select all" if you want everything for a brand'),

      space(),

      // Step 5
      stepHeading(5, 'Preview the product count'),
      body('Review how many products will be uploaded across which categories before committing. You\'ll see a breakdown by category and family tier (Good / Better / Best / Addon).'),
      bullet('Universal accessories are always included regardless of brand selection — they appear in the count'),
      bullet('If the count looks wrong, go back and adjust brands or product lines'),
      space(),
      note('Products without a suggested price from our customer data will be uploaded with an estimated price based on category medians, tagged as "Estimated" in Zuper. Review and adjust these after import.'),

      space(),

      // Step 6
      stepHeading(6, 'Pre-flight validation'),
      body('The tool runs 7 automatic checks against the Zuper account before uploading. Each check either passes or creates the missing item:'),
      space(),
      stepTable([
        ['Product categories', 'Verifies SRS categories exist in Zuper. Creates any missing ones automatically.'],
        ['Warehouse location', 'Checks a default warehouse exists. Creates one if not.'],
        ['Measurement tokens', 'Verifies the 22 standard measurement tokens exist (roof area, ridge length, slope bands, etc.). Creates missing ones in a "Roof Measurements" category.'],
        ['CPQ formulas', 'Verifies the 33 quantity formulas exist. Creates missing ones.'],
        ['Units of measure', 'Confirms all UOMs (SQ, BD, RL, PC, etc.) are supported.'],
        ['Product Tier field', 'Checks for a "Product Tier" custom field on products. Creates it if missing. (Optional — upload continues without it.)'],
        ['Service categories', 'Checks roofing/gutter/siding service categories exist. Creates if missing. (Optional.)'],
      ]),
      space(),
      body('All checks must pass (or be optional) before you can proceed. If a required check fails, it usually means the API key lacks permissions — regenerate with full access.'),

      space(),

      // Step 7
      stepHeading(7, 'Upload products and services'),
      body('The upload runs in two phases:'),
      bullet('Phase 1 — Products: uploads in batches of 100 with a short pause between batches. You\'ll see product names stream in real time as they upload.'),
      bullet('Phase 2 — Services: uploads the 28 standard roofing/gutter/siding services.'),
      space(),
      body('The upload is safe to re-run. If you\'ve run it before on this account, existing products are updated rather than duplicated.', { bold: true }),
      space(),
      note('Do not close the browser tab during upload. If the connection drops, re-run from Step 1 — the tool will detect existing products and skip or update them automatically.'),

      space(),

      // Step 8
      stepHeading(8, 'Review the results'),
      body('You\'ll see a summary: how many products were created, updated, and if any errors occurred.'),
      bullet('Download the error list as CSV if there are failures — it shows the product name and reason'),
      bullet('Most errors are "duplicate name" or "category not found" — both are safe to ignore or retry'),
      bullet('If more than 5% of products failed, check the API key permissions and retry'),

      space(),

      // Step 9
      stepHeading(9, 'Create proposal templates'),
      body('This final step creates Good / Better / Best CPQ proposal templates in Zuper — one per selected brand.'),
      bullet('Each template includes the brand\'s shingles at each tier, matching accessories, and services'),
      bullet('Formulas are pre-wired so quantities auto-calculate from EagleView or drone measurement reports'),
      bullet('You\'ll need to supply a Job Category UID and Job Status UID from the customer\'s Zuper account to link the template to the right trigger — find these in Zuper → Settings → Job Types'),
      space(),
      tip('Proposal templates can be recreated any time without re-uploading products. If a template needs updating, just re-run Step 9.'),

      divider(),

      // ── What gets uploaded ─────────────────────────────────────────────────
      h2('What Gets Uploaded'),

      h3('Products'),
      body('All products from the SRS Distribution catalog for the selected brands, filtered to the residential product lines you chose, plus the universal accessory set.'),
      space(),
      body('Universal accessories (always included regardless of brand selection):'),
      bullet('Drip edge, step flashing, W-valley metal'),
      bullet('Synthetic underlayment, ice & water shield (standard + high-temp)'),
      bullet('Coil nails, plastic cap nails'),
      bullet('Pipe boots (3" and 4" EPDM + high-temp)'),
      bullet('Ridge vent'),
      bullet('Starter strip'),
      bullet('Caulk / sealant'),
      bullet('Counter / headwall flashing'),

      space(),
      h3('Services (28 total)'),
      bullet('Installation labor, tear-off, shingle installation, flashing, underlayment, venting'),
      bullet('Slope-based tear-off (Low / Standard / Steep / Very Steep)'),
      bullet('Slope-based shingle installation (4 tiers)'),
      bullet('Skylight, chimney flashing, roof deck replacement, EPDM membrane'),
      bullet('Gutter installation, repair, fascia/soffit'),
      bullet('Siding installation'),

      space(),
      h3('Good / Better / Best Proposals'),
      body('One CPQ template per brand, with three options (Good, Better, Best). Each option contains:'),
      bullet('Shingles at the appropriate tier for that brand (e.g. GAF Good = Timberline HDZ; Best = Camelot II)'),
      bullet('Hip & ridge cap, starter, underlayment, ice & water, vents — all brand-specific where available'),
      bullet('Universal accessories (same set in all 3 tiers)'),
      bullet('Brand-specific tier upgrades (e.g. CertainTeed Best includes High Temp ice & water; OC Better/Best includes WoodStart Cool starter)'),
      bullet('All services (slope-based services auto-calculate from measurements)'),

      divider(),

      // ── FAQ ────────────────────────────────────────────────────────────────
      h2('Frequently Asked Questions'),

      h3('The products uploaded but prices look wrong — some show as $0 or unusual amounts.'),
      body('Products with no customer data to reference use an estimated median price based on their category and tier. These are tagged "Estimated (category median)" in Zuper\'s product meta data. Review these with the customer and adjust in Zuper → Products. The most commonly unpriced categories are COMMERCIAL, SIDING, and specialty items.'),

      space(),
      h3('I need to add a brand that\'s not in the quick-select tiles.'),
      body('Use the search box in Step 3. The search handles typos — just type the brand name and it will find it. If the brand truly isn\'t in the catalog, it means SRS doesn\'t stock it.'),

      space(),
      h3('Can I re-run the import if I made a mistake?'),
      body('Yes. Re-running the wizard will update existing products in-place — it will not create duplicates. You can safely change your brand or product line selection and re-run from the beginning.'),

      space(),
      h3('The pre-flight validation failed on "Measurement Tokens" or "CPQ Formulas".'),
      body('This usually means the API key doesn\'t have permission to create measurement categories or formulas. Regenerate the API key in Zuper → Settings → Developer Hub with full access and try again.'),

      space(),
      h3('A product line I need isn\'t showing up in Step 4.'),
      body('Product lines are pulled directly from the SRS catalog. If a line is missing it either: (a) doesn\'t have products in the SRS catalog for that brand, or (b) all products in that line are restricted (private-label for specific accounts). Contact the SRS catalog team if you believe a line is missing.'),

      space(),
      h3('How do I find the Job Category UID and Job Status UID for proposal templates?'),
      body('In the customer\'s Zuper account: Settings → Job Types → select the job type the customer uses for roofing jobs → copy the UID from the URL. For Job Status UID, go to Settings → Job Statuses → find the status that triggers a proposal (usually "Proposal Sent" or "Estimate Requested") → copy the UID.'),

      space(),
      h3('I only need to look up an SRS product ID or SKU for an existing product.'),
      body('Use the SRS SKU Fetcher — accessible from the link on Step 1 of the importer, or directly at the tool URL. It lets you upload a Zuper product export and matches each item to its SRS catalog entry.'),

      divider(),

      // ── Footer ─────────────────────────────────────────────────────────────
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 400, after: 0 },
        children: [new TextRun({ text: 'Built by the Zuper Customer Product Management team', size: 16, color: GRAY, italics: true })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 60, after: 0 },
        children: [new TextRun({ text: 'For questions or issues contact the CPM team in Slack', size: 16, color: GRAY, italics: true })],
      }),

    ],
  }],
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync('SRS Importer — Help Article.docx', buffer);
  console.log('✓ SRS Importer — Help Article.docx written');
}).catch(err => {
  console.error('Error generating docx:', err.message);
  process.exit(1);
});
