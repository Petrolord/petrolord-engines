/**
 * Well Test U2-003 (rate-dependent skin) and U2-004 (correction to datum).
 */
import { rateDependentSkinFit, nonDarcyDFromF, GAS } from '../engines/welltest/gas.js';
import { datumCorrection } from '../engines/welltest/datum.js';
import { getModel, evaluateDrawdown } from '../engines/welltest/models/modelCatalog.js';
import { mdhAnalysis } from '../engines/welltest/analysis.js';

describe('U2-003 rate-dependent skin', () => {
  test('Ahmed (2010) Example 6-20, step 4: F 0.14, k 55 md, h 20 ft, T 600 degR give D = 1.805e-4 per Mscf/D', () => {
    expect(GAS.PD_FACTOR).toBe(1422);
    const D = nonDarcyDFromF({ F: 0.14, k: 55, h: 20, tempR: 600 });
    expect(Number(D.toPrecision(4))).toBe(1.805e-4);
    // negative control: the gas constant 1637 of the semilog slope in its place
    expect(Number(((0.14 * 55 * 20) / (1637 * 600)).toPrecision(4))).not.toBe(1.805e-4);
  });

  test("round trip through the engine: two drawdowns at two rates, each MDH skin, recover s and D", () => {
    // equivalent-liquid drawdowns (gas in m(p) is the liquid machinery with B_eq): the skin of each
    // run is s + D q; the MDH line of each recovers it, and the line through them recovers s and D
    const model = getModel('homogeneous');
    const truth = { s: 2, D: 4e-4 };
    const res = { h: 30, phi: 0.12, rw: 0.3, B: 1.1, mu: 0.02, ct: 1.5e-4, pi: 5000 };
    const times = Array.from({ length: 40 }, (_, i) => Math.pow(10, -1 + (3 * i) / 39));
    const points = [2000, 6000, 10000].map((q) => {
      const skin = truth.s + truth.D * q;
      const run = evaluateDrawdown({ model, params: { k: 20, skin, C: 0 }, reservoir: { ...res, q }, times });
      const late = run.filter((r) => r.t > 10).map((r) => ({ t: r.t, pwf: r.pw }));
      const mdh = mdhAnalysis({ points: late, ...res, q });
      return { q, skin: mdh.skin };
    });
    const fit = rateDependentSkinFit(points);
    expect(fit.ok).toBe(true);
    expect(fit.s).toBeCloseTo(truth.s, 1);
    expect(fit.D / truth.D).toBeCloseTo(1, 2);
    expect(fit.r2).toBeGreaterThan(0.9999);
    // negative control: the apparent skins read as true skins (D taken as zero) miss the true skin by D q
    expect(Math.abs(points[2].skin - truth.s)).toBeGreaterThan(3.5);
  });

  test('two rates give the line exactly; one rate is refused with the data need', () => {
    const fit = rateDependentSkinFit([{ q: 1000, skin: 3 }, { q: 3000, skin: 5 }]);
    expect(fit.s).toBeCloseTo(2, 12);
    expect(fit.D).toBeCloseTo(1e-3, 12);
    expect(fit.r2).toBeNull();
    const one = rateDependentSkinFit([{ q: 1000, skin: 3 }, { q: 1000, skin: 3.1 }]);
    expect(one.ok).toBe(false);
    expect(one.reason).toMatch(/different rates/);
  });
});

describe('U2-004 correction to datum', () => {
  test('a datum 200 ft below the gauge with 0.1 psi/ft adds 20 psi; above subtracts', () => {
    const c = datumCorrection({ gaugeTvd: 9900, refElevation: 100, datumTvdss: 10000, gradient: 0.1 });
    expect(c.ok).toBe(true);
    expect(c.gaugeTvdss).toBe(9800);
    expect(c.correction).toBeCloseTo(20, 12);
    expect(c.apply(4000)).toBeCloseTo(4020, 12);
    const up = datumCorrection({ gaugeTvdss: 10100, datumTvdss: 10000, gradient: 0.433 });
    expect(up.correction).toBeCloseTo(-43.3, 12);
  });

  test('no gradient stated: no correction, and the reason (owner default)', () => {
    const c = datumCorrection({ gaugeTvd: 9900, refElevation: 100, datumTvdss: 10000 });
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/No gradient was stated/);
    expect(datumCorrection({ gaugeTvd: 9900, datumTvdss: 10000, gradient: 0.1 }).reason).toMatch(/elevation of the depth reference/);
    expect(datumCorrection({ gaugeTvd: 9900, refElevation: 0, datumTvdss: 10000, gradient: 3 }).ok).toBe(false);
  });
});
