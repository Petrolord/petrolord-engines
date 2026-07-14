// Well-tie velocity calibration (Phase W3): fit the velocity model so
// converted horizon depths match well tops in least squares.
//
// The key structure: with each layer's k FIXED, depth through the
// layer cake is LINEAR in the V0 vector —
//   z(t, cell) = Σℓ V0ℓ · g(kℓ, τℓ),  g(k, τ) = (e^{kτ} − 1)/k
// where τℓ is the one-way time the column spends in layer ℓ above t
// (velocityModel.layerTimesMs, sharing layercakeDepthM's exact
// null-boundary and clamping conventions). So calibration is a small
// masked normal-equations solve, exact when the ties are consistent.
// The single-function model is the L = 1 case; its k can optionally be
// fitted too (1-D variable-projection scan — V0 is solved analytically
// per candidate k).
//
// Honesty rules (plan W3): residuals are reported per tie BEFORE and
// AFTER; an inconsistent top surfaces as a large residual, never a
// silently averaged-away fit; layers the ties never sample keep their
// current V0 (reported via fittedLayers); non-positive fitted
// velocities are an error, not a clamp.
//
// Pure math, worker-safe, no I/O.

import { computeWellPath, positionAtMd } from './wellPath';
import { normalizeStations } from './wellSection';
import { worldToIlxl } from './surveyGeometry';
import {
  normalizeVelocity, velocityToManifest, layerTimesMs, makeDepthConverter,
} from './velocityModel';
import { NULL_VALUE } from './manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

/** Depth per unit V0 of one analytic segment over one-way time (s). */
export const segGain = (k, tOneWayS) => {
  if (tOneWayS <= 0) return 0;
  if (Math.abs(k) < 1e-9) return tOneWayS;
  return Math.expm1(k * tOneWayS) / k;
};

/**
 * Sample a horizon pick grid at a fractional lattice position:
 * bilinear when all four surrounding nodes are live, else the nearest
 * live node of the four, else null. Positions outside the survey
 * (beyond half a cell) are null.
 * @returns {?number} sub-sample pick value
 */
export function sampleGridAt(grid, nIl, nXl, il, xl) {
  if (il < -0.5 || il > nIl - 0.5 || xl < -0.5 || xl > nXl - 0.5) return null;
  const i0 = Math.max(0, Math.min(nIl - 2, Math.floor(il)));
  const j0 = Math.max(0, Math.min(nXl - 2, Math.floor(xl)));
  const fi = Math.min(1, Math.max(0, il - i0));
  const fj = Math.min(1, Math.max(0, xl - j0));
  const v = [
    grid[i0 * nXl + j0], grid[i0 * nXl + j0 + 1],
    grid[(i0 + 1) * nXl + j0], grid[(i0 + 1) * nXl + j0 + 1],
  ];
  const live = v.map((x) => x !== NULL_F32 && Number.isFinite(x));
  if (live.every(Boolean)) {
    return v[0] * (1 - fi) * (1 - fj) + v[1] * (1 - fi) * fj
      + v[2] * fi * (1 - fj) + v[3] * fi * fj;
  }
  const d = [
    fi * fi + fj * fj, fi * fi + (1 - fj) ** 2,
    (1 - fi) ** 2 + fj * fj, (1 - fi) ** 2 + (1 - fj) ** 2,
  ];
  let best = -1;
  let bestD = Infinity;
  for (let q = 0; q < 4; q++) {
    if (live[q] && d[q] < bestD) { bestD = d[q]; best = q; }
  }
  return best >= 0 ? v[best] : null;
}

/**
 * Tie points from top ↔ horizon pairings: for every well top whose name
 * is paired, the horizon's picked TWT at the top's lattice position vs
 * the top's measured TVDss. Geometry only — no velocity model involved,
 * so ties are valid inputs for fitting ANY model.
 *
 * @param {Array} wells rows with stations/surface/kbM/tops (the panel's
 *   visible-well shape)
 * @param {{topName: string, horizonId: string}[]} pairings
 * @param {{affine: Object, geom: {nIl, nXl}, dtUs: number,
 *   horizonGrids: Map<string, Float32Array>}} ctx
 * @returns {{wellName, topName, horizonId, il, xl, cell, twtMs, zTopM}[]}
 */
export function buildTiePoints(wells, pairings, { affine, geom, dtUs, horizonGrids }) {
  const dtMs = dtUs / 1000;
  const ties = [];
  for (const w of wells || []) {
    const stations = normalizeStations(w);
    if (!stations || !w.tops || !w.tops.length) continue;
    let path;
    try {
      path = computeWellPath(stations, {
        surfaceX: w.surfaceX, surfaceY: w.surfaceY, kb: w.kbM || 0,
      });
    } catch {
      continue;
    }
    for (const pair of pairings) {
      if (!pair.horizonId) continue;
      const grid = horizonGrids.get(pair.horizonId);
      if (!grid) continue;
      for (const top of w.tops) {
        if (top.name !== pair.topName) continue;
        const pos = positionAtMd(stations, path, top.md);
        if (!pos) continue;
        const ij = worldToIlxl(affine, pos.x, pos.y);
        if (!ij) continue;
        const s = sampleGridAt(grid, geom.nIl, geom.nXl, ij.i, ij.j);
        if (s == null) continue;                // horizon not picked here
        const cell = Math.min(geom.nIl - 1, Math.max(0, Math.round(ij.i))) * geom.nXl
          + Math.min(geom.nXl - 1, Math.max(0, Math.round(ij.j)));
        ties.push({
          wellName: w.name,
          topName: top.name,
          horizonId: pair.horizonId,
          il: ij.i,
          xl: ij.j,
          cell,
          twtMs: s * dtMs,
          zTopM: pos.tvdss,
        });
      }
    }
  }
  return ties;
}

/** Gaussian elimination with partial pivoting (tiny symmetric systems). */
function solveLinear(G, b) {
  const n = b.length;
  const a = G.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;          // singular
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let q = c; q <= n; q++) a[r][q] -= f * a[c][q];
    }
  }
  return a.map((row, i) => row[n] / a[i][i]);
}

const rms = (xs) => (xs.length
  ? Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length) : 0);

/**
 * Provenance record for an applied calibration — persisted next to the
 * model (manifest.velocity_calibration) so depth exports can carry
 * `wells_used` honestly in the RCP handoff. Callers may add a
 * timestamp; the engine stays clock-free.
 * @param {ReturnType<typeof fitWellTie>} result
 */
export function calibrationProvenance(result) {
  return {
    source: 'well_tie',
    wells: [...new Set(result.residuals.map((r) => r.wellName))].sort(),
    ties: result.residuals.length,
    rms_before_m: Math.round(result.rmsBeforeM * 100) / 100,
    rms_after_m: Math.round(result.rmsAfterM * 100) / 100,
  };
}

/**
 * Fit the velocity model to the tie points.
 *
 * Layer cake: per-layer V0 in least squares, k's fixed; layers the ties
 * never sample keep their current V0. Single function: V0 (and, with
 * fitK, k via a 1-D variable-projection scan). Throws plain domain
 * Errors on unusable inputs, singular systems and non-positive fits.
 *
 * @param {Array} ties buildTiePoints output
 * @param {Object} model current model (any accepted shape)
 * @param {{boundaries?: (Float32Array|null)[], dtUs: number,
 *   fitK?: boolean}} opts
 * @returns {{model: Object, manifestModel: Object, fittedLayers: boolean[],
 *   residuals: Array, rmsBeforeM: number, rmsAfterM: number}}
 */
export function fitWellTie(ties, model, { boundaries = null, dtUs, fitK = false } = {}) {
  const m = normalizeVelocity(model);
  if (!m) throw new Error('Set a velocity model before calibrating.');
  if (!ties || !ties.length) {
    throw new Error('No usable tie points — pair tops with horizons that are picked at the well locations.');
  }
  const dtMs = dtUs / 1000;

  let fitted;
  let fittedLayers;
  if (m.kind === 'layercake') {
    if (!boundaries) {
      throw new Error('Layer-cake calibration needs the boundary horizon grids loaded.');
    }
    const L = m.layers.length;
    const nB = L - 1;
    const rows = ties.map((tie) => {
      const bms = new Array(nB);
      for (let b = 0; b < nB; b++) {
        const g = boundaries[b];
        const s = g ? g[tie.cell] : NULL_F32;
        bms[b] = s === NULL_F32 || !Number.isFinite(s) ? null : s * dtMs;
      }
      const times = layerTimesMs(m.layers, bms, tie.twtMs);
      return times.map((tms, l) => segGain(m.layers[l].k, tms / 2000));
    });
    fittedLayers = m.layers.map((_, l) => rows.some((r) => r[l] > 1e-9));
    const idxs = fittedLayers.map((c, l) => (c ? l : -1)).filter((l) => l >= 0);
    if (!idxs.length) throw new Error('The tie points never sample any layer.');
    const nP = idxs.length;
    const G = Array.from({ length: nP }, () => new Array(nP).fill(0));
    const bVec = new Array(nP).fill(0);
    ties.forEach((tie, i) => {
      for (let p = 0; p < nP; p++) {
        const ap = rows[i][idxs[p]];
        bVec[p] += ap * tie.zTopM;
        for (let q = 0; q < nP; q++) G[p][q] += ap * rows[i][idxs[q]];
      }
    });
    const x = solveLinear(G, bVec);
    if (!x) {
      throw new Error('The tie points cannot separate the layer velocities — add ties that bottom in different layers.');
    }
    const v0s = m.layers.map((l) => l.v0);
    idxs.forEach((l, p) => { v0s[l] = Math.round(x[p] * 10) / 10; });
    v0s.forEach((v, l) => {
      if (!(v > 0)) {
        throw new Error(`Fitted V0 for layer ${l + 1} is ${v.toFixed(1)} m/s — the ties are inconsistent with this layer structure.`);
      }
    });
    fitted = {
      kind: 'layercake',
      layers: m.layers.map((l, i) => ({ ...l, v0: v0s[i] })),
    };
  } else {
    const g = (k) => ties.map((tie) => segGain(k, tie.twtMs / 2000));
    const v0For = (k) => {
      const gi = g(k);
      const den = gi.reduce((s, x) => s + x * x, 0);
      if (den <= 0) return null;
      return gi.reduce((s, x, i) => s + x * ties[i].zTopM, 0) / den;
    };
    const sse = (k) => {
      const v0 = v0For(k);
      if (v0 == null) return Infinity;
      const gi = g(k);
      return ties.reduce((s, tie, i) => s + (v0 * gi[i] - tie.zTopM) ** 2, 0);
    };
    let k = m.k;
    if (fitK) {
      // coarse scan then golden-section refine (variable projection)
      let bestK = 0;
      let bestS = Infinity;
      for (let i = 0; i <= 400; i++) {
        const kc = -1 + (i / 400) * 4;                  // k in [-1, 3] 1/s
        const s = sse(kc);
        if (s < bestS) { bestS = s; bestK = kc; }
      }
      let lo = bestK - 0.01;
      let hi = bestK + 0.01;
      const phi = (Math.sqrt(5) - 1) / 2;
      for (let it = 0; it < 60; it++) {
        const a = hi - phi * (hi - lo);
        const b = lo + phi * (hi - lo);
        if (sse(a) < sse(b)) hi = b;
        else lo = a;
      }
      k = Math.round(((lo + hi) / 2) * 1e4) / 1e4;
    }
    const v0 = v0For(k);
    if (v0 == null || !(v0 > 0)) {
      throw new Error('The ties are inconsistent with a positive velocity.');
    }
    fitted = { kind: 'linear', v0: Math.round(v0 * 10) / 10, k };
    fittedLayers = [true];
  }

  const manifestModel = velocityToManifest(fitted);
  const convBefore = makeDepthConverter(velocityToManifest(m), { dtUs, boundaries });
  const convAfter = makeDepthConverter(manifestModel, { dtUs, boundaries });
  const residuals = ties.map((tie) => ({
    ...tie,
    beforeM: convBefore.toDepthM(tie.twtMs, tie.cell) - tie.zTopM,
    afterM: convAfter.toDepthM(tie.twtMs, tie.cell) - tie.zTopM,
  }));
  return {
    model: fitted,
    manifestModel,
    fittedLayers,
    residuals,
    rmsBeforeM: rms(residuals.map((r) => r.beforeM)),
    rmsAfterM: rms(residuals.map((r) => r.afterM)),
  };
}
