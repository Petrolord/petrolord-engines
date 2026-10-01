// Pseudo-sonic: a P velocity for wells with no sonic log (Rock Physics
// Studio U2-007, 2026-10-01). Two published empirical transforms, each
// with a calibration against wells that do have a sonic and an honest
// misfit. A pseudo-sonic is an ESTIMATE: every consumer must label it so.
//
// Gardner, Gardner and Gregory (1974, Geophysics 39, 770):
//     rho = 0.23 V^0.25        rho in g/cc, V in ft/s
//   inverted: V = (rho / 0.23)^4. A brine-filled sedimentary average; it
//   misses coal, salt, anhydrite and gas sands.
//
// Faust (1953, Geophysics 18, 271):
//     V = 1948 (Z R)^(1/6)     V in ft/s, Z depth in ft, R in ohm m
//   the same relation Hacikoylu, Dvorkin and Mavko (2006, The Leading
//   Edge 25, 1006) write as V = 2.2888 (Z R)^(1/6) with V in km/s and Z in
//   km. Hydrocarbons raise R and so the estimate; fresh water and shallow
//   unconsolidated rock break it.
//
// SI in and out (m, m/s, kg/m3, ohm m); the published constants are used
// in their own units inside. Pure math, no I/O.

const M_PER_FT = 0.3048;

export const GARDNER_A = 0.23;   // g/cc with V in ft/s
export const GARDNER_B = 0.25;
export const FAUST_GAMMA = 1948; // ft/s with Z in ft and R in ohm m
export const FAUST_EXPONENT = 1 / 6;

/** Gardner density (kg/m3) from P velocity (m/s). */
export function gardnerRho(vp, { a = GARDNER_A, b = GARDNER_B } = {}) {
  if (!(vp > 0)) return NaN;
  return 1000 * a * (vp / M_PER_FT) ** b;
}

/** Gardner inverse: P velocity (m/s) from bulk density (kg/m3). */
export function gardnerVp(rho, { a = GARDNER_A, b = GARDNER_B } = {}) {
  if (!(rho > 0) || !(a > 0) || !(b > 0)) return NaN;
  return M_PER_FT * (rho / 1000 / a) ** (1 / b);
}

/** Faust: P velocity (m/s) from depth below surface (m) and true resistivity (ohm m). */
export function faustVp(depthM, rtOhmm, { gamma = FAUST_GAMMA } = {}) {
  if (!(depthM > 0) || !(rtOhmm > 0) || !(gamma > 0)) return NaN;
  return M_PER_FT * gamma * ((depthM / M_PER_FT) * rtOhmm) ** FAUST_EXPONENT;
}

/**
 * Gardner's coefficient a fitted to a well with a sonic (the exponent
 * stays 0.25): least squares in log space, so a = exp(mean(ln rho - b ln V)).
 * @param {ArrayLike<number>} rho kg/m3 @param {ArrayLike<number>} vp m/s
 * @returns {{a: number, n: number}}
 */
export function fitGardnerA(rho, vp, { b = GARDNER_B } = {}) {
  let s = 0; let n = 0;
  for (let i = 0; i < rho.length; i++) {
    if (!(rho[i] > 0) || !(vp[i] > 0)) continue;
    s += Math.log(rho[i] / 1000) - b * Math.log(vp[i] / M_PER_FT);
    n += 1;
  }
  if (n < 10) throw new Error('Calibrating Gardner needs at least 10 samples with both density and sonic.');
  return { a: Math.exp(s / n), n };
}

/**
 * Faust's constant fitted to a well with a sonic (the 1/6 power stays):
 * gamma = exp(mean(ln V - ln (Z R)^(1/6))), V in ft/s and Z in ft.
 * @returns {{gamma: number, n: number}}
 */
export function fitFaustGamma(depthM, rtOhmm, vp) {
  let s = 0; let n = 0;
  for (let i = 0; i < vp.length; i++) {
    if (!(depthM[i] > 0) || !(rtOhmm[i] > 0) || !(vp[i] > 0)) continue;
    s += Math.log(vp[i] / M_PER_FT) - FAUST_EXPONENT * Math.log((depthM[i] / M_PER_FT) * rtOhmm[i]);
    n += 1;
  }
  if (n < 10) throw new Error('Calibrating Faust needs at least 10 samples with depth, resistivity and sonic.');
  return { gamma: Math.exp(s / n), n };
}

/**
 * How far an estimated velocity sits from the measured one, over samples
 * where both exist. Percentages are of the measured velocity.
 * @returns {{n: number, biasPct: number, rmsPct: number, medianAbsPct: number, p90AbsPct: number, corr: number}}
 */
export function velocityMisfit(estimated, measured) {
  const rel = [];
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
  for (let i = 0; i < Math.min(estimated.length, measured.length); i++) {
    const e = estimated[i]; const m = measured[i];
    if (!(e > 0) || !(m > 0)) continue;
    rel.push((e - m) / m);
    sx += e; sy += m; sxx += e * e; syy += m * m; sxy += e * m;
  }
  const n = rel.length;
  if (!n) return { n: 0, biasPct: NaN, rmsPct: NaN, medianAbsPct: NaN, p90AbsPct: NaN, corr: NaN };
  const bias = rel.reduce((a, b) => a + b, 0) / n;
  const rms = Math.sqrt(rel.reduce((a, b) => a + b * b, 0) / n);
  const abs = rel.map(Math.abs).sort((a, b) => a - b);
  const q = (f) => abs[Math.min(n - 1, Math.floor(f * (n - 1)))];
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n;
  const vy = syy - (sy * sy) / n;
  return {
    n,
    biasPct: 100 * bias,
    rmsPct: 100 * rms,
    medianAbsPct: 100 * q(0.5),
    p90AbsPct: 100 * q(0.9),
    corr: vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN,
  };
}
