// Facilities F4 heat-transfer gates.
//
// WHAT THIS GATE EXAMINES, and what it cannot. The shipped version of
// this file passed 19 of 19 while forty-two defects were planted in the
// engine one at a time and THIRTEEN of them left it green, including
// inverting the bundle-diameter exponent, dropping the pi out of the
// tube surface area and SQUARING the hot-day duty fraction. Ten more
// were planted in the engine and the oracle TOGETHER and eight left it
// green, including replacing the air cooler's log mean with an
// arithmetic mean, because three of the six oracle routes were the
// engine's own expressions written in SI and converted back.
//
// Three things replace that:
//
//  1. INDEPENDENT ROUTES. The oracle's docstring lists what each route
//     checks and what it cannot. Nothing here calls a route
//     independent that is not.
//  2. CONSTANT PINS. A fitted constant cannot be validated by any
//     oracle, so the fits are pinned BY LITERAL here, which is a third
//     copy the engine and the oracle cannot both move past. A PIN IS
//     NOT A VALIDATION and nothing in the F4 course may present it as
//     one; what it buys is that moving 0.023 is a reviewed act.
//  3. SELF-CONSISTENCY. Several of the worst defects in this module
//     were the engine's own numbers contradicting each other: an area
//     that did not satisfy Q = U A dTlm with the LMTD the engine itself
//     reported, and a hot-day duty that implied a 24.4 F air rise while
//     the engine reported 30. Those identities are gates now.
//
// The rounded constants (2.4191, 10.7316) are NOT moved: they are
// measured against derivations and the residual they cause downstream
// is asserted to EQUAL the rounding, so the named cause is itself a
// gate.
//
// EVERY GOLDEN ROW IS SYNTHETIC. This repository carries no published
// heat exchanger case, and inventing a citation would be worse than
// saying so. What stands in for published data is route independence,
// the pins, and a block of ANALYTIC LIMITS that need no citation.

import fs from 'fs';
import path from 'path';
import {
  capacityRate, energyBalance, lmtd, lmtdGroups, lmtdCorrectionF,
  overallUOutside, tubeSideFilm, areaRequired, tubeCount, bundleConstants,
  effectivenessFromNtu, ntuFromEffectiveness,
  airDensityLbFt3, airCooler,
  DECLARED_CONSTANTS, DECLARED_BOUNDS, HELD_FOR_LITERATURE,
} from '../engines/facilities/heatTransfer';

const GOLDEN_PATH = path.join(
  __dirname, '..', 'test-data', 'facilities', 'goldens', 'heattransfer_cases.json',
);
const G = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

const rel = (a, b) => {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  if (a === b) return 0;
  return Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
};

// A gate that cannot do its job must refuse, not pass. The row counts
// below are asserted so that an oracle run that silently dropped a
// section fails here instead of reporting a green suite over nothing.
const EXPECTED_ROWS = {
  lmtd: 6, lmtdParallel: 2, lmtdGroups: 2, fCorrection: 5, fMultiShell: 7,
  epsNtu: 13, ntuFromEps: 5, ceilings: 4, capacityRate: 3, energyBalance: 2,
  areaRequired: 2, u: 3, tubeFilm: 4, tubeCount: 5, airCooler: 4, hotDay: 5,
};

describe('the golden itself', () => {
  test('carries every section this gate examines, at its stated size', () => {
    Object.entries(EXPECTED_ROWS).forEach(([section, count]) => {
      expect(Array.isArray(G[section])).toBe(true);
      expect(G[section]).toHaveLength(count);
    });
    ['derivedConstants', 'uDefaults', 'airCoolerDefaults'].forEach((k) => {
      expect(typeof G[k]).toBe('object');
      expect(G[k]).not.toBeNull();
    });
    // 75 rows across 19 sections, against 18 rows across 6 before FC6-0.
    const rows = Object.values(G)
      .reduce((acc, v) => acc + (Array.isArray(v) ? v.length : 1), 0);
    expect(rows).toBe(75);
  });
});

/* ------------------------------------------------------------------ *
 * 1. The constants, pinned and measured
 * ------------------------------------------------------------------ */

describe('declared constants', () => {
  // A PIN, NOT A VALIDATION. These are fits and tables; no oracle can
  // derive them. What the pin buys is that moving one fails here.
  test('the fitted constants are the ones this module shipped with', () => {
    expect(DECLARED_CONSTANTS.dittusBoelterA).toBe(0.023);
    expect(DECLARED_CONSTANTS.dittusBoelterReExp).toBe(0.8);
    expect(DECLARED_CONSTANTS.dittusBoelterPrExpHeating).toBe(0.4);
    expect(DECLARED_CONSTANTS.siederTateExp).toBe(0.14);
    expect(DECLARED_CONSTANTS.laminarNusselt).toBe(3.66);
    expect(DECLARED_CONSTANTS.transitionReLow).toBe(2300);
    expect(DECLARED_CONSTANTS.transitionReHigh).toBe(10000);
    expect(DECLARED_CONSTANTS.cpToLbFtHr).toBe(2.4191);
    expect(DECLARED_CONSTANTS.airMolecularWeight).toBe(28.9625);
    expect(DECLARED_CONSTANTS.gasConstantPsiaFt3LbmolR).toBe(10.7316);
    expect(DECLARED_CONSTANTS.standardBarometricPsia).toBe(14.7);
    expect(DECLARED_CONSTANTS.airCpBtuLbF).toBe(0.24);
    expect(DECLARED_CONSTANTS.fanConstant).toBe(6356);
  });

  test('the defaults are pinned too, because every golden row used to state them', () => {
    expect(DECLARED_CONSTANTS.defaultKWallBtuHrFtF).toBe(26);
    expect(DECLARED_CONSTANTS.defaultStaticPressureInH2O).toBe(0.6);
    expect(DECLARED_CONSTANTS.defaultFanEfficiency).toBe(0.65);
    expect(DECLARED_CONSTANTS.defaultMotorEfficiency).toBe(0.92);
    expect(DECLARED_BOUNDS.maxShellPasses).toBe(6);
    expect(DECLARED_BOUNDS.controllingMarginPct).toBe(10);
  });

  test('the eight bundle pairs are pinned, and 45 and 90 are IDENTICAL', () => {
    const k = bundleConstants();
    expect(k['30']).toEqual({
      1: { k: 0.319, n: 2.142 }, 2: { k: 0.249, n: 2.207 },
      4: { k: 0.175, n: 2.285 }, 6: { k: 0.0743, n: 2.499 },
    });
    expect(k['45']).toEqual({
      1: { k: 0.215, n: 2.207 }, 2: { k: 0.156, n: 2.291 },
      4: { k: 0.158, n: 2.263 }, 6: { k: 0.0402, n: 2.617 },
    });
    // This is a FINDING recorded as a test: the two square-pitch rows
    // carried here are byte-identical, so the layout input does nothing
    // between them, and the module's return says so.
    expect(k['90']).toEqual(k['45']);
    expect(HELD_FOR_LITERATURE.bundleConstants).toMatch(/IDENTICAL/);
  });

  test('every held-for-literature item is recorded rather than graded', () => {
    expect(Object.keys(HELD_FOR_LITERATURE).sort()).toEqual([
      'bundleConstants', 'crossFlowF', 'defaultsProvenance',
      'dittusBoelterBand', 'dittusBoelterCoolingExponent',
      'fanConstantWaterDensity', 'siederTateExponent',
    ]);
    Object.values(HELD_FOR_LITERATURE).forEach((s) => {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(40);
    });
  });
});

describe('the rounded constants, measured against derivations', () => {
  // The oracle derives these from the international Btu, the
  // international foot, the pound, standard gravity and the SI gas
  // constant. The engine carries customary roundings of two of them.
  // The roundings are KEPT -- moving them would move every shipped
  // number in the platform -- and the residual each one causes
  // downstream is asserted to EQUAL it, so the named cause is a gate.
  const D = G.derivedConstants;

  test('the derivations themselves are the ones this gate was written against', () => {
    expect(D.cpToLbFtHrDerived).toBeCloseTo(2.4190883105022247, 12);
    expect(D.gasConstantPsiaFt3LbmolRDerived).toBeCloseTo(10.73157708901629, 10);
    expect(D.uBtuToSi).toBeCloseTo(5.678263341113487, 10);
    expect(D.kBtuToSi).toBeCloseTo(1.730734666371391, 10);
    expect(D.cpBtuToSi).toBeCloseTo(4186.8, 6);
    expect(D.psiPa).toBeCloseTo(6894.757293168361, 8);
    expect(D.hpW).toBeCloseTo(745.6998715822702, 8);
  });

  test('the viscosity conversion is a rounding of 4.83 ppm, and that is ALL it is', () => {
    const ratio = DECLARED_CONSTANTS.cpToLbFtHr / D.cpToLbFtHrDerived;
    expect(ratio).toBeCloseTo(1.0000048324, 9);
    expect(Math.abs(ratio - 1)).toBeLessThan(1e-5);
  });

  test('the gas constant is a rounding of 2.13 ppm', () => {
    const ratio = DECLARED_CONSTANTS.gasConstantPsiaFt3LbmolR
      / D.gasConstantPsiaFt3LbmolRDerived;
    expect(ratio).toBeCloseTo(1.0000021349, 9);
  });

  test('the fan constant 6356 implies water at 62.3033 lb/ft3, which is MEASURED and not cited', () => {
    // 33000 ft.lbf/min per hp, over 6356, over 12 in/ft.
    const implied = 33000 / DECLARED_CONSTANTS.fanConstant * 12;
    expect(implied).toBeCloseTo(62.303335431088726, 9);
    expect(D.waterLbFt3ImpliedBy6356).toBeCloseTo(implied, 9);
    expect(HELD_FOR_LITERATURE.fanConstantWaterDensity).toMatch(/62\.3033/);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Energy balance
 * ------------------------------------------------------------------ */

describe('capacity rate', () => {
  test('matches the balance carried out in kg/s and J/(kg.K)', () => {
    G.capacityRate.forEach((row) => {
      const r = capacityRate(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.cBtuHrF, row.cBtuHrF)).toBeLessThan(1e-12);
    });
  });

  test('CARRIES THE ERROR CONTRACT: it used to return a bare NaN', () => {
    // NEGATIVE CONTROL. A bare NaN sailed past every downstream
    // `if (r.error)` guard and the studio rendered a card of dashes.
    [{ mLbHr: 0, cpBtuLbF: 0.5 }, { mLbHr: -50, cpBtuLbF: 0.5 },
      { mLbHr: NaN, cpBtuLbF: 0.5 }, { mLbHr: 50, cpBtuLbF: 0 }].forEach((bad) => {
      const r = capacityRate(bad);
      expect(typeof r).toBe('object');
      expect(r.error).toBeTruthy();
      expect(r.cBtuHrF).toBeUndefined();
    });
    expect(capacityRate({ mLbHr: -50, cpBtuLbF: 0.5 }).error).toContain('-50');
  });
});

describe('energy balance', () => {
  test('the outlet temperatures match the balance solved in kelvin through watts', () => {
    G.energyBalance.forEach((row) => {
      const r = energyBalance(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.thOut, row.thOut)).toBeLessThan(1e-12);
      expect(rel(r.tcOut, row.tcOut)).toBeLessThan(1e-12);
      // and it closes on itself, both ways round
      expect(rel(row.cHot * (row.thIn - r.thOut), row.qBtuHr)).toBeLessThan(1e-12);
      expect(rel(row.cCold * (r.tcOut - row.tcIn), row.qBtuHr)).toBeLessThan(1e-12);
    });
  });

  test('closes from a duty or from either outlet, consistently', () => {
    const cHot = capacityRate({ mLbHr: 50000, cpBtuLbF: 0.55 }).cBtuHrF;
    const cCold = capacityRate({ mLbHr: 80000, cpBtuLbF: 1.0 }).cBtuHrF;
    const fromQ = energyBalance({ cHot, cCold, thIn: 300, tcIn: 100, qBtuHr: 2.75e6 });
    const fromHot = energyBalance({ cHot, cCold, thIn: 300, tcIn: 100, thOut: fromQ.thOut });
    const fromCold = energyBalance({ cHot, cCold, thIn: 300, tcIn: 100, tcOut: fromQ.tcOut });
    expect(rel(fromHot.qBtuHr, 2.75e6)).toBeLessThan(1e-12);
    expect(rel(fromCold.qBtuHr, 2.75e6)).toBeLessThan(1e-12);
    expect(fromQ.basis).toBe('stated duty');
    expect(fromHot.basis).toBe('hot outlet');
    expect(fromCold.basis).toBe('cold outlet');
  });

  test('REFUSES an outlet that moves the wrong way, which used to return a NEGATIVE duty', () => {
    // NEGATIVE CONTROL, and the worst fails-open in the module: a hot
    // outlet of 320 F against a 300 F hot inlet used to return
    // { qBtuHr: -550000, thOut: 320, tcOut: 93.13 } with no error key,
    // and the studio printed "Duty -0.55 MMBtu/hr" and "Cold outlet
    // 93.1 F" on three tabs. The cross guard cannot fire when BOTH
    // temperatures move away from the cross.
    const cHot = 27500;
    const cCold = 80000;
    [320, 350, 400].forEach((thOut) => {
      const r = energyBalance({ cHot, cCold, thIn: 300, tcIn: 100, thOut });
      expect(r.error).toBeTruthy();
      expect(r.error).toContain(String(thOut));
      expect(r.error).toContain('300');
      expect(r.qBtuHr).toBeUndefined();
    });
    [90, 50].forEach((tcOut) => {
      const r = energyBalance({ cHot, cCold, thIn: 300, tcIn: 100, tcOut });
      expect(r.error).toBeTruthy();
      expect(r.error).toContain(String(tcOut));
      expect(r.qBtuHr).toBeUndefined();
    });
    // the boundary: an outlet equal to its own inlet exchanges nothing
    const none = energyBalance({ cHot, cCold, thIn: 300, tcIn: 100, thOut: 300 });
    expect(none.error).toMatch(/exchanges no heat/);
  });

  test('the cross test MATCHES THE ARRANGEMENT', () => {
    // It used to be the counter-current test whatever the arrangement,
    // so between 4.0 and 5.5 MMBtu/hr in parallel flow the balance
    // passed a duty no parallel exchanger can deliver and `lmtd` caught
    // it two functions later with a generic message. TWO FUNCTIONS
    // DISAGREED AND THE TRUSTING HALF WAS THIS ONE.
    const cHot = 27500;
    const cCold = 80000;
    const at = (qBtuHr, arrangement) => energyBalance({
      cHot, cCold, thIn: 300, tcIn: 100, qBtuHr, arrangement,
    });
    expect(at(2.75e6, 'parallel').error).toBeUndefined();
    // 4.0 MMBtu/hr a parallel unit still just reaches: 154.5 F against
    // 150.0 F. The window the old guard let through starts just above it.
    expect(at(4.0e6, 'parallel').error).toBeUndefined();
    [4.2e6, 4.5e6, 5.0e6].forEach((q) => {
      const par = at(q, 'parallel');
      const cnt = at(q, 'counter');
      expect(cnt.error).toBeUndefined();          // a counter unit does it
      expect(par.error).toMatch(/PARALLEL/);      // a parallel one cannot
      expect(par.error).toContain('crossed inside');
      // and the refusal carries the temperatures that made it
      expect(par.thOutIfReached).toBeLessThan(par.tcOutIfReached);
    });
    // 5.5 MMBtu/hr is beyond BOTH
    expect(at(5.5e6, 'counter').error).toMatch(/crosses the streams/);
    expect(at(5.5e6, 'parallel').error).toBeTruthy();
  });

  test('a stated duty no longer discards a stated outlet beside it', () => {
    const cHot = 27500;
    const cCold = 80000;
    const ok = energyBalance({
      cHot, cCold, thIn: 300, tcIn: 100, qBtuHr: 2.75e6, thOut: 200,
    });
    expect(ok.error).toBeUndefined();
    const clash = energyBalance({
      cHot, cCold, thIn: 300, tcIn: 100, qBtuHr: 2.75e6, thOut: 250,
    });
    expect(clash.error).toMatch(/disagree/);
    expect(clash.error).toContain('250');
    expect(clash.error).toContain('200');
  });

  test('a zero or negative stated duty is refused instead of falling through', () => {
    const cHot = 27500;
    const cCold = 80000;
    [0, -5e6].forEach((qBtuHr) => {
      const r = energyBalance({ cHot, cCold, thIn: 300, tcIn: 100, qBtuHr });
      expect(r.error).toMatch(/must be positive/);
      expect(r.error).toContain(String(qBtuHr));
    });
    expect(energyBalance({ cHot, cCold, thIn: 300, tcIn: 100 }).error)
      .toMatch(/duty or one outlet/);
    expect(energyBalance({ cHot, cCold, thIn: 100, tcIn: 300, qBtuHr: 1e5 }).error)
      .toMatch(/hotter than the cold inlet/);
    expect(energyBalance({ cHot: 0, cCold, thIn: 300, tcIn: 100, qBtuHr: 1e5 }).error)
      .toMatch(/hot capacity rate/);
  });
});

/* ------------------------------------------------------------------ *
 * 3. LMTD, P and R, and the F correction
 * ------------------------------------------------------------------ */

describe('LMTD', () => {
  test('the log mean matches INTEGRATION of the driving force, at unequal ends', () => {
    // The oracle integrates 1/dT over the duty and inverts, which never
    // evaluates a logarithm. One of the three rows this suite used to
    // carry, (400, 380, 100, 120), has EQUAL end approaches, so the
    // engine takes its `Math.abs(dt1-dt2) < 1e-9` shortcut and the
    // logarithm is never reached: two rows carried the log-mean route,
    // not three. Two more unequal-ends rows are in the golden now, one
    // of them at an end ratio above 7.
    const unequal = G.lmtd.filter((row) => !row.equalEnds);
    expect(unequal.length).toBeGreaterThanOrEqual(5);
    let maxRatio = 0;
    G.lmtd.forEach((row) => {
      const r = lmtd(row);
      expect(r.error).toBeUndefined();
      expect(r.equalEnds).toBe(row.equalEnds);
      expect(rel(r.lmtdF, row.lmtdF)).toBeLessThan(1e-8);
      expect(rel(r.dt1, row.dt1)).toBeLessThan(1e-12);
      expect(rel(r.dt2, row.dt2)).toBeLessThan(1e-12);
      maxRatio = Math.max(maxRatio, Math.max(r.dt1 / r.dt2, r.dt2 / r.dt1));
      // the log mean always lies between the two ends
      expect(r.lmtdF).toBeLessThanOrEqual(Math.max(r.dt1, r.dt2) + 1e-9);
      expect(r.lmtdF).toBeGreaterThanOrEqual(Math.min(r.dt1, r.dt2) - 1e-9);
    });
    expect(maxRatio).toBeGreaterThan(25);
  });

  test('the PARALLEL ends are the other pair, and the golden says so', () => {
    G.lmtdParallel.forEach((row) => {
      const r = lmtd({ ...row, arrangement: 'parallel' });
      expect(r.error).toBeUndefined();
      expect(r.basis).toBe('parallel');
      expect(rel(r.lmtdF, row.lmtdF)).toBeLessThan(1e-8);
      // and it is genuinely lower than the counter-current one: 78.17
      // against 109.70 on the studio's own default stream pair
      expect(r.lmtdF).toBeLessThan(lmtd(row).lmtdF);
    });
  });

  test('equal-approach ends give the arithmetic mean, and a cross refuses BY NUMBER', () => {
    const equal = lmtd({ thIn: 300, thOut: 200, tcIn: 100, tcOut: 200 });
    expect(equal.lmtdF).toBeCloseTo(100, 9);
    expect(equal.equalEnds).toBe(true);
    const crossed = lmtd({ thIn: 200, thOut: 150, tcIn: 100, tcOut: 220 });
    expect(crossed.error).toMatch(/cross/);
    expect(crossed.error).toContain('-20.00');   // the end that is not positive
    expect(crossed.dt1).toBeLessThan(0);
  });

  test('a shell1 log mean says it is the counter-current one and needs F', () => {
    const r = lmtd({ thIn: 300, thOut: 200, tcIn: 100, tcOut: 180, arrangement: 'shell1' });
    expect(r.basis).toBe('counter');
    expect(r.note).toMatch(/multiplied by F/);
    expect(r.lmtdF).toBeCloseTo(lmtd({ thIn: 300, thOut: 200, tcIn: 100, tcOut: 180 }).lmtdF, 12);
  });

  test('an EMPTY temperature box is named, not reported as a cross', () => {
    // NEGATIVE CONTROL. A blank box used to come back as a temperature
    // cross the user never created.
    const r = lmtd({ thIn: 300, thOut: NaN, tcIn: 100, tcOut: 180 });
    expect(r.error).toMatch(/all four terminal temperatures/);
    expect(r.error).toContain('thOut');
    expect(r.error).not.toMatch(/cross/);
  });
});

describe('arrangement matching', () => {
  // NEGATIVE CONTROL for the silent fall-through. `===` against one
  // lowercase string meant 'Parallel' returned the COUNTER-CURRENT
  // answer, a 40 percent error on the driving force, in three
  // functions. Reachable from any saved study, because the payload
  // restore spread stored strings in without validating them.
  const capitalised = ['Parallel', 'PARALLEL', ' parallel ', 'Counter', 'Shell1'];
  const unknown = ['crossflow', 'cross-flow', '', 'counterflow', null, 7];

  test('case and space no longer change the answer', () => {
    capitalised.forEach((a) => {
      const key = a.trim().toLowerCase();
      expect(effectivenessFromNtu({ ntu: 2, cr: 0.7, arrangement: a }).arrangement).toBe(key);
      expect(ntuFromEffectiveness({ effectiveness: 0.5, cr: 0.5, arrangement: a }).arrangement).toBe(key);
    });
    expect(lmtd({
      thIn: 300, thOut: 200, tcIn: 100, tcOut: 180, arrangement: 'Parallel',
    }).lmtdF).toBeCloseTo(78.17300674, 6);
    expect(effectivenessFromNtu({ ntu: 2, cr: 0.7, arrangement: 'Parallel' }).effectiveness)
      .toBeCloseTo(0.568603958846867, 12);
  });

  test('an unknown arrangement is REFUSED in all four functions', () => {
    unknown.forEach((a) => {
      [
        effectivenessFromNtu({ ntu: 2, cr: 0.7, arrangement: a }),
        ntuFromEffectiveness({ effectiveness: 0.5, cr: 0.5, arrangement: a }),
        lmtd({ thIn: 300, thOut: 200, tcIn: 100, tcOut: 180, arrangement: a }),
        energyBalance({ cHot: 27500, cCold: 80000, thIn: 300, tcIn: 100, qBtuHr: 2e6, arrangement: a }),
      ].forEach((r) => {
        expect(r.error).toBeTruthy();
        expect(r.error).toMatch(/arrangement/);
      });
    });
    expect(effectivenessFromNtu({ ntu: 2, cr: 0.7, arrangement: 'crossflow' }).error)
      .toContain('crossflow');
    // omitting it entirely still defaults to counter-current, documented
    expect(effectivenessFromNtu({ ntu: 2, cr: 0.7 }).arrangement).toBe('counter');
  });
});

describe('P and R', () => {
  test('come from the terminal temperatures', () => {
    G.lmtdGroups.forEach((row) => {
      const g = lmtdGroups(row);
      expect(g.error).toBeUndefined();
      expect(rel(g.p, row.p)).toBeLessThan(1e-12);
      expect(rel(g.r, row.r)).toBeLessThan(1e-12);
    });
  });

  test('a cold stream that does not change temperature is REFUSED, not reported as R = Infinity', () => {
    // NEGATIVE CONTROL. R came back Infinity and `lmtdCorrectionF` then
    // blamed the shell count: "add shell passes". No number of shells
    // fixes a zero cold-side rise.
    const r = lmtdGroups({ thIn: 300, thOut: 250, tcIn: 100, tcOut: 100 });
    expect(r.error).toMatch(/does not change temperature/);
    expect(r.error).not.toMatch(/add shell/i);
    expect(r.r).toBeUndefined();
    expect(lmtdGroups({ thIn: 100, thOut: 90, tcIn: 100, tcOut: 110 }).error)
      .toMatch(/no temperature span/);
    expect(lmtdGroups({ thIn: 300, thOut: NaN, tcIn: 100, tcOut: 180 }).error)
      .toContain('thOut');
  });
});

describe('the LMTD correction factor', () => {
  test('Bowman matches F = NTU_counter / NTU_1-2 where the 1-2 NTU comes from the ODE', () => {
    // The oracle inverts a THREE-STREAM RK4 march of the 1-2 shell,
    // with the tube fluid's turn-around as a boundary condition. It
    // restates no part of Bowman's closed form.
    G.fCorrection.forEach((row) => {
      const r = lmtdCorrectionF({ p: row.p, r: row.r, shellPasses: row.shellPasses });
      expect(r.error).toBeUndefined();
      expect(rel(r.f, row.f)).toBeLessThan(1e-9);
      expect(r.shellPasses).toBe(1);
    });
  });

  test('the N-SHELL CONVERSION matches marching N shells in series', () => {
    // The recon proved this conversion CORRECT and proved that NOBODY
    // CHECKED IT: inverting its `1/n` exponent to `n` left the shipped
    // suite 19 of 19 green. A route already proved right still needs a
    // row, or the next edit breaks it silently.
    G.fMultiShell.forEach((row) => {
      const r = lmtdCorrectionF({ p: row.p, r: row.r, shellPasses: row.shellPasses });
      expect(r.error).toBeUndefined();
      expect(r.shellPasses).toBe(row.shellPasses);
      // the equivalent single-shell P the conversion produces is the one
      // that, marched through N shells in series, reproduces the stated P
      expect(rel(r.p1, row.p1)).toBeLessThan(1e-9);
      expect(rel(r.f, row.f)).toBeLessThan(1e-9);
    });
    // and it covers R != 1, which the shipped suite never reached
    expect(G.fMultiShell.filter((row) => row.r !== 1).length).toBeGreaterThanOrEqual(5);
  });

  test('F is at most 1, falls as the duty gets harder, and warns below 0.8', () => {
    const easy = lmtdCorrectionF({ p: 0.1, r: 1.0 });
    const mid = lmtdCorrectionF({ p: 0.45, r: 1.0 });
    const hard = lmtdCorrectionF({ p: 0.55, r: 1.0 });
    expect(easy.f).toBeLessThanOrEqual(1);
    expect(easy.f).toBeGreaterThan(mid.f);
    expect(mid.f).toBeGreaterThan(hard.f);
    expect(easy.warning).toBeNull();
    expect(hard.warning).toMatch(/Add a shell pass/);
  });

  test('more shell passes recover a duty a single shell cannot reach', () => {
    const one = lmtdCorrectionF({ p: 0.6, r: 1.0, shellPasses: 1 });
    const two = lmtdCorrectionF({ p: 0.6, r: 1.0, shellPasses: 2 });
    expect(one.error).toBeTruthy();
    expect(two.error).toBeUndefined();
    expect(two.f).toBeGreaterThan(0.8);
    expect(lmtdCorrectionF({ p: 0.75, r: 1.0, shellPasses: 2 }).error).toBeTruthy();
    expect(lmtdCorrectionF({ p: 0.75, r: 1.0, shellPasses: 3 }).f).toBeGreaterThan(0.8);
  });

  test('SHELL PASSES ARE BOUNDED AND NOT ROUNDED', () => {
    // NEGATIVE CONTROL. 2.4 and 2.6 used to be taken silently as 2 and
    // 3, which differ by 6.6 percent on F; 1000 shells returned F =
    // 0.999998, so any unreachable duty became reachable by typing a
    // bigger number. The bound is DECLARED by this module, not
    // published, and the message says so.
    const fractional = lmtdCorrectionF({ p: 0.5, r: 1.2, shellPasses: 2.4 });
    expect(fractional.error).toMatch(/whole numbers/);
    expect(fractional.error).toContain('2.4');
    expect(fractional.error).toContain('2');
    expect(fractional.error).toContain('3');
    // the 6.6 percent the silent rounding used to hide
    const two = lmtdCorrectionF({ p: 0.5, r: 1.2, shellPasses: 2 }).f;
    const three = lmtdCorrectionF({ p: 0.5, r: 1.2, shellPasses: 3 }).f;
    expect((three - two) / two).toBeGreaterThan(0.02);
    [0, -1, 7, 10, 100, 1000].forEach((n) => {
      const r = lmtdCorrectionF({ p: 0.5, r: 1.2, shellPasses: n });
      expect(r.error).toBeTruthy();
      expect(r.error).toContain(String(n));
      expect(r.f).toBeUndefined();
    });
    expect(lmtdCorrectionF({ p: 0.5, r: 1.2, shellPasses: 6 }).error).toBeUndefined();
    expect(lmtdCorrectionF({ p: 0.5, r: 1.2, shellPasses: NaN }).error).toMatch(/must be a number/);
    expect(lmtdCorrectionF({ p: 1.2, r: 1.0 }).error).toContain('1.2');
    expect(lmtdCorrectionF({ p: 0.4, r: -1 }).error).toContain('-1');
  });
});

/* ------------------------------------------------------------------ *
 * 4. Effectiveness-NTU
 * ------------------------------------------------------------------ */

describe('effectiveness-NTU', () => {
  test('all THREE arrangements match an RK4 march of their own ODEs', () => {
    // Counter-current was the only arrangement the shipped golden
    // reached. Parallel and 1-2 shell were checked ONLY against their
    // own inverses, an identity that holds for any mutually inverse
    // pair whether either one is right, plus one ordering assertion.
    const seen = new Set();
    G.epsNtu.forEach((row) => {
      const e = effectivenessFromNtu(row);
      expect(e.error).toBeUndefined();
      expect(rel(e.effectiveness, row.epsOde)).toBeLessThan(1e-9);
      seen.add(row.arrangement);
    });
    expect([...seen].sort()).toEqual(['counter', 'parallel', 'shell1']);
  });

  test('NTU from effectiveness is inverted from the ODE, not from the engine', () => {
    G.ntuFromEps.forEach((row) => {
      const r = ntuFromEffectiveness(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.ntu, row.ntu)).toBeLessThan(1e-8);
    });
  });

  test('the ANALYTIC CEILINGS are reached and reported, and counter-current has NONE', () => {
    // These are analytic limits, not published data, and they need no
    // citation: as NTU grows without bound a parallel unit tends to
    // 1/(1+Cr) and a 1-2 shell to 2/(1+Cr+sqrt(1+Cr^2)).
    G.ceilings.forEach((row) => {
      const par = effectivenessFromNtu({ ntu: 1, cr: row.cr, arrangement: 'parallel' });
      const sh = effectivenessFromNtu({ ntu: 1, cr: row.cr, arrangement: 'shell1' });
      expect(rel(par.ceiling, row.parallel)).toBeLessThan(1e-12);
      expect(rel(sh.ceiling, row.shell1)).toBeLessThan(1e-12);
      expect(rel(
        effectivenessFromNtu({ ntu: 60, cr: row.cr, arrangement: 'parallel' }).effectiveness,
        row.parallelAtHighNtu,
      )).toBeLessThan(1e-9);
      expect(rel(
        effectivenessFromNtu({ ntu: 60, cr: row.cr, arrangement: 'shell1' }).effectiveness,
        row.shell1AtHighNtu,
      )).toBeLessThan(1e-6);
      // COUNTER-CURRENT HAS NO CEILING. The shipped help text said
      // "each arrangement has a hard ceiling on effectiveness that no
      // amount of area beats", and counter-current is the Rating tab's
      // DEFAULT. It does not.
      expect(effectivenessFromNtu({ ntu: 1, cr: row.cr, arrangement: 'counter' }).ceiling)
        .toBeNull();
    });
    [0.9, 0.99, 0.999, 0.99999].forEach((eff) => {
      const r = ntuFromEffectiveness({ effectiveness: eff, cr: 0.5, arrangement: 'counter' });
      expect(r.error).toBeUndefined();
      expect(r.ceiling).toBeNull();
      expect(Number.isFinite(r.ntu)).toBe(true);
    });
    expect(ntuFromEffectiveness({ effectiveness: 0.7, cr: 0.5, arrangement: 'parallel' }).error)
      .toMatch(/cannot exceed/);
    expect(ntuFromEffectiveness({ effectiveness: 0.95, cr: 0.8, arrangement: 'shell1' }).error)
      .toMatch(/cannot exceed/);
  });

  test('at Cr = 0 all three arrangements collapse onto ONE curve', () => {
    // Another analytic limit: with one stream isothermal the
    // arrangement stops mattering and every form reduces to
    // 1 - exp(-NTU). Three golden rows carry it.
    const rows = G.epsNtu.filter((row) => row.cr === 0);
    expect(rows).toHaveLength(3);
    rows.forEach((row) => {
      expect(rel(effectivenessFromNtu(row).effectiveness, 1 - Math.exp(-row.ntu)))
        .toBeLessThan(1e-14);
    });
  });

  test('counter beats shell beats parallel at the same NTU', () => {
    const at = (arrangement) => effectivenessFromNtu({ ntu: 2, cr: 0.7, arrangement }).effectiveness;
    expect(at('counter')).toBeGreaterThan(at('shell1'));
    expect(at('shell1')).toBeGreaterThan(at('parallel'));
  });

  test('CARRIES THE ERROR CONTRACT: it used to return a bare NaN', () => {
    // NEGATIVE CONTROL. cr above 1, cr negative and any NaN all came
    // back as a bare NaN, so `if (r.error)` passed and the Summary rail
    // printed "Rated effectiveness -- %".
    [{ ntu: 2, cr: 1.4 }, { ntu: 2, cr: -0.1 }, { ntu: NaN, cr: 0.5 },
      { ntu: 2, cr: NaN }, { ntu: -1, cr: 0.5 }].forEach((bad) => {
      const r = effectivenessFromNtu(bad);
      expect(typeof r).toBe('object');
      expect(r.error).toBeTruthy();
      expect(r.effectiveness).toBeUndefined();
    });
    expect(effectivenessFromNtu({ ntu: 2, cr: 1.4 }).error).toContain('1.4');
    expect(effectivenessFromNtu({ ntu: 2, cr: 1.4 }).error).toMatch(/wrong way round/);
    expect(ntuFromEffectiveness({ effectiveness: 1.2, cr: 0.5 }).error).toContain('1.2');
  });
});

/* ------------------------------------------------------------------ *
 * 5. The overall coefficient and the tube-side film
 * ------------------------------------------------------------------ */

describe('overall coefficient', () => {
  test('matches a resistance stack built on each term OWN area', () => {
    // The oracle assembles absolute resistances per unit tube length --
    // the outside terms on pi.do, the inside terms on pi.di -- and
    // refers the sum to the outside surface only at the very end, with
    // the WALL TERM BY SIMPSON QUADRATURE rather than a logarithm. The
    // old route was the engine's own expression in SI: the factor 2 in
    // the wall term could be moved to 2.2 in BOTH files, and the do/di
    // ratio dropped from both, with the suite staying green.
    G.u.forEach((row) => {
      const r = overallUOutside(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.uDirtyBtuHrFt2F, row.uDirtyBtuHrFt2F)).toBeLessThan(1e-9);
      expect(rel(r.uCleanBtuHrFt2F, row.uCleanBtuHrFt2F)).toBeLessThan(1e-9);
      Object.keys(row.resistances).forEach((k) => {
        expect(rel(r.resistances[k], row.resistances[k])).toBeLessThan(1e-9);
      });
      // SELF-CONSISTENCY: the five parts must add up to the whole
      const sum = Object.values(r.resistances).reduce((a, b) => a + b, 0);
      expect(rel(sum, r.totalResistance)).toBeLessThan(1e-14);
      expect(rel(1 / sum, r.uDirtyBtuHrFt2F)).toBeLessThan(1e-14);
      const shareSum = Object.values(r.resistanceSharePct).reduce((a, b) => a + b, 0);
      expect(shareSum).toBeCloseTo(100, 10);
      expect(r.referenceArea).toBe('outside tube surface (do)');
    });
  });

  test('the row that states NO defaults measures the defaults', () => {
    // Every shipped golden row passed kWallBtuHrFtF explicitly, so
    // moving the default from 26 to 30 left the suite 19 of 19 green.
    const row = G.uDefaults;
    const r = overallUOutside({
      hoBtuHrFt2F: row.hoBtuHrFt2F, hiBtuHrFt2F: row.hiBtuHrFt2F,
      doIn: row.doIn, diIn: row.diIn,
    });
    expect(r.error).toBeUndefined();
    expect(rel(r.uDirtyBtuHrFt2F, row.uDirtyBtuHrFt2F)).toBeLessThan(1e-9);
    expect(rel(r.resistances.wall, row.resistances.wall)).toBeLessThan(1e-9);
    // fouling defaults to zero, so dirty and clean coincide here
    expect(r.uDirtyBtuHrFt2F).toBeCloseTo(r.uCleanBtuHrFt2F, 10);
    expect(r.foulingPenaltyPct).toBeCloseTo(0, 12);
  });

  test('controlling carries the MARGIN that decided it', () => {
    // At the studio's own shipped defaults this one-word verdict rested
    // on a two percent gap between the outside and inside films, on a
    // film computed at a tube count the same screen contradicted. A
    // verdict that close is a coin toss wearing a result's clothes.
    const close = overallUOutside({
      hoBtuHrFt2F: 200, hiBtuHrFt2F: 247.26, doIn: 0.75, diIn: 0.62,
      foulingOut: 0.001, foulingIn: 0.002,
    });
    expect(close.controlling).toBe('outsideFilm');
    expect(close.runnerUp).toBe('insideFilm');
    expect(close.controllingMarginPct).toBeLessThan(3);
    expect(close.controllingClear).toBe(false);
    expect(close.controllingNote).toMatch(/jointly controlling/);
    const clear = overallUOutside({ hoBtuHrFt2F: 50, hiBtuHrFt2F: 2000, doIn: 0.75, diIn: 0.62 });
    expect(clear.controlling).toBe('outsideFilm');
    expect(clear.controllingClear).toBe(true);
    expect(clear.controllingNote).toBeNull();
    expect(clear.controllingMarginPct).toBeGreaterThan(DECLARED_BOUNDS.controllingMarginPct);
  });

  test('REFUSES every coefficient it used to accept', () => {
    // NEGATIVE CONTROLS, each naming its own value.
    const base = { hoBtuHrFt2F: 200, hiBtuHrFt2F: 800, doIn: 0.75, diIn: 0.62 };
    const cases = [
      [{ ...base, foulingOut: -0.01 }, '-0.01', /cleans itself/],
      [{ ...base, foulingOut: -0.002 }, '-0.002', /cleans itself/],
      [{ ...base, foulingIn: -0.001 }, '-0.001', /cleans itself/],
      [{ ...base, kWallBtuHrFtF: 0 }, '0', /wall conductivity/],
      [{ ...base, kWallBtuHrFtF: -26 }, '-26', /wall conductivity/],
      [{ ...base, hoBtuHrFt2F: 0 }, '0', /outside film/],
      [{ ...base, hiBtuHrFt2F: -800 }, '-800', /inside film/],
      [{ ...base, diIn: 0 }, '0', /inside diameter/],
      [{ ...base, doIn: 0.5 }, '0.5', /outside diameter/],
    ];
    cases.forEach(([args, needle, pattern]) => {
      const r = overallUOutside(args);
      expect(r.error).toBeTruthy();
      expect(r.error).toContain(needle);
      expect(r.error).toMatch(pattern);
      expect(r.uDirtyBtuHrFt2F).toBeUndefined();
      expect(r.controlling).toBeUndefined();
    });
    // the specific absurdity each one used to produce
    const ok = overallUOutside({ ...base, foulingOut: 0.001, foulingIn: 0.002 });
    expect(ok.uDirtyBtuHrFt2F).toBeLessThan(ok.uCleanBtuHrFt2F);
    expect(ok.foulingPenaltyPct).toBeGreaterThan(0);
  });
});

describe('the tube-side film', () => {
  test('matches a Reynolds number formed WITHOUT a flow area', () => {
    // Re = 4 mdot / (pi d mu) per tube never forms the area the engine
    // divides by, so a dropped pi or a wrong tubes-per-pass cannot
    // agree. The residual is the 2.4191 rounding and nothing else,
    // which the next test nails exactly.
    G.tubeFilm.forEach((row) => {
      const r = tubeSideFilm(row);
      expect(r.error).toBeUndefined();
      expect(r.regime).toBe(row.regime);
      expect(rel(r.re, row.re)).toBeLessThan(1e-5);
      expect(rel(r.pr, row.pr)).toBeLessThan(1e-5);
      expect(rel(r.hBtuHrFt2F, row.hBtuHrFt2F)).toBeLessThan(1e-5);
      expect(r.tubesPerPass).toBe(row.nTubes / row.passes);
      expect(r.service).toBe('heating');
    });
    expect(G.tubeFilm.filter((row) => row.regime === 'laminar')).toHaveLength(1);
    expect(G.tubeFilm.filter((row) => row.muWallCp)).toHaveLength(1);
  });

  test('THE RESIDUAL IS THE ROUNDING, THROUGH BOTH EXPONENTS', () => {
    // This is the strongest check in the module and it costs one line.
    // The engine's Re is the oracle's divided by kappa and its Pr is
    // the oracle's times kappa, where kappa is the 4.83 ppm rounding of
    // the centipoise conversion. Since h goes as Re^m Pr^n, the film
    // coefficients must differ by EXACTLY kappa^(n-m). Move either
    // exponent in BOTH files and this identity breaks, which is how the
    // paired plants that used to pass now fail.
    const kappa = DECLARED_CONSTANTS.cpToLbFtHr / G.derivedConstants.cpToLbFtHrDerived;
    const m = DECLARED_CONSTANTS.dittusBoelterReExp;
    const n = DECLARED_CONSTANTS.dittusBoelterPrExpHeating;
    G.tubeFilm.filter((row) => row.regime === 'turbulent').forEach((row) => {
      const r = tubeSideFilm(row);
      expect(r.re / row.re).toBeCloseTo(1 / kappa, 12);
      expect(r.pr / row.pr).toBeCloseTo(kappa, 12);
      expect(r.hBtuHrFt2F / row.hBtuHrFt2F).toBeCloseTo(kappa ** (n - m), 12);
    });
    // a laminar film carries no Reynolds or Prandtl dependence at all,
    // so it agrees to machine precision
    const lam = G.tubeFilm.find((row) => row.regime === 'laminar');
    expect(rel(tubeSideFilm(lam).hBtuHrFt2F, lam.hBtuHrFt2F)).toBeLessThan(1e-14);
  });

  test('the Sieder-Tate factor moves the film the right way and is reported', () => {
    const base = {
      mLbHr: 150000, diIn: 0.62, muCp: 0.5, kBtuHrFtF: 0.08, cpBtuLbF: 0.5,
      nTubes: 200, passes: 2,
    };
    const plain = tubeSideFilm(base);
    const heated = tubeSideFilm({ ...base, muWallCp: 0.3 });
    expect(heated.hBtuHrFt2F).toBeGreaterThan(plain.hBtuHrFt2F);
    expect(heated.siederTate).toBe(true);
    expect(plain.siederTate).toBe(false);
    expect(heated.siederTateFactor)
      .toBeCloseTo((0.5 / 0.3) ** DECLARED_CONSTANTS.siederTateExp, 12);
    expect(tubeSideFilm({ ...base, muWallCp: -1 }).error).toContain('-1');
  });

  test('the laminar branch SAYS it ignores the flow rate and the wall viscosity', () => {
    // A finding turned into a test: the laminar film is 5.667097 at 500,
    // 2000 and 20000 lb/hr, which is correct for the
    // constant-wall-temperature limit and used to be stated nowhere, so
    // the studio's Flow box simply stopped moving hi.
    const base = {
      diIn: 0.62, muCp: 50, kBtuHrFtF: 0.08, cpBtuLbF: 0.5, nTubes: 100, passes: 1,
    };
    const hs = [500, 2000, 20000].map((mLbHr) => tubeSideFilm({ ...base, mLbHr }));
    hs.forEach((r) => {
      expect(r.regime).toBe('laminar');
      expect(r.hBtuHrFt2F).toBeCloseTo(hs[0].hBtuHrFt2F, 12);
      expect(r.warning).toMatch(/does NOT move with the flow rate/);
      expect(r.siederTate).toBe(false);
    });
    // and the Sieder-Tate box really does nothing there
    expect(tubeSideFilm({ ...base, mLbHr: 2000, muWallCp: 10 }).hBtuHrFt2F)
      .toBeCloseTo(hs[1].hBtuHrFt2F, 12);
  });

  test('the transition band is refused, and the refusal carries Re and Pr', () => {
    const trans = tubeSideFilm({
      mLbHr: 250000, diIn: 0.62, muCp: 5, kBtuHrFtF: 0.08, cpBtuLbF: 0.5,
      nTubes: 100, passes: 1,
    });
    expect(trans.re).toBeGreaterThan(DECLARED_CONSTANTS.transitionReLow);
    expect(trans.re).toBeLessThan(DECLARED_CONSTANTS.transitionReHigh);
    expect(trans.error).toMatch(/transition band/);
    expect(trans.pr).toBeGreaterThan(0);
    expect(trans.hBtuHrFt2F).toBeUndefined();
  });

  test('a COOLED tube side is refused rather than answered with the heating exponent', () => {
    // NEGATIVE CONTROL and a HELD-FOR-LITERATURE item. Nothing used to
    // let a caller say the tube fluid is being cooled and the Prandtl
    // exponent was the heating one in every call. At the studio's own
    // default Prandtl of 15.12 the two forms differ by 31.2 percent on
    // hi, so answering anyway would be a confident wrong number and
    // inventing the cooling exponent here would be worse.
    const base = {
      mLbHr: 150000, diIn: 0.62, muCp: 0.5, kBtuHrFtF: 0.08, cpBtuLbF: 0.5,
      nTubes: 200, passes: 2,
    };
    const cooled = tubeSideFilm({ ...base, service: 'cooling' });
    expect(cooled.error).toMatch(/only the HEATING form/);
    expect(cooled.error).toContain('31 percent');
    expect(cooled.hBtuHrFt2F).toBeUndefined();
    expect(tubeSideFilm({ ...base, service: 'warming' }).error).toContain('warming');
    expect(HELD_FOR_LITERATURE.dittusBoelterCoolingExponent).toMatch(/REFUSED/);
    // and the band it is applied over is REPORTED, never graded
    const r = tubeSideFilm(base);
    expect(r.correlation.validityBand).toBeNull();
    expect(r.correlation.prandtl).toBe(r.pr);
    expect(r.correlation.note).toMatch(/not established in this repository/);
  });

  test('the tube count and the pass count are whole numbers or refused', () => {
    // NEGATIVE CONTROL. `Math.max(1, nTubes / passes)` floored
    // silently, so one tube in four passes returned exactly the same
    // Reynolds number as four tubes in four passes.
    const base = {
      mLbHr: 150000, diIn: 0.62, muCp: 0.5, kBtuHrFtF: 0.08, cpBtuLbF: 0.5,
    };
    expect(tubeSideFilm({ ...base, nTubes: 1, passes: 4 }).error).toMatch(/cannot be divided/);
    expect(tubeSideFilm({ ...base, nTubes: 7, passes: 2 }).error).toMatch(/equally/);
    expect(tubeSideFilm({ ...base, nTubes: 7.5, passes: 1 }).error).toContain('7.5');
    expect(tubeSideFilm({ ...base, nTubes: 0, passes: 1 }).error).toMatch(/at least 1/);
    expect(tubeSideFilm({ ...base, nTubes: 8, passes: 2 }).error).toBeUndefined();
    ['mLbHr', 'diIn', 'muCp', 'kBtuHrFtF', 'cpBtuLbF'].forEach((key) => {
      const r = tubeSideFilm({ ...base, nTubes: 200, passes: 2, [key]: 0 });
      expect(r.error).toBeTruthy();
      expect(r.error).toContain('0');
    });
  });
});

/* ------------------------------------------------------------------ *
 * 6. Area and bundle geometry
 * ------------------------------------------------------------------ */

describe('sizing and bundle geometry', () => {
  test('the area matches Q = U A F dTlm solved in m2 through watts', () => {
    G.areaRequired.forEach((row) => {
      const a = areaRequired(row);
      expect(a.error).toBeUndefined();
      expect(rel(a.areaFt2, row.areaFt2)).toBeLessThan(1e-12);
      // SELF-CONSISTENCY, both ways
      expect(rel(a.areaFt2 * row.uBtuHrFt2F * row.f * row.lmtdF, row.qBtuHr))
        .toBeLessThan(1e-12);
    });
    [['qBtuHr', 0], ['uBtuHrFt2F', 0], ['lmtdF', -80], ['f', 0], ['f', 1.2]]
      .forEach(([key, value]) => {
        const r = areaRequired({
          qBtuHr: 5e6, uBtuHrFt2F: 120, lmtdF: 80, f: 0.9, [key]: value,
        });
        expect(r.error).toBeTruthy();
        expect(r.error).toContain(String(value));
      });
  });

  test('the bundle fit matches BISECTION on the diameter, not the same power', () => {
    // The whole bundle-geometry fit was unvalidated: the shipped suite
    // checked only that a bigger area gives more tubes and a wider
    // bundle, which an INVERTED EXPONENT still does. The oracle
    // bisects for the D_b that satisfies (D_b/do)^n1 = N/K, which an
    // inverted exponent cannot reproduce.
    G.tubeCount.forEach((row) => {
      const r = tubeCount(row);
      expect(r.error).toBeUndefined();
      expect(r.nTubes).toBe(row.nTubes);
      expect(rel(r.areaPerTubeFt2, row.areaPerTubeFt2)).toBeLessThan(1e-14);
      expect(rel(r.actualAreaFt2, row.actualAreaFt2)).toBeLessThan(1e-14);
      expect(rel(r.bundleDiameterIn, row.bundleDiameterIn)).toBeLessThan(1e-9);
      expect(rel(r.shellDiameterIn, row.shellDiameterIn)).toBeLessThan(1e-9);
      // SELF-CONSISTENCY: a whole number of tubes always covers the
      // requirement, and the overshoot is REPORTED now
      expect(r.actualAreaFt2).toBeGreaterThanOrEqual(row.areaFt2 - 1e-9);
      expect(r.areaMarginPct).toBeGreaterThanOrEqual(0);
      expect(rel(r.actualAreaFt2 / row.areaFt2 - 1, r.areaMarginPct / 100))
        .toBeLessThan(1e-9);
    });
  });

  test('30 degrees moves the bundle and 45 against 90 does not, and the return says so', () => {
    const at = (layoutDeg) => tubeCount({
      areaFt2: 860, doIn: 0.75, tubeLengthFt: 16, layoutDeg,
    });
    expect(at(45).bundleDiameterIn).toBe(at(90).bundleDiameterIn);
    expect(at(45).layoutNote).toMatch(/identical/);
    expect(at(30).layoutNote).toBeNull();
    const shift = Math.abs(at(45).bundleDiameterIn / at(30).bundleDiameterIn - 1);
    expect(shift).toBeGreaterThan(0.08);
    expect(at(30).constantsNote).toMatch(/not established in this repository/);
  });

  test('a bigger area gives a bigger bundle, and the refusals name the value', () => {
    const small = tubeCount({ areaFt2: 500, doIn: 0.75, tubeLengthFt: 16 });
    const big = tubeCount({ areaFt2: 2000, doIn: 0.75, tubeLengthFt: 16 });
    expect(big.nTubes).toBeGreaterThan(small.nTubes);
    expect(big.bundleDiameterIn).toBeGreaterThan(small.bundleDiameterIn);
    expect(big.shellDiameterIn).toBeGreaterThan(big.bundleDiameterIn);
    expect(tubeCount({ areaFt2: 500, doIn: 0.75, tubeLengthFt: 16, passes: 3 }).error)
      .toMatch(/1, 2, 4 and 6/);
    expect(tubeCount({ areaFt2: 500, doIn: 0.75, tubeLengthFt: 16, layoutDeg: 17 }).error)
      .toContain('17');
    expect(tubeCount({
      areaFt2: 500, doIn: 0.75, tubeLengthFt: 16, bundleClearanceIn: -1,
    }).error).toContain('-1');
    expect(tubeCount({ areaFt2: 0, doIn: 0.75, tubeLengthFt: 16 }).error).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * 7. Air coolers
 * ------------------------------------------------------------------ */

describe('air coolers', () => {
  test('area, air flow and fan power match the SI routes', () => {
    G.airCooler.forEach((row) => {
      const r = airCooler(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.lmtdF, row.lmtdF)).toBeLessThan(1e-9);
      expect(rel(r.areaFt2, row.areaFt2)).toBeLessThan(1e-9);
      expect(rel(r.airLbHr, row.airLbHr)).toBeLessThan(1e-12);
      expect(rel(r.acfm, row.acfm)).toBeLessThan(1e-5);
      expect(rel(r.airDensityLbFt3, row.airDensityLbFt3)).toBeLessThan(1e-5);
      expect(rel(r.fanBhp, row.fanBhp)).toBeLessThan(1e-5);
      expect(rel(r.motorHp, row.motorHp)).toBeLessThan(1e-5);
      expect(r.airOutF).toBe(row.airOutF);
      expect(r.fanInletF).toBe(row.fanInletF);
      // SELF-CONSISTENCY. This is the identity the arithmetic-mean
      // plant broke while both files agreed with each other: the area
      // the engine reports must satisfy Q = U A dTlm at the LMTD the
      // engine itself reports.
      expect(rel(r.areaFt2 * row.uBtuHrFt2F * r.lmtdF, row.qBtuHr)).toBeLessThan(1e-12);
      // and the air it asks for must carry the duty at the stated rise
      expect(rel(r.airLbHr * DECLARED_CONSTANTS.airCpBtuLbF * row.airRiseF, row.qBtuHr))
        .toBeLessThan(1e-12);
      expect(rel(r.acfm * 60 * r.airDensityLbFt3, r.airLbHr)).toBeLessThan(1e-12);
      expect(rel(r.motorHp * row.motorEfficiency, r.fanBhp)).toBeLessThan(1e-12);
    });
  });

  test('the fan power residual is the GAS CONSTANT rounding and nothing else', () => {
    const ratio = DECLARED_CONSTANTS.gasConstantPsiaFt3LbmolR
      / G.derivedConstants.gasConstantPsiaFt3LbmolRDerived;
    G.airCooler.forEach((row) => {
      const r = airCooler(row);
      // density goes as 1/R, and ACFM and bhp go as 1/density
      expect(r.airDensityLbFt3 / row.airDensityLbFt3).toBeCloseTo(1 / ratio, 12);
      expect(r.acfm / row.acfm).toBeCloseTo(ratio, 12);
      expect(r.fanBhp / row.fanBhp).toBeCloseTo(ratio, 12);
    });
  });

  test('THE DRAFT TYPE IS NAMED, and the mean belonged to neither machine', () => {
    // The density used to be taken at the MEAN of the inlet and outlet
    // air, which is neither machine's fan inlet. Across the two real
    // choices the fan power moves by 5.3 percent, and the engine
    // returned one number and named no draft type.
    const base = {
      qBtuHr: 20e6, processInF: 250, processOutF: 150, ambientF: 95,
      airRiseF: 30, uBtuHrFt2F: 4.5,
    };
    const forced = airCooler({ ...base, draftType: 'forced' });
    const induced = airCooler({ ...base, draftType: 'induced' });
    expect(forced.fanInletF).toBe(95);
    expect(induced.fanInletF).toBe(125);
    expect(forced.draftType).toBe('forced');
    expect(airCooler({ ...base, draftType: 'Induced' }).draftType).toBe('induced');
    expect(induced.fanBhp / forced.fanBhp - 1).toBeCloseTo(0.0541, 3);
    expect(forced.fanBhp).toBeCloseTo(94.0039, 3);
    expect(induced.fanBhp).toBeCloseTo(99.0883, 3);
    // the old mean-temperature answer sat between the two and belonged
    // to neither
    const meanRho = airDensityLbFt3(110);
    expect(meanRho).toBeLessThan(forced.airDensityLbFt3);
    expect(meanRho).toBeGreaterThan(induced.airDensityLbFt3);
    // an unnamed draft type is refused rather than averaged
    expect(airCooler({ ...base, draftType: 'either' }).error).toContain('either');
    expect(airCooler({ ...base, draftType: undefined }).draftType).toBe('forced');
  });

  test('barometric pressure is an input, because this machine runs on air density', () => {
    const base = {
      qBtuHr: 14e6, processInF: 300, processOutF: 190, ambientF: 100,
      airRiseF: 28, uBtuHrFt2F: 4.0,
    };
    const sea = airCooler(base);
    const altitude = airCooler({ ...base, barometricPsia: 12.2 });
    expect(sea.barometricPsia).toBe(14.7);
    expect(altitude.airDensityLbFt3 / sea.airDensityLbFt3).toBeCloseTo(12.2 / 14.7, 12);
    expect(altitude.fanBhp / sea.fanBhp).toBeCloseTo(14.7 / 12.2, 12);
    expect(airCooler({ ...base, barometricPsia: 0 }).error).toMatch(/barometric/);
    expect(airDensityLbFt3(60)).toBeCloseTo(0.0764, 3);
    expect(Number.isNaN(airDensityLbFt3(-500))).toBe(true);
  });

  test('the row that states NO defaults measures the defaults', () => {
    // Moving staticPressureInH2O from 0.6 to 0.9, motorEfficiency from
    // 0.92 to 0.80 or fanEfficiency from 0.65 used to leave the suite
    // 19 of 19 green, because every golden row passed them explicitly.
    const row = G.airCoolerDefaults;
    const r = airCooler({
      qBtuHr: row.qBtuHr, processInF: row.processInF, processOutF: row.processOutF,
      ambientF: row.ambientF, airRiseF: row.airRiseF, uBtuHrFt2F: row.uBtuHrFt2F,
    });
    expect(r.error).toBeUndefined();
    expect(rel(r.fanBhp, row.fanBhp)).toBeLessThan(1e-5);
    expect(rel(r.motorHp, row.motorHp)).toBeLessThan(1e-5);
    expect(rel(r.areaFt2, row.areaFt2)).toBeLessThan(1e-9);
  });

  test('REFUSES every efficiency and pressure it used to accept', () => {
    // NEGATIVE CONTROLS. Fan efficiency 0 returned Infinity bhp,
    // -0.65 returned -96.5, and 5 was accepted; motor efficiency 3
    // returned a motor drawing less than its shaft; a negative static
    // pressure returned negative horsepower. None carried an error key,
    // so `if (cooler.error)` passed and the panel printed "-- bhp".
    const base = {
      qBtuHr: 20e6, processInF: 250, processOutF: 150, ambientF: 95,
      airRiseF: 30, uBtuHrFt2F: 4.5,
    };
    const cases = [
      ['fanEfficiency', 0], ['fanEfficiency', -0.65], ['fanEfficiency', 5],
      ['motorEfficiency', 0], ['motorEfficiency', -0.92], ['motorEfficiency', 3],
      ['staticPressureInH2O', -0.6], ['staticPressureInH2O', 0],
      ['qBtuHr', 0], ['uBtuHrFt2F', 0], ['airRiseF', -30],
    ];
    cases.forEach(([key, value]) => {
      const r = airCooler({ ...base, [key]: value });
      expect(r.error).toBeTruthy();
      expect(r.error).toContain(String(value));
      expect(r.fanBhp).toBeUndefined();
      expect(r.motorHp).toBeUndefined();
    });
  });

  test('an EMPTY temperature box is named, not reported as a temperature cross', () => {
    // NEGATIVE CONTROL. A blank ambient or process-outlet box used to
    // come back as "temperature cross: one end of the exchanger has no
    // driving force", which names a cross the user did not create and
    // never names the box that is empty.
    const base = {
      qBtuHr: 20e6, processInF: 250, processOutF: 150, ambientF: 95,
      airRiseF: 30, uBtuHrFt2F: 4.5,
    };
    ['ambientF', 'processInF', 'processOutF'].forEach((key) => {
      const r = airCooler({ ...base, [key]: NaN });
      expect(r.error).toContain(key.replace(/F$/, '').replace(/([A-Z])/g, ' $1').trim().toLowerCase().split(' ')[0]);
      expect(r.error).toMatch(/empty or not a number/);
      expect(r.error).not.toMatch(/temperature cross/);
    });
    // a cooler that heats is named as such
    expect(airCooler({ ...base, processOutF: 300 }).error).toMatch(/takes the process DOWN/);
    // an air temperature that really cannot reach the outlet still says so
    expect(airCooler({ ...base, ambientF: 200 }).error).toMatch(/cannot take the process to/);
  });

  test('the cross-flow F is DECLARED ABSENT rather than silently 1', () => {
    // The finding is the silence, not the number. This module's
    // headline is that F is computed rather than typed, and its air
    // cooler sized a cross-flow unit on the counter-current log mean
    // with F silently 1.
    const r = airCooler({
      qBtuHr: 20e6, processInF: 250, processOutF: 150, ambientF: 95,
      airRiseF: 30, uBtuHrFt2F: 4.5,
    });
    expect(r.fCorrection).toBeNull();
    expect(r.fNote).toMatch(/cross-flow/);
    expect(r.fNote).toMatch(/counter-current log mean/i);
    expect(HELD_FOR_LITERATURE.crossFlowF).toMatch(/not established in this repository/);
  });
});

describe('the hot day', () => {
  test('the rated duty matches solving the LMTD equation at fixed UA', () => {
    // THE HEADLINE REPAIR. The engine used to hold the process outlet
    // FIXED and scale the duty by the ratio of two log means, and those
    // two things cannot both be true. At the studio's own shipped
    // defaults it reported 81.16 percent capacity retained where the
    // honest answer is 90.32, and it was 29.5 percent out at 130 F.
    //
    // The engine holds the effectiveness (equivalently UA and both
    // capacity rates). The oracle holds the same UA and solves
    // q = UA x LMTD by bisection, every log mean coming from the
    // integration route. Two classical methods, one answer.
    G.hotDay.forEach((row) => {
      const r = airCooler({
        qBtuHr: row.qBtuHr, processInF: row.processInF, processOutF: row.processOutF,
        ambientF: row.ambientF, airRiseF: row.airRiseF, uBtuHrFt2F: 4.5,
        checkAmbientF: row.checkAmbientF,
      }).hotDay;
      expect(r.error).toBeUndefined();
      expect(rel(r.uaBtuHrF, row.uaBtuHrF)).toBeLessThan(1e-9);
      expect(rel(r.qBtuHr, row.hotQBtuHr)).toBeLessThan(1e-8);
      expect(rel(r.dutyFraction, row.dutyFraction)).toBeLessThan(1e-8);
      expect(rel(r.processOutF, row.hotProcessOutF)).toBeLessThan(1e-8);
      expect(rel(r.airRiseF, row.hotAirRiseF)).toBeLessThan(1e-8);
      expect(r.basis).toMatch(/fixed UA/);
    });
  });

  test('THE DUTY, THE OUTLET AND THE AIR RISE AGREE WITH EACH OTHER', () => {
    // The defect was not only that the number was wrong, it was that
    // the engine's own numbers contradicted each other: 16.231 MMBtu/hr
    // at the same 2,777,778 lb/hr of air implies a 24.35 F air rise and
    // the engine kept 30, and it kept the process outlet at 150 F,
    // which needs the FULL 20 MMBtu/hr. These three identities are
    // gates now, and the shipped engine failed all three.
    const design = {
      qBtuHr: 20e6, processInF: 250, processOutF: 150, ambientF: 95,
      airRiseF: 30, uBtuHrFt2F: 4.5,
    };
    const cProcess = 20e6 / (250 - 150);
    const cAir = 20e6 / 30;
    [100, 105, 110, 120, 130, 149].forEach((checkAmbientF) => {
      const h = airCooler({ ...design, checkAmbientF }).hotDay;
      expect(h.error).toBeUndefined();
      // the duty and the new process outlet
      expect(rel(cProcess * (250 - h.processOutF), h.qBtuHr)).toBeLessThan(1e-12);
      // the duty and the new air rise, at the SAME air mass
      expect(rel(cAir * h.airRiseF, h.qBtuHr)).toBeLessThan(1e-12);
      expect(h.airOutF).toBeCloseTo(checkAmbientF + h.airRiseF, 10);
      // a hotter day is a smaller duty and a hotter outlet
      expect(h.dutyFraction).toBeLessThan(1);
      expect(h.processOutF).toBeGreaterThan(150);
      expect(h.airRiseF).toBeLessThan(30);
      expect(h.regime).toBe('hotter than design');
      expect(h.note).toMatch(/no longer reachable/);
      // and the effectiveness really is held
      expect(h.effectiveness).toBeCloseTo(100 / 155, 12);
    });
    // the specific numbers a user will now see at the app's own default
    const at110 = airCooler({ ...design, checkAmbientF: 110 }).hotDay;
    expect(at110.dutyFraction).toBeCloseTo(0.903226, 6);
    expect(at110.processOutF).toBeCloseTo(159.677, 3);
    expect(at110.airRiseF).toBeCloseTo(27.097, 3);
    // the old answer, for the record: the LMTD ratio at the DESIGN outlet
    const designLmtd = airCooler(design).lmtdF;
    const oldLmtd = lmtd({ thIn: 250, thOut: 150, tcIn: 110, tcOut: 140 }).lmtdF;
    expect(oldLmtd / designLmtd).toBeCloseTo(0.8115657, 6);
    expect(Math.abs(at110.dutyFraction - oldLmtd / designLmtd)).toBeGreaterThan(0.09);
  });

  test('a COLD day is labelled instead of printing 167 percent retained', () => {
    // The panel's accent rule was `dutyFraction < 0.85 ? amber :
    // emerald`, so 167 percent rendered as a healthy green under the
    // words "Capacity retained".
    const h = airCooler({
      qBtuHr: 20e6, processInF: 250, processOutF: 150, ambientF: 95,
      airRiseF: 30, uBtuHrFt2F: 4.5, checkAmbientF: 40,
    }).hotDay;
    expect(h.regime).toBe('colder than design');
    expect(h.dutyFraction).toBeGreaterThan(1);
    expect(h.dutyFraction).toBeCloseTo(1.354839, 6);
    expect(h.note).toMatch(/capability that the plant may never draw on/);
    expect(h.processOutF).toBeLessThan(150);
    // at the design ambient it is exactly the design point
    const same = airCooler({
      qBtuHr: 20e6, processInF: 250, processOutF: 150, ambientF: 95,
      airRiseF: 30, uBtuHrFt2F: 4.5, checkAmbientF: 95,
    }).hotDay;
    expect(same.regime).toBe('the design ambient');
    expect(same.dutyFraction).toBeCloseTo(1, 12);
    expect(same.processOutF).toBeCloseTo(150, 9);
    expect(same.airRiseF).toBeCloseTo(30, 9);
    expect(same.designOutletReached).toBe(true);
  });

  test('an ambient at or above the process inlet is refused, and a blank box is named', () => {
    const design = {
      qBtuHr: 20e6, processInF: 250, processOutF: 150, ambientF: 95,
      airRiseF: 30, uBtuHrFt2F: 4.5,
    };
    [250, 300].forEach((checkAmbientF) => {
      const h = airCooler({ ...design, checkAmbientF }).hotDay;
      expect(h.error).toMatch(/no driving force at all/);
      expect(h.error).toContain(String(checkAmbientF));
    });
    expect(airCooler({ ...design, checkAmbientF: NaN }).hotDay.error)
      .toMatch(/empty or not a number/);
    // an ambient ABOVE the design outlet is a real answer now, not a
    // refusal: the outlet simply rises
    const h160 = airCooler({ ...design, checkAmbientF: 160 }).hotDay;
    expect(h160.error).toBeUndefined();
    expect(h160.processOutF).toBeGreaterThan(160);
    expect(h160.designOutletReached).toBe(false);
    // and omitting the box entirely omits the block
    expect(airCooler(design).hotDay).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * 8. Analytic limits: known truths that need no citation
 * ------------------------------------------------------------------ */

describe('analytic limits', () => {
  test('a THIN cylindrical wall is a flat plate: R = t / k', () => {
    // The strongest structural check on the wall term, and it needs no
    // oracle and no citation. As do approaches di the curvature stops
    // mattering and the resistance referred to the outside area tends to
    // the plate result, thickness over conductivity. The factor 2 in
    // (do ln(do/di)) / (2 kw) is FIXED BY THAT LIMIT: move it to 2.2 in
    // the engine and in the oracle together, as the recon did, and the
    // two files still agree with each other but neither agrees with
    // this.
    [[1.0, 26], [4.0, 26], [0.652, 9.4], [2.0, 223]].forEach(([diIn, k]) => {
      [1.0002, 1.00005].forEach((stretch) => {
        const doIn = diIn * stretch;
        const r = overallUOutside({
          hoBtuHrFt2F: 1e9, hiBtuHrFt2F: 1e9, doIn, diIn, kWallBtuHrFtF: k,
        });
        const tFt = (doIn - diIn) / 2 / 12;
        expect(rel(r.resistances.wall, tFt / k)).toBeLessThan(1e-3);
      });
    });
    // and a thick wall is MORE resistive than the plate estimate, which
    // is the whole reason the logarithm is there
    const thick = overallUOutside({
      hoBtuHrFt2F: 1e9, hiBtuHrFt2F: 1e9, doIn: 2.0, diIn: 1.0, kWallBtuHrFtF: 26,
    });
    expect(thick.resistances.wall).toBeGreaterThan(((2.0 - 1.0) / 2 / 12) / 26);
  });

  test('the log mean is strictly below the arithmetic mean at unequal ends', () => {
    // Another limit that needs no citation, and the one the recon's
    // worst paired plant broke: the air cooler's log mean replaced by an
    // arithmetic mean in the engine AND the oracle left the shipped
    // suite green.
    G.lmtd.forEach((row) => {
      const r = lmtd(row);
      const arithmetic = (r.dt1 + r.dt2) / 2;
      if (row.equalEnds) {
        expect(r.lmtdF).toBeCloseTo(arithmetic, 9);
      } else {
        expect(r.lmtdF).toBeLessThan(arithmetic);
      }
    });
    const skew = lmtd({ thIn: 500, thOut: 110, tcIn: 100, tcOut: 200 });
    expect(skew.lmtdF / ((skew.dt1 + skew.dt2) / 2)).toBeLessThan(0.62);
  });

  test('F tends to 1 as P tends to 0, at every R', () => {
    [0.5, 0.8, 1.0, 1.5, 2.5].forEach((r) => {
      expect(lmtdCorrectionF({ p: 1e-9, r }).f).toBeCloseTo(1, 6);
      expect(lmtdCorrectionF({ p: 1e-6, r }).f).toBeGreaterThan(
        lmtdCorrectionF({ p: 0.3, r }).f,
      );
    });
  });

  test('F is 1 for a 1-2 shell only in the limit, and below 1 everywhere else', () => {
    [[0.4, 0.8], [0.3, 1.5], [0.5, 1.0], [0.25, 2.5], [0.6, 0.5]].forEach(([p, r]) => {
      const f = lmtdCorrectionF({ p, r }).f;
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThan(1);
    });
  });

  test('effectiveness rises with NTU and falls with Cr, in every arrangement', () => {
    ['counter', 'parallel', 'shell1'].forEach((arrangement) => {
      const at = (ntu, cr) => effectivenessFromNtu({ ntu, cr, arrangement }).effectiveness;
      expect(at(2, 0.5)).toBeGreaterThan(at(1, 0.5));
      expect(at(1, 0.9)).toBeLessThan(at(1, 0.2));
      expect(at(0, 0.5)).toBeCloseTo(0, 12);
    });
  });

  test('a counter-current unit tends to 1 as NTU grows, for Cr below 1', () => {
    expect(effectivenessFromNtu({ ntu: 200, cr: 0.5 }).effectiveness).toBeCloseTo(1, 10);
    expect(effectivenessFromNtu({ ntu: 200, cr: 0.99 }).effectiveness).toBeGreaterThan(0.87);
    // at Cr = 1 it tends to 1 too, but only as NTU/(1+NTU)
    expect(effectivenessFromNtu({ ntu: 200, cr: 1 }).effectiveness)
      .toBeCloseTo(200 / 201, 12);
  });
});
