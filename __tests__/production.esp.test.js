// Production P5 ESP engine gates: closed forms the hydraulics must
// satisfy, the refusals the engine has to make rather than produce a
// number, and agreement with the independent stdlib oracle
// (tools/validation/production/oracle_esp.py) through its committed
// goldens. The oracle fits by QR where the engine solves normal
// equations, and rebuilds the hydraulic power constant from the
// pressure form rather than from rho g Q H, so agreement here is two
// routes meeting rather than code echoing itself.

import fs from 'fs';
import path from 'path';
import {
  HP_HEAD_DIVISOR, hydraulicHp, brakeHp, polyFit, polyEval, fitStageCurve,
  referenceStageCurve, bepOf, stagePerformance, stackPerformance,
  viscosityCheck, applyViscosityFactors, VISCOSITY_CORRECTION_THRESHOLD_CST,
} from '../engines/production/espPump';
import {
  PSI_PER_FT_SG, gradientFromDensity, intakePressure, intakeStream, gasHandling,
  DEFAULT_GAS_LIMITS, totalDynamicHead, tdhBreakdown, stageCount, sizePump,
  diagnoseOperation, stackCurve,
} from '../engines/production/espDesign';
import {
  conductorResistance, motorCurrent, cableVoltageDrop, cablePowerLossKw,
  surfaceRequirement, selectCable, COPPER_REF_TEMP_F,
} from '../engines/production/espMotorCable';
import {
  REFERENCE_STAGES, referenceStage, CABLE_SIZES, MOTOR_FRAMES, motorFrame,
} from '../engines/production/data/espCatalog';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'production', 'goldens', 'esp_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
const curveFor = (id) => (id === 'vendor'
  ? fitStageCurve({ points: G.vendorCurve.points })
  : referenceStageCurve(G.referenceCurves.find((c) => c.id === id).spec));

describe('hydraulic power', () => {
  test('the head constant equals the pressure-form constant, both ways', () => {
    // hp = q dP / 58824 with dP = 0.433 SG H is the same statement
    const pressureForm = (550 * 86400) / (5.614583 * 144) / (62.4 / 144);
    expect(rel(HP_HEAD_DIVISOR, pressureForm)).toBeLessThan(1e-12);
    expect(rel(HP_HEAD_DIVISOR, G.constants.hpHeadDivisor)).toBeLessThan(1e-10);
    // and the familiar rounded field constant is within a tenth of a percent
    expect(rel(HP_HEAD_DIVISOR * (62.4 / 144), 58824)).toBeLessThan(1e-3);
  });

  test('power is linear in rate, head and gravity, and efficiency divides it', () => {
    const base = hydraulicHp({ qBpd: 2000, headFt: 5000, specificGravity: 1 });
    expect(rel(hydraulicHp({ qBpd: 4000, headFt: 5000, specificGravity: 1 }), 2 * base)).toBeLessThan(1e-12);
    expect(rel(hydraulicHp({ qBpd: 2000, headFt: 5000, specificGravity: 0.85 }), 0.85 * base)).toBeLessThan(1e-12);
    expect(rel(brakeHp({ qBpd: 2000, headFt: 5000, specificGravity: 1, efficiency: 0.5 }), 2 * base)).toBeLessThan(1e-12);
    expect(Number.isNaN(brakeHp({ qBpd: 2000, headFt: 5000, specificGravity: 1, efficiency: 0 }))).toBe(true);
  });
});

describe('curve fitting', () => {
  test('a polynomial is recovered exactly from its own samples', () => {
    const truth = (x) => 30 - 1e-3 * x + 2e-7 * x * x - 4e-11 * x * x * x;
    const xs = [1000, 1500, 2000, 2500, 3000, 3500];
    const fit = polyFit(xs, xs.map(truth), 3);
    xs.forEach((x) => expect(rel(polyEval(fit, x), truth(x))).toBeLessThan(1e-8));
    expect(fit.rmse).toBeLessThan(1e-6);
    expect(fit.degree).toBe(3);
  });

  test('degree is reduced rather than over-fitted when points are scarce', () => {
    const fit = polyFit([1000, 2000, 3000], [30, 28, 22], 5);
    expect(fit.degree).toBe(2);
  });

  test('a vendor curve fit matches the oracle QR solve', () => {
    const curve = fitStageCurve({ points: G.vendorCurve.points });
    expect(curve.ok).toBe(true);
    expect(curve.headFit.coeffs).toHaveLength(G.vendorCurve.headCoeffs.length);
    // Compare the fitted curve, not each coefficient in isolation: the
    // cubic term of this dataset is numerically zero, and a relative
    // test on a zero coefficient measures nothing. Coefficients are
    // still checked, against the size of the largest of them.
    const span = Math.max(...G.vendorCurve.headCoeffs.map(Math.abs));
    curve.headFit.coeffs.forEach((c, i) => {
      expect(Math.abs(c - G.vendorCurve.headCoeffs[i])).toBeLessThan(1e-8 * span);
    });
    for (let q = curve.qMin; q <= curve.qMax; q += 100) {
      const t = q / G.vendorCurve.headScale;
      let py = 0;
      for (let k = G.vendorCurve.headCoeffs.length - 1; k >= 0; k -= 1) {
        py = py * t + G.vendorCurve.headCoeffs[k];
      }
      expect(rel(polyEval(curve.headFit, q), py)).toBeLessThan(1e-9);
    }
    expect(rel(curve.headFit.rmse, G.vendorCurve.headRmse)).toBeLessThan(1e-6);
    expect(rel(curve.bep.qBpd, G.vendorCurve.bep.qBpd)).toBeLessThan(1e-9);
    expect(rel(curve.bep.efficiency, G.vendorCurve.bep.efficiency)).toBeLessThan(1e-8);
  });

  test('too few points is refused, not fitted', () => {
    const curve = fitStageCurve({ points: [{ qBpd: 1000, headFt: 30 }, { qBpd: 2000, headFt: 25 }] });
    expect(curve.ok).toBe(false);
    expect(curve.warnings[0]).toMatch(/at least three points/i);
  });

  test('a curve with no efficiency points says so rather than inventing one', () => {
    const curve = fitStageCurve({
      points: [
        { qBpd: 1000, headFt: 30 }, { qBpd: 2000, headFt: 27 },
        { qBpd: 3000, headFt: 21 }, { qBpd: 3500, headFt: 17 },
      ],
    });
    expect(curve.effFit).toBeNull();
    expect(curve.warnings.join(' ')).toMatch(/no efficiency points/i);
    expect(Number.isNaN(bepOf(curve).qBpd)).toBe(true);
  });
});

describe('reference stage model', () => {
  const spec = REFERENCE_STAGES[1];
  const curve = referenceStageCurve(spec);

  test('it passes through the parameters it was built from', () => {
    expect(rel(polyEval(curve.headFit, spec.bepBpd), spec.bepHeadFt)).toBeLessThan(1e-9);
    // shutoff head is the ratio times the BEP head, by construction
    expect(rel(polyEval(curve.headFit, 0), spec.shutoffRatio * spec.bepHeadFt)).toBeLessThan(1e-8);
    expect(rel(curve.bep.efficiency, spec.bepEfficiency)).toBeLessThan(1e-6);
    expect(rel(curve.bep.qBpd, spec.bepBpd)).toBeLessThan(1e-2);
  });

  test('it is labelled a model, never a vendor curve', () => {
    expect(curve.source).toBe('reference-model');
    expect(curve.label).toMatch(/reference/i);
    REFERENCE_STAGES.forEach((s) => {
      expect(s.label).toMatch(/^Reference stage/);
      expect(s).not.toHaveProperty('manufacturer');
    });
  });

  test('the catalog matches the oracle samples of the same model', () => {
    G.referenceCurves.forEach((g) => {
      const c = referenceStageCurve(g.spec);
      g.samples.forEach((s) => {
        expect(rel(polyEval(c.headFit, s.qBpd), s.headFt)).toBeLessThan(1e-8);
      });
      expect(rel(c.bep.qBpd, g.bep.qBpd)).toBeLessThan(1e-6);
    });
  });

  test('an unknown catalog id falls back rather than throwing', () => {
    expect(referenceStage('nope')).toBe(REFERENCE_STAGES[1]);
    expect(motorFrame('nope')).toBe(MOTOR_FRAMES[1]);
  });
});

describe('affinity laws', () => {
  const curve = fitStageCurve({ points: G.vendorCurve.points });

  test('head goes as speed squared and power as speed cubed at the same relative duty', () => {
    const at60 = stagePerformance({ curve, qBpd: 2500, hz: 60, specificGravity: 0.9 });
    const at50 = stagePerformance({ curve, qBpd: 2500 * (50 / 60), hz: 50, specificGravity: 0.9 });
    expect(rel(at50.headFt, at60.headFt * (50 / 60) ** 2)).toBeLessThan(1e-9);
    expect(rel(at50.bhpPerStage, at60.bhpPerStage * (50 / 60) ** 3)).toBeLessThan(1e-9);
    expect(rel(at50.efficiency, at60.efficiency)).toBeLessThan(1e-12);
  });

  test('the whole affinity table matches the oracle', () => {
    G.affinity.forEach((g) => {
      const s = stagePerformance({ curve, qBpd: g.qBpd, hz: g.hz, specificGravity: g.sg });
      expect(rel(s.headFt, g.headFt)).toBeLessThan(1e-8);
      expect(rel(s.efficiency, g.efficiency)).toBeLessThan(1e-8);
      expect(rel(s.bhpPerStage, g.bhpPerStage)).toBeLessThan(1e-8);
      expect(s.inRange).toBe(g.inRange);
      expect(s.region).toBe(g.region);
    });
  });

  test('running outside the published range is reported, not hidden', () => {
    const fast = stagePerformance({ curve, qBpd: 5000, hz: 60, specificGravity: 0.9 });
    expect(fast.inRange).toBe(false);
    expect(fast.region).toBe('upthrust');
    const slow = stagePerformance({ curve, qBpd: 500, hz: 60, specificGravity: 0.9 });
    expect(slow.inRange).toBe(false);
    expect(slow.region).toBe('downthrust');
  });
});

describe('intake conditions and gas', () => {
  test('the stream and the gas split match the oracle', () => {
    G.designs.forEach((g) => {
      const stream = intakeStream({
        qoStbd: g.inputs.qoStbd, wct: g.inputs.wct, gorScfStb: g.inputs.gorScfStb, pvt: g.inputs.pvt,
      });
      ['qwStbd', 'qoResBpd', 'qwResBpd', 'freeGasScfd', 'freeGasResBpd', 'totalResBpd', 'gvf', 'mixtureDensityLbFt3']
        .forEach((k) => expect(rel(stream[k], g.stream[k])).toBeLessThan(1e-10));
      const gas = gasHandling({ stream, separatorEfficiency: g.inputs.separatorEfficiency });
      expect(rel(gas.pumpIntakeBpd, g.gas.pumpIntakeBpd)).toBeLessThan(1e-10);
      expect(rel(gas.gvfThroughPump, g.gas.gvfThroughPump)).toBeLessThan(1e-9);
      expect(rel(gas.mixtureDensityLbFt3, g.gas.mixtureDensityLbFt3)).toBeLessThan(1e-10);
      expect(gas.verdict).toBe(g.gas.verdict);
    });
  });

  test('gas below the bubble point stays dissolved and the pump sees liquid only', () => {
    const pvt = { rs: 600, bo: 1.25, bw: 1.02, bg: 0.001, rhoO: 47, rhoW: 64, rhoG: 5 };
    const stream = intakeStream({ qoStbd: 1000, wct: 0.3, gorScfStb: 500, pvt });
    expect(stream.freeGasScfd).toBe(0);
    expect(stream.gvf).toBe(0);
  });

  test('what the pump swallows is denser than the full stream once gas is vented', () => {
    // The head conversion has to use the density of the fluid IN the
    // pump: vent gas to the annulus and the same pressure rise is fewer
    // feet of head, so a design that used the full-stream density would
    // over-stage.
    const pvt = { rs: 300, bo: 1.2, bw: 1.02, bg: 0.0012, rhoO: 48, rhoW: 64, rhoG: 6 };
    const stream = intakeStream({ qoStbd: 1200, wct: 0.5, gorScfStb: 500, pvt });
    const none = gasHandling({ stream, separatorEfficiency: 0 });
    const most = gasHandling({ stream, separatorEfficiency: 0.7 });
    expect(rel(none.mixtureDensityLbFt3, stream.mixtureDensityLbFt3)).toBeLessThan(1e-12);
    expect(most.mixtureDensityLbFt3).toBeGreaterThan(none.mixtureDensityLbFt3);
    expect(most.mixtureDensityLbFt3).toBeLessThan(stream.liquidDensityLbFt3);
    // with every drop of free gas gone the pump sees the liquid itself
    const all = gasHandling({ stream, separatorEfficiency: 1 });
    expect(rel(all.mixtureDensityLbFt3, stream.liquidDensityLbFt3)).toBeLessThan(1e-12);
  });

  test('a separator moves the verdict, and the thresholds are the ones stated', () => {
    const pvt = { rs: 100, bo: 1.15, bw: 1.02, bg: 0.004, rhoO: 50, rhoW: 64, rhoG: 3 };
    const stream = intakeStream({ qoStbd: 1000, wct: 0.2, gorScfStb: 900, pvt });
    const none = gasHandling({ stream, separatorEfficiency: 0 });
    const some = gasHandling({ stream, separatorEfficiency: 0.85 });
    expect(none.gvfThroughPump).toBeGreaterThan(DEFAULT_GAS_LIMITS.handlerMax);
    expect(none.verdict).toBe('separatorRequired');
    expect(some.gvfThroughPump).toBeLessThan(none.gvfThroughPump);
    expect(some.pumpIntakeBpd).toBeLessThan(none.pumpIntakeBpd);
    // custom limits are honoured rather than baked in
    const strict = gasHandling({ stream, separatorEfficiency: 0.85, limits: { standardMax: 0.001, handlerMax: 0.002 } });
    expect(strict.verdict).toBe('separatorRequired');
  });
});

describe('total dynamic head', () => {
  test('intake pressure drops the annulus column between perforations and pump', () => {
    const pip = intakePressure({
      pwfPsia: 1500, perfTvdFt: 7500, pumpTvdFt: 7000, annulusGradPsiPerFt: 0.32,
    });
    expect(pip).toBeCloseTo(1500 - 0.32 * 500, 9);
    // a pump below the perforations cannot gain head from a negative column
    expect(intakePressure({
      pwfPsia: 1500, perfTvdFt: 7000, pumpTvdFt: 7500, annulusGradPsiPerFt: 0.32,
    })).toBe(1500);
  });

  test('TDH is the pressure the pump adds, in feet of what it is pumping', () => {
    const grad = gradientFromDensity(50.54);
    const { tdhFt, dpPsi } = totalDynamicHead({
      pIntakePsia: 1340, pDischargePsia: 3200, gradientPsiPerFt: grad,
    });
    expect(dpPsi).toBe(1860);
    expect(rel(tdhFt * grad, dpPsi)).toBeLessThan(1e-12);
    expect(rel(gradientFromDensity(62.4), PSI_PER_FT_SG)).toBeLessThan(1e-3);
  });

  test('net lift dominates a deep well: friction plus wellhead alone is not TDH', () => {
    // The predecessor app set TDH = friction + wellhead head and staged
    // an order of magnitude short. The decomposition here has to carry
    // the lift term, and the total has to be far above the other two.
    const parts = tdhBreakdown({ netLiftFt: 4800, frictionFt: 260, whpHeadFt: 340 });
    expect(parts.tdhFt).toBe(5400);
    expect(parts.tdhFt).toBeGreaterThan(6 * (parts.frictionFt + parts.whpHeadFt));
  });

  test('a stage that makes no head gives no stage count', () => {
    expect(Number.isNaN(stageCount({ tdhFt: 4000, headPerStageFt: 0 }))).toBe(true);
    expect(Number.isNaN(stageCount({ tdhFt: 4000, headPerStageFt: -3 }))).toBe(true);
    expect(stageCount({ tdhFt: 4000, headPerStageFt: 25 })).toBe(160);
  });
});

describe('sizing', () => {
  test('both design cases match the oracle end to end', () => {
    G.designs.forEach((g) => {
      const curve = curveFor(g.inputs.curve);
      const sized = sizePump({
        curve,
        qBpd: g.gas.pumpIntakeBpd,
        tdhFt: g.tdhFt,
        hz: g.inputs.hz,
        specificGravity: g.gradientPsiPerFt / PSI_PER_FT_SG,
        nameplateHp: g.inputs.nameplateHp,
      });
      expect(sized.stages).toBe(g.sized.stages);
      expect(rel(sized.shaftHp, g.sized.shaftHp)).toBeLessThan(1e-7);
      expect(rel(sized.hydraulicHp, g.sized.hydraulicHp)).toBeLessThan(1e-8);
      expect(rel(sized.headMadeFt, g.sized.headMadeFt)).toBeLessThan(1e-7);
      expect(sized.stage.region).toBe(g.sized.stage.region);
      expect(rel(sized.motorLoad.loadFraction, g.sized.loadFraction)).toBeLessThan(1e-7);
    });
  });

  test('the stack always makes at least the head asked of it', () => {
    G.designs.forEach((g) => {
      const sized = sizePump({
        curve: curveFor(g.inputs.curve),
        qBpd: g.gas.pumpIntakeBpd,
        tdhFt: g.tdhFt,
        hz: g.inputs.hz,
        specificGravity: g.gradientPsiPerFt / PSI_PER_FT_SG,
      });
      expect(sized.headMarginFt).toBeGreaterThanOrEqual(0);
      expect(sized.headMarginFt).toBeLessThan(sized.stage.headFt);
    });
  });

  test('a duty off the end of the curve is refused, not turned into a negative stack', () => {
    const curve = fitStageCurve({ points: G.vendorCurve.points });
    const sized = sizePump({
      curve, qBpd: 4800, tdhFt: 3800, hz: 50, specificGravity: 1.0, nameplateHp: 200,
    });
    expect(Number.isFinite(sized.stages) && sized.stages > 0).toBe(false);
    expect(sized.warnings.map((w) => w.code)).toContain('outsideCurve');
    expect(sized.warnings.map((w) => w.code)).toContain('upthrust');
  });

  test('motor loading is reported at both ends', () => {
    const curve = curveFor('ref-540-2500');
    const heavy = sizePump({
      curve, qBpd: 2500, tdhFt: 6000, hz: 60, specificGravity: 0.95, nameplateHp: 60,
    });
    expect(heavy.warnings.map((w) => w.code)).toContain('motorOverloaded');
    const light = sizePump({
      curve, qBpd: 2500, tdhFt: 2000, hz: 60, specificGravity: 0.95, nameplateHp: 400,
    });
    expect(light.warnings.map((w) => w.code)).toContain('motorUnderloaded');
  });
});

describe('diagnostics', () => {
  const curve = curveFor('ref-540-2500');
  const stages = 200;
  const sg = 0.95;

  test('a stack making exactly its curve reads as healthy', () => {
    const expected = stackPerformance({ curve, stages, qBpd: 2500, hz: 60, specificGravity: sg });
    const d = diagnoseOperation({
      curve, stages, hz: 60, specificGravity: sg,
      measured: { qBpd: 2500, headFt: expected.headFt },
    });
    expect(rel(d.headRatio, 1)).toBeLessThan(1e-9);
    expect(d.region).toBe('recommended');
    expect(d.flags).toHaveLength(0);
  });

  test('a worn stack is flagged from the head it is not making', () => {
    const expected = stackPerformance({ curve, stages, qBpd: 2500, hz: 60, specificGravity: sg });
    const d = diagnoseOperation({
      curve, stages, hz: 60, specificGravity: sg,
      measured: { qBpd: 2500, headFt: 0.7 * expected.headFt },
    });
    expect(d.headRatio).toBeCloseTo(0.7, 9);
    expect(d.flags.map((f) => f.code)).toContain('underCurve');
  });

  test('head can come from the two pressures instead of being handed over', () => {
    const grad = PSI_PER_FT_SG * sg;
    const d = diagnoseOperation({
      curve, stages, hz: 60, specificGravity: sg,
      measured: { qBpd: 2500, pIntakePsia: 800, pDischargePsia: 800 + grad * 5000 },
    });
    expect(rel(d.actualHeadFt, 5000)).toBeLessThan(1e-9);
  });

  test('motor amps at both extremes are called out', () => {
    const expected = stackPerformance({ curve, stages, qBpd: 2500, hz: 60, specificGravity: sg });
    const low = diagnoseOperation({
      curve, stages, hz: 60, specificGravity: sg, nameplateAmps: 60,
      measured: { qBpd: 2500, headFt: expected.headFt, amps: 20 },
    });
    expect(low.flags.map((f) => f.code)).toContain('ampsLow');
    const high = diagnoseOperation({
      curve, stages, hz: 60, specificGravity: sg, nameplateAmps: 60,
      measured: { qBpd: 2500, headFt: expected.headFt, amps: 70 },
    });
    expect(high.flags.map((f) => f.code)).toContain('ampsHigh');
  });

  test('the stack curve falls with rate and spans the speed-scaled range', () => {
    const rows = stackCurve({ curve, stages, hz: 50, specificGravity: sg, nPoints: 12 });
    expect(rows).toHaveLength(12);
    expect(rel(rows[0].qBpd, curve.qMin * (50 / 60))).toBeLessThan(1e-12);
    expect(rel(rows[rows.length - 1].qBpd, curve.qMax * (50 / 60))).toBeLessThan(1e-12);
    for (let i = 1; i < rows.length; i += 1) expect(rows[i].headFt).toBeLessThan(rows[i - 1].headFt);
  });
});

describe('viscous service', () => {
  test('a light fluid needs no correction and a heavy one is flagged', () => {
    const light = viscosityCheck({ viscosityCp: 2, densityLbFt3: 55 });
    expect(light.correctionRequired).toBe(false);
    const heavy = viscosityCheck({ viscosityCp: 60, densityLbFt3: 58 });
    expect(heavy.correctionRequired).toBe(true);
    expect(heavy.viscosityCSt).toBeGreaterThan(VISCOSITY_CORRECTION_THRESHOLD_CST);
    expect(heavy.factorsApplied).toBe(false);
    expect(heavy.note).toMatch(/Hydraulic Institute/i);
  });

  test('supplied factors are applied and nothing is invented without them', () => {
    const curve = curveFor('ref-540-2500');
    const stage = stagePerformance({ curve, qBpd: 2500, hz: 60, specificGravity: 0.95 });
    const plain = applyViscosityFactors(stage, null);
    expect(plain).toBe(stage);
    const corrected = applyViscosityFactors(stage, { cq: 0.9, ch: 0.85, ceta: 0.7 });
    expect(rel(corrected.headFt, stage.headFt * 0.85)).toBeLessThan(1e-12);
    expect(rel(corrected.efficiency, stage.efficiency * 0.7)).toBeLessThan(1e-12);
    expect(corrected.factorsApplied).toBe(true);
  });
});

describe('motor, cable and surface power', () => {
  test('copper resistance rises with temperature and is exact at the reference', () => {
    expect(conductorResistance({ ohmsPer1000FtAt77F: 0.1593, tempF: COPPER_REF_TEMP_F }))
      .toBeCloseTo(0.1593, 12);
    expect(conductorResistance({ ohmsPer1000FtAt77F: 0.1593, tempF: 200 }))
      .toBeGreaterThan(0.1593);
  });

  test('the electrical cases match the oracle', () => {
    G.electrical.forEach((g) => {
      const r = surfaceRequirement({
        shaftHp: g.inputs.shaftHp,
        nameplateHp: g.inputs.nameplateHp,
        nameplateAmps: g.inputs.nameplateAmps,
        nameplateVolts: g.inputs.nameplateVolts,
        powerFactor: g.inputs.powerFactor,
        lengthFt: g.inputs.lengthFt,
        ohmsPer1000FtAt77F: g.inputs.ohmsPer1000FtAt77F,
        cableTempF: g.inputs.cableTempF,
      });
      ['amps', 'dropV', 'dropPct', 'surfaceVolts', 'kva', 'kw', 'lossKw', 'resistanceOhmsPer1000Ft']
        .forEach((k) => expect(rel(r[k], g[k])).toBeLessThan(1e-9));
    });
  });

  test('drop is linear in length and current, and loss goes as current squared', () => {
    const base = { amps: 40, ohmsPer1000FtAt77F: 0.1593, cableTempF: 150 };
    const d1 = cableVoltageDrop({ ...base, lengthFt: 5000 }).dropV;
    const d2 = cableVoltageDrop({ ...base, lengthFt: 10000 }).dropV;
    expect(rel(d2, 2 * d1)).toBeLessThan(1e-12);
    const dHalf = cableVoltageDrop({ ...base, amps: 20, lengthFt: 5000 }).dropV;
    expect(rel(dHalf, d1 / 2)).toBeLessThan(1e-12);
    const l1 = cablePowerLossKw({ ...base, lengthFt: 5000 });
    const l2 = cablePowerLossKw({ ...base, amps: 80, lengthFt: 5000 });
    expect(rel(l2, 4 * l1)).toBeLessThan(1e-12);
  });

  test('motor current scales with load and says when the estimate is weak', () => {
    const half = motorCurrent({ shaftHp: 50, nameplateHp: 100, nameplateAmps: 49 });
    expect(rel(half.amps, 24.5)).toBeLessThan(1e-12);
    expect(half.estimateWeakBelowHalfLoad).toBe(false);
    expect(motorCurrent({ shaftHp: 20, nameplateHp: 100, nameplateAmps: 49 })
      .estimateWeakBelowHalfLoad).toBe(true);
    expect(Number.isNaN(motorCurrent({ shaftHp: 50, nameplateHp: 0, nameplateAmps: 49 }).amps)).toBe(true);
  });

  test('cable selection takes the smallest conductor that passes both checks', () => {
    const cables = CABLE_SIZES.map((c) => ({ ...c, ampacityA: 90 }));
    const pick = selectCable({
      cables, maxDropPct: 5, shaftHp: 125, nameplateHp: 250, nameplateAmps: 67,
      nameplateVolts: 2400, lengthFt: 7200, cableTempF: 180,
    });
    expect(pick.cable).not.toBeNull();
    expect(pick.requirement.dropPct).toBeLessThanOrEqual(5);
    const smaller = pick.candidates.filter(
      (c) => c.cable.ohmsPer1000FtAt77F > pick.cable.ohmsPer1000FtAt77F,
    );
    smaller.forEach((c) => expect(c.ok).toBe(false));
  });

  test('when nothing qualifies it returns nothing rather than the least bad cable', () => {
    const cables = CABLE_SIZES.map((c) => ({ ...c, ampacityA: 10 }));
    const pick = selectCable({
      cables, maxDropPct: 1, shaftHp: 200, nameplateHp: 250, nameplateAmps: 67,
      nameplateVolts: 1000, lengthFt: 12000, cableTempF: 220,
    });
    expect(pick.cable).toBeNull();
    expect(pick.requirement).toBeNull();
    expect(pick.candidates.every((c) => !c.ok)).toBe(true);
  });

  test('the cable table carries conductor resistance and leaves ampacity to the maker', () => {
    CABLE_SIZES.forEach((c) => {
      expect(c.ohmsPer1000FtAt77F).toBeGreaterThan(0);
      expect(c).not.toHaveProperty('ampacityA');
    });
  });
});
