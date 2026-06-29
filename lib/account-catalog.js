/**
 * Shared catalog-source abstraction for the account option audit + backfill.
 *
 * The audit (audit-account-options.js) and the backfill (backfill-account-options.js)
 * both need to take an account's Zuper PARTS — whose `product_id` is always a plain
 * integer — and resolve each back to its source-catalog row + the option axes (colors,
 * sizes, real color/size pairs) the catalog implies. The ONLY thing that differs
 * between the SRS and QXO catalogs is how that resolution works:
 *
 *   - SRS   product_id is numeric and is stamped into Zuper verbatim, so the Zuper
 *           product_id IS the srs_products PK. Variants carry color_name + size_name
 *           and an is_restricted flag we must filter out.
 *   - QXO   product_key is text ("C-123456"). The wizard upload stamps
 *           Number(product_key.replace(/\D/g,'')) into Zuper (app/api/upload/route.ts),
 *           so the link back is digit-stripping every product_key and matching. QXO
 *           variants carry `color` only (size is split across 4 columns and the wizard
 *           uploads QXO color-only — includeSize=false), and have no is_restricted.
 *
 * This mirrors zuper-importer/lib/catalog-source.ts so the standalone tools and the
 * wizard agree on exactly what options a product should have. Add ABC here the same
 * way if/when its accounts need the option backfill.
 */

const { fetchAll } = require('./utils');

const realOpt = s => s && String(s).trim() && !['n/a', 'na'].includes(String(s).trim().toLowerCase());

const CONFIGS = {
  srs: {
    source: 'srs',
    productsTable: 'srs_products',
    variantsTable: 'srs_variants',
    productPk: 'product_id',
    nameCol: 'product_name',
    brandCol: 'manufacturer_norm',
    categoryCol: 'product_category',
    variantFk: 'product_id',
    variantPk: 'variant_id',
    colorCol: 'color_name',
    sizeCol: 'size_name',
    skuCol: 'variant_code',   // vendor_sku source
    uomCol: 'order_uom',      // pick the per-color SKU whose UOM matches the product
    restricted: true,      // filter is_restricted=false on variants
    includeSize: true,     // color + size + composite
    pkIsNumeric: true,     // Zuper product_id === catalog PK
  },
  abc: {
    // ABC reads from Postgres views (abc_products / abc_variants) that expose the
    // SRS column names (color_name, size_name, is_restricted) — so options are
    // color + size + composite like SRS. The ONLY twist is the PK: abc_products.product_id
    // is the text "PFam_NNNNNNN" family id, which the wizard upload digit-strips into
    // Zuper (Number(...replace(/\D/g,''))). Mirrors zuper-importer catalog-source.ts ABC.
    source: 'abc',
    productsTable: 'abc_products',
    variantsTable: 'abc_variants',
    productPk: 'product_id',
    nameCol: 'product_name',
    brandCol: 'manufacturer_norm',
    categoryCol: 'product_category',
    variantFk: 'product_id',
    variantPk: 'variant_id',
    colorCol: 'color_name',
    sizeCol: 'size_name',
    skuCol: 'variant_code',
    uomCol: 'order_uom',
    restricted: true,
    includeSize: true,
    pkIsNumeric: false,    // text "PFam_…" key; digit-strip to match Zuper product_id
    pkToZid: pk => Number(String(pk).replace(/\D/g, '')) || 0,
  },
  qxo: {
    // QXO as the wizard uploads it: Zuper product_id = digit-stripped product_key
    // ("C-000SP5" → 5). Color-only (no single size column).
    source: 'qxo',
    productsTable: 'qxo_products',
    variantsTable: 'qxo_variants',
    productPk: 'product_key',
    nameCol: 'product_name',
    brandCol: 'brand_norm',
    categoryCol: 'category_norm',
    variantFk: 'product_key',
    variantPk: 'variant_sku',
    colorCol: 'color',
    sizeCol: null,         // QXO size is split across 4 cols; wizard uploads color-only
    skuCol: 'variant_sku', // vendor_sku = QXO's integer item key (matches wizard)
    uomCol: 'uom',         // pipe-delimited packaging chain, e.g. "PLT|BDL"
    restricted: false,
    includeSize: false,    // color-only (matches upload route includeSize=false)
    pkIsNumeric: false,
    keyMode: 'pk-digitstrip',
    pkToZid: pk => Number(String(pk).replace(/\D/g, '')) || 0,
  },
  'qxo-sku': {
    // QXO where the account loaded each product keyed by a single qxo_variants.variant_sku
    // (the Zuper product_id IS a variant_sku, e.g. 656024 → parent product C-635001).
    // Observed in the Elite Options Contracting account. We resolve the variant's parent
    // product_key and load ALL of that parent's colors onto the product. Color-only.
    source: 'qxo-sku',
    productsTable: 'qxo_products',
    variantsTable: 'qxo_variants',
    productPk: 'product_key',
    nameCol: 'product_name',
    brandCol: 'brand_norm',
    categoryCol: 'category_norm',
    variantFk: 'product_key',
    variantPk: 'variant_sku',
    colorCol: 'color',
    sizeCol: null,
    skuCol: 'variant_sku',
    uomCol: 'uom',
    restricted: false,
    includeSize: false,
    pkIsNumeric: false,
    keyMode: 'variant-sku',
  },
};

function getCatalogConfig(source) {
  const c = CONFIGS[source];
  if (!c) throw new Error(`Unknown catalog source "${source}" (expected: ${Object.keys(CONFIGS).join(', ')})`);
  return c;
}

// Resolve the account's Zuper numeric product_ids back to catalog rows + option axes.
//
//   zuperIds : number[]  — the account's numeric PARTS product_ids
//
// The account id is mapped to a catalog product PK by one of three key modes:
//   - identity        (SRS) — Zuper product_id IS the numeric catalog PK
//   - pk-digitstrip   (QXO/ABC wizard) — digit-strip the text PK ("PFam_3272874"→3272874,
//                     "C-000SP5"→5) the way the wizard upload stamps it
//   - variant-sku     (QXO-by-SKU) — Zuper product_id is a qxo_variants.variant_sku; we
//                     look up its parent product_key and load ALL the parent's colors.
//                     Several account products can point at the same parent — each gets
//                     the parent's full option set.
//
// Returns:
//   prodByZid    Map<number, { name, brand, category, pk }>  — catalog product (matched only)
//   optsByZid    Map<number, { colors:Set, sizes:Set, pairs:[[color,size]] }>  — option axes
//   collisions   [{ zid, keys }]  — pk-digitstrip: >1 PK digit-strips to the same Zuper id
//   notInCatalog number          — account ids with no catalog row
// Resolve account ids → catalog PK(s) per the source's key mode (identity / pk-digitstrip
// / variant-sku). Returns { zidsByPk: Map<pk,[zid]>, collisions, matchedZids:Set, notInCatalog }.
// Shared by indexAccountProducts (options) and resolveVariantSkus (vendor SKUs).
async function resolvePkMapping(supabase, cfg, zuperIds) {
  const keyMode = cfg.keyMode || (cfg.pkIsNumeric ? 'identity' : 'pk-digitstrip');
  const collisions = [];
  const zidsByPk = new Map();
  const addPair = (pk, zid) => { if (!zidsByPk.has(pk)) zidsByPk.set(pk, []); zidsByPk.get(pk).push(zid); };

  if (keyMode === 'identity') {
    for (const id of zuperIds) addPair(id, id);
  } else if (keyMode === 'variant-sku') {
    // Zuper product_id is a variant PK (qxo_variants.variant_sku) → find its parent PK.
    for (let i = 0; i < zuperIds.length; i += 300) {
      const chunk = zuperIds.slice(i, i + 300);
      const rows = await fetchAll(supabase, cfg.variantsTable, `${cfg.variantPk},${cfg.variantFk}`,
        { filters: [{ op: 'in', args: [cfg.variantPk, chunk] }], orderBy: cfg.variantPk });
      for (const r of rows) {
        const zid = r[cfg.variantPk], pk = r[cfg.variantFk];
        if (pk != null) addPair(pk, zid);
      }
    }
  } else {
    // pk-digitstrip: load all PKs, digit-strip, match the account ids.
    const allKeys = await fetchAll(supabase, cfg.productsTable, cfg.productPk, { orderBy: cfg.productPk });
    const keysByZid = new Map();
    for (const r of allKeys) {
      const pk = r[cfg.productPk];
      const zid = cfg.pkToZid(pk);
      if (!zid) continue;
      if (!keysByZid.has(zid)) keysByZid.set(zid, []);
      keysByZid.get(zid).push(pk);
    }
    for (const zid of zuperIds) {
      const keys = keysByZid.get(zid);
      if (!keys || !keys.length) continue;
      if (keys.length > 1) collisions.push({ zid, keys });
      addPair(keys[0], zid);   // deterministic — first by product_key sort order
    }
  }

  const matchedZids = new Set();
  for (const arr of zidsByPk.values()) for (const z of arr) matchedZids.add(z);
  return { zidsByPk, collisions, matchedZids, notInCatalog: zuperIds.length - matchedZids.size };
}

async function indexAccountProducts(supabase, source, zuperIds) {
  const cfg = getCatalogConfig(source);
  const prodByZid = new Map();
  const optsByZid = new Map();

  const { zidsByPk, collisions, notInCatalog } = await resolvePkMapping(supabase, cfg, zuperIds);
  const matchedPks = [...zidsByPk.keys()];
  if (matchedPks.length === 0) return { prodByZid, optsByZid, collisions, notInCatalog };

  // 2. Catalog product rows for the matched PKs → fan out to every account id behind each.
  const prodSelect = [cfg.productPk, cfg.nameCol, cfg.categoryCol, cfg.brandCol].join(',');
  for (let i = 0; i < matchedPks.length; i += 300) {
    const chunk = matchedPks.slice(i, i + 300);
    const rows = await fetchAll(supabase, cfg.productsTable, prodSelect,
      { filters: [{ op: 'in', args: [cfg.productPk, chunk] }], orderBy: cfg.productPk });
    for (const r of rows) {
      const info = {
        name: r[cfg.nameCol] || '', brand: r[cfg.brandCol] || '',
        category: r[cfg.categoryCol] || '', pk: r[cfg.productPk],
      };
      for (const zid of (zidsByPk.get(r[cfg.productPk]) || [])) prodByZid.set(zid, info);
    }
  }

  // 3. Variants → option axes per PK, then fan out to every account id behind each PK.
  const vSelect = [cfg.variantFk, cfg.variantPk, cfg.colorCol];
  if (cfg.sizeCol) vSelect.push(cfg.sizeCol);
  if (cfg.restricted) vSelect.push('is_restricted');
  const optsByPk = new Map();
  const ensurePk = pk => {
    let e = optsByPk.get(pk);
    if (!e) { e = { colors: new Set(), sizes: new Set(), pairs: [] }; optsByPk.set(pk, e); }
    return e;
  };
  for (let i = 0; i < matchedPks.length; i += 300) {
    const chunk = matchedPks.slice(i, i + 300);
    const filters = [{ op: 'in', args: [cfg.variantFk, chunk] }];
    if (cfg.restricted) filters.push({ op: 'eq', args: ['is_restricted', false] });
    const rows = await fetchAll(supabase, cfg.variantsTable, vSelect.join(','),
      { filters, orderBy: cfg.variantPk });
    for (const r of rows) {
      const pk = r[cfg.variantFk];
      const c = realOpt(r[cfg.colorCol]) ? String(r[cfg.colorCol]).trim() : null;
      const s = (cfg.sizeCol && realOpt(r[cfg.sizeCol])) ? String(r[cfg.sizeCol]).trim() : null;
      if (!c && !s) continue;
      const e = ensurePk(pk);
      if (c) e.colors.add(c);
      if (s) e.sizes.add(s);
      e.pairs.push([c, s]);
    }
  }
  for (const [pk, e] of optsByPk) {
    for (const zid of (zidsByPk.get(pk) || [])) optsByZid.set(zid, e);
  }

  return { prodByZid, optsByZid, collisions, notInCatalog };
}

// Resolve, per account id, the catalog variants carrying a color → used to set the
// vendor catalog's per-color vendor_sku. Returns Map<zid, Array<{ color, sku, uom }>>
// (color trimmed; sku from the source's skuCol as a string; uom from uomCol or null).
// Several variants can share a color (different UOM/packaging) — all are returned so the
// caller can pick the one whose UOM matches the Zuper product. Mirrors variant-sku
// fan-out so multiple account products behind one parent each get the parent's variants.
async function resolveVariantSkus(supabase, source, zuperIds) {
  const cfg = getCatalogConfig(source);
  const { zidsByPk, collisions, notInCatalog } = await resolvePkMapping(supabase, cfg, zuperIds);
  const matchedPks = [...zidsByPk.keys()];
  const byZid = new Map();
  if (matchedPks.length === 0) return { byZid, collisions, notInCatalog };

  const sel = [cfg.variantFk, cfg.variantPk, cfg.colorCol, cfg.skuCol];
  if (cfg.uomCol) sel.push(cfg.uomCol);
  if (cfg.restricted) sel.push('is_restricted');
  const vSelect = [...new Set(sel)].join(',');   // skuCol may equal variantPk (QXO)

  const byPk = new Map();   // pk → [{ color, sku, uom }]
  for (let i = 0; i < matchedPks.length; i += 300) {
    const chunk = matchedPks.slice(i, i + 300);
    const filters = [{ op: 'in', args: [cfg.variantFk, chunk] }];
    if (cfg.restricted) filters.push({ op: 'eq', args: ['is_restricted', false] });
    const rows = await fetchAll(supabase, cfg.variantsTable, vSelect, { filters, orderBy: cfg.variantPk });
    for (const r of rows) {
      const color = realOpt(r[cfg.colorCol]) ? String(r[cfg.colorCol]).trim() : null;
      if (!color) continue;
      const sku = r[cfg.skuCol];
      if (sku == null || String(sku).trim() === '') continue;
      const pk = r[cfg.variantFk];
      if (!byPk.has(pk)) byPk.set(pk, []);
      byPk.get(pk).push({ color, sku: String(sku), uom: cfg.uomCol ? (r[cfg.uomCol] || '') : '' });
    }
  }
  for (const [pk, arr] of byPk) {
    for (const zid of (zidsByPk.get(pk) || [])) byZid.set(zid, arr);
  }
  return { byZid, collisions, notInCatalog };
}

// For variant-sku-keyed sources (qxo-sku): the Zuper product_id IS a specific
// variant's PK, so there's exactly ONE catalog variant per product. Returns
// Map<zid, sku> for the chosen field (variant_sku | product_number | manufacturer_number).
// Used by the vendor catalog (Zuper allows only one vendor_sku per product — no per-color).
async function resolveOwnVariantSkus(supabase, source, zuperIds, field = 'variant_sku') {
  const cfg = getCatalogConfig(source);
  if ((cfg.keyMode || '') !== 'variant-sku') {
    throw new Error(`resolveOwnVariantSkus is only defined for variant-sku sources (got "${source}")`);
  }
  const allowed = new Set(['variant_sku', 'product_number', 'manufacturer_number', 'material_number']);
  if (!allowed.has(field)) throw new Error(`Unsupported sku field "${field}" (allowed: ${[...allowed].join(', ')})`);
  const out = new Map();
  for (let i = 0; i < zuperIds.length; i += 300) {
    const chunk = zuperIds.slice(i, i + 300);
    const sel = [...new Set([cfg.variantPk, field])].join(',');
    const rows = await fetchAll(supabase, cfg.variantsTable, sel,
      { filters: [{ op: 'in', args: [cfg.variantPk, chunk] }], orderBy: cfg.variantPk });
    for (const r of rows) {
      const v = r[field];
      if (v == null || String(v).trim() === '') continue;
      out.set(r[cfg.variantPk], String(v));
    }
  }
  return out;
}

module.exports = { getCatalogConfig, indexAccountProducts, resolveVariantSkus, resolveOwnVariantSkus, realOpt };
