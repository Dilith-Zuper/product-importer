# GAF — Golden CPQ Template (reference blueprint)

> **BUILT & PUBLISHED 2026-06-29** in the golden account — `template_uid
> 858f618d-b9a6-41fb-8347-90f2f4b5e44c` ("GAF - Good / Better / Best"). 10 GAF products
> created (see `gaf-golden-products.json`), template/options/line-items in
> `gaf-golden-template-result.json`. Build tool: `build-gaf-golden.js`. The sections below
> are the design reference the build followed.

Reference build for the **Single Job Roofing Golden Account** (`roofing-golden-account`,
us-east-1), derived from Roof Medic's `ASPHALT ROOFING | GAF Replacement` template
(`roof medic cpq template gaf.txt`) but **normalized to our golden standard**:

- Structure: **3 self-contained tier options**, each split into **Material** + **Labor**
  sections — same shape as the CertainTeed golden template ([[certainteed-golden-template]]),
  NOT Roof Medic's upgrade-delta layout.
- **Standing Seam (Roof Medic's 4th option) is dropped** per scope decision.
- Material products = fetched from SRS (`product_id` below, all verified present 2026-06-29).
  Warranties / labor / service rows = account-created (not SRS parts).
- Source UIDs (option_uid, product_uid, formula) are Roof-Medic-account-scoped and **do not
  port** — recreate against the golden account's own products/formulas/measurements.

---

## SRS coverage verdict

**Every GAF material in the source maps to a primary SRS SKU** — data is good. Generic
accessories all have SRS equivalents; warranties/labor/services are intentionally not SRS parts.

| Roof Medic line | SRS product_id | SRS name | Cat / UOM | $ sugg / cost | colors |
|---|---|---|---|---|---|
| GAF Timberline HDZ | **75386** | GAF Timberline HDZ Shingles | SHINGLES / BD | 131.37 / 78.82 | 11 |
| GAF UHDZ | **97196** | GAF Timberline UHDZ StainGuard Plus Shingles | SHINGLES / BD | 158.74 / 95.24 | 9 |
| GAF WeatherWatch I&W | **75366** | GAF WeatherWatch Ice & Water Leak Barrier | ICE&WATER / RL | 122.22 / 73.33 | 4 (sizes) |
| GAF FeltBuster | **75399** | GAF FeltBuster Synthetic Underlayment | UNDERLAYMENT / RL | 95.08 / 57.05 | — |
| GAF Tiger Paw | **75384** | GAF Tiger Paw Premium Roof Deck Protection | UNDERLAYMENT / RL | 243.46 / 146.08 | — |
| GAF Pro-Start | **75388** | GAF Pro-Start Starter | STARTER / BD | 82.59 / 49.55 | 1 |
| GAF Seal-a-Ridge | **75364** | GAF Seal-A-Ridge Ridge Cap Shingles | HIP&RIDGE / BD | 183.15 / 109.89 | 27 |
| GAF Timbertex | **88182** | GAF TimberTex Premium Hip & Ridge | HIP&RIDGE / BD | 183.15 / 109.89 | 15 |
| GAF Cobra Ridgevent 3 | **75354** | GAF Cobra Rigid Vent 3 | VENTS / PC | 37.88 / 22.73 | 2 |
| GAF Cobra Snow Country | **75376** | GAF Cobra SnowCountry Exhaust Ridge Vent | VENTS / PC | 48.22 / 28.93 | 1 |
| GAF Liberty Low Slope Base | (search `GAF LIBERTY SBS ... Base`) | COMMERCIAL / RL | — | — | — |
| GAF Liberty Low Slope Cap | (search `GAF LIBERTY SBS ... Cap Sheet`) | COMMERCIAL / RL | — | — | — |

**Generic accessory SKUs (brand-neutral, reusable):**

| Line | SRS product_id | SRS name |
|---|---|---|
| Drip Edge | 190492 | CertainTeed Aluminum Drip Edge (or pick a brand-neutral D-style) |
| Step Flashing | 195798 | Berger Aluminum Step Flashing |
| Counter / Roof-to-Wall Flashing | 118113 | Klauer Steel Roof-To-Wall Flashing |
| Valley Metal | 158439 | Steel Roll Valley Metal |
| Coil Nails | 195820 | Coil Nails |
| Pipe Boot (matches "Master Flow") | (search `GAF Master Flow ... Pipe Boot`) | GAF Master Flow Pivot Pipe Boot |
| Box / Slant-Back Vent | 75343 | GAF Master Flow IR65 Plastic Slant Back |
| Turbine / roof vent (Lomanco 750 sub) | (search `Lomanco`) | Lomanco 135 / 730 (no "750" SKU — substitute) |

**Not in SRS (account-created, by design):** 5-Year / Silver Pledge / Golden Pledge warranties,
Essentials/PoM/THP Labor packages, Area Prep, Remove Existing Shingles, decking inspection,
1-yr / 3-yr Maintenance plans, Standing Seam package.

**Literal misses (substitute, not gaps):** Lomanco **750** (SRS has 135/730/2000), "Kynar"-spec
valley (generic steel/aluminum valley present), Zipper Boot (use retrofit zip-seal pipe flashing).

---

## Tier → the only per-tier differences (everything else is the common block)

| Tier (option) | Field shingle | Underlayment | Hip & Ridge cap | Ridge vent | Warranty (svc) | Valley metal |
|---|---|---|---|---|---|---|
| **Good — Essentials** | HDZ `75386` | FeltBuster `75399` | Seal-A-Ridge `75364` | Cobra Rigid 3 `75354` | 5-Year | — |
| **Better — Peace of Mind** | HDZ `75386` | FeltBuster `75399` | **TimberTex `88182`** | Cobra Rigid 3 `75354` | Silver Pledge | — |
| **Best — Total Home Protection** | **UHDZ `97196`** | **Tiger Paw `75384`** | TimberTex `88182` | **Cobra SnowCountry `75376`** | Golden Pledge | Valley `158439` |

Color variants come from each shingle's SRS `product_options` — don't hand-type the list.

---

## MATERIAL section (per tier = tier rows above + the common block below)

| Line | SRS product_id | UOM | Qty formula (round **up** unless noted) | Notes |
|---|---|---|---|---|
| Field shingle | per tier | BD | `RoofArea*(1+Waste%/100)/100 * 3` | 3 bdl/sq. Source formula "Shingle Bundles (3 bdl per sq)" |
| Starter | `75388` | BD | `Eaves / 105` | gate: Eaves IS_NOT_EMPTY (~105 LF/bundle, verify coverage) |
| Hip & Ridge | per tier | BD | `(Ridges + Hips) / 25` | TimberTex/Seal-A-Ridge ~25 LF/bundle (verify) |
| Ice & Water | `75366` | RL | `Eaves / 65` | default size `3' x 65'` |
| Underlayment (synthetic) | per tier | RL | `RoofArea / 1000` | FeltBuster ~10 sq/roll; Tiger Paw same |
| Drip Edge | `190492` | PC | `DripEdgeLength / 10` | |
| Ridge Vent | per tier | PC | `Ridges / 4` | gate: ridge-vent condition checklist |
| Valley Metal | `158439` | EA | `Valleys / 10` | **Best tier only** (round up) |
| Step Flashing | `195798` | BD | FIXED 1 | |
| Counter / Roof-to-Wall Flashing | `118113` | PC | `FlashingLength / 10` | |
| Pipe Boots (1.5-2", 3-4") | GAF Master Flow | EA | FIXED qty per checklist | |
| Box / Slant Vent | `75343` | EA | per checklist | |
| Coil Nails | `195820` | BX | `RoofArea / 1500` | |
| Low-Slope Base + Cap (SBS) | GAF Liberty | RL | `LowSlopeArea / 100` | gate: low-slope area IS_NOT_EMPTY |

---

## LABOR / FEES section (account-created — NOT in SRS)

| Line | UOM | Qty formula | Notes |
|---|---|---|---|
| Tier Labor Pkg (Essentials / PoM / THP) | EA | FIXED 1 | priced row per tier (source: $539.72 sell) |
| Asphalt Additional Tear | SQ | per layers | source formula "Asphalt Additional Tear" |
| Area Prep / Remove Existing Shingles | EA | FIXED 1 | $0 service rows |
| Decking inspection | EA | FIXED 1 | $0 service row (per tier) |
| Maintenance plan (1-yr PoM / 3-yr THP) | EA | FIXED 1 | service row |

## Warranty rows (account-created service products, $/sq or $0)
- 5-Year (Good), Silver Pledge (Better, ~$25/sq), Golden Pledge (Best, ~$36/sq) — qty = `RoofArea/100`.

---

## CPQ rules / account placeholders to wire up
- **Trigger:** Roof Inspection → Create Proposal (match golden account's category/status uids).
- **Gates:** Starter ADD if Eaves IS_NOT_EMPTY; Ridge Vent ADD per checklist condition; Valley
  ADD on Best; Low-Slope ADD if low-slope area present.
- **Measurement tokens** needed: Roof Area, Eaves, Ridges, Hips, Valleys, Drip Edge Length,
  Flashing Length, Low-Slope Area, Waste %.
- **Formulas:** create per-account; reuse the corrected round-up pattern from the CT golden
  build (`ct_shingles_squares` etc. treat waste as `/100` and round up) — do NOT reuse the
  account's stock system formulas, which are NO_ROUNDING / treat waste as a fraction.
- **Markup:** Roof Medic used **82%** on shingles (varies per line). Decide: keep source
  markups, or apply the golden flat default. Set before publish.
- **Color picker:** field shingle is the only mandatory customer selection per tier; hip/ridge
  & starter match the shingle (single value, not a separate picker).

## Sanity targets (25-sq hip roof: 2500 sqft, 15% waste, ridges 35, hips 45, eaves 140, valleys 24, drip 200)
- Shingles HDZ: `2500*1.15/100*3` = **87 bundles** (29 sq). Starter: ~2 BD. Hip&Ridge: `80/25`→**4 BD**.
  I&W: `140/65`→**3 RL**. Underlayment: `2500/1000`→**3 RL**. Drip edge: **20 PC**. Ridge vent: `35/4`→**9 PC**.
  Valley (Best): `24/10`→**3 EA**. Verify against golden account's actual formula outputs before publish.
