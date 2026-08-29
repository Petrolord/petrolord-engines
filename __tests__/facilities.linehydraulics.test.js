// Facilities F1 line-hydraulics gates: liquid Darcy-Weisbach with
// Colebrook friction, the four published gas transmission forms with
// the elevation adjustment, Barlow wall thickness to B31.4/B31.8, and
// the pigging estimates -- against the independent stdlib oracle
// (tools/validation/facilities/oracle_linehydraulics.py).
//
// The oracle works in the PUBLISHED SI FORMS of the same equations
// (Menon's 3.7435e-3 / 4.5965e-3 / 1.002e-2 / 1.1494e-3 / 0.0684
// constants against this module's 433.5 / 435.87 / 737 / 77.54 /
// 0.0375), and takes friction by bisection where this module iterates
// a fixed point, so agreement is two routes meeting rather than code
// echoing itself. The SI/field constant pairs are published to four
// to five significant figures, which sets the gas tolerance.
//
// Multiphase pressure drop is deliberately NOT gated here because it
// is not here: the Suite's golden-tested Beggs & Brill stays the
// canonical correlation and the app composes it.

import fs from 'fs';
import path from 'path';
import {
  BASE_CONDITIONS, reynoldsNumber, frictionFactor,
  liquidLineDrop, liquidLineTraverse,
  elevationAdjustment, weymouthQ, panhandleAQ, panhandleBQ, generalFlowQ,
  gasOutletPressure,
  B318_DESIGN_FACTORS, requiredWallIn, maopPsig,
  lineVolumeBbl, sweptLiquidBbl, pigRun, piggingInterval,
} from '../engines/facilities/lineHydraulics';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'linehydraulics_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('friction factor', () => {
  test('matches the bisection oracle across regimes', () => {
    G.friction.forEach((row) => {
      const { f } = frictionFactor({ re: row.re, relRough: row.relRough });
      expect(rel(f, row.f)).toBeLessThan(1e-8);
    });
  });

  test('laminar is 64/Re and rough turbulent flattens with Re', () => {
    expect(frictionFactor({ re: 1000 }).f).toBeCloseTo(0.064, 12);
    const a = frictionFactor({ re: 1e6, relRough: 1e-3 }).f;
    const b = frictionFactor({ re: 1e8, relRough: 1e-3 }).f;
    expect(Math.abs(a - b) / a).toBeLessThan(0.06); // fully rough: f barely moves
    expect(frictionFactor({ re: -1 }).regime).toBe('invalid');
  });
});

describe('liquid lines', () => {
  test('pressure-drop split matches the SI oracle', () => {
    G.liquid.forEach((row) => {
      const r = liquidLineDrop(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.vFtS, row.vFtS)).toBeLessThan(1e-8);
      expect(rel(r.re, row.re)).toBeLessThan(2e-4); // cp conversion quoted to 5 figs
      expect(rel(r.f, row.f)).toBeLessThan(2e-4);
      expect(rel(r.dpFrictionPsi, row.dpFrictionPsi)).toBeLessThan(5e-4);
      expect(rel(r.dpTotalPsi, row.dpTotalPsi)).toBeLessThan(5e-4);
    });
  });

  test('the viscous case is laminar and the split adds up', () => {
    const lam = G.liquid[3];
    const r = liquidLineDrop(lam);
    expect(r.regime).toBe('laminar');
    const sum = r.dpFrictionPsi + r.dpFittingsPsi + r.dpElevationPsi;
    expect(rel(sum, r.dpTotalPsi)).toBeLessThan(1e-12);
  });

  test('a traverse marches the same physics segment by segment', () => {
    const base = G.liquid[1];
    const whole = liquidLineDrop(base);
    const half = { lengthFt: base.lengthFt / 2, elevChangeFt: base.elevChangeFt / 2 };
    const tr = liquidLineTraverse({
      p1Psia: 1000, qBpd: base.qBpd, idIn: base.idIn, rhoLbFt3: base.rhoLbFt3,
      muCp: base.muCp, roughnessIn: base.roughnessIn, profile: [half, half],
    });
    // fittings are per-line, not per-segment, so compare without them
    expect(rel(tr.dpTotalPsi, whole.dpTotalPsi - whole.dpFittingsPsi)).toBeLessThan(1e-9);
    expect(tr.stations).toHaveLength(3);
    expect(liquidLineTraverse({ p1Psia: 100, profile: [] }).error).toBeTruthy();
  });

  test('refuses nonsense instead of numbers', () => {
    expect(liquidLineDrop({ qBpd: -5, idIn: 6, lengthFt: 100, rhoLbFt3: 55, muCp: 1 }).error).toBeTruthy();
  });
});

describe('gas transmission forms', () => {
  const forms = {
    weymouth: weymouthQ, panhandleA: panhandleAQ, panhandleB: panhandleBQ, general: generalFlowQ,
  };

  test('all four forms match their published SI twins, elevation included', () => {
    G.gas.forEach((row) => {
      const r = forms[row.equation](row);
      expect(r.error).toBeUndefined();
      expect(rel(r.qScfd, row.qScfd)).toBeLessThan(2e-3);
    });
  });

  test('uphill flows less than downhill through the same line', () => {
    const up = G.gas.find((r) => r.equation === 'weymouth' && r.elevChangeFt > 0);
    const dn = G.gas.find((r) => r.equation === 'weymouth' && r.elevChangeFt < 0);
    expect(up.qScfd).toBeLessThan(dn.qScfd);
    const flat = elevationAdjustment({ sg: 0.65, elevChangeFt: 0, tAvgR: 540, zAvg: 0.9 });
    expect(flat.es).toBe(1);
  });

  test('outlet-pressure solve round-trips every form', () => {
    const base = {
      p1Psia: 1000, idIn: 8, lengthMi: 25, sg: 0.65, tAvgR: 540, zAvg: 0.87,
    };
    Object.keys(forms).forEach((equation) => {
      const q = forms[equation]({ ...base, p2Psia: 700 }).qScfd;
      const inv = gasOutletPressure({ equation, qScfd: q, ...base });
      expect(inv.error).toBeUndefined();
      expect(rel(inv.p2Psia, 700)).toBeLessThan(1e-4);
    });
    expect(gasOutletPressure({ equation: 'weymouth', qScfd: 1e12, ...base }).error).toBeTruthy();
    expect(gasOutletPressure({ equation: 'nonsense', qScfd: 1 }).error).toBeTruthy();
  });

  test('refuses a dead or reversed line instead of imagining flow', () => {
    const r = weymouthQ({
      p1Psia: 500, p2Psia: 600, idIn: 8, lengthMi: 10, sg: 0.65, tAvgR: 540, zAvg: 0.9,
    });
    expect(r.error).toBeTruthy();
    expect(BASE_CONDITIONS.tbR).toBe(520);
  });
});

describe('Barlow wall thickness', () => {
  test('required wall matches the SI oracle and MAOP round-trips', () => {
    G.barlow.forEach((row) => {
      const r = requiredWallIn(row);
      expect(r.error).toBeUndefined();
      expect(r.designFactor).toBe(row.designFactor);
      expect(rel(r.tRequiredIn, row.tRequiredIn)).toBeLessThan(1e-9);
      const back = maopPsig({ ...row, wallIn: r.tRequiredIn });
      expect(rel(back.maopPsig, row.maopOfRequiredPsig)).toBeLessThan(1e-9);
    });
  });

  test('the location classes derate in order and unknown ones refuse', () => {
    const fs4 = B318_DESIGN_FACTORS.map((r) => r.f);
    expect(fs4).toEqual([0.72, 0.60, 0.50, 0.40]);
    expect(requiredWallIn({
      designPsig: 1000, odIn: 8.625, smysPsi: 42000, code: 'B31.8', locationClass: 9,
    }).error).toBeTruthy();
    expect(requiredWallIn({
      designPsig: 1000, odIn: 8.625, smysPsi: 42000, code: 'B99',
    }).error).toBeTruthy();
    expect(maopPsig({
      wallIn: 0.04, odIn: 8.625, smysPsi: 42000, corrosionAllowanceIn: 0.0625,
    }).error).toBeTruthy(); // nothing left after CA
  });
});

describe('pigging estimates', () => {
  test('geometry matches the oracle', () => {
    G.pigging.forEach((row) => {
      expect(rel(lineVolumeBbl(row), row.lineVolumeBbl)).toBeLessThan(1e-9);
      expect(rel(sweptLiquidBbl(row).sweptBbl, row.sweptBbl)).toBeLessThan(1e-9);
      expect(rel(pigRun({ lengthFt: row.lengthFt, pigSpeedFtS: 5 }).runHours,
        row.runHoursAt5FtS)).toBeLessThan(1e-12);
    });
  });

  test('the interval answers in days and refuses an overfull catcher', () => {
    const swept = sweptLiquidBbl({ idIn: 6.065, lengthFt: 30000, holdupFrac: 0.12 }).sweptBbl;
    const ok = piggingInterval({ maxSlugBbl: swept + 100, dropoutBpd: 25, sweptBbl: swept });
    expect(ok.intervalDays).toBeCloseTo(4, 9);
    expect(piggingInterval({ maxSlugBbl: swept - 1, dropoutBpd: 25, sweptBbl: swept }).error).toBeTruthy();
    expect(sweptLiquidBbl({ idIn: 6, lengthFt: 100, holdupFrac: 1.4 }).error).toBeTruthy();
    expect(pigRun({ lengthFt: 100, pigSpeedFtS: 0 }).error).toBeTruthy();
  });
});

describe('composition seams stay seams', () => {
  test('reynoldsNumber guards its inputs', () => {
    expect(Number.isNaN(reynoldsNumber({ rhoLbFt3: 0, vFtS: 1, idIn: 6, muCp: 1 }))).toBe(true);
  });
});
