/**
 * Straight-line analysis round trips: data generated from the exponential-
 * integral line-source solution with known reservoir properties must be
 * recovered by the MDH and Horner analyses within engineering tolerance.
 */
import {
  linearFit,
  mdhAnalysis,
  hornerAnalysis,
  radiusOfInvestigation,
  skinPressureDrop,
  flowEfficiency,
  cartesianPssAnalysis,
  sqrtTimeAnalysis,
} from '../engines/welltest/analysis.js';
import { lineSourcePd } from '../engines/welltest/models/homogeneous.js';
import { toDimensionlessGroups } from '../engines/welltest/models/modelCatalog.js';

const TRUTH = { k: 50, skin: 5 };
const RESERVOIR = { phi: 0.2, mu: 1, ct: 1e-5, rw: 0.3, h: 30, B: 1.2, q: 300, pi: 5000 };
const groups = toDimensionlessGroups({ ...RESERVOIR, k: TRUTH.k });

const logspace = (a, b, n) =>
  Array.from({ length: n }, (_, i) => Math.pow(10, a + ((b - a) * i) / (n - 1)));

describe('linearFit', () => {
  test('exact line', () => {
    const fit = linearFit([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(fit.slope).toBeCloseTo(2, 12);
    expect(fit.intercept).toBeCloseTo(1, 12);
    expect(fit.r2).toBeCloseTo(1, 12);
  });

  test('degenerate inputs return null', () => {
    expect(linearFit([1], [2])).toBeNull();
    expect(linearFit([2, 2, 2], [1, 2, 3])).toBeNull();
  });
});

describe('MDH drawdown round trip (line-source synthetic, k=50 md, s=5)', () => {
  const points = logspace(0, 2, 30).map((t) => ({
    t,
    pwf: RESERVOIR.pi - groups.dpPerPd * (lineSourcePd(groups.tdPerHour * t) + TRUTH.skin),
  }));
  const result = mdhAnalysis({ points, ...RESERVOIR });

  test('recovers permeability within 1%', () => {
    expect(Math.abs(result.k - TRUTH.k) / TRUTH.k).toBeLessThan(0.01);
    expect(result.kh).toBeCloseTo(result.k * RESERVOIR.h, 8);
  });

  test('recovers skin within 0.15', () => {
    expect(Math.abs(result.skin - TRUTH.skin)).toBeLessThan(0.15);
  });

  test('semilog slope matches m = 162.6 qBmu/kh', () => {
    const expected = (162.6 * RESERVOIR.q * RESERVOIR.B * RESERVOIR.mu) / (TRUTH.k * RESERVOIR.h);
    expect(Math.abs(result.m - expected) / expected).toBeLessThan(0.01);
  });

  test('fit quality is reported', () => {
    expect(result.r2).toBeGreaterThan(0.9999);
    expect(result.n).toBe(30);
  });

  test('returns null without enough usable points', () => {
    expect(mdhAnalysis({ points: [{ t: 1, pwf: 4000 }], ...RESERVOIR })).toBeNull();
  });
});

describe('Horner buildup round trip (line-source superposition, k=50 md, s=5)', () => {
  const tp = 24;
  const pd = (tHours) => lineSourcePd(groups.tdPerHour * tHours);
  const pwfShutIn = RESERVOIR.pi - groups.dpPerPd * (pd(tp) + TRUTH.skin);
  const points = logspace(-1, 2, 40).map((dt) => ({
    dt,
    pws: RESERVOIR.pi - groups.dpPerPd * (pd(tp + dt) - pd(dt)),
  }));
  const result = hornerAnalysis({ points, tp, pwfShutIn, ...RESERVOIR });

  test('recovers permeability within 2%', () => {
    expect(Math.abs(result.k - TRUTH.k) / TRUTH.k).toBeLessThan(0.02);
  });

  test('recovers skin within 0.2', () => {
    expect(Math.abs(result.skin - TRUTH.skin)).toBeLessThan(0.2);
  });

  test('p* extrapolates to initial pressure for an infinite-acting system', () => {
    expect(Math.abs(result.pStar - RESERVOIR.pi)).toBeLessThan(2);
  });

  test('requires a positive producing time', () => {
    expect(hornerAnalysis({ points, tp: 0, pwfShutIn, ...RESERVOIR })).toBeNull();
  });
});

describe('derived quantities', () => {
  test('radius of investigation reference case', () => {
    // sqrt(100 * 9.48 / (948 * 0.2 * 1 * 1e-5)) = sqrt(500000)
    const ri = radiusOfInvestigation({ k: 100, tHours: 9.48, phi: 0.2, mu: 1, ct: 1e-5 });
    expect(ri).toBeCloseTo(Math.sqrt(500000), 6);
  });

  test('skin pressure drop reference case', () => {
    // 141.2 * 300 * 1.2 * 1 * 5 / (50 * 30) = 169.44 psi
    const dp = skinPressureDrop({ q: 300, B: 1.2, mu: 1, k: 50, h: 30, skin: 5 });
    expect(dp).toBeCloseTo(169.44, 2);
  });

  test('flow efficiency', () => {
    expect(flowEfficiency({ pAvg: 3000, pwf: 2500, dpSkin: 100 })).toBeCloseTo(0.8, 12);
    expect(flowEfficiency({ pAvg: 3000, pwf: 3000, dpSkin: 0 })).toBeNaN();
  });
});

describe('Cartesian PSS analysis', () => {
  test('recovers pore volume from a linear decline', () => {
    const mStar = 0.5; // psi/hr
    const points = Array.from({ length: 20 }, (_, i) => ({ t: 100 + i, pwf: 4000 - mStar * (100 + i) }));
    const result = cartesianPssAnalysis({ points, q: 300, B: 1.2, ct: 1e-5 });
    expect(result.mStar).toBeCloseTo(0.5, 8);
    // Vp = 0.23396 * 300 * 1.2 / (1e-5 * 0.5) ft^3
    expect(result.poreVolumeFt3).toBeCloseTo((0.23396 * 360) / 5e-6, 3);
    expect(result.poreVolumeMMbbl).toBeCloseTo(3.0, 1);
  });
});

describe('sqrt-time analysis', () => {
  test('recovers the linear-flow slope', () => {
    const points = Array.from({ length: 25 }, (_, i) => {
      const t = (i + 1) * 0.4;
      return { t, dp: 4 + 2 * Math.sqrt(t) };
    });
    const result = sqrtTimeAnalysis({ points });
    expect(result.slope).toBeCloseTo(2, 8);
    expect(result.intercept).toBeCloseTo(4, 8);
    expect(result.r2).toBeCloseTo(1, 10);
  });
});
