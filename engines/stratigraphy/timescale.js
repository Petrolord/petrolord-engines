// Geologic time scale (Stratigraphy Studio ST0, 2026-09-06).
//
// The International Chronostratigraphic Chart of the International
// Commission on Stratigraphy, version 2023/09 (Cohen, Finney, Gibbard and
// Fan 2013, updated; chart at stratigraphy.org, licensed CC BY 4.0). Ages
// are the base of each unit in Ma. Units the chart marks with "~" carry
// `approx: true`; the number is the chart's, the flag says the boundary is
// not yet defined by a GSSP.
//
// Pure data plus lookups. The tree below is transcribed base-first: each
// node is [name, children] or [name, baseMa, opts]; a parent's base is its
// oldest child's base, a unit's top is the base of the next-younger sibling
// (or its parent's top; the present is 0). Guard tests pin well-known
// boundaries (Cretaceous/Paleogene 66.0, Triassic/Jurassic 201.4, base of
// the Cambrian 538.8) and the monotonic ordering of every level.

export const TIMESCALE_VERSION = 'ICS 2023/09';
export const TIMESCALE_LICENCE = 'International Chronostratigraphic Chart, ICS, CC BY 4.0';
export const RANKS = Object.freeze(['eon', 'era', 'period', 'epoch', 'age']);

const A = { approx: true };

// [name, children | baseMa, opts?]
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

/**
 * Flatten the chart. Rank is by depth in the Phanerozoic (eon, era, period,
 * epoch, age); the Precambrian tree is shallower (eon, era, period) and
 * keeps the same rank names for the levels it has.
 * @returns {Array<{name, rank, parent, top_ma, base_ma, approx, path}>}
 */
function flatten() {
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
    } else {
      entry.base_ma = body;
    }
    return entry;
  };
  let top = 0;
  for (const node of CHART) {
    const e = walk(node, 0, null, top, []);
    top = e.base_ma;
  }
  return out;
}

const UNITS = Object.freeze(flatten().map((u) => Object.freeze(u)));
const byName = new Map(UNITS.map((u) => [u.name.toLowerCase(), u]));

/** Every unit of the chart, youngest first within each parent, as flattened. */
export const timescaleUnits = () => UNITS;

/** Units of one rank, youngest first. */
export const unitsOfRank = (rank) => UNITS.filter((u) => u.rank === rank);

/** Lookup by name, case-insensitive; null when absent. */
export const timescaleUnit = (name) => byName.get(String(name || '').toLowerCase()) || null;

/** {top_ma, base_ma} of a named unit, or null. */
export function ageBounds(name) {
  const u = timescaleUnit(name);
  return u ? { top_ma: u.top_ma, base_ma: u.base_ma, approx: u.approx } : null;
}

/**
 * The chronostratigraphic position of an age: the unit at every rank that
 * contains it, youngest rank last. An age exactly on a boundary belongs to
 * the older unit below it (base is inclusive), the top (0 Ma) to the
 * youngest. Ages outside the chart return an empty array.
 * @param {number} ma
 * @returns {Array<{name, rank, top_ma, base_ma, approx}>}
 */
export function unitsAt(ma) {
  if (!Number.isFinite(ma) || ma < 0) return [];
  const chain = [];
  let level = UNITS.filter((u) => u.parent === null);
  while (level.length) {
    const hit = level.find((u) => (ma > u.top_ma && ma <= u.base_ma) || (ma === 0 && u.top_ma === 0));
    if (!hit) break;
    chain.push(hit);
    level = UNITS.filter((u) => u.parent === hit.name && u.path.length === hit.path.length + 1);
  }
  return chain;
}

/** The finest unit containing an age, or null. */
export function unitAt(ma) {
  const chain = unitsAt(ma);
  return chain.length ? chain[chain.length - 1] : null;
}

/**
 * Units of a rank that overlap an interval [topMa, baseMa], youngest first.
 * Used for the Wheeler age axis and the column editor's age pickers.
 */
export function unitsBetween(topMa, baseMa, rank = 'age') {
  const lo = Math.min(topMa, baseMa);
  const hi = Math.max(topMa, baseMa);
  return unitsOfRank(rank).filter((u) => u.base_ma > lo && u.top_ma < hi);
}

/** Parent chain of a unit, eon first. */
export function lineage(name) {
  const u = timescaleUnit(name);
  return u ? u.path.map((n) => timescaleUnit(n)) : [];
}
