"""
Phase 4 — populate abc_items.proposal_line_item.

Maps each ABC item to one of the 41 fixed proposal_line_items via
lib/abc_classifier.classify_abc_product(category, family_name, brand_line, product_type).

Writes an abc-unmapped-categories.json coverage report at the end.

Usage:
    py enrich-abc-proposal-line-item.py            # apply
    py enrich-abc-proposal-line-item.py --dry-run  # classify only, no DB writes
"""

import os
import sys
import time
import json
from collections import Counter, defaultdict
from supabase import create_client

sys.path.insert(0, os.path.dirname(__file__))
from lib.abc_classifier import classify_abc_product


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


# ── 1. Fetch all abc_items with keyset pagination on id ──────────────────
print("Step 1: Fetching abc_items rows (keyset pagination by id)...", flush=True)
items = []
last_id = 0
while True:
    page = retry(
        lambda lid=last_id: sb.table("abc_items")
            .select("id,item_number,family_id,family_name,product_category_norm,brand_line_name,product_type_name,proposal_line_item")
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


# ── 2. Classify each item ────────────────────────────────────────────────
print("\nStep 2: Classifying...", flush=True)
distribution = Counter()
groups = defaultdict(list)   # proposal_line_item (or None) → [item_number, ...]
unmapped_by_cat = defaultdict(lambda: {"count": 0, "samples": []})

skipped_unchanged = 0
for r in items:
    li = classify_abc_product(
        r.get("product_category_norm"),
        r.get("family_name"),
        r.get("brand_line_name"),
        r.get("product_type_name"),
    )
    key = li or "(none)"
    distribution[key] += 1

    if li is None:
        cat = r.get("product_category_norm") or "(no category)"
        entry = unmapped_by_cat[cat]
        entry["count"] += 1
        if len(entry["samples"]) < 5:
            entry["samples"].append(r.get("family_name"))

    # Skip update if value is unchanged
    if (r.get("proposal_line_item") or None) == (li or None):
        skipped_unchanged += 1
        continue
    groups[li].append(r["item_number"])


# ── 3. Distribution summary ──────────────────────────────────────────────
total_mapped = len(items) - distribution["(none)"]
pct = (total_mapped / len(items) * 100) if items else 0.0
print(f"\n--- Line item distribution ---")
for k, n in distribution.most_common():
    print(f"  {n:>7,}  {k}")
print(f"\n  Mapped: {total_mapped:,} / {len(items):,} ({pct:.1f}%)")
print(f"  Unchanged (skip): {skipped_unchanged:,}")


# ── 4. Coverage report ───────────────────────────────────────────────────
report_rows = sorted(
    ({"category": cat, **info} for cat, info in unmapped_by_cat.items()),
    key=lambda r: -r["count"],
)
report_path = "abc-unmapped-categories.json"
with open(report_path, "w", encoding="utf-8") as f:
    json.dump({
        "totalUnmapped": distribution["(none)"],
        "distinctCategories": len(report_rows),
        "rows": report_rows,
    }, f, indent=2)
print(f"\n--- Top 15 unmapped categories (by count) ---")
for r in report_rows[:15]:
    print(f"  {r['count']:>6,}  {r['category']}")
print(f"  -> full report: {report_path}")


# ── 5. Apply updates (grouped by proposal_line_item value) ───────────────
if DRY_RUN:
    print("\n[DRY RUN] skipping DB update.", flush=True)
    sys.exit(0)

total_to_update = sum(len(v) for v in groups.values())
if total_to_update == 0:
    print("\nNothing to write.", flush=True)
    sys.exit(0)

print(f"\nStep 5: Applying {total_to_update:,} updates in batches of 500...", flush=True)
CHUNK = 500
done = 0
for li, item_nums in sorted(groups.items(), key=lambda kv: -len(kv[1])):
    val = li if li is not None else None
    print(f"  {('NULL' if val is None else val):<35} {len(item_nums):>6,} items", flush=True)
    for j in range(0, len(item_nums), CHUNK):
        batch = item_nums[j:j + CHUNK]
        retry(
            lambda b=batch, v=val: sb.table("abc_items").update({
                "proposal_line_item": v,
            }).in_("item_number", b).execute(),
            f"update {li} chunk {j}",
        )
        done += len(batch)
print(f"\nTotal updated: {done:,}", flush=True)


# ── 6. Sanity check ──────────────────────────────────────────────────────
print("\nStep 6: Sanity check", flush=True)
mapped = retry(
    lambda: sb.table("abc_items").select("*", count="exact", head=True)
        .not_.is_("proposal_line_item", "null").execute().count,
    "sanity count",
)
print(f"  abc_items with proposal_line_item populated: {mapped:,}")
