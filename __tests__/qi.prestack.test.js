import {
  dixInterval, layeredRms, rayTraceAngle, waldenAngle, binOffsets, angleGather, partialStack, usableAngle,
} from '../engines/qi/prestack';

// A flat layered earth: the known truth for Dix and for the incidence angle.
const LAYERS = [
  { thicknessM: 600, v: 1800 }, { thicknessM: 500, v: 2200 }, { thicknessM: 700, v: 2700 }, { thicknessM: 400, v: 3200 },
];

describe('velocities', () => {
  test('Dix recovers the interval velocities from the layered RMS function exactly', () => {
    const rms = layeredRms(LAYERS);
    const vi = dixInterval(rms.map((r) => r.vrms), rms.map((r) => r.t0));
    LAYERS.forEach((l, k) => expect(vi[k]).toBeCloseTo(l.v, 9));
  });
  test('refusals', () => {
    expect(() => dixInterval([2000], [1])).toThrow(/two or more/);
    expect(() => dixInterval([2000, 1000], [1, 2])).toThrow(/no real interval velocity/);
  });
});

describe('incidence angle', () => {
  test('ray tracing: one layer is the geometry, tan(theta) = (x / 2) / z', () => {
    expect(rayTraceAngle([{ thicknessM: 1000, v: 2000 }], 0, 1000)).toBeCloseTo(Math.atan(0.5) * 180 / Math.PI, 9);
  });
  test('Walden straight ray is within 1.5 degrees of the exact ray at offsets up to the target depth', () => {
    const rms = layeredRms(LAYERS);
    const target = 3; const z = LAYERS.reduce((s, l) => s + l.thicknessM, 0);
    for (const x of [250, 500, 1000, 1500, z]) {
      const exact = rayTraceAngle(LAYERS, target, x);
      const approx = waldenAngle(x, rms[target].t0, rms[target].vrms, LAYERS[target].v);
      expect(Math.abs(approx - exact)).toBeLessThan(1.5);
    }
  });
  test('negative control: leaving out the Vint / Vrms factor misses the exact angle by more', () => {
    const rms = layeredRms(LAYERS);
    const x = 1500; const t = rms[3];
    const exact = rayTraceAngle(LAYERS, 3, x);
    const naive = Math.asin(x / Math.sqrt(x * x + (t.vrms * t.t0) ** 2)) * 180 / Math.PI;
    expect(Math.abs(naive - exact)).toBeGreaterThan(3 * Math.abs(waldenAngle(x, t.t0, t.vrms, LAYERS[3].v) - exact));
  });
});

describe('gathers', () => {
  const ns = 200; const dtMs = 4;
  const vrms = new Float64Array(ns).fill(2500); const vint = new Float64Array(ns).fill(2500);
  const offsets = Array.from({ length: 30 }, (_, j) => 50 + 100 * j);
  // an NMO-corrected gather whose amplitude is a known function of angle (Shuey two-term: A + B sin^2)
  const A = 0.1; const Bg = -0.2;
  const traces = offsets.map((x) => Float64Array.from({ length: ns }, (_, i) => {
    const th = waldenAngle(x, (i * dtMs) / 1000, 2500, 2500) * Math.PI / 180;
    return i === 120 ? A + Bg * Math.sin(th) ** 2 : 0;
  }));
  const edges = [0, 10, 20, 30, 40];
  test('offset bins', () => {
    const b = binOffsets([0, 24, 25, 99, -1, NaN], 25);
    expect(Array.from(b.index)).toEqual([0, 0, 1, 3, -1, -1]);
    expect(b.fold).toEqual([2, 1, 0, 1]);
    expect(b.centres[1]).toBe(37.5);
  });
  test('the angle gather keeps the AVO trend: each bin near A + B sin^2 of its angles', () => {
    const g = angleGather({ traces, offsets, vrms, vint, dtMs, edges });
    for (let k = 0; k < 4; k++) {
      if (!g.fold[k][120]) continue;
      const lo = A + Bg * Math.sin(edges[k + 1] * Math.PI / 180) ** 2; const hi = A + Bg * Math.sin(edges[k] * Math.PI / 180) ** 2;
      expect(g.gather[k][120]).toBeGreaterThanOrEqual(lo - 1e-12);
      expect(g.gather[k][120]).toBeLessThanOrEqual(hi + 1e-12);
    }
    expect(g.gather[0][120]).toBeGreaterThan(g.gather[2][120]); // amplitude falls with angle (a negative gradient)
  });
  test('partial stacks and the usable angle', () => {
    const g = angleGather({ traces, offsets, vrms, vint, dtMs, edges });
    const near = partialStack(g, 0, 1); const far = partialStack(g, 2, 4);
    expect(near[120]).toBeGreaterThan(far[120]);
    const u = usableAngle(g, edges, 2);
    // at 480 ms the 30 offsets up to 2950 m reach past 40 degrees: every bin has two or more traces
    expect(u[120]).toBe(40);
    // at 80 ms even the nearest offset (50 m) is at 14 degrees: the first bin is empty, so nothing is usable
    expect(u[20]).toBeNaN();
    // at 240 ms, one trace per bin up to 30 degrees and two in the last: usable to 40 with a fold of one
    expect(usableAngle(g, edges, 1)[60]).toBe(40);
    expect(usableAngle(g, edges, 2)[60]).toBeNaN();
  });
  test('negative control: offsets read as angles (no mapping) scramble the AVO trend', () => {
    // put each trace in the bin of its offset in hundreds of metres instead of its angle
    const wrong = { gather: [0, 1, 2, 3].map((k) => Float64Array.from({ length: ns }, (_, i) => traces[k * 7][i])), fold: [0, 1, 2, 3].map(() => new Int32Array(ns).fill(1)) };
    const right = angleGather({ traces, offsets, vrms, vint, dtMs, edges });
    expect(Math.abs(wrong.gather[3][120] - right.gather[3][120])).toBeGreaterThan(1e-3);
  });
});

describe('velocity table on the trace grid', () => {
  const { velocityOnGrid } = require('../engines/qi/prestack');
  test('Vrms interpolates, Vint is the segment Dix value, held outside the table', () => {
    const rms = layeredRms(LAYERS);
    const tMs = rms.map((r) => 1000 * r.t0); const v = rms.map((r) => r.vrms);
    const g = velocityOnGrid(tMs, v, 1000, 2);
    const at = (t) => Math.round(t / 2);
    // inside layer 3 (between the bases of layers 2 and 3) Vint is that layer's velocity
    expect(g.vint[at((tMs[1] + tMs[2]) / 2)]).toBeCloseTo(LAYERS[2].v, 6);
    expect(g.vrms[at(tMs[1])]).toBeCloseTo(v[1], 0); // the nearest grid sample, within one sample of slope
    expect(g.vrms[999]).toBe(v[v.length - 1]);
    expect(Array.from(velocityOnGrid([500], [2200], 3, 4).vint)).toEqual([2200, 2200, 2200]);
  });
  test('refusals', () => {
    expect(() => velocityOnGrid([1, 1], [2000, 2100], 3, 4)).toThrow(/increase/);
    expect(() => velocityOnGrid([1], [0], 3, 4)).toThrow(/positive/);
  });
});
