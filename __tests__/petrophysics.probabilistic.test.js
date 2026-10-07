// PT10c: the probabilistic petrophysics engine, validation-first. The
// engine re-derives nothing: realisations are computeWellZoned + zoneSummary
// verbatim and every sampling / quantile / sensitivity primitive is the
// canonical lib/stats one. These gates pin (1) the monotone-transform
// identity (Sw under uncertain Rw equals Archie at the Rw quantile, exact
// with 201 draws), (2) the degenerate spec reproducing the deterministic
// run byte for byte, (3) seed determinism, (4) the type-well bracket of the
// SAND A golden net, (5) chunking invariance, (6) finiteness, and (7) the
// oracle's exact lognormal-Rw quantiles at N = 20000 within 1 percent.

import fs from 'fs';
import path from 'path';
import { computeWell, computeWellZoned, zoneSummary, DEFAULT_PARAMS } from '../engines/petrophysics/pipeline';
import { swArchie } from '../engines/petrophysics/sw';
import { quantile } from '../lib/stats/stats';
import {
  runProbabilistic, drawRealisations, zoneParamsUnderDraw, distFromPercentiles, varyingKeys, finiteQuantile, quantileSuffix,
  UNCERTAIN_PARAMS, QUANTILE_CURVES, OUTCOME_FIELDS, PARAMETER_FIELDS, EXCEEDANCE_DEFINITION,
} from '../engines/petrophysics/probabilistic';

const DATA_DIR = path.join(__dirname, '..', 'test-data', 'petrophysics');
const typewell = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'typewell.json'), 'utf8'));
const goldens = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'goldens.json'), 'utf8'));
const E = goldens.EFFECTIVE;
const PB = goldens.PROBABILISTIC;

const curve = (name) => Float64Array.from(typewell.curves[name], (v) => (v === null ? NaN : v));
const curves = { DEPT: curve('DEPT'), GR: curve('GR'), RHOB: curve('RHOB'), NPHI: curve('NPHI'), DT: curve('DT'), RT: curve('RT') };
const params = { ...DEFAULT_PARAMS, phiShale: typewell.params.phi_shale, bucklesConst: E.params.bucklesConst };
const zones = Object.entries(typewell.params.zones).map(([name, [top, base]]) => ({ id: name, name, top_md_m: top, base_md_m: base }));

const sameCurve = (a, b, tol = 0) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(b[i])) { if (!Number.isNaN(a[i])) throw new Error(`[${i}] expected NaN, got ${a[i]}`); continue; }
    const d = Math.abs(a[i] - b[i]);
    if (d > tol * Math.max(1, Math.abs(b[i]))) throw new Error(`[${i}] ${a[i]} vs ${b[i]} (diff ${d})`);
  }
};

test('names and vocabulary: no P-label on a percentile curve, outcomes vs parameters, the definition sentence', () => {
  expect(quantileSuffix(0.1)).toBe('Q10');
  expect(quantileSuffix(0.9)).toBe('Q90');
  expect(UNCERTAIN_PARAMS).toContain('rw');
  expect(UNCERTAIN_PARAMS).not.toContain('swMethod');
  expect(QUANTILE_CURVES).toEqual(['PHIE', 'PHIT', 'VSH', 'SW', 'BVW', 'KPERM']);
  expect(OUTCOME_FIELDS).toEqual(['net_m', 'ntg', 'hcpv_m']);
  expect(PARAMETER_FIELDS).toEqual(['phi_avg', 'sw_avg', 'vsh_avg', 'k_gm_md']);
  expect(EXCEEDANCE_DEFINITION).toBe('P90 means a 90% probability the actual quantity meets or exceeds this value, per SPE PRMS.');
});

test('quantile definition pinned (lib/stats): order statistic at non-integer n*p, midpoint at integer n*p', () => {
  expect(quantile([3, 1, 2, 4], 0.5)).toBe(2.5);          // n*p = 2 integer, even n -> mean of x[1], x[2]
  expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);         // n*p = 2.5 -> x[ceil(2.5) - 1] = x[2]
  expect(quantile([5, 4, 3, 2, 1], 0.1)).toBe(1);         // n*p = 0.5 -> x[0]
  expect(finiteQuantile([NaN, 2, 1, NaN, 3], 0.5)).toBe(2);
  expect(Number.isNaN(finiteQuantile([NaN, NaN], 0.5))).toBe(true);
  // triangular from three percentiles is the lib/stats fit, not min/mode/max
  const d = distFromPercentiles(0.04, 0.05, 0.06);
  expect(d.type).toBe('triangular');
  expect(d.min).toBeLessThan(0.04);
  expect(d.max).toBeGreaterThan(0.06);
  expect(varyingKeys({ rw: d, m: { type: 'constant', value: 2 }, cutSw: { type: 'uniform', min: 0.6, max: 0.6 } })).toEqual(['rw']);
});

test('gate 1: with only Rw uncertain under Archie, Sw quantiles equal Archie at the Rw draw quantiles, to 1e-12 (201 draws)', () => {
  const spec = { rw: { type: 'lognormal', mean: 0.05, stdDev: 0.015 } };
  const n = 201;
  const seed = 11;
  const res = runProbabilistic(curves, params, [], spec, { n, seed, zones });
  const { patches } = drawRealisations(spec, n, seed);
  expect(res.draws.patches).toEqual(patches);
  const rws = patches.map((p) => p.rw);
  const phie = computeWell(curves, params).outputs.PHIE;
  for (const q of [0.1, 0.5, 0.9]) {
    const rwq = quantile(rws, q);
    const want = Float64Array.from(curves.RT, (rt, i) => swArchie(rt, phie[i], rwq, params.a, params.m, params.n));
    sameCurve(res.curves[`SW_${quantileSuffix(q)}`], want, 1e-12);
  }
  // and KPERM against bucklesConst (k is monotone in Swirr, Swirr in the Buckles constant)
  const spec2 = { bucklesConst: { type: 'uniform', min: 0.03, max: 0.05 } };
  const r2 = runProbabilistic(curves, params, [], spec2, { n, seed: 3 });
  const bcs = drawRealisations(spec2, n, 3).patches.map((p) => p.bucklesConst);
  for (const q of [0.1, 0.5, 0.9]) {
    // k = 8581 phi^4.4 / swirr^2 with swirr = bc / phi: k DEcreases with bc, so the
    // q-quantile of k is k at the (1 - q)-quantile of bc
    const bcq = quantile(bcs, 1 - q);
    const want = computeWell(curves, { ...params, bucklesConst: bcq }).outputs.KPERM;
    sameCurve(r2.curves[`KPERM_${quantileSuffix(q)}`], want, 1e-12);
  }
});

test('gate 2: a degenerate spec reproduces computeWellZoned byte for byte, PAY_PROB is the PAY flag, zone summaries match', () => {
  const zoneList = [{ top: 2050, base: 2080, params: { cutSw: 0.7 } }];
  const det = computeWellZoned(curves, params, zoneList).outputs;
  const res = runProbabilistic(curves, params, zoneList, {}, { n: 50, zones });
  expect(res.draws.varKeys).toEqual([]);
  for (const key of QUANTILE_CURVES) {
    for (const q of [0.1, 0.5, 0.9]) sameCurve(res.curves[`${key}_${quantileSuffix(q)}`], det[key], 0);
  }
  sameCurve(res.curves.PAY_PROB, det.PAY, 0);
  for (const z of res.zones) {
    // the zone summary uses the zone's merged set, as the deterministic card does (PETRO-M-001)
    const merged = z.name === 'SAND_B' ? { ...params, cutSw: 0.7 } : params;
    const s = zoneSummary(curves, det, merged, zones.find((x) => x.name === z.name));
    expect(z.outcomes.net_m).toEqual({ p90: s.net_m, p50: s.net_m, p10: s.net_m, mean: s.net_m });
    expect(z.parameters.phi_avg.q50).toBe(s.phi_avg);
    expect(z.parameters.k_gm_md.q10).toBe(s.k_gm_md);
    expect(z.sensitivity.rank).toEqual([]);
  }
  expect(res.zones.find((z) => z.name === 'SAND_A').outcomes.net_m.p50).toBe(E.ZONES.SAND_A.summary.net_m);
});

test('gate 2b (PETRO-M-001): a zone cutoff override reaches the zone outcomes; negative control: base cutoffs give the old, different net', () => {
  const zoneList = [{ top: 2050, base: 2080, params: { cutSw: 0.7 } }];
  const det = computeWellZoned(curves, params, zoneList).outputs;
  const sandB = zones.find((x) => x.name === 'SAND_B');
  const withOverride = zoneSummary(curves, det, { ...params, cutSw: 0.7 }, sandB).net_m;
  const baseOnly = zoneSummary(curves, det, params, sandB).net_m;
  expect(withOverride).not.toBe(baseOnly); // the case the bug hid
  const res = runProbabilistic(curves, params, zoneList, { rw: distFromPercentiles(0.045, 0.05, 0.055) }, { n: 101, zones });
  const b = res.zones.find((z) => z.name === 'SAND_B');
  expect(b.outcomes.net_m.p10).toBeGreaterThan(baseOnly);
  const degenerate = runProbabilistic(curves, params, zoneList, {}, { n: 5, zones }).zones.find((z) => z.name === 'SAND_B');
  expect(degenerate.outcomes.net_m.p50).toBe(withOverride);
});

test('gate 2c (PETRO-M-002): a varied parameter a zone overrides still varies there, around the zone value; control: a draw fixed at the base value leaves the zone at its own value', () => {
  const zoneList = [{ top: 2050, base: 2080, params: { rw: 0.04 } }];
  const spec = { rw: distFromPercentiles(0.04, 0.05, 0.06) };
  const res = runProbabilistic(curves, params, zoneList, spec, { n: 201, zones, seed: 3 });
  // Sw at a SAND B sample: Archie at the zone rw scaled by draw / base rw, so its Q10..Q90 spread is real
  const det = computeWellZoned(curves, params, zoneList).outputs;
  const i = Array.from(curves.DEPT).findIndex((d) => d >= 2060);
  expect(res.curves.SW_Q90[i]).toBeGreaterThan(res.curves.SW_Q10[i] * 1.05);
  // the median draw sits at the base rw, so the Q50 curve is the deterministic zone value (exact, monotone)
  const base = { ...DEFAULT_PARAMS, ...params };
  const medianRatio = finiteQuantile(Float64Array.from(res.draws.patches, (p) => p.rw), 0.5) / base.rw;
  const zoneAtMedian = computeWellZoned(curves, params, [{ ...zoneList[0], params: { rw: 0.04 * medianRatio } }]).outputs;
  expect(Math.abs(res.curves.SW_Q50[i] - zoneAtMedian.SW[i])).toBeLessThan(1e-12);
  expect(Math.abs(zoneAtMedian.SW[i] - det.SW[i])).toBeLessThan(0.05);
  // control: every draw at the base rw gives the zone exactly its own override (no spread, the deterministic curve)
  const fixed = runProbabilistic(curves, params, zoneList, { rw: { type: 'uniform', min: base.rw, max: base.rw } }, { n: 11, zones });
  expect(fixed.curves.SW_Q10[i]).toBe(det.SW[i]);
  expect(fixed.curves.SW_Q90[i]).toBe(det.SW[i]);
  // SAND A (no override) still follows the well draw directly
  const j = Array.from(curves.DEPT).findIndex((d) => d >= 2020);
  expect(res.curves.SW_Q90[j]).toBeGreaterThan(res.curves.SW_Q10[j]);
});

test('zoneParamsUnderDraw: ratios for scale parameters, offsets for the rest, fractions held to 0..1', () => {
  const base = { ...DEFAULT_PARAMS, rw: 0.05, cutSw: 0.6, m: 2 };
  expect(zoneParamsUnderDraw({ rw: 0.03 }, base, { rw: 0.06 }).rw).toBeCloseTo(0.036, 12);
  expect(zoneParamsUnderDraw({ cutSw: 0.7 }, base, { cutSw: 0.5 }).cutSw).toBeCloseTo(0.6, 12);
  expect(zoneParamsUnderDraw({ cutSw: 0.95 }, base, { cutSw: 0.8 }).cutSw).toBe(1);
  expect(zoneParamsUnderDraw({ m: 1.8 }, base, { m: 2.2 }).m).toBeCloseTo(2.0, 12);
  expect(zoneParamsUnderDraw({ m: 1.8 }, base, { rw: 0.07 })).toEqual({ m: 1.8 }); // only overridden keys move
});

test('gate 3: one seed is reproducible; another seed differs in draws but agrees within the sampling band', () => {
  const spec = { rw: distFromPercentiles(0.04, 0.05, 0.06), cutSw: { type: 'uniform', min: 0.55, max: 0.65 } };
  const a = runProbabilistic(curves, params, [], spec, { n: 200, seed: 5, zones });
  const b = runProbabilistic(curves, params, [], spec, { n: 200, seed: 5, zones });
  expect(b.draws.patches).toEqual(a.draws.patches);
  sameCurve(b.curves.SW_Q50, a.curves.SW_Q50, 0);
  expect(b.zones[0].outcomes).toEqual(a.zones[0].outcomes);
  const c = runProbabilistic(curves, params, [], spec, { n: 200, seed: 6, zones });
  expect(c.draws.patches).not.toEqual(a.draws.patches);
  sameCurve(c.curves.SW_Q50, a.curves.SW_Q50, 0.03);
  expect(Math.abs(c.zones[0].outcomes.net_m.p50 - a.zones[0].outcomes.net_m.p50)).toBeLessThanOrEqual(1.0);
});

test('gate 4: a symmetric spread about the golden set brackets the SAND A golden net; P90 <= P50 <= P10 on every outcome', () => {
  const spec = {
    rw: distFromPercentiles(0.04, 0.05, 0.06),
    m: distFromPercentiles(1.9, 2.0, 2.1),
    phiShale: distFromPercentiles(0.04, params.phiShale, 0.08),
    cutSw: distFromPercentiles(0.55, 0.6, 0.65),
  };
  const res = runProbabilistic(curves, params, [], spec, { n: 300, seed: 1, zones });
  const a = res.zones.find((z) => z.name === 'SAND_A');
  const golden = E.ZONES.SAND_A.summary.net_m;
  expect(a.outcomes.net_m.p90).toBeLessThanOrEqual(golden);
  expect(a.outcomes.net_m.p10).toBeGreaterThanOrEqual(golden);
  expect(Math.abs(a.outcomes.net_m.p50 - golden)).toBeLessThanOrEqual(1.0);
  for (const z of res.zones) {
    for (const f of OUTCOME_FIELDS) {
      expect(z.outcomes[f].p90).toBeLessThanOrEqual(z.outcomes[f].p50);
      expect(z.outcomes[f].p50).toBeLessThanOrEqual(z.outcomes[f].p10);
    }
    for (const f of PARAMETER_FIELDS) {
      if (Number.isFinite(z.parameters[f].q10)) {
        expect(z.parameters[f].q10).toBeLessThanOrEqual(z.parameters[f].q50);
        expect(z.parameters[f].q50).toBeLessThanOrEqual(z.parameters[f].q90);
      }
    }
    // sensitivity: rank list covers the varying keys, rw dominates SAND A's net
    expect(z.sensitivity.rank.map((s) => s.parameter).sort()).toEqual(res.draws.varKeys.slice().sort());
    expect(z.sensitivity.tornado.length).toBeGreaterThan(0);
  }
  expect(a.sensitivity.rank[0].parameter).toBe('rw');
});

// Zone results are sums over depth; since the one-pass engine (Suite
// PETRO-U2-011) accumulates them per chunk, the chunk size changes the
// summation order and so the last binary digit. Curves stay bit for bit;
// every zone number agrees to 1e-12 relative, and every non-numeric field
// is identical.
const sameZones = (got, want, tol) => {
  if (typeof want === 'number') {
    if (Number.isNaN(want)) { expect(Number.isNaN(got)).toBe(true); return; }
    expect(typeof got).toBe('number');
    const d = Math.abs(got - want);
    if (d > tol * Math.max(1, Math.abs(want))) throw new Error(`${got} vs ${want} (diff ${d})`);
    return;
  }
  if (want === null || typeof want !== 'object') { expect(got).toEqual(want); return; }
  expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
  for (const k of Object.keys(want)) sameZones(got[k], want[k], tol);
};

test('gate 5: chunk sizes 50 and 5000 give identical percentile curves and zone results to 1e-12', () => {
  const spec = { rw: { type: 'normal', mean: 0.05, stdDev: 0.005 }, grClay: { type: 'uniform', min: 110, max: 130 } };
  const a = runProbabilistic(curves, params, [], spec, { n: 60, seed: 2, zones, chunk: 50 });
  const b = runProbabilistic(curves, params, [], spec, { n: 60, seed: 2, zones, chunk: 5000 });
  for (const key of Object.keys(a.curves)) sameCurve(b.curves[key], a.curves[key], 0);
  sameZones(b.zones, a.zones, 1e-12);
  // negative control: a real change in one zone number is caught
  const bent = JSON.parse(JSON.stringify(a.zones));
  bent[0].outcomes.hcpv_m.p50 *= 1 + 1e-9;
  expect(() => sameZones(bent, a.zones, 1e-12)).toThrow();
  // progress reports every chunk
  const seen = [];
  runProbabilistic(curves, params, [], spec, { n: 5, chunk: 100, onProgress: (p) => seen.push(p) });
  expect(seen.filter((p) => p.phase === 'curves').map((p) => p.done)).toEqual([100, 200, 201]);
});

test('gate 6: every curve is finite where the deterministic output is finite and NaN where it is not', () => {
  const spec = { rw: distFromPercentiles(0.04, 0.05, 0.06), rhoMa: distFromPercentiles(2.64, 2.65, 2.66) };
  const det = computeWell(curves, params).outputs;
  const res = runProbabilistic(curves, params, [], spec, { n: 100 });
  for (const key of QUANTILE_CURVES) {
    for (const q of [0.1, 0.5, 0.9]) {
      const got = res.curves[`${key}_${quantileSuffix(q)}`];
      for (let i = 0; i < det[key].length; i++) expect(Number.isFinite(got[i])).toBe(Number.isFinite(det[key][i]));
    }
  }
  for (let i = 0; i < det.PAY.length; i++) expect(Number.isFinite(res.curves.PAY_PROB[i])).toBe(Number.isFinite(det.PAY[i]));
});

test('gate 7 (oracle): lognormal Rw at N = 20000 lands on the exact quantile curves within 1 percent and the zone net cases', () => {
  const res = runProbabilistic(curves, params, [], { rw: PB.rw }, { n: 20000, seed: 7, zones });
  for (const [key, want] of [['SW_Q10', PB.SW_Q10], ['SW_Q50', PB.SW_Q50], ['SW_Q90', PB.SW_Q90]]) {
    const w = Float64Array.from(want, (v) => (v === null ? NaN : v));
    sameCurve(res.curves[key], w, 0.01);
  }
  // exceedance cases of net pay: within one sample thickness of the exact step
  for (const name of Object.keys(PB.ZONES)) {
    const z = res.zones.find((x) => x.name === name);
    for (const k of ['p90', 'p50', 'p10']) expect(Math.abs(z.outcomes.net_m[k] - PB.ZONES[name].net_m[k])).toBeLessThanOrEqual(0.5);
  }
});
