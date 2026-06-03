"""
Find ABC family_ids for each universal accessory slot.

Reads abc_items directly (not the view — abc_products GROUP BY is too slow over
316K rows for ad-hoc queries) and dedupes by family_id in Python.

Output: top 5 candidates per slot, ordered by suggested_price.
Pick one family_id per slot and add to zuper-importer/lib/abc-accessory-catalog.ts.

Usage:  py find-abc-accessory-gaps.py
"""
import os
import time
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


# proposal_line_item, ordering preference (cheap = lowest price wins)
SLOTS = [
    "Drip Edge",
    "Underlayment - Synthetic",
    "Ice & Water - Standard",
    "Ice & Water - High Temp",
    "Coil Nails",
    "Plastic Cap Nails",
    "Step Flashing",
    "W-Valley",
    'Pipe Boot 3"',
    "Ridge Vent",
    "Starter Strip",
    "Caulk / Sealant",
    "Counter / Headwall Flashing",
    "Gutter Apron",
    "Box Vent",
]


def retry(fn, label, max_attempts=5):
    backoff = 2
    for attempt in range(max_attempts):
        try:
            return fn()
        except Exception as e:
            if attempt == max_attempts - 1:
                raise
            print(f"  [retry] {label}: {type(e).__name__}. Waiting {backoff}s...", flush=True)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)


def find_candidates(line_item):
    """Query abc_items, group by family_id in Python, return top 10 unique families."""
    # The actual proposal_line_item values use em-dash (U+2014) for "Underlayment — Synthetic"
    # since that's what's stored in the DB. Try both ASCII and em-dash forms.
    forms_to_try = [line_item]
    if " - " in line_item:
        forms_to_try.append(line_item.replace(" - ", " — "))
    if " — " in line_item:
        forms_to_try.append(line_item.replace(" — ", " - "))

    rows = []
    for form in forms_to_try:
        try:
            rows = retry(
                lambda f=form: sb.table("abc_items")
                    .select("family_id,family_name,manufacturer_norm,product_category_norm,family_tier,accessory_tier,suggested_price")
                    .eq("proposal_line_item", f)
                    .not_.is_("family_id", "null")
                    .order("suggested_price", desc=False, nullsfirst=False)
                    .limit(200).execute().data,
                f"fetch {line_item[:30]}",
                max_attempts=3,
            )
        except Exception:
            continue
        if rows:
            break

    # Dedup by family_id, keep first occurrence (= cheapest)
    seen = set()
    unique = []
    for r in rows:
        fid = r["family_id"]
        if fid in seen:
            continue
        seen.add(fid)
        unique.append(r)
        if len(unique) >= 10:
            break
    return unique


print("\n=== ABC Accessory Gap Finder ===\n")
print("Reads abc_items, dedupes by family_id. Pick one family_id per slot.\n")

picks = []
for slot in SLOTS:
    print(f"\n-- {slot}")
    candidates = find_candidates(slot)
    if not candidates:
        print("  (no candidates — slot will be unfilled for ABC accounts)")
        continue
    for r in candidates[:5]:
        price = f"${r['suggested_price']}" if r.get("suggested_price") else "--"
        name = (r.get("family_name") or "")[:55]
        brand = (r.get("manufacturer_norm") or "NULL")[:18]
        cat = (r.get("product_category_norm") or "NULL")[:18]
        print(f"    {r['family_id']:>10}  [{brand:<18}] {name:<55}  {price}  cat={cat}")
    rec = candidates[0]
    picks.append((slot, rec["family_id"], rec.get("manufacturer_norm"), rec.get("family_name")))


print("\n\n" + "=" * 70)
print("SUGGESTED abc-accessory-catalog.ts entries")
print("=" * 70)
print("export const ABC_ACCESSORY_PRODUCT_IDS: number[] = [")
for slot, fid, brand, name in picks:
    short_name = ((name or "")[:50])
    print(f"  {fid},  // {slot} -- {brand or 'NULL'} -- {short_name}")
print("]")
