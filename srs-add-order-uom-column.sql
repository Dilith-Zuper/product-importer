-- SRS Catalog — order_uom enrichment column
--
-- srs_products.product_uom is the raw source array (productUOM) — its first
-- element is frequently "PAL" (pallet, a near-universal secondary/bulk unit
-- listed on almost every variant) rather than the actual order unit. Picking
-- product_uom[0] causes zuper-importer's toZuperUom() to send the wrong Zuper
-- UOM for ~38% of products (verified 2026-06-15).
--
-- order_uom stores the dominant order_uom across a product's unrestricted
-- srs_variants (computed by enrich-order-uom.js), falling back to
-- product_uom[0] for the handful of products with no variant order_uom data.
--
-- Idempotent: safe to re-run.

ALTER TABLE srs_products ADD COLUMN IF NOT EXISTS order_uom TEXT;
CREATE INDEX IF NOT EXISTS idx_srs_products_order_uom ON srs_products(order_uom);
