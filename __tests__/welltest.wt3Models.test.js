/**
 * WT3 model library vs the independent Python oracle
 * (tools/validation/welltest/oracle.py). Regenerate goldens with:
 *   python3 tools/validation/welltest/genfixtures.py
 *
 * The uniform-flux fracture goldens come from the oracle's REAL-TIME closed
 * form (erf + E1), a route fully independent of the JS
 * Laplace/Stehfest/K0-integral implementation, so agreement validates both.
 */
import fs from 'fs';
import path from 'path';
import { besselK0Integral, besselI0e, besselI1e, stehfestInvert } from '../engines/welltest/numerics.js';
import { radialSandfaceLaplace, composeWellbore } from '../engines/welltest/models/radial.js';
import { ufFracturePwdLaplace, fcFracturePwdLaplace } from '../engines/welltest/models/fracture.js';
import { getModel, evaluateDrawdown } from '../engines/welltest/models/modelCatalog.js';
import { autoFitModel } from '../engines/welltest/autoFit.js';
import { bourdetDerivative, detectFlowRegimes } from '../engines/welltest/derivative.js';

const goldens = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../test-data/welltest/goldens.json'), 'utf8')
);

const relErr = (actual, expected) =>
  Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-300);

describe('WT3 numerics vs oracle goldens', () => {
  test('K0 integral and scaled I0e/I1e agree with the independent routes', () => {
    for (const row of goldens.besselExtra) {
      expect(relErr(besselK0Integral(row.x), row.k0Integral)).toBeLessThan(2e-6);
      expect(relErr(besselI0e(row.x), row.i0e)).toBeLessThan(2e-6);
      expect(relErr(besselI1e(row.x), row.i1e)).toBeLessThan(2e-6);
    }
  });
});

describe('WT3 radial models vs oracle goldens', () => {
  test('boundary and dual-porosity pwD tables agree', () => {
    for (const row of goldens.radialModels) {
      const fissure = row.fissure
        ? { omega: row.fissure.omega, lambda: row.fissure.lambda, mode: row.fissure.mode }
        : null;
      const boundary = row.boundary || null;
      const ours = stehfestInvert(
        (u) => composeWellbore(u, radialSandfaceLaplace(u, { fissure, boundary }), row.skin, row.cd),
        row.tD
      );
      expect(relErr(ours, row.pwd)).toBeLessThan(1e-3);
    }
  });
});

describe('WT3 fracture models vs oracle goldens', () => {
  test('uniform-flux/IC fracture matches the independent real-time route', () => {
    for (const row of goldens.ufFractureTime) {
      const ours = stehfestInvert(
        (v) => ufFracturePwdLaplace(v, { xD: row.xD }),
        row.tDxf
      );
      expect(relErr(ours, row.pwd)).toBeLessThan(2e-3);
    }
  });

  test('finite-conductivity fracture matches the oracle discretization', () => {
    for (const row of goldens.fcFracture) {
      const ours = stehfestInvert(
        (v) => fcFracturePwdLaplace(v, { fcd: row.fcd }),
        row.tDxf
      );
      expect(relErr(ours, row.pwd)).toBeLessThan(1e-4);
    }
  });
});

describe('WT3 forward reproduction of oracle fixtures', () => {
  test('sealing-fault drawdown fixture', () => {
    const { reservoir, truth, points } = goldens.fixtures.faultDrawdown;
    const series = evaluateDrawdown({
      model: getModel('homogeneous-sealing-fault'),
      params: truth,
      reservoir,
      times: points.map((p) => p.t),
    });
    // late-time image-term differences between the A&S-polynomial and
    // integral-based Bessel bases amplify through Stehfest to ~5e-4 here
    points.forEach((p, i) => {
      expect(relErr(series[i].dp, p.dp)).toBeLessThan(1e-3);
    });
  });

  test('infinite-conductivity fracture drawdown fixture', () => {
    const { reservoir, truth, points } = goldens.fixtures.icFractureDrawdown;
    const series = evaluateDrawdown({
      model: getModel('fracture-infinite-conductivity'),
      params: truth,
      reservoir,
      times: points.map((p) => p.t),
    });
    points.forEach((p, i) => {
      expect(relErr(series[i].dp, p.dp)).toBeLessThan(2e-4);
    });
  });

  test('dual-porosity (PSS) drawdown fixture', () => {
    const { reservoir, truth, points } = goldens.fixtures.dualPorosityDrawdown;
    const series = evaluateDrawdown({
      model: getModel('dual-porosity-pss'),
      params: truth,
      reservoir,
      times: points.map((p) => p.t),
    });
    points.forEach((p, i) => {
      expect(relErr(series[i].dp, p.dp)).toBeLessThan(1e-5);
    });
  });
});

describe('WT3 auto-fit round trips (oracle-generated data)', () => {
  test('sealing fault: recovers k, skin, C and boundary distance', () => {
    const { reservoir, truth, points } = goldens.fixtures.faultDrawdown;
    const fit = autoFitModel({
      model: getModel('homogeneous-sealing-fault'),
      testType: 'drawdown',
      data: points.map((p) => ({ t: p.t, dp: p.dp })),
      reservoir,
      initialParams: { k: 30, skin: 1, C: 0.005, L: 300 },
    });
    expect(fit.converged).toBe(true);
    expect(relErr(fit.params.k, truth.k)).toBeLessThan(0.02);
    expect(Math.abs(fit.params.skin - truth.skin)).toBeLessThan(0.3);
    expect(relErr(fit.params.C, truth.C)).toBeLessThan(0.05);
    expect(relErr(fit.params.L, truth.L)).toBeLessThan(0.1);
  });

  test('infinite-conductivity fracture: recovers k, xf and C', () => {
    const { reservoir, truth, points } = goldens.fixtures.icFractureDrawdown;
    const fit = autoFitModel({
      model: getModel('fracture-infinite-conductivity'),
      testType: 'drawdown',
      data: points.map((p) => ({ t: p.t, dp: p.dp })),
      reservoir,
      initialParams: { k: 2, xf: 100, C: 0.001, skin: 0 },
    });
    expect(fit.converged).toBe(true);
    expect(relErr(fit.params.k, truth.k)).toBeLessThan(0.03);
    expect(relErr(fit.params.xf, truth.xf)).toBeLessThan(0.05);
    expect(relErr(fit.params.C, truth.C)).toBeLessThan(0.1);
    expect(Math.abs(fit.params.skin - truth.skin)).toBeLessThan(0.3);
  });

  test('dual porosity (PSS): recovers k, omega and lambda', () => {
    const { reservoir, truth, points } = goldens.fixtures.dualPorosityDrawdown;
    const fit = autoFitModel({
      model: getModel('dual-porosity-pss'),
      testType: 'drawdown',
      data: points.map((p) => ({ t: p.t, dp: p.dp })),
      reservoir,
      initialParams: { k: 40, skin: 1, C: 0.005, omega: 0.2, lambda: 1e-6 },
    });
    expect(fit.converged).toBe(true);
    expect(relErr(fit.params.k, truth.k)).toBeLessThan(0.03);
    expect(Math.abs(fit.params.skin - truth.skin)).toBeLessThan(0.5);
    expect(Math.abs(Math.log10(fit.params.omega / truth.omega))).toBeLessThan(0.15);
    expect(Math.abs(Math.log10(fit.params.lambda / truth.lambda))).toBeLessThan(0.3);
  });
});

describe('WT3 regime detection extension', () => {
  test('constant-pressure boundary flagged from a plunging derivative', () => {
    const { reservoir, truth } = goldens.fixtures.faultDrawdown;
    const model = getModel('homogeneous-constant-pressure');
    const times = Array.from({ length: 60 }, (_, i) => Math.pow(10, -2 + (5 * i) / 59));
    const series = evaluateDrawdown({
      model,
      params: { k: truth.k, skin: 0, C: 0.001, L: 300 },
      reservoir,
      times,
    });
    const deriv = bourdetDerivative(
      series.map((p) => ({ x: p.t, y: p.dp })),
      { L: 0.1 }
    );
    const regimes = detectFlowRegimes(deriv);
    expect(regimes.some((r) => r.regime === 'constant-pressure')).toBe(true);
  });
});
