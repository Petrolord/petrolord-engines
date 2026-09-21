import {
  pwdLaplaceHomogeneous,
  pwdHomogeneous,
  lineSourcePd,
  radialSemilogPwd,
} from '../engines/welltest/models/homogeneous.js';
import {
  getModel,
  defaultParams,
  toDimensionlessGroups,
  evaluateDrawdown,
  evaluateBuildup,
  evaluateModelTest,
  OILFIELD,
} from '../engines/welltest/models/modelCatalog.js';
import { bourdetDerivative } from '../engines/welltest/derivative.js';

const relErr = (actual, expected) =>
  Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-300);

const RESERVOIR = {
  phi: 0.2,
  mu: 1,
  ct: 1e-5,
  rw: 0.3,
  h: 30,
  B: 1.2,
  q: 300,
  pi: 5000,
};

describe('homogeneous model dimensionless behavior (analytic identity gates)', () => {
  test('finite-radius solution matches the line source once tD >> 25', () => {
    for (const tD of [1e3, 1e4, 1e6]) {
      const finite = pwdHomogeneous(tD, { skin: 0, cd: 0 });
      const line = lineSourcePd(tD);
      expect(relErr(finite, line)).toBeLessThan(5e-3);
    }
  });

  test('radial semilog asymptote pwD = 0.5(ln tD + 0.80907) + S', () => {
    for (const tD of [1e4, 1e6]) {
      expect(relErr(pwdHomogeneous(tD, { skin: 0, cd: 0 }), radialSemilogPwd(tD))).toBeLessThan(5e-3);
    }
  });

  test('positive skin adds S to the late-time response', () => {
    const tD = 1e4;
    const shift = pwdHomogeneous(tD, { skin: 5, cd: 0 }) - pwdHomogeneous(tD, { skin: 0, cd: 0 });
    expect(shift).toBeCloseTo(5, 2);
  });

  test('negative skin follows the effective-wellbore-radius mapping', () => {
    const tD = 1e6;
    const expected = radialSemilogPwd(tD, -2);
    expect(relErr(pwdHomogeneous(tD, { skin: -2, cd: 0 }), expected)).toBeLessThan(1e-2);
  });

  test('early-time wellbore storage unit slope pwD = tD / CD', () => {
    const cd = 1000;
    for (const tD of [0.5, 1, 2]) {
      expect(relErr(pwdHomogeneous(tD, { skin: 0, cd }), tD / cd)).toBeLessThan(0.02);
    }
  });

  test('dimensionless Bourdet derivative stabilizes at 0.5 in radial flow', () => {
    const params = { skin: 3, cd: 100 };
    // storage dies out well before tD ~ 60 CD; sample far beyond it
    const tDs = Array.from({ length: 41 }, (_, i) => Math.pow(10, 5 + (2 * i) / 40));
    const series = tDs.map((tD) => ({ x: tD, y: pwdHomogeneous(tD, params) }));
    const deriv = bourdetDerivative(series, { L: 0.1 });
    const mid = deriv.slice(8, deriv.length - 8);
    for (const p of mid) {
      expect(relErr(p.derivative, 0.5)).toBeLessThan(0.01);
    }
  });

  test('Laplace solution guards invalid arguments', () => {
    expect(pwdLaplaceHomogeneous(0)).toBeNaN();
    expect(pwdLaplaceHomogeneous(-1)).toBeNaN();
    expect(pwdHomogeneous(0, {})).toBeNaN();
  });
});

describe('model catalog and dimensional evaluation', () => {
  const model = getModel('homogeneous');

  test('catalog exposes the homogeneous model with parameter metadata', () => {
    expect(model).toBeTruthy();
    const keys = model.parameters.map((p) => p.key);
    expect(keys).toEqual(['k', 'skin', 'C']);
    expect(defaultParams(model)).toEqual({ k: 50, skin: 0, C: 0.01 });
    expect(getModel('nope')).toBeNull();
  });

  test('dimensionless groups reproduce the standard SPE factors', () => {
    const g = toDimensionlessGroups({ ...RESERVOIR, k: 50 });
    // tdPerHour = 0.0002637 * 50 / (0.2 * 1 * 1e-5 * 0.09)
    expect(g.tdPerHour).toBeCloseTo(73250, 0);
    // dpPerPd = 141.2 * 300 * 1.2 * 1 / (50 * 30)
    expect(g.dpPerPd).toBeCloseTo(33.888, 3);
    // cdPerBblPsi = 0.8936 / (0.2 * 1e-5 * 30 * 0.09)
    expect(relErr(g.cdPerBblPsi, 0.8936 / (0.2 * 1e-5 * 30 * 0.09))).toBeLessThan(1e-12);
  });

  test('drawdown without storage matches the dimensional semilog line', () => {
    const params = { k: 50, skin: 0, C: 0 };
    const g = toDimensionlessGroups({ ...RESERVOIR, k: 50 });
    const [point] = evaluateDrawdown({ model, params, reservoir: RESERVOIR, times: [10] });
    const expected = g.dpPerPd * radialSemilogPwd(g.tdPerHour * 10);
    expect(relErr(point.dp, expected)).toBeLessThan(5e-3);
    expect(point.pw).toBeCloseTo(RESERVOIR.pi - point.dp, 10);
  });

  test('buildup returns to initial pressure at long shut-in (infinite acting)', () => {
    const params = { k: 50, skin: 5, C: 0.01 };
    const tp = 24;
    const points = evaluateBuildup({ model, params, reservoir: RESERVOIR, tp, dts: [0.01, 1, 24000] });
    expect(points.pwfAtShutIn).toBeLessThan(RESERVOIR.pi);
    // dp grows monotonically with shut-in time
    expect(points[0].dp).toBeLessThan(points[1].dp);
    // long shut-in: pws within a psi of pi
    expect(Math.abs(points[2].pws - RESERVOIR.pi)).toBeLessThan(1);
  });

  test('evaluateModelTest dispatches by test type', () => {
    const params = { k: 50, skin: 0, C: 0 };
    const dd = evaluateModelTest({ testType: 'drawdown', model, params, reservoir: RESERVOIR, times: [10] });
    const bu = evaluateModelTest({ testType: 'buildup', model, params, reservoir: RESERVOIR, tp: 24, dts: [10] });
    expect(dd[0].dp).toBeGreaterThan(0);
    expect(bu[0].dp).toBeGreaterThan(0);
  });

  test('oilfield constants are the published values', () => {
    expect(OILFIELD.TD_FACTOR).toBe(0.0002637);
    expect(OILFIELD.PD_FACTOR).toBe(141.2);
    expect(OILFIELD.CD_FACTOR).toBe(0.8936);
    expect(OILFIELD.SEMILOG_SLOPE).toBe(162.6);
    expect(OILFIELD.DERIVATIVE_PLATEAU).toBe(70.6);
  });
});
