/**
 * U2-002 gas ratios (engines/wellsite/gasRatios.js).
 *
 * The formulas and the interpretation limits were read on the page in
 * Baker Hughes INTEQ, Advanced Logging Procedures Workbook (80269H Rev. C,
 * December 1995), pages 6-6 to 6-8, which restates Haworth, Sellens and
 * Whittaker (1985): Wh = 100 (C2+C3+C4+C5)/(C1..C5), Bh = (C1+C2)/(C3+C4+C5),
 * Ch = (C4+C5)/C3; Wh 0.5, 17.5 and 40; Bh 100; Ch 0.5. The Pixler C1/C2
 * limits under 2 (residual oil) and over 65 (light gas, non-productive) and
 * the oil gravity bands 2 to 4, 4 to 8, 8 to 15 were read in Diversified
 * Well Logging, "Gas Ratios, Short Overview" (2020).
 *
 * NO published worked example with C1 to C5 readings and printed Wh, Bh, Ch
 * could be read, so the numeric cases below are hand arithmetic on round
 * readings (written out in each test), one per interpretation band, with
 * the limits themselves tested on both sides. That is weaker than a
 * published case and the upgrade document says so.
 *
 * Negative controls: wetness without the factor of 100, C1 left in the
 * wetness numerator, and the balance ratio inverted each move a case into
 * another band.
 */
import { haworthRatios, haworthInterpretation, pixlerRatios, pixlerInterpretation, normaliseComponents, HAWORTH_LIMITS, PIXLER_LIMITS, pixlerOilGravity, percentToPpm, ppmToPercent } from '../engines/wellsite/gasRatios';

const read = (g) => { const r = haworthRatios(g); return { r, i: haworthInterpretation(r) }; };

describe('Haworth wetness, balance and character: hand arithmetic, one case per band', () => {
  test('very dry gas: C1 99,800, C2 150, C3 30, C4 15, C5 5 ppm', () => {
    // heavies 200 of 100,000: Wh = 0.2; Bh = 99,950 / 50 = 1999; Ch = 20 / 30 = 0.667
    const { r, i } = read({ c1: 99800, c2: 150, c3: 30, c4: 15, c5: 5 });
    expect(r.wh).toBeCloseTo(0.2, 12);
    expect(r.bh).toBeCloseTo(1999, 9);
    expect(r.ch).toBeCloseTo(2 / 3, 12);
    expect(i.code).toBe('very_dry_gas');
  });
  test('gas: C1 90,000, C2 6,000, C3 2,500, C4 1,000, C5 500 ppm', () => {
    // Wh = 100 x 10,000 / 100,000 = 10; Bh = 96,000 / 4,000 = 24 (above Wh); Ch = 1,500 / 2,500 = 0.6
    const { r, i } = read({ c1: 90000, c2: 6000, c3: 2500, c4: 1000, c5: 500 });
    expect(r.wh).toBeCloseTo(10, 12);
    expect(r.bh).toBeCloseTo(24, 12);
    expect(r.ch).toBeCloseTo(0.6, 12);
    expect(i.code).toBe('gas');
  });
  test('wet gas or condensate: C1 85,000, C2 4,000, C3 8,000, C4 2,000, C5 1,000 ppm', () => {
    // Wh = 15; Bh = 89,000 / 11,000 = 8.09 (below Wh); Ch = 3,000 / 8,000 = 0.375 (under 0.5)
    const { r, i } = read({ c1: 85000, c2: 4000, c3: 8000, c4: 2000, c5: 1000 });
    expect(r.wh).toBeCloseTo(15, 12);
    expect(r.bh).toBeCloseTo(89 / 11, 12);
    expect(r.ch).toBeCloseTo(0.375, 12);
    expect(i.code).toBe('gas_condensate');
  });
  test('gas associated with oil: C1 85,000, C2 4,000, C3 5,000, C4 4,000, C5 2,000 ppm', () => {
    // Wh = 15; Bh = 8.09; Ch = 6,000 / 5,000 = 1.2 (over 0.5)
    const { r, i } = read({ c1: 85000, c2: 4000, c3: 5000, c4: 4000, c5: 2000 });
    expect(r.ch).toBeCloseTo(1.2, 12);
    expect(i.code).toBe('gas_oil');
  });
  test('oil: C1 70,000, C2 12,000, C3 9,000, C4 6,000, C5 3,000 ppm', () => {
    // Wh = 30; Bh = 82,000 / 18,000 = 4.56 (below Wh)
    const { r, i } = read({ c1: 70000, c2: 12000, c3: 9000, c4: 6000, c5: 3000 });
    expect(r.wh).toBeCloseTo(30, 12);
    expect(r.bh).toBeCloseTo(82 / 18, 12);
    expect(i.code).toBe('oil');
  });
  test('residual oil: C1 50,000, C2 15,000, C3 15,000, C4 12,000, C5 8,000 ppm', () => {
    // Wh = 50
    const { r, i } = read({ c1: 50000, c2: 15000, c3: 15000, c4: 12000, c5: 8000 });
    expect(r.wh).toBeCloseTo(50, 12);
    expect(i.code).toBe('residual_oil');
  });
  test('the limits, on both sides', () => {
    const L = HAWORTH_LIMITS;
    expect([L.wetnessDry, L.wetnessOil, L.wetnessResidual, L.balanceDry, L.character]).toEqual([0.5, 17.5, 40, 100, 0.5]);
    expect(haworthInterpretation({ wh: 0.49, bh: 200, ch: 0.2 }).code).toBe('very_dry_gas');
    expect(haworthInterpretation({ wh: 0.5, bh: 200, ch: 0.2 }).code).toBe('gas');
    expect(haworthInterpretation({ wh: 17.49, bh: 30, ch: 0.2 }).code).toBe('gas');
    expect(haworthInterpretation({ wh: 17.5, bh: 5, ch: 0.2 }).code).toBe('oil');
    expect(haworthInterpretation({ wh: 40, bh: 2, ch: 1 }).code).toBe('oil');
    expect(haworthInterpretation({ wh: 40.01, bh: 2, ch: 1 }).code).toBe('residual_oil');
    expect(haworthInterpretation({ wh: 10, bh: 9.9, ch: 0.49 }).code).toBe('gas_condensate');
    expect(haworthInterpretation({ wh: 10, bh: 9.9, ch: 0.5 }).code).toBe('gas_oil');
    // a dry wetness whose balance does not confirm it says so
    expect(haworthInterpretation({ wh: 0.3, bh: 50, ch: 0.2 }).basis).toMatch(/check the readings/);
  });
  test('the ratios are unit free: percent gives what ppm gives', () => {
    const ppm = { c1: 90000, c2: 6000, c3: 2500, c4: 1000, c5: 500 };
    const pct = Object.fromEntries(Object.entries(ppm).map(([k, v]) => [k, ppmToPercent(v)]));
    expect(pct.c1).toBeCloseTo(9, 12);
    expect(percentToPpm(9)).toBe(90000);
    const a = haworthRatios(ppm); const b = haworthRatios(pct);
    expect(b.wh).toBeCloseTo(a.wh, 12); expect(b.bh).toBeCloseTo(a.bh, 12); expect(b.ch).toBeCloseTo(a.ch, 12);
  });
  test('iso and normal butane and pentane are summed', () => {
    const c = normaliseComponents({ c1: 100, c2: 10, c3: 5, ic4: 1, nc4: 2, ic5: 0.5, nc5: 0.5 });
    expect(c).toMatchObject({ ok: true, c4: 3, c5: 1 });
    expect(haworthRatios({ c1: 100, c2: 10, c3: 5, ic4: 1, nc4: 2, ic5: 0.5, nc5: 0.5 }).ch).toBeCloseTo(0.8, 12);
  });
  test('negative controls: the classic slips change the band', () => {
    const g = { c1: 90000, c2: 6000, c3: 2500, c4: 1000, c5: 500 };
    const { r } = read(g);
    // wetness as a fraction (no factor of 100) reads 0.1: very dry gas instead of gas
    expect(haworthInterpretation({ wh: r.wh / 100, bh: r.bh, ch: r.ch }).code).toBe('very_dry_gas');
    // C1 left in the numerator reads 100: residual oil
    expect(haworthInterpretation({ wh: 100, bh: r.bh, ch: r.ch }).code).toBe('residual_oil');
    // the balance inverted (heavies over lights) falls below the wetness: gas becomes gas with oil
    expect(haworthInterpretation({ wh: r.wh, bh: 1 / r.bh, ch: r.ch }).code).toBe('gas_oil');
  });
});

describe('hostile readings', () => {
  test('methane only: wetness 0, no balance or character, and it says why', () => {
    const r = haworthRatios({ c1: 5000 });
    expect(r).toMatchObject({ ok: true, wh: 0, bh: null, ch: null });
    expect(r.notes.join(' ')).toMatch(/balance ratio has no denominator/);
    expect(r.notes.join(' ')).toMatch(/character ratio has no denominator/);
    expect(haworthInterpretation(r).code).toBe('very_dry_gas');
    expect(pixlerRatios({ c1: 5000 })).toMatchObject({ c1c2: null, c1c3: null, c1c4: null, c1c5: null });
    expect(pixlerInterpretation(pixlerRatios({ c1: 5000 })).code).toBe('none');
  });
  test('all zeros: no ratio, never a division by a floor', () => {
    const r = haworthRatios({ c1: 0, c2: 0, c3: 0, c4: 0, c5: 0 });
    expect(r).toMatchObject({ ok: true, wh: null, bh: null, ch: null });
    expect(haworthInterpretation(r).code).toBe('none');
  });
  test('negative, missing and non-numeric components are refused', () => {
    expect(haworthRatios({ c1: 100, c2: -5 })).toMatchObject({ ok: false });
    expect(haworthRatios({ c1: 100, c2: -5 }).errors[0]).toMatch(/C2 is negative/);
    expect(haworthRatios({ c2: 5 }).errors.join(' ')).toMatch(/C1 \(methane\) is needed/);
    expect(pixlerRatios({ c1: 100, c3: NaN }).ok).toBe(false);
    expect(haworthRatios(null).ok).toBe(false);
  });
});

describe('Pixler ratios', () => {
  test('the ratios are C1 over each heavier component', () => {
    // 90,000 / 6,000 = 15; / 2,500 = 36; / 1,000 = 90; / 500 = 180
    const r = pixlerRatios({ c1: 90000, c2: 6000, c3: 2500, c4: 1000, c5: 500 });
    expect(r).toMatchObject({ ok: true, c1c2: 15, c1c3: 36, c1c4: 90, c1c5: 180 });
  });
  test('the C1/C2 limits 2, 15 and 65, on both sides', () => {
    expect([PIXLER_LIMITS.residual, PIXLER_LIMITS.oilGas, PIXLER_LIMITS.dryGas]).toEqual([2, 15, 65]);
    const code = (v) => pixlerInterpretation({ c1c2: v, c1c3: v * 2, c1c4: v * 3, c1c5: v * 4 }).code;
    expect(code(1.9)).toBe('residual_oil');
    expect(code(2)).toBe('oil');
    expect(code(14.9)).toBe('oil');
    expect(code(15)).toBe('gas');
    expect(code(65)).toBe('gas');
    expect(code(65.1)).toBe('dry_gas');
  });
  test('oil gravity bands on C1/C2: 2 to 4 low, 4 to 8 medium, 8 to 15 high', () => {
    expect(pixlerOilGravity(3)).toBe('low gravity oil');
    expect(pixlerOilGravity(4)).toBe('medium gravity oil');
    expect(pixlerOilGravity(7.9)).toBe('medium gravity oil');
    expect(pixlerOilGravity(8)).toBe('high gravity oil');
    expect(pixlerOilGravity(15)).toBeNull();
    expect(pixlerOilGravity(1)).toBeNull();
  });
  test('a ratio falling below the one before it is said (possibly water-bearing)', () => {
    const ok = pixlerInterpretation({ c1c2: 10, c1c3: 20, c1c4: 40, c1c5: 80 });
    expect(ok).toMatchObject({ code: 'oil', slopeOk: true, falls: [] });
    const bad = pixlerInterpretation({ c1c2: 10, c1c3: 20, c1c4: 12, c1c5: 80 });
    expect(bad.slopeOk).toBe(false);
    expect(bad.falls).toEqual(['C1/C4 is below C1/C3']);
    expect(bad.text).toMatch(/possibly water-bearing or non-productive/);
    // a missing ratio is skipped, the rest are still compared
    expect(pixlerInterpretation({ c1c2: 10, c1c3: null, c1c4: 5, c1c5: 80 }).falls).toEqual(['C1/C4 is below C1/C2']);
  });
  test('negative control: the ratio inverted (C2 over C1) reads residual oil for a gas', () => {
    const r = pixlerRatios({ c1: 90000, c2: 3000, c3: 1000, c4: 400, c5: 100 });
    expect(pixlerInterpretation(r).code).toBe('gas');
    expect(pixlerInterpretation({ c1c2: 1 / r.c1c2 }).code).toBe('residual_oil');
  });
});
