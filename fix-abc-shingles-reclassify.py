"""
Fix: ABC's 'Steep Slope Roofing (>2:12 Pitch)' category contains some HIP AND RIDGE,
STARTER, and other non-shingle products. Re-run the sub-classifier on rows currently
tagged product_category_norm='SHINGLES' and reclassify if the family_name or
brand_line_name clearly indicates a different slot.
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

# Reuse the same rule set as enrich-abc-category-norm.py.
# We ONLY reclassify if the rule finds a roofing-slot match (not a generic "vent" match etc.)
RECLASSIFY_RULES = [
    ("hip & ridge",          "HIP AND RIDGE"),
    ("ridge cap",            "HIP AND RIDGE"),
    ("starter",              "STARTER"),
    ("underlayment",         "UNDERLAYMENT"),
    ("ice & water",          "ICE AND WATER"),
    ("ice and water",        "ICE AND WATER"),
    ("drip edge",            "DRIP EDGE"),
    ("valley",               "W-VALLEY"),
    ("pipe boot",            "PIPE FLASHING"),
    ("pipe jack",            "PIPE FLASHING"),
    ("pipe flashing",        "PIPE FLASHING"),
    ("ridge vent",           "VENTS"),
    ("box vent",             "VENTS"),
    ("power vent",           "VENTS"),
    ("attic vent",           "VENTS"),
    ("gable vent",           "VENTS"),
    ("step flashing",        "OTHER FLASHING METAL"),
    ("counter flashing",     "OTHER FLASHING METAL"),
    ("headwall flashing",    "OTHER FLASHING METAL"),
    ("skylight",             "SKYLIGHTS"),
    ("gutter apron",         "GUTTER APRON"),
]

UNIVERSAL = {
    "UNDERLAYMENT", "ICE AND WATER", "DRIP EDGE", "W-VALLEY",
    "COIL NAILS", "PLASTIC CAPS", "VENTS", "PIPE FLASHING",
    "CAULK", "SPRAY PAINT", "OTHER FASTENERS", "OTHER FLASHING METAL",
    "GUTTER/ALUMINUM/COIL", "GUTTER APRON",
}


def reclassify(product_type, brand_line, family_name):
    haystack = " ".join(filter(None, [product_type, brand_line, family_name])).lower()
    if not haystack:
        return None
    for keyword, target in RECLASSIFY_RULES:
        if keyword in haystack:
            return target
    return None


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


# ── Fetch all rows currently tagged SHINGLES (keyset pagination) ──
print("Fetching all rows where product_category_norm = 'SHINGLES'...")
rows = []
last_id = 0
while True:
    page = retry(
        lambda lid=last_id: sb.table("abc_items")
            .select("id,item_number,product_type_name,brand_line_name,family_name")
            .eq("product_category_norm", "SHINGLES")
            .gt("id", lid).order("id").limit(1000).execute().data,
        f"fetch shingles last_id={last_id}"
    )
    if not page:
        break
    rows.extend(page)
    last_id = page[-1]["id"]
    if len(rows) % 5000 == 0:
        print(f"  ...fetched {len(rows):,}")
print(f"Fetched {len(rows):,} SHINGLES rows")

# ── Reclassify ────────────────────────────────────────────────
groups = defaultdict(list)
keep_count = 0
for r in rows:
    new_cat = reclassify(r.get("product_type_name"), r.get("brand_line_name"), r.get("family_name"))
    if new_cat:
        groups[new_cat].append(r["item_number"])
    else:
        keep_count += 1

print(f"\nReclassifications:")
print(f"  KEEP as SHINGLES: {keep_count:,}")
for cat, items in sorted(groups.items(), key=lambda x: -len(x[1])):
    is_uni = cat in UNIVERSAL
    print(f"  -> {cat}: {len(items):,} (universal={is_uni})")

if DRY_RUN:
    print("\n[DRY RUN] skipping DB update.")
    sys.exit(0)

# ── Apply in chunks of 500 ────────────────────────────────────
print("\nApplying reclassification in chunks of 500...")
CHUNK = 500
total_updated = 0
for cat, item_nums in sorted(groups.items(), key=lambda x: -len(x[1])):
    is_uni = cat in UNIVERSAL
    for j in range(0, len(item_nums), CHUNK):
        batch = item_nums[j:j+CHUNK]
        retry(
            lambda b=batch, c=cat, u=is_uni: sb.table("abc_items").update({
                "product_category_norm": c,
                "is_universal": u,
            }).in_("item_number", b).execute(),
            f"update {cat} chunk {j}"
        )
        total_updated += len(batch)
    print(f"  {cat}: {len(item_nums):,} done")

print(f"\nTotal reclassified: {total_updated:,}")

# Sanity
for brand in ("Gaf", "Certainteed", "Owens Corning"):
    cnt = sb.table("abc_items").select("*", count="exact", head=True)\
        .eq("manufacturer_norm", brand).eq("product_category_norm", "SHINGLES").execute().count
    print(f"  {brand} SHINGLES (after fix): {cnt:,}")
