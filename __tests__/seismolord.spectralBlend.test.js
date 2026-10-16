/**
 * Gate: spectral decomposition against known frequencies, and the RGB blend.
 *
 * Every check calls the shipped kernel (spectralTriplet ->
 * makeTraceCompute('spectral') -> spectralTrace, the code the worker, the
 * browser runner and the attribute volumes run).
 *
 * Known truth:
 *  1. Three equal tone bursts, 12 Hz at 500 ms, 25 Hz at 1100 ms and 40 Hz
 *     at 1700 ms: each frequency trace peaks at its own burst, and at each
 *     burst its own frequency is the strongest of the three, so the blend
 *     is red, green and blue there in that order.
 *  2. A sinusoid of amplitude A exactly on an FFT bin: the Hann-windowed
 *     spectrum magnitude is A (n - 1) / 4 at every interior sample, to
 *     0.1 percent (the n-point Hann taper with the (n - 1) denominator sums
 *     to (n - 1) / 2, and a real tone splits it in half; the rest is the
 *     tone's negative-frequency image leaking through the taper's sidelobes,
 *     2e-4 here).
 *  3. Thin-bed tuning: a spike pair of opposite sign dt apart has the
 *     amplitude spectrum 2 |sin(pi f dt)|, which peaks at f = 1 / (2 dt).
 *     A 20 ms bed tunes at 25 Hz (green), a 12.5 ms bed at 40 Hz (blue).
 *  4. Linearity: doubling one burst doubles its channel.
 *
 * Negative control: the same gate run on a kernel that reads each
 * frequency at twice its value (a seconds/milliseconds style slip in the
 * bin) fails, and a blend with two channels swapped fails the colour check.
 */
import {
  spectralTriplet, channelRange, blendRgb, dominantChannel, tripletProblem,
  RGB_DEFAULT_FREQS, RGB_DEFAULT_WINDOW_MS,
} from '../engines/seismolord/spectralBlend';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const DT_US = 4000;
const DT_MS = 4;
const NS = 600;
const FREQS = [12, 25, 40];
const BURSTS = [{ f: 12, t: 500, len: 250 }, { f: 25, t: 1100, len: 200 }, { f: 40, t: 1700, len: 150 }];

function burstTrace(amps = [1, 1, 1]) {
  const tr = new Float32Array(NS);
  BURSTS.forEach(({ f, t, len }, k) => {
    for (let i = 0; i < NS; i++) {
      const tm = i * DT_MS - t;
      if (Math.abs(tm) > len / 2) continue;
      const w = 0.5 + 0.5 * Math.cos((2 * Math.PI * tm) / len);
      tr[i] += amps[k] * w * Math.cos((2 * Math.PI * f * tm) / 1000);
    }
  });
  return tr;
}

const sampleAt = (ms) => Math.round(ms / DT_MS);
const argmax = (a, from = 0, to = a.length) => { let k = from; for (let i = from; i < to; i++) if (a[i] > a[k]) k = i; return k; };

/** The gate, as a function of the kernel, so the negative control runs the very same checks. */
function gateFailures(triplet) {
  const fails = [];
  const ch = triplet(burstTrace(), FREQS);
  BURSTS.forEach(({ t }, k) => {
    const peakMs = argmax(ch[k], 30, NS - 30) * DT_MS;
    if (Math.abs(peakMs - t) > 40) fails.push(`channel ${k} peaks at ${peakMs} ms, burst at ${t} ms`);
    const z = sampleAt(t);
    const own = ch[k][z];
    for (let c = 0; c < 3; c++) if (c !== k && !(own > 2 * ch[c][z])) fails.push(`at ${t} ms channel ${k} (${own.toFixed(3)}) is not twice channel ${c} (${ch[c][z].toFixed(3)})`);
  });
  // thin-bed tuning
  for (const [bedMs, want] of [[20, 1], [12.5, 2]]) {
    const tr = new Float32Array(NS);
    // a sub-sample bed: the spike pair is band-limited by sinc interpolation
    const put = (ms, a) => { for (let i = 0; i < NS; i++) { const x = (i * DT_MS - ms) / DT_MS; tr[i] += a * (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)); } };
    put(1200, 1); put(1200 + bedMs, -1);
    const c = triplet(tr, FREQS);
    const z = sampleAt(1200 + bedMs / 2);
    const k = argmax([c[0][z], c[1][z], c[2][z]]);
    if (k !== want) fails.push(`a ${bedMs} ms bed tunes on channel ${k}, expected ${want}`);
  }
  return fails;
}

const shipped = (tr, freqs) => spectralTriplet(tr, freqs, { windowMs: RGB_DEFAULT_WINDOW_MS, dtUs: DT_US });

describe('spectral decomposition against known frequencies', () => {
  test('the shipped kernel passes the known-frequency and tuning gate', () => {
    expect(gateFailures(shipped)).toEqual([]);
  });

  test('negative control: a kernel reading each frequency at twice its value fails the same gate', () => {
    const broken = (tr, freqs) => spectralTriplet(tr, freqs.map((f) => 2 * f), { windowMs: RGB_DEFAULT_WINDOW_MS, dtUs: DT_US });
    const fails = gateFailures(broken);
    expect(fails.length).toBeGreaterThan(2);
  });

  test('a sinusoid on an FFT bin reads A (n - 1) / 4 at every interior sample', () => {
    // 120 ms at 4 ms: hw 15, n 31, nfft 128, bin spacing 1/(128 x 0.004 s) = 1.953125 Hz
    const n = 31; const fBin = 13 / (128 * 0.004); const A = 3.7;
    const tr = Float32Array.from({ length: NS }, (_, i) => A * Math.cos(2 * Math.PI * fBin * i * 0.004 + 0.3));
    const [, mid] = spectralTriplet(tr, [5, fBin, 60], { windowMs: 120, dtUs: DT_US });
    const want = (A * (n - 1)) / 4;
    for (let z = 20; z < NS - 20; z += 7) expect(Math.abs(mid[z] - want) / want).toBeLessThan(1e-3);
  });

  test('linearity: doubling the 25 Hz burst doubles the middle channel at that burst', () => {
    const a = shipped(burstTrace([1, 1, 1]), FREQS)[1][sampleAt(1100)];
    const b = shipped(burstTrace([1, 2, 1]), FREQS)[1][sampleAt(1100)];
    expect(b / a).toBeCloseTo(2, 5);
  });
});

describe('RGB blend', () => {
  test('the bursts come out red, green and blue on a common range', () => {
    const ch = shipped(burstTrace(), FREQS);
    const all = Float32Array.from([...ch[0], ...ch[1], ...ch[2]]);
    const common = channelRange(all, { lo: 0, hi: 1 });
    const ranges = [common, common, common];
    const dom = dominantChannel(ch[0], ch[1], ch[2], ranges);
    expect(BURSTS.map(({ t }) => dom[sampleAt(t)])).toEqual([0, 1, 2]);
    const { pixels } = blendRgb(ch[0], ch[1], ch[2], { ranges });
    BURSTS.forEach(({ t }, k) => {
      const o = 4 * sampleAt(t);
      const px = [pixels[o], pixels[o + 1], pixels[o + 2]];
      expect(argmax(px)).toBe(k);
      expect(pixels[o + 3]).toBe(255);
    });
  });

  test('negative control: two channels swapped fail the colour check', () => {
    const ch = shipped(burstTrace(), FREQS);
    const r = channelRange(Float32Array.from([...ch[0], ...ch[1], ...ch[2]]), { lo: 0, hi: 1 });
    const dom = dominantChannel(ch[1], ch[0], ch[2], [r, r, r]);
    expect(BURSTS.map(({ t }) => dom[sampleAt(t)])).not.toEqual([0, 1, 2]);
  });

  test('nulls are transparent and the range ignores them', () => {
    const a = Float32Array.from([0, 1, 2, NULL_VALUE, 4]);
    const rg = channelRange(a, { lo: 0, hi: 1 });
    expect(rg).toMatchObject({ min: 0, max: 4, n: 4 });
    const { pixels } = blendRgb(a, a, a, { ranges: [rg, rg, rg] });
    expect(Array.from(pixels.slice(12, 16))).toEqual([0, 0, 0, 0]);
    expect(Array.from(pixels.slice(16, 20))).toEqual([255, 255, 255, 255]);
    expect(Array.from(pixels.slice(8, 12))).toEqual([128, 128, 128, 255]);
  });

  test('a flat channel maps to black without dividing by zero', () => {
    const flat = new Float32Array(10).fill(5);
    const rg = channelRange(flat);
    expect(rg.max).toBeGreaterThan(rg.min);
    const { pixels } = blendRgb(flat, flat, flat);
    expect(pixels[0]).toBe(0);
  });

  test('frequency choices are checked', () => {
    expect(tripletProblem(RGB_DEFAULT_FREQS, DT_US)).toBeNull();
    expect(tripletProblem([25, 12, 40], DT_US)).toMatch(/ascending/);
    expect(tripletProblem([12, 25], DT_US)).toMatch(/three/);
    expect(tripletProblem([12, 25, 200], DT_US)).toMatch(/Nyquist frequency, 125 Hz/);
    expect(() => spectralTriplet(new Float32Array(10), [40, 25, 12], { dtUs: DT_US })).toThrow(/ascending/);
  });
});
