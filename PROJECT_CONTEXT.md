# SRS Product Importer — Full Project Context

> **Purpose of this file:** Complete handoff document. Any AI model or developer can read this and continue the project from where it left off. Written: 2026-05-01.

---

## 1. What This Project Is

We are building a **roofing product catalog import and rule engine** for a roofing company's customer onboarding flow (built on Zuper).

The goal: when a roofing customer answers a few questions (roof type, brand preference, job scope), the rule engine automatically assembles the right set of products from the SRS Distribution catalog into their estimate/job.

**Owner:** Dilith — dilith@zuper.co  
**Company:** Zuper Inc.  
**Working directory:** `D:\OneDrive - Zuper,inc\Documents\Projects\product importer`  
**GitHub:** https://github.com/Dilith-Zuper/product-importer (private) — default branch `main`

---

## 2. The Source Data — SRS catalog.json

**File:** `SRS catalog.json` (18M+ tokens, ~500MB)  
**Source:** SRS Distribution (major roofing products distributor)

### Top-level stats
| Stat | Value |
|---|---|
| Total products | 19,807 |
| Total variants (SKUs) | 83,273 (83,047 after dedup) |
| Unique brands | 1,469 (raw), ~305 with 10+ products |
| Unique categories | 23 |
| Duplicate variant IDs | 226 (same productOptionsId under two products — SRS data quality issue, deduped on ingest) |

### Product object schema (14 fields)
```
productId          INTEGER   — unique product ID
productName        TEXT      — always present
productCategory    TEXT      — one of 23 values
manufacturer       TEXT      — brand name (99.9% populated)
productDescription TEXT      — 62.4% populated
productFeatures    string[]  — 47% populated
productUOM         string[]  — always present (e.g. ["SQ","BD","PAL"])
productOptions     string[]  — always present (color/size options, or ["N/A"])
productVariants    object[]  — always present, at least 1
productImageUrl    TEXT|null — 33.1% populated
primaryItem        boolean   — always true for SHINGLES (useless as filter)
isGeneric          boolean   — always false (dead field)
allowSubstitution  boolean   — always false (dead field)
keywords           null      — always null (dead field)
```

### Variant object schema (9 fields)
```
productOptionsId      INTEGER — unique variant ID (PK in DB as variant_id)
variantCode           TEXT    — the SKU code
orderUOM              TEXT    — default ordering unit
uoMs                  string[]— all valid units for this SKU
selectedOption        TEXT    — option text that created this variant ("N/A" if none)
colorName             TEXT    — 84.3% populated
sizeName              TEXT    — 97.4% populated
variantImageURL       TEXT|null — 37.7% populated
customerRestrictions  TEXT    — 0.6% populated; account codes (e.g. "LENNAR", "S012330")
                                 — restricted variants excluded from all exports/queries
```

### 23 Product Categories
| Category | Products | Notes |
|---|---|---|
| COMMERCIAL | 4,688 | Flat/low-slope roofing — TPO, EPDM, insulation, coatings |
| OTHER | 2,801 | Solar racking, tile accessories, misc catch-all |
| SIDING | 2,438 | Vinyl, fiber cement, LP SmartSide, trim |
| TOOLS/SAFETY | 1,784 | Contractor tools — EXCLUDE from customer catalog |
| OTHER FASTENERS | 1,596 | Screws, nails, clips — auto-include |
| OTHER FLASHING METAL | 1,241 | Step/counter/chimney flashing, coil stock, flat sheet |
| GUTTER/ALUMINUM/COIL | 1,230 | Gutter systems, downspouts, coil |
| VENTS | 732 | Ridge, box, power, tile vents |
| PIPE FLASHING | 566 | Pipe boots/jacks by diameter |
| DECKING | 520 | Mostly composite deck (Trex/TimberTech) — NOT roofing OSB |
| DRIP EDGE | 505 | All profiles, colors, gauges |
| UNDERLAYMENT | 261 | Synthetic, felt, self-adhered HT |
| SKYLIGHTS | 229 | VELUX dominates 71% |
| CAULK | 206 | 68% general sealants, ~30% roofing-specific |
| SHINGLES | 195 | Architectural, impact, designer, solar, tile |
| HIP AND RIDGE | 173 | Cap shingles — linked to shingle brand/color |
| ICE AND WATER | 137 | Self-adhered ice & water shield |
| W-VALLEY | 125 | Pre-formed valley metal |
| COIL NAILS | 113 | For pneumatic nailers |
| STARTER | 106 | Starter strip shingles — linked to shingle brand |
| SPRAY PAINT | 105 | Touch-up aerosols — auto-link to trim color |
| GUTTER APRON | 35 | |
| PLASTIC CAPS | 21 | Cap nails for underlayment/housewrap |

---

## 3. Supabase Database

**Project URL:** `https://kbdczzldmyayliwajwma.supabase.co`  
**Project Ref:** `kbdczzldmyayliwajwma`  
**Region:** Asia Pacific (ap-southeast-1 / Singapore — IPv6 only for direct DB connection)

### Connection notes
- Direct TCP port 5432 to `db.[ref].supabase.co` is **IPv6 only** — won't work from most dev environments
- Use **Supabase JS client over HTTPS** (REST API) for all operations — confirmed working
- The `.env` key labeled `SUPABASE_SERVICE_KEY` is actually the **anon key** — works because RLS is disabled on all tables
- DB password is in `.env` as `SUPABASE_DB_PASSWORD` — needed for direct pg connections from local machine

### .env file
```
SUPABASE_URL=https://kbdczzldmyayliwajwma.supabase.co
SUPABASE_SERVICE_KEY=eyJ...  (anon key — works because RLS off)
SUPABASE_DB_PASSWORD=BETTERDAYScoming@007
CATALOG_VERSION=2025-05-01
```

---

## 4. Database Tables

### Table 1: `srs_products` (19,807 rows)
```sql
CREATE TABLE srs_products (
  product_id          INTEGER PRIMARY KEY,
  product_name        TEXT NOT NULL,
  product_category    TEXT NOT NULL,
  manufacturer        TEXT,                    -- original brand name
  manufacturer_norm   TEXT,                    -- title case normalized (e.g. "Gaf", "Certainteed")
  product_description TEXT,
  product_features    JSONB,                   -- array of bullet points
  product_uom         JSONB,                   -- array of valid units
  product_options     JSONB,                   -- array of option values
  product_image_url   TEXT,
  primary_item        BOOLEAN DEFAULT FALSE,
  is_generic          BOOLEAN DEFAULT FALSE,
  allow_substitution  BOOLEAN DEFAULT FALSE,
  is_private_label    BOOLEAN DEFAULT FALSE,   -- not yet populated, all false
  exclude_default     BOOLEAN DEFAULT FALSE,   -- not yet populated, all false
  catalog_version     TEXT,                    -- "2025-05-01"
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  product_line        TEXT,                    -- enriched field: product line/family name
  family_tier         TEXT,                    -- good / better / best / addon (proposal tier)
  proposal_line_item  TEXT,                    -- which proposal line item this product maps to
  is_universal        BOOLEAN DEFAULT FALSE,   -- load for every account regardless of brand
  is_big3_brand       BOOLEAN DEFAULT FALSE,   -- GAF / CertainTeed / Owens Corning
  suggested_price     NUMERIC(10,2),           -- median sell price from real customer data
  accessory_tier      TEXT                     -- good_accessory / better_accessory / best_accessory (NULL for non-better products)
);
```

**Indexes:** product_category, manufacturer_norm, exclude_default, accessory_tier

**Key notes:**
- `manufacturer_norm` = title case version of brand (ALCO→Alco, GAF→Gaf, "Manufacturer Varies by Location"→"Manufacturer Varies")
- `product_line` = enriched field populated by `enrich-product-line.js` — 19,806/19,807 rows populated
- `family_tier` = proposal tier populated by `enrich-family-tier.js` — all 19,807 rows populated (good: 1,875 | better: 14,750 | best: 124 | addon: 3,058)
- `accessory_tier` = sub-tier for the 14,750 `better` products only — populated by `enrich-accessory-tier.js` using price-quartile bands within (product_category, manufacturer_norm). Values: good_accessory (781) / better_accessory (13,066) / best_accessory (903). NULL for all non-better products. Use this to differentiate accessories across G/B/B proposal tiers.
- `proposal_line_item` = which proposal line item this product maps to — populated by `enrich-proposal-line-item.js`
- `is_universal = true` for 6,873 products — accessories loaded for every account regardless of brand (UNDERLAYMENT, ICE AND WATER, DRIP EDGE, W-VALLEY, COIL NAILS, PLASTIC CAPS, VENTS, PIPE FLASHING, CAULK, SPRAY PAINT, OTHER FASTENERS, OTHER FLASHING METAL, GUTTER/ALUMINUM/COIL, GUTTER APRON)
- `is_big3_brand = true` for 1,133 products — GAF, CertainTeed, Owens Corning (auto-loaded for every account)
- `suggested_price` = median sell price derived from 54 real customer accounts — populated for 5,646 products
- `exclude_default` and `is_private_label` are all false — placeholders for rule engine logic
- `keywords` from source always null — not imported

### Table 2: `srs_variants` (83,047 rows — 226 duplicates removed)
```sql
CREATE TABLE srs_variants (
  variant_id            INTEGER PRIMARY KEY,   -- productOptionsId from source
  product_id            INTEGER REFERENCES srs_products(product_id) ON DELETE CASCADE,
  variant_code          TEXT NOT NULL,          -- the SKU
  order_uom             TEXT,
  color_name            TEXT,
  size_name             TEXT,
  selected_option       TEXT,
  variant_image_url     TEXT,
  uoms                  JSONB,                  -- all valid units
  customer_restrictions TEXT DEFAULT '',        -- account codes; non-empty = restricted
  is_restricted         BOOLEAN DEFAULT FALSE,  -- true when customer_restrictions non-empty
  is_private_label      BOOLEAN DEFAULT FALSE,
  catalog_version       TEXT
);
```

**Indexes:** product_id, color_name, size_name, is_restricted, catalog_version

**Key notes:**
- 480 variants have `is_restricted = true` — these are private/account-specific SKUs (e.g. LENNAR, S012330)
- Always filter `is_restricted = false` in customer-facing queries
- 226 duplicate `productOptionsId` values in source — resolved by keeping last occurrence (Map dedup)

### Table 3: `srs_product_families` (474 rows)
```sql
CREATE TABLE srs_product_families (
  product_id        INTEGER PRIMARY KEY REFERENCES srs_products(product_id),
  manufacturer_norm TEXT NOT NULL,
  family_name       TEXT NOT NULL,   -- the product line/family (e.g. "Timberline HDZ")
  family_tier       TEXT,            -- flagship / premium / designer / specialty
  is_default        BOOLEAN DEFAULT FALSE  -- one true per family = the "hero" product
);
```

**Indexes:** manufacturer_norm, family_name

**Coverage:** Only SHINGLES, HIP AND RIDGE, and STARTER categories (474 products)
**Tier definitions:**
- `flagship` — current main product line (e.g. Timberline HDZ, Landmark PRO, Duration)
- `premium` — upgraded/newer tier (e.g. Timberline UHDZ, Duration MAX)
- `designer` — dimensional/premium look (e.g. Grand Sequoia, Presidential Shake)
- `specialty` — impact, solar, cool roof, legacy (e.g. ArmorShield II, XT 25, Royal Sovereign)

---

## 5. Scripts — What Each Does

| Script | Purpose | Status |
|---|---|---|
| `create-tables.js` | Creates srs_products, srs_variants + indexes via pg client | Done (tables now created manually via SQL Editor) |
| `ingest.js` | Streams SRS catalog.json → Supabase via REST API (stream-json, no OOM) | Done, full 19,807 products ingested |
| `classify-families.js` | Classifies SHINGLES/H&R/STARTER into product families → srs_product_families | Done, 474 rows. Boral catch-all removed — unmatched Boral surfaces in warning report. |
| `enrich-product-line.js` | Populates product_line column on srs_products for all 19,807 products | Done, 19,806/19,807 populated. Supports --log-changes audit flag. |
| `enrich-family-tier.js` | Populates family_tier column on srs_products for all 19,807 products | Done — good/better/best/addon. Supports --log-changes audit flag. |
| `enrich-proposal-line-item.js` | Classifies all 19,807 products into proposal line items | Done. Pipe-flashing now classified by max variant count, not first-presence. Supports --log-changes. |
| `enrich-account-load-flags.js` | Populates is_universal, is_big3_brand, suggested_price on srs_products | Done. Supports --log-changes audit flag. |
| `enrich-accessory-tier.js` | Populates accessory_tier column — price-quartile split of the 14,750 "better" products | Done — 781 good / 13,066 better / 903 best. Run: `node enrich-accessory-tier.js [--dry-run] [--log-changes]` |
| `find-accessory-gaps.js` | Queries Supabase for candidate products for any missing accessory slot | Utility — run ad-hoc when accessory catalog needs a new ID |
| `generate-help-doc.js` | Generates `catalog-description.txt` + `SRS Importer — Help Article.docx` | Run: `node generate-help-doc.js` — outputs both files to project root |
| `lib/utils.js` | Shared helpers: fetchAll(), upsertInBatches(), makeChangeLogger() | Used by all 4 enrich scripts |
| `analyze-categories.js` | Runs stats on all 16 roofing categories (products, brands, colors, sizes, UOMs) | Analysis complete |
| `query-shingles.js` | Queries SHINGLES by brand (GAF/CertainTeed/OC) — count, variants, sample products | Done |
| `query-gaf.js` | GAF-specific: all product lines, primaryItem breakdown | Done |
| `export-excel.js` | Full DB export — all 3 tables, 3 sheets, 19,807 products + 82,567 variants | Done → SRS Catalog Export.xlsx |
| `export-roofing.js` | Roofing materials export — 14 categories, one sheet per category | Done → SRS Roofing Catalog.xlsx |
| `export-atlas-catalog.js` | Atlas brand only — 65 products, single sheet | Done → Atlas Roofing Catalog.xlsx |
| `export-brandwise.js` | One Excel per brand (10+ products) — 304 files in brandwise catalog/ | Done, includes Product Line + Tier columns from DB |
| `generate-formula-sheet.js` | Generates Product Formulas.xlsx — 31 formula definitions with Zuper tokens | Done |
| `setup-proposal-line-items.js` | Creates and populates proposal_line_items table — 41 line items | Done |

### ingest.js key logic
- **Streams** the JSON via `stream-json` package — processes products as they arrive, peak memory <1GB (vs 1-2GB for full JSON.parse of the 500MB file)
- Deduplicates variants by productOptionsId (226 duplicates)
- Normalizes manufacturer_norm to title case
- "Manufacturer Varies…" → "Manufacturer Varies" (canonical)
- Deletes all rows before re-ingesting (clean slate)
- Upserts products in batches of 100, variants in batches of 500
- Set `DRY_RUN_LIMIT = Infinity` for full run, 50 for dry run

### Enrichment scripts — shared patterns (lib/utils.js)
All enrich scripts use shared helpers from `lib/utils.js`:
- `fetchAll(supabase, table, select, opts)` — paginated read past the 1000-row Supabase cap
- `upsertInBatches(supabase, table, rows, opts)` — batched upsert with progress callback
- `makeChangeLogger({ enabled, scriptName })` — per-row diff capture; activated with `--log-changes` flag, writes a timestamped JSON file showing every (product_id, field, old, new) change

Re-running any enrichment script is safe (idempotent). Pass `--log-changes` if you want an audit log of what actually changed.

---

## 6. Key Analysis Findings

### Shingles — Big 3 brands
| Brand | Products | Variants | Manufacturer Norm |
|---|---|---|---|
| CertainTeed | 35 | 260 | `Certainteed` |
| GAF | 35 | 196 | `Gaf` |
| Owens Corning | 33 | 230 | `Owens Corning` |

**Important:** `primaryItem = true` on ALL shingle products from all 3 brands — this flag is useless for filtering. Do not use it.

### GAF Product Families (SHINGLES)
- Flagship: Timberline HDZ (9 products), Timberline HD (6)
- Premium: Timberline UHDZ (2), Timberline Ultra HD (3)
- Designer: Grand Sequoia (4), Camelot, Grand Canyon, Slateline, Woodland
- Specialty: Royal Sovereign (3-tab), ArmorShield II (impact), Solar HDZ, Cool Series, Natural Shadow, American Harvest

### CertainTeed Product Families (SHINGLES)
- Flagship: Landmark (2), Landmark PRO (3)
- Premium: Belmont (2), Landmark Premium (2)
- Designer: Presidential Shake (7), Grand Manor, Highland Slate, Carriage House, Hatteras
- Specialty: NorthGate, Landmark IR/ClimateFlex/TL/Solaris, XT 25, IR XT 30, Patriot, Solstice

### Owens Corning Product Families (SHINGLES)
- Flagship: Duration (4), Oakridge (4)
- Premium: Duration MAX (4), Duration Premium (2), Woodcrest (3), Woodmoor (4)
- Designer: Berkshire, Duration Designer (2)
- Specialty: Duration Cool (2), Duration FLEX (2), Duration STORM, Supreme (4)

### Recommended defaults per brand
- GAF → `GAF Timberline HDZ StainGuard AR Shingles`
- CertainTeed → `CertainTeed Landmark PRO AR Shingles`
- Owens Corning → `Owens Corning TruDefinition Duration AR Shingles`

### Atlas — Full product catalog (65 products across 9 categories)
- COMMERCIAL: 20 (ACFoam insulation, EnergyShield, drains)
- TOOLS/SAFETY: 10 (gloves — different Atlas company, coincidental brand name)
- VENTS: 9 (HighPoint, TruRidge ridge vents, power vents)
- HIP AND RIDGE: 7 (Pro-Cut, ProLam, StormMaster H&R)
- SHINGLES: 6 (Pinnacle Pristine HP42 SG — 19 colors, Pinnacle Impact IR — 6 colors, Pinnacle Cool Sun — 6 colors, ProLam HP42, StormMaster, GlassMaster)
- UNDERLAYMENT: 6 (Summit, Gorilla Guard, 30# felt)
- STARTER: 3 (Pro-Cut HP42, Universal 9XR)
- ICE AND WATER: 3 (WeatherMaster)
- OTHER FASTENERS: 1 (Nail Base Fasteners)

All Pinnacle shingles: size 14" x 42", order UOM = BD (Bundle), all have images and descriptions.

### customerRestrictions — Critical finding
- 480 of 83,273 variants have non-empty customerRestrictions
- Values are account codes: `LENNAR`, `S012330`, `FVH247`, etc.
- These are private/locked SKUs for specific contractor accounts
- Always filter `is_restricted = false` in any customer-facing query

---

## 7. Rule Engine Selection Strategy

Based on full category analysis, here is the master strategy:

| Strategy | Categories | Onboarding question |
|---|---|---|
| **Universal** | COIL NAILS, ICE AND WATER | "Re-roof or tear-off?" / "Is ice & water required?" |
| **Linked / auto** | HIP AND RIDGE, STARTER, SPRAY PAINT, CAULK (filtered), OTHER FASTENERS | None — backend resolves from other selections |
| **Type-based** | UNDERLAYMENT, VENTS, PIPE FLASHING | "What type?" multi-select |
| **Color-based** | DRIP EDGE, W-VALLEY | "What color?" picker |
| **Gated scope** | SKYLIGHTS, GUTTER/ALUMINUM/COIL, SIDING | "Is this in scope?" gate question |
| **Exclude** | TOOLS/SAFETY | Never shown to customers |

### Linking rules
- HIP AND RIDGE → auto-select from shingle brand + color match
- STARTER → auto-select from shingle brand
- SPRAY PAINT → auto-link to selected trim/metal color
- CAULK → filter to roofing-specific only (exclude general silicone/latex)
- DRIP EDGE color → must match GUTTER color
- PIPE FLASHING → include standard 2", 3", 4" by default; gate 6"+ behind question

### Metal roofing (buried — no dedicated category)
- Stone-coated steel: DECRA (46 products) and Tilcor (36) — complete systems across OTHER, OTHER FLASHING METAL, VENTS, SHINGLES, etc.
- Standing seam: very thin (1 actual panel — ASC Skyline); catalog not suited for standing seam contractors
- Gate behind: "Is this a stone-coated steel roof?" → pulls DECRA/Tilcor ecosystem

---

## 8. Product Line Enrichment

**Column:** `srs_products.product_line TEXT` (added via ALTER TABLE)

**Population logic:**
1. 474 products with entries in `srs_product_families` → use `family_name` (exact, from manual classification)
2. Remaining 19,333 products → extracted from product name: strip brand prefix, take 2-3 meaningful words

**Status:** 19,806/19,807 products populated (1 has blank name, stored null — acceptable)

**Script:** `enrich-product-line.js` — uses upsert in batches of 500 (40 total API calls, ~2 min runtime)

---

## 8b. Family Tier Enrichment

**Column:** `srs_products.family_tier TEXT` (added via ALTER TABLE)

**4 tier values:** `good` | `better` | `best` | `addon`

**Classification priority:**
1. Brand + product line rules (e.g. Gaf + "Timberline HDZ" → good, Gaf + "Grand Sequoia" → best)
2. Category keyword rules (e.g. UNDERLAYMENT with "felt" → addon, "synthetic" → good, "high temp" → better)
3. Default → `better` (commodity items that go into all 3 proposals)

**Key decisions:**
- `good` = current standard entry product ONLY (no legacy/prior-gen)
- `better` = default for all accessories — they appear in every proposal regardless of tier
- `best` = premium/designer shingles, luxury products
- `addon` = legacy gen, specialty (impact/solar/cool variants), ALL tile and stone-coated systems (DECRA, Boral, Tilcor, Tesla, DaVinci, Brava, Eagle, etc.), category-wide exclusions like SKYLIGHTS and TOOLS/SAFETY

**Status:** All 19,807 products populated (good: 1,875 | better: 14,750 | best: 124 | addon: 3,058)

**Script:** `enrich-family-tier.js` — same upsert pattern as product line, 40 batches of 500

---

## 9. Exports & Documents — Files on Disk

| File | Location | Contents |
|---|---|---|
| `SRS Catalog Export.xlsx` | Project root | Full DB — Products (19,807), Variants (82,567), Families (474) — 3 sheets |
| `SRS Roofing Catalog.xlsx` | Project root | 14 roofing categories, one sheet per category, products only |
| `Atlas Roofing Catalog.xlsx` | Project root | 65 Atlas products, single sheet with Category + Product Line |
| `Atlas Catalog.xlsx` | Project root | Old version (wrong — had 5,858 items) — ignore/delete |
| `Atlas Catalog v2.xlsx` | Project root | Interim version — superseded by Atlas Roofing Catalog.xlsx |
| `brandwise catalog/` | Project root | 304 brand Excel files, one per brand with 10+ products — includes Product Line + Tier columns |
| `Product Formulas.xlsx` | Project root | 31 formula definitions for all categories — Zuper token expressions, UOM, notes |
| `SRS Importer — Help Article.docx` | Project root | Full CSM help guide — 9-step walkthrough, prerequisites, FAQ, what gets uploaded. Regenerate: `node generate-help-doc.js` |
| `catalog-description.txt` | Project root | Short blurb (3–4 sentences) describing the tool — for Notion pages, tool catalogs, Slack pins. Regenerate: `node generate-help-doc.js` |

### Excel column structure (all brand catalogs)
Category | Brand | Product Line | Tier | Product Name | # Variants | Available Colors | Available Sizes | Order UOM(s) | Sample SKUs | Product UOM | Description | Image URL

### brandwise catalog/ folder
- 303 files, named `{Brand} Catalog.xlsx`
- Covers all brands with 10+ products, excludes "Manufacturer Varies"
- Product Line pulled from `srs_products.product_line` (DB column, not computed)
- Sorted by Category → Product Name within each file
- Alternating row colors, frozen header, auto-filter on all columns

---

## 10. UOM Reference

Key unit codes used throughout the catalog:
| Code | Meaning |
|---|---|
| SQ | Square (100 sq ft — roofing standard) |
| BD | Bundle |
| PAL | Pallet |
| RL | Roll |
| PC | Piece |
| EA | Each |
| CTN | Carton |
| BX | Box |
| LF | Linear Foot |
| TB | Tube |
| 5G | 5 Gallon |
| BAG | Bag |
| MSF | Thousand Square Feet |
| MLF | Thousand Linear Feet |

PAL is on almost every variant as a secondary unit — it's the pallet-quantity ordering tier.

---

## 11. Technical Stack

| Component | Technology |
|---|---|
| Runtime | Node.js (Windows 11, bash shell) |
| DB client | `@supabase/supabase-js` v2.105.1 (REST API over HTTPS) |
| Excel generation | `exceljs` |
| Data analysis | Python 3 (py launcher) for catalog.json analysis |
| Database | Supabase (PostgreSQL) — project kbdczzldmyayliwajwma |
| Storage | OneDrive synced — `D:\OneDrive - Zuper,inc\Documents\Projects\product importer\` |

**Note:** `pg` (direct PostgreSQL client) is installed but cannot connect from this environment — Supabase DB host is IPv6-only and this dev environment has no IPv6 routing. All DB operations use Supabase JS client over HTTPS.

---

## 12. What's Done vs What's Next

### ✅ Done
- [x] SRS catalog.json fully analyzed (structure, brands, categories, colors, sizes, UOMs)
- [x] All 3 Supabase tables created and populated
- [x] Full 19,807 products ingested with 83,047 variants
- [x] manufacturer_norm normalized to title case
- [x] 226 duplicate variant IDs handled
- [x] 480 restricted variants flagged
- [x] Product family classification (474 SHINGLES/H&R/STARTER products)
- [x] product_line column enriched for all 19,807 products
- [x] Full category analysis (16 categories — strategy, colors, sizes, brands)
- [x] Rule engine selection strategy defined for all 16 categories
- [x] Excel exports: full catalog, roofing catalog, Atlas catalog, 303 brandwise catalogs
- [x] brandwise catalog/ folder with Product Line + Tier columns from DB
- [x] family_tier enrichment — all 19,807 products tagged good/better/best/addon
- [x] Product quantity formulas defined for all 23 categories — Product Formulas.xlsx with Zuper token expressions
- [x] proposal_line_items table created — 41 line items with formulas, UOMs, gate questions
- [x] All 19,807 products classified into proposal line items
- [x] is_universal flag — 6,873 accessory products marked for auto-load on every account
- [x] is_big3_brand flag — 1,133 GAF/CertainTeed/OC products marked for auto-load
- [x] suggested_price — 5,646 products priced from real customer data medians (54 accounts)
- [x] accessory_tier column — 14,750 "better" products sub-classified by price quartile into good_accessory/better_accessory/best_accessory
- [x] Zuper importer wizard (see §17) — fully deployed at Vercel, all P0/P1/P2 items addressed
- [x] Accessory catalog gaps filled — Counter/Headwall Flashing (75999) + Plastic Cap Nails (79219) added
- [x] Brand-specific tier-upgrade rules — CertainTeed Best → HT Ice & Water; OC Better/Best → WoodStart Cool starter
- [x] Slope token formulas wired to service line items — 4 slope tokens + 8 slope-band formulas auto-route quantities
- [x] Pricing fallback for zero-priced products — category-tier medians applied at upload time
- [x] Upload idempotency — re-runs PUT existing products instead of creating duplicates
- [x] Pipeline utilities consolidated — lib/utils.js shared across all enrichment scripts
- [x] Streaming JSON ingest — stream-json package, no OOM on large catalogs
- [x] Audit log on all enrichment scripts — --log-changes flag writes timestamped diff file
- [x] Select all / Deselect all toggle on Step 3 Gutters and Siding tabs (operates on full brand list, search-filter agnostic)
- [x] Step 4 Preview back-navigation fixed — two text links: back to product lines (step 4) and back to brand selection (step 3); the prior single button was mislabeled and went to product lines
- [x] SRS category name sanitization for Zuper — `toZuperCategoryName()` in `lib/category-norm.ts` maps `TOOLS/SAFETY` → `Tools & Safety`, `GUTTER/ALUMINUM/COIL` → `Gutter, Aluminum & Coil`, etc. Zuper rejected slashes with HTTP 400, surfacing only when specialty (non-pre-selected) product lines pulled in new categories
- [x] Validate route product fetch chunked into batches of 500 — Supabase encodes `.in()` arrays into the URL; ~4000 IDs produced a 25 KB URL that exceeded PostgREST limits and silently killed the function before any SSE event could be emitted
- [x] Validate route catch block hardened — `console.error` logs to Vercel function logs, enqueue/close wrapped in try blocks since the runtime may tear down the controller before the catch fires
- [x] ChecklistItem detail line wraps (not truncates) on failed status — CSMs see the full Zuper response, not just the trailing fragment

### family_tier tier definitions
| Tier | Count | Meaning |
|---|---|---|
| `good` | 1,875 | Current standard entry products (Timberline HDZ, Duration, Landmark PRO, Cambridge, Heritage, Highlander, etc.) |
| `better` | 14,750 | Commodity/accessory items — now further sub-classified in `accessory_tier` |
| `best` | 124 | Premium/designer shingles (Grand Sequoia, Presidential Shake, Woodmoor, Berkshire, Crowne Slate, etc.) |
| `addon` | 3,058 | Legacy products, specialty/impact/solar/tile/stone-coated systems, upgrades shown separately |

### accessory_tier sub-classification (applied to family_tier='better' only)
| Tier | Count | Meaning |
|---|---|---|
| `good_accessory` | 781 | Cheapest-in-band per (category, brand) — economy accessories |
| `better_accessory` | 13,066 | Middle band + all categories without enough pricing data to differentiate |
| `best_accessory` | 903 | Most-expensive-in-band per (category, brand) — premium accessories |

Best differentiation in: GUTTER/ALUMINUM/COIL (360/471/391), OTHER FLASHING METAL (301/460/348), CAULK, VENTS, W-VALLEY. Categories with insufficient pricing depth (COMMERCIAL, SIDING, DECKING, OTHER FASTENERS) all land in `better_accessory`.

### 🔲 Not Yet Done (logical next steps)
- [ ] Rule engine implementation — the actual logic that maps customer answers → product set
- [ ] `exclude_default` flag population — mark legacy/irrelevant products to exclude
- [ ] `is_private_label` flag population — mark contractor-branded products
- [ ] Color-matching logic — auto-link drip edge/spray paint to selected shingle color
- [ ] Per-account formula overrides — `account_formula_overrides` table for custom bundle lengths etc.
- [ ] Stock/availability layer — not in SRS catalog data
- [ ] Category enrichment beyond shingles — extend srs_product_families to all categories
- [ ] COMMERCIAL category sub-classification — 4,688 products need type tagging (TPO vs EPDM vs modified bitumen)
- [ ] SIDING scope decision — separate trade or included in roofing scope?
- [ ] DECKING cleanup — remove composite deck boards, keep only OSB/structural sheathing
- [ ] More brand-specific tier-upgrade rules — extend lib/tier-upgrade-rules.ts beyond Big 3
- [ ] Cleanup wizard — CSM tool to delete a prior import batch from Zuper in one click

---

## 13. Important Data Quality Notes

1. **SHINGLES category** contains ~20 mis-categorized products: tile vents (O'Hagin), flashing accessories (TopShield tin shingles), vinyl siding (Alside), trim moulding (Azek), adhesive (APOC 705). These should have `exclude_default = true` set.

2. **TOOLS/SAFETY** — Atlas-branded gloves in this category are a different "Atlas" company (Atlas Gloves), not Atlas Roofing.

3. **"Manufacturer Varies by Location"** — 1,086+ products. These are location-dependent generic items (e.g. coil stock, drip edge) priced/sourced locally by SRS branch. The `customerRestrictions` field sometimes identifies which branch account gets specific variants.

4. **Brand name inconsistencies** in source — same brand appears with different spellings (SOPREMA vs Soprema, Polyglass vs Polyglass with trailing space). `manufacturer_norm` title-case normalization handles most of these but some duplicates remain (e.g. "Resisto" vs "RESISTO").

5. **Product line column one miss** — product_id with blank product_name has null product_line. Exactly 1 row, not significant.

6. **GAF Drill-Tec Purlin** is classified as "Timberline HDZ" product line because it was mis-categorized in HIP AND RIDGE in the SRS source and got the families classification. It's actually a fastener.

---

## 14. Queries You'll Use Often

```javascript
// All shingles for 3 brands
supabase.from('srs_products')
  .select('*')
  .eq('product_category', 'SHINGLES')
  .in('manufacturer_norm', ['Gaf', 'Certainteed', 'Owens Corning'])
  .eq('exclude_default', false)

// Variants for a product (unrestricted only)
supabase.from('srs_variants')
  .select('*')
  .eq('product_id', productId)
  .eq('is_restricted', false)

// Products by family
supabase.from('srs_product_families')
  .select('*, srs_products(*)')
  .eq('manufacturer_norm', 'Gaf')
  .eq('family_name', 'Timberline HDZ')

// All brands with 10+ products (paginate — default limit 1000)
// Must paginate with .range(from, from+999) to get all 19,807 products

// Products by family tier (e.g. all "good" shingles for GAF)
supabase.from('srs_products')
  .select('*')
  .eq('product_category', 'SHINGLES')
  .eq('manufacturer_norm', 'Gaf')
  .eq('family_tier', 'good')
  .eq('exclude_default', false)
```

---

## 15. Product Quantity Formulas

**File:** `Product Formulas.xlsx` (project root) — 32 rows, one per formula  
**Script:** `generate-formula-sheet.js` — regenerates the Excel from source  
**Token format:** Plain Zuper token names, no unit suffixes. `Suggested Waste Percentage %` is the only waste token.  
**Validated against:** 54 real roofing customer accounts (us_east/west_zuper_service.cpq_formula.csv)  
**Stored in DB:** `proposal_line_items.formula_expr` column — plain token names, no braces

| Category | Formula Name | Expression | UOM |
|---|---|---|---|
| SHINGLES | Shingle Quantity | `(Total Roof Area * (1 + Suggested Waste Percentage % / 100)) / 100` | **SQ** |
| HIP AND RIDGE | Hip & Ridge Quantity | `CEIL((Total Hip Length + Total Ridges Length) / 33)` | BD |
| STARTER | Starter Quantity | `CEIL((Total Eaves Length + Total Rakes Length) / 120)` | BD |
| UNDERLAYMENT | Synthetic | `CEIL(Total Roof Area * (1 + Suggested Waste Percentage % / 100) / 1000)` | RL |
| UNDERLAYMENT | Felt 15# | `CEIL(Total Roof Area * (1 + Suggested Waste Percentage % / 100) / 400)` | RL |
| UNDERLAYMENT | Felt 30# | `CEIL(Total Roof Area * (1 + Suggested Waste Percentage % / 100) / 200)` | RL |
| UNDERLAYMENT | Self-Adhered HT | `CEIL(Total Roof Area * (1 + Suggested Waste Percentage % / 100) / 200)` | RL |
| ICE AND WATER | Ice & Water Quantity | `CEIL((Total Eaves Length + Total Valleys Length) * 1.1 / 66)` | RL |
| DRIP EDGE | Drip Edge Quantity | `CEIL((Total Rakes Length + Total Eaves Length) / 10)` | PC |
| W-VALLEY | W-Valley Quantity | `CEIL(Total Valleys Length / 10)` | PC |
| COIL NAILS | Coil Nail Quantity | `CEIL(Total Roof Area * 3.2 / 3600)` | BX |
| PLASTIC CAPS | Plastic Cap Quantity | `CEIL(Total Roof Area / 400)` | BX |
| VENTS | Ridge Vent Quantity | `CEIL(Total Ridges Length / 4)` | PC |
| VENTS | Box / Soffit Vent Quantity | Direct Input | EA |
| PIPE FLASHING | Pipe Boot Quantity | Direct Input | EA |
| SKYLIGHTS | Skylight Quantity | Direct Input | EA |
| CAULK | Caulk Quantity | Direct Input | TB |
| GUTTER/ALUMINUM/COIL | Gutter Sections | `CEIL(Gutter Length / 10)` | PC |
| GUTTER/ALUMINUM/COIL | Downspouts | `No of Downspouts` | EA |
| GUTTER/ALUMINUM/COIL | End Caps | `No of End Caps` | EA |
| GUTTER/ALUMINUM/COIL | Outside Corners | `No of Outside Miters` | EA |
| GUTTER/ALUMINUM/COIL | Inside Corners | `No of Inside Miters` | EA |
| GUTTER/ALUMINUM/COIL | Elbows | `Downspout Elbows + No of Inner Elbows + No of Outer Elbows` | EA |
| GUTTER APRON | Gutter Apron Quantity | `CEIL((Total Rakes Length + Total Eaves Length) / 10)` | PC |
| SPRAY PAINT | Spray Paint Quantity | Direct Input | EA |
| OTHER FASTENERS | Fastener Quantity | Direct Input | BX |
| OTHER FLASHING METAL | Step Flashing | `CEIL(Total Step Flashing Length / 10)` | PC |
| OTHER FLASHING METAL | Headwall Flashing | `CEIL(Headwall Flashing / 10)` | PC |
| SIDING | Siding Quantity | `CEIL(Total Siding Area * (1 + Suggested Waste Percentage % / 100) / 100)` | SQ |
| COMMERCIAL | Membrane Quantity | `CEIL(Total Roof Area * (1 + Suggested Waste Percentage % / 100) / 100)` | SQ |
| DECKING | Sheet Quantity | `CEIL(Total Roof Area / 32 * (1 + Suggested Waste Percentage % / 100))` | PC |
| TOOLS/SAFETY | — | EXCLUDED | — |

**Key constants (validated from 54 customer accounts):**
- 33 LF per hip & ridge bundle (corrected from 35)
- 120 LF per starter bundle (corrected from 105; uses Eaves + Rakes not Starter token)
- Ice & water: 66 LF per roll × 3ft wide, ×1.1 overlap (corrected from SQFT-based formula)
- Drip edge & gutter apron: Rakes + Eaves perimeter (not a dedicated Drip Edge token)
- Ridge vent: Total Ridges Length (not RidgeCap token)
- 3,600 nails per box; 3.2 nails per SQFT

---

---

## 16. Customer Inventory Analysis

**Source files:** `us_east_zuper_service.products.csv` (43 companies, 31,875 rows) + `us_west_zuper_service.products.csv` (11 companies, 3,322 rows)
**Total:** 54 roofing companies, 35,197 product/service records, avg 652 products per company

### Key findings

**Brand universality — every company uses the Big 3:**
| Brand | Companies |
|---|---|
| GAF | 54/54 |
| CertainTeed | 54/54 |
| Owens Corning | 54/54 |
| IKO | 17/54 |
| Malarkey | 13/54 |
| TAMKO | 9/54 |
| Atlas | 9/54 |

**Universal accessories — 54/54 companies carry all of these:**
Drip Edge, Starter, Hip & Ridge, Step Flashing, Ice & Water, Underlayment (felt + synthetic), Vents

**Strong accessories (31–37/54 companies):** Valley, Sealant/Caulk, Coil Nails, Cap Nails, Pipe Boot, Counter Flashing

### Account load strategy (confirmed from analysis)

**Brand selection UI (account setup screen):**
1. **Big 3 (GAF, CertainTeed, OC)** → pre-selected tiles, auto-load, no action needed
2. **Top 9 secondary brands** → displayed as quick-select tiles (IKO, Malarkey, TAMKO, Atlas, Boral, DECRA + 3 others TBD)
3. **Remaining 290+ brands** → searchable list so nothing is missed
4. **Universal accessories** (`is_universal = true`) → always loaded regardless of brand selection
5. **family_tier** → used within each brand's product set for Good/Better/Best proposal tiers
6. **Product IDs in customer data** use internal codes (RSS###, DELIV###) — no direct SKU match to SRS catalog

### Suggested prices (from customer data medians)
| Item | Suggested Price | UOM |
|---|---|---|
| Shingles — good | $131.37 | BD |
| Shingles — better | $158.74 | BD |
| Shingles — best | $431.02 | BD |
| Hip & Ridge | $183.15 | BD |
| Starter | $82.59 | BD |
| Underlayment — Synthetic | $243.46 | RL |
| Underlayment — Felt | $95.08 | RL |
| Ice & Water | $122.22 | RL |
| Drip Edge | $18.00 | PC |
| W-Valley | $64.38 | PC |
| Step Flashing | $100.73 | PC |
| Coil Nails | $109.20 | BX |
| Cap Nails | $42.07 | BX |
| Pipe Boot | $57.86 | EA |
| Ridge Vent | $48.22 | PC |
| Box Vent | $37.88 | EA |
| Caulk / Sealant | $19.98 | TB |
| Gutter Section | $9.45 | PC |

---

---

## 17. The Zuper Importer App

**Repo:** `D:\OneDrive - Zuper,inc\Documents\Projects\zuper-importer`  
**GitHub:** `https://github.com/Dilith-Zuper/zuper-importer`  
**Live URL:** Deployed on Vercel (auto-deploys from main branch)  
**Stack:** Next.js 14 (App Router, TypeScript), Tailwind CSS, Zustand + persist middleware, Supabase JS client  
**Last updated:** 2026-06-05 (v5 — ABC + QXO catalog sources live through the full wizard incl. Step 11 proposal templates; fixed ABC/QXO proposals dropping all non-service line items due to a product_id key-space mismatch; template names now source-suffixed. SRS details below predate ABC/QXO — treat §17 as multi-source where it says SRS.)

### What it does
A 9-step wizard that imports the SRS Distribution product catalog into a Zuper customer account and creates Good/Better/Best CPQ proposal templates. Used by Zuper CSMs during customer onboarding.

### 9-Step Wizard Flow

| Step | Component | What happens |
|------|-----------|--------------|
| 1 | Step1Connect | Enter company login name + API key — validates against Zuper |
| 2 | Step2Trades | Select trades: Roofing (pre-selected), Gutters, Siding |
| 3 | Step3Brands | Select brands per trade — Big 3 pre-selected for roofing |
| 4 | Step4ProductLines | Filter product lines per brand — residential pre-selected |
| 5 | Step4Preview | Preview full product count + category breakdown before upload |
| 6 | Step5Validate | 7 pre-flight checks (categories, warehouse, tokens, formulas, custom fields, services) |
| 7 | Step6Upload | SSE-streamed upload — Phase 1 products, Phase 2 services |
| 8 | Step7Done | Summary + error download |
| 9 | Step9Proposals | Create G/B/B CPQ proposal templates per brand |

### Key architecture decisions

**Products upload (Phase 1):**
- Fetches products from Supabase by brand + product line selection
- 20 universal accessories always merged in (see `lib/accessory-catalog.ts`)
- Batches of 100 products, 3s pause between batches
- SSE stream — `app/api/upload/route.ts`

**Universal accessories (`lib/accessory-catalog.ts`):**
- 21 hardcoded SRS product IDs always uploaded to every account (was 19; Counter/Headwall Flashing + Plastic Cap Nails added 2026-05-14)
- Full slot coverage: drip edge, underlayment (synthetic + ice & water), coil nails, plastic cap nails, step flashing, valley metal, pipe boots, ridge vent, starter strip, caulk, counter/headwall flashing
- To find or replace an entry: run `node find-accessory-gaps.js` in `product importer/`

**Services upload (Phase 2):**
- 28 services defined in `lib/service-catalog.ts` — 16 core roofing + 8 slope-based (tear-off + install × 4 slope tiers) + 3 gutters + 1 siding
- Slope tiers: Low (3-6/12) $107/$30, Standard (7-9/12) $185/$77, Steep (10-12/12) $245/$107, Very Steep (13/12+) $321/$132
- Slope services now have `formula_key` wired — proposals use `quantity_type: 'FORMULA'` so quantities auto-calculate from `Low Slope`, `Standard Slope`, `Steep Slope`, `Very Steep Slope` measurement tokens
- Service payload built by `lib/service-builder.ts` — product_type: SERVICE, min_quantity: 0

**CPQ Proposal Templates (Step 9):**
- 4-step Zuper API flow: POST template → POST options (G/B/B) → PUT trigger config → POST line items
- Formula field in line item: `formula` (not `formula_uid`) — critical detail
- sectionUid from HEADER response: `data` is an array, use `data[0]?.uid`
- Live formula map cached via `lib/zuper-cache.ts` (5-min TTL per apiKey); invalidated after any formula POST in validate route
- Brand-specific tier-upgrade rules (`lib/tier-upgrade-rules.ts`) apply per-tier accessory swaps before building packages. Current rules: CertainTeed Best → HT Ice & Water; OC Better/Best → WoodStart Cool Starter
- Roofing: products filtered by family_tier (good/better/best)
- Gutters/siding: same curated items in all 3 tiers (family_tier is 99% "better" for those)

**Multi-trade support:**
- Roofing: SRS catalog filtered by brand + product line
- Gutters: `product_category = 'GUTTER/ALUMINUM/COIL'`, brand-filtered
- Siding: `product_category = 'SIDING'`, brand-filtered
- All 3 share the same upload/validate/proposal flow

**Validation (Step 6):**
- Check 1: Product categories (maps SRS categories → Zuper category UIDs)
- Check 2: Default warehouse (gets warehouseUid)
- Check 3: Measurement tokens (gets tokenMap for formula expressions)
- Check 4: CPQ formulas (gets formulaMap: formula_key → uid)
- Check 5: Product UOMs (verifies UOMs supported)
- Check 6: Product Tier custom field (optional — gets productTierFieldUid)
- Check 7: Service categories (optional — finds/creates "Roofing/Gutter/Siding Services" categories)

### Important API details

**Zuper API base URL:** Stored per-account, e.g. `https://us-east-1.zuperpro.com/api/`  
**Company login name:** Found in Zuper internal admin panel  
**API key location:** Zuper → Settings → Developer Hub → API Key → New API Key

**Product payload key fields:**
```ts
product_id: String(srs_product_id)   // SRS ID stamped as external reference
product_type: 'PARTS'
formula: formulaUid                   // NOT formula_uid — common mistake
```

**⚠️ ABC/QXO product_id key-space — the proposal-template gotcha (2026-06-05):**
SRS `product_id` is numeric end-to-end, so it's keyed identically everywhere. ABC
(`PFam_3359303`) and QXO (`product_key`) are **text** PKs, and the pipeline carries
them in two different forms — this is the source of a class of "proposals only have
services, no materials" bugs:
- **Upload** (`app/api/upload/route.ts`) strips non-digits (`toNum`) → `3359303`.
  That digit-only form is what gets stamped into Zuper's `product_id`, keyed into
  `productIdMap` (`product_id → Zuper product_uid`), grouped for variants, and used
  for idempotency. **Canonical key for the whole Zuper-facing flow = digit-only.**
- **proposal-preview** (`app/api/proposal-preview/route.ts`) stamps each line item's
  `product_id` straight from `cfg.cols.productPk` — i.e. the **raw text** PK
  (`PFam_3359303`), NOT the digit-only form.
- **create-proposals** (`app/api/create-proposals/route.ts`) bridges the two with
  `resolveZuperProduct(rawId)`: tries the raw key first (SRS hits), then falls back
  to the digit-stripped form (ABC/QXO hit). Without this, every material/gutter/
  siding line item fails the `productIdMap` lookup and is silently skipped, leaving
  only the Services section (services use a separate `serviceIdMap` keyed by
  `service.id`). The route now also reports a per-brand skipped-item count in its SSE
  `done` event instead of dropping silently. If you ever re-stamp ids in preview or
  upload, keep these two ends in the same key-space or this regresses.

**Template names carry a ` - <SOURCE>` suffix** (`Owens Corning Roofing Proposal - ABC`).
Zuper rejects duplicate `template_name` per account, so the same brand imported from
SRS and ABC into one account would otherwise collide. Suffix = `catalogSource.toUpperCase()`
(SRS / ABC / QXO), set in `components/wizard/Step10Proposals.tsx`. Note: create-proposals
is **not** idempotent on re-run — a second run with the same suffix collides with the
first run's templates; delete the prior `… - <SOURCE>` templates in Zuper before re-running.

**Option/variant mapping:**
- `srs_variants.color_name` → Zuper `option_values[].option_value`
- `srs_variants.variant_code` (SKU) is NOT currently sent to Zuper — reserved for vendor catalog feature later

### State management (`store/wizard-store.ts`)
Zustand store holds all wizard state across steps, **persisted to localStorage** (except `apiKey` which is memory-only for security). On browser refresh: `apiKey` clears and step resets to 1, but all other selections (brands, product lines, validation data) survive.

Key fields:
- `companyLoginName`, `apiKey` (NOT persisted), `baseUrl`, `companyName`
- `selectedTrades`, `selectedBrands`, `selectedGutterBrands`, `selectedSidingBrands`
- `selectedProductLines`, `selectedGutterProductLines`, `selectedSidingProductLines`
- `filteredProductIds`, `productCounts`
- `categoryMap`, `warehouseUid`, `tokenMap`, `formulaMap`, `productTierFieldUid`, `serviceCategoryMap`
- `uploadSummary`, `productIdMap` (SRS product_id → Zuper product_uid, captured after upload)
- `proposalPackages`, `gutterProposalItems`, `sidingProposalItems`

### UX features
- **Guide panel** (`components/ui/GuidePanel.tsx`): Slide-in right drawer with page-specific instructions + FAQ accordion. Triggered by "Do you have any doubts? Ask here" button in header.
- **NaaS Easter egg**: Triple-clicking the Zuper logo triggers a random "No as a Service" rejection reason in a toast (from `lib/no-reasons.json`).
- **Live upload log**: Real-time SSE log of product names as they upload, with copy button.
- **Phase indicators**: Upload page shows Phase 1 (products) and Phase 2 (services) progress bars.
- **SKU fetcher cross-link**: Step 1 Connect page has a card below the Connect button linking to `https://srs-sku-fetcher.vercel.app/` for CSMs who just need a SKU lookup.
- **Error states with retry**: Step3Brands and Step4ProductLines render an error card + retry button instead of hanging spinner on fetch failure.

### Performance

- **Brands + product lines**: Both fetch via paginated Supabase queries (1,000-row cap handled) then group in JS. Page fan-out capped at 5 concurrent requests via `lib/limit.ts` `mapWithLimit`.
- **Upload N+1 fix**: Color option_uid GETs (needed for vendor catalog) are now batched after each upload batch at 10 concurrent — not serialized per-product. ~30% faster for color-heavy catalogs.
- **TTL cache** (`lib/zuper-cache.ts`): Formula list cached 5 min per apiKey across validate + create-proposals routes. Eliminates redundant Zuper formula pagination between wizard steps.
- **Idempotency scan**: Upload route scans existing Zuper products before the first batch; known products are PUT (update) instead of POSTed (duplicate). Emits `created`/`updated` counts in SSE.
- `lib/brands-cache.ts`: module-level session cache + prefetching. Step2Trades fires all brand fetches on mount; Step3Brands debounce-prefetches product lines as brands are selected.

### Security

- Never hardcode Supabase credentials in scripts. All Python scripts read from `.env.local` via a simple file parser (no external deps). `.env.local` is gitignored.
- The `service_role` key (not anon) is stored in `.env.local` as `SUPABASE_SERVICE_KEY` and in Vercel env vars. Rotate it in Supabase → Settings → API if ever exposed.

### Design system

Full design language documented in `DESIGN.md` at the repo root. Key tokens:
- Page bg: `#FAF9F7`, border: `#E5E2DC`, text: `#1A1A1A`
- Primary: orange-500 — the only interactive color
- Cards: `rounded-2xl border border-[#E5E2DC]`, flat (no shadows)
- Buttons: `rounded-full`, full-width pill CTAs
- No emojis, inline SVG icons only, sentence case headings always

### Key files

| File | Purpose |
|------|---------|
| `app/api/upload/route.ts` | SSE upload stream — idempotency scan, Phase 1 products, Phase 2 services |
| `app/api/validate/route.ts` | Pre-flight validation SSE stream (7 checks) |
| `app/api/preview/route.ts` | Product preview + accessory merge |
| `app/api/proposal-preview/route.ts` | G/B/B package preview — applies tier-upgrade rules per brand |
| `app/api/create-proposals/route.ts` | CPQ template creation SSE stream — slope services use FORMULA quantity |
| `app/api/brands/route.ts` | Brand list per trade — paginated with bounded concurrency |
| `app/api/product-lines/route.ts` | Product lines — batch query for all brands at once, bounded concurrency |
| `lib/accessory-catalog.ts` | 21 universal accessory SRS product IDs (Counter/Headwall + Plastic Cap now included) |
| `lib/tier-upgrade-rules.ts` | Brand-specific accessory swaps per proposal tier (CertainTeed, OC) |
| `lib/limit.ts` | `mapWithLimit()` — bounded-concurrency Promise.all helper |
| `lib/zuper-cache.ts` | TTL cache for Zuper API lookups (formulas, categories) keyed by apiKey |
| `lib/service-catalog.ts` | 28 service definitions with formula_key wired to slope services |
| `lib/service-builder.ts` | Builds Zuper SERVICE product payload |
| `lib/product-builder.ts` | Builds Zuper PARTS product payload — pricing fallback via PriceFallback map |
| `lib/formula-definitions.ts` | 33 formula definitions (25 product + 8 slope-band) — FORMULA_CONSTANTS doc block |
| `lib/token-definitions.ts` | 22 required tokens (18 standard + 4 slope-band: Low/Standard/Steep/Very Steep) |
| `lib/brands-cache.ts` | Client-side session cache + prefetch for brands and product lines |
| `lib/guide-content.ts` | Step-by-step guide + FAQ content for all 9 steps |
| `lib/category-norm.ts` | Maps SRS product_category → display label |
| `lib/no-reasons.json` | NaaS rejection reasons for the Easter egg |
| `store/wizard-store.ts` | Zustand store with localStorage persistence (apiKey excluded) |
| `DESIGN.md` | Full design language reference for all future Zuper internal tools |
| `scripts/generate_report.py` | Roof Medic vs upload coverage Excel report |
| `scripts/unbranded_analysis.py` | Unbranded gap analysis across 54 accounts |

### Analysis outputs (in `product importer/` folder)

| File | Contents |
|------|---------|
| `Roof_Medic_Coverage_Report.xlsx` | 4-sheet report: matched vs unmatched vs extra products |
| `Unbranded_Gap_Analysis.xlsx` | 207 unbranded RM items × account prevalence × SRS counterpart availability |
| `hackthon 4 product export.xlsx` | Hackathon account product export used for comparison |
| `Roof_Medic.xlsx` | Reference account (Roof Medic) product catalog |

### G/B/B Proposal Structure (current)

Each proposal template = brand-specific tier items + universal accessories, with brand-specific tier upgrades applied.

**Universal accessories (base set — same for all brands unless a tier-upgrade rule overrides):**
| Slot | Product | Price |
|------|---------|-------|
| Drip Edge | Mastic Aluminum F Drip Edge | $18 |
| Step Flashing | Taylor Prebent Step Flashing | $101 |
| W-Valley | Copper W-Valley | $64 |
| Pipe Boot 3" | Dektite High Temp Pipe Boot | $58 |
| Coil Nails | ProFIT Coil Nails | $109 |
| Plastic Cap Nails | Stinger Plastic Cap NailPac | $42 |
| Fasteners | Stinger EG RS Plastic Cap Nails | — |
| Ridge Vent | Lomanco LPR-10 Ridge Vent | $48 |
| Caulk / Sealant | G.A.P. DYNAFLEX Caulk | $20 |
| Counter / Headwall Flashing | Bay Cities Counter Flashing | $101 |

**Brand-specific tier-upgrade rules (`lib/tier-upgrade-rules.ts`):**
- CertainTeed Best: Ice & Water → upgrades to High Temp (CertainTeed)
- OC Better: Starter Strip → upgrades to WoodStart Cool (OC)
- OC Best: Starter Strip → upgrades to WoodStart Cool (OC)
- Add more rules by editing `lib/tier-upgrade-rules.ts` — no code changes to other files needed

**Brand-specific shingles (differ by tier):**
- GAF: Shingles addon → good → best
- CertainTeed: Landmark → Landmark PRO → Presidential TL
- OC: Oakridge → Duration → Woodmoor
- Underlayment, vents: brand's own products within family_tier bands

### Pricing — how products get a price

1. `suggested_price` in DB: populated for 5,646 products from 54 customer account medians — used as-is.
2. **Fallback (added 2026-05-14):** at upload time, compute median `suggested_price` per `(product_category, family_tier)` from the 5,646 priced products. Apply to any product with `suggested_price = null`. Products that received a fallback price are tagged with `meta_data.label = 'Price Source', value = 'Estimated (category median)'` so CSMs can identify them in Zuper.
3. Products with no fallback (e.g. categories with zero priced examples) upload at $0. CSM must set price manually.

### Measurement token analysis

From `scripts/token_analysis.py` — output at `Token_Analysis.xlsx`:
- 802 unique measurement tokens across 54 accounts
- Our 22 standard tokens (18 + 4 slope-band): present in 53-54/54 accounts — well deployed
- Slope tokens (`Low Slope`, `Standard Slope`, `Steep Slope`, `Very Steep Slope`) now wired to slope-based service line items — proposal quantities auto-calculate from measurements
- 4 naming variants (`Total Eaves`, `Total Rakes`, `Total Valleys`, `Total Hips`) used in 1,504 formulas but semantically identical to our standard tokens — low risk

### Vendor catalog option mapping

The vendor catalog step (Step 9 Vendor) creates an SRS Distribution vendor in Zuper with per-SKU catalog entries linked to product color options via `option_uid`.

- POST response doesn't reliably include option UIDs → after each upload batch, GET each color-bearing product from `{baseUrl}product/{uid}` in bounded-parallel batches of 10 (was serial per-product N+1 — fixed 2026-05-14)
- `variantCodeByColor` keyed by `(product_id, color_name.trim())` to match Zuper's trimmed echo-back
- `colorCatalogMap`: `{ srs_product_id: [{ color_name, variant_code, option_uid, purchase_price }] }`

### Supabase row limit — critical rule

**Supabase PostgREST silently caps every query at 1000 rows**, regardless of `.limit(N)` in the JS client.

**Rule:** Always paginate with `.range()` + `{ count: 'exact' }`. Page fan-out uses `mapWithLimit(5, ...)` from `lib/limit.ts` to avoid hammering the connection pool.

### Brand search

`components/wizard/Step3Brands.tsx` — search works across all groups (tiles + list). Uses Levenshtein distance with threshold `ceil(queryLen/4)` to tolerate typos (malarki → Malarkey).

### CeDUR and Malarkey — what they are

**CeDUR** (`manufacturer_norm = 'Cedur'`) — 6 products, all `addon` tier:
- HIP AND RIDGE: Low/Medium/High Ridge (3) | STARTER: CeDUR Starter
- OTHER: Composite Multi-Width Shake, Composite Valley Shake
- Composite shake/synthetic system, not asphalt. Gate behind specialty roof type question.

**Malarkey** (`manufacturer_norm = 'Malarkey'`) — 46 products across 7 categories:
- SHINGLES: Highlander NEX, Vista, Legacy, Windsor, Ecoasis (flagship residential lines)
- HIP AND RIDGE, STARTER, UNDERLAYMENT, ICE AND WATER: matching accessories
- COMMERCIAL: 22 modified bitumen products (flat roofing) — separate from residential shingles
- Note: product `"Marlakey 502 Pano Cap"` (product_id 77723) is a source data typo — manufacturer_norm correctly set to Malarkey

### Pending / future work
- More brand-specific tier-upgrade rules — extend `lib/tier-upgrade-rules.ts` beyond Big 3 (Malarkey, IKO, TAMKO)
- Per-account formula overrides table — allow customising bundle lengths (33 LF, 120 LF etc.) per customer
- Cleanup wizard — CSM tool to delete all products from a prior import in one click
- `exclude_default` and `is_private_label` flags on `srs_products` — not yet populated, reserved for future rule engine

*End of context file. Last updated: 2026-06-05 (v5 — ABC/QXO proposal product_id key-space gotcha + `resolveZuperProduct` fallback documented in §17; source-suffixed template names; note that create-proposals isn't re-run idempotent. Prior v4 — Select-all brand toggle on Gutters/Siding, dual back-nav on Preview, SRS→Zuper category-name sanitizer for slash-rejection 400s, validate route product-id fetch chunked into 500-batch groups, validate catch block hardened, ChecklistItem detail wraps on failure).*
