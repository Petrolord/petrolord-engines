/**
 * Cross-validation against the independent Python oracle
 * (tools/validation/welltest/oracle.py, stdlib-only, integral-based Bessel
 * functions and exact rational Stehfest weights). Regenerate goldens with:
 *   python3 tools/validation/welltest/genfixtures.py
 */
import fs from 'fs';
import path from 'path';
import { besselI0, besselI1, besselK0e, besselK1e, expE1, stehfestCoefficients } from '../engines/welltest/numerics.js';
import { pwdHomogeneous, lineSourcePd } from '../engines/welltest/models/homogeneous.js';
import { getModel, toDimensionlessGroups, evaluateDrawdown, evaluateBuildup } from '../engines/welltest/models/modelCatalog.js';
import { mdhAnalysis, hornerAnalysis } from '../engines/welltest/analysis.js';
import { autoFitModel } from '../engines/welltest/autoFit.js';

const goldens = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../test-data/welltest/goldens.json'), 'utf8')
);

const relErr = (actual, expected) =>
  Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-300);

describe('numerics vs oracle goldens', () => {
  test('Bessel functions agree with the integral-representation oracle', () => {
    for (const row of goldens.bessel) {
      expect(relErr(besselI0(row.x), row.i0)).toBeLessThan(2e-6);
      expect(relErr(besselI1(row.x), row.i1)).toBeLessThan(2e-6);
      expect(relErr(besselK0e(row.x), row.k0e)).toBeLessThan(2e-6);
      expect(relErr(besselK1e(row.x), row.k1e)).toBeLessThan(2e-6);
    }
  });

  test('E1 agrees with the oracle to near machine precision', () => {
    for (const row of goldens.e1) {
      expect(relErr(expE1(row.x), row.e1)).toBeLessThan(1e-12);
    }
  });

  test('Stehfest weights agree with exact rational arithmetic', () => {
    for (const n of [8, 12, 16]) {
      const exact = goldens.stehfest[String(n)];
      const ours = stehfestCoefficients(n);
      exact.forEach((v, i) => {
        expect(relErr(ours[i], v)).toBeLessThan(1e-9);
      });
    }
  });

  test('line-source pD agrees with the oracle', () => {
    for (const row of goldens.lineSource) {
      expect(relErr(lineSourcePd(row.tD), row.pD)).toBeLessThan(1e-10);
    }
  });
});

describe('homogeneous pwD vs oracle goldens', () => {
  test('all storage/skin cases agree', () => {
    // Stehfest's alternating weights amplify the ~1e-7 Bessel approximation
    // difference between the two implementations by the cancellation ratio,
    // which peaks at early time for strongly negative skin. Typical agreement
    // is 1e-6; the hard ceiling covers the worst cancellation case.
    let loose = 0;
    for (const row of goldens.pwd) {
      const ours = pwdHomogeneous(row.tD, { skin: row.skin, cd: row.cd });
      const err = relErr(ours, row.pwd);
      expect(err).toBeLessThan(5e-3);
      if (err > 1e-5) loose += 1;
    }
    expect(loose).toBeLessThanOrEqual(2);
  });
});

describe('oracle-generated synthetic fixtures (engine-level round trips)', () => {
  const model = getModel('homogeneous');

  test('forward model reproduces the oracle drawdown fixture', () => {
    const { reservoir, truth, points } = goldens.fixtures.drawdown;
    const series = evaluateDrawdown({
      model,
      params: truth,
      reservoir,
      times: points.map((p) => p.t),
    });
    points.forEach((p, i) => {
      expect(relErr(series[i].dp, p.dp)).toBeLessThan(1e-5);
    });
  });

  test('forward model reproduces the oracle buildup fixture', () => {
    const { reservoir, truth, tp, points, pwfShutIn } = goldens.fixtures.buildup;
    const series = evaluateBuildup({
      model,
      params: truth,
      reservoir,
      tp,
      dts: points.map((p) => p.dt),
    });
    expect(relErr(series.pwfAtShutIn, pwfShutIn)).toBeLessThan(1e-6);
    points.forEach((p, i) => {
      expect(relErr(series[i].dp, p.dp)).toBeLessThan(1e-5);
    });
  });

  test('MDH on the late-time drawdown fixture recovers k and skin', () => {
    const { reservoir, truth, points } = goldens.fixtures.drawdown;
    const groups = toDimensionlessGroups({ ...reservoir, k: truth.k });
    // classical end-of-storage criterion tD > (60 + 3.5 s) CD, then most of a
    // log cycle of margin so the window is fully radial
    const tStorageOut =
      ((60 + 3.5 * truth.skin) * truth.C * groups.cdPerBblPsi) / groups.tdPerHour;
    const radial = points.filter((p) => p.t > 8 * tStorageOut);
    expect(radial.length).toBeGreaterThan(8);
    const result = mdhAnalysis({
      points: radial.map((p) => ({ t: p.t, pwf: p.pwf })),
      ...reservoir,
    });
    expect(Math.abs(result.k - truth.k) / truth.k).toBeLessThan(0.02);
    expect(Math.abs(result.skin - truth.skin)).toBeLessThan(0.3);
  });

  test('Horner on the buildup fixture recovers k, skin and p*', () => {
    const { reservoir, truth, tp, points, pwfShutIn } = goldens.fixtures.buildup;
    const groups = toDimensionlessGroups({ ...reservoir, k: truth.k });
    const tStorageOut =
      ((60 + 3.5 * truth.skin) * truth.C * groups.cdPerBblPsi) / groups.tdPerHour;
    const radial = points.filter((p) => p.dt > 8 * tStorageOut && p.dt < tp);
    expect(radial.length).toBeGreaterThan(6);
    const result = hornerAnalysis({
      points: radial.map((p) => ({ dt: p.dt, pws: p.pws })),
      tp,
      pwfShutIn,
      ...reservoir,
    });
    expect(Math.abs(result.k - truth.k) / truth.k).toBeLessThan(0.03);
    expect(Math.abs(result.skin - truth.skin)).toBeLessThan(0.5);
    expect(Math.abs(result.pStar - reservoir.pi)).toBeLessThan(5);
  });

  test('auto-fit on the drawdown fixture recovers k, skin and C', () => {
    const { reservoir, truth, points } = goldens.fixtures.drawdown;
    const fit = autoFitModel({
      model,
      testType: 'drawdown',
      data: points.map((p) => ({ t: p.t, dp: p.dp })),
      reservoir,
      initialParams: { k: 20, skin: 0, C: 0.003 },
    });
    expect(fit.converged).toBe(true);
    expect(Math.abs(fit.params.k - truth.k) / truth.k).toBeLessThan(0.01);
    expect(Math.abs(fit.params.skin - truth.skin)).toBeLessThan(0.2);
    expect(Math.abs(fit.params.C - truth.C) / truth.C).toBeLessThan(0.05);
  });
});
