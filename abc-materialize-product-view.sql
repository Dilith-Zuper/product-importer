-- Materialize the abc_products view — split into 3 steps so failures are
-- diagnosable. Run each block separately in Supabase SQL Editor; if a block
-- fails, paste the exact error back so we can adjust.
--
-- The regular view re-runs GROUP BY family_id over all 316K abc_items rows on
-- every query. PostgREST's 8s statement timeout kills the wizard's brands
-- endpoint. A materialized view + indexes brings filtered queries under 100ms.
--
-- Refresh after every ABC ingest / enrichment run:
--   REFRESH MATERIALIZED VIEW abc_products;
--
-- abc_variants stays a regular view — the wizard always filters by
-- product_id IN (...), which uses the abc_items.family_id index.


-- ── STEP 1: Drop old view + create materialized view ────────────────────
-- product_uom is omitted here because JSONB_AGG(DISTINCT) over 316K rows is
-- the slowest aggregation and not worth the cost — UOMs are reconstructed in
-- the upload route from variant data when needed.

-- Drop both forms — the first attempt may have left a materialized view behind.
DROP MATERIALIZED VIEW IF EXISTS abc_products;
DROP VIEW IF EXISTS abc_products;

CREATE MATERIALIZED VIEW abc_products AS
SELECT
  family_id                                          AS product_id,
  MIN(family_name)                                   AS product_name,
  MIN(product_category_norm)                         AS product_category,
  MIN(manufacturer_norm)                             AS manufacturer_norm,
  MIN(product_line)                                  AS product_line,
  MIN(family_tier)                                   AS family_tier,
  MIN(accessory_tier)                                AS accessory_tier,
  MIN(proposal_line_item)                            AS proposal_line_item,
  BOOL_OR(is_universal)                              AS is_universal,
  BOOL_OR(is_big3_brand)                             AS is_big3_brand,
  AVG(suggested_price)::numeric(10,2)                AS suggested_price,
  MIN(item_description)                              AS product_description,
  NULL::jsonb                                        AS product_uom,
  MIN(variant_image_url)                             AS product_image_url,
  FALSE                                              AS exclude_default
FROM abc_items
WHERE family_id IS NOT NULL
GROUP BY family_id;


-- ── STEP 2: Required unique index (run only after STEP 1 succeeds) ──────
-- This is the PK index; it's also required if you later want to use
-- REFRESH MATERIALIZED VIEW CONCURRENTLY (non-blocking refreshes).

CREATE UNIQUE INDEX idx_abc_products_pk ON abc_products(product_id);


-- ── STEP 3: Hot-path indexes (run only after STEP 2 succeeds) ──────────
-- The brands endpoint needs these. Each is small and quick.

CREATE INDEX idx_abc_products_brand               ON abc_products(manufacturer_norm);
CREATE INDEX idx_abc_products_category            ON abc_products(product_category);
CREATE INDEX idx_abc_products_brand_cat           ON abc_products(manufacturer_norm, product_category);
CREATE INDEX idx_abc_products_big3                ON abc_products(is_big3_brand)        WHERE is_big3_brand = TRUE;
CREATE INDEX idx_abc_products_universal           ON abc_products(is_universal)         WHERE is_universal = TRUE;
CREATE INDEX idx_abc_products_proposal_line_item  ON abc_products(proposal_line_item);
CREATE INDEX idx_abc_products_product_line        ON abc_products(product_line);


-- ── Sanity check (run after all 3 steps) ───────────────────────────────
-- SELECT COUNT(*) FROM abc_products;       -- expect ~34,868
-- SELECT manufacturer_norm, COUNT(*) FROM abc_products GROUP BY manufacturer_norm ORDER BY 2 DESC LIMIT 10;
