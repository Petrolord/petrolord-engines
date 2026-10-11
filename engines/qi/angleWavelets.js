// Angle-dependent wavelets (QI programme Q6b, 2026-10-07; SOW section 5;
// moved from the Suite's QIStudio/services/angleWavelets.js on 2026-10-11, QI
// course gate E2): for each angle stack, a wavelet extracted at every well by
// least squares against the reflectivity of that well's logs at the stack's
// angle, then aligned and averaged across the wells (qi/wavelets.js). The
// reflectivity is the simultaneous inversion's own Fatti operator with a
// unit spike for a wavelet, so a wavelet extracted here carries the stack's
// amplitude scale for that operator. Beside each, the correlation of every
// well's synthetic (its reflectivity with the stack's wavelet) against the
// stack at the well: the synthetic-against-real check by angle. Pure.
// Oracle: tools/validation/qi/oracle_qi_angle_wavelets.py.

import { forwardFatti } from './prestackInversion.js';
import { compareWavelets } from './wavelets.js';
import { extractWellWavelet } from '../seismolord/wellWavelet.js';

const fin = Number.isFinite;

/** The Fatti reflectivity of a well's logs at one angle, NaN where a log is missing next to the sample. */
export function angleReflectivity(well, thetaDeg, vsVp) {
  const n = well.ln_ai.length;
  const ok = (i) => i >= 0 && i < n && fin(well.ln_ai[i]) && fin(well.ln_si[i]) && fin(well.ln_rho[i]);
  const fill = (arr) => Float64Array.from(arr, (v) => (fin(v) ? v : 0));
  const r = forwardFatti({ lnAi: fill(well.ln_ai), lnSi: fill(well.ln_si), lnRho: fill(well.ln_rho) }, [thetaDeg], [1], vsVp)[0];
  return Float64Array.from(r, (v, i) => (ok(i - 1) && ok(i + 1) ? v : NaN));
}

const corr = (a, b) => {
  let n = 0; let sa = 0; let sb = 0; let saa = 0; let sbb = 0; let sab = 0;
  for (let i = 0; i < a.length; i++) {
    if (!fin(a[i]) || !fin(b[i])) continue;
    n += 1; sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i];
  }
  if (n < 5) return NaN;
  const cov = sab / n - (sa / n) * (sb / n); const va = saa / n - (sa / n) ** 2; const vb = sbb / n - (sb / n) ** 2;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
};

const convolve = (r, w) => {
  const h = (w.length - 1) / 2;
  return Float64Array.from(r, (_, i) => {
    let s = 0; let any = false;
    for (let k = -h; k <= h; k++) { const v = r[i - k]; if (fin(v)) { s += w[k + h] * v; any = true; } }
    return any ? s : NaN;
  });
};

/**
 * The wavelet of each stack, from the wells.
 * @param {Object} p
 * @param {Array<{name, ln_ai, ln_si, ln_rho}>} p.wells logs on the stacks' time axis
 * @param {Array<Array<ArrayLike<number>>>} p.tracesByWell [well][stack] the stack traces at each well (null samples as NaN or null)
 * @param {number[]} p.thetaDeg the stacks' mean angles
 * @param {number} p.vsVp
 * @param {number} [p.halfLength] wavelet half length in samples
 * @returns {Array<{angle, samples: Float64Array, wells: Array<{name, fitCorr, synthCorr}>, misfit}>}
 */
export function extractAngleWavelets({ wells, tracesByWell, thetaDeg, vsVp, halfLength = 15 }) {
  return thetaDeg.map((theta, k) => {
    const per = [];
    wells.forEach((w, j) => {
      const tr = Float64Array.from(tracesByWell[j][k], (v) => (v == null ? NaN : v));
      const rc = angleReflectivity(w, theta, vsVp);
      let ex;
      try { ex = extractWellWavelet(rc, tr, { halfLength }); } catch { ex = null; }
      if (ex && ex.wavelet.some((v) => v !== 0)) per.push({ name: w.name, wavelet: Float64Array.from(ex.wavelet), fitCorr: ex.fitCorr, rc, tr });
    });
    if (!per.length) return { angle: theta, samples: null, wells: wells.map((w) => ({ name: w.name, fitCorr: NaN, synthCorr: NaN })), misfit: [] };
    // align and average across wells; one well is its own average. The scale is kept (the mean energy of the wells' wavelets).
    let avg; let misfit = [];
    if (per.length > 1) {
      const cmp = compareWavelets(per.map((x) => ({ name: x.name, samples: x.wavelet })), { maxLag: 4 });
      const energy = per.reduce((a, x) => a + Math.sqrt(x.wavelet.reduce((s, v) => s + v * v, 0)), 0) / per.length;
      avg = Float64Array.from(cmp.average, (v) => v * energy);
      misfit = cmp.misfit;
    } else avg = per[0].wavelet;
    return {
      angle: theta,
      samples: avg,
      wells: per.map((x) => ({ name: x.name, fitCorr: x.fitCorr, synthCorr: corr(convolve(x.rc, avg), x.tr) })),
      misfit,
    };
  });
}
