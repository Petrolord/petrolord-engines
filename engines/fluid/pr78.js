/**
 * Peng-Robinson (1978) EOS core — FS2.
 *
 * Formulation per Peng & Robinson (1976) with the 1978 heavy-component
 * kappa extension, as compiled in Whitson & Brulé, SPE Monograph 20,
 * Ch. 4 (eqs. 4.20-4.28) — the same source as the component library.
 * Volume translation per Peneloux et al. (1982) with the Jhaveri &
 * Youngren (SPE 13118) dimensionless shifts carried by components.js.
 *
 * Units: psia / °R / lb-mol / ft³ throughout (see units.js). All
 * functions are pure and synchronous; nothing here touches the UI.
 *
 * Scope (binding FS decisions): PR78 only, van der Waals one-fluid
 * mixing with the FS1 BIP table, lowest-Gibbs root selection, Peneloux
 * applied to volumes/densities only (it cancels identically in
 * equilibrium ratios, so lnPhi is reported untranslated). Stability
 * analysis and flash arrive in FS3; C7+ characterization in FS4.
 *
 * Validated by tools/validation/fluidstudio/ (independent Python oracle
 * goldens + NIST vapor-pressure gates) and __tests__/pr78.test.js.
 */

import { COMPONENTS, buildBipMatrix } from './components.js';
import { R_PSIA } from './units.js';

/** PR omega-a / omega-b (exact algebraic values, Monograph 20 eq. 4.21). */
export const OMEGA_A = 0.457235529;
export const OMEGA_B = 0.077796074;

const SQRT2 = Math.SQRT2;
const D1 = 1 + SQRT2; // PR delta constants: v² + 2bv − b² = (v + d1 b)(v + d2 b)
const D2 = 1 - SQRT2;

/**
 * PR78 kappa. The 1978 revision replaces the 1976 quadratic with a cubic
 * for omega > 0.491 (heavy fractions); below that the original applies.
 */
export function kappaPR78(omega) {
  if (omega > 0.491) {
    return 0.379642 + omega * (1.48503 + omega * (-0.164423 + omega * 0.016666));
  }
  return 0.37464 + omega * (1.54226 - omega * 0.26992);
}

/**
 * Assemble the EOS mixture description for ordered component keys from
 * the FS1 library. `extra` lets FS4 append a characterized plus fraction:
 * a map of key → full property object ({ mw, tcR, pcPsia, omega, shift, … }),
 * with its BIPs supplied via `extraBip` (map of key → { otherKey: kij }).
 */
export function mixtureFromKeys(keys, extra = {}, extraBip = {}) {
  const comps = keys.map((k) => {
    const c = COMPONENTS[k] || extra[k];
    if (!c) throw new Error(`Unknown EOS component: ${k}`);
    return { key: k, ...c };
  });
  const base = buildBipMatrix(keys);
  const bip = base.map((row, i) => row.map((v, j) => {
    const a = keys[i]; const b = keys[j];
    if (extraBip[a] && extraBip[a][b] !== undefined) return extraBip[a][b];
    if (extraBip[b] && extraBip[b][a] !== undefined) return extraBip[b][a];
    return v;
  }));
  return { keys, comps, bip };
}

/** Per-component a(T), b (dimensional, psia·ft⁶/lb-mol² and ft³/lb-mol). */
export function pureParams(comp, tR) {
  const tr = tR / comp.tcR;
  const alphaSqrt = 1 + kappaPR78(comp.omega) * (1 - Math.sqrt(tr));
  const rtc = R_PSIA * comp.tcR;
  return {
    a: (OMEGA_A * rtc * rtc * alphaSqrt * alphaSqrt) / comp.pcPsia,
    b: (OMEGA_B * rtc) / comp.pcPsia,
  };
}

/**
 * van der Waals one-fluid mixing at (x, T, P).
 * Returns dimensional a, b, dimensionless A, B, and sumA[i] = Σ_j x_j a_ij
 * (the composition-derivative sum the fugacity expression needs).
 */
export function mixParams(mix, x, tR, pPsia) {
  const n = mix.comps.length;
  const ai = new Array(n);
  const bi = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = pureParams(mix.comps[i], tR);
    ai[i] = p.a;
    bi[i] = p.b;
  }
  let a = 0;
  let b = 0;
  const sumA = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    b += x[i] * bi[i];
    for (let j = 0; j < n; j += 1) {
      const aij = Math.sqrt(ai[i] * ai[j]) * (1 - mix.bip[i][j]);
      sumA[i] += x[j] * aij;
      a += x[i] * x[j] * aij;
    }
  }
  const rt = R_PSIA * tR;
  return { ai, bi, a, b, sumA, A: (a * pPsia) / (rt * rt), B: (b * pPsia) / rt };
}

/**
 * Real roots of the PR compressibility cubic
 *   Z³ − (1−B)Z² + (A−3B²−2B)Z − (AB−B²−B³) = 0,
 * ascending, Newton-polished, deduplicated. Physical filtering (Z > B)
 * happens in the caller so degenerate cases stay observable.
 */
export function solveCubicZ(A, B) {
  const c2 = -(1 - B);
  const c1 = A - 3 * B * B - 2 * B;
  const c0 = -(A * B - B * B - B * B * B);

  const p = c1 - (c2 * c2) / 3;
  const q = (2 * c2 * c2 * c2) / 27 - (c2 * c1) / 3 + c0;
  const disc = (q * q) / 4 + (p * p * p) / 27;

  let roots;
  if (disc > 0) {
    const s = Math.sqrt(disc);
    const t = Math.cbrt(-q / 2 + s) + Math.cbrt(-q / 2 - s);
    roots = [t - c2 / 3];
  } else {
    const r = Math.sqrt(-p / 3);
    const theta = Math.acos(Math.min(1, Math.max(-1, (3 * q) / (2 * p * r))));
    roots = [0, 1, 2].map(
      (k) => 2 * r * Math.cos((theta + 2 * Math.PI * k) / 3) - c2 / 3,
    );
  }

  const f = (z) => ((z + c2) * z + c1) * z + c0;
  const df = (z) => (3 * z + 2 * c2) * z + c1;
  const polished = roots.map((z0) => {
    let z = z0;
    for (let it = 0; it < 3; it += 1) {
      const d = df(z);
      if (d === 0) break;
      z -= f(z) / d;
    }
    return z;
  }).sort((u, v) => u - v);

  const out = [];
  for (const z of polished) {
    if (!out.length || Math.abs(z - out[out.length - 1]) > 1e-9) out.push(z);
  }
  return out;
}

/** ln(phi_i) vector at a given root (Monograph 20 eq. 4.28). */
export function lnPhiVector(params, x, zFactor) {
  const { a, b, bi, sumA, A, B } = params;
  const n = x.length;
  const lnZmB = Math.log(zFactor - B);
  const logTerm = Math.log((zFactor + D1 * B) / (zFactor + D2 * B));
  const coeff = A / (2 * SQRT2 * B);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const bRatio = bi[i] / b;
    out[i] = bRatio * (zFactor - 1) - lnZmB
      - coeff * ((2 * sumA[i]) / a - bRatio) * logTerm;
  }
  return out;
}

const normalizedGibbs = (params, x, z) => {
  const lnPhi = lnPhiVector(params, x, z);
  let g = 0;
  for (let i = 0; i < x.length; i += 1) g += x[i] * lnPhi[i];
  return g;
};

/**
 * Pick the equilibrium root: physical roots are Z > B; with multiple
 * candidates the smallest-normalized-Gibbs root wins (`root: 'gibbs'`,
 * the default). 'min'/'max' force the liquid-like/vapor-like branch —
 * FS3's stability test needs both trial branches explicitly.
 */
export function selectRoot(roots, params, x, root = 'gibbs') {
  const physical = roots.filter((z) => z > params.B);
  if (!physical.length) return roots[roots.length - 1];
  if (root === 'min') return physical[0];
  if (root === 'max') return physical[physical.length - 1];
  if (physical.length === 1) return physical[0];
  const zMin = physical[0];
  const zMax = physical[physical.length - 1];
  return normalizedGibbs(params, x, zMin) <= normalizedGibbs(params, x, zMax) ? zMin : zMax;
}

/**
 * Full single-phase evaluation at (x, T, P).
 *
 * Returns the untranslated zFactor (equilibrium quantity), lnPhi and
 * fugacities from it, and Peneloux-translated molar volume / density /
 * zCorrected for reporting. `apparentMw` is Σ x_i MW_i.
 */
export function phaseProps(mix, x, tR, pPsia, { root = 'gibbs' } = {}) {
  const params = mixParams(mix, x, tR, pPsia);
  const roots = solveCubicZ(params.A, params.B);
  const zFactor = selectRoot(roots, params, x, root);
  const lnPhi = lnPhiVector(params, x, zFactor);
  const fugacityPsia = lnPhi.map((lp, i) => x[i] * pPsia * Math.exp(lp));

  const rt = R_PSIA * tR;
  let cShift = 0;
  let apparentMw = 0;
  for (let i = 0; i < x.length; i += 1) {
    cShift += x[i] * (mix.comps[i].shift ?? 0) * params.bi[i];
    apparentMw += x[i] * mix.comps[i].mw;
  }
  const molarVolumeEos = (zFactor * rt) / pPsia;
  const molarVolume = molarVolumeEos - cShift;
  return {
    zFactor,
    zCorrected: (pPsia * molarVolume) / rt,
    roots,
    lnPhi,
    fugacityPsia,
    molarVolumeEos,
    molarVolume,
    density: apparentMw / molarVolume,
    apparentMw,
    A: params.A,
    B: params.B,
  };
}

/**
 * Pure-component saturation pressure at tR (< Tc), psia.
 *
 * Successive substitution on the fugacity-equality condition,
 * P ← P·(phiL/phiV), started from the Wilson estimate. Inside the
 * two-phase window the pure cubic always has both branches; if the
 * iterate lands in a one-root region the pressure is nudged back toward
 * the window using the v/b < 1.75 liquid-likeness heuristic.
 */
export function purePsat(comp, tR, { tol = 1e-12, maxIter = 300 } = {}) {
  if (tR >= comp.tcR) return null;
  const mix = { comps: [comp], bip: [[0]] };
  const x = [1];
  let p = comp.pcPsia * Math.exp(5.373 * (1 + comp.omega) * (1 - comp.tcR / tR));
  p = Math.min(Math.max(p, 1e-8), 0.999 * comp.pcPsia);

  for (let it = 0; it < maxIter; it += 1) {
    const params = mixParams(mix, x, tR, p);
    const roots = solveCubicZ(params.A, params.B).filter((z) => z > params.B);
    if (roots.length < 2) {
      const z = roots[roots.length - 1];
      const vOverB = (z * R_PSIA * tR) / p / params.b;
      p *= vOverB < 1.75 ? 0.85 : 1.15; // liquid-only → P too high; vapor-only → too low
      continue;
    }
    const lnPhiL = lnPhiVector(params, x, roots[0])[0];
    const lnPhiV = lnPhiVector(params, x, roots[roots.length - 1])[0];
    const dLnPhi = lnPhiL - lnPhiV;
    if (Math.abs(dLnPhi) < tol) return p;
    p *= Math.exp(dLnPhi);
    if (!(p > 0) || !Number.isFinite(p)) return null;
  }
  return null;
}
