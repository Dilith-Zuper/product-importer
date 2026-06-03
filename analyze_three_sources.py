"""Compare SRS, QXO, and ABC product catalogs side-by-side."""
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

def count(table, filters=None):
    q = sb.table(table).select("*", count="exact", head=True)
    for k, v in (filters or {}).items():
        q = q.eq(k, v)
    return q.execute().count

def distinct_count(table, col):
    """Get distinct count of a column via aggregation."""
    rows = sb.table(table).select(col).execute().data
    return len({r[col] for r in rows if r.get(col)})

print("=" * 70)
print("ROW COUNTS")
print("=" * 70)
print(f"srs_products:        {count('srs_products'):>10,}")
print(f"srs_variants:        {count('srs_variants'):>10,}")
print(f"srs_product_families:{count('srs_product_families'):>10,}")
print()
print(f"qxo_products:        {count('qxo_products'):>10,}")
print(f"qxo_variants:        {count('qxo_variants'):>10,}")
print(f"qxo_branches:        {count('qxo_branches'):>10,}")
print(f"qxo_branch_sku:      {count('qxo_branch_sku'):>10,}")
print()
print(f"abc_items:        {count('abc_items'):>10,}")

print()
print("=" * 70)
print("ABC SCHEMA — sample row")
print("=" * 70)
sample = sb.table("abc_items").select("*").limit(1).execute().data[0]
for k, v in sample.items():
    val = str(v)[:80]
    print(f"  {k:<25} {val}")

print()
print("=" * 70)
print("ABC — top suppliers (= brands) by item count")
print("=" * 70)
# Fetch all and count in Python (no GROUP BY in supabase REST)
suppliers = {}
limit = 1000
offset = 0
while True:
    batch = sb.table("abc_items").select("supplier_name").range(offset, offset + limit - 1).execute().data
    for r in batch:
        s = r.get("supplier_name") or "(null)"
        suppliers[s] = suppliers.get(s, 0) + 1
    if len(batch) < limit:
        break
    offset += limit
print(f"Total unique suppliers: {len(suppliers)}")
print(f"Top 25:")
for name, cnt in sorted(suppliers.items(), key=lambda x: -x[1])[:25]:
    print(f"  {cnt:>6,} — {name}")

print()
print("=" * 70)
print("ABC — top categories by item count")
print("=" * 70)
cats = {}
offset = 0
while True:
    batch = sb.table("abc_items").select("category_name").range(offset, offset + limit - 1).execute().data
    for r in batch:
        c = r.get("category_name") or "(null)"
        cats[c] = cats.get(c, 0) + 1
    if len(batch) < limit:
        break
    offset += limit
print(f"Total unique categories: {len(cats)}")
print(f"Top 25:")
for name, cnt in sorted(cats.items(), key=lambda x: -x[1])[:25]:
    print(f"  {cnt:>6,} — {name}")

print()
print("=" * 70)
print("ABC — top brand_line_name (the actual brand)")
print("=" * 70)
brands = {}
offset = 0
while True:
    batch = sb.table("abc_items").select("brand_line_name").range(offset, offset + limit - 1).execute().data
    for r in batch:
        b = r.get("brand_line_name") or "(null/blank)"
        brands[b] = brands.get(b, 0) + 1
    if len(batch) < limit:
        break
    offset += limit
print(f"Total unique brand_line_name: {len(brands)}")
print(f"Top 25:")
for name, cnt in sorted(brands.items(), key=lambda x: -x[1])[:25]:
    print(f"  {cnt:>6,} — {name}")

print()
print("=" * 70)
print("ABC — field population stats")
print("=" * 70)
# Sample 5000 rows to estimate population
sample = sb.table("abc_items").select("*").limit(5000).execute().data
n = len(sample)
fields = ["family_id", "family_name", "supplier_name", "is_dimensional",
          "item_description", "marketing_description", "status",
          "color_code", "color_name", "finish_code", "finish_name",
          "product_group_name", "category_name", "product_type_name",
          "brand_line_name"]
for f in fields:
    populated = sum(1 for r in sample if r.get(f) not in (None, "", []))
    pct = 100 * populated / n
    print(f"  {f:<25} {populated:>5,}/{n} ({pct:.1f}%)")

print()
print("=" * 70)
print("BRAND OVERLAP — Big 3 across SRS / QXO / ABC")
print("=" * 70)
big3 = ["GAF", "CERTAINTEED", "OWENS CORNING"]
for brand in big3:
    srs_norm = brand.title().replace("certainteed".title(), "Certainteed")
    srs_cnt = sb.table("srs_products").select("*", count="exact", head=True).eq("manufacturer_norm", srs_norm if brand != "GAF" else "Gaf").execute().count
    qxo_cnt = sb.table("qxo_products").select("*", count="exact", head=True).eq("manufacturer_norm", srs_norm if brand != "GAF" else "Gaf").execute().count
    # ABC: check supplier_name (uppercase)
    abc_supp_cnt = suppliers.get(brand, 0)
    # ABC: also check brand_line_name
    abc_brand_cnt = brands.get(brand, 0) + brands.get(brand.title(), 0)
    print(f"  {brand:<20} SRS={srs_cnt:>5,}  QXO={qxo_cnt:>5,}  ABC(supplier)={abc_supp_cnt:>5,}  ABC(brand_line)={abc_brand_cnt:>5,}")
