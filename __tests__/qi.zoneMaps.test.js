/**
 * Zone maps from volumes (QI upgrade P1.5). Every gate calls the shipped
 * functions: against the numpy oracle (tools/validation/qi/oracle_zone_maps.py,
 * its own window arithmetic and reductions; goldens in
 * test-data/qi/goldens.zoneMaps.json), against closed forms on a linear
 * trace, and against Seismolord's interval attribute, whose window convention
 * the zone shares. Negative controls: a floor window and a window one sample
 * short both fail the goldens; nulls counted as values fail.
 */
import fs from 'fs';
import path from 'path';
import { zoneRange, zoneStats, zoneSpread, zoneThicknessMs, zoneProducts } from '../engines/qi/zoneMaps';
import { intervalStat } from '../engines/seismolord/horizonAmplitude';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/qi/goldens.zoneMaps.json'), 'utf8'));
const close = (a, b, tol = 1e-12) => (b == null ? Number.isNaN(a) : Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)));

describe('against the numpy oracle', () => {
  test.each(G.cases.map((c, i) => [i, c]))('case %i: window, statistics and spread', (i, c) => {
    const r = zoneRange(c.top, c.base, c.ns, { windowSamples: c.window });
    expect(r).toEqual(c.range);
    if (!r) return;
    const st = zoneStats(c.trace, r[0], r[1], { cutoff: c.cutoff });
    for (const k of ['mean', 'rms', 'min', 'max', 'frac']) expect(close(st[k], c.stats[k])).toBe(true);
    expect(st.n).toBe(c.stats.n);
    expect(close(zoneStats(c.trace, r[0], r[1], { cutoff: c.cutoff, above: false }).frac, c.statsBelow.frac)).toBe(true);
    const sp = zoneSpread(c.q10, c.trace, c.q90, r[0], r[1]);
    expect(close(sp.spread, c.spread.spread)).toBe(true);
    expect(close(sp.relSpread, c.spread.relSpread)).toBe(true);
  });

  test('negative controls: a floor window, a window one sample short and nulls counted all fail the goldens', () => {
    const floorRange = (c) => { const b = c.base ?? c.top + c.window; return [Math.max(0, Math.floor(Math.min(c.top, b))), Math.min(c.ns - 1, Math.floor(Math.max(c.top, b)))]; };
    let floorMiss = 0; let shortMiss = 0; let nullMiss = 0;
    for (const c of G.cases.filter((x) => x.range)) {
      const [f0, f1] = floorRange(c);
      if (!close(zoneStats(c.trace, f0, f1).mean, c.stats.mean)) floorMiss += 1;
      if (!close(zoneStats(c.trace, c.range[0], c.range[1] - 1).mean, c.stats.mean)) shortMiss += 1;
      const seg = c.trace.slice(c.range[0], c.range[1] + 1);
      if (!close(seg.reduce((a, v) => a + v, 0) / seg.length, c.stats.mean)) nullMiss += 1;
    }
    expect(floorMiss).toBeGreaterThan(5);
    expect(shortMiss).toBeGreaterThan(8);
    expect(nullMiss).toBeGreaterThan(8);
  });
});

describe('closed forms', () => {
  const ns = 200; const a = 0.3; const b = 0.002;
  const lin = Float64Array.from({ length: ns }, (_, k) => a + b * k);
  test('a linear trace: the mean is the value at the window centre, the RMS and the share above a cutoff are exact', () => {
    const [s0, s1] = zoneRange(40.4, 90.6, ns);
    expect([s0, s1]).toEqual([40, 91]);
    const st = zoneStats(lin, s0, s1, { cutoff: a + b * 70.5 });
    expect(st.mean).toBeCloseTo(a + (b * (s0 + s1)) / 2, 13);
    let sq = 0; for (let k = s0; k <= s1; k++) sq += (a + b * k) ** 2;
    expect(st.rms).toBeCloseTo(Math.sqrt(sq / (s1 - s0 + 1)), 13);
    expect(st.frac).toBeCloseTo((s1 - 70) / (s1 - s0 + 1), 13);
    expect(st.min).toBeCloseTo(a + b * s0, 13);
    expect(st.max).toBeCloseTo(a + b * s1, 13);
  });
  test('the base above the top reads the same zone; a window below the top; clamping; missing picks', () => {
    expect(zoneRange(90.6, 40.4, ns)).toEqual([40, 91]);
    expect(zoneRange(10.5, null, ns, { windowSamples: 20 })).toEqual([11, 31]);
    expect(zoneRange(-8, 5, ns)).toEqual([0, 5]);
    expect(zoneRange(190, 260, ns)).toEqual([190, 199]);
    expect(zoneRange(1e30, 50, ns)).toBeNull();
    expect(zoneRange(20, 1e30, ns)).toBeNull();
    expect(zoneRange(20, null, ns)).toBeNull();
    expect(zoneRange(250, 300, ns)).toBeNull();
  });
  test('the zone shares Seismolord\'s interval window: mean and RMS equal intervalStat', () => {
    const tr = Float32Array.from({ length: ns }, (_, k) => Math.fround(Math.sin(k / 7) + 0.1 * Math.cos(k / 3)));
    tr[55] = Math.fround(1e30);
    for (const [t, bse] of [[40.4, 90.6], [12.5, 13.5], [100.49, 180.51]]) {
      const [s0, s1] = zoneRange(t, bse, ns);
      const at = (s) => tr[s];
      expect(zoneStats(tr, s0, s1).mean).toBeCloseTo(intervalStat(at, ns, t, bse, 'mean'), 6);
      expect(zoneStats(tr, s0, s1).rms).toBeCloseTo(intervalStat(at, ns, t, bse, 'rms'), 6);
    }
  });
  test('a zone with no live sample is NaN; a constant spread is that spread', () => {
    const dead = new Float64Array(10).fill(1e30);
    expect(zoneStats(dead, 0, 9).n).toBe(0);
    expect(Number.isNaN(zoneStats(dead, 0, 9).mean)).toBe(true);
    const sp = zoneSpread(new Float64Array(10).fill(1), new Float64Array(10).fill(2), new Float64Array(10).fill(1.5), 0, 9);
    expect(sp.spread).toBeCloseTo(0.5, 14);
    expect(sp.relSpread).toBeCloseTo(0.25, 14);
    expect(zoneThicknessMs(10, 35.5, 4)).toBeCloseTo(102, 12);
  });
  test('zoneProducts gives each requested product in order, NaN with no zone', () => {
    const products = [
      { key: 'm', kind: 'stat', input: 'v', stat: 'mean' },
      { key: 'f', kind: 'stat', input: 'v', stat: 'frac', cutoff: a + b * 70.5 },
      { key: 's', kind: 'spread', q10: 'lo', q50: 'v', q90: 'hi' },
      { key: 'r', kind: 'spread', q10: 'lo', q50: 'v', q90: 'hi', relative: true },
      { key: 't', kind: 'thickness' },
    ];
    const lo = lin.map((v) => v - 0.01); const hi = lin.map((v) => v + 0.03);
    const range = zoneRange(40.4, 90.6, ns);
    const out = zoneProducts({ traces: { v: lin, lo, hi }, products, range, top: 40.4, base: 90.6, dtMs: 4 });
    expect(out[0]).toBeCloseTo(a + (b * (40 + 91)) / 2, 13);
    expect(out[1]).toBeCloseTo((91 - 70) / 52, 13);
    expect(out[2]).toBeCloseTo(0.04, 13);
    expect(out[4]).toBeCloseTo(200.8, 10);
    expect(Array.from(zoneProducts({ traces: { v: lin }, products: products.slice(0, 1), range: null, top: 1, base: 2, dtMs: 4 })).every(Number.isNaN)).toBe(true);
  });
});
