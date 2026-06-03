"""
Phase 3 script 6 — Apply SRS-derived (category, family_tier) median prices to ABC.

ABC ships with no prices. SRS has suggested_price populated for 5,646 products
from 54 real customer accounts. Compute medians per (category, tier) from SRS
and apply to ABC's suggested_price column.
"""
import os
import sys
import time
import statistics
from collections import defaultdict
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


# ── 1. Pull SRS priced rows ────────────────────────────────────
print("Step 1: Fetching SRS priced products...")
srs_rows = []
offset = 0
while True:
    page = retry(
        lambda o=offset: sb.table("srs_products")
            .select("product_category,family_tier,suggested_price")
            .not_.is_("suggested_price", "null")
            .range(o, o + 999).execute().data,
        f"srs page offset={offset}"
    )
    if not page:
        break
    srs_rows.extend(page)
    if len(page) < 1000:
        break
    offset += 1000
print(f"Fetched {len(srs_rows):,} priced SRS rows")

# ── 2. Build median price map ──────────────────────────────────
print("\nStep 2: Computing (category, tier) median prices from SRS...")
grouped = defaultdict(list)
for r in srs_rows:
    cat = r.get("product_category")
    tier = r.get("family_tier")
    price = r.get("suggested_price")
    if cat and tier and price is not None:
        grouped[(cat, tier)].append(float(price))

median_map = {}
for (cat, tier), prices in grouped.items():
    median_map[(cat, tier)] = round(statistics.median(prices), 2)

# Category-only median (fallback when (cat, tier) has no SRS data)
cat_median_map = {}
cat_groups = defaultdict(list)
for r in srs_rows:
    cat = r.get("product_category")
    price = r.get("suggested_price")
    if cat and price is not None:
        cat_groups[cat].append(float(price))
for cat, prices in cat_groups.items():
    cat_median_map[cat] = round(statistics.median(prices), 2)

print(f"Computed {len(median_map)} (category, tier) medians:")
print(f"{'category':<25} {'tier':<8} {'n':>5}  {'median':>9}")
print("-" * 55)
for (cat, tier), med in sorted(median_map.items(), key=lambda x: (x[0][0], x[0][1])):
    n = len(grouped[(cat, tier)])
    print(f"  {cat:<23} {tier:<8} {n:>5}  ${med:>8.2f}")

# ── 3. Fetch all ABC rows (need category_norm + family_tier + item_number) ──
print("\nStep 3: Fetching ABC rows (keyset pagination)...")
abc_rows = []
last_id = 0
while True:
    page = retry(
        lambda lid=last_id: sb.table("abc_items")
            .select("id,item_number,product_category_norm,family_tier")
            .gt("id", lid).order("id").limit(1000).execute().data,
        f"abc page last_id={last_id}"
    )
    if not page:
        break
    abc_rows.extend(page)
    last_id = page[-1]["id"]
    if len(abc_rows) % 50000 == 0:
        print(f"  ...fetched {len(abc_rows):,}")
print(f"Fetched {len(abc_rows):,} ABC rows")

# ── 4. Map each ABC row to a price ─────────────────────────────
print("\nStep 4: Mapping ABC rows to median prices...")
# Group ABC item_numbers by price -> [item_number, ...]
price_groups = defaultdict(list)
priced_count = 0
unmatched = defaultdict(int)
for r in abc_rows:
    cat = r.get("product_category_norm")
    tier = r.get("family_tier")
    if cat is None or tier is None:
        unmatched[(cat, tier)] += 1
        continue
    price = median_map.get((cat, tier)) or cat_median_map.get(cat)
    if price is None:
        unmatched[(cat, tier)] += 1
        continue
    price_groups[price].append(r["item_number"])
    priced_count += 1

print(f"Will set price for: {priced_count:,} ABC rows ({100*priced_count/len(abc_rows):.1f}%)")
print(f"Unmatched (no SRS data for that category/tier): {sum(unmatched.values()):,}")
if unmatched:
    print("Unmatched breakdown:")
    for (cat, tier), n in sorted(unmatched.items(), key=lambda x: -x[1])[:20]:
        print(f"  {n:>6,} - ({cat or 'NULL'}, {tier or 'NULL'})")

print(f"\nDistinct price values to apply: {len(price_groups)}")

if DRY_RUN:
    print("\n[DRY RUN] skipping DB update.")
    sys.exit(0)

# ── 5. Apply in chunks of 500 ──────────────────────────────────
print("\nStep 5: Applying prices in chunks of 500...")
CHUNK = 500
total_updated = 0
for price, item_nums in sorted(price_groups.items(), key=lambda kv: -len(kv[1])):
    for j in range(0, len(item_nums), CHUNK):
        batch = item_nums[j:j+CHUNK]
        retry(
            lambda b=batch, p=price: sb.table("abc_items").update({
                "suggested_price": p,
            }).in_("item_number", b).execute(),
            f"update price=${price} chunk {j}"
        )
        total_updated += len(batch)
    if len(item_nums) > 5000:
        print(f"  ${price:>8.2f} - {len(item_nums):,} rows")

print(f"\nTotal priced: {total_updated:,}")
