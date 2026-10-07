// Prestack simultaneous inversion (QI programme Q8b, Milestone C; SOW
// section 9): ln(AI), ln(SI) and ln(rho) from angle gathers or angle stacks
// at once, with Fatti et al.'s (1994) three-term linearisation
//   R(theta) = G1 dln(AI) + G2 dln(SI) + G3 dln(rho)
//   G1 = (1 + tan^2) / 2,  G2 = -4 K^2 sin^2,  G3 = (4 K^2 sin^2 - tan^2) / 2
// (K the background Vs/Vp), each angle convolved with its wavelet, the
// derivative the centred one of the post-stack engine. The operator is
// pylops' PrestackLinearModelling (explicit, linearization 'fatti', kind
// 'centered'), so pylops is the oracle. The model-based solution minimises
// ||d - F m||^2 + sum_p eps_p^2 ||m_p - m0_p||^2 by CGLS, each parameter
// pulled to its own low-frequency model. Density is the least resolved
// parameter and needs the far angles (Buland and Omre 2003). Pure, float64.

import { diffCentred, diffCentredAdjoint, convolveCentred, convolveCentredAdjoint } from './inversion.js';

const RAD = Math.PI / 180;
const fin = Number.isFinite;

/** Fatti's three coefficients per angle (degrees). */
export function fattiCoefficients(thetaDeg, vsVp) {
  const K2 = vsVp * vsVp;
  return thetaDeg.map((a) => {
    const t = a * RAD; const s2 = Math.sin(t) ** 2; const tn2 = Math.tan(t) ** 2;
    return [0.5 * (1 + tn2), -4 * K2 * s2, 0.5 * (4 * K2 * s2 - tn2)];
  });
}

const waveletOf = (wavelets, k) => (Array.isArray(wavelets[0]) || ArrayBuffer.isView(wavelets[0]) ? wavelets[k] : wavelets);

/**
 * Synthetic angle traces of a model.
 * @param {{lnAi, lnSi, lnRho}} m one value per sample each
 * @param {number[]} thetaDeg
 * @param {ArrayLike<number>|ArrayLike<number>[]} wavelets one for all angles, or one per angle
 * @returns {Float64Array[]} one trace per angle
 */
export function forwardFatti(m, thetaDeg, wavelets, vsVp) {
  const G = fattiCoefficients(thetaDeg, vsVp);
  const d = [diffCentred(m.lnAi), diffCentred(m.lnSi), diffCentred(m.lnRho)];
  const n = d[0].length;
  return G.map((g, k) => {
    const r = new Float64Array(n);
    for (let i = 0; i < n; i++) r[i] = g[0] * d[0][i] + g[1] * d[1][i] + g[2] * d[2][i];
    return convolveCentred(r, waveletOf(wavelets, k));
  });
}

/** The adjoint: angle traces back to the three parameter traces. */
export function forwardFattiAdjoint(traces, thetaDeg, wavelets, vsVp) {
  const G = fattiCoefficients(thetaDeg, vsVp);
  const n = traces[0].length;
  const acc = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  G.forEach((g, k) => {
    const r = convolveCentredAdjoint(traces[k], waveletOf(wavelets, k));
    for (let p = 0; p < 3; p++) for (let i = 0; i < n; i++) acc[p][i] += g[p] * r[i];
  });
  return acc.map((a) => diffCentredAdjoint(a));
}

/**
 * Model-based simultaneous inversion of one CDP.
 * @param {Object} p
 * @param {ArrayLike<number>[]} p.traces one per angle (NaN read as 0 and left out of the misfit)
 * @param {number[]} p.thetaDeg
 * @param {ArrayLike<number>|ArrayLike<number>[]} p.wavelets
 * @param {number} p.vsVp background Vs/Vp
 * @param {{lnAi, lnSi, lnRho}} p.m0 the low-frequency models
 * @param {[number, number, number]} p.eps the pull of each parameter to its model
 * @param {number} [p.iters]
 * @returns {{lnAi: Float64Array, lnSi: Float64Array, lnRho: Float64Array, residualRms: number, iterations: number}}
 */
export function simultaneousInversion({ traces, thetaDeg, wavelets, vsVp, m0, eps, iters = 300 }) {
  const nT = thetaDeg.length; const n = m0.lnAi.length;
  if (traces.length !== nT) throw new Error('One trace per angle.');
  if (!(vsVp > 0 && vsVp < 1)) throw new Error('Vs/Vp must be between 0 and 1.');
  if (!Array.isArray(eps) || eps.length !== 3 || eps.some((e) => !(e >= 0))) throw new Error('Give the three regularisation weights, zero or positive.');
  const live = traces.map((t) => Uint8Array.from(t, (v) => (fin(v) ? 1 : 0)));
  const d = traces.map((t) => Float64Array.from(t, (v) => (fin(v) ? v : 0)));
  const prior = [Float64Array.from(m0.lnAi), Float64Array.from(m0.lnSi), Float64Array.from(m0.lnRho)];
  // the stacked operator [F; E] and its adjoint on x = [lnAi; lnSi; lnRho]
  const split = (x) => [x.subarray(0, n), x.subarray(n, 2 * n), x.subarray(2 * n, 3 * n)];
  const A = (x) => {
    const [a, s, r] = split(x);
    const syn = forwardFatti({ lnAi: a, lnSi: s, lnRho: r }, thetaDeg, wavelets, vsVp);
    const out = new Float64Array(nT * n + 3 * n);
    syn.forEach((tr, k) => { for (let i = 0; i < n; i++) out[k * n + i] = live[k][i] ? tr[i] : 0; });
    for (let p = 0; p < 3; p++) for (let i = 0; i < n; i++) out[nT * n + p * n + i] = eps[p] * x[p * n + i];
    return out;
  };
  const At = (y) => {
    const tr = Array.from({ length: nT }, (_, k) => Float64Array.from({ length: n }, (_, i) => (live[k][i] ? y[k * n + i] : 0)));
    const back = forwardFattiAdjoint(tr, thetaDeg, wavelets, vsVp);
    const out = new Float64Array(3 * n);
    for (let p = 0; p < 3; p++) for (let i = 0; i < n; i++) out[p * n + i] = back[p][i] + eps[p] * y[nT * n + p * n + i];
    return out;
  };
  const b = new Float64Array(nT * n + 3 * n);
  d.forEach((tr, k) => { for (let i = 0; i < n; i++) b[k * n + i] = live[k][i] ? tr[i] : 0; });
  for (let p = 0; p < 3; p++) for (let i = 0; i < n; i++) b[nT * n + p * n + i] = eps[p] * prior[p][i];
  // CGLS from the prior
  let x = new Float64Array(3 * n);
  for (let p = 0; p < 3; p++) x.set(prior[p], p * n);
  const Ax = A(x);
  let r = b.map((v, i) => v - Ax[i]);
  let s = At(r); let pdir = Float64Array.from(s);
  let gamma = s.reduce((a, v) => a + v * v, 0);
  const g0 = gamma;
  let it = 0;
  for (; it < iters && gamma > 1e-30 * Math.max(1, g0); it++) {
    const q = A(pdir);
    const qq = q.reduce((a, v) => a + v * v, 0);
    if (!(qq > 0)) break;
    const alpha = gamma / qq;
    for (let i = 0; i < x.length; i++) x[i] += alpha * pdir[i];
    for (let i = 0; i < r.length; i++) r[i] -= alpha * q[i];
    s = At(r);
    const gNew = s.reduce((a, v) => a + v * v, 0);
    const beta = gNew / gamma;
    for (let i = 0; i < pdir.length; i++) pdir[i] = s[i] + beta * pdir[i];
    gamma = gNew;
  }
  const [la, ls, lr] = split(x);
  const syn = forwardFatti({ lnAi: la, lnSi: ls, lnRho: lr }, thetaDeg, wavelets, vsVp);
  let ss = 0; let cnt = 0;
  syn.forEach((tr, k) => { for (let i = 0; i < n; i++) if (live[k][i]) { ss += (tr[i] - d[k][i]) ** 2; cnt += 1; } });
  return { lnAi: Float64Array.from(la), lnSi: Float64Array.from(ls), lnRho: Float64Array.from(lr), residualRms: cnt ? Math.sqrt(ss / cnt) : NaN, iterations: it };
}
