// Production P6 sucker-rod engine gates: the closed forms the mechanics
// must satisfy, the static limit the wave equation has to reduce to,
// the refusals the engine makes rather than produce a number, and
// agreement with the independent stdlib oracle
// (tools/validation/production/oracle_rodpump.py) through its committed
// goldens.
//
// The oracle takes a different route at every step — a finite-element
// eigenvalue solve where the engine walks a transfer matrix, Newton
// loop closure and implicit differentiation where the engine
// intersects circles and differences numerically, a staggered
// velocity/tension RK4 march where the engine marches displacement by
// explicit central differences, and Python's own complex type where
// the engine hand-rolls complex arithmetic. Agreement here is two
// routes meeting, not code echoing itself.

import fs from 'fs';
import path from 'path';
import {
  ROD_SIZES, ROD_GRADES, PLUNGER_SIZES, COUPLING_ALLOWANCE, STEEL_SG,
  rodArea, bareRodWeightLbPerFt, parseRodSize, rodSize, rodGrade,
  rodWeightLbPerFt, steelAcousticVelocityFtS, ROD_ACOUSTIC_VELOCITY_FT_S,
} from '../engines/production/data/rodCatalog';
import {
  rodSection, buildRodString, buoyancyFactor, rodStretchIn, naturalFrequency,
  sectionWaveSpeedFtS, stringWaveSpeedFtS, designTaper,
} from '../engines/production/rodString';
import {
  predictCard, diagnoseCard, cardArea, polishedRodHp, dampingCoefficient,
  fourierCoefficients, DEFAULT_DAMPING_RATIO,
} from '../engines/production/rodDynamics';
import {
  conventionalGeometry, beamAngleAt, unitKinematics, surfacePositionFn,
  simpleHarmonicPosition, netTorque, balanceUnit, counterbalanceEffect,
  genericConventionalGeometry, parseUnitDesignation,
} from '../engines/production/pumpingUnit';
import {
  PUMP_CONSTANT, IN3_PER_BBL, displacementBpd, fluidLoadLb, sectionStresses,
  modifiedGoodman, dimensionlessGroups, runRodPumpDesign,
} from '../engines/production/rodPumpDesign';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'rodpump_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
const TAPER = [{ size: '7/8', lengthFt: 3000 }, { size: '3/4', lengthFt: 2000 }];
const taperString = () => buildRodString({ sections: TAPER, fluidSg: 1.0, gradeId: 'D' });

describe('rod sizes are read as fractions', () => {
  // The predecessor did parseFloat("7/8".replace('/', '.')) === 7.8, so
  // a 7/8 inch rod got a 47 square inch section instead of 0.6 and the
  // string could not stretch. This is the gate on that.
  test('a fraction is a fraction, not a decimal point', () => {
    expect(parseRodSize('7/8')).toBeCloseTo(0.875, 12);
    expect(parseRodSize('7/8')).not.toBeCloseTo(7.8, 6);
    expect(rodArea(parseRodSize('7/8'))).toBeCloseTo(0.60132, 4);
    expect(rodArea(7.8)).toBeGreaterThan(45);   // what the bug produced
  });

  test('mixed numbers, bare fractions and decimals all read', () => {
    expect(parseRodSize('1 1/8')).toBeCloseTo(1.125, 12);
    expect(parseRodSize('11/16')).toBeCloseTo(0.6875, 12);
    expect(parseRodSize('0.875')).toBeCloseTo(0.875, 12);
    expect(parseRodSize(0.75)).toBeCloseTo(0.75, 12);
  });

  test('an unreadable size is NaN, never a plausible number', () => {
    expect(parseRodSize('')).toBeNaN();
    expect(parseRodSize('seven eighths')).toBeNaN();
    expect(parseRodSize('7/0')).toBeNaN();
  });

  test('every catalog area comes from its diameter', () => {
    ROD_SIZES.forEach((r) => {
      expect(rodArea(r.dIn)).toBeCloseTo((Math.PI * r.dIn ** 2) / 4, 12);
    });
  });

  test('published weights all sit the same fraction above bare steel', () => {
    // Couplings and upsets are steel too, and they add a consistent
    // share across every API size. A transcription slip in the weight
    // column breaks this and nothing else would notice.
    ROD_SIZES.forEach((r) => {
      const ratio = r.weightLbPerFt / bareRodWeightLbPerFt(r.dIn);
      expect(rel(ratio, COUPLING_ALLOWANCE)).toBeLessThan(0.005);
      expect(rel(ratio, G.constants.couplingRatios[r.label])).toBeLessThan(1e-12);
    });
  });

  test('a non-API diameter is estimated and says so', () => {
    expect(rodWeightLbPerFt(0.875, '7/8').source).toBe('api');
    expect(rodWeightLbPerFt(0.6875).source).toBe('estimated');
    expect(rodSize('3/4').dIn).toBe(0.75);
    expect(rodGrade('c').minTensilePsi).toBe(90000);
    expect(rodGrade('nonsense').id).toBe('D');
    expect(ROD_GRADES).toHaveLength(3);
    expect(PLUNGER_SIZES.length).toBeGreaterThan(4);
  });
});

describe('string mechanics', () => {
  test('buoyancy is Archimedes and has no fudge factor in it', () => {
    // The predecessor used 1 - 1.2 SG / 7.85, which removes about a
    // fifth of the rod weight for no stated reason.
    expect(buoyancyFactor(1.0)).toBeCloseTo(1 - 1 / STEEL_SG, 12);
    expect(buoyancyFactor(0)).toBe(1);
    expect(buoyancyFactor(1.0)).not.toBeCloseTo(1 - (1.2 * 1.0) / 7.85, 4);
  });

  test('weight, stiffness and stretch sum over the sections', () => {
    const s = taperString();
    expect(rel(s.weightAirLb, G.strings.taper.weightAirLb)).toBeLessThan(1e-12);
    expect(rel(s.weightFluidLb, G.strings.taper.weightFluidLb)).toBeLessThan(1e-12);
    expect(rel(s.krLbPerIn, G.strings.taper.krLbPerIn)).toBeLessThan(1e-12);
    // 1/kr is the sum of the section compliances, by construction.
    const compliance = s.sections.reduce((a, sec) => a + sec.stretchPerLb, 0);
    expect(rel(1 / s.krLbPerIn, compliance)).toBeLessThan(1e-12);
    // and stretch is linear in load
    expect(rel(rodStretchIn({ string: s, loadLb: 2000 }),
      2 * rodStretchIn({ string: s, loadLb: 1000 }))).toBeLessThan(1e-12);
  });

  test('a section that cannot be read is refused, not defaulted', () => {
    expect(rodSection({ size: 'x', lengthFt: 100 }).ok).toBe(false);
    expect(rodSection({ size: '7/8', lengthFt: 0 }).ok).toBe(false);
    const bad = buildRodString({ sections: [{ size: 'x', lengthFt: 100 }] });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/could not be read/);
    expect(buildRodString({ sections: [] }).ok).toBe(false);
  });

  test('a taper that steps up going down is flagged', () => {
    const s = buildRodString({
      sections: [{ size: '3/4', lengthFt: 2000 }, { size: '7/8', lengthFt: 3000 }],
      fluidSg: 1,
    });
    expect(s.ok).toBe(true);
    expect(s.warnings.map((w) => w.code)).toContain('taperStepsUp');
  });

  test('designTaper equalises peak stress across the sections', () => {
    const t = designTaper({
      lengthFt: 5000, sizes: ['7/8', '3/4'], plungerAreaIn2: rodArea(1.75),
      fluidLoadLb: 5000, fluidSg: 1,
    });
    expect(t.ok).toBe(true);
    const s = buildRodString({ sections: t.sections, fluidSg: 1 });
    expect(rel(s.lengthFt, 5000)).toBeLessThan(1e-9);
    // Top load of each section over its area, within a few percent.
    let below = 0;
    const stresses = [];
    for (let i = s.sections.length - 1; i >= 0; i -= 1) {
      const sec = s.sections[i];
      const top = 5000 + below + sec.weightLb * s.buoyancy;
      stresses.unshift(top / sec.areaIn2);
      below += sec.weightLb * s.buoyancy;
    }
    expect(rel(stresses[0], stresses[1])).toBeLessThan(0.05);
  });
});

describe('the wave speed and the 245,000 constant', () => {
  test('bare steel is about 16,980 ft/s and the coupling mass explains the rest', () => {
    expect(steelAcousticVelocityFtS()).toBeGreaterThan(16800);
    expect(steelAcousticVelocityFtS()).toBeLessThan(17100);
    // Couplings add mass and no stiffness, so they slow the wave by the
    // square root of the coupling allowance. That is where the
    // conventional rod-string velocity comes from.
    const derived = steelAcousticVelocityFtS() / Math.sqrt(COUPLING_ALLOWANCE);
    expect(rel(derived, ROD_ACOUSTIC_VELOCITY_FT_S)).toBeLessThan(0.005);
  });

  test('the section wave speed matches the oracle', () => {
    const s = rodSection({ size: '7/8', lengthFt: 1000 });
    expect(rel(sectionWaveSpeedFtS(s), G.constants.waveSpeed78)).toBeLessThan(1e-9);
  });

  test('a uniform string gives N0 = 245,000 / L', () => {
    const s = buildRodString({ sections: [{ size: '7/8', lengthFt: 6000 }], fluidSg: 1 });
    const f = naturalFrequency({ string: s });
    expect(rel(f.n0Spm * 6000, 245000)).toBeLessThan(0.005);
    expect(f.uniform).toBe(true);
    expect(f.taperFactor).toBe(1);
    // and the eigenvalue solver agrees with the finite-element oracle
    expect(rel(f.nPrimeSpm, G.strings.uniform.n0Spm)).toBeLessThan(1e-4);
  });

  test('a tapered string is solved, not looked up, and matches the oracle', () => {
    const f = naturalFrequency({ string: taperString() });
    expect(f.uniform).toBe(false);
    expect(f.taperFactor).toBeGreaterThan(1);
    expect(rel(f.nPrimeSpm, G.strings.taper.n0Spm)).toBeLessThan(1e-4);
  });

  test('the string wave speed is a length-weighted mean of its sections', () => {
    const s = taperString();
    const a = stringWaveSpeedFtS(s);
    const lo = Math.min(...s.sections.map(sectionWaveSpeedFtS));
    const hi = Math.max(...s.sections.map(sectionWaveSpeedFtS));
    expect(a).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(a).toBeLessThanOrEqual(hi + 1e-9);
  });
});

describe('the damped wave equation', () => {
  const S_FT = 64 / 12;
  const FO = 5000;

  test('damping is a fraction of critical for the fundamental', () => {
    const k = dampingCoefficient({ dampingRatio: 0.1, waveSpeedFtS: 16289, lengthFt: 5000 });
    // kappa = 2 zeta omega0 with omega0 = pi a / (2 L)
    expect(rel(k, 2 * 0.1 * ((Math.PI * 16289) / (2 * 5000)))).toBeLessThan(1e-12);
    expect(DEFAULT_DAMPING_RATIO).toBeGreaterThan(0);
  });

  test('THE STATIC LIMIT: as the unit slows, Sp -> S - Fo/kr and the loads go flat', () => {
    // This is the gate the whole module stands on. Pumped slowly
    // enough, a rod string is just a spring: the plunger loses exactly
    // the rod stretch, the peak load is the buoyed weight plus the
    // fluid load, and the minimum is the buoyed weight alone. Any error
    // in the boundary conditions, the transfer states or the marching
    // scheme shows up here.
    const s = taperString();
    const r = predictCard({
      string: s, surfacePosition: simpleHarmonicPosition(S_FT), strokeFt: S_FT,
      spm: 0.5, fluidLoadLb: FO, fillage: 1, dampingRatio: 0.1,
    });
    expect(r.converged).toBe(true);
    expect(rel(r.plungerStrokeIn, 64 - FO * s.erInPerLb)).toBeLessThan(0.01);
    expect(rel(r.prlPeakLb, s.weightFluidLb + FO)).toBeLessThan(0.02);
    expect(rel(r.prlMinLb, s.weightFluidLb)).toBeLessThan(0.02);
  });

  test('faster pumping widens the load range and overtravels the plunger', () => {
    const s = taperString();
    const run = (spm) => predictCard({
      string: s, surfacePosition: simpleHarmonicPosition(S_FT), strokeFt: S_FT,
      spm, fluidLoadLb: FO, fillage: 1, dampingRatio: 0.1,
    });
    const slow = run(3);
    const fast = run(12);
    expect(fast.prlPeakLb).toBeGreaterThan(slow.prlPeakLb);
    expect(fast.prlMinLb).toBeLessThan(slow.prlMinLb);
    expect(fast.plungerStrokeIn).toBeGreaterThan(slow.plungerStrokeIn);
  });

  test('the predictive march agrees with the staggered RK4 oracle', () => {
    const s = taperString();
    Object.entries(G.predict.bySpm).forEach(([spm, o]) => {
      const r = predictCard({
        string: s, surfacePosition: simpleHarmonicPosition(S_FT), strokeFt: S_FT,
        spm: Number(spm), fluidLoadLb: G.predict.fluidLoadLb, fillage: 1,
        dampingRatio: G.predict.dampingRatio,
      });
      expect(rel(r.plungerStrokeIn, o.plungerStrokeIn)).toBeLessThan(0.02);
      expect(rel(r.prlPeakLb, o.pprlLb)).toBeLessThan(0.02);
      expect(rel(r.prlMinLb, o.mprlLb)).toBeLessThan(0.03);
    });
  });

  test('THE ROUND TRIP: the diagnostic recovers the pump card the prediction assumed', () => {
    // Two solvers that share no code path. The predictive march is a
    // finite-difference time march; the diagnostic propagates Fourier
    // harmonics in closed form. Handing one's surface card to the other
    // has to give back the pump behaviour the first one was told to
    // assume.
    const s = taperString();
    const r = predictCard({
      string: s, surfacePosition: simpleHarmonicPosition(S_FT), strokeFt: S_FT,
      spm: 8, fluidLoadLb: FO, fillage: 1, dampingRatio: 0.1,
    });
    const d = diagnoseCard({ string: s, surfaceCard: r.surfaceCard, spm: 8, dampingRatio: 0.1, harmonics: 30 });
    expect(d.ok).toBe(true);
    expect(rel(d.plungerStrokeIn, r.plungerStrokeIn)).toBeLessThan(0.02);
    expect(rel(d.pumpLoadRangeLb[1], FO)).toBeLessThan(0.05);
    expect(Math.abs(d.pumpLoadRangeLb[0])).toBeLessThan(0.05 * FO);
  });

  test('the diagnostic matches the oracle to the last digit', () => {
    // The engine hand-rolls complex arithmetic because JavaScript has
    // no complex type; the oracle uses Python's. A slip in the
    // hand-rolled multiply, square root, sine or cosine cannot survive
    // this.
    const s = taperString();
    const card = G.diagnose.positionsIn.map((p, i) => ({
      tFrac: i / G.diagnose.positionsIn.length,
      positionIn: p,
      loadLb: G.diagnose.loadsLb[i],
    }));
    const d = diagnoseCard({
      string: s, surfaceCard: card, spm: G.diagnose.spm,
      dampingRatio: G.diagnose.dampingRatio, harmonics: G.diagnose.harmonics,
    });
    expect(rel(d.plungerStrokeIn, G.diagnose.result.plungerStrokeIn)).toBeLessThan(1e-9);
    expect(rel(d.pumpLoadRangeLb[1], G.diagnose.result.pumpLoadMaxLb)).toBeLessThan(1e-9);
    expect(rel(d.pumpLoadRangeLb[0], G.diagnose.result.pumpLoadMinLb)).toBeLessThan(1e-9);
  });

  test('a card too short to read is refused', () => {
    expect(diagnoseCard({ string: taperString(), surfaceCard: [], spm: 8 }).ok).toBe(false);
  });

  test('partial fillage keeps the load on into the downstroke and cuts the work', () => {
    const s = taperString();
    const run = (fillage) => predictCard({
      string: s, surfacePosition: simpleHarmonicPosition(S_FT), strokeFt: S_FT,
      spm: 8, fluidLoadLb: FO, fillage, dampingRatio: 0.1,
    });
    const full = run(1);
    const half = run(0.5);
    expect(half.workInLbPerCycle).toBeLessThan(full.workInLbPerCycle);
    // and the pump card still spans the same load, just for less of the stroke
    const loads = half.pumpCard.map((p) => p.loadLb);
    expect(Math.max(...loads)).toBeGreaterThan(0.8 * FO);
  });

  test('the card area is the work, and horsepower follows from it', () => {
    // A rectangle of known area, to pin the shoelace formula.
    const rect = [
      { positionIn: 0, loadLb: 0 }, { positionIn: 10, loadLb: 0 },
      { positionIn: 10, loadLb: 5 }, { positionIn: 0, loadLb: 5 },
    ];
    expect(cardArea(rect)).toBeCloseTo(50, 9);
    // 33,000 ft-lb/min is one horsepower; the card is in inch-pounds.
    expect(polishedRodHp({ workInLbPerCycle: 12 * 33000, spm: 1 })).toBeCloseTo(1, 12);
  });

  test('Fourier coefficients recover a pure tone', () => {
    const n = 64;
    const vals = Array.from({ length: n }, (_, j) => 3 * Math.cos((2 * Math.PI * 2 * j) / n));
    const c = fourierCoefficients(vals, 4);
    expect(Math.abs(c[0][0])).toBeLessThan(1e-12);
    expect(c[2][0]).toBeCloseTo(1.5, 10);       // half the amplitude, as a complex pair
    expect(Math.abs(c[3][0])).toBeLessThan(1e-12);
  });
});

describe('the pumping unit', () => {
  const geom = () => conventionalGeometry(G.unit.geometry);

  test('the linkage closes and reproduces the oracle stroke and torque factor', () => {
    const kin = unitKinematics(geom(), { steps: 360 });
    expect(kin.ok).toBe(true);
    expect(rel(kin.strokeIn, G.unit.strokeIn)).toBeLessThan(1e-4);
    const tfMax = Math.max(...kin.samples.map((s) => Math.abs(s.torqueFactorIn)));
    expect(rel(tfMax, G.unit.torqueFactorMaxIn)).toBeLessThan(1e-3);
    expect(Math.abs(kin.upstrokeFraction - G.unit.upstrokeFraction)).toBeLessThan(0.01);
  });

  test('a conventional unit is NOT a sine wave', () => {
    // The predecessor assumed pure harmonic motion. A real four-bar
    // spends different amounts of the revolution on the two strokes,
    // and that asymmetry is most of the difference in peak torque.
    const kin = unitKinematics(geom(), { steps: 720 });
    expect(Math.abs(kin.upstrokeFraction - 0.5)).toBeGreaterThan(0.02);
  });

  test('the torque factor IS ds/dtheta', () => {
    // By virtual work that is the definition, so a coarse independent
    // difference of the position samples has to reproduce it.
    const kin = unitKinematics(geom(), { steps: 720 });
    const n = kin.samples.length;
    const dTheta = (2 * Math.PI) / n;
    for (let i = 5; i < n; i += 97) {
      const fwd = kin.samples[(i + 1) % n].positionIn;
      const back = kin.samples[(i - 1 + n) % n].positionIn;
      const numeric = (fwd - back) / (2 * dTheta);
      expect(rel(numeric, kin.samples[i].torqueFactorIn)).toBeLessThan(0.02);
    }
  });

  test('a geometry that cannot close is refused rather than clamped', () => {
    const bad = conventionalGeometry({
      aIn: 100, cIn: 60, pIn: 5, crankBehindIn: 90, crankBelowIn: 60, rIn: 30,
    });
    const kin = unitKinematics(bad);
    expect(kin.ok).toBe(false);
    expect(kin.error).toMatch(/does not close/);
    expect(beamAngleAt(bad, 0)).toBeNull();
  });

  test('generic geometry hits the stroke it was asked for, and says it is generic', () => {
    [48, 64, 120].forEach((strokeIn) => {
      const g = genericConventionalGeometry({ strokeIn });
      expect(g.ok).toBe(true);
      expect(g.generic).toBe(true);
      expect(g.note).toMatch(/[Nn]ot a manufacturer/);
      const kin = unitKinematics(g.geometry, { steps: 720 });
      expect(rel(kin.strokeIn, strokeIn)).toBeLessThan(1e-3);
    });
  });

  test('ENERGY: torque through a revolution equals the area of the card', () => {
    // The single strongest check on the torque factor. Whatever work
    // the polished rod does on the rods over a stroke has to arrive at
    // the crankshaft, so integrating TF x PRL over a revolution must
    // return the dynamometer card's area.
    const s = taperString();
    const g = genericConventionalGeometry({ strokeIn: 64 });
    const kin = unitKinematics(g.geometry, { steps: 360 });
    const r = predictCard({
      string: s, surfacePosition: surfacePositionFn(kin), strokeFt: 64 / 12,
      spm: 9, fluidLoadLb: 5000, fillage: 1, dampingRatio: 0.1,
    });
    const card = r.surfaceCard;
    const cardLoadAt = (f) => card[Math.min(card.length - 1,
      Math.max(0, Math.round(f * card.length) % card.length))].loadLb;
    const t = netTorque({ kin, cardLoadAt, counterbalanceMomentInLb: 0 });
    const dTheta = (2 * Math.PI) / t.length;
    const work = Math.abs(t.reduce((a, row) => a + row.rodTorqueInLb * dTheta, 0));
    expect(rel(work, r.workInLbPerCycle)).toBeLessThan(0.05);
  });

  test('balancing levels the two peaks and cuts the torque the gearbox sees', () => {
    const s = taperString();
    const g = genericConventionalGeometry({ strokeIn: 64 });
    const kin = unitKinematics(g.geometry, { steps: 360 });
    const r = predictCard({
      string: s, surfacePosition: surfacePositionFn(kin), strokeFt: 64 / 12,
      spm: 9, fluidLoadLb: 5000, fillage: 1, dampingRatio: 0.1,
    });
    const card = r.surfaceCard;
    const cardLoadAt = (f) => card[Math.min(card.length - 1,
      Math.max(0, Math.round(f * card.length) % card.length))].loadLb;
    const unbalanced = netTorque({ kin, cardLoadAt, counterbalanceMomentInLb: 0 });
    const peak0 = Math.max(...unbalanced.map((x) => Math.abs(x.netTorqueInLb)));
    const bal = balanceUnit({ kin, cardLoadAt, aIn: g.geometry.aIn });
    expect(bal.balanced).toBe(true);
    expect(bal.peakTorqueInLb).toBeLessThan(peak0);
    const up = Math.max(...bal.torque.filter((x) => x.torqueFactorIn < 0)
      .map((x) => Math.abs(x.netTorqueInLb)));
    const down = Math.max(...bal.torque.filter((x) => x.torqueFactorIn >= 0)
      .map((x) => Math.abs(x.netTorqueInLb)));
    expect(rel(up, down)).toBeLessThan(1e-3);
    // and the counterbalance effect lands near the textbook ideal
    const ideal = s.weightFluidLb + 5000 / 2;
    expect(rel(bal.counterbalanceEffectLb, ideal)).toBeLessThan(0.25);
    expect(counterbalanceEffect({ kin, momentInLb: 0 })).toBe(0);
  });

  test('API unit designations parse into the three numbers a design is checked against', () => {
    const d = parseUnitDesignation('C-228D-200-74');
    expect(d.kind).toBe('conventional');
    expect(d.torqueRatingInLb).toBe(228000);
    expect(d.structuralCapacityLb).toBe(20000);
    expect(d.strokeIn).toBe(74);
    expect(parseUnitDesignation('M-320D-256-120').kind).toBe('Mark II');
    expect(parseUnitDesignation('A-912D-365-168').kind).toBe('air balanced');
    expect(parseUnitDesignation('not a unit')).toBeNull();
  });
});

describe('the design chain', () => {
  test('the pump constant is derived, and equals the 0.1166 every text quotes', () => {
    expect(IN3_PER_BBL).toBe(9702);
    expect(rel(PUMP_CONSTANT, 0.1166)).toBeLessThan(1e-3);
    expect(rel(PUMP_CONSTANT, G.constants.pumpConstant)).toBeLessThan(1e-12);
  });

  test('displacement uses the diameter squared, not the area', () => {
    // The predecessor wrote 0.1166 * area * S * N. The constant already
    // carries the pi/4, so multiplying by area applies it twice and
    // understates displacement by 21 percent — which came back out as a
    // pump fillage 27 percent too high.
    const d = displacementBpd({ plungerDIn: 2, strokeIn: 64, spm: 10 });
    const wrong = 0.1166 * rodArea(2) * 64 * 10;
    expect(rel(d, 0.1166 * 4 * 64 * 10)).toBeLessThan(1e-3);
    expect(rel(wrong / d, Math.PI / 4)).toBeLessThan(1e-2);
    // linear in every factor
    expect(rel(displacementBpd({ plungerDIn: 2, strokeIn: 128, spm: 10 }), 2 * d)).toBeLessThan(1e-12);
    expect(rel(displacementBpd({ plungerDIn: 4, strokeIn: 64, spm: 10 }), 4 * d)).toBeLessThan(1e-12);
  });

  test('the fluid load is the differential across the plunger, and tubing pressure ADDS', () => {
    // The predecessor subtracted the tubing pressure from the column,
    // which lightened every design it produced.
    const withTubing = fluidLoadLb({ plungerDIn: 1.75, pDischargePsi: 2265, pIntakePsi: 150 });
    const withoutTubing = fluidLoadLb({ plungerDIn: 1.75, pDischargePsi: 2165, pIntakePsi: 150 });
    expect(withTubing).toBeGreaterThan(withoutTubing);
    expect(rel(withTubing, rodArea(1.75) * (2265 - 150))).toBeLessThan(1e-12);
    // never negative: a plunger with nothing to lift carries nothing
    expect(fluidLoadLb({ plungerDIn: 1.75, pDischargePsi: 100, pIntakePsi: 500 })).toBe(0);
  });

  test('the modified Goodman allowable rises with the minimum stress and scales with the service factor', () => {
    const a = modifiedGoodman({ minTensilePsi: 115000, minStressPsi: 10000, serviceFactor: 1 });
    expect(rel(a.allowablePsi, 115000 / 4 + 0.5625 * 10000)).toBeLessThan(1e-12);
    const b = modifiedGoodman({ minTensilePsi: 115000, minStressPsi: 20000, serviceFactor: 1 });
    expect(b.allowablePsi).toBeGreaterThan(a.allowablePsi);
    const c = modifiedGoodman({ minTensilePsi: 115000, minStressPsi: 10000, serviceFactor: 0.9 });
    expect(rel(c.allowablePsi, 0.9 * a.allowablePsi)).toBeLessThan(1e-12);
  });

  test('the dimensionless groups are the definitions RP 11L is plotted against', () => {
    const g = dimensionlessGroups({
      spm: 10, n0Spm: 50, nPrimeSpm: 55, fluidLoad: 5000, strokeIn: 64,
      krLbPerIn: 200, plungerStrokeIn: 48, pprlLb: 16000, mprlLb: 6000,
      weightFluidLb: 9000, peakTorqueInLb: 200000,
    });
    expect(g.nOverN0).toBeCloseTo(0.2, 12);
    expect(g.nOverNPrime).toBeCloseTo(10 / 55, 12);
    expect(g.skrLb).toBeCloseTo(12800, 12);
    expect(g.foOverSkr).toBeCloseTo(5000 / 12800, 12);
    expect(g.spOverS).toBeCloseTo(0.75, 12);
    expect(g.f1OverSkr).toBeCloseTo(7000 / 12800, 12);
    expect(g.f2OverSkr).toBeCloseTo(3000 / 12800, 12);
    expect(g.torqueGroup).toBeCloseTo((2 * 200000) / (64 * 64 * 200), 12);
  });

  test('a full design run holds together, and stress lands on the taper', () => {
    const s = taperString();
    const g = genericConventionalGeometry({ strokeIn: 64 });
    const kin = unitKinematics(g.geometry, { steps: 360 });
    const res = runRodPumpDesign({
      string: s,
      frequency: naturalFrequency({ string: s }),
      kin,
      surfacePosition: surfacePositionFn(kin),
      strokeIn: 64,
      spm: 9,
      plungerDIn: 1.75,
      pDischargePsi: 0.433 * 5000 + 100,
      pIntakePsi: 150,
      fillage: 1,
      pumpEfficiency: 0.9,
      serviceFactor: 1,
      unitRating: parseUnitDesignation('C-228D-200-74'),
    });
    expect(res.ok).toBe(true);
    const d = res.design;
    expect(d.plungerStrokeIn).toBeLessThan(64);
    expect(d.pprlLb).toBeGreaterThan(s.weightFluidLb);
    expect(d.mprlLb).toBeLessThan(s.weightFluidLb);
    // The plunger, not the polished rod, sweeps the barrel.
    expect(d.producedBpd).toBeLessThan(d.ratedBpd);
    expect(rel(d.sweptBpd, displacementBpd({
      plungerDIn: 1.75, strokeIn: d.plungerStrokeIn, spm: 9,
    }))).toBeLessThan(1e-12);
    expect(d.stresses).toHaveLength(2);
    d.stresses.forEach((x) => {
      expect(x.maxStressPsi).toBeGreaterThan(0);
      expect(x.loadingPct).toBeGreaterThan(0);
      expect(x.maxStressPsi).toBeLessThan(s.grade.minTensilePsi);
    });
    // the top section carries the most
    expect(d.stresses[0].maxLoadLb).toBeGreaterThan(d.stresses[1].maxLoadLb);
    expect(d.rating.structuralPct).toBeGreaterThan(0);
  });

  test('a plunger with nothing to lift is refused, not solved', () => {
    const s = taperString();
    const g = genericConventionalGeometry({ strokeIn: 64 });
    const kin = unitKinematics(g.geometry, { steps: 180 });
    const res = runRodPumpDesign({
      string: s, frequency: naturalFrequency({ string: s }), kin,
      surfacePosition: surfacePositionFn(kin), strokeIn: 64, spm: 9,
      plungerDIn: 1.75, pDischargePsi: 100, pIntakePsi: 500,
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/no fluid to lift/);
  });

  test('a unit driven at the string natural frequency is refused, with the number', () => {
    const s = taperString();
    const f = naturalFrequency({ string: s });
    const g = genericConventionalGeometry({ strokeIn: 64 });
    const kin = unitKinematics(g.geometry, { steps: 180 });
    const res = runRodPumpDesign({
      string: s, frequency: f, kin, surfacePosition: surfacePositionFn(kin),
      strokeIn: 64, spm: Math.ceil(f.nPrimeSpm) + 1,
      plungerDIn: 1.75, pDischargePsi: 2265, pIntakePsi: 150,
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/natural frequency/);
    expect(res.errors.join(' ')).toContain(f.nPrimeSpm.toFixed(1));
  });

  test('an overstressed string and an overloaded unit are both named', () => {
    const s = buildRodString({
      sections: [{ size: '1/2', lengthFt: 5000 }], fluidSg: 1, gradeId: 'K',
    });
    const g = genericConventionalGeometry({ strokeIn: 64 });
    const kin = unitKinematics(g.geometry, { steps: 180 });
    const res = runRodPumpDesign({
      string: s, frequency: naturalFrequency({ string: s }), kin,
      surfacePosition: surfacePositionFn(kin), strokeIn: 64, spm: 8,
      plungerDIn: 2.25, pDischargePsi: 0.433 * 5000 + 200, pIntakePsi: 100,
      serviceFactor: 1, unitRating: parseUnitDesignation('C-57D-076-48'),
    });
    expect(res.ok).toBe(true);
    const codes = res.design.warnings.map((w) => w.code);
    expect(codes).toContain('rodOverstressed');
    expect(codes).toContain('structuralOverload');
  });

  test('an incompletely filled barrel is called out', () => {
    const s = taperString();
    const g = genericConventionalGeometry({ strokeIn: 64 });
    const kin = unitKinematics(g.geometry, { steps: 180 });
    const res = runRodPumpDesign({
      string: s, frequency: naturalFrequency({ string: s }), kin,
      surfacePosition: surfacePositionFn(kin), strokeIn: 64, spm: 9,
      plungerDIn: 1.75, pDischargePsi: 0.433 * 5000 + 100, pIntakePsi: 150,
      fillage: 0.6, pumpEfficiency: 1,
    });
    expect(res.ok).toBe(true);
    expect(res.design.warnings.map((w) => w.code)).toContain('incompleteFillage');
    expect(res.design.producedBpd).toBeLessThan(0.7 * res.design.sweptBpd);
  });

  test('section stresses read the tension envelope, not the static weight', () => {
    const s = taperString();
    const envelope = [
      { depthFt: 10, maxLb: 20000, minLb: 8000 },
      { depthFt: 3010, maxLb: 12000, minLb: 4000 },
    ];
    const out = sectionStresses({ string: s, tensionEnvelope: envelope });
    expect(out).toHaveLength(2);
    expect(out[0].maxStressPsi).toBeCloseTo(20000 / s.sections[0].areaIn2, 6);
    expect(out[1].maxStressPsi).toBeCloseTo(12000 / s.sections[1].areaIn2, 6);
  });
});

describe('damping is a precondition', () => {
  test('a string with no damping is refused, not marched into nonsense', () => {
    // Without damping the transient from every valve transfer survives
    // to the next one: the plunger stroke grows past the surface
    // stroke, the minimum load goes negative, and none of it is
    // flagged unless the solver refuses up front. A caller reaching
    // this by passing a zero default is exactly how it happens.
    const s = buildRodString({ sections: TAPER, fluidSg: 1, gradeId: 'D' });
    const r = predictCard({
      string: s, surfacePosition: simpleHarmonicPosition(64 / 12), strokeFt: 64 / 12,
      spm: 8, fluidLoadLb: 5000, fillage: 1, dampingRatio: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/never settles/);
    const res = runRodPumpDesign({
      string: s, frequency: naturalFrequency({ string: s }),
      kin: unitKinematics(genericConventionalGeometry({ strokeIn: 64 }).geometry, { steps: 180 }),
      surfacePosition: simpleHarmonicPosition(64 / 12), strokeIn: 64, spm: 8,
      plungerDIn: 1.75, pDischargePsi: 2265, pIntakePsi: 150, dampingRatio: 0,
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/never settles/);
  });
});

// ---------------------------------------------------------------------------
// Every warning in this module fires on a STRICT inequality against a
// threshold and then prints the value it fired on. Printed to whole units,
// anything within half a unit of the threshold renders AS the threshold, so
// a real warning reads as a false alarm sitting exactly on its own limit and
// invites a reader to dismiss it. The rounding errs in both directions: a
// loading of 100.55 printed whole reads as 101, overstating by the same
// mechanism that understates 100.2 onto 100.
//
// One decimal place does NOT remove the collision. It narrows it by ten: a
// value within 0.05 of the threshold still prints as the threshold. That is
// the honest claim, and every fixture below sits inside the band its flag
// fires on and clear of that residual neighbourhood. Same defect and same
// fix as espDesign.diagnoseOperation (engines PR #109).
describe('warnings print a value that is off their own threshold', () => {
  const percentIn = (message) => Number(/([\d.]+) percent/.exec(message)[1]);
  const g = genericConventionalGeometry({ strokeIn: 64 });
  const kin = unitKinematics(g.geometry, { steps: 180 });

  test('rodOverstressed fires above 100 percent and prints above 100 percent', () => {
    const s = buildRodString({
      sections: [{ size: '1/2', lengthFt: 5000 }], fluidSg: 1, gradeId: 'K',
    });
    const base = {
      string: s, frequency: naturalFrequency({ string: s }), kin,
      surfacePosition: surfacePositionFn(kin), strokeIn: 64, spm: 8,
      plungerDIn: 2.25, pDischargePsi: 0.433 * 5000 + 200, pIntakePsi: 100,
    };
    // The Goodman allowable scales with the service factor, so the service
    // factor places the loading exactly where the band is wanted.
    const free = runRodPumpDesign({ ...base, serviceFactor: 1 });
    const r = runRodPumpDesign({
      ...base, serviceFactor: free.design.worstSection.loadingPct / 100.3,
    });
    const loading = r.design.worstSection.loadingPct;
    expect(loading).toBeGreaterThan(100);
    expect(loading).toBeLessThan(100.5);              // the old whole print said "100"
    expect(loading - 100).toBeGreaterThan(0.05);      // clear of the residual band
    const w = r.design.warnings.find((x) => x.code === 'rodOverstressed');
    expect(w).toBeDefined();
    expect(percentIn(w.message)).toBeCloseTo(100.3, 6);
    expect(w.message).not.toMatch(/\b100 percent\b/);
  });

  test('incompleteFillage fires below 85 percent and prints below 85 percent', () => {
    const s = taperString();
    const r = runRodPumpDesign({
      string: s, frequency: naturalFrequency({ string: s }), kin,
      surfacePosition: surfacePositionFn(kin), strokeIn: 64, spm: 9,
      plungerDIn: 1.75, pDischargePsi: 0.433 * 5000 + 100, pIntakePsi: 150,
      fillage: 0.8461, pumpEfficiency: 1,
    });
    const w = r.design.warnings.find((x) => x.code === 'incompleteFillage');
    expect(w).toBeDefined();
    expect(percentIn(w.message)).toBeLessThan(85);
    expect(percentIn(w.message)).toBeGreaterThanOrEqual(84.5);
    expect(w.message).not.toMatch(/\b85 percent\b/);
  });

  test('the unit overloads print a load that is not the rating beside it', () => {
    // These two are the sharpest form of the defect: the value and the
    // threshold sit in ONE sentence, so a whole-unit print of a peak load a
    // fifth of a pound over the structure read as two identical numbers,
    // one of them said to exceed the other.
    const s = taperString();
    const base = {
      string: s, frequency: naturalFrequency({ string: s }), kin,
      surfacePosition: surfacePositionFn(kin), strokeIn: 64, spm: 9,
      plungerDIn: 1.75, pDischargePsi: 2275, pIntakePsi: 150,
      fillage: 1, pumpEfficiency: 0.9, serviceFactor: 1,
    };
    const free = runRodPumpDesign(base);
    const card = free.design.dynamics.surfaceCard;
    const cardLoadAt = (f) => card[Math.min(card.length - 1,
      Math.max(0, Math.round(f * card.length) % card.length))].loadLb;
    const balance = balanceUnit({ kin, cardLoadAt, aIn: g.geometry.aIn });
    // Ratings a whisker under what this design makes. The case is chosen so
    // both quantities land between a twentieth and half a unit above the
    // whole number below them: inside the old collision band, outside the
    // one decimal place leaves.
    const structuralCapacityLb = Math.floor(free.design.pprlLb);
    const torqueRatingInLb = Math.floor(balance.peakTorqueInLb);
    expect(free.design.pprlLb - structuralCapacityLb).toBeGreaterThan(0.05);
    expect(free.design.pprlLb - structuralCapacityLb).toBeLessThan(0.5);
    expect(balance.peakTorqueInLb - torqueRatingInLb).toBeGreaterThan(0.05);
    expect(balance.peakTorqueInLb - torqueRatingInLb).toBeLessThan(0.5);
    // which is to say: rounded whole, both printed the rating itself
    expect(Math.round(free.design.pprlLb)).toBe(structuralCapacityLb);
    expect(Math.round(balance.peakTorqueInLb)).toBe(torqueRatingInLb);

    const r = runRodPumpDesign({
      ...base,
      balance,
      unitRating: { structuralCapacityLb, torqueRatingInLb, strokeIn: 100 },
    });
    const load = r.design.warnings.find((x) => x.code === 'structuralOverload');
    const torque = r.design.warnings.find((x) => x.code === 'torqueOverload');
    expect(load).toBeDefined();
    expect(torque).toBeDefined();
    expect(load.message).toContain(
      `${free.design.pprlLb.toFixed(1)} lb against a ${structuralCapacityLb} lb structure`);
    expect(torque.message).toContain(
      `${balance.peakTorqueInLb.toFixed(1)} in-lb against a ${torqueRatingInLb} in-lb rating`);
    expect(load.message).not.toMatch(new RegExp(`\\b${structuralCapacityLb} lb against`));
    expect(torque.message).not.toMatch(new RegExp(`\\b${torqueRatingInLb} in-lb against`));
  });
});

// ---------------------------------------------------------------------------
// WAVE 1 of the 4 September 2026 engine decisions: items 16, 39, 43 and 49.
// Every gate below is a correctness, documentation or wording fix that must
// leave every published number exactly where it was. Nothing here regenerates
// a golden, and the goldens above are the proof that nothing moved.
const engineSource = (file) => fs.readFileSync(
  path.join(__dirname, '..', 'engines', 'production', file), 'utf8',
);
// Comment blocks wrap, so the prose is read with the leading stars and
// the line breaks flattened out of it.
const flattened = (text) => text.replace(/^\s*\*/gm, ' ').replace(/\s+/g, ' ');

describe('item 16: the frequency scan keeps to the range it says it scans', () => {
  test('a window that ends below the fundamental resolves nothing, rather than reaching outside it', () => {
    // The scan runs from 0.05 N0 to 4 N0, and N0 comes from the wave
    // speed the caller hands in. `acousticVelocityFtS` sets N0 and
    // NOTHING ELSE in the eigenvalue problem: the transfer matrix uses
    // each section's own wave speed. So a deliberately low velocity
    // moves the window without moving the root, and puts the whole
    // window below the string's true fundamental.
    //
    // A scan that adds its increment to the LOWER BOUND stays inside
    // that window, finds no sign change and says so. The scan that
    // added the increment to the running sample walked a quadratic
    // grid whose last point sat tens of thousands of spm out, so it
    // reached a root from far outside the range it claimed to scan and
    // reported it as the fundamental with no tell at all.
    const s = taperString();
    const honest = naturalFrequency({ string: s });
    const windowed = naturalFrequency({ string: s, acousticVelocityFtS: 3000 });
    expect(windowed.n0Spm * 4).toBeLessThan(honest.nPrimeSpm);   // window below the root
    expect(windowed.unresolved).toBe(true);
    expect(windowed.nPrimeSpm).toBe(windowed.n0Spm);
    expect(windowed.nPrimeSpm).not.toBeCloseTo(honest.nPrimeSpm, 6);
  });

  test('and the shipped answers do not move: the fundamental is still the FIRST root', () => {
    // The defect is latent on every shipped case, which is what makes
    // this a Wave 1 fix. Both halves are asserted: the value is the
    // golden one, and it is the lowest frequency at which a string
    // clamped at the surface and free at the pump has a solution, so
    // no higher mode has been handed back in its place.
    const endForce = (string, spm) => {
      // Independent transfer march, written out here rather than
      // reached for in the engine.
      let u = 0;
      let f = 1;
      const omega = (2 * Math.PI * spm) / 60;
      for (const sec of string.sections) {
        const k = omega / sectionWaveSpeedFtS(sec);
        const kl = k * sec.lengthFt;
        const z = ((30e6 * sec.areaIn2) / 12) * k;
        const c = Math.cos(kl);
        const sn = Math.sin(kl);
        const uNext = c * u + (sn / z) * f;
        f = -z * sn * u + c * f;
        u = uNext;
      }
      return f;
    };
    [taperString(), buildRodString({
      sections: designTaper({
        lengthFt: 5000, sizes: ['7/8', '3/4'], plungerAreaIn2: rodArea(1.75),
        fluidLoadLb: 5000, fluidSg: 1,
      }).sections,
      fluidSg: 1,
    })].forEach((s) => {
      const f = naturalFrequency({ string: s });
      let prev = endForce(s, f.n0Spm * 0.05);
      for (let i = 1; i <= 4000; i += 1) {
        const spm = f.n0Spm * 0.05 + ((f.nPrimeSpm * 0.999 - f.n0Spm * 0.05) * i) / 4000;
        const here = endForce(s, spm);
        expect(prev * here).toBeGreaterThan(0);      // no root below the one returned
        prev = here;
      }
      expect(Math.abs(endForce(s, f.nPrimeSpm))).toBeLessThan(1e-6 * Math.abs(prev));
    });
    // and the taper's fundamental is still the golden value to the digit
    expect(rel(naturalFrequency({ string: taperString() }).nPrimeSpm,
      G.strings.taper.n0Spm)).toBeLessThan(1e-4);
  });
});

describe('item 39: the march documents its own subsample', () => {
  const doc = () => {
    const src = engineSource('rodDynamics.js');
    const start = src.indexOf(' * Predictive solve');
    const end = src.indexOf('export const predictCard');
    return flattened(src.slice(start, end));
  };

  test('the documented node default is the default the march runs', () => {
    // The docstring said 60 while the code said 120, so a caller
    // reading the documentation was told the wrong grid.
    expect(doc()).toMatch(/nodes\s+spatial nodes \(default 120\)/);
    expect(doc()).not.toMatch(/default 60/);
    const s = taperString();
    const run = (extra) => predictCard({
      string: s, surfacePosition: simpleHarmonicPosition(64 / 12), strokeFt: 64 / 12,
      spm: 9, fluidLoadLb: 5000, fillage: 1, dampingRatio: 0.1, ...extra,
    });
    const bare = run({});
    expect(run({ nodes: 120 }).plungerStrokeIn).toBe(bare.plungerStrokeIn);
    expect(run({ nodes: 120 }).prlPeakLb).toBe(bare.prlPeakLb);
    expect(run({ nodes: 60 }).plungerStrokeIn).not.toBe(bare.plungerStrokeIn);
  });

  test('cardSamples and tensionEnvelope are both documented, and named as what they are', () => {
    // These are the two things that let a caller SEE the decimation:
    // the input that sets it and the one returned field carried at
    // full march resolution. Both were missing from the documentation.
    expect(doc()).toMatch(/cardSamples/);
    expect(doc()).toMatch(/tensionEnvelope/);
    expect(doc()).toMatch(/full march/i);
    expect(doc()).toMatch(/decimated/i);
    // the return really does carry the envelope at one entry per node
    const s = taperString();
    const r = predictCard({
      string: s, surfacePosition: simpleHarmonicPosition(64 / 12), strokeFt: 64 / 12,
      spm: 9, fluidLoadLb: 5000, fillage: 1, dampingRatio: 0.1, nodes: 120,
    });
    expect(r.tensionEnvelope).toHaveLength(120);
    expect(r.surfaceCard.length).toBeLessThan(r.tensionEnvelope.length * 4);
    expect(r.surfaceCard.length).toBeLessThan(r.samples);       // it IS a subsample
  });
});

describe('item 43: the displacement constant says what its square inches are', () => {
  test('the unit comment names a squared diameter, with the pi over four inside the constant', () => {
    const src = engineSource('rodPumpDesign.js');
    const block = flattened(src.slice(0, src.indexOf('export const IN3_PER_BBL')));
    expect(block).toMatch(/squared plunger diameter/i);
    expect(block).toMatch(/pi over four is already INCLUDED/i);
    expect(block).toMatch(/not an area/i);
    // and the arithmetic the comment describes is unchanged
    expect(rel(PUMP_CONSTANT, G.constants.pumpConstant)).toBeLessThan(1e-12);
    expect(rel(displacementBpd({ plungerDIn: 2, strokeIn: 64, spm: 10 }),
      PUMP_CONSTANT * 4 * 64 * 10)).toBeLessThan(1e-12);
  });
});

describe('item 49: the non-periodic flag names no remedy, and the user has a real lever', () => {
  const s = () => taperString();
  const g = genericConventionalGeometry({ strokeIn: 64 });
  const kin = unitKinematics(g.geometry, { steps: 180 });
  const base = () => ({
    string: s(), frequency: naturalFrequency({ string: s() }), kin,
    surfacePosition: surfacePositionFn(kin), strokeIn: 64, spm: 9,
    plungerDIn: 1.75, pDischargePsi: 0.433 * 5000 + 100, pIntakePsi: 150,
    fillage: 1, pumpEfficiency: 0.9, serviceFactor: 1,
  });

  test('the warning says what the flag means and nothing else', () => {
    // It used to say to raise the damping. That advice is not monotone
    // in the quantity it names: 0.08 clean, 0.10 flagged, 0.12 clean
    // again, so following it can be exactly what raises the flag.
    const r = predictCard({
      string: s(), surfacePosition: simpleHarmonicPosition(64 / 12), strokeFt: 64 / 12,
      spm: 9, fluidLoadLb: 5000, fillage: 1, dampingRatio: 0.1, maxCycles: 2,
    });
    expect(r.converged).toBe(false);
    const w = r.warnings.find((x) => x.code === 'notPeriodic');
    expect(w).toBeDefined();
    expect(w.message).toBe('The march did not settle to a repeating cycle at this resolution.');
    expect(w.message).not.toMatch(/damping/i);
    expect(w.message).not.toMatch(/indicative/i);
    expect(w.message).not.toMatch(/raise|check the inputs/i);
  });

  test('nodes and maxCycles are exposed on the design run and reach the march', () => {
    const dflt = runRodPumpDesign(base());
    const coarse = runRodPumpDesign({ ...base(), nodes: 40 });
    const short = runRodPumpDesign({ ...base(), maxCycles: 2 });
    expect(dflt.ok).toBe(true);
    expect(dflt.design.dynamics.converged).toBe(true);
    // a coarser grid is a different march, so the input is wired
    expect(coarse.ok).toBe(true);
    expect(coarse.design.dynamics.tensionEnvelope).toHaveLength(40);
    expect(coarse.design.dynamics.plungerStrokeIn)
      .not.toBe(dflt.design.dynamics.plungerStrokeIn);
    // and the cycle limit is the second lever, which the warning needs
    expect(short.design.dynamics.cycles).toBe(2);
    expect(short.design.warnings.map((w) => w.code)).toContain('notPeriodic');
    expect(dflt.design.warnings.map((w) => w.code)).not.toContain('notPeriodic');
  });

  test('leaving the advanced inputs out changes nothing at all', () => {
    // Adding an optional input must not move a single published value,
    // so the default run and the run that types the defaults out have
    // to agree to the last bit, card for card.
    const a = runRodPumpDesign(base());
    const b = runRodPumpDesign({ ...base(), nodes: 120, maxCycles: 20 });
    expect(b.design.pprlLb).toBe(a.design.pprlLb);
    expect(b.design.mprlLb).toBe(a.design.mprlLb);
    expect(b.design.plungerStrokeIn).toBe(a.design.plungerStrokeIn);
    expect(b.design.producedBpd).toBe(a.design.producedBpd);
    expect(b.design.prhp).toBe(a.design.prhp);
    expect(b.design.dynamics.surfaceCard).toEqual(a.design.dynamics.surfaceCard);
    expect(b.design.dynamics.tensionEnvelope).toEqual(a.design.dynamics.tensionEnvelope);
  });

  test('an advanced input that cannot be read is refused, never coerced', () => {
    const bad = runRodPumpDesign({ ...base(), nodes: 'sixty' });
    expect(bad.ok).toBe(false);
    expect(bad.design).toBeNull();
    expect(bad.errors.join(' ')).toMatch(/node count must be a number of at least 8/);
    expect(bad.errors.join(' ')).toContain('"sixty"');
    const cycles = runRodPumpDesign({ ...base(), maxCycles: NaN });
    expect(cycles.ok).toBe(false);
    expect(cycles.errors.join(' ')).toMatch(/cycle limit must be a number of at least 1/);
    // and the message says what it was actually handed, not a coerced
    // stand-in for it
    expect(cycles.errors.join(' ')).toContain('given as NaN');
    // null is not a default: absent is
    expect(runRodPumpDesign({ ...base(), nodes: null }).ok).toBe(false);
    expect(runRodPumpDesign({ ...base(), nodes: undefined }).ok).toBe(true);
  });
});

// Items 14 and 38: the loads come off the full march, never off the
// plotting subsample.
describe('items 14 and 38: which series the loads are read from', () => {
  const s = taperString();
  const S_FT = 64 / 12;
  const run = (over) => predictCard({
    string: s, surfacePosition: simpleHarmonicPosition(S_FT), strokeFt: S_FT,
    spm: 9, fluidLoadLb: 5000, fillage: 1, dampingRatio: 0.1, ...over,
  });

  test('the reported peak and minimum are the extremes of every step, not of 180 samples', () => {
    const r = run();
    // the march is thousands of steps a cycle against 180 card points
    expect(r.marchSamplesPerCycle).toBeGreaterThan(1000);
    expect(r.surfaceCard.length).toBeLessThanOrEqual(181);
    // a maximum over a superset can only be larger, and a minimum only
    // smaller, so these two inequalities are the whole claim
    expect(r.prlPeakLb).toBeGreaterThanOrEqual(r.cardPrlPeakLb);
    expect(r.prlMinLb).toBeLessThanOrEqual(r.cardPrlMinLb);
    // and on this design the subsample really did miss something
    expect(r.prlPeakLb - r.cardPrlPeakLb).toBeGreaterThan(1);
    expect(r.cardPrlMinLb - r.prlMinLb).toBeGreaterThan(1);
  });

  test('the miss is worst where the card is least smooth, which is a partly filled pump', () => {
    const full = run({ fillage: 1 });
    const partial = run({ fillage: 0.6 });
    const missFull = (full.cardPrlMinLb - full.prlMinLb) / full.prlMinLb;
    const missPartial = (partial.cardPrlMinLb - partial.prlMinLb) / partial.prlMinLb;
    expect(missPartial).toBeGreaterThan(missFull);
    // MPRL sets the counterbalance and half the gearbox torque, and on
    // the partly filled pump the subsample overstated it by per cent,
    // not by rounding
    expect(missPartial).toBeGreaterThan(0.05);
  });

  test('the work per cycle is the area of the loop the march traversed', () => {
    const r = run();
    expect(r.workInLbPerCycle).not.toBe(r.cardWorkInLbPerCycle);
    // the two agree to better than a per cent, which is what a 180 point
    // polygon of a smooth loop is worth: it is the LOADS the subsample
    // hurts, not the area
    expect(rel(r.workInLbPerCycle, r.cardWorkInLbPerCycle)).toBeLessThan(0.01);
  });

  test('the cards themselves are still the decimated ones, for plotting', () => {
    const r = run({ cardSamples: 60 });
    expect(r.surfaceCard.length).toBeLessThanOrEqual(61);
    // and changing the card sampling does not move a load any more
    const coarse = run({ cardSamples: 30 });
    const fine = run({ cardSamples: 360 });
    expect(coarse.prlPeakLb).toBe(fine.prlPeakLb);
    expect(coarse.prlMinLb).toBe(fine.prlMinLb);
    expect(coarse.workInLbPerCycle).toBe(fine.workInLbPerCycle);
    // where the card readings do move with it, which is why they were
    // never the loads
    expect(coarse.cardPrlMinLb).not.toBe(fine.cardPrlMinLb);
  });
});

// The partial-fillage coverage the golden never had, and what it shows.
describe('partial fillage: the coverage, and the seed', () => {
  const G_PF = G.partialFillage;
  const s = buildRodString({
    sections: G_PF.sections.map(([size, lengthFt]) => ({ size, lengthFt })),
    fluidSg: 1.0,
    gradeId: 'D',
  });

  test('every partly filled row agrees with the independent oracle', () => {
    // Every `predict` case in this golden was fillage 1, and a full pump
    // never enters the pound-down branch at all, so the partly filled
    // half of both implementations was ungated. It is the field normal
    // case.
    G_PF.rows.forEach((row) => {
      const r = predictCard({
        string: s,
        surfacePosition: simpleHarmonicPosition(G_PF.strokeIn / 12),
        strokeFt: G_PF.strokeIn / 12,
        spm: row.spm,
        fluidLoadLb: G_PF.fluidLoadLb,
        fillage: row.fillage,
        dampingRatio: G_PF.dampingRatio,
      });
      expect(r.ok).toBe(true);
      expect(r.converged).toBe(true);
      expect(rel(r.plungerStrokeIn, row.plungerStrokeIn)).toBeLessThan(0.01);
      expect(rel(r.prlPeakLb, row.pprlLb)).toBeLessThan(0.01);
      expect(rel(r.prlMinLb, row.mprlLb)).toBeLessThan(0.03);
      // the pump card really is a partly filled one: the pound-down
      // shortens the plunger's loaded travel as the fillage falls
      expect(r.plungerStrokeIn).toBeLessThan(G_PF.strokeIn);
    });
  });

  test('the oracle forgets its first-cycle seed on every one of them', () => {
    // which is what a settled march is supposed to do, and it is the
    // reference the engine is judged against below
    G_PF.rows.forEach((row) => {
      // to the seventh figure, which is the march's own step noise and
      // not a different answer
      expect(rel(row.plungerStrokeInStaticSeed, row.plungerStrokeIn)).toBeLessThan(1e-7);
      expect(rel(row.mprlLbStaticSeed, row.mprlLb)).toBeLessThan(1e-7);
    });
    expect(G_PF.staticSeedFt).toBeLessThan(G_PF.surfaceStrokeSeedFt);
  });

  test('so does this march, on the same rows', () => {
    G_PF.rows.forEach((row) => {
      const base = {
        string: s,
        surfacePosition: simpleHarmonicPosition(G_PF.strokeIn / 12),
        strokeFt: G_PF.strokeIn / 12,
        spm: row.spm,
        fluidLoadLb: G_PF.fluidLoadLb,
        fillage: row.fillage,
        dampingRatio: G_PF.dampingRatio,
      };
      const a = predictCard(base);
      const b = predictCard({ ...base, firstCycleSeedFt: G_PF.staticSeedFt });
      expect(rel(b.plungerStrokeIn, a.plungerStrokeIn)).toBeLessThan(1e-3);
      // and the check says so on the record
      if (row.fillage < 1) {
        expect(a.seedIndependence.checked).toBe(true);
        expect(a.seedIndependence.independent).toBe(true);
      } else {
        expect(a.seedIndependence).toBeNull();
      }
    });
  });

  // ITEM 39. This is the case the seeding half was about, and it is not
  // a case for choosing a seed.
  test('one operating point settles to two different cycles, and says so', () => {
    const half = buildRodString({
      sections: [{ size: '1/2', lengthFt: 5000 }], fluidSg: 1.0, gradeId: 'D',
    });
    const base = {
      string: half,
      surfacePosition: simpleHarmonicPosition(64 / 12),
      strokeFt: 64 / 12,
      spm: 3,
      fluidLoadLb: 5000,
      fillage: 0.1,
      dampingRatio: 0.12,
    };
    const fromSurfaceStroke = predictCard(base);
    const staticSeedFt = Math.max(64 / 12 - 5000 / half.krLbPerIn / 12, 0.1);
    const fromStatic = predictCard({ ...base, firstCycleSeedFt: staticSeedFt, seedCheck: false });
    // both settle
    expect(fromSurfaceStroke.converged).toBe(true);
    expect(fromStatic.converged).toBe(true);
    // to answers a factor of four apart
    expect(fromSurfaceStroke.plungerStrokeIn).toBeGreaterThan(14);
    expect(fromSurfaceStroke.plungerStrokeIn).toBeLessThan(15);
    expect(fromStatic.plungerStrokeIn).toBeGreaterThan(57);
    expect(fromStatic.plungerStrokeIn).toBeLessThan(59);
    // and the minimum load with them, which is what sets the
    // counterbalance
    expect(fromStatic.prlMinLb / fromSurfaceStroke.prlMinLb).toBeGreaterThan(2);
    // the answer is reported, and it is reported as one of the answers
    const w = fromSurfaceStroke.warnings.find((x) => x.code === 'seedDependent');
    expect(w).toBeDefined();
    expect(w.message).toMatch(/more than one repeating cycle/);
    expect(w.message).toMatch(/not as the answer/);
    expect(fromSurfaceStroke.seedIndependence.independent).toBe(false);
    expect(fromSurfaceStroke.seedIndependence.relativeStrokeDifference).toBeGreaterThan(1);
    // a neighbour a fifth of a fillage away is untroubled, so this is a
    // narrow band and not the whole partly filled range
    const neighbour = predictCard({ ...base, fillage: 0.3 });
    expect(neighbour.seedIndependence.independent).toBe(true);
    expect(neighbour.warnings.map((x) => x.code)).not.toContain('seedDependent');
  });

  test('a full pump is not charged for the check it does not need', () => {
    const r = predictCard({
      string: s,
      surfacePosition: simpleHarmonicPosition(G_PF.strokeIn / 12),
      strokeFt: G_PF.strokeIn / 12,
      spm: 9,
      fluidLoadLb: G_PF.fluidLoadLb,
      fillage: 1,
      dampingRatio: G_PF.dampingRatio,
    });
    // no pound-down, no seed, nothing to check
    expect(r.seedIndependence).toBeNull();
  });
});

// Items 15, 37 and 50: the three inputs the design accepted and never
// read, and the torque group that reported zero for "no answer".
describe('items 15, 37 and 50: the balance the design solves for itself', () => {
  const s = taperString();
  const geom = genericConventionalGeometry({ strokeIn: 64 });
  const kin = unitKinematics(geom.geometry, { steps: 360 });
  const design = (over) => runRodPumpDesign({
    string: s,
    frequency: naturalFrequency({ string: s }),
    kin,
    surfacePosition: surfacePositionFn(kin),
    strokeIn: 64,
    spm: 9,
    plungerDIn: 1.75,
    pDischargePsi: 0.433 * 5000 + 100,
    pIntakePsi: 150,
    fillage: 1,
    pumpEfficiency: 0.9,
    unitRating: parseUnitDesignation('C-228D-200-74'),
    ...over,
  });

  test('the design solves its own balance from the kinematics it was given', () => {
    const d = design().design;
    expect(d.balance).toBeTruthy();
    expect(d.balance.balanced).toBe(true);
    expect(d.balance.peakTorqueInLb).toBeGreaterThan(0);
    // and the torque rating check is taken from it, where it used to be
    // null unless the caller had solved the balance itself
    expect(d.rating.torquePct).toBeGreaterThan(0);
    expect(d.groups.torqueGroup).toBeGreaterThan(0);
  });

  test('the crank offset and the structural unbalance reach the torque', () => {
    const straight = design().design;
    const offset = design({ crankOffsetDeg: 20 }).design;
    const unbalanced = design({ structuralUnbalanceLb: 800 }).design;
    // three inputs the door accepted and dropped
    expect(offset.balance.peakTorqueInLb).not.toBe(straight.balance.peakTorqueInLb);
    expect(unbalanced.balance.peakTorqueInLb).not.toBe(straight.balance.peakTorqueInLb);
    expect(offset.balance.counterbalanceEffectLb)
      .not.toBe(straight.balance.counterbalanceEffectLb);
    // and a structural unbalance shows up in the counterbalance effect
    // pound for pound, which is its definition
    expect(unbalanced.balance.counterbalanceEffectLb - 800)
      .toBeLessThan(straight.balance.counterbalanceEffectLb + 1);
  });

  test('the counterbalance effect is read where the counterweight moment peaks', () => {
    // ITEM 37. The moment is M sin(theta - theta_bottom + tau), so its
    // peak moves with the crank offset. It used to be read a fixed
    // quarter turn from the bottom whatever the offset.
    const tau = (25 * Math.PI) / 180;
    const ref = kin.crankAngleAtBottomRad;
    const peakIndex = kin.samples.reduce(
      (best, x, i) => (Math.sin(x.thetaRad - ref + tau)
        > Math.sin(kin.samples[best].thetaRad - ref + tau) ? i : best),
      0,
    );
    const tfAtPeak = Math.abs(kin.samples[peakIndex].torqueFactorIn);
    const cbe = counterbalanceEffect({ kin, momentInLb: 200000, crankOffsetDeg: 25 });
    // the definition, exactly: CBE x TF = M at the crank angle where the
    // counterweight moment is largest
    expect(cbe * tfAtPeak).toBeCloseTo(200000, 6);
    // and it is a different crank angle from the no-offset one, so the
    // answer moves
    const noOffset = counterbalanceEffect({ kin, momentInLb: 200000 });
    expect(cbe).not.toBe(noOffset);
    const quarter = (kin.bottomIndex + Math.round(kin.samples.length / 4)) % kin.samples.length;
    expect(peakIndex).not.toBe(quarter);
  });

  test('with no counterbalance solved, the torque group is null and not zero', () => {
    // ITEM 50. A torque group of 0 reads as a unit that sees no gearbox
    // torque. `torquePct` beside it has always said null in this case.
    const noKin = design({ kin: undefined, surfacePosition: simpleHarmonicPosition(64 / 12) });
    expect(noKin.ok).toBe(true);
    expect(noKin.design.balance).toBeNull();
    expect(noKin.design.groups.torqueGroup).toBeNull();
    expect(noKin.design.rating.torquePct).toBeNull();
  });
});
