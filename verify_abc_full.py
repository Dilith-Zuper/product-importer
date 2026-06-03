"""Final sanity check across all ABC enrichments."""
import os
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

print("=" * 80)
print("FULL GAF CATALOG BREAKDOWN — all categories")
print("=" * 80)
print(f"{'Category':<25} {'Total':>8}  Tier breakdown (good / better / best / addon)")
print("-" * 80)
for cat in ("SHINGLES", "HIP AND RIDGE", "STARTER", "UNDERLAYMENT", "ICE AND WATER",
            "DRIP EDGE", "W-VALLEY", "VENTS", "PIPE FLASHING", "OTHER FLASHING METAL",
            "OTHER FASTENERS", "PLASTIC CAPS", "GUTTER APRON", "CAULK",
            "GUTTER/ALUMINUM/COIL", "SIDING", "COMMERCIAL", "OTHER"):
    total = sb.table("abc_items").select("*", count="exact", head=True)\
        .eq("manufacturer_norm", "Gaf").eq("product_category_norm", cat).execute().count
    if total == 0:
        continue
    parts = []
    for tier in ("good", "better", "best", "addon"):
        n = sb.table("abc_items").select("*", count="exact", head=True)\
            .eq("manufacturer_norm", "Gaf").eq("product_category_norm", cat).eq("family_tier", tier).execute().count
        parts.append(f"{n}")
    print(f"  {cat:<23} {total:>8,}  {' / '.join(parts)}")

print()
print("=" * 80)
print("GAF Timberline HDZ — what colors are available?")
print("=" * 80)
rows = sb.table("abc_items").select("color_name,item_number,family_name")\
    .eq("manufacturer_norm", "Gaf").eq("product_category_norm", "SHINGLES")\
    .eq("family_tier", "good").execute().data
colors = sorted({r["color_name"] for r in rows if r.get("color_name")})
print(f"Found {len(rows)} 'good' GAF shingle SKUs across {len({r.get('family_name') for r in rows if r.get('family_name')})} distinct family_names")
print(f"\nDistinct colors ({len(colors)}):")
for c in colors:
    print(f"  - {c}")
print(f"\nDistinct family_names:")
for fn in sorted({r.get("family_name") for r in rows if r.get("family_name")}):
    print(f"  - {fn}")

print()
print("=" * 80)
print("OVERALL SUMMARY")
print("=" * 80)
total = sb.table("abc_items").select("*", count="exact", head=True).execute().count
print(f"Total ABC products: {total:,}")
big3 = sb.table("abc_items").select("*", count="exact", head=True).eq("is_big3_brand", True).execute().count
print(f"is_big3_brand=TRUE: {big3:,}")
universal = sb.table("abc_items").select("*", count="exact", head=True).eq("is_universal", True).execute().count
print(f"is_universal=TRUE: {universal:,}")
no_brand = sb.table("abc_items").select("*", count="exact", head=True).is_("manufacturer_norm", "null").execute().count
print(f"NULL manufacturer_norm (placeholders): {no_brand:,}")
no_cat = sb.table("abc_items").select("*", count="exact", head=True).is_("product_category_norm", "null").execute().count
print(f"NULL product_category_norm: {no_cat:,}")
no_tier = sb.table("abc_items").select("*", count="exact", head=True).is_("family_tier", "null").execute().count
print(f"NULL family_tier: {no_tier:,}")
