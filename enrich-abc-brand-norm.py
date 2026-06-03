"""
Phase 3 script 2 — Normalize ABC supplier_name into manufacturer_norm.

ABC has 1,523 distinct supplier names with issues:
  - SHOUTING UPPERCASE
  - Category suffixes (-ROOFING / -SIDING / -COMM)
  - Corporate suffixes (LLC, INC, CORP, LTD, CO INC)
  - Multiple suppliers per brand (e.g. CERTAINTEED LLC-ROOFING + CERTAINTEED LLC-SIDING -> Certainteed)
  - Placeholders ("MUST ASSIGN A VALID SUPPLIER", "Misc. Vendor")

Output: writes manufacturer_norm + is_big3_brand to abc_items.
"""
import os
import re
import sys
from collections import Counter
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

# ── Explicit brand map — covers top suppliers + Big 3 ──────────────────
# Key: a substring/keyword that uniquely identifies the brand (uppercase)
# Value: canonical manufacturer_norm (matches SRS title-case convention)
BRAND_MAP = [
    # (uppercase-keyword, canonical_name)
    # Big 3
    ("GAF",                            "Gaf"),
    ("CERTAINTEED",                    "Certainteed"),
    ("OWENS CORNING",                  "Owens Corning"),
    # Top tier
    ("JAMES HARDIE",                   "James Hardie"),
    ("WESTLAKE/BORAL",                 "Westlake Royal"),  # rebranded
    ("WESTLAKE DAVINCI",               "DaVinci"),
    ("WESTLAKE ROYAL",                 "Westlake Royal"),
    ("ROYAL BUILDING",                 "Royal Building Products"),
    ("PLYGEM",                         "PlyGem"),
    ("MASTIC",                         "Mastic"),
    ("PROVIA",                         "ProVia"),
    ("MULEHIDE",                       "Mule-Hide"),
    ("MULE-HIDE",                      "Mule-Hide"),
    ("AMRIZE",                         "Amrize"),
    ("BERGER",                         "Berger"),
    ("WAUSAU",                         "Wausau"),
    ("EDCO",                           "Edco"),
    ("OLDCASTLE",                      "Oldcastle"),
    ("ASSOCIATED MATERIALS",           "Associated Materials"),
    ("QUALITY ALUMINUM",               "Quality Aluminum"),
    ("ROLLEX",                         "Rollex"),
    ("THERMA TRU",                     "Therma-Tru"),
    ("THERMA-TRU",                     "Therma-Tru"),
    ("VARIFORM",                       "Variform"),
    ("ATLAS ROOFING",                  "Atlas"),
    ("ATLAS COMPONENT",                "Atlas"),
    ("ATLAS BLDG",                     "Atlas"),
    ("METAL SALES",                    "Metal Sales"),
    ("IKO METALS",                     "IKO"),
    ("IKO INDUSTRIES",                 "IKO"),
    ("IKO MFG",                        "IKO"),
    ("MALARKEY",                       "Malarkey"),
    ("CENTRAL STATES",                 "Central States"),
    ("TAMKO",                          "TAMKO"),
    ("EAGLE ROOFING",                  "Eagle"),
    ("CROWN BUILDING",                 "Crown"),
    ("VELUX",                          "Velux"),
    ("FYPON",                          "Fypon"),
    ("DECRA",                          "DECRA"),
    ("BORAL",                          "Boral"),
    ("MONIER",                         "Monier"),
    ("METRO ROOF",                     "Metro Roof Products"),
    ("PABCO",                          "PABCO"),
    ("WORTHOUSE",                      "Worthouse"),
    ("STAROBA",                        "Staroba"),
    ("HENRY",                          "Henry"),
    ("GAF MATERIALS",                  "Gaf"),
    ("TIMBERTECH",                     "TimberTech"),
    ("AZEK",                           "AZEK"),
    ("TREX",                           "Trex"),
    ("LP BUILDING",                    "LP"),
    ("LOUISIANA-PACIFIC",              "LP"),
    ("ALLURA",                         "Allura"),
    ("NICHIHA",                        "Nichiha"),
    ("CARLISLE",                       "Carlisle"),
    ("FIRESTONE",                      "Firestone"),
    ("JOHNS MANVILLE",                 "Johns Manville"),
    ("SOPREMA",                        "Soprema"),
    ("POLYGLASS",                      "Polyglass"),
    ("VERSICO",                        "Versico"),
    ("GENFLEX",                        "GenFlex"),
    ("OWENS-CORNING",                  "Owens Corning"),
    ("DURO-LAST",                      "Duro-Last"),
    ("DUROLAST",                       "Duro-Last"),
    ("BRAVA",                          "Brava"),
    ("DAVINCI",                        "DaVinci"),
    ("CEDUR",                          "Cedur"),
    ("SBS BUILDING",                   "SBS"),
    ("STINGER",                        "Stinger"),
    ("LOMANCO",                        "Lomanco"),
    ("AIR VENT",                       "Air Vent"),
    ("VENT-A-RIDGE",                   "Vent-a-Ridge"),
    ("MID-AMERICA",                    "Mid-America"),
    ("OMG ROOFING",                    "OMG"),
    ("ITW",                            "ITW"),
    ("DRYDEX",                         "DryDex"),
    ("DUPONT",                         "DuPont"),
    ("KINGSPAN",                       "Kingspan"),
    ("DOW",                            "Dow"),
    ("DOW CHEMICAL",                   "Dow"),
    ("GS GAY",                         "GS Gay"),
    ("INSULFOAM",                      "InsulFoam"),
    ("CONFER PLASTICS",                "Confer Plastics"),
    ("BROAN-NUTONE",                   "Broan-NuTone"),
    ("WESCO",                          "Wesco"),
    ("APPALACHIAN",                    "Appalachian"),
    ("AEP SPAN",                       "AEP Span"),
    ("DREXEL",                         "Drexel"),
    ("OCV REINFORCEMENT",              "Owens Corning"),
    ("CHEM LINK",                      "ChemLink"),
    ("CHEMLINK",                       "ChemLink"),
    ("BITEC",                          "BiTec"),
    ("DECKORATORS",                    "Deckorators"),
    ("FORTRESS",                       "Fortress"),
    ("WOLF HOME",                      "Wolf"),
    ("WOLF PRO",                       "Wolf"),
]

PLACEHOLDERS = {
    "MUST ASSIGN A VALID SUPPLIER",
    "MISC. VENDOR",
    "ABC CATALOG DIVISION",
    "ACM SUPPLIER",
}

# Suffixes to strip when falling back to generic cleanup
STRIP_SUFFIXES = [
    r"\s+LLC\.?$",
    r"\s+L\.L\.C\.$",
    r"\s+INC\.?$",
    r"\s+INCORPORATED$",
    r"\s+CORP\.?$",
    r"\s+CORPORATION$",
    r"\s+CO\.?$",
    r"\s+CO\s+INC\.?$",
    r"\s+CO\.?\s+INC\.?$",
    r"\s+LTD\.?$",
    r"\s+LIMITED$",
    r"\s+COMPANY$",
    r"\s+MFG$",
    r"\s+SALES$",
    r"\s+SALES\s+LLC\.?$",
    r"\s+BUILDING\s+PRODUCTS$",
    r"\s+BUILDING\s+PRODUCTS\s+INC\.?$",
    r"\s+BUILDING\s+PRODUC$",  # truncated
    r"\s+BUILDING\s+SOLUTIONS$",
    r"\s+ROOFING/MONIER$",
    r"\s+ROOFING$",
    r"\s+SIDING$",
    r"-ROOFING$",
    r"-SIDING$",
    r"-COMM$",
    r"-RESI$",
    r"\s+\(MASTIC\)$",
    r"\s+-\s+MASTIC$",
    r"\s+ROOFING\s+PRODUCTS$",
]

BIG3 = {"Gaf", "Certainteed", "Owens Corning"}


def normalize(name):
    """Return canonical manufacturer_norm or None if it's a placeholder."""
    if not name:
        return None
    up = name.upper().strip()
    if up in PLACEHOLDERS:
        return None
    # Explicit-map match: longest keyword wins
    for keyword, canonical in sorted(BRAND_MAP, key=lambda x: -len(x[0])):
        if keyword in up:
            return canonical
    # Generic fallback
    s = up
    for pat in STRIP_SUFFIXES:
        s = re.sub(pat, "", s, flags=re.IGNORECASE)
    s = s.strip()
    # Title-case but preserve known caps (e.g. LLC stayed but stripped above)
    return s.title()


# ── Fetch all distinct supplier_names ────────────────────────────
print("Fetching all supplier_names from abc_items...")
rows = []
limit = 1000
offset = 0
while True:
    batch = sb.table("abc_items").select("supplier_name").range(offset, offset + limit - 1).execute().data
    rows.extend(batch)
    if len(batch) < limit:
        break
    offset += limit
print(f"Fetched {len(rows):,} rows")

# Build supplier -> count map
supplier_counts = Counter(r["supplier_name"] for r in rows if r.get("supplier_name"))
print(f"Distinct suppliers: {len(supplier_counts):,}")

# Build supplier -> canonical map
print("\nNormalizing...")
mapping = {}  # supplier_name -> manufacturer_norm
for s, n in supplier_counts.items():
    mapping[s] = normalize(s)

# Report
canon_counts = Counter()
for s, n in supplier_counts.items():
    canon_counts[mapping[s] or "(NULL — placeholder)"] += n

print(f"\nResult: {len(supplier_counts):,} suppliers -> {len(canon_counts):,} canonical brands")
print("\nTop 30 canonical brands after normalization:")
for canon, n in canon_counts.most_common(30):
    flag = " [BIG3]" if canon in BIG3 else ""
    print(f"  {n:>6,} — {canon}{flag}")

null_count = canon_counts.get("(NULL — placeholder)", 0)
print(f"\nNULL (placeholder/unbrandable): {null_count:,} SKUs")
print(f"Big 3 totals: {sum(canon_counts[b] for b in BIG3):,} SKUs")

# ── Show a few specific mappings ─────────────────────────────────
print("\nExample mappings (top 20 source suppliers):")
for s, n in supplier_counts.most_common(20):
    canon = mapping[s]
    print(f"  {n:>6,} — {s:<45} -> {canon}")

# ── Apply updates ────────────────────────────────────────────────
if DRY_RUN:
    print("\n[DRY RUN] Skipping DB update. Re-run without --dry-run to apply.")
    sys.exit(0)

print(f"\nApplying updates to abc_items ({len(supplier_counts):,} distinct supplier_names)...")
print("Strategy: fetch item_numbers per supplier, update in chunks of 500 to stay under statement timeout.")

CHUNK = 500
updated_total = 0
sorted_suppliers = sorted(mapping.items(), key=lambda kv: -supplier_counts[kv[0]])

for i, (supplier, canon) in enumerate(sorted_suppliers, 1):
    is_big3 = canon in BIG3
    # Fetch all item_numbers for this supplier
    item_nums = []
    offset = 0
    while True:
        page = sb.table("abc_items").select("item_number").eq("supplier_name", supplier).range(offset, offset + 999).execute().data
        item_nums.extend(r["item_number"] for r in page)
        if len(page) < 1000:
            break
        offset += 1000
    # Update in chunks of CHUNK
    for j in range(0, len(item_nums), CHUNK):
        batch = item_nums[j:j+CHUNK]
        sb.table("abc_items").update({
            "manufacturer_norm": canon,
            "is_big3_brand": is_big3,
        }).in_("item_number", batch).execute()
    updated_total += len(item_nums)
    if i % 25 == 0 or i == len(sorted_suppliers) or supplier_counts[supplier] > 5000:
        print(f"  [{i}/{len(sorted_suppliers)}] '{supplier[:40]}' -> '{canon}' ({len(item_nums):,} rows)")

print(f"\nDone. Updated rows: ~{updated_total:,}")

# Sanity check
big3_total = sb.table("abc_items").select("*", count="exact", head=True).eq("is_big3_brand", True).execute().count
print(f"Total is_big3_brand=TRUE rows: {big3_total:,}")
for brand in BIG3:
    cnt = sb.table("abc_items").select("*", count="exact", head=True).eq("manufacturer_norm", brand).execute().count
    print(f"  manufacturer_norm='{brand}': {cnt:,}")
