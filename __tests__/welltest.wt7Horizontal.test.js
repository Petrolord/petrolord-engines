/**
 * WT7 horizontal-well model vs the independent Python oracle
 * (tools/validation/welltest/oracle.py hw_pd_time, a REAL-TIME erf x theta
 * route with no Laplace, no Stehfest and no K0). Regenerate goldens with:
 *   python3 tools/validation/welltest/genfixtures.py
 *
 * The full gate set (regime plateaus, thin-slab = fracture + pseudo-skin,
 * dimensional 70.6/(Lw sqrt(kh kv)) identity, auto-fit round trip) lives in
 * tools/validation/welltest/run-validation.mjs CASE 11; this suite keeps the
 * fast subset in jest.
 */
import fs from 'fs';
import path from 'path';
import { stehfestInvert } from '../engines/welltest/numerics.js';
import { horizontalSandfaceLaplace, makeHorizontalPwdLaplace } from '../engines/welltest/models/horizontal.js';
import { getModel, defaultParams, evaluateDrawdown } from '../engines/welltest/models/modelCatalog.js';

const goldens = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../test-data/welltest/goldens.json'), 'utf8')
);

const relErr = (actual, expected) =>
  Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-300);

const CENTERED = { hD: 0.5, zwD: 0.25, zobsD: 0.251 };

describe('WT7 horizontal well vs oracle goldens', () => {
  test('mode-plus-image Laplace route agrees with the real-time erf x theta route', () => {
    expect(goldens.horizontalWell.length).toBeGreaterThan(0);
    for (const row of goldens.horizontalWell) {
      const geom = { hD: row.hD, zwD: row.zwD, zobsD: row.zobsD };
      const ours = stehfestInvert((v) => horizontalSandfaceLaplace(v, geom), row.tDL);
      expect(relErr(ours, row.pwd)).toBeLessThan(2e-3);
    }
  });
});

describe('WT7 horizontal well analytic truths', () => {
  const pwd = (geom, tDL) =>
    stehfestInvert((v) => horizontalSandfaceLaplace(v, geom), tDL);
  const logDeriv = (geom, tDL) => {
    const e = 1.02;
    return (pwd(geom, tDL * e) - pwd(geom, tDL / e)) / (2 * Math.log(e));
  };

  test('early vertical-radial derivative plateau is hD/4', () => {
    expect(relErr(logDeriv(CENTERED, 3e-3), CENTERED.hD / 4)).toBeLessThan(5e-3);
  });

  test('late pseudoradial derivative plateau is 0.5 on kh h', () => {
    expect(relErr(logDeriv(CENTERED, 1e4), 0.5)).toBeLessThan(2e-3);
  });

  test('invalid geometry returns NaN instead of a plausible number', () => {
    expect(horizontalSandfaceLaplace(1, { hD: 0, zwD: 0.1, zobsD: 0.11 })).toBeNaN();
    expect(horizontalSandfaceLaplace(1, { hD: 0.5, zwD: 0.6, zobsD: 0.61 })).toBeNaN();
    expect(horizontalSandfaceLaplace(-1, CENTERED)).toBeNaN();
  });

  test('storage and skin compose through the shared wellbore composition', () => {
    const pwdLaplace = makeHorizontalPwdLaplace();
    const base = { lhOverRw: 2824.86, ...CENTERED, skin: 0, cd: 0 };
    const skinned = { ...base, skin: 3 };
    const tDrw = 1e9; // rw-based late time
    const a = stehfestInvert((u) => pwdLaplace(u, base), tDrw);
    const b = stehfestInvert((u) => pwdLaplace(u, skinned), tDrw);
    expect(Math.abs(b - a - 3)).toBeLessThan(0.01); // additive skin on kh h
  });
});

describe('WT7 catalog wiring', () => {
  test('the horizontal-well entry is metadata-complete and evaluates finite', () => {
    const model = getModel('horizontal-well');
    expect(model).toBeTruthy();
    expect(model.parameters.map((p) => p.key)).toEqual(
      ['k', 'kvkh', 'Lw', 'zwFrac', 'skin', 'C']
    );
    expect(model.parameters.find((p) => p.key === 'skin').min).toBe(0);
    const series = evaluateDrawdown({
      model,
      params: defaultParams(model),
      reservoir: { phi: 0.18, mu: 0.9, ct: 1.2e-5, rw: 0.354, h: 45, B: 1.25, q: 450, pi: 4800 },
      times: [0.01, 0.1, 1, 10, 100, 1000],
    });
    for (const point of series) {
      expect(Number.isFinite(point.dp)).toBe(true);
      expect(point.dp).toBeGreaterThan(0);
    }
    for (let i = 1; i < series.length; i += 1) {
      expect(series[i].dp).toBeGreaterThan(series[i - 1].dp);
    }
  });
});
