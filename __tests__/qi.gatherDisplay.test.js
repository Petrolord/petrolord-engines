import {
  nmoCorrect, angleField, angleContour, stretchMuteTimes,
} from '../engines/qi/gatherDisplay';
import { waldenAngle, velocityOnGrid, layeredRms } from '../engines/qi/prestack';
import { stretchMuteOffset } from '../engines/qi/prestackQc';

// Known truth. A flat reflector under a constant velocity v has the exact
// hyperbola t(x) = sqrt(t0^2 + x^2 / v^2), so NMO with v must flatten it to
// the zero-offset time exactly (up to the interpolation of the wavelet).
const DT = 2; const NS = 1200;
const OFFS = Array.from({ length: 16 }, (_, k) => 100 + 200 * k);
const ricker = (tMs, f = 30) => { const a = (Math.PI * f * tMs / 1000) ** 2; return (1 - 2 * a) * Math.exp(-a); };
const peakMs = (tr, fromMs, toMs) => {
  let best = -1; let bv = -Infinity;
  for (let i = Math.round(fromMs / DT); i <= Math.round(toMs / DT); i++) if (Number.isFinite(tr[i]) && tr[i] > bv) { bv = tr[i]; best = i; }
  if (best <= 0) return NaN;
  const l = tr[best - 1]; const c = tr[best]; const r = tr[best + 1];
  return (best + (l - r) / (2 * (l - 2 * c + r))) * DT; // parabolic peak
};
const gatherAt = (events, travel) => OFFS.map((x) => Float64Array.from({ length: NS }, (_, i) => events.reduce((s, t0) => s + ricker(i * DT - travel(x, t0)), 0)));

describe('NMO correction', () => {
  const v = 2500;
  const hyper = (x, t0) => Math.sqrt(t0 * t0 + (1000 * x / v) ** 2);
  const raw = gatherAt([600, 1100], hyper);
  const vrms = new Float64Array(NS).fill(v);

  test('a constant-velocity hyperbola is flattened to its zero-offset time at every offset (within a quarter sample)', () => {
    const out = nmoCorrect({ traces: raw, offsets: OFFS, vrms, dtMs: DT });
    out.forEach((tr) => {
      expect(Math.abs(peakMs(tr, 560, 640) - 600)).toBeLessThan(0.5);
      expect(Math.abs(peakMs(tr, 1060, 1140) - 1100)).toBeLessThan(0.5);
    });
  });

  test('a layered earth: the exact ray traveltime is flattened within 2 ms up to an offset equal to the depth (Vrms from Dix layers)', () => {
    const LAY = [{ thicknessM: 500, v: 1900 }, { thicknessM: 600, v: 2400 }];
    const rms = layeredRms(LAY);
    const z = 1100;
    // exact traveltime to the base of layer 2 for offset x: solve the ray parameter p, then t = 2 sum h / (v cos)
    const exactT = (x) => {
      const xOf = (p) => 2 * LAY.reduce((s, l) => s + (l.thicknessM * p * l.v) / Math.sqrt(1 - (p * l.v) ** 2), 0);
      let lo = 0; let hi = (1 - 1e-12) / 2400;
      for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (xOf(m) < x) lo = m; else hi = m; }
      const p = (lo + hi) / 2;
      return 2000 * LAY.reduce((s, l) => s + l.thicknessM / (l.v * Math.sqrt(1 - (p * l.v) ** 2)), 0);
    };
    const t0 = rms[1].t0 * 1000;
    const tr = OFFS.filter((x) => x <= z).map((x) => Float64Array.from({ length: NS }, (_, i) => ricker(i * DT - exactT(x))));
    const vel = velocityOnGrid([rms[0].t0 * 1000, t0], [rms[0].vrms, rms[1].vrms], NS, DT);
    const out = nmoCorrect({ traces: tr, offsets: OFFS.filter((x) => x <= z), vrms: vel.vrms, dtMs: DT });
    out.forEach((c) => expect(Math.abs(peakMs(c, t0 - 40, t0 + 40) - t0)).toBeLessThan(2));
  });

  test('negative control: a velocity 15 percent too fast leaves the far offset over 10 ms late', () => {
    const out = nmoCorrect({ traces: raw, offsets: OFFS, vrms: new Float64Array(NS).fill(v * 1.15), dtMs: DT });
    expect(peakMs(out[OFFS.length - 1], 1060, 1300) - 1100).toBeGreaterThan(10);
  });

  test('the stretch mute nulls exactly the samples past the limit', () => {
    const s = 0.3;
    // a live constant input, so only the mute (and the trace end) nulls samples
    const flat = OFFS.map(() => new Float64Array(4 * NS).fill(1));
    const out = nmoCorrect({ traces: flat, offsets: OFFS, vrms, dtMs: DT, maxStretch: s });
    const mute = stretchMuteTimes({ offsets: OFFS, vrms, dtMs: DT, maxStretch: s });
    let checked = 0;
    out.forEach((tr, j) => {
      if (!Number.isFinite(mute[j])) { expect(tr.every((x) => Number.isNaN(x))).toBe(true); return; }
      expect(tr.findIndex((x) => Number.isFinite(x)) * DT).toBe(mute[j]);
      checked += 1;
    });
    expect(checked).toBeGreaterThan(8);
    // without the limit the same input is live from the first sample past t0 = 0
    expect(nmoCorrect({ traces: flat, offsets: OFFS, vrms, dtMs: DT })[5][1]).toBe(1);
  });

  test('refusals and nulls', () => {
    expect(() => nmoCorrect({ traces: raw, offsets: [1], vrms, dtMs: DT })).toThrow(/one offset per trace/);
    const nulls = [Float64Array.from({ length: NS }, () => 1e30)];
    expect(nmoCorrect({ traces: nulls, offsets: [0], vrms, dtMs: DT })[0].every((x) => Number.isNaN(x))).toBe(true);
  });
});

describe('angle overlay and stretch mute', () => {
  const v = 2400;
  const vrms = new Float64Array(NS).fill(v); const vint = new Float64Array(NS).fill(v);

  test('the angle field is the engine Walden angle at each sample', () => {
    const f = angleField({ offsets: OFFS, vrms, vint, dtMs: DT });
    expect(f[3][200]).toBe(waldenAngle(OFFS[3], 0.4, v, v));
    expect(Number.isNaN(f[0][0])).toBe(true);
  });

  test('constant velocity: the 30 degree contour is t0 = x cot(30) / v', () => {
    const f = angleField({ offsets: OFFS, vrms, vint, dtMs: DT });
    const c = angleContour(f, { angleDeg: 30, dtMs: DT });
    OFFS.forEach((x, j) => {
      const truth = (1000 * x) / (v * Math.tan(Math.PI / 6));
      if (truth < (NS - 1) * DT) expect(Math.abs(c[j] - truth)).toBeLessThan(0.2);
    });
  });

  test('negative control: the contour from a field at half the velocity is far from the truth', () => {
    const half = new Float64Array(NS).fill(v / 2);
    const c = angleContour(angleField({ offsets: OFFS, vrms: half, vint: half, dtMs: DT }), { angleDeg: 30, dtMs: DT });
    const truth = (1000 * OFFS[4]) / (v * Math.tan(Math.PI / 6));
    expect(Math.abs(c[4] - truth)).toBeGreaterThan(50);
  });

  test('stretch mute: the earliest time inside the limit inverts the stretch-mute offset', () => {
    const s = 0.3;
    const t = stretchMuteTimes({ offsets: OFFS, vrms, dtMs: DT, maxStretch: s });
    OFFS.forEach((x, j) => {
      const exact = (1000 * x) / (v * Math.sqrt((1 + s) ** 2 - 1));
      expect(t[j]).toBeGreaterThanOrEqual(exact - 1e-9);
      expect(t[j] - exact).toBeLessThan(DT);
      expect(stretchMuteOffset(t[j] / 1000, v, s)).toBeGreaterThanOrEqual(x - 1e-6);
    });
    expect(() => stretchMuteTimes({ offsets: OFFS, vrms, dtMs: DT, maxStretch: 0 })).toThrow(/positive/);
  });
});
