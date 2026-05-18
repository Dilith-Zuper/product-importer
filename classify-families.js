// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Run this SQL in Supabase SQL Editor first:
//
// CREATE TABLE srs_product_families (
//   product_id        INTEGER PRIMARY KEY REFERENCES srs_products(product_id),
//   manufacturer_norm TEXT NOT NULL,
//   family_name       TEXT NOT NULL,
//   family_tier       TEXT,
//   is_default        BOOLEAN DEFAULT FALSE
// );
// CREATE INDEX idx_families_manufacturer ON srs_product_families(manufacturer_norm);
// CREATE INDEX idx_families_name         ON srs_product_families(family_name);
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── Classification rules ──────────────────────────────────────────────────────
// Each rule: { match(product) → bool, family, tier, defaultName? }
// Rules are evaluated in order; first match wins.
// defaultName: the exact product_name that gets is_default=true for that family.
// H&R and STARTER products share the family of their parent shingle line
// but never carry is_default (they're accessories, not the shingle itself).

const RULES = [

  // ══════════════════════════ GAF ══════════════════════════════════════════

  // Timberline HDZ — flagship
  { m: 'Gaf', rx: /timberline\s+hdz/i,          family: 'Timberline HDZ',       tier: 'flagship',  def: 'GAF Timberline HDZ StainGuard AR Shingles' },
  // Timberline UHDZ — premium (newer than HDZ)
  { m: 'Gaf', rx: /timberline\s+uhdz/i,         family: 'Timberline UHDZ',      tier: 'premium',   def: 'GAF Timberline UHDZ StainGuard Plus Shingles' },
  // Timberline Ultra HD — premium
  { m: 'Gaf', rx: /timberline\s+ultra\s+hd/i,   family: 'Timberline Ultra HD',  tier: 'premium',   def: 'GAF Timberline Ultra HD StainGuard Plus Shingles' },
  // Timberline ArmorShield II — specialty (impact)
  { m: 'Gaf', rx: /armorshield/i,                family: 'Timberline ArmorShield II', tier: 'specialty', def: 'GAF Timberline ArmorShield II Shingles' },
  // Timberline Solar — specialty
  { m: 'Gaf', rx: /timberline\s+solar/i,         family: 'Timberline Solar',     tier: 'specialty', def: 'GAF Timberline Solar HDZ' },
  // Timberline Natural Shadow — specialty
  { m: 'Gaf', rx: /natural\s+shadow/i,           family: 'Timberline Natural Shadow', tier: 'specialty', def: 'GAF Timberline Natural Shadow StainGuard Shingles' },
  // Timberline American Harvest (standalone — not under HDZ)
  { m: 'Gaf', rx: /timberline\s+american\s+harvest$/i, family: 'Timberline American Harvest', tier: 'specialty', def: 'GAF Timberline American Harvest' },
  // Timberline Cool Series — specialty
  { m: 'Gaf', rx: /timberline\s+cool/i,          family: 'Timberline Cool',      tier: 'specialty', def: 'GAF Timberline Cool Series' },
  // Timberline HD — flagship (prior gen; catch-all after specifics above)
  { m: 'Gaf', rx: /timberline\s+hd\b/i,          family: 'Timberline HD',        tier: 'flagship',  def: 'GAF Timberline HD StainGuard' },
  // Grand Sequoia — designer
  { m: 'Gaf', rx: /grand\s+sequoia/i,            family: 'Grand Sequoia',        tier: 'designer',  def: 'GAF Grand Sequoia Shingles' },
  // Grand Canyon — designer
  { m: 'Gaf', rx: /grand\s+canyon/i,             family: 'Grand Canyon',         tier: 'designer',  def: 'GAF Grand Canyon StainGuard' },
  // Camelot — designer
  { m: 'Gaf', rx: /camelot/i,                    family: 'Camelot',              tier: 'designer',  def: 'GAF Camelot II Shingles' },
  // Slateline — designer
  { m: 'Gaf', rx: /slateline/i,                  family: 'Slateline',            tier: 'designer',  def: 'GAF Slateline Shingles' },
  // Royal Sovereign — specialty (legacy 3-tab)
  { m: 'Gaf', rx: /royal\s+sovereign/i,          family: 'Royal Sovereign',      tier: 'specialty', def: 'GAF Royal Sovereign StainGuard Shingles' },
  // Woodland — designer
  { m: 'Gaf', rx: /woodland/i,                   family: 'Woodland',             tier: 'designer',  def: 'GAF Woodland LT AR Shingles' },
  // H&R: Seal-A-Ridge → Timberline HDZ
  { m: 'Gaf', rx: /seal.a.ridge/i,               family: 'Timberline HDZ',       tier: 'flagship' },
  // H&R: TimberTex → Timberline HDZ (used with both HD and HDZ)
  { m: 'Gaf', rx: /timbertex/i,                  family: 'Timberline HDZ',       tier: 'flagship' },
  // H&R: TimberCrest SBS → Timberline HDZ (SBS modified)
  { m: 'Gaf', rx: /timbercrest/i,                family: 'Timberline HDZ',       tier: 'flagship' },
  // H&R: Ridglass → Timberline HD
  { m: 'Gaf', rx: /ridglass/i,                   family: 'Timberline HD',        tier: 'flagship' },
  // H&R: Z-Ridge → Timberline HD
  { m: 'Gaf', rx: /z.ridge/i,                    family: 'Timberline HD',        tier: 'flagship' },
  // H&R: Drill-Tec (miscategorized fastener) → Timberline HDZ
  { m: 'Gaf', rx: /drill.tec/i,                  family: 'Timberline HDZ',       tier: 'flagship' },
  // STARTER: WeatherBlocker → Timberline HDZ
  { m: 'Gaf', rx: /weatherblocker/i,             family: 'Timberline HDZ',       tier: 'flagship' },
  // STARTER: StarterMatch → Timberline HDZ
  { m: 'Gaf', rx: /startermatch/i,               family: 'Timberline HDZ',       tier: 'flagship' },
  // STARTER: QuickStart → Timberline HDZ
  { m: 'Gaf', rx: /quickstart/i,                 family: 'Timberline HDZ',       tier: 'flagship' },
  // STARTER: Pro-Start → Timberline HDZ
  { m: 'Gaf', rx: /pro.start/i,                  family: 'Timberline HDZ',       tier: 'flagship' },

  // ══════════════════════════ CertainTeed ══════════════════════════════════

  // Landmark IR (impact) — specialty
  { m: 'Certainteed', rx: /landmark\s+ir\b/i,        family: 'Landmark IR',          tier: 'specialty', def: 'CertainTeed Landmark IR AR Shingles' },
  // Landmark ClimateFlex (impact) — specialty
  { m: 'Certainteed', rx: /landmark\s+climateflex/i, family: 'Landmark ClimateFlex', tier: 'specialty', def: 'CertainTeed Landmark ClimateFlex AR Shingles' },
  // Landmark TL — specialty (thick laminate)
  { m: 'Certainteed', rx: /landmark\s+tl\b/i,        family: 'Landmark TL',          tier: 'specialty', def: 'CertainTeed Landmark TL AR Shingles' },
  // Landmark Solaris (cool) — specialty
  { m: 'Certainteed', rx: /landmark\s+(solaris|non-ar\s+solaris)/i, family: 'Landmark Solaris', tier: 'specialty', def: 'CertainTeed Landmark Solaris AR Shingles' },
  // Landmark PRO — flagship (upgraded standard)
  { m: 'Certainteed', rx: /landmark\s+pro\b/i,       family: 'Landmark PRO',         tier: 'flagship',  def: 'CertainTeed Landmark PRO AR Shingles' },
  // Landmark Premium — premium
  { m: 'Certainteed', rx: /landmark\s+premium/i,     family: 'Landmark Premium',     tier: 'premium',   def: 'CertainTeed Landmark Premium AR Shingles' },
  // Landmark (standard) — flagship
  { m: 'Certainteed', rx: /^certainteed\s+landmark\b/i, family: 'Landmark',          tier: 'flagship',  def: 'CertainTeed Landmark AR Shingles' },
  // NorthGate ClimateFlex (impact) — specialty
  { m: 'Certainteed', rx: /northgate/i,              family: 'NorthGate',            tier: 'specialty', def: 'CertainTeed NorthGate ClimateFlex AR Shingles' },
  // Presidential Shake — designer
  { m: 'Certainteed', rx: /presidential/i,           family: 'Presidential Shake',   tier: 'designer',  def: 'CertainTeed Presidential Shake AR Shingles' },
  // Grand Manor — designer
  { m: 'Certainteed', rx: /grand\s+manor/i,          family: 'Grand Manor',          tier: 'designer',  def: 'CertainTeed Grand Manor AR Shingles' },
  // Highland Slate — designer
  { m: 'Certainteed', rx: /highland\s+slate/i,       family: 'Highland Slate',       tier: 'designer',  def: 'CertainTeed Highland Slate AR Shingles' },
  // Carriage House — designer
  { m: 'Certainteed', rx: /carriage\s+house/i,       family: 'Carriage House',       tier: 'designer',  def: 'CertainTeed Carriage House AR Shingles' },
  // Belmont — premium
  { m: 'Certainteed', rx: /belmont/i,                family: 'Belmont',              tier: 'premium',   def: 'CertainTeed Belmont AR Shingles' },
  // Hatteras — designer
  { m: 'Certainteed', rx: /hatteras/i,               family: 'Hatteras',             tier: 'designer',  def: 'CertainTeed Hatteras Designer Shingles' },
  // XT 25 (legacy 3-tab) — specialty
  { m: 'Certainteed', rx: /xt\s*25\b/i,              family: 'XT 25',                tier: 'specialty', def: 'CertainTeed XT 25 AR Shingles' },
  // IR XT 30 (impact) — specialty
  { m: 'Certainteed', rx: /ir\s+xt\s+30/i,           family: 'IR XT 30',             tier: 'specialty', def: 'CertainTeed IR XT 30 AR Shingles' },
  // Patriot (metric/economy) — specialty
  { m: 'Certainteed', rx: /patriot/i,                family: 'Patriot',              tier: 'specialty', def: 'CertainTeed Patriot Metric AR Shingles' },
  // Solstice (solar) — specialty
  { m: 'Certainteed', rx: /solstice/i,               family: 'Solstice',             tier: 'specialty', def: 'CertainTeed Solstice Shingle' },
  // H&R: CedarCrest → Presidential Shake
  { m: 'Certainteed', rx: /cedarcrest/i,             family: 'Presidential Shake',   tier: 'designer' },
  // H&R: Mountain Ridge → Landmark
  { m: 'Certainteed', rx: /mountain\s+ridge/i,       family: 'Landmark',             tier: 'flagship' },
  // H&R: Shadow Ridge → Landmark PRO
  { m: 'Certainteed', rx: /shadow\s+ridge/i,         family: 'Landmark PRO',         tier: 'flagship' },
  // H&R: Shangle Ridge → Landmark
  { m: 'Certainteed', rx: /shangle\s+ridge/i,        family: 'Landmark',             tier: 'flagship' },
  // H&R: NorthGate Ridge → NorthGate
  { m: 'Certainteed', rx: /northgate\s+ridge/i,      family: 'NorthGate',            tier: 'specialty' },
  // STARTER: SwiftStart → Landmark PRO
  { m: 'Certainteed', rx: /swiftstart/i,             family: 'Landmark PRO',         tier: 'flagship' },
  // STARTER: High-Performance Starter → Landmark PRO
  { m: 'Certainteed', rx: /high.performance\s+starter/i, family: 'Landmark PRO',    tier: 'flagship' },
  // STARTER: Presidential → Presidential Shake
  { m: 'Certainteed', rx: /presidential.*(starter|strip)/i, family: 'Presidential Shake', tier: 'designer' },
  // STARTER: Solstice Starter → Solstice
  { m: 'Certainteed', rx: /solstice.*starter/i,      family: 'Solstice',             tier: 'specialty' },
  // STARTER: CertaPlank Metal Starter → generic (metal panel)
  { m: 'Certainteed', rx: /certaplank/i,             family: 'Landmark',             tier: 'flagship' },

  // ══════════════════════════ Owens Corning ════════════════════════════════

  // Duration Designer — designer
  { m: 'Owens Corning', rx: /duration.*designer/i,    family: 'Duration Designer',   tier: 'designer',  def: 'Owens Corning TruDefinition Duration AR Designer Shingles' },
  // Duration FLEX (impact) — specialty
  { m: 'Owens Corning', rx: /duration\s+flex/i,       family: 'Duration FLEX',       tier: 'specialty', def: 'Owens Corning TruDefinition Duration FLEX AR IR Shingles' },
  // Duration STORM (impact) — specialty
  { m: 'Owens Corning', rx: /duration\s+storm/i,      family: 'Duration STORM',      tier: 'specialty', def: 'Owens Corning TruDefinition Duration STORM IR AR Shingles' },
  // Duration MAX — premium
  { m: 'Owens Corning', rx: /duration\s+max/i,        family: 'Duration MAX',        tier: 'premium',   def: 'Owens Corning TruDefinition Duration MAX AR Shingles' },
  // Duration Cool — specialty
  { m: 'Owens Corning', rx: /duration\s+cool/i,       family: 'Duration Cool',       tier: 'specialty', def: 'Owens Corning TruDefinition Duration Cool Non-AR Shingles' },
  // Duration Premium — premium
  { m: 'Owens Corning', rx: /duration\s+premium/i,    family: 'Duration Premium',    tier: 'premium',   def: 'Owens Corning Duration Premium AR Shingles' },
  // Duration (standard) — flagship
  { m: 'Owens Corning', rx: /duration\b/i,            family: 'Duration',            tier: 'flagship',  def: 'Owens Corning TruDefinition Duration AR Shingles' },
  // Oakridge — flagship (entry tier)
  { m: 'Owens Corning', rx: /oakridge/i,              family: 'Oakridge',            tier: 'flagship',  def: 'Owens Corning TruDefinition Oakridge AR Shingles' },
  // Supreme (legacy 3-tab) — specialty
  { m: 'Owens Corning', rx: /supreme\b/i,             family: 'Supreme',             tier: 'specialty', def: 'Owens Corning Supreme AR Shingles' },
  // Berkshire — designer
  { m: 'Owens Corning', rx: /berkshire/i,             family: 'Berkshire',           tier: 'designer',  def: 'Owens Corning Berkshire AR Shingles' },
  // Woodcrest — premium
  { m: 'Owens Corning', rx: /woodcrest/i,             family: 'Woodcrest',           tier: 'premium',   def: 'Owens Corning Woodcrest AR Shingles' },
  // Woodmoor — premium
  { m: 'Owens Corning', rx: /woodmoor/i,              family: 'Woodmoor',            tier: 'premium',   def: 'Owens Corning Woodmoor AR Shingles' },
  // H&R: WeatherGuard HP → Duration
  { m: 'Owens Corning', rx: /weatherguard\s+hp/i,     family: 'Duration',            tier: 'flagship' },
  // H&R: ImpactRidge → Duration STORM (impact ridge)
  { m: 'Owens Corning', rx: /impactridge/i,           family: 'Duration STORM',      tier: 'specialty' },
  // H&R: DuraRidge → Duration
  { m: 'Owens Corning', rx: /duraridge/i,             family: 'Duration',            tier: 'flagship' },
  // H&R: ProEdge → Duration
  { m: 'Owens Corning', rx: /proedge/i,               family: 'Duration',            tier: 'flagship' },
  // H&R: RIZERidge → Duration
  { m: 'Owens Corning', rx: /rizeridge/i,             family: 'Duration',            tier: 'flagship' },
  // H&R: DecoRidge → Duration
  { m: 'Owens Corning', rx: /decoridge/i,             family: 'Duration',            tier: 'flagship' },
  // H&R: High Ridge → Duration
  { m: 'Owens Corning', rx: /high\s+ridge/i,          family: 'Duration',            tier: 'flagship' },
  // H&R: Berkshire Hip & Ridge → Berkshire
  { m: 'Owens Corning', rx: /berkshire\s+hip/i,       family: 'Berkshire',           tier: 'designer' },
  // STARTER: WoodStart → Woodcrest/Woodmoor (shake)
  { m: 'Owens Corning', rx: /woodstart/i,             family: 'Woodcrest',           tier: 'premium' },
  // STARTER: Starter Strip → Duration
  { m: 'Owens Corning', rx: /starter\s+strip/i,       family: 'Duration',            tier: 'flagship' },

  // ══════════════════════════ IKO ══════════════════════════════════════════

  { m: 'Iko', rx: /armourshake/i,          family: 'ArmourShake',     tier: 'specialty', def: 'IKO Armourshake IR Shingles' },
  { m: 'Iko', rx: /cambridge\s+ir\b/i,     family: 'Cambridge',       tier: 'flagship' },
  { m: 'Iko', rx: /cambridge\s+cool/i,     family: 'Cambridge',       tier: 'flagship' },
  { m: 'Iko', rx: /cambridge\b/i,          family: 'Cambridge',       tier: 'flagship',  def: 'IKO Cambridge Shingles' },
  { m: 'Iko', rx: /dynasty/i,              family: 'Dynasty',         tier: 'premium',   def: 'IKO Dynasty AR Shingles' },
  { m: 'Iko', rx: /nordic/i,              family: 'Nordic',           tier: 'specialty', def: 'IKO Nordic IR ArmourZone AR Shingles' },
  { m: 'Iko', rx: /crowne\s+slate/i,       family: 'Crowne Slate',    tier: 'designer',  def: 'IKO Crowne Slate IR Shingles' },
  { m: 'Iko', rx: /royal\s+estate/i,       family: 'Royal Estate',    tier: 'designer',  def: 'IKO Royal Estate IR Shingles' },
  { m: 'Iko', rx: /biltmore/i,             family: 'Biltmore',        tier: 'designer',  def: 'IKO Biltmore AR Shingles' },
  { m: 'Iko', rx: /roofshake/i,            family: 'RoofShake',       tier: 'specialty', def: 'IKO RoofShake HW Shingles' },
  { m: 'Iko', rx: /marathon/i,             family: 'Marathon Plus',   tier: 'flagship',  def: 'IKO Marathon Plus AR Shingles' },
  { m: 'Iko', rx: /regency/i,              family: 'Regency',         tier: 'specialty', def: 'IKO Regency AR IR ArmourZone Shingles' },
  { m: 'Iko', rx: /ultrahp/i,              family: 'Dynasty',         tier: 'premium' },
  { m: 'Iko', rx: /hip\s*&?\s*ridge\s+12/i, family: 'Cambridge',     tier: 'flagship' },
  { m: 'Iko', rx: /(armour|leading edge|edgeseal)/i, family: 'Cambridge', tier: 'flagship' },

  // ══════════════════════════ TAMKO ════════════════════════════════════════

  { m: 'Tamko', rx: /metalworks/i,         family: 'MetalWorks',           tier: 'specialty', def: 'TAMKO MetalWorks AstonWood Shingles' },
  { m: 'Tamko', rx: /stormfighter/i,       family: 'Heritage StormFighter', tier: 'specialty', def: 'TAMKO StormFighter FLEX Proline Shingles' },
  { m: 'Tamko', rx: /titan\s+xt/i,         family: 'Titan XT',             tier: 'flagship',  def: 'TAMKO Titan XT Proline Shingles' },
  { m: 'Tamko', rx: /elite\s+glass.seal/i, family: 'Heritage Elite',       tier: 'specialty', def: 'TAMKO Elite Glass-Seal AR Shingles' },
  { m: 'Tamko', rx: /heritage\s+vintage/i, family: 'Heritage Vintage',     tier: 'specialty', def: 'TAMKO Heritage Vintage Shingles' },
  { m: 'Tamko', rx: /heritage\s+woodgate/i,family: 'Heritage Woodgate',    tier: 'specialty', def: 'TAMKO Heritage Woodgate Shingles' },
  { m: 'Tamko', rx: /heritage\s+(ar\s+ir|proline|ir\b)/i, family: 'Heritage StormFighter', tier: 'specialty' },
  { m: 'Tamko', rx: /heritage\b/i,         family: 'Heritage',             tier: 'flagship',  def: 'TAMKO Heritage Shingles' },
  { m: 'Tamko', rx: /designer\s+ridge/i,   family: 'Heritage',             tier: 'flagship' },
  { m: 'Tamko', rx: /(proline\s+hip|ir\s+hip|\ship\s*&|\bstarter)/i, family: 'Heritage', tier: 'flagship' },
  { m: 'Tamko', rx: /class\s+4\s+proline/i,family: 'Heritage StormFighter',tier: 'specialty' },
  { m: 'Tamko', rx: /perforated|shingle\s+starter/i, family: 'Heritage',   tier: 'flagship' },
  { m: 'Tamko', rx: /galvalume\s+perforated/i, family: 'Heritage',         tier: 'flagship' },

  // ══════════════════════════ Malarkey ═════════════════════════════════════

  { m: 'Malarkey', rx: /ecoasis/i,         family: 'Ecoasis NEX',      tier: 'specialty', def: 'Malarkey Ecoasis NEX Polymer Modified Shingles' },
  { m: 'Malarkey', rx: /highlander/i,      family: 'Highlander NEX',   tier: 'flagship',  def: 'Malarkey Highlander NEX AR Shingles' },
  { m: 'Malarkey', rx: /legacy/i,          family: 'Legacy NEX',       tier: 'premium',   def: 'Malarkey Legacy Scotchgard Shingles' },
  { m: 'Malarkey', rx: /vista/i,           family: 'Vista',            tier: 'flagship',  def: 'Malarkey Vista AR Shingles' },
  { m: 'Malarkey', rx: /windsor/i,         family: 'Windsor',          tier: 'premium',   def: 'Malarkey Windsor Scotchgard' },
  { m: 'Malarkey', rx: /ez.ridge|ridgeflex/i, family: 'Vista',         tier: 'flagship' },
  { m: 'Malarkey', rx: /210\s+smart\s+start|starter/i, family: 'Vista',tier: 'flagship' },

  // ══════════════════════════ Atlas ════════════════════════════════════════

  { m: 'Atlas', rx: /glassMaster/i,        family: 'GlassMaster',      tier: 'specialty', def: 'Atlas GlassMaster 30 Shingles' },
  { m: 'Atlas', rx: /pinnacle.*impact|impact.*ir/i, family: 'Pinnacle IR', tier: 'specialty', def: 'Atlas Pinnacle Impact IR Shingle' },
  { m: 'Atlas', rx: /pinnacle.*cool/i,     family: 'Pinnacle Cool',    tier: 'specialty', def: 'Atlas Pinnacle Cool Sun Shingles' },
  { m: 'Atlas', rx: /pinnacle/i,           family: 'Pinnacle',         tier: 'premium',   def: 'Atlas Pinnacle Pristine HP42 SG Shingles' },
  { m: 'Atlas', rx: /stormMaster/i,        family: 'StormMaster',      tier: 'specialty', def: 'Atlas StormMaster Scotchgard Shake Shingles' },
  { m: 'Atlas', rx: /prolam|pro.lam/i,     family: 'ProLam',           tier: 'flagship',  def: 'Atlas ProLam HP42 Shingles' },
  { m: 'Atlas', rx: /ridge\s+tile/i,       family: 'ProLam',           tier: 'flagship' },
  { m: 'Atlas', rx: /pro.cut/i,            family: 'ProLam',           tier: 'flagship' },

  // ══════════════════════════ PABCO ════════════════════════════════════════

  { m: 'Pabco', rx: /paramount/i,          family: 'Paramount',        tier: 'flagship',  def: 'PABCO Paramount AR Shingles' },
  { m: 'Pabco', rx: /premier/i,            family: 'Premier',          tier: 'flagship',  def: 'PABCO Premier AR Shingles' },
  { m: 'Pabco', rx: /prestige/i,           family: 'Prestige',         tier: 'premium',   def: 'PABCO Prestige Shingles' },
  { m: 'Pabco', rx: /cascade/i,            family: 'Cascade',          tier: 'premium',   def: 'Pabco Cascade Signature Cut Shingles' },
  { m: 'Pabco', rx: /shadow\s+cap|shasta/i,family: 'Paramount',        tier: 'flagship' },
  { m: 'Pabco Roofing', rx: /.*/,          family: 'Cascade',          tier: 'premium' },
  { m: 'Pabco Roofing Products', rx: /.*/,  family: 'Paramount',       tier: 'flagship' },

  // ══════════════════════════ Boral ════════════════════════════════════════

  { m: 'Boral', rx: /steel/i,              family: 'Boral Steel',      tier: 'specialty', def: 'Boral Steel Top Row Barrel-Vault' },
  { m: 'Boral', rx: /cedarlite/i,          family: 'Cedarlite',        tier: 'flagship',  def: 'Boral Cedarlite Lightweight Concrete V-Ridge' },
  { m: 'Boral', rx: /duralite/i,           family: 'Duralite',         tier: 'premium',   def: 'Boral Duralite Lightweight Concrete Ridge' },
  { m: 'Boral', rx: /saxony.*(900|shake|slate)/i, family: 'Saxony 900', tier: 'premium',  def: 'Boral Saxony 900 Slate Concrete V-Ridge' },
  { m: 'Boral', rx: /saxony/i,             family: 'Saxony',           tier: 'flagship',  def: 'Boral Saxony Standard Concrete 3-Sided Ridge' },
  { m: 'Boral', rx: /madera/i,             family: 'Madera',           tier: 'flagship',  def: 'Boral Madera 900 Concrete V-Ridge' },
  { m: 'Boral', rx: /villa/i,              family: 'Villa 900',        tier: 'premium',   def: 'Boral Villa Hip & Ridge' },
  { m: 'Boral', rx: /claymax/i,            family: 'ClayMax',          tier: 'designer',  def: 'Boral ClayMax Hip & Ridge' },
  { m: 'Boral', rx: /capri|apex/i,          family: 'Villa 900',        tier: 'premium' },
  { m: 'Boral', rx: /3.sided|elevated|batten|te210|moulding|striated\s+concrete\s+hip/i, family: 'Saxony', tier: 'flagship' },
  { m: 'Boral', rx: /barcelona|tejas|espa/i, family: 'Villa 900',      tier: 'premium' },
  // No catch-all for Boral — unmatched products fall through to 'Unknown'
  // and surface in the script's warning report so we can decide explicitly.
  // The prior catch-all defaulted everything Boral-branded to 'Saxony' which
  // silently mis-classified anything new the catalog added.

  // ══════════════════════════ Boral Steel ══════════════════════════════════
  { m: 'Boral Steel', rx: /.*/,            family: 'Boral Steel',      tier: 'specialty', def: 'Boral Steel Cap Shingle Hip & Ridge' },

  // ══════════════════════════ DECRA ════════════════════════════════════════

  { m: 'Decra', rx: /shingle\s+xd/i,       family: 'DECRA Shingle XD', tier: 'flagship',  def: 'DECRA Shingle XD Hip & Ridge' },
  { m: 'Decra', rx: /shingle\s+plus/i,     family: 'DECRA Shingle Plus', tier: 'flagship', def: 'DECRA Shingle Plus' },
  { m: 'Decra', rx: /shake\s+xd/i,         family: 'DECRA Shake XD',   tier: 'premium',   def: 'DECRA Shake XD Hip & Ridge' },
  { m: 'Decra', rx: /shake/i,              family: 'DECRA Shake',      tier: 'premium',   def: 'DECRA Shake Hip & Ridge' },
  { m: 'Decra', rx: /villa\s+tile/i,       family: 'DECRA Villa Tile', tier: 'designer',  def: 'DECRA Tile Hip & Ridge for Villa Tile' },
  { m: 'Decra', rx: /tile/i,               family: 'DECRA Tile',       tier: 'designer',  def: 'DECRA Tile Hip & Ridge' },
  { m: 'Decra', rx: /chips?|granule/i,     family: 'DECRA Shingle Plus', tier: 'flagship' },
  // Base stone-coated shingle (original, no XD/Plus suffix) → Shingle Plus family
  { m: 'Decra', rx: /hip\s*&\s*ridge\s+shingle$/i, family: 'DECRA Shingle Plus', tier: 'flagship' },
  // Decra catch-all
  { m: 'Decra', rx: /.*/,                 family: 'DECRA Shingle Plus', tier: 'flagship' },

  // ══════════════════════════ Tilcor ═══════════════════════════════════════

  { m: 'Tilcor', rx: /antica/i,            family: 'Tilcor Antica',    tier: 'designer',  def: 'Tilcor V-Ridge Trim' },
  { m: 'Tilcor', rx: /.*/,                 family: 'Tilcor Shingle',   tier: 'flagship',  def: 'Tilcor V-Ridge Trim' },

  // ══════════════════════════ Eagle ════════════════════════════════════════

  { m: 'Eagle', rx: /bel\s+air/i,          family: 'Bel Air',          tier: 'flagship',  def: 'Eagle Bel Air Standard Select Conventional Weight Tile' },
  { m: 'Eagle', rx: /ponderosa|golden\s+eagle/i, family: 'Ponderosa',  tier: 'flagship',  def: 'Eagle Ponderosa Concrete Ridge' },
  { m: 'Eagle', rx: /estate/i,             family: 'Estate',           tier: 'premium',   def: 'Eagle Estate Ridge' },
  { m: 'Eagle', rx: /capistrano/i,         family: 'Capistrano',       tier: 'designer',  def: 'Eagle Capistrano/Ponderosa/Golden Eagle Ridge' },
  { m: 'Eagle', rx: /malibu/i,             family: 'Malibu',           tier: 'flagship',  def: 'Eagle Malibu Sub 800 Lightweight Tile' },
  { m: 'Eagle', rx: /slate/i,              family: 'Bel Air',          tier: 'flagship' },
  { m: 'Eagle', rx: /barrel|flat\s+tile/i, family: 'Ponderosa',        tier: 'flagship' },

  // ══════════════════════════ Brava Roof Tile ═══════════════════════════════

  { m: 'Brava Roof Tile', rx: /slate/i,    family: 'Brava Slate',      tier: 'designer',  def: 'Brava Slate Hip & Ridge Class A' },
  { m: 'Brava Roof Tile', rx: /spanish\s+barrel|barrel/i, family: 'Brava Spanish Barrel', tier: 'designer', def: 'Brava Synthetic Spanish Barrel Tile Hip & Ridge Class A' },
  { m: 'Brava Roof Tile', rx: /cedar\s+shake|shake/i, family: 'Brava Cedar Shake', tier: 'designer', def: 'Brava Cedar Shake Starter' },
  { m: 'Brava Roof Tile', rx: /.*/,        family: 'Brava',            tier: 'designer' },

  // ══════════════════════════ DaVinci Roofscapes ═══════════════════════════

  { m: 'Davinci Roofscapes', rx: /slate/i, family: "DaVinci Slate",    tier: 'designer',  def: 'DaVinci Slate Hinged Hip & Ridge' },
  { m: 'Davinci Roofscapes', rx: /shake|bellaforte/i, family: 'DaVinci Shake', tier: 'designer', def: 'DaVinci Composite Bellaforté & Select Shake Hinged Hip & Ridge' },
  { m: 'Davinci Roofscapes', rx: /.*/,     family: 'DaVinci',          tier: 'designer' },

  // ══════════════════════════ Tesla ════════════════════════════════════════

  { m: 'Tesla', rx: /.*/,                  family: 'Tesla Solar Roof',  tier: 'specialty', def: 'Tesla Metal Roof Tile' },

  // ══════════════════════════ Worthouse ════════════════════════════════════

  { m: 'Worthouse', rx: /.*/,              family: 'Supre Metal Tile',  tier: 'specialty', def: 'Worthouse Supre Metal Tile' },

  // ══════════════════════════ F-Wave ═══════════════════════════════════════

  { m: 'F-wave', rx: /shake/i,             family: 'F-Wave Shake',      tier: 'designer',  def: 'F-Wave Hand Split Shake Hip & Ridge' },
  { m: 'F-wave', rx: /.*/,                 family: 'F-Wave REVIA Slate', tier: 'designer', def: 'F-Wave REVIA Classic Slate Hip & Ridge' },

  // ══════════════════════════ EcoStar ══════════════════════════════════════
  { m: 'Ecostar', rx: /.*/,                family: 'Majestic Slate',    tier: 'designer',  def: 'EcoStar Majestic Slate Hip & Ridge' },

  // ══════════════════════════ CeDUR ════════════════════════════════════════
  { m: 'Cedur', rx: /.*/,                  family: 'CeDUR',             tier: 'designer',  def: 'CeDUR Medium Ridge' },

  // ══════════════════════════ Inspire ══════════════════════════════════════
  { m: 'Inspire', rx: /.*/,                family: 'Inspire Classic',   tier: 'designer',  def: 'Inspire Classic Hip & Ridge' },

  // ══════════════════════════ MCA / Clay Tile ══════════════════════════════
  { m: 'Mca', rx: /.*/,                    family: 'MCA Mission',       tier: 'designer',  def: 'MCA Straight Mission Barrel' },
  { m: 'Mca Tile', rx: /.*/,               family: 'MCA Mission',       tier: 'designer',  def: 'MCA One Piece S Mission' },

  // ══════════════════════════ Stoneworth ═══════════════════════════════════
  { m: 'Stoneworth', rx: /.*/,             family: 'Oxford Stone Coated', tier: 'specialty', def: 'Stoneworth Oxford Concrete Hip & Ridge' },

  // ══════════════════════════ Crown Roof Tiles ═════════════════════════════
  { m: 'Crown Roof Tiles', rx: /.*/,       family: 'Crown',             tier: 'flagship',  def: 'Crown Windsor Concrete Ridge' },

  // ══════════════════════════ Verea ════════════════════════════════════════
  { m: 'Verea', rx: /.*/,                  family: 'Verea Clay',        tier: 'designer',  def: 'Verea Clay Hip & Ridge' },

  // ══════════════════════════ Roser ════════════════════════════════════════
  { m: 'Roser', rx: /.*/,                  family: 'Roser Stone Wood',  tier: 'specialty', def: 'Roser Cleo Tile Hip & Ridge' },

  // ══════════════════════════ Santafe / Santafé ════════════════════════════
  { m: 'Santafe Tile', rx: /.*/,           family: 'Santafe Clay',      tier: 'designer',  def: 'Santafe Tile Planum La Escandella Hip & Ridge' },
  { m: 'Santafé Tile', rx: /.*/,           family: 'Santafe Clay',      tier: 'designer' },

  // ══════════════════════════ Greenstone / Vermont Slate ═══════════════════
  { m: 'Greenstone Slate', rx: /.*/,       family: 'Vermont Slate',     tier: 'designer',  def: 'Greenstone Slate SlateTec Vermont Hip & Ridge' },
  { m: 'Vermont Slate Company', rx: /.*/,  family: 'Vermont Slate',     tier: 'designer',  def: 'Vermont Slate Cupa Ridge' },

  // ══════════════════════════ Waldun / Cedar shake ══════════════════════════
  { m: 'Waldun', rx: /.*/,                 family: 'Cedar Shake',       tier: 'specialty', def: 'Waldun WRC Medium Tapersawn Hip & Ridge' },
  { m: 'Manufacturer Varies', rx: /cedar/i, family: 'Cedar Shake',      tier: 'specialty', def: 'Cedar Tapersawn Hip & Ridge' },
  { m: 'Manufacturer Varies', rx: /.*/,    family: 'Generic',           tier: 'specialty' },

  // ══════════════════════════ Misc small brands ════════════════════════════
  { m: 'Claymex', rx: /.*/,                family: 'Claymex Clay Tile', tier: 'designer',  def: 'Claymex Clay Tile Rake' },
  { m: 'International Stone Imports', rx: /.*/,  family: 'Sandcast Tile', tier: 'designer', def: 'International Stone Imports Sandcast Pinto Viejo Pan' },
  { m: 'Klauer Manufacturing', rx: /.*/,   family: 'Steel Classic',     tier: 'specialty', def: 'Klauer Steel Classic Shingle' },
  { m: 'O\'hagin', rx: /.*/,              family: 'Tile Vent',         tier: 'specialty', def: 'O\'Hagin Flat Aluminum Vent' },
  { m: 'Topshield', rx: /.*/,              family: 'Generic Metal',     tier: 'specialty', def: 'TopShield Galvanized Tin Shingles' },
  { m: 'Stampco', rx: /.*/,               family: 'Generic',           tier: 'specialty', def: 'Stampco Galvanized Shingle Vent' },
  { m: 'Tassie Siding Inc', rx: /.*/,     family: 'Generic Metal',     tier: 'specialty', def: 'Tassie Siding Prebent Step Shingles' },
  { m: 'Alside', rx: /.*/,                family: 'Pelican Bay',        tier: 'flagship',  def: 'Alside Pelican Bay One Cape Cod Shingle Siding' },
  { m: 'Apoc', rx: /.*/,                  family: 'Roof Tile Adhesive', tier: 'specialty', def: 'APOC 705 Polyset RTA-1 Roof Tile' },
  { m: 'Azek', rx: /.*/,                  family: 'Trim Moulding',      tier: 'specialty', def: 'Azek Shingle Moulding' },
  { m: 'Asc', rx: /.*/,                   family: 'Metal Roofing Trim', tier: 'specialty', def: 'ASC Zincalume Hip & Ridge' },
  { m: 'Diamond Ridge', rx: /.*/,         family: 'Diamond Ridge',      tier: 'flagship',  def: 'Diamond Ridge Hip & Ridge' },
  { m: 'Diamond Kote', rx: /.*/,          family: 'Diamond Kote Steel', tier: 'specialty', def: 'Diamond Kote RigidStack Steel Starter' },
  { m: 'Ecostar', rx: /.*/,               family: 'Majestic Slate',     tier: 'designer' },
  { m: 'Edco', rx: /.*/,                  family: 'EDCO Steel Shake',   tier: 'specialty', def: 'EDCO Shake Hip & Ridge Cap Solid' },
  { m: 'Flamco', rx: /.*/,                family: 'Generic Metal',      tier: 'specialty', def: 'Flamco Galvanized Ridge Flashing' },
  { m: 'Foundry', rx: /.*/,               family: 'Foundry Shake',      tier: 'designer',  def: 'Foundry Shake Starter Strip' },
  { m: 'Hecker', rx: /.*/,                family: 'Hecker Concrete',    tier: 'flagship',  def: 'Hecker Concrete V-Ridge Tiles' },
  { m: 'Hecker Ridge Tiles', rx: /.*/,    family: 'Hecker Concrete',    tier: 'flagship' },
  { m: 'In-o-vate Manufacturing', rx: /.*/,  family: 'Rapid Ridge',     tier: 'flagship',  def: 'In-o-vate Rapid Ridge Plus Hip & Ridge' },
  { m: 'Inovate Manufacturing', rx: /.*/,    family: 'Rapid Ridge',     tier: 'flagship' },
  { m: 'Terracotta North America', rx: /.*/,  family: 'Terracotta Mission', tier: 'designer', def: 'Terracotta North America 2-Piece Mission' },
  { m: 'Tek Industries', rx: /.*/,        family: 'Bird Stop Ridge',    tier: 'specialty', def: 'TEK Industries Bird Stop Ridge' },
  { m: 'Tamco', rx: /.*/,                 family: 'Galvalume Ridge',    tier: 'specialty', def: 'TAMCO Galvalume Perforated Ridge Channel' },
  { m: 'Top Notch', rx: /.*/,             family: 'Tile Ridge',         tier: 'specialty', def: 'Ridged Top Notch Tile Ridge System' },
  // Generic starters from various brands
  { m: 'Bellara', rx: /.*/,               family: 'Generic Metal',      tier: 'specialty', def: 'Bellara G90 Galvanized Starter Strip' },
  { m: 'Berger', rx: /.*/,                family: 'Generic Metal',      tier: 'specialty', def: 'Berger Aluminum Starter' },
  { m: 'Ft Synthetics', rx: /.*/,         family: 'Synthetic Starter',  tier: 'specialty', def: 'FT Synthetics EavePro 44 Starter Strip' },
  { m: 'Genesee Building Products', rx: /.*/,  family: 'Generic Metal', tier: 'specialty', def: 'Genesee Narrow Galvanized Steel Starter' },
  { m: 'Gladding Mcbean', rx: /.*/,       family: 'Cordova Tile',       tier: 'designer',  def: 'GMCB Cordova Starter' },
  { m: 'Great American', rx: /.*/,        family: 'Cedar Shake',        tier: 'specialty', def: 'Great American Shake Eave Starter Shake' },
  { m: 'Mbtechnology', rx: /.*/,          family: 'SBS Modified',       tier: 'specialty', def: 'MBTechnology SBS Shingle Starter' },
  { m: 'Mfm', rx: /.*/,                   family: 'Synthetic Starter',  tier: 'specialty', def: 'MFM Starter Shingle Roll' },
  { m: 'Norwesco', rx: /.*/,              family: 'Generic Metal',      tier: 'specialty', def: 'Norwesco Stainless Steel Roof Starter' },
  { m: 'Nu-ray', rx: /.*/,               family: 'Generic Metal',      tier: 'specialty', def: 'Nu-Ray PVC Clad Starter' },
  { m: 'Provia', rx: /.*/,               family: 'Generic',            tier: 'specialty', def: 'ProVia Universal Starter Strip' },
  { m: 'Quarrix', rx: /.*/,              family: 'Tile Starter',       tier: 'specialty', def: 'Quarrix Double Roman Hip Starter' },
  { m: 'Tag & Stick', rx: /.*/,          family: 'SBS Modified',       tier: 'specialty', def: 'Tag & Stick Selvage Starter Sheet' },
  { m: 'Evergreen Slate Company', rx: /.*/, family: 'Vermont Slate',   tier: 'designer',  def: 'Evergreen Slate Vermont Starter' },
  { m: 'Everlast', rx: /.*/,             family: 'Generic',            tier: 'specialty', def: 'Everlast PVC Starter Strip' },
];

function classify(product) {
  const n = product.product_name.trim();
  const mfr = product.manufacturer_norm;
  for (const rule of RULES) {
    if (rule.m === mfr && rule.rx.test(n)) {
      return { family_name: rule.family, family_tier: rule.tier, defName: rule.def || null };
    }
  }
  return { family_name: 'Unknown', family_tier: 'specialty', defName: null };
}

async function main() {
  // ── Fetch all products ──────────────────────────────────────────────────
  console.log('Fetching products …');
  const { data: products, error } = await supabase
    .from('srs_products')
    .select('product_id, product_name, manufacturer_norm, product_category')
    .in('product_category', ['SHINGLES', 'HIP AND RIDGE', 'STARTER'])
    .eq('exclude_default', false)
    .order('manufacturer_norm').order('product_category').order('product_name');
  if (error) throw new Error(error.message);
  console.log(`  ${products.length} products fetched\n`);

  // ── Classify ─────────────────────────────────────────────────────────────
  const classified = products.map(p => ({ ...p, ...classify(p) }));

  // ── Compute is_default: one per (manufacturer_norm, family_name) ─────────
  // Only SHINGLES category products can be defaults (not H&R or STARTER).
  const defaultSet = new Set();
  const rows = classified.map(p => {
    const key = `${p.manufacturer_norm}|${p.family_name}`;
    const isShingle = p.product_category === 'SHINGLES';
    const isDefault = isShingle && p.defName === p.product_name.trim() && !defaultSet.has(key);
    if (isDefault) defaultSet.add(key);
    return {
      product_id:        p.product_id,
      manufacturer_norm: p.manufacturer_norm,
      family_name:       p.family_name,
      family_tier:       p.family_tier,
      is_default:        isDefault,
    };
  });

  // ── Preview unknown / unmatched ───────────────────────────────────────────
  const unknowns = rows.filter(r => r.family_name === 'Unknown');
  if (unknowns.length) {
    console.log(`⚠  ${unknowns.length} unclassified products:`);
    unknowns.forEach(r => {
      const p = classified.find(x => x.product_id === r.product_id);
      console.log(`   [${p.manufacturer_norm}] ${p.product_name}`);
    });
    console.log();
  }

  // ── Summary stats ─────────────────────────────────────────────────────────
  const families = new Set(rows.map(r => r.family_name)).size;
  const defaults  = rows.filter(r => r.is_default).length;
  console.log(`Classification summary:`);
  console.log(`  Products classified : ${rows.length}`);
  console.log(`  Unique families     : ${families}`);
  console.log(`  is_default=true     : ${defaults}`);
  console.log();

  // ── Clear existing & insert ───────────────────────────────────────────────
  console.log('Clearing srs_product_families …');
  const { error: delErr } = await supabase.from('srs_product_families').delete().neq('product_id', 0);
  if (delErr) throw new Error(`Clear: ${delErr.message}`);

  console.log('Inserting classifications …');
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error: insErr } = await supabase.from('srs_product_families').insert(batch);
    if (insErr) throw new Error(`Insert batch ${i}: ${insErr.message}`);
    process.stdout.write(`  ${Math.min(i + BATCH, rows.length)} / ${rows.length} …\r`);
  }
  console.log(`  ${rows.length} / ${rows.length} ✓\n`);

  // ── Verification: SHINGLES families with default count ───────────────────
  console.log('─'.repeat(80));
  console.log('VERIFICATION — SHINGLES families (manufacturer_norm / family_name / tier / count / default)');
  console.log('─'.repeat(80));

  const { data: fams, error: fErr } = await supabase
    .from('srs_product_families')
    .select('manufacturer_norm, family_name, family_tier, is_default, product_id, srs_products!inner(product_category)')
    .eq('srs_products.product_category', 'SHINGLES')
    .order('manufacturer_norm').order('family_tier').order('family_name');
  if (fErr) throw new Error(`Verify: ${fErr.message}`);

  // Aggregate in JS
  const agg = {};
  fams.forEach(r => {
    const k = `${r.manufacturer_norm}||${r.family_name}||${r.family_tier}`;
    if (!agg[k]) agg[k] = { manufacturer_norm: r.manufacturer_norm, family_name: r.family_name, family_tier: r.family_tier, products: 0, has_default: 0 };
    agg[k].products++;
    if (r.is_default) agg[k].has_default++;
  });

  const vRows = Object.values(agg).sort((a, b) =>
    a.manufacturer_norm.localeCompare(b.manufacturer_norm) ||
    ['flagship','premium','designer','specialty'].indexOf(a.family_tier) - ['flagship','premium','designer','specialty'].indexOf(b.family_tier) ||
    a.family_name.localeCompare(b.family_name)
  );

  // Print table
  const cols = ['manufacturer_norm','family_name','family_tier','products','has_default'];
  const widths = cols.map(c => Math.max(c.length, ...vRows.map(r => String(r[c]).length)));
  const sep = widths.map(w => '-'.repeat(w + 2)).join('+');
  const fmt = r => cols.map((c, i) => ` ${String(r[c]).padEnd(widths[i])} `).join('|');
  console.log(sep);
  console.log(cols.map((c, i) => ` ${c.padEnd(widths[i])} `).join('|'));
  console.log(sep);
  let curMfr = '';
  vRows.forEach(r => {
    if (r.manufacturer_norm !== curMfr) { console.log(sep); curMfr = r.manufacturer_norm; }
    console.log(fmt(r));
  });
  console.log(sep);
  console.log(`\n  ${vRows.length} family rows, ${vRows.reduce((s,r)=>s+r.has_default,0)} defaults set\n`);
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
