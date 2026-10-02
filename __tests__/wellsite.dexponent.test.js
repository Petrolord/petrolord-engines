/**
 * U2-006 d-exponent and corrected d-exponent (engines/wellsite/dExponent.js).
 *
 * PUBLISHED, read on the page:
 *  - Lapeyrouse, "Formulas and Calculations for Drilling, Production and
 *    Workover", printed pages 131 to 132: R = 30 ft/hr, N = 120 rpm,
 *    W = 35,000 lb, D = 8.5 in gives d = 1.82; d = 1.64 with a 9.0 ppg normal
 *    gradient and 12.7 ppg in use gives dc = 1.16.
 *  - drillingformulas.com, "d-exponent calculation" and "corrected
 *    d-exponent": R = 90, N = 110, W = 20,000 lb, D = 8.5 in gives d = 1.20;
 *    9.0 over 12.0 ppg gives dc = 0.9.
 * REMEMBERED, the page was not readable (arithmetic agrees): Bourgoyne et
 * al., Applied Drilling Engineering (SPE, 1986), the d-exponent example:
 * R = 23 ft/hr, 9.875 in bit, W = 25,500 lbf, N = 113 rpm, ECD 9.5 lbm/gal,
 * normal 0.465 psi/ft: d = 1.64, modified d = 1.54.
 *
 * Negative controls: each classic slip (the 60 left out, the weight in lb
 * against the thousand-pound constant, the mud weight ratio inverted) is
 * computed beside the engine and lands away from the published answer.
 */
import { dExponentField, dExponent, correctedDExponent, fitNormalTrend, trendAt, trendDeparture, GULF_COAST_NORMAL_PPG, M_PER_FT, M_PER_IN, N_PER_LBF } from '../engines/wellsite/dExponent';

describe('published d-exponent cases', () => {
  test('Lapeyrouse pp. 131 to 132: d = 1.82', () => {
    const r = dExponentField({ ropFtHr: 30, rpm: 120, wobLbf: 35000, bitIn: 8.5 });
    expect(r.ok).toBe(true);
    expect(r.d).toBeCloseTo(1.82, 2);
    expect(r.ropTerm).toBeCloseTo(0.0042, 4);
    expect(r.wobTerm).toBeCloseTo(0.0494, 4);
  });
  test('Lapeyrouse pp. 131 to 132: dc = 1.64 x 9.0 / 12.7 = 1.16', () => {
    const r = correctedDExponent({ d: 1.64, normalMudWeight: 9.0, mudWeight: 12.7 });
    expect(r.ok).toBe(true);
    expect(r.dc).toBeCloseTo(1.16, 2);
  });
  test('drillingformulas.com: d = 1.20 and dc = 0.9', () => {
    const r = dExponentField({ ropFtHr: 90, rpm: 110, wobLbf: 20000, bitIn: 8.5 });
    expect(r.d).toBeCloseTo(1.20, 2);
    expect(correctedDExponent({ d: r.d, normalMudWeight: 9.0, mudWeight: 12.0 }).dc).toBeCloseTo(0.9, 2);
  });
  test('Bourgoyne (remembered, arithmetic agrees): d = 1.64, modified d = 1.54 on 0.465 psi/ft', () => {
    const r = dExponentField({ ropFtHr: 23, rpm: 113, wobLbf: 25500, bitIn: 9.875 });
    expect(r.d).toBeCloseTo(1.64, 2);
    expect(GULF_COAST_NORMAL_PPG).toBeCloseTo(8.94, 2);
    expect(correctedDExponent({ d: 1.64, normalMudWeight: GULF_COAST_NORMAL_PPG, mudWeight: 9.5 }).dc).toBeCloseTo(1.54, 2);
  });
  test('negative controls: the classic slips do not give the published 1.82 and 1.16', () => {
    const no60 = Math.log10(30 / 120) / Math.log10((12 * 35000) / (1e6 * 8.5));
    expect(Math.abs(no60 - 1.82)).toBeGreaterThan(1);
    const lbAgainstThousand = (12 * 35000) / (1000 * 8.5); // 49.4: its logarithm is positive, the exponent negative
    expect(Math.log10(30 / (60 * 120)) / Math.log10(lbAgainstThousand)).toBeLessThan(0);
    expect(Math.abs(1.64 * (12.7 / 9.0) - 1.16)).toBeGreaterThan(1);
  });
});

describe('units and refusals', () => {
  test('SI inputs give the same exponent as the field inputs', () => {
    const f = dExponentField({ ropFtHr: 30, rpm: 120, wobLbf: 35000, bitIn: 8.5 });
    const s = dExponent({ ropMPerHr: 30 * M_PER_FT, rpm: 120, wobN: 35000 * N_PER_LBF, bitM: 8.5 * M_PER_IN });
    expect(s.d).toBeCloseTo(f.d, 12);
  });
  test('the mud weight ratio is unit free: sg and kg/m3 give the same dc as ppg', () => {
    const ppg = correctedDExponent({ d: 1.5, normalMudWeight: 9, mudWeight: 12 }).dc;
    expect(correctedDExponent({ d: 1.5, normalMudWeight: 9 * 0.119826, mudWeight: 12 * 0.119826 }).dc).toBeCloseTo(ppg, 12);
    expect(correctedDExponent({ d: 1.5, normalMudWeight: 9 * 119.826, mudWeight: 12 * 119.826 }).dc).toBeCloseTo(ppg, 12);
  });
  test('zero, negative and out of range inputs are refused with a reason', () => {
    expect(dExponentField({ ropFtHr: 0, rpm: 120, wobLbf: 35000, bitIn: 8.5 })).toMatchObject({ ok: false, reason: expect.stringMatching(/rate of penetration/) });
    expect(dExponentField({ ropFtHr: 30, rpm: 0, wobLbf: 35000, bitIn: 8.5 }).ok).toBe(false);
    expect(dExponentField({ ropFtHr: 30, rpm: 120, wobLbf: -1, bitIn: 8.5 }).ok).toBe(false);
    expect(dExponentField({ ropFtHr: 30, rpm: 120, wobLbf: 35000, bitIn: NaN }).ok).toBe(false);
    // more than a foot per revolution; more than 83,333 lbf per inch of bit
    expect(dExponentField({ ropFtHr: 8000, rpm: 120, wobLbf: 35000, bitIn: 8.5 }).reason).toMatch(/foot or more per revolution/);
    expect(dExponentField({ ropFtHr: 30, rpm: 120, wobLbf: 800000, bitIn: 8.5 }).reason).toMatch(/83,333 lbf per inch/);
    expect(correctedDExponent({ d: NaN, normalMudWeight: 9, mudWeight: 12 }).ok).toBe(false);
    expect(correctedDExponent({ d: 1.5, normalMudWeight: 9, mudWeight: 0 }).ok).toBe(false);
    expect(correctedDExponent({ d: 1.5, normalMudWeight: 0, mudWeight: 12 }).ok).toBe(false);
  });
});

describe('the normal trend', () => {
  // dc = 1.0 x 10^(0.0001 z): a straight line on the semi-log plot
  const normal = [1000, 1500, 2000, 2500].map((z) => ({ depth: z, dc: 10 ** (0.0001 * z) }));
  test('a semi-log straight line is recovered exactly', () => {
    const t = fitNormalTrend(normal);
    expect(t.ok).toBe(true);
    expect(t.slope).toBeCloseTo(0.0001, 12);
    expect(t.intercept).toBeCloseTo(0, 10);
    expect(t.at(3000)).toBeCloseTo(10 ** 0.3, 10);
    expect(trendAt(t, 3000)).toBeCloseTo(t.at(3000), 12);
  });
  test('a dc 20 percent under the trend is flagged; one 5 percent under is not', () => {
    const t = fitNormalTrend(normal);
    const dep = trendDeparture([{ depth: 3000, dc: 0.8 * t.at(3000) }, { depth: 3100, dc: 0.95 * t.at(3100) }], t);
    expect(dep[0].ratio).toBeCloseTo(0.8, 12);
    expect(dep[0].below).toBe(true);
    expect(dep[1].below).toBe(false);
    // negative control: a linear (not semi-log) fit of the same points misses the trend at depth
    const lin = (() => { const n = normal.length; const sx = normal.reduce((a, p) => a + p.depth, 0); const sy = normal.reduce((a, p) => a + p.dc, 0); const sxx = normal.reduce((a, p) => a + p.depth * p.depth, 0); const sxy = normal.reduce((a, p) => a + p.depth * p.dc, 0); const b = (n * sxy - sx * sy) / (n * sxx - sx * sx); return (z) => (sy - b * sx) / n + b * z; })();
    expect(Math.abs(lin(6000) - t.at(6000))).toBeGreaterThan(0.5);
  });
  test('fewer than two points, or one depth, is refused', () => {
    expect(fitNormalTrend([{ depth: 1000, dc: 1.2 }]).ok).toBe(false);
    expect(fitNormalTrend([{ depth: 1000, dc: 1.2 }, { depth: 1000, dc: 1.3 }]).reason).toMatch(/one depth/);
    expect(fitNormalTrend([{ depth: 1000, dc: -1 }, { depth: 2000, dc: 0 }]).ok).toBe(false);
    expect(trendDeparture([{ depth: 1, dc: 1 }], null)).toEqual([]);
  });
});
