/**
 * Rock Physics Studio U2 engine gates (2026-10-01). Every gate calls the
 * shipped function and carries a negative control that re-breaks the
 * physics and must fail. Expected values come from the independent Python
 * oracle (tools/validation/rockphysics/oracle_u2.py, goldens.u2.json),
 * which asserts the published anchors before it writes.
 *
 *  U2-003 angle gather: the published two polarity reversals (25 and 49
 *         degrees) of van der Baan and Smit (2006), Ostrander's (1984) gas
 *         sand, the gather against the oracle, the picked AVO.
 *  U2-002 fluid line: Castagna, Swan and Foster (1998), B = -A at Vp/Vs 2.
 *  U2-005 iterative Vs: recovers the true gas-sand Vs; direct
 *         Greenberg-Castagna does not.
 *  U2-014 Greenberg-Castagna fast path: identical to the last bit.
 *  U2-001 template lines: critical-porosity sand, mudrock line.
 *  U2-007 pseudo-sonic: Gardner (1974) and Faust (1953) published forms.
 *  U2-016 Voigt fluid mix: the stiff bound over Wood.
 */

import fs from 'fs';
import path from 'path';
import { zoeppritzRpp, akiRichards, shuey } from '../engines/rockphysics/avo';
import {
  interfaceReflectivity, phaseRotatedRicker, twoWayTimeMs, logsToTime, gatherFromTimeModel, angleGather,
  pickEvent, fitInterceptGradient,
} from '../engines/rockphysics/gather';
import {
  backgroundSlope, blockLogs, interfacePoints, fitFluidLine, distanceFromLine,
} from '../engines/rockphysics/avoTrend';
import {
  gcSandShaleVs, greenbergCastagnaVs, gcLithVs, shearForWell, iterativeVs,
} from '../engines/rockphysics/vsEstimate';
import { substituteVels } from '../engines/rockphysics/gassmann';
import {
  criticalPorosityDry, sandPoint, sandLine, mudrockLine, CRITICAL_POROSITY_SANDSTONE,
} from '../engines/rockphysics/templates';
import {
  gardnerRho, gardnerVp, faustVp, fitGardnerA, fitFaustGamma, velocityMisfit, GARDNER_A, FAUST_GAMMA,
} from '../engines/rockphysics/pseudoSonic';
import { woodMix, voigtMix } from '../engines/rockphysics/fluids';
import { rickerWavelet } from '../lib/waveform';

const root = path.join(__dirname, '..');
const G = JSON.parse(fs.readFileSync(path.join(root, 'test-data/rockphysics/goldens.u2.json'), 'utf8'));
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

/** Angles where f changes sign on [lo, hi], by a 0.01 degree scan. */
function zeroCrossings(f, lo, hi) {
  const out = [];
  let prev = f(lo);
  for (let th = lo; th < hi; th += 0.01) {
    const cur = f(th + 0.01);
    if ((prev < 0) !== (cur < 0)) out.push(th + (0.01 * prev) / (prev - cur));
    prev = cur;
  }
  return out;
}

describe('U2-003 angle gather', () => {
  const V = G.published.vdbs;

  test('published example: polarity reverses at 25 and 49 degrees, critical at 53 (van der Baan and Smit 2006)', () => {
    const zc = zeroCrossings((th) => interfaceReflectivity(...V.model, th, 'zoeppritz').r, 0, 53);
    expect(zc).toHaveLength(2);
    expect(Math.abs(zc[0] - 25)).toBeLessThan(0.5);
    expect(Math.abs(zc[1] - 49)).toBeLessThan(0.5);
    expect(zc[0]).toBeCloseTo(V.zero_crossings_deg[0], 6);
    expect(zc[1]).toBeCloseTo(V.zero_crossings_deg[1], 6);
    // critical angle: the first angle the engine flags as past critical
    let crit = null;
    for (let th = 50; th < 56 && crit === null; th += 0.01) if (interfaceReflectivity(...V.model, th).postCritical) crit = th;
    expect(Math.abs(crit - 53)).toBeLessThan(0.5);
    expect(crit).toBeCloseTo(V.critical_deg, 1);
    for (const row of V.curve) expect(interfaceReflectivity(...V.model, row.theta).r).toBeCloseTo(row.r, 12);
  });

  test('negative control: the Aki-Richards curve does not reproduce the published reversals', () => {
    const zc = zeroCrossings((th) => interfaceReflectivity(...V.model, th, 'aki-richards').r, 0, 52);
    // the linearisation reverses about four degrees early
    expect(Math.abs(zc[0] - 25)).toBeGreaterThan(2);
    // and a wrong shear velocity (the paper's model 2) moves it too
    const m2 = [...V.model]; m2[4] = 1255;
    const zc2 = zeroCrossings((th) => interfaceReflectivity(...m2, th).r, 0, 53);
    expect(zc2.length === 0 || Math.abs(zc2[0] - 25) > 2).toBe(true);
  });

  test('Ostrander (1984) gas sand: R(0) = -0.1674 and the reflection brightens with angle', () => {
    const O = G.published.ostrander;
    const rs = O.curve.map((row) => interfaceReflectivity(...O.model, row.theta).r);
    O.curve.forEach((row, i) => expect(rs[i]).toBeCloseTo(row.r, 12));
    expect(rs[0]).toBeCloseTo(-0.1674, 3);
    for (let i = 1; i < rs.length; i++) expect(rs[i]).toBeLessThan(rs[i - 1]);
    // negative control: with the shale's Poisson's ratio in the sand (no gas effect) it dims instead
    const wet = [...O.model]; wet[4] = wet[3] / (O.model[0] / O.model[1]);
    expect(Math.abs(interfaceReflectivity(...wet, 40).r)).toBeLessThan(Math.abs(interfaceReflectivity(...wet, 0).r));
  });

  test('the gather equals the oracle gather (shale, gas sand, shale; 25 Hz Ricker)', () => {
    const g = G.gather;
    const model = { vp: [], vs: [], rho: [] };
    for (let k = 0; k < g.n; k++) {
      const L = k >= g.top && k < g.base ? g.gas : g.shale;
      model.vp.push(L[0]); model.vs.push(L[1]); model.rho.push(L[2]);
    }
    const out = gatherFromTimeModel(model, { angles: g.angles, wavelet: rickerWavelet(g.freq_hz, g.dt_ms, 60) });
    expect(out.traces).toHaveLength(g.angles.length);
    out.traces.forEach((trace, a) => {
      for (let k = 0; k < g.n; k++) expect(Math.abs(trace[k] - g.traces[a][k])).toBeLessThan(1e-6);
    });
    // the gas sand brightens with angle (class III): the top pick grows more negative
    const picks = pickEvent(out.traces, g.top, 0);
    for (let a = 1; a < picks.length; a++) expect(picks[a]).toBeLessThan(picks[a - 1]);
    picks.forEach((p, a) => expect(p).toBeCloseTo(g.picks_top[a], 6));
    expect(out.postCritical.every((c) => c === 0)).toBe(true);

    // negative control: a gather built with the angle ignored (normal incidence everywhere) is flat and fails the oracle
    const flat = gatherFromTimeModel(model, { angles: g.angles.map(() => 0), wavelet: rickerWavelet(g.freq_hz, g.dt_ms, 60) });
    let worst = 0;
    for (let k = 0; k < g.n; k++) worst = Math.max(worst, Math.abs(flat.traces[8][k] - g.traces[8][k]));
    expect(worst).toBeGreaterThan(0.05);
  });

  test('an isolated interface reads the Zoeppritz coefficient at each angle; A and B picked off the gather', () => {
    const sc = G.gather.small_contrast;
    const model = { vp: [], vs: [], rho: [] };
    for (let k = 0; k < 121; k++) {
      const L = k < 60 ? sc.upper : sc.lower;
      model.vp.push(L[0]); model.vs.push(L[1]); model.rho.push(L[2]);
    }
    const out = gatherFromTimeModel(model, { angles: G.gather.angles, wavelet: rickerWavelet(25, 2, 60) });
    const picks = pickEvent(out.traces, 60, 2);
    G.gather.angles.forEach((th, a) => {
      expect(picks[a]).toBeCloseTo(zoeppritzRpp(...sc.upper, ...sc.lower, th).re, 7);
      expect(picks[a]).toBeCloseTo(sc.picks[a], 7);
    });
    const fit = fitInterceptGradient(G.gather.angles, sc.picks);
    expect(fit.a).toBeCloseTo(sc.a, 12);
    expect(fit.b).toBeCloseTo(sc.b, 12);
    const fit15 = fitInterceptGradient(G.gather.angles, sc.picks, { maxAngle: 15 });
    expect(fit15.a).toBeCloseTo(sc.a15, 12);
    const { a, b } = shuey(...sc.upper, ...sc.lower, 0);
    expect(Math.abs(fit15.a - a)).toBeLessThan(1e-5);
    expect(rel(fit15.b, b)).toBeLessThan(0.05);
    // exact on two-term data
    const two = G.gather.angles.map((th) => a + b * Math.sin((th * Math.PI) / 180) ** 2);
    const exact = fitInterceptGradient(G.gather.angles, two);
    expect(exact.a).toBeCloseTo(a, 12);
    expect(exact.b).toBeCloseTo(b, 12);
    expect(exact.r2).toBeCloseTo(1, 12);
    // negative control: a fit against sin(theta) in place of sin^2(theta) misses B
    const wrongX = G.gather.angles.map((th) => Math.sin((th * Math.PI) / 180));
    const n = wrongX.length; const sx = wrongX.reduce((s, x) => s + x, 0); const sy = two.reduce((s, y) => s + y, 0);
    const sxx = wrongX.reduce((s, x) => s + x * x, 0); const sxy = wrongX.reduce((s, x, i) => s + x * two[i], 0);
    expect(rel((n * sxy - sx * sy) / (n * sxx - sx * sx), b)).toBeGreaterThan(0.2);
    expect(() => fitInterceptGradient([10], [0.1])).toThrow(/two different angles/);
  });

  test('constant phase: the 40 degree wavelet and its gather equal the oracle; 90 is antisymmetric, 180 the negative', () => {
    const g = G.gather;
    const w40 = phaseRotatedRicker(g.freq_hz, g.dt_ms, 40);
    g.wavelet_40deg.forEach((v, i) => expect(Math.abs(w40[i] - v)).toBeLessThan(1e-6));
    const w0 = rickerWavelet(g.freq_hz, g.dt_ms, 60);
    const w90 = phaseRotatedRicker(g.freq_hz, g.dt_ms, 90);
    const w180 = phaseRotatedRicker(g.freq_hz, g.dt_ms, 180);
    for (let i = 0; i < w0.length; i++) {
      expect(Math.abs(w90[i] + w90[w0.length - 1 - i])).toBeLessThan(1e-6);
      expect(Math.abs(w180[i] + w0[i])).toBeLessThan(1e-6);
    }
    expect(phaseRotatedRicker(25, 2, 0)).toEqual(w0);
    const model = { vp: [], vs: [], rho: [] };
    for (let k = 0; k < g.n; k++) {
      const L = k >= g.top && k < g.base ? g.gas : g.shale;
      model.vp.push(L[0]); model.vs.push(L[1]); model.rho.push(L[2]);
    }
    const out = gatherFromTimeModel(model, { angles: [0, 30], wavelet: w40 });
    out.traces.forEach((trace, a) => {
      for (let k = 0; k < g.n; k++) expect(Math.abs(trace[k] - g.rotated_traces[a][k])).toBeLessThan(1e-6);
    });
    // negative control: the zero-phase gather is not the 40 degree one
    const zero = gatherFromTimeModel(model, { angles: [0], wavelet: w0 });
    let worst = 0;
    for (let k = 0; k < g.n; k++) worst = Math.max(worst, Math.abs(zero.traces[0][k] - g.rotated_traces[0][k]));
    expect(worst).toBeGreaterThan(0.02);
  });

  test('depth logs to time and the gather from depth equal the oracle', () => {
    const d = G.depth_gather;
    const logs = { depth: [], vp: [], vs: [], rho: [] };
    for (let z = d.depth_from; z <= d.depth_to + 1e-9; z += d.step) {
      const L = z >= d.gas_top && z < d.gas_base ? G.gather.gas : G.gather.shale;
      logs.depth.push(z); logs.vp.push(L[0]); logs.vs.push(L[1]); logs.rho.push(L[2]);
    }
    const tm = logsToTime(logs, d.dt_ms);
    expect(tm.tMs).toHaveLength(d.nt);
    expect(tm.tMs[d.nt - 1]).toBeCloseTo(d.t_end_ms, 9);
    d.vp_time.forEach((v, k) => expect(tm.vp[k]).toBeCloseTo(v, 6));
    d.depth_time.forEach((v, k) => expect(tm.depth[k]).toBeCloseTo(v, 6));
    const out = angleGather(logs, { angles: d.angles, dtMs: d.dt_ms, freqHz: 25 });
    out.traces.forEach((trace, a) => {
      for (let k = 0; k < d.nt; k++) expect(Math.abs(trace[k] - d.traces[a][k])).toBeLessThan(1e-6);
    });
    // a uniform 3000 m/s column: 150 m is 100 ms two way
    const t = twoWayTimeMs([0, 75, 150], [3000, 3000, 3000]);
    expect(t[2]).toBeCloseTo(100, 12);
    // negative control: one-way time would be half
    expect(t[2] / 2).not.toBeCloseTo(100, 3);
  });

  test('hostile inputs: gaps are dropped and counted, bad angles and wavelets refused, past critical counted', () => {
    const logs = { depth: [0, 1, 2, 3, 4, 5], vp: [3000, NaN, 3000, 3100, 3100, 3100], vs: [1500, 1500, 1500, 1600, 1600, 1600], rho: [2300, 2300, -999, 2350, 2350, 2350] };
    const tm = logsToTime(logs, 0.5);
    expect(tm.dropped).toBe(2);
    expect(tm.used).toBe(4);
    expect(() => logsToTime({ depth: [1], vp: [NaN], vs: [1], rho: [1] }, 2)).toThrow(/Fewer than two usable samples/);
    expect(() => logsToTime(logs, 0)).toThrow(/time sample/);
    const model = { vp: [2000, 4000], vs: [900, 2200], rho: [2200, 2500] };
    expect(() => gatherFromTimeModel(model, { angles: [], wavelet: [1] })).toThrow(/at least one angle/);
    expect(() => gatherFromTimeModel(model, { angles: [95], wavelet: [1] })).toThrow(/Angles/);
    expect(() => gatherFromTimeModel(model, { angles: [10], wavelet: [1, 1] })).toThrow(/odd/);
    expect(() => interfaceReflectivity(2000, 900, 2200, 4000, 2200, 2500, 10, 'bogus')).toThrow(/Unknown/);
    const g = gatherFromTimeModel(model, { angles: [10, 45], wavelet: [1] });
    expect(g.postCritical).toEqual([0, 1]); // critical is 30 degrees
    const ar = gatherFromTimeModel(model, { angles: [45], wavelet: [1], method: 'aki-richards' });
    expect(ar.traces[0][1]).toBe(0); // undefined past critical: no amplitude, and counted
    expect(ar.postCritical).toEqual([1]);
    expect(() => akiRichards(2000, 900, 2200, 4000, 2200, 2500, 45)).toThrow();
  });
});

describe('U2-002 fluid line', () => {
  const T = G.trend;

  test('Castagna, Swan and Foster (1998): B = -A at Vp/Vs = 2; the slope table equals the oracle', () => {
    expect(backgroundSlope(0.5)).toBeCloseTo(-1, 14);
    for (const row of T.slopes) expect(backgroundSlope(row.vs_over_vp, row.g)).toBeCloseTo(row.slope, 13);
    // at Vp/Vs = 2 the slope is -1 whatever the density exponent
    expect(backgroundSlope(0.5, 0)).toBeCloseTo(-1, 14);
    // negative control: away from Vp/Vs = 2 the line is not B = -A, and the Gardner exponent matters
    expect(Math.abs(backgroundSlope(0.6) + 1)).toBeGreaterThan(0.5);
    expect(Math.abs(backgroundSlope(0.6, 0) - backgroundSlope(0.6, 0.25))).toBeGreaterThan(0.05);
    expect(() => backgroundSlope(1.2)).toThrow();
  });

  test('the line fitted to a Gardner, Vp/Vs = 2 background through the engine is B = -A; the gas sand sits off it', () => {
    const vp = T.background_vp;
    const vs = vp.map((v) => v / 2);
    const rho = vp.map((v) => gardnerRho(v));
    const blocks = blockLogs(vp, vs, rho, vp.map((_, i) => i), 1);
    const pts = interfacePoints(blocks);
    expect(pts).toHaveLength(T.points.length);
    pts.forEach((p, i) => { expect(p.a).toBeCloseTo(T.points[i][0], 12); expect(p.b).toBeCloseTo(T.points[i][1], 12); });
    const line = fitFluidLine(pts);
    expect(line.slope).toBeCloseTo(T.fit_slope, 9);
    expect(line.slope).toBeCloseTo(backgroundSlope(0.5), 2);
    expect(line.rmsDistance).toBeLessThan(1e-3);
    expect(distanceFromLine(T.gas.a, T.gas.b, line)).toBeCloseTo(T.gas.distance, 9);
    expect(distanceFromLine(T.gas.a, T.gas.b, line)).toBeLessThan(-0.2);
    // a point on the line has no anomaly
    expect(distanceFromLine(0.05, 0.05 * line.slope, line)).toBeCloseTo(0, 14);
    // negative control: the vertical-offset "distance" (B minus the line) overstates it by sqrt(1 + m^2)
    expect(Math.abs((T.gas.b - line.slope * T.gas.a) - T.gas.distance)).toBeGreaterThan(0.05);
  });

  test('blocking averages whole blocks, skips unusable samples; too few interfaces are refused', () => {
    const vp = [3000, 3000, 3100, 3100, NaN, 3200, 3200];
    const vs = vp.map((v) => v / 2);
    const rho = vp.map(() => 2300);
    const blocks = blockLogs(vp, vs, rho, [0, 1, 2, 3, 4, 5, 6], 2);
    expect(blocks.map((b) => b.vp)).toEqual([3000, 3100, 3200]);
    expect(blocks[2].from).toBe(5);
    expect(() => fitFluidLine([{ a: 0.1, b: -0.1 }])).toThrow(/three interfaces/);
    expect(() => fitFluidLine([{ a: 0, b: 0 }, { a: 0, b: 0 }, { a: 0, b: 0 }])).toThrow(/no trend/);
  });
});

describe('U2-005 iterative Vs and U2-014 fast Greenberg-Castagna', () => {
  test('recovers the true hydrocarbon-sand Vs; the direct regression on the in-situ Vp does not', () => {
    for (const row of G.iterative_vs) {
      const out = iterativeVs({
        vp: row.vp, rho: row.rho, phi: row.phi, kmin: row.kmin, fluidInSitu: row.fluid, fluidBrine: row.brine, vsh: row.vsh,
      });
      expect(out.converged).toBe(true);
      expect(rel(out.vs, row.vs_true)).toBeLessThan(1e-7);
      expect(rel(out.vs, row.vs_iterative)).toBeLessThan(1e-7);
      expect(rel(out.vpBrine, row.vp_brine)).toBeLessThan(1e-7);
      // the fixed point: taken to brine with this Vs, the rock lies on the Greenberg-Castagna line
      const wet = substituteVels(row.vp, out.vs, row.rho, row.kmin, row.phi, row.fluid, row.brine);
      expect(rel(wet.vs, gcSandShaleVs(wet.vp, row.vsh))).toBeLessThan(1e-7);
      // negative control: direct Greenberg-Castagna on the gas Vp is off by more than 10 percent
      const direct = gcSandShaleVs(row.vp, row.vsh);
      expect(direct).toBeCloseTo(row.vs_direct, 6);
      expect(rel(direct, row.vs_true)).toBeGreaterThan(0.1);
    }
  });

  test('with brine in situ the iteration returns the direct estimate; unphysical samples throw the engine reason', () => {
    const row = G.iterative_vs[0];
    const out = iterativeVs({ vp: row.vp_brine, rho: row.rho_brine, phi: row.phi, kmin: row.kmin, fluidInSitu: row.brine, fluidBrine: row.brine });
    expect(rel(out.vs, row.vs_brine)).toBeLessThan(1e-9);
    expect(() => iterativeVs({ vp: -1, rho: 2000, phi: 0.2, kmin: 37e9, fluidInSitu: row.fluid, fluidBrine: row.brine })).toThrow(/positive/);
    expect(() => iterativeVs({ vp: row.vp, rho: row.rho, phi: 0, kmin: row.kmin, fluidInSitu: row.fluid, fluidBrine: row.brine })).toThrow(/Porosity/);
  });

  test('the fast sand/shale path is identical to the reference composite, bit for bit, on 20,000 samples', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const vp = []; const vsh = [];
    for (let i = 0; i < 20000; i++) {
      vp.push(i % 97 === 0 ? NaN : 900 + 5000 * rnd());
      vsh.push(i % 11 === 0 ? 0 : i % 13 === 0 ? 1 : i % 17 === 0 ? NaN : i % 19 === 0 ? 1.4 : rnd());
    }
    const reference = (p, s) => {
      if (!Number.isFinite(p)) return NaN;
      const v = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0;
      if (v === 0) return gcLithVs(p, 'sandstone');
      if (v === 1) return gcLithVs(p, 'shale');
      return greenbergCastagnaVs(p, { sandstone: 1 - v, shale: v });
    };
    const out = shearForWell({ vpCurve: vp, vshCurve: vsh });
    expect(out.source).toBe('estimated');
    let differing = 0;
    for (let i = 0; i < vp.length; i++) if (!Object.is(out.vs[i], reference(vp[i], vsh[i]))) differing += 1;
    expect(differing).toBe(0);
    // no VSH curve: clean sand everywhere
    const clean = shearForWell({ vpCurve: [3000, 4000] });
    expect(clean.vs[1]).toBeCloseTo(2360.76, 6);
    // measured shear still wins
    expect(shearForWell({ vpCurve: [3000], dtsVsCurve: [1500] })).toEqual({ vs: [1500], source: 'measured' });
    // negative control: the mudrock-style single sand line is not the composite
    expect(Math.abs(gcLithVs(3000, 'sandstone') - gcSandShaleVs(3000, 0.5))).toBeGreaterThan(20);
  });
});

describe('U2-001 template lines', () => {
  const T = G.templates;

  test('critical-porosity sand lines equal the oracle; mineral point at zero porosity; Reuss at the critical porosity', () => {
    const phis = T.brine_line.map((p) => p.phi);
    const brine = sandLine(T.mineral, T.brine, phis, T.phic);
    const gas = sandLine(T.mineral, T.gas, phis, T.phic);
    for (const [line, gold] of [[brine, T.brine_line], [gas, T.gas_line]]) {
      expect(line).toHaveLength(gold.length);
      line.forEach((p, i) => {
        for (const key of ['vp', 'vs', 'rho', 'ai', 'vpvs']) expect(rel(p[key], gold[i][key])).toBeLessThan(1e-12);
      });
    }
    const q = T.mineral;
    expect(brine[0].vp).toBeCloseTo(Math.sqrt((q.k + (4 * q.mu) / 3) / q.rho), 9);
    expect(brine[0].vpvs).toBeCloseTo(Math.sqrt(q.k / q.mu + 4 / 3), 12);
    const near = sandPoint(q, T.brine, T.phic * (1 - 1e-9), T.phic);
    expect(rel(near.k, 1 / (T.phic / T.brine.k + (1 - T.phic) / q.k))).toBeLessThan(1e-6);
    // impedance falls with porosity; gas is softer and has the lower Vp/Vs at every porosity
    for (let i = 1; i < brine.length; i++) {
      expect(brine[i].ai).toBeLessThan(brine[i - 1].ai);
      expect(gas[i].ai).toBeLessThan(brine[i].ai);
      expect(gas[i].vpvs).toBeLessThan(brine[i].vpvs);
    }
    expect(CRITICAL_POROSITY_SANDSTONE).toBe(0.4);
    expect(criticalPorosityDry(q.k, q.mu, 0.2, 0.4)).toEqual({ k: q.k * 0.5, mu: q.mu * 0.5 });
    // negative control: another critical porosity is another line
    expect(rel(sandPoint(q, T.brine, 0.2, 0.36).ai, T.brine_line[4].ai)).toBeGreaterThan(0.02);
    expect(() => criticalPorosityDry(q.k, q.mu, 0.4, 0.4)).toThrow(/critical porosity/);
    expect(sandLine(q, T.brine, [0.1, 0.4, 0.5], 0.4)).toHaveLength(1);
    expect(() => sandPoint(q, { k: 0, rho: 1000 }, 0.2)).toThrow(/pore fluid/);
  });

  test('mudrock line with Gardner density equals the oracle', () => {
    const line = mudrockLine(2000, 4000, 4);
    expect(line).toHaveLength(T.mudrock.length);
    line.forEach((p, i) => { for (const key of ['vp', 'vs', 'rho', 'ai', 'vpvs']) expect(rel(p[key], T.mudrock[i][key])).toBeLessThan(1e-12); });
    // below about 1360 m/s the mudrock line has no positive Vs: left out
    expect(mudrockLine(1000, 2000, 2).map((p) => p.vp)).toEqual([1500, 2000]);
    expect(() => mudrockLine(3000, 2000)).toThrow();
  });
});

describe('U2-007 pseudo-sonic', () => {
  test('Gardner (1974): 2.30 g/cc is 10,000 ft/s; the inverse equals the oracle and round-trips', () => {
    expect(gardnerVp(2300) / 0.3048).toBeCloseTo(10000, 6);
    expect(gardnerRho(10000 * 0.3048)).toBeCloseTo(2300, 9);
    for (const row of G.pseudo_sonic.gardner) {
      expect(rel(gardnerVp(row.rho), row.vp)).toBeLessThan(1e-12);
      expect(rel(gardnerRho(gardnerVp(row.rho)), row.rho)).toBeLessThan(1e-12);
    }
    // negative control: the ft/s coefficient applied to m/s (a unit slip) is 20 percent out in density
    expect(rel(1000 * GARDNER_A * 3048 ** 0.25, 2300)).toBeGreaterThan(0.2);
    expect(gardnerVp(-5)).toBeNaN();
    expect(gardnerVp(NaN)).toBeNaN();
  });

  test('Faust (1953): 1948 (Z R)^(1/6) ft/s is 2.2888 (Z R)^(1/6) km/s with Z in km (Hacikoylu et al. 2006)', () => {
    expect(rel(faustVp(1000, 1), 2288.8)).toBeLessThan(1e-4);
    expect(rel(faustVp(2500, 4), 2288.8 * 10 ** (1 / 6))).toBeLessThan(1e-4);
    for (const row of G.pseudo_sonic.faust) expect(rel(faustVp(row.depth_m, row.rt), row.vp)).toBeLessThan(1e-12);
    // negative control: depth left in metres (not feet) is 18 percent slow
    expect(rel(0.3048 * FAUST_GAMMA * (1000 * 1) ** (1 / 6), 2288.8)).toBeGreaterThan(0.15);
    expect(faustVp(0, 5)).toBeNaN();
    expect(faustVp(1000, -999)).toBeNaN();
  });

  test('calibration recovers the constants of logs built with them; the misfit is reported honestly', () => {
    const depth = []; const rt = []; const vp = []; const rho = [];
    for (let i = 0; i < 400; i++) {
      const z = 800 + 5 * i;
      const r = 1 + 3 * Math.abs(Math.sin(i / 9));
      depth.push(z); rt.push(r);
      vp.push(faustVp(z, r, { gamma: 2100 }));
      rho.push(gardnerRho(vp[i], { a: 0.245 }));
    }
    expect(fitFaustGamma(depth, rt, vp).gamma).toBeCloseTo(2100, 6);
    expect(fitGardnerA(rho, vp).a).toBeCloseTo(0.245, 9);
    // the default constants on these logs are biased, and the misfit says by how much
    const def = velocityMisfit(depth.map((z, i) => faustVp(z, rt[i])), vp);
    expect(def.n).toBe(400);
    expect(def.biasPct).toBeCloseTo(100 * (1948 / 2100 - 1), 6);
    expect(def.rmsPct).toBeCloseTo(Math.abs(def.biasPct), 6);
    expect(def.corr).toBeCloseTo(1, 9);
    const cal = velocityMisfit(depth.map((z, i) => faustVp(z, rt[i], { gamma: 2100 })), vp);
    expect(Math.abs(cal.biasPct)).toBeLessThan(1e-9);
    // gaps on either side are skipped
    expect(velocityMisfit([3000, NaN, 3300], [3000, 3100, NaN]).n).toBe(1);
    expect(velocityMisfit([], []).n).toBe(0);
    expect(() => fitGardnerA([2300], [3000])).toThrow(/at least 10/);
    expect(() => fitFaustGamma([1000], [1], [3000])).toThrow(/at least 10/);
  });
});

describe('U2-016 Voigt fluid mix', () => {
  test('equals the oracle, is the stiff bound over Wood and meets it at the end members', () => {
    for (const row of G.voigt) {
      const phases = [{ ...row.brine, sat: row.sw }, { ...row.gas, sat: 1 - row.sw }];
      const v = voigtMix(phases);
      expect(rel(v.k, row.voigt.k)).toBeLessThan(1e-12);
      expect(v.rho).toBeCloseTo(row.voigt.rho, 9);
      const w = woodMix(phases);
      expect(v.k).toBeGreaterThanOrEqual(w.k * (1 - 1e-12));
      expect(v.rho).toBeCloseTo(w.rho, 9);
      if (row.sw === 0 || row.sw === 1) expect(rel(v.k, w.k)).toBeLessThan(1e-12);
      else expect(v.k / w.k).toBeGreaterThan(1.5); // far apart for brine and gas
    }
    // negative control: the harmonic (Wood) average is not the Voigt bound at Sw 0.5
    const mid = G.voigt.find((r) => r.sw === 0.5);
    expect(rel(woodMix([{ ...mid.brine, sat: 0.5 }, { ...mid.gas, sat: 0.5 }]).k, mid.voigt.k)).toBeGreaterThan(0.5);
    expect(() => voigtMix([{ k: 1, rho: 1, sat: 0.4 }])).toThrow(/sum to 1/);
    expect(() => voigtMix([{ k: -1, rho: 1, sat: 1 }])).toThrow(/positive/);
  });
});
