// Facilities F11 control-valve gates against
// tools/validation/facilities/oracle_controlvalve.py.
//
// Independent routes: the liquid CHOKING BOUNDARY is located by
// bisection on the regime flag rather than by evaluating the closed
// form, and the Cv is checked either side of it; the gas expansion
// factor is checked against a MARCH of x values up to and past the
// terminal ratio, confirming Y falls linearly to exactly two thirds and
// then stops moving; and the equal-percentage travel is checked by
// ROUND TRIP, generating a Cv from a travel and requiring the module to
// return that travel.
//
// The boundary is the point of the whole module. Below it a valve sizes
// on the stated drop; at or above it the flow chokes and sizing on the
// stated drop undersizes the valve badly.

import fs from 'fs';
import path from 'path';
import {
  VALVE_STYLES, styleOf, liquidCriticalRatioFF, liquidValve,
  specificHeatFactor, gasValve,
  valveAuthority, characteristicFor, noiseIndication, travelCheck,
} from '../engines/facilities/controlValve';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'controlvalve_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('published valve data', () => {
  test('the style table is complete and ordered the way the physics is', () => {
    expect(VALVE_STYLES.length).toBeGreaterThan(6);
    // a globe recovers less pressure than a butterfly, so it chokes later
    expect(styleOf('globeCage').fl).toBeGreaterThan(styleOf('butterfly90').fl);
    // anti-cavitation trim is the highest FL of all
    expect(styleOf('globeAntiCav').fl).toBeGreaterThan(styleOf('globeCage').fl);
    // and xT tracks FL in the same order
    expect(styleOf('globeCage').xt).toBeGreaterThan(styleOf('ballFullBore').xt);
    expect(styleOf('nonsense')).toBeNull();
  });
});

describe('liquid sizing', () => {
  test('Cv and the choking flag match the independent evaluation', () => {
    G.liquid.forEach((row) => {
      const r = liquidValve({ ...row, flOverride: row.fl });
      expect(r.error).toBeUndefined();
      expect(r.choked).toBe(row.choked);
      expect(rel(r.ff, row.ff)).toBeLessThan(1e-12);
      expect(rel(r.dpAllowablePsi, row.dpAllowablePsi)).toBeLessThan(1e-12);
      expect(rel(r.cv, row.cv)).toBeLessThan(1e-12);
    });
  });

  test('THE BOUNDARY: found by bisection, it is where the regime flips', () => {
    G.boundary.forEach((row) => {
      // the module must agree on which side of the boundary it is
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
      expect(rel(justAbove.dpAllowablePsi, row.dpAllowablePsi)).toBeLessThan(1e-12);
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

  test('FF and the refusals behave', () => {
    // pure water at 3200 psia critical: FF near 0.96 for low volatility
    expect(liquidCriticalRatioFF({ pvPsia: 0, pcPsia: 3200 })).toBeCloseTo(0.96, 9);
    expect(liquidCriticalRatioFF({ pvPsia: 3200, pcPsia: 3200 })).toBeCloseTo(0.68, 9);
    expect(liquidValve({ qGpm: 500, p1Psia: 100, p2Psia: 150, sg: 0.85 }).error).toBeTruthy();
    expect(liquidValve({ qGpm: 0, p1Psia: 200, p2Psia: 100, sg: 0.85 }).error).toBeTruthy();
    expect(liquidValve({
      qGpm: 500, p1Psia: 200, p2Psia: 100, sg: 0.85, styleId: 'nope',
    }).error).toBeTruthy();
  });
});

describe('gas sizing', () => {
  test('Y falls linearly to exactly two thirds and then stops', () => {
    const m = G.gasMarch;
    m.rows.forEach((row) => {
      const r = gasValve({
        qScfh: 1e5, p1Psia: m.p1Psia, p2Psia: m.p1Psia * (1 - row.x),
        gasSg: 0.65, tF: 100, k: m.k, xtOverride: m.xt,
      });
      if (row.x <= 0 || row.x >= 1) return;
      expect(rel(r.y, row.y)).toBeLessThan(1e-9);
      expect(r.choked).toBe(row.choked);
    });
    // the choked floor is exactly 2/3
    const choked = gasValve({
      qScfh: 1e5, p1Psia: 300, p2Psia: 30, gasSg: 0.65, tF: 100, k: 1.28, xtOverride: 0.72,
    });
    expect(choked.y).toBeCloseTo(2 / 3, 12);
  });

  test('Cv matches the independent evaluation either side of choking', () => {
    G.gas.forEach((row) => {
      const r = gasValve({ ...row, xtOverride: row.xt });
      expect(r.error).toBeUndefined();
      expect(r.choked).toBe(row.choked);
      expect(rel(r.x, row.x)).toBeLessThan(1e-12);
      expect(rel(r.cv, row.cv)).toBeLessThan(1e-12);
    });
  });

  test('the heat capacity factor and the warnings behave', () => {
    expect(specificHeatFactor(1.4)).toBeCloseTo(1, 12);
    expect(specificHeatFactor(1.28)).toBeLessThan(1);
    const hard = gasValve({
      qScfh: 5e5, p1Psia: 300, p2Psia: 100, gasSg: 0.65, tF: 100, k: 1.28,
      styleId: 'globeCage',
    });
    expect(hard.warning).toBeTruthy();
    expect(gasValve({ qScfh: 1e5, p1Psia: 100, p2Psia: 150, gasSg: 0.65, tF: 100 }).error)
      .toBeTruthy();
  });
});

describe('authority and characteristic', () => {
  test('authority decides whether a loop can control at all', () => {
    const good = valveAuthority({ dpValvePsi: 60, dpSystemTotalPsi: 100 });
    expect(good.verdict).toBe('good');
    expect(good.note).toBeNull();
    const poor = valveAuthority({ dpValvePsi: 10, dpSystemTotalPsi: 100 });
    expect(poor.verdict).toBe('poor');
    expect(poor.note).toMatch(/first few percent of travel/);
    expect(valveAuthority({ dpValvePsi: 200, dpSystemTotalPsi: 100 }).error).toBeTruthy();
  });

  test('the characteristic recommendation follows the published rule', () => {
    expect(characteristicFor({ authority: 0.7 }).characteristic).toBe('linear');
    const eq = characteristicFor({ authority: 0.3 });
    expect(eq.characteristic).toBe('equal percentage');
    expect(eq.reason).toMatch(/cancel exactly that/);
    expect(characteristicFor({ authority: 0 }).error).toBeTruthy();
  });
});

describe('travel and rangeability', () => {
  test('equal-percentage travel round-trips against the characteristic law', () => {
    const t = G.travel;
    t.points.forEach((p) => {
      const r = travelCheck({
        cvRequiredNormal: p.cv, cvRated: t.cvRated, rangeability: t.rangeability,
      });
      expect(rel(r.normalTravelPct / 100, p.travelFraction)).toBeLessThan(1e-9);
    });
  });

  test('catches the valve that cannot pass its duty or control at turndown', () => {
    const tooSmall = travelCheck({
      cvRequiredMin: 5, cvRequiredNormal: 60, cvRequiredMax: 150, cvRated: 100,
    });
    expect(tooSmall.maxTravelPct).toBeNull();
    expect(tooSmall.warnings.join(' ')).toMatch(/will not pass the design case/);
    const nearSeat = travelCheck({
      cvRequiredMin: 0.5, cvRequiredNormal: 50, cvRequiredMax: 90, cvRated: 100,
    });
    expect(nearSeat.minTravelPct).toBeLessThan(10);
    expect(nearSeat.warnings.join(' ')).toMatch(/characteristic collapses/);
    const good = travelCheck({
      cvRequiredMin: 20, cvRequiredNormal: 45, cvRequiredMax: 75, cvRated: 100,
      characteristic: 'linear',
    });
    expect(good.pass).toBe(true);
    expect(travelCheck({ cvRated: 0 }).error).toBeTruthy();
  });
});

describe('noise', () => {
  test('bands the service and is honest that it is an indication', () => {
    const quiet = noiseIndication({ p1Psia: 120, p2Psia: 100, qScfh: 1e5, gasSg: 0.65, tF: 100 });
    expect(quiet.band).toBe('low');
    expect(quiet.warning).toBeNull();
    const loud = noiseIndication({ p1Psia: 900, p2Psia: 60, qScfh: 2e6, gasSg: 0.65, tF: 100 });
    expect(loud.band).toBe('severe');
    expect(loud.warning).toMatch(/multistage trim/);
    expect(loud.note).toMatch(/screening indication only/);
    expect(noiseIndication({ p1Psia: 100, p2Psia: 150, qScfh: 1e5 }).error).toBeTruthy();
  });
});
