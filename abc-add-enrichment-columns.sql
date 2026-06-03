-- ABC Catalog — Phase 2 DDL
-- Adds variant-level + product-level enrichment columns to abc_items.
-- Idempotent: safe to re-run (all ADD COLUMN / CREATE INDEX use IF NOT EXISTS).

-- ── Variant-level columns (filled by enrich-abc-variants.js) ──
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS size_name         TEXT;
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS variant_image_url TEXT;
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS order_uom         TEXT;
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS uoms              JSONB;

-- ── Product-level enrichment columns (duplicated across variants of same family_id) ──
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS manufacturer_norm     TEXT;
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS product_category_norm TEXT;
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS product_line          TEXT;
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS family_tier           TEXT;     -- good | better | best | addon
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS accessory_tier        TEXT;     -- good_accessory | better_accessory | best_accessory (NULL for non-better)
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS proposal_line_item    TEXT;
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS is_universal          BOOLEAN DEFAULT FALSE;
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS is_big3_brand         BOOLEAN DEFAULT FALSE;
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS suggested_price       NUMERIC(10,2);
ALTER TABLE abc_items ADD COLUMN IF NOT EXISTS is_restricted         BOOLEAN DEFAULT FALSE;

-- ── Indexes for the queries we'll run ──
CREATE INDEX IF NOT EXISTS idx_abc_manuf_norm    ON abc_items(manufacturer_norm);
CREATE INDEX IF NOT EXISTS idx_abc_cat_norm      ON abc_items(product_category_norm);
CREATE INDEX IF NOT EXISTS idx_abc_family_id     ON abc_items(family_id);
CREATE INDEX IF NOT EXISTS idx_abc_brand_line    ON abc_items(brand_line_name);
CREATE INDEX IF NOT EXISTS idx_abc_supplier      ON abc_items(supplier_name);
CREATE INDEX IF NOT EXISTS idx_abc_is_universal  ON abc_items(is_universal);
CREATE INDEX IF NOT EXISTS idx_abc_is_big3       ON abc_items(is_big3_brand);
CREATE INDEX IF NOT EXISTS idx_abc_family_tier   ON abc_items(family_tier);
