/**
 * Phase stability + two-phase PT flash on the PR78 core — FS3.
 *
 * Michelsen (1982a) tangent-plane stability with two-sided trials,
 * successive substitution accelerated with single-eigenvalue GDEM
 * (Crowe & Nishio), Rachford-Rice solved over the Whitson negative-flash
 * window, and an orchestrating flashPT() that reports per-phase
 * properties through pr78.phaseProps.
 *
 * Binding FS decisions: SS + GDEM only (full Newton deferred), two
 * phases only (no aqueous), PT spec only. Units psia/degR as everywhere
 * in this directory.
 *
 * Validated by tools/validation/fluidstudio/ (plain-SS oracle flash
 * goldens sealed by quadrature fugacity equality) and
 * __tests__/flash.test.js.
 */

import { mixParams, solveCubicZ, selectRoot, lnPhiVector, phaseProps } from './pr78.js';

/** Wilson (1968) K-value estimate, the standard SS starting point. */
export function wilsonK(mix, tR, pPsia) {
  return mix.comps.map(
    (c) => (c.pcPsia / pPsia) * Math.exp(5.373 * (1 + c.omega) * (1 - c.tcR / tR)),
  );
}

/** lnPhi + chosen Z at a composition (thin wrapper reused by the solvers). */
function lnPhiAt(mix, x, tR, pPsia, root = 'gibbs') {
  const params = mixParams(mix, x, tR, pPsia);
  const roots = solveCubicZ(params.A, params.B);
  const z = selectRoot(roots, params, x, root);
  return { lnPhi: lnPhiVector(params, x, z), z };
}

/**
 * Rachford-Rice over the negative-flash window
 * (1/(1 - Kmax), 1/(1 - Kmin)) per Whitson & Michelsen (1989).
 * g is strictly decreasing there, so Newton with a bisection safeguard
 * cannot escape. Returns null when K does not straddle 1 (no root).
 */
export function solveRachfordRice(z, K, { tol = 1e-14, maxIter = 100 } = {}) {
  const n = z.length;
  let kMax = -Infinity;
  let kMin = Infinity;
  for (let i = 0; i < n; i += 1) {
    if (z[i] <= 0) continue;
    if (K[i] > kMax) kMax = K[i];
    if (K[i] < kMin) kMin = K[i];
  }
  if (!(kMax > 1) || !(kMin < 1)) return null;

  const g = (beta) => {
    let s = 0;
    for (let i = 0; i < n; i += 1) s += (z[i] * (K[i] - 1)) / (1 + beta * (K[i] - 1));
    return s;
  };
  const dg = (beta) => {
    let s = 0;
    for (let i = 0; i < n; i += 1) {
      const d = 1 + beta * (K[i] - 1);
      s -= (z[i] * (K[i] - 1) ** 2) / (d * d);
    }
    return s;
  };

  const margin = 1e-12;
  let lo = 1 / (1 - kMax) + margin;
  let hi = 1 / (1 - kMin) - margin;
  let beta = Math.min(Math.max(0.5, lo), hi);
  for (let it = 0; it < maxIter; it += 1) {
    const gb = g(beta);
    if (Math.abs(gb) < tol) break;
    if (gb > 0) lo = beta; else hi = beta; // g decreasing: root is to the right of positive g
    const step = gb / dg(beta);
    let next = beta - step;
    if (!(next > lo) || !(next < hi)) next = 0.5 * (lo + hi);
    if (next === beta) break;
    beta = next;
  }

  const x = new Array(n);
  const y = new Array(n);
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    x[i] = z[i] / (1 + beta * (K[i] - 1));
    y[i] = K[i] * x[i];
    sx += x[i];
    sy += y[i];
  }
  for (let i = 0; i < n; i += 1) {
    x[i] /= sx;
    y[i] /= sy;
  }
  return { beta, x, y, residual: g(beta) };
}

/** GDEM single-eigenvalue promotion applied in place to lnV (Crowe & Nishio). */
function gdemPromote(lnV, d1, d0) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < lnV.length; i += 1) {
    num += d1[i] * d0[i];
    den += d0[i] * d0[i];
  }
  if (!(den > 0)) return;
  const lambda = num / den;
  if (!(lambda > 0) || !(lambda < 0.98)) return; // diverging or noisy: skip
  const f = lambda / (1 - lambda);
  for (let i = 0; i < lnV.length; i += 1) lnV[i] += d1[i] * f;
}

/**
 * One Michelsen trial: iterate ln Y_i = h_i - lnPhi_i(Y/S) from the
 * given start. Reports the mole-number sum S, the modified tangent-plane
 * distance at convergence (tpd = 1 - S; negative <=> feed unstable) and
 * whether the trial collapsed onto the feed (trivial).
 */
function stabilityTrial(mix, z, tR, pPsia, h, y0, { tol, maxIter, gdemEvery }) {
  const n = z.length;
  let lnY = y0.map((v) => Math.log(v));
  let dPrev = null;
  let converged = false;
  let iterations = 0;
  for (let it = 1; it <= maxIter; it += 1) {
    iterations = it;
    let s = 0;
    const Y = lnY.map((v) => Math.exp(v));
    for (const v of Y) s += v;
    const y = Y.map((v) => v / s);
    const { lnPhi } = lnPhiAt(mix, y, tR, pPsia);
    const lnYNew = h.map((hv, i) => hv - lnPhi[i]);
    const d = lnYNew.map((v, i) => v - lnY[i]);
    let r2 = 0;
    for (const v of d) r2 += v * v;
    lnY = lnYNew;
    if (r2 < tol) {
      converged = true;
      break;
    }
    if (dPrev && it % gdemEvery === 0) gdemPromote(lnY, d, dPrev);
    dPrev = d;
  }
  const Y = lnY.map((v) => Math.exp(v));
  let S = 0;
  for (const v of Y) S += v;
  let distFeed = 0;
  for (let i = 0; i < n; i += 1) distFeed += (lnY[i] - Math.log(z[i])) ** 2;
  return {
    converged,
    iterations,
    S,
    tpd: 1 - S,
    trivial: distFeed < 1e-8,
    y: Y.map((v) => v / S),
  };
}

/**
 * Two-sided Michelsen stability test at (z, T, P).
 * stable = neither trial found a mole-number sum meaningfully above 1
 * (non-trivial negative tangent-plane distance). kSuggest carries the
 * flash K start distilled from the most unstable trial.
 */
export function stabilityTest(mix, z, tR, pPsia, opts = {}) {
  const { tol = 1e-13, maxIter = 500, gdemEvery = 5 } = opts;
  const { lnPhi: lnPhiZ } = lnPhiAt(mix, z, tR, pPsia);
  const h = z.map((zi, i) => Math.log(zi) + lnPhiZ[i]);
  const kW = wilsonK(mix, tR, pPsia);

  const trials = [
    { kind: 'vapor-like', ...stabilityTrial(mix, z, tR, pPsia, h, z.map((zi, i) => zi * kW[i]), { tol, maxIter, gdemEvery }) },
    { kind: 'liquid-like', ...stabilityTrial(mix, z, tR, pPsia, h, z.map((zi, i) => zi / kW[i]), { tol, maxIter, gdemEvery }) },
  ];

  const unstable = trials.filter((t) => t.converged && !t.trivial && t.S > 1 + 1e-8);
  let kSuggest = null;
  if (unstable.length) {
    const worst = unstable.reduce((a, b) => (a.tpd <= b.tpd ? a : b));
    kSuggest = worst.kind === 'vapor-like'
      ? worst.y.map((yi, i) => yi / z[i])
      : worst.y.map((yi, i) => z[i] / yi);
  }
  return { stable: unstable.length === 0, trials, kSuggest };
}

/**
 * Two-phase PT flash: stability-gated SS + GDEM on ln K with
 * Rachford-Rice inner solves. Returns phases: 1 with the feed state when
 * the mixture is stable (or the negative flash lands outside (0,1));
 * phases: 2 with per-phase pr78.phaseProps otherwise.
 */
export function flashPT(mix, z, tR, pPsia, opts = {}) {
  // tol is on the squared ln K step norm; 1e-20 puts the converged state
  // within ~1e-10 per component of the SS fixed point, cheap under GDEM
  const { tol = 1e-20, maxIter = 1000, gdemEvery = 5, skipStability = false } = opts;

  const stability = skipStability ? null : stabilityTest(mix, z, tR, pPsia, opts.stability || {});
  if (stability && stability.stable) {
    return { phases: 1, reason: 'stable', feed: phaseProps(mix, z, tR, pPsia), stability };
  }

  let lnK = (stability?.kSuggest || wilsonK(mix, tR, pPsia)).map((k) => Math.log(k));
  let rr = null;
  let converged = false;
  let iterations = 0;
  let dPrev = null;
  for (let it = 1; it <= maxIter; it += 1) {
    iterations = it;
    rr = solveRachfordRice(z, lnK.map(Math.exp));
    if (!rr) break; // K collapsed to one side of 1: no two-phase solution
    const { lnPhi: lnPhiL } = lnPhiAt(mix, rr.x, tR, pPsia);
    const { lnPhi: lnPhiV } = lnPhiAt(mix, rr.y, tR, pPsia);
    const lnKNew = lnPhiL.map((v, i) => v - lnPhiV[i]);
    const d = lnKNew.map((v, i) => v - lnK[i]);
    let r2 = 0;
    let k2 = 0;
    for (let i = 0; i < d.length; i += 1) {
      r2 += d[i] * d[i];
      k2 += lnKNew[i] * lnKNew[i];
    }
    lnK = lnKNew;
    if (k2 < 1e-10) { rr = null; break; } // trivial K -> 1: single phase
    if (r2 < tol) {
      converged = true;
      break;
    }
    if (dPrev && it % gdemEvery === 0) gdemPromote(lnK, d, dPrev);
    dPrev = d;
  }

  if (!rr || !converged) {
    return {
      phases: 1,
      reason: rr ? 'not-converged' : 'trivial',
      feed: phaseProps(mix, z, tR, pPsia),
      stability,
      iterations,
      converged: false,
    };
  }
  // final RR at the converged K so beta/x/y are self-consistent
  const K = lnK.map(Math.exp);
  rr = solveRachfordRice(z, K);
  if (!rr || rr.beta <= 0 || rr.beta >= 1) {
    return {
      phases: 1,
      reason: rr && rr.beta <= 0 ? 'negative-flash-liquid' : 'negative-flash-vapor',
      feed: phaseProps(mix, z, tR, pPsia),
      stability,
      K,
      beta: rr ? rr.beta : null,
      iterations,
      converged,
    };
  }
  return {
    phases: 2,
    beta: rr.beta,
    K,
    x: rr.x,
    y: rr.y,
    liquid: phaseProps(mix, rr.x, tR, pPsia),
    vapor: phaseProps(mix, rr.y, tR, pPsia),
    stability,
    iterations,
    converged,
  };
}
