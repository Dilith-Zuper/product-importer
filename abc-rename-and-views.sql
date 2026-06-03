-- ABC Catalog — Phase 4 schema migration
-- Renames raw table abc_products -> abc_items, adds the missing proposal_line_item column,
-- and exposes wizard-facing views abc_products + abc_variants that the Zuper importer
-- can read with the same CatalogConfig pattern it uses for SRS and QXO.
--
-- Idempotent: safe to re-run. Verify in the Supabase SQL Editor.

-- 1. Rename the raw item-level table (only if it's still a TABLE — re-runs no-op)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'abc_products' AND relkind = 'r') THEN
    ALTER TABLE abc_products RENAME TO abc_items;
  END IF;
END $$;

-- 2. Add the missing column the wizard expects (proposal_line_item) before view creation
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS proposal_line_item TEXT;
CREATE INDEX IF NOT EXISTS idx_abc_items_proposal_line ON abc_items(proposal_line_item);

-- 3. Drop and recreate the views (idempotent — views can be safely dropped/recreated)
DROP VIEW IF EXISTS abc_variants;
DROP VIEW IF EXISTS abc_products;

-- 4. abc_products view: one row per family_id (= one "product" in wizard terms)
--    Wizard reads columns matching SRS/QXO contract: product_id, product_name,
--    product_category, manufacturer_norm, family_tier, product_line, suggested_price, etc.
CREATE VIEW abc_products AS
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
  COALESCE(
    JSONB_AGG(DISTINCT order_uom) FILTER (WHERE order_uom IS NOT NULL),
    '[]'::jsonb
  )                                                  AS product_uom,
  MIN(variant_image_url)                             AS product_image_url,
  FALSE                                              AS exclude_default
FROM abc_items
WHERE family_id IS NOT NULL
GROUP BY family_id;

-- 5. abc_variants view: 1-to-1 with abc_items rows (= one variant per ABC item_number)
CREATE VIEW abc_variants AS
SELECT
  item_number                                        AS variant_id,
  family_id                                          AS product_id,
  item_number                                        AS variant_code,
  order_uom,
  color_name,
  size_name,
  variant_image_url,
  uoms,
  COALESCE(is_restricted, FALSE)                     AS is_restricted
FROM abc_items
WHERE family_id IS NOT NULL;

-- 6. Sanity check (informational — does not block migration)
-- SELECT COUNT(*) AS items FROM abc_items;             -- expect ~316,380
-- SELECT COUNT(*) AS products FROM abc_products;       -- expect ~34,868 (distinct family_ids)
-- SELECT COUNT(*) AS variants FROM abc_variants;       -- expect ~315,000 (items with family_id)
