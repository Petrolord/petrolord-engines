// engines/seismolord/wellWavelet.js, moved from the Suite's Seismolord lib (QI course gate E2):
// the least-squares wavelet from the well recovers a known wavelet, and refuses with the reason.
import { extractWellWavelet } from '../engines/seismolord/wellWavelet';

const ns = 400; const dtMs = 2;
let seed = 7; const u = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
const rc = Float64Array.from({ length: ns }, (_, i) => (i % 7 === 0 ? u() * 0.2 : 0.02 * u()));
const TRUE_W = Array.from({ length: 31 }, (_, i) => { const t = ((i - 15) * dtMs) / 1000; const a = (Math.PI * 30 * t) ** 2; return (1 - 2 * a) * Math.exp(-a) + 0.3 * Math.sin(i / 3) * Math.exp(-a); });
const conv = (r, w) => Float64Array.from(r, (_, t) => { let s = 0; for (let k = -15; k <= 15; k++) { const i = t - k; if (i >= 0 && i < r.length) s += w[k + 15] * r[i]; } return s; });
const corr = (a, b) => { let s = 0; let x = 0; let y = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return s / Math.sqrt(x * y); };

test('recovers a mixed-phase wavelet from the well, peak-normalised, with the fit correlation', () => {
  const seismic = conv(rc, TRUE_W);
  const { wavelet, fitCorr, used } = extractWellWavelet(rc, seismic, { halfLength: 15, damping: 1e-9 });
  expect(corr(wavelet, TRUE_W)).toBeGreaterThan(0.99999);
  expect(Math.max(...Array.from(wavelet, Math.abs))).toBeCloseTo(1, 6);
  expect(fitCorr).toBeGreaterThan(0.99999);
  expect(used).toBe(ns);
  // negative control: a 5-sample shift of the seismic is not the same wavelet
  const shifted = Float64Array.from(seismic, (_, i) => seismic[Math.min(ns - 1, i + 5)]);
  expect(corr(extractWellWavelet(rc, shifted, { halfLength: 15, damping: 1e-9 }).wavelet, TRUE_W)).toBeLessThan(0.9);
});

test('null seismic samples are skipped and NaN reflectivity drops the rows it touches', () => {
  const seismic = Float32Array.from(conv(rc, TRUE_W));
  seismic.fill(Math.fround(1e30), 0, 50);
  const r2 = Float64Array.from(rc); r2[200] = NaN;
  const { used } = extractWellWavelet(r2, seismic, { halfLength: 15 });
  expect(used).toBe(ns - 50 - 31);
});

test('refusals: a flat reflectivity, and a log too short for the wavelet', () => {
  expect(() => extractWellWavelet(new Float64Array(ns), conv(rc, TRUE_W))).toThrow(/reflectivity is flat/);
  expect(() => extractWellWavelet(rc.subarray(0, 40), conv(rc, TRUE_W).subarray(0, 40), { halfLength: 15 })).toThrow(/needs at least 62/);
});
