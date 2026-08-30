/**
 * WT6 closed-rectangle model vs the independent Python oracle
 * (tools/validation/welltest/oracle.py rect_pd_time, a REAL-TIME
 * theta-duality route with no Laplace, no Stehfest and no K0). Regenerate
 * goldens with:
 *   python3 tools/validation/welltest/genfixtures.py
 *
 * The full gate set (Dietz shape factors, channel degeneracy, off-center
 * auto-fit round trip) lives in tools/validation/welltest/run-validation.mjs
 * CASE 10; this suite keeps the fast subset in jest.
 */
import fs from 'fs';
import path from 'path';
import { stehfestInvert } from '../engines/welltest/numerics.js';
import {
  rectangleSandfaceLaplace,
  rectanglePssIntercept,
  makeRectanglePwdLaplace,
} from '../engines/welltest/models/rectangle.js';
import { pwdLaplaceHomogeneous } from '../engines/welltest/models/homogeneous.js';
import { getModel, defaultParams, evaluateDrawdown } from '../engines/welltest/models/modelCatalog.js';

const goldens = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../test-data/welltest/goldens.json'), 'utf8')
);

const relErr = (actual, expected) =>
  Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-300);

const SQUARE = { xeD: 4000, yeD: 4000, xwD: 2000, ywD: 2000 };

describe('WT6 closed rectangle vs oracle goldens', () => {
  test('lattice route agrees with the real-time theta route on all geometries', () => {
    expect(goldens.closedRectangle.length).toBeGreaterThan(0);
    for (const row of goldens.closedRectangle) {
      const geom = { xeD: row.xeD, yeD: row.yeD, xwD: row.xwD, ywD: row.ywD };
      const ours = stehfestInvert((u) => rectangleSandfaceLaplace(u, geom), row.tD);
      expect(relErr(ours, row.pwd)).toBeLessThan(2e-3);
    }
  });
});

describe('WT6 closed rectangle analytic truths', () => {
  test('boundary-invisible early time collapses onto the homogeneous model', () => {
    for (const tD of [1e3, 1e5]) {
      const rect = stehfestInvert((u) => rectangleSandfaceLaplace(u, SQUARE), tD);
      const homog = stehfestInvert((u) => pwdLaplaceHomogeneous(u, {}), tD);
      expect(relErr(rect, homog)).toBeLessThan(1e-6);
    }
  });

  test('late time follows the exact PSS line 2 pi tDA + b with the Dietz square constant', () => {
    const AD = SQUARE.xeD * SQUARE.yeD;
    const b = rectanglePssIntercept(SQUARE);
    // published Dietz shape factor for the centered square, CA = 30.8828
    expect(relErr((2.2458 * AD) / Math.exp(2 * b), 30.8828)).toBeLessThan(1e-3);
    for (const tDA of [0.5, 2]) {
      const pwd = stehfestInvert((u) => rectangleSandfaceLaplace(u, SQUARE), tDA * AD);
      expect(relErr(pwd, 2 * Math.PI * tDA + b)).toBeLessThan(2e-3);
    }
  });

  test('storage and skin compose identically to the WT1 formula when boundaries are far', () => {
    const pwdLaplace = makeRectanglePwdLaplace();
    const far = { xeD: 4e6, yeD: 4e6, xwD: 2e6, ywD: 2e6, skin: 4, cd: 500 };
    for (const tD of [1e2, 1e5]) {
      const rect = stehfestInvert((u) => pwdLaplace(u, far), tD);
      const homog = stehfestInvert((u) => pwdLaplaceHomogeneous(u, { skin: 4, cd: 500 }), tD);
      expect(relErr(rect, homog)).toBeLessThan(1e-8);
    }
  });

  test('invalid geometry returns NaN instead of a plausible number', () => {
    expect(rectangleSandfaceLaplace(1, { xeD: 0, yeD: 100, xwD: 1, ywD: 1 })).toBeNaN();
    expect(rectangleSandfaceLaplace(1, { xeD: 100, yeD: 100, xwD: 200, ywD: 1 })).toBeNaN();
    expect(rectangleSandfaceLaplace(-1, SQUARE)).toBeNaN();
  });
});

describe('WT6 catalog wiring', () => {
  test('the closed-rectangle entry is metadata-complete and evaluates finite', () => {
    const model = getModel('homogeneous-closed-rectangle');
    expect(model).toBeTruthy();
    expect(model.parameters.map((p) => p.key)).toEqual(
      ['k', 'skin', 'C', 'L1', 'L2', 'W1', 'W2']
    );
    const skinMeta = model.parameters.find((p) => p.key === 'skin');
    expect(skinMeta.min).toBe(0); // additive Laplace skin: S >= 0 only
    const series = evaluateDrawdown({
      model,
      params: defaultParams(model),
      reservoir: { phi: 0.18, mu: 0.9, ct: 1.2e-5, rw: 0.354, h: 45, B: 1.25, q: 450, pi: 4800 },
      times: [0.1, 1, 10, 100, 1000],
    });
    for (const point of series) {
      expect(Number.isFinite(point.dp)).toBe(true);
      expect(point.dp).toBeGreaterThan(0);
    }
    // monotonic drawdown through the PSS tail
    for (let i = 1; i < series.length; i += 1) {
      expect(series[i].dp).toBeGreaterThan(series[i - 1].dp);
    }
  });
});
