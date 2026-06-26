# CertainTeed — Golden CPQ Template (reference blueprint)

Reference build for the golden account, derived from A&A Roofing's "CT Template - Updated"
but **de-bugged and normalized**. Use this to recreate the template against the golden
account's own products/formulas/measurements — the source JSON's UIDs are account-scoped
and do not port.

- Structure: **3 tier options**, each split into **Material** + **Labor** sections.
- Material products = fetched from SRS (`product_id` below). Labor/fees = account-created.
- Bugs fixed vs A&A source: Ridge Vent qty (`/4`), Valley Metal rounding, and removal of
  the duplicate Landmark starter/ridge that A&A double-billed in the Presidential option.

---

## Tier → shingle / starter / ridge (the only per-tier differences)

| Tier (option) | Field shingle (SRS) | Starter (SRS) | Hip & Ridge (SRS) | Extra |
|---|---|---|---|---|
| **CT Landmark** | Landmark AR `75663` | SwiftStart `75621` | Shadow Ridge AR `75647` | — |
| **CT Landmark Pro** | Landmark PRO AR `75650` | SwiftStart `75621` | Shadow Ridge AR `75647` | — |
| **CT Presidential** | Presidential Shake AR `75662` | Presidential Starter `1432` | Mountain Ridge AR `75668` | + Additional Presidential labor, + Freight |

Color variants for each shingle come from `srs_variants` (don't hand-type the color list).

---

## MATERIAL section (per tier = tier shingle/starter/ridge + the common block below)

| Line | SRS product_id | UOM | Qty formula (round up unless noted) | Notes |
|---|---|---|---|---|
| Field shingle | per tier | SQ | `RoofArea * (1 + Waste%/100) / 100` | Waste default 15% |
| Starter | per tier | BD/bundle | `Eaves / 116` (SwiftStart) · `Eaves / ⟨verify⟩` (Presidential) | gate: Eaves IS_NOT_EMPTY. **Verify Presidential bundle coverage — A&A had 90 in formula vs 120 in meta** |
| Hip & Ridge | per tier | BD/Box | Shadow Ridge `(Ridges+Hips)/45` · Mountain Ridge `(Ridges+Hips)/20` | |
| Ice & Water | `75603` | Roll | `Eaves / 65` | Winterguard Sand |
| Synthetic Underlayment | `1454` | Roll | `RoofArea / 1000` | RoofRunner (CT equiv of A&A's Tri-Built); 10 sq/roll |
| Drip Edge | `190492` | Piece | `DripEdgeLength / 10` | |
| Ridge Vent | `75606` | Piece | `Ridges / 4`  ← **FIXED (was `Ridges`, 4× over-order)** | gate: "Ridge Vent Condition" = Fail |
| Coil Nails 1-1/4 | `195820` (generic) | Box | `RoofArea / 1500` | |
| Coil Nails 1-3/4 | `195820` (generic) | Box | `RoofArea / 1500` | |
| Staples | generic P-style | Box | `RoofArea / 1500` | no "A-11" SKU in SRS |
| Sealant (Chem Link) | `78755` | Tube | FIXED 1 | |
| Step Flashing | `195798` (Berger) | Bundle | FIXED 1 | non-CT brand |
| Roof-to-Wall Flashing | `118113` (Klauer) | Piece | `FlashingLength / 10` | non-CT brand |
| Valley Metal | `158439` | Piece | `Valleys / 10`  ← **FIXED: round up (was NO_ROUNDING)** | add to ALL tiers (A&A had it only in Presidential) |

---

## LABOR / FEES section (account-created — NOT in SRS)

| Line | UOM | Qty formula | Notes |
|---|---|---|---|
| Install Laminated Shingles | SQ | `RoofArea*(1+Waste/100)/100 + (Ridges + Ridge/Hip)/90` | verify Ridges vs Ridge/Hip aren't both populated by your measurement source |
| Remove Laminated Shingles | SQ | same as Install | |
| Additional Presidential Labor | SQ | `RoofArea*(1+Waste/100)/100` | **Presidential tier only** (5 bundles/sq vs 3) |
| Roof Top Delivery Fee | Each | FIXED 1 | |
| Dump Fee | Each | `RoofArea*(1+Waste/100)/100` | scales with tear-off |
| Freight (Presidential) | Each | FIXED 1 | **Presidential tier only** |

---

## CPQ rules (carry over)
- **Starter**: ADD if `Total Eaves Length` IS_NOT_EMPTY, else REMOVE.
- **Ridge Vent**: ADD if checklist `Ridge Vent Condition` EQUAL_TO `Fail`, else REMOVE.

## Account-specific placeholders to wire up in the golden account
- `job_category_uid` + `job_status_uid` (trigger + LOOKUP "Roof Penetrations")
- `measurement_token_uid` for: Total Roof Area, Total Eaves Length, Total Ridges Length,
  Total Hips Length, Total Ridge/Hip Length, Total Drip Edge Length, Total Valleys Length,
  Total Flashing Length, Suggested Waste Percentage %
- `field_uid` for the "Ridge Vent Condition" checklist
- `formula_uid`s (created per account), `location` id, `layout_template_uid`, `category_uid`
- Markup: A&A used a flat **49.25%** on every line — keep or set golden default.

## Color / variant options (full data in `certainteed-golden-variants.json`)

**Decision: the field shingle is the only mandatory color picker per tier.** Hip/ridge and
starter carry an SRS color in data but are NOT separate customer selections — in roofing
they match the field shingle, and making them independent pickers causes mis-orders. Drop
A&A's "Pending Selection" pseudo-color (it defeats the mandate).

### Field shingle colors (the mandatory picker)

- **Landmark AR `75663`** (28): Birchwood, Black Walnut, Burnt Sienna, Charcoal Black,
  Cinder Black, Cobblestone Gray, Colonial Slate, Cottage Red, Driftwood, Georgetown Gray,
  Granite Gray, Heather Blend, Hunter Green, Max Def Burnt Sienna, Max Def Georgetown Gray,
  Max Def Moire Black, Max Def Weathered Wood, Mission Brown, Moire Black, Mojave Tan,
  Pewter, Pewterwood, Resawn Shake, Silver Birch, Sunrise Cedar, Terra Cotta,
  Thunderstorm Gray, Weathered Wood
- **Landmark PRO AR `75650`** (28, all Max Def): Birchwood, Cinder Black, Max Def Atlantic
  Blue, Max Def Birchwood, Max Def Black Walnut, Max Def Burnt Sienna, Max Def Charcoal
  Black, Max Def Coastal Blue, Max Def Cobblestone Gray, Max Def Colonial Slate, Max Def
  Driftwood, Max Def Espresso, Max Def Evergreen, Max Def Georgetown Gray, Max Def Granite
  Gray, Max Def Heather Blend, Max Def Mission Brown, Max Def Moire Black, Max Def Mojave
  Tan, Max Def Pewter, Max Def Pewterwood, Max Def Prairie Wood, Max Def Red Oak, Max Def
  Resawn Shake, Max Def Shenandoah, Max Def Sunrise Cedar, Max Def Weathered Wood, Silver Birch
- **Presidential Shake AR `75662`** (7): Aged Bark, Autumn Blend, Charcoal Black, Classic
  Weathered Wood, Country Gray, Shadow Gray, Weathered Wood

### Data-only (not a picker)
- Hip/ridge (`75647` 52 colors, `75668` 21 colors) and Presidential Starter (`1432` 5) —
  set to match shingle, single value in template.
- Drip Edge `190492` — 5 colors available if you ever want it selectable (Black, Colonial,
  Musket Brown, Natural Clay, Wolf White); default single.
- Ice & Water `75603` — options are **sizes** not colors; default `3' x 65'`.
- RoofRunner Synthetic `1454` — only 1 of 21 variants available ("White with Blue").
- Single-SKU (no option): Ridge Vent (Black), Coil Nails (Mill), Valley Metal (Mill),
  Chem Link (Clear), SwiftStart (Black).

## Sanity check — computed quantities (sample 25-square hip roof)

Roof: 2500 sqft, 15% waste, ridges 35, hips 45, eaves 140, rakes 60, valleys 24, drip edge 200.
Quantities computed from the **account's live formulas** wired into the template:

| Line | Formula | Qty | Notes |
|---|---|---|---|
| Shingles | shingles_squares | **400** ⚠ | `RoofArea*(1+waste)/100` — treats waste token as a FRACTION. Returns 400 sq if waste=`15`, ~29 sq if waste=`0.15`. **Latent account-wide bug** (existing OC shingle uses the same formula), missing `/100` on the waste term. |
| Hip & Ridge | hip_ridge_cap_bundles | 3 | round-up ✓ |
| Starter | starter_shingles_bundles | 1.67 | NO_ROUNDING — fractional bundle |
| Ice & Water | ice_and_water_shield_rolls | 2.73 | NO_ROUNDING — fractional roll |
| Synthetic underlayment | synthetic_underlayment_rolls | 2.5 | NO_ROUNDING |
| Drip Edge | drip_edge_pieces | 20 | ✓ |
| Ridge Vent | ridge_vents_pieces | 9 | round-up ✓ (`Ridges/4`) |
| Valley Metal | valley_metal_pieces | 2.4 | NO_ROUNDING — fractional |
| Coil Nails | coil_nails_boxes | 3 | round-up ✓ |

**Recommended fixes (account-level, optional):** correct `shingles_squares` to `RoofArea*(1+waste/100)/100` (or confirm the account enters waste as a fraction), and switch the NO_ROUNDING material formulas (starter / ice&water / synthetic / valley) to NEXT_WHOLE_NUMBER so they don't quote fractional rolls/bundles. These are shared formulas — fixing them affects every template on the account, so do it deliberately.
