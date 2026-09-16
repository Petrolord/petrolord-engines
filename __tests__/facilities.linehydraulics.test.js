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
import {
  erosionalVelocityFtS, erosionalRateBpd, pipeAreaFt2,
} from '../engines/production/chokePerformance';

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

// ---------------------------------------------------------------------------
// FC2-0, the repair wave before the NextGen Line Sizing & Hydraulics course.
// Twenty inputs that returned a number they should not have: ten a confident
// wrong one and ten a NaN or an Infinity with no `error` key, so every
// caller's `if (result.error)` guard passed. Each block below covers the
// defective input, the corrected behaviour and the boundary either side.
// ---------------------------------------------------------------------------

const GAS = {
  p1Psia: 1000, p2Psia: 600, idIn: 8, lengthMi: 25,
  sg: 0.65, tAvgR: 540, zAvg: 0.87,
};
const LIQ = {
  qBpd: 12000, idIn: 7.981, lengthFt: 26400, rhoLbFt3: 54.5, muCp: 2.5,
};
const WALL = { designPsig: 1200, odIn: 12.75, smysPsi: 52000 };

describe('the outlet-pressure bracket', () => {
  test('matches the closed-form SI inverse on every published outlet case', () => {
    expect(G.outlet).toHaveLength(8);
    const forms = {
      weymouth: weymouthQ, panhandleA: panhandleAQ, panhandleB: panhandleBQ, general: generalFlowQ,
    };
    G.outlet.forEach((row) => {
      const args = {
        p1Psia: row.p1Psia, idIn: row.idIn, lengthMi: row.lengthMi, sg: row.sg,
        tAvgR: row.tAvgR, zAvg: row.zAvg, efficiency: row.efficiency,
        elevChangeFt: row.elevChangeFt,
      };
      // the engine's own forward rate, inverted back to the outlet it came from
      const q = forms[row.equation]({ ...args, p2Psia: row.p2SetPsia }).qScfd;
      const inv = gasOutletPressure({ equation: row.equation, qScfd: q, ...args });
      expect(inv.error).toBeUndefined();
      expect(rel(inv.p2Psia, row.p2SetPsia)).toBeLessThan(1e-9);
      // and the ORACLE's rate, inverted by the engine, lands on the oracle's
      // own closed-form outlet to the packaging tolerance of the constants
      const fromOracle = gasOutletPressure({ equation: row.equation, qScfd: row.qScfd, ...args });
      expect(fromOracle.error).toBeUndefined();
      expect(rel(fromOracle.p2Psia, row.p2RecoveredPsia)).toBeLessThan(2e-3);
      // the sign of the answer is the whole finding: on a descent it is ABOVE
      expect(inv.p2Psia > row.p1Psia).toBe(row.p2AboveInlet);
      expect(inv.dpPsi < 0).toBe(row.p2AboveInlet);
    });
  });

  test('a descent returns the outlet above its inlet rather than the inlet itself', () => {
    const descent = {
      p1Psia: 1000, idIn: 8, lengthMi: 25, sg: 0.65, tAvgR: 540, zAvg: 0.87,
      elevChangeFt: -3000,
    };
    [1010, 1050].forEach((p2) => {
      const q = weymouthQ({ ...descent, p2Psia: p2 }).qScfd;
      const inv = gasOutletPressure({ equation: 'weymouth', qScfd: q, ...descent });
      expect(rel(inv.p2Psia, p2)).toBeLessThan(1e-9);
      expect(inv.dpPsi).toBeCloseTo(1000 - p2, 9);  // a gain, not a drop
    });
  });

  test('an ascent cannot reach its inlet at any rate, and says so at the ceiling', () => {
    const ascent = {
      p1Psia: 1000, idIn: 8, lengthMi: 25, sg: 0.65, tAvgR: 540, zAvg: 0.87,
      elevChangeFt: 3000,
    };
    const { es } = elevationAdjustment({ sg: 0.65, elevChangeFt: 3000, tAvgR: 540, zAvg: 0.87 });
    const ceiling = 1000 / Math.sqrt(es);
    expect(ceiling).toBeLessThan(1000);
    // a small rate lands just under the ceiling, NOT on the inlet
    const small = gasOutletPressure({ equation: 'weymouth', qScfd: 1e6, ...ascent });
    expect(small.p2Psia).toBeLessThan(ceiling);
    expect(small.p2Psia).toBeGreaterThan(ceiling - 1);
    expect(small.dpPsi).toBeGreaterThan(75);
    // and the answer is a real one: the forward form reproduces the rate
    expect(rel(weymouthQ({ ...ascent, p2Psia: small.p2Psia }).qScfd, 1e6)).toBeLessThan(1e-6);
    // A climb the inlet cannot pay for AT ALL is refused rather than
    // answered: a near-atmospheric gathering line at 15.5 psia up the same
    // 3000 ft has a ceiling of 14.34 psia, below the atmospheric floor the
    // solve searches from, so there is no outlet at any rate.
    const starved = gasOutletPressure({
      equation: 'weymouth', qScfd: 1e6, ...ascent, p1Psia: 15.5,
    });
    expect(starved.error).toMatch(/static gas column/);
    // and one psi more of inlet buys it an answer again
    expect(gasOutletPressure({
      equation: 'weymouth', qScfd: 1e3, ...ascent, p1Psia: 17,
    }).error).toBeUndefined();
  });

  test('the flat solve is untouched: every form still round-trips exactly', () => {
    const forms = {
      weymouth: weymouthQ, panhandleA: panhandleAQ, panhandleB: panhandleBQ, general: generalFlowQ,
    };
    Object.keys(forms).forEach((equation) => {
      const q = forms[equation]({ ...GAS, p2Psia: 700 }).qScfd;
      expect(gasOutletPressure({ equation, qScfd: q, ...GAS }).p2Psia).toBeCloseTo(700, 9);
    });
  });
});

describe('named refusals, never a NaN', () => {
  test('the liquid line guards roughness, the resistance sum and the elevation', () => {
    expect(liquidLineDrop({ ...LIQ, roughnessIn: -0.01 }).error).toBeTruthy();
    expect(liquidLineDrop({ ...LIQ, sumK: -5 }).error).toBeTruthy();
    expect(liquidLineDrop({ ...LIQ, lengthFt: 100, elevChangeFt: 9000 }).error).toBeTruthy();
    // boundaries: smooth pipe, no fittings, and a vertical line are all legal
    expect(liquidLineDrop({ ...LIQ, roughnessIn: 0 }).error).toBeUndefined();
    expect(liquidLineDrop({ ...LIQ, sumK: 0 }).error).toBeUndefined();
    expect(liquidLineDrop({ ...LIQ, lengthFt: 100, elevChangeFt: 100 }).error).toBeUndefined();
    expect(liquidLineDrop({ ...LIQ, lengthFt: 100, elevChangeFt: -100 }).error).toBeUndefined();
    expect(liquidLineDrop({ ...LIQ, lengthFt: 100, elevChangeFt: 100.0001 }).error).toBeTruthy();
    // and a negative relative roughness is invalid at the friction factor too
    expect(frictionFactor({ re: 1e6, relRough: -1e-6 }).regime).toBe('invalid');
    expect(frictionFactor({ re: 1e6, relRough: 0 }).regime).toBe('turbulent');
  });

  test('all four gas forms guard the inputs they share', () => {
    const forms = [weymouthQ, panhandleAQ, panhandleBQ, generalFlowQ];
    const bad = [
      { lengthMi: 0 }, { lengthMi: -50 }, { idIn: -12 }, { idIn: 0 },
      { zAvg: 0 }, { tAvgR: 0 }, { sg: 0 }, { p1Psia: 0 }, { p2Psia: 0 },
      { efficiency: 3 }, { efficiency: -1 }, { efficiency: 0 },
      { lengthMi: 1, elevChangeFt: 9000 },
    ];
    forms.forEach((form) => {
      bad.forEach((over) => {
        const r = form({ ...GAS, ...over });
        expect(r.error).toBeTruthy();
        expect(r.qScfd).toBeUndefined();
      });
      // boundaries: E of exactly 1, and a line exactly as tall as it is long
      expect(form({ ...GAS, efficiency: 1 }).error).toBeUndefined();
      expect(form({ ...GAS, efficiency: 1 + 1e-12 }).error).toBeTruthy();
      expect(form({ ...GAS, lengthMi: 1, elevChangeFt: 5280 }).error).toBeUndefined();
      expect(form({ ...GAS, lengthMi: 1, elevChangeFt: 5281 }).error).toBeTruthy();
    });
  });

  test('General Flow guards the two inputs only it takes', () => {
    expect(generalFlowQ({ ...GAS, muCp: 0 }).error).toBeTruthy();
    expect(generalFlowQ({ ...GAS, muCp: -0.01 }).error).toBeTruthy();
    expect(generalFlowQ({ ...GAS, roughnessIn: -0.0007 }).error).toBeTruthy();
    expect(generalFlowQ({ ...GAS, muCp: 1e-9 }).error).toBeUndefined();
    expect(generalFlowQ({ ...GAS, roughnessIn: 0 }).error).toBeUndefined();
  });

  test('the elevation group refuses what it cannot exponentiate', () => {
    expect(elevationAdjustment({ sg: 0.65, elevChangeFt: 800, tAvgR: 540, zAvg: 0 }).error).toBeTruthy();
    expect(elevationAdjustment({ sg: 0.65, elevChangeFt: 800, tAvgR: 0, zAvg: 0.9 }).error).toBeTruthy();
    expect(elevationAdjustment({ sg: 0, elevChangeFt: 800, tAvgR: 540, zAvg: 0.9 }).error).toBeTruthy();
    expect(elevationAdjustment({ sg: 0.65, elevChangeFt: 0, tAvgR: 540, zAvg: 0.9 }).es).toBe(1);
  });

  test('the wall guards the two factors in its denominator and the allowance', () => {
    expect(requiredWallIn({ ...WALL, jointFactor: 0 }).error).toBeTruthy();
    expect(requiredWallIn({ ...WALL, jointFactor: 1.1 }).error).toBeTruthy();
    expect(requiredWallIn({ ...WALL, tempDerate: 0 }).error).toBeTruthy();
    expect(requiredWallIn({ ...WALL, tempDerate: 1.1 }).error).toBeTruthy();
    expect(requiredWallIn({ ...WALL, corrosionAllowanceIn: -0.5 }).error).toBeTruthy();
    expect(requiredWallIn({ ...WALL, jointFactor: 1, tempDerate: 1, corrosionAllowanceIn: 0 }).error)
      .toBeUndefined();
    expect(requiredWallIn({ ...WALL, jointFactor: 0.6 }).tRequiredIn)
      .toBeGreaterThan(requiredWallIn({ ...WALL }).tRequiredIn);
    // and the rating read back the other way guards the same allowance
    expect(maopPsig({ ...WALL, wallIn: 0.375, corrosionAllowanceIn: -0.5 }).error).toBeTruthy();
    expect(maopPsig({ ...WALL, wallIn: 0, corrosionAllowanceIn: 0 }).error).toBeTruthy();
    expect(maopPsig({ ...WALL, wallIn: 0.375, jointFactor: 0 }).error).toBeTruthy();
  });

  test('the pigging chain guards the bore, the length and the sweep', () => {
    expect(sweptLiquidBbl({ idIn: 0, lengthFt: 1000, holdupFrac: 0.1 }).error).toBeTruthy();
    expect(sweptLiquidBbl({ idIn: 6, lengthFt: -100, holdupFrac: 0.1 }).error).toBeTruthy();
    expect(sweptLiquidBbl({ idIn: 6, lengthFt: 100, holdupFrac: 0 }).sweptBbl).toBe(0);
    expect(sweptLiquidBbl({ idIn: 6, lengthFt: 100, holdupFrac: 1 }).sweptBbl)
      .toBeCloseTo(lineVolumeBbl({ idIn: 6, lengthFt: 100 }), 12);
    expect(piggingInterval({ maxSlugBbl: 100, dropoutBpd: 25, sweptBbl: -500 }).error).toBeTruthy();
    expect(piggingInterval({ maxSlugBbl: 100, dropoutBpd: 25, sweptBbl: 0 }).intervalDays).toBe(4);
  });

  test('the traverse refuses a march that leaves the physical range, and says where', () => {
    const dead = liquidLineTraverse({
      p1Psia: 100, qBpd: 20000, idIn: 2.067, rhoLbFt3: 56, muCp: 8,
      profile: [{ lengthFt: 20000 }],
    });
    expect(dead.error).toMatch(/zero absolute/);
    expect(dead.diedAtFt).toBe(20000);
    expect(dead.diedAtPsia).toBeLessThan(0);
    expect(dead.stations).toHaveLength(1);      // only the physical ones
    expect(dead.p2Psia).toBeUndefined();
    // the same line short enough to survive still answers
    const alive = liquidLineTraverse({
      p1Psia: 100, qBpd: 20000, idIn: 2.067, rhoLbFt3: 56, muCp: 8,
      profile: [{ lengthFt: 20 }],
    });
    expect(alive.error).toBeUndefined();
    expect(alive.p2Psia).toBeGreaterThan(0);
    // and it needs an inlet pressure at all: this used to return NaN stations
    expect(liquidLineTraverse({
      qBpd: 5000, idIn: 6, rhoLbFt3: 55, muCp: 2, profile: [{ lengthFt: 1000 }],
    }).error).toBeTruthy();
    expect(liquidLineTraverse({
      p1Psia: 0, qBpd: 5000, idIn: 6, rhoLbFt3: 55, muCp: 2, profile: [{ lengthFt: 1000 }],
    }).error).toBeTruthy();
  });

  test('NOTHING in this module returns a non-finite number without an error', () => {
    const calls = [
      () => liquidLineDrop({ ...LIQ, roughnessIn: -0.01 }),
      () => liquidLineDrop({ ...LIQ, sumK: -5 }),
      () => liquidLineDrop({ ...LIQ, lengthFt: 100, elevChangeFt: 9000 }),
      () => weymouthQ({ ...GAS, lengthMi: 0 }),
      () => weymouthQ({ ...GAS, lengthMi: -50 }),
      () => weymouthQ({ ...GAS, idIn: -12 }),
      () => weymouthQ({ ...GAS, zAvg: 0 }),
      () => weymouthQ({ ...GAS, tAvgR: 0 }),
      () => weymouthQ({ ...GAS, efficiency: 3 }),
      () => weymouthQ({ ...GAS, efficiency: -1 }),
      () => panhandleAQ({ ...GAS, sg: 0 }),
      () => panhandleBQ({ ...GAS, zAvg: 0 }),
      () => generalFlowQ({ ...GAS, muCp: 0 }),
      () => gasOutletPressure({ equation: 'weymouth', qScfd: 1e6, ...GAS, idIn: -8 }),
      () => requiredWallIn({ ...WALL, tempDerate: 0 }),
      () => requiredWallIn({ ...WALL, jointFactor: 0 }),
      () => requiredWallIn({ ...WALL, corrosionAllowanceIn: -0.5 }),
      () => maopPsig({ ...WALL, wallIn: 0.375, corrosionAllowanceIn: -0.5 }),
      () => sweptLiquidBbl({ idIn: 0, lengthFt: 1000, holdupFrac: 0.1 }),
      () => sweptLiquidBbl({ idIn: 6, lengthFt: -100, holdupFrac: 0.1 }),
      () => piggingInterval({ maxSlugBbl: 100, dropoutBpd: 25, sweptBbl: -500 }),
      () => liquidLineTraverse({ qBpd: 5000, idIn: 6, rhoLbFt3: 55, muCp: 2, profile: [{ lengthFt: 1 }] }),
    ];
    calls.forEach((call) => {
      const r = call();
      expect(r.error).toBeTruthy();
      Object.entries(r).forEach(([k, v]) => {
        if (typeof v === 'number') {
          // diedAtPsia is the unphysical value being REPORTED, beside an error
          expect(Number.isFinite(v)).toBe(true);
          if (k !== 'diedAtFt' && k !== 'diedAtPsia') expect(v).not.toBeNaN();
        }
      });
    });
  });
});

describe('one barrel for the package', () => {
  test('lineHydraulics and chokePerformance measure the same cubic feet per barrel', () => {
    const idIn = 7.981; const lengthFt = 26400; const rhoLbFt3 = 54.5; const cFactor = 100;
    const areaFt2 = (Math.PI * idIn * idIn) / (4 * 144);
    // asked of each module through its own public return, not read off a source
    const fromLine = (areaFt2 * lengthFt) / lineVolumeBbl({ idIn, lengthFt });
    const ve = erosionalVelocityFtS({ mixtureDensityLbFt3: rhoLbFt3, cFactor });
    const fromChoke = (ve * pipeAreaFt2(idIn) * 86400)
      / erosionalRateBpd({ idIn, mixtureDensityLbFt3: rhoLbFt3, cFactor });
    expect(rel(fromLine, fromChoke)).toBeLessThan(1e-15);
    // and the one they share is the EXACT barrel, not a rounding of it
    expect(fromLine).toBeCloseTo((42 * 231) / 1728, 12);
  });
});
