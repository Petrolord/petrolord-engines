// AVO from angle gathers or partial stacks (QI programme Q7, Milestone C;
// SOW section 8). The Aki and Richards (1980) linearised reflectivity in
// Shuey's (1985) form, R(theta) = A + B sin^2 + C (tan^2 - sin^2), is fitted
// per sample by least squares over the angles (two terms, or three when the
// angles reach far enough). From A and B, with a Vs/Vp ratio and Gardner's
// density (drho/rho = dVp/Vp / 4), come the relative contrasts and the
// Smith and Gidlow (1987) fluid factor dVp/Vp - 1.16 (Vs/Vp) dVs/Vs, which is
// near zero along the mudrock line and negative for gas. Also the
// intercept-gradient background trend (Castagna and Swan 1997), the
// projection A cos(chi) + B sin(chi) (Whitcombe, Connolly, Reagan and
// Redshaw 2002) and the AVO classes of Rutherford and Williams (1989) with
// Castagna's class IV. Pure, float64.

const fin = Number.isFinite;
const RAD = Math.PI / 180;

/** Aki-Richards reflectivity at angle theta (degrees) from relative contrasts and the mean Vs/Vp. */
export function akiRichards({ dVpVp, dVsVs, dRhoRho, vsVp }, thetaDeg) {
  const t = thetaDeg * RAD; const s2 = Math.sin(t) ** 2; const g2 = vsVp * vsVp;
  return 0.5 * (1 - 4 * g2 * s2) * dRhoRho + (0.5 / Math.cos(t) ** 2) * dVpVp - 4 * g2 * s2 * dVsVs;
}

/** Shuey's A, B and C from the same contrasts (the terms of the fit). */
export function shueyTerms({ dVpVp, dVsVs, dRhoRho, vsVp }) {
  const g2 = vsVp * vsVp;
  return { A: 0.5 * (dVpVp + dRhoRho), B: 0.5 * dVpVp - 4 * g2 * dVsVs - 2 * g2 * dRhoRho, C: 0.5 * dVpVp };
}

/** Solve a small symmetric system by Gaussian elimination (2 or 3 unknowns). */
function solve(M, v) {
  const n = v.length; const a = M.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (!(Math.abs(a[p][c]) > 1e-14)) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((r, i) => r[n] / r[i]);
}

/**
 * The least-squares Shuey fit of one sample's amplitudes against angle.
 * @param {number[]} angles degrees
 * @param {number[]} amps amplitudes (NaN skipped)
 * @param {{terms?: 2|3, weights?: number[]}} [opts]
 * @returns {{A, B, C, n}} C is 0 for a two-term fit; NaNs when too few angles
 */
export function fitShuey(angles, amps, { terms = 2, weights = null } = {}) {
  const k = terms === 3 ? 3 : 2;
  const M = Array.from({ length: k }, () => new Array(k).fill(0)); const v = new Array(k).fill(0);
  let n = 0;
  for (let i = 0; i < angles.length; i++) {
    const y = amps[i];
    if (!fin(y) || !fin(angles[i])) continue;
    const t = angles[i] * RAD; const s2 = Math.sin(t) ** 2;
    const x = k === 3 ? [1, s2, Math.tan(t) ** 2 - s2] : [1, s2];
    const w = weights ? weights[i] : 1;
    if (!(w > 0)) continue;
    for (let a = 0; a < k; a++) { v[a] += w * x[a] * y; for (let b = 0; b < k; b++) M[a][b] += w * x[a] * x[b]; }
    n += 1;
  }
  const sol = n >= k ? solve(M, v) : null;
  if (!sol) return { A: NaN, B: NaN, C: k === 3 ? NaN : 0, n };
  return { A: sol[0], B: sol[1], C: k === 3 ? sol[2] : 0, n };
}

/**
 * Relative contrasts and the Smith-Gidlow fluid factor from A and B, with
 * Gardner's density (drho/rho = dVp/Vp / 4) and the mean Vs/Vp.
 */
export function contrastsFromAB(A, B, vsVp) {
  if (!fin(A) || !fin(B) || !(vsVp > 0 && vsVp < 1)) return { dVpVp: NaN, dVsVs: NaN, dRhoRho: NaN, fluidFactor: NaN };
  const g2 = vsVp * vsVp;
  const dVpVp = (8 / 5) * A; // A = (1/2)(1 + 1/4) dVp/Vp
  const dRhoRho = dVpVp / 4;
  const dVsVs = (0.5 * dVpVp - 2 * g2 * dRhoRho - B) / (4 * g2);
  return { dVpVp, dVsVs, dRhoRho, fluidFactor: dVpVp - 1.16 * vsVp * dVsVs };
}

/** The background trend B = m A through the origin, by orthogonal regression over (A, B) pairs. */
export function backgroundTrend(As, Bs) {
  let saa = 0; let sbb = 0; let sab = 0; let n = 0;
  for (let i = 0; i < As.length; i++) {
    if (!fin(As[i]) || !fin(Bs[i])) continue;
    saa += As[i] * As[i]; sbb += Bs[i] * Bs[i]; sab += As[i] * Bs[i]; n += 1;
  }
  if (n < 3 || !(Math.abs(sab) > 0)) return { m: NaN, n };
  // principal direction of the uncentred scatter matrix
  const theta = 0.5 * Math.atan2(2 * sab, saa - sbb);
  return { m: Math.tan(theta), n };
}

/** The distance of (A, B) off the background trend, signed: negative toward softer and gas-like responses below the line. */
export const offTrend = (A, B, m) => (fin(A) && fin(B) && fin(m) ? (B - m * A) / Math.sqrt(1 + m * m) : NaN);

/** The chi projection A cos(chi) + B sin(chi). */
export const chiProjection = (A, B, chiDeg) => A * Math.cos(chiDeg * RAD) + B * Math.sin(chiDeg * RAD);

/**
 * The AVO class of a reflector top from A and B: I (A at or above +t), II
 * (|A| below t), III (A at or below -t, B negative), IV (A at or below -t,
 * B zero or positive), with t the class II band (default 0.02).
 */
export function avoClass(A, B, { band = 0.02 } = {}) {
  if (!fin(A) || !fin(B)) return null;
  if (A >= band) return 'I';
  if (A > -band) return 'II';
  return B < 0 ? 'III' : 'IV';
}
