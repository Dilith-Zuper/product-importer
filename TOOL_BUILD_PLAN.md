# Zuper SRS Product Importer — Final Build Plan
> Complete specification for Claude Code. No open questions remain. Build exactly as specified.
> Last updated: 2026-05-01

---

## Stack & Project Structure

**Stack:** Next.js 14 (App Router) + TypeScript + Tailwind CSS + Zustand  
**Why:** Modern best practice, API routes solve CORS, server-side Supabase, deploys to Vercel  
**Reference utilities:** Copy `fetchWithRetry`, `fetchJSON`, `zuperHeaders`, `sleep`, `chunks`, `normalizeToken`, `wordOverlapScore`, `bestZuperMatch` verbatim from `sumoquotetozuper` into `lib/zuper-fetch.ts`

```
/zuper-importer
  /app
    /api
      /connect/route.ts         — Step 1: resolve baseUrl + verify API key
      /brands/route.ts          — Step 2: brand list from Supabase
      /preview/route.ts         — Step 3: filtered product list + counts
      /validate/route.ts        — Step 4: SSE stream of 5 preflight checks
      /upload/route.ts          — Step 5: SSE stream of batched product upload
    layout.tsx
    page.tsx                    — Renders <WizardShell />
  /components
    /wizard
      WizardShell.tsx           — Step counter + renders current step
      Step1Connect.tsx
      Step2Brands.tsx
      Step3Preview.tsx
      Step4Validate.tsx
      Step5Upload.tsx
      Step6Done.tsx
    /ui
      BrandTile.tsx
      ProductTable.tsx
      ChecklistItem.tsx         — pending / running / pass / fail states
      ProgressBar.tsx
  /lib
    supabase.ts                 — createClient (server-only, env vars)
    zuper-fetch.ts              — fetchWithRetry, zuperHeaders, helpers (from reference)
    formula-definitions.ts      — All 25 token-formula definitions (pre-computed)
    token-definitions.ts        — 18 required tokens with names + UOMs
    uom-map.ts                  — SRS → Zuper UOM mapping
    category-map.ts             — SRS category name → Zuper display name
    product-builder.ts          — buildProductPayload()
  /store
    wizard-store.ts             — Zustand: all cross-step state
  /types
    wizard.ts                   — WizardState, ValidationResult, UploadSummary
    zuper.ts                    — Zuper API response shapes
  .env.local                    — SUPABASE_URL, SUPABASE_SERVICE_KEY
  package.json
  tsconfig.json
```

---

## Critical API Facts (from reference implementation)

```typescript
// ✅ CORRECT header — NOT Authorization
function zuperHeaders(apiKey: string) {
  return { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
}

// ✅ URL construction — dc_api_url already has no trailing slash
// All calls: `${baseUrl}/api/...`

// ✅ Product endpoint = /api/product (SINGULAR)
// ✅ specification field = always ""
// ✅ currency field = always ""
// ✅ formula_category = always "AREA_MEASUREMENT" for all formulas
// ✅ category_uid field — handle all shapes:
const uid = cat.category_uid || cat.product_category_uid || cat.uid
```

---

## Wizard State

```typescript
// /types/wizard.ts
interface TokenInfo { measurement_token_uid: string; measurement_category_uid: string }

interface WizardState {
  step: 1 | 2 | 3 | 4 | 5 | 6
  // Step 1
  companyLoginName: string
  apiKey: string
  baseUrl: string
  companyName: string
  // Step 2
  selectedBrands: string[]           // manufacturer_norm values
  // Step 3
  filteredProductIds: number[]
  productCounts: { total: number; byCategory: Record<string, number> }
  // Step 4
  categoryMap: Record<string, string>   // srs_category → zuper category_uid
  warehouseUid: string
  tokenMap: Record<string, TokenInfo>   // token_name → { uid, category_uid }
  formulaMap: Record<string, string>    // formula_key → formula_uid
  // Step 5
  uploadSummary: { uploaded: number; skipped: number; errors: UploadError[] }
}

interface UploadError { productName: string; productId: number; message: string }
```

---

## Step 1 — Connect

**UI:** Company login name input + API key input + "Connect →" button

**POST `/api/connect`** body: `{ companyLoginName, apiKey }`

```typescript
// 1. Resolve base URL
const configRes = await fetch('https://accounts.zuperpro.com/api/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json;charset=UTF-8' },
  body: JSON.stringify({ company_name: companyLoginName })
})
const { config } = await configRes.json()
const baseUrl = config.dc_api_url   // e.g. "https://us-west-1c.zuperpro.com"

// 2. Verify API key
const verifyRes = await fetchWithRetry(`${baseUrl}/api/user/company`, {
  headers: zuperHeaders(apiKey)
})
if (!verifyRes.ok) throw new Error('Invalid API key')
const companyName = verifyRes.json?.data?.company_name || verifyRes.json?.company_name
```

**Errors:** company not found → "Company not found" | non-2xx verify → "Invalid API key"  
**On success:** store `{ baseUrl, apiKey, companyName }` → advance to Step 2

---

## Step 2 — Brand Selection

**GET `/api/brands`** — queries Supabase:
```sql
SELECT manufacturer_norm, is_big3_brand,
       COUNT(*) FILTER (WHERE exclude_default = false) as product_count
FROM srs_products
WHERE is_universal = false AND manufacturer_norm IS NOT NULL
  AND manufacturer_norm NOT ILIKE '%manufacturer varies%'
GROUP BY manufacturer_norm, is_big3_brand
ORDER BY product_count DESC
```

**UI layout:**
- **Row 1 — Pre-selected (locked):** GAF, CertainTeed, Owens Corning tiles with checkmark, cannot deselect
- **Row 2 — Top 9 secondary:** IKO, Malarkey, TAMKO, Atlas, Boral, DECRA + top 3 remaining by product count — toggle tiles
- **Row 3 — Search:** text input filters remaining brands, checkbox list
- **Note:** "Universal accessories (drip edge, underlayment, flashings, etc.) are always included"
- **"Continue →"** stores `selectedBrands` (big 3 always included) → Step 3

---

## Step 3 — Product Preview

**POST `/api/preview`** body: `{ selectedBrands }`

```sql
SELECT p.product_id, p.product_name, p.product_category, p.manufacturer_norm,
       p.family_tier, p.proposal_line_item, p.suggested_price,
       p.product_uom, p.product_image_url, p.is_universal
FROM srs_products p
WHERE (p.manufacturer_norm = ANY($1) OR p.is_universal = true)
  AND p.exclude_default = false
ORDER BY p.proposal_line_item NULLS LAST, p.product_name
```

**UI:**
- Summary header: "X products across Y categories"
- Family tier tabs: All | Good | Better | Best | Addon
- Table grouped by `proposal_line_item` with product count per group
- "Confirm & Run Pre-flight Checks →" → store `filteredProductIds` → Step 4

---

## Step 4 — Pre-flight Validation

**GET `/api/validate`** — SSE stream. Emits one event per check:
```typescript
// Event shapes
{ check: 'categories', status: 'running' | 'pass' | 'fail', detail: string }
{ check: 'warehouse',  status: 'running' | 'pass' | 'fail', detail: string }
{ check: 'tokens',     status: 'running' | 'pass' | 'fail', detail: string }
{ check: 'formulas',   status: 'running' | 'pass' | 'fail', detail: string }
{ check: 'uoms',       status: 'running' | 'pass' | 'fail', detail: string }
{ check: 'done', categoryMap, warehouseUid, tokenMap, formulaMap }
```

Run checks **sequentially**. Each must pass before next starts.

---

### Check 1 — Product Categories

```typescript
// Fetch all existing categories (paginate until done)
let allCats = [], page = 1
while (true) {
  const r = await fetchWithRetry(`${baseUrl}/api/products/category?count=100&page=${page}`, {
    headers: zuperHeaders(apiKey)
  })
  allCats.push(...(r.json?.data || []))
  if (allCats.length >= r.json?.total_records) break
  page++
}

// Build lookup: lowercase name → uid
const existing = Object.fromEntries(
  allCats.filter(c => !c.is_deleted)
         .map(c => [c.category_name.toLowerCase(), c.category_uid || c.product_category_uid || c.uid])
)

// Required categories = unique product_category values in filteredProducts
// Use SRS category name directly (SHINGLES, HIP AND RIDGE, etc.)
const requiredCategories = [...new Set(filteredProducts.map(p => p.product_category))]

const categoryMap: Record<string, string> = {}
for (const catName of requiredCategories) {
  if (existing[catName.toLowerCase()]) {
    categoryMap[catName] = existing[catName.toLowerCase()]
  } else {
    // Create it
    const r = await fetchWithRetry(`${baseUrl}/api/products/category`, {
      method: 'POST',
      headers: zuperHeaders(apiKey),
      body: JSON.stringify({
        product_category: {
          category_name: catName,
          category_description: '',
          bu_uids: [],
          parent_category_uid: null
        }
      })
    })
    const uid = r.json?.data?.category_uid || r.json?.data?.product_category_uid
    if (!uid) throw new Error(`Failed to create category: ${catName}`)
    categoryMap[catName] = uid
  }
}
```

---

### Check 2 — Warehouse Location

```typescript
const locRes = await fetchWithRetry(`${baseUrl}/api/products/location?count=100&page=1`, {
  headers: zuperHeaders(apiKey)
})
const warehouse = (locRes.json?.data || []).find(
  l => l.location_type === 'WAREHOUSE' && !l.is_deleted
)

let warehouseUid: string
if (warehouse) {
  warehouseUid = warehouse.location_uid
} else {
  const cr = await fetchWithRetry(`${baseUrl}/api/products/location`, {
    method: 'POST',
    headers: zuperHeaders(apiKey),
    body: JSON.stringify({
      product_location: {
        location_access: 'ALL',
        location_name: 'Warehouse',
        location_type: 'WAREHOUSE',
        location_description: '',
        location_address: { city: '', street: '', country: '', state: '', zip_code: '', geo_cordinates: [0, 0] },
        allowed_users: []
      }
    })
  })
  warehouseUid = cr.json?.data?.location_uid
  if (!warehouseUid) throw new Error('Failed to create warehouse location')
}
```

---

### Check 3 — Measurement Tokens

**18 required tokens** (`/lib/token-definitions.ts`):
```typescript
export const REQUIRED_TOKENS = [
  { name: 'Total Roof Area',             uom: 'SQFT' },
  { name: 'Suggested Waste Percentage %', uom: 'PCT'  },
  { name: 'Total Hip Length',            uom: 'LF'   },
  { name: 'Total Ridges Length',         uom: 'LF'   },
  { name: 'Total Eaves Length',          uom: 'LF'   },
  { name: 'Total Rakes Length',          uom: 'LF'   },
  { name: 'Total Valleys Length',        uom: 'LF'   },
  { name: 'Total Step Flashing Length',  uom: 'LF'   },
  { name: 'Headwall Flashing',           uom: 'LF'   },
  { name: 'Gutter Length',               uom: 'LF'   },
  { name: 'No of Downspouts',            uom: 'EA'   },
  { name: 'No of End Caps',              uom: 'EA'   },
  { name: 'No of Outside Miters',        uom: 'EA'   },
  { name: 'No of Inside Miters',         uom: 'EA'   },
  { name: 'No of Inner Elbows',          uom: 'EA'   },
  { name: 'No of Outer Elbows',          uom: 'EA'   },
  { name: 'Downspout Elbows',            uom: 'EA'   },
  { name: 'Total Siding Area',           uom: 'SQFT' },
]
```

```typescript
// Fetch all measurement categories + tokens
const catRes = await fetchWithRetry(
  `${baseUrl}/api/measurements/categories?sort=ASC&sort_by=created_at`,
  { headers: zuperHeaders(apiKey) }
)

// Flatten all tokens across all categories
const allTokens = []
for (const cat of catRes.json?.data || []) {
  for (const token of cat.measurement_tokens || []) {
    allTokens.push({ ...token, categoryUid: cat.measurement_category_uid })
  }
}

// Build tokenMap using fuzzy matching (from reference: bestZuperMatch)
const tokenMap: Record<string, TokenInfo> = {}
for (const required of REQUIRED_TOKENS) {
  const match = bestZuperMatch(required.name, allTokens)  // uses normalizeToken + wordOverlapScore
  if (match && match.score >= 0.5) {
    tokenMap[required.name] = { measurement_token_uid: match.uid, measurement_category_uid: match.categoryUid }
  }
}

// Create missing tokens in "Roof Measurements" category
const missing = REQUIRED_TOKENS.filter(t => !tokenMap[t.name])
if (missing.length > 0) {
  // Find or create "Roof Measurements" category
  let roofCatUid: string
  const existing = (catRes.json?.data || []).find(
    c => c.measurement_category_name?.toLowerCase() === 'roof measurements'
  )
  if (existing) {
    roofCatUid = existing.measurement_category_uid
  } else {
    const cr = await fetchWithRetry(`${baseUrl}/api/measurements/categories`, {
      method: 'POST',
      headers: zuperHeaders(apiKey),
      body: JSON.stringify({ measurement_category: { measurement_category_name: 'Roof Measurements' } })
    })
    if (cr.ok) {
      roofCatUid = cr.json?.data?.measurement_category_uid
    } else {
      // May already exist — fetch again
      const listRes = await fetchWithRetry(`${baseUrl}/api/measurements/categories?sort=ASC&sort_by=created_at`, { headers: zuperHeaders(apiKey) })
      roofCatUid = (listRes.json?.data || []).find(c => c.measurement_category_name?.toLowerCase() === 'roof measurements')?.measurement_category_uid
    }
    if (!roofCatUid) throw new Error('Failed to find/create Roof Measurements category')
  }

  for (const token of missing) {
    const r = await fetchWithRetry(`${baseUrl}/api/measurements/categories/${roofCatUid}/tokens`, {
      method: 'POST',
      headers: zuperHeaders(apiKey),
      body: JSON.stringify({ measurement_token: { measurement_token_name: token.name, uom: token.uom } })
    })
    const uid = r.json?.data?.measurement_token_uid
    if (!uid) throw new Error(`Failed to create token: ${token.name}`)
    tokenMap[token.name] = { measurement_token_uid: uid, measurement_category_uid: roofCatUid }
  }
}
```

---

### Check 4 — CPQ Formulas

**Formula definitions** (`/lib/formula-definitions.ts`) — all 25 token-formula entries from `proposal_line_items`. The `expression_map` uses `field_name` to look up UIDs from `tokenMap` at runtime.

```typescript
// Helper: build expression_map entry for a measurement token
function meas(fieldName: string) {
  return { type: 'MEASUREMENT' as const, field_name: fieldName }
}
// Helper: build expression_map entry for a constant
function con(value: number) {
  return { type: 'CONSTANT' as const, value }
}

export interface FormulaEntry {
  formula_name: string
  formula_key: string
  formula_description: string
  expression: string
  expression_map: Array<{ type: 'MEASUREMENT'; field_name: string } | { type: 'CONSTANT'; value: number }>
  rounding_mechanism: 'NEXT_WHOLE_NUMBER' | 'NO_ROUNDING'
  proposal_line_items: string[]  // which display_names this formula serves
}

export const FORMULA_DEFINITIONS: FormulaEntry[] = [
  {
    formula_name: 'Shingles (squares)',
    formula_key: 'shingles_squares',
    formula_description: 'Roof area with waste factor, output in squares',
    expression: '($1 * (1 + $2 / $3)) / $4',
    expression_map: [meas('Total Roof Area'), meas('Suggested Waste Percentage %'), con(100), con(100)],
    rounding_mechanism: 'NO_ROUNDING',
    proposal_line_items: ['Shingles'],
  },
  {
    formula_name: 'Hip & Ridge Cap (bundles)',
    formula_key: 'hip_ridge_cap_bundles',
    formula_description: 'Hip + ridge linear footage divided by 33 LF per bundle',
    expression: '($1 + $2) / $3',
    expression_map: [meas('Total Hip Length'), meas('Total Ridges Length'), con(33)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Hip & Ridge Cap'],
  },
  {
    formula_name: 'Starter Strip (bundles)',
    formula_key: 'starter_strip_bundles',
    formula_description: 'Eaves + rakes linear footage divided by 120 LF per bundle',
    expression: '($1 + $2) / $3',
    expression_map: [meas('Total Eaves Length'), meas('Total Rakes Length'), con(120)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Starter Strip'],
  },
  {
    formula_name: 'Underlayment Synthetic (rolls)',
    formula_key: 'underlayment_synthetic_rolls',
    formula_description: 'Roof area with waste, divided by 1000 SQFT per roll (10 SQ)',
    expression: '$1 * (1 + $2 / $3) / $4',
    expression_map: [meas('Total Roof Area'), meas('Suggested Waste Percentage %'), con(100), con(1000)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Underlayment — Synthetic'],
  },
  {
    formula_name: 'Underlayment Felt 15# (rolls)',
    formula_key: 'underlayment_felt_15_rolls',
    formula_description: 'Roof area with waste, divided by 400 SQFT per roll (4 SQ)',
    expression: '$1 * (1 + $2 / $3) / $4',
    expression_map: [meas('Total Roof Area'), meas('Suggested Waste Percentage %'), con(100), con(400)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Underlayment — Felt 15#'],
  },
  {
    formula_name: 'Underlayment Felt 30# (rolls)',
    formula_key: 'underlayment_felt_30_rolls',
    formula_description: 'Roof area with waste, divided by 200 SQFT per roll (2 SQ)',
    expression: '$1 * (1 + $2 / $3) / $4',
    expression_map: [meas('Total Roof Area'), meas('Suggested Waste Percentage %'), con(100), con(200)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Underlayment — Felt 30#'],
  },
  {
    formula_name: 'Underlayment Self-Adhered HT (rolls)',
    formula_key: 'underlayment_ht_rolls',
    formula_description: 'Roof area with waste, divided by 200 SQFT per roll (2 SQ)',
    expression: '$1 * (1 + $2 / $3) / $4',
    expression_map: [meas('Total Roof Area'), meas('Suggested Waste Percentage %'), con(100), con(200)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Underlayment — Self-Adhered HT'],
  },
  {
    formula_name: 'Ice & Water Shield (rolls)',
    formula_key: 'ice_and_water_shield_rolls',
    formula_description: '(Eaves + Valleys) * 1.1 overlap factor / 66 LF per roll',
    expression: '($1 + $2) * $3 / $4',
    expression_map: [meas('Total Eaves Length'), meas('Total Valleys Length'), con(1.1), con(66)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Ice & Water — Standard'],
  },
  {
    formula_name: 'Drip Edge (pieces)',
    formula_key: 'drip_edge_pieces',
    formula_description: 'Rakes + eaves perimeter divided by 10 LF per piece',
    expression: '($1 + $2) / $3',
    expression_map: [meas('Total Rakes Length'), meas('Total Eaves Length'), con(10)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Drip Edge'],
  },
  {
    formula_name: 'W-Valley (pieces)',
    formula_key: 'valley_metal_pieces',
    formula_description: 'Valley length divided by 10 LF per piece',
    expression: '$1 / $2',
    expression_map: [meas('Total Valleys Length'), con(10)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['W-Valley'],
  },
  {
    formula_name: 'Gutter Apron (pieces)',
    formula_key: 'gutter_apron_pieces',
    formula_description: 'Rakes + eaves perimeter divided by 10 LF per piece',
    expression: '($1 + $2) / $3',
    expression_map: [meas('Total Rakes Length'), meas('Total Eaves Length'), con(10)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Gutter Apron'],
  },
  {
    formula_name: 'Coil Nails (boxes)',
    formula_key: 'coil_nails_boxes',
    formula_description: 'Total roof area * 3.2 nails/SQFT / 3600 nails per box',
    expression: '$1 * $2 / $3',
    expression_map: [meas('Total Roof Area'), con(3.2), con(3600)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Coil Nails'],
  },
  {
    formula_name: 'Plastic Cap Nails (boxes)',
    formula_key: 'plastic_cap_nails_boxes',
    formula_description: 'Total roof area divided by 400 SQFT per box',
    expression: '$1 / $2',
    expression_map: [meas('Total Roof Area'), con(400)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Plastic Cap Nails'],
  },
  {
    formula_name: 'Ridge Vents (pieces)',
    formula_key: 'ridge_vents_pieces',
    formula_description: 'Ridge length divided by 4 LF per piece',
    expression: '$1 / $2',
    expression_map: [meas('Total Ridges Length'), con(4)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Ridge Vent'],
  },
  {
    formula_name: 'Gutter Sections (pieces)',
    formula_key: 'gutter_sections_pieces',
    formula_description: 'Gutter length divided by 10 LF per section',
    expression: '$1 / $2',
    expression_map: [meas('Gutter Length'), con(10)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Gutter Sections'],
  },
  {
    formula_name: 'Downspouts (count)',
    formula_key: 'downspouts_count',
    formula_description: 'Direct count from measurement report',
    expression: '$1',
    expression_map: [meas('No of Downspouts')],
    rounding_mechanism: 'NO_ROUNDING',
    proposal_line_items: ['Downspouts'],
  },
  {
    formula_name: 'Gutter End Caps (count)',
    formula_key: 'gutter_end_caps_count',
    formula_description: 'Direct count from measurement report',
    expression: '$1',
    expression_map: [meas('No of End Caps')],
    rounding_mechanism: 'NO_ROUNDING',
    proposal_line_items: ['Gutter End Caps'],
  },
  {
    formula_name: 'Gutter Outside Corners (count)',
    formula_key: 'gutter_outside_corners_count',
    formula_description: 'Direct count from measurement report',
    expression: '$1',
    expression_map: [meas('No of Outside Miters')],
    rounding_mechanism: 'NO_ROUNDING',
    proposal_line_items: ['Gutter Outside Corners'],
  },
  {
    formula_name: 'Gutter Inside Corners (count)',
    formula_key: 'gutter_inside_corners_count',
    formula_description: 'Direct count from measurement report',
    expression: '$1',
    expression_map: [meas('No of Inside Miters')],
    rounding_mechanism: 'NO_ROUNDING',
    proposal_line_items: ['Gutter Inside Corners'],
  },
  {
    formula_name: 'Gutter Elbows (count)',
    formula_key: 'gutter_elbows_count',
    formula_description: 'Sum of all elbow types from measurement report',
    expression: '$1 + $2 + $3',
    expression_map: [meas('Downspout Elbows'), meas('No of Inner Elbows'), meas('No of Outer Elbows')],
    rounding_mechanism: 'NO_ROUNDING',
    proposal_line_items: ['Gutter Elbows'],
  },
  {
    formula_name: 'Step Flashing (pieces)',
    formula_key: 'step_flashing_pieces',
    formula_description: 'Step flashing length divided by 10 LF per piece',
    expression: '$1 / $2',
    expression_map: [meas('Total Step Flashing Length'), con(10)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Step Flashing'],
  },
  {
    formula_name: 'Headwall Flashing (pieces)',
    formula_key: 'headwall_flashing_pieces',
    formula_description: 'Headwall flashing length divided by 10 LF per piece',
    expression: '$1 / $2',
    expression_map: [meas('Headwall Flashing'), con(10)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Counter / Headwall Flashing'],
  },
  {
    formula_name: 'Siding (squares)',
    formula_key: 'siding_squares',
    formula_description: 'Siding area with waste, in squares',
    expression: '$1 * (1 + $2 / $3) / $4',
    expression_map: [meas('Total Siding Area'), meas('Suggested Waste Percentage %'), con(100), con(100)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Siding'],
  },
  {
    formula_name: 'Commercial Membrane (squares)',
    formula_key: 'commercial_membrane_squares',
    formula_description: 'Flat roof area with waste, in squares',
    expression: '$1 * (1 + $2 / $3) / $4',
    expression_map: [meas('Total Roof Area'), meas('Suggested Waste Percentage %'), con(100), con(100)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Commercial Membrane (TPO/EPDM)'],
  },
  {
    formula_name: 'Roof Decking (sheets)',
    formula_key: 'roof_decking_sheets',
    formula_description: 'Roof area divided by 32 SQFT per 4x8 sheet, with waste',
    expression: '$1 / $2 * (1 + $3 / $4)',
    expression_map: [meas('Total Roof Area'), con(32), meas('Suggested Waste Percentage %'), con(100)],
    rounding_mechanism: 'NEXT_WHOLE_NUMBER',
    proposal_line_items: ['Roof Decking (OSB)'],
  },
]
```

**Formula check + create logic:**

```typescript
// Fetch existing
const fRes = await fetchWithRetry(`${baseUrl}/api/invoice_estimate/cpq/formulas?count=1000&page=1`, {
  headers: zuperHeaders(apiKey)
})
const existingFormulas = Object.fromEntries(
  (fRes.json?.data || []).map(f => [f.formula_key, f.formula_uid])
)

const formulaMap: Record<string, string> = { ...existingFormulas }

for (const def of FORMULA_DEFINITIONS) {
  if (existingFormulas[def.formula_key]) continue  // already exists

  // Inject UIDs from tokenMap into expression_map
  const expression_map = def.expression_map.map((entry, idx) => {
    const key = `$${idx + 1}`
    if (entry.type === 'CONSTANT') return { key, type: 'CONSTANT', value: entry.value }
    const tokenInfo = tokenMap[entry.field_name]
    if (!tokenInfo) throw new Error(`Token not found in tokenMap: ${entry.field_name}`)
    return {
      key,
      type: 'MEASUREMENT',
      field_name: entry.field_name,
      measurement_token_uid: tokenInfo.measurement_token_uid,
      measurement_category_uid: tokenInfo.measurement_category_uid,
    }
  })

  const r = await fetchWithRetry(`${baseUrl}/api/invoice_estimate/cpq/formulas`, {
    method: 'POST',
    headers: zuperHeaders(apiKey),
    body: JSON.stringify({
      formula: {
        formula_name: def.formula_name,
        formula_key: def.formula_key,
        formula_category: 'AREA_MEASUREMENT',
        formula_description: def.formula_description,
        formula: {
          expression: def.expression,
          expression_map,
          rounding_mechanism: def.rounding_mechanism,
        }
      }
    })
  })

  const uid = r.json?.data?.formula_uid
  if (!uid) throw new Error(`Failed to create formula: ${def.formula_name} — ${JSON.stringify(r.json)}`)
  formulaMap[def.formula_key] = uid
}
```

---

### Check 5 — UOM Validation (read-only)

```typescript
// /lib/uom-map.ts
export const UOM_MAP: Record<string, string> = {
  BD:  'BDL',  // bundle
  RL:  'RL',   // roll
  PC:  'PC',   // piece
  EA:  'EA',   // each
  BX:  'BX',   // box
  SQ:  'SQ',   // square
  TB:  'EA',   // tube → each (no Zuper equivalent)
  LF:  'LF',   // linear foot
}

// Fetch and verify
const uomRes = await fetchWithRetry(`${baseUrl}/api/misc/uom?filter.industry=roofing`, {
  headers: zuperHeaders(apiKey)
})
const zuperUoms = new Set((uomRes.json?.data || []).map(u => u.value))
const allMapped = Object.values(UOM_MAP).every(v => zuperUoms.has(v))
if (!allMapped) throw new Error('Some UOM values not supported by this Zuper account')
```

---

### Pre-flight Summary UI

```
✓ Product Categories    13 categories ready (3 created)
✓ Warehouse Location    "Warehouse" — b94326f2...
✓ Measurement Tokens    18 tokens ready (2 created in Roof Measurements)
✓ CPQ Formulas          25 formulas ready (12 created)
✓ Units of Measure      All 8 mapped UOMs confirmed

Ready to upload 1,247 products to Johnson Roofing
[Begin Upload →]
```

---

## Step 5 — Product Upload

**GET `/api/upload`** — SSE stream  
Batch: 100 products per batch, 3 seconds between batches, sequential within batch (no parallel)

### `/lib/product-builder.ts` — `buildProductPayload()`

**Proposal line item → formula key lookup:**
```typescript
// Build this map from FORMULA_DEFINITIONS at startup
const PROPOSAL_LINE_ITEM_TO_FORMULA_KEY: Record<string, string> = {}
for (const def of FORMULA_DEFINITIONS) {
  for (const item of def.proposal_line_items) {
    PROPOSAL_LINE_ITEM_TO_FORMULA_KEY[item] = def.formula_key
  }
}
```

**Function signature:**
```typescript
function buildProductPayload(
  product: SrsProduct,
  variants: SrsVariant[],        // unrestricted variants for this product
  categoryMap: Record<string, string>,
  warehouseUid: string,
  formulaMap: Record<string, string>
): ZuperProductPayload
```

**Color options (from variants):**
```typescript
// Deduplicate colors, filter null/empty, exclude "N/A"
const colors = [...new Set(
  variants
    .map(v => v.color_name?.trim())
    .filter(c => c && c !== 'N/A' && c !== 'NA')
)]

const hasColors = colors.length > 1   // only add options if multiple colors

const option = hasColors ? {
  customer_selection: true,
  mandate_customer_selection: false,
  option_label: 'Color Selection',
  option_values: colors.map(c => ({
    option_value: c,
    option_image: variants.find(v => v.color_name?.trim() === c)?.variant_image_url || '',
    is_available: true,
  }))
} : undefined
```

**Image waterfall:**
```typescript
const image = variants.find(v => v.variant_image_url)?.variant_image_url
           || product.product_image_url
           || ''
```

**Formula lookup:**
```typescript
const formulaKey = product.proposal_line_item
  ? PROPOSAL_LINE_ITEM_TO_FORMULA_KEY[product.proposal_line_item]
  : undefined
const formulaUid = formulaKey ? formulaMap[formulaKey] : undefined
```

**UOM:**
```typescript
const zuperUom = UOM_MAP[
  Array.isArray(product.product_uom) ? product.product_uom[0] : product.product_uom
] || 'EA'
```

**Complete payload:**
```typescript
return {
  product: {
    prefix: '',
    product_name: product.product_name,
    product_id: String(product.product_id),
    is_available: true,
    product_category: categoryMap[product.product_category],
    price: product.suggested_price || 0,
    purchase_price: 0,
    min_quantity: 1,
    quantity: 1,
    currency: '',
    product_manual_link: '',
    product_description: product.product_description
      ? `<p>${product.product_description.slice(0, 2000)}</p>`
      : '',
    product_image: image,
    product_type: 'PARTS',
    pricing_level: 'ROLLUP',
    brand: product.manufacturer_norm === 'Manufacturer Varies' ? '' : (product.manufacturer || ''),
    track_quantity: true,
    specification: '',
    has_custom_tax: false,
    formula: formulaUid || null,
    uom: zuperUom,
    is_billable: true,
    consider_profitability: true,
    is_commissionable: true,
    bu_uids: null,
    location_availability: [{
      location: warehouseUid,
      min_quantity: 1,
      quantity: 1,
      serial_nos: [],
    }],
    tax: { tax_exempt: false, tax_name: '', tax_rate: '' },
    markup: null,
    product_files: [],
    meta_data: [
      { hide_field: false, hide_to_fe: false, id: 0, label: 'Color', read_only: false, type: 'MULTI_LINE', dependent_on: '', dependent_options: [], module_name: 'PRODUCT', value: '' },
      { hide_field: false, hide_to_fe: false, id: 1, label: 'Color Selected', read_only: false, type: 'SINGLE_LINE', dependent_on: '', dependent_options: [], module_name: 'PRODUCT', value: '' },
      { hide_field: false, hide_to_fe: false, id: 2, label: 'Color Selection Mandatory', read_only: false, type: 'RADIO', dependent_on: '', dependent_options: [], module_name: 'PRODUCT', value: '' },
      { hide_field: false, hide_to_fe: false, id: 3, label: 'Display Color Selection', read_only: false, type: 'RADIO', dependent_on: '', dependent_options: [], module_name: 'PRODUCT', value: '' },
    ],
    ...(option ? { option } : {}),
  },
  vendor: [],
}
```

### Upload SSE route logic:

```typescript
// Supabase query — products + their variants in one go
const { data: products } = await supabase
  .from('srs_products')
  .select('*, srs_variants!inner(variant_id, color_name, size_name, variant_image_url, is_restricted)')
  .in('product_id', filteredProductIds)
  .eq('srs_variants.is_restricted', false)

// Group variants by product
const variantsByProduct = Map<number, SrsVariant[]>

// Batch + upload
const productBatches = chunks(products, 100)
for (const [i, batch] of productBatches.entries()) {
  for (const product of batch) {
    const payload = buildProductPayload(product, variantsByProduct.get(product.product_id) || [], categoryMap, warehouseUid, formulaMap)
    try {
      const r = await fetchWithRetry(`${baseUrl}/api/product`, {
        method: 'POST',
        headers: zuperHeaders(apiKey),
        body: JSON.stringify(payload),
      })
      if (r.ok && (r.json?.type === 'success' || r.json?.data)) {
        emit({ type: 'progress', status: 'success', productName: product.product_name })
        uploaded++
      } else {
        emit({ type: 'progress', status: 'error', productName: product.product_name, message: JSON.stringify(r.json) })
        errors.push({ productId: product.product_id, productName: product.product_name, message: JSON.stringify(r.json) })
      }
    } catch (e) {
      errors.push({ productId: product.product_id, productName: product.product_name, message: e.message })
    }
  }
  emit({ type: 'batch_complete', batch: i + 1, of: productBatches.length, uploaded, errors: errors.length })
  if (i < productBatches.length - 1) await sleep(3000)
}
emit({ type: 'done', uploaded, skipped: 0, errors })
```

---

## Step 6 — Done

- "Import Complete" heading with company name
- Stats: X uploaded · Y skipped · Z errors
- Error list: product name + error message, copy-to-clipboard button
- "Download Error List" → CSV
- "Start New Import" → reset wizard store to Step 1

---

## Error Handling (Global)

| Status | Action |
|---|---|
| 401 / 403 | Stop + "API key invalid or expired — return to Step 1" |
| 429 | Wait 5s, retry up to 3× |
| 5xx | Wait 2s, retry up to 3× |
| Timeout (25s) | Log + continue (per-product errors don't stop batch) |
| Network error | Show retry button for that check |

All Zuper calls use `fetchWithRetry` from `lib/zuper-fetch.ts` (copied verbatim from `sumoquotetozuper`).

---

## Build Order

Build and test each before moving to next:

1. **Scaffold** — `npx create-next-app@14 zuper-importer --typescript --tailwind --app`; install `@supabase/supabase-js zustand`; create `.env.local`
2. **`lib/zuper-fetch.ts`** — copy utilities verbatim from `sumoquotetozuper`
3. **`lib/formula-definitions.ts`** + **`lib/token-definitions.ts`** + **`lib/uom-map.ts`** — static data files
4. **`store/wizard-store.ts`** — Zustand store
5. **`/api/connect/route.ts`** + **Step1Connect.tsx** — test with real company + key
6. **`/api/brands/route.ts`** + **Step2Brands.tsx** — test brand list loads
7. **`/api/preview/route.ts`** + **Step3Preview.tsx** — test product counts
8. **`/api/validate/route.ts`** — all 5 checks with SSE, test against real Zuper account
9. **Step4Validate.tsx** — checklist UI consuming SSE
10. **`lib/product-builder.ts`** — unit test `buildProductPayload()` with sample data
11. **`/api/upload/route.ts`** + **Step5Upload.tsx** — test with 10 products first
12. **Step6Done.tsx** — summary + error display
13. **End-to-end test** — full flow with real Zuper sandbox account, 1,000+ products
14. **Polish** — loading states, error boundaries, mobile responsiveness

---

## Environment Variables

```bash
# .env.local
SUPABASE_URL=https://kbdczzldmyayliwajwma.supabase.co
SUPABASE_SERVICE_KEY=eyJ...   # service key for server-side queries
```

Zuper API key and baseUrl are **never stored server-side** — passed per-request from browser session (Zustand store, in-memory only).
