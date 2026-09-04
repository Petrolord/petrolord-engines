// Production nodal engine gates: closed forms the physics must satisfy
// exactly, plus agreement with the independent stdlib oracle
// (tools/validation/production/oracle_nodal.py) through its committed
// goldens.
//
// The oracle reaches every number by a different road: closed-form IPR
// inverses where the engine runs Brent on the forward relation, an RK4
// march in depth where the engine evaluates the Cullender and Smith
// integral by trapezoid and Simpson, a 300-to-4000 point scan with
// bisection where the engine scans 40 points, and analytic residual
// slopes where the engine takes a central difference of half a per cent
// of qmax. Agreement here is two methods meeting, not code echoing
// itself.
//
// ONE PLACE THEY DO NOT AGREE, AND IT IS A REAL RESULT. The published
// two-station Cullender and Smith construction carries a truncation
// error that the oracle's converged integral exposes: 1.3 psi at
// 9 MMscf/d on an 8000 ft 2.441 in string, 11.6 psi at 13.3 MMscf/d.
// Both are gated below -- the default two-station march against the
// method's own error band, and the same marcher at 256 sub-intervals
// against the converged integral to a part in a million.

import fs from 'fs';
import path from 'path';
import {
  nodalGasZ, moodyFrictionFactor, colebrookFrictionFactor,
  linspace, brentSolve, vogelRatio,
  rateAtPwf, pwfAtRate, computeIpr, futureIpr,
  backPressureIpr, litIpr, gasPwfAtRate, gasPwfAtRateExact,
  gasReynolds, csIntegrand, csFrictionGroup,
  cullenderSmithBhp, averageTzBhp, tubingCurve,
  solveNodeCore, solveOilNode, solveGasNode, operatingPointSweep,
} from '../engines/production/nodal';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'nodal_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

/** Rebuild a golden oil-IPR spec as a calibrated engine model. */
const oilModel = (spec) => computeIpr({
  model: spec.model,
  pr: spec.pr,
  pb: spec.pb,
  pi: spec.pi,
  qmax: spec.qmax,
  c: spec.c,
  n: spec.n,
  a: spec.a,
  b: spec.b,
});

/**
 * The two instrument outflows the goldens use. They are test
 * instruments, not correlations, and the oracle documents why: a curve
 * whose crossings are known in closed form gates the SOLVER, where a
 * correlation would only gate it against another numerical answer.
 */
const instrumentOutflow = (o, ipr) => (o.form === 'gravityFriction'
  ? (q) => o.pWh + o.gGrav / (1 + q / o.qRef) + o.kFric * q * q
  : (q) => pwfAtRate(ipr, q) + o.c0 + o.c2 * (q - o.q0) ** 2);

// ---------------------------------------------------------------------

describe('numerics and gas properties', () => {
  test('linspace hits both ends exactly', () => {
    const xs = linspace(3, 11, 5);
    expect(xs[0]).toBe(3);
    expect(xs[xs.length - 1]).toBe(11);
    expect(xs).toHaveLength(5);
  });

  test('Brent refuses a bracket that does not straddle a root', () => {
    const bad = brentSolve((x) => x * x + 1, -1, 1);
    expect(bad.converged).toBe(false);
    expect(Number.isNaN(bad.root)).toBe(true);
  });

  test('Colebrook root satisfies the Colebrook equation it was solved from', () => {
    for (const [re, rr] of [[1e4, 1e-4], [1e6, 5e-4], [1e8, 1e-6]]) {
      const f = colebrookFrictionFactor(re, rr);
      const lhs = 1 / Math.sqrt(f);
      const rhs = -2 * Math.log10(rr / 3.7 + 2.51 / (re * Math.sqrt(f)));
      expect(rel(lhs, rhs)).toBeLessThan(1e-10);
    }
  });

  test('friction factor matches the oracle across the regimes', () => {
    for (const c of G.friction) {
      expect(rel(moodyFrictionFactor(c.re, c.relRough), c.f)).toBeLessThan(1e-9);
    }
  });

  test('z matches the oracle, and goes to the ideal-gas limit', () => {
    for (const c of G.zFactor) {
      expect(rel(nodalGasZ({ pPsia: c.pPsia, tF: c.tF, gasSg: c.gasSg }), c.z)).toBeLessThan(1e-9);
    }
    expect(nodalGasZ({ pPsia: 1e-6, tF: 150, gasSg: 0.65 })).toBeCloseTo(1, 8);
  });
});

describe('oil inflow performance', () => {
  test('Vogel is its own reference at both ends of the curve', () => {
    expect(vogelRatio(0)).toBe(1);
    expect(vogelRatio(1)).toBeCloseTo(0, 12);
  });

  test('forward and inverse are inverses of each other', () => {
    for (const c of G.oilIpr) {
      const m = oilModel({ model: c.model, ...c.inputs });
      for (const f of [0.05, 0.3, 0.6, 0.9]) {
        const q = m.qmax * f;
        expect(rel(rateAtPwf(m, pwfAtRate(m, q)), q)).toBeLessThan(1e-8);
      }
    }
  });

  test('absolute open flow, forward rates and inverse pressures match the oracle', () => {
    for (const c of G.oilIpr) {
      const m = oilModel({ model: c.model, ...c.inputs });
      expect(rel(m.qmax, c.qmax)).toBeLessThan(1e-12);
      for (const r of c.forward) expect(rel(rateAtPwf(m, r.pwf), r.q)).toBeLessThan(1e-12);
      // the engine inverts with Brent at a 1e-6 tolerance; the oracle
      // writes the inverse down.
      for (const r of c.inverse) expect(Math.abs(pwfAtRate(m, r.q) - r.pwf)).toBeLessThan(1e-6);
    }
  });

  test('the curve is sampled evenly in pressure and lands on both axes', () => {
    for (const c of G.oilIpr) {
      const m = oilModel({ model: c.model, ...c.inputs });
      expect(m.curve).toHaveLength(40);
      expect(m.curve[0].pwf).toBe(m.pr);
      expect(m.curve[0].q).toBe(0);
      expect(m.curve[m.curve.length - 1].pwf).toBe(0);
      expect(rel(m.curve[m.curve.length - 1].q, m.qmax)).toBeLessThan(1e-12);
    }
  });

  test('calibration from a production test reproduces the test point', () => {
    for (const c of G.iprCalibration) {
      const m = computeIpr({
        model: c.model,
        pr: c.inputs.pr,
        pb: c.inputs.pb,
        n: c.inputs.n,
        testPoint: { q: c.inputs.testQ, pwf: c.inputs.testPwf },
      });
      expect(rel(m.qmax, c.qmax)).toBeLessThan(1e-12);
      if (c.pi != null) expect(rel(m.pi, c.pi)).toBeLessThan(1e-12);
      if (c.c != null) expect(rel(m.c, c.c)).toBeLessThan(1e-12);
      expect(rel(rateAtPwf(m, c.inputs.testPwf), c.qAtTestPwf)).toBeLessThan(1e-12);
      expect(rel(rateAtPwf(m, c.inputs.testPwf), c.inputs.testQ)).toBeLessThan(1e-12);
    }
  });

  test('depletion follows the published rule for each family', () => {
    for (const c of G.futureIpr) {
      const base = G.oilIpr.find((x) => x.model === c.model);
      const f = futureIpr(oilModel({ model: c.model, ...base.inputs }), { prFuture: c.prFuture });
      expect(rel(f.qmax, c.qmax)).toBeLessThan(1e-12);
      expect(Math.abs(pwfAtRate(f, 0.5 * f.qmax) - c.pwfAtHalfQmax)).toBeLessThan(1e-6);
    }
  });

  test('an uncalibrated inflow refuses rather than returning NaN rates', () => {
    const bad = computeIpr({ model: 'pi', pr: 2500 });
    expect(bad.curve).toEqual([]);
    expect(bad.warnings.join(' ')).toMatch(/not positive/);
    const noPr = computeIpr({ model: 'vogel', pr: 0, qmax: 900 });
    expect(noPr.curve).toEqual([]);
  });
});

describe('gas deliverability', () => {
  test('absolute open flow, forward and closed-form inverse match the oracle', () => {
    for (const c of G.gasIpr) {
      const m = c.model === 'backPressure' ? backPressureIpr(c.inputs) : litIpr(c.inputs);
      expect(rel(m.aof, c.aof)).toBeLessThan(1e-12);
      for (const r of c.forward) expect(rel(m.qAt(r.pwf), r.q)).toBeLessThan(1e-12);
      for (const r of c.inverse) {
        expect(rel(gasPwfAtRateExact(m, r.q), r.pwf)).toBeLessThan(1e-12);
      }
    }
  });

  test('reading pwf off the sampled curve is biased, by the amount the oracle measures', () => {
    for (const c of G.gasIpr) {
      const m = c.model === 'backPressure' ? backPressureIpr(c.inputs) : litIpr(c.inputs);
      for (const r of c.chord40) {
        expect(rel(gasPwfAtRate(m, r.q), r.pwf)).toBeLessThan(1e-12);
        // the reading is LOW on both empirical families, because the
        // curve is sampled evenly in pressure and is therefore sparse in
        // rate exactly where it is steepest
        expect(r.biasPsi).toBeLessThan(0);
        expect(gasPwfAtRate(m, r.q)).toBeLessThan(gasPwfAtRateExact(m, r.q));
      }
    }
  });

  test('an unpinned deliverability refuses', () => {
    expect(backPressureIpr({ pr: 4000, c: 0, n: 0.85 }).curve).toEqual([]);
    expect(litIpr({ pr: 0, a: 900, b: 0.35 }).curve).toEqual([]);
  });
});

describe('dry-gas tubing outflow', () => {
  test('the Reynolds number and friction group match the oracle', () => {
    for (const c of G.tubing) {
      const i = c.inputs;
      if (!(i.qMmscfd > 0)) continue;
      expect(rel(gasReynolds(i.qMmscfd, i.gasSg, i.muCp, i.idIn), c.reynolds)).toBeLessThan(1e-12);
      expect(rel(
        csFrictionGroup({ qMmscfd: i.qMmscfd, fMoody: c.fMoodyUsed, idIn: i.idIn }),
        c.frictionGroupF2,
      )).toBeLessThan(1e-9);
    }
  });

  test('the integrand is the published one', () => {
    // I(p) = (p/Tz) / [ (H/L)(p/Tz)^2/1000 + F^2 ], and with F^2 = 0 and
    // a vertical hole it collapses to 1000 Tz/p exactly.
    const v = csIntegrand({ pPsia: 1500, tR: 620, z: 0.88, elevRatio: 1, f2: 0 });
    expect(rel(v, (1000 * 620 * 0.88) / 1500)).toBeLessThan(1e-12);
  });

  test('the marcher converges to the same integral the oracle integrated', () => {
    for (const c of G.tubing) {
      const r = cullenderSmithBhp({ ...c.inputs, steps: 256, tolPsi: 1e-9 });
      expect(r.converged).toBe(true);
      expect(rel(r.pwf, c.pwfPsia)).toBeLessThan(1e-6);
    }
  });

  test('the published two-station march is inside its own truncation error, and no better', () => {
    // Gated as a BAND, not as agreement: the two-station construction is
    // an approximation to the integral above and the oracle knows what
    // the integral is. See the module header on `steps`.
    for (const c of G.tubing) {
      const r = cullenderSmithBhp(c.inputs);
      expect(r.converged).toBe(true);
      expect(rel(r.pwf, c.pwfPsia)).toBeLessThan(1e-3);
    }
    // and the error is real and one-signed on the friction-dominated case
    const hot = G.tubing.find((c) => c.id === 'flowingHighRate');
    const two = cullenderSmithBhp(hot.inputs).pwf;
    expect(hot.pwfPsia - two).toBeGreaterThan(1.0);
    const fine = cullenderSmithBhp({ ...hot.inputs, steps: 256, tolPsi: 1e-9 }).pwf;
    expect(Math.abs(hot.pwfPsia - fine)).toBeLessThan(1e-2);
  });

  test('average T and z matches the oracle bisection of the same closure', () => {
    for (const c of G.tubing) {
      const a = averageTzBhp({ ...c.inputs, qMscfd: c.inputs.qMmscfd * 1000 });
      expect(a.converged).toBe(true);
      expect(rel(a.pwf, c.avgTzPwfPsia)).toBeLessThan(1e-8);
    }
  });

  test('the static column is the static column whichever way it is reached', () => {
    const stat = G.tubing.find((c) => c.id === 'staticVertical');
    const cs = cullenderSmithBhp({ ...stat.inputs, steps: 256, tolPsi: 1e-9 }).pwf;
    const az = averageTzBhp({ ...stat.inputs, qMscfd: 0 }).pwf;
    // two different quadratures of a static gas column, within a psi
    expect(Math.abs(cs - az)).toBeLessThan(1);
  });

  test('a column with no wellhead pressure or no depth refuses', () => {
    expect(Number.isNaN(cullenderSmithBhp({ ptf: 0, gasSg: 0.65, mdFt: 8000, whtF: 100, bhtF: 200 }).pwf)).toBe(true);
    expect(Number.isNaN(averageTzBhp({ ptf: 800, gasSg: 0.65, mdFt: 0, whtF: 100, bhtF: 200 }).pwf)).toBe(true);
  });

  test('the sampled outflow curve and its minimum match the oracle', () => {
    const t = G.tubingCurve;
    const r = tubingCurve({
      bhpAt: (q) => cullenderSmithBhp({ ...t.tubing, qMmscfd: q / 1000, steps: 256, tolPsi: 1e-9 }).pwf,
      qMax: t.qMax,
      nPoints: t.nPoints,
    });
    expect(r.curve).toHaveLength(t.nPoints);
    t.curve.forEach((row, i) => {
      expect(rel(r.curve[i].q, row.q)).toBeLessThan(1e-12);
      expect(rel(r.curve[i].bhp, row.bhp)).toBeLessThan(1e-6);
    });
    // the reduction is gated as its own value
    expect(rel(r.minimum.q, t.sampledMinimum.q)).toBeLessThan(1e-12);
    expect(rel(r.minimum.bhp, t.sampledMinimum.bhp)).toBeLessThan(1e-6);
    // and a dry gas column has no J in it: the minimum is the low-rate end
    expect(r.minimum.q).toBe(r.curve[0].q);
    expect(rel(t.sampledMinimum.bhp, t.trueMinimum.bhp)).toBeLessThan(1e-6);
  });

  test('an empty rate bound gives an empty curve, not a crash', () => {
    expect(tubingCurve({ bhpAt: () => 1, qMax: 0 })).toEqual({ curve: [], minimum: null });
  });
});

describe('the node solve', () => {
  test('two straight lines cross where algebra says they do', () => {
    // inflow  pwf = 3000 - 2 q      outflow  bhp = 500 + q
    // crossing at q = 2500/3, pwf = 3000 - 5000/3
    const r = solveNodeCore({
      iprPwfAt: (q) => 3000 - 2 * q,
      vlpBhpAt: (q) => 500 + q,
      qMax: 1500,
    });
    expect(r.intersections).toHaveLength(1);
    expect(rel(r.op.q, 2500 / 3)).toBeLessThan(1e-9);
    expect(rel(r.op.pwf, 3000 - 2 * (2500 / 3))).toBeLessThan(1e-9);
    expect(r.op.stable).toBe(true);
    expect(r.status).toBe('flowing');
  });

  test('a rate bound of zero is dead, not a crash', () => {
    const r = solveNodeCore({ iprPwfAt: () => 1, vlpBhpAt: () => 0, qMax: 0 });
    expect(r).toEqual({ intersections: [], op: null, status: 'dead', curve: [] });
  });

  test('every golden node reproduces the oracle: crossings, stability and the operating point', () => {
    for (const c of G.nodes) {
      const ipr = oilModel(c.ipr);
      const vlp = instrumentOutflow(c.outflow, ipr);
      expect(rel(ipr.qmax, c.qMax)).toBeLessThan(1e-12);

      // the two curves themselves, before anything is solved
      for (const p of c.probes) {
        expect(Math.abs(pwfAtRate(ipr, p.q) - p.ipr)).toBeLessThan(1e-6);
        expect(Math.abs(vlp(p.q) - p.vlp)).toBeLessThan(1e-6);
      }

      const s = solveOilNode({ ipr, vlpBhpAt: vlp, nGrid: c.nGridRequired || 40 });
      expect(s.status).toBe(c.status);
      expect(s.intersections).toHaveLength(c.intersections.length);
      c.intersections.forEach((x, i) => {
        expect(rel(s.intersections[i].q, x.q)).toBeLessThan(1e-7);
        expect(Math.abs(s.intersections[i].pwf - x.pwf)).toBeLessThan(1e-4);
        expect(s.intersections[i].stable).toBe(x.stable);
      });
      // THE REDUCTION, gated on its own: the rightmost stable crossing.
      if (c.op === null) {
        expect(s.op).toBeNull();
      } else {
        expect(rel(s.op.q, c.op.q)).toBeLessThan(1e-7);
        expect(Math.abs(s.op.pwf - c.op.pwf)).toBeLessThan(1e-4);
        expect(s.op.stable).toBe(true);
      }
    }
  });

  test('the operating point is off the scan grid, so it took a real solve', () => {
    const c = G.nodes.find((x) => x.id === 'vogelSingleCrossing');
    const ipr = oilModel(c.ipr);
    const grid = linspace(ipr.qmax * 1e-3, ipr.qmax * 0.999, 40);
    const nearest = grid.reduce((best, q) => (Math.abs(q - c.op.q) < Math.abs(best - c.op.q) ? q : best), grid[0]);
    const spacing = grid[1] - grid[0];
    // not merely off a node: a fifth of an interval away from the nearest one
    expect(Math.abs(nearest - c.op.q) / spacing).toBeGreaterThan(0.2);
  });

  test('a scan too coarse for the crossings loses the well entirely', () => {
    // The pinched instrument puts both crossings inside one interval of
    // the default 40-point scan. This is not a contrivance: it is the
    // shape a well takes as it approaches loading up, and it is the
    // documented limit of a fixed-resolution scan. The golden records
    // what is TRUE; this test records what the default costs.
    const c = G.nodes.find((x) => x.id === 'analyticResidualPinched');
    const ipr = oilModel(c.ipr);
    const vlp = instrumentOutflow(c.outflow, ipr);
    expect(solveOilNode({ ipr, vlpBhpAt: vlp, nGrid: 40 }).status).toBe('dead');
    const fine = solveOilNode({ ipr, vlpBhpAt: vlp, nGrid: c.nGridRequired });
    expect(fine.status).toBe('flowing');
    expect(rel(fine.op.q, c.op.q)).toBeLessThan(1e-9);
  });

  test('an inflow that never calibrated makes a dead node, not a NaN one', () => {
    const s = solveOilNode({ ipr: computeIpr({ model: 'pi', pr: 2500 }), vlpBhpAt: () => 500 });
    expect(s.status).toBe('dead');
    expect(s.op).toBeNull();
    expect(Number.isNaN(s.qMax)).toBe(true);
  });
});

describe('a physical gas node: deliverability against the column', () => {
  test('crossings and the operating point match the oracle', () => {
    for (const c of G.gasNodes) {
      const ipr = backPressureIpr(c.ipr);
      const tubing = { ...c.tubing, steps: 256, tolPsi: 1e-9 };
      expect(rel(ipr.aof, c.qMax)).toBeLessThan(1e-12);

      for (const p of c.probes) {
        expect(rel(gasPwfAtRateExact(ipr, p.q), p.ipr)).toBeLessThan(1e-12);
        expect(rel(cullenderSmithBhp({ ...tubing, qMmscfd: p.q / 1000 }).pwf, p.vlp)).toBeLessThan(1e-6);
      }

      const s = solveGasNode({ iprResult: ipr, tubing, nGrid: 40 });
      expect(s.status).toBe(c.status);
      expect(s.intersections).toHaveLength(c.intersections.length);
      expect(rel(s.op.q, c.op.q)).toBeLessThan(1e-5);
      expect(rel(s.op.pwf, c.op.pwf)).toBeLessThan(1e-5);
      expect(s.op.stable).toBe(true);
    }
  });

  test('a dry-gas node has exactly one crossing and it is stable', () => {
    // Nothing in a dry gas column lightens with rate, so the outflow
    // rises monotonically and can cross a falling inflow only once.
    for (const c of G.gasNodes) {
      expect(c.intersections).toHaveLength(1);
      expect(c.intersections[0].stable).toBe(true);
    }
  });

  test('the two-station default moves the operating point by a measurable amount', () => {
    // The same finding as the tubing gate, carried through to the number
    // a user reads. Recorded, not hidden.
    const c = G.gasNodes.find((x) => x.id === 'gasWellVertical');
    const ipr = backPressureIpr(c.ipr);
    const coarse = solveGasNode({ iprResult: ipr, tubing: c.tubing, nGrid: 40 });
    const fine = solveGasNode({
      iprResult: ipr, tubing: { ...c.tubing, steps: 256, tolPsi: 1e-9 }, nGrid: 40,
    });
    expect(rel(fine.op.q, c.op.q)).toBeLessThan(1e-5);
    expect(coarse.op.q).toBeGreaterThan(fine.op.q);
    expect(rel(coarse.op.q, fine.op.q)).toBeGreaterThan(1e-4);
  });

  test('a wellhead-pressure sweep matches the oracle case by case', () => {
    const base = G.gasNodes.find((x) => x.id === G.sweep.node);
    const ipr = backPressureIpr(base.ipr);
    const rows = operatingPointSweep(G.sweep.cases.map((c) => ({
      label: c.label,
      value: c.value,
      solve: () => solveGasNode({
        iprResult: ipr,
        tubing: { ...base.tubing, ptf: c.value, steps: 256, tolPsi: 1e-9 },
        nGrid: 40,
      }),
    })));
    expect(rows).toHaveLength(G.sweep.cases.length);
    rows.forEach((r, i) => {
      const g = G.sweep.cases[i];
      expect(r.label).toBe(g.label);
      expect(r.value).toBe(g.value);
      expect(r.status).toBe(g.status);
      expect(rel(r.q, g.q)).toBeLessThan(1e-5);
      expect(rel(r.pwf, g.pwf)).toBeLessThan(1e-5);
    });
    // and the physics of the sweep: choking the wellhead back kills rate
    for (let i = 1; i < rows.length; i += 1) expect(rows[i].q).toBeLessThan(rows[i - 1].q);
  });

  // The cullenderSmithBhp header states a truncation and a convergence
  // sequence, and a header is what a consumer acts on. This pins every number
  // it quotes, on the string it names, so the prose cannot drift away from the
  // arithmetic. It was added after the header was found attributing 11.6 psi
  // to 13 MMscf/d when 11.6 psi belongs to 13.3 and 13.0 gives 10.5.
  test('the header truncation and convergence sequence are the arithmetic', () => {
    const string = {
      ptf: 800, gasSg: 0.65, mdFt: 8000, tvdFt: 8000,
      whtF: 100, bhtF: 200, idIn: 2.441, roughnessIn: 0.0006, muCp: 0.012,
    };
    const gapAt = (qMmscfd, steps) => {
      const converged = cullenderSmithBhp({ ...string, qMmscfd, steps: 4096 }).pwf;
      return cullenderSmithBhp({ ...string, qMmscfd, steps }).pwf - converged;
    };
    // the two-station truncation the header quotes at three rates
    expect(gapAt(9.0, 2)).toBeCloseTo(-1.3, 1);
    expect(gapAt(13.0, 2)).toBeCloseTo(-10.5, 1);
    expect(gapAt(13.3, 2)).toBeCloseTo(-11.6, 1);
    // and the convergence sequence on the 13.3 MMscf/d column
    expect(gapAt(13.3, 16)).toBeCloseTo(-0.26, 2);
    expect(gapAt(13.3, 64)).toBeCloseTo(-0.016, 3);
    expect(gapAt(13.3, 256)).toBeCloseTo(-0.001, 3);
    // the header says the error falls roughly with the square of the count,
    // so quadrupling the stations should cut it by about sixteen
    const r16to64 = gapAt(13.3, 16) / gapAt(13.3, 64);
    expect(r16to64).toBeGreaterThan(12);
    expect(r16to64).toBeLessThan(20);
    // and every march runs LOW, which is the direction the header claims
    [2, 16, 64, 256].forEach((n) => expect(gapAt(13.3, n)).toBeLessThan(0));
  });

  test('a deliverability that never pinned down refuses the node', () => {
    const s = solveGasNode({ iprResult: backPressureIpr({ pr: 4000, c: NaN, n: 0.8 }), tubing: {} });
    expect(s.status).toBe('dead');
    expect(s.op).toBeNull();
  });
});
