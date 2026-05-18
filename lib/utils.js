/**
 * Shared helpers for enrichment scripts.
 *
 * - fetchAll(supabase, table, select, opts)        — paginated read past the 1000-row cap
 * - upsertInBatches(supabase, table, rows, opts)   — batched write
 * - makeChangeLogger({ enabled, scriptName, fields }) — per-row diff capture for audit
 *
 * Scripts continue to load their own dotenv + create their own supabase client;
 * these helpers only standardize the read/write/log patterns that were
 * copy-pasted across enrich-*.js.
 */

const PAGE_DEFAULT  = 1000;
const BATCH_DEFAULT = 500;

/**
 * Paginated read. Supabase's PostgREST caps each request at 1000 rows; this
 * walks pages until exhausted.
 *
 * opts:
 *   pageSize:   default 1000
 *   filters:    array of { op, args } — applied via builder, e.g. { op: 'in', args: ['product_id', ids] }
 *   onProgress: optional fn(totalSoFar) callback for status output
 */
async function fetchAll(supabase, table, select, opts = {}) {
  const { pageSize = PAGE_DEFAULT, filters = [], onProgress } = opts;
  const rows = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(select);
    for (const f of filters) q = q[f.op](...f.args);
    q = q.range(from, from + pageSize - 1);
    const { data, error } = await q;
    if (error) throw new Error(`fetchAll(${table}): ${error.message}`);
    rows.push(...data);
    if (onProgress) onProgress(rows.length);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

/**
 * Batched upsert. Throws on any batch error, leaving partial state — callers
 * should design enrichment to be re-runnable (idempotent classification).
 *
 * opts:
 *   batchSize:  default 500
 *   onConflict: default 'product_id'
 *   onProgress: optional fn(done, total)
 */
async function upsertInBatches(supabase, table, rows, opts = {}) {
  const { batchSize = BATCH_DEFAULT, onConflict = 'product_id', onProgress } = opts;
  let done = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) throw new Error(`upsert(${table}) at row ${i}: ${error.message}`);
    done += batch.length;
    if (onProgress) onProgress(done, rows.length);
  }
  return done;
}

/**
 * Change logger — captures row-level diffs when --log-changes is passed.
 * On script completion, writes a timestamped JSON file in cwd that records
 * every (product_id, field) pair whose value flipped. Used to debug rule-change
 * fallout: "why did product X switch from 'better' to 'addon' last Tuesday?".
 *
 * No-op when disabled.
 */
function makeChangeLogger({ enabled, scriptName }) {
  if (!enabled) {
    return { log: () => {}, count: () => 0, save: async () => null };
  }
  const changes = [];
  const startedAt = new Date().toISOString();

  return {
    /** Record a single (product_id, field, old → new) change. */
    log(productId, field, oldVal, newVal) {
      // Treat null and undefined as the same "no value" state.
      const a = oldVal === undefined ? null : oldVal;
      const b = newVal === undefined ? null : newVal;
      if (a === b) return;
      changes.push({ product_id: productId, field, old: a, new: b });
    },
    count: () => changes.length,
    async save() {
      const fs = require('fs');
      const fname = `enrichment-changes-${scriptName}-${Date.now()}.json`;
      const payload = {
        script: scriptName,
        startedAt,
        finishedAt: new Date().toISOString(),
        count: changes.length,
        changes,
      };
      fs.writeFileSync(fname, JSON.stringify(payload, null, 2));
      return fname;
    },
  };
}

/** Returns true if the calling script was invoked with --log-changes */
function changeLogFlag() {
  return process.argv.includes('--log-changes');
}

module.exports = {
  PAGE_DEFAULT,
  BATCH_DEFAULT,
  fetchAll,
  upsertInBatches,
  makeChangeLogger,
  changeLogFlag,
};
