-- v2 category-norm cleanup — update previously-NULL product_category_norm rows
-- per the CATEGORY_MAP expansion in enrich-abc-category-norm.py.
--
-- Why not re-run the full Python script: the keyset pagination on Low Slope
-- Roofing (already-mapped, ~50K rows) hits PostgREST's 8s statement timeout
-- because abc_items has no (category_name, id) composite index. The newly-
-- added categories are small (under 1500 rows each), so direct UPDATE
-- statements complete in milliseconds and are idempotent (the WHERE filters
-- to previously-NULL rows only).
--
-- These rows aren't in CPQ_CATEGORIES (SHINGLES/UNDERLAYMENT/etc.) so they
-- don't surface in proposal templates. They just upload to Zuper with proper
-- category labels (Commercial / Siding / Other) instead of "Other" via the
-- validate-route v1 fallback.

-- COMMERCIAL — insulation + ceiling systems
UPDATE abc_items SET product_category_norm = 'COMMERCIAL', is_universal = FALSE
WHERE category_name IN (
  'Batts, Rolls & Loose Fill Insulation',
  'All Other Insulation',
  'Standard Ceiling Panels',
  'Ceiling Grid Systems',
  'Specialty Ceiling Panels'
) AND product_category_norm IS NULL;

-- SIDING — wood/PVC/aluminum siding + cladding
UPDATE abc_items SET product_category_norm = 'SIDING', is_universal = FALSE
WHERE category_name IN (
  'Wood Siding, Soffit & Accessories',
  'PVC Siding, Soffit & Accessories',
  'Aluminum Cladding Systems',
  'PVC Cladding Systems'
) AND product_category_norm IS NULL;

-- OTHER — non-roofing categories (mapped explicitly for hygiene; functionally
-- equivalent to leaving them NULL since the validate route adds an "Other"
-- Zuper category for non-SRS uploads anyway).
UPDATE abc_items SET product_category_norm = 'OTHER', is_universal = FALSE
WHERE category_name IN (
  'Other Outdoor Living Products',
  'Window & Door Accessories',
  'Pool & Patio Extrusions',
  'Porch Room Products',
  'Motorized Applications',
  'Metal Framing',
  'Pool and Patio Accessories',
  'Pool and Patio Doors',
  'Lattice',
  'Pool and Patio Roofing',
  'Hurricane Protection',
  'Screen & Spline',
  'Metal Framing Accessories',
  'Large Opening Enclosure Systems',
  'FRP Panels & Accessories',
  'Wallboard Accessories',
  'Decorative Colonial / Bahama Shutters',
  'Storm Panels'
) AND product_category_norm IS NULL;

-- Refresh the materialized view so the wizard sees the updated categories.
REFRESH MATERIALIZED VIEW abc_products;

-- Sanity check (optional):
-- SELECT product_category_norm, COUNT(*) FROM abc_items GROUP BY 1 ORDER BY 2 DESC;
