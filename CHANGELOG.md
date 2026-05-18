# Changelog

All notable changes to the SRS Product Importer (data pipeline) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The 0.x line is pre-stable — breaking changes may land in minor bumps.

## [Unreleased]

## [v0.1.0] - 2026-05-18

### Added
- Baseline tag for the SRS catalog data pipeline. Includes the ingest streamer, enrichment scripts (`enrich-*.js`), export scripts (`export-*.js`), and `lib/utils.js` shared helpers. Full project context in `PROJECT_CONTEXT.md`. Establishes the versioning convention and a rollback anchor; subsequent commits will record their changes here under `## [Unreleased]` and roll into the next dated section at release time.
