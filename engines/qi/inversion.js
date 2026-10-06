// Post-stack acoustic impedance inversion (QI programme Q8a, Milestone B).
// Trace by trace; the seismic worker runs it over volumes. Pure, float64.
//
// The model is m = ln(AI) and the linearised post-stack forward operator is
// pylops' PoststackLinearModelling (explicit, kind "centered"; Ravasi and
// Vasconcelos 2020): d = C D m, with D the centred first difference
// (D m)_i = (m_{i+1} - m_{i-1}) / 2 (rows 0 and n-1 zero) and C the centred
// convolution with the wavelet (offset floor(len/2)). Matching pylops exactly
// lets its solvers be the oracle.
//
//   modelBased: min ||C D m - d||^2 + eps^2 ||m - m0||^2 by CGLS, m0 the low
//     frequency model (the information the band-limited seismic lacks).
//     blocky: iteratively reweighted total variation, adding
//     epsTV^2 sum w_i (m_{i+1} - m_i)^2 with w_i = 1 / sqrt((m_{i+1}-m_i)^2 + beta^2).
//   sparseSpike: min 1/2 ||C r - d||^2 + lambda ||r||_1 by FISTA (Beck and
//     Teboulle 2009) on the reflectivity r = D m, then m by integrating r onto
//     the low-frequency model (the high frequencies from the spikes, the low
//     from m0, joined by a cosine-tapered crossover).

const fin = Number.isFinite;

function checkInputs(d, wavelet) {
  if (!d?.length || d.length < 4) throw new Error('The trace needs at least 4 samples.');
  if (!wavelet?.length || wavelet.length % 2 === 0) throw new Error('The wavelet needs an odd number of samples (a centre sample).');
  for (const v of d) if (!fin(v)) throw new Error('The trace has null samples; fill or crop them before inverting.');
}

/** Centred first difference (pylops "centered", explicit). */
export function diffCentred(m) {
  const n = m.length;
  const out = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) out[i] = 0.5 * (m[i + 1] - m[i - 1]);
  return out;
}

/** Adjoint of diffCentred. */
export function diffCentredAdjoint(y) {
  const n = y.length;
  const out = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) { out[i + 1] += 0.5 * y[i]; out[i - 1] -= 0.5 * y[i]; }
  return out;
}

/** Centred convolution, output length n: d_i = sum_k h_k x_{i - k + c}, c = floor(len/2). */
export function convolveCentred(x, h) {
  const n = x.length; const c = Math.floor(h.length / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < h.length; k++) { const j = i - k + c; if (j >= 0 && j < n) s += h[k] * x[j]; }
    out[i] = s;
  }
  return out;
}

/** Adjoint of convolveCentred. */
export function convolveCentredAdjoint(y, h) {
  const n = y.length; const c = Math.floor(h.length / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < h.length; k++) { const j = i - k + c; if (j >= 0 && j < n) out[j] += h[k] * y[i]; }
  }
  return out;
}

/** The forward model: the seismic trace of a ln(AI) log. */
export const forwardPoststack = (m, wavelet) => convolveCentred(diffCentred(m), wavelet);

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/**
 * CGLS for min ||A x - b||^2 with A given as (forward, adjoint), x0 start.
 * @returns {{x: Float64Array, iterations: number, residual: number}}
 */
function cgls(forward, adjoint, b, x0, { iters = 300, tol = 1e-10 } = {}) {
  const x = Float64Array.from(x0);
  const ax = forward(x);
  const r = b.map((v, i) => v - ax[i]);
  let s = adjoint(r);
  const p = Float64Array.from(s);
  let gamma = dot(s, s);
  const gamma0 = gamma;
  let it = 0;
  for (; it < iters && gamma > tol * tol * gamma0 && gamma > 0; it++) {
    const q = forward(p);
    const qq = dot(q, q);
    if (!(qq > 0)) break;
    const alpha = gamma / qq;
    for (let i = 0; i < x.length; i++) x[i] += alpha * p[i];
    for (let i = 0; i < r.length; i++) r[i] -= alpha * q[i];
    s = adjoint(r);
    const g1 = dot(s, s);
    const beta = g1 / gamma;
    gamma = g1;
    for (let i = 0; i < p.length; i++) p[i] = s[i] + beta * p[i];
  }
  return { x, iterations: it, residual: Math.sqrt(dot(r, r)) };
}

/**
 * Model-based inversion of one trace.
 * @param {{d: ArrayLike<number>, wavelet: ArrayLike<number>, m0: ArrayLike<number>, eps: number,
 *   blocky?: {epsTV: number, beta?: number, outer?: number}, iters?: number}} p
 *   m0 the low-frequency model of ln(AI); eps the weight of the pull towards it
 * @returns {{m: Float64Array, ai: Float64Array, synthetic: Float64Array, residualRms: number, iterations: number}}
 */
export function modelBased({ d, wavelet, m0, eps, blocky = null, iters = 300 }) {
  checkInputs(d, wavelet);
  const n = d.length;
  if (m0?.length !== n) throw new Error('The low-frequency model must have one value per trace sample.');
  if (!(eps >= 0)) throw new Error('The regularisation weight must be zero or positive.');
  const dd = Float64Array.from(d);
  const prior = Float64Array.from(m0);
  let w = null; // TV weights (n - 1)
  let m = Float64Array.from(prior);
  let total = 0;
  const outer = blocky ? Math.max(1, blocky.outer ?? 6) : 1;
  for (let o = 0; o < outer; o++) {
    const tv = blocky ? blocky.epsTV : 0;
    const fwd = (x) => {
      const out = new Float64Array(n + n + (blocky ? n - 1 : 0));
      out.set(forwardPoststack(x, wavelet), 0);
      for (let i = 0; i < n; i++) out[n + i] = eps * x[i];
      if (blocky) for (let i = 0; i < n - 1; i++) out[2 * n + i] = tv * Math.sqrt(w[i]) * (x[i + 1] - x[i]);
      return out;
    };
    const adj = (y) => {
      const out = diffCentredAdjoint(convolveCentredAdjoint(y.subarray(0, n), wavelet));
      for (let i = 0; i < n; i++) out[i] += eps * y[n + i];
      if (blocky) for (let i = 0; i < n - 1; i++) { const v = tv * Math.sqrt(w[i]) * y[2 * n + i]; out[i + 1] += v; out[i] -= v; }
      return out;
    };
    if (blocky) {
      const beta = blocky.beta ?? 1e-3;
      w = new Float64Array(n - 1);
      for (let i = 0; i < n - 1; i++) w[i] = 1 / Math.sqrt((m[i + 1] - m[i]) ** 2 + beta * beta);
    }
    const rhs = new Float64Array(n + n + (blocky ? n - 1 : 0));
    rhs.set(dd, 0);
    for (let i = 0; i < n; i++) rhs[n + i] = eps * prior[i];
    const res = cgls(fwd, adj, rhs, m, { iters });
    m = res.x;
    total += res.iterations;
  }
  const synthetic = forwardPoststack(m, wavelet);
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (synthetic[i] - dd[i]) ** 2;
  return { m, ai: m.map(Math.exp), synthetic, residualRms: Math.sqrt(ss / n), iterations: total };
}

/** Largest eigenvalue of C^T C by power iteration (the FISTA step size). */
function opNorm2(wavelet, n, iters = 60) {
  let v = new Float64Array(n).map((_, i) => Math.sin(i + 1));
  let lam = 0;
  for (let k = 0; k < iters; k++) {
    const u = convolveCentredAdjoint(convolveCentred(v, wavelet), wavelet);
    lam = Math.sqrt(dot(u, u));
    if (!(lam > 0)) return 0;
    v = u.map((x) => x / lam);
  }
  return lam;
}

/**
 * FISTA for min 1/2 ||C r - d||^2 + lambda ||r||_1.
 * @returns {{r: Float64Array, iterations: number}}
 */
export function fistaReflectivity({ d, wavelet, lambda, iters = 300, step = null }) {
  checkInputs(d, wavelet);
  const n = d.length;
  const L = step ? 1 / step : opNorm2(wavelet, n);
  const t = 1 / L;
  let x = new Float64Array(n);
  let y = Float64Array.from(x);
  let tk = 1;
  const soft = (v, th) => (v > th ? v - th : v < -th ? v + th : 0);
  for (let k = 0; k < iters; k++) {
    const cy = convolveCentred(y, wavelet);
    const g = convolveCentredAdjoint(cy.map((v, i) => v - d[i]), wavelet);
    const xn = y.map((v, i) => soft(v - t * g[i], lambda * t));
    const tn = (1 + Math.sqrt(1 + 4 * tk * tk)) / 2;
    y = xn.map((v, i) => v + ((tk - 1) / tn) * (v - x[i]));
    x = xn;
    tk = tn;
  }
  return { r: x, iterations: iters };
}

/**
 * Sparse-spike inversion of one trace: FISTA reflectivity, integrated to
 * ln(AI) (the centred difference inverted by a running sum over pairs),
 * merged with the low-frequency model through a cosine crossover.
 * @param {{d, wavelet, m0, lambda: number, dtMs: number, crossoverHz?: number, iters?: number}} p
 */
export function sparseSpike({ d, wavelet, m0, lambda, dtMs, crossoverHz = 8, iters = 400 }) {
  checkInputs(d, wavelet);
  const n = d.length;
  if (m0?.length !== n) throw new Error('The low-frequency model must have one value per trace sample.');
  if (!(dtMs > 0)) throw new Error('The sample interval must be positive.');
  const { r } = fistaReflectivity({ d, wavelet, lambda, iters });
  // relative ln(AI): with (D m)_i = (m_{i+1} - m_{i-1}) / 2, m_{i+1} = m_{i-1} + 2 r_i
  const rel = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) rel[i + 1] = rel[i - 1] + 2 * r[i];
  // the two interleaved chains share no information; level each to its mean
  for (const start of [0, 1]) {
    let s = 0; let c = 0;
    for (let i = start; i < n; i += 2) { s += rel[i]; c += 1; }
    for (let i = start; i < n; i += 2) rel[i] -= s / c;
  }
  // merge: high frequencies from rel, low from m0, by a moving-average split
  const half = Math.max(1, Math.round(1000 / (crossoverHz * dtMs) / 2));
  const smooth = (x) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0; let c = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) { s += x[j]; c += 1; }
      out[i] = s / c;
    }
    return out;
  };
  const relLow = smooth(rel);
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) m[i] = m0[i] + (rel[i] - relLow[i]);
  return { r, m, ai: m.map(Math.exp), synthetic: forwardPoststack(m, wavelet) };
}

/**
 * The low-frequency model of a log: ln(AI) low-passed by a moving average of
 * the given length in samples (the LFM at a well; interpolating LFMs between
 * wells along horizons is the builder's job).
 */
export function lowFrequencyModel(lnAi, halfWindow) {
  const n = lnAi.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; let c = 0;
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(n - 1, i + halfWindow); j++) if (fin(lnAi[j])) { s += lnAi[j]; c += 1; }
    out[i] = c ? s / c : NaN;
  }
  return out;
}
