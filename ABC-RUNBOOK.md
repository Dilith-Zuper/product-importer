# ABC pipeline runbook

## The one rule that bites: refresh the materialized view

The wizard reads `abc_products`, a **materialized** view over `abc_items`
(materialized because GROUP BY over 316K rows blows PostgREST's 8s timeout —
see `abc-materialize-product-view.sql`). It does **not** auto-update.

**After every `abc_sync.py` run or any `enrich-abc-*` script, run:**

```
node refresh-abc-products.js
```

(or `REFRESH MATERIALIZED VIEW abc_products;` in the Supabase SQL Editor).
Until you do, the wizard serves pre-run data — enrichment changes are
invisible, new items missing, and stale tiers/UOMs flow into uploads and
G/B/B proposals.

## Full pipeline order (fresh or full re-sync)

1. `python abc_sync.py` — pages the ABC items API into `abc_items`
   (checkpointed; `abc_sync_parallel.py --workers 2` is the faster variant —
   do NOT raise workers past 2-3, the sandbox gateway 502s under load).
2. `python enrich-abc-brand-norm.py` — manufacturer_norm + is_big3_brand
3. `python enrich-abc-category-norm.py` — product_category_norm + is_universal
4. `python fix-abc-shingles-reclassify.py`
5. `python enrich-abc-product-line-and-tier.py` — product_line + family_tier
   (tier rules mirror SRS's `enrich-family-tier.js` — keep them in sync;
   Landmark PRO/Duration = good, base Landmark/Oakridge = addon)
6. `python enrich-abc-price-fallback.py` — SRS-median suggested_price
7. `python enrich-abc-proposal-line-item.py`
8. `python enrich-abc-accessory-tier.py`
9. **`node refresh-abc-products.js`** ← never skip

A sync-only re-run (e.g. UOM backfill) preserves enrichment columns — the
upsert only writes the columns `flatten_item()` emits. But items NEW since the
last enrichment run will have NULL enrichment until steps 2-8 re-run.

## Known limitations (v1)

- `suggested_price` is a synthetic SRS-median estimate per (category, tier) —
  not an ABC price. Real per-UOM pricing needs the ABC pricing API.
- ~66K rows have NULL `manufacturer_norm` (placeholder suppliers like "MUST
  ASSIGN A VALID SUPPLIER") — excluded from wizard brand lists by design.
- ABC is branch-agnostic (no abc_branch_sku yet); brand names keep supplier
  casing ("TAMKO", "IKO") unlike SRS title-case ("Tamko", "Iko").
