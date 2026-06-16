/**
 * A&A → SRS catalog matcher — thin wrapper around the reusable matcher.
 *
 * The matching engine now lives in match-account-to-srs.js (works for any account's
 * Zuper product export). This wrapper just pins the A&A input + output names so the
 * original command keeps working and produces the same files:
 *   A&A_SRS_Match.xlsx, "A&A_SRS_Match - simple.xlsx", A&A_SRS_Review.xlsx
 *
 *   node match-aa-to-srs.js
 *
 * For any other account, call the general tool directly, e.g.:
 *   node match-account-to-srs.js "Roof Medic.xlsx" --label "Roof Medic" --out "RoofMedic"
 */

const { run } = require('./match-account-to-srs');

run({ inFile: 'aanda_parts_export.xlsx', label: 'A&A', outPrefix: 'A&A' })
  .catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
