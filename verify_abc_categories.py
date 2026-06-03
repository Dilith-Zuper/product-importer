"""Verify ABC category normalization didn't accidentally over-include things."""
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

print("GAF — products by product_category_norm:")
print("-" * 70)
# Use brand_line_name aggregation to understand what kinds of products are in each category
for cat in ["SHINGLES", "HIP AND RIDGE", "STARTER", "UNDERLAYMENT", "ICE AND WATER",
            "DRIP EDGE", "W-VALLEY", "VENTS", "PIPE FLASHING", "OTHER FLASHING METAL",
            "OTHER FASTENERS", "PLASTIC CAPS", "GUTTER APRON", "OTHER"]:
    cnt = sb.table("abc_items").select("*", count="exact", head=True)\
        .eq("manufacturer_norm", "Gaf").eq("product_category_norm", cat).execute().count
    if cnt > 0:
        # Show top 3 brand_line_names in this slice
        rows = sb.table("abc_items").select("brand_line_name,family_name")\
            .eq("manufacturer_norm", "Gaf").eq("product_category_norm", cat).limit(3).execute().data
        print(f"\n  {cat}: {cnt} SKUs")
        for r in rows:
            print(f"    - brand_line: {r.get('brand_line_name')}")
            print(f"      family:     {r.get('family_name')}")

print("\n\nGAF SHINGLES — check no HIP AND RIDGE got mis-classified into SHINGLES:")
rows = sb.table("abc_items").select("family_name,brand_line_name,product_type_name")\
    .eq("manufacturer_norm", "Gaf").eq("product_category_norm", "SHINGLES").execute().data
# Look for "Ridge" / "Starter" in family names — those would be misclassified
suspicious = [r for r in rows if r.get("family_name") and any(k in r["family_name"].lower() for k in ["ridge", "starter"])]
print(f"  Suspicious (family contains 'ridge' or 'starter'): {len(suspicious)}")
for s in suspicious[:5]:
    print(f"    family='{s['family_name']}'  brand_line='{s['brand_line_name']}'  product_type='{s['product_type_name']}'")
