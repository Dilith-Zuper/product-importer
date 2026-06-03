"""
Phase 4 — populate abc_items.accessory_tier.

Ported from enrich-accessory-tier.js (SRS). Splits family_tier='better' products
into 3 price-quartile bands within (product_category_norm, manufacturer_norm):
  bottom 1/3 → good_accessory
  middle 1/3 → better_accessory
  top 1/3    → best_accessory
Families with no price land in 'better_accessory' (safe default).

Tiering happens at the FAMILY level (one tier per family_id), then applied to
all items in that family. The abc_products view uses MIN(accessory_tier) so
keeping the tier consistent within a family is important.

Usage:
    py enrich-abc-accessory-tier.py            # apply
    py enrich-abc-accessory-tier.py --dry-run  # classify only, no DB writes
"""

import os
import sys
import time
import statistics
from collections import defaultdict, Counter
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
            print(f"  [retry] {label}: {type(e).__name__}. Waiting {backoff}s...", flush=True)
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)


# ── 1. Fetch all abc_items (keyset pagination on id) ─────────────────────
print("Step 1: Fetching abc_items rows (family_tier, price, family_id) ...", flush=True)
items = []
last_id = 0
while True:
    page = retry(
        lambda lid=last_id: sb.table("abc_items")
            .select("id,item_number,family_id,product_category_norm,manufacturer_norm,family_tier,suggested_price,accessory_tier")
            .gt("id", lid).order("id").limit(1000).execute().data,
        f"fetch last_id={last_id}",
    )
    if not page:
        break
    items.extend(page)
    last_id = page[-1]["id"]
    if len(items) % 20000 == 0:
        print(f"  ...fetched {len(items):,}", flush=True)
print(f"Fetched {len(items):,} rows", flush=True)


# ── 2. Aggregate by family_id, keep only family_tier='better' families ───
print("\nStep 2: Aggregating to family level...", flush=True)
families = {}     # family_id → { category, brand, prices: [..], items: [item_number, ...] }
for r in items:
    fid = r.get("family_id")
    if fid is None:
        continue
    if r.get("family_tier") != "better":
        continue
    if fid not in families:
        families[fid] = {
            "category": r.get("product_category_norm"),
            "brand":    r.get("manufacturer_norm"),
            "prices":   [],
            "items":    [],
        }
    fam = families[fid]
    fam["items"].append(r["item_number"])
    p = r.get("suggested_price")
    if p is not None and p > 0:
        fam["prices"].append(float(p))

print(f"  {len(families):,} 'better' families (out of ~35K total)", flush=True)


# ── 3. Classify each family by price quartile within (category, brand) ────
print("\nStep 3: Classifying families by (category, brand) price quartile...", flush=True)

# Compute avg price per family
for fam in families.values():
    fam["avg_price"] = statistics.mean(fam["prices"]) if fam["prices"] else None

# Group by (category, brand)
by_group = defaultdict(list)
for fid, fam in families.items():
    key = (fam["category"], fam["brand"] or "(unknown)")
    by_group[key].append((fid, fam))

# Assign tier per family
assignments = {}   # family_id → 'good_accessory' | 'better_accessory' | 'best_accessory'
for (cat, brand), group in by_group.items():
    priced   = [(fid, fam) for fid, fam in group if fam["avg_price"] is not None]
    unpriced = [(fid, fam) for fid, fam in group if fam["avg_price"] is None]

    for fid, _ in unpriced:
        assignments[fid] = "better_accessory"

    priced.sort(key=lambda kv: kv[1]["avg_price"])
    n = len(priced)
    if n == 0:
        continue
    if n <= 2:
        for fid, _ in priced:
            assignments[fid] = "better_accessory"
        continue

    third1 = n // 3
    third2 = (2 * n) // 3
    for idx, (fid, _) in enumerate(priced):
        if idx < third1:
            assignments[fid] = "good_accessory"
        elif idx < third2:
            assignments[fid] = "better_accessory"
        else:
            assignments[fid] = "best_accessory"


# ── 4. Distribution + spot-check ─────────────────────────────────────────
dist = Counter(assignments.values())
print("\n--- accessory_tier distribution (family-level) ---")
for tier, n in dist.most_common():
    print(f"  {tier:<18}: {n:>6,}")

# Top 10 (category, brand) groups
print("\n--- Top 10 (category, brand) groups ---")
group_dist = defaultdict(lambda: Counter())
for (cat, brand), group in by_group.items():
    for fid, _ in group:
        group_dist[(cat, brand)][assignments.get(fid, "better_accessory")] += 1
for (cat, brand), d in sorted(group_dist.items(), key=lambda kv: -sum(kv[1].values()))[:10]:
    total = sum(d.values())
    print(f"  {(cat or 'NULL'):<22} {(brand or 'NULL'):<22} total={total:>4}  g={d['good_accessory']:>3} b={d['better_accessory']:>3} B={d['best_accessory']:>3}")


# ── 5. Build item-level assignments ──────────────────────────────────────
print("\nStep 5: Expanding family-level tiers back to item-level...", flush=True)
groups = defaultdict(list)   # accessory_tier → [item_number, ...]
skipped_unchanged = 0

# Build index: item_number → current accessory_tier (for skip-unchanged)
current_tier_by_item = {r["item_number"]: r.get("accessory_tier") for r in items if r.get("family_id") in families}

for fid, fam in families.items():
    new_tier = assignments.get(fid, "better_accessory")
    for item_num in fam["items"]:
        cur = current_tier_by_item.get(item_num)
        if cur == new_tier:
            skipped_unchanged += 1
            continue
        groups[new_tier].append(item_num)

total_to_update = sum(len(v) for v in groups.values())
print(f"  {total_to_update:,} items to update; {skipped_unchanged:,} unchanged", flush=True)


# ── 6. Apply updates ─────────────────────────────────────────────────────
if DRY_RUN:
    print("\n[DRY RUN] skipping DB update.", flush=True)
    sys.exit(0)

if total_to_update == 0:
    print("\nNothing to write.", flush=True)
    sys.exit(0)

print(f"\nStep 6: Applying {total_to_update:,} updates in batches of 500...", flush=True)
CHUNK = 500
done = 0
for tier, item_nums in groups.items():
    print(f"  {tier:<18}: {len(item_nums):>6,} items", flush=True)
    for j in range(0, len(item_nums), CHUNK):
        batch = item_nums[j:j + CHUNK]
        retry(
            lambda b=batch, t=tier: sb.table("abc_items").update({
                "accessory_tier": t,
            }).in_("item_number", b).execute(),
            f"update {tier} chunk {j}",
        )
        done += len(batch)
print(f"\nTotal updated: {done:,}", flush=True)


# ── 7. Sanity check ──────────────────────────────────────────────────────
print("\nStep 7: Sanity check", flush=True)
for tier in ("good_accessory", "better_accessory", "best_accessory"):
    n = retry(
        lambda t=tier: sb.table("abc_items").select("*", count="exact", head=True)
            .eq("accessory_tier", t).execute().count,
        f"count {tier}",
    )
    print(f"  abc_items WHERE accessory_tier='{tier}': {n:,}")
