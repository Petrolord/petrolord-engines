// Geologic time scale (Stratigraphy Studio ST0, 2026-09-06; chart versions
// AppUpgrade STRAT-U2-003, 2026-09-30).
//
// The International Chronostratigraphic Chart of the International
// Commission on Stratigraphy (chart at stratigraphy.org, licensed CC BY 4.0).
// Two versions are held:
//
// - ICS 2026/06, the current chart and the default of every lookup (Cohen,
//   Harper, Gibbard and Car 2025, updated; Episodes 48: 105-115). Against
//   2023/09 it moves 7 Cenozoic bases (Chattian 27.82 to 27.30, Bartonian
//   41.2 to 41.03 ...), 9 Cretaceous ones (Berriasian, the J/K boundary,
//   145.0 to 143.1; Valanginian 139.8 to 137.05; Santonian 86.3 to 85.7),
//   most Triassic to Cambrian bases (2024/12), and in 2026/06 itself the
//   Wuchiapingian (259.51 to 259.857), Anisian (to 247.0) and Olenekian (to
//   250.8).
// - ICS 2023/09 AS SHIPPED in ST0, kept so an age typed under it can be
//   recognised and its update offered. Three values of that table differ
//   from the printed 2023/09 chart (TIMESCALE_ERRATA): the Barremian base
//   129.4 (chart 125.77), the Ladinian base 241.0 (chart ~242) and the
//   Hadean base 4567.3 (chart 4567). They are kept as shipped, because ages
//   filled from the table carry those numbers.
//
// Ages are the base of each unit in Ma. Units the chart marks with "~" carry
// `approx: true`. Pure data plus lookups. The tree below is transcribed
// base-first: each node is [name, children] or [name, baseMa, opts]; a
// parent's base is its oldest child's base, a unit's top is the base of the
// next-younger sibling (or its parent's top; the present is 0). The 2026/06
// tree is the 2023/09 tree (same names and hierarchy on both charts) with
// every leaf base and "~" flag replaced from the 2026/06 chart; the gate test
// reads the chart's own printed numbers (test-data/stratigraphy).

export const TIMESCALE_V2023 = 'ICS 2023/09';
export const TIMESCALE_V2026 = 'ICS 2026/06';
/** The current chart: the default of every lookup and the stamp on new ages. */
export const TIMESCALE_VERSION = TIMESCALE_V2026;
/** Every chart version this engine can read, oldest first. */
export const TIMESCALE_VERSIONS = Object.freeze([TIMESCALE_V2023, TIMESCALE_V2026]);
export const TIMESCALE_LICENCE = 'International Chronostratigraphic Chart, ICS, CC BY 4.0';
export const TIMESCALE_CITATION = Object.freeze({
  [TIMESCALE_V2023]: 'Cohen, K.M., Finney, S.C., Gibbard, P.L. & Fan, J.-X. (2013; updated) The ICS International Chronostratigraphic Chart. Episodes 36: 199-204. v2023/09.',
  [TIMESCALE_V2026]: 'Cohen, K.M., Harper, D.A.T., Gibbard, P.L. & Car, N. (2025, updated) The ICS international chronostratigraphic chart this decade. Episodes 48: 105-115. v2026/06.',
});
/** Where the 2023/09 table as shipped differs from the printed 2023/09 chart (kept, see above). */
export const TIMESCALE_ERRATA = Object.freeze([
  Object.freeze({ version: TIMESCALE_V2023, name: 'Barremian', table_ma: 129.4, chart_ma: 125.77 }),
  Object.freeze({ version: TIMESCALE_V2023, name: 'Ladinian', table_ma: 241.0, chart_ma: 242 }),
  Object.freeze({ version: TIMESCALE_V2023, name: 'Hadean', table_ma: 4567.3, chart_ma: 4567 }),
]);
export const RANKS = Object.freeze(['eon', 'era', 'period', 'epoch', 'age']);

const A = { approx: true };

// [name, children | baseMa, opts?]: ICS 2023/09 as shipped in ST0
const CHART = [
  ['Phanerozoic', [
    ['Cenozoic', [
      ['Quaternary', [
        ['Holocene', [['Meghalayan', 0.0042], ['Northgrippian', 0.0082], ['Greenlandian', 0.0117]]],
        ['Pleistocene', [['Upper Pleistocene', 0.129], ['Chibanian', 0.774], ['Calabrian', 1.80], ['Gelasian', 2.58]]],
      ]],
      ['Neogene', [
        ['Pliocene', [['Piacenzian', 3.600], ['Zanclean', 5.333]]],
        ['Miocene', [['Messinian', 7.246], ['Tortonian', 11.63], ['Serravallian', 13.82], ['Langhian', 15.98], ['Burdigalian', 20.44], ['Aquitanian', 23.03]]],
      ]],
      ['Paleogene', [
        ['Oligocene', [['Chattian', 27.82], ['Rupelian', 33.9]]],
        ['Eocene', [['Priabonian', 37.71], ['Bartonian', 41.2], ['Lutetian', 47.8], ['Ypresian', 56.0]]],
        ['Paleocene', [['Thanetian', 59.2], ['Selandian', 61.6], ['Danian', 66.0]]],
      ]],
    ]],
    ['Mesozoic', [
      ['Cretaceous', [
        ['Upper Cretaceous', [['Maastrichtian', 72.1], ['Campanian', 83.6], ['Santonian', 86.3], ['Coniacian', 89.8], ['Turonian', 93.9], ['Cenomanian', 100.5]]],
        ['Lower Cretaceous', [['Albian', 113.0, A], ['Aptian', 121.4, A], ['Barremian', 129.4, A], ['Hauterivian', 132.6, A], ['Valanginian', 139.8, A], ['Berriasian', 145.0, A]]],
      ]],
      ['Jurassic', [
        ['Upper Jurassic', [['Tithonian', 149.2, A], ['Kimmeridgian', 154.8, A], ['Oxfordian', 161.5, A]]],
        ['Middle Jurassic', [['Callovian', 165.3, A], ['Bathonian', 168.2, A], ['Bajocian', 170.9, A], ['Aalenian', 174.7, A]]],
        ['Lower Jurassic', [['Toarcian', 184.2, A], ['Pliensbachian', 192.9, A], ['Sinemurian', 199.5, A], ['Hettangian', 201.4, A]]],
      ]],
      ['Triassic', [
        ['Upper Triassic', [['Rhaetian', 208.5, A], ['Norian', 227.0, A], ['Carnian', 237.0, A]]],
        ['Middle Triassic', [['Ladinian', 241.0, A], ['Anisian', 247.2, A]]],
        ['Lower Triassic', [['Olenekian', 251.2, A], ['Induan', 251.902]]],
      ]],
    ]],
    ['Paleozoic', [
      ['Permian', [
        ['Lopingian', [['Changhsingian', 254.14], ['Wuchiapingian', 259.51]]],
        ['Guadalupian', [['Capitanian', 264.28], ['Wordian', 266.9], ['Roadian', 273.01]]],
        ['Cisuralian', [['Kungurian', 283.5, A], ['Artinskian', 290.1, A], ['Sakmarian', 293.52], ['Asselian', 298.9]]],
      ]],
      ['Carboniferous', [
        ['Pennsylvanian', [['Gzhelian', 303.7, A], ['Kasimovian', 307.0, A], ['Moscovian', 315.2, A], ['Bashkirian', 323.2]]],
        ['Mississippian', [['Serpukhovian', 330.9, A], ['Visean', 346.7], ['Tournaisian', 358.9]]],
      ]],
      ['Devonian', [
        ['Upper Devonian', [['Famennian', 372.2], ['Frasnian', 382.7]]],
        ['Middle Devonian', [['Givetian', 387.7], ['Eifelian', 393.3]]],
        ['Lower Devonian', [['Emsian', 407.6], ['Pragian', 410.8], ['Lochkovian', 419.2]]],
      ]],
      ['Silurian', [
        ['Pridoli', [['Pridoli age', 423.0]]],
        ['Ludlow', [['Ludfordian', 425.6], ['Gorstian', 427.4]]],
        ['Wenlock', [['Homerian', 430.5], ['Sheinwoodian', 433.4]]],
        ['Llandovery', [['Telychian', 438.5], ['Aeronian', 440.8], ['Rhuddanian', 443.8]]],
      ]],
      ['Ordovician', [
        ['Upper Ordovician', [['Hirnantian', 445.2], ['Katian', 453.0], ['Sandbian', 458.4]]],
        ['Middle Ordovician', [['Darriwilian', 467.3], ['Dapingian', 470.0]]],
        ['Lower Ordovician', [['Floian', 477.7], ['Tremadocian', 485.4]]],
      ]],
      ['Cambrian', [
        ['Furongian', [['Stage 10', 489.5, A], ['Jiangshanian', 494.0, A], ['Paibian', 497.0, A]]],
        ['Miaolingian', [['Guzhangian', 500.5, A], ['Drumian', 504.5, A], ['Wuliuan', 509.0, A]]],
        ['Cambrian Series 2', [['Cambrian Stage 4', 514.0, A], ['Cambrian Stage 3', 521.0, A]]],
        ['Terreneuvian', [['Cambrian Stage 2', 529.0, A], ['Fortunian', 538.8]]],
      ]],
    ]],
  ]],
  ['Proterozoic', [
    ['Neoproterozoic', [['Ediacaran', 635.0, A], ['Cryogenian', 720.0], ['Tonian', 1000.0]]],
    ['Mesoproterozoic', [['Stenian', 1200.0], ['Ectasian', 1400.0], ['Calymmian', 1600.0]]],
    ['Paleoproterozoic', [['Statherian', 1800.0], ['Orosirian', 2050.0], ['Rhyacian', 2300.0], ['Siderian', 2500.0]]],
  ]],
  ['Archean', [
    ['Neoarchean', 2800.0], ['Mesoarchean', 3200.0], ['Paleoarchean', 3600.0], ['Eoarchean', 4031.0],
  ]],
  ['Hadean', 4567.3],
];

// ICS 2026/06: every leaf base as printed on the chart, "~" as approx.
// Names are the 2023/09 tree's (the charts share them).
const BASES_2026 = {
  Meghalayan: 0.0042, Northgrippian: 0.0082, Greenlandian: 0.0117,
  'Upper Pleistocene': 0.129, Chibanian: 0.774, Calabrian: 1.80, Gelasian: 2.58,
  Piacenzian: 3.600, Zanclean: 5.333,
  Messinian: 7.246, Tortonian: 11.63, Serravallian: 13.82, Langhian: 15.98, Burdigalian: 20.45, Aquitanian: 23.04,
  Chattian: 27.30, Rupelian: 33.9,
  Priabonian: 37.71, Bartonian: 41.03, Lutetian: 48.07, Ypresian: 56.00,
  Thanetian: 59.24, Selandian: 61.66, Danian: 66.00,
  Maastrichtian: 72.2, Campanian: 83.6, Santonian: 85.7, Coniacian: 89.8, Turonian: 93.9, Cenomanian: 100.5,
  Albian: 113.2, Aptian: 121.4, Barremian: 125.77, Hauterivian: 132.6, Valanginian: 137.05, Berriasian: 143.1,
  Tithonian: 149.2, Kimmeridgian: 154.8, Oxfordian: 161.5,
  Callovian: 165.3, Bathonian: 168.2, Bajocian: 170.9, Aalenian: 174.7,
  Toarcian: 184.2, Pliensbachian: 192.9, Sinemurian: 199.5, Hettangian: 201.4,
  Rhaetian: [205.7, A], Norian: [227.3, A], Carnian: [237, A],
  Ladinian: 241.464, Anisian: 247.0, Olenekian: 250.8, Induan: 251.902,
  Changhsingian: 254.14, Wuchiapingian: 259.857,
  Capitanian: 264.28, Wordian: 266.9, Roadian: 274.4,
  Kungurian: 283.3, Artinskian: 290.1, Sakmarian: 293.52, Asselian: 298.9,
  Gzhelian: 303.7, Kasimovian: 307.0, Moscovian: 315.2, Bashkirian: 323.4,
  Serpukhovian: 330.3, Visean: 346.7, Tournaisian: 358.86,
  Famennian: 372.15, Frasnian: 382.31, Givetian: 387.95, Eifelian: 393.47, Emsian: 410.62, Pragian: 413.02, Lochkovian: 419.62,
  'Pridoli age': 422.7, Ludfordian: 425.0, Gorstian: 426.7, Homerian: 430.6, Sheinwoodian: 432.9,
  Telychian: 438.6, Aeronian: 440.5, Rhuddanian: 443.1,
  Hirnantian: 445.2, Katian: 452.8, Sandbian: 458.2, Darriwilian: 469.4, Dapingian: 471.3, Floian: 477.1, Tremadocian: 486.85,
  'Stage 10': [491.0, A], Jiangshanian: [494.2, A], Paibian: [497.0, A],
  Guzhangian: [500.5, A], Drumian: [504.5, A], Wuliuan: [506.5, A],
  'Cambrian Stage 4': [514.5, A], 'Cambrian Stage 3': [521.0, A], 'Cambrian Stage 2': [529.0, A], Fortunian: 538.8,
  Ediacaran: [635, A], Cryogenian: [720, A], Tonian: 1000,
  Stenian: 1200, Ectasian: 1400, Calymmian: 1600,
  Statherian: 1800, Orosirian: 2050, Rhyacian: 2300, Siderian: 2500,
  Neoarchean: 2800, Mesoarchean: 3200, Paleoarchean: 3600, Eoarchean: 4031,
  Hadean: 4567,
};

/** The 2023/09 tree with every leaf base and approx flag from `bases` (a leaf missing there throws). */
function rebase(tree, bases) {
  return tree.map(([name, body]) => {
    if (Array.isArray(body)) return [name, rebase(body, bases)];
    if (!(name in bases)) throw new Error(`timescale: no base for ${name}`);
    const b = bases[name];
    return Array.isArray(b) ? [name, b[0], b[1]] : [name, b];
  });
}

/**
 * Flatten a chart tree. Rank is by depth in the Phanerozoic (eon, era,
 * period, epoch, age); the Precambrian tree is shallower (eon, era, period)
 * and keeps the same rank names for the levels it has.
 * @returns {Array<{name, rank, parent, top_ma, base_ma, approx, path}>}
 */
function flatten(tree) {
  const out = [];
  const walk = (node, depth, parent, topMa, path) => {
    const [name, body, opts] = node;
    const rank = RANKS[Math.min(depth, RANKS.length - 1)];
    const entry = { name, rank, parent, top_ma: topMa, base_ma: null, approx: !!(opts && opts.approx), path: [...path, name] };
    out.push(entry);
    if (Array.isArray(body)) {
      let childTop = topMa;
      for (const child of body) {
        const c = walk(child, depth + 1, name, childTop, entry.path);
        childTop = c.base_ma;
      }
      entry.base_ma = childTop; // the oldest child's base
      // a parent's lower boundary is its oldest child's, so it shares the "~"
      entry.approx = out.find((u) => u.parent === name && u.base_ma === childTop && u.path.length === entry.path.length + 1)?.approx || false;
    } else {
      entry.base_ma = body;
    }
    return entry;
  };
  let top = 0;
  for (const node of tree) {
    const e = walk(node, 0, null, top, []);
    top = e.base_ma;
  }
  return out;
}

const freezeAll = (list) => Object.freeze(list.map((u) => Object.freeze(u)));
const TABLES = {
  [TIMESCALE_V2023]: freezeAll(flatten(CHART)),
  [TIMESCALE_V2026]: freezeAll(flatten(rebase(CHART, BASES_2026))),
};
const BY_NAME = Object.fromEntries(Object.entries(TABLES).map(([v, units]) => [v, new Map(units.map((u) => [u.name.toLowerCase(), u]))]));

/** The table of a chart version; unknown versions throw (a stamp this build cannot read). */
function table(version = TIMESCALE_VERSION) {
  const t = TABLES[version];
  if (!t) throw new Error(`Unknown timescale version "${version}"; this build reads ${TIMESCALE_VERSIONS.join(' and ')}.`);
  return t;
}

/** True when this build can read ages stamped with `version`. */
export const isTimescaleVersion = (version) => Object.prototype.hasOwnProperty.call(TABLES, version);

/** Every unit of the chart, youngest first within each parent, as flattened. */
export const timescaleUnits = (version = TIMESCALE_VERSION) => table(version);

/** Units of one rank, youngest first. */
export const unitsOfRank = (rank, version = TIMESCALE_VERSION) => table(version).filter((u) => u.rank === rank);

/** Lookup by name, case-insensitive; null when absent. */
export const timescaleUnit = (name, version = TIMESCALE_VERSION) => (table(version), BY_NAME[version].get(String(name || '').toLowerCase()) || null);

/** {top_ma, base_ma} of a named unit, or null. */
export function ageBounds(name, version = TIMESCALE_VERSION) {
  const u = timescaleUnit(name, version);
  return u ? { top_ma: u.top_ma, base_ma: u.base_ma, approx: u.approx } : null;
}

/**
 * The chronostratigraphic position of an age: the unit at every rank that
 * contains it, youngest rank last. An age exactly on a boundary belongs to
 * the older unit below it (base is inclusive), the top (0 Ma) to the
 * youngest. Ages outside the chart return an empty array.
 * @param {number} ma
 * @param {string} [version]
 * @returns {Array<{name, rank, top_ma, base_ma, approx}>}
 */
export function unitsAt(ma, version = TIMESCALE_VERSION) {
  const units = table(version);
  if (!Number.isFinite(ma) || ma < 0) return [];
  const chain = [];
  let level = units.filter((u) => u.parent === null);
  while (level.length) {
    const hit = level.find((u) => (ma > u.top_ma && ma <= u.base_ma) || (ma === 0 && u.top_ma === 0));
    if (!hit) break;
    chain.push(hit);
    level = units.filter((u) => u.parent === hit.name && u.path.length === hit.path.length + 1);
  }
  return chain;
}

/** The finest unit containing an age, or null. */
export function unitAt(ma, version = TIMESCALE_VERSION) {
  const chain = unitsAt(ma, version);
  return chain.length ? chain[chain.length - 1] : null;
}

/**
 * Units of a rank that overlap an interval [topMa, baseMa], youngest first.
 * Used for the Wheeler age axis and the column editor's age pickers.
 */
export function unitsBetween(topMa, baseMa, rank = 'age', version = TIMESCALE_VERSION) {
  const lo = Math.min(topMa, baseMa);
  const hi = Math.max(topMa, baseMa);
  return unitsOfRank(rank, version).filter((u) => u.base_ma > lo && u.top_ma < hi);
}

/** Parent chain of a unit, eon first. */
export function lineage(name, version = TIMESCALE_VERSION) {
  const u = timescaleUnit(name, version);
  return u ? u.path.map((n) => timescaleUnit(n, version)) : [];
}

// ---- chart versions: what moved, and what it means for a typed age ------------

// the finest unit whose base a boundary is, plus the coarser units that share it
function boundaryAt(units, ma) {
  const on = units.filter((u) => u.base_ma === ma);
  if (!on.length) return null;
  const finest = on.reduce((a, b) => (b.path.length > a.path.length ? b : a));
  const coarser = on.filter((u) => u !== finest).sort((a, b) => a.path.length - b.path.length).map((u) => u.name);
  return { name: finest.name, rank: finest.rank, alsoBaseOf: coarser };
}

/** The label of a boundary: "base of the Berriasian (base of the Cretaceous)". */
export function boundaryLabel(b) {
  if (!b) return '';
  const outer = b.alsoBaseOf?.length ? ` (base of the ${b.alsoBaseOf[0]})` : '';
  return `base of the ${b.name}${outer}`;
}

/**
 * Every boundary whose age moved between two chart versions, oldest chart
 * first: one row per finest unit whose base moved, youngest first.
 * @returns {Array<{name, rank, alsoBaseOf: string[], from_ma, to_ma, delta_ma, label}>}
 */
export function boundaryChanges(fromVersion, toVersion = TIMESCALE_VERSION) {
  const from = table(fromVersion);
  const to = table(toVersion);
  const out = [];
  for (const u of from) {
    const v = BY_NAME[toVersion].get(u.name.toLowerCase());
    if (!v || v.base_ma === u.base_ma) continue;
    const b = boundaryAt(from, u.base_ma);
    if (!b || b.name !== u.name) continue; // one row per boundary, at its finest unit
    const row = { ...b, from_ma: u.base_ma, to_ma: v.base_ma, delta_ma: Number((v.base_ma - u.base_ma).toFixed(6)) };
    out.push({ ...row, label: boundaryLabel(row) });
  }
  void to;
  return out.sort((a, b) => a.from_ma - b.from_ma);
}

/**
 * What a typed age means on another chart. An age that sits ON a boundary of
 * the chart it was entered under (typed or filled from a stage) moves with
 * that boundary: `update` gives the new number and the change. An age off
 * every boundary is a calibration of its own and keeps its number; if the
 * stage it falls in differs on the new chart, `stageFrom`/`stageTo` say so.
 * Nothing is changed here; the caller offers the update.
 * @param {number} ma
 * @param {string} fromVersion the chart the age was entered under
 * @param {string} [toVersion]
 * @param {{ tolerance?: number }} [opts] how close to a boundary counts as on it (Ma; default 1e-6)
 * @returns {{ update: ?{boundary, label, from_ma, to_ma, delta_ma}, stageFrom: ?string, stageTo: ?string }}
 */
export function ageOnChart(ma, fromVersion, toVersion = TIMESCALE_VERSION, { tolerance = 1e-6 } = {}) {
  const from = table(fromVersion);
  table(toVersion);
  if (!Number.isFinite(ma)) return { update: null, stageFrom: null, stageTo: null };
  let update = null;
  if (fromVersion !== toVersion) {
    const hit = from.find((u) => Math.abs(u.base_ma - ma) <= tolerance);
    if (hit) {
      const b = boundaryAt(from, hit.base_ma);
      const v = BY_NAME[toVersion].get(b.name.toLowerCase());
      if (v && v.base_ma !== hit.base_ma) update = { boundary: b.name, label: boundaryLabel(b), from_ma: hit.base_ma, to_ma: v.base_ma, delta_ma: Number((v.base_ma - hit.base_ma).toFixed(6)) };
    }
  }
  const a = unitAt(ma, fromVersion);
  const b = unitAt(update ? update.to_ma : ma, toVersion);
  return { update, stageFrom: a?.name || null, stageTo: b?.name || null };
}
