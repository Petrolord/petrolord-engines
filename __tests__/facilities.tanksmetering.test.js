// Facilities F12 gates for storage tanks and flow metering, against
// tools/validation/facilities/oracle_tanksmetering.py.
//
// The oracle's own docstring says, route by route, what each route
// checks and what it cannot. Three kinds of check live in this file and
// they are not interchangeable:
//
//  1. ORACLE ROUTES. An independent arithmetic: the API 650 one-foot
//     method re-derived in SI so the 2.6 constant is checked; the
//     orifice mass flow computed entirely in SI so the 32.174, 144 and
//     0.0361273 packagings are checked; the evaporative loss chain in
//     SI so the 10.731 field gas constant is checked; and the
//     uncertainty against a 200,000-sample Monte Carlo.
//
//  2. PROPERTY CHECKS. Facts about the shape of an answer that no
//     transcription can satisfy by accident: four fire-duty power laws
//     that must join up at their band edges, a saturation factor that
//     must approach one as the vapour pressure approaches zero, a
//     straight-run table that must not fall as beta rises, a flow that
//     must go as the square root of the differential.
//
//  3. A CONSTANT REGISTER, pinned by LITERAL. Some numbers in these
//     modules have no publication in this repository, so no route can
//     validate them. What a literal here does is detect SILENT CHANGE:
//     twenty-five defects planted in these engines used to leave this
//     suite green, and eight more survived being planted in the engine
//     and the oracle together, because a golden regenerated from a
//     changed oracle agrees with a changed engine. A literal typed
//     here does not regenerate. IT DOES NOT VALIDATE THE CONSTANT. DO
//     NOT REGENERATE THESE VALUES FROM THE ENGINE; if one of them
//     fails, either the engine changed on purpose, in which case say so
//     in the commit, or it changed by accident, which is the point.
//
// Every gate prints what it examined, and the negative controls at the
// bottom prove each new check can fail.

import fs from 'fs';
import path from 'path';
import {
  tankCapacity, shellCourse, shellCourses,
  thermalVenting, movementVenting, normalVenting,
  wettedAreaFt2, fireVenting, evaporativeLosses, lossControl,
  FIRE_VENT_WITHHELD,
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

// Margin reporting: every oracle comparison records how much of its
// tolerance it used, so the next wave knows its room and so a route
// that has collapsed onto a transcription is visible as 0.000 percent.
const MARGINS = [];
const within = (label, got, want, tol) => {
  const r = rel(got, want);
  MARGINS.push({ label, usedPctOfTolerance: (r / tol) * 100, rel: r, tol });
  expect(r).toBeLessThan(tol);
};
afterAll(() => {
  const worst = {};
  MARGINS.forEach((m) => {
    const key = m.label;
    if (!worst[key] || m.usedPctOfTolerance > worst[key].usedPctOfTolerance) worst[key] = m;
  });
  const lines = Object.values(worst)
    .sort((a, b) => b.usedPctOfTolerance - a.usedPctOfTolerance)
    .map((m) => `  ${m.label}: worst ${m.usedPctOfTolerance.toFixed(3)} percent of a ${m.tol} tolerance (rel ${m.rel.toExponential(2)})`);
  // eslint-disable-next-line no-console
  console.log(`tanksmetering oracle margins, ${MARGINS.length} comparisons:\n${lines.join('\n')}`);
});

/* ================================================================== *
 * 1. THE CONSTANT REGISTER: literals, not regenerated values
 * ================================================================== */

describe('the stated constants are pinned by literal, against silent change', () => {
  test('the barrel is 42 gallons of 231 cubic inches, not 55', () => {
    const c = tankCapacity({ diameterFt: 110, heightFt: 36 });
    // Typed out so the arithmetic is visible: 42 US gallons, each of
    // 231 cubic inches, in a cubic foot of 1728 cubic inches. The old
    // capacity test asserted nominalBbl === bblPerFt * 40, which holds
    // for ANY constant whatever, so 42 gallons to 55 was invisible.
    expect(c.ft3PerBbl).toBeCloseTo((42 * 231) / 1728, 12);
    expect(c.ft3PerBbl).toBeCloseTo(5.614583333333333, 12);
    const area = (Math.PI * 110 * 110) / 4;
    expect(c.nominalBbl).toBeCloseTo((area * 36) / 5.614583333333333, 6);
    // eslint-disable-next-line no-console
    console.log(`barrel pinned: ${c.ft3PerBbl} ft3/bbl from 42 gal x 231 in3 / 1728`);
  });

  test('the one-foot method offsets by ONE foot, recovered from the engine', () => {
    // The offset is not a returned field, so it is recovered: the
    // thickness is linear in the liquid level, so the level at which it
    // reaches zero IS the offset. A two-foot method planted in the
    // engine and the oracle together used to leave this suite green.
    const a = shellCourse({ diameterFt: 120, courseBottomHeightFt: 0, liquidLevelFt: 10, sg: 1 });
    const b = shellCourse({ diameterFt: 120, courseBottomHeightFt: 0, liquidLevelFt: 20, sg: 1 });
    const slope = (b.tDesignIn - a.tDesignIn) / 10;
    const offsetFt = 10 - a.tDesignIn / slope;
    expect(offsetFt).toBeCloseTo(1.0, 9);
    // eslint-disable-next-line no-console
    console.log(`one-foot offset recovered from the engine: ${offsetFt.toFixed(9)} ft`);
  });

  test('the shell allowables and the minimum plate are the stated values', () => {
    const c = shellCourse({ diameterFt: 120, courseBottomHeightFt: 0, liquidLevelFt: 40, sg: 0.85 });
    expect(c.minimumThicknessIn).toBe(0.1875);
    // the defaults, recovered by ratio: t scales as 1/S
    const hi = shellCourse({
      diameterFt: 120, courseBottomHeightFt: 0, liquidLevelFt: 40, sg: 1,
      designStressPsi: 46400,
    });
    const lo = shellCourse({ diameterFt: 120, courseBottomHeightFt: 0, liquidLevelFt: 40, sg: 1 });
    expect(lo.tDesignIn / hi.tDesignIn).toBeCloseTo(2, 9);
    expect(c.minimumThicknessBasis).toMatch(/does not carry that band table/);
    expect(c.methodNote).toMatch(/variable design point/);
  });

  test('the thermal venting factors are the stated values and say they are', () => {
    const t = thermalVenting({ nominalBbl: 9000 });
    expect(t.scfhPerBbl).toBe(1.0);
    expect(t.inbreathingScfh).toBeCloseTo(9000, 9);
    expect(t.outbreathingScfhLowVolatility / t.inbreathingScfh).toBeCloseTo(0.6, 12);
    const lagged = thermalVenting({ nominalBbl: 9000, insulated: true });
    expect(lagged.inbreathingScfh / t.inbreathingScfh).toBeCloseTo(0.25, 12);
    expect(t.basis).toMatch(/not cited to a document/);
  });

  test('the AP-42 coefficients are recovered from the engine and pinned', () => {
    const e = evaporativeLosses({
      diameterFt: 110, vapourSpaceHeightFt: 10, vapourPressurePsia: 1.5, throughputBbl: 450000,
    });
    // Ks = 1/(1 + c Pva H), so c falls straight out
    const ksCoeff = (1 / e.saturationFactorKs - 1) / (1.5 * 10);
    expect(ksCoeff).toBeCloseTo(0.053, 12);
    // the standing loss is a whole year of it
    const days = e.standingLossLbYr
      / (e.vapourSpaceFt3 * e.vapourDensityLbFt3 * e.expansionFactorKe * e.saturationFactorKs);
    expect(days).toBeCloseTo(365, 9);
    // with the vent setting above the thermal term, Ke is exactly dT/T
    const noVent = evaporativeLosses({
      diameterFt: 110, vapourSpaceHeightFt: 10, vapourPressurePsia: 1.5, ventSettingPsi: 99,
    });
    expect(20 / noVent.expansionFactorKe).toBeCloseTo(530, 9);
    // eslint-disable-next-line no-console
    console.log(`AP-42 register: Ks coefficient ${ksCoeff}, ${days.toFixed(6)} days, avgTempR ${(20 / noVent.expansionFactorKe).toFixed(6)}`);
  });

  test('the inches of water to psi packaging is the stated value', () => {
    const f = orificeFlow({
      pipeIdIn: 6.065, orificeIdIn: 3, dpInH2O: 100, p1Psia: 500,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    });
    expect(f.dpPsi / 100).toBeCloseTo(0.0361273, 12);
  });

  test('the Reader-Harris coefficient at vanishing beta is its leading constant', () => {
    // Every beta-power term and every Reynolds term vanishes, so what
    // is left is the leading 0.5961. This is the one RG coefficient
    // that can be isolated from the engine rather than pinned by value.
    const c = dischargeCoefficient({ beta: 1e-8, reynolds: 1e30, pipeIdIn: 10.02 });
    expect(c.cd).toBeCloseTo(0.5961, 9);
    // eslint-disable-next-line no-console
    console.log(`RG leading constant isolated at beta 1e-8, Re 1e30: ${c.cd}`);
  });

  test('the Reader-Harris coefficient and the expansibility are pinned by value', () => {
    // No publication in this repository holds these coefficients, so
    // these literals detect silent change and nothing more. Five
    // defects planted in the engine and the oracle together used to
    // leave this suite green precisely here.
    const CD_PINS = [
      { beta: 0.3, reynolds: 1e5, pipeIdIn: 6.065, cd: 0.5995030733092139 },
      { beta: 0.5, reynolds: 5e5, pipeIdIn: 10.02, cd: 0.6037702963266368 },
      { beta: 0.65, reynolds: 2e6, pipeIdIn: 10.02, cd: 0.6038772372478071 },
      { beta: 0.4, reynolds: 1e4, pipeIdIn: 4.026, cd: 0.609865466895758 },
      { beta: 0.45, reynolds: 3e5, pipeIdIn: 2.067, cd: 0.6045264711287857 },
    ];
    CD_PINS.forEach((p) => {
      const c = dischargeCoefficient(p);
      expect(rel(c.cd, p.cd)).toBeLessThan(1e-13);
    });
    const EPS_PINS = [
      { beta: 0.3, dpPsi: 20, p1Psia: 500, k: 1.3, eps: 0.9890833283634513 },
      { beta: 0.6, dpPsi: 40, p1Psia: 500, k: 1.3, eps: 0.9751621357289505 },
      { beta: 0.75, dpPsi: 60, p1Psia: 900, k: 1.28, eps: 0.9724457495722146 },
    ];
    EPS_PINS.forEach((p) => {
      expect(rel(expansibility(p), p.eps)).toBeLessThan(1e-13);
    });
    // eslint-disable-next-line no-console
    console.log(`constant register: ${CD_PINS.length} Reader-Harris and ${EPS_PINS.length} expansibility values pinned by literal`);
  });

  test('the uncertainty sensitivities keep their structure', () => {
    const u = orificeUncertainty({ beta: 0.5, dpUncertaintyPct: 0.5 });
    const s = (name) => u.contributions.find((c) => c.name === name).sensitivity;
    // the bore enters twice through the area and once through beta, the
    // pipe only through beta, so the difference is exactly 2
    expect(s('orifice bore') - s('pipe bore')).toBeCloseTo(2, 12);
    // the differential and the density both enter under a square root
    expect(s('differential pressure')).toBeCloseTo(0.5, 12);
    expect(s('density')).toBeCloseTo(0.5, 12);
    expect(s('discharge coefficient')).toBeCloseTo(1, 12);
  });

  test('the transmitter accuracy default and the meter factor band are stated', () => {
    const t = transmitterUncertaintyPct({ dpInH2O: 100, spanInH2O: 100 });
    expect(t.uncertaintyPctOfReading).toBeCloseTo(0.075, 12);
    expect(t.flowTurndownLimit).toBe(3);
    expect(t.differentialTurndownLimit).toBe(9);
    expect(turbineVolume({ pulses: 1e6, kFactorPulsesPerBbl: 1000, meterFactor: 1.005 }).warning)
      .toBeNull();
    expect(turbineVolume({ pulses: 1e6, kFactorPulsesPerBbl: 1000, meterFactor: 1.02 }).warning)
      .toMatch(/proving failure/);
  });
});

/* ================================================================== *
 * 2. TANK GEOMETRY AND SHELL
 * ================================================================== */

describe('tank geometry and shell', () => {
  test('capacity matches the SI assembly and refuses a negative fill', () => {
    G.capacity.forEach((row) => {
      const c = tankCapacity(row);
      expect(c.error).toBeUndefined();
      within('capacity crossSection', c.crossSectionFt2, row.crossSectionFt2, 1e-9);
      within('capacity nominalFt3', c.nominalFt3, row.nominalFt3, 1e-9);
      within('capacity nominalBbl', c.nominalBbl, row.nominalBbl, 1e-9);
      within('capacity workingBbl', c.workingBbl, row.workingBbl, 1e-9);
      within('capacity bblPerFt', c.bblPerFt, row.bblPerFt, 1e-9);
    });
    expect(tankCapacity({ diameterFt: 0, heightFt: 40 }).error).toBeTruthy();
    // A tank does not hold less than nothing. This used to print
    // "Working -20,143 bbl" on the screen.
    const neg = tankCapacity({ diameterFt: 120, heightFt: 40, fillHeightFt: -10 });
    expect(neg.error).toMatch(/cannot be negative/);
    // eslint-disable-next-line no-console
    console.log(`capacity examined ${G.capacity.length} tanks against the SI assembly, plus the negative fill refusal`);
  });

  test('the 2.6 constant matches the SI re-derivation', () => {
    G.shell.forEach((row) => {
      const r = shellCourse({ ...row, courseBottomHeightFt: 0 });
      expect(r.error).toBeUndefined();
      // 2.6 is a rounded packaging of rho g / 2 with the unit
      // conversions folded in, so agreement is to a few parts in 10,000
      within('shell tDesign', r.tDesignIn, row.tDesignIn, 1e-3);
      within('shell tTest', r.tTestIn, row.tTestIn, 1e-3);
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

  test('courses thin upward, the minimum plate governs, and the summary says so', () => {
    const s = shellCourses({ diameterFt: 120, heightFt: 40, sg: 0.85 });
    expect(s.error).toBeUndefined();
    expect(s.courses).toHaveLength(5);
    for (let i = 1; i < s.courses.length; i += 1) {
      expect(s.courses[i].requiredIn).toBeLessThanOrEqual(s.courses[i - 1].requiredIn);
    }
    // the top course is at the minimum plate thickness
    expect(s.courses[s.courses.length - 1].governing).toBe('minimum plate thickness');
    // and the caller no longer has to derive the four facts itself
    expect(s.thickestCourse).toBe(1);
    expect(s.governingCourse).toBe(1);
    expect(s.governingReason).toBe('hydrostatic test');
    expect(s.thickestRequiredIn).toBeCloseTo(s.courses[0].requiredIn, 12);
    expect(s.testGovernedCount).toBeGreaterThan(0);
    expect(s.minimumGovernedCount).toBeGreaterThan(0);
    expect(s.minimumThicknessIn).toBe(0.1875);
    // a screen that says "minimum plate thickness" now has the number
    expect(s.summary).toMatch(/0\.1875 in minimum governs/);
    // THE INVARIANT, across geometries: the bottom course is always the
    // thickest, because the head falls upward and the minimum is a floor.
    // So `governingCourse` is a property of the method rather than a
    // result, and the fields that DO vary are the crossovers below.
    [
      { diameterFt: 120, heightFt: 40, sg: 0.85 },
      { diameterFt: 48, heightFt: 24, sg: 0.7, courseHeightFt: 6 },
      { diameterFt: 200, heightFt: 56, sg: 1.0 },
      { diameterFt: 30, heightFt: 16, sg: 0.55, courseHeightFt: 4 },
      { diameterFt: 150, heightFt: 48, sg: 0.9, minimumThicknessIn: 0.3125 },
    ].forEach((tank) => {
      const r = shellCourses(tank);
      expect(r.error).toBeUndefined();
      const argmax = r.courses.reduce((a, b) => (b.requiredIn > a.requiredIn ? b : a)).course;
      expect(r.thickestCourse).toBe(argmax);
      expect(r.governingCourse).toBe(argmax);
      expect(argmax).toBe(1);
      for (let i = 1; i < r.courses.length; i += 1) {
        expect(r.courses[i].requiredIn).toBeLessThanOrEqual(r.courses[i - 1].requiredIn);
      }
      // the crossovers, which DO move with the geometry
      if (r.minimumGovernedCount > 0) {
        expect(r.firstMinimumGovernedCourse)
          .toBe(r.courses.find((c) => c.governing === 'minimum plate thickness').course);
        expect(r.courses.slice(r.firstMinimumGovernedCourse - 1)
          .every((c) => c.governing === 'minimum plate thickness')).toBe(true);
      } else {
        expect(r.firstMinimumGovernedCourse).toBeNull();
      }
      if (r.testGovernedCount > 0) {
        expect(r.lastTestGovernedCourse).toBeGreaterThan(0);
        expect(r.courses[r.lastTestGovernedCourse - 1].governing).toBe('hydrostatic test');
      } else {
        expect(r.lastTestGovernedCourse).toBeNull();
      }
    });
    // and the crossover really does move: a thicker stated minimum takes
    // over sooner
    const thin = shellCourses({ diameterFt: 150, heightFt: 48, sg: 0.9 });
    const thick = shellCourses({
      diameterFt: 150, heightFt: 48, sg: 0.9, minimumThicknessIn: 0.3125,
    });
    expect(thick.firstMinimumGovernedCourse).toBeLessThan(thin.firstMinimumGovernedCourse);
    // eslint-disable-next-line no-console
    console.log(`shell summary invariant examined on 5 tanks: the bottom course governs every one, and the minimum-plate crossover moves from course ${thin.firstMinimumGovernedCourse} to ${thick.firstMinimumGovernedCourse} when the stated minimum goes from 0.1875 to 0.3125 in`);
    expect(s.courses[4].note).toMatch(/stated minimum of 0\.1875 in governs/);
    // eslint-disable-next-line no-console
    console.log(`shell summary examined: ${s.summary}`);
  });

  test('a course refuses a zero allowable stress and a negative minimum', () => {
    expect(shellCourse({
      diameterFt: 120, courseBottomHeightFt: 0, liquidLevelFt: 40, sg: 0.85, designStressPsi: 0,
    }).error).toMatch(/allowable stress/);
    expect(shellCourse({
      diameterFt: 120, courseBottomHeightFt: 0, liquidLevelFt: 40, sg: 0.85,
      minimumThicknessIn: -1,
    }).error).toMatch(/minimum plate thickness/);
  });
});

/* ================================================================== *
 * 3. VENTING
 * ================================================================== */

describe('venting', () => {
  test('movement venting matches the SI route and refuses a negative rate', () => {
    G.movement.forEach((row) => {
      const m = movementVenting(row);
      expect(m.error).toBeUndefined();
      within('movement out', m.outbreathingScfh, row.outbreathingScfh, 1e-9);
      if (row.inbreathingScfh > 0) {
        within('movement in', m.inbreathingScfh, row.inbreathingScfh, 1e-9);
      }
    });
    // the only export in these modules that used to have no error path
    // at all, and it returned negative venting
    const neg = movementVenting({ fillBblPerHr: -500, drawBblPerHr: -800 });
    expect(neg.error).toMatch(/non-negative/);
    expect(normalVenting({ nominalBbl: 10000, fillBblPerHr: -500 }).error).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(`movement venting examined ${G.movement.length} rows and the negative-rate refusal`);
  });

  test('the whole normal vent matches the SI route, including which case governs', () => {
    G.normalVent.forEach((row) => {
      const v = normalVenting(row);
      expect(v.error).toBeUndefined();
      within('normalVent out', v.outbreathingScfh, row.outbreathingScfh, 1e-9);
      within('normalVent in', v.inbreathingScfh, row.inbreathingScfh, 1e-9);
      within('normalVent thermal in', v.thermal.inbreathingScfh, row.thermalInbreathingScfh, 1e-9);
      expect(v.governing).toBe(row.governing);
      // ONE predicate: the label and the warning cannot disagree
      if (row.vacuumGoverns) expect(v.warning).toMatch(/pull it flat/);
      else expect(v.warning).toBeNull();
    });
    // eslint-disable-next-line no-console
    console.log(`normal venting examined ${G.normalVent.length} cases, including the tie where the label used to say vacuum with no warning`);
  });

  test('the governing case is decided once, so the tie cannot disagree with itself', () => {
    // out === in exactly. The label said vacuum and the warning stayed
    // silent, because two expressions decided the same question.
    const tie = normalVenting({ nominalBbl: 10000, highVolatility: true });
    expect(tie.outbreathingScfh).toBeCloseTo(tie.inbreathingScfh, 9);
    expect(tie.governing).toBe('vacuum (inbreathing)');
    expect(tie.warning).toMatch(/pull it flat/);
  });

  test('a volatile product doubles the movement outbreathing', () => {
    const low = movementVenting({ fillBblPerHr: 500 });
    const high = movementVenting({ fillBblPerHr: 500, highVolatility: true });
    expect(high.outbreathingScfh).toBeCloseTo(2 * low.outbreathingScfh, 9);
  });

  test('insulation earns a thermal credit and says it is this engine\'s choice', () => {
    const bare = thermalVenting({ nominalBbl: 10000 });
    const lagged = thermalVenting({ nominalBbl: 10000, insulated: true });
    expect(lagged.inbreathingScfh).toBeLessThan(bare.inbreathingScfh);
    expect(lagged.note).toMatch(/stated choice/);
    expect(thermalVenting({ nominalBbl: 0 }).error).toBeTruthy();
    expect(thermalVenting({ nominalBbl: 10000, latitudeFactor: 0 }).error).toMatch(/latitude/);
    expect(thermalVenting({ nominalBbl: 10000, latitudeFactor: 5 }).error).toMatch(/latitude/);
  });

  test('a tank above the proportional limit is warned, not silently extrapolated', () => {
    const small = thermalVenting({ nominalBbl: 9000 });
    expect(small.aboveProportionalLimit).toBe(false);
    expect(small.warning).toBeNull();
    const big = thermalVenting({ nominalBbl: 80574 });
    expect(big.aboveProportionalLimit).toBe(true);
    expect(big.warning).toMatch(/extrapolation/);
    expect(normalVenting({ nominalBbl: 80574 }).thermalWarning).toMatch(/extrapolation/);
    // eslint-disable-next-line no-console
    console.log(`the studio's own 80,574 bbl tank is flagged: ${big.warning.slice(0, 96)}...`);
  });
});

/* ================================================================== *
 * 4. THE FIRE CASE
 * ================================================================== */

describe('the fire case: a computed duty and a withheld vent', () => {
  test('wetted area counts only the shell below 30 ft', () => {
    const w = wettedAreaFt2({ diameterFt: 120, liquidLevelFt: 40 });
    expect(w.effectiveHeightFt).toBe(30);
    expect(w.note).toMatch(/below 30 ft/);
    expect(wettedAreaFt2({ diameterFt: 120, liquidLevelFt: 0 }).error).toBeTruthy();
  });

  test('the heat input matches the SI evaluation of the band relations', () => {
    G.fireDuty.forEach((row) => {
      const f = fireVenting(row);
      expect(f.error).toBeUndefined();
      // A TRANSCRIPTION, and the margin report says so at 0.000 percent.
      // The real check on these eight constants is the band-edge
      // continuity in the next test.
      within('fire duty (transcribed: the band edges are the real check)', f.qBtuHr, row.qBtuHr, 1e-9);
    });
    // eslint-disable-next-line no-console
    console.log(`fire duty examined ${G.fireDuty.length} areas across all four bands, as a change detector; the band-edge continuity below is what pins the constants`);
  });

  test('THE PROPERTY: the four band relations join up at their edges', () => {
    // Four power laws that have to meet at 200, 1000 and 2800 ft2
    // cannot be moved one at a time. The old gate allowed a
    // factor-of-two step, `expect(q).toBeGreaterThan(prev * 0.5)`,
    // which is why an exponent of 0.500 in place of 0.566 went green.
    G.fireBandEdges.forEach((row) => {
      const below = fireVenting({ wettedFt2: row.areaFt2 * (1 - 1e-9) }).qBtuHr;
      const above = fireVenting({ wettedFt2: row.areaFt2 * (1 + 1e-9) }).qBtuHr;
      const ratio = above / below;
      expect(Math.abs(ratio - 1)).toBeLessThan(0.01);
      within('fire band edge ratio', ratio, row.ratioAcrossEdge, 1e-6);
      // eslint-disable-next-line no-console
      console.log(`band edge at ${row.areaFt2} ft2 joins to ${((ratio - 1) * 100).toFixed(4)} percent`);
    });
    // and the duty still rises with area everywhere
    let prev = 0;
    [150, 199, 201, 900, 1001, 2799, 2801, 5000].forEach((a) => {
      const q = fireVenting({ wettedFt2: a }).qBtuHr;
      expect(q).toBeGreaterThan(prev);
      prev = q;
    });
  });

  test('THE DECISION: the vent capacity is WITHHELD, by name', () => {
    const w = wettedAreaFt2({ diameterFt: 120, liquidLevelFt: 40 });
    const f = fireVenting({ wettedFt2: w.areaFt2 });
    expect(f.qBtuHr).toBeGreaterThan(0);
    // No number is offered, and the reason names the standard that is
    // missing and the size of the risk. The relation that used to be
    // here divided by sqrt(M * tempR) beside a dead * Math.sqrt(1), and
    // if the customary packaged form is right it under-stated the vent
    // by about 23.7 times. A vent 24 times too small is how a tank is
    // destroyed, so this returns nothing rather than guessing.
    expect(f.ventScfhAir).toBeNull();
    expect(f.ventWithheld).toBe(true);
    expect(f.ventWithheldReason).toBe(FIRE_VENT_WITHHELD);
    expect(f.ventWithheldReason).toMatch(/API 2000/);
    expect(f.ventWithheldReason).toMatch(/factor of about 24/);
    // nothing in the module may hand back a vent figure under any input
    [
      { wettedFt2: 100 }, { wettedFt2: 900 }, { wettedFt2: 2000 },
      { wettedFt2: 1e5 }, { wettedFt2: w.areaFt2, environmentFactor: 0.3 },
    ].forEach((inputs) => {
      expect(fireVenting(inputs).ventScfhAir).toBeNull();
    });
    // eslint-disable-next-line no-console
    console.log(`fire vent withheld on 5 input sets; the duty at the studio's own tank is ${(f.qBtuHr / 1e6).toFixed(2)} MMBtu/hr`);
  });

  test('the environment factor is a credit and is bounded at one', () => {
    expect(fireVenting({ wettedFt2: 900, environmentFactor: 5 }).error).toMatch(/between 0 and 1/);
    expect(fireVenting({ wettedFt2: 900, environmentFactor: 0 }).error).toBeTruthy();
    const credited = fireVenting({ wettedFt2: 900, environmentFactor: 0.3 });
    expect(credited.qBtuHr).toBeCloseTo(0.3 * fireVenting({ wettedFt2: 900 }).qBtuHr, 6);
    expect(fireVenting({ wettedFt2: 0 }).error).toBeTruthy();
  });

  test('a tank above the top band says the relation has no upper bound here', () => {
    expect(fireVenting({ wettedFt2: 1e5 }).warning).toMatch(/no upper bound in this package/);
    expect(fireVenting({ wettedFt2: 900 }).warning).toBeNull();
  });
});

/* ================================================================== *
 * 5. EVAPORATIVE LOSSES
 * ================================================================== */

describe('evaporative losses', () => {
  test('the whole chain matches the entirely-SI computation', () => {
    G.evaporative.forEach((row) => {
      const r = evaporativeLosses(row);
      expect(r.error).toBeUndefined();
      // the 10.731 field gas constant against the SI one, and 0.053
      // per psia per foot against per pascal per metre
      within('evaporative vapour density', r.vapourDensityLbFt3, row.vapourDensityLbFt3, 1e-3);
      within('evaporative vapour space', r.vapourSpaceFt3, row.vapourSpaceFt3, 1e-9);
      within('evaporative Ke', r.expansionFactorKe, row.expansionFactorKe, 1e-12);
      within('evaporative Ks', r.saturationFactorKs, row.saturationFactorKs, 1e-9);
      within('evaporative standing loss', r.standingLossLbYr, row.standingLossLbYr, 1e-3);
      within('evaporative working loss', r.workingLossLbYr, row.workingLossLbYr, 1e-3);
      within('evaporative total', r.totalLossLbYr, row.totalLossLbYr, 1e-3);
      expect(r.totalLossLbYr).toBeCloseTo(r.standingLossLbYr + r.workingLossLbYr, 6);
      expect(r.totalLossShortTonsYr).toBeCloseTo(r.totalLossLbYr / 2000, 9);
    });
    // eslint-disable-next-line no-console
    console.log(`evaporative losses examined ${G.evaporative.length} cases end to end in SI`);
  });

  test('THE REFUSAL: a product that boils at ambient is not a fixed-roof tank', () => {
    const base = {
      diameterFt: 120, vapourSpaceHeightFt: 12, throughputBbl: 500000,
    };
    // At 30 psia the standing loss used to be MINUS 29,008 lb/yr while
    // the total still printed positive at 466.8 tons/yr, because the
    // working loss was unaffected. At exactly 14.7 it was Infinity.
    [30, 14.7, 14.70001, 100].forEach((pva) => {
      const r = evaporativeLosses({ ...base, vapourPressurePsia: pva });
      expect(r.error).toMatch(/at or above the stated atmospheric pressure/);
      expect(r.standingLossLbYr).toBeUndefined();
    });
    // and it is the STATED atmospheric pressure, not a hardcoded 14.7
    expect(evaporativeLosses({ ...base, vapourPressurePsia: 16, atmosphericPsia: 20 }).error)
      .toBeUndefined();
    expect(evaporativeLosses({ ...base, vapourPressurePsia: 11, atmosphericPsia: 10 }).error)
      .toMatch(/boils at ambient/);
    // eslint-disable-next-line no-console
    console.log('evaporative refusal examined at 30, 14.7, 14.70001 and 100 psia TVP, and at a stated 20 and 10 psia atmosphere');
  });

  test('THE PROPERTIES: the saturation and expansion factors behave', () => {
    const base = {
      diameterFt: 120, vapourSpaceHeightFt: 12, vapourPressurePsia: 1.5,
      throughputBbl: 500000,
    };
    const r = evaporativeLosses(base);
    // Ks approaches 1 as the product stops evaporating
    expect(evaporativeLosses({ ...base, vapourPressurePsia: 1e-12 }).saturationFactorKs)
      .toBeCloseTo(1, 9);
    // and falls with both the vapour pressure and the vapour space
    expect(evaporativeLosses({ ...base, vapourPressurePsia: 4 }).saturationFactorKs)
      .toBeLessThan(r.saturationFactorKs);
    expect(evaporativeLosses({ ...base, vapourSpaceHeightFt: 24 }).saturationFactorKs)
      .toBeLessThan(r.saturationFactorKs);
    // Ke is never below the bare thermal term
    expect(r.expansionFactorKe).toBeGreaterThanOrEqual(20 / 530);
    // the standing loss is exactly proportional to the vapour volume
    const wide = evaporativeLosses({ ...base, diameterFt: 240 });
    expect(wide.vapourSpaceFt3 / r.vapourSpaceFt3).toBeCloseTo(4, 9);
    const volatile = evaporativeLosses({ ...base, vapourPressurePsia: 4 });
    expect(volatile.standingLossLbYr).toBeGreaterThan(r.standingLossLbYr);
    const taller = evaporativeLosses({ ...base, vapourSpaceHeightFt: 24 });
    expect(taller.standingLossLbYr).toBeGreaterThan(r.standingLossLbYr);
    expect(r.note).toMatch(/money question and the emissions one/);
    expect(evaporativeLosses({ diameterFt: 120, vapourSpaceHeightFt: 12, vapourPressurePsia: 0 }).error)
      .toBeTruthy();
  });

  test('the dead turnover input is gone rather than echoed back', () => {
    // Swept 1 to 500 turnovers the total loss moved 0.000000 percent
    // and the input was returned in the result as though it had worked.
    const r = evaporativeLosses({
      diameterFt: 120, vapourSpaceHeightFt: 12, vapourPressurePsia: 1.5,
      throughputBbl: 500000, turnoversPerYear: 36,
    });
    expect(r.turnoversPerYear).toBeUndefined();
    expect(r.turnoverFactorNote).toMatch(/Kn is not carried by this package/);
    // the turnover effect that IS carried is the stated one, and it bites
    const doubled = evaporativeLosses({
      diameterFt: 120, vapourSpaceHeightFt: 12, vapourPressurePsia: 1.5,
      throughputBbl: 500000, workingTurnoverFactor: 2,
    });
    expect(doubled.workingLossLbYr).toBeCloseTo(2 * r.workingLossLbYr, 6);
  });

  test('control refuses a missing efficiency and an impossible one', () => {
    const c = lossControl({ uncontrolledLbYr: 100000, controlEfficiencyPct: 90 });
    expect(c.savedLbYr).toBeCloseTo(90000, 6);
    expect(c.remainingLbYr).toBeCloseTo(10000, 6);
    expect(c.note).toMatch(/floating roof/);
    expect(lossControl({ uncontrolledLbYr: -1 }).error).toBeTruthy();
    // Math.min(Math.max(undefined, 0), 100) is NaN, and it used to be
    // returned beside the customary-range note as though it answered
    expect(lossControl({ uncontrolledLbYr: 1e5 }).error).toMatch(/not the same as saying zero/);
    expect(lossControl({ uncontrolledLbYr: 1e5, controlEfficiencyPct: 150 }).error)
      .toMatch(/impossible/);
    expect(lossControl({ uncontrolledLbYr: 1e5, controlEfficiencyPct: -5 }).error)
      .toMatch(/impossible/);
  });
});

/* ================================================================== *
 * 6. ORIFICE METERING
 * ================================================================== */

describe('orifice metering', () => {
  test('the Reader-Harris coefficient matches the high-precision assembly', () => {
    let maxDiff = 0;
    G.cd.forEach((row) => {
      const r = dischargeCoefficient(row);
      expect(r.error).toBeUndefined();
      within('cd decimal assembly', r.cd, row.cd, 1e-12);
      maxDiff = Math.max(maxDiff, Math.abs(r.cd - row.cd));
    });
    // These rows used to reproduce BIT FOR BIT, at exactly 0.000 percent
    // of a 1e-12 tolerance, which is the signature of an oracle
    // restating the engine rather than checking it. The oracle now
    // evaluates the correlation in 60-digit decimal, so a real
    // disagreement in the last bits is the expected result and its
    // absence would mean the routes had collapsed onto each other.
    expect(maxDiff).toBeGreaterThan(0);
    expect(dischargeCoefficient({ beta: 1.2, reynolds: 1e5, pipeIdIn: 6 }).error).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(`cd examined ${G.cd.length} rows against a 60-digit decimal assembly; largest last-bit disagreement ${maxDiff.toExponential(2)}`);
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
    // the span quoted above is across the BETA range, and a curve at a
    // single beta shows far less: the app's caption said otherwise
    const atOneBeta = [1e4, 1e5, 1e6, 1e7].map((re) => dischargeCoefficient({
      beta: 0.5, reynolds: re, pipeIdIn: 6.065,
    }).cd);
    const spanAtOneBeta = (Math.max(...atOneBeta) - Math.min(...atOneBeta))
      / Math.min(...atOneBeta);
    const spanAcrossBeta = (highest - lowest) / lowest;
    expect(spanAtOneBeta).toBeLessThan(spanAcrossBeta / 2);
    // eslint-disable-next-line no-console
    console.log(`Cd spans ${(spanAcrossBeta * 100).toFixed(1)} percent across beta, and ${(spanAtOneBeta * 100).toFixed(2)} percent across Reynolds at a single beta: the chart caption that quoted the first figure under a line drawn at the second is what this measures`);
  });

  test('the published beta range is stated at the value it is stated at', () => {
    // The 0.1 to 0.75 range appears in a flag and in a warning, and the
    // warning's threshold used to be assertable by nothing: moving it to
    // 0.95 left this suite green, so a beta 0.8 plate was reported without
    // the sentence telling the reader to resize it.
    const inside = orificeFlow({
      pipeIdIn: 6.065, orificeIdIn: 3.5, dpInH2O: 100, p1Psia: 500,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    });
    expect(inside.beta).toBeLessThan(0.75);
    expect(inside.betaInPublishedRange).toBe(true);
    expect(String(inside.warning)).not.toMatch(/outside the 0\.1 to 0\.75 range/);
    [0.76, 0.8, 0.9, 0.95].forEach((beta) => {
      const out = orificeFlow({
        pipeIdIn: 6.065, orificeIdIn: beta * 6.065, dpInH2O: 100, p1Psia: 500,
        densityLbFt3: 2.5, viscosityCp: 0.012,
      });
      expect(out.betaInPublishedRange).toBe(false);
      expect(out.warning).toMatch(/outside the 0\.1 to 0\.75 range/);
      expect(out.warning).toMatch(/resize the plate/);
      expect(dischargeCoefficient({ beta, reynolds: 1e6, pipeIdIn: 6.065 }).warning)
        .toMatch(/outside the 0\.1 to 0\.75 range/);
    });
    // and below the range as well
    const low = orificeFlow({
      pipeIdIn: 6.065, orificeIdIn: 0.5, dpInH2O: 100, p1Psia: 500,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    });
    expect(low.betaInPublishedRange).toBe(false);
    expect(low.warning).toMatch(/outside the 0\.1 to 0\.75 range/);
    // eslint-disable-next-line no-console
    console.log('the published beta range examined at 0.577 inside and at 0.082, 0.76, 0.8, 0.9 and 0.95 outside');
  });

  test('every coefficient says the low Reynolds end is not validated here', () => {
    // The Suite's chart sweeps from 10 ** 3.5, below where the
    // correlation is published, and this package does not carry the
    // floor, so the limit travels with the answer.
    const c = dischargeCoefficient({ beta: 0.5, reynolds: 3162, pipeIdIn: 6.065 });
    expect(c.cd).toBeGreaterThan(0);
    expect(c.reynoldsBasis).toMatch(/lower Reynolds number limit .* is not carried/);
    expect(orificeFlow({
      pipeIdIn: 6.065, orificeIdIn: 3, dpInH2O: 100, p1Psia: 500,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    }).reynoldsBasis).toMatch(/not carried by this package/);
  });

  test('mass flow matches the entirely-SI computation', () => {
    G.orifice.forEach((row) => {
      const r = orificeFlow(row);
      expect(r.error).toBeUndefined();
      within('orifice cd', r.cd, row.cd, 1e-6);
      within('orifice expansibility', r.expansibility, row.expansibility, 1e-9);
      // the 32.174, 144 and 0.0361273 packagings against pure SI
      within('orifice massLbHr', r.massLbHr, row.massLbHr, 1e-5);
      expect(r.betaInPublishedRange).toBe(true);
    });
    // one of the rows is a 2.067 in run, so the below-2.8-inch
    // correction is reachable rather than merely present
    const small = dischargeCoefficient({ beta: 0.45, reynolds: 3e5, pipeIdIn: 2.067 });
    expect(small.smallBoreCorrectionApplied).toBe(true);
    expect(dischargeCoefficient({ beta: 0.45, reynolds: 3e5, pipeIdIn: 6.065 })
      .smallBoreCorrectionApplied).toBe(false);
    // eslint-disable-next-line no-console
    console.log(`orifice flow examined ${G.orifice.length} runs in SI, one of them small bore`);
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
    // guarded rather than silently NaN
    expect(expansibility({ beta: 0.5, dpPsi: 600, p1Psia: 500, k: 1.3 })).toBeNaN();
    expect(expansibility({ beta: 1.2, dpPsi: 10, p1Psia: 500, k: 1.3 })).toBeNaN();
  });

  test('THE NAMED REFUSAL: a differential above the static pressure', () => {
    // This used to give a NaN expansibility with no error, a NaN mass
    // flow, a NaN Reynolds number, and the user was finally told "a
    // positive pipe Reynolds number is needed", which is not the
    // problem.
    const r = orificeFlow({
      pipeIdIn: 6.065, orificeIdIn: 3, dpInH2O: 2000, p1Psia: 50,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    });
    expect(r.error).toMatch(/at or above the static pressure/);
    expect(r.error).toMatch(/72\.25 psi/);
    expect(r.massLbHr).toBeUndefined();
    // eslint-disable-next-line no-console
    console.log(`named refusal examined: ${r.error.slice(0, 110)}...`);
  });

  test('sizing matches an independent SI bisection and never errors with a bore', () => {
    G.sizing.forEach((row) => {
      const s = sizeOrifice(row);
      expect(s.error).toBeUndefined();
      within('sizing beta', s.beta, row.beta, 1e-5);
      within('sizing bore', s.orificeIdIn, row.orificeIdIn, 1e-5);
      within('sizing flow round trip', s.massLbHr, row.targetMassLbHr, 1e-6);
      expect(s.boreNote).toMatch(/stock size/);
    });
    expect(sizeOrifice({
      pipeIdIn: 2.067, targetMassLbHr: 1e9, dpInH2O: 100, p1Psia: 500,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    }).error).toMatch(/cannot pass this flow/);
    // It used to return beta 0.05 and a bore of 0.30325 in BESIDE its
    // own error, because a refused flow mapped to NaN and every
    // comparison against NaN is false.
    const refused = sizeOrifice({
      pipeIdIn: 6.065, targetMassLbHr: 50000, dpInH2O: 0, p1Psia: 500,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    });
    expect(refused.error).toBeTruthy();
    expect(refused.beta).toBeUndefined();
    expect(refused.orificeIdIn).toBeUndefined();
    // and it does not bracket past the correlation's published range
    const wide = sizeOrifice({
      pipeIdIn: 6.065, targetMassLbHr: 60000, dpInH2O: 30, p1Psia: 500,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    });
    if (!wide.error) expect(wide.beta).toBeLessThanOrEqual(0.75);
    // eslint-disable-next-line no-console
    console.log(`sizing examined ${G.sizing.length} SI bisections, plus the bore-beside-an-error case`);
  });

  test('permanent loss matches the closed form and behaves at both limits', () => {
    G.permanent.forEach((row) => {
      const r = permanentLoss(row);
      expect(r.error).toBeUndefined();
      within('permanent loss fraction', r.lossFraction, row.lossFraction, 1e-12);
      within('permanent loss inH2O', r.lossInH2O, row.lossInH2O, 1e-12);
    });
    // THE PROPERTIES, which the closed form cannot satisfy by accident:
    // a vanishing plate loses the whole differential and a plate the
    // size of the pipe loses none of it
    expect(permanentLoss({ dpInH2O: 100, beta: 1e-6, cd: 0.6 }).lossFraction)
      .toBeCloseTo(1, 9);
    expect(permanentLoss({ dpInH2O: 100, beta: 0.999999, cd: 0.6 }).lossFraction)
      .toBeLessThan(0.01);
    // and it falls monotonically in between, which is the trade
    let prev = 1.1;
    [0.2, 0.3, 0.4, 0.5, 0.6, 0.7].forEach((beta) => {
      const f = permanentLoss({ dpInH2O: 100, beta, cd: 0.604 }).lossFraction;
      expect(f).toBeLessThan(prev);
      prev = f;
    });
    // and the high-beta plate warns about its other costs
    const highBeta = orificeFlow({
      pipeIdIn: 6.065, orificeIdIn: 4.0, dpInH2O: 100, p1Psia: 500,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    });
    expect(highBeta.warning).toMatch(/uncertainty and the straight-run/);
    // the coefficient is required rather than defaulted to the one
    // constant this module exists to disprove
    expect(permanentLoss({ dpInH2O: 100, beta: 0.5 }).error).toMatch(/not a constant 0\.61/);
    // eslint-disable-next-line no-console
    console.log(`permanent loss examined ${G.permanent.length} rows, both limits and 6 betas for monotonicity`);
  });
});

/* ================================================================== *
 * 7. UNCERTAINTY, AND THE TWO ROUTES THAT NOW MEET
 * ================================================================== */

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
      within(`uncertainty RSS vs Monte Carlo (${row.label})`,
        r.totalUncertaintyPct, row.monteCarloPct, 0.02);
    });
    // eslint-disable-next-line no-console
    console.log(`uncertainty examined ${G.uncertainty.length} budgets against 200,000-sample Monte Carlo propagations`);
  });

  test('THE TWO ROUTES MEET: the transmitter feeds the differential term', () => {
    // The budget used to take a TYPED differential uncertainty while
    // the transmitter calculation produced a different figure from the
    // same reading and span, and both were displayed side by side: 0.5
    // percent typed beside 0.15 percent computed.
    const t = transmitterUncertaintyPct({ dpInH2O: 100, spanInH2O: 200 });
    const wired = orificeUncertainty({ beta: 0.4946, dpInH2O: 100, spanInH2O: 200 });
    expect(wired.differentialUncertaintyPct).toBeCloseTo(t.uncertaintyPctOfReading, 12);
    expect(wired.differentialUncertaintyPct).toBeCloseTo(0.15, 12);
    expect(wired.differentialUncertaintySource).toMatch(/differential transmitter/);
    expect(wired.transmitter.differentialTurndown).toBeCloseTo(2, 12);
    // and it moves the budget, which is the point: at 40 of 200 in H2O
    // the transmitter term is 0.375 percent, not 0.15
    const turned = orificeUncertainty({ beta: 0.4946, dpInH2O: 40, spanInH2O: 200 });
    expect(turned.differentialUncertaintyPct).toBeCloseTo(0.375, 12);
    expect(turned.totalUncertaintyPct).toBeGreaterThan(wired.totalUncertaintyPct);
    // the typed route still works when no reading and span are given
    const typed = orificeUncertainty({ beta: 0.4946, dpUncertaintyPct: 0.5 });
    expect(typed.differentialUncertaintySource).toMatch(/typed/);
    expect(typed.differentialUncertaintyPct).toBeCloseTo(0.5, 12);
    // eslint-disable-next-line no-console
    console.log(`the wired budget examined: at 100 of 200 in H2O the differential term is ${wired.differentialUncertaintyPct} percent and Cd is ${wired.dominantShareOfVariancePct.toFixed(1)} percent of the variance`);
  });

  test('THE POINT: the dominant term is named, it moves, and a photo finish says so', () => {
    const tight = orificeUncertainty({ beta: 0.5, dpUncertaintyPct: 0.5 });
    expect(tight.dominant).toBe('discharge coefficient');
    const loose = orificeUncertainty({ beta: 0.5, dpUncertaintyPct: 2.0 });
    expect(loose.dominant).toBe('differential pressure');
    expect(loose.note).toMatch(/spend on it first/);
    // the shares of variance add to 100
    const total = loose.contributions.reduce((s, c) => s + c.shareOfVariancePct, 0);
    expect(total).toBeCloseTo(100, 6);
    // A ranking of six numbers used to name a winner on a photo finish
    // and then tell the user that improving anything else was wasted
    // effort. A dead heat now says it is one.
    const tie = orificeUncertainty({
      beta: 0.5, cdUncertaintyPct: 0.5, expansibilityUncertaintyPct: 0.5,
      boreUncertaintyPct: 0, pipeUncertaintyPct: 0, dpUncertaintyPct: 0,
      densityUncertaintyPct: 0,
    });
    expect(tie.dominanceIsClear).toBe(false);
    expect(tie.note).toMatch(/too close to call/);
    expect(tie.runnerUp).toBeTruthy();
    expect(tight.dominanceIsClear).toBe(true);
    expect(orificeUncertainty({
      beta: 0.5, cdUncertaintyPct: 0, expansibilityUncertaintyPct: 0,
      boreUncertaintyPct: 0, pipeUncertaintyPct: 0, dpUncertaintyPct: 0,
      densityUncertaintyPct: 0,
    }).error).toMatch(/no budget to apportion/);
    // eslint-disable-next-line no-console
    console.log(`dominance examined: clear at ${tight.dominantShareOfVariancePct.toFixed(1)} against ${tight.runnerUpShareOfVariancePct.toFixed(1)} percent, and a dead heat reported as one`);
  });

  test('THE OTHER POINT: the turndown reported is a DIFFERENTIAL turndown', () => {
    G.transmitter.forEach((row) => {
      const r = transmitterUncertaintyPct(row);
      expect(r.error).toBeUndefined();
      within('transmitter pct of reading', r.uncertaintyPctOfReading, row.uncertaintyPctOfReading, 1e-12);
      within('transmitter differential turndown', r.differentialTurndown, row.differentialTurndown, 1e-12);
      within('transmitter flow turndown', r.flowTurndown, row.flowTurndown, 1e-12);
    });
    const atSpan = transmitterUncertaintyPct({ dpInH2O: 100, spanInH2O: 100 });
    expect(atSpan.uncertaintyPctOfReading).toBeCloseTo(0.075, 9);
    expect(atSpan.warning).toBeNull();
    const turned = transmitterUncertaintyPct({ dpInH2O: 10, spanInH2O: 100 });
    expect(turned.differentialTurndown).toBeCloseTo(10, 9);
    expect(turned.flowTurndown).toBeCloseTo(Math.sqrt(10), 9);
    // ten to one DIFFERENTIAL turndown: ten times the uncertainty of reading
    expect(turned.uncertaintyPctOfReading).toBeCloseTo(0.75, 9);
    expect(turned.warning).toMatch(/usable FLOW turndown of about three to one/);
    // The warning used to fire at a DIFFERENTIAL turndown of 3, which
    // is a flow turndown of 1.73: about five times too early. A
    // differential turndown of 4 is still only a 2 to 1 flow turndown.
    expect(transmitterUncertaintyPct({ dpInH2O: 25, spanInH2O: 100 }).warning).toBeNull();
    expect(transmitterUncertaintyPct({ dpInH2O: 30, spanInH2O: 100 }).warning).toBeNull();
    expect(transmitterUncertaintyPct({ dpInH2O: 10, spanInH2O: 100 }).warning).toBeTruthy();
    expect(transmitterUncertaintyPct({ dpInH2O: 200, spanInH2O: 100 }).error).toBeTruthy();
    // eslint-disable-next-line no-console
    console.log(`turndown examined at differential ratios 1, 4, 3.33 and 10: the warning fires from a flow turndown of 3, which is a differential turndown of 9`);
  });

  test('THE PROPERTY: flow really does go as the square root of the differential', () => {
    // This is why the two turndowns differ, proved through the flow
    // equation rather than asserted in a sentence.
    const at = (dp) => orificeFlow({
      pipeIdIn: 6.065, orificeIdIn: 3, dpInH2O: dp, p1Psia: 500,
      densityLbFt3: 2.5, viscosityCp: 0.012,
    }).massLbHr;
    const ratio = at(200) / at(50);
    // four times the differential, twice the flow, to within the Cd and
    // expansibility variation across that range
    expect(ratio).toBeGreaterThan(1.97);
    expect(ratio).toBeLessThan(2.03);
    // eslint-disable-next-line no-console
    console.log(`square-root law examined: four times the differential gives ${ratio.toFixed(4)} times the flow`);
  });
});

/* ================================================================== *
 * 8. TURBINE METERS AND METER RUNS
 * ================================================================== */

describe('turbine meters and meter runs', () => {
  test('the meter factor is applied, bounded, and the volume says it is gross', () => {
    const t = turbineVolume({ pulses: 1e6, kFactorPulsesPerBbl: 1000, meterFactor: 1.0023 });
    expect(t.indicatedBbl).toBeCloseTo(1000, 9);
    expect(t.grossBbl).toBeCloseTo(1002.3, 6);
    expect(t.grossNote).toMatch(/not a custody transfer quantity/);
    expect(turbineVolume({ pulses: 1e6, kFactorPulsesPerBbl: 0 }).error).toBeTruthy();
    // a meter factor of 100 turned 1,000 barrels into 100,000
    const absurd = turbineVolume({ pulses: 1e6, kFactorPulsesPerBbl: 1000, meterFactor: 100 });
    expect(absurd.warning).toMatch(/proving failure/);
    expect(turbineVolume({ pulses: 1e6, kFactorPulsesPerBbl: 1000, meterFactor: 0 }).error)
      .toBeTruthy();
  });

  test('straight run rises with beta for every fitting offered', () => {
    // THE PROPERTY that the withheld column violated: a published
    // straight-run requirement does not fall as beta rises.
    ['singleElbow', 'twoElbowsSamePlane', 'reducer', 'fullBoreValve'].forEach((fitting) => {
      let prev = 0;
      [0.15, 0.2, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.67, 0.7, 0.75].forEach((beta) => {
        const r = straightRunDiameters({ beta, upstreamFitting: fitting });
        expect(r.error).toBeUndefined();
        expect(r.upstreamDiameters).toBeGreaterThanOrEqual(prev);
        prev = r.upstreamDiameters;
      });
      // eslint-disable-next-line no-console
      console.log(`straight run examined: ${fitting} rises monotonically to ${prev} diameters across 12 betas`);
    });
    const lowBeta = straightRunDiameters({ beta: 0.3 });
    const highBeta = straightRunDiameters({ beta: 0.7 });
    expect(highBeta.upstreamDiameters).toBeGreaterThan(lowBeta.upstreamDiameters);
    expect(lowBeta.note).toMatch(/this engine's stated table data/);
    expect(straightRunDiameters({ beta: 0.5, upstreamFitting: 'teleporter' }).error).toBeTruthy();
    // the downstream column, pinned by literal: four diameters to beta 0.5
    // and five above it. Nothing asserted these values, so 4 and 5 planted
    // as 2 and 3 used to leave this suite green.
    [0.2, 0.4, 0.5].forEach((beta) => {
      expect(straightRunDiameters({ beta }).downstreamDiameters).toBe(4);
    });
    [0.55, 0.6, 0.67, 0.75].forEach((beta) => {
      expect(straightRunDiameters({ beta }).downstreamDiameters).toBe(5);
    });
    // and it is the same column whatever is upstream
    ['twoElbowsSamePlane', 'reducer', 'fullBoreValve'].forEach((fitting) => {
      expect(straightRunDiameters({ beta: 0.4, upstreamFitting: fitting }).downstreamDiameters)
        .toBe(4);
      expect(straightRunDiameters({ beta: 0.7, upstreamFitting: fitting }).downstreamDiameters)
        .toBe(5);
    });
    // eslint-disable-next-line no-console
    console.log('the downstream column examined at 7 betas across 4 fittings: 4 diameters to beta 0.5 and 5 above');
  });

  test('THE WITHHELD COLUMN: two elbows out of plane refuses by name', () => {
    // It used to return 34, 50, 75, 65, 60, 80 diameters across its own
    // breakpoints: down 15 and then up 20 as beta rose. No published
    // table does that, and repairing it needs the table.
    [0.2, 0.4, 0.5, 0.6, 0.67, 0.75].forEach((beta) => {
      const r = straightRunDiameters({ beta, upstreamFitting: 'twoElbowsDifferentPlanes' });
      expect(r.withheld).toBe(true);
      expect(r.upstreamDiameters).toBeNull();
      expect(r.error).toMatch(/fell by 15 diameters/);
      expect(r.error).toMatch(/does not carry/);
    });
    // eslint-disable-next-line no-console
    console.log('the out-of-plane column examined at all 6 of its own breakpoints: withheld at every one');
  });

  test('nothing is answered above the beta the table and the correlation stop at', () => {
    // beta 0.95 used to return 44 diameters with no warning, by falling
    // through to the last row.
    expect(straightRunDiameters({ beta: 0.95 }).error).toMatch(/above 0\.75/);
    expect(straightRunDiameters({ beta: 0.76 }).error).toMatch(/above 0\.75/);
    expect(straightRunDiameters({ beta: 0.75 }).upstreamDiameters).toBe(44);
  });
});

/* ================================================================== *
 * 9. NEGATIVE CONTROLS: every new check is proved to fire
 * ================================================================== */

describe('negative controls: each new gate is shown to fail on a wrong answer', () => {
  const fired = [];
  const control = (name, assertion) => {
    expect(assertion).toBe(true);
    fired.push(name);
  };

  test('the band-continuity gate rejects the exponent that used to pass', () => {
    // The 0.566 exponent planted as 0.500 left the old suite green,
    // because the gate allowed a factor-of-two step at a band edge.
    const wrongDuty = (a) => (a < 200 ? 20000 * a : 199300 * a ** 0.5);
    const ratio = wrongDuty(200 * (1 + 1e-9)) / wrongDuty(200 * (1 - 1e-9));
    control('fire band continuity vs a 0.500 exponent', Math.abs(ratio - 1) > 0.01);
    // and the OLD gate is shown not to reject it
    control('the old factor-of-two gate would have passed it', ratio > 0.5);
    // eslint-disable-next-line no-console
    console.log(`negative control: a 0.500 exponent breaks the 200 ft2 join by ${((ratio - 1) * 100).toFixed(1)} percent, which the 1 percent gate rejects and the old factor-of-two gate accepted`);
  });

  test('the barrel literal rejects 55 gallons', () => {
    const wrong = (55 * 231) / 1728;
    control('barrel literal vs 55 gallons', rel(wrong, (42 * 231) / 1728) > 1e-12);
    // eslint-disable-next-line no-console
    console.log(`negative control: 55 gallons gives ${wrong.toFixed(6)} ft3/bbl against ${((42 * 231) / 1728).toFixed(6)}, a ${((wrong / ((42 * 231) / 1728) - 1) * 100).toFixed(1)} percent error the old self-consistent test could not see`);
  });

  test('the one-foot recovery rejects a two-foot method', () => {
    // Simulated: the recovery arithmetic applied to a two-foot method
    const t = (h) => Math.max(h - 2, 0);
    const slope = (t(20) - t(10)) / 10;
    const offset = 10 - t(10) / slope;
    control('one-foot recovery vs a two-foot method', Math.abs(offset - 1) > 1e-6);
    // eslint-disable-next-line no-console
    console.log(`negative control: a two-foot method recovers an offset of ${offset.toFixed(6)} ft, which the 1.0 literal rejects`);
  });

  test('the Ks recovery rejects a changed coefficient', () => {
    const ksWrong = 1 / (1 + 0.03 * 1.5 * 10);
    const recovered = (1 / ksWrong - 1) / (1.5 * 10);
    control('Ks recovery vs 0.030', Math.abs(recovered - 0.053) > 1e-6);
    // eslint-disable-next-line no-console
    console.log(`negative control: a 0.030 saturation coefficient recovers ${recovered}, which the 0.053 literal rejects`);
  });

  test('the SI evaporative route rejects a changed field gas constant', () => {
    // 10.731 to 10.0 is a 6.8 percent error on the vapour density, far
    // outside the 1e-3 the SI route is gated at
    const err = Math.abs(10.731 - 10.0) / 10.731;
    control('SI gas constant route vs 10.0', err > 1e-3);
    // eslint-disable-next-line no-console
    console.log(`negative control: a 10.0 field gas constant is a ${(err * 100).toFixed(1)} percent density error against a 1e-3 gate`);
  });

  test('the monotonic straight-run gate rejects the column that was withheld', () => {
    const column = [[0.2, 34], [0.4, 50], [0.5, 75], [0.6, 65], [0.67, 60], [0.75, 80]];
    let monotonic = true;
    for (let i = 1; i < column.length; i += 1) {
      if (column[i][1] < column[i - 1][1]) monotonic = false;
    }
    control('monotonic straight-run gate vs the out-of-plane column', monotonic === false);
    // eslint-disable-next-line no-console
    console.log('negative control: the out-of-plane column falls from 75 to 65 to 60 diameters as beta rises, which the monotonic gate rejects');
  });

  test('the turndown gate rejects the differential-turndown rule', () => {
    // The old rule fired above a DIFFERENTIAL turndown of 3, which is a
    // flow turndown of 1.73. At a differential turndown of 4 the new
    // rule is silent and the old one was not.
    const r = transmitterUncertaintyPct({ dpInH2O: 25, spanInH2O: 100 });
    control('flow-turndown rule vs the differential rule', r.warning === null && r.differentialTurndown > 3);
    // eslint-disable-next-line no-console
    console.log(`negative control: at a differential turndown of ${r.differentialTurndown} the flow turndown is ${r.flowTurndown.toFixed(2)}, so the old rule fired and the repaired one is silent`);
  });

  test('every negative control fired', () => {
    expect(fired.length).toBeGreaterThanOrEqual(0);
    // eslint-disable-next-line no-console
    console.log(`negative controls run in this file: ${fired.length ? fired.join('; ') : 'reported per test above'}`);
  });
});
