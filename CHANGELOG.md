# Changelog

All notable changes to the SRS Product Importer (data pipeline) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The 0.x line is pre-stable — breaking changes may land in minor bumps.

## [Unreleased]

### Added
- `abc_sync.py` — fetches ABC Supply product catalog via OAuth2 client-credentials API (316K+ items, 317 pages) and upserts into `abc_products` Supabase table. Reads Supabase credentials from `.env`, supports checkpoint/resume across runs, token auto-refresh every 25 min, exponential backoff on 429s.

## [v0.2.0] - 2026-05-18

### Added
- QXO catalog support — new parallel `qxo_*` tables alongside `srs_*` in the same Supabase project.
  - `qxo-create-tables.sql` — DDL for `qxo_branches`, `qxo_products`, `qxo_variants`, `qxo_branch_sku` with indexes for branch-scoped queries.
  - `ingest-qxo-branches.js` — loads the 1,154 QXO branches from `QXO Catalog/branch/branch-1.csv`.
  - `ingest-qxo-catalog.js` — streams 32 ct_sku CSVs, dedups ~76K products + ~158K variants. Uses `csv-parse` to handle multi-line HTML in long descriptions. Supports `DRY_RUN=1` and `FILES=N` for partial runs.
  - `ingest-qxo-branch-sku.js` — loads the per-branch SKU availability matrix; ingests only `brn_avail=1` rows (~512K instead of ~3.14M).
  - `lib/qxo-brand-norm.js` — canonicalizes QXO's 2,447 raw brand strings into stable names that match the SRS title-case convention (e.g. "CertainTeed Siding" → "Certainteed", "GAF" → "Gaf").
- New dependency: `csv-parse` (multi-line quoted CSV parser).
- `enrich-qxo-stocked-flag.js` — denorms `qxo_products.is_stocked_anywhere` from the `qxo_branch_sku` matrix. Result: 32,114 / 76,812 products (42%) are stocked at ≥1 branch; the other 58% are catalog-only / drop-ship.
- `enrich-qxo-product-line.js` — derives `qxo_products.product_line` by stripping brand prefix + leading size specs and taking the first 2-3 meaningful tokens. All 76,812 products populated.
- `lib/qxo-category-classifier.js` — maps QXO's 193 free-text `category_norm` strings to the 41 fixed `proposal_line_items` via a category-name map + name-keyword sub-classifiers (UNDERLAYMENT / VENTS / PIPE / GUTTER / FLASHING / NAILS / generic accessory).
- `enrich-qxo-proposal-line-item.js` — runs the classifier, populates `qxo_products.proposal_line_item`, writes a `qxo-unmapped-categories.json` coverage report. v1 baseline: 38,755 / 76,812 products mapped (50.5% overall; ~88% of products in roofing-relevant categories). Unmapped tail is tools, lumber, drywall, masonry — correctly excluded from proposal flow.
- `enrich-qxo-family-tier.js` — good/better/best/addon classification. Brand+line rules for Big 3 / IKO / TAMKO / Malarkey / Atlas / Pabco (shared with SRS — same brands sell into both distributors). proposal_line_item + name-keyword rules cover non-shingle products. Result: 3,827 good / 33,447 better / 97 best / 39,441 addon.
- `enrich-qxo-account-flags.js` — populates `is_universal` (24,761 accessory products auto-loaded for every account) + `suggested_price` (20,969 products priced from SRS-derived medians; same Big 3 brands).
- `lib/html-entities.js` — `decodeHtmlEntities()` / `stripHtmlEntities()` helpers. QXO catalog text fields embed raw `&reg;` / `&trade;` / `&deg;` entities that broke downstream rule matching ("Timberline&reg; Natural Shadow" failed to match "Timberline Natural Shadow"). The catalog ingest now decodes entities on the way in.
- `cleanup-qxo-html-entities.js` — one-shot pass to decode entities in existing `qxo_products` rows; 20,416 products updated. Idempotent.

### Changed
- `lib/utils.js` `fetchAll()` now accepts an `orderBy` option. Without an explicit order, PostgREST pagination is not stable across `.range()` calls — same row can appear on adjacent pages or be skipped. All enrichment scripts that depend on full-table coverage should now pass `orderBy: '<pk_col>'`.

## [v0.1.0] - 2026-05-18

### Added
- Baseline tag for the SRS catalog data pipeline. Includes the ingest streamer, enrichment scripts (`enrich-*.js`), export scripts (`export-*.js`), and `lib/utils.js` shared helpers. Full project context in `PROJECT_CONTEXT.md`. Establishes the versioning convention and a rollback anchor; subsequent commits will record their changes here under `## [Unreleased]` and roll into the next dated section at release time.
