// The least-squares (Wiener) wavelet from the well (moved verbatim from the
// Suite's src/pages/apps/Seismolord/lib/wellWavelet.js on 2026-10-11, QI
// course gate E2, so the angle-dependent wavelets of engines/qi/angleWavelets.js
// run inside the engines): the wavelet that best convolves the well's
// reflectivity into the seismic trace at the well, so its phase is measured,
// not assumed (the Petrel and Kingdom well-based extraction). Mildly damped
// (lambda) so noise and short logs do not blow it up. Pure, float64 with a
// Float32 result. Oracle: tools/validation/qi/oracle_qi_angle_wavelets.py.

const NULL_F32 = Math.fround(1.0e30);
const live = (v) => v !== NULL_F32 && Number.isFinite(v);

function solveDense(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let q = c + 1; q < n; q++) if (Math.abs(M[q][c]) > Math.abs(M[p][c])) p = q;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let q = c + 1; q < n; q++) {
      const f = M[q][c] / M[c][c];
      if (f) for (let m = c; m <= n; m++) M[q][m] -= f * M[c][m];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

/**
 * Least-squares wavelet from the well: w minimising
 * sum_t (sum_k w[k] rc[t - k] - s[t])^2 + lambda * sum_k w[k]^2 over the
 * samples where both are live; k = -half..half (centre = zero lag).
 * @param {ArrayLike<number>} rc reflectivity on the seismic time grid
 * @param {ArrayLike<number>} seismic the trace at the well, same grid
 * @param {{halfLength?: number, damping?: number}} [opts] damping relative
 *   to the mean diagonal of the normal equations
 * @returns {{wavelet: Float32Array, used: number, fitCorr: number}}
 */
export function extractWellWavelet(rc, seismic, { halfLength = 15, damping = 1e-3 } = {}) {
  const L = halfLength;
  const n = Math.min(rc.length, seismic.length);
  const m = 2 * L + 1;
  const rows = [];
  for (let t = 0; t < n; t++) {
    if (!live(seismic[t])) continue;
    const row = new Float64Array(m);
    let ok = true;
    let energy = 0;
    for (let k = -L; k <= L; k++) {
      const i = t - k;
      const v = i >= 0 && i < n ? rc[i] : 0;
      if (i >= 0 && i < n && !live(v)) { ok = false; break; }
      row[k + L] = live(v) ? v : 0;
      energy += row[k + L] * row[k + L];
    }
    if (ok) rows.push([row, seismic[t], energy]);
  }
  if (!rows.some((r) => r[2] > 0)) throw new Error('The well reflectivity is flat over the seismic at the well, so there is nothing to extract a wavelet from.');
  if (rows.length < 2 * m) {
    throw new Error(`The log covers ${rows.length} usable samples at the well; a ${m}-sample wavelet needs at least ${2 * m}. Shorten the wavelet or use the statistical one.`);
  }
  const A = Array.from({ length: m }, () => new Array(m).fill(0));
  const b = new Array(m).fill(0);
  for (const [row, s] of rows) {
    for (let i = 0; i < m; i++) {
      b[i] += row[i] * s;
      for (let j = i; j < m; j++) A[i][j] += row[i] * row[j];
    }
  }
  let diag = 0;
  for (let i = 0; i < m; i++) { for (let j = 0; j < i; j++) A[i][j] = A[j][i]; diag += A[i][i]; }
  const lam = damping * (diag / m);
  for (let i = 0; i < m; i++) A[i][i] += lam;
  const w = solveDense(A, b);
  if (!w) throw new Error('The reflectivity at the well is too weak to extract a wavelet.');
  // fit quality: correlation of rc * w with the seismic over the used rows
  let xy = 0; let xx = 0; let yy = 0;
  for (const [row, s] of rows) {
    let p = 0;
    for (let i = 0; i < m; i++) p += row[i] * w[i];
    xy += p * s; xx += p * p; yy += s * s;
  }
  const peak = Math.max(...w.map(Math.abs)) || 1;
  return {
    wavelet: Float32Array.from(w, (v) => v / peak),
    used: rows.length,
    fitCorr: xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0,
  };
}
