// Jest gate for engines/economics/montecarlo.ts (the Suite epe-mc.ts,
// extracted VERBATIM in the EC0 Economics wave, 2026-09-08; one import
// repointed to ./cashflow.ts).
//
// Four layers:
//   1. ANTI-DRIFT GATE, ported from the Suite's epe-mc.test.ts: montecarlo.ts
//      vendors its own sampling primitives (edge functions could not import
//      the canonical module). In this package the canonical Monte Carlo module
//      is lib/stats/stats.js, so every primitive here (mulberry32 itself,
//      randomNormal, erf, normalCDF, triInvCDF, cholesky, marginalValue,
//      createCorrelatedSampler, basicStats, tornadoSwings) must produce
//      BIT-IDENTICAL output to lib/stats/stats.js on shared seeds. If either
//      side changes, this fails until both agree again.
//   2. PORTED SUITE TESTS: the 13 runEpeMonteCarlo tests of epe-mc.test.ts and
//      the 7 Monte Carlo checks of tools/validation/epe-validation.ts case 7.
//   3. GOLDEN AGREEMENT with test-data/economics/goldens/montecarlo_cases.json
//      from the INDEPENDENT stdlib oracle
//      tools/validation/economics/oracle_montecarlo.py, which replicates
//      mulberry32 bit for bit in uint32 arithmetic and runs every iteration
//      through the independent cash flow oracle: the uniform stream exactly,
//      the transformed draws to 1e-12 relative (libm vs V8 last-ulp), every
//      reported summary (percentiles, P(NPV > 0), standard error, convergence,
//      fan bands, tornado, undefined-run shares) and the exported sample.
//   4. The degenerate and seeded-reproducibility contracts.

import fs from 'fs';
import path from 'path';
import * as canon from '../lib/stats/stats.js';
import {
  mulberry32, cholesky, randomNormal, erf, normalCDF, triInvCDF,
  marginalValue, createCorrelatedSampler, basicStats, tornadoSwings,
  runEpeMonteCarlo,
} from '../engines/economics/montecarlo.ts';
import { computeCashFlow } from '../engines/economics/cashflow.ts';

const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(__dirname, rel), 'utf8'));
const FIXTURE = read('../test-data/economics/fixtures/pia-worked-example.json');
const GOLDEN = read('../test-data/economics/goldens/montecarlo_cases.json');

const PIA_WORKED_EXAMPLE_CFG = FIXTURE.cfg;
const PIA_WORKED_EXAMPLE_PROD = FIXTURE.prodRows;
const PIA_WORKED_EXAMPLE_CAPEX = FIXTURE.capexRows;
const PIA_WORKED_EXAMPLE_OPEX = FIXTURE.opexRows;
const PIA_WORKED_EXAMPLE_EXPECTED = FIXTURE.expected;

// ===========================================================================
// 1. Anti-drift: montecarlo.ts primitives vs the canonical lib/stats/stats.js
// ===========================================================================

describe('anti-drift: montecarlo.ts primitives vs canonical lib/stats/stats.js', () => {
  it('mulberry32 streams are bit-identical for shared seeds', () => {
    for (const seed of [0, 1, 7, 42, 123, 2 ** 31 - 1, 4294967295, -5, 3.7]) {
      const a = mulberry32(seed);
      const b = canon.mulberry32(seed);
      for (let i = 0; i < 1000; i++) expect(a()).toBe(b());
    }
  });

  it('erf / normalCDF / triInvCDF are bit-identical', () => {
    for (const x of [-3, -1.5, -0.2, 0, 0.7, 1.9, 3.4]) {
      expect(erf(x)).toBe(canon.erf(x));
      expect(normalCDF(x)).toBe(canon.normalCDF(x));
    }
    for (const u of [0.01, 0.3, 0.5, 0.77, 0.99]) {
      expect(triInvCDF(u, 10, 25, 60)).toBe(canon.triInvCDF(u, 10, 25, 60));
    }
  });

  it('cholesky is bit-identical', () => {
    const C = [[1, 0.6, 0.2], [0.6, 1, -0.3], [0.2, -0.3, 1]];
    expect(cholesky(C)).toEqual(canon.cholesky(C));
  });

  it('randomNormal is bit-identical on the same RNG stream', () => {
    const a = mulberry32(42);
    const b = canon.mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(randomNormal(a)).toBe(canon.randomNormal(b));
    }
  });

  it('marginalValue is bit-identical for all four spread types', () => {
    const dists = [
      { type: 'normal', mean: 100, stdDev: 15 },
      { type: 'lognormal', mean: 50, stdDev: 20 },
      { type: 'triangular', min: 10, mode: 25, max: 60 },
      { type: 'uniform', min: 5, max: 9 },
    ];
    for (const d of dists) {
      for (const x of [-2.5, -1, 0, 0.5, 2.2]) {
        expect(marginalValue(d, x)).toBe(canon.marginalValue(d, x));
      }
    }
  });

  it('createCorrelatedSampler draws identical realizations on the same stream', () => {
    const spec = {
      inputs: {
        oil_price: { type: 'lognormal', mean: 80, stdDev: 15 },
        capex_scale: { type: 'triangular', min: 0.8, mode: 1.0, max: 1.4 },
        opex_scale: { type: 'normal', mean: 1.0, stdDev: 0.1 },
      },
      paramOrder: ['oil_price', 'capex_scale', 'opex_scale'],
      correlations: [{ a: 'oil_price', b: 'opex_scale', rho: 0.5 }],
    };
    const ours = createCorrelatedSampler({ ...spec, rng: mulberry32(7) });
    const theirs = canon.createCorrelatedSampler({ ...spec, rng: canon.mulberry32(7) });
    expect(ours.varKeys).toEqual(theirs.varKeys);
    for (let i = 0; i < 200; i++) {
      expect(ours.sample()).toEqual(theirs.sample());
    }
  });

  it('basicStats percentiles and CDF are identical (mean/stdDev to 1e-9)', () => {
    const rng = mulberry32(123);
    const data = Array.from({ length: 1000 }, () => rng() * 100);
    const ours = basicStats(data);
    const theirs = canon.basicStats(data);
    expect(ours.p90).toBe(theirs.p90);
    expect(ours.p50).toBe(theirs.p50);
    expect(ours.p10).toBe(theirs.p10);
    expect(ours.cdf).toEqual(theirs.cdf);
    expect(ours.mean).toBeCloseTo(theirs.mean, 9);
    expect(ours.stdDev).toBeCloseTo(theirs.stdDev, 9);
  });

  it('tornadoSwings agrees with the canonical implementation', () => {
    const rng = mulberry32(99);
    const samples = Array.from({ length: 500 }, () => {
      const a = rng();
      const b = rng();
      return { targetVol: 3 * a + 0.5 * b, inputs: { a, b } };
    });
    expect(tornadoSwings(samples)).toEqual(canon.tornadoSwings(samples));
  });
});

// ===========================================================================
// 2a. Ported Suite runEpeMonteCarlo tests (13)
// ===========================================================================

describe('runEpeMonteCarlo', () => {
  const baseArgs = {
    cfg: PIA_WORKED_EXAMPLE_CFG,
    prodRows: PIA_WORKED_EXAMPLE_PROD,
    capexRows: PIA_WORKED_EXAMPLE_CAPEX,
    opexRows: PIA_WORKED_EXAMPLE_OPEX,
  };

  it('with no uncertain variables, every iteration equals the deterministic run', () => {
    const res = runEpeMonteCarlo({ ...baseArgs, mcConfig: { iterations: 100, seed: 1, variables: {} } });
    const det = computeCashFlow(baseArgs);
    expect(res.npv.p90).toBeCloseTo(det.kpis.npv, 6);
    expect(res.npv.p10).toBeCloseTo(det.kpis.npv, 6);
    expect(res.npv.stdDev).toBeCloseTo(0, 6);
    expect(res.probNpvPositive).toBe(1);
    expect(res.base.npv).toBeCloseTo(det.kpis.npv, 6);
  });

  it('is reproducible for the same seed and differs for another', () => {
    const mcConfig = {
      iterations: 200, seed: 42,
      variables: { oil_price: { type: 'triangular', min: 60, mode: 80, max: 110 } },
    };
    const a = runEpeMonteCarlo({ ...baseArgs, mcConfig });
    const b = runEpeMonteCarlo({ ...baseArgs, mcConfig });
    const c = runEpeMonteCarlo({ ...baseArgs, mcConfig: { ...mcConfig, seed: 43 } });
    expect(a.npv.p50).toBe(b.npv.p50);
    expect(a.npv.mean).toBe(b.npv.mean);
    expect(a.npv.mean).not.toBe(c.npv.mean);
  });

  it('produces ordered percentiles, a sensible P(NPV>0), and fan bands', () => {
    const res = runEpeMonteCarlo({
      ...baseArgs,
      mcConfig: {
        iterations: 500, seed: 7,
        variables: {
          oil_price: { type: 'triangular', min: 40, mode: 80, max: 120 },
          capex_scale: { type: 'triangular', min: 0.8, mode: 1.0, max: 1.5 },
        },
      },
    });
    expect(res.npv.p90).toBeLessThan(res.npv.p50);
    expect(res.npv.p50).toBeLessThan(res.npv.p10);
    expect(res.probNpvPositive).toBeGreaterThan(0.5);
    expect(res.probNpvPositive).toBeLessThanOrEqual(1);
    expect(res.fan.ncf).toHaveLength(1);
    expect(res.fan.ncf[0].p90).toBeLessThanOrEqual(res.fan.ncf[0].p10);
    expect(res.varKeys).toEqual(['oil_price', 'capex_scale']);
  });

  it('ranks the dominant uncertainty first in the tornado', () => {
    const res = runEpeMonteCarlo({
      ...baseArgs,
      mcConfig: {
        iterations: 600, seed: 11,
        variables: {
          oil_price: { type: 'triangular', min: 40, mode: 80, max: 120 },
          opex_scale: { type: 'triangular', min: 0.97, mode: 1.0, max: 1.03 },
        },
      },
    });
    expect(res.tornado.length).toBe(2);
    expect(res.tornado[0].parameter).toBe('oil_price');
    expect(res.tornado[0].high - res.tornado[0].low)
      .toBeGreaterThan(5 * (res.tornado[1].high - res.tornado[1].low));
  });

  it('correlated price draws shift the NPV spread versus independent draws', () => {
    const variables = {
      oil_price: { type: 'normal', mean: 80, stdDev: 15 },
      production_scale: { type: 'normal', mean: 1.0, stdDev: 0.15 },
    };
    const indep = runEpeMonteCarlo({
      ...baseArgs,
      mcConfig: { iterations: 800, seed: 5, variables },
    });
    const corr = runEpeMonteCarlo({
      ...baseArgs,
      mcConfig: {
        iterations: 800, seed: 5, variables,
        correlations: [{ a: 'oil_price', b: 'production_scale', rho: 0.8 }],
      },
    });
    expect(corr.npv.stdDev).toBeGreaterThan(indep.npv.stdDev * 1.1);
  });

  it('clamps iterations into [100, 5000]', () => {
    const res = runEpeMonteCarlo({ ...baseArgs, mcConfig: { iterations: 3, seed: 1, variables: {} } });
    expect(res.iterations).toBe(100);
  });

  it('Wave C: reports payback distribution, NPV standard error, and a convergence trace', () => {
    const res = runEpeMonteCarlo({
      ...baseArgs,
      mcConfig: {
        iterations: 400, seed: 11,
        variables: { oil_price: { type: 'triangular', min: 60, mode: 80, max: 100 } },
      },
    });
    expect(Number.isFinite(res.payback.p50)).toBe(true);
    expect(res.payback.p90).toBeLessThanOrEqual(res.payback.p10 + 1e-9);
    expect(res.payback.neverShare).toBeGreaterThanOrEqual(0);
    expect(res.payback.neverShare).toBeLessThanOrEqual(1);
    expect(res.npv.se).toBeGreaterThan(0);
    expect(res.npv.se).toBeCloseTo(res.npv.stdDev / Math.sqrt(400), 6);
    expect(res.convergence.length).toBeGreaterThanOrEqual(10);
    const last = res.convergence[res.convergence.length - 1];
    expect(last.n).toBe(400);
    expect(last.mean).toBeCloseTo(res.npv.mean, 6);
  });

  it('Wave C: all four distribution types sample within their support', () => {
    const res = runEpeMonteCarlo({
      ...baseArgs,
      mcConfig: {
        iterations: 300, seed: 21,
        variables: {
          oil_price: { type: 'lognormal', mean: 80, stdDev: 12 },
          capex_scale: { type: 'normal', mean: 1.0, stdDev: 0.1, min: 0.7, max: 1.3 },
          opex_scale: { type: 'uniform', min: 0.9, max: 1.15 },
          production_scale: { type: 'triangular', min: 0.85, mode: 1.0, max: 1.1 },
        },
      },
    });
    expect(res.varKeys.sort()).toEqual(['capex_scale', 'oil_price', 'opex_scale', 'production_scale']);
    expect(Number.isFinite(res.npv.p50)).toBe(true);
    expect(res.npv.stdDev).toBeGreaterThan(0);
  });

  describe('the raw per-iteration sample', () => {
    const mcConfig = {
      iterations: 120,
      seed: 7,
      variables: {
        oil_price: { type: 'triangular', min: 50, mode: 70, max: 95 },
        capex_scale: { type: 'triangular', min: 0.8, mode: 1.0, max: 1.3 },
      },
    };

    it('has exactly one row per iteration', () => {
      const res = runEpeMonteCarlo({ ...baseArgs, mcConfig });
      expect(res.samples).toHaveLength(120);
      expect(res.samples[0].i).toBe(1);
      expect(res.samples[119].i).toBe(120);
    });

    it('records the drawn inputs and the KPIs they produced', () => {
      const res = runEpeMonteCarlo({ ...baseArgs, mcConfig });
      res.samples.forEach((row: any) => {
        expect(Number.isFinite(row.inputs.oil_price)).toBe(true);
        expect(row.inputs.oil_price).toBeGreaterThanOrEqual(50);
        expect(row.inputs.oil_price).toBeLessThanOrEqual(95);
        expect(Number.isFinite(row.npv)).toBe(true);
      });
    });

    it('keeps the iterations where IRR or payback does not exist', () => {
      const res = runEpeMonteCarlo({ ...baseArgs, mcConfig });
      const undefinedIrr = res.samples.filter((r: any) => r.irr === null).length;
      expect(undefinedIrr / res.iterations).toBeCloseTo(res.irr.nullShare, 10);
      const neverPays = res.samples.filter((r: any) => r.payback === null).length;
      expect(neverPays / res.iterations).toBeCloseTo(res.payback.neverShare, 10);
    });

    it('reproduces the reported percentiles from the sample itself', () => {
      const res = runEpeMonteCarlo({ ...baseArgs, mcConfig });
      const npvs = res.samples.map((r: any) => r.npv).sort((a: number, b: number) => a - b);
      const at = (p: number) => npvs[Math.min(Math.floor(p * npvs.length), npvs.length - 1)];
      expect(at(0.1)).toBeCloseTo(res.npv.p90, 6);
      expect(at(0.5)).toBeCloseTo(res.npv.p50, 6);
      expect(at(0.9)).toBeCloseTo(res.npv.p10, 6);
    });

    it('is reproducible from the seed', () => {
      const a = runEpeMonteCarlo({ ...baseArgs, mcConfig });
      const b = runEpeMonteCarlo({ ...baseArgs, mcConfig });
      expect(b.samples.map((r: any) => r.npv)).toEqual(a.samples.map((r: any) => r.npv));
    });
  });
});

// ===========================================================================
// 2b. Ported validation harness case 7 (7 checks)
// ===========================================================================

describe('ported validation harness case 7: Monte Carlo layer over the engine', () => {
  const baseArgs = {
    cfg: PIA_WORKED_EXAMPLE_CFG,
    prodRows: PIA_WORKED_EXAMPLE_PROD,
    capexRows: PIA_WORKED_EXAMPLE_CAPEX,
    opexRows: PIA_WORKED_EXAMPLE_OPEX,
  };
  const degenerate = runEpeMonteCarlo({ ...baseArgs, mcConfig: { iterations: 100, seed: 1, variables: {} } });
  const mcConfig = {
    iterations: 500, seed: 42,
    variables: { oil_price: { type: 'triangular', min: 60, mode: 80, max: 110 } },
  };
  const runA = runEpeMonteCarlo({ ...baseArgs, mcConfig });
  const runB = runEpeMonteCarlo({ ...baseArgs, mcConfig });

  it('degenerate MC P90 = deterministic NPV', () => {
    expect(Math.abs(degenerate.npv.p90 - PIA_WORKED_EXAMPLE_EXPECTED.npv)).toBeLessThanOrEqual(0.01);
  });
  it('degenerate MC P10 = deterministic NPV', () => {
    expect(Math.abs(degenerate.npv.p10 - PIA_WORKED_EXAMPLE_EXPECTED.npv)).toBeLessThanOrEqual(0.01);
  });
  it('degenerate MC stdDev = 0', () => {
    expect(Math.abs(degenerate.npv.stdDev)).toBeLessThanOrEqual(1e-6);
  });
  it('seeded run reproducible (P50 identical)', () => {
    expect(runA.npv.p50).toBe(runB.npv.p50);
  });
  it('P90 < deterministic NPV < P10 (mode at base price)', () => {
    expect(runA.npv.p90 < PIA_WORKED_EXAMPLE_EXPECTED.npv && PIA_WORKED_EXAMPLE_EXPECTED.npv < runA.npv.p10).toBe(true);
  });
  it('P(NPV>0) within (0, 1]', () => {
    expect(runA.probNpvPositive > 0 && runA.probNpvPositive <= 1).toBe(true);
  });
  it('tornado has the single varied input', () => {
    expect(runA.tornado.length === 1 && runA.tornado[0].parameter === 'oil_price').toBe(true);
  });
});

// ===========================================================================
// 3. Golden agreement with the independent oracle
// ===========================================================================

const money = (a: number, b: number, where: string) => {
  if (Math.abs(a - b) > Math.max(0.01, 1e-9 * Math.abs(b))) throw new Error(`${where}: engine ${a} vs oracle ${b}`);
};
const rel = (a: number, b: number, tol: number, where: string) => {
  if (Math.abs(a - b) > tol * Math.max(1, Math.abs(b))) throw new Error(`${where}: engine ${a} vs oracle ${b} (rel ${tol})`);
};
const nullable = (a: any, b: any, tol: number, where: string) => {
  if (b === null) { expect(a).toBeNull(); return; }
  expect(a).not.toBeNull();
  if (Math.abs(a - b) > tol) throw new Error(`${where}: engine ${a} vs oracle ${b} (tol ${tol})`);
};
const statsSame = (a: any, b: any, where: string, tol: 'money' | number) => {
  expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  for (const k of Object.keys(b)) {
    if (k === 'cdf') {
      expect(a.cdf).toHaveLength(b.cdf.length);
      b.cdf.forEach((pt: any, i: number) => {
        expect(a.cdf[i].y).toBe(pt.y);
        if (tol === 'money') money(a.cdf[i].x, pt.x, `${where}.cdf[${i}].x`);
        else nullable(a.cdf[i].x, pt.x, tol, `${where}.cdf[${i}].x`);
      });
    } else if (k === 'nullShare' || k === 'neverShare') {
      expect(a[k]).toBe(b[k]);
    } else if (tol === 'money') {
      money(a[k], b[k], `${where}.${k}`);
    } else {
      nullable(a[k], b[k], tol, `${where}.${k}`);
    }
  }
};

describe('golden agreement: primitives on fixed arguments', () => {
  const P = GOLDEN.primitives;

  it('mulberry32 uniform streams are BIT-IDENTICAL to the uint32 replica for every pinned seed', () => {
    for (const [key, stream] of Object.entries(P) as Array<[string, any]>) {
      if (!key.startsWith('mulberry32_seed_')) continue;
      const seed = Number(key.replace('mulberry32_seed_', ''));
      const rng = mulberry32(seed);
      for (const u of stream) expect(rng()).toBe(u);
    }
  });

  it('randomNormal on seed 42 agrees to 1e-12 relative (Box-Muller through two libms)', () => {
    const rng = mulberry32(42);
    for (const z of P.randomNormal_seed_42) rel(randomNormal(rng), z, 1e-12, 'randomNormal');
  });

  it('erf, normalCDF, triInvCDF, cholesky and the marginals agree to 1e-12 relative', () => {
    for (const [x, v] of Object.entries(P.erf)) rel(erf(Number(x)), v as number, 1e-12, `erf(${x})`);
    for (const [x, v] of Object.entries(P.normalCDF)) rel(normalCDF(Number(x)), v as number, 1e-12, `normalCDF(${x})`);
    for (const [u, v] of Object.entries(P.triInvCDF_10_25_60)) rel(triInvCDF(Number(u), 10, 25, 60), v as number, 1e-12, `triInvCDF(${u})`);
    const L = cholesky([[1, 0.6, 0.2], [0.6, 1, -0.3], [0.2, -0.3, 1]]);
    L.forEach((row, i) => row.forEach((v, j) => rel(v, P.cholesky[i][j], 1e-12, `cholesky[${i}][${j}]`)));
    for (const m of P.marginals) rel(marginalValue(m.dist, m.x) as number, m.value, 1e-12, `marginal ${m.dist.type} at ${m.x}`);
  });
});

describe('golden agreement: montecarlo_cases.json', () => {
  it('carries the degenerate and the seeded reproducibility cases', () => {
    const names = GOLDEN.cases.map((c: any) => c.name);
    expect(names).toContain('degenerate_constant');
    expect(names).toContain('seeded_triangular_oil_price');
    expect(GOLDEN.cases.length).toBeGreaterThanOrEqual(6);
  });

  describe.each(GOLDEN.cases.map((c: any) => [c.name, c]))('%s', (_name: string, c: any) => {
    const args = { cfg: c.cfg, prodRows: c.prodRows, capexRows: c.capexRows, opexRows: c.opexRows, mcConfig: c.mcConfig };
    const res = runEpeMonteCarlo(args);
    const exp = c.expected;

    it('iterations, seed, varKeys and the deterministic base agree', () => {
      expect(res.iterations).toBe(exp.iterations);
      expect(res.seed).toBe(exp.seed);
      expect(res.varKeys).toEqual(exp.varKeys);
      money(res.base.npv, exp.base.npv, 'base.npv');
      nullable(res.base.irr, exp.base.irr, 1e-4, 'base.irr');
      expect(res.base.fiscal_framework).toBe(exp.base.fiscal_framework);
      expect(res.base.pv_basis).toBe(exp.base.pv_basis);
    });

    it('every exported sample row agrees: inputs to 1e-12 relative, NPV to 0.01 USD, IRR to 1e-4, payback to 1e-8', () => {
      expect(res.samples).toHaveLength(exp.samples.length);
      res.samples.forEach((row: any, i: number) => {
        const want = exp.samples[i];
        expect(row.i).toBe(want.i);
        expect(Object.keys(row.inputs).sort()).toEqual(Object.keys(want.inputs).sort());
        for (const k of Object.keys(want.inputs)) rel(row.inputs[k], want.inputs[k], 1e-12, `samples[${i}].inputs.${k}`);
        money(row.npv, want.npv, `samples[${i}].npv`);
        nullable(row.irr, want.irr, 1e-4, `samples[${i}].irr`);
        nullable(row.payback, want.payback, 1e-8, `samples[${i}].payback`);
      });
    });

    it('NPV, IRR and payback summaries agree (petroleum-convention percentiles, population stdDev, standard error)', () => {
      statsSame(res.npv, exp.npv, 'npv', 'money');
      statsSame(res.irr, exp.irr, 'irr', 1e-4);
      statsSame(res.payback, exp.payback, 'payback', 1e-8);
      expect(res.probNpvPositive).toBe(exp.probNpvPositive);
      expect(res.diagnostics.truncationRejects).toBe(exp.diagnostics.truncationRejects);
    });

    it('the convergence trace, the fan bands and the tornado agree', () => {
      expect(res.convergence.map((p: any) => p.n)).toEqual(exp.convergence.map((p: any) => p.n));
      res.convergence.forEach((p: any, i: number) => money(p.mean, exp.convergence[i].mean, `convergence[${i}].mean`));
      for (const band of ['ncf', 'cumulative']) {
        expect(res.fan[band]).toHaveLength(exp.fan[band].length);
        res.fan[band].forEach((y: any, i: number) => {
          expect(y.year).toBe(exp.fan[band][i].year);
          for (const k of ['p90', 'p50', 'p10', 'mean']) money(y[k], exp.fan[band][i][k], `fan.${band}[${i}].${k}`);
        });
      }
      expect(res.tornado.map((t: any) => t.parameter)).toEqual(exp.tornado.map((t: any) => t.parameter));
      res.tornado.forEach((t: any, i: number) => {
        for (const k of ['base', 'low', 'high', 'lowInputVol', 'highInputVol']) money(t[k], exp.tornado[i][k], `tornado[${i}].${k}`);
      });
    });

    it('the headline percentiles re-derive from the exported rows (the auditor check)', () => {
      const r = c.rederived_from_samples;
      const npvs = res.samples.map((x: any) => x.npv).sort((a: number, b: number) => a - b);
      const at = (p: number) => npvs[Math.min(Math.floor(p * npvs.length), npvs.length - 1)];
      money(at(0.1), r.p90, 'rederived.p90');
      money(at(0.5), r.p50, 'rederived.p50');
      money(at(0.9), r.p10, 'rederived.p10');
      expect(at(0.1)).toBe(res.npv.p90);
      expect(at(0.5)).toBe(res.npv.p50);
      expect(at(0.9)).toBe(res.npv.p10);
      expect(res.samples.filter((x: any) => x.irr === null).length / res.iterations).toBe(r.irr_null_share);
      expect(res.samples.filter((x: any) => x.payback === null).length / res.iterations).toBe(r.payback_never_share);
      expect(res.samples.filter((x: any) => x.npv > 0).length / res.iterations).toBe(r.prob_npv_positive);
    });

    it('is reproducible: a second run with the same seed is identical', () => {
      const again = runEpeMonteCarlo(args);
      expect(again.samples.map((x: any) => x.npv)).toEqual(res.samples.map((x: any) => x.npv));
      expect(again.npv).toEqual(res.npv);
      expect(again.tornado).toEqual(res.tornado);
    });
  });

  it('degenerate case: every iteration is the deterministic NPV 135,185,570.34 exactly and the sampler drew nothing', () => {
    const c = GOLDEN.cases.find((x: any) => x.name === 'degenerate_constant');
    const res = runEpeMonteCarlo({ cfg: c.cfg, prodRows: c.prodRows, capexRows: c.capexRows, opexRows: c.opexRows, mcConfig: c.mcConfig });
    for (const row of res.samples) expect(row.npv).toBe(res.base.npv);
    expect(Math.abs(res.base.npv - PIA_WORKED_EXAMPLE_EXPECTED.npv)).toBeLessThanOrEqual(0.01);
    // FINDINGS-cashflow.md (Monte Carlo section): with 100 identical NPVs the
    // engine's naive reduce-mean rounds, so its population stdDev comes out
    // at 3.3e-7 USD where the oracle (compensated sum) reports exactly 0.
    // Pinned as a bound, not as zero.
    expect(res.npv.stdDev).toBeLessThanOrEqual(1e-6);
    expect(c.expected.npv.stdDev).toBe(0);
    expect(res.npv.se).toBeLessThanOrEqual(1e-7);
    expect(res.tornado).toEqual([]);
    expect(res.varKeys).toEqual([]);
    expect(c.expected.npv.p90).toBe(c.expected.npv.p10);
  });
});
