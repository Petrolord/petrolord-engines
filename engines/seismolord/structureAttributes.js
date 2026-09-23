// Structure attributes (Seismolord new attributes programme, engines first
// with oracles): Sobel edge, and the gradient structure tensor family
// (dip magnitude, dip azimuth, chaos, most positive and most negative
// curvature). All are REGIONAL entries of DISCONTINUITY_DEFS: they run a
// brick column at a time through runNeighborhoodJob, each column computed
// over the block plus a halo (structureHalo) wide enough that every output
// cell equals a whole-volume run (gate: seismolord.structure test).
//
// Recipe (pinned by the numpy oracle test-data/seismolord/structure/
// gen_structure.py and its structure_golden.json; the oracle implements
// it independently, vectorised):
//
// Missing data. A sample is missing when it lies outside the survey, when
// its trace is absent or dead, or when it is null (|v| > 1e29). Output is
// NULL_VALUE wherever the centre sample is null.
//
// Half windows. hw = floor(windowMs / 2 / dtMs + 0.5) (round half up; the
// oracle uses the same, not Python's banker's rounding).
//
// 1. edge. Per time slice, 3x3 Sobel in il and xl, normalised by 8 so the
//    value is a gradient per trace:
//      gi = sum_dj w[dj] (f(il+1, xl+dj) - f(il-1, xl+dj)) / 8, w = 1, 2, 1
//    and gx likewise. A neighbour outside the survey takes the value at the
//    nearest survey cell (replicate padding at the SURVEY edge only); a
//    neighbour that is then null or dead takes the CENTRE sample's value
//    (decision: nulls must not fabricate gradients, and the centre is the
//    only value guaranteed to exist). value = sqrt(mean of (gi^2 + gx^2)
//    over the live samples of [t-hw, t+hw] clipped to the trace). hw may be
//    0 (single sample). Unit amp/trace.
//
// 2. Structure tensor (dip, azimuth, chaos, curvature). Gradients by
//    central differences along il, xl and t; one-sided where only one
//    neighbour exists (survey edge, null or dead neighbour); 0 along an
//    axis with neither; the whole gradient is 0 where the centre is null.
//    T = g g^T averaged over the (2r+1)^2 traces x (2hw+1) samples box
//    about the sample, clipped to the survey, the mean taken over the LIVE
//    (non-null) samples in the box. Eigen-decomposition by cyclic Jacobi,
//    lambda1 >= lambda2 >= lambda3. The tensor is ZERO when its trace is
//    exactly 0 (every gradient in the box is zero).
//
// 3. dip. The reflector normal is the lambda1 eigenvector v = (vi, vx, vt);
//    time dips p = -vi/vt, q = -vx/vt in samples per trace (a reflector
//    t = t0 + p il + q xl has normal proportional to (-p, -q, 1)). A zero
//    tensor gives p = q = 0. CAP (decision): a normal steeper than
//    DIP_CAP = 20 samples per trace (|vt| * 20 < hypot(vi, vx), including
//    vt = 0) keeps its direction and is scaled to magnitude 20, the sign
//    of vt taken as + when vt is 0. value = hypot(p, q) * dtMs, ms/trace.
//
// 4. azimuth. Down-dip direction in the LATTICE frame: atan2(q, p) in
//    degrees, [0, 360), measured from the +inline-index axis toward the
//    +crossline-index axis. Null for a zero tensor or when
//    hypot(p, q) < AZIMUTH_MIN_DIP = 1e-6 samples per trace (the direction
//    of a zero vector is undefined).
//
// 4b. azimuth_north. The same down-dip direction on the MAP: the time
//    gradient (p, q) per index step becomes a gradient per metre through
//    the survey affine (world = origin + il * ilVec + xl * xlVec), whose
//    Jacobian J has columns ilVec and xlVec: G = J^-T (p, q). Unequal
//    inline and crossline spacing and a skewed grid are therefore
//    honoured, which the lattice angle is not. Value: atan2(Gx, Gy) in
//    degrees, [0, 360), clockwise from grid north (+Y of the projected
//    coordinates; true north differs by the CRS's meridian convergence).
//    Null exactly where azimuth is null. Needs the survey's MEASURED
//    affine: the legacy two-corner fallback cannot represent rotation, so
//    it is refused with the reason.
//
// 5. chaos. 1 - (lambda1 - lambda2)/lambda1 = lambda2/lambda1, clamped to
//    [0, 1]; planar 0, isotropic 1; a zero tensor is 0.
//
// 6. curvature_pos / curvature_neg. Al-Dossary & Marfurt (2006), small dip
//    form, from the (capped) time-dip FIELDS p and q: a = dp/dil,
//    c = dq/dxl, b = (dp/dxl + dq/dil)/2 by the same central / one-sided /
//    zero difference rule as the gradients (a neighbour whose p is null is
//    missing). kMean = (a+c)/2, kPos = kMean + sqrt(((a-c)/2)^2 + b^2),
//    kNeg = kMean - sqrt(...), times dtMs, ms/trace^2. SIGN: time increases
//    downward, so t = t0 + A (il^2 + xl^2) with A > 0 (an anticline in
//    time, the crest shallowest) gives kPos = kNeg = 2 A dtMs > 0.
//
// Halo (structureHalo). edge reads one cell each side: 1. The tensor at a
// cell reads gradients r cells away, each reading one cell further: r+1.
// Curvature differences the dip field one cell further again: r+2. Cells
// that close to a block edge that is not a survey edge would see a
// one-sided gradient or a replicated neighbour; the halo keeps them out of
// the returned block. Vertically every column holds whole traces, so no
// vertical halo is needed.
//
// Computation streams by time slice (a ring of 2hw+1 lateral box sums), so
// memory is bounded by the region's traces plus a few slices.
//
// Pure math, worker-safe, no I/O. Imports nothing from discontinuityJobs.

import { NULL_VALUE } from './manifest';

// Math.* in hot loops is much slower inside jest's vm context; alias it once.
const M = Math;

const NULL_LIM = 1.0e29;
const isNull = (v) => M.abs(v) > NULL_LIM;

/** Dip cap, samples per trace (see recipe 3). */
export const DIP_CAP = 20;
/** Below this dip (samples per trace) the azimuth is undefined (null). */
export const AZIMUTH_MIN_DIP = 1e-6;

/** The structure attribute keys (all regional DISCONTINUITY_DEFS entries). */
export const STRUCTURE_KEYS = ['edge', 'dip', 'azimuth', 'azimuth_north', 'chaos', 'curvature_pos', 'curvature_neg'];
const TENSOR_KEYS = new Set(['dip', 'azimuth', 'azimuth_north', 'chaos', 'curvature_pos', 'curvature_neg']);

/**
 * The map-gradient transform of a survey affine: G = J^-T g, with
 * J = [[ilVec.x, xlVec.x], [ilVec.y, xlVec.y]] (recipe 4b).
 * @param {{ilVec: {x, y}, xlVec: {x, y}, legacyAxisAligned?: boolean}} affine
 *   engine form (surveyGeometry.surveyAffine)
 * @returns {{gx: [number, number], gy: [number, number]}} Gx = gx . (p, q),
 *   Gy = gy . (p, q)
 */
export function mapGradientTransform(affine) {
  if (!affine?.ilVec || !affine?.xlVec) {
    throw new Error('Dip azimuth from grid north needs the survey orientation (its inline and crossline vectors).');
  }
  if (affine.legacyAxisAligned) {
    throw new Error('This survey was imported before its orientation was measured, so a map azimuth could be wrong. Re-import the SEG-Y to measure it, or use Dip azimuth (lattice).');
  }
  const a = affine.ilVec.x;
  const b = affine.ilVec.y;
  const c = affine.xlVec.x;
  const d = affine.xlVec.y;
  const det = a * d - b * c;
  if (![a, b, c, d].every(Number.isFinite) || !(M.abs(det) > 0)) {
    throw new Error('The survey orientation is degenerate (its inline and crossline vectors are parallel or zero).');
  }
  return { gx: [d / det, -b / det], gy: [-c / det, a / det] };
}

/**
 * Down-dip azimuth clockwise from grid north, degrees in [0, 360), of a
 * time gradient (p, q) per index step; null (NULL_VALUE) below
 * AZIMUTH_MIN_DIP samples per trace.
 * @param {{gx: number[], gy: number[]}} T mapGradientTransform result
 */
export function northAzimuth(p, q, T) {
  if (!(M.hypot(p, q) >= AZIMUTH_MIN_DIP)) return NULL_VALUE;
  const gxv = T.gx[0] * p + T.gx[1] * q;
  const gyv = T.gy[0] * p + T.gy[1] * q;
  let az = (M.atan2(gxv, gyv) * 180) / M.PI;
  if (az < 0) az += 360;
  if (az >= 360) az -= 360;
  return az;
}
const CURVATURE_KEYS = new Set(['curvature_pos', 'curvature_neg']);

export const isStructureKey = (name) => typeof name === 'string' && STRUCTURE_KEYS.includes(name);

const DEFAULTS = {
  edge: { windowMs: 12 },
  tensor: { windowMs: 24, radius: 1 },
};

/** Round half up (the oracle's rule). */
const roundHalfUp = (x) => M.floor(x + 0.5);

/**
 * Resolve an attribute's params to samples and cells.
 * @returns {{hw: number, radius: number}} radius is 0 for edge
 */
export function structureParams(name, params = {}, dtMs = 4) {
  if (!isStructureKey(name)) throw new Error(`Unknown structure attribute "${name}".`);
  if (!(dtMs > 0)) throw new Error(`Structure attributes need a positive sample interval, got ${dtMs} ms.`);
  if (name === 'edge') {
    const windowMs = params?.windowMs ?? DEFAULTS.edge.windowMs;
    if (!(windowMs >= 0) || !Number.isFinite(windowMs)) throw new Error(`Vertical window ${windowMs} ms is not usable.`);
    return { hw: roundHalfUp(windowMs / 2 / dtMs), radius: 0 };
  }
  const windowMs = params?.windowMs ?? DEFAULTS.tensor.windowMs;
  if (!(windowMs >= 0) || !Number.isFinite(windowMs)) throw new Error(`Vertical window ${windowMs} ms is not usable.`);
  const r = params?.radius ?? DEFAULTS.tensor.radius;
  if (!Number.isFinite(r)) throw new Error(`Trace radius ${r} is not usable.`);
  return { hw: roundHalfUp(windowMs / 2 / dtMs), radius: M.max(1, M.min(2, M.floor(r))) };
}

/** Lateral halo (cells) that makes a block equal the whole-volume run. */
export function structureHalo(name, params = {}) {
  if (!isStructureKey(name)) throw new Error(`Unknown structure attribute "${name}".`);
  if (name === 'edge') return 1;
  const { radius } = structureParams(name, params, 4);
  return CURVATURE_KEYS.has(name) ? radius + 2 : radius + 1;
}

/**
 * Eigen-decomposition of a symmetric 3x3 matrix by cyclic Jacobi.
 * @param {number[]} m [a00, a01, a02, a11, a12, a22]
 * @returns {{l: number[], v: number[][]}} eigenvalues descending, v[k] the
 *   unit eigenvector of l[k]
 */
export function eigSym3(m) {
  const a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    const off = a[0][1] * a[0][1] + a[0][2] * a[0][2] + a[1][2] * a[1][2];
    const diag = a[0][0] * a[0][0] + a[1][1] * a[1][1] + a[2][2] * a[2][2];
    if (off === 0 || off <= 1e-36 * diag) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p][q];
        if (apq === 0) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * apq);
        const t = M.sign(theta || 1) / (M.abs(theta) + M.sqrt(theta * theta + 1));
        const c = 1 / M.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const idx = [0, 1, 2].sort((x, y) => a[y][y] - a[x][x] || x - y);
  return {
    l: idx.map((k) => a[k][k]),
    v: idx.map((k) => [V[0][k], V[1][k], V[2][k]]),
  };
}

/**
 * Time dips (samples per trace) from a tensor. Returns null p/q never;
 * `zero` flags a zero tensor.
 * @param {number[]} m tensor [Tii, Tix, Tit, Txx, Txt, Ttt]
 */
export function dipsFromTensor(m) {
  if (m[0] + m[3] + m[5] === 0) return { p: 0, q: 0, zero: true, chaos: 0 };
  const { l, v } = eigSym3(m);
  const [vi, vx, vt] = v[0];
  const h = M.hypot(vi, vx);
  let p;
  let q;
  if (h === 0) {
    p = 0;
    q = 0;
  } else if (M.abs(vt) * DIP_CAP < h) {
    const sg = vt < 0 ? -1 : 1;
    p = (-sg * vi / h) * DIP_CAP;
    q = (-sg * vx / h) * DIP_CAP;
  } else {
    p = -vi / vt;
    q = -vx / vt;
  }
  let chaos = l[0] > 0 ? l[1] / l[0] : 0;
  chaos = chaos < 0 ? 0 : chaos > 1 ? 1 : chaos;
  return { p, q, zero: false, chaos };
}

/** Load the region's traces (null for absent or dead). */
function loadRegion(getTrace, ri0, ri1, rj0, rj1) {
  const nRi = ri1 - ri0 + 1;
  const nRj = rj1 - rj0 + 1;
  const tr = new Array(nRi * nRj).fill(null);
  for (let i = 0; i < nRi; i++) {
    for (let j = 0; j < nRj; j++) {
      const t = getTrace(i + ri0, j + rj0);
      if (!t) continue;
      let live = false;
      for (let s = 0; s < t.length; s++) {
        if (!isNull(t[s])) { live = true; break; }
      }
      if (live) tr[i * nRj + j] = t;
    }
  }
  return { tr, nRi, nRj };
}

/** Sobel edge for the block cells (region-local block bounds). */
function edgeBlock(R, ns, b, hw, out) {
  const { tr, nRi, nRj } = R;
  const nJ = b.j1 - b.j0 + 1;
  const g2 = new Float64Array(ns);
  const ok = new Uint8Array(ns);
  const clampI = (i) => (i < 0 ? 0 : i >= nRi ? nRi - 1 : i);
  const clampJ = (j) => (j < 0 ? 0 : j >= nRj ? nRj - 1 : j);
  const W = [1, 2, 1];
  for (let i = b.i0; i <= b.i1; i++) {
    for (let j = b.j0; j <= b.j1; j++) {
      const o0 = ((i - b.i0) * nJ + (j - b.j0)) * ns;
      const c = tr[i * nRj + j];
      if (!c) { out.fill(NULL_VALUE, o0, o0 + ns); continue; }
      const nb = [];
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) nb.push(tr[clampI(i + di) * nRj + clampJ(j + dj)]);
      }
      for (let t = 0; t < ns; t++) {
        const cv = c[t];
        if (isNull(cv)) { ok[t] = 0; g2[t] = 0; continue; }
        ok[t] = 1;
        const v = (di, dj) => {
          const n = nb[(di + 1) * 3 + (dj + 1)];
          if (!n) return cv;
          const x = n[t];
          return isNull(x) ? cv : x;
        };
        let gi = 0;
        let gx = 0;
        for (let k = -1; k <= 1; k++) {
          gi += W[k + 1] * (v(1, k) - v(-1, k));
          gx += W[k + 1] * (v(k, 1) - v(k, -1));
        }
        gi /= 8;
        gx /= 8;
        g2[t] = gi * gi + gx * gx;
      }
      for (let t = 0; t < ns; t++) {
        if (!ok[t]) { out[o0 + t] = NULL_VALUE; continue; }
        let sum = 0;
        let n = 0;
        const s0 = M.max(0, t - hw);
        const s1 = M.min(ns - 1, t + hw);
        for (let s = s0; s <= s1; s++) {
          if (ok[s]) { sum += g2[s]; n += 1; }
        }
        out[o0 + t] = M.sqrt(sum / n);
      }
    }
  }
}

/** One-sided / central / zero difference. */
function diff3(has1, v1, has0, v0, hasM, vM) {
  if (has1 && hasM) return (v1 - vM) / 2;
  if (has1) return v1 - v0;
  if (hasM) return v0 - vM;
  return 0;
}

/** Structure-tensor attributes for the block cells. */
function tensorBlock(R, ns, b, name, hw, r, dtMs, out, mapT = null) {
  const { tr, nRi, nRj } = R;
  const curv = CURVATURE_KEYS.has(name);
  const e = curv ? 1 : 0;
  // tensor area (T) and gradient area (G), region-local, clipped
  const T = {
    i0: M.max(0, b.i0 - e), i1: M.min(nRi - 1, b.i1 + e),
    j0: M.max(0, b.j0 - e), j1: M.min(nRj - 1, b.j1 + e),
  };
  const G = {
    i0: M.max(0, T.i0 - r), i1: M.min(nRi - 1, T.i1 + r),
    j0: M.max(0, T.j0 - r), j1: M.min(nRj - 1, T.j1 + r),
  };
  const nTi = T.i1 - T.i0 + 1;
  const nTj = T.j1 - T.j0 + 1;
  const nGi = G.i1 - G.i0 + 1;
  const nGj = G.j1 - G.j0 + 1;
  const nT = nTi * nTj;
  const nG = nGi * nGj;
  const nJ = b.j1 - b.j0 + 1;

  const val = (i, j, t) => {
    if (i < 0 || i >= nRi || j < 0 || j >= nRj || t < 0 || t >= ns) return NaN;
    const x = tr[i * nRj + j];
    if (!x) return NaN;
    const v = x[t];
    return isNull(v) ? NaN : v;
  };

  const gI = new Float64Array(nG);
  const gX = new Float64Array(nG);
  const gT = new Float64Array(nG);
  const gOk = new Uint8Array(nG);
  const L = 2 * hw + 1;
  const ringS = new Float64Array(L * nT * 6);
  const ringN = new Int32Array(L * nT);

  // dip fields at the output slice (curvature only)
  const P = new Float64Array(nT);
  const Q = new Float64Array(nT);
  const PQok = new Uint8Array(nT);

  const sliceIntoRing = (s) => {
    for (let gi = 0; gi < nGi; gi++) {
      for (let gj = 0; gj < nGj; gj++) {
        const i = G.i0 + gi;
        const j = G.j0 + gj;
        const k = gi * nGj + gj;
        const c = val(i, j, s);
        if (Number.isNaN(c)) { gOk[k] = 0; gI[k] = 0; gX[k] = 0; gT[k] = 0; continue; }
        gOk[k] = 1;
        let a = val(i + 1, j, s); let m = val(i - 1, j, s);
        gI[k] = diff3(!Number.isNaN(a), a, true, c, !Number.isNaN(m), m);
        a = val(i, j + 1, s); m = val(i, j - 1, s);
        gX[k] = diff3(!Number.isNaN(a), a, true, c, !Number.isNaN(m), m);
        a = val(i, j, s + 1); m = val(i, j, s - 1);
        gT[k] = diff3(!Number.isNaN(a), a, true, c, !Number.isNaN(m), m);
      }
    }
    const slot = s % L;
    for (let ti = 0; ti < nTi; ti++) {
      for (let tj = 0; tj < nTj; tj++) {
        const i = T.i0 + ti;
        const j = T.j0 + tj;
        let s0 = 0; let s1 = 0; let s2 = 0; let s3 = 0; let s4 = 0; let s5 = 0;
        let n = 0;
        const a0 = M.max(G.i0, i - r); const a1 = M.min(G.i1, i + r);
        const c0 = M.max(G.j0, j - r); const c1 = M.min(G.j1, j + r);
        for (let ii = a0; ii <= a1; ii++) {
          for (let jj = c0; jj <= c1; jj++) {
            const k = (ii - G.i0) * nGj + (jj - G.j0);
            if (!gOk[k]) continue;
            const x = gI[k]; const y = gX[k]; const z = gT[k];
            s0 += x * x; s1 += x * y; s2 += x * z; s3 += y * y; s4 += y * z; s5 += z * z;
            n += 1;
          }
        }
        const kk = ti * nTj + tj;
        const o = (slot * nT + kk) * 6;
        ringS[o] = s0; ringS[o + 1] = s1; ringS[o + 2] = s2;
        ringS[o + 3] = s3; ringS[o + 4] = s4; ringS[o + 5] = s5;
        ringN[slot * nT + kk] = n;
      }
    }
  };

  const m = [0, 0, 0, 0, 0, 0];
  const outputSlice = (t) => {
    const w0 = M.max(0, t - hw);
    const w1 = M.min(ns - 1, t + hw);
    for (let ti = 0; ti < nTi; ti++) {
      for (let tj = 0; tj < nTj; tj++) {
        const i = T.i0 + ti;
        const j = T.j0 + tj;
        const kk = ti * nTj + tj;
        const inBlock = i >= b.i0 && i <= b.i1 && j >= b.j0 && j <= b.j1;
        const oIdx = inBlock ? ((i - b.i0) * nJ + (j - b.j0)) * ns + t : -1;
        if (Number.isNaN(val(i, j, t))) {
          PQok[kk] = 0;
          if (inBlock) out[oIdx] = NULL_VALUE;
          continue;
        }
        m.fill(0);
        let n = 0;
        for (let s = w0; s <= w1; s++) {
          const slot = s % L;
          const o = (slot * nT + kk) * 6;
          m[0] += ringS[o]; m[1] += ringS[o + 1]; m[2] += ringS[o + 2];
          m[3] += ringS[o + 3]; m[4] += ringS[o + 4]; m[5] += ringS[o + 5];
          n += ringN[slot * nT + kk];
        }
        for (let q = 0; q < 6; q++) m[q] /= n;
        const d = dipsFromTensor(m);
        if (curv) {
          P[kk] = d.p; Q[kk] = d.q; PQok[kk] = 1;
          continue;
        }
        if (!inBlock) continue;
        if (name === 'dip') out[oIdx] = M.hypot(d.p, d.q) * dtMs;
        else if (name === 'chaos') out[oIdx] = d.chaos;
        else if (name === 'azimuth_north') out[oIdx] = d.zero ? NULL_VALUE : northAzimuth(d.p, d.q, mapT);
        else {
          const mag = M.hypot(d.p, d.q);
          if (d.zero || mag < AZIMUTH_MIN_DIP) out[oIdx] = NULL_VALUE;
          else {
            let az = (M.atan2(d.q, d.p) * 180) / M.PI;
            if (az < 0) az += 360;
            if (az >= 360) az -= 360;
            out[oIdx] = az;
          }
        }
      }
    }
    if (!curv) return;
    const has = (i, j) => i >= T.i0 && i <= T.i1 && j >= T.j0 && j <= T.j1 && PQok[(i - T.i0) * nTj + (j - T.j0)] === 1;
    const at = (F, i, j) => F[(i - T.i0) * nTj + (j - T.j0)];
    const sgn = name === 'curvature_pos' ? 1 : -1;
    for (let i = b.i0; i <= b.i1; i++) {
      for (let j = b.j0; j <= b.j1; j++) {
        const oIdx = ((i - b.i0) * nJ + (j - b.j0)) * ns + t;
        if (!has(i, j)) { out[oIdx] = NULL_VALUE; continue; }
        const hiP = has(i + 1, j); const hiM = has(i - 1, j);
        const hjP = has(i, j + 1); const hjM = has(i, j - 1);
        const dpdi = diff3(hiP, hiP ? at(P, i + 1, j) : 0, true, at(P, i, j), hiM, hiM ? at(P, i - 1, j) : 0);
        const dqdi = diff3(hiP, hiP ? at(Q, i + 1, j) : 0, true, at(Q, i, j), hiM, hiM ? at(Q, i - 1, j) : 0);
        const dpdj = diff3(hjP, hjP ? at(P, i, j + 1) : 0, true, at(P, i, j), hjM, hjM ? at(P, i, j - 1) : 0);
        const dqdj = diff3(hjP, hjP ? at(Q, i, j + 1) : 0, true, at(Q, i, j), hjM, hjM ? at(Q, i, j - 1) : 0);
        const a = dpdi;
        const c = dqdj;
        const bb = (dpdj + dqdi) / 2;
        const kMean = (a + c) / 2;
        const rad = M.sqrt(((a - c) / 2) ** 2 + bb * bb);
        out[oIdx] = (kMean + sgn * rad) * dtMs;
      }
    }
  };

  for (let s = 0; s < ns + hw; s++) {
    if (s < ns) sliceIntoRing(s);
    const t = s - hw;
    if (t >= 0) outputSlice(t);
  }
}

/**
 * A structure attribute over the cells il0..il1 x xl0..xl1 (all samples),
 * computed over that block plus `halo` cells each side (clipped to the
 * survey), in (row-major il, then xl)*ns order. Dead and absent traces
 * come back all NULL_VALUE.
 *
 * @param {Object} p
 * @param {string} p.name STRUCTURE_KEYS entry
 * @param {(il:number, xl:number) => ?Float32Array} p.getTrace survey
 *   coordinates; null outside the survey
 * @param {number} p.nIl @param {number} p.nXl @param {number} p.ns
 * @param {number} p.dtMs sample interval in ms
 * @param {Object} [p.params] {windowMs, radius}
 * @param {number} [p.halo] defaults to structureHalo(name, params)
 * @returns {Float32Array}
 */
export function structureBlock({
  name, getTrace, nIl, nXl, ns, dtMs, il0, il1, xl0, xl1, params = {}, halo, affine = null,
}) {
  const { hw, radius } = structureParams(name, params, dtMs);
  const mapT = name === 'azimuth_north' ? mapGradientTransform(affine) : null;
  const h = halo ?? structureHalo(name, params);
  if (!(h >= 0)) throw new Error(`Halo ${h} is not usable.`);
  const ri0 = M.max(0, il0 - h);
  const ri1 = M.min(nIl - 1, il1 + h);
  const rj0 = M.max(0, xl0 - h);
  const rj1 = M.min(nXl - 1, xl1 + h);
  const R = loadRegion(getTrace, ri0, ri1, rj0, rj1);
  const b = { i0: il0 - ri0, i1: il1 - ri0, j0: xl0 - rj0, j1: xl1 - rj0 };
  const out = new Float32Array((il1 - il0 + 1) * (xl1 - xl0 + 1) * ns);
  if (name === 'edge') edgeBlock(R, ns, b, hw, out);
  else if (TENSOR_KEYS.has(name)) tensorBlock(R, ns, b, name, hw, radius, dtMs, out, mapT);
  return out;
}

/** The whole survey in one block: (il, then xl)*ns. */
export function structureVolume({
  name, getTrace, nIl, nXl, ns, dtMs, params = {}, affine = null,
}) {
  return structureBlock({
    name, getTrace, nIl, nXl, ns, dtMs, il0: 0, il1: nIl - 1, xl0: 0, xl1: nXl - 1, params, halo: 0, affine,
  });
}

/**
 * The runNeighborhoodJob pieces for a structure attribute.
 * @param {string} name @param {Object} params
 * @param {{dtUs: number, nIl: number, nXl: number, ns: number, affine?: Object}} volume
 *   affine (engine form, surveyGeometry.surveyAffine) is required by
 *   azimuth_north
 * @returns {{radius: number, computeColumn: Function}}
 */
export function makeStructureJob(name, params, {
  dtUs, nIl, nXl, ns, affine = null,
}) {
  if (!(dtUs > 0)) throw new Error(`Structure attributes need a positive dt, got ${dtUs}.`);
  if (!(nIl > 0 && nXl > 0 && ns > 0)) throw new Error('Structure attributes need the survey size (nIl, nXl, ns).');
  const dtMs = dtUs / 1000;
  structureParams(name, params, dtMs);           // validate early
  if (name === 'azimuth_north') mapGradientTransform(affine);
  const halo = structureHalo(name, params);
  return {
    radius: halo,
    computeColumn: ({ getTrace, il0, il1, xl0, xl1 }) => structureBlock({
      name, getTrace, nIl, nXl, ns, dtMs, il0, il1, xl0, xl1, params, halo, affine,
    }),
  };
}
