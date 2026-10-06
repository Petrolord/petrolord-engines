/**
 * Seismic QC gates (QI programme Q4a, A5). Every gate calls the shipped
 * function against a known truth: the analytic Ricker spectrum (oracle
 * tools/validation/qi/oracle_seismic_qc.py: peak, -6 and -20 dB edges,
 * power centroid), a designed signal-to-noise ratio on seeded synthetic
 * traces, and a designed acquisition stripe. Negative controls must fail.
 */
import fs from 'fs';
import path from 'path';
import { amplitudeSpectrum, averageSpectrum, spectrumStats, snrFromCoherency, footprint } from '../engines/qi/seismicQc';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/qi/goldens.seismicQc.json'), 'utf8'));
const ricker = (fp, dtMs, n, shift = 0) => Array.from({ length: n }, (_, i) => {
  const t = ((i - n / 2 - shift) * dtMs) / 1000;
  const a = (Math.PI * fp * t) ** 2;
  return (1 - 2 * a) * Math.exp(-a);
});
function rng(seed) {
  let s = seed;
  const u = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  return () => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u());
}

describe('amplitude spectrum against the analytic Ricker', () => {
  test.each(G.ricker.map((r) => [r.fp, r]))('Ricker %s Hz: peak, band edges and centroid', (fp, r) => {
    const s = spectrumStats(amplitudeSpectrum(ricker(fp, 2, 801), 2, { taper: 0 }));
    expect(Math.abs(s.peakHz - r.peakHz)).toBeLessThan(0.05);
    expect(Math.abs(s.band6[0] - r.band6[0])).toBeLessThan(0.1);
    expect(Math.abs(s.band6[1] - r.band6[1])).toBeLessThan(0.1);
    expect(Math.abs(s.band20[0] - r.band20[0])).toBeLessThan(0.15);
    expect(Math.abs(s.band20[1] - r.band20[1])).toBeLessThan(0.15);
    expect(Math.abs(s.centroidHz - r.centroidHz) / r.centroidHz).toBeLessThan(0.005);
    expect(s.bandwidth6Hz).toBeCloseTo(r.band6[1] - r.band6[0], 0);
  });
  test('the frequency axis and its Nyquist end', () => {
    const s = amplitudeSpectrum(ricker(30, 4, 300), 4);
    expect(s.freqHz[s.freqHz.length - 1]).toBeCloseTo(125, 9);
    expect(s.df).toBeCloseTo(1000 / (1024 * 4), 12);
  });
  test('the average spectrum of identical traces is that trace\'s spectrum', () => {
    const t = ricker(25, 2, 400);
    const one = amplitudeSpectrum(t, 2);
    const avg = averageSpectrum([t, t, t], 2);
    for (let k = 0; k < one.amp.length; k += 37) expect(avg.amp[k]).toBeCloseTo(one.amp[k], 9);
    expect(avg.traces).toBe(3);
  });
  test('negative control: a 15 Hz Ricker does not pass as a 30 Hz one', () => {
    const s = spectrumStats(amplitudeSpectrum(ricker(15, 2, 801), 2, { taper: 0 }));
    expect(Math.abs(s.peakHz - 30)).toBeGreaterThan(10);
  });
});

describe('signal-to-noise from coherency', () => {
  const traces = (snr, seed, n = 3000, count = 24, dip = 0) => {
    const g = rng(seed);
    const sig = Array.from({ length: n + 40 }, () => g());
    const noiseSd = 1 / Math.sqrt(snr);
    return Array.from({ length: count }, (_, k) => Array.from({ length: n }, (_, i) => sig[i + 20 + k * dip] + noiseSd * g()));
  };
  test.each([[1, 11], [4, 12], [16, 13]])('a designed S/N of %s is recovered within 12 percent', (snr, seed) => {
    const r = snrFromCoherency(traces(snr, seed));
    expect(Math.abs(r.snr - snr) / snr).toBeLessThan(0.12);
    expect(r.pairs).toBe(23);
    expect(r.snrDb).toBeCloseTo(10 * Math.log10(r.snr), 12);
  });
  test('a dip of one sample per trace is followed by the lag search', () => {
    const r = snrFromCoherency(traces(4, 21, 3000, 24, 1), { maxLag: 3 });
    expect(Math.abs(r.snr - 4) / 4).toBeLessThan(0.12);
    // negative control: no lag search, the dipping signal decorrelates
    expect(snrFromCoherency(traces(4, 21, 3000, 24, 1), { maxLag: 0 }).snr).toBeLessThan(1);
  });
  test('negative control: pure noise has no signal', () => {
    const g = rng(99);
    const noise = Array.from({ length: 12 }, () => Array.from({ length: 3000 }, () => g()));
    expect(snrFromCoherency(noise).snr).toBeLessThan(0.1);
  });
});

describe('acquisition footprint', () => {
  const slice = (stripe, seed, { gain = false, nIl = 40 } = {}) => {
    const g = rng(seed);
    return Array.from({ length: nIl }, (_, i) => Array.from({ length: 64 }, (_, j) => {
      const base = 1 + 0.01 * i + 0.005 * j + 0.05 * g();
      if (!stripe) return base;
      return gain ? base * (j % 4 === 0 ? 1.6 : 1) : base + (j % 4 === 0 ? 0.3 : 0);
    }));
  };
  test('a stripe every 4 crosslines is found at its fundamental, with most of the profile variance', () => {
    const f = footprint(slice(true, 5));
    expect(f.alongCrossline.period).toBeCloseTo(4, 6);
    expect(f.alongCrossline.share).toBeGreaterThan(0.5);
    expect(f.alongCrossline.prominence).toBeGreaterThan(20);
  });
  test('a single-line pulse train (equal harmonics) still reports period 4, never its period-2 harmonic', () => {
    for (const seed of [5, 6, 7, 8]) {
      const f = footprint(slice(true, seed, { gain: true, nIl: 24 }));
      expect(f.alongCrossline.period).toBeCloseTo(4, 6);
      expect(f.alongCrossline.share).toBeGreaterThan(0.5);
    }
  });
  test('negative control: the same slice without the stripe has no dominant, prominent period', () => {
    for (const seed of [5, 6, 7, 8]) {
      const f = footprint(slice(false, seed, { nIl: 24 }));
      for (const axis of [f.alongCrossline, f.alongInline]) {
        expect(axis.share < 0.3 || axis.prominence < 10).toBe(true);
      }
    }
  });
  test('refusals', () => {
    expect(() => footprint([[1, 2], [3, 4]])).toThrow(/at least 4 by 4/);
    expect(() => snrFromCoherency([[1, 2, 3]])).toThrow(/two neighbouring traces/);
    expect(() => amplitudeSpectrum([1, 2, 3], 2)).toThrow(/at least 8 samples/);
  });
});
