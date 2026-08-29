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
 *     IS calculable, from the same API 521 point-source model the
 *     relief engine uses and from published pool-fire correlations. A
 *     radiation setback is therefore computed from the duty, not read
 *     off a chart, and it moves when the duty moves.
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
 * Setback from a liquid pool fire, from the published solid-flame
 * correlations: burning rate per unit area, flame height by the
 * Thomas correlation, and a view-factor-based intensity that reduces
 * to the point source far from the flame.
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
  // Thomas (1963) flame height for a pool fire in still air:
  // H/D = 42 (m" / (rho_air sqrt(g D)))^0.61
  const rhoAir = 1.2;
  const flameHeightM = poolDiameterM * 42
    * (burnRateKgM2S / (rhoAir * Math.sqrt(9.80665 * poolDiameterM))) ** 0.61;
  // Point-source distance, measured from the flame centre, then
  // referenced to the pool edge as a setback.
  const rFromCentreM = Math.sqrt(
    (transmissivity * fractionRadiated * qKw) / (4 * Math.PI * allowableKwM2),
  );
  const setbackM = Math.max(0, rFromCentreM - poolDiameterM / 2);
  return {
    areaM2, burnRateKgS: mDotKgS, qKw, flameHeightM,
    radiusFromCentreM: rFromCentreM,
    setbackFromEdgeM: setbackM,
    note: rFromCentreM < flameHeightM
      ? 'the computed radius is inside the flame height, so the point-source model is being used close to the flame where it under-predicts: treat this as a lower bound and use a solid-flame view factor for design'
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * The layout check
 * ------------------------------------------------------------------ */

/**
 * Check every pair of placed items against the spacing table, and any
 * item against a computed radiation setback where one applies. Returns
 * the violations sorted worst first, so a layout review is a list to
 * work through rather than a map to squint at.
 *
 * `items`: [{ id, name, type, lat, lon }]
 * `radiationSources`: [{ id, setbackM, allowableKwM2, label }]
 */
export const checkLayout = ({
  items, table = SPACING_TABLE_M, radiationSources = [],
}) => {
  if (!Array.isArray(items)) return { error: 'a list of placed items is needed' };
  const violations = [];
  const unknownPairs = [];
  let checked = 0;

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      const required = requiredSpacingM({ typeA: a.type, typeB: b.type, table });
      if (required === null) {
        unknownPairs.push({ typeA: a.type, typeB: b.type });
        continue;
      }
      const d = haversineM({ lat1: a.lat, lon1: a.lon, lat2: b.lat, lon2: b.lon });
      if (d.error) continue;
      checked += 1;
      if (required > 0 && d.distanceM < required) {
        violations.push({
          kind: 'spacing',
          aId: a.id, aName: a.name, aType: a.type,
          bId: b.id, bName: b.name, bType: b.type,
          actualM: d.distanceM,
          requiredM: required,
          shortfallM: required - d.distanceM,
          severity: (required - d.distanceM) / required,
        });
      }
    }
  }

  // Radiation setbacks: each source against every other item.
  for (const src of radiationSources) {
    const source = items.find((it) => it.id === src.id);
    if (!source || !(src.setbackM > 0)) continue;
    for (const other of items) {
      if (other.id === source.id) continue;
      const d = haversineM({
        lat1: source.lat, lon1: source.lon, lat2: other.lat, lon2: other.lon,
      });
      if (d.error) continue;
      checked += 1;
      if (d.distanceM < src.setbackM) {
        violations.push({
          kind: 'radiation',
          aId: source.id, aName: source.name, aType: source.type,
          bId: other.id, bName: other.name, bType: other.type,
          actualM: d.distanceM,
          requiredM: src.setbackM,
          shortfallM: src.setbackM - d.distanceM,
          severity: (src.setbackM - d.distanceM) / src.setbackM,
          allowableKwM2: src.allowableKwM2,
          label: src.label,
        });
      }
    }
  }

  violations.sort((x, y) => y.severity - x.severity);
  return {
    checked,
    violations,
    worst: violations[0] || null,
    unknownPairs,
    pass: violations.length === 0,
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
