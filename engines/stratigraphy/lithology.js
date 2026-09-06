// Lithology, grain size and depositional environment vocabulary
// (Stratigraphy Studio ST1, 2026-09-06).
//
// One list of lithology codes with the colours the industry expects on a
// lithology column (sand yellow, shale grey-green, limestone blue, dolomite
// purple, salt and anhydrite pale, coal black), the Wentworth (1922) grain
// size classes, a depositional-environment list, and the interval kinds
// the registry stores (geo_wells_intervals.kind). Lookups are tolerant of
// the abbreviations mud loggers actually write (SS, SH, LS, DOL, ANH ...)
// so a LAS 3.0 lithology block or a pasted CSV lands without a mapping
// dialog for the common cases.

export const INTERVAL_KINDS = Object.freeze([
  { code: 'lithology', name: 'Lithology', description: 'Rock type between two depths, from cuttings, core or logs.' },
  { code: 'core_description', name: 'Core description', description: 'Sedimentological description of a cored interval: lithology, grain size, structures, colour.' },
  { code: 'facies', name: 'Facies', description: 'Facies assigned between two depths, by hand or published from a crossplot.' },
  { code: 'electrofacies', name: 'Electrofacies', description: 'Facies assigned from log response alone.' },
  { code: 'environment', name: 'Depositional environment', description: 'Interpreted environment of deposition.' },
  { code: 'motif', name: 'Log motif', description: 'Gamma-ray shape between two depths (blocky, bell, funnel, bow, serrated).' },
  { code: 'systems_tract', name: 'Systems tract', description: 'Catuneanu systems tract between two typed surfaces (ST2).' },
  { code: 'biozone_interval', name: 'Biozone', description: 'Range of a biozone between two depths (ST3).' },
]);

export const INTERVAL_KIND_CODES = Object.freeze(INTERVAL_KINDS.map((k) => k.code));

export const INTERVAL_SOURCES = Object.freeze(['core', 'cuttings', 'log', 'interpretation', 'import']);

/** Lithologies: code, name, colour, the aliases mud logs use, a coarse class. */
export const LITHOLOGIES = Object.freeze([
  { code: 'sandstone', name: 'Sandstone', colour: '#f4d03f', aliases: ['SS', 'SST', 'SAND', 'SD', 'SDST'], klass: 'siliciclastic' },
  { code: 'siltstone', name: 'Siltstone', colour: '#c9b96a', aliases: ['SLT', 'SLTST', 'SILT', 'SI'], klass: 'siliciclastic' },
  { code: 'shale', name: 'Shale', colour: '#8fa08a', aliases: ['SH', 'SHL', 'SHALE', 'CLYST', 'MUDST', 'MUDSTONE', 'CLAYSTONE', 'CLAY', 'CL'], klass: 'siliciclastic' },
  { code: 'marl', name: 'Marl', colour: '#a9c4a0', aliases: ['MRL', 'MARL', 'MRLST'], klass: 'mixed' },
  { code: 'conglomerate', name: 'Conglomerate', colour: '#d8a35d', aliases: ['CGL', 'CONG', 'CONGL', 'GRAVEL', 'GVL'], klass: 'siliciclastic' },
  { code: 'limestone', name: 'Limestone', colour: '#6fa8dc', aliases: ['LS', 'LST', 'LIME', 'LMST', 'CALC'], klass: 'carbonate' },
  { code: 'chalk', name: 'Chalk', colour: '#a4c8ec', aliases: ['CHK', 'CHALK'], klass: 'carbonate' },
  { code: 'dolomite', name: 'Dolomite', colour: '#a78bd6', aliases: ['DOL', 'DOLO', 'DOLST', 'DOLOM'], klass: 'carbonate' },
  { code: 'anhydrite', name: 'Anhydrite', colour: '#e7d7f1', aliases: ['ANH', 'ANHY', 'ANHYD'], klass: 'evaporite' },
  { code: 'gypsum', name: 'Gypsum', colour: '#f1e7f7', aliases: ['GYP', 'GYPS'], klass: 'evaporite' },
  { code: 'halite', name: 'Halite (salt)', colour: '#f8f0d8', aliases: ['SALT', 'HAL', 'HLT', 'NACL'], klass: 'evaporite' },
  { code: 'coal', name: 'Coal', colour: '#1f1f1f', aliases: ['COAL', 'CL', 'LIG', 'LIGNITE'], klass: 'organic' },
  { code: 'chert', name: 'Chert', colour: '#b7c3c9', aliases: ['CHT', 'CHERT', 'FLINT'], klass: 'siliceous' },
  { code: 'volcanic', name: 'Volcanic', colour: '#c76d6d', aliases: ['VOLC', 'VOL', 'BASALT', 'BAS', 'TUFF', 'IGN'], klass: 'igneous' },
  { code: 'basement', name: 'Basement', colour: '#d98cb3', aliases: ['BSMT', 'BASEMENT', 'GRANITE', 'GRN', 'GNEISS', 'META'], klass: 'crystalline' },
  { code: 'unknown', name: 'Unknown', colour: '#cbd5e1', aliases: ['UNK', 'ND', 'NA', '?'], klass: 'other' },
]);

export const LITHOLOGY_CODES = Object.freeze(LITHOLOGIES.map((l) => l.code));

/** Wentworth grain size classes, finest first, with the size range in mm. */
export const GRAIN_SIZES = Object.freeze([
  { code: 'clay', name: 'Clay', maxMm: 0.0039, aliases: ['CLY', 'C'] },
  { code: 'silt', name: 'Silt', maxMm: 0.0625, aliases: ['SLT', 'SI', 'Z'] },
  { code: 'vf_sand', name: 'Very fine sand', maxMm: 0.125, aliases: ['VF', 'VFS', 'VFG'] },
  { code: 'f_sand', name: 'Fine sand', maxMm: 0.25, aliases: ['F', 'FS', 'FG', 'FN'] },
  { code: 'm_sand', name: 'Medium sand', maxMm: 0.5, aliases: ['M', 'MS', 'MG', 'MED'] },
  { code: 'c_sand', name: 'Coarse sand', maxMm: 1, aliases: ['C', 'CS', 'CG', 'CRS'] },
  { code: 'vc_sand', name: 'Very coarse sand', maxMm: 2, aliases: ['VC', 'VCS', 'VCG'] },
  { code: 'granule', name: 'Granule', maxMm: 4, aliases: ['GRAN', 'GR'] },
  { code: 'pebble', name: 'Pebble', maxMm: 64, aliases: ['PEB', 'PBL'] },
  { code: 'cobble', name: 'Cobble', maxMm: 256, aliases: ['COB'] },
  { code: 'boulder', name: 'Boulder', maxMm: Infinity, aliases: ['BLD'] },
]);

export const GRAIN_SIZE_CODES = Object.freeze(GRAIN_SIZES.map((g) => g.code));

/** Depositional environments, proximal to distal, with a family for colouring maps. */
export const ENVIRONMENTS = Object.freeze([
  { code: 'alluvial_fan', name: 'Alluvial fan', family: 'continental', colour: '#b45309' },
  { code: 'fluvial', name: 'Fluvial', family: 'continental', colour: '#d97706' },
  { code: 'eolian', name: 'Eolian', family: 'continental', colour: '#fbbf24' },
  { code: 'lacustrine', name: 'Lacustrine', family: 'continental', colour: '#7dd3fc' },
  { code: 'coastal_plain', name: 'Coastal plain', family: 'transitional', colour: '#a3e635' },
  { code: 'deltaic', name: 'Deltaic', family: 'transitional', colour: '#65a30d' },
  { code: 'estuarine', name: 'Estuarine', family: 'transitional', colour: '#4d7c0f' },
  { code: 'tidal_flat', name: 'Tidal flat', family: 'transitional', colour: '#84cc16' },
  { code: 'shoreface', name: 'Shoreface', family: 'shallow_marine', colour: '#facc15' },
  { code: 'shelf', name: 'Shelf', family: 'shallow_marine', colour: '#38bdf8' },
  { code: 'carbonate_platform', name: 'Carbonate platform', family: 'shallow_marine', colour: '#60a5fa' },
  { code: 'reef', name: 'Reef', family: 'shallow_marine', colour: '#818cf8' },
  { code: 'lagoon', name: 'Lagoon', family: 'shallow_marine', colour: '#67e8f9' },
  { code: 'sabkha', name: 'Sabkha (evaporitic)', family: 'shallow_marine', colour: '#e9d5ff' },
  { code: 'slope', name: 'Slope', family: 'deep_marine', colour: '#2563eb' },
  { code: 'submarine_fan', name: 'Submarine fan (turbidite)', family: 'deep_marine', colour: '#1d4ed8' },
  { code: 'basin_floor', name: 'Basin floor', family: 'deep_marine', colour: '#1e3a8a' },
  { code: 'glacial', name: 'Glacial', family: 'continental', colour: '#e0f2fe' },
  { code: 'volcanic', name: 'Volcanic', family: 'other', colour: '#b91c1c' },
  { code: 'unknown', name: 'Unknown', family: 'other', colour: '#cbd5e1' },
]);

export const ENVIRONMENT_CODES = Object.freeze(ENVIRONMENTS.map((e) => e.code));

const norm = (s) => String(s ?? '').trim().toUpperCase().replace(/[\s_\-.]+/g, '');

function indexOf(list) {
  const map = new Map();
  for (const item of list) {
    map.set(norm(item.code), item);
    map.set(norm(item.name), item);
    for (const a of item.aliases || []) if (!map.has(norm(a))) map.set(norm(a), item);
  }
  return map;
}

const lithIndex = indexOf(LITHOLOGIES);
const grainIndex = indexOf(GRAIN_SIZES);
const envIndex = indexOf(ENVIRONMENTS);
const kindIndex = new Map(INTERVAL_KINDS.map((k) => [k.code, k]));

export const lithology = (code) => LITHOLOGIES.find((l) => l.code === code) || null;
export const grainSize = (code) => GRAIN_SIZES.find((g) => g.code === code) || null;
export const environment = (code) => ENVIRONMENTS.find((e) => e.code === code) || null;
export const intervalKind = (code) => kindIndex.get(code) || null;
export const isIntervalKind = (code) => kindIndex.has(code);

/** Resolve a lithology from a code, name or mud-log abbreviation; null when unknown. */
export function resolveLithology(text) {
  const k = norm(text);
  if (!k) return null;
  if (lithIndex.has(k)) return lithIndex.get(k);
  // "SST W/ SH STRINGERS": the first alias-matching token wins
  for (const tok of String(text).toUpperCase().split(/[^A-Z]+/)) if (tok && lithIndex.has(tok)) return lithIndex.get(tok);
  return null;
}

export function resolveGrainSize(text) {
  const k = norm(text);
  return k && grainIndex.has(k) ? grainIndex.get(k) : null;
}

export function resolveEnvironment(text) {
  const k = norm(text);
  return k && envIndex.has(k) ? envIndex.get(k) : null;
}

/** The colour an interval draws with: its own properties.colour, else the
 *  lithology / environment colour of its code, else a neutral grey. */
export function intervalColour(row) {
  if (row?.properties?.colour) return row.properties.colour;
  const kind = row?.kind;
  if (kind === 'lithology' || kind === 'core_description') return resolveLithology(row.code)?.colour || '#cbd5e1';
  if (kind === 'environment') return resolveEnvironment(row.code)?.colour || '#cbd5e1';
  return '#cbd5e1';
}

/** Legend rows for a kind: distinct codes in the order they first appear. */
export function intervalLegend(rows) {
  const seen = new Map();
  for (const r of rows || []) {
    const key = String(r.code ?? r.label ?? '');
    if (!seen.has(key)) seen.set(key, { code: key, label: r.label || resolveLithology(key)?.name || key, colour: intervalColour(r) });
  }
  return Array.from(seen.values());
}
