"""
Phase 3 script 3 — Normalize ABC category_name into SRS-canonical product_category_norm.

Strategy:
  1. For 53 of 54 categories: simple flat map. UPDATE WHERE category_name = ?  (one per category)
  2. For "Steep Slope Roofing Accessories" (35K rows): sub-classify by product_type_name.
     Fetch those rows specifically, build classification, update in 500-row chunks.

This avoids ever doing high-offset pagination across the 316K-row table.
"""
import os
import sys
import time
from collections import Counter, defaultdict
from supabase import create_client

def _load_env(path=".env"):
    env = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    env[k.strip()] = v.strip()
    return env

_env = _load_env()
sb = create_client(_env["SUPABASE_URL"], _env["SUPABASE_SERVICE_KEY"])

DRY_RUN = "--dry-run" in sys.argv

# ── Flat category map: ABC raw label -> SRS canonical (or None) ────
# Note: ABC labels still contain HTML entities like <gt/> — match the raw label.
CATEGORY_MAP = {
    "Steep Slope Roofing (<gt/>2:12 Pitch)":              "SHINGLES",
    "Steep Slope Roofing Accessories":                    "__SUB__",   # special case
    "Low Slope Roofing (<lt/>2:12 Pitch)":                "COMMERCIAL",
    "Low Slope Roofing Accessories":                      "COMMERCIAL",
    "Rigid Insulation":                                   "COMMERCIAL",
    "Waterproofing Products":                             "ICE AND WATER",
    "Gutter Coil":                                        "GUTTER/ALUMINUM/COIL",
    "All Other Gutter Accessories":                       "GUTTER/ALUMINUM/COIL",
    "Downspouts":                                         "GUTTER/ALUMINUM/COIL",
    "Vinyl Siding, Soffit & Accessories":                 "SIDING",
    "Fiber Cement Siding, Soffit & Accessories":          "SIDING",
    "Metal Siding, Soffit & Accessories":                 "SIDING",
    "Composite Siding, Soffit & Accessories":             "SIDING",
    "Universal Siding & Soffit Accessories":              "SIDING",
    "Stucco, EIFS, Masonry & Other Siding Products":      "SIDING",
    "Brick, Stone & Mortar":                              "SIDING",
    "Brick Veneer & Manufactured Stone":                  "SIDING",
    "Caulks, Sealants, Paints & Other Related Products":  "CAULK",
    "Decking, Railing & Fencing":                         "DECKING",
    "Tools & Equipment":                                  "TOOLS/SAFETY",
    "Industrial Products":                                "TOOLS/SAFETY",
    "Safety Products":                                    "TOOLS/SAFETY",
    "Wallboard Panels":                                   "OTHER",
    "Lumber Products":                                    "OTHER",
    "Windows":                                            "OTHER",
    "Doors":                                              "OTHER",
    "Other Products":                                     "OTHER",
    "Solar Products":                                     "OTHER",
    # ── v2 additions: previously fell through to NULL → "Other" Zuper category ──
    # Insulation (covers the CertaPRO/EcoTouch/AttiCat/PINK Next Gen products
    # that surfaced as "Product Category is Mandatory" failures in v1)
    "Batts, Rolls & Loose Fill Insulation":               "COMMERCIAL",
    "All Other Insulation":                               "COMMERCIAL",
    # Acoustic ceiling systems
    "Standard Ceiling Panels":                            "COMMERCIAL",
    "Ceiling Grid Systems":                               "COMMERCIAL",
    "Specialty Ceiling Panels":                           "COMMERCIAL",
    # Additional siding categories ABC carries
    "Wood Siding, Soffit & Accessories":                  "SIDING",
    "PVC Siding, Soffit & Accessories":                   "SIDING",
    "Aluminum Cladding Systems":                          "SIDING",
    "PVC Cladding Systems":                               "SIDING",
    # Non-roofing categories — explicitly mapped to OTHER for coverage hygiene
    # (functionally equivalent to leaving them NULL since validate route adds an
    # OTHER Zuper category for non-SRS uploads anyway).
    "Other Outdoor Living Products":                      "OTHER",
    "Window & Door Accessories":                          "OTHER",
    "Pool & Patio Extrusions":                            "OTHER",
    "Porch Room Products":                                "OTHER",
    "Motorized Applications":                             "OTHER",
    "Metal Framing":                                      "OTHER",
    "Pool and Patio Accessories":                         "OTHER",
    "Pool and Patio Doors":                               "OTHER",
    "Lattice":                                            "OTHER",
    "Pool and Patio Roofing":                             "OTHER",
    "Hurricane Protection":                               "OTHER",
    "Screen & Spline":                                    "OTHER",
    "Metal Framing Accessories":                          "OTHER",
    "Large Opening Enclosure Systems":                    "OTHER",
    "FRP Panels & Accessories":                           "OTHER",
    "Wallboard Accessories":                              "OTHER",
    "Decorative Colonial / Bahama Shutters":              "OTHER",
    "Storm Panels":                                       "OTHER",
}

# Sub-classify "Steep Slope Roofing Accessories" by product_type_name (substring match, case-insensitive)
ACCESSORY_PT_RULES = [
    ("hip & ridge",          "HIP AND RIDGE"),
    ("ridge cap",            "HIP AND RIDGE"),
    ("starter",              "STARTER"),
    ("underlayment",         "UNDERLAYMENT"),
    ("felt",                 "UNDERLAYMENT"),
    ("synthetic",            "UNDERLAYMENT"),
    ("ice & water",          "ICE AND WATER"),
    ("ice and water",        "ICE AND WATER"),
    ("self-adhered",         "ICE AND WATER"),
    ("drip edge",            "DRIP EDGE"),
    ("valley",               "W-VALLEY"),
    ("pipe boot",            "PIPE FLASHING"),
    ("pipe jack",            "PIPE FLASHING"),
    ("pipe flashing",        "PIPE FLASHING"),
    ("ridge vent",           "VENTS"),
    ("box vent",             "VENTS"),
    ("power vent",           "VENTS"),
    ("attic vent",           "VENTS"),
    ("turbine",              "VENTS"),
    ("gable vent",           "VENTS"),
    ("dryer vent",           "VENTS"),
    ("vent",                 "VENTS"),   # catch-all for any remaining "*vent*"
    ("step flashing",        "OTHER FLASHING METAL"),
    ("counter flashing",     "OTHER FLASHING METAL"),
    ("headwall flashing",    "OTHER FLASHING METAL"),
    ("flashing",             "OTHER FLASHING METAL"),
    ("flat sheet",           "OTHER FLASHING METAL"),
    ("coil stock",           "OTHER FLASHING METAL"),
    ("base sheet",           "UNDERLAYMENT"),
    ("mineral surface",      "UNDERLAYMENT"),
    ("cap nail",             "PLASTIC CAPS"),  # before "nail" — must match first
    ("plastic cap",          "PLASTIC CAPS"),
    ("nail",                 "OTHER FASTENERS"),
    ("screw",                "OTHER FASTENERS"),
    ("staple",               "OTHER FASTENERS"),
    ("fastener",             "OTHER FASTENERS"),
    ("skylight",             "SKYLIGHTS"),
    ("gutter apron",         "GUTTER APRON"),
    # Generic metal-roofing accessory catch-all → flashing
    ("steel roofing",        "OTHER FLASHING METAL"),
    ("metal roofing",        "OTHER FLASHING METAL"),
    ("aluminum roofing",     "OTHER FLASHING METAL"),
    ("copper roofing",       "OTHER FLASHING METAL"),
    ("galvanized roofing",   "OTHER FLASHING METAL"),
]

# Universal accessory categories (matches SRS)
UNIVERSAL = {
    "UNDERLAYMENT", "ICE AND WATER", "DRIP EDGE", "W-VALLEY",
    "COIL NAILS", "PLASTIC CAPS", "VENTS", "PIPE FLASHING",
    "CAULK", "SPRAY PAINT", "OTHER FASTENERS", "OTHER FLASHING METAL",
    "GUTTER/ALUMINUM/COIL", "GUTTER APRON",
}

def sub_classify_accessory(product_type, brand_line, family_name):
    """Match keyword against product_type, brand_line, then family_name."""
    haystack = " ".join(filter(None, [product_type, brand_line, family_name])).lower()
    if not haystack:
        return "OTHER"
    for keyword, target in ACCESSORY_PT_RULES:
        if keyword in haystack:
            return target
    return "OTHER"

def retry(fn, label, max_attempts=10):
    backoff = 2
    for attempt in range(max_attempts):
        try:
            return fn()
        except Exception as e:
            if attempt == max_attempts - 1:
                raise
            print(f"  [retry] {label}: {type(e).__name__}. Waiting {backoff}s...")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)

# ── 1. (Optional verification — skip if API is flaky) ──────────
if "--skip-counts" not in sys.argv:
    print("Step 1: Verify counts per category (best-effort; --skip-counts to bypass)")
    for cat in CATEGORY_MAP:
        target = CATEGORY_MAP[cat]
        try:
            n = retry(
                lambda c=cat: sb.table("abc_items").select("*", count="exact", head=True).eq("category_name", c).execute().count,
                f"count cat={cat[:40]}",
                max_attempts=3,
            )
            print(f"  {n:>6,} - '{cat[:60]}' -> {target}")
        except Exception as e:
            print(f"  ?????  - '{cat[:60]}' -> {target}  (count skipped: {type(e).__name__})")
else:
    print("Step 1: SKIPPED (--skip-counts)")

# ── 2. Plan classifications ─────────────────────────────────────
print("\nStep 2: For 'Steep Slope Roofing Accessories', fetch & sub-classify (keyset pagination)")
acc_items = []
last_id = 0
while True:
    page = retry(
        lambda lid=last_id: sb.table("abc_items")
            .select("id,item_number,product_type_name,brand_line_name,family_name")
            .eq("category_name", "Steep Slope Roofing Accessories")
            .gt("id", lid).order("id").limit(1000).execute().data,
        f"acc page last_id={last_id}"
    )
    if not page:
        break
    acc_items.extend(page)
    last_id = page[-1]["id"]
    if len(acc_items) % 5000 == 0:
        print(f"  ...fetched {len(acc_items):,}")
print(f"Fetched {len(acc_items):,} 'Steep Slope Roofing Accessories' rows")

# Group accessory item_numbers by their derived sub-category
acc_groups = defaultdict(list)
for r in acc_items:
    cat = sub_classify_accessory(
        r.get("product_type_name"),
        r.get("brand_line_name"),
        r.get("family_name"),
    )
    acc_groups[cat].append((r["item_number"], r))

print("\nAccessory sub-classification:")
for cat, items in sorted(acc_groups.items(), key=lambda x: -len(x[1])):
    print(f"  {len(items):>6,} - {cat}")

# Show what's still in OTHER — distinct product_type_name values
other_items = acc_groups.get("OTHER", [])
if other_items:
    pt_counts = Counter((r.get("product_type_name") or "(blank)") for _, r in other_items)
    print(f"\nTop product_type_names still in OTHER ({len(other_items):,} rows, {len(pt_counts)} distinct types):")
    for pt, n in pt_counts.most_common(20):
        print(f"  {n:>5,} - {pt}")

# Flatten acc_groups back to just item_numbers for the update step
acc_groups = {cat: [item for item, _ in items] for cat, items in acc_groups.items()}

if DRY_RUN:
    print("\n[DRY RUN] skipping DB update.")
    sys.exit(0)

# ── 3. Fetch item_numbers for ALL non-accessory categories (keyset pagination) ──
print("\nStep 3: Fetching item_numbers for flat-mapped categories (keyset pagination)...")
flat_groups = defaultdict(list)  # (cat_norm, is_universal) -> [item_number, ...]

# Already-classified accessories from Step 2 go straight in
for cat, item_nums in acc_groups.items():
    is_uni = cat in UNIVERSAL
    flat_groups[(cat, is_uni)].extend(item_nums)

# For each non-__SUB__ category, fetch its item_numbers
for cat, target in CATEGORY_MAP.items():
    if target == "__SUB__":
        continue
    is_uni = target in UNIVERSAL
    print(f"  Fetching '{cat[:50]}' -> {target}...")
    last_id = 0
    fetched = 0
    while True:
        page = retry(
            lambda lid=last_id, c=cat: sb.table("abc_items")
                .select("id,item_number").eq("category_name", c)
                .gt("id", lid).order("id").limit(1000).execute().data,
            f"fetch cat={cat[:30]} last_id={last_id}"
        )
        if not page:
            break
        flat_groups[(target, is_uni)].extend(r["item_number"] for r in page)
        fetched += len(page)
        last_id = page[-1]["id"]
    print(f"    fetched {fetched:,}")

print(f"\nTotal item_numbers to update: {sum(len(v) for v in flat_groups.values()):,}")
print(f"Distinct (cat, universal) groups: {len(flat_groups)}")

# ── 4. Apply all updates in chunks of 500 ──
print("\nStep 4: Applying updates in chunks of 500 item_numbers...")
CHUNK = 500
total_updated = 0
for (cat, uni), item_nums in sorted(flat_groups.items(), key=lambda kv: -len(kv[1])):
    print(f"  ({cat or 'NULL'}, universal={uni}): {len(item_nums):,} rows", flush=True)
    for j in range(0, len(item_nums), CHUNK):
        batch = item_nums[j:j+CHUNK]
        retry(
            lambda b=batch, c=cat, u=uni: sb.table("abc_items").update({
                "product_category_norm": c,
                "is_universal": u,
            }).in_("item_number", b).execute(),
            f"update {cat} chunk {j}"
        )
        total_updated += len(batch)
print(f"\nTotal updated: {total_updated:,}")

# ── 5. Sanity check ─────────────────────────────────────────────
print("\nStep 5: Sanity check")
for brand in ("Gaf", "Certainteed", "Owens Corning"):
    cnt = sb.table("abc_items").select("*", count="exact", head=True)\
        .eq("manufacturer_norm", brand).eq("product_category_norm", "SHINGLES").execute().count
    print(f"  {brand} SHINGLES: {cnt:,} SKUs")

uni_cnt = sb.table("abc_items").select("*", count="exact", head=True).eq("is_universal", True).execute().count
print(f"\nTotal is_universal=TRUE: {uni_cnt:,}")
