// Production P7 gas-well engine gates: the derivations the constants
// must reproduce, the physics the correlations have to satisfy, the
// refusals, and agreement with the independent stdlib oracle
// (tools/validation/production/oracle_gaswell.py) through its committed
// goldens.
//
// The oracle works entirely in SI -- newtons per metre, kilograms per
// cubic metre, pascals -- with no gc anywhere, and converts only at the
// boundary. This module works in field units throughout. Agreement is
// therefore two unit systems meeting, which is the strongest thing a
// correlation full of remembered constants can be checked against.

import fs from 'fs';
import path from 'path';
import {
  P_STANDARD_PSIA, T_STANDARD_R, GC, DEFAULT_DRAG_COEFFICIENT,
  DEFAULT_CRITICAL_WEBER, DYNE_CM_TO_LBF_FT, TURNER_FLUIDS, turnerFluid,
  AIR_MW, gasDensityLbFt3, terminalDropletVelocity, LOADING_ADJUSTMENT,
  COLEMAN_PRESSURE_LIMIT_PSIA, criticalVelocity, RATE_CONSTANT_MSCFD,
  rateAtVelocity, velocityAtRate, tubingAreaFt2, loadingAt, loadingProfile,
  recommendCorrelation, sizeTubingForRate,
} from '../engines/production/gasWellLoading';
import {
  FT3_PER_BBL, PSI_PER_FT_SG, TYPICAL, tubingAreaIn2, slugVolumeBbl,
  slugLengthForBbl, liftPressure, gasPerCycleScf, cycleTime,
  RULE_OF_THUMB_SCF_PER_BBL_PER_1000FT, ruleOfThumbGlr, screenPlungerLift,
  maxSlugLengthFt,
} from '../engines/production/plungerLift';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'gaswell_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('the Turner constant is derived, not remembered', () => {
  test('the droplet balance produces 1.593 from Cd, We and gc alone', () => {
    // Drag = weight - buoyancy, with the largest stable droplet set by
    // the critical Weber number. Nothing else goes in.
    const t = terminalDropletVelocity({
      sigmaDyneCm: 1, rhoLiquidLbFt3: 2, rhoGasLbFt3: 1,
    });
    expect(rel(t.constant, 1.593)).toBeLessThan(1e-3);
    // The oracle derives the same constant in SI, where no gc appears
    // at all. The two agree to within a part in a million, which is
    // the rounding in the field-unit conversions this side carries
    // (gc as 32.174 and dyne/cm to lbf/ft), not a difference in physics.
    expect(rel(t.constant, G.constants.turnerConstant)).toBeLessThan(1e-5);
  });

  test('the constant moves with the drag coefficient and the Weber number', () => {
    // If it did not, it would not be a derivation.
    const base = terminalDropletVelocity({ sigmaDyneCm: 1, rhoLiquidLbFt3: 2, rhoGasLbFt3: 1 });
    const softer = terminalDropletVelocity({
      sigmaDyneCm: 1, rhoLiquidLbFt3: 2, rhoGasLbFt3: 1, dragCoefficient: 0.88,
    });
    // v goes as Cd^(-1/4)
    expect(rel(softer.constant, base.constant * Math.pow(0.5, 0.25))).toBeLessThan(1e-12);
    const tougher = terminalDropletVelocity({
      sigmaDyneCm: 1, rhoLiquidLbFt3: 2, rhoGasLbFt3: 1, criticalWeber: 60,
    });
    expect(rel(tougher.constant, base.constant * Math.pow(2, 0.25))).toBeLessThan(1e-12);
    expect(DEFAULT_DRAG_COEFFICIENT).toBe(0.44);
    expect(DEFAULT_CRITICAL_WEBER).toBe(30);
    expect(GC).toBeCloseTo(32.174, 6);
    expect(DYNE_CM_TO_LBF_FT).toBeGreaterThan(0);
  });

  test('the velocity is a power law in the three groups it should be', () => {
    const v = (s, dl, rg) => terminalDropletVelocity({
      sigmaDyneCm: s, rhoLiquidLbFt3: rg + dl, rhoGasLbFt3: rg,
    }).velocityFtS;
    // quarter power in tension and in the density difference
    expect(rel(v(16, 60, 3), v(1, 60, 3) * 2)).toBeLessThan(1e-12);
    expect(rel(v(60, 16, 3), v(60, 1, 3) * 2)).toBeLessThan(1e-12);
    // inverse square root in gas density
    expect(rel(v(60, 60, 4), v(60, 60, 1) / 2)).toBeLessThan(1e-12);
  });

  test('an impossible droplet gets no velocity rather than a number', () => {
    expect(terminalDropletVelocity({ sigmaDyneCm: 60, rhoLiquidLbFt3: 2, rhoGasLbFt3: 5 }).ok)
      .toBe(false);
    expect(terminalDropletVelocity({ sigmaDyneCm: 0, rhoLiquidLbFt3: 67, rhoGasLbFt3: 3 }).ok)
      .toBe(false);
  });
});

describe('gas density and the rate constant', () => {
  test('real-gas density matches the SI oracle', () => {
    const rho = gasDensityLbFt3({ pPsia: 1000, tempR: 600, z: 0.88, gasSg: 0.65 });
    expect(rel(rho, G.constants.gasDensity_1000psia_600R_z088_sg065)).toBeLessThan(1e-4);
    expect(AIR_MW).toBeCloseTo(28.9647, 4);
    // linear in pressure, inverse in temperature and z
    expect(rel(gasDensityLbFt3({ pPsia: 2000, tempR: 600, z: 0.88, gasSg: 0.65 }), rho * 2))
      .toBeLessThan(1e-12);
    expect(gasDensityLbFt3({ pPsia: 1000, tempR: 0, z: 0.88, gasSg: 0.65 })).toBeNaN();
  });

  test('the rate constant is derived and equals the 3.06 the texts print', () => {
    expect(rel(RATE_CONSTANT_MSCFD / 1000, 3.06)).toBeLessThan(2e-3);
    expect(rel(RATE_CONSTANT_MSCFD, G.constants.rateConstantMscfd)).toBeLessThan(1e-9);
    expect(P_STANDARD_PSIA).toBe(14.7);
    expect(T_STANDARD_R).toBeCloseTo(519.67, 6);
  });

  test('rate and velocity are exact inverses of each other', () => {
    const args = { areaFt2: tubingAreaFt2(2.441), pPsia: 900, tempR: 580, z: 0.9 };
    const q = rateAtVelocity({ velocityFtS: 12, ...args });
    expect(rel(velocityAtRate({ qMscfd: q, ...args }), 12)).toBeLessThan(1e-12);
  });

  test('tubing area comes from the diameter', () => {
    expect(tubingAreaFt2(2.441)).toBeCloseTo((Math.PI * 2.441 ** 2) / (4 * 144), 12);
    expect(rel(tubingAreaFt2(4.882), tubingAreaFt2(2.441) * 4)).toBeLessThan(1e-12);
  });
});

describe('Turner and Coleman are one equation and one factor', () => {
  test('they differ by exactly the adjustment', () => {
    const args = {
      sigmaDyneCm: 60, rhoLiquidLbFt3: 67, pPsia: 1200, tempR: 600, z: 0.9, gasSg: 0.65,
    };
    const t = criticalVelocity({ correlation: 'turner', ...args });
    const c = criticalVelocity({ correlation: 'coleman', ...args });
    expect(rel(t.velocityFtS, c.velocityFtS * 1.2)).toBeLessThan(1e-12);
    expect(rel(t.terminalFtS, c.terminalFtS)).toBeLessThan(1e-12);
    expect(LOADING_ADJUSTMENT.turner).toBe(1.2);
    expect(LOADING_ADJUSTMENT.coleman).toBe(1);
  });

  test('an unknown correlation is refused rather than treated as one of them', () => {
    const r = criticalVelocity({
      correlation: 'guess', sigmaDyneCm: 60, rhoLiquidLbFt3: 67,
      pPsia: 1000, tempR: 600, z: 0.9, gasSg: 0.65,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/turner or coleman/);
  });

  test('the whole oracle velocity table, water and condensate', () => {
    G.velocity.forEach((row) => {
      const v = criticalVelocity({
        correlation: 'turner',
        sigmaDyneCm: row.sigmaDyneCm,
        rhoLiquidLbFt3: row.rhoLiquidLbFt3,
        pPsia: row.pPsia,
        tempR: row.tempR,
        z: row.z,
        gasSg: row.gasSg,
      });
      expect(rel(v.rhoGasLbFt3, row.rhoGasLbFt3)).toBeLessThan(1e-4);
      expect(rel(v.terminalFtS, row.terminalFtS)).toBeLessThan(1e-4);
      expect(rel(v.velocityFtS, row.turnerFtS)).toBeLessThan(1e-4);
      const q = rateAtVelocity({
        velocityFtS: v.velocityFtS, areaFt2: tubingAreaFt2(2.441),
        pPsia: row.pPsia, tempR: row.tempR, z: row.z,
      });
      expect(rel(q, row.criticalRateTurnerMscfd)).toBeLessThan(1e-4);
    });
  });

  test('condensate loads a well at a lower rate than water does', () => {
    // Condensate has about a third the interfacial tension and a lower
    // density, so its droplets are easier to carry. A well making
    // condensate can therefore run slower before it loads, and getting
    // this backwards would flag healthy wells.
    const args = { pPsia: 800, tempR: 580, z: 0.9, gasSg: 0.65, idIn: 2.441, qMscfd: 500 };
    const water = loadingAt({ correlation: 'turner', ...turnerFluidArgs('water'), ...args });
    const cond = loadingAt({ correlation: 'turner', ...turnerFluidArgs('condensate'), ...args });
    expect(cond.criticalRateMscfd).toBeLessThan(water.criticalRateMscfd);
    expect(TURNER_FLUIDS).toHaveLength(2);
    expect(turnerFluid('nonsense').id).toBe('water');
  });

  function turnerFluidArgs(id) {
    const f = turnerFluid(id);
    return { sigmaDyneCm: f.sigmaDyneCm, rhoLiquidLbFt3: f.densityLbFt3 };
  }

  test('the correlation guidance follows the pressure ranges they were fitted on', () => {
    expect(recommendCorrelation(400).correlation).toBe('coleman');
    expect(recommendCorrelation(2500).correlation).toBe('turner');
    expect(recommendCorrelation(400).reason).toMatch(/low-pressure/);
    expect(COLEMAN_PRESSURE_LIMIT_PSIA).toBe(1000);
  });
});

describe('the loading profile down the string', () => {
  const stations = [
    { depthFt: 0, pPsia: 400, tempR: 540, z: 0.94, idIn: 2.441 },
    { depthFt: 3000, pPsia: 700, tempR: 570, z: 0.91, idIn: 2.441 },
    { depthFt: 6000, pPsia: 1100, tempR: 600, z: 0.89, idIn: 2.441 },
  ];
  const args = {
    correlation: 'turner', sigmaDyneCm: 60, rhoLiquidLbFt3: 67, gasSg: 0.65,
  };

  test('the critical rate rises with depth, so the SHOE controls', () => {
    // This is the part that is commonly got wrong. Critical rate goes
    // as roughly the square root of pressure, so it is highest at the
    // bottom: a well can be comfortably above it at the wellhead and
    // loading at the shoe, which is where liquid actually collects.
    const p = loadingProfile({ stations, qMscfd: 900, ...args });
    expect(p.ok).toBe(true);
    expect(p.points[2].criticalRateMscfd).toBeGreaterThan(p.points[0].criticalRateMscfd);
    expect(p.controlling.depthFt).toBe(6000);
  });

  test('a well can pass at the wellhead and still be loading', () => {
    // Critical rate runs 1,008 Mscf/d at the wellhead and 1,615 at the
    // shoe on this string, so 1,200 sits between them: comfortably
    // unloaded where the operator can see it, loading where the liquid
    // actually collects.
    const p = loadingProfile({ stations, qMscfd: 1200, ...args });
    const wellhead = p.points[0];
    expect(wellhead.ratio).toBeGreaterThan(1);      // fine at the top
    expect(p.controlling.ratio).toBeLessThan(1);    // loading at the bottom
    expect(p.loaded).toBe(true);
    expect(p.marginPct).toBeLessThan(0);
  });

  test('a well above the controlling rate everywhere is not loaded', () => {
    const p = loadingProfile({ stations, qMscfd: 4000, ...args });
    expect(p.loaded).toBe(false);
    expect(p.marginPct).toBeGreaterThan(0);
    p.points.forEach((x) => expect(x.ratio).toBeGreaterThan(1));
  });

  test('each profile point carries the conditions it was computed at', () => {
    // Without them the point cannot be plotted, and the controlling
    // station cannot be handed to the tubing sizing that has to be
    // evaluated there.
    const p = loadingProfile({ stations, qMscfd: 1200, ...args });
    p.points.forEach((pt, i) => {
      expect(pt.pPsia).toBe(stations[i].pPsia);
      expect(pt.tempR).toBe(stations[i].tempR);
      expect(pt.z).toBe(stations[i].z);
      expect(pt.idIn).toBe(stations[i].idIn);
    });
    expect(p.controlling.pPsia).toBe(1100);
  });

  test('an empty traverse is refused, not treated as a passing well', () => {
    expect(loadingProfile({ stations: [], qMscfd: 900, ...args }).ok).toBe(false);
    expect(loadingProfile({ stations: [], qMscfd: 900, ...args }).error)
      .toMatch(/at least one station/);
  });

  test('smaller tubing unloads at a lower rate, and sizing finds the largest that works', () => {
    // Velocity goes as 1/A, so a smaller string lifts liquid at a
    // lower rate. This is the commonest and cheapest fix for a loading
    // well, and the reason it works has to come out of the arithmetic.
    const sized = sizeTubingForRate({
      candidatesIdIn: [3.958, 2.992, 2.441, 1.995, 1.61],
      qMscfd: 750, pPsia: 1100, tempR: 600, z: 0.89, ...args,
    });
    const rates = sized.rows.map((r) => r.criticalRateMscfd);
    for (let i = 1; i < rates.length; i += 1) expect(rates[i]).toBeLessThan(rates[i - 1]);
    expect(sized.largestUnloaded).not.toBeNull();
    expect(sized.largestUnloaded.ratio).toBeGreaterThanOrEqual(1);
    // and a rate nothing can carry returns nothing rather than the least bad
    const hopeless = sizeTubingForRate({
      candidatesIdIn: [3.958, 2.441], qMscfd: 1, pPsia: 1100, tempR: 600, z: 0.89, ...args,
    });
    expect(hopeless.largestUnloaded).toBeNull();
  });
});

describe('plunger lift: the force balance', () => {
  const base = {
    depthFt: 6000, idIn: 2.441, linePressurePsia: 120, casingPressurePsia: 600,
    slugLengthFt: 200, liquidSg: 1.02, plungerWeightLb: 6, gasSg: 0.65,
    avgTempR: 580, z: 0.9,
  };

  test('the lift pressure matches the SI oracle, term by term', () => {
    const lift = liftPressure(base);
    const o = G.plunger;
    // The slug term carries the platform's rounded 0.433 psi/ft
    // constant where the oracle uses rho g exactly, which is a tenth of
    // a percent apart and is the only place the two disagree at all.
    expect(rel(lift.terms.slugPsi, o.slugPsi)).toBeLessThan(5e-3);
    expect(rel(lift.terms.plungerPsi, o.plungerPsi)).toBeLessThan(1e-3);
    expect(rel(lift.terms.gasColumnPsi, o.gasColumnPsi)).toBeLessThan(1e-3);
    expect(rel(lift.requiredPsia, o.requiredPsia)).toBeLessThan(3e-3);
    expect(PSI_PER_FT_SG).toBe(0.433);
  });

  test('every term is what it says it is', () => {
    const lift = liftPressure(base);
    expect(lift.terms.slugPsi).toBeCloseTo(0.433 * 1.02 * 200, 9);
    expect(lift.terms.plungerPsi).toBeCloseTo(6 / tubingAreaIn2(2.441), 9);
    expect(lift.terms.linePressurePsia).toBe(120);
    // and they sum to the requirement
    const sum = Object.values(lift.terms).reduce((a, v) => a + v, 0);
    expect(rel(lift.requiredPsia, sum)).toBeLessThan(1e-12);
  });

  test('friction is an input, and it moves the answer', () => {
    const withFriction = liftPressure({ ...base, frictionPsi: 40 });
    expect(withFriction.requiredPsia).toBeCloseTo(liftPressure(base).requiredPsia + 40, 9);
    expect(TYPICAL.frictionPsi).toBe(0);
  });

  test('a longer slug needs more pressure, and there is a longest one', () => {
    const short = liftPressure({ ...base, slugLengthFt: 100 }).requiredPsia;
    const long = liftPressure({ ...base, slugLengthFt: 400 }).requiredPsia;
    expect(long).toBeGreaterThan(short);
    const max = maxSlugLengthFt(base);
    // At the maximum slug, the available casing pressure is exactly used up.
    const atMax = liftPressure({ ...base, slugLengthFt: max });
    expect(rel(atMax.requiredPsia, base.casingPressurePsia)).toBeLessThan(1e-6);
    expect(max).toBeLessThanOrEqual(base.depthFt);
  });
});

describe('plunger lift: gas, cycle and feasibility', () => {
  const base = {
    depthFt: 6000, idIn: 2.441, linePressurePsia: 120, casingPressurePsia: 600,
    slugLengthFt: 200, liquidSg: 1.02, plungerWeightLb: 6, gasSg: 0.65,
    avgTempR: 580, z: 0.9, wellGlrScfBbl: 12000, afterflowMin: 20, shutInMin: 35,
  };

  test('slug volume and length are inverses', () => {
    const bbl = slugVolumeBbl({ slugLengthFt: 200, idIn: 2.441 });
    expect(rel(slugLengthForBbl({ bbl, idIn: 2.441 }), 200)).toBeLessThan(1e-12);
    expect(FT3_PER_BBL).toBeCloseTo(5.614583, 6);
  });

  test('the gas a cycle needs matches the oracle', () => {
    const o = G.plunger;
    const scf = gasPerCycleScf({
      depthFt: 6000, idIn: 2.441, pStartPsia: 600, pEndPsia: o.requiredPsia,
      avgTempR: 580, z: 0.9,
    });
    expect(rel(scf, o.gasPerCycleScf)).toBeLessThan(1e-6);
  });

  test('the cycle adds up and turns into trips a day', () => {
    const t = cycleTime({
      depthFt: 6000, riseFtMin: 750, fallInGasFtMin: 1000, fallInLiquidFtMin: 172,
      liquidColumnFt: 200, afterflowMin: 20, shutInMin: 35,
    });
    expect(t.riseMin).toBeCloseTo(8, 9);
    expect(rel(t.totalMin, t.riseMin + t.fallMin + 20 + 35)).toBeLessThan(1e-12);
    expect(rel(t.cyclesPerDay, 1440 / t.totalMin)).toBeLessThan(1e-12);
  });

  test('feasibility rests on the COMPUTED gas-liquid ratio, not the rule of thumb', () => {
    const r = screenPlungerLift(base);
    expect(r.ok).toBe(true);
    const d = r.design;
    expect(rel(d.requiredGlrScfBbl, G.plunger.requiredGlrScfBbl)).toBeLessThan(5e-3);
    expect(d.feasible).toBe(true);
    // The heuristic is reported alongside and is a different number.
    expect(d.ruleOfThumbGlrScfBbl).toBeCloseTo(400 * 6, 9);
    expect(d.ruleOfThumbGlrScfBbl).not.toBeCloseTo(d.requiredGlrScfBbl, 0);
    expect(RULE_OF_THUMB_SCF_PER_BBL_PER_1000FT).toBe(400);
    expect(ruleOfThumbGlr({ depthFt: 6000, scfPerBblPer1000ft: 500 })).toBeCloseTo(3000, 9);
  });

  test('a well that cannot build the pressure is told so, in pressure terms', () => {
    const r = screenPlungerLift({ ...base, casingPressurePsia: 180 });
    expect(r.design.pressureOk).toBe(false);
    expect(r.design.feasible).toBe(false);
    expect(r.design.warnings.map((w) => w.code)).toContain('insufficientPressure');
    expect(r.design.warnings[0].message).toMatch(/psia is needed/);
  });

  test('a well without the gas to drive it is told so, in gas terms', () => {
    const r = screenPlungerLift({ ...base, wellGlrScfBbl: 500 });
    expect(r.design.glrOk).toBe(false);
    expect(r.design.feasible).toBe(false);
    expect(r.design.warnings.map((w) => w.code)).toContain('insufficientGas');
  });

  test('the rule of thumb can disagree with the physics, and that is reported', () => {
    // A well between the two numbers is exactly where a screening
    // heuristic misleads, so whether they agree is surfaced rather than
    // hidden.
    const r = screenPlungerLift({ ...base, wellGlrScfBbl: 3000 });
    expect(r.design.wellGlrScfBbl).toBeGreaterThan(r.design.ruleOfThumbGlrScfBbl);
    expect(r.design.glrOk).toBe(false);      // the physics says no
    expect(r.design.ruleOfThumbAgrees).toBe(false);
  });

  test('an impossible installation is refused with reasons, not screened', () => {
    expect(screenPlungerLift({ ...base, depthFt: 0 }).ok).toBe(false);
    expect(screenPlungerLift({ ...base, slugLengthFt: 9000 }).errors.join(' '))
      .toMatch(/longer than the tubing/);
    expect(screenPlungerLift({ ...base, plungerWeightLb: 0 }).errors.join(' '))
      .toMatch(/needs a weight/);
  });
});

// slowCycle fires when the well makes fewer than one trip a day, which is a
// cycle longer than 1440 minutes, and then prints the cycle time. At whole
// minutes a 1440.3 minute cycle read "At 1440 minutes a cycle this well
// would make fewer than one trip a day", which contradicts itself for any
// reader who knows how long a day is. One decimal narrows the collision to
// the 0.05 above 1440 rather than closing it.
describe('the slow-cycle warning prints a cycle that is not exactly a day', () => {
  test('a cycle just over a day does not print as exactly a day', () => {
    const well = {
      depthFt: 8000, idIn: 2.441, linePressurePsia: 100, casingPressurePsia: 900,
      slugLengthFt: 300, liquidSg: 1.0, plungerWeightLb: 10, gasSg: 0.65,
      avgTempR: 580, z: 0.9, wellGlrScfBbl: 100000,
      riseFtMin: 750, fallInGasFtMin: 1000, fallInLiquidFtMin: 200, afterflowMin: 0,
    };
    // the rise and the fall are fixed by the well, so the shut-in places the
    // cycle where the band is wanted
    const moving = cycleTime({
      depthFt: well.depthFt, riseFtMin: well.riseFtMin,
      fallInGasFtMin: well.fallInGasFtMin, fallInLiquidFtMin: well.fallInLiquidFtMin,
      liquidColumnFt: well.slugLengthFt,
    });
    const r = screenPlungerLift({ ...well, shutInMin: 1440.3 - moving.totalMin });
    expect(r.ok).toBe(true);
    expect(r.design.timing.cyclesPerDay).toBeLessThan(1);
    expect(r.design.timing.totalMin).toBeGreaterThan(1440.05);
    expect(r.design.timing.totalMin).toBeLessThan(1440.5);
    const w = r.design.warnings.find((x) => x.code === 'slowCycle');
    expect(w).toBeDefined();
    expect(w.message).toMatch(/At 1440\.3 minutes a cycle/);
    expect(w.message).not.toMatch(/\b1440 minutes\b/);
  });
});

// The same defect as PR #113, in its second spelling. That sweep was
// grepped on `toFixed(0)`, and `Math.round` inside a message string does
// exactly the same thing, so the grep passed here because it could not see
// rather than because there was nothing to find.
//
// Two shapes appear below. `recommendCorrelation` prints the value it
// branched on: the branch is a strict comparison against 1000 psia, and a
// well at 999.62 read "At 1000 psia wellhead this well sits inside the
// low-pressure range" under a branch that only takes wells BELOW 1000. The
// two plunger-lift warnings CONTRAST two quantities in one sentence, and
// rounding whole can collapse the contrast so that one number is said to
// fall short of another it prints as equal to. One decimal narrows both
// collisions by ten rather than closing them: a value inside 0.05 of the
// threshold, or a pair inside 0.05 of each other, still renders the same.
describe('the second spelling of the defect: Math.round inside a message', () => {
  test('a wellhead just under the Coleman limit does not print as the limit', () => {
    // 0.38 psi under, which is where a real PD5 well sits, and the choice
    // of correlation it decides is worth 20 percent of every critical rate
    // computed after it.
    const p = COLEMAN_PRESSURE_LIMIT_PSIA - 0.38;
    const r = recommendCorrelation(p);
    expect(r.correlation).toBe('coleman');
    expect(Math.round(p)).toBe(COLEMAN_PRESSURE_LIMIT_PSIA);   // what the old print gave
    expect(COLEMAN_PRESSURE_LIMIT_PSIA - p).toBeGreaterThan(0.05);
    expect(r.reason).toContain('At 999.6 psia');
    expect(r.reason).not.toMatch(/At 1000(\.0)? psia/);
  });

  test('the station in the sentence is the caller\'s, not a hardcoded wellhead', () => {
    // The function takes any station's pressure and callers hand it
    // others, so the label cannot be a fact this function asserts.
    expect(recommendCorrelation(1240.4).reason).toContain('psia wellhead this well');
    expect(recommendCorrelation(1240.4, 'at the 5,000 ft station').reason)
      .toContain('psia at the 5,000 ft station this well');
  });

  test('a casing short of the lift requirement does not print as the requirement', () => {
    const well = {
      depthFt: 8000, idIn: 2.441, linePressurePsia: 100.6, slugLengthFt: 300,
      liquidSg: 1.0, plungerWeightLb: 10, gasSg: 0.65, avgTempR: 580, z: 0.9,
    };
    const required = liftPressure(well).requiredPsia;
    const casingPressurePsia = required - 0.15;
    // the old print collapsed the two onto one number
    expect(Math.round(casingPressurePsia)).toBe(Math.round(required));
    expect(required - casingPressurePsia).toBeGreaterThan(0.05);

    const r = screenPlungerLift({
      ...well, casingPressurePsia, wellGlrScfBbl: 1e9,
      riseFtMin: 750, fallInGasFtMin: 1000, fallInLiquidFtMin: 200,
      afterflowMin: 0, shutInMin: 30,
    });
    const w = r.design.warnings.find((x) => x.code === 'insufficientPressure');
    expect(w).toBeDefined();
    expect(w.message).toContain(`builds to ${casingPressurePsia.toFixed(1)} psia`);
    expect(w.message).toContain(`but ${required.toFixed(1)} psia is needed`);
    // the two numbers in the sentence are no longer the same number
    expect(casingPressurePsia.toFixed(1)).not.toBe(required.toFixed(1));
  });

  test('a well short of the gas a cycle needs does not print as making it', () => {
    const well = {
      depthFt: 8000, idIn: 2.441, linePressurePsia: 100, casingPressurePsia: 900,
      slugLengthFt: 300, liquidSg: 1.0, plungerWeightLb: 10, gasSg: 0.65,
      avgTempR: 580, z: 0.9, riseFtMin: 750, fallInGasFtMin: 1000,
      fallInLiquidFtMin: 200, afterflowMin: 0, shutInMin: 30,
    };
    const requiredGlr = screenPlungerLift({ ...well, wellGlrScfBbl: 1e9 })
      .design.requiredGlrScfBbl;
    const wellGlrScfBbl = requiredGlr - 0.15;
    expect(Math.round(wellGlrScfBbl)).toBe(Math.round(requiredGlr));
    expect(requiredGlr - wellGlrScfBbl).toBeGreaterThan(0.05);

    const r = screenPlungerLift({ ...well, wellGlrScfBbl });
    const w = r.design.warnings.find((x) => x.code === 'insufficientGas');
    expect(w).toBeDefined();
    // built the way the message builds them, so the gate does not depend
    // on the runner's locale
    const oneDp = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
    expect(w.message).toContain(`needs ${requiredGlr.toLocaleString(undefined, oneDp)} scf`);
    expect(w.message).toContain(`makes ${wellGlrScfBbl.toLocaleString(undefined, oneDp)}`);
    expect(requiredGlr.toLocaleString(undefined, oneDp))
      .not.toBe(wellGlrScfBbl.toLocaleString(undefined, oneDp));
  });
});

// PR #114 REGRESSION: a display-only fix that was not display-only.
//
// #114 replaced `Math.round(pWellheadPsia)` with `pPsia.toFixed(1)` in the
// reason strings above, and described the change as display only. It was
// display only in INTENT. `Math.round` swallows anything, so it turned
// `undefined` into NaN and the string '900' into 900; `toFixed` is a
// method on Number, so the same values threw. Three of the four inputs
// below went from a silently wrong answer to a TypeError at a caller in a
// live Suite app, and the fourth printed "At NaN psia wellhead" as though
// NaN were a gauge reading.
//
// The rule these gates pin: a formatter is not a validator, so a change of
// format is only safe once something has checked what reaches it. Nothing
// had. Every case below must return, and must say plainly that the
// pressure could not be read rather than dressing NaN up as a measurement.
// The same guard covers plungerLift's insufficientPressure, where
// `casingPressurePsia` is not in the function's own refusal list and so
// reaches the message unvalidated too.
describe('a bad pressure is named, not crashed on and not printed as NaN', () => {
  const unusable = [
    ['undefined', undefined],
    ['null', null],
    ['a numeric string', '900'],
    ['NaN', NaN],
  ];

  test.each(unusable)('recommendCorrelation(%s) does not throw', (_label, value) => {
    expect(() => recommendCorrelation(value)).not.toThrow();
  });

  test.each(unusable)('recommendCorrelation(%s) still answers with a correlation', (_label, value) => {
    // The return SHAPE is unchanged, which is the whole point of the
    // conservative fix: a caller that read `.correlation` before still
    // reads one, so nothing downstream has to change to stop crashing.
    const r = recommendCorrelation(value);
    expect(['turner', 'coleman']).toContain(r.correlation);
    expect(typeof r.reason).toBe('string');
  });

  test.each(unusable)('recommendCorrelation(%s) says the pressure was not a number', (_label, value) => {
    const r = recommendCorrelation(value);
    expect(r.reason).toMatch(/No wellhead pressure could be read/);
    // and does not print the unreadable value as though it were one
    expect(r.reason).not.toMatch(/At NaN psia/);
    expect(r.reason).not.toMatch(/\bAt \S+ psia wellhead this well\b/);
    // nor claim the well sits anywhere relative to Coleman's range
    expect(r.reason).not.toMatch(/sits inside the low-pressure range/);
    expect(r.reason).not.toMatch(/is above the range Coleman studied/);
  });

  test('the station label reaches the unreadable message too', () => {
    expect(recommendCorrelation(undefined, 'at the 5,000 ft station').reason)
      .toMatch(/No at the 5,000 ft station pressure could be read/);
  });

  test('a real pressure reads exactly as PR #114 left it', () => {
    // The guard must not touch the one-decimal fix or the station label,
    // which are the things #114 was right about.
    const p = COLEMAN_PRESSURE_LIMIT_PSIA - 0.38;
    expect(recommendCorrelation(p).reason).toContain('At 999.6 psia wellhead this well');
    expect(recommendCorrelation(p).correlation).toBe('coleman');
    expect(recommendCorrelation(1240.4).reason)
      .toContain('At 1240.4 psia wellhead this well');
    expect(recommendCorrelation(1240.4, 'at the 5,000 ft station').reason)
      .toContain('At 1240.4 psia at the 5,000 ft station this well');
    expect(recommendCorrelation(1240.4).correlation).toBe('turner');
  });

  // The same hazard, second site. #114 turned Math.round(casingPressurePsia)
  // into casingPressurePsia.toFixed(1), and screenPlungerLift's refusal list
  // checks depth, diameter, slug, plunger weight and temperature but never
  // the casing pressure, so an undefined one walks past the gate and into
  // the formatter.
  const plungerWell = {
    depthFt: 6000, idIn: 2.441, linePressurePsia: 120, slugLengthFt: 200,
    liquidSg: 1.05, plungerWeightLb: 6, gasSg: 0.65, avgTempR: 580, z: 0.95,
    wellGlrScfBbl: 5000,
  };

  test.each([['undefined', undefined], ['null', null], ['NaN', NaN]])(
    'screenPlungerLift with a %s casing pressure does not throw', (_label, casingPressurePsia) => {
      expect(() => screenPlungerLift({ ...plungerWell, casingPressurePsia })).not.toThrow();
      const r = screenPlungerLift({ ...plungerWell, casingPressurePsia });
      const w = r.design.warnings.find((x) => x.code === 'insufficientPressure');
      expect(w).toBeDefined();
      expect(w.message).toMatch(/No casing pressure could be read/);
      expect(w.message).not.toMatch(/builds to NaN psia/);
    },
  );

  test('a real casing pressure reads exactly as PR #114 left it', () => {
    const well = {
      depthFt: 8000, idIn: 2.441, linePressurePsia: 100.6, slugLengthFt: 300,
      liquidSg: 1.0, plungerWeightLb: 10, gasSg: 0.65, avgTempR: 580, z: 0.9,
    };
    const required = liftPressure(well).requiredPsia;
    const casingPressurePsia = required - 0.15;
    const r = screenPlungerLift({
      ...well, casingPressurePsia, wellGlrScfBbl: 1e9,
      riseFtMin: 750, fallInGasFtMin: 1000, fallInLiquidFtMin: 200,
      afterflowMin: 0, shutInMin: 30,
    });
    const w = r.design.warnings.find((x) => x.code === 'insufficientPressure');
    expect(w.message).toContain(`The casing builds to ${casingPressurePsia.toFixed(1)} psia`);
    expect(w.message).toContain(`but ${required.toFixed(1)} psia is needed`);
  });
});
