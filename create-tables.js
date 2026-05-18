require('dotenv').config();
const { Client } = require('pg');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_DB_PASSWORD } = process.env;

const projectRef = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '');

// Always use object-form config — avoids URL-encoding bugs when password contains
// special characters like @, #, %, etc.
let clientConfig;
if (SUPABASE_DB_PASSWORD) {
  // Pooler session mode with DB password.
  // Username format for pooler: postgres.<ref>
  const region = process.env.SUPABASE_REGION || 'us-east-1';
  clientConfig = {
    host:     `aws-0-${region}.pooler.supabase.com`,
    port:     5432,
    user:     `postgres.${projectRef}`,
    password: SUPABASE_DB_PASSWORD,
    database: 'postgres',
    ssl:      { rejectUnauthorized: false },
  };
  console.log(`Using pooler (${region}) with DB password.`);
} else {
  const region = process.env.SUPABASE_REGION || 'us-east-1';
  clientConfig = {
    host:     `aws-0-${region}.pooler.supabase.com`,
    port:     6543,
    user:     `postgres.${projectRef}`,
    password: SUPABASE_SERVICE_KEY,
    database: 'postgres',
    ssl:      { rejectUnauthorized: false },
  };
  console.log(`Using pooler (${region}) with service role key.`);
}

const SQL = `
CREATE TABLE IF NOT EXISTS srs_products (
  product_id          INTEGER PRIMARY KEY,
  product_name        TEXT NOT NULL,
  product_category    TEXT NOT NULL,
  manufacturer        TEXT,
  manufacturer_norm   TEXT,
  product_description TEXT,
  product_features    JSONB,
  product_uom         JSONB,
  product_options     JSONB,
  product_image_url   TEXT,
  primary_item        BOOLEAN DEFAULT FALSE,
  is_generic          BOOLEAN DEFAULT FALSE,
  allow_substitution  BOOLEAN DEFAULT FALSE,
  is_private_label    BOOLEAN DEFAULT FALSE,
  exclude_default     BOOLEAN DEFAULT FALSE,
  catalog_version     TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS srs_variants (
  variant_id            INTEGER PRIMARY KEY,
  product_id            INTEGER REFERENCES srs_products(product_id) ON DELETE CASCADE,
  variant_code          TEXT NOT NULL,
  order_uom             TEXT,
  color_name            TEXT,
  size_name             TEXT,
  selected_option       TEXT,
  variant_image_url     TEXT,
  uoms                  JSONB,
  customer_restrictions TEXT DEFAULT '',
  is_restricted         BOOLEAN DEFAULT FALSE,
  is_private_label      BOOLEAN DEFAULT FALSE,
  catalog_version       TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_category     ON srs_products(product_category);
CREATE INDEX IF NOT EXISTS idx_products_manufacturer ON srs_products(manufacturer_norm);
CREATE INDEX IF NOT EXISTS idx_products_exclude      ON srs_products(exclude_default);
CREATE INDEX IF NOT EXISTS idx_variants_product_id   ON srs_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_variants_color        ON srs_variants(color_name);
CREATE INDEX IF NOT EXISTS idx_variants_size         ON srs_variants(size_name);
CREATE INDEX IF NOT EXISTS idx_variants_restricted   ON srs_variants(is_restricted);
CREATE INDEX IF NOT EXISTS idx_variants_catalog_ver  ON srs_variants(catalog_version);
`;

const VERIFY_SQL = `
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('srs_products', 'srs_variants')
ORDER BY table_name;
`;

async function main() {
  const client = new Client(clientConfig);

  console.log(`Connecting to project: ${projectRef} ...`);
  await client.connect();
  console.log('Connected.\n');

  console.log('Running CREATE TABLE + INDEX statements...');
  await client.query(SQL);
  console.log('Done.\n');

  console.log('Verifying tables in information_schema.tables:');
  const { rows } = await client.query(VERIFY_SQL);
  if (rows.length === 0) {
    console.error('ERROR: No tables found — something went wrong.');
  } else {
    console.table(rows);
    const found = rows.map(r => r.table_name);
    const missing = ['srs_products', 'srs_variants'].filter(t => !found.includes(t));
    if (missing.length === 0) {
      console.log('✓ Both tables confirmed: srs_products, srs_variants');
    } else {
      console.error(`Missing tables: ${missing.join(', ')}`);
    }
  }

  await client.end();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
