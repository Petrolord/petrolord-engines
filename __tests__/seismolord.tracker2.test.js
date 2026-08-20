/**
 * W3.2 Tracker 2.0 oracles: normalized-crosscorrelation picking with
 * KNOWN sub-sample shifts on an analytic waveform, confidence gating,
 * multi-seed and grow-from-existing region growth, and fault-aware
 * growth against rasterized barriers. All synthetic constructions are
 * deterministic (no RNG) so failures reproduce exactly.
 */

import {
  refWindow, correlatePick, autotrack2D, regionGrow3D, snapPick,
} from '../engines/seismolord/horizonTrack';
import { rasterizeTraces } from '../engines/seismolord/faultBarriers';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

/** Gaussian-modulated cosine sampled with its centre at `center`. */
function waveTrace(ns, center, { width = 4, freq = 0.35 } = {}) {
  const t = new Float32Array(ns);
  for (let i = 0; i < ns; i++) {
    const d = i - center;
    t[i] = Math.exp(-(d * d) / (2 * width * width)) * Math.cos(freq * d);
  }
  return t;
}

/** Deterministic pseudo-noise (LCG), zero-mean-ish. */
function noiseTrace(ns, seed = 12345) {
  const t = new Float32Array(ns);
  let x = seed >>> 0;
  for (let i = 0; i < ns; i++) {
    x = (1664525 * x + 1013904223) >>> 0;
    t[i] = (x / 0xffffffff) - 0.5;
  }
  return t;
}

const NS = 128;

describe('correlatePick', () => {
  test('recovers a known sub-sample shift', () => {
    const a = waveTrace(NS, 40.0);
    const b = waveTrace(NS, 42.3);
    const ref = refWindow(a, 40, 8);
    expect(ref).not.toBeNull();
    const hit = correlatePick(ref, b, 40, { search: 5, threshold: 0.7 });
    expect(hit).not.toBeNull();
    expect(hit.sample).toBeCloseTo(42.3, 1);
    expect(Math.abs(hit.sample - 42.3)).toBeLessThan(0.05);
    expect(hit.coeff).toBeGreaterThan(0.99);
  });

  test('identical traces correlate at 1 with zero shift', () => {
    const a = waveTrace(NS, 60.0);
    const hit = correlatePick(refWindow(a, 60, 8), a, 60, { search: 5 });
    expect(hit.sample).toBeCloseTo(60, 6);
    expect(hit.coeff).toBeCloseTo(1, 6);
  });

  test('uncorrelated noise is rejected by the threshold', () => {
    const a = waveTrace(NS, 40.0);
    const hit = correlatePick(refWindow(a, 40, 8), noiseTrace(NS), 40,
      { search: 5, threshold: 0.7 });
    expect(hit).toBeNull();
  });

  test('nulls in the candidate window rule those lags out', () => {
    const a = waveTrace(NS, 40.0);
    const b = waveTrace(NS, 41.0);
    for (let i = 30; i <= 52; i++) b[i] = NULL_F32;   // event zone nulled
    expect(correlatePick(refWindow(a, 40, 8), b, 40, { search: 5 })).toBeNull();
  });

  test('refWindow rejects edges and nulls', () => {
    const a = waveTrace(NS, 40.0);
    expect(refWindow(a, 3, 8)).toBeNull();
    const withNull = waveTrace(NS, 40.0);
    withNull[42] = NULL_F32;
    expect(refWindow(withNull, 40, 8)).toBeNull();
  });
});

describe('autotrack2D in ncc mode', () => {
  test('follows a dipping event with sub-sample accuracy + confidence', () => {
    const nTraces = 40;
    const truth = (t) => 30 + 0.5 * t;   // dips half a sample per trace
    const data = new Float32Array(nTraces * NS);
    for (let t = 0; t < nTraces; t++) data.set(waveTrace(NS, truth(t)), t * NS);
    const slice = { data, width: NS, height: nTraces };
    const { picks, tracked, confidence } = autotrack2D(slice, 20, truth(20), {
      mode: 'ncc', corrHalf: 8, corrSearch: 5, corrThreshold: 0.7, maxJump: 3,
    });
    expect(tracked).toBe(nTraces);
    for (let t = 0; t < nTraces; t++) {
      expect(Math.abs(picks[t] - truth(t))).toBeLessThan(0.1);
      expect(confidence[t]).toBeGreaterThan(0.95);
    }
  });

  test('a dead trace stops the walk in that direction', () => {
    const nTraces = 20;
    const data = new Float32Array(nTraces * NS);
    for (let t = 0; t < nTraces; t++) data.set(waveTrace(NS, 40), t * NS);
    data.fill(NULL_F32, 15 * NS, 16 * NS);
    const slice = { data, width: NS, height: nTraces };
    const { picks } = autotrack2D(slice, 5, 40, { mode: 'ncc' });
    expect(picks[14]).not.toBe(NULL_F32);
    expect(picks[15]).toBe(NULL_F32);
    expect(picks[16]).toBe(NULL_F32); // beyond the dead trace: unreachable
  });

  test('snap modes keep their exact pre-W3.2 behavior', () => {
    const nTraces = 10;
    const data = new Float32Array(nTraces * NS);
    for (let t = 0; t < nTraces; t++) data.set(waveTrace(NS, 50), t * NS);
    const slice = { data, width: NS, height: nTraces };
    const { picks, tracked } = autotrack2D(slice, 4, 50, { mode: 'peak', window: 3 });
    expect(tracked).toBe(nTraces);
    const solo = snapPick(waveTrace(NS, 50), 50, { mode: 'peak', window: 3 });
    for (let t = 0; t < nTraces; t++) expect(picks[t]).toBeCloseTo(solo.sample, 9);
  });
});

describe('regionGrow3D — Tracker 2.0', () => {
  const NIL = 16;
  const NXL = 16;
  const geom = { nIl: NIL, nXl: NXL, ns: NS };

  /** cube: event surface s(il, xl); null cells = dead traces. */
  const makeGetTrace = (surface, dead = () => false) => async (il, xl) => {
    if (dead(il, xl)) return new Float32Array(NS).fill(NULL_F32);
    return waveTrace(NS, surface(il, xl));
  };

  test('ncc growth tracks a doubly dipping event with confidence', async () => {
    const truth = (il, xl) => 40 + 0.3 * il + 0.2 * xl;
    const getTrace = makeGetTrace(truth);
    const { picks, tracked, confidence } = await regionGrow3D(
      getTrace, geom, { ilIdx: 8, xlIdx: 8, sample: truth(8, 8) },
      { mode: 'ncc', corrHalf: 8, corrSearch: 5, corrThreshold: 0.7 },
    );
    expect(tracked).toBe(NIL * NXL);
    for (let i = 0; i < NIL; i++) {
      for (let j = 0; j < NXL; j++) {
        expect(Math.abs(picks[i * NXL + j] - truth(i, j))).toBeLessThan(0.15);
      }
    }
    expect(confidence[8 * NXL + 8]).toBe(1);
    expect(confidence[0]).toBeGreaterThan(0.9);
  });

  test('multi-seed reaches regions a single seed cannot', async () => {
    // two islands split by a dead 2-column channel
    const truth = () => 40;
    const dead = (il, xl) => xl === 7 || xl === 8;
    const getTrace = makeGetTrace(truth, dead);
    const single = await regionGrow3D(getTrace, geom,
      { ilIdx: 4, xlIdx: 3, sample: 40 }, { mode: 'ncc' });
    expect(single.picks[4 * NXL + 12]).toBe(NULL_F32);   // far island untouched
    const multi = await regionGrow3D(getTrace, geom,
      { ilIdx: 4, xlIdx: 3, sample: 40 },
      { mode: 'ncc', seeds: [{ ilIdx: 4, xlIdx: 12, sample: 40 }] });
    expect(multi.picks[4 * NXL + 12]).not.toBe(NULL_F32);
    expect(multi.tracked).toBe(NIL * NXL - NIL * 2);      // all but the channel
  });

  test('grow-from-existing keeps existing picks bit-exact and fills outward', async () => {
    const truth = (il, xl) => 40 + 0.2 * xl;
    const getTrace = makeGetTrace(truth);
    const initial = new Float32Array(NIL * NXL).fill(NULL_F32);
    // an existing interpreted band at il 6..9, xl 0..3 (deliberately
    // biased half a sample so preservation is distinguishable)
    for (let i = 6; i <= 9; i++) {
      for (let j = 0; j <= 3; j++) initial[i * NXL + j] = truth(i, j) + 0.5;
    }
    const { picks, tracked, confidence } = await regionGrow3D(getTrace, geom, null, {
      mode: 'ncc', initialPicks: initial,
    });
    expect(tracked).toBe(NIL * NXL);
    for (let i = 6; i <= 9; i++) {
      for (let j = 0; j <= 3; j++) {
        expect(picks[i * NXL + j]).toBe(initial[i * NXL + j]); // untouched
        expect(confidence[i * NXL + j]).toBe(NULL_F32);        // no fake conf
      }
    }
    expect(picks[0]).not.toBe(NULL_F32);                       // grew outward
  });

  test('fault barriers stop growth that would otherwise succeed', async () => {
    // perfectly trackable everywhere; only the barrier can stop it
    const truth = () => 40;
    const getTrace = makeGetTrace(truth);
    const barrierTrace = [[{ i: 0, j: 7.5 }, { i: NIL - 1, j: 7.5 }]];
    const barriers = rasterizeTraces(barrierTrace, NIL, NXL);
    const seed = { ilIdx: 4, xlIdx: 3, sample: 40 };
    const open = await regionGrow3D(getTrace, geom, seed, { mode: 'ncc' });
    expect(open.tracked).toBe(NIL * NXL);                      // control
    const walled = await regionGrow3D(getTrace, geom, seed, {
      mode: 'ncc', barriers,
    });
    for (let i = 0; i < NIL; i++) {
      for (let j = 0; j < NXL; j++) {
        const idx = i * NXL + j;
        if (barriers[idx]) expect(walled.picks[idx]).toBe(NULL_F32);
        else if (j > 8) expect(walled.picks[idx]).toBe(NULL_F32); // far side
        else if (j < 7) expect(walled.picks[idx]).not.toBe(NULL_F32);
      }
    }
  });

  test('snap-mode growth without new opts matches the pre-W3.2 result', async () => {
    const truth = (il, xl) => 40 + 0.3 * il + 0.2 * xl;
    const getTrace = makeGetTrace(truth);
    const { picks, tracked } = await regionGrow3D(
      getTrace, geom, { ilIdx: 8, xlIdx: 8, sample: truth(8, 8) },
      { mode: 'peak', window: 3, maxJump: 3 },
    );
    expect(tracked).toBe(NIL * NXL);
    for (let i = 0; i < NIL; i++) {
      for (let j = 0; j < NXL; j++) {
        expect(Math.abs(picks[i * NXL + j] - truth(i, j))).toBeLessThan(0.6);
      }
    }
  });
});
