/**
 * W1.1 display-enhancement oracles: AGC gain maps against hand-computed
 * windowed RMS (edge shrink, null exclusion, reference preservation),
 * percentile scaling against the numpy 'linear' convention, and wiggle /
 * variable-area geometry with exact fractional zero crossings.
 */

import {
  sliceRms, agcGainMap, amplitudePercentile, wiggleDeviations, varAreaRuns,
} from '../engines/seismolord/displayEnhance';

const NULLV = 1.0e30;
const F = (a) => Float32Array.from(a);

describe('sliceRms', () => {
  test('non-null rms, nulls excluded', () => {
    expect(sliceRms(F([3, 4, NULLV]))).toBeCloseTo(Math.sqrt((9 + 16) / 2), 12);
    expect(sliceRms(F([NULLV, NULLV]))).toBe(0);
  });
});

describe('agcGainMap', () => {
  test('constant trace: gain = reference / |amp| everywhere', () => {
    const data = F([2, 2, 2, 2, 2, 2]);
    const g = agcGainMap(data, 6, 1, { halfWindow: 2, reference: 1 });
    for (const v of g) expect(v).toBeCloseTo(0.5, 6);
  });

  test('default reference is the slice rms, so a constant slice gets gain 1', () => {
    const data = F([5, 5, 5, 5, 5, 5, 5, 5]);
    const g = agcGainMap(data, 8, 1, { halfWindow: 3 });
    for (const v of g) expect(v).toBeCloseTo(1, 6);
  });

  test('two-level step: hand-computed windowed rms with edge shrink', () => {
    // trace [1,1,1,9,9,9], hw=1, ref=1:
    // s=0: rms([1,1])            s=2: rms([1,1,9])
    // s=3: rms([1,9,9])          s=5: rms([9,9])
    const data = F([1, 1, 1, 9, 9, 9]);
    const g = agcGainMap(data, 6, 1, { halfWindow: 1, reference: 1 });
    expect(g[0]).toBeCloseTo(1 / Math.sqrt((1 + 1) / 2), 6);
    expect(g[1]).toBeCloseTo(1 / Math.sqrt((1 + 1 + 1) / 3), 6);
    expect(g[2]).toBeCloseTo(1 / Math.sqrt((1 + 1 + 81) / 3), 6);
    expect(g[3]).toBeCloseTo(1 / Math.sqrt((1 + 81 + 81) / 3), 6);
    expect(g[5]).toBeCloseTo(1 / Math.sqrt((81 + 81) / 2), 6);
  });

  test('nulls are excluded from windows; all-null windows get gain 0', () => {
    const data = F([2, NULLV, 2, NULLV, NULLV, NULLV]);
    const g = agcGainMap(data, 6, 1, { halfWindow: 1, reference: 1 });
    expect(g[0]).toBeCloseTo(0.5, 6);   // window [2, null] -> rms 2
    expect(g[1]).toBeCloseTo(0.5, 6);   // window [2, null, 2] -> rms 2
    expect(g[4]).toBe(0);               // window all null
    expect(g[5]).toBe(0);
  });

  test('per-trace independence (second trace does not leak into the first)', () => {
    const data = F([1, 1, 1, 1, 100, 100, 100, 100]);
    const g = agcGainMap(data, 4, 2, { halfWindow: 4, reference: 1 });
    expect(g[0]).toBeCloseTo(1, 6);
    expect(g[4]).toBeCloseTo(0.01, 6);
  });

  test('silent slice returns flat zeros; bad window throws', () => {
    expect(Array.from(agcGainMap(F([0, 0, 0]), 3, 1, { halfWindow: 1 }))).toEqual([0, 0, 0]);
    expect(() => agcGainMap(F([1]), 1, 1, { halfWindow: 0 })).toThrow(/half-window/);
  });
});

describe('amplitudePercentile', () => {
  test('numpy linear convention on a known ramp', () => {
    const data = F([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(amplitudePercentile(data, 50)).toBeCloseTo(5.5, 6);
    expect(amplitudePercentile(data, 0)).toBeCloseTo(1, 6);
    expect(amplitudePercentile(data, 100)).toBeCloseTo(10, 6);
    expect(amplitudePercentile(data, 90)).toBeCloseTo(9.1, 5);
  });

  test('absolute values; nulls skipped; empty -> 0', () => {
    expect(amplitudePercentile(F([-10, 1, NULLV]), 100)).toBeCloseTo(10, 6);
    expect(amplitudePercentile(F([NULLV, NULLV]), 50)).toBe(0);
    expect(() => amplitudePercentile(F([1]), 101)).toThrow(/out of range/);
  });

  test('deterministic stride above the cap', () => {
    const data = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) data[i] = i;
    const a = amplitudePercentile(data, 50, { cap: 100 });
    const b = amplitudePercentile(data, 50, { cap: 100 });
    expect(a).toBe(b);
    // stride 10 keeps indices 0,10,...,990 -> median 490 with interp 495
    expect(a).toBeCloseTo(495, 6);
  });
});

describe('wiggleDeviations', () => {
  test('shader amplitude pipeline: balance * agc * gain / clip, clamped', () => {
    const tr = F([1, -1, 4, NULLV]);
    const agc = F([2, 1, 1, 1]);
    const dev = wiggleDeviations(tr, { gain: 1, clip: 2, rmsScale: 1, agc });
    expect(dev[0]).toBeCloseTo(1, 12);            // 1*2/2
    expect(dev[1]).toBeCloseTo(-0.5, 12);
    expect(dev[2]).toBe(1);                       // 4/2 clamps to 1
    expect(Number.isNaN(dev[3])).toBe(true);
    expect(() => wiggleDeviations(tr, { clip: 0 })).toThrow(/clip/);
  });

  test('polarity rides in through a signed gain', () => {
    const dev = wiggleDeviations(F([1]), { gain: -1, clip: 2 });
    expect(dev[0]).toBeCloseTo(-0.5, 12);
  });
});

describe('varAreaRuns', () => {
  test('exact fractional crossings on a sign-alternating trace', () => {
    // [-1, 1, 1, -1]: crossing up at 0.5, down at 2.5
    const runs = varAreaRuns([-1, 1, 1, -1]);
    expect(runs).toHaveLength(1);
    expect(runs[0].s0).toBeCloseTo(0.5, 12);
    expect(runs[0].s1).toBeCloseTo(2.5, 12);
  });

  test('asymmetric crossing interpolates by magnitude', () => {
    // [-3, 1]: crossing at 0 + 3/4
    const runs = varAreaRuns([-3, 1, -1]);
    expect(runs[0].s0).toBeCloseTo(0.75, 12);
    expect(runs[0].s1).toBeCloseTo(1.5, 12);
  });

  test('runs at the trace ends take the boundary sample', () => {
    const runs = varAreaRuns([2, 1, -1, -1, 1, 2]);
    expect(runs).toHaveLength(2);
    expect(runs[0].s0).toBe(0);
    expect(runs[0].s1).toBeCloseTo(1.5, 12);
    expect(runs[1].s0).toBeCloseTo(3.5, 12);
    expect(runs[1].s1).toBe(5);
  });

  test('NaN breaks a run at the last valid sample and suppresses interpolation', () => {
    const runs = varAreaRuns([1, 1, NaN, 1, 1]);
    expect(runs).toEqual([{ s0: 0, s1: 1 }, { s0: 3, s1: 4 }]);
  });

  test('no positive lobe, no runs; zero samples are not positive', () => {
    expect(varAreaRuns([-1, 0, -2])).toEqual([]);
  });
});
