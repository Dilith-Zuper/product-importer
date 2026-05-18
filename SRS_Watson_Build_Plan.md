# SRS Catalog Configurator — Watson Build Plan
*Full-stack app: Node.js + Express backend + React frontend*
*Built by Watson (Claude Code) against live Zuper + Supabase APIs*

---

## Project Structure

```
srs-configurator/
  server/
    index.js              ← Express entry point
    routes/
      auth.js             ← Step 1-2: tenant setup + verification
      catalog.js          ← Step 3: rule engine + product selection
      preflight.js        ← Step 5: categories, location, tokens, formulas, UOM
      upload.js           ← Step 6: batched product upload
    services/
      zuper.js            ← all Zuper API calls (base URL injected)
      supabase.js         ← SRS catalog queries
      transformer.js      ← SRS product → Zuper payload
      uom.js              ← UOM mapping logic
    middleware/
      session.js          ← stores baseUrl + apiKey in memory per session
  client/
    src/
      App.tsx
      pages/
        Welcome.tsx        ← Step 1: API key + company name
        Catalog.tsx        ← Step 3: onboarding questions
        Review.tsx         ← Step 4: filtered product list
        Preflight.tsx      ← Step 5: validation checklist
        Upload.tsx         ← Step 6: upload progress
      components/
        StepIndicator.tsx
        CategoryGroup.tsx
        ChecklistItem.tsx
        ProgressBar.tsx
      store/
        session.ts         ← global state: baseUrl, apiKey, companyName, products
  .env
  package.json
```

---

## Environment Variables (.env)

```
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
PORT=3000
```

Zuper API key is NOT stored in .env — it is entered by the user at runtime and held in server-side session memory only.

---

## Step 1 — Welcome Screen

**UI:** Two input fields + one button.
- Field 1: "Company Login Name" (the subdomain/login name used to log into Zuper)
- Field 2: "API Key"
- Button: "Connect →"

**On click — two sequential API calls:**

### Call 1 — Resolve base URL
```
POST https://accounts.zuperpro.com/api/config
Headers: content-type: application/json
Body: { "company_name": "<entered_company_name>" }
```

Success response shape:
```json
{
  "type": "success",
  "config": {
    "dc_api_url": "https://us-west-1c.zuperpro.com"
  }
}
```

Extract `config.dc_api_url` → store as `baseUrl` in session.
All subsequent API calls use this `baseUrl`. Never hardcode a region.

Error handling:
- Non-success `type` → "Company not found. Check the login name."
- Network error → "Could not reach Zuper. Check your connection."

### Call 2 — Verify API key
```
GET {baseUrl}/api/user/company
Headers: Authorization: {apiKey}
```

Success: any 2xx response.
Extract `data.company_name` from response → store as `companyName` in session.

Display in UI: green chip → "Connected to {companyName}"

Error handling:
- 401/403 → "Invalid API key."
- Any non-2xx → "Could not verify API key. Check key and try again."

**On success:** store `{ baseUrl, apiKey, companyName }` in session → navigate to Step 3.

---

## Step 2 — Onboarding Questions (Catalog Configuration)

This is the rule engine form. It calls the backend which queries Supabase and runs the 9-step filter pipeline. See the main Product Plan doc for the full question set (Q1–Q12).

**Backend endpoint:**
```
POST /api/catalog/filter
Body: { answers: { q1, q2, q3, ... q12 } }
Response: { products: [...], stats: { total, byCategory } }
```

The backend runs the Supabase queries, applies all filter steps, and returns the filtered product list. The frontend never talks to Supabase directly.

---

## Step 3 — Review Screen

Display filtered products grouped by SRS category. Each category is a collapsible section showing:
- Category name + product count
- List of products: name | brand | color options count | image thumbnail
- Toggle to exclude entire category
- Remove button per product

Bottom bar:
- "Export CSV" → downloads the product list
- "Proceed to Pre-flight →" → navigates to Step 5

Store the approved product list in session state before proceeding.

---

## Step 4 — Pre-flight Checklist

Five sequential checks run automatically when this screen loads. Each check is shown as a checklist item with status: pending → running → pass / fail / created.

Run checks in this exact order. Each check must pass before the next runs.

---

### Check 1 — Product Categories

**Goal:** Ensure all SRS categories in the approved product list exist in Zuper. If missing, create them.

**Step A — Fetch existing categories:**
```
GET {baseUrl}/api/products/category?count=100&page=1&filter.keyword=
Headers: Authorization: {apiKey}
```

Response shape: `{ type, data: [{ category_uid, category_name, ... }] }`

**Step B — Compare:**
Get unique `productCategory` values from the approved product list (from Supabase/SRS).
Compare against `category_name` values from Zuper response (case-insensitive).

Missing categories = SRS categories not found in Zuper.

**Step C — Create missing categories:**
For each missing category:
```
POST {baseUrl}/api/products/category
Headers: Authorization: {apiKey}, Content-Type: application/json
Body:
{
  "product_category": {
    "category_name": "<srs_category_name>",
    "category_description": "",
    "bu_uids": [],
    "parent_category_uid": null
  }
}
```

**Step D — Build category UUID lookup table:**
After all categories exist, build in-memory map:
```javascript
const categoryMap = {
  "SHINGLES": "uuid-from-zuper",
  "UNDERLAYMENT": "uuid-from-zuper",
  // ... all 23 categories
}
```
Store this map in session — needed for product upload payloads.

**UI display:**
```
✓ Product Categories
  Found 8 existing · Created 5 new · 13 total mapped
```

---

### Check 2 — Warehouse Location

**Goal:** Ensure at least one WAREHOUSE location exists. If none, create one.

**Step A — Fetch locations:**
```
GET {baseUrl}/api/products/location?count=100&page=1&filter.keyword=
Headers: Authorization: {apiKey}
```

Response shape: `{ type, data: [{ location_uid, location_name, location_type, ... }] }`

**Step B — Find warehouse:**
Filter `data` where `location_type === "WAREHOUSE"` and `is_deleted === false`.

If found: use `location_uid` of first result. Store in session as `warehouseUid`.

If not found — **Step C — Create warehouse:**
```
POST {baseUrl}/api/products/location
Headers: Authorization: {apiKey}, Content-Type: application/json
Body:
{
  "product_location": {
    "location_access": "ALL",
    "location_name": "Warehouse",
    "location_type": "WAREHOUSE",
    "location_description": "",
    "location_address": {
      "city": "", "street": "", "country": "",
      "state": "", "zip_code": "", "geo_cordinates": [0, 0]
    },
    "allowed_users": []
  }
}
```

Extract `location_uid` from response → store in session as `warehouseUid`.

**UI display:**
```
✓ Warehouse Location
  Using existing "Warehouse" (b94326f2...)
  — or —
  Created new warehouse location
```

---

### Check 3 — Measurement Tokens

**Goal:** Verify the measurement tokens needed for CPQ formulas exist.

**Step A — Fetch measurement categories:**
```
GET {baseUrl}/api/measurements/categories?sort=ASC&sort_by=created_at
Headers: Authorization: {apiKey}
```

Response: `{ type, data: [{ measurement_category_uid, measurement_category_name, measurement_tokens: [...] }] }`

**Step B — Build flat token map:**
Flatten all tokens across all categories:
```javascript
const tokenMap = {}
data.forEach(cat => {
  cat.measurement_tokens?.forEach(token => {
    tokenMap[token.measurement_token_name] = {
      measurement_token_uid: token.measurement_token_uid,
      measurement_category_uid: cat.measurement_category_uid
    }
  })
})
```

**Required tokens** (these must exist for formulas to work):
```javascript
const REQUIRED_TOKENS = [
  "Total Roof Area",
  "Suggested Waste Percentage %",
  "Total Ridge Length",
  "Total Hip Length",
  "Total Valley Length",
  "Total Eave Length",
  "Total Rake Length",
  "Roof Squares"
]
```

**Step C — Create missing tokens:**
For each required token not found in `tokenMap`:

First, find or create a category called "Roofing Measurements":
```
POST {baseUrl}/api/measurements/categories
Headers: Authorization: {apiKey}, Content-Type: application/json
Body: { "measurement_category": { "measurement_category_name": "Roofing Measurements" } }
```

Then create the token in that category:
```
POST {baseUrl}/api/measurements/categories/{category_uid}/tokens
Headers: Authorization: {apiKey}, Content-Type: application/json
Body:
{
  "measurement_token": {
    "measurement_token_name": "<token_name>",
    "uom": "SQFT"
  }
}
```

After creating, add to `tokenMap`.

Store complete `tokenMap` in session — needed for formula payloads.

**UI display:**
```
✓ Measurement Tokens
  Found 6 required tokens · Created 2 missing
```

---

### Check 4 — CPQ Formulas

**Goal:** Ensure required CPQ formulas exist. Create any missing ones.

**Step A — Fetch existing formulas:**
```
GET {baseUrl}/api/invoice_estimate/cpq/formulas?count=1000&page=1
Headers: Authorization: {apiKey}
```

Response: `{ type, data: [{ formula_uid, formula_name, formula_key, ... }] }`

**Step B — Required formula definitions:**

These are the formulas the tool needs. Match by `formula_key`.

```javascript
const REQUIRED_FORMULAS = [
  {
    formula_name: "Roof Squares",
    formula_key: "roof_squares",
    formula_category: "AREA_MEASUREMENT",
    formula_description: "Total roof area in squares",
    formula: {
      expression: "$1 / $2",
      expression_map: [
        {
          key: "$1", type: "MEASUREMENT",
          field_name: "Total Roof Area",
          // UIDs filled from tokenMap at runtime
        },
        { key: "$2", type: "CONSTANT", value: 100 }
      ],
      rounding_mechanism: "NEXT_WHOLE_NUMBER"
    }
  },
  {
    formula_name: "Shingle Bundles",
    formula_key: "shingle_bundles",
    formula_category: "AREA_MEASUREMENT",
    formula_description: "Number of shingle bundles needed",
    formula: {
      expression: "($1 / $2) * $3",
      expression_map: [
        { key: "$1", type: "MEASUREMENT", field_name: "Total Roof Area" },
        { key: "$2", type: "CONSTANT", value: 100 },
        { key: "$3", type: "CONSTANT", value: 3 }
      ],
      rounding_mechanism: "NEXT_WHOLE_NUMBER"
    }
  },
  {
    formula_name: "Synthetic Underlayment (rolls)",
    formula_key: "synthetic_underlayment_rolls",
    formula_category: "AREA_MEASUREMENT",
    formula_description: "Default formula for Synthetic Underlayment (rolls)",
    formula: {
      expression: "$1 / $2",
      expression_map: [
        { key: "$1", type: "MEASUREMENT", field_name: "Total Roof Area" },
        { key: "$2", type: "CONSTANT", value: 1000 }
      ],
      rounding_mechanism: "NO_ROUNDING"
    }
  },
  {
    formula_name: "Ridge Cap Bundles",
    formula_key: "ridge_cap_bundles",
    formula_category: "LINEAR_MEASUREMENT",
    formula_description: "Bundles of ridge cap needed",
    formula: {
      expression: "$1 / $2",
      expression_map: [
        { key: "$1", type: "MEASUREMENT", field_name: "Total Ridge Length" },
        { key: "$2", type: "CONSTANT", value: 35 }
      ],
      rounding_mechanism: "NEXT_WHOLE_NUMBER"
    }
  }
]
```

**Step C — For each required formula:**
Check if `formula_key` exists in fetched formulas.
If missing → create it:
```
POST {baseUrl}/api/invoice_estimate/cpq/formulas
Headers: Authorization: {apiKey}, Content-Type: application/json
Body: {
  formula_name, formula_key, formula_category,
  formula_description,
  formula: {
    expression,
    expression_map: [
      // inject measurement_token_uid + measurement_category_uid from tokenMap
    ],
    rounding_mechanism
  }
}
```

**Important:** Before POSTing, inject the token UIDs from `tokenMap` into `expression_map` entries where `type === "MEASUREMENT"`. Match by `field_name`.

**UI display:**
```
✓ CPQ Formulas
  Found 2 existing · Created 2 new · 4 total
```

---

### Check 5 — Units of Measure

**Goal:** Fetch the Zuper UOM list and confirm all UOMs needed by the product list are supported.

**Step A — Fetch Zuper UOMs:**
```
GET {baseUrl}/api/misc/uom?filter.industry=roofing
Headers: Authorization: {apiKey}
```

Response: `{ status: 200, data: [{ value, label, display_order }] }`

Valid Zuper UOM values:
```
SQ, SQFT, LF, EA, PC, GAL, HR, BDL, PCT, RL, BX, PITCH, INCH
```

**Step B — Build the SRS → Zuper UOM mapping table:**

This is hardcoded in `server/services/uom.js`. One default UOM per SRS product category:

```javascript
const CATEGORY_UOM_MAP = {
  "SHINGLES":             "SQ",
  "UNDERLAYMENT":         "RL",
  "ICE AND WATER":        "RL",
  "HIP AND RIDGE":        "BDL",
  "STARTER":              "BDL",
  "DRIP EDGE":            "PC",
  "VENTS":                "EA",
  "PIPE FLASHING":        "EA",
  "COIL NAILS":           "BX",
  "W-VALLEY":             "RL",
  "GUTTER/ALUMINUM/COIL": "LF",
  "GUTTER APRON":         "LF",
  "SIDING":               "SQ",
  "SKYLIGHTS":            "EA",
  "SPRAY PAINT":          "EA",
  "CAULK":                "EA",
  "OTHER FASTENERS":      "BX",
  "OTHER FLASHING METAL": "PC",
  "PLASTIC CAPS":         "BX",
  "DECKING":              "SQ",
  "TOOLS/SAFETY":         "EA",
  "COMMERCIAL":           "SQ",
  // fallback for anything not mapped:
  "DEFAULT":              "EA"
}

function getUOM(productCategory) {
  return CATEGORY_UOM_MAP[productCategory] || CATEGORY_UOM_MAP["DEFAULT"]
}
```

**UI display:**
```
✓ Units of Measure
  13 Zuper UOMs confirmed · Category mapping loaded
```

---

### Pre-flight Summary Screen

After all 5 checks pass, show a summary panel:

```
✓ Product Categories    13 categories mapped (5 created)
✓ Warehouse Location    "Warehouse" — b94326f2...
✓ Measurement Tokens    8 tokens ready (2 created)
✓ CPQ Formulas          4 formulas ready (2 created)
✓ Units of Measure      13 UOMs confirmed

Ready to upload 1,247 products to Johnson Roofing
```

"Begin Upload →" button proceeds to Step 6.

If any check fails, show it in red with the error message and a "Retry" button for that check only.

---

## Step 5 — Product Upload

### Transformer: SRS product → Zuper payload

`server/services/transformer.js` — one function: `buildZuperPayload(product, variants, categoryMap, warehouseUid)`

**Grouping rule (from main plan):**
```javascript
// Group variants by sizeName
// Each unique sizeName = one Zuper product
// Within each size group, multiple colorNames = options block
```

**Field mapping:**

| Zuper field | Source | Rule |
|---|---|---|
| `product_name` | `product_name` + `size_name` | Append size only if multiple sizes on parent |
| `product_id` | `variant_code` (SKU) | First variantCode in size group e.g. "THDZ-CHAR" |
| `product_category` | `product_category` | UUID from `categoryMap` |
| `brand` | `manufacturer_norm` | Direct; `""` if "Manufacturer Varies" |
| `product_description` | `product_description` | Fallback to `product_features` joined as `<ul>` HTML |
| `product_image` | `variant_image_url` → `product_image_url` | Waterfall; `""` if both null |
| `uom` | `product_category` | Looked up from `CATEGORY_UOM_MAP` |
| `price` | — | Always `0` |
| `purchase_price` | — | Always `0` |
| `quantity` | — | Always `1` |
| `min_quantity` | — | Always `1` |
| `product_type` | — | Always `"PARTS"` |
| `pricing_level` | — | Always `"ROLLUP"` |
| `is_available` | — | Always `true` |
| `is_billable` | — | Always `true` |
| `track_quantity` | — | Always `true` |
| `consider_profitability` | — | Always `true` |
| `is_commissionable` | — | Always `true` |
| `has_custom_tax` | — | Always `false` |
| `bu_uids` | — | Always `null` |

**Options block** (only when multiple colors exist in size group):
```javascript
option: {
  customer_selection: true,
  mandate_customer_selection: false,
  option_label: "Color Selection",
  option_values: variants.map(v => ({
    option_value: v.color_name,
    option_image: v.variant_image_url || "",
    is_available: true
  }))
}
```

**meta_data block** (always include these 4 fields, fixed structure):
```javascript
meta_data: [
  {
    hide_field: false, hide_to_fe: false, id: 0,
    label: "Color", read_only: false, type: "MULTI_LINE",
    dependent_on: "", dependent_options: [], module_name: "PRODUCT", value: ""
  },
  {
    hide_field: false, hide_to_fe: false, id: 1,
    label: "Color Selected", read_only: false, type: "SINGLE_LINE",
    dependent_on: "", dependent_options: [], module_name: "PRODUCT", value: ""
  },
  {
    hide_field: false, hide_to_fe: false, id: 2,
    label: "Color Selection Mandatory", read_only: false, type: "RADIO",
    dependent_on: "", dependent_options: [], module_name: "PRODUCT", value: ""
  },
  {
    hide_field: false, hide_to_fe: false, id: 3,
    label: "Display Color Selection", read_only: false, type: "RADIO",
    dependent_on: "", dependent_options: [], module_name: "PRODUCT", value: ""
  }
]
```

**location_availability block:**
```javascript
location_availability: [{
  location: warehouseUid,
  min_quantity: 1,
  quantity: 1,
  serial_nos: []
}]
```

**tax block:**
```javascript
tax: { tax_exempt: false, tax_name: "", tax_rate: "" }
```

**Complete payload wrapper:**
```javascript
{
  product: { ...all fields above },
  vendor: []
}
```

**Edge cases:**
| Scenario | Handling |
|---|---|
| `selectedOption = "N/A"` (single SKU) | 1 Zuper product, no options block |
| Multiple sizes, single color | N products, no options block each |
| Single size, multiple colors | 1 product with options block |
| Multiple sizes + multiple colors | N products each with options block |
| `product_description` + `product_features` both empty | `product_description: ""` |
| Both image fields null | `product_image: ""` |
| `manufacturer_norm` = "Manufacturer Varies" | `brand: ""` |

---

### Upload Logic

**Backend endpoint:**
```
POST /api/upload/start
Body: {} (uses session state: approved products + categoryMap + warehouseUid)
Response: Server-Sent Events stream for real-time progress
```

**Batching rules:**
- Group approved products into batches of 100
- 3 second delay between each batch
- Each product POSTed individually within a batch (not bulk)
- Rate: sequential within batch, no parallel requests

**Per product upload:**
```
POST {baseUrl}/api/product
Headers: Authorization: {apiKey}, Content-Type: application/json
Body: <zuper_payload from transformer>
```

Success: 2xx response
Failure: log to `failed[]` array, continue with next product

**Progress tracking (Server-Sent Events):**
```javascript
// Server emits these events:
{ type: "progress", imported: 45, total: 1247, current: "GAF Timberline HDZ — Charcoal", failed: 0 }
{ type: "batch_complete", batch: 2, of: 13 }
{ type: "done", imported: 1240, failed: 7, skipped: 0 }
{ type: "error", product_id: "THDZ-CHAR", message: "..." }
```

**Frontend Upload screen UI:**
- Large progress bar: "847 / 1,247 · 68%"
- Live log panel (monospace): scrolling list of recent imports with ✓ / ✗ icons
- Stats panel: Imported · Failed · Batches complete
- Speed note: "Uploading in batches of 100 · 3s between batches"
- On complete: show summary + "View in Zuper ↗" link

**Failed products:**
- Listed separately after upload completes
- "Retry Failed" button → re-runs upload for failed items only
- "Download Failed List" → CSV of failed product names + error messages

---

## API Error Handling (Global Rules)

Apply these consistently across all Zuper API calls:

| HTTP Status | Meaning | Action |
|---|---|---|
| 401 | Invalid/expired API key | Stop + show re-auth prompt |
| 403 | Insufficient permissions | Stop + show permission error |
| 404 | Endpoint not found | Log + skip |
| 429 | Rate limited | Wait 5s + retry (max 3 retries) |
| 5xx | Zuper server error | Wait 2s + retry (max 3 retries) |
| Network error | Connection failed | Show error + retry button |

All Zuper calls must include:
```javascript
headers: {
  "Authorization": apiKey,
  "Content-Type": "application/json"
}
```

---

## Session State Shape

Stored in Express session (in-memory, per browser session):
```javascript
{
  baseUrl: "https://us-west-1c.zuperpro.com",
  apiKey: "eyJ...",
  companyName: "Johnson Roofing",
  approvedProducts: [...],        // from Step 3
  categoryMap: { "SHINGLES": "uuid", ... },  // from Check 1
  warehouseUid: "b94326f2-...",   // from Check 2
  tokenMap: { "Total Roof Area": { uid, categoryUid }, ... }, // from Check 3
  formulaMap: { "roof_squares": "uuid", ... },  // from Check 4
  uploadResults: { imported: 0, failed: [], total: 0 }
}
```

---

## Build Order for Watson

Build in this exact sequence. Test each before moving to next.

1. **Project scaffold** — Express + React, folder structure, .env, package.json, Supabase client
2. **server/services/zuper.js** — all Zuper API wrapper functions (no logic, just HTTP calls)
3. **server/routes/auth.js** — config call + API key verification, session storage
4. **Welcome.tsx** — UI for Step 1, calls auth routes, handles errors
5. **server/services/supabase.js** — catalog query functions (filter pipeline from main plan)
6. **server/routes/catalog.js** — runs filter pipeline, returns product list
7. **Catalog.tsx + Review.tsx** — onboarding form UI + review screen
8. **server/services/uom.js** — UOM mapping table
9. **server/services/transformer.js** — SRS → Zuper payload builder, all edge cases
10. **server/routes/preflight.js** — all 5 checks in sequence
11. **Preflight.tsx** — checklist UI with real-time status per check
12. **server/routes/upload.js** — batched upload with SSE progress stream
13. **Upload.tsx** — progress bar, live log, retry failed, completion screen
14. **End-to-end test** — full flow with a real Zuper test tenant

---

## Resolved Technical Decisions
*From analysis of existing migrate-jn.js codebase*

### 1. ✅ Zuper API key header = `x-api-key`
```javascript
function zuperHeaders(apiKey) {
  return { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
}
```
NOT `Authorization`. Every Zuper API call must use `x-api-key`.

### 2. ✅ base_url format — trailing slash included
The `dc_api_url` from the config response already includes trailing slash handling.
Always construct URLs as: `${baseUrl}/api/product` (add `/api/` prefix to the dc_api_url).

```javascript
// dc_api_url = "https://us-west-1c.zuperpro.com"
// All API calls: `${dc_api_url}/api/product`
// NOT: `${dc_api_url}product`
```

### 3. ✅ Product upload endpoint = `/api/product` (singular)
```javascript
POST ${baseUrl}/api/product
// NOT /api/products
```
Success check: `r.json?.type === 'success' || r.json?.data`

### 4. ✅ `specification` field = always `""`
Empty string. Never populated from product features.

### 5. ✅ `currency` field = always `""`
Empty string throughout.

### 6. ✅ `product_category` in upload payload = `category_uid` (UUID)
From the GET /api/products/category response, use `category_uid` field.
Field may also appear as `product_category_uid` depending on response shape — handle both:
```javascript
cats[0]?.product_category_uid || cats[0]?.category_uid || cats[0]?.uid
```

### 7. ✅ Formula payload wrapper = `formula: { ... }` (not `product_formula`)
```javascript
{
  formula: {
    formula_name: "...",
    formula_key: "...",
    formula_category: "AREA_MEASUREMENT",  // string, not object
    formula_description: "...",
    formula: {
      expression: "...",
      expression_map: [...],
      rounding_mechanism: "NEXT_WHOLE_NUMBER"
    }
  }
}
```

### 8. ✅ Token creation URL = `/api/measurements/categories/{uid}/tokens`
Category creation URL = `/api/measurements/categories`
If category already exists, Zuper returns non-2xx — catch and GET by name to find existing UID.

### 9. ✅ `min_quantity` and `quantity` = `1` for inventory tracking
Use `track_quantity: true`, `min_quantity: 1`, `quantity: 1` for SRS parts.

---

## Reusable Code from migrate-jn.js
*Copy these utilities verbatim into `server/services/zuper.js`*

```javascript
// ─── Constants ────────────────────────────────────────────────────────────────
const BATCH_SIZE     = 10;        // concurrent requests per batch
const BATCH_DELAY_MS = 400;       // ms between batches
const FETCH_TIMEOUT  = 25_000;    // 25s per API call
const RETRY_MAX      = 2;         // 3 total attempts (1 + 2 retries)
const RETRY_BASE_MS  = 800;       // backoff: 800ms, 1600ms

// ─── Headers ──────────────────────────────────────────────────────────────────
function zuperHeaders(apiKey) {
  return { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function stripHtml(str) {
  return String(str || '').replace(/<[^>]+>/g, '')
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function chunks(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ─── Fetch with timeout + retry ───────────────────────────────────────────────
async function fetchJSON(url, opts = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = { raw: text } }
    return { ok: res.ok, status: res.status, json }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Request timed out after ${FETCH_TIMEOUT / 1000}s`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWithRetry(url, opts = {}, attempt = 1) {
  let res
  try {
    res = await fetchJSON(url, opts)
  } catch (e) {
    if (attempt <= RETRY_MAX) {
      await sleep(RETRY_BASE_MS * attempt)
      return fetchWithRetry(url, opts, attempt + 1)
    }
    throw e
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Authentication error (${res.status}) — check API key`)
  }

  if ((res.status === 429 || res.status >= 500) && attempt <= RETRY_MAX) {
    const delay = res.status === 429
      ? RETRY_BASE_MS * attempt * 2
      : RETRY_BASE_MS * attempt
    await sleep(delay)
    return fetchWithRetry(url, opts, attempt + 1)
  }

  return res
}

// ─── Rounding map ─────────────────────────────────────────────────────────────
const ROUNDING_MAP = {
  NoRounding:    'NO_ROUNDING',
  NextWhole:     'NEXT_WHOLE_NUMBER',
  PreviousWhole: 'PREVIOUS_WHOLE_NUMBER',
  RoundOff:      'ROUND_OFF',
}

// ─── Warehouse location ───────────────────────────────────────────────────────
async function ensureWarehouseLocation({ apiKey, baseUrl }) {
  const r = await fetchWithRetry(`${baseUrl}/api/products/location?count=50&page=1`, {
    headers: zuperHeaders(apiKey),
  })
  const locations = r.json?.data || []
  const existing = locations.find(l =>
    l.location_type === 'WAREHOUSE' && !l.is_deleted
  )
  if (existing) return existing.location_uid

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
        allowed_users: [],
      },
    }),
  })
  return cr.json?.data?.location_uid || null
}

// ─── Fuzzy token matching (for Check 3) ──────────────────────────────────────
function normalizeToken(name) {
  return name
    .toLowerCase()
    .replace(/"/g, ' inch ')
    .replace(/'/g, ' foot ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function wordOverlapScore(a, b) {
  const wordsA = new Set(a.split(/\s+/).filter(Boolean))
  const wordsB = new Set(b.split(/\s+/).filter(Boolean))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length
  return (2 * intersection) / (wordsA.size + wordsB.size)
}

function bestZuperMatch(tokenName, defaultTokens) {
  const normName = normalizeToken(tokenName)
  let best = null, bestScore = 0
  for (const t of defaultTokens) {
    const score = wordOverlapScore(normName, normalizeToken(t.measurement_token_name))
    if (score > bestScore) {
      bestScore = score
      best = {
        uid: t.measurement_token_uid,
        name: t.measurement_token_name,
        categoryUid: t.categoryUid,
        score,
      }
    }
  }
  return bestScore >= 0.5 ? best : null  // 0.5 threshold = reasonable fuzzy match
}
```

---

## Updated Build Instructions for Watson

Tell Watson at the start of the session:

> "A reference implementation exists at `./reference/migrate-jn.js`. Before building any Zuper API calls, read that file. Copy `fetchWithRetry`, `fetchJSON`, `zuperHeaders`, `sleep`, `chunks`, `stripHtml`, `ensureWarehouseLocation`, `normalizeToken`, `wordOverlapScore`, and `bestZuperMatch` verbatim into `server/services/zuper.js`. Do not reimplement these — the existing code is battle-tested against the Zuper API."
