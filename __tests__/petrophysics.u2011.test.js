// PETRO-U2-011 (Petrophysics Studio Step 2, 2026-09-29): the probabilistic
// run in one pass. Each realisation runs the zoned pipeline once per depth
// chunk and the zones are summed from the same outputs (zoneSums), with one
// sort per sample for every quantile; the pipeline fills its arrays by index.
//
// Gate: the one-pass engine reproduces the previous two-loop algorithm,
// rebuilt here from the shipped primitives it used (computeWellZoned per
// realisation, finiteQuantile per quantile, zoneSummary + zoneHydrocarbon per
// zone), on the type well with zones, a zone override and several chunk
// sizes: the per-sample percentile curves and PAY_PROB bit for bit (same
// draws, same order statistics), the zone statistics to 1e-12 (the sums are
// added in a different order). zoneSums is also checked against zoneSummary
// and zoneHydrocarbon directly, for the Archie and a total-porosity model.
//
// Negative controls (run 2026-09-29): with zoneSums skipping the edge
// margin (midpoint thickness from the chunk alone) the zone gross and net
// differ from the reference and the gate fails; with the quantile loop
// reading the chunk without its margin offset every curve shifts by one
// sample and the bitwise gate fails.

import fs from 'fs';
import path from 'path';
import {
  computeWell, computeWellZoned, zoneSummary, zoneHydrocarbon, zoneSums, summaryFromSums, DEFAULT_PARAMS,
} from '../engines/petrophysics/pipeline';
import {
  runProbabilistic, probabilisticPart, finishProbabilistic, drawRealisations, zoneParamsUnderDraw, finiteQuantile, quantileSuffix, QUANTILE_CURVES, OUTCOME_FIELDS, PARAMETER_FIELDS,
} from '../engines/petrophysics/probabilistic';

const DATA_DIR = path.join(__dirname, '..', 'test-data', 'petrophysics');
const typewell = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'typewell.json'), 'utf8'));
const curve = (name) => Float64Array.from(typewell.curves[name], (v) => (v === null ? NaN : v));
const regular = { DEPT: curve('DEPT'), GR: curve('GR'), RHOB: curve('RHOB'), NPHI: curve('NPHI'), DT: curve('DT'), RT: curve('RT') };
const curves = regular;
// an irregular depth vector (core-merged or depth-shifted wells): each edge
// sample's midpoint thickness then depends on its neighbour across a chunk edge
const irregular = { ...regular, DEPT: Float64Array.from(regular.DEPT, (d, i) => d + 0.12 * Math.sin(i * 1.7)) };
const params = { ...DEFAULT_PARAMS, phiShale: typewell.params.phi_shale };
const zones = Object.entries(typewell.params.zones).map(([name, [top, base]]) => ({ id: name, name, top_md_m: top, base_md_m: base }));
const zoneParamList = [{ top: zones[1].top_md_m, base: zones[1].base_md_m, params: { cutPhi: 0.1, swMethod: 'dual-water' } }];
const spec = {
  rw: { type: 'triangular', min: 0.04, mode: 0.05, max: 0.065 },
  m: { type: 'normal', mean: 2, stdDev: 0.1, min: 1.6, max: 2.4 },
  cutSw: { type: 'uniform', min: 0.5, max: 0.7 },
  grClay: { type: 'triangular', min: 110, mode: 120, max: 135 },
};

/** The previous algorithm, from the primitives it called. */
function reference(n, seed, curves = regular) {
  const { patches } = drawRealisations(spec, n, seed);
  const base = { ...DEFAULT_PARAMS, ...params };
  // PETRO-M-002: each zone's overrides under the draw
  const zl = (pt) => zoneParamList.map((z) => ({ ...z, params: zoneParamsUnderDraw(z.params, base, pt) }));
  const outs = patches.map((pt) => computeWellZoned(curves, { ...base, ...pt }, zl(pt)).outputs);
  const N = curves.DEPT.length;
  const res = { curves: {}, zones: {} };
  for (const key of QUANTILE_CURVES) {
    if (!outs.some((o) => o[key])) continue;
    for (const q of [0.1, 0.5, 0.9]) {
      const arr = new Float64Array(N);
      for (let j = 0; j < N; j++) arr[j] = finiteQuantile(outs.map((o) => (o[key] ? o[key][j] : NaN)), q);
      res.curves[`${key}_${quantileSuffix(q)}`] = arr;
    }
  }
  for (const z of zones) {
    const series = {};
    for (const f of [...OUTCOME_FIELDS, ...PARAMETER_FIELDS]) series[f] = [];
    patches.forEach((pt, r) => {
      // PETRO-M-001: the zone sums use the zone's merged set
      const entry = zl(pt).find((e) => e.top <= z.top_md_m && e.base >= z.base_md_m);
      const pr = { ...base, ...pt, ...(entry ? entry.params : {}) };
      const s = zoneSummary(curves, outs[r], pr, z);
      const h = zoneHydrocarbon(curves, outs[r], pr, z);
      const row = { ...s, sw_avg: h.sw_avg, hcpv_m: h.hcpv_m };
      for (const f of Object.keys(series)) series[f].push(row[f] == null ? NaN : row[f]);
    });
    res.zones[z.id] = series;
  }
  return res;
}

const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));

test.each([[37, 1000, 'regular'], [37, 23, 'irregular'], [60, 7, 'irregular']])('one pass equals the two-loop algorithm (n %i, chunk %i, %s depths)', (n, chunk, grid) => {
  const seed = 5;
  const c = grid === 'irregular' ? irregular : regular;
  const ref = reference(n, seed, c);
  const got = runProbabilistic(c, params, zoneParamList, spec, { n, seed, zones, chunk });
  for (const [key, arr] of Object.entries(ref.curves)) {
    const g = got.curves[key];
    for (let j = 0; j < arr.length; j++) {
      if (Number.isNaN(arr[j])) expect(Number.isNaN(g[j])).toBe(true);
      else if (g[j] !== arr[j]) throw new Error(`${key}[${j}] ${g[j]} !== ${arr[j]}`);
    }
  }
  for (const z of got.zones) {
    const series = ref.zones[z.id];
    for (const f of OUTCOME_FIELDS) {
      expect(rel(z.outcomes[f].p50, finiteQuantile(series[f], 0.5))).toBeLessThan(1e-12);
      expect(rel(z.outcomes[f].p90, finiteQuantile(series[f], 0.1))).toBeLessThan(1e-12);
    }
    for (const f of PARAMETER_FIELDS) {
      const want = finiteQuantile(series[f], 0.5);
      if (Number.isNaN(want)) expect(Number.isNaN(z.parameters[f].q50)).toBe(true);
      else expect(rel(z.parameters[f].q50, want)).toBeLessThan(1e-12);
    }
  }
});

test.each(['archie', 'waxman-smits'])('zoneSums reproduces zoneSummary and zoneHydrocarbon (%s)', (swMethod) => {
  const p = { ...params, swMethod };
  const { outputs } = computeWell(curves, p);
  for (const z of zones) {
    const s = zoneSummary(curves, outputs, p, z);
    const h = zoneHydrocarbon(curves, outputs, p, z);
    const got = summaryFromSums(zoneSums(curves, outputs, p, z));
    for (const f of ['gross_m', 'net_m', 'ntg', 'phi_avg', 'vsh_avg', 'k_gm_md']) expect(rel(got[f], s[f])).toBeLessThan(1e-12);
    expect(rel(got.sw_avg_h, s.sw_avg)).toBeLessThan(1e-12);
    expect(rel(got.sw_avg, h.sw_avg)).toBeLessThan(1e-12);
    expect(rel(got.hcpv_m, h.hcpv_m)).toBeLessThan(1e-12);
  }
});

test('a run split into depth ranges (the parallel workers) joins to the whole run', () => {
  const n = 25; const seed = 9;
  const whole = runProbabilistic(curves, params, zoneParamList, spec, { n, seed, zones });
  const { patches, varKeys } = drawRealisations(spec, n, seed);
  const N = curves.DEPT.length;
  const cuts = [[120, N - 1], [0, 57], [58, 119]]; // out of order on purpose
  const parts = cuts.map((range) => probabilisticPart(curves, params, zoneParamList, patches, { zones, range, chunk: 31 }));
  const joined = finishProbabilistic({ N, parts, patches, varKeys, zones, seed, spec });
  for (const [key, arr] of Object.entries(whole.curves)) {
    for (let j = 0; j < N; j++) {
      if (Number.isNaN(arr[j])) expect(Number.isNaN(joined.curves[key][j])).toBe(true);
      else if (joined.curves[key][j] !== arr[j]) throw new Error(`${key}[${j}]`);
    }
  }
  whole.zones.forEach((z, i) => {
    for (const f of OUTCOME_FIELDS) expect(rel(joined.zones[i].outcomes[f].p50, z.outcomes[f].p50)).toBeLessThan(1e-12);
    for (const f of PARAMETER_FIELDS) {
      if (Number.isNaN(z.parameters[f].q50)) expect(Number.isNaN(joined.zones[i].parameters[f].q50)).toBe(true);
      else expect(rel(joined.zones[i].parameters[f].q50, z.parameters[f].q50)).toBeLessThan(1e-12);
    }
    expect(joined.zones[i].sensitivity.rank.length).toBe(z.sensitivity.rank.length);
  });
});
