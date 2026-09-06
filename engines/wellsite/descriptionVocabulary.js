// Wellsite Studio WS1: the canonical cuttings-description vocabulary
// (spec sections 17 and 18). Lithology and grain size come from the
// stratigraphy tables (sanctioned edge wellsite -> stratigraphy, one
// lithology table in the Suite). Everything else a wellsite geologist
// records about a cuttings component is a controlled term here, with a
// code (stored), a name (narrative), a default abbreviation and aliases
// (typed). Operator house styles are display profiles over these codes
// (abbreviations.js); the stored meaning never changes with the profile.
//
// The ATTRIBUTES list is the single order the keyboard screen, the
// abbreviator, the narrative and the validator all follow.

import { LITHOLOGIES, GRAIN_SIZES, resolveLithology, resolveGrainSize } from '../stratigraphy/lithology.js';

export { LITHOLOGIES, GRAIN_SIZES, resolveLithology, resolveGrainSize };

const T = (code, name, abbrev, aliases = [], extra = {}) => Object.freeze({ code, name, abbrev, aliases: Object.freeze(aliases), ...extra });

export const COLOUR_HUES = Object.freeze([
  T('grey', 'grey', 'gy', ['gray', 'gry', 'grey']),
  T('brown', 'brown', 'brn', ['bn', 'brwn']),
  T('red_brown', 'reddish brown', 'rd brn', ['rdbrn', 'red brown', 'reddish brown']),
  T('red', 'red', 'rd', ['red']),
  T('tan', 'tan', 'tn', ['tan']),
  T('buff', 'buff', 'bf', ['buff']),
  T('white', 'white', 'wh', ['wht', 'white']),
  T('black', 'black', 'blk', ['bk', 'black']),
  T('green', 'green', 'grn', ['gn', 'green']),
  T('olive', 'olive', 'olv', ['olive']),
  T('yellow', 'yellow', 'yel', ['yl', 'yellow']),
  T('orange', 'orange', 'orng', ['or', 'orange']),
  T('pink', 'pink', 'pk', ['pink']),
  T('purple', 'purple', 'purp', ['pur', 'purple']),
  T('blue_grey', 'bluish grey', 'bl gy', ['blgy', 'blue grey', 'bluish grey', 'blue gray']),
  T('cream', 'cream', 'crm', ['cream']),
  T('translucent', 'translucent', 'trnsl', ['transl', 'translucent', 'clear']),
  T('colourless', 'colourless', 'clr', ['colorless', 'colourless']),
]);
export const COLOUR_MODIFIERS = Object.freeze([
  T('light', 'light', 'lt', ['lt', 'light', 'pale']),
  T('dark', 'dark', 'dk', ['dk', 'dark']),
  T('medium', 'medium', 'med', ['med', 'medium']),
  T('mottled', 'mottled', 'mot', ['mot', 'mottled']),
  T('variegated', 'variegated', 'vgt', ['vgt', 'variegated', 'varicoloured']),
  T('speckled', 'speckled', 'spk', ['spk', 'speckled', 'spkld']),
]);
export const HARDNESS = Object.freeze([
  T('very_soft', 'very soft', 'v sft', ['vsft', 'very soft', 'vs']),
  T('soft', 'soft', 'sft', ['sft', 'soft', 's']),
  T('firm', 'firm', 'frm', ['frm', 'firm', 'f']),
  T('moderately_hard', 'moderately hard', 'mod hd', ['modhd', 'mod hard', 'moderately hard', 'mh']),
  T('hard', 'hard', 'hd', ['hd', 'hard', 'h']),
  T('very_hard', 'very hard', 'v hd', ['vhd', 'very hard', 'vh']),
  T('brittle', 'brittle', 'brit', ['brit', 'brittle', 'brtl']),
  T('friable', 'friable', 'fri', ['fri', 'friable', 'frbl']),
]);
export const TEXTURE = Object.freeze([
  T('massive', 'massive', 'mass', ['mass', 'massive', 'msv']),
  T('laminated', 'laminated', 'lam', ['lam', 'laminated', 'lmn']),
  T('fissile', 'fissile', 'fis', ['fis', 'fissile', 'fsl']),
  T('blocky', 'blocky', 'blky', ['blky', 'blocky', 'blk']),
  T('platy', 'platy', 'plty', ['plty', 'platy']),
  T('splintery', 'splintery', 'splty', ['splty', 'splintery', 'spl']),
  T('earthy', 'earthy', 'erthy', ['erthy', 'earthy']),
  T('waxy', 'waxy', 'wxy', ['wxy', 'waxy']),
  T('sucrosic', 'sucrosic', 'suc', ['suc', 'sucrosic', 'sucr']),
  T('chalky', 'chalky', 'chky', ['chky', 'chalky']),
  T('crystalline', 'crystalline', 'xln', ['xln', 'crystalline', 'xtl', 'xtln']),
  T('oolitic', 'oolitic', 'ool', ['ool', 'oolitic']),
  T('bioclastic', 'bioclastic', 'biocl', ['biocl', 'bioclastic']),
  T('vuggy', 'vuggy', 'vug', ['vug', 'vuggy', 'vgy']),
  T('silty', 'silty', 'slty', ['slty', 'silty']),
  T('sandy', 'sandy', 'sdy', ['sdy', 'sandy']),
  T('argillaceous', 'argillaceous', 'arg', ['arg', 'argillaceous', 'argil']),
  T('calcareous', 'calcareous', 'calc', ['calc', 'calcareous']),
  T('carbonaceous', 'carbonaceous', 'carb', ['carb', 'carbonaceous']),
  T('micaceous', 'micaceous', 'mic', ['mic', 'micaceous']),
  T('pyritic', 'pyritic', 'pyr', ['pyr', 'pyritic']),
  T('glauconitic', 'glauconitic', 'glauc', ['glauc', 'glauconitic', 'glc']),
]);
export const SORTING = Object.freeze([
  T('very_poor', 'very poorly sorted', 'v p srt', ['vpsrt', 'very poor', 'very poorly sorted', 'vps']),
  T('poor', 'poorly sorted', 'p srt', ['psrt', 'poor', 'poorly sorted', 'ps']),
  T('moderate', 'moderately sorted', 'mod srt', ['modsrt', 'mod', 'moderate', 'moderately sorted', 'ms', 'msrt']),
  T('well', 'well sorted', 'w srt', ['wsrt', 'well', 'well sorted', 'ws']),
  T('very_well', 'very well sorted', 'v w srt', ['vwsrt', 'very well', 'very well sorted', 'vws']),
]);
export const ROUNDING = Object.freeze([
  T('angular', 'angular', 'ang', ['ang', 'angular', 'a']),
  T('subangular', 'subangular', 'sbang', ['sbang', 'subang', 'subangular', 'sa']),
  T('subrounded', 'subrounded', 'sbrnd', ['sbrnd', 'subrnd', 'subrounded', 'sr']),
  T('rounded', 'rounded', 'rnd', ['rnd', 'rounded', 'r']),
  T('well_rounded', 'well rounded', 'w rnd', ['wrnd', 'well rounded', 'wr']),
]);
export const CEMENT = Object.freeze([
  T('calcareous', 'calcareous', 'calc', ['calc', 'calcareous', 'calcite']),
  T('dolomitic', 'dolomitic', 'dol', ['dol', 'dolomitic']),
  T('siliceous', 'siliceous', 'sil', ['sil', 'siliceous', 'silica', 'qtz']),
  T('argillaceous', 'argillaceous', 'arg', ['arg', 'argillaceous', 'clay']),
  T('ferruginous', 'ferruginous', 'ferr', ['ferr', 'ferruginous', 'fe']),
  T('anhydritic', 'anhydritic', 'anhy', ['anhy', 'anhydritic']),
  T('pyritic', 'pyritic', 'pyr', ['pyr', 'pyritic']),
  T('kaolinitic', 'kaolinitic', 'kao', ['kao', 'kaolinitic', 'kaolin']),
  T('none', 'no visible cement', 'no cmt', ['none', 'no cement', 'uncemented', 'uncmt']),
]);
export const ACCESSORIES = Object.freeze([
  T('pyrite', 'pyrite', 'pyr', ['pyr', 'pyrite', 'py']),
  T('glauconite', 'glauconite', 'glauc', ['glauc', 'glauconite', 'glc']),
  T('mica', 'mica', 'mic', ['mic', 'mica', 'musc', 'biot']),
  T('carbonaceous', 'carbonaceous material', 'carb', ['carb', 'carbonaceous', 'carb mat']),
  T('lignite', 'lignite', 'lig', ['lig', 'lignite']),
  T('chert', 'chert', 'cht', ['cht', 'chert']),
  T('feldspar', 'feldspar', 'fspr', ['fspr', 'feldspar', 'fsp']),
  T('shell_fragments', 'shell fragments', 'shl frag', ['shlfrag', 'shell', 'shell fragments', 'shells']),
  T('siderite', 'siderite', 'sid', ['sid', 'siderite']),
  T('anhydrite_nodules', 'anhydrite nodules', 'anhy nod', ['anhynod', 'anhydrite nodules']),
  T('quartz_grains', 'quartz grains', 'qtz', ['qtz', 'quartz', 'quartz grains']),
  T('lithics', 'lithic fragments', 'lith', ['lith', 'lithics', 'lithic', 'rock fragments']),
  T('heavy_minerals', 'heavy minerals', 'hvy min', ['hvymin', 'heavy minerals', 'heavies']),
  T('pyrobitumen', 'pyrobitumen', 'pybit', ['pybit', 'pyrobitumen', 'bitumen', 'bit']),
]);
export const FOSSILS = Object.freeze([
  T('forams', 'foraminifera', 'foram', ['foram', 'forams', 'foraminifera']),
  T('shell_fragments', 'shell fragments', 'shl frag', ['shlfrag', 'shell fragments', 'shells']),
  T('bryozoa', 'bryozoa', 'bry', ['bry', 'bryozoa', 'bryozoans']),
  T('algae', 'algae', 'alg', ['alg', 'algae', 'algal']),
  T('echinoids', 'echinoids', 'ech', ['ech', 'echinoids', 'echinoderms']),
  T('plant_remains', 'plant remains', 'plt rem', ['pltrem', 'plant', 'plant remains', 'plant material']),
  T('ostracods', 'ostracods', 'ostr', ['ostr', 'ostracods']),
  T('corals', 'corals', 'corl', ['corl', 'coral', 'corals']),
  T('none', 'no fossils', 'no foss', ['none', 'no fossils', 'unfossiliferous']),
]);
export const POROSITY = Object.freeze([
  T('none', 'no visible porosity', 'no vis por', ['none', 'no visible porosity', 'tight', 'tt', 'nvp']),
  T('poor', 'poor visible porosity', 'p vis por', ['poor', 'p', 'pvp']),
  T('fair', 'fair visible porosity', 'fr vis por', ['fair', 'fr', 'fvp']),
  T('good', 'good visible porosity', 'gd vis por', ['good', 'gd', 'gvp']),
  T('very_good', 'very good visible porosity', 'v gd vis por', ['very good', 'vgd', 'vg', 'vgvp']),
]);
export const POROSITY_TYPES = Object.freeze([
  T('intergranular', 'intergranular', 'intgran', ['intgran', 'intergranular', 'ig']),
  T('intercrystalline', 'intercrystalline', 'intxln', ['intxln', 'intercrystalline', 'ix']),
  T('vuggy', 'vuggy', 'vug', ['vug', 'vuggy']),
  T('fracture', 'fracture', 'frac', ['frac', 'fracture', 'fractured']),
  T('moldic', 'moldic', 'mold', ['mold', 'moldic', 'mouldic']),
  T('pinpoint', 'pinpoint', 'pp', ['pp', 'pinpoint']),
]);
export const AMOUNTS = Object.freeze([
  T('trace', 'trace', 'tr', ['tr', 'trace']),
  T('rare', 'rare', 'rr', ['rr', 'rare']),
  T('common', 'common', 'com', ['com', 'common', 'cmn']),
  T('abundant', 'abundant', 'abd', ['abd', 'abundant', 'abt']),
]);

export const TABLES = Object.freeze({
  lithology: LITHOLOGIES, grainSize: GRAIN_SIZES, colourHue: COLOUR_HUES, colourModifier: COLOUR_MODIFIERS,
  hardness: HARDNESS, texture: TEXTURE, sorting: SORTING, rounding: ROUNDING, cement: CEMENT,
  accessories: ACCESSORIES, fossils: FOSSILS, porosity: POROSITY, porosityTypes: POROSITY_TYPES, amount: AMOUNTS,
});

/**
 * The attribute order every screen and every renderer follows. `multi`
 * attributes hold a list; `quick` ones show in quick mode; `range` ones
 * hold {from, to}; `amount` ones carry an amount per entry.
 */
export const ATTRIBUTES = Object.freeze([
  { key: 'lithology', label: 'Lithology', table: 'lithology', quick: true },
  { key: 'percent', label: 'Percent', quick: true, numeric: true },
  { key: 'colour', label: 'Colour', table: 'colourHue', quick: true, colour: true },
  { key: 'hardness', label: 'Hardness', table: 'hardness' },
  { key: 'grainSize', label: 'Grain size', table: 'grainSize', quick: true, range: true },
  { key: 'sorting', label: 'Sorting', table: 'sorting' },
  { key: 'rounding', label: 'Rounding', table: 'rounding' },
  { key: 'texture', label: 'Texture', table: 'texture', multi: true },
  { key: 'cement', label: 'Cement', table: 'cement', multi: true },
  { key: 'accessories', label: 'Accessories', table: 'accessories', multi: true, amount: true },
  { key: 'fossils', label: 'Fossils', table: 'fossils', multi: true, amount: true },
  { key: 'porosity', label: 'Porosity', table: 'porosity', quick: true },
  { key: 'porosityTypes', label: 'Porosity type', table: 'porosityTypes', multi: true },
]);
export const ATTRIBUTE_KEYS = Object.freeze(ATTRIBUTES.map((a) => a.key));
export const QUICK_KEYS = Object.freeze(ATTRIBUTES.filter((a) => a.quick).map((a) => a.key));

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_\-.]+/g, '');
const indexes = new Map();
function indexFor(table) {
  if (indexes.has(table)) return indexes.get(table);
  const list = TABLES[table];
  const map = new Map();
  for (const t of list || []) {
    map.set(norm(t.code), t);
    if (t.abbrev) map.set(norm(t.abbrev), t);
    if (t.name) map.set(norm(t.name), t);
    for (const a of t.aliases || []) map.set(norm(a), t);
  }
  indexes.set(table, map);
  return map;
}

/** Resolve typed text against a table: exact code, abbreviation, name or alias, then a unique prefix. */
export function resolveTerm(table, text) {
  if (table === 'lithology') return resolveLithology(text);
  if (table === 'grainSize') return resolveGrainSize(text) || prefixOf(GRAIN_SIZES, text);
  const k = norm(text);
  if (!k) return null;
  const idx = indexFor(table);
  if (idx.has(k)) return idx.get(k);
  return prefixOf(TABLES[table], text);
}

function prefixOf(list, text) {
  const k = norm(text);
  if (!k || k.length < 2) return null;
  const hits = new Set();
  for (const t of list || []) {
    const keys = [t.code, t.abbrev, t.name, ...(t.aliases || [])].filter(Boolean).map(norm);
    if (keys.some((x) => x.startsWith(k))) hits.add(t);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/** "lt gy", "dark grey", "gy" to {hue, modifier}. */
export function resolveColour(text) {
  const words = String(text ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let modifier = null;
  let hueWords = words;
  const m = resolveTerm('colourModifier', words[0]);
  if (m && words.length > 1) { modifier = m.code; hueWords = words.slice(1); }
  const hue = resolveTerm('colourHue', hueWords.join(' '));
  if (!hue) {
    const whole = resolveTerm('colourHue', words.join(' '));
    return whole ? { hue: whole.code, modifier: null } : null;
  }
  return { hue: hue.code, modifier };
}

/** Options for a table as {code, name, abbrev} (the screens' pickers). */
export function optionsFor(table) {
  return (TABLES[table] || []).map((t) => ({ code: t.code, name: t.name, abbrev: t.abbrev || t.code }));
}

export function emptyComponent() {
  return {
    lithology: null, percent: null, colour: null, hardness: null, grainSize: null, sorting: null, rounding: null,
    texture: [], cement: [], accessories: [], fossils: [], porosity: null, porosityTypes: [], extras: {},
  };
}

function codeOf(v) { return typeof v === 'string' ? v : v && v.code; }
function has(table, code) { return !!code && (TABLES[table] || []).some((t) => t.code === code); }

/**
 * Validate a description. Errors block saving; warnings do not.
 * @param {Object} d { components:[...], comment? }
 * @param {Object} [o] { tolerance = 5 } percent sum tolerance
 */
export function validateDescription(d, { tolerance = 5 } = {}) {
  const errors = [];
  const warnings = [];
  const comps = (d && Array.isArray(d.components)) ? d.components : [];
  if (!comps.length) errors.push('A description needs at least one component.');
  let sum = 0;
  comps.forEach((c, i) => {
    const n = i + 1;
    if (!has('lithology', c.lithology)) errors.push(`Component ${n} needs a lithology from the vocabulary.`);
    if (!(Number.isFinite(c.percent) && c.percent > 0 && c.percent <= 100)) errors.push(`Component ${n} needs a percent between 0 and 100.`);
    else sum += c.percent;
    if (c.colour && !has('colourHue', c.colour.hue)) errors.push(`Component ${n} colour hue is not in the vocabulary.`);
    if (c.colour && c.colour.modifier && !has('colourModifier', c.colour.modifier)) errors.push(`Component ${n} colour modifier is not in the vocabulary.`);
    if (c.hardness && !has('hardness', c.hardness)) errors.push(`Component ${n} hardness is not in the vocabulary.`);
    if (c.grainSize && (!has('grainSize', c.grainSize.from) || (c.grainSize.to && !has('grainSize', c.grainSize.to)))) errors.push(`Component ${n} grain size is not in the vocabulary.`);
    if (c.sorting && !has('sorting', c.sorting)) errors.push(`Component ${n} sorting is not in the vocabulary.`);
    if (c.rounding && (typeof c.rounding === 'object' ? (!has('rounding', c.rounding.from) || !has('rounding', c.rounding.to)) : !has('rounding', c.rounding))) errors.push(`Component ${n} rounding is not in the vocabulary.`);
    if (c.porosity && !has('porosity', c.porosity)) errors.push(`Component ${n} porosity is not in the vocabulary.`);
    for (const [key, table] of [['texture', 'texture'], ['cement', 'cement'], ['accessories', 'accessories'], ['fossils', 'fossils'], ['porosityTypes', 'porosityTypes']]) {
      for (const v of c[key] || []) {
        if (!has(table, codeOf(v))) errors.push(`Component ${n} ${key} entry ${codeOf(v) ?? ''} is not in the vocabulary.`);
        if (v && typeof v === 'object' && v.amount && !has('amount', v.amount)) errors.push(`Component ${n} ${key} amount ${v.amount} is not in the vocabulary.`);
      }
    }
  });
  if (comps.length && Math.abs(sum - 100) > tolerance) errors.push(`Component percentages sum to ${sum}, expected 100 within ${tolerance}.`);
  else if (comps.length && sum !== 100) warnings.push(`Component percentages sum to ${sum}.`);
  return { ok: errors.length === 0, errors, warnings, percentSum: sum };
}

/** Copy the previous description onto a new interval (describe by exception). */
export function copyPrevious(prev, { sampleId = null, mdTopM = null, mdBaseM = null } = {}) {
  const components = (prev.components || []).map((c) => JSON.parse(JSON.stringify(c)));
  return { sampleId, mdTopM, mdBaseM, mode: prev.mode || 'quick', components, comment: '', copiedFrom: prev.id || null, changedFields: [] };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Field-level differences between two descriptions, by component index. */
export function diffDescriptions(a, b) {
  const out = [];
  const n = Math.max((a.components || []).length, (b.components || []).length);
  for (let i = 0; i < n; i += 1) {
    const ca = (a.components || [])[i];
    const cb = (b.components || [])[i];
    if (!ca) { out.push({ componentIndex: i, field: '*', from: null, to: 'added' }); continue; }
    if (!cb) { out.push({ componentIndex: i, field: '*', from: 'removed', to: null }); continue; }
    for (const key of ATTRIBUTE_KEYS) if (!same(ca[key], cb[key])) out.push({ componentIndex: i, field: key, from: ca[key] ?? null, to: cb[key] ?? null });
  }
  return out;
}

export function dominantLithology(d) {
  let best = null;
  for (const c of d.components || []) if (!best || (c.percent || 0) > (best.percent || 0)) best = c;
  return best ? best.lithology : null;
}

/** The registry publish shape for geo_wells_intervals (kind lithology, source cuttings). */
export function toIntervalRow(d, { abbrev = null } = {}) {
  const dom = dominantLithology(d);
  const lith = dom ? resolveLithology(dom) : null;
  const first = (d.components || [])[0] || {};
  return {
    kind: 'lithology',
    top_md_m: d.mdTopM,
    base_md_m: d.mdBaseM,
    code: dom,
    label: lith ? lith.name : null,
    source: 'cuttings',
    properties: {
      components: (d.components || []).map((c) => ({ lithology: c.lithology, percent: c.percent })),
      description_id: d.id || null,
      abbrev,
      colour: lith ? lith.colour : null,
      grain_size: first.grainSize ? first.grainSize.from : null,
      ws_pipeline: 'ws-1.0.0',
    },
  };
}
