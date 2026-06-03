"""
Phase 3 scripts 4 + 5 combined — populate product_line and family_tier.

product_line: copy brand_line_name (already clean, 100% populated)
family_tier:  good | better | best | addon (mirrors SRS classification)

Tier rules (in order):
  1. Brand+line keyword rules (e.g. GAF + "Timberline HDZ" -> good)
  2. Category keyword rules (e.g. UNDERLAYMENT + "synthetic" -> good)
  3. Default: "better" (commodity accessories)
  4. "addon" for legacy/tile/stone-coated/specialty
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

# ── Brand+line tier rules — match substring in brand_line_name (case-insensitive) ──
# Format: (manufacturer_norm, line_substring, tier)
BRAND_LINE_RULES = [
    # ---- GAF ----
    # GOOD = current flagship entry product
    ("Gaf", "timberline hd",          "good"),    # HDZ, HD
    ("Gaf", "timberline natural",     "good"),    # Natural Shadow
    # BETTER = upgraded same family
    ("Gaf", "timberline uhdz",        "better"),
    ("Gaf", "timberline ultra",       "better"),
    # BEST = designer/premium
    ("Gaf", "grand sequoia",          "best"),
    ("Gaf", "grand canyon",           "best"),
    ("Gaf", "camelot",                "best"),
    ("Gaf", "slateline",              "best"),
    ("Gaf", "woodland",               "best"),
    # ADDON = legacy, specialty, impact, solar
    ("Gaf", "royal sovereign",        "addon"),   # 3-tab legacy
    ("Gaf", "armorshield",            "addon"),
    ("Gaf", "solar",                  "addon"),
    ("Gaf", "cool",                   "addon"),
    ("Gaf", "truslate",               "addon"),   # synthetic slate
    ("Gaf", "country mansion",        "addon"),

    # ---- CertainTeed ----
    ("Certainteed", "landmark pro",          "better"),
    ("Certainteed", "landmark premium",      "better"),
    ("Certainteed", "landmark",              "good"),   # base Landmark
    ("Certainteed", "belmont",               "better"),
    ("Certainteed", "presidential",          "best"),
    ("Certainteed", "grand manor",           "best"),
    ("Certainteed", "highland slate",        "best"),
    ("Certainteed", "carriage house",        "best"),
    ("Certainteed", "hatteras",              "best"),
    ("Certainteed", "northgate",             "addon"),
    ("Certainteed", "climateflex",           "addon"),
    ("Certainteed", "patriot",               "addon"),
    ("Certainteed", "xt 25",                 "addon"),
    ("Certainteed", "xt 30",                 "addon"),
    ("Certainteed", "solaris",               "addon"),
    ("Certainteed", "solstice",              "addon"),

    # ---- Owens Corning ----
    ("Owens Corning", "duration max",        "better"),
    ("Owens Corning", "duration premium",    "better"),
    ("Owens Corning", "duration designer",   "best"),
    ("Owens Corning", "duration flex",       "addon"),
    ("Owens Corning", "duration cool",       "addon"),
    ("Owens Corning", "duration storm",      "addon"),
    ("Owens Corning", "duration",            "better"),   # base Duration line (after specific variants above)
    ("Owens Corning", "oakridge",            "good"),
    ("Owens Corning", "woodcrest",           "best"),
    ("Owens Corning", "woodmoor",            "best"),
    ("Owens Corning", "berkshire",           "best"),
    ("Owens Corning", "supreme",             "addon"),    # 3-tab legacy

    # ---- IKO ----
    ("IKO", "cambridge",                     "good"),
    ("IKO", "dynasty",                       "better"),
    ("IKO", "armourshake",                   "best"),
    ("IKO", "royal estate",                  "best"),
    ("IKO", "crowne slate",                  "best"),
    ("IKO", "marathon",                      "addon"),

    # ---- TAMKO ----
    ("TAMKO", "heritage",                    "good"),
    ("TAMKO", "stormfighter",                "better"),
    ("TAMKO", "titan xt",                    "better"),
    ("TAMKO", "elite glass-seal",            "addon"),

    # ---- Malarkey ----
    ("Malarkey", "highlander",               "good"),
    ("Malarkey", "vista",                    "better"),
    ("Malarkey", "legacy",                   "best"),
    ("Malarkey", "windsor",                  "best"),
    ("Malarkey", "ecoasis",                  "best"),

    # ---- Atlas ----
    ("Atlas", "pinnacle pristine",           "good"),
    ("Atlas", "pinnacle impact",             "addon"),
    ("Atlas", "pinnacle cool",               "addon"),
    ("Atlas", "stormmaster",                 "better"),
    ("Atlas", "prolam",                      "better"),
    ("Atlas", "glassmaster",                 "addon"),

    # ---- Pabco ----
    ("PABCO", "premier",                     "good"),
    ("PABCO", "paramount",                   "better"),
    ("PABCO", "prestige",                    "best"),
    ("PABCO", "radiance",                    "addon"),

    # ---- Tile / stone-coated / synthetic — all ADDON ----
    (None, "truslate",                       "addon"),
    (None, "davinci",                        "addon"),
    (None, "brava",                          "addon"),
    (None, "decra",                          "addon"),
    (None, "boral roofing",                  "addon"),
    (None, "monier",                         "addon"),
    (None, "tilcor",                         "addon"),
    (None, "eagle tile",                     "addon"),
    (None, "metro roof",                     "addon"),
    (None, "tesla",                          "addon"),
    (None, "cedur",                          "addon"),
]

# ── Category keyword rules (for non-shingle products) ──
# Format: (category, keyword_in_brand_line_or_family_name, tier)
CATEGORY_RULES = [
    # UNDERLAYMENT differentiation
    ("UNDERLAYMENT", "felt",                "addon"),
    ("UNDERLAYMENT", "30# ",                "addon"),
    ("UNDERLAYMENT", "15# ",                "addon"),
    ("UNDERLAYMENT", "synthetic",           "good"),
    ("UNDERLAYMENT", "high temp",           "better"),
    ("UNDERLAYMENT", "self-adhered",        "better"),
    ("UNDERLAYMENT", "mineral surface",     "addon"),
    # ICE AND WATER
    ("ICE AND WATER", "high temp",          "better"),
    ("ICE AND WATER", "ht ",                "better"),
]

# Categories that get "addon" by default
ADDON_CATEGORIES = {"TOOLS/SAFETY", "OTHER", "SKYLIGHTS"}


def classify_tier(manufacturer_norm, brand_line, family_name, category):
    """Return tier (good/better/best/addon)."""
    bl = (brand_line or "").lower()
    fn = (family_name or "").lower()
    haystack = f"{bl} {fn}"

    # 1. Brand+line rules
    for brand, sub, tier in BRAND_LINE_RULES:
        if sub in haystack:
            if brand is None or brand == manufacturer_norm:
                return tier

    # 2. Category keyword rules
    for cat, kw, tier in CATEGORY_RULES:
        if cat == category and kw in haystack:
            return tier

    # 3. Category defaults
    if category in ADDON_CATEGORIES:
        return "addon"

    # 4. Default
    return "better"


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


# ── Fetch all rows via keyset pagination ────────────────────────
print("Fetching all rows (id, item_number, manufacturer_norm, brand_line_name, family_name, product_category_norm)...")
rows = []
last_id = 0
while True:
    page = retry(
        lambda lid=last_id: sb.table("abc_items")
            .select("id,item_number,manufacturer_norm,brand_line_name,family_name,product_category_norm")
            .gt("id", lid).order("id").limit(1000).execute().data,
        f"fetch last_id={last_id}"
    )
    if not page:
        break
    rows.extend(page)
    last_id = page[-1]["id"]
    if len(rows) % 25000 == 0:
        print(f"  ...fetched {len(rows):,}")
print(f"Fetched {len(rows):,} rows")

# ── Compute classifications ─────────────────────────────────────
# Group by (product_line, family_tier) -> [item_number, ...]
groups = defaultdict(list)
for r in rows:
    item_num = r["item_number"]
    bl = r.get("brand_line_name")
    tier = classify_tier(
        r.get("manufacturer_norm"),
        bl,
        r.get("family_name"),
        r.get("product_category_norm"),
    )
    # product_line = brand_line_name (copy as-is)
    groups[(bl, tier)].append(item_num)

# Stats
tier_counts = Counter()
for (bl, tier), items in groups.items():
    tier_counts[tier] += len(items)

print(f"\nTier distribution:")
for tier in ("good", "better", "best", "addon"):
    n = tier_counts.get(tier, 0)
    pct = 100 * n / len(rows) if rows else 0
    print(f"  {tier:<7}: {n:>7,} ({pct:.1f}%)")
print(f"\nDistinct (product_line, tier) groups: {len(groups):,}")

# Sanity: tier breakdown for Big 3 shingles
print("\nBig 3 SHINGLES by tier (sanity):")
big3_tiers = defaultdict(lambda: defaultdict(int))
for r in rows:
    if r.get("product_category_norm") == "SHINGLES" and r.get("manufacturer_norm") in ("Gaf", "Certainteed", "Owens Corning"):
        tier = classify_tier(r.get("manufacturer_norm"), r.get("brand_line_name"), r.get("family_name"), "SHINGLES")
        big3_tiers[r["manufacturer_norm"]][tier] += 1
for brand in ("Gaf", "Certainteed", "Owens Corning"):
    counts = big3_tiers[brand]
    line = " | ".join(f"{t}: {counts.get(t, 0)}" for t in ("good", "better", "best", "addon"))
    print(f"  {brand:<15}  {line}")

if DRY_RUN:
    print("\n[DRY RUN] skipping DB update.")
    sys.exit(0)

# ── Apply in chunks of 500 ──────────────────────────────────────
print("\nApplying updates in chunks of 500...")
CHUNK = 500
total_updated = 0
sorted_groups = sorted(groups.items(), key=lambda kv: -len(kv[1]))
for i, ((bl, tier), item_nums) in enumerate(sorted_groups, 1):
    for j in range(0, len(item_nums), CHUNK):
        batch = item_nums[j:j+CHUNK]
        retry(
            lambda b=batch, _bl=bl, t=tier: sb.table("abc_items").update({
                "product_line": _bl,
                "family_tier": t,
            }).in_("item_number", b).execute(),
            f"update {tier}/{(bl or 'NULL')[:20]} chunk {j}"
        )
        total_updated += len(batch)
    if i % 100 == 0 or len(item_nums) > 1000:
        print(f"  [{i}/{len(sorted_groups)}] {tier} / '{(bl or 'NULL')[:40]}': {len(item_nums):,}")

print(f"\nTotal updated: {total_updated:,}")
