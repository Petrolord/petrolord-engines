/**
 * Saturation pressure + PT phase-envelope tracing — FS4.
 *
 * Both are built directly on the FS3 Michelsen stability test: at fixed
 * T the single-phase/two-phase boundary in P is located by scanning a
 * log-spaced pressure grid and bisecting every stability flip. That
 * reuses the validated stability/flash machinery unchanged, needs no
 * branch-switching logic for retrograde fluids (the upper dew branch
 * falls out of the scan like any other flip), and is exactly
 * reproducible by the plain-SS oracle. Full Michelsen (lnK, lnP, lnT)
 * continuation stays out of scope with the deferred full-Newton flash.
 *
 * Boundaries are classified by a flash just inside the two-phase side:
 * vapor fraction → 0 is a bubble point, → 1 a dew point.
 *
 * Caveats (documented; FS8 hardened the classification but the physics
 * limits stand):
 * - Composition-trial stability cannot see instability for a pure
 *   component, so these routines require ≥ 2 components with nonzero z.
 * - Near the mixture critical point both trials go trivial and the
 *   boundary is undetectable; envelope traces truncate there instead of
 *   closing the loop through the critical point.
 * - The scan can only find two-phase windows wider than its grid
 *   spacing. Near-pure fluids (window width → 0) need a larger nScan or
 *   a narrower [pMin, pMax] window than the defaults.
 *
 * FS8 near-critical fallback: boundary classification probes a ladder of
 * insets (1%, 3%, 6%) instead of a single 1% probe, because close to the
 * critical point the flash can refuse to split at the shallowest inset
 * while a slightly deeper one still resolves. If the whole ladder stays
 * indeterminate, saturationPressure falls back to the v/b < 1.75
 * liquid-likeness heuristic (the pr78.purePsat convention) so the UI
 * still gets a usable bubble/dew label, marked kindSource:
 * 'density-heuristic' instead of the default 'flash-probe'.
 *
 * Units psia / °R as everywhere in this directory.
 */

import { stabilityTest, flashPT } from './flash.js';
import { phaseProps } from './pr78.js';

const isUnstable = (mix, z, tR, p, stabilityOpts) => !stabilityTest(mix, z, tR, p, stabilityOpts).stable;

/**
 * All stability-boundary pressures at temperature tR inside
 * [pMinPsia, pMaxPsia], ascending. Each boundary carries the two-phase
 * side, the near-boundary vapor fraction and its kind:
 * 'bubble' (beta→0), 'dew' (beta→1) or 'indeterminate' (flash refused
 * to split at the probe pressure — pathologically near-critical).
 */
export function phaseBoundaries(mix, z, tR, opts = {}) {
  const {
    pMinPsia = 14.696,
    pMaxPsia = 12000,
    nScan = 40,
    tolPsia = 0.05,
  } = opts;
  // near a boundary the tangent-plane trials converge slowly (the SS
  // eigenvalue tends to 1), and an iteration-capped trial reads as
  // "stable"; a deep default budget keeps the flip pressure sharp
  const stabilityOpts = { maxIter: 4000, ...opts.stability };

  const lnLo = Math.log(pMinPsia);
  const lnHi = Math.log(pMaxPsia);
  const grid = Array.from(
    { length: nScan },
    (_, i) => Math.exp(lnLo + ((lnHi - lnLo) * i) / (nScan - 1)),
  );
  const flags = grid.map((p) => isUnstable(mix, z, tR, p, stabilityOpts));

  const boundaries = [];
  for (let i = 1; i < grid.length; i += 1) {
    if (flags[i] === flags[i - 1]) continue;
    let lo = grid[i - 1];
    let hi = grid[i];
    let loUnstable = flags[i - 1];
    while (hi - lo > tolPsia) {
      const mid = 0.5 * (lo + hi);
      if (isUnstable(mix, z, tR, mid, stabilityOpts) === loUnstable) lo = mid;
      else hi = mid;
    }
    const pBoundary = 0.5 * (lo + hi);
    const twoPhaseSide = loUnstable ? 'below' : 'above';
    boundaries.push({
      pPsia: pBoundary,
      twoPhaseSide,
      ...classifyBoundary(mix, z, tR, pBoundary, twoPhaseSide, { pMinPsia, tolPsia }),
    });
  }
  return boundaries;
}

/**
 * Classify a located boundary by flashing just inside its two-phase
 * side. The original FS4 probe sat at a single 1% inset; near the
 * critical point that flash can refuse to split while a deeper probe
 * still resolves, so FS8 walks an inset ladder before conceding
 * 'indeterminate'. probeBeta reports the shallowest successful probe.
 */
export function classifyBoundary(mix, z, tR, pBoundary, twoPhaseSide, opts = {}) {
  const { pMinPsia = 14.696, tolPsia = 0.05, insets = [0.01, 0.03, 0.06] } = opts;
  for (const frac of insets) {
    const inset = Math.max(5 * tolPsia, frac * pBoundary);
    const pProbe = twoPhaseSide === 'below'
      ? Math.max(pMinPsia, pBoundary - inset)
      : pBoundary + inset;
    const probe = flashPT(mix, z, tR, pProbe);
    if (probe.phases === 2) {
      return { kind: probe.beta < 0.5 ? 'bubble' : 'dew', probeBeta: probe.beta };
    }
    if (probe.reason === 'negative-flash-liquid') return { kind: 'bubble', probeBeta: null };
    if (probe.reason === 'negative-flash-vapor') return { kind: 'dew', probeBeta: null };
  }
  return { kind: 'indeterminate', probeBeta: null };
}

/**
 * Last-resort phase-kind inference from the single-phase feed just
 * outside the boundary: liquid-like (v/b < 1.75, the pr78.purePsat
 * convention) means the two-phase region is entered by nucleating gas,
 * i.e. a bubble point; vapor-like means a dew point.
 */
export function classifyByLiquidLikeness(mix, z, tR, pPsia) {
  const props = phaseProps(mix, z, tR, pPsia);
  return props.zFactor / props.B < 1.75 ? 'bubble' : 'dew';
}

/**
 * Saturation pressure at tR: the highest phase boundary in the window —
 * the bubble point of an oil or the (upper, if retrograde) dew point of
 * a gas condensate. Returns null when the fluid is single-phase across
 * the whole pressure window at this temperature.
 */
export function saturationPressure(mix, z, tR, opts = {}) {
  const boundaries = phaseBoundaries(mix, z, tR, opts);
  if (!boundaries.length) return null;
  const top = boundaries[boundaries.length - 1];
  if (top.kind !== 'indeterminate') {
    return { pPsia: top.pPsia, kind: top.kind, kindSource: 'flash-probe', boundaries };
  }
  // near-critical fallback (FS8): infer the kind from the single-phase
  // feed just above the top boundary; 2% clears the bisection tolerance
  const kind = classifyByLiquidLikeness(mix, z, tR, top.pPsia * 1.02);
  return { pPsia: top.pPsia, kind, kindSource: 'density-heuristic', boundaries };
}

/**
 * Trace the PT envelope on a temperature grid. Returns per-temperature
 * boundary sets plus flat bubble/dew polylines for plotting. The FS5 UI
 * runs this in a web worker; it is the slow path (hundreds of stability
 * bisections).
 */
export function tracePhaseEnvelope(mix, z, opts = {}) {
  const {
    tMinR,
    tMaxR,
    nT = 25,
    ...boundaryOpts
  } = opts;
  if (!(tMinR > 0) || !(tMaxR > tMinR)) throw new Error('tracePhaseEnvelope needs tMinR < tMaxR (°R)');

  const points = [];
  const bubble = [];
  const dew = [];
  for (let i = 0; i < nT; i += 1) {
    const tR = tMinR + ((tMaxR - tMinR) * i) / (nT - 1);
    const boundaries = phaseBoundaries(mix, z, tR, boundaryOpts);
    points.push({ tR, boundaries });
    for (const b of boundaries) {
      if (b.kind === 'bubble') bubble.push({ tR, pPsia: b.pPsia });
      else if (b.kind === 'dew') dew.push({ tR, pPsia: b.pPsia });
    }
  }
  return { points, bubble, dew };
}
