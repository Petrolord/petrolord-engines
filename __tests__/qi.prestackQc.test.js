import { nmoStretch, stretchMuteOffset, residualMoveout, foldSummary } from '../engines/qi/prestackQc';

describe('NMO stretch', () => {
  test('the analytic stretch, and the mute offset inverts it', () => {
    // t0 = 1 s, v = 2000 m/s, x = 2000 m: t = sqrt(2) s, stretch sqrt(2) - 1
    expect(nmoStretch(2000, 1, 2000)).toBeCloseTo(Math.SQRT2 - 1, 12);
    const x = stretchMuteOffset(1.2, 2500, 0.3);
    expect(nmoStretch(x, 1.2, 2500)).toBeCloseTo(0.3, 12);
    expect(nmoStretch(0, 1, 2000)).toBe(0);
    expect(nmoStretch(100, 0, 2000)).toBeNaN();
  });
});

describe('residual moveout', () => {
  const dtMs = 2; const ns = 400; const offsets = Array.from({ length: 24 }, (_, k) => 100 + 150 * k);
  const ricker = (t) => { const a = (Math.PI * 30 * t / 1000) ** 2; return (1 - 2 * a) * Math.exp(-a); };
  const gather = (curv) => offsets.map((x) => Float64Array.from({ length: ns }, (_, i) => ricker(i * dtMs - (400 + curv * x * x))));
  test('a known parabolic residual is recovered: 8 ms at the far offset', () => {
    const far = offsets[offsets.length - 1];
    const a = 8 / (far * far);
    const r = residualMoveout({ traces: gather(a), offsets, dtMs, centreMs: 400 });
    expect(r.rmoFarMs).toBeCloseTo(8, 0);
    expect(Math.abs(r.curvature - a) / a).toBeLessThan(0.03);
    expect(r.used).toBe(24);
  });
  test('negative control: a flat gather measures no residual', () => {
    const r = residualMoveout({ traces: gather(0), offsets, dtMs, centreMs: 400 });
    expect(Math.abs(r.rmoFarMs)).toBeLessThan(0.3);
  });
  test('too few live traces give no measure', () => {
    const r = residualMoveout({ traces: [new Float64Array(10), new Float64Array(10)], offsets: [100, 200], dtMs, centreMs: 10 });
    expect(r.rmoFarMs).toBeNaN();
  });
});

test('fold summary', () => {
  expect(foldSummary([3, 2, 0, 1], [50, 150, 250, 350], 1)).toEqual({ total: 6, farOffset: 350, liveBins: 3 });
  expect(foldSummary([3, 2, 0, 1], [50, 150, 250, 350], 2).farOffset).toBe(150);
});

// Flat gathers with amplitude change across offset (2026-10-10): the first
// estimator cross-correlated each offset against a near stack and read 5 to
// 33 ms of residual on gathers flat by construction. AB semblance reads zero.
describe('residual moveout with AVO (flat and curved gathers)', () => {
  const dtMs = 4; const ns = 500; const offsets = Array.from({ length: 13 }, (_, k) => 100 + 200 * k);
  const far = offsets[offsets.length - 1];
  const ricker = (t) => { const a = (Math.PI * 25 * t / 1000) ** 2; return (1 - 2 * a) * Math.exp(-a); };
  // events {t, a, b}: amplitude a + b s, s = k / 12; rmoFar: the true residual at the far offset
  const gather = (events, rmoFar = 0, noise = 0) => {
    let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    return offsets.map((x, k) => {
      const s = k / 12; const dt = (rmoFar * x * x) / (far * far);
      return Float64Array.from({ length: ns }, (_, i) => events.reduce((acc, e) => acc + (e.a + e.b * s) * ricker(i * dtMs - e.t - dt), 0) + noise * rnd());
    });
  };
  const cases = [
    ['class I, polarity flip', [{ t: 1000, a: 0.15, b: -0.3 }], 1000],
    ['two events 24 ms apart, opposite AVO', [{ t: 1000, a: 0.15, b: -0.25 }, { t: 1024, a: -0.05, b: 0.2 }], 1010],
    ['thin-bed tuning', [{ t: 1000, a: 0.14, b: -0.5 }, { t: 1016, a: -0.11, b: 0.2 }, { t: 1040, a: 0.05, b: 0.05 }], 1000],
    ['class I, no flip', [{ t: 1000, a: 0.15, b: -0.1 }], 1000],
  ];
  test.each(cases)('flat: %s reads no residual', (_, events, centreMs) => {
    const r = residualMoveout({ traces: gather(events), offsets, dtMs, centreMs });
    expect(Math.abs(r.rmoFarMs)).toBeLessThan(1);
    expect(r.used).toBe(13); // the trace at the polarity crossing is live, with no energy
  });
  test.each([[8], [-12]])('a true residual of %s ms at the far offset is recovered, with and without AVO', (rmo) => {
    for (const [, events, centreMs] of cases) {
      const r = residualMoveout({ traces: gather(events, rmo), offsets, dtMs, centreMs });
      expect(Math.abs(r.rmoFarMs - rmo)).toBeLessThan(1.5);
    }
  });
  test('noise: a flat gather with noise at a fifth of the peak still reads under 3 ms (the QC flags 4 ms)', () => {
    for (const [, events, centreMs] of cases) {
      const r = residualMoveout({ traces: gather(events, 0, 0.06), offsets, dtMs, centreMs });
      expect(Math.abs(r.rmoFarMs)).toBeLessThan(3);
    }
  });
  test('a gather whose waveform holds is measured by correlation; one whose waveform changes falls back to AB semblance', () => {
    expect(residualMoveout({ traces: gather(cases[3][1], 8), offsets, dtMs, centreMs: 1000 }).method).toBe('correlation');
    expect(residualMoveout({ traces: gather(cases[1][1]), offsets, dtMs, centreMs: 1010 }).method).toBe('ab-semblance');
  });
  test('negative control: the first estimator (signed correlation against a near stack) reads the flat AVO gathers as moved out', () => {
    const old = (traces, centreMs) => {
      const ref = Float64Array.from(traces[0], (_, i) => (traces[0][i] + traces[1][i] + traces[2][i]) / 3);
      const c0 = Math.round(centreMs / dtMs); const h = 10; const L = 6; let sxy = 0; let sxx = 0;
      offsets.forEach((x, k) => {
        let best = 0; let bv = -Infinity;
        for (let lag = -L; lag <= L; lag++) {
          let s = 0; let ea = 0; let eb = 0;
          for (let i = c0 - h; i <= c0 + h; i++) { s += ref[i] * traces[k][i + lag]; ea += ref[i] ** 2; eb += traces[k][i + lag] ** 2; }
          const cc = s / Math.sqrt(ea * eb); if (cc > bv) { bv = cc; best = lag; }
        }
        if (bv > 0.3) { sxy += x * x * best * dtMs; sxx += x ** 4; }
      });
      return (sxy / sxx) * far * far;
    };
    expect(Math.abs(old(gather(cases[1][1]), 1010))).toBeGreaterThan(10);
    expect(Math.abs(old(gather(cases[2][1]), 1000))).toBeGreaterThan(10);
  });
});
