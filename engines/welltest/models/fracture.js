/**
 * Vertical fracture models (WT3), Laplace space, dimensionless time based on
 * fracture half-length: tDxf = 0.0002637 k t / (phi mu ct xf^2), with v the
 * Laplace variable conjugate to tDxf.
 *
 * Uniform-flux / infinite-conductivity fracture (Gringarten, Ramey &
 * Raghavan, 1974). Plane source of total Laplace rate 1/v along
 * xD in [-1, 1]:
 *
 *   pfD(xD, v) = [ F(sqrt(v)(1+xD)) + F(sqrt(v)(1-xD)) ] / (2 v^{3/2})
 *   F(x) = int_0^x K0(t) dt
 *
 * Wellbore pressure: xD = 0 for uniform flux; xD = 0.732 reproduces the
 * infinite-conductivity response (Gringarten's equivalent-pressure point).
 * Exact limits (harness gates): early linear flow pwD = sqrt(pi tDxf)
 * (half slope); late pseudo-radial pwD = 0.5 (ln tDxf + 2.80907) for
 * uniform flux and 0.5 (ln tDxf + 2.2) for infinite conductivity
 * (effective wellbore radius xf/e and xf/2).
 *
 * Finite-conductivity fracture (Cinco-Ley, Samaniego & Dominguez, 1978,
 * solved by the Cinco-Ley & Meng, 1988 discretization): the half wing [0, 1]
 * is split into n segments of piecewise-constant flux q_j; incompressible
 * 1D Darcy flow inside the fracture couples to the reservoir plane-source
 * response:
 *
 *   reservoir:  pD(xi) = sum_j q_j R_ij   (own wing + mirror wing K0 integrals)
 *   fracture:   pD(xi) = pwD - (2 pi / FcD) sum_j q_j g_ij
 *   rate:       sum_j q_j delta = 1/(2v)
 *
 * with FcD = kf w / (k xf). Solving the (n+1) linear system per Laplace node
 * gives pwD(v). Exact limits (harness gates): bilinear flow
 * pwD = [pi / (Gamma(5/4) sqrt(2 FcD))] tDxf^{1/4} = 2.451 FcD^{-1/2} tDxf^{1/4}
 * (quarter slope) while the tip is not felt; convergence to the
 * infinite-conductivity solution as FcD -> inf; late pseudo-radial flow.
 *
 * Wellbore storage and choked-fracture skin are composed in the rw-based
 * Laplace domain by the shared composition in radial.js; the rw <-> xf time
 * rescale is pwD(u) = A pfD(A u) with A = (xf/rw)^2.
 */

import { besselK0Integral } from '../numerics.js';
import { solveLinear } from '../lmFit.js';
import { composeWellbore } from './radial.js';

const F = besselK0Integral;

/** Uniform-flux / infinite-conductivity fracture, tDxf Laplace domain. */
export const ufFracturePwdLaplace = (v, { xD = 0 } = {}) => {
  if (!(v > 0)) return NaN;
  const rv = Math.sqrt(v);
  return (F(rv * (1 + xD)) + F(rv * (1 - xD))) / (2 * v * rv);
};

export const INFINITE_CONDUCTIVITY_XD = 0.732;

/** K0 integral over [a, b] at scale rv, observation point xi (same axis). */
const segK0Integral = (rv, xi, a, b) => {
  if (xi <= a) return (F(rv * (b - xi)) - F(rv * (a - xi))) / rv;
  if (xi >= b) return (F(rv * (xi - a)) - F(rv * (xi - b))) / rv;
  return (F(rv * (xi - a)) + F(rv * (b - xi))) / rv;
};

/** Fracture-flow geometric kernel g_ij = int_0^{xi} len([aj,bj] ∩ (x',1]) dx'. */
const gKernel = (xi, a, b) => {
  const len = b - a;
  if (xi <= a) return len * xi;
  if (xi >= b) return len * a + (len * len) / 2;
  return len * a + (len * len - (b - xi) * (b - xi)) / 2;
};

/**
 * Finite-conductivity fracture pwD in the tDxf Laplace domain.
 * @param {number} v Laplace variable
 * @param {{fcd: number, nSeg?: number}} params
 */
const GRADING_EXPONENT = 2; // segment edges (j/n)^2: fine near the wellbore,
// where the flux concentrates during bilinear flow

export const fcFracturePwdLaplace = (v, { fcd, nSeg = 12 } = {}) => {
  if (!(v > 0) || !(fcd > 0)) return NaN;
  const n = Math.max(4, Math.round(nSeg));
  const rv = Math.sqrt(v);
  const edges = Array.from({ length: n + 1 }, (_, j) => Math.pow(j / n, GRADING_EXPONENT));
  // rows: n collocation equations + rate constraint; cols: q_1..q_n, pwD
  const A = [];
  const rhs = [];
  for (let i = 0; i < n; i += 1) {
    const xi = (edges[i] + edges[i + 1]) / 2;
    const row = new Array(n + 1).fill(0);
    for (let j = 0; j < n; j += 1) {
      const a = edges[j];
      const b = edges[j + 1];
      const reservoir = segK0Integral(rv, xi, a, b) + segK0Integral(rv, xi, -b, -a);
      row[j] = reservoir + ((2 * Math.PI) / fcd) * gKernel(xi, a, b);
    }
    row[n] = -1;
    A.push(row);
    rhs.push(0);
  }
  const rateRow = edges.slice(1).map((b, j) => b - edges[j]);
  rateRow.push(0);
  A.push(rateRow);
  rhs.push(1 / (2 * v));
  const solution = solveLinear(A, rhs);
  if (!solution) return NaN;
  return solution[n];
};

/**
 * Factory: catalog-ready pwdLaplace(u, dimless) in the rw-based domain.
 * dimless: { xfOverRw, skin, cd, fcd? } (fcd only for finite conductivity).
 */
export const makeFracturePwdLaplace = ({ conductivity }) => (u, dimless = {}) => {
  const ratio = Math.max(dimless.xfOverRw, 1e-9);
  const A = ratio * ratio; // tD(rw) = A tDxf  =>  pwD(u) = A pfD(A u)
  const v = A * u;
  const p0 =
    conductivity === 'finite'
      ? A * fcFracturePwdLaplace(v, { fcd: dimless.fcd })
      : A * ufFracturePwdLaplace(v, { xD: INFINITE_CONDUCTIVITY_XD });
  return composeWellbore(u, p0, dimless.skin, dimless.cd);
};
