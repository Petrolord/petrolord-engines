/**
 * Multi-well wavelet comparison (QI programme Q6a, A6): every gate calls the
 * shipped function on wavelets with known relations (the same Ricker shifted,
 * scaled, rotated in phase, resampled), with negative controls.
 */
import { resampleWavelet, normaliseWavelet, alignWavelet, compareWavelets } from '../engines/qi/wavelets';

const ricker = (fp, dtMs, half, shift = 0, phaseDeg = 0) => Float64Array.from({ length: 2 * half + 1 }, (_, i) => {
  const t = ((i - half - shift) * dtMs) / 1000;
  const a = (Math.PI * fp * t) ** 2;
  const r = (1 - 2 * a) * Math.exp(-a);
  if (!phaseDeg) return r;
  // a 90 degree component: the Hilbert-like odd partner of the Ricker (its derivative, scaled)
  const d = -2 * Math.PI * Math.PI * fp * fp * t * (3 - 2 * a) * Math.exp(-a) / (Math.PI * fp * 2);
  const p = (phaseDeg * Math.PI) / 180;
  return Math.cos(p) * r + Math.sin(p) * d;
});
const corr = (a, b) => { let s = 0; let x = 0; let y = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return s / Math.sqrt(x * y); };

test('resampling a 2 ms Ricker to 4 ms and back keeps its shape', () => {
  const w2 = ricker(25, 2, 40);
  const w4 = resampleWavelet(w2, 2, 4);
  expect(w4.length).toBe(41);
  for (let k = -20; k <= 20; k++) expect(w4[k + 20]).toBeCloseTo(w2[2 * k + 40], 12);
  const back = resampleWavelet(w4, 4, 2);
  expect(corr(back, w2.subarray(0, back.length))).toBeGreaterThan(0.99);
});

test('normalising gives unit energy; a zero wavelet stays zero', () => {
  const n = normaliseWavelet(ricker(30, 2, 30).map((v) => v * 7));
  expect(n.reduce((s, v) => s + v * v, 0)).toBeCloseTo(1, 12);
  expect(Array.from(normaliseWavelet(new Float64Array(5)))).toEqual([0, 0, 0, 0, 0]);
});

test('alignment finds a known shift and undoes it', () => {
  const a = ricker(30, 2, 40);
  const b = ricker(30, 2, 40, 4);
  const r = alignWavelet(a, b, { maxLag: 10 });
  expect(r.lag).toBe(-4);
  expect(r.corr).toBeGreaterThan(0.999);
  // negative control: no search leaves them misaligned
  expect(alignWavelet(a, b, { maxLag: 0 }).corr).toBeLessThan(0.7);
});

test('identical wavelets (shifted and scaled) average to themselves with similarity 1', () => {
  const r = compareWavelets([
    { name: 'W1', samples: ricker(28, 2, 40) },
    { name: 'W2', samples: ricker(28, 2, 40, 3).map((v) => 3 * v) },
    { name: 'W3', samples: ricker(28, 2, 40, -2).map((v) => 0.5 * v) },
  ]);
  expect(r.aligned.map((a) => a.lag)).toEqual([0, -3, 2]);
  for (const row of r.similarity) for (const s of row) expect(s).toBeGreaterThan(0.999);
  expect(corr(r.average, normaliseWavelet(ricker(28, 2, 40)))).toBeGreaterThan(0.999);
  for (const m of r.misfit) expect(m.corrToAverage).toBeGreaterThan(0.999);
});

test('a well with a rotated phase stands out against the others (negative control)', () => {
  const r = compareWavelets([
    { name: 'W1', samples: ricker(28, 2, 40) },
    { name: 'W2', samples: ricker(28, 2, 40) },
    { name: 'W3', samples: ricker(28, 2, 40, 0, 90) },
  ]);
  const by = Object.fromEntries(r.misfit.map((m) => [m.name, m.corrToAverage]));
  expect(by.W3).toBeLessThan(by.W1 - 0.05);
  expect(r.similarity[0][1]).toBeGreaterThan(0.999);
  expect(r.similarity[0][2]).toBeLessThan(0.95);
});

test('refusals', () => {
  expect(() => compareWavelets([{ name: 'a', samples: [1, 2] }])).toThrow(/at least two/);
  expect(() => compareWavelets([{ name: 'a', samples: [1, 2, 3] }, { name: 'b', samples: [1, 2] }])).toThrow(/one length/);
  expect(() => resampleWavelet([1, 2, 3], 0, 2)).toThrow(/positive/);
});
