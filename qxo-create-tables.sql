-- QXO Catalog — Supabase DDL
-- Run once in Supabase SQL Editor (project kbdczzldmyayliwajwma).
-- Idempotent: uses CREATE TABLE IF NOT EXISTS so re-running is safe.
-- Designed to peer alongside the existing srs_* tables — no overlap.

-- ── qxo_branches ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qxo_branches (
  branch_num         INTEGER PRIMARY KEY,
  code               TEXT,
  name               TEXT NOT NULL,
  region_name        TEXT,
  reg_num            INTEGER,
  market_num         INTEGER,
  address1           TEXT,
  address2           TEXT,
  city               TEXT,
  state              TEXT,
  postalcode         TEXT,
  lat                NUMERIC,
  lng                NUMERIC,
  phone              TEXT,
  delivery_types     TEXT,
  delivery_tracking  BOOLEAN DEFAULT FALSE,
  catalog_version    TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qxo_branches_state       ON qxo_branches (state);
CREATE INDEX IF NOT EXISTS idx_qxo_branches_region      ON qxo_branches (region_name);

-- ── qxo_products ──────────────────────────────────────────────────────────────
-- product_key is QXO's "C-NNNNNN" string identifier (one per product).
-- Free-text categories preserved as-is in category_raw; category_norm is
-- trimmed + title-cased. Enrichment columns mirror the srs_products shape so the
-- proposal engine can treat both catalogs uniformly via lib/catalog-source.
CREATE TABLE IF NOT EXISTS qxo_products (
  product_key         TEXT PRIMARY KEY,
  product_id          TEXT,
  product_name        TEXT NOT NULL,
  slug                TEXT,
  category_raw        TEXT,
  category_norm       TEXT,
  brand_raw           TEXT,
  brand_norm          TEXT,
  brand_image_url     TEXT,
  description_short   TEXT,
  description_long    TEXT,
  prd_dimensions      TEXT,
  prd_length          TEXT,
  prd_width           TEXT,
  prd_thickness       TEXT,
  site_ids            TEXT,
  product_line        TEXT,
  family_tier         TEXT,
  accessory_tier      TEXT,
  proposal_line_item  TEXT,
  is_universal        BOOLEAN DEFAULT FALSE,
  is_private_label    BOOLEAN DEFAULT FALSE,
  is_stocked_anywhere BOOLEAN DEFAULT FALSE,
  suggested_price     NUMERIC(10,2),
  exclude_default     BOOLEAN DEFAULT FALSE,
  catalog_version     TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qxo_products_brand_norm   ON qxo_products (brand_norm);
CREATE INDEX IF NOT EXISTS idx_qxo_products_category     ON qxo_products (category_norm);
CREATE INDEX IF NOT EXISTS idx_qxo_products_family_tier  ON qxo_products (family_tier);
CREATE INDEX IF NOT EXISTS idx_qxo_products_acc_tier     ON qxo_products (accessory_tier);
CREATE INDEX IF NOT EXISTS idx_qxo_products_universal    ON qxo_products (is_universal);
CREATE INDEX IF NOT EXISTS idx_qxo_products_stocked      ON qxo_products (is_stocked_anywhere);
CREATE INDEX IF NOT EXISTS idx_qxo_products_exclude      ON qxo_products (exclude_default);

-- ── qxo_variants ──────────────────────────────────────────────────────────────
-- variant_sku is the canonical join key: equals variants.key in source CSV,
-- equals variants.sku, equals qxo_branch_sku.item_number. Always a positive
-- integer in observed data. variants.id from source is sequential per product
-- (1, 2, 3) — NOT unique across products — kept only for traceability.
CREATE TABLE IF NOT EXISTS qxo_variants (
  variant_sku          INTEGER PRIMARY KEY,
  product_key          TEXT NOT NULL REFERENCES qxo_products(product_key) ON DELETE CASCADE,
  product_id_raw       TEXT,
  color                TEXT,
  color_family         TEXT,
  uom                  TEXT,
  size_height          TEXT,
  size_width           TEXT,
  size_length          TEXT,
  size_thickness       TEXT,
  pieces_per_box       NUMERIC,
  pieces_per_bundle    NUMERIC,
  pieces_per_carton    NUMERIC,
  bundles_per_square   NUMERIC,
  coverage_per_square  NUMERIC,
  lineal_per_bundle    NUMERIC,
  lineal_per_box       NUMERIC,
  lineal_per_carton    NUMERIC,
  weight               NUMERIC,
  warranty_length      TEXT,
  warranty_value       TEXT,
  manufacturer_number  TEXT,
  material_number      TEXT,
  product_number       TEXT,
  image_url            TEXT,
  short_description    TEXT,
  catalog_version      TEXT
);
CREATE INDEX IF NOT EXISTS idx_qxo_variants_product  ON qxo_variants (product_key);
CREATE INDEX IF NOT EXISTS idx_qxo_variants_color    ON qxo_variants (color);

-- ── qxo_branch_sku ────────────────────────────────────────────────────────────
-- Inventory matrix. We ingest ONLY rows where source brn_avail=1 — cuts table
-- from 3.14M to ~512K rows. The absence of a row means "not currently stocked
-- at that branch", which is the only state the wizard needs.
CREATE TABLE IF NOT EXISTS qxo_branch_sku (
  branch_num       INTEGER NOT NULL REFERENCES qxo_branches(branch_num) ON DELETE CASCADE,
  variant_sku      INTEGER NOT NULL,
  branch_available BOOLEAN NOT NULL DEFAULT TRUE,
  region_available BOOLEAN,
  region_id        INTEGER,
  market_id        INTEGER,
  PRIMARY KEY (branch_num, variant_sku)
);
-- Hot path: "what does this branch stock?" — the brand-list / product-line queries.
CREATE INDEX IF NOT EXISTS idx_qxo_branch_sku_branch  ON qxo_branch_sku (branch_num);
-- Reverse lookup: "which branches stock this SKU?"
CREATE INDEX IF NOT EXISTS idx_qxo_branch_sku_variant ON qxo_branch_sku (variant_sku);
