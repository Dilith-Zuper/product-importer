/**
 * One-off: create the full set of CPQ measurement tokens used by our quantity
 * formulas into a single category called "CPQ Tokens" on ONE Zuper account.
 *
 * Token set = the 22 tokens referenced by FORMULA_DEFINITIONS in the zuper-importer
 * wizard (lib/token-definitions.ts / formula-definitions.ts). Every token below is
 * actually consumed by at least one formula's expression_map.
 *
 * UOM scheme (per request): no SQFT. Area tokens use SQ; length tokens use LF.
 * Percentage/count tokens are neither area nor length, so they keep PCT / EA
 * ("wherever applicable"). NOTE: the wizard formulas assume area is entered in
 * SQFT (they divide by 100 to get squares) — labelling these SQ is a display
 * choice; if values are entered already in squares the area formulas read 100x low.
 *
 * Endpoints (verified against app/api/validate/route.ts):
 *   GET  {base}measurements/categories?sort=ASC&sort_by=created_at
 *   POST {base}measurements/categories            { measurement_category: { measurement_category_name } }
 *   POST {base}measurements/categories/{uid}/tokens { measurement_token: { measurement_token_name, uom } }
 *
 * Connection (pick one):  --login <name> | --region <region> | --base <url>
 * Auth:                   --key <apiKey>   (or ZUPER_API_KEY in the environment)
 * Mode (required, safety): --dry-run | --run
 * Options:                --category "CPQ Tokens"   (override category name)
 *                         --area-uom SQ             (override area UOM; e.g. SQFT)
 *
 *   node create-cpq-tokens.js --key XXX --login some-account --dry-run
 *   node create-cpq-tokens.js --key XXX --login some-account --run
 */

require('dotenv').config();

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) { const k = t.slice(2); const v = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true; a[k] = v; }
    else a._.push(t);
  }
  return a;
}
const ARGS = parseArgs(process.argv.slice(2));
const API_KEY = (typeof ARGS.key === 'string' && ARGS.key) || process.env.ZUPER_API_KEY;
const MODE = ARGS.run ? 'RUN' : (ARGS['dry-run'] ? 'DRY-RUN' : null);
const CATEGORY_NAME = (typeof ARGS.category === 'string' && ARGS.category) || 'CPQ Tokens';
const AREA_UOM = (typeof ARGS['area-uom'] === 'string' && ARGS['area-uom']) || 'SQ';

let H = null;

// The 22 formula-referenced tokens. Area → AREA_UOM (SQ), length → LF, else native.
const TOKENS = [
  { name: 'Total Roof Area',              uom: AREA_UOM },
  { name: 'Total Siding Area',            uom: AREA_UOM },
  { name: 'Low Slope',                    uom: AREA_UOM },
  { name: 'Standard Slope',               uom: AREA_UOM },
  { name: 'Steep Slope',                  uom: AREA_UOM },
  { name: 'Very Steep Slope',             uom: AREA_UOM },
  { name: 'Total Hip Length',             uom: 'LF'  },
  { name: 'Total Ridges Length',          uom: 'LF'  },
  { name: 'Total Eaves Length',           uom: 'LF'  },
  { name: 'Total Rakes Length',           uom: 'LF'  },
  { name: 'Total Valleys Length',         uom: 'LF'  },
  { name: 'Total Step Flashing Length',   uom: 'LF'  },
  { name: 'Headwall Flashing',            uom: 'LF'  },
  { name: 'Gutter Length',                uom: 'LF'  },
  { name: 'Suggested Waste Percentage %', uom: 'PCT' },
  { name: 'No of Downspouts',             uom: 'EA'  },
  { name: 'No of End Caps',               uom: 'EA'  },
  { name: 'No of Outside Miters',         uom: 'EA'  },
  { name: 'No of Inside Miters',          uom: 'EA'  },
  { name: 'No of Inner Elbows',           uom: 'EA'  },
  { name: 'No of Outer Elbows',           uom: 'EA'  },
  { name: 'Downspout Elbows',             uom: 'EA'  },
];

async function resolveBaseUrl() {
  if (typeof ARGS.base === 'string') {
    let b = ARGS.base.trim().replace(/\/+$/, '');
    if (!b.endsWith('/api')) b += '/api';
    return b + '/';
  }
  if (typeof ARGS.region === 'string') return `https://${ARGS.region}.zuperpro.com/api/`;
  if (typeof ARGS.login === 'string') {
    const r = await fetch('https://accounts.zuperpro.com/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company_name: ARGS.login }),
    });
    const j = await r.json().catch(() => null);
    const dc = j?.config?.dc_api_url;
    if (!dc) throw new Error(`Could not resolve region from login name "${ARGS.login}"`);
    return dc.replace(/\/+$/, '') + '/api/';
  }
  throw new Error('Provide a connection: --login <name> | --region <region> | --base <url>');
}

async function reqJson(url, opts = {}) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: H, ...opts });
      if (r.status === 429 || r.status >= 500) { await sleep(700 * (a + 1)); continue; }
      const j = await r.json().catch(() => null);
      return { ok: r.ok, status: r.status, json: j };
    } catch { await sleep(700 * (a + 1)); }
  }
  throw new Error('fetch failed: ' + url);
}

const norm = s => String(s || '').trim().toLowerCase();

async function main() {
  if (!MODE) { console.log('Specify a mode: --dry-run | --run'); process.exit(1); }
  if (!API_KEY) { console.log('Provide --key <apiKey> or set ZUPER_API_KEY'); process.exit(1); }
  H = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };

  const base = await resolveBaseUrl();
  const ver = await reqJson(`${base}user/company`);
  const company = ver.json?.data?.company_name ?? ver.json?.company_name ?? null;
  if (!ver.ok || !company) { console.log(`Key/connection check failed (status ${ver.status}) for ${base}`); process.exit(1); }
  console.log(`\n=== Create CPQ tokens  [${MODE}]  account: ${company}  category: "${CATEGORY_NAME}"  area UOM: ${AREA_UOM}  (${base}) ===\n`);

  // 1. Fetch existing categories + their tokens.
  const catRes = await reqJson(`${base}measurements/categories?sort=ASC&sort_by=created_at`);
  const categories = catRes.json?.data ?? [];
  const existingByName = new Map(); // tokenName(norm) -> category name (any category, for reporting)
  for (const cat of categories) {
    for (const tok of cat.measurement_tokens ?? []) existingByName.set(norm(tok.measurement_token_name), cat.measurement_category_name);
  }
  let target = categories.find(c => norm(c.measurement_category_name) === norm(CATEGORY_NAME));
  const inTarget = new Set((target?.measurement_tokens ?? []).map(t => norm(t.measurement_token_name)));

  // 2. Plan.
  const toCreate = TOKENS.filter(t => !inTarget.has(norm(t.name)));
  const skip = TOKENS.filter(t => inTarget.has(norm(t.name)));
  const dupElsewhere = toCreate.filter(t => existingByName.has(norm(t.name)));

  console.log(`Category "${CATEGORY_NAME}": ${target ? 'exists' : 'MISSING (will create)'}`);
  console.log(`Tokens: ${toCreate.length} to create, ${skip.length} already in category.`);
  if (dupElsewhere.length) {
    console.log(`\nNote — these names already exist in ANOTHER category (a duplicate will be created in "${CATEGORY_NAME}"):`);
    for (const t of dupElsewhere) console.log(`  • ${t.name}  (currently in "${existingByName.get(norm(t.name))}")`);
  }
  console.log('\nPlanned tokens:');
  for (const t of TOKENS) console.log(`  ${inTarget.has(norm(t.name)) ? 'skip  ' : 'create'}  ${t.name.padEnd(32)} ${t.uom}`);

  if (MODE === 'DRY-RUN') { console.log('\nDry run — no writes. Re-run with --run to apply.'); return; }

  // 3. Ensure category.
  if (!target) {
    const cr = await reqJson(`${base}measurements/categories`, { method: 'POST', body: JSON.stringify({ measurement_category: { measurement_category_name: CATEGORY_NAME } }) });
    let uid = cr.json?.data?.measurement_category_uid;
    if (!uid) {
      const listRes = await reqJson(`${base}measurements/categories?sort=ASC&sort_by=created_at`);
      uid = (listRes.json?.data ?? []).find(c => norm(c.measurement_category_name) === norm(CATEGORY_NAME))?.measurement_category_uid;
    }
    if (!uid) { console.log(`Failed to create category "${CATEGORY_NAME}" (status ${cr.status}): ${JSON.stringify(cr.json)}`); process.exit(1); }
    target = { measurement_category_uid: uid, measurement_category_name: CATEGORY_NAME };
    console.log(`Created category "${CATEGORY_NAME}"  (${uid})`);
  } else {
    console.log(`Using category "${CATEGORY_NAME}"  (${target.measurement_category_uid})`);
  }
  const catUid = target.measurement_category_uid;

  // 4. Create tokens.
  let created = 0;
  const failed = [];
  for (const t of toCreate) {
    const r = await reqJson(`${base}measurements/categories/${catUid}/tokens`, { method: 'POST', body: JSON.stringify({ measurement_token: { measurement_token_name: t.name, uom: t.uom } }) });
    const uid = r.json?.data?.measurement_token_uid;
    if (r.ok && uid) { created++; console.log(`  ✓ ${t.name.padEnd(32)} ${t.uom}  (${uid})`); }
    else { failed.push(t.name); console.log(`  ✗ ${t.name.padEnd(32)} ${t.uom}  status ${r.status}: ${JSON.stringify(r.json)}`); }
    await sleep(150);
  }

  console.log(`\nDone. Created ${created}, skipped ${skip.length}${failed.length ? `, FAILED ${failed.length}: ${failed.join(', ')}` : ''}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
