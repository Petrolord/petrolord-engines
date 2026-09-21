// Facilities F2 relief-and-flare gates: API 520 gas (critical and
// subcritical), liquid with the iterated Kv, steam with Napier, the
// API 521 fire case and wetted-area geometry, knockout-drum droplet
// settling and the drum itself, point-source radiation both ways, and
// the blowdown march -- against the independent stdlib oracle
// (tools/validation/facilities/oracle_relief.py).
//
// WHAT THE ORACLE CHECKS AND WHAT IT CANNOT is written out in that
// file's header, route by route, and the short version is here:
//
//  - gas, both branches, and the critical ratio: derived in absolute
//    SI from the isentropic nozzle (the flux, and the ratio as the
//    ARGMAX of that flux), so the USC 520 and 735 are CHECKED;
//  - liquid: the SI 11.78 against the USC 38, and the Reynolds number
//    from rho u D / mu, so the USC 2800 is CHECKED. The Kv fit itself
//    is SHARED on purpose -- nothing in this package can derive it --
//    and what discriminates its constants is the golden's row at
//    Re below 200, where 342.75 is worth 23 percent of the denominator;
//  - steam: the SI 190.4 and the SI statement of Napier, with a row at
//    3100 psia where the fit's slopes are worth 100 times the tolerance;
//  - fire: 43.2/70.9 against 21000/34500 with the 0.82 exponent carried
//    through the unit conversion, and the relief load through kW and
//    kg/s so every unit packaging is exercised;
//  - wetted area: POLYLINE SUMMATION round the real circle, both
//    orientations (the old route was the engine's own formula wrapped
//    in a ft-m-ft round trip, which is algebraically a no-op);
//  - settling: BISECTION on the force residual, which derives the 4/3
//    the standard prints as 1.15. The drag correlation is SHARED and
//    HELD FOR LITERATURE;
//  - the drum: SIMPSON quadrature of the segment area integral;
//  - radiation: the sphere's area by QUADRATURE, and the setback by
//    BISECTION on it, so the 4 pi is checked in both directions;
//  - blowdown: the march is separable and the oracle solves it IN
//    CLOSED FORM, so the time, the (k-1) isentropic exponent and the
//    absence of a hidden discharge coefficient are all checked.
//
// The chart factors (balanced-bellows Kb and Kw, superheat KSH,
// insulation credits) are typed inputs by design: they are published
// as figures and tables, and reproducing plotted curves from memory
// is what this package refuses. Their literature gates stay ARMED.

import fs from 'fs';
import path from 'path';
import {
  API_ORIFICES, selectOrifice, gasConstantC, criticalPressureRatio, subcriticalF2,
  gasVaporArea, liquidKv, liquidKvUnclamped, liquidArea, steamKn, steamArea,
  NAPIER_UNITY_PSIA, wettedAreaFt2, fireHeatInput, fireReliefLoad,
  dropoutVelocityFtS, koDrumHorizontal, segmentAreaFraction,
  radiationIntensity, distanceForIntensity, RADIATION_LEVELS,
  blowdown,
} from '../engines/facilities/relief';
import { RADIATION_LEVELS as SPACING_RADIATION_LEVELS } from '../engines/facilities/spacing';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'relief_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('orifice selection', () => {
  test('picks the smallest standard orifice at or above the need', () => {
    expect(API_ORIFICES).toHaveLength(14);
    expect(selectOrifice(0.5).orifice).toBe('G');
    expect(selectOrifice(0.503).orifice).toBe('G');
    expect(selectOrifice(0.504).orifice).toBe('H');
    const over = selectOrifice(60);
    expect(over.error).toBeTruthy();
    expect(over.multipleOfT).toBe(3);
  });

  test('the refusal prints the figure that made it true, and a non-finite area refuses', () => {
    // 26.0001 rounded to 26.00 used to read as a contradiction
    expect(selectOrifice(26.0001).error).toMatch(/26\.0001 in2 exceeds/);
    expect(selectOrifice(Infinity).error).toBeTruthy();
    expect(selectOrifice(Infinity).multipleOfT).toBeUndefined();
    expect(selectOrifice(NaN).error).toBeTruthy();
  });
});

describe('gas and vapor sizing', () => {
  test('critical and subcritical areas match the first-principles SI oracle', () => {
    expect(G.gas).toHaveLength(5);
    G.gas.forEach((row) => {
      const r = gasVaporArea(row);
      expect(r.error).toBeUndefined();
      expect(r.critical).toBe(row.critical);
      // 520 and 735 are published to 3 figures; the oracle derives them.
      expect(rel(r.areaIn2, row.areaIn2)).toBeLessThan(2e-3);
      // the ratio the oracle found by maximising the flux, not by the closed form
      expect(rel(r.criticalRatio, row.criticalRatio)).toBeLessThan(1e-6);
    });
  });

  test('the two branches meet at the critical ratio', () => {
    const k = 1.3;
    const base = { wLbHr: 50000, p1Psia: 500, tR: 600, mw: 20, z: 0.9, k };
    const pCrit = criticalPressureRatio(k) * 500;
    const a1 = gasVaporArea({ ...base, p2Psia: pCrit * 0.999 }).areaIn2;
    const a2 = gasVaporArea({ ...base, p2Psia: pCrit * 1.001 }).areaIn2;
    expect(rel(a1, a2)).toBeLessThan(5e-3);
    expect(gasConstantC(1.4)).toBeCloseTo(356, 0);
    expect(Number.isNaN(subcriticalF2({ k: 1.3, r: 1.2 }))).toBe(true);
  });

  test('warns where the typed factors stop being safe, refuses dead valves', () => {
    const highBack = gasVaporArea({
      wLbHr: 10000, p1Psia: 500, p2Psia: 200, tR: 600, mw: 20, z: 0.9, k: 1.3,
    });
    expect(highBack.critical).toBe(true);
    expect(highBack.warning).toMatch(/balanced-bellows/);
    expect(gasVaporArea({
      wLbHr: 10000, p1Psia: 100, p2Psia: 120, tR: 600, mw: 20, z: 0.9, k: 1.3,
    }).error).toBeTruthy();
  });

  test('every certified coefficient is validated by name', () => {
    const base = { wLbHr: 50000, p1Psia: 314.7, p2Psia: 14.7, tR: 610, mw: 19, z: 0.9, k: 1.25 };
    // a zero used to return Infinity with no error key
    expect(gasVaporArea({ ...base, kd: 0 }).error).toMatch(/Kd/);
    expect(gasVaporArea({ ...base, kb: 0 }).error).toMatch(/Kb/);
    expect(gasVaporArea({ ...base, kc: null }).error).toMatch(/Kc/);
    // and a coefficient above 1 used to sell an area no valve delivers
    expect(gasVaporArea({ ...base, kd: 2 }).error).toMatch(/Kd/);
    expect(gasVaporArea({ ...base, kd: -0.5 }).error).toMatch(/Kd/);
    expect(gasVaporArea({ ...base, p2Psia: -1 }).error).toBeTruthy();
    // and the valid range still works
    expect(gasVaporArea({ ...base, kd: 0.9, kb: 0.9, kc: 0.9 }).areaIn2).toBeGreaterThan(0);
  });
});

describe('liquid sizing', () => {
  test('areas, the iterated Kv and the Reynolds number match the SI oracle', () => {
    expect(G.liquid).toHaveLength(5);
    G.liquid.forEach((row) => {
      const r = liquidArea(row);
      expect(r.error).toBeUndefined();
      // 38 vs 11.78: published constant pair to 3-4 figures.
      expect(rel(r.areaIn2, row.areaIn2)).toBeLessThan(1e-3);
      expect(rel(r.kv, row.kv)).toBeLessThan(3e-4);
      if (row.reynolds) {
        // 2800 against rho u D / mu in SI
        expect(rel(r.reynolds, row.reynolds)).toBeLessThan(5e-4);
        expect(r.kvConverged).toBe(true);
        expect(r.kvIterations).toBeGreaterThan(0);
      }
    });
  });

  test('the golden keeps the row that can discriminate the Kv fit', () => {
    // The 342.75 term is worth 2e-5 at the Reynolds numbers the ordinary
    // rows sit at and only bites below about Re 900. If this row is ever
    // "tidied away", the Kv constants go back to being unvalidated.
    const low = G.liquid.filter((r) => r.reynolds && r.reynolds < 200);
    expect(low.length).toBeGreaterThan(0);
    expect(low[0].kv).toBeLessThan(0.7);
  });

  test('viscosity always costs area, and the correction never adds capacity', () => {
    const thin = liquidArea({ qGpm: 500, p1Psig: 250, p2Psig: 50, sg: 0.9, muCp: 0 });
    const thick = liquidArea({ qGpm: 500, p1Psig: 250, p2Psig: 50, sg: 0.9, muCp: 400 });
    expect(thick.areaIn2).toBeGreaterThan(thin.areaIn2);
    // the published fit asymptotes ABOVE 1, which would UNDERSIZE the
    // valve; Kv is clamped and the raw fit stays inspectable
    expect(liquidKvUnclamped(1e8)).toBeCloseTo(1 / 0.9935, 3);
    expect(liquidKvUnclamped(1e8)).toBeGreaterThan(1);
    expect(liquidKv(1e8)).toBe(1);
    const veryThin = liquidArea({ qGpm: 800, p1Psig: 300, p2Psig: 100, sg: 1.0, muCp: 0.5 });
    expect(veryThin.kv).toBe(1);
    expect(veryThin.areaIn2).toBeGreaterThanOrEqual(
      liquidArea({ qGpm: 800, p1Psig: 300, p2Psig: 100, sg: 1.0, muCp: 0 }).areaIn2,
    );
    expect(liquidArea({ qGpm: 100, p1Psig: 50, p2Psig: 60, sg: 1 }).error).toBeTruthy();
  });

  test('a stated viscosity is never silently discarded, and the coefficients are checked', () => {
    // -400 cp used to return kv 1, reynolds null and an inviscid area
    expect(liquidArea({ qGpm: 500, p1Psig: 250, p2Psig: 50, sg: 0.9, muCp: -400 }).error)
      .toMatch(/viscosity/);
    expect(liquidArea({ qGpm: 500, p1Psig: 250, p2Psig: 50, sg: 0.9, muCp: NaN }).error).toBeTruthy();
    expect(liquidArea({ qGpm: 500, p1Psig: 250, p2Psig: 50, sg: 0.9, kd: 0 }).error).toMatch(/Kd/);
    expect(liquidArea({ qGpm: 500, p1Psig: 250, p2Psig: 50, sg: 0.9, kw: 1.4 }).error).toMatch(/Kw/);
  });
});

describe('steam sizing', () => {
  test('areas and Napier match the SI oracle', () => {
    expect(G.steam).toHaveLength(5);
    G.steam.forEach((row) => {
      const r = steamArea(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.areaIn2, row.areaIn2)).toBeLessThan(1e-3);
      expect(rel(r.kn, row.kn)).toBeLessThan(5e-4);
    });
  });

  test('the golden keeps a row near the top of the published Napier range', () => {
    // a 0.3 percent change in the 0.1906 slope is worth 1.8e-3 at 2014.7
    // psia and 4.6e-3 at 3100, so only the upper row can discriminate it
    expect(G.steam.some((r) => r.p1Psia > 3000)).toBe(true);
  });

  test('Napier is unity to 1500 psia, refuses past its range, and says where it costs area', () => {
    expect(steamKn(1000)).toBe(1);
    expect(steamKn(2000)).toBeGreaterThan(1);
    expect(steamArea({ wLbHr: 1000, p1Psia: 3300 }).error).toBeTruthy();
    expect(NAPIER_UNITY_PSIA).toBeGreaterThan(1500);
    expect(NAPIER_UNITY_PSIA).toBeLessThan(1600);
    // between 1500 and the crossing the correction makes the valve BIGGER
    const inBand = steamArea({ wLbHr: 120000, p1Psia: 1550 });
    expect(inBand.kn).toBeLessThan(1);
    expect(inBand.warning).toMatch(/LARGER/);
    expect(steamArea({ wLbHr: 120000, p1Psia: 2014.7 }).warning).toBeNull();
    // KSH and Kd are certified/table factors, validated like the rest
    expect(steamArea({ wLbHr: 1000, p1Psia: 314.7, ksh: 0 }).error).toMatch(/KSH/);
    expect(steamArea({ wLbHr: 1000, p1Psia: 314.7, kd: 0 }).error).toMatch(/Kd/);
  });
});

describe('fire case', () => {
  test('wetted geometry, both orientations, matches the polyline oracle', () => {
    expect(G.wetted).toHaveLength(7);
    G.wetted.forEach((row) => {
      const r = wettedAreaFt2(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.areaFt2, row.areaFt2)).toBeLessThan(1e-9);
    });
    expect(G.wetted.some((r) => r.orientation === 'vertical')).toBe(true);
  });

  test('heat input and relief load match the SI oracle', () => {
    G.fire.forEach((row) => {
      const r = fireHeatInput({
        wettedFt2: row.wettedFt2, adequateDrainage: row.adequateDrainage, envFactor: row.envFactor,
      });
      // 21000/34500 vs 43.2/70.9: published pairs to 3 figures.
      expect(rel(r.qBtuHr, row.qBtuHr)).toBeLessThan(2e-3);
    });
    G.load.forEach((row) => {
      const r = fireReliefLoad(row);
      expect(rel(r.wLbHr, row.wLbHr)).toBeLessThan(1e-6);
    });
  });

  test('a half-full horizontal vessel wets exactly half its shell', () => {
    const half = wettedAreaFt2({ diameterFt: 10, lengthFt: 40, liquidLevelFt: 5 });
    expect(half.areaFt2).toBeCloseTo(Math.PI * 10 * 40 / 2, 6);
  });

  test('orientation is read case-insensitively and an unknown one refuses', () => {
    const v = wettedAreaFt2({
      orientation: 'vertical', diameterFt: 10, lengthFt: 40, liquidLevelFt: 5,
    }).areaFt2;
    // 'Vertical' used to fall through to HORIZONTAL: a factor of 4
    ['Vertical', 'VERTICAL', ' vertical '].forEach((o) => {
      expect(wettedAreaFt2({
        orientation: o, diameterFt: 10, lengthFt: 40, liquidLevelFt: 5,
      }).areaFt2).toBeCloseTo(v, 9);
    });
    expect(wettedAreaFt2({
      orientation: 'vert', diameterFt: 10, lengthFt: 40, liquidLevelFt: 5,
    }).error).toBeTruthy();
    expect(wettedAreaFt2({
      orientation: 'sphere', diameterFt: 10, lengthFt: 40, liquidLevelFt: 5,
    }).error).toBeTruthy();
  });

  test('a missing or negative level refuses in BOTH orientations', () => {
    ['horizontal', 'vertical'].forEach((orientation) => {
      // an empty box used to give NaN in both, and a negative level a
      // NEGATIVE area in the vertical branch
      expect(wettedAreaFt2({ orientation, diameterFt: 10, lengthFt: 40 }).error).toBeTruthy();
      expect(wettedAreaFt2({
        orientation, diameterFt: 10, lengthFt: 40, liquidLevelFt: NaN,
      }).error).toBeTruthy();
      expect(wettedAreaFt2({
        orientation, diameterFt: 10, lengthFt: 40, liquidLevelFt: -3,
      }).error).toBeTruthy();
    });
  });

  test('the fire duty refuses a zero, negative or oversized environment factor and a string drainage', () => {
    const base = { wettedFt2: 628.3 };
    expect(fireHeatInput({ ...base, envFactor: 0 }).error).toBeTruthy();
    expect(fireHeatInput({ ...base, envFactor: -1 }).error).toBeTruthy();
    expect(fireHeatInput({ ...base, envFactor: 1.5 }).error).toBeTruthy();
    // 'false' is truthy in JavaScript: it used to buy the 1.643 drainage credit
    expect(fireHeatInput({ ...base, adequateDrainage: 'false' }).error).toBeTruthy();
    expect(fireHeatInput({ ...base, adequateDrainage: 'yes' }).error).toBeTruthy();
    expect(fireHeatInput({ ...base, wettedFt2: NaN }).error).toBeTruthy();
    const ratio = fireHeatInput({ ...base, adequateDrainage: false }).qBtuHr
      / fireHeatInput({ ...base, adequateDrainage: true }).qBtuHr;
    expect(ratio).toBeCloseTo(34500 / 21000, 9);
  });

  test('the relief load flags near-critical latent heat', () => {
    const w = fireReliefLoad({ qBtuHr: 1e7, latentBtuLb: 100 });
    expect(w.wLbHr).toBeCloseTo(1e5, 6);
    expect(fireReliefLoad({ qBtuHr: 1e7, latentBtuLb: 30 }).warning).toBeTruthy();
    expect(fireReliefLoad({ qBtuHr: Infinity, latentBtuLb: 100 }).error).toBeTruthy();
  });
});

describe('knockout drum', () => {
  test('dropout velocity matches the force-balance bisection oracle', () => {
    expect(G.dropout).toHaveLength(4);
    G.dropout.forEach((row) => {
      const r = dropoutVelocityFtS(row);
      expect(r.error).toBeUndefined();
      // the oracle derives the 4/3 in the balance; API 521 prints 1.15,
      // which is 0.41 percent low and 40 times this tolerance
      expect(rel(r.udFtS, row.udFtS)).toBeLessThan(1e-5);
      expect(r.converged).toBe(true);
      // the returned velocity belongs to the returned drag coefficient
      const check = Math.sqrt(4 / 3) * Math.sqrt(
        (32.174 * row.dropletMicron * 3.2808398950131233e-6
          * (row.rhoLLbFt3 - row.rhoVLbFt3)) / (row.rhoVLbFt3 * r.dragC),
      );
      expect(rel(r.udFtS, check)).toBeLessThan(1e-12);
    });
  });

  test('the drum geometry matches the quadrature oracle at every holdup', () => {
    expect(G.drum).toHaveLength(6);
    G.drum.forEach((row) => {
      const r = koDrumHorizontal(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.requiredLengthFt, row.requiredLengthFt)).toBeLessThan(1e-9);
      expect(rel(r.vVaporFtS, row.vVaporFtS)).toBeLessThan(1e-9);
      expect(rel(r.ld, row.ld)).toBeLessThan(1e-9);
      expect(Math.abs(r.liquidAreaFraction - row.liquidAreaFraction)).toBeLessThan(1e-9);
    });
  });

  test('the holdup fraction MOVES the required length', () => {
    // it used to cancel algebraically: (1 - f) in the vapour area and
    // (1 - f) in the fall distance, so the box moved the answer by 9e-16
    const at = (f) => koDrumHorizontal({
      qVaporAcfs: 120, udFtS: 1.73, diameterFt: 8, liquidFraction: f,
    }).requiredLengthFt;
    const lengths = [0, 0.1, 0.25, 0.5, 0.75, 0.9].map(at);
    const spread = Math.max(...lengths) - Math.min(...lengths);
    expect(spread).toBeGreaterThan(1.0);          // ft, not 9e-16
    // and it is right at half full, which is where the old one was right
    expect(at(0.5)).toBeCloseTo(120 / (Math.PI * 64 / 8) * (4 / 1.73), 9);
    // a fuller drum needs a LONGER vessel: less vapour area, faster gas
    expect(at(0.75)).toBeGreaterThan(at(0.5));
    expect(segmentAreaFraction(0.5)).toBeCloseTo(0.5, 12);
    expect(segmentAreaFraction(0)).toBe(0);
    expect(segmentAreaFraction(1)).toBeCloseTo(1, 12);
  });

  test('a bigger droplet falls faster, and the drum reads L from D', () => {
    const small = dropoutVelocityFtS({ dropletMicron: 150, rhoLLbFt3: 40, rhoVLbFt3: 0.5, muVCp: 0.012 });
    const large = dropoutVelocityFtS({ dropletMicron: 600, rhoLLbFt3: 40, rhoVLbFt3: 0.5, muVCp: 0.012 });
    expect(large.udFtS).toBeGreaterThan(small.udFtS);
    const drum = koDrumHorizontal({ qVaporAcfs: 120, udFtS: large.udFtS, diameterFt: 8 });
    expect(drum.requiredLengthFt).toBeGreaterThan(0);
    // L = v * fall / ud with v ~ 1/D^2 and fall ~ D, so doubling the
    // diameter halves the required length exactly
    const bigger = koDrumHorizontal({ qVaporAcfs: 120, udFtS: large.udFtS, diameterFt: 16 });
    expect(bigger.requiredLengthFt).toBeCloseTo(drum.requiredLengthFt / 2, 9);
  });

  test('the drum refuses a bad holdup with the right reason', () => {
    const base = { qVaporAcfs: 120, udFtS: 1, diameterFt: 8 };
    expect(koDrumHorizontal({ ...base, liquidFraction: 1.2 }).error).toBeTruthy();
    // null >= 0 is true in JavaScript: it used to be treated as zero
    expect(koDrumHorizontal({ ...base, liquidFraction: null }).error).toBeTruthy();
    // and -0.5 used to be refused for being "below 1"
    expect(koDrumHorizontal({ ...base, liquidFraction: -0.5 }).error).toMatch(/from 0/);
    expect(dropoutVelocityFtS({ dropletMicron: 300, rhoLLbFt3: 40, rhoVLbFt3: 0.5, muVCp: NaN }).error)
      .toBeTruthy();
  });
});

describe('flare radiation', () => {
  test('intensity and setback match the quadrature oracle', () => {
    G.radiation.forEach((row) => {
      const r = radiationIntensity(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.kWm2, row.kWm2)).toBeLessThan(1e-12);
    });
    G.setback.forEach((row) => {
      const d = distanceForIntensity(row);
      expect(d.error).toBeUndefined();
      expect(rel(d.distanceM, row.distanceM)).toBeLessThan(1e-12);
    });
    expect(RADIATION_LEVELS.map((l) => l.kWm2)).toEqual([1.58, 4.73, 6.31, 9.46]);
  });

  test('BOTH directions validate all four inputs', () => {
    const base = { qKw: 50000, distanceM: 100, allowableKwM2: 4.73 };
    // a radiated fraction of zero used to return a safe distance of ZERO
    expect(distanceForIntensity({ ...base, fractionRadiated: 0 }).error).toBeTruthy();
    expect(distanceForIntensity({ ...base, transmissivity: -1 }).error).toBeTruthy();
    // and a flare used to be allowed to radiate more than it releases
    expect(radiationIntensity({ ...base, fractionRadiated: 1.5 }).error).toBeTruthy();
    expect(radiationIntensity({ ...base, transmissivity: 2 }).error).toBeTruthy();
    expect(distanceForIntensity({ ...base, fractionRadiated: 1.5 }).error).toBeTruthy();
    expect(radiationIntensity({ ...base, distanceM: 0 }).error).toBeTruthy();
    expect(distanceForIntensity({ ...base, allowableKwM2: 0 }).error).toBeTruthy();
  });

  test('one published table, one set of words, across two engines', () => {
    // relief.js and spacing.js export the same four kW/m2 for the same
    // physics; they used to carry four different labels, and a merged
    // NextGen course teaches the spacing.js wording
    expect(RADIATION_LEVELS).toEqual(SPACING_RADIATION_LEVELS);
  });
});

describe('blowdown', () => {
  test('the march matches the closed-form SI solution on every golden row', () => {
    expect(G.blowdown).toHaveLength(5);
    G.blowdown.forEach((row) => {
      const r = blowdown(row);
      expect(r.error).toBeUndefined();
      // the 520 packaging is worth 1.1e-3 here, exactly as it is on the
      // gas areas; the hidden 0.975 was worth 2.6e-2, twenty-five times it
      expect(rel(r.timeS, row.timeS)).toBeLessThan(2e-3);
      expect(rel(r.finalTR, row.finalTR)).toBeLessThan(1e-4);
      expect(rel(r.initialMassLb, row.initialMassLb)).toBeLessThan(1e-5);
      expect(r.timeS).toBeGreaterThan(0);
      expect(r.finalPPsia).toBeCloseTo(row.pEndPsia, 6);
    });
  });

  test('a step that would empty the vessel is subdivided, not called done', () => {
    // this used to return timeS 0, no error key, and the vessel still at
    // its start pressure, which printed as "0.0 min, inside the
    // customary 15 minutes"
    const fast = blowdown({
      volumeFt3: 5, p0Psia: 1014.7, t0R: 560, pEndPsia: 114.7, mw: 19, k: 1.3, z: 0.9,
      orificeDIn: 4, cd: 0.85,
    });
    expect(fast.error).toBeUndefined();
    expect(fast.timeS).toBeGreaterThan(0);
    expect(fast.substeps).toBeGreaterThan(0);
    expect(fast.stations[fast.stations.length - 1].pPsia).toBeCloseTo(114.7, 6);
    const app = blowdown({
      volumeFt3: 500, p0Psia: 1014.7, t0R: 560, pEndPsia: 114.7, mw: 19, k: 1.3, z: 0.9,
      orificeDIn: 38, cd: 0.85,
    });
    expect(app.timeS).toBeGreaterThan(0);
    expect(app.stations[app.stations.length - 1].pPsia).toBeCloseTo(114.7, 6);
  });

  test('refining the time step converges instead of stepping', () => {
    const base = {
      volumeFt3: 500, p0Psia: 1014.7, t0R: 560, pEndPsia: 114.7, mw: 19, k: 1.3, z: 0.9,
      orificeDIn: 1.0, cd: 0.85,
    };
    const times = [0.4, 0.2, 0.1, 0.05, 0.025].map((dtS) => blowdown({ ...base, dtS }).timeS);
    // the answer used to be quantised to one dtS: 274.8, 274.8, 274.9,
    // 274.9, 274.925, because the march overshot the end pressure
    const spread = Math.max(...times) - Math.min(...times);
    expect(spread).toBeLessThan(1e-3);
    expect(rel(times[0], times[4])).toBeLessThan(1e-5);
  });

  test('the discharge coefficient is the caller\'s, with nothing hidden behind it', () => {
    const base = {
      volumeFt3: 500, p0Psia: 1014.7, t0R: 560, pEndPsia: 114.7, mw: 19, k: 1.3, z: 0.9,
      orificeDIn: 1.0,
    };
    // time is inversely proportional to cd, exactly, once nothing else
    // multiplies it; a hidden constant factor would not change this, so
    // what proves the 0.975 is gone is the golden above. This proves the
    // typed value is the only thing acting.
    const a = blowdown({ ...base, cd: 0.85 }).timeS;
    const b = blowdown({ ...base, cd: 0.425 }).timeS;
    expect(rel(b, 2 * a)).toBeLessThan(1e-5);
  });

  test('refuses the inputs that used to hang it or go non-finite', () => {
    const base = {
      volumeFt3: 500, p0Psia: 1014.7, t0R: 560, pEndPsia: 114.7, mw: 19, k: 1.3, z: 0.9,
      orificeDIn: 1.0,
    };
    // dtS <= 0 was an UNBOUNDED LOOP: time never advanced, so the maxS
    // exit could never fire. These calls must RETURN.
    expect(blowdown({ ...base, dtS: 0 }).error).toBeTruthy();
    expect(blowdown({ ...base, dtS: -1 }).error).toBeTruthy();
    expect(blowdown({ ...base, dtS: NaN }).error).toBeTruthy();
    expect(blowdown({ ...base, maxS: 0 }).error).toBeTruthy();
    // a negative cd used to return a time and a NaN final temperature
    expect(blowdown({ ...base, cd: -0.85 }).error).toBeTruthy();
    expect(blowdown({ ...base, cd: 1.5 }).error).toBeTruthy();
    expect(blowdown({ ...base, p0Psia: 100, pEndPsia: 200 }).error).toBeTruthy();
    // and one that cannot finish says so rather than reporting the limit
    expect(blowdown({ ...base, orificeDIn: 0.01, maxS: 60 }).error).toMatch(/end pressure/);
  });

  test('marches to the end pressure, cooling as it goes, and says where it stops being choked', () => {
    const r = blowdown({
      volumeFt3: 500, p0Psia: 1014.7, t0R: 560, pEndPsia: 114.7,
      mw: 19, k: 1.3, z: 0.9, orificeDIn: 1.0,
    });
    expect(r.timeS).toBeGreaterThan(10);
    expect(r.finalTR).toBeLessThan(560);
    const p = r.stations.map((s) => s.pPsia);
    for (let i = 1; i < p.length; i += 1) expect(p[i]).toBeLessThan(p[i - 1]);
    expect(p).toHaveLength(new Set(p).size);
    const fast = blowdown({
      volumeFt3: 500, p0Psia: 1014.7, t0R: 560, pEndPsia: 114.7,
      mw: 19, k: 1.3, z: 0.9, orificeDIn: 2.0,
    });
    expect(fast.timeS).toBeLessThan(r.timeS / 3);
    expect(r.warning).toBeNull();
    // the model is choked flow throughout, and below this it is not
    const low = blowdown({
      volumeFt3: 500, p0Psia: 1014.7, t0R: 560, pEndPsia: 20,
      mw: 19, k: 1.3, z: 0.9, orificeDIn: 1.0,
    });
    expect(low.chokedToPsia).toBeGreaterThan(20);
    expect(low.warning).toMatch(/choked/);
  });
});

describe('no function returns a number without an error key', () => {
  // The defect class this module was carrying: a non-finite return with
  // no `error` is invisible to every caller's `if (r.error)` guard, and
  // the studio renders it as two dashes.
  const wrecked = [
    ['selectOrifice', () => selectOrifice(Infinity)],
    ['gasVaporArea kd 0', () => gasVaporArea({
      wLbHr: 50000, p1Psia: 314.7, tR: 610, mw: 19, z: 0.9, k: 1.25, kd: 0,
    })],
    ['gasVaporArea kb null', () => gasVaporArea({
      wLbHr: 50000, p1Psia: 314.7, tR: 610, mw: 19, z: 0.9, k: 1.25, kb: null,
    })],
    ['liquidArea kd 0', () => liquidArea({ qGpm: 500, p1Psig: 250, sg: 0.9, kd: 0 })],
    ['liquidArea mu -1', () => liquidArea({ qGpm: 500, p1Psig: 250, sg: 0.9, muCp: -1 })],
    ['steamArea ksh 0', () => steamArea({ wLbHr: 60000, p1Psia: 314.7, ksh: 0 })],
    ['steamArea kd 0', () => steamArea({ wLbHr: 60000, p1Psia: 314.7, kd: 0 })],
    ['wettedAreaFt2 no level', () => wettedAreaFt2({ diameterFt: 10, lengthFt: 40 })],
    ['wettedAreaFt2 negative level', () => wettedAreaFt2({
      orientation: 'vertical', diameterFt: 10, lengthFt: 40, liquidLevelFt: -3,
    })],
    ['fireHeatInput F 0', () => fireHeatInput({ wettedFt2: 628.3, envFactor: 0 })],
    ['fireHeatInput NaN area', () => fireHeatInput({ wettedFt2: NaN })],
    ['fireReliefLoad NaN duty', () => fireReliefLoad({ qBtuHr: NaN, latentBtuLb: 100 })],
    ['dropoutVelocityFtS NaN mu', () => dropoutVelocityFtS({
      dropletMicron: 300, rhoLLbFt3: 40, rhoVLbFt3: 0.5, muVCp: NaN,
    })],
    ['koDrumHorizontal null holdup', () => koDrumHorizontal({
      qVaporAcfs: 120, udFtS: 1, diameterFt: 8, liquidFraction: null,
    })],
    ['radiationIntensity f 0', () => radiationIntensity({
      qKw: 50000, distanceM: 100, fractionRadiated: 0,
    })],
    ['distanceForIntensity f 0', () => distanceForIntensity({
      qKw: 50000, allowableKwM2: 4.73, fractionRadiated: 0,
    })],
    ['blowdown cd -1', () => blowdown({
      volumeFt3: 500, p0Psia: 1014.7, t0R: 560, pEndPsia: 114.7, mw: 19, orificeDIn: 1, cd: -1,
    })],
    ['blowdown dtS 0', () => blowdown({
      volumeFt3: 500, p0Psia: 1014.7, t0R: 560, pEndPsia: 114.7, mw: 19, orificeDIn: 1, dtS: 0,
    })],
  ];

  test.each(wrecked)('%s refuses instead of returning a number', (name, call) => {
    const r = call();
    expect(r.error).toBeTruthy();
    Object.entries(r).forEach(([key, v]) => {
      if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
    });
  });
});
