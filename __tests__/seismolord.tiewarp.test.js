/**
 * W3.3 well-tie 2.0 oracles: the anchor warp against hand-computed
 * piecewise mappings, warp commitment to checkshots / fitWellTie ties
 * on an analytic T(z), constant-phase estimation with a KNOWN rotation,
 * and windowed QC on constructed agreement/disagreement.
 */

import {
  makeTieWarp, warpTrace, warpToCheckshots, warpToTiePoints,
  rotateConstantPhase, estimatePhaseRotation, windowedTieQc,
} from '../engines/seismolord/tieWarp';
import { fitWellTie } from '../engines/seismolord/wellTie';
import { suggestBulkShift } from '../engines/seismolord/synthetics';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const NULL_F32 = Math.fround(NULL_VALUE);
const NS = 256;
const DT_MS = 4;

function waveTrace(ns, centerMs, { widthMs = 24, freq = 0.09 } = {}) {
  const t = new Float32Array(ns);
  for (let i = 0; i < ns; i++) {
    const d = i * DT_MS - centerMs;
    t[i] = Math.exp(-(d * d) / (2 * widthMs * widthMs)) * Math.cos(freq * d);
  }
  return t;
}

describe('makeTieWarp', () => {
  test('single anchor = the bulk shift', () => {
    const w = makeTieWarp([{ synTwtMs: 500, seisTwtMs: 512 }]);
    expect(w.toSeismicMs(0)).toBe(12);
    expect(w.toSeismicMs(900)).toBe(912);
    expect(w.toSyntheticMs(512)).toBe(500);
  });

  test('piecewise-linear between anchors, slope-one extension outside', () => {
    const w = makeTieWarp([
      { synTwtMs: 400, seisTwtMs: 410 },
      { synTwtMs: 800, seisTwtMs: 830 },
    ]);
    // inside: 600 is halfway -> maps to halfway between 410 and 830
    expect(w.toSeismicMs(600)).toBeCloseTo(620, 9);
    // outside: constant shift of the nearest anchor
    expect(w.toSeismicMs(300)).toBeCloseTo(310, 9);
    expect(w.toSeismicMs(1000)).toBeCloseTo(1030, 9);
    // inverse round-trips
    for (const t of [350, 500, 700, 900]) {
      expect(w.toSyntheticMs(w.toSeismicMs(t))).toBeCloseTo(t, 9);
    }
  });

  test('folding anchors are rejected', () => {
    expect(() => makeTieWarp([
      { synTwtMs: 400, seisTwtMs: 500 },
      { synTwtMs: 500, seisTwtMs: 480 },   // seismic time decreases
    ])).toThrow(/fold/);
    expect(() => makeTieWarp([])).toThrow(/at least one anchor/);
  });
});

describe('warpTrace', () => {
  test('a stretch moves the event exactly to its anchor', () => {
    // event at 400 ms; anchors stretch 400 -> 440
    const syn = waveTrace(NS, 400);
    const w = makeTieWarp([
      { synTwtMs: 200, seisTwtMs: 200 },
      { synTwtMs: 400, seisTwtMs: 440 },
      { synTwtMs: 700, seisTwtMs: 700 },
    ]);
    const out = warpTrace(syn, DT_MS, w);
    // the warped event peaks at 440 ms
    let best = 0;
    let bestV = -Infinity;
    for (let i = 0; i < NS; i++) {
      if (out[i] !== NULL_F32 && out[i] > bestV) { bestV = out[i]; best = i; }
    }
    expect(best * DT_MS).toBeCloseTo(440, 0);
    // anchor times themselves map exactly
    expect(out[110]).toBeCloseTo(syn[100], 5); // 440 ms out = 400 ms in
  });

  test('gaps and out-of-range stay null', () => {
    const syn = waveTrace(NS, 400);
    syn[50] = NULL_F32;
    const w = makeTieWarp([{ synTwtMs: 0, seisTwtMs: 40 }]); // shift +40ms
    const out = warpTrace(syn, DT_MS, w);
    expect(out[0]).toBe(NULL_F32);              // maps before the synthetic
    expect(out[60]).toBe(NULL_F32);             // lands on the gap (50+10)
    expect(out[59]).toBe(NULL_F32);             // interpolation touches it
    expect(out[61]).not.toBe(NULL_F32);         // clear of the gap again
  });

  test('single-anchor warp reproduces what suggestBulkShift means', () => {
    const syn = waveTrace(NS, 400);
    const seis = waveTrace(NS, 424);
    const s = suggestBulkShift(syn, seis, DT_MS, 60);
    expect(s.lagMs).toBeCloseTo(24, 5);
    const w = makeTieWarp([{ synTwtMs: 400, seisTwtMs: 400 + s.lagMs }]);
    const out = warpTrace(syn, DT_MS, w);
    // warped synthetic now correlates ~1 with the seismic at zero lag
    const again = suggestBulkShift(out, seis, DT_MS, 60);
    expect(again.lagMs).toBeCloseTo(0, 5);
    expect(again.corr).toBeGreaterThan(0.999);
  });
});

describe('committing the warp', () => {
  // analytic T(z): constant 2000 m/s -> z = t/2 * 2 (m per ms one-way)
  // tvdss = (twtMs / 2000) * 2000 / 2 ... keep it simple: z = 0.5 * twt
  const twtToTvdss = (twtMs) => 0.5 * twtMs;

  test('derived checkshots: anchor depths + warped times', () => {
    const w = makeTieWarp([
      { synTwtMs: 400, seisTwtMs: 410 },
      { synTwtMs: 800, seisTwtMs: 830 },
    ]);
    const rows = warpToCheckshots(w, twtToTvdss);
    expect(rows).toEqual([
      { tvdssM: 200, twtMs: 410 },
      { tvdssM: 400, twtMs: 830 },
    ]);
  });

  test('ties feed fitWellTie and recover the implied velocity', () => {
    // truth AFTER the tie: depth z at seismic time t follows
    // z = v0 * (t/2000) exactly when checkshot times are consistent
    // with a constant-velocity model. Build anchors from that truth:
    // v0 = 2400 m/s -> z(t) = 1.2 * t (m per ms of TWT)
    const zOf = (seisMs) => 1.2 * seisMs;
    const anchors = [
      { synTwtMs: 2 * zOf(400) , seisTwtMs: 400 },
      { synTwtMs: 2 * zOf(800), seisTwtMs: 800 },
    ].map((a) => ({ ...a, synTwtMs: a.synTwtMs / 1.0 }));
    // twtToTvdss must return the anchor's TRUE depth from synthetic time:
    // synthetic was built with z = 0.5 * synTwt (2000 m/s)
    const w = makeTieWarp(anchors.map((a) => ({
      synTwtMs: 2 * zOf(a.seisTwtMs), seisTwtMs: a.seisTwtMs,
    })));
    const ties = warpToTiePoints(w, (synMs) => 0.5 * synMs, { wellName: 'W1' });
    expect(ties).toHaveLength(2);
    const fit = fitWellTie(ties, { v0: 2000, k: 0 }, { dtUs: DT_MS * 1000 });
    expect(fit.model.v0).toBeCloseTo(2400, 0);
    expect(fit.rmsAfterM).toBeLessThan(0.1);
    expect(fit.rmsBeforeM).toBeGreaterThan(50);
  });

  test('unreachable T(z) throws instead of silently dropping all anchors', () => {
    const w = makeTieWarp([{ synTwtMs: 400, seisTwtMs: 410 }]);
    expect(() => warpToCheckshots(w, () => null)).toThrow(/does not reach/);
    expect(() => warpToTiePoints(w, () => null)).toThrow(/does not reach/);
  });
});

describe('constant-phase rotation', () => {
  test('recovers a known rotation within a degree', () => {
    const s = waveTrace(NS, 500);
    for (const deg of [30, -60, 90, 145]) {
      const r = rotateConstantPhase(s, (deg * Math.PI) / 180);
      const est = estimatePhaseRotation(s, r);
      expect(est).not.toBeNull();
      expect(est.phiDeg).toBeCloseTo(deg, 0);
      expect(est.corr).toBeGreaterThan(0.99);
      expect(est.corr).toBeGreaterThanOrEqual(est.corr0 - 1e-9);
    }
  });

  test('zero phase on identical traces', () => {
    const s = waveTrace(NS, 500);
    const est = estimatePhaseRotation(s, s);
    expect(Math.abs(est.phiDeg)).toBeLessThan(1);
    expect(est.corr).toBeGreaterThan(0.999);
  });

  test('rotation by 180 degrees flips polarity', () => {
    const s = waveTrace(NS, 500);
    const r = rotateConstantPhase(s, Math.PI);
    for (let i = 120; i < 130; i++) expect(r[i]).toBeCloseTo(-s[i], 4);
  });

  test('gaps propagate and starve the estimate', () => {
    const s = waveTrace(NS, 500);
    const holed = Float32Array.from(s);
    holed.fill(NULL_F32);
    expect(estimatePhaseRotation(s, holed)).toBeNull();
    const r = rotateConstantPhase(holed, 1);
    expect(r[10]).toBe(NULL_F32);
  });
});

describe('windowedTieQc', () => {
  test('1 where identical, -1 where polarity-flipped, null in gaps', () => {
    const syn = waveTrace(NS, 300, { widthMs: 400, freq: 0.12 });
    const seis = Float32Array.from(syn);
    // flip polarity in 600..800 ms, gap out 900..1000 ms
    for (let i = Math.round(600 / DT_MS); i <= Math.round(800 / DT_MS); i++) seis[i] = -seis[i];
    for (let i = Math.round(900 / DT_MS); i <= Math.round(1000 / DT_MS); i++) seis[i] = NULL_F32;
    const rows = windowedTieQc(syn, seis, DT_MS, { windowMs: 80, stepMs: 20 });
    const at = (ms) => rows.reduce((best, r) => (
      Math.abs(r.twtMs - ms) < Math.abs(best.twtMs - ms) ? r : best));
    expect(at(300).corr).toBeGreaterThan(0.999);
    expect(at(700).corr).toBeLessThan(-0.999);
    expect(at(950).corr).toBeNull();
  });
});
