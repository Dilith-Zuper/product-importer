"""Deep-dive into ABC catalog — narrowed by category first to avoid full-table scans."""
import os
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

def fetchall(table, sel, filters_eq=None, filters_in=None):
    rows = []
    limit = 1000
    offset = 0
    while True:
        q = sb.table(table).select(sel).range(offset, offset + limit - 1)
        for k, v in (filters_eq or {}).items():
            q = q.eq(k, v)
        for k, vs in (filters_in or {}).items():
            q = q.in_(k, vs)
        batch = q.execute().data
        rows.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return rows

# Steep-slope roofing categories — these are the "shingles" world
SHINGLE_CATS = ["Steep Slope Roofing (<gt/>2:12 Pitch)", "Steep Slope Roofing Accessories"]

# ── 1. Pull just the shingle universe ─────────────────────────
print("=" * 80)
print("1. PULLING STEEP-SLOPE ROOFING UNIVERSE")
print("=" * 80)

shingle_rows = fetchall("abc_items",
    "item_number,family_id,family_name,supplier_name,brand_line_name,product_type_name,category_name,color_name,finish_name,item_description",
    filters_in={"category_name": SHINGLE_CATS})
print(f"Steep Slope Roofing total SKUs: {len(shingle_rows):,}")

# Just the actual shingle category (not accessories)
shingles_only = [r for r in shingle_rows if r["category_name"] == "Steep Slope Roofing (<gt/>2:12 Pitch)"]
accessories  = [r for r in shingle_rows if r["category_name"] == "Steep Slope Roofing Accessories"]
print(f"  Shingles (>2:12):                {len(shingles_only):,}")
print(f"  Shingle Accessories:             {len(accessories):,}")

# ── 2. Top suppliers in shingles ──────────────────────────────
print("\n" + "=" * 80)
print("2. TOP SUPPLIERS IN SHINGLES CATEGORY")
print("=" * 80)
sup_counts = Counter(r["supplier_name"] for r in shingles_only if r.get("supplier_name"))
print(f"Distinct suppliers in shingles: {len(sup_counts)}")
print("\nTop 20:")
for s, n in sup_counts.most_common(20):
    print(f"  {n:>5} — {s}")

# ── 3. Pick GAF/CT/OC by matching supplier names ──────────────
def matches(name, keyword):
    if not name:
        return False
    n = name.upper()
    return keyword in n

big3_groups = {
    "GAF":         [s for s in sup_counts if matches(s, "GAF") and "WACHGAFFEN" not in s.upper()],
    "CERTAINTEED": [s for s in sup_counts if matches(s, "CERTAINTEED")],
    "OWENS CORNING": [s for s in sup_counts if matches(s, "OWENS CORNING")],
}

print("\n" + "=" * 80)
print("3. BIG 3 MATCHING")
print("=" * 80)
for brand, supps in big3_groups.items():
    total = sum(sup_counts[s] for s in supps)
    print(f"\n{brand}: {total} SKUs across {len(supps)} supplier-name variant(s)")
    for s in supps:
        print(f"  {sup_counts[s]:>4} — {s}")

# ── 4. Drill into GAF shingles ────────────────────────────────
print("\n" + "=" * 80)
print("4. GAF SHINGLES — family_id grouping (= product, with variants per row)")
print("=" * 80)

gaf_supps = big3_groups["GAF"]
gaf_sh = [r for r in shingles_only if r["supplier_name"] in gaf_supps]
print(f"GAF shingle SKUs (variants): {len(gaf_sh)}")
fams = defaultdict(list)
for r in gaf_sh:
    fams[r["family_id"]].append(r)
print(f"Distinct family_ids (= distinct products): {len(fams)}")

print("\nGAF shingle products (top 15 by variant count):")
print(f"{'family_id':<18} {'variants':>8}  {'brand_line':<40} family_name")
print("-" * 130)
for fid, items in sorted(fams.items(), key=lambda x: -len(x[1]))[:15]:
    bl = items[0].get("brand_line_name") or ""
    fn = items[0].get("family_name") or "(blank)"
    colors = sorted({r["color_name"] for r in items if r.get("color_name")})
    print(f"{fid:<18} {len(items):>8}  {bl[:38]:<40} {fn[:60]}")
    print(f"{'':>27}  colors: {colors[:8]}{' ...' if len(colors) > 8 else ''}")

# ── 5. Now — one product fully dumped with variants ───────────
print("\n" + "=" * 80)
print("5. ONE GAF SHINGLE PRODUCT IN FULL — all variants")
print("=" * 80)
# Pick the family with most variants
top_fid, top_items = max(fams.items(), key=lambda x: len(x[1]))
print(f"\nfamily_id: {top_fid}")
print(f"family_name: {top_items[0]['family_name']}")
print(f"brand_line_name: {top_items[0]['brand_line_name']}")
print(f"product_type_name: {top_items[0]['product_type_name']}")
print(f"\nAll {len(top_items)} variants:")
print(f"{'item_number':<15} {'color_name':<25} item_description")
print("-" * 110)
for r in top_items[:30]:
    print(f"{r['item_number']:<15} {(r.get('color_name') or ''):<25} {r.get('item_description','')[:60]}")

# ── 6. Fetch one full row with raw_json to see uoms etc ───────
print("\n" + "=" * 80)
print("6. ONE FULL ROW (raw_json — see uoms, hierarchy)")
print("=" * 80)
full = sb.table("abc_items").select("*").eq("item_number", top_items[0]["item_number"]).limit(1).execute().data[0]
raw = full.get("raw_json") or {}
print(f"item_number: {full['item_number']}")
print(f"raw_json keys: {sorted(raw.keys())}")
uoms = raw.get("uoms") or []
print(f"\nUoMs (all): {[(u.get('code'), u.get('description')) for u in uoms]}")
# any other unexpected top-level fields?
captured = {"itemNumber","familyId","familyName","supplierName","isDimensional",
            "itemDescription","marketingDescription","status","color","finish",
            "hierarchy","lastModifiedDate","uoms"}
extra = sorted(set(raw.keys()) - captured)
if extra:
    print(f"\nUNCAPTURED keys (not flattened into columns):")
    for k in extra:
        print(f"  {k}: {str(raw[k])[:200]}")

# ── 7. UoM codes across whole shingle dataset ─────────────────
print("\n" + "=" * 80)
print("7. UOMS USED IN SHINGLES (across all GAF shingle SKUs)")
print("=" * 80)
# Fetch raw_json for GAF shingles only
gaf_item_nums = [r["item_number"] for r in gaf_sh]
uom_counts = Counter()
# Batch in groups of 100 to avoid URL length issues
for i in range(0, len(gaf_item_nums), 100):
    batch = gaf_item_nums[i:i+100]
    rj_rows = sb.table("abc_items").select("raw_json").in_("item_number", batch).execute().data
    for r in rj_rows:
        for u in (r.get("raw_json") or {}).get("uoms") or []:
            if u.get("code"):
                uom_counts[u["code"]] += 1
print(f"UoM codes in GAF shingles (count of SKUs that include each):")
for c, n in uom_counts.most_common():
    print(f"  {n:>4} — {c}")

# ── 8. What about non-shingle categories? Show GAF spread ─────
print("\n" + "=" * 80)
print("8. GAF PRESENCE ACROSS ALL CATEGORIES (not just shingles)")
print("=" * 80)
# Get all GAF items from the supplier name list — use eq per supplier and union
all_gaf = []
for sn in gaf_supps:
    all_gaf.extend(fetchall("abc_items", "category_name,family_id",
                            filters_eq={"supplier_name": sn}))
print(f"All GAF SKUs in ABC: {len(all_gaf):,}")
gaf_cats = Counter(r["category_name"] for r in all_gaf if r.get("category_name"))
print(f"\nGAF coverage by category:")
for c, n in gaf_cats.most_common(15):
    print(f"  {n:>5,} — {c}")
