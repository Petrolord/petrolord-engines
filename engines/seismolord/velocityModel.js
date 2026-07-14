// Velocity model + time-depth conversion (pure, worker-safe, jest-tested).
//
// Two model kinds:
//
// SINGLE FUNCTION — V(z) = v0 + k·z, instantaneous velocity linear in
// depth (k = 0 is plain constant velocity). One-way time t (s) to depth
// (m, positive down):
//   z(t) = (v0 / k) · (e^{k·t} − 1)      (k ≠ 0)
//   z(t) = v0 · t                        (k = 0)
//
// LAYER CAKE — ordered layers top-down, each bounded below by a picked
// horizon (the last layer is unbounded). Within layer n the model is
// V = v0ₙ + kₙ·(z − zTopₙ) — the same analytic segment, restarted at
// each layer top — so depth accumulates piecewise down the column.
// Layer boundaries are HORIZON TIMES and therefore vary per (il, xl)
// cell: layer-cake conversion is column-dependent. Conventions
// (documented + tested):
//   - a boundary that is null at a column extends the layer above it
//     down to the next defined boundary (the layer below vanishes);
//   - non-monotonic boundaries (crossing/noisy picks) clamp to zero
//     layer thickness — depth stays monotonic in time.
//
// Inputs are TWT in ms (the app's vertical unit); t = twt / 2000.
// Display uses positive-down metres/feet; the EXPORT convention stays
// NEGATIVE Z in feet (playbook — matches ReservoirCalc Pro test data)
// via sampleToExportZ.

import { NULL_VALUE } from './manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

export const M_PER_FT = 0.3048;

/**
 * Validate a velocity model shape.
 * Accepts {v0, k} (single function: v0 m/s at datum, k 1/s) or
 * {type: 'layercake', layers: [{base_horizon_id|null, v0, k}, …]}
 * (manifest form; camelCase baseHorizonId also accepted).
 * @returns {{kind:'linear', v0:number, k:number} |
 *   {kind:'layercake', layers:{v0:number,k:number,
 *    baseHorizonId:string|null}[]} | null} null when unusable — a
 *   layer-cake with ANY invalid layer is rejected whole (a silently
 *   dropped layer would misconvert every depth below it).
 */
export function normalizeVelocity(model) {
  if (!model) return null;
  if (model.type === 'layercake' || model.kind === 'layercake') {
    const src = model.layers;
    if (!Array.isArray(src) || src.length === 0) return null;
    const layers = [];
    for (const l of src) {
      const v0 = Number(l.v0);
      const k = Number(l.k ?? 0);
      if (!Number.isFinite(v0) || v0 <= 0 || !Number.isFinite(k)) return null;
      layers.push({ v0, k, baseHorizonId: l.base_horizon_id ?? l.baseHorizonId ?? null });
    }
    return { kind: 'layercake', layers };
  }
  const v0 = Number(model.v0);
  const k = Number(model.k ?? 0);
  if (!Number.isFinite(v0) || v0 <= 0 || !Number.isFinite(k)) return null;
  return { kind: 'linear', v0, k };
}

/** Manifest (persisted) form of a normalized model. */
export function velocityToManifest(model) {
  const m = normalizeVelocity(model);
  if (!m) return null;
  if (m.kind === 'layercake') {
    return {
      type: 'layercake',
      layers: m.layers.map((l) => ({
        base_horizon_id: l.baseHorizonId, v0: l.v0, k: l.k,
      })),
    };
  }
  return { v0: m.v0, k: m.k };
}

/** Stable cache-key string for a model (layer grids keyed separately). */
export function velocityKey(model) {
  const m = normalizeVelocity(model);
  if (!m) return '';
  return m.kind === 'layercake'
    ? `lc:${m.layers.map((l) => `${l.baseHorizonId ?? ''}~${l.v0}~${l.k}`).join('|')}`
    : `lin:${m.v0}~${m.k}`;
}

/** Depth advance of one analytic segment over one-way time (s). */
const segDepthM = (v0, k, tOneWayS) => {
  if (tOneWayS <= 0) return 0;
  if (Math.abs(k) < 1e-9) return v0 * tOneWayS;
  return (v0 / k) * Math.expm1(k * tOneWayS);
};

/** TWT ms -> depth in metres, positive down (single-function model). */
export function twtMsToDepthM(twtMs, { v0, k }) {
  return segDepthM(v0, k, twtMs / 2000);
}

/**
 * Layer-cake TWT ms -> depth (m, positive down) for ONE column.
 *
 * @param {{v0:number,k:number}[]} layers top-down
 * @param {(number|null)[]} boundaryTwtMs base TWT of layers[0..n-2] at
 *   this column; null/1e30/non-finite = boundary missing here (the
 *   layer above extends to the next defined boundary)
 * @param {number} twtMs target time
 */
export function layercakeDepthM(layers, boundaryTwtMs, twtMs) {
  const n = layers.length;
  let tTop = 0;
  let zTop = 0;
  for (let i = 0; i < n;) {
    const l = layers[i];
    // effective base: the first DEFINED boundary at index >= i; layers
    // whose boundary is missing merge into this one (zero thickness)
    let tBase = Infinity;
    let next = n;
    for (let b = i; b < n - 1; b++) {
      const v = boundaryTwtMs ? boundaryTwtMs[b] : null;
      if (v != null && Number.isFinite(v) && Math.abs(v) < 1e29) {
        tBase = v;
        next = b + 1;
        break;
      }
    }
    const base = Math.max(tBase, tTop);    // crossing picks -> clamp
    if (twtMs <= base) return zTop + segDepthM(l.v0, l.k, (twtMs - tTop) / 2000);
    zTop += segDepthM(l.v0, l.k, (base - tTop) / 2000);
    tTop = base;
    i = next;
  }
  return zTop; // unreachable (last layer has an infinite base)
}

/**
 * TWT spent in each layer above `twtMs` for ONE column — the same walk
 * as layercakeDepthM (identical null-boundary and crossing-clamp
 * conventions; the identity
 *   layercakeDepthM(...) === Σ segDepth(v0ℓ, kℓ, layerTimesMs[ℓ]/2000)
 * is asserted in tests). Depth is LINEAR in the v0 vector through these
 * times, which is what makes well-tie calibration a linear fit.
 *
 * @param {{v0:number,k:number}[]} layers top-down
 * @param {(number|null)[]} boundaryTwtMs per layercakeDepthM
 * @param {number} twtMs
 * @returns {number[]} TWT ms per layer (zeros for merged/unreached layers)
 */
export function layerTimesMs(layers, boundaryTwtMs, twtMs) {
  const n = layers.length;
  const out = new Array(n).fill(0);
  let tTop = 0;
  for (let i = 0; i < n;) {
    let tBase = Infinity;
    let next = n;
    for (let b = i; b < n - 1; b++) {
      const v = boundaryTwtMs ? boundaryTwtMs[b] : null;
      if (v != null && Number.isFinite(v) && Math.abs(v) < 1e29) {
        tBase = v;
        next = b + 1;
        break;
      }
    }
    const base = Math.max(tBase, tTop);
    if (twtMs <= base) {
      out[i] = Math.max(0, twtMs - tTop);
      return out;
    }
    out[i] = base - tTop;
    tTop = base;
    i = next;
  }
  return out;
}

/**
 * Build a cell-aware TWT->depth converter for either model kind.
 *
 * @param {Object} model manifest.velocity (any accepted shape)
 * @param {{dtUs?: number, boundaries?: (Float32Array|null)[]}} [ctx]
 *   boundaries: pick grids (SAMPLE indices, 1e30 nulls) aligned with
 *   the layer-cake's layers[0..n-2] bases; required for layer cake
 * @returns {{toDepthM: (twtMs: number, cell?: number) => number,
 *   columnDependent: boolean, model: Object}|null}
 */
export function makeDepthConverter(model, { dtUs = 0, boundaries = null } = {}) {
  const m = normalizeVelocity(model);
  if (!m) return null;
  if (m.kind !== 'layercake') {
    return {
      model: m,
      columnDependent: false,
      toDepthM: (twtMs) => twtMsToDepthM(twtMs, m),
    };
  }
  const dtMs = dtUs / 1000;
  const nB = m.layers.length - 1;
  const scratch = new Array(nB); // reused per call — single-threaded loops
  return {
    model: m,
    columnDependent: true,
    toDepthM: (twtMs, cell) => {
      for (let b = 0; b < nB; b++) {
        const g = boundaries ? boundaries[b] : null;
        const s = g && cell != null ? g[cell] : NULL_F32;
        scratch[b] = s === NULL_F32 || !Number.isFinite(s) ? null : s * dtMs;
      }
      return layercakeDepthM(m.layers, scratch, twtMs);
    },
  };
}

/**
 * Convert a pick grid (sample indices) to a depth grid, null-aware.
 * Layer-cake models convert per column (pass ctx.boundaries).
 * @param {Float32Array} picks
 * @param {number} dtUs sample interval, µs
 * @param {Object} model
 * @param {{unit?: 'm'|'ft', boundaries?: (Float32Array|null)[]}} [opts]
 * @returns {Float32Array} depth, positive down
 */
export function depthGridFromPicks(picks, dtUs, model, { unit = 'm', boundaries = null } = {}) {
  const dtMs = dtUs / 1000;
  const scale = unit === 'ft' ? 1 / M_PER_FT : 1;
  const conv = makeDepthConverter(model, { dtUs, boundaries });
  const out = new Float32Array(picks.length);
  for (let c = 0; c < picks.length; c++) {
    out[c] = picks[c] === NULL_F32
      ? NULL_F32
      : conv.toDepthM(picks[c] * dtMs, c) * scale;
  }
  return out;
}

/**
 * Export-convention converter: sample index -> NEGATIVE depth in feet.
 * Layer-cake models need ctx.boundaries and a cell index at call time.
 * @returns {(sample: number, cell?: number) => number}
 */
export function sampleToExportZ(model, dtUs, { boundaries = null } = {}) {
  const dtMs = dtUs / 1000;
  const conv = makeDepthConverter(model, { dtUs, boundaries });
  return (s, cell) => -(conv.toDepthM(s * dtMs, cell) / M_PER_FT);
}

/** Human label, e.g. "V(z) = 2000 + 0.30·z m/s", "V = 2000 m/s" or
 *  "Layer cake, 3 layers (1800 / 2400 / 3200 m/s at layer tops)". */
export function describeVelocity(model) {
  const m = normalizeVelocity(model);
  if (!m) return 'not set';
  if (m.kind === 'layercake') {
    const v0s = m.layers.map((l) => l.v0).join(' / ');
    return `Layer cake, ${m.layers.length} layers (${v0s} m/s at layer tops)`;
  }
  return Math.abs(m.k) < 1e-9
    ? `V = ${m.v0} m/s`
    : `V(z) = ${m.v0} + ${m.k}·z m/s`;
}
