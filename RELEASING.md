# Releasing

How to cut a new version of the SRS Product Importer data pipeline.

## Versioning scheme

Semantic versioning under the **0.x** line until the pipeline hits a stability milestone — then bump to 1.0.0.

- **Minor** (`v0.1.0 → v0.2.0`) — new enrichment columns, new scripts, schema changes
- **Patch** (`v0.1.0 → v0.1.1`) — bug fixes in existing scripts, formula corrections, doc updates

## To cut a release

1. In `CHANGELOG.md`, move every entry under `## [Unreleased]` into a new section `## [v0.X.Y] - YYYY-MM-DD`. Leave a fresh empty `## [Unreleased]` header above it.
2. Bump `version` in `package.json` to `0.X.Y`.
3. Commit:
   ```
   git commit -am "Release v0.X.Y"
   ```
4. Tag the release commit:
   ```
   git tag -a v0.X.Y -m "Release v0.X.Y"
   ```
5. Push commit + tag:
   ```
   git push origin main v0.X.Y
   ```

**Repo:** https://github.com/Dilith-Zuper/product-importer (private) — default branch `main`.

## Rolling back

This is a local data pipeline — no deployed surface to roll back. To inspect or revert to a previous version:

```
git checkout v0.X.Y           # inspect that tree
git revert <bad-sha>          # undo a bad commit on main
git reset --hard v0.X.Y       # only on local branches, never after push
```

## Re-running enrichment after a release

All enrichment scripts are idempotent and support `--log-changes`:
```
node enrich-product-line.js --log-changes
node enrich-family-tier.js --log-changes
node enrich-accessory-tier.js --log-changes
node enrich-proposal-line-item.js --log-changes
node enrich-account-load-flags.js --log-changes
```
The log files (`enrichment-changes-*.json`) are gitignored — review them after each release for an audit trail of what changed in Supabase.

## During development

Add Changelog entries as you go — under `## [Unreleased]`, grouped by `### Added` / `### Changed` / `### Fixed` / `### Removed`. At release time, the section is already drafted.
