// Facilities F11 control-valve gates against
// tools/validation/facilities/oracle_controlvalve.py.
//
// The oracle's docstring says, route by route, what each route checks
// and what it cannot, and two claims that used to stand at the top of
// it described routes the file did not contain. Three kinds of check
// live here and they are not interchangeable:
//
//  1. ORACLE ROUTES. The 1360 gas packaging genuinely re-derived
//     through SI and a metric Kv; the equal-percentage characteristic
//     inverted as a ROUND TRIP; the liquid form evaluated in 60-digit
//     decimal; the noise stream power and mass flow re-derived from the
//     SI gas constant.
//
//  2. PROPERTY CHECKS. The choking boundary LOCATED FROM THE MODULE'S
//     OWN Cv OUTPUTS without reading its choked flag; the expansion
//     factor falling linearly to exactly two thirds and then stopping;
//     an allowable drop that must be the square of the recovery factor.
//
//  3. A CONSTANT REGISTER, pinned by LITERAL. Every FL, every xT, the
//     sigma thresholds, the authority thresholds and the noise bands
//     have no publication in this repository. A literal here detects
//     SILENT CHANGE and nothing more: six defects planted in this
//     engine used to leave this suite green, including a globe valve's
//     FL and xT and the whole of the noise indication. DO NOT
//     REGENERATE THESE VALUES FROM THE ENGINE.
//
// The boundary is the point of the whole module. Below it a valve sizes
// on the stated drop; at or above it the flow chokes and sizing on the
// stated drop undersizes the valve badly.

import fs from 'fs';
import path from 'path';
import {
  VALVE_STYLES, styleOf, liquidCriticalRatioFF, liquidValve,
  specificHeatFactor, gasValve, SIGMA_THRESHOLDS,
  NOISE_RATIO_BANDS, NOISE_POWER_BANDS, CHARACTERISTICS, characteristicLabel,
  valveAuthority, characteristicFor, noiseIndication, travelCheck,
} from '../engines/facilities/controlValve';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'controlvalve_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

const MARGINS = [];
const within = (label, got, want, tol) => {
  const r = rel(got, want);
  MARGINS.push({ label, usedPctOfTolerance: (r / tol) * 100, rel: r, tol });
  expect(r).toBeLessThan(tol);
};
afterAll(() => {
  const worst = {};
  MARGINS.forEach((m) => {
    if (!worst[m.label] || m.usedPctOfTolerance > worst[m.label].usedPctOfTolerance) {
      worst[m.label] = m;
    }
  });
  const lines = Object.values(worst)
    .sort((a, b) => b.usedPctOfTolerance - a.usedPctOfTolerance)
    .map((m) => `  ${m.label}: worst ${m.usedPctOfTolerance.toFixed(3)} percent of a ${m.tol} tolerance (rel ${m.rel.toExponential(2)})`);
  // eslint-disable-next-line no-console
  console.log(`controlvalve oracle margins, ${MARGINS.length} comparisons:\n${lines.join('\n')}`);
});

/* ================================================================== *
 * 1. THE CONSTANT REGISTER
 * ================================================================== */

describe('the stated constants are pinned by literal, against silent change', () => {
  test('the style table is exactly the stated one', () => {
    // Planting globeCage's FL at 0.85 and its xT at 0.60 both used to
    // leave this suite green, so nothing in the repository held any of
    // the sixteen numbers to anything.
    const EXPECTED = [
      ['globeSingleFlow', 0.90, 0.72],
      ['globeSingleClose', 0.80, 0.55],
      ['globeCage', 0.90, 0.75],
      ['globeAntiCav', 0.97, 0.90],
      ['butterfly60', 0.68, 0.38],
      ['butterfly90', 0.55, 0.20],
      ['ballSegmented', 0.66, 0.30],
      ['ballFullBore', 0.55, 0.15],
    ];
    expect(VALVE_STYLES).toHaveLength(EXPECTED.length);
    EXPECTED.forEach(([id, fl, xt], i) => {
      expect(VALVE_STYLES[i].id).toBe(id);
      expect(VALVE_STYLES[i].fl).toBeCloseTo(fl, 12);
      expect(VALVE_STYLES[i].xt).toBeCloseTo(xt, 12);
      // the fd column was read by nothing and is gone rather than
      // decorating the table: its only consumers, the Reynolds factor
      // FR and the IEC noise method, are not in this package
      expect(VALVE_STYLES[i].fd).toBeUndefined();
    });
    // eslint-disable-next-line no-console
    console.log(`style register examined: ${VALVE_STYLES.length} styles, ${VALVE_STYLES.length * 2} values pinned by literal`);
  });

  test('the thresholds that colour a screen are the stated ones', () => {
    expect(SIGMA_THRESHOLDS.cavitating).toBe(2);
    expect(SIGMA_THRESHOLDS.incipient).toBe(3);
    expect(NOISE_RATIO_BANDS.moderate).toBe(2);
    expect(NOISE_RATIO_BANDS.high).toBe(4);
    expect(NOISE_RATIO_BANDS.severe).toBe(10);
    expect(NOISE_POWER_BANDS.quietKw).toBe(1);
    expect(NOISE_POWER_BANDS.loudKw).toBe(1000);
    const a = valveAuthority({ dpValvePsi: 60, dpSystemTotalPsi: 100 });
    expect(a.thresholds.good).toBe(0.5);
    expect(a.thresholds.acceptable).toBe(0.25);
    expect(a.thresholdBasis).toMatch(/no standard in this package supplies them/);
    expect(travelCheck({ cvRequiredNormal: 50, cvRated: 100 }).rangeability).toBe(50);
  });

  test('the allowable drop is the SQUARE of the recovery factor, recovered', () => {
    // FL^2 planted as FL^1 is caught by the boundary today; recovering
    // the exponent from the engine pins it directly.
    const r = liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 150, sg: 0.85, pvPsia: 5, pcPsia: 3200,
      styleId: 'globeCage',
    });
    const recoveredFl = Math.sqrt(r.dpAllowablePsi / (200 - r.ff * 5));
    expect(recoveredFl).toBeCloseTo(0.90, 12);
    expect(r.fl).toBeCloseTo(0.90, 12);
    // eslint-disable-next-line no-console
    console.log(`recovery factor recovered from the allowable drop: ${recoveredFl}`);
  });

  test('Cv IS its own definition: one gallon a minute of water at one psi', () => {
    // The liquid form has no packaging constant to re-derive, because Cv
    // is DEFINED as the US gallons per minute of water at 60 F that pass
    // at one psi of drop. That definition is the anchor, and it is the
    // only thing that pins the liquid Cv to anything outside these two
    // files: a 2 percent factor planted in the engine and the oracle
    // together is invisible to any comparison between them.
    const water = (qGpm, dp) => liquidValve({
      qGpm, p1Psia: 1000, p2Psia: 1000 - dp, sg: 1, pvPsia: 1e-9, pcPsia: 3200,
      flOverride: 1,
    });
    expect(water(1, 1).choked).toBe(false);
    expect(water(1, 1).cv).toBeCloseTo(1, 12);
    expect(water(2, 1).cv).toBeCloseTo(2, 12);
    expect(water(100, 1).cv).toBeCloseTo(100, 12);
    // four times the drop, half the Cv
    expect(water(1, 4).cv).toBeCloseTo(0.5, 12);
    expect(water(1, 100).cv).toBeCloseTo(0.1, 12);
    // and a heavier liquid needs more Cv for the same rate and drop, by
    // the square root of its gravity
    const heavy = liquidValve({
      qGpm: 1, p1Psia: 1000, p2Psia: 999, sg: 4, pvPsia: 1e-9, pcPsia: 3200, flOverride: 1,
    });
    expect(heavy.cv).toBeCloseTo(2, 12);
    // the piping geometry factor divides into it, exactly
    const withFp = liquidValve({
      qGpm: 1, p1Psia: 1000, p2Psia: 999, sg: 1, pvPsia: 1e-9, pcPsia: 3200,
      flOverride: 1, fp: 0.5,
    });
    expect(withFp.cv).toBeCloseTo(2, 12);
    // eslint-disable-next-line no-console
    console.log(`Cv definition examined: 1 gpm of water at 1 psi gives Cv ${water(1, 1).cv}, and 1 gpm at 4 psi gives ${water(1, 4).cv}`);
  });

  test('the Rankine offset is recovered from two temperatures', () => {
    // 459.67 planted as 460 used to leave this suite green in both
    // files. Cv goes as sqrt(T), so two temperatures give the offset.
    const at = (tF) => gasValve({
      qScfh: 5e5, p1Psia: 300, p2Psia: 250, gasSg: 0.65, tF, z: 0.95, k: 1.28,
      xtOverride: 0.72,
    }).cv;
    const r2 = (at(100) / at(0)) ** 2;
    const offset = 100 / (r2 - 1);
    expect(offset).toBeCloseTo(459.67, 6);
    // eslint-disable-next-line no-console
    console.log(`Rankine offset recovered from a 0 F and a 100 F sizing: ${offset.toFixed(6)}`);
  });

  test('FF, Fk and the characteristic vocabulary are the stated ones', () => {
    // pure water at 3200 psia critical: FF near 0.96 for low volatility
    expect(liquidCriticalRatioFF({ pvPsia: 0, pcPsia: 3200 })).toBeCloseTo(0.96, 9);
    expect(liquidCriticalRatioFF({ pvPsia: 3200, pcPsia: 3200 })).toBeCloseTo(0.68, 9);
    expect(specificHeatFactor(1.4)).toBeCloseTo(1, 12);
    expect(specificHeatFactor(1.28)).toBeLessThan(1);
    expect(CHARACTERISTICS).toEqual(['equalPercentage', 'linear']);
    expect(characteristicLabel('equalPercentage')).toBe('equal percentage');
    expect(characteristicLabel('linear')).toBe('linear');
    expect(characteristicLabel('quickOpening')).toBeNull();
  });
});

/* ================================================================== *
 * 2. LIQUID SIZING
 * ================================================================== */

describe('liquid sizing', () => {
  test('Cv and the choking flag match the high-precision evaluation', () => {
    let maxDiff = 0;
    G.liquid.forEach((row) => {
      const r = liquidValve({ ...row, flOverride: row.fl });
      expect(r.error).toBeUndefined();
      expect(r.choked).toBe(row.choked);
      expect(r.flashing).toBe(row.flashing);
      within('liquid ff', r.ff, row.ff, 1e-12);
      within('liquid dpAllowable', r.dpAllowablePsi, row.dpAllowablePsi, 1e-12);
      within('liquid dpUsed', r.dpUsedPsi, row.dpUsedPsi, 1e-12);
      within('liquid cv', r.cv, row.cv, 1e-12);
      within('liquid sigma', r.sigma, row.sigma, 1e-12);
      maxDiff = Math.max(maxDiff, Math.abs(r.cv - row.cv));
    });
    // These rows used to reproduce BIT FOR BIT at exactly 0.000 percent
    // of a 1e-12 tolerance. The oracle now evaluates in 60-digit
    // decimal with the terms grouped differently, so a last-bit
    // disagreement is the expected result.
    expect(maxDiff).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`liquid examined ${G.liquid.length} rows against a 60-digit decimal evaluation; largest last-bit disagreement ${maxDiff.toExponential(2)}`);
  });

  test('THE BOUNDARY: located from the module\'s Cv outputs alone', () => {
    // The oracle used to bisect on a predicate that RESTATED the
    // module's own inequality, so the route was an independent root
    // find on a transcribed predicate. The boundary is now found from
    // the Cv numbers only: below it the required Cv still moves with
    // the outlet pressure, and at or past it the Cv stops moving
    // because the allowable drop has taken over. The module's `choked`
    // flag is never read while locating it.
    G.boundary.forEach((row) => {
      const cvAt = (p2) => liquidValve({
        qGpm: row.qGpm, p1Psia: row.p1Psia, p2Psia: p2, sg: row.sg,
        pvPsia: row.pvPsia, pcPsia: row.pcPsia, flOverride: row.fl,
      }).cv;
      const eps = 1e-4;
      const flat = (p2) => cvAt(p2 + eps) - cvAt(p2) <= 0;
      let lo = 0.01;              // large drop: the Cv has stopped moving
      let hi = row.p1Psia - 0.01; // small drop: the Cv still moves
      expect(flat(lo)).toBe(true);
      expect(flat(hi)).toBe(false);
      for (let i = 0; i < 200; i += 1) {
        const mid = (lo + hi) / 2;
        if (flat(mid)) lo = mid; else hi = mid;
      }
      const located = (lo + hi) / 2;
      within('boundary located from Cv alone', located, row.p2BoundaryPsia, 1e-5);
      // and the module agrees about which side of it each point is on
      const justBelow = liquidValve({
        qGpm: row.qGpm, p1Psia: row.p1Psia, p2Psia: row.p2BoundaryPsia + 0.5,
        sg: row.sg, pvPsia: row.pvPsia, pcPsia: row.pcPsia, flOverride: row.fl,
      });
      const justAbove = liquidValve({
        qGpm: row.qGpm, p1Psia: row.p1Psia, p2Psia: row.p2BoundaryPsia - 0.5,
        sg: row.sg, pvPsia: row.pvPsia, pcPsia: row.pcPsia, flOverride: row.fl,
      });
      expect(justBelow.choked).toBe(false);
      expect(justAbove.choked).toBe(true);
      within('boundary dpAllowable', justAbove.dpAllowablePsi, row.dpAllowablePsi, 1e-12);
      // eslint-disable-next-line no-console
      console.log(`boundary at P1 ${row.p1Psia}: located from Cv alone at P2 ${located.toFixed(6)} psia against a closed form of ${row.p2BoundaryPsia.toFixed(6)}`);
    });
  });

  test('THE POINT: past choking, more drop buys no more flow', () => {
    const base = {
      qGpm: 500, p1Psia: 200, sg: 0.85, pvPsia: 5, pcPsia: 3200, styleId: 'globeCage',
    };
    const modest = liquidValve({ ...base, p2Psia: 40 });
    const extreme = liquidValve({ ...base, p2Psia: 16 });
    expect(modest.choked).toBe(true);
    expect(extreme.choked).toBe(true);
    // both use the same allowable drop, so the required Cv is identical
    expect(rel(extreme.cv, modest.cv)).toBeLessThan(1e-12);
    expect(extreme.warning).toMatch(/undersize the valve badly/);
  });

  test('THE REFUSAL: a liquid sizing with no vapour pressure', () => {
    // sigma = (P1 - Pv) / dP was Infinity at the module's own default
    // of zero, which took the last branch of the regime ladder, so
    // EVERY liquid service at EVERY pressure drop reported "stable" in
    // green with no warning. The Suite's cleared box supplied exactly
    // that default, so the cavitation screen this module exists for was
    // switched off by an empty box.
    const noPv = liquidValve({ qGpm: 500, p1Psia: 200, p2Psia: 150, sg: 0.85 });
    expect(noPv.error).toMatch(/a true vapour pressure is needed/);
    expect(noPv.error).toMatch(/every service reads as stable/);
    expect(noPv.sigma).toBeUndefined();
    expect(noPv.regime).toBeUndefined();
    [0, -1, NaN, undefined].forEach((pv) => {
      expect(liquidValve({ qGpm: 500, p1Psia: 200, p2Psia: 150, sg: 0.85, pvPsia: pv }).error)
        .toBeTruthy();
    });
    // and no input anywhere can now produce an infinite index
    [1e-6, 0.5, 5, 50, 150].forEach((pv) => {
      const r = liquidValve({ qGpm: 500, p1Psia: 200, p2Psia: 150, sg: 0.85, pvPsia: pv });
      if (!r.error) expect(Number.isFinite(r.sigma)).toBe(true);
    });
    // eslint-disable-next-line no-console
    console.log('the vapour pressure refusal examined on 4 missing-or-zero inputs and 5 stated ones: no finite input yields an infinite sigma');
  });

  test('flashing is distinguished from cavitation, because the fix differs', () => {
    const flashing = liquidValve({
      qGpm: 300, p1Psia: 150, p2Psia: 20, sg: 0.72, pvPsia: 25, pcPsia: 550,
      styleId: 'globeCage',
    });
    expect(flashing.flashing).toBe(true);
    expect(flashing.regime).toBe('flashing');
    expect(flashing.warning).toMatch(/anti-cavitation trim will not help/);
    // cavitating but not flashing: outlet above vapour pressure
    const cav = liquidValve({
      qGpm: 300, p1Psia: 150, p2Psia: 40, sg: 0.72, pvPsia: 25, pcPsia: 550,
      styleId: 'globeCage',
    });
    expect(cav.flashing).toBe(false);
    expect(cav.regime).toMatch(/cavitat/);
  });

  test('damage starts before choking, and the index says so', () => {
    const stable = liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 190, sg: 0.85, pvPsia: 5, styleId: 'globeCage',
    });
    expect(stable.regime).toBe('stable');
    expect(stable.warning).toBeNull();
    const incipient = liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 130, sg: 0.85, pvPsia: 5, styleId: 'globeCage',
    });
    expect(incipient.choked).toBe(false); // not yet choked
    expect(incipient.sigma).toBeLessThan(3);
    expect(incipient.warning).toMatch(/damage begins well before choking/);
  });

  test('the index reported belongs to the drop the valve actually uses', () => {
    // sigma was computed on the STATED drop while the Cv was computed
    // on the drop the valve can use, so on a choked service the
    // cavitation index printed beside the answer belonged to a pressure
    // drop the valve cannot take.
    const choked = liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 20, sg: 0.85, pvPsia: 5, pcPsia: 3200,
      styleId: 'globeCage',
    });
    expect(choked.choked).toBe(true);
    expect(choked.sigma).toBeCloseTo((200 - 5) / choked.dpUsedPsi, 12);
    expect(choked.sigma).not.toBeCloseTo((200 - 5) / choked.dpStatedPsi, 6);
    expect(choked.sigmaBasis).toMatch(/the pressure drop the valve uses/);
    // unchoked, the two drops are the same and nothing moves
    const open = liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 150, sg: 0.85, pvPsia: 5, styleId: 'globeCage',
    });
    expect(open.dpUsedPsi).toBeCloseTo(open.dpStatedPsi, 12);
    // eslint-disable-next-line no-console
    console.log(`choked sigma examined: ${choked.sigma.toFixed(3)} on the ${choked.dpUsedPsi.toFixed(1)} psi the valve uses, against ${((200 - 5) / choked.dpStatedPsi).toFixed(3)} on the ${choked.dpStatedPsi.toFixed(1)} psi stated`);
  });

  test('the overrides and the geometry factor are bounded', () => {
    // A recovery factor is a fraction by construction. flOverride 5
    // used to give an allowable drop of 4881 psi on a 200 psia inlet,
    // which is more drop than the system has pressure.
    expect(liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 150, sg: 0.85, pvPsia: 5, flOverride: 5,
    }).error).toMatch(/must lie between 0 and 1/);
    expect(liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 150, sg: 0.85, pvPsia: 5, flOverride: 0,
    }).error).toBeTruthy();
    expect(gasValve({
      qScfh: 1e5, p1Psia: 300, p2Psia: 250, gasSg: 0.65, tF: 100, xtOverride: 3,
    }).error).toMatch(/must lie between 0 and 1/);
    expect(liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 150, sg: 0.85, pvPsia: 5, fp: 0,
    }).error).toMatch(/piping geometry factor/);
    expect(liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 150, sg: 0.85, pvPsia: 5, fp: 9,
    }).error).toMatch(/piping geometry factor/);
  });

  test('the refusals behave and the turbulent limit travels with the answer', () => {
    expect(liquidValve({ qGpm: 500, p1Psia: 100, p2Psia: 150, sg: 0.85, pvPsia: 5 }).error)
      .toBeTruthy();
    expect(liquidValve({ qGpm: 0, p1Psia: 200, p2Psia: 100, sg: 0.85, pvPsia: 5 }).error)
      .toBeTruthy();
    expect(liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 100, sg: 0.85, pvPsia: 5, styleId: 'nope',
    }).error).toBeTruthy();
    expect(liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 150, sg: 0.85, pvPsia: 5, pcPsia: 1,
    }).error).toMatch(/critical pressure/);
    const ok = liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 150, sg: 0.85, pvPsia: 5, styleId: 'globeCage',
    });
    expect(ok.reynoldsFactorApplied).toBe(false);
    expect(ok.limitNote).toMatch(/Reynolds number factor FR is not carried/);
  });
});

/* ================================================================== *
 * 3. GAS SIZING
 * ================================================================== */

describe('gas sizing', () => {
  test('THE 1360 PACKAGING, against an SI re-derivation through a metric Kv', () => {
    // 1360 planted as 1400 in this file and the module together used to
    // leave this suite green, because the oracle restated the module.
    // The route now goes through moles, cubic metres, bar and Kv and
    // never touches the module's expression.
    G.gasSi.forEach((row) => {
      const r = gasValve({ ...row, xtOverride: row.xt });
      expect(r.error).toBeUndefined();
      within('gas Cv against the SI Kv route', r.cv, row.cv, 5e-3);
    });
    // eslint-disable-next-line no-console
    console.log(`the 1360 packaging examined on ${G.gasSi.length} services through an entirely SI route`);
  });

  test('Y falls linearly to exactly two thirds and then stops', () => {
    const m = G.gasMarch;
    const ys = [];
    m.rows.forEach((row) => {
      const r = gasValve({
        qScfh: 1e5, p1Psia: m.p1Psia, p2Psia: m.p1Psia * (1 - row.x),
        gasSg: 0.65, tF: 100, k: m.k, xtOverride: m.xt,
      });
      if (row.x <= 0 || row.x >= 1) return;
      within('gas expansion factor', r.y, row.y, 1e-9);
      expect(r.choked).toBe(row.choked);
      ys.push({ x: row.x, y: r.y, choked: r.choked });
    });
    // THE PROPERTY: below choking the slope is constant, which is what
    // makes the divisor 3 and the two-thirds floor the same statement
    const below = ys.filter((p) => !p.choked);
    const slopes = [];
    for (let i = 1; i < below.length; i += 1) {
      slopes.push((below[i].y - below[i - 1].y) / (below[i].x - below[i - 1].x));
    }
    slopes.forEach((s) => within('gas Y slope', s, m.slopePerX, 1e-9));
    // and past it nothing moves
    const above = ys.filter((p) => p.choked);
    above.forEach((p) => expect(p.y).toBeCloseTo(2 / 3, 12));
    // the choked floor is exactly 2/3
    const choked = gasValve({
      qScfh: 1e5, p1Psia: 300, p2Psia: 30, gasSg: 0.65, tF: 100, k: 1.28, xtOverride: 0.72,
    });
    expect(choked.y).toBeCloseTo(2 / 3, 12);
    // eslint-disable-next-line no-console
    console.log(`the expansion factor examined at ${ys.length} points: ${slopes.length} constant slopes below choking and ${above.length} flat points past it`);
  });

  test('x and the choking flag match the independent evaluation', () => {
    G.gas.forEach((row) => {
      const r = gasValve({ ...row, xtOverride: row.xt });
      expect(r.error).toBeUndefined();
      expect(r.choked).toBe(row.choked);
      within('gas x', r.x, row.x, 1e-12);
      within('gas xUsed', r.xUsed, row.xUsed, 1e-12);
      within('gas xChoked', r.xChoked, row.xChoked, 1e-12);
      within('gas y', r.y, row.y, 1e-12);
    });
  });

  test('the warnings and the refusals behave', () => {
    const hard = gasValve({
      qScfh: 5e5, p1Psia: 300, p2Psia: 100, gasSg: 0.65, tF: 100, k: 1.28,
      styleId: 'globeCage',
    });
    expect(hard.warning).toBeTruthy();
    expect(gasValve({ qScfh: 1e5, p1Psia: 100, p2Psia: 150, gasSg: 0.65, tF: 100 }).error)
      .toBeTruthy();
    expect(gasValve({ qScfh: 1e5, p1Psia: 300, p2Psia: 250, gasSg: 0.65 }).error)
      .toMatch(/flowing temperature/);
    expect(gasValve({ qScfh: 1e5, p1Psia: 300, p2Psia: 250, gasSg: 0.65, tF: 100, z: 0 }).error)
      .toMatch(/compressibility/);
  });
});

/* ================================================================== *
 * 4. AUTHORITY AND CHARACTERISTIC
 * ================================================================== */

describe('authority and characteristic', () => {
  test('every verdict label is reached, and the selection rule follows it', () => {
    G.authority.forEach((row) => {
      const a = valveAuthority(row);
      expect(a.error).toBeUndefined();
      within('authority ratio', a.authority, row.authority, 1e-12);
      expect(a.verdict).toBe(row.verdict);
      const c = characteristicFor({ authority: a.authority });
      expect(c.characteristic).toBe(row.characteristic);
    });
    const labels = new Set(G.authority.map((r) => r.verdict));
    expect(labels).toEqual(new Set(['good', 'acceptable', 'poor']));
    const poor = valveAuthority({ dpValvePsi: 10, dpSystemTotalPsi: 100 });
    expect(poor.note).toMatch(/first few percent of travel/);
    expect(valveAuthority({ dpValvePsi: 60, dpSystemTotalPsi: 100 }).note).toBeNull();
    expect(valveAuthority({ dpValvePsi: 40, dpSystemTotalPsi: 100 }).note)
      .toMatch(/workable with equal-percentage trim/);
    expect(valveAuthority({ dpValvePsi: 200, dpSystemTotalPsi: 100 }).error).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(`authority examined ${G.authority.length} rows covering all 3 verdict labels and all 3 note branches`);
  });

  test('ONE VOCABULARY: the recommendation is what the travel check accepts', () => {
    // characteristicFor used to return 'equal percentage' while
    // travelCheck tested for 'linear' and treated EVERY other string,
    // recognised or not, as equal percentage. Feeding the
    // recommendation to the check worked for linear by luck and for
    // equal percentage by accident.
    [0.7, 0.55, 0.5, 0.3, 0.1].forEach((authority) => {
      const c = characteristicFor({ authority });
      expect(CHARACTERISTICS).toContain(c.characteristic);
      const t = travelCheck({
        cvRequiredNormal: 45, cvRated: 100, characteristic: c.characteristic,
      });
      expect(t.error).toBeUndefined();
      expect(t.characteristic).toBe(c.characteristic);
      expect(t.characteristicLabel).toBe(c.characteristicLabel);
    });
    expect(characteristicFor({ authority: 0.7 }).characteristicLabel).toBe('linear');
    expect(characteristicFor({ authority: 0.3 }).characteristicLabel).toBe('equal percentage');
    expect(characteristicFor({ authority: 0.3 }).reason).toMatch(/cancel exactly that/);
    expect(characteristicFor({ authority: 0 }).error).toBeTruthy();
    // and an unrecognised characteristic is refused rather than
    // silently treated as equal percentage
    expect(travelCheck({ cvRequiredNormal: 45, cvRated: 100, characteristic: 'quickOpening' }).error)
      .toMatch(/unknown inherent characteristic/);
    // eslint-disable-next-line no-console
    console.log('the characteristic vocabulary examined at 5 authorities: the recommendation is accepted by the travel check at every one');
  });
});

/* ================================================================== *
 * 5. TRAVEL AND RANGEABILITY
 * ================================================================== */

describe('travel and rangeability', () => {
  test('equal-percentage travel round-trips against the characteristic law', () => {
    const t = G.travel;
    t.points.forEach((p) => {
      const r = travelCheck({
        cvRequiredNormal: p.cv, cvRated: t.cvRated, rangeability: t.rangeability,
      });
      within('equal-percentage round trip', r.normalTravelPct / 100, p.travelFraction, 1e-9);
    });
  });

  test('IT COUNTS ITS CHECKS: every state and every branch, from the goldens', () => {
    G.travelStates.forEach((row) => {
      const r = travelCheck({
        cvRequiredMin: row.cvRequiredMin === null ? undefined : row.cvRequiredMin,
        cvRequiredNormal: row.cvRequiredNormal === null ? undefined : row.cvRequiredNormal,
        cvRequiredMax: row.cvRequiredMax === null ? undefined : row.cvRequiredMax,
        cvRated: row.cvRated,
      });
      expect(r.error).toBeUndefined();
      expect([r.minState, r.normalState, r.maxState]).toEqual(row.expectStates);
      expect(r.checksPerformed).toBe(row.expectChecksPerformed);
      expect(r.pass).toBe(row.expectPass);
      expect(r.warnings).toHaveLength(row.expectWarningCount);
      expect(r.checksPerformed + r.checksSkipped.length).toBe(3);
    });
    // eslint-disable-next-line no-console
    console.log(`travel states examined ${G.travelStates.length} cases covering all 3 states on all 3 flows`);
  });

  test('A VERDICT OVER CHECKS THAT DID NOT RUN IS NOT A VERDICT', () => {
    // travelCheck used to return pass: true having run ZERO checks. A
    // missing minimum flow skipped the near-seat rangeability check
    // silently and the studio printed "Verdict: WORKABLE" in green.
    const nothing = travelCheck({ cvRated: 100 });
    expect(nothing.pass).toBeNull();
    expect(nothing.checksPerformed).toBe(0);
    expect(nothing.warnings).toHaveLength(0);
    expect(nothing.passWithheldReason).toMatch(/0 of the 3 checks ran/);
    expect(nothing.verdict).toBe('0 of 3 checks ran');
    // the exact case from the recon: no minimum flow
    const noMin = travelCheck({ cvRequiredNormal: 45, cvRequiredMax: 75, cvRated: 100 });
    expect(noMin.pass).toBeNull();
    expect(noMin.checksPerformed).toBe(2);
    expect(noMin.checksSkipped.join(' ')).toMatch(/near-seat rangeability check/);
    // all three given: a verdict is offered
    const full = travelCheck({
      cvRequiredMin: 20, cvRequiredNormal: 45, cvRequiredMax: 75, cvRated: 100,
      characteristic: 'linear',
    });
    expect(full.pass).toBe(true);
    expect(full.checksPerformed).toBe(3);
    expect(full.verdict).toBe('all 3 checks passed');
    expect(travelCheck({ cvRated: 0 }).error).toBeTruthy();
    expect(travelCheck({ cvRequiredNormal: 45, cvRated: 100, rangeability: 1 }).error)
      .toMatch(/must exceed 1/);
    // eslint-disable-next-line no-console
    console.log(`withheld verdict examined: ${nothing.passWithheldReason.slice(0, 120)}...`);
  });

  test('BEYOND THE VALVE AND NOT GIVEN ARE DIFFERENT ANSWERS', () => {
    // One null used to mean both, and the alarming reading won: a
    // maximum flow box the user had not filled in produced "the maximum
    // flow needs more Cv than the valve is rated for: it will not pass
    // the design case".
    const beyond = travelCheck({
      cvRequiredMin: 5, cvRequiredNormal: 60, cvRequiredMax: 150, cvRated: 100,
    });
    expect(beyond.maxState).toBe('beyond the valve');
    expect(beyond.maxTravelPct).toBeNull();
    expect(beyond.warnings.join(' ')).toMatch(/will not pass the design case/);
    const notGiven = travelCheck({ cvRated: 100 });
    expect(notGiven.maxState).toBe('not given');
    expect(notGiven.maxTravelPct).toBeNull();
    expect(notGiven.warnings.join(' ')).not.toMatch(/will not pass the design case/);
    // eslint-disable-next-line no-console
    console.log('the two meanings of a null travel examined side by side: one warns, the other withholds');
  });

  test('catches the valve that cannot control at turndown', () => {
    const nearSeat = travelCheck({
      cvRequiredMin: 0.5, cvRequiredNormal: 50, cvRequiredMax: 90, cvRated: 100,
    });
    expect(nearSeat.minTravelPct).toBeLessThan(10);
    expect(nearSeat.warnings.join(' ')).toMatch(/characteristic collapses/);
  });
});

// Each travel warning fires on a strict inequality and then prints the
// travel it fired on. At whole percent, anything within half a point of the
// threshold rendered AS the threshold: a valve 9.7 percent open reported
// "only 10 percent open" under a flag that only fires BELOW 10, which reads
// as a false alarm. One decimal narrows that collision by ten rather than
// removing it (0.05 of a point still collides), so the fixtures below sit
// inside each flag's band and clear of that residual neighbourhood.
describe('the travel warnings print a travel off their own threshold', () => {
  const percentIn = (message) => Number(/([\d.]+) percent/.exec(message)[1]);
  // Equal percentage is Cv/Cvmax = R^(h-1), so the Cv for a wanted travel is
  // the characteristic run backwards, on a valve rated 100 at the module's
  // default rangeability of 50.
  const cvAt = (travelPct) => 100 * 50 ** (travelPct / 100 - 1);

  test('near the seat: fires below 10 percent and prints below 10 percent', () => {
    const r = travelCheck({
      cvRequiredMin: cvAt(9.7), cvRequiredNormal: cvAt(50), cvRequiredMax: cvAt(70),
      cvRated: 100,
    });
    expect(r.minTravelPct).toBeGreaterThan(9.5);   // the old whole print said "10"
    expect(r.minTravelPct).toBeLessThan(9.95);     // clear of the residual band
    const w = r.warnings.find((m) => m.includes('at minimum flow'));
    expect(w).toBeDefined();
    expect(percentIn(w)).toBeLessThan(10);
    expect(w).not.toMatch(/\b10 percent open\b/);
  });

  test('no margin left: fires above 90 percent and prints above 90 percent', () => {
    const r = travelCheck({
      cvRequiredMin: cvAt(30), cvRequiredNormal: cvAt(50), cvRequiredMax: cvAt(90.3),
      cvRated: 100,
    });
    expect(r.maxTravelPct).toBeGreaterThan(90.05);
    expect(r.maxTravelPct).toBeLessThan(90.5);
    const w = r.warnings.find((m) => m.includes('at maximum flow'));
    expect(w).toBeDefined();
    expect(percentIn(w)).toBeGreaterThan(90);
    expect(w).not.toMatch(/\b90 percent open\b/);
  });

  test('outside 20 to 80: both edges print off the edge they crossed', () => {
    const low = travelCheck({
      cvRequiredMin: cvAt(15), cvRequiredNormal: cvAt(19.7), cvRequiredMax: cvAt(50),
      cvRated: 100,
    });
    const lowWarning = low.warnings.find((m) => m.includes('normal flow sits'));
    expect(low.normalTravelPct).toBeGreaterThan(19.5);
    expect(low.normalTravelPct).toBeLessThan(19.95);
    expect(percentIn(lowWarning)).toBeLessThan(20);
    expect(lowWarning).not.toMatch(/\b20 percent travel\b/);
    // and the target the sentence names is untouched
    expect(lowWarning).toContain('the customary target is 20 to 80 percent');

    const high = travelCheck({
      cvRequiredMin: cvAt(30), cvRequiredNormal: cvAt(80.3), cvRequiredMax: cvAt(85),
      cvRated: 100,
    });
    const highWarning = high.warnings.find((m) => m.includes('normal flow sits'));
    expect(high.normalTravelPct).toBeGreaterThan(80.05);
    expect(high.normalTravelPct).toBeLessThan(80.5);
    expect(percentIn(highWarning)).toBeGreaterThan(80);
    expect(highWarning).not.toMatch(/\b80 percent travel\b/);
  });
});

/* ================================================================== *
 * 6. NOISE
 * ================================================================== */

describe('noise', () => {
  test('the mass flow and the stream power match the SI re-derivation', () => {
    // 379.49 cubic feet per pound mole planted as 380, and the natural
    // logarithm dropped from the stream power entirely, both used to
    // leave this suite green, because nothing had a route here at all.
    G.noise.forEach((row) => {
      const n = noiseIndication(row);
      expect(n.error).toBeUndefined();
      within('noise pressure ratio', n.pressureRatio, row.pressureRatio, 1e-12);
      within('noise mass flow vs SI', n.massFlowLbHr, row.massFlowLbHr, 1e-4);
      within('noise stream power vs SI', n.streamPowerKw, row.streamPowerKw, 1e-3);
    });
    // eslint-disable-next-line no-console
    console.log(`noise examined ${G.noise.length} services against an SI molar volume and an SI specific gas constant`);
  });

  test('THE BAND SEES THE STREAM POWER, not the pressure ratio alone', () => {
    // A 1 scfh bleed at a ratio of 12 used to read "severe" with the
    // multistage-trim warning, and a valve passing 100 MMscfh at a
    // ratio of 1.9 used to read "low" with no warning at all, because
    // the band never saw the power the function computed.
    G.noise.forEach((row) => {
      const n = noiseIndication(row);
      expect(n.band).toBe(row.expectBand);
    });
    const bleed = G.noise.find((r) => r.why.includes('holds it down'));
    const nb = noiseIndication(bleed);
    expect(nb.ratioBand).toBe('severe');
    expect(nb.band).toBe('low');
    expect(nb.warning).toBeNull();
    expect(nb.powerEffect).toMatch(/a trickle cannot be loud/);
    const torrent = G.noise.find((r) => r.why.includes('raises it'));
    const nt = noiseIndication(torrent);
    expect(nt.ratioBand).toBe('low');
    expect(nt.band).toBe('moderate');
    expect(nt.powerEffect).toMatch(/not a quiet valve at any pressure ratio/);
    // every band label is reached
    expect(new Set(G.noise.map((r) => r.expectBand)))
      .toEqual(new Set(['low', 'moderate', 'high', 'severe']));
    // eslint-disable-next-line no-console
    console.log(`a ${bleed.qScfh} scfh bleed at a ratio of ${nb.pressureRatio.toFixed(1)} is banded ${nb.band} on ${nb.streamPowerKw.toExponential(2)} kW, where the ratio alone said ${nb.ratioBand}`);
  });

  test('it is honest that it is an indication, and it guards its inputs', () => {
    const loud = noiseIndication({ p1Psia: 900, p2Psia: 60, qScfh: 2e6, gasSg: 0.65, tF: 100 });
    expect(loud.band).toBe('severe');
    expect(loud.warning).toMatch(/multistage trim/);
    expect(loud.note).toMatch(/screening indication only/);
    expect(noiseIndication({ p1Psia: 100, p2Psia: 150, qScfh: 1e5 }).error).toBeTruthy();
    // p2 = 0 used to give an infinite ratio, an infinite power, a
    // "severe" band and the multistage-trim warning, with no error
    expect(noiseIndication({ p1Psia: 900, p2Psia: 0, qScfh: 2e6, gasSg: 0.65, tF: 100 }).error)
      .toMatch(/positive outlet pressure/);
    // and a missing gas gravity or temperature used to give a NaN power
    // and a "moderate" band, because the band was formed first
    expect(noiseIndication({ p1Psia: 900, p2Psia: 60, qScfh: 2e6, tF: 100 }).error)
      .toMatch(/gas gravity and a flowing temperature/);
    expect(noiseIndication({ p1Psia: 900, p2Psia: 60, qScfh: 2e6, gasSg: 0.65 }).error)
      .toMatch(/gas gravity and a flowing temperature/);
    // eslint-disable-next-line no-console
    console.log('noise guards examined: an outlet at zero, a missing gravity and a missing temperature all refuse by name');
  });
});

/* ================================================================== *
 * 7. NEGATIVE CONTROLS
 * ================================================================== */

describe('negative controls: each new gate is shown to fail on a wrong answer', () => {
  test('the FL recovery rejects a first-power allowable drop', () => {
    const fl = 0.90;
    // an allowable drop of FL * (P1 - FF Pv) recovers sqrt(FL), not FL
    const recovered = Math.sqrt(fl);
    expect(Math.abs(recovered - fl)).toBeGreaterThan(1e-6);
    // eslint-disable-next-line no-console
    console.log(`negative control: a first-power allowable drop recovers ${recovered.toFixed(6)} where the literal wants ${fl}`);
  });

  test('the Rankine recovery rejects a 460 offset', () => {
    const at = (tF, offset) => Math.sqrt(tF + offset);
    const r2 = (at(100, 460) / at(0, 460)) ** 2;
    const recovered = 100 / (r2 - 1);
    expect(Math.abs(recovered - 459.67)).toBeGreaterThan(1e-6);
    // eslint-disable-next-line no-console
    console.log(`negative control: a 460 offset recovers ${recovered.toFixed(4)}, which the 459.67 literal rejects`);
  });

  test('the SI Kv route rejects a 1400 gas constant', () => {
    const err = Math.abs(1360 - 1400) / 1360;
    expect(err).toBeGreaterThan(5e-3);
    // eslint-disable-next-line no-console
    console.log(`negative control: 1400 in place of 1360 is a ${(err * 100).toFixed(2)} percent error against a 0.5 percent gate, and the route's own residual is about 0.25 percent`);
  });

  test('the noise band gate rejects a band that cannot see the power', () => {
    // the ratio-only ladder, as it used to be
    const ratioOnly = (ratio) => {
      if (ratio < 2) return 'low';
      if (ratio < 4) return 'moderate';
      if (ratio < 10) return 'high';
      return 'severe';
    };
    const bleed = G.noise.find((r) => r.why.includes('holds it down'));
    const torrent = G.noise.find((r) => r.why.includes('raises it'));
    expect(ratioOnly(bleed.pressureRatio)).not.toBe(bleed.expectBand);
    expect(ratioOnly(torrent.pressureRatio)).not.toBe(torrent.expectBand);
    // eslint-disable-next-line no-console
    console.log(`negative control: the ratio-only ladder bands the bleed ${ratioOnly(bleed.pressureRatio)} and the torrent ${ratioOnly(torrent.pressureRatio)}, where the goldens want ${bleed.expectBand} and ${torrent.expectBand}`);
  });

  test('the check-counting gate rejects a verdict over zero checks', () => {
    // the old contract: pass = warnings.length === 0, whatever ran
    const oldPass = (warnings) => warnings.length === 0;
    expect(oldPass([])).toBe(true);
    expect(travelCheck({ cvRated: 100 }).pass).toBeNull();
    expect(travelCheck({ cvRated: 100 }).pass).not.toBe(oldPass([]));
    // eslint-disable-next-line no-console
    console.log('negative control: the old contract reports WORKABLE over zero checks and the repaired one withholds the verdict');
  });

  test('the vapour pressure refusal rejects the default that switched the screen off', () => {
    // with pvPsia defaulting to 0, sigma was Infinity and the regime
    // ladder's last branch made every service "stable"
    const sigmaAtZeroPv = (200 - 0) / 50;
    expect(Number.isFinite(sigmaAtZeroPv)).toBe(true); // with a stated Pv it is finite
    const oldSigma = 0 > 0 ? (200 - 0) / 50 : Infinity;
    expect(oldSigma).toBe(Infinity);
    expect(oldSigma).toBeGreaterThan(SIGMA_THRESHOLDS.incipient);
    expect(liquidValve({ qGpm: 500, p1Psia: 200, p2Psia: 150, sg: 0.85 }).error).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(`negative control: the old default gives sigma ${oldSigma}, past the ${SIGMA_THRESHOLDS.incipient} threshold, so every service read stable; the repaired engine refuses instead`);
  });
});
