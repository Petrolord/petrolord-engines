/**
 * Facility layout spacing and fire-radiation setbacks (Facilities F8).
 *
 * The Facility Layout Mapper is a genuinely working drafting tool that
 * has always advertised "safety distances" and never computed any. This
 * engine is that missing half: it checks the distances between placed
 * equipment against a spacing table, and computes the setback a flare
 * or a pool fire actually demands from its own heat release rather than
 * from a table lookup.
 *
 * Two different kinds of answer, deliberately kept apart:
 *
 *  1. TABLE SPACING. Minimum separations between equipment types are
 *     published as tables (the oil-industry insurance and API practice
 *     sets). A table is a table: the values here are the customary
 *     onshore production-facility figures, they are stated as inputs
 *     that can be replaced wholesale by a site's own standard, and the
 *     engine never pretends a table value is a calculation.
 *
 *  2. COMPUTED SETBACK. Thermal radiation from a flare or a pool fire
 *     IS calculable. Both setbacks here use the API 521 point-source
 *     model the relief engine uses; the pool fire takes its heat
 *     release from a burning rate and uses the Thomas flame height only
 *     to flag the near field (see poolFireSetbackM). A radiation
 *     setback is therefore computed from the duty and moves when the
 *     duty moves.
 *
 * Distances in metres throughout; the Suite layer converts.
 */

/* ------------------------------------------------------------------ *
 * The spacing table
 * ------------------------------------------------------------------ */

/**
 * Customary minimum separations for an onshore production facility, in
 * metres, between equipment CLASSES. Symmetric: the lookup takes the
 * pair in either order. These are the commonly cited industry-practice
 * figures and are meant to be overridden by a site standard.
 */
export const SPACING_TABLE_M = {
  wellhead: {
    wellhead: 3, manifold: 8, separator: 15, heaterTreater: 30, tank: 30,
    flare: 60, pump: 15, compressor: 30, control: 30, valve: 0, psv: 0,
  },
  manifold: {
    manifold: 3, separator: 8, heaterTreater: 15, tank: 15, flare: 60,
    pump: 8, compressor: 15, control: 30, valve: 0, psv: 0,
  },
  separator: {
    separator: 3, heaterTreater: 15, tank: 15, flare: 60, pump: 8,
    compressor: 15, control: 30, valve: 0, psv: 0,
  },
  heaterTreater: {
    heaterTreater: 8, tank: 30, flare: 60, pump: 15, compressor: 15,
    control: 30, valve: 0, psv: 0,
  },
  tank: {
    tank: 3, flare: 60, pump: 15, compressor: 30, control: 30,
    valve: 0, psv: 0,
  },
  flare: { flare: 60, pump: 60, compressor: 60, control: 90, valve: 0, psv: 0 },
  pump: { pump: 3, compressor: 8, control: 15, valve: 0, psv: 0 },
  compressor: { compressor: 8, control: 30, valve: 0, psv: 0 },
  control: { control: 0, valve: 0, psv: 0 },
  valve: { valve: 0, psv: 0 },
  psv: { psv: 0 },
};

/** Symmetric lookup; unknown pairs return null rather than a guess. */
export const requiredSpacingM = ({ typeA, typeB, table = SPACING_TABLE_M }) => {
  const a = table[typeA];
  if (a && Number.isFinite(a[typeB])) return a[typeB];
  const b = table[typeB];
  if (b && Number.isFinite(b[typeA])) return b[typeA];
  return null;
};

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

const R_EARTH_M = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

/**
 * Great-circle distance between two lat/lon points (haversine). The
 * layout mapper places equipment on a map, so its coordinates are
 * geographic and a planar distance would be wrong at the scale of a
 * large site at high latitude.
 */
export const haversineM = ({ lat1, lon1, lat2, lon2 }) => {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) {
    return { error: 'two coordinate pairs are needed' };
  }
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return { distanceM: 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a))) };
};

/* ------------------------------------------------------------------ *
 * Computed radiation setbacks
 * ------------------------------------------------------------------ */

/** API 521 customary allowable radiation levels, kW/m2. */
export const RADIATION_LEVELS = [
  { kWm2: 1.58, label: 'Continuous exposure, no time limit (site boundary, control room)' },
  { kWm2: 4.73, label: 'Emergency action of several minutes, with clothing' },
  { kWm2: 6.31, label: 'Emergency action up to about a minute' },
  { kWm2: 9.46, label: 'Seconds only: escape route' },
];

/**
 * Setback from a flare, computed from the point-source model. The same
 * physics as the relief engine's radiation check, asked as a distance.
 */
export const flareSetbackM = ({
  reliefRateKgS, lhvKjKg, allowableKwM2 = 4.73,
  fractionRadiated = 0.3, transmissivity = 1.0,
}) => {
  if (!(reliefRateKgS > 0) || !(lhvKjKg > 0)) {
    return { error: 'a flare setback needs a relief rate and a heating value' };
  }
  if (!(allowableKwM2 > 0)) return { error: 'an allowable intensity is needed' };
  const qKw = reliefRateKgS * lhvKjKg;
  const distanceM = Math.sqrt(
    (transmissivity * fractionRadiated * qKw) / (4 * Math.PI * allowableKwM2),
  );
  return { qKw, distanceM };
};

/**
 * Thomas (1963) mean visible flame height of a pool fire in still air:
 *
 *     H / D = 42 (m" / (rho_air sqrt(g D)))^0.61
 *
 * m" in kg/(m2 s), D in m, rho_air in kg/m3 (1.2 unless stated), g =
 * 9.80665 m/s2. Exported so that the HSE consequence engine
 * (engines/hse/consequence.js) uses this one expression rather than a
 * copy of it; poolFireSetbackM below calls it with the same defaults it
 * always used, so its results are unchanged bit for bit. Inputs are not
 * validated here: both callers validate before calling.
 */
export const thomasFlameHeightM = ({ poolDiameterM, burnRateKgM2S, airDensityKgM3 = 1.2 }) => poolDiameterM * 42
  * (burnRateKgM2S / (airDensityKgM3 * Math.sqrt(9.80665 * poolDiameterM))) ** 0.61;

/**
 * Setback from a liquid pool fire, by a POINT-SOURCE model.
 *
 * What the code does, and all it does:
 *  - heat release Q = burning rate per unit area x pool area x LHV
 *  - intensity at distance R from the pool centre by a single point
 *    source, q = tau F Q / (4 pi R^2), solved for the R at which q
 *    equals the allowable (`radiusFromCentreM`)
 *  - setback from the pool edge = R - D/2
 *  - flame height by the Thomas (1963) correlation, used ONLY to flag
 *    when R falls inside the flame height, where a point source
 *    under-predicts the intensity and the result is a lower bound
 *
 * No view factor and no solid-flame surface emissive power are
 * computed. A near-field design case needs a solid-flame model, which
 * this function does not provide.
 *
 * When R is not beyond the pool edge (R <= D/2) there is no setback to
 * add outside the pool: `setbackFromEdgeM` is 0 and `setbackStatus` is
 * 'within-pool-edge' with a note saying so. Otherwise `setbackStatus`
 * is 'beyond-pool-edge'.
 *
 * A pool fire is the case a tank spacing table is silently encoding,
 * and computing it makes the table's assumptions visible: a small bund
 * needs far less separation than the table's blanket figure, and a
 * large one needs more.
 */
export const poolFireSetbackM = ({
  poolDiameterM, burnRateKgM2S = 0.055, lhvKjKg = 43000,
  allowableKwM2 = 4.73, fractionRadiated = 0.35, transmissivity = 1.0,
}) => {
  if (!(poolDiameterM > 0)) return { error: 'a pool diameter is needed' };
  if (!(allowableKwM2 > 0)) return { error: 'an allowable intensity is needed' };
  const areaM2 = (Math.PI * poolDiameterM * poolDiameterM) / 4;
  const mDotKgS = burnRateKgM2S * areaM2;
  const qKw = mDotKgS * lhvKjKg;
  const flameHeightM = thomasFlameHeightM({ poolDiameterM, burnRateKgM2S });
  // Point-source distance from the pool centre, then referenced to the
  // pool edge as a setback.
  const rFromCentreM = Math.sqrt(
    (transmissivity * fractionRadiated * qKw) / (4 * Math.PI * allowableKwM2),
  );
  const withinEdge = rFromCentreM <= poolDiameterM / 2;
  const notes = [];
  if (withinEdge) {
    notes.push(`the point-source radius of ${rFromCentreM.toFixed(1)} m lies within the pool edge at ${(poolDiameterM / 2).toFixed(1)} m from the centre, so the setback from the edge is reported as 0 with setbackStatus 'within-pool-edge': a point source says nothing reliable this close to the fire`);
  }
  if (rFromCentreM < flameHeightM) {
    notes.push('the computed radius is inside the flame height, so the point-source model is being used close to the flame where it under-predicts: treat this as a lower bound and use a solid-flame view factor for design');
  }
  return {
    areaM2, burnRateKgS: mDotKgS, qKw, flameHeightM,
    radiusFromCentreM: rFromCentreM,
    setbackFromEdgeM: withinEdge ? 0 : rFromCentreM - poolDiameterM / 2,
    setbackStatus: withinEdge ? 'within-pool-edge' : 'beyond-pool-edge',
    note: notes.length ? notes.join('. ') : null,
  };
};

/* ------------------------------------------------------------------ *
 * The layout check
 * ------------------------------------------------------------------ */

/**
 * Check every pair of placed items against the spacing table, and any
 * item against a computed radiation setback where one applies.
 *
 * `items`: [{ id, name, type, lat, lon }]
 * `radiationSources`: [{ id, setbackM, allowableKwM2, label }]
 *
 * Contract (FC1-0, 2026-09-15):
 *  - `skipped`: [{ id, reason }]. An item without finite coordinates is
 *    skipped once ('bad-coordinates'); a radiation source whose id is
 *    not a placed item is skipped ('radiation-source-not-placed').
 *  - `unknownPairs`: type pairs the table has no figure for.
 *  - `checked` counts only comparisons with a POSITIVE requirement
 *    between two items that both have coordinates. A table figure of 0
 *    (or a radiation setback of 0) is no requirement and is counted in
 *    `zeroRequirementPairs` instead.
 *  - `pass`: true when at least one comparison was checked and none
 *    failed, false when any failed, and null when nothing was checked
 *    (`passStatus` 'nothing-checked'; otherwise 'checked'). `pass`
 *    speaks only for the comparisons checked.
 *  - `complete`: false when anything was skipped or any type pair was
 *    unknown, because then the layout was not fully judged.
 *  - `violations` are sorted by absolute shortfall in metres, largest
 *    first (ties: larger shortfall fraction, then the order found).
 *    Two named rankings are returned, and neither is called "worst"
 *    on its own: `worstAbsolute` is the largest shortfall in metres,
 *    `worstRelative` the largest shortfall as a fraction of its
 *    requirement (ties: larger shortfall in metres, then the order
 *    found). A 2 m shortfall on a 3 m figure is the worst relative
 *    breach, while 40 m short of 90 m is the worst absolute one.
 */
export const checkLayout = ({
  items, table = SPACING_TABLE_M, radiationSources = [],
}) => {
  if (!Array.isArray(items)) return { error: 'a list of placed items is needed' };
  const violations = [];
  const unknownPairs = [];
  const skipped = [];
  let checked = 0;
  let zeroRequirementPairs = 0;

  const placed = (it) => Number.isFinite(it?.lat) && Number.isFinite(it?.lon);
  for (const it of items) {
    if (!placed(it)) skipped.push({ id: it?.id ?? null, reason: 'bad-coordinates' });
  }

  const record = (v) => violations.push({ ...v, order: violations.length });

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (!placed(a) || !placed(b)) continue;
      const required = requiredSpacingM({ typeA: a.type, typeB: b.type, table });
      if (required === null) {
        unknownPairs.push({ typeA: a.type, typeB: b.type });
        continue;
      }
      if (!(required > 0)) { zeroRequirementPairs += 1; continue; }
      const d = haversineM({ lat1: a.lat, lon1: a.lon, lat2: b.lat, lon2: b.lon });
      checked += 1;
      if (d.distanceM < required) {
        record({
          kind: 'spacing',
          aId: a.id, aName: a.name, aType: a.type,
          bId: b.id, bName: b.name, bType: b.type,
          actualM: d.distanceM,
          requiredM: required,
          shortfallM: required - d.distanceM,
          shortfallFraction: (required - d.distanceM) / required,
        });
      }
    }
  }

  // Radiation setbacks: each source against every other placed item.
  for (const src of radiationSources) {
    const source = items.find((it) => it.id === src.id);
    if (!source) {
      skipped.push({ id: src.id ?? null, reason: 'radiation-source-not-placed' });
      continue;
    }
    if (!placed(source)) continue; // already skipped as bad-coordinates
    for (const other of items) {
      if (other.id === source.id || !placed(other)) continue;
      if (!(src.setbackM > 0)) { zeroRequirementPairs += 1; continue; }
      const d = haversineM({
        lat1: source.lat, lon1: source.lon, lat2: other.lat, lon2: other.lon,
      });
      checked += 1;
      if (d.distanceM < src.setbackM) {
        record({
          kind: 'radiation',
          aId: source.id, aName: source.name, aType: source.type,
          bId: other.id, bName: other.name, bType: other.type,
          actualM: d.distanceM,
          requiredM: src.setbackM,
          shortfallM: src.setbackM - d.distanceM,
          shortfallFraction: (src.setbackM - d.distanceM) / src.setbackM,
          allowableKwM2: src.allowableKwM2,
          label: src.label,
        });
      }
    }
  }

  const byAbsolute = (x, y) => (y.shortfallM - x.shortfallM)
    || (y.shortfallFraction - x.shortfallFraction) || (x.order - y.order);
  const byRelative = (x, y) => (y.shortfallFraction - x.shortfallFraction)
    || (y.shortfallM - x.shortfallM) || (x.order - y.order);
  const worstRelative = violations.length ? [...violations].sort(byRelative)[0] : null;
  violations.sort(byAbsolute);
  const strip = (v) => {
    if (!v) return null;
    const { order, ...rest } = v;
    return rest;
  };
  const out = violations.map(strip);
  const nothingChecked = checked === 0;
  return {
    checked,
    zeroRequirementPairs,
    violations: out,
    worstAbsolute: out[0] || null,
    worstRelative: strip(worstRelative),
    unknownPairs,
    skipped,
    complete: skipped.length === 0 && unknownPairs.length === 0,
    pass: nothingChecked ? null : violations.length === 0,
    passStatus: nothingChecked ? 'nothing-checked' : 'checked',
  };
};

/**
 * The nearest neighbour of each item, which is what a layout reviewer
 * actually wants next to the violation list: not just what is too
 * close, but how much room everything has.
 */
export const nearestNeighbours = ({ items }) => {
  if (!Array.isArray(items) || items.length < 2) {
    return { error: 'at least two placed items are needed' };
  }
  return {
    rows: items.map((a) => {
      let best = null;
      for (const b of items) {
        if (b.id === a.id) continue;
        const d = haversineM({ lat1: a.lat, lon1: a.lon, lat2: b.lat, lon2: b.lon });
        if (d.error) continue;
        if (!best || d.distanceM < best.distanceM) {
          best = { distanceM: d.distanceM, id: b.id, name: b.name, type: b.type };
        }
      }
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        nearest: best,
        requiredM: best ? requiredSpacingM({ typeA: a.type, typeB: best.type }) : null,
      };
    }),
  };
};
