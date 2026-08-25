// ISCWSA MWD Rev4 positional-uncertainty engine (Well Design Studio WD4).
//
// Implements the ISCWSA/OWSG MWD Revision 4 error model: per-source
// weighting functions map instrument error magnitudes to station
// (depth, inclination, azimuth) perturbations; the Williamson
// balanced-tangential position Jacobian propagates them to NEV; and
// per-source accumulation (systematic running sum vs random RSS)
// yields station covariance matrices. Follows the algorithmic
// structure of welleng 0.29.0 (Apache-2.0, jonnymaserati/welleng),
// whose Rev4 output reproduces the official iscwsa.net example Well #1
// validation workbook to machine precision; this port is gated against
// that workbook's full-precision per-source values and the welleng
// oracle totals in test-data/drilling/goldens/iscwsa_mwd_rev4_well1.json.
//
// Conventions: stations {md, inc, azi} in degrees, MD/TVD in metres
// (the model's magnitudes are metric — callers convert ft first).
// header.aziReference declares the azimuth frame of the input stations
// ('grid' | 'true' | 'magnetic'); declination/convergence complete the
// chain (aziTrue = aziGrid + convergence = aziMag + declination). The
// NEV frame of the output covariances is north-referenced in the same
// sense as the input chain's true north.
//
// Pure math, worker-safe, no I/O.

import { ISCWSA_MWD_REV4 } from './data/iscwsaMwdRev4.js';

const DEG = Math.PI / 180;
const DEFAULT_G = 9.80665;

export const ERROR_MODELS = { 'ISCWSA MWD Rev4': ISCWSA_MWD_REV4 };

// ---------------------------------------------------------------------------
// small linear algebra on [3] vectors and [3][3] matrices
// ---------------------------------------------------------------------------

function zeros3() { return [0, 0, 0]; }

function zeros33() {
  return [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
}

function outer3(v) {
  return [
    [v[0] * v[0], v[0] * v[1], v[0] * v[2]],
    [v[1] * v[0], v[1] * v[1], v[1] * v[2]],
    [v[2] * v[0], v[2] * v[1], v[2] * v[2]],
  ];
}

function addInto(a, b) {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) a[r][c] += b[r][c];
  return a;
}

export function matAdd(a, b) {
  return addInto([[...a[0]], [...a[1]], [...a[2]]], b);
}

/** finite-or-zero guard mirroring numpy nan_to_num(posinf=0, neginf=0). */
function finite0(x) {
  return Number.isFinite(x) ? x : 0;
}

// ---------------------------------------------------------------------------
// survey preprocessing
// ---------------------------------------------------------------------------

/**
 * Resolve the azimuth chain and radian angle arrays for the model.
 * Returns {md, inc, aziTrue, aziMag, tvd} (angles in radians).
 */
export function prepareSurvey(stations, header) {
  const n = stations.length;
  const decl = (header.declinationDeg ?? 0) * DEG;
  const conv = (header.convergenceDeg ?? 0) * DEG;
  const ref = header.aziReference ?? 'grid';
  const md = new Array(n);
  const inc = new Array(n);
  const aziTrue = new Array(n);
  for (let i = 0; i < n; i++) {
    md[i] = stations[i].md;
    inc[i] = stations[i].inc * DEG;
    // Grid-referenced azimuth is canonicalised to 0 at exactly-vertical
    // stations (azimuth is undefined there, and the inc-weighting
    // Jacobian columns are azimuth-dependent even at inc == 0, so a raw
    // placeholder azimuth would taint the covariance of every downstream
    // station via the systematic running sum). Matches the reference
    // implementation's Survey preprocessing; true/magnetic-referenced
    // input is consumed as given.
    const rawAzi = ref === 'grid' && stations[i].inc === 0 ? 0 : stations[i].azi;
    const a = rawAzi * DEG;
    aziTrue[i] = ref === 'true' ? a : ref === 'magnetic' ? a + decl : a + conv;
  }
  const aziMag = aziTrue.map((a) => a - decl);
  // TVD feeds the depth-stretch weighting (DST). Stations that carry
  // their own tvd (e.g. a tied-on sidetrack whose depths start below the
  // datum, or an actual-survey listing) are used as given; otherwise TVD
  // is integrated by minimum curvature from header.startTvd (default 0).
  // The azimuth frame is immaterial here — frames differ by a constant.
  if (stations.every((st) => Number.isFinite(st.tvd))) {
    return { n, md, inc, aziTrue, aziMag, tvd: stations.map((st) => st.tvd) };
  }
  const tvd = new Array(n);
  tvd[0] = header.startTvd ?? 0;
  for (let i = 1; i < n; i++) {
    const dmd = md[i] - md[i - 1];
    const cosDl = Math.min(1, Math.max(-1,
      Math.sin(inc[i - 1]) * Math.sin(inc[i]) * Math.cos(aziTrue[i] - aziTrue[i - 1])
      + Math.cos(inc[i - 1]) * Math.cos(inc[i])));
    const dl = Math.acos(cosDl);
    const rf = dl < 1e-7 ? 1 : (2 / dl) * Math.tan(dl / 2);
    tvd[i] = tvd[i - 1] + 0.5 * dmd * rf * (Math.cos(inc[i - 1]) + Math.cos(inc[i]));
  }
  return { n, md, inc, aziTrue, aziMag, tvd };
}

// ---------------------------------------------------------------------------
// balanced-tangential position Jacobian (drdp)
// ---------------------------------------------------------------------------

/**
 * The 18-column station Jacobian: columns 0-2 drk_dDepth, 3-5 drk_dInc,
 * 6-8 drk_dAz (own leg [k-1 -> k], station-k side), 9-11 drkplus1_dDepth,
 * 12-14 drkplus1_dInc, 15-17 drkplus1_dAz (next leg [k -> k+1],
 * station-k side). Rev4 conventions: a survey rooted at the zero datum
 * (md[0] === 0) seeds station 0's depth column with the full wellbore
 * tangent (a first-station depth error shifts position by the whole
 * tangent — ISCWSA DRFR carries full variance at surface); no Rev5
 * surface tie-on doubling.
 */
function buildDrdp(md, inc, azi) {
  const n = md.length;
  const drdp = Array.from({ length: n }, () => new Float64Array(18));
  for (let k = 1; k < n; k++) {
    const dmd = md[k] - md[k - 1];
    const half = 0.5 * dmd;
    const si1 = Math.sin(inc[k - 1]); const ci1 = Math.cos(inc[k - 1]);
    const sa1 = Math.sin(azi[k - 1]); const ca1 = Math.cos(azi[k - 1]);
    const si2 = Math.sin(inc[k]); const ci2 = Math.cos(inc[k]);
    const sa2 = Math.sin(azi[k]); const ca2 = Math.cos(azi[k]);
    const dcN = 0.5 * (si1 * ca1 + si2 * ca2);
    const dcE = 0.5 * (si1 * sa1 + si2 * sa2);
    const dcV = 0.5 * (ci1 + ci2);
    // own leg, station k
    const rk = drdp[k];
    rk[0] = dcN; rk[1] = dcE; rk[2] = dcV;
    rk[3] = half * ci2 * ca2; rk[4] = half * ci2 * sa2; rk[5] = -half * si2;
    rk[6] = -half * si2 * sa2; rk[7] = half * si2 * ca2; // rk[8] = 0
    // next leg, station k-1
    const rp = drdp[k - 1];
    rp[9] = -dcN; rp[10] = -dcE; rp[11] = -dcV;
    rp[12] = half * ci1 * ca1; rp[13] = half * ci1 * sa1; rp[14] = -half * si1;
    rp[15] = -half * si1 * sa1; rp[16] = half * si1 * ca1; // rp[17] = 0
  }
  if (md[0] === 0) {
    const r0 = drdp[0];
    r0[0] = Math.sin(inc[0]) * Math.cos(azi[0]);
    r0[1] = Math.sin(inc[0]) * Math.sin(azi[0]);
    r0[2] = Math.cos(inc[0]);
  }
  return drdp;
}

/** Both-legs NEV error vector per station (row 0 zeroed). */
function eNevOf(drdp, eDIA) {
  const n = eDIA.length;
  const out = Array.from({ length: n }, zeros3);
  for (let i = 1; i < n; i++) {
    const [D, I, A] = eDIA[i];
    const r = drdp[i];
    out[i][0] = (r[0] + r[9]) * D + (r[3] + r[12]) * I + (r[6] + r[15]) * A;
    out[i][1] = (r[1] + r[10]) * D + (r[4] + r[13]) * I + (r[7] + r[16]) * A;
    out[i][2] = (r[2] + r[11]) * D + (r[5] + r[14]) * I + (r[8] + r[17]) * A;
  }
  return out;
}

/** Own-leg-only NEV error vector per station (station-0 depth seed live). */
function eNevStarOf(drdp, eDIA) {
  const n = eDIA.length;
  const out = Array.from({ length: n }, zeros3);
  for (let i = 0; i < n; i++) {
    const [D, I, A] = eDIA[i];
    const r = drdp[i];
    out[i][0] = r[0] * D + r[3] * I + r[6] * A;
    out[i][1] = r[1] * D + r[4] * I + r[7] * A;
    out[i][2] = r[2] * D + r[5] * I + r[8] * A;
  }
  return out;
}

/**
 * Accumulate a source's station covariances from its NEV error vectors.
 * systematic/global: fully correlated running sum, cov = σσᵀ with
 *   σ[i] = e*[i] + Σ_{j<i} e[j].
 * random: independent per-station, cov = e*[i]e*[i]ᵀ + Σ_{j<i} e[j]e[j]ᵀ.
 * Returns {sigmaENEV, covNEV}; sigmaENEV for random holds the running
 * sum of outer products' diagonal is not meaningful, so it is null.
 */
function accumulate(eNEV, eNEVStar, propagation) {
  const n = eNEV.length;
  const covNEV = new Array(n);
  if (propagation === 'random') {
    let running = zeros33();
    for (let i = 0; i < n; i++) {
      covNEV[i] = matAdd(outer3(eNEVStar[i]), running);
      running = matAdd(running, outer3(eNEV[i]));
    }
    return { sigmaENEV: null, covNEV };
  }
  // systematic / global / well
  const sigmaENEV = new Array(n);
  let sum = zeros3();
  for (let i = 0; i < n; i++) {
    sigmaENEV[i] = [
      eNEVStar[i][0] + sum[0],
      eNEVStar[i][1] + sum[1],
      eNEVStar[i][2] + sum[2],
    ];
    sum = [sum[0] + eNEV[i][0], sum[1] + eNEV[i][1], sum[2] + eNEV[i][2]];
    covNEV[i] = outer3(sigmaENEV[i]);
  }
  return { sigmaENEV, covNEV };
}

// ---------------------------------------------------------------------------
// Rev4 weighting functions: dpde rows [dDepth, dInc, dAzi] per station.
// s = prepared survey context, h = resolved header numbers.
// ---------------------------------------------------------------------------

const WEIGHT_FNS = {
  DREF: (s) => s.md.map(() => [1, 0, 0]),
  DSF: (s) => s.md.map((m) => [m, 0, 0]),
  DST: (s) => s.md.map((m, i) => [m * s.tvd[i], 0, 0]),
  ABXY_TI1: (s, h) => s.inc.map((I, i) => [
    0,
    -Math.cos(I) / h.G,
    (Math.cos(I) * Math.tan(h.dip) * Math.sin(s.aziMag[i])) / h.G,
  ]),
  ABXY_TI2: (s, h) => s.inc.map((I, i) => [
    0,
    0,
    finite0((Math.tan(Math.PI / 2 - I) - Math.tan(h.dip) * Math.cos(s.aziMag[i])) / h.G),
  ]),
  ABZ: (s, h) => s.inc.map((I, i) => [
    0,
    -Math.sin(I) / h.G,
    (Math.sin(I) * Math.tan(h.dip) * Math.sin(s.aziMag[i])) / h.G,
  ]),
  ASXY_TI1: (s, h) => s.inc.map((I, i) => [
    0,
    (Math.sin(I) * Math.cos(I)) / Math.SQRT2,
    (Math.sin(I) * -Math.tan(h.dip) * Math.cos(I) * Math.sin(s.aziMag[i])) / Math.SQRT2,
  ]),
  ASXY_TI2: (s, h) => s.inc.map((I, i) => [
    0,
    (Math.sin(I) * Math.cos(I)) / 2,
    (Math.sin(I) * -Math.tan(h.dip) * Math.cos(I) * Math.sin(s.aziMag[i])) / 2,
  ]),
  ASXY_TI3: (s, h) => s.inc.map((I, i) => [
    0,
    0,
    (Math.sin(I) * Math.tan(h.dip) * Math.cos(s.aziMag[i]) - Math.cos(I)) / 2,
  ]),
  ASZ: (s, h) => s.inc.map((I, i) => [
    0,
    -Math.sin(I) * Math.cos(I),
    Math.sin(I) * Math.tan(h.dip) * Math.cos(I) * Math.sin(s.aziMag[i]),
  ]),
  MBXY_TI1: (s, h) => s.inc.map((I, i) => [
    0,
    0,
    (-Math.cos(I) * Math.sin(s.aziMag[i])) / (h.bTotal * Math.cos(h.dip)),
  ]),
  MBXY_TI2: (s, h) => s.inc.map((I, i) => [
    0,
    0,
    Math.cos(s.aziMag[i]) / (h.bTotal * Math.cos(h.dip)),
  ]),
  MBZ: (s, h) => s.inc.map((I, i) => [
    0,
    0,
    (-Math.sin(I) * Math.sin(s.aziMag[i])) / (h.bTotal * Math.cos(h.dip)),
  ]),
  MSXY_TI1: (s, h) => s.inc.map((I, i) => [
    0,
    0,
    (Math.sin(I) * Math.sin(s.aziMag[i])
      * (Math.tan(h.dip) * Math.cos(I) + Math.sin(I) * Math.cos(s.aziMag[i]))) / Math.SQRT2,
  ]),
  MSXY_TI2: (s, h) => s.inc.map((I, i) => [
    0,
    0,
    (Math.sin(s.aziMag[i]) * (
      Math.tan(h.dip) * Math.sin(I) * Math.cos(I)
      - Math.cos(I) * Math.cos(I) * Math.cos(s.aziMag[i])
      - Math.cos(s.aziMag[i])
    )) / 2,
  ]),
  MSXY_TI3: (s, h) => s.inc.map((I, i) => [
    0,
    0,
    (Math.cos(I) * Math.cos(s.aziMag[i]) * Math.cos(s.aziMag[i])
      - Math.cos(I) * Math.sin(s.aziMag[i]) * Math.sin(s.aziMag[i])
      - Math.tan(h.dip) * Math.sin(I) * Math.cos(s.aziMag[i])) / 2,
  ]),
  MSZ: (s, h) => s.inc.map((I, i) => [
    0,
    0,
    -(Math.sin(I) * Math.cos(s.aziMag[i]) + Math.tan(h.dip) * Math.cos(I))
      * Math.sin(I) * Math.sin(s.aziMag[i]),
  ]),
  AZ: (s) => s.md.map(() => [0, 0, 1]),
  DBH: (s, h) => s.md.map(() => [0, 0, 1 / (h.bTotal * Math.cos(h.dip))]),
  AMIL: (s, h) => s.inc.map((I, i) => [
    0,
    0,
    (-Math.sin(I) * Math.sin(s.aziMag[i])) / (h.bTotal * Math.cos(h.dip)),
  ]),
  SAG: (s) => s.inc.map((I) => [0, Math.sin(I), 0]),
  XYM1: (s) => s.inc.map((I) => [0, Math.abs(Math.sin(I)), 0]),
  XYM2: (s) => s.md.map(() => [0, 0, -1]),
  XYM3: (s) => s.inc.map((I, i) => [
    0,
    Math.abs(Math.cos(I)) * Math.cos(s.aziTrue[i]),
    finite0(-(Math.abs(Math.cos(I)) * Math.sin(s.aziTrue[i])) / Math.sin(I)),
  ]),
  XYM4: (s) => s.inc.map((I, i) => [
    0,
    Math.abs(Math.cos(I)) * Math.sin(s.aziTrue[i]),
    finite0((Math.abs(Math.cos(I)) * Math.cos(s.aziTrue[i])) / Math.sin(I)),
  ]),
};

/**
 * Near-vertical singularity substitutions (inc < verticalIncLimit): the
 * azimuth weighting collapses, so affected interior stations' NEV error
 * vectors are replaced by the ISCWSA lateral forms built from the MD
 * spans (double_delta_md for e_NEV, delta_md for e_NEV_star). First and
 * last stations substitute to zero. Returns {eNEV, eNEVStar} overrides
 * or null when no station is singular.
 *
 * Per-fn interior rows ([n, e] with v = 0), for interior station j
 * (1 <= j <= n-2, azi2 = aziTrue[j]):
 *  ABXY_TI2: [-half·sin(azi2), half·cos(azi2)] · mag / G  (Rev4 keeps
 *    the plain form — no Rev5 first-leg east seed)
 *  XYM3: [half, 0] · mag
 *  XYM4: [0, half] · mag
 */
function singularOverrides(fnKey, s, h, mag, drdp, eDIA) {
  const lim = h.verticalIncLimit;
  const singular = [];
  for (let i = 0; i < s.n; i++) if (s.inc[i] < lim) singular.push(i);
  if (singular.length === 0) return null;

  const rowFor = (halfSpan, j) => {
    const azi2 = s.aziTrue[j];
    switch (fnKey) {
      case 'ABXY_TI2':
        return [
          (halfSpan * -Math.sin(azi2) * mag) / h.G,
          (halfSpan * Math.cos(azi2) * mag) / h.G,
          0,
        ];
      case 'XYM3':
        return [halfSpan * mag, 0, 0];
      case 'XYM4':
        return [0, halfSpan * mag, 0];
      default:
        return null;
    }
  };

  const eNEV = eNevOf(drdp, eDIA);
  const eNEVStar = eNevStarOf(drdp, eDIA);
  for (const j of singular) {
    if (j === 0 || j === s.n - 1) {
      eNEV[j] = zeros3();
      eNEVStar[j] = zeros3();
    } else {
      eNEV[j] = rowFor(0.5 * (s.md[j + 1] - s.md[j - 1]), j);
      eNEVStar[j] = rowFor(0.5 * (s.md[j] - s.md[j - 1]), j);
    }
  }
  return { eNEV, eNEVStar };
}

const SINGULAR_FNS = new Set(['ABXY_TI2', 'XYM3', 'XYM4']);

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Run the error model over a survey.
 *
 * stations: [{md, inc, azi}] (degrees, metres; azi in header.aziReference
 * frame). header: {bTotalNT, dipDeg, declinationDeg, convergenceDeg,
 * aziReference, verticalIncLimitDeg, gravity}.
 *
 * Returns {
 *   md, sources: [{code, propagation, depthOnly, eNEV, eNEVStar,
 *     sigmaENEV, covNEV}],
 *   totalCov: [n][3][3],
 * }.
 */
export function computeErrorModel(stations, header, { model = 'ISCWSA MWD Rev4' } = {}) {
  const def = typeof model === 'string' ? ERROR_MODELS[model] : model;
  if (!def) throw new Error(`Unknown error model: ${model}`);
  if (!Number.isFinite(header?.bTotalNT) || !Number.isFinite(header?.dipDeg)) {
    throw new Error('Error model needs a geomagnetic reference: header.bTotalNT and header.dipDeg (from WMM2025 magnetics or a survey-provider report).');
  }
  const s = prepareSurvey(stations, header);
  const h = {
    G: header.gravity ?? DEFAULT_G,
    bTotal: header.bTotalNT,
    dip: header.dipDeg * DEG,
    verticalIncLimit: (header.verticalIncLimitDeg ?? 1e-4) * DEG,
  };
  const drdp = buildDrdp(s.md, s.inc, s.aziTrue);

  const sources = [];
  const totalCov = Array.from({ length: s.n }, zeros33);
  for (const [code, spec] of Object.entries(def.codes)) {
    const dpde = WEIGHT_FNS[spec.fn](s, h);
    const eDIA = dpde.map((row) => [
      row[0] * spec.magnitude, row[1] * spec.magnitude, row[2] * spec.magnitude,
    ]);
    let eNEV; let eNEVStar;
    const override = SINGULAR_FNS.has(spec.fn)
      ? singularOverrides(spec.fn, s, h, spec.magnitude, drdp, eDIA)
      : null;
    if (override) {
      ({ eNEV, eNEVStar } = override);
    } else {
      eNEV = eNevOf(drdp, eDIA);
      eNEVStar = eNevStarOf(drdp, eDIA);
    }
    const { sigmaENEV, covNEV } = accumulate(eNEV, eNEVStar, spec.propagation);
    const depthOnly = eDIA.every((r) => Math.abs(r[1]) < 1e-10 && Math.abs(r[2]) < 1e-10)
      && eDIA.some((r) => Math.abs(r[0]) > 1e-10);
    sources.push({
      code, propagation: spec.propagation, depthOnly, eNEV, eNEVStar, sigmaENEV, covNEV,
    });
    for (let i = 0; i < s.n; i++) addInto(totalCov[i], covNEV[i]);
  }
  return { md: s.md, incRad: s.inc, aziTrueRad: s.aziTrue, tvd: s.tvd, sources, totalCov };
}

// ---------------------------------------------------------------------------
// NEV <-> HLA (highside / lateral / along-hole) and EOU extraction
// ---------------------------------------------------------------------------

/** Rotation NEV -> HLA at one attitude (radians). Rows H, L, A. */
export function hlaTransform(incRad, aziRad) {
  const ci = Math.cos(incRad); const si = Math.sin(incRad);
  const ca = Math.cos(aziRad); const sa = Math.sin(aziRad);
  return [
    [ci * ca, ci * sa, -si],
    [-sa, ca, 0],
    [si * ca, si * sa, ci],
  ];
}

function matMul(a, b) {
  const out = zeros33();
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
    }
  }
  return out;
}

function transpose(a) {
  return [
    [a[0][0], a[1][0], a[2][0]],
    [a[0][1], a[1][1], a[2][1]],
    [a[0][2], a[1][2], a[2][2]],
  ];
}

/** covHLA = T covNEV Tᵀ at one station. */
export function nevToHlaCov(incRad, aziRad, covNEV) {
  const t = hlaTransform(incRad, aziRad);
  return matMul(matMul(t, covNEV), transpose(t));
}

/** covNEV = Tᵀ covHLA T at one station. */
export function hlaToNevCov(incRad, aziRad, covHLA) {
  const t = hlaTransform(incRad, aziRad);
  return matMul(matMul(transpose(t), covHLA), t);
}

/** 1-SD highside/lateral/along-hole sigmas from an NEV covariance. */
export function hlaSigmas(incRad, aziRad, covNEV) {
  const c = nevToHlaCov(incRad, aziRad, covNEV);
  return {
    sigmaH: Math.sqrt(Math.max(0, c[0][0])),
    sigmaL: Math.sqrt(Math.max(0, c[1][1])),
    sigmaA: Math.sqrt(Math.max(0, c[2][2])),
  };
}

/**
 * Horizontal (plan-view) uncertainty ellipse from an NEV covariance:
 * eigen-decomposition of the 2x2 [NN NE; NE EE] block. Returns
 * {semiMajor, semiMinor, azimuthDeg} at `k` standard deviations, with
 * azimuthDeg the compass bearing of the major axis (0..180).
 */
export function horizontalEllipse(covNEV, { k = 1 } = {}) {
  const nn = covNEV[0][0]; const ee = covNEV[1][1]; const ne = covNEV[0][1];
  const tr = nn + ee;
  const disc = Math.sqrt(Math.max(0, (nn - ee) * (nn - ee) / 4 + ne * ne));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(0, tr / 2 - disc);
  // eigenvector of l1 in (N, E); compass bearing atan2(E, N)
  let azimuthDeg;
  if (disc < 1e-15) {
    azimuthDeg = 0;
  } else {
    const vN = ne !== 0 ? ne : l1 - ee;
    const vE = ne !== 0 ? l1 - nn : ne === 0 && nn >= ee ? 0 : 1;
    azimuthDeg = ((Math.atan2(vE, vN) / DEG) % 180 + 180) % 180;
  }
  return {
    semiMajor: k * Math.sqrt(Math.max(0, l1)),
    semiMinor: k * Math.sqrt(l2),
    azimuthDeg,
  };
}

/**
 * Vertical-section-view uncertainty extents: 1-SD in TVD and along an
 * arbitrary horizontal direction (compass bearing, degrees) at `k` SD.
 */
export function sectionExtents(covNEV, bearingDeg, { k = 1 } = {}) {
  const b = bearingDeg * DEG;
  const u = [Math.cos(b), Math.sin(b)]; // (N, E)
  const varAlong = u[0] * u[0] * covNEV[0][0]
    + 2 * u[0] * u[1] * covNEV[0][1] + u[1] * u[1] * covNEV[1][1];
  return {
    horizontal: k * Math.sqrt(Math.max(0, varAlong)),
    vertical: k * Math.sqrt(Math.max(0, covNEV[2][2])),
  };
}

/** Linear per-component covariance interpolation between stations. */
export function covAtMd(md, covs, targetMd) {
  const n = md.length;
  if (targetMd <= md[0]) return covs[0];
  if (targetMd >= md[n - 1]) return covs[n - 1];
  let i = 1;
  while (i < n - 1 && md[i] < targetMd) i += 1;
  const f = (targetMd - md[i - 1]) / (md[i] - md[i - 1]);
  const out = zeros33();
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r][c] = covs[i - 1][r][c] + f * (covs[i][r][c] - covs[i - 1][r][c]);
    }
  }
  return out;
}
