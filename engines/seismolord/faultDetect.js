// Automatic fault picking (Tops to Horizons programme, TP3F).
//
// Four explainable stages turn a seismic volume, read trace by trace, into
// proposed fault sticks an interpreter can accept, edit or delete:
//
//   1. faultLikelihoodVolume: semblance variance (discontinuity.js
//      varianceTrace) per trace, then per time slice
//        a. lateral contrast: variance minus its local lateral mean, so a
//           uniformly incoherent zone (pure noise, dead zone) scores near
//           zero and only a LOCAL break stands out;
//        b. orientation: the structure tensor of the contrast gives the
//           local strike of the lineament and its linearity (0 isotropic
//           .. 1 a perfect line);
//        c. strike smoothing: average along the local strike, which
//           reinforces a continuous fault trace and averages random
//           speckle away; the result is weighted by linearity;
//      then a short vertical average ties the slices together.
//   2. thinFaults: non-maximum suppression along the normal to the local
//      strike, so each fault is about one cell wide on every slice.
//   3. extractFaultPatches: hysteresis threshold, 26-connected components
//      that only join voxels (and patches) of compatible strike, so two
//      faults crossing at a large angle stay separate; small or
//      vertically short patches are dropped.
//   4. patchToSticks: one stick per Nth line across the patch strike,
//      each a top-to-bottom polyline of the median fault position.
//
// Conventions: lattice index space (il, xl fractional 0-based indices,
// s = sample index increasing downward); volumes are Float32Array indexed
// (il*nXl + xl)*ns + s; nulls are NULL_VALUE (1.0e30). Strike angles are
// in LATTICE terms: strikeDeg = atan2(dXl, dIl) in degrees, folded into
// (-90, 90], so a fault running along increasing il is 0 degrees.
//
// Pure math, worker-safe, no I/O, no dependencies.

import { NULL_VALUE } from './manifest';
import { varianceTrace, makeAligner } from './discontinuity';
import { VolumeJobCancelledError } from './volumeJob';

// Module-level alias: hot loops call M.* (a bare global Math lookup is
// markedly slower inside sandboxed runners such as jest's vm context).
const M = Math;
const NULL_LIM = 1.0e29;
const isNull = (v) => !(M.abs(v) <= NULL_LIM);

/**
 * Stage defaults, each with its reason. Sample-based values assume a
 * 2-4 ms volume; detectFaults converts the ms-based ones for other rates.
 */
export const FAULT_DETECT_DEFAULTS = Object.freeze({
  /** Semblance half-window (samples). 3 at 4 ms = a 28 ms window, about
   *  one period of a 30-40 Hz wavelet: long enough to be stable, short
   *  enough to follow a fault across thin layers. */
  halfWindow: 3,
  /** Semblance trace radius. 1 = the 3x3 neighbourhood, the sharpest
   *  lateral resolution (a fault lights up about two cells). */
  radius: 1,
  /** Dip-steering lag limit (samples). Each neighbour is aligned to the
   *  centre trace by up to 3 samples (12 ms at 4 ms) before semblance, so
   *  structural dip and small velocity steps under a fault do not score;
   *  a fault throw above about 4 samples still does. */
  maxLag: 3,
  /** Lateral background radius (cells). 5 = an 11x11 box: wide enough
   *  that a one-to-two cell fault barely raises the mean, narrow enough
   *  to follow changes in data quality. */
  backgroundRadius: 5,
  /** Structure-tensor smoothing radius (cells). 2 = a 5x5 box: spans
   *  both flanks of a two-cell-wide ridge so the orientation is defined
   *  on the ridge crest itself. */
  tensorRadius: 2,
  /** Strike smoothing half-length (cells). 5 = an 11-cell (275 m at
   *  25 m bins) line: long enough to average speckle by about 3x,
   *  short enough to follow a curved fault. */
  strikeHalfLength: 5,
  /** Vertical smoothing half-length (samples). 3 at 4 ms bridges the
   *  quiet gaps between reflectors while a 60 degree fault moves well
   *  under one cell. */
  verticalHalf: 3,
  /** Hysteresis seed threshold on the thinned likelihood. */
  high: 0.3,
  /** Hysteresis growth threshold. */
  low: 0.12,
  /** Smallest patch kept (voxels). A 40-sample fault trace one cell wide
   *  across 8 lines is ~320 voxels; 150 drops speckle clusters. */
  minVoxels: 150,
  /** Shortest patch kept (samples). 25 at 4 ms = 100 ms: a fault must
   *  offset more than one reflector band to be believed. */
  minHeightSamples: 25,
  /** Largest strike difference (degrees) across which voxels or patches
   *  may join. 30 tolerates curvature and orientation noise while two
   *  faults crossing at 45 degrees or more stay separate. */
  maxAngleDeg: 30,
  /** Largest vertical gap (samples) bridged between two pieces of one
   *  fault. 40 at 4 ms = 160 ms: a fault is only visible where it offsets
   *  reflectors, so quiet intervals split it into bands. */
  maxGapSamples: 40,
  /** Two pieces are one fault when, on the lines they share, one straight
   *  depth trend fits both within 1.5 cells RMS: a staircase of reflector
   *  breaks along a dipping plane passes (its residual is about a third
   *  of the step), two parallel faults more than about 3 cells apart do
   *  not. */
  bridgeTolCells: 1.5,
  /** Stick spacing: every 8th line across the strike, the density an
   *  interpreter would draw by hand. */
  every: 8,
  /** Vertical spacing of stick points (samples). */
  stickStep: 4,
  /** Half-window (samples) of the local straight-line fit that places each
   *  stick point. A fault is only seen where it offsets a reflector, so
   *  between reflectors the thinned patch holds the last break position
   *  and steps at the next one; 32 at 4 ms (a 260 ms window) spans about
   *  two reflector bands, so the fit runs through the cutoffs the way an
   *  interpreter draws a stick, while a listric fault still bends. */
  stickFitHalfSamples: 32,
  /** Faults below this confidence are not proposed. */
  confidenceFloor: 0.35,
});

const DEG = 180 / M.PI;

function checkGeom(geom) {
  const { nIl, nXl, ns } = geom || {};
  if (!(nIl > 0 && nXl > 0 && ns > 0)) throw new Error('Fault detection needs a geometry with nIl, nXl and ns.');
  return { nIl, nXl, ns };
}

/** Box mean of a 2D slice (nIl x nXl, row = il) with radius r, edge-clipped. */
function boxMean2d(src, nIl, nXl, r, out) {
  const W = nXl + 1;
  const sat = new Float64Array((nIl + 1) * W);
  for (let i = 0; i < nIl; i++) {
    let row = 0;
    for (let j = 0; j < nXl; j++) {
      row += src[i * nXl + j];
      sat[(i + 1) * W + j + 1] = sat[i * W + j + 1] + row;
    }
  }
  for (let i = 0; i < nIl; i++) {
    const i0 = M.max(0, i - r);
    const i1 = M.min(nIl - 1, i + r) + 1;
    for (let j = 0; j < nXl; j++) {
      const j0 = M.max(0, j - r);
      const j1 = M.min(nXl - 1, j + r) + 1;
      const sum = sat[i1 * W + j1] - sat[i0 * W + j1] - sat[i1 * W + j0] + sat[i0 * W + j0];
      out[i * nXl + j] = sum / ((i1 - i0) * (j1 - j0));
    }
  }
}

/** Bilinear sample of a 2D slice, clamped to the edge. */
function bilinear(src, nIl, nXl, fi, fj) {
  const i = M.min(nIl - 1, M.max(0, fi));
  const j = M.min(nXl - 1, M.max(0, fj));
  const i0 = M.floor(i);
  const j0 = M.floor(j);
  const i1 = M.min(nIl - 1, i0 + 1);
  const j1 = M.min(nXl - 1, j0 + 1);
  const ti = i - i0;
  const tj = j - j0;
  const a = src[i0 * nXl + j0] * (1 - tj) + src[i0 * nXl + j1] * tj;
  const b = src[i1 * nXl + j0] * (1 - tj) + src[i1 * nXl + j1] * tj;
  return a * (1 - ti) + b * ti;
}

/**
 * Local strike and linearity of a 2D slice from its structure tensor.
 * The tensor of the gradient, smoothed over a (2r+1)^2 box, has its major
 * eigenvector along the gradient, which is ACROSS a ridge; the strike is
 * that direction rotated 90 degrees.
 *
 * @param {Float32Array|Float64Array} slice nIl*nXl (row = il)
 * @param {number} nIl
 * @param {number} nXl
 * @param {number} r tensor smoothing radius (cells)
 * @param {Float32Array} strikeOut radians, atan2(dXl, dIl) of the strike, in (-pi/2, pi/2]
 * @param {Float32Array} [linOut] linearity (l1 - l2)/(l1 + l2), 0..1
 */
export function sliceOrientation(slice, nIl, nXl, r, strikeOut, linOut) {
  const n = nIl * nXl;
  const jxx = new Float64Array(n);
  const jyy = new Float64Array(n);
  const jxy = new Float64Array(n);
  for (let i = 0; i < nIl; i++) {
    for (let j = 0; j < nXl; j++) {
      const ip = M.min(nIl - 1, i + 1);
      const im = M.max(0, i - 1);
      const jp = M.min(nXl - 1, j + 1);
      const jm = M.max(0, j - 1);
      const gx = (slice[ip * nXl + j] - slice[im * nXl + j]) / M.max(1, ip - im);
      const gy = (slice[i * nXl + jp] - slice[i * nXl + jm]) / M.max(1, jp - jm);
      const k = i * nXl + j;
      jxx[k] = gx * gx;
      jyy[k] = gy * gy;
      jxy[k] = gx * gy;
    }
  }
  const sxx = new Float64Array(n);
  const syy = new Float64Array(n);
  const sxy = new Float64Array(n);
  boxMean2d(jxx, nIl, nXl, r, sxx);
  boxMean2d(jyy, nIl, nXl, r, syy);
  boxMean2d(jxy, nIl, nXl, r, sxy);
  for (let k = 0; k < n; k++) {
    const a = sxx[k];
    const b = syy[k];
    const c = sxy[k];
    // angle of the major eigenvector (the gradient direction)
    const phi = 0.5 * M.atan2(2 * c, a - b);
    let strike = phi + M.PI / 2;
    if (strike > M.PI / 2) strike -= M.PI;
    strikeOut[k] = strike;
    if (linOut) {
      const tr = a + b;
      const disc = M.sqrt((a - b) * (a - b) + 4 * c * c);
      linOut[k] = tr > 1e-12 ? disc / tr : 0;
    }
  }
}


/** Smallest angle between two axial directions (radians, mod pi), degrees. */
function axialDiffDeg(a, b) {
  let d = M.abs(a - b) % M.PI;
  if (d > M.PI / 2) d = M.PI - d;
  return d * DEG;
}

/**
 * Data quality from the semblance itself: the reflector coherence, 1 minus
 * the median variance over the strongest windows (the top 30 percent by
 * power, i.e. the reflectors). Signal is coherent across the neighbourhood
 * and noise is not, so noise lowers it: on the synthetic field it reads
 * 0.96 clean, 0.88 at signal to noise 6 and 0.76 at 3 (white noise; 0.89
 * and 0.82 for band-limited noise at 6 and 3). Residual dip and wavelet
 * interference keep it a little below 1 even on clean data, so it is a
 * ranking of data quality, not a signal-to-noise ratio.
 *
 * @param {number[]} pow window power per sampled window
 * @param {number[]} vari semblance variance per sampled window
 * @returns {{coherence: number|null, windows: number}}
 */
export function estimateQuality(pow, vari) {
  const idx = [];
  for (let k = 0; k < pow.length; k++) if (pow[k] > 0) idx.push(k);
  if (idx.length < 50) return { coherence: null, windows: idx.length };
  idx.sort((a, b) => pow[b] - pow[a]);
  const top = idx.slice(0, M.max(50, M.floor(idx.length * 0.3)));
  const vs = top.map((k) => vari[k]).sort((a, b) => a - b);
  return { coherence: 1 - vs[vs.length >> 1], windows: top.length };
}

/**
 * Threshold scale for a reflector coherence: 1 (the defaults) at 0.95 and
 * above, 0.5 at 0.80 and below, linear between. Noise compresses the
 * likelihood (its peak on the synthetic fault falls from about 0.27 clean
 * to 0.10 at signal to noise 3) while the background's high tail falls
 * with it, so the fault stays about twice the background's 99.9th
 * percentile: halved thresholds find it again (every stick point within 2
 * cells at signal to noise 3) and still propose nothing in unfaulted noisy
 * data. Clean data keeps the defaults, which hold back weaker lineaments
 * such as channel edges.
 *
 * @param {number|null} coherence
 * @param {'auto'|'standard'|'high'} [sensitivity='auto']
 * @returns {number}
 */
export function thresholdScale(coherence, sensitivity = 'auto') {
  if (sensitivity === 'standard') return 1;
  if (sensitivity === 'high') return 0.5;
  if (coherence == null || !Number.isFinite(coherence)) return 1;
  const t = (coherence - 0.8) / (0.95 - 0.8);
  return 0.5 + 0.5 * M.min(1, M.max(0, t));
}

/**
 * Stage 1: fault likelihood, 0..1, from semblance variance sharpened by
 * lateral contrast and smoothed along the local strike.
 *
 * @param {Object} p
 * @param {(il:number, xl:number) => Promise<?Float32Array>|?Float32Array} p.getTrace
 *   ns samples, NULL_VALUE nulls; null/undefined for a missing trace
 * @param {{nIl:number, nXl:number, ns:number}} p.geom
 * @param {number} [p.halfWindow=3] semblance half-window (samples)
 * @param {number} [p.radius=1] semblance trace radius
 * @param {number} [p.maxLag=3] dip-steering lag limit (samples)
 * @param {number} [p.backgroundRadius=5] lateral background radius (cells)
 * @param {number} [p.tensorRadius=2] structure-tensor radius (cells)
 * @param {number} [p.strikeHalfLength=5] strike smoothing half-length (cells)
 * @param {number} [p.verticalHalf=3] vertical smoothing half-length (samples)
 * @param {(il:number, xl:number) => Promise<?Float32Array>|?Float32Array} [p.getVarianceTrace]
 *   instead of getTrace: a precomputed variance volume (0..1, e.g. the
 *   Variance attribute), which replaces the dip-steered semblance; data
 *   quality is then unknown (qualityOut.coherence stays null)
 * @param {Object} [p.qualityOut] receives {coherence, windows} (estimateQuality)
 * @param {(done:number, total:number, phase:string) => void} [p.onProgress]
 * @param {() => boolean} [p.shouldCancel] polled per inline and per slice
 * @returns {Promise<Float32Array>} nIl*nXl*ns, index (il*nXl + xl)*ns + s
 */
export async function faultLikelihoodVolume({
  getTrace, getVarianceTrace, geom,
  halfWindow = FAULT_DETECT_DEFAULTS.halfWindow,
  radius = FAULT_DETECT_DEFAULTS.radius,
  maxLag = FAULT_DETECT_DEFAULTS.maxLag,
  backgroundRadius = FAULT_DETECT_DEFAULTS.backgroundRadius,
  tensorRadius = FAULT_DETECT_DEFAULTS.tensorRadius,
  strikeHalfLength = FAULT_DETECT_DEFAULTS.strikeHalfLength,
  verticalHalf = FAULT_DETECT_DEFAULTS.verticalHalf,
  qualityOut = null,
  onProgress, shouldCancel,
}) {
  const { nIl, nXl, ns } = checkGeom(geom);
  if (typeof getTrace !== 'function' && typeof getVarianceTrace !== 'function') {
    throw new Error('Fault detection needs a getTrace or a getVarianceTrace function.');
  }
  const r = M.max(1, M.floor(radius));
  const nTr = nIl * nXl;
  const { variance, lateral } = getVarianceTrace
    ? await readVarianceVolume({ getVarianceTrace, nIl, nXl, ns, onProgress, shouldCancel })
    : await semblanceVolume({
      getTrace, nIl, nXl, ns, r, halfWindow, maxLag, qualityOut, onProgress, shouldCancel,
    });
  if (qualityOut && getVarianceTrace) Object.assign(qualityOut, { coherence: null, windows: 0 });
  return likelihoodFromVariance({
    variance, lateral, nIl, nXl, ns, backgroundRadius, tensorRadius, strikeHalfLength, verticalHalf, onProgress, shouldCancel,
  });
}

/** Variance volume read from a precomputed attribute (nulls = 0, clamped 0..1). */
async function readVarianceVolume({
  getVarianceTrace, nIl, nXl, ns, onProgress, shouldCancel,
}) {
  const nTr = nIl * nXl;
  const variance = new Float32Array(nTr * ns);
  for (let il = 0; il < nIl; il++) {
    if (shouldCancel && shouldCancel()) throw new VolumeJobCancelledError();
    for (let xl = 0; xl < nXl; xl++) {
      const tr = await getVarianceTrace(il, xl);
      if (!tr) continue;
      const base = (il * nXl + xl) * ns;
      for (let s = 0; s < ns && s < tr.length; s++) {
        const v = tr[s];
        variance[base + s] = isNull(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
    if (onProgress) onProgress(il + 1, nIl, 'read');
  }
  return { variance, lateral: new Float32Array(nTr * ns) };
}

/** Stage 1a: every trace read once, then dip-steered semblance variance. */
async function semblanceVolume({
  getTrace, nIl, nXl, ns, r, halfWindow, maxLag, qualityOut, onProgress, shouldCancel,
}) {
  const nTr = nIl * nXl;

  // 1. read every trace once (the volume is held as one cube)
  const cube = new Float32Array(nTr * ns).fill(M.fround(NULL_VALUE));
  const live = new Uint8Array(nTr);
  for (let il = 0; il < nIl; il++) {
    if (shouldCancel && shouldCancel()) throw new VolumeJobCancelledError();
    for (let xl = 0; xl < nXl; xl++) {
      const tr = await getTrace(il, xl);
      if (!tr) continue;
      const base = (il * nXl + xl) * ns;
      let any = false;
      for (let s = 0; s < ns && s < tr.length; s++) {
        cube[base + s] = tr[s];
        if (!isNull(tr[s])) any = true;
      }
      live[il * nXl + xl] = any ? 1 : 0;
    }
    if (onProgress) onProgress(il + 1, nIl, 'read');
  }

  // 2. dip-steered semblance variance per trace (nulls become 0: no evidence)
  const variance = new Float32Array(nTr * ns);
  const outTr = new Float32Array(ns);
  // data quality: (window power, variance, neighbourhood size) samples
  const qStride = M.max(1, M.ceil((nTr * ns) / 300000));
  const qPow = [];
  const qVar = [];
  const winPow = new Float64Array(ns + 1);
  const aligner = makeAligner(ns, halfWindow, maxLag);
  for (let il = 0; il < nIl; il++) {
    if (shouldCancel && shouldCancel()) throw new VolumeJobCancelledError();
    for (let xl = 0; xl < nXl; xl++) {
      if (!live[il * nXl + xl]) continue;
      const b0 = (il * nXl + xl) * ns;
      const center = cube.subarray(b0, b0 + ns);
      const hood = [];
      for (let di = -r; di <= r; di++) {
        for (let dj = -r; dj <= r; dj++) {
          const i = il + di;
          const j = xl + dj;
          if (i < 0 || j < 0 || i >= nIl || j >= nXl || !live[i * nXl + j]) continue;
          const b = (i * nXl + j) * ns;
          const tr = cube.subarray(b, b + ns);
          hood.push(di === 0 && dj === 0 ? tr : aligner(center, tr));
        }
      }
      varianceTrace(center, hood, halfWindow, outTr);
      for (let s = 0; s < ns; s++) variance[b0 + s] = isNull(outTr[s]) ? 0 : outTr[s];
      if (qualityOut) {
        for (let s = 0; s < ns; s++) {
          const v = center[s];
          winPow[s + 1] = winPow[s] + (isNull(v) ? 0 : v * v);
        }
        for (let s = (b0 % qStride); s < ns; s += qStride) {
          if (isNull(outTr[s])) continue;
          const w0 = M.max(0, s - halfWindow);
          const w1 = M.min(ns, s + halfWindow + 1);
          qPow.push((winPow[w1] - winPow[w0]) / (w1 - w0));
          qVar.push(outTr[s]);
        }
      }
    }
    if (onProgress) onProgress(il + 1, nIl, 'variance');
  }

  if (qualityOut) Object.assign(qualityOut, estimateQuality(qPow, qVar));
  // the trace cube's memory is reused for the lateral result
  return { variance, lateral: cube };
}

/** Stage 1b: lateral contrast, orientation, strike smoothing, vertical average. */
function likelihoodFromVariance({
  variance, lateral, nIl, nXl, ns, backgroundRadius, tensorRadius, strikeHalfLength, verticalHalf, onProgress, shouldCancel,
}) {
  const nTr = nIl * nXl;
  // 3. per slice: contrast, orientation, strike smoothing
  const slice = new Float32Array(nTr);
  const bg = new Float32Array(nTr);
  const strike = new Float32Array(nTr);
  const lin = new Float32Array(nTr);
  const L = M.max(0, M.floor(strikeHalfLength));
  for (let s = 0; s < ns; s++) {
    if (shouldCancel && s % 16 === 0 && shouldCancel()) throw new VolumeJobCancelledError();
    for (let k = 0; k < nTr; k++) slice[k] = variance[k * ns + s];
    boxMean2d(slice, nIl, nXl, M.max(1, backgroundRadius), bg);
    for (let k = 0; k < nTr; k++) {
      const c = slice[k] - bg[k];
      slice[k] = c > 0 ? c : 0;
    }
    sliceOrientation(slice, nIl, nXl, M.max(1, tensorRadius), strike, lin);
    for (let il = 0; il < nIl; il++) {
      for (let xl = 0; xl < nXl; xl++) {
        const k = il * nXl + xl;
        const ci = M.cos(strike[k]);
        const cj = M.sin(strike[k]);
        let sum = 0;
        for (let t = -L; t <= L; t++) sum += bilinear(slice, nIl, nXl, il + t * ci, xl + t * cj);
        lateral[k * ns + s] = (sum / (2 * L + 1)) * lin[k];
      }
    }
    if (onProgress && s % 16 === 0) onProgress(s + 1, ns, 'slices');
  }

  // 4. vertical box average, scaled to 0..1
  const V = M.max(0, M.floor(verticalHalf));
  const out = variance; // reuse
  for (let k = 0; k < nTr; k++) {
    const b = k * ns;
    let acc = 0;
    let cnt = 0;
    for (let s = 0; s < M.min(ns, V); s++) { acc += lateral[b + s]; cnt++; }
    for (let s = 0; s < ns; s++) {
      if (s + V < ns) { acc += lateral[b + s + V]; cnt++; }
      if (s - V - 1 >= 0) { acc -= lateral[b + s - V - 1]; cnt--; }
      const v = acc / cnt;
      out[b + s] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
  if (onProgress) onProgress(ns, ns, 'done');
  return out;
}

/** A precomputed fault likelihood volume (the Fault likelihood attribute):
 *  nulls = 0, clamped 0..1. */
async function readLikelihoodVolume({
  getLikelihoodTrace, geom, onProgress, shouldCancel,
}) {
  const { nIl, nXl, ns } = geom;
  const out = new Float32Array(nIl * nXl * ns);
  for (let il = 0; il < nIl; il++) {
    if (shouldCancel && shouldCancel()) throw new VolumeJobCancelledError();
    for (let xl = 0; xl < nXl; xl++) {
      const tr = await getLikelihoodTrace(il, xl);
      if (!tr) continue;
      const base = (il * nXl + xl) * ns;
      for (let s = 0; s < ns && s < tr.length; s++) {
        const v = tr[s];
        out[base + s] = isNull(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
      }
    }
    if (onProgress) onProgress(il + 1, nIl, 'read');
  }
  return out;
}

/**
 * Stage 2: non-maximum suppression across strike on every time slice. A
 * voxel survives only if it is at least as large as both neighbours one
 * cell away along the normal to the local strike (bilinear), so a fault
 * ridge is reduced to its crest, about one cell wide.
 *
 * @param {Float32Array} likelihood from faultLikelihoodVolume
 * @param {{nIl:number, nXl:number, ns:number}} geom
 * @param {Object} [opts]
 * @param {number} [opts.tensorRadius=2] structure-tensor radius (cells)
 * @param {number} [opts.floor=0.02] values at or below are dropped outright
 * @param {Float32Array} [opts.orientationOut] if given (nIl*nXl*ns), receives
 *   the local strike (radians, lattice) of every voxel for extractFaultPatches
 * @returns {Float32Array} thinned likelihood (0 where suppressed)
 */
export function thinFaults(likelihood, geom, opts = {}) {
  const { nIl, nXl, ns } = checkGeom(geom);
  const tensorRadius = opts.tensorRadius ?? FAULT_DETECT_DEFAULTS.tensorRadius;
  const floor = opts.floor ?? 0.02;
  const nTr = nIl * nXl;
  const out = new Float32Array(nTr * ns);
  const slice = new Float32Array(nTr);
  const strike = new Float32Array(nTr);
  for (let s = 0; s < ns; s++) {
    let any = false;
    for (let k = 0; k < nTr; k++) {
      slice[k] = likelihood[k * ns + s];
      if (slice[k] > floor) any = true;
    }
    if (!any) continue;
    sliceOrientation(slice, nIl, nXl, M.max(1, tensorRadius), strike);
    for (let il = 0; il < nIl; il++) {
      for (let xl = 0; xl < nXl; xl++) {
        const k = il * nXl + xl;
        const v = slice[k];
        if (!(v > floor)) continue;
        const ni = -M.sin(strike[k]);
        const nj = M.cos(strike[k]);
        const a = bilinear(slice, nIl, nXl, il + ni, xl + nj);
        const b = bilinear(slice, nIl, nXl, il - ni, xl - nj);
        if (v >= a && v >= b) {
          out[k * ns + s] = v;
          if (opts.orientationOut) opts.orientationOut[k * ns + s] = strike[k];
        }
      }
    }
  }
  return out;
}

/** Union-find with per-root orientation sums (doubled angle). */
function makeUnionFind(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const cnt = new Float64Array(n).fill(1);
  const c2 = new Float64Array(n);
  const s2 = new Float64Array(n);
  const find = (a) => {
    let x = a;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  return { parent, cnt, c2, s2, find };
}

/**
 * Stage 3: hysteresis, orientation-aware 26-connected components, size
 * and height filters.
 *
 * @param {Float32Array} thinned from thinFaults
 * @param {{nIl:number, nXl:number, ns:number}} geom
 * @param {Object} [opts]
 * @param {number} [opts.high=0.3] seed threshold
 * @param {number} [opts.low=0.12] growth threshold
 * @param {number} [opts.minVoxels=150]
 * @param {number} [opts.minHeightSamples=25]
 * @param {number} [opts.maxAngleDeg=30] largest strike difference to join
 * @param {Float32Array} [opts.orientation] per-voxel strike from thinFaults;
 *   recomputed from the thinned volume when absent
 * @param {number} [opts.maxGapSamples=40] largest vertical gap bridged
 * @param {number} [opts.bridgeTolCells=1.5] RMS residual allowed when bridging
 * @param {number} [opts.patchCheckVoxels=30] patches this large join only if
 *   their MEAN strikes are also compatible (stops a chain of small angle
 *   steps through a fault crossing from welding two faults together)
 * @returns {Array<{voxels:Int32Array, stats:{voxels:number, heightSamples:number,
 *   sTop:number, sBase:number, strikeDeg:number, dipIndicator:number,
 *   meanLikelihood:number}}>} largest first
 */
export function extractFaultPatches(thinned, geom, opts = {}) {
  const { nIl, nXl, ns } = checkGeom(geom);
  const high = opts.high ?? FAULT_DETECT_DEFAULTS.high;
  const low = opts.low ?? FAULT_DETECT_DEFAULTS.low;
  const minVoxels = opts.minVoxels ?? FAULT_DETECT_DEFAULTS.minVoxels;
  const minHeight = opts.minHeightSamples ?? FAULT_DETECT_DEFAULTS.minHeightSamples;
  const maxAngle = opts.maxAngleDeg ?? FAULT_DETECT_DEFAULTS.maxAngleDeg;
  const patchCheck = opts.patchCheckVoxels ?? 30;
  const maxGap = opts.maxGapSamples ?? FAULT_DETECT_DEFAULTS.maxGapSamples;
  const tolCells = opts.bridgeTolCells ?? FAULT_DETECT_DEFAULTS.bridgeTolCells;
  let orient = opts.orientation;
  if (!orient) {
    orient = new Float32Array(thinned.length);
    thinFaults(thinned, geom, { orientationOut: orient, floor: 0 });
  }

  // candidate voxels (above low), compacted
  const idxOf = new Map();
  const vox = [];
  for (let v = 0; v < thinned.length; v++) {
    if (thinned[v] > low) {
      idxOf.set(v, vox.length);
      vox.push(v);
    }
  }
  const n = vox.length;
  const uf = makeUnionFind(n);
  for (let a = 0; a < n; a++) {
    const th = 2 * orient[vox[a]];
    uf.c2[a] = M.cos(th);
    uf.s2[a] = M.sin(th);
  }
  const meanAngle = (root) => 0.5 * M.atan2(uf.s2[root], uf.c2[root]);

  // forward half of the 26-neighbourhood
  const offs = [];
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      for (let ds = -1; ds <= 1; ds++) {
        const lin = (di * nXl + dj) * ns + ds;
        if (lin > 0) offs.push([di, dj, ds]);
      }
    }
  }
  for (let a = 0; a < n; a++) {
    const v = vox[a];
    const s = v % ns;
    const k = (v - s) / ns;
    const xl = k % nXl;
    const il = (k - xl) / nXl;
    for (const [di, dj, ds] of offs) {
      const i = il + di;
      const j = xl + dj;
      const t = s + ds;
      if (i < 0 || j < 0 || t < 0 || i >= nIl || j >= nXl || t >= ns) continue;
      const w = (i * nXl + j) * ns + t;
      const b = idxOf.get(w);
      if (b === undefined) continue;
      if (axialDiffDeg(orient[v], orient[w]) > maxAngle) continue;
      const ra = uf.find(a);
      const rb = uf.find(b);
      if (ra === rb) continue;
      if (uf.cnt[ra] >= patchCheck && uf.cnt[rb] >= patchCheck
        && axialDiffDeg(meanAngle(ra), meanAngle(rb)) > maxAngle) continue;
      const [big, small] = uf.cnt[ra] >= uf.cnt[rb] ? [ra, rb] : [rb, ra];
      uf.parent[small] = big;
      uf.cnt[big] += uf.cnt[small];
      uf.c2[big] += uf.c2[small];
      uf.s2[big] += uf.s2[small];
    }
  }

  // group, keep components holding a seed
  const groups = new Map();
  for (let a = 0; a < n; a++) {
    const r = uf.find(a);
    let g = groups.get(r);
    if (!g) {
      g = { list: [], seed: false };
      groups.set(r, g);
    }
    g.list.push(vox[a]);
    if (thinned[vox[a]] > high) g.seed = true;
  }
  // pieces: seeded components big enough to measure (a quarter of
  // minVoxels), then bridged across the quiet gaps between reflectors
  let pieces = [];
  for (const g of groups.values()) {
    if (!g.seed || g.list.length < M.max(10, minVoxels / 4)) continue;
    pieces.push({ list: g.list, stats: patchStats(g.list, thinned, geom) });
  }
  pieces = bridgePieces(pieces, thinned, geom, { maxAngle, maxGap, tolCells });
  const patches = [];
  for (const p of pieces) {
    if (p.list.length < minVoxels || p.stats.heightSamples < minHeight) continue;
    patches.push({ voxels: Int32Array.from(p.list), stats: p.stats });
  }
  patches.sort((a, b) => b.stats.voxels - a.stats.voxels);
  return patches;
}

/**
 * Patch statistics. Strike comes from the covariance of the (il, xl)
 * positions pooled over slices AFTER removing each slice's centroid, so
 * the fault's lateral migration with depth (its dip) does not tilt the
 * strike estimate. dipIndicator is the least-squares slope (cells per
 * sample) of the position along the strike normal, n = (-sin, cos) of
 * the strike, against s: positive means the fault moves toward +n with
 * depth.
 */
function patchStats(list, lik, geom) {
  const { nXl, ns } = geom;
  const bySlice = new Map();
  let sumL = 0;
  let sTop = Infinity;
  let sBase = -Infinity;
  for (const v of list) {
    const s = v % ns;
    const k = (v - s) / ns;
    const xl = k % nXl;
    const il = (k - xl) / nXl;
    sumL += lik[v];
    if (s < sTop) sTop = s;
    if (s > sBase) sBase = s;
    let e = bySlice.get(s);
    if (!e) {
      e = [];
      bySlice.set(s, e);
    }
    e.push(il, xl);
  }
  let cii = 0;
  let cjj = 0;
  let cij = 0;
  for (const e of bySlice.values()) {
    const m = e.length / 2;
    if (m < 2) continue;
    let mi = 0;
    let mj = 0;
    for (let q = 0; q < e.length; q += 2) { mi += e[q]; mj += e[q + 1]; }
    mi /= m;
    mj /= m;
    for (let q = 0; q < e.length; q += 2) {
      const di = e[q] - mi;
      const dj = e[q + 1] - mj;
      cii += di * di;
      cjj += dj * dj;
      cij += di * dj;
    }
  }
  let strike = 0.5 * M.atan2(2 * cij, cii - cjj);
  if (strike > M.PI / 2) strike -= M.PI;
  if (strike <= -M.PI / 2) strike += M.PI;
  const ni = -M.sin(strike);
  const nj = M.cos(strike);
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let m = 0;
  for (const v of list) {
    const s = v % ns;
    const k = (v - s) / ns;
    const xl = k % nXl;
    const il = (k - xl) / nXl;
    const u = il * ni + xl * nj;
    sx += s;
    sy += u;
    sxx += s * s;
    sxy += s * u;
    m++;
  }
  const den = m * sxx - sx * sx;
  const dip = den > 0 ? (m * sxy - sx * sy) / den : 0;
  return {
    voxels: list.length,
    heightSamples: sBase - sTop + 1,
    sTop,
    sBase,
    strikeDeg: strike * DEG,
    dipIndicator: dip,
    meanLikelihood: sumL / list.length,
  };
}

/**
 * Per-line moment sums of a piece: line (inline if |strike| <= 45
 * degrees, else crossline) -> sums of s and of the lateral position.
 */
function lineMoments(list, geom, onInline) {
  const { nXl, ns } = geom;
  const acc = new Map();
  for (const v of list) {
    const s = v % ns;
    const k = (v - s) / ns;
    const xl = k % nXl;
    const il = (k - xl) / nXl;
    const line = onInline ? il : xl;
    const lat = onInline ? xl : il;
    let e = acc.get(line);
    if (!e) {
      e = {
        n: 0, s: 0, l: 0, ss: 0, sl: 0, ll: 0,
      };
      acc.set(line, e);
    }
    e.n++; e.s += s; e.l += lat; e.ss += s * s; e.sl += s * lat; e.ll += lat * lat;
  }
  return acc;
}

/** RMS residual (cells) of the least-squares line lat = a + b*s through
 *  the combined moments of two pieces on one line. */
function unionRms(ea, eb) {
  const n = ea.n + eb.n;
  const ms = (ea.s + eb.s) / n;
  const ml = (ea.l + eb.l) / n;
  const vss = ea.ss + eb.ss - n * ms * ms;
  const vsl = ea.sl + eb.sl - n * ms * ml;
  const vll = ea.ll + eb.ll - n * ml * ml;
  const sse = vss > 1e-9 ? vll - (vsl * vsl) / vss : vll;
  return M.sqrt(M.max(0, sse) / n);
}

/**
 * Merge pieces of one fault. In a time slice a fault shows only where it
 * offsets a reflector, and each reflector breaks at the plane position of
 * its own depth, so a dipping fault arrives as a staircase of vertical
 * pieces. Two pieces join when their mean strikes are compatible, their
 * vertical gap is at most maxGap (overlap allowed), they share at least 3
 * lines, and on those lines ONE straight trend (lat = a + b*s) fits the
 * union with a mean RMS residual of at most tolCells. A staircase along a
 * plane fits a line; two parallel faults side by side do not. Repeats
 * until nothing merges.
 */
function bridgePieces(pieces, lik, geom, { maxAngle, maxGap, tolCells }) {
  const list = pieces;
  let merged = true;
  while (merged && list.length > 1) {
    merged = false;
    list.sort((a, b) => b.list.length - a.list.length);
    const mom = list.map((p) => {
      const onInline = M.abs(p.stats.strikeDeg) <= 45;
      return { onInline, lines: lineMoments(p.list, geom, onInline) };
    });
    outer:
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a].stats;
        const B = list[b].stats;
        if (axialDiffDeg(A.strikeDeg / DEG, B.strikeDeg / DEG) > maxAngle) continue;
        if (mom[a].onInline !== mom[b].onInline) continue;
        const gap = M.max(A.sTop, B.sTop) - M.min(A.sBase, B.sBase);
        if (gap > maxGap) continue;
        let shared = 0;
        let rsum = 0;
        for (const [line, ea] of mom[a].lines) {
          const eb = mom[b].lines.get(line);
          if (!eb) continue;
          shared++;
          rsum += unionRms(ea, eb);
        }
        if (shared < 3 || rsum / shared > tolCells) continue;
        const joined = list[a].list.concat(list[b].list);
        list[a] = { list: joined, stats: patchStats(joined, lik, geom) };
        list.splice(b, 1);
        merged = true;
        break outer;
      }
    }
  }
  return list;
}

const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  const h = a.length >> 1;
  return a.length % 2 ? a[h] : 0.5 * (a[h - 1] + a[h]);
};

/**
 * Stage 4: sticks from a patch. The patch is cut by every Nth line ACROSS
 * its strike: inlines (constant il) when the fault runs mostly along il
 * (|strike| <= 45 degrees), crosslines otherwise. On each line the patch
 * gives one median lateral position per sample; stick points every `step`
 * samples from the patch top to its base are placed by a local
 * least-squares line through those positions (half-window fitHalfSamples),
 * so the stick is a top-to-bottom polyline with strictly increasing s.
 *
 * Confidence (0..1) = likelihood term x size term:
 *   clamp((meanLikelihood - low) / (high - low), 0, 1) x (1 - exp(-voxels / 1500)),
 * the likelihood term placing the patch's mean response between the
 * growth and seed thresholds, the size term saturating for a patch of a
 * few thousand voxels, so a patch needs both a strong and a large
 * response to score high.
 *
 * @param {{voxels:Int32Array, stats:Object}} patch
 * @param {{nIl:number, nXl:number, ns:number}} geom
 * @param {Object} [opts]
 * @param {number} [opts.every=8] line spacing
 * @param {'auto'|'inline'|'crossline'} [opts.orientation='auto']
 * @param {number} [opts.step=4] vertical point spacing (samples)
 * @param {number} [opts.fitHalfSamples=32] local line-fit half-window (samples)
 * @param {number} [opts.trimSamples=6] samples cut from each stick's top and
 *   base: halfWindow + verticalHalf, the vertical smear of the likelihood
 * @param {number} [opts.high=0.3] extraction seed threshold (confidence scale)
 * @param {number} [opts.low=0.12] extraction growth threshold (confidence scale)
 * @returns {{sticks: Array<{line:'inline'|'crossline', index:number,
 *   points:{il:number, xl:number, s:number}[]}>, confidence:number}}
 */
export function patchToSticks(patch, geom, opts = {}) {
  const { nXl, ns } = checkGeom(geom);
  const every = M.max(1, M.floor(opts.every ?? FAULT_DETECT_DEFAULTS.every));
  const step = M.max(1, M.floor(opts.step ?? FAULT_DETECT_DEFAULTS.stickStep));
  const high = opts.high ?? FAULT_DETECT_DEFAULTS.high;
  const low = opts.low ?? FAULT_DETECT_DEFAULTS.low;
  const fitHalf = M.max(1, opts.fitHalfSamples ?? FAULT_DETECT_DEFAULTS.stickFitHalfSamples);
  const trim = M.max(0, opts.trimSamples
    ?? FAULT_DETECT_DEFAULTS.halfWindow + FAULT_DETECT_DEFAULTS.verticalHalf);
  let orientation = opts.orientation ?? 'auto';
  if (orientation === 'auto') {
    orientation = M.abs(patch.stats.strikeDeg) <= 45 ? 'inline' : 'crossline';
  }
  const onInline = orientation === 'inline';

  // line index -> s -> lateral positions
  const lines = new Map();
  let lo = Infinity;
  for (const v of patch.voxels) {
    const s = v % ns;
    const k = (v - s) / ns;
    const xl = k % nXl;
    const il = (k - xl) / nXl;
    const line = onInline ? il : xl;
    if (line < lo) lo = line;
    let m = lines.get(line);
    if (!m) {
      m = new Map();
      lines.set(line, m);
    }
    let e = m.get(s);
    if (!e) {
      e = [];
      m.set(s, e);
    }
    e.push(onInline ? xl : il);
  }
  const latMax = (onInline ? nXl : geom.nIl) - 1;
  const sticks = [];
  const keys = [...lines.keys()].sort((x, y) => x - y);
  for (const line of keys) {
    if ((line - lo) % every !== 0) continue;
    // one median position per sample, then a local straight-line fit
    const rows = [...lines.get(line).entries()].sort((x, y) => x[0] - y[0])
      .map(([sv, lats]) => [sv, median(lats)]);
    if (rows.length < 3) continue;
    // the semblance window and the vertical average smear the response
    // `trim` samples beyond the real evidence at both ends
    const sTop = rows[0][0] + trim;
    const sBase = rows[rows.length - 1][0] - trim;
    if (sBase - sTop < 2 * step) continue;
    const targets = [];
    for (let t = sTop; t < sBase; t += step) targets.push(t);
    targets.push(sBase);
    if (targets.length < 3) continue;
    const points = targets.map((t) => {
      // full-width window even at the ends (centre clamped inside the
      // stick, the line extrapolated), so the top and base follow the
      // trend instead of the last flat step
      const c = sBase - sTop > 2 * fitHalf ? M.min(sBase - fitHalf, M.max(sTop + fitHalf, t)) : 0.5 * (sTop + sBase);
      let n = 0;
      let ss = 0;
      let sl = 0;
      let sss = 0;
      let ssl = 0;
      for (const [sv, lat] of rows) {
        if (M.abs(sv - c) > fitHalf) continue;
        n++; ss += sv; sl += lat; sss += sv * sv; ssl += sv * lat;
      }
      let lat;
      if (n === 0) {
        lat = rows.reduce((q, r) => (M.abs(r[0] - t) < M.abs(q[0] - t) ? r : q))[1];
      } else {
        const ms = ss / n;
        const ml = sl / n;
        const vss = sss - n * ms * ms;
        lat = n >= 3 && vss > 1e-9 ? ml + ((ssl - n * ms * ml) / vss) * (t - ms) : ml;
      }
      lat = M.min(latMax, M.max(0, lat));
      return onInline ? { il: line, xl: lat, s: t } : { il: lat, xl: line, s: t };
    });
    sticks.push({ line: orientation, index: line, points });
  }
  const likTerm = M.min(1, M.max(0, (patch.stats.meanLikelihood - low) / M.max(1e-6, high - low)));
  const sizeTerm = 1 - M.exp(-patch.stats.voxels / 1500);
  return { sticks, confidence: likTerm * sizeTerm };
}

/**
 * Whole pipeline: likelihood, thinning, extraction, sticks. Faults are
 * named Auto-1, Auto-2, ... by descending patch size; those below
 * params.confidenceFloor or with fewer than two sticks are not proposed.
 *
 * @param {Object} p
 * @param {Function} [p.getTrace] see faultLikelihoodVolume (the seismic)
 * @param {Function} [p.getVarianceTrace] instead: a variance volume, which
 *   replaces the dip-steered semblance (see faultLikelihoodVolume)
 * @param {Function} [p.getLikelihoodTrace] instead: a fault likelihood
 *   volume (the Fault likelihood attribute), which replaces stage 1; data
 *   quality is unknown with either, so params.sensitivity decides
 *   ('auto' then means 'standard')
 * @param {{nIl:number, nXl:number, ns:number}} p.geom
 * @param {number} [p.dtMs=4] sample rate; when params.windowMs or
 *   params.minHeightMs are given they are converted to samples with it
 * @param {Object} [p.params] any FAULT_DETECT_DEFAULTS key, plus windowMs,
 *   minHeightMs and sensitivity ('auto' | 'standard' | 'high'): auto scales
 *   the default high and low thresholds by thresholdScale(coherence); an
 *   explicit high or low is used as given
 * @param {Function} [p.onProgress]
 * @param {Function} [p.shouldCancel]
 * @returns {Promise<{likelihood: Float32Array, faults: Array<{name:string,
 *   sticks:Array, confidence:number, stats:Object}>, patches: Array<{voxels:
 *   Int32Array, stats:Object}>, params:Object, quality: {coherence: number|null,
 *   thresholdScale: number, sensitivity: string}}>} patches[k] is the voxel
 *   patch behind faults[k] (kept apart so faults stay small and jsonb-friendly)
 */
export async function detectFaults({
  getTrace, getVarianceTrace, getLikelihoodTrace, geom, dtMs = 4, params = {}, onProgress, shouldCancel,
}) {
  const P = { ...FAULT_DETECT_DEFAULTS, ...params };
  if (params.windowMs != null) P.halfWindow = M.max(1, M.round(params.windowMs / 2 / dtMs));
  if (params.minHeightMs != null) P.minHeightSamples = M.max(1, M.round(params.minHeightMs / dtMs));
  const quality = {};
  const likelihood = getLikelihoodTrace
    ? await readLikelihoodVolume({
      getLikelihoodTrace, geom: checkGeom(geom), onProgress, shouldCancel,
    })
    : await faultLikelihoodVolume({
      getTrace: getVarianceTrace ? undefined : getTrace,
      getVarianceTrace,
      geom,
      ...P,
      qualityOut: quality,
      onProgress,
      shouldCancel,
    });
  // noisy data: the thresholds follow the data's own coherence unless the
  // caller set them
  const scale = thresholdScale(quality.coherence, params.sensitivity ?? 'auto');
  if (params.high == null) P.high = FAULT_DETECT_DEFAULTS.high * scale;
  if (params.low == null) P.low = FAULT_DETECT_DEFAULTS.low * scale;
  const orientation = new Float32Array(likelihood.length);
  const thinned = thinFaults(likelihood, geom, { tensorRadius: P.tensorRadius, orientationOut: orientation });
  const patches = extractFaultPatches(thinned, geom, { ...P, orientation });
  const faults = [];
  const kept = [];
  for (const patch of patches) {
    const { sticks, confidence } = patchToSticks(patch, geom, {
      every: P.every, step: P.stickStep, fitHalfSamples: P.stickFitHalfSamples,
      trimSamples: P.halfWindow + P.verticalHalf,
      high: P.high,
      low: P.low,
    });
    if (confidence < P.confidenceFloor || sticks.length < 2) continue;
    faults.push({
      name: `Auto-${faults.length + 1}`, sticks, confidence, stats: patch.stats,
    });
    kept.push(patch);
  }
  return {
    likelihood, faults, patches: kept, params: P,
    quality: {
      coherence: quality.coherence ?? null, thresholdScale: scale, sensitivity: params.sensitivity ?? 'auto',
    },
  };
}
