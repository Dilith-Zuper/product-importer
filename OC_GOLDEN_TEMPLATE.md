# Owens Corning — Golden CPQ Template (reference blueprint)

> **BUILT & PUBLISHED 2026-07-01** in the golden account — `template_uid
> df3430b4-c63c-4aab-a968-15f5a0649d23` ("Owens Corning - Good / Better / Best"). 11 OC products
> created (see `oc-golden-products.json`), template/options/line-items in
> `oc-golden-template-result.json`, probe snapshot `oc-golden-probe.json`. Build tool:
> `build-oc-golden.js`. Mirrors the GAF ([[gaf-golden-template]]) & CertainTeed
> ([[certainteed-golden-template]]) golden builds. Sections per tier: **Material + Labor + Warranty**
> (Good 14 / Better 14 / Best 15 line items).
>
> _(Superseded builds, deleted: `944a1530…` Duration→Duration→Woodmoor where Good==Better;
> `19d11a46…` had the 3-shingle ladder but no warranty/permit rows.)_

Derived from the **Trust Roofing** live CPQ export (`trust_roofing_cpq_json OC`) — a 15-option /
383-product Owens Corning + metal/standing-seam/brava/tile/flat account template — but
**normalized to the lean golden standard**:

- **Scope decision (2026-07-01):** lean **material G/B/B only**, NOT the full 15-option port.
  True 3-shingle ladder **Oakridge → Duration → Woodmoor** (every tier steps up).
- Compared against rashid's `CPQ Template - Golden.xlsx` (an **Atlas** G/B/B build-spec, columns
  `Product Name · UOM · Measurement Token · Checklist Q · Condition · Formula · Calculation`) —
  used only to confirm the golden schema; different brand, not a source.
- Material products = fetched from SRS (`product_id` below, all verified present 2026-07-01).
  Warranties / labor / service rows = account-created (reused GAF/CT rows) — not SRS parts.
- Source UIDs from the Trust account **do not port** — recreated against the golden account's own
  products / formulas / measurements (same rule as GAF/CT).

---

## SRS coverage verdict

**Every OC material maps to a primary SRS SKU** — coverage is strong. SRS carries the full OC
shingle line (good=Duration, best=Woodmoor/Woodcrest/Berkshire) plus OC-branded accessories
(Starter Strip, RhinoRoof/Titanium underlayment, WeatherLock I&W, VentSure vents) and every
generic accessory category (DRIP EDGE 187, VENTS 179, HIP&RIDGE, STARTER, UNDERLAYMENT, ICE&WATER,
COIL NAILS, CAULK, PIPE FLASHING). Warranties/labor/services are intentionally not SRS parts.

**Data gap:** SRS stored only 1 color variant for `96906` (Duration) and `133784` (Woodmoor).
The color-rich canonical SKUs are **`75933` TruDefinition Duration AR (21 colors)** and **`675`
Woodmoor AR (6 colors)** — used those instead (also the correct product-line names).

| Line | SRS product_id | SRS name | Cat / UOM | tier |
|---|---|---|---|---|
| Field shingle (Good) | **688** | Owens Corning Oakridge AR Shingles | SHINGLES / BDL | addon(entry) |
| Field shingle (Better) | **75933** | Owens Corning TruDefinition Duration AR Shingles | SHINGLES / BDL | good |
| Field shingle (Best) | **675** | Owens Corning Woodmoor AR Shingles | SHINGLES / BDL | best |
| Hip & Ridge (Good/Better) | **672** | Owens Corning ProEdge AR Hip & Ridge | HIP&RIDGE / BDL | good |
| Hip & Ridge (Best) | **685** | Owens Corning Berkshire Hip & Ridge | HIP&RIDGE / BDL | best |
| Starter (Good/Better) | **686** | Owens Corning Starter Strip | STARTER / BDL | good |
| Starter (Best) | **133782** | Owens Corning WoodStart Starter | STARTER / BDL | best |
| Underlayment (Good) | **75674** | Owens Corning RhinoRoof U20 Synthetic | UNDERLAYMENT / RL | good |
| Underlayment (Better/Best) | **79663** | Owens Corning Titanium UDL30 Synthetic | UNDERLAYMENT / RL | good |
| Ice & Water (all) | **684** | Owens Corning WeatherLock Flex I&W | ICE&WATER / RL | good |
| Ridge Vent (all) | **676** | Owens Corning VentSure Ridge Vent | VENTS / PC | better |

**Generic accessories reused verbatim (existing golden-account products, brand-neutral):**
Galvanized Drip Edge, Steel Roll Valley Metal (Best only), Galvanized Step Flashing (FIXED),
Coil Nails, Chem Link DuraSil Sealant (FIXED). Labor: Roof Tear-Off, Shingle Install - Standard.

**Not ported from the Trust template (account-created / out of scope by design):** Trust Platinum
20-Yr & Unlimited Wind warranties, Premium Concierge, Fascia Painting, Equipter / Trash Rocket /
Material Lift, Project Management, permitting, all `Labor Job Costing` rows, and the entire
TPO / modified-bitumen / metal / tile catalog.

---

## Tier → the only per-tier differences (everything else is the common block)

| Tier (option) | Field shingle | Hip & Ridge | Starter | Underlayment | Valley metal |
|---|---|---|---|---|---|
| **Good** | Oakridge `688` | ProEdge `672` | Starter Strip `686` | RhinoRoof `75674` | — |
| **Better** | **Duration `75933`** | ProEdge `672` | Starter Strip `686` | **Titanium UDL30 `79663`** | — |
| **Best** | **Woodmoor `675`** | **Berkshire `685`** | **WoodStart `133782`** | Titanium UDL30 `79663` | Valley `24a2…` |

Ice & Water `684` and VentSure Ridge Vent `676` are common to all three tiers. Color variants come
from each shingle's SRS variants (Oakridge 21, Duration 21, Woodmoor 6) — don't hand-type.

> **Every tier is a distinct material step-up.** Field shingle changes at each tier
> (Oakridge entry → Duration mid → Woodmoor luxury); Better also upgrades the underlayment to
> Titanium; Best further upgrades hip&ridge, starter, and adds valley metal.

## Labor + Warranty sections (reused existing account products — NOT SRS parts)

Each tier also carries a **Labor** section (common) and a **Warranty** section (per-tier):

| Section | Good | Better | Best | product_uid |
|---|---|---|---|---|
| Labor: Roof Tear-Off | ✔ | ✔ | ✔ | `07a1adf8…` ($250, F.shingles) |
| Labor: Shingle Install - Standard | ✔ | ✔ | ✔ | `842309a0…` ($280, F.shingles) |
| Labor: Residential Permit | ✔ | ✔ | ✔ | `6548f204…` ($70, FIXED 1) |
| **Warranty** (per-tier) | OC Standard `38e171c5` ($7) | OC System `9d54402a` ($11.10) | OC Platinum `26d11c28` ($32) | UOM=SQ, qty via `ct_shingles_squares` |

Warranty products are UOM=SQ with no bound formula, so the line item drives qty with
`ct_shingles_squares` (same squares formula the labor rows use). Other Trust service rows
(Concierge, Equipter/Trash Rocket, Fascia Painting, TPO/flat block) intentionally NOT ported.

---

## Formulas / categories / trigger (all reused, re-confirmed at probe 2026-07-01)

- **Formulas** (corrected `ct_*` round-up customs): shingles `fc3af594…`, starter `be281b5e…`,
  hip/ridge `5b2f8876…`, ice&water `a7690fc2…`, synthetic `9036b640…`, ridge vent `1a854eb8…`,
  drip edge `c525c51f…`, valley `1e2dc692…`, coil nails `162203ae…`.
- **Categories:** Shingles / Underlayment / Ice & Water / Hip & Ridge / Vents / Roofing Materials.
- **Trigger:** Roof Inspection → Create Proposal (`catUid 96b23fdd…`, `statusUid 590cae00…`),
  Residential Roofing layout `7c75a34a…`, Warehouse `b94326f2…`.
- **Publish:** `is_draft:false` PUT issued **last** (after line items) so it doesn't revert to draft.

## Build runbook
```
node build-oc-golden.js probe      # read-only: verify formulas/cats/idempotency
node build-oc-golden.js products   # create the 10 OC products (idempotent, skips existing)
node build-oc-golden.js template   # create template + options + line items + publish
```
Account API key = `ZUPER_GOLDEN_API_KEY` in the gitignored `.env`.
