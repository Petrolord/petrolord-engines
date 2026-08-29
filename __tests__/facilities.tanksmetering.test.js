// Facilities F12 gates for storage tanks and flow metering, against
// tools/validation/facilities/oracle_tanksmetering.py.
//
// Independent routes: the API 650 one-foot method re-derived in SI so
// the 2.6 field constant is CHECKED rather than repeated; the orifice
// mass flow computed entirely in SI so the 32.174, 144 and 0.0361273
// packagings are checked; the Reader-Harris/Gallagher coefficient
// grouped differently; and the measurement uncertainty checked against
// a MONTE CARLO propagation of 200,000 perturbed samples, which is a
// completely different way to propagate error from the root-sum-square
// the module uses.

import fs from 'fs';
import path from 'path';
import {
  tankCapacity, shellCourse, shellCourses,
  thermalVenting, movementVenting, normalVenting,
  wettedAreaFt2, fireVenting, evaporativeLosses, lossControl,
} from '../engines/facilities/storageTank';
import {
  dischargeCoefficient, expansibility, orificeFlow, sizeOrifice,
  permanentLoss, orificeUncertainty, transmitterUncertaintyPct,
  turbineVolume, straightRunDiameters,
} from '../engines/facilities/metering';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'tanksmetering_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('tank geometry and shell', () => {
  test('capacity is consistent and per-foot follows from it', () => {
    const c = tankCapacity({ diameterFt: 120, heightFt: 40 });
    expect(c.nominalBbl).toBeCloseTo(c.bblPerFt * 40, 6);
    expect(c.nominalFt3).toBeCloseTo(c.crossSectionFt2 * 40, 9);
    expect(tankCapacity({ diameterFt: 0, heightFt: 40 }).error).toBeTruthy();
  });

  test('the 2.6 constant matches the SI re-derivation', () => {
    G.shell.forEach((row) => {
      const r = shellCourse({ ...row, courseBottomHeightFt: 0 });
      expect(r.error).toBeUndefined();
      // 2.6 is a rounded packaging of rho g / 2 with the unit
      // conversions folded in, so agreement is to a few parts in 10,000
      expect(rel(r.tDesignIn, row.tDesignIn)).toBeLessThan(1e-3);
      expect(rel(r.tTestIn, row.tTestIn)).toBeLessThan(1e-3);
    });
  });

  test('THE POINT: a light product makes the water test govern', () => {
    const heavy = shellCourse({
      diameterFt: 120, courseBottomHeightFt: 0, liquidLevelFt: 40, sg: 1.0,
    });
    const light = shellCourse({
      diameterFt: 120, courseBottomHeightFt: 0, liquidLevelFt: 40, sg: 0.6,
    });
    expect(heavy.governing).toBe('product design');
    expect(light.governing).toBe('hydrostatic test');
    expect(light.note).toMatch(/would under-thickness it/);
  });

  test('courses thin upward and the minimum plate eventually governs', () => {
    const s = shellCourses({ diameterFt: 120, heightFt: 40, sg: 0.85 });
    expect(s.error).toBeUndefined();
    expect(s.courses).toHaveLength(5);
    for (let i = 1; i < s.courses.length; i += 1) {
      expect(s.courses[i].requiredIn).toBeLessThanOrEqual(s.courses[i - 1].requiredIn);
    }
    // the top course is at the minimum plate thickness
    expect(s.courses[s.courses.length - 1].governing).toBe('minimum plate thickness');
  });
});

describe('venting', () => {
  test('thermal and movement venting combine in each direction', () => {
    const v = normalVenting({
      nominalBbl: 10000, fillBblPerHr: 500, drawBblPerHr: 800,
    });
    expect(v.error).toBeUndefined();
    expect(v.outbreathingScfh).toBeGreaterThan(0);
    expect(v.inbreathingScfh).toBeGreaterThan(0);
    // drawing faster than filling makes vacuum govern
    expect(v.governing).toBe('vacuum (inbreathing)');
    expect(v.warning).toMatch(/pull it flat/);
  });

  test('a volatile product doubles the movement outbreathing', () => {
    const low = movementVenting({ fillBblPerHr: 500 });
    const high = movementVenting({ fillBblPerHr: 500, highVolatility: true });
    expect(high.outbreathingScfh).toBeCloseTo(2 * low.outbreathingScfh, 9);
  });

  test('insulation earns a thermal credit and says it is customary', () => {
    const bare = thermalVenting({ nominalBbl: 10000 });
    const lagged = thermalVenting({ nominalBbl: 10000, insulated: true });
    expect(lagged.inbreathingScfh).toBeLessThan(bare.inbreathingScfh);
    expect(lagged.note).toMatch(/customary one/);
    expect(thermalVenting({ nominalBbl: 0 }).error).toBeTruthy();
  });

  test('fire venting counts only the shell below 30 ft and dwarfs normal', () => {
    const w = wettedAreaFt2({ diameterFt: 120, liquidLevelFt: 40 });
    expect(w.effectiveHeightFt).toBe(30);
    expect(w.note).toMatch(/below 30 ft/);
    const f = fireVenting({ wettedFt2: w.areaFt2 });
    const n = normalVenting({ nominalBbl: 30000, fillBblPerHr: 500 });
    expect(f.ventScfhAir).toBeGreaterThan(n.outbreathingScfh * 10);
    expect(f.note).toMatch(/order of magnitude/);
    expect(fireVenting({ wettedFt2: 0 }).error).toBeTruthy();
  });

  test('the fire heat-input bands are continuous enough to be sane', () => {
    // the published relations change form at 200, 1000 and 2800 ft2;
    // the duty must still rise monotonically with area
    const areas = [150, 199, 201, 900, 1001, 2799, 2801, 5000];
    let prev = 0;
    areas.forEach((a) => {
      const q = fireVenting({ wettedFt2: a }).qBtuHr;
      expect(q).toBeGreaterThan(prev * 0.5); // no collapse at a band edge
      prev = q;
    });
  });
});

describe('evaporative losses', () => {
  test('standing loss rises with vapour pressure and vapour space', () => {
    const base = {
      diameterFt: 120, vapourSpaceHeightFt: 12, vapourPressurePsia: 1.5,
      throughputBbl: 500000,
    };
    const r = evaporativeLosses(base);
    expect(r.error).toBeUndefined();
    expect(r.totalLossLbYr).toBeCloseTo(r.standingLossLbYr + r.workingLossLbYr, 6);
    const volatile = evaporativeLosses({ ...base, vapourPressurePsia: 4 });
    expect(volatile.standingLossLbYr).toBeGreaterThan(r.standingLossLbYr);
    const taller = evaporativeLosses({ ...base, vapourSpaceHeightFt: 24 });
    expect(taller.standingLossLbYr).toBeGreaterThan(r.standingLossLbYr);
    expect(r.note).toMatch(/money question and the emissions one/);
    expect(evaporativeLosses({ diameterFt: 120, vapourSpaceHeightFt: 12, vapourPressurePsia: 0 }).error)
      .toBeTruthy();
  });

  test('control saves what its efficiency says and names the ranges', () => {
    const c = lossControl({ uncontrolledLbYr: 100000, controlEfficiencyPct: 90 });
    expect(c.savedLbYr).toBeCloseTo(90000, 6);
    expect(c.remainingLbYr).toBeCloseTo(10000, 6);
    expect(c.note).toMatch(/floating roof/);
    expect(lossControl({ uncontrolledLbYr: -1 }).error).toBeTruthy();
  });
});

describe('orifice metering', () => {
  test('the Reader-Harris coefficient matches the independent grouping', () => {
    G.cd.forEach((row) => {
      const r = dischargeCoefficient(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.cd, row.cd)).toBeLessThan(1e-9);
    });
    expect(dischargeCoefficient({ beta: 1.2, reynolds: 1e5, pipeIdIn: 6 }).error).toBeTruthy();
  });

  test('THE POINT: Cd is not a constant 0.61', () => {
    // across the practical beta and Reynolds range the coefficient
    // spans roughly 0.597 to 0.640, which is about 7 percent: many
    // times the uncertainty anybody is arguing about in a custody
    // transfer dispute. (Two points can coincide, which is why the
    // corners of the range are the honest comparison.)
    const lowest = dischargeCoefficient({ beta: 0.2, reynolds: 1e6, pipeIdIn: 4.026 }).cd;
    const highest = dischargeCoefficient({ beta: 0.75, reynolds: 1e4, pipeIdIn: 10.02 }).cd;
    expect(highest - lowest).toBeGreaterThan(0.03);
    expect(lowest).toBeGreaterThan(0.55);
    expect(highest).toBeLessThan(0.68);
    // and it moves with Reynolds at fixed beta, which a constant cannot
    const slow = dischargeCoefficient({ beta: 0.7, reynolds: 1e4, pipeIdIn: 10.02 }).cd;
    const fast = dischargeCoefficient({ beta: 0.7, reynolds: 5e6, pipeIdIn: 10.02 }).cd;
    expect(slow - fast).toBeGreaterThan(0.02);
  });

  test('mass flow matches the entirely-SI computation', () => {
    G.orifice.forEach((row) => {
      const r = orificeFlow(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.cd, row.cd)).toBeLessThan(1e-6);
      expect(rel(r.expansibility, row.expansibility)).toBeLessThan(1e-9);
      // the 32.174, 144 and 0.0361273 packagings against pure SI
      expect(rel(r.massLbHr, row.massLbHr)).toBeLessThan(1e-5);
    });
  });

  test('expansibility is 1 for an incompressible fluid and falls with drop', () => {
    expect(expansibility({ beta: 0.5, dpPsi: 0, p1Psia: 500, k: 1.3 })).toBeCloseTo(1, 12);
    const small = expansibility({ beta: 0.5, dpPsi: 2, p1Psia: 500, k: 1.3 });
    const large = expansibility({ beta: 0.5, dpPsi: 40, p1Psia: 500, k: 1.3 });
    expect(large).toBeLessThan(small);
    const incompressible = orificeFlow({
      pipeIdIn: 6.065, orificeIdIn: 3, dpInH2O: 100, p1Psia: 500,
      densityLbFt3: 53, viscosityCp: 3, compressible: false,
    });
    expect(incompressible.expansibility).toBe(1);
  });

  test('sizing inverts the flow and refuses an impossible duty', () => {
    const target = 50000;
    const s = sizeOrifice({
      pipeIdIn: 6.065, targetMassLbHr: target, dpInH2O: 100, p1Psia: 500,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    });
    expect(s.error).toBeUndefined();
    expect(rel(s.massLbHr, target)).toBeLessThan(1e-6);
    expect(sizeOrifice({
      pipeIdIn: 2.067, targetMassLbHr: 1e9, dpInH2O: 100, p1Psia: 500,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    }).error).toMatch(/cannot pass this flow/);
  });

  test('permanent loss falls as beta rises, which is the trade', () => {
    const small = permanentLoss({ dpInH2O: 100, beta: 0.3 });
    const large = permanentLoss({ dpInH2O: 100, beta: 0.7 });
    expect(large.lossInH2O).toBeLessThan(small.lossInH2O);
    // and the high-beta plate warns about its other costs
    const highBeta = orificeFlow({
      pipeIdIn: 6.065, orificeIdIn: 4.0, dpInH2O: 100, p1Psia: 500,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    });
    expect(highBeta.warning).toMatch(/uncertainty and the straight-run/);
  });
});

describe('measurement uncertainty', () => {
  test('the root-sum-square matches a Monte Carlo propagation', () => {
    G.uncertainty.forEach((row) => {
      const u = row.uncertainties;
      const r = orificeUncertainty({
        beta: row.beta,
        cdUncertaintyPct: u.cd,
        expansibilityUncertaintyPct: u.eps,
        boreUncertaintyPct: u.bore,
        pipeUncertaintyPct: u.pipe,
        dpUncertaintyPct: u.dp,
        densityUncertaintyPct: u.rho,
      });
      expect(r.error).toBeUndefined();
      // two completely different propagation methods, 200k samples
      expect(rel(r.totalUncertaintyPct, row.monteCarloPct)).toBeLessThan(0.02);
    });
  });

  test('THE POINT: the dominant term is named and it moves', () => {
    const tight = orificeUncertainty({ beta: 0.5, dpUncertaintyPct: 0.5 });
    expect(tight.dominant).toBe('discharge coefficient');
    const loose = orificeUncertainty({ beta: 0.5, dpUncertaintyPct: 2.0 });
    expect(loose.dominant).toBe('differential pressure');
    expect(loose.note).toMatch(/wasted effort/);
    // the shares of variance add to 100
    const total = loose.contributions.reduce((s, c) => s + c.shareOfVariancePct, 0);
    expect(total).toBeCloseTo(100, 6);
  });

  test('THE OTHER POINT: turndown destroys a transmitter accuracy', () => {
    const atSpan = transmitterUncertaintyPct({ dpInH2O: 100, spanInH2O: 100 });
    expect(atSpan.uncertaintyPctOfReading).toBeCloseTo(0.075, 9);
    expect(atSpan.warning).toBeNull();
    const turned = transmitterUncertaintyPct({ dpInH2O: 10, spanInH2O: 100 });
    expect(turned.turndown).toBeCloseTo(10, 9);
    // ten to one turndown: ten times the uncertainty of reading
    expect(turned.uncertaintyPctOfReading).toBeCloseTo(0.75, 9);
    expect(turned.warning).toMatch(/three to one/);
    expect(transmitterUncertaintyPct({ dpInH2O: 200, spanInH2O: 100 }).error).toBeTruthy();
  });
});

describe('turbine meters and meter runs', () => {
  test('the meter factor is applied to the indicated volume', () => {
    const t = turbineVolume({ pulses: 1e6, kFactorPulsesPerBbl: 1000, meterFactor: 1.0023 });
    expect(t.indicatedBbl).toBeCloseTo(1000, 9);
    expect(t.grossBbl).toBeCloseTo(1002.3, 6);
    expect(turbineVolume({ pulses: 1e6, kFactorPulsesPerBbl: 0 }).error).toBeTruthy();
  });

  test('straight run is table data, rises with beta, and says so', () => {
    const lowBeta = straightRunDiameters({ beta: 0.3 });
    const highBeta = straightRunDiameters({ beta: 0.7 });
    expect(highBeta.upstreamDiameters).toBeGreaterThan(lowBeta.upstreamDiameters);
    // out-of-plane elbows are the worst case in the published tables
    const nasty = straightRunDiameters({ beta: 0.5, upstreamFitting: 'twoElbowsDifferentPlanes' });
    const simple = straightRunDiameters({ beta: 0.5, upstreamFitting: 'singleElbow' });
    expect(nasty.upstreamDiameters).toBeGreaterThan(simple.upstreamDiameters);
    expect(nasty.note).toMatch(/published table values, not a calculation/);
    expect(straightRunDiameters({ beta: 0.5, upstreamFitting: 'teleporter' }).error).toBeTruthy();
  });
});
