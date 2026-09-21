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
    let refused = 0;
    G.affinity.forEach((g) => {
      const s = stagePerformance({ curve, qBpd: g.qBpd, hz: g.hz, specificGravity: g.sg });
      expect(s.ok).toBe(g.ok);
      if (g.ok === false) {
        // item 5: past the band both sides refuse, and for the same reason
        expect(s.code).toBe(g.code);
        expect(s.inBand).toBe(false);
        expect(s.region).toBe(g.region);
        refused += 1;
        return;
      }
      expect(rel(s.headFt, g.headFt)).toBeLessThan(1e-8);
      expect(rel(s.efficiency, g.efficiency)).toBeLessThan(1e-8);
      expect(rel(s.bhpPerStage, g.bhpPerStage)).toBeLessThan(1e-8);
      expect(s.inRange).toBe(g.inRange);
      expect(s.inBand).toBe(true);
      expect(s.region).toBe(g.region);
    });
    // the table covers both sides of the band, or it is not gating item 5
    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThan(G.affinity.length);
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

  // Item 5. A cubic through five points is not a pump outside the rates
  // it was fitted to. Inside a tenth of the tested span past either end
  // the answer is an extrapolation and says so; outside it there is no
  // answer at all, and a stage count taken from one was the old result.
  test('a duty off the end of the curve is refused, not turned into a stack', () => {
    const curve = fitStageCurve({ points: G.vendorCurve.points });
    const sized = sizePump({
      curve, qBpd: 4800, tdhFt: 3800, hz: 50, specificGravity: 1.0, nameplateHp: 200,
    });
    expect(sized.ok).toBe(false);
    expect(sized.code).toBe('outsideCurve');
    expect(sized.stages).toBeUndefined();
    // the message names the rate it was asked for, the rate that implies
    // on the reference curve, and the range that curve was tested over
    expect(sized.error).toMatch(/4800\.0 bbl\/d/);
    expect(sized.error).toMatch(/5760\.0 bbl\/d/);
    expect(sized.error).toMatch(/1500 to 3500 bbl\/d/);
  });

  test('inside the band it is an extrapolation, flagged, and still answered', () => {
    const curve = fitStageCurve({ points: G.vendorCurve.points });
    // 3600 bbl/d at 60 Hz is 100 bbl/d past a 3500 bbl/d end, which is
    // half of the 200 bbl/d band on this curve
    const sized = sizePump({
      curve, qBpd: 3600, tdhFt: 2000, hz: 60, specificGravity: 1.0, nameplateHp: 200,
    });
    expect(sized.ok).toBe(true);
    expect(sized.stage.inRange).toBe(false);
    expect(sized.stage.inBand).toBe(true);
    expect(sized.warnings.map((w) => w.code)).toContain('outsideCurve');
    expect(sized.stages).toBeGreaterThan(0);
    // and one bbl/d past the band there is nothing
    const past = sizePump({
      curve, qBpd: 3701, tdhFt: 2000, hz: 60, specificGravity: 1.0, nameplateHp: 200,
    });
    expect(past.ok).toBe(false);
    expect(past.code).toBe('outsideCurve');
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

  test('boundary bands print a value off the threshold, not the threshold itself', () => {
    // Every one of these three flags fires on a STRICT inequality and
    // then prints the ratio it fired on. Rounded to whole percent, a
    // ratio anywhere in the first tenth of a percent below (or above)
    // the threshold renders AS the threshold, so a real warning reads
    // as a false alarm: "making 85 percent of its head" under a flag
    // that only fires below 85. One decimal place is the fix, and this
    // gate pins all three bands.
    const percentIn = (message) => Number(/([\d.]+) percent/.exec(message)[1]);
    const expected = stackPerformance({ curve, stages, qBpd: 2500, hz: 60, specificGravity: sg });

    // underCurve fires below 0.85: a ratio in [0.845, 0.85)
    const worn = diagnoseOperation({
      curve, stages, hz: 60, specificGravity: sg,
      measured: { qBpd: 2500, headFt: 0.8461 * expected.headFt },
    });
    const under = worn.flags.find((f) => f.code === 'underCurve');
    expect(under).toBeDefined();
    expect(percentIn(under.message)).toBeLessThan(85);
    expect(percentIn(under.message)).toBeGreaterThanOrEqual(84.5);
    expect(under.message).not.toMatch(/\b85 percent\b/);

    // ampsHigh fires above 1.05: a load in (1.05, 1.055]
    const high = diagnoseOperation({
      curve, stages, hz: 60, specificGravity: sg, nameplateAmps: 60,
      measured: { qBpd: 2500, headFt: expected.headFt, amps: 1.052 * 60 },
    });
    const hot = high.flags.find((f) => f.code === 'ampsHigh');
    expect(hot).toBeDefined();
    expect(percentIn(hot.message)).toBeGreaterThan(105);
    expect(percentIn(hot.message)).toBeLessThanOrEqual(105.5);
    expect(hot.message).not.toMatch(/\b105 percent\b/);

    // ampsLow fires below 0.40: a load in [0.395, 0.40)
    const low = diagnoseOperation({
      curve, stages, hz: 60, specificGravity: sg, nameplateAmps: 60,
      measured: { qBpd: 2500, headFt: expected.headFt, amps: 0.397 * 60 },
    });
    const cold = low.flags.find((f) => f.code === 'ampsLow');
    expect(cold).toBeDefined();
    expect(percentIn(cold.message)).toBeLessThan(40);
    expect(percentIn(cold.message)).toBeGreaterThanOrEqual(39.5);
    expect(cold.message).not.toMatch(/\b40 percent\b/);
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
        motorHp: g.inputs.motorHp,
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
    const half = motorCurrent({ motorHp: 50, nameplateHp: 100, nameplateAmps: 49 });
    expect(rel(half.amps, 24.5)).toBeLessThan(1e-12);
    expect(half.estimateWeakBelowHalfLoad).toBe(false);
    expect(motorCurrent({ motorHp: 20, nameplateHp: 100, nameplateAmps: 49 })
      .estimateWeakBelowHalfLoad).toBe(true);
    expect(Number.isNaN(motorCurrent({ motorHp: 50, nameplateHp: 0, nameplateAmps: 49 }).amps)).toBe(true);
    // and a power that is not a number is not a load either
    expect(Number.isNaN(motorCurrent({ nameplateHp: 100, nameplateAmps: 49 }).amps)).toBe(true);
  });

  test('cable selection takes the smallest conductor that passes both checks', () => {
    const cables = CABLE_SIZES.map((c) => ({ ...c, ampacityA: 90 }));
    const pick = selectCable({
      cables, maxDropPct: 5, motorHp: 125, nameplateHp: 250, nameplateAmps: 67,
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
      cables, maxDropPct: 1, motorHp: 200, nameplateHp: 250, nameplateAmps: 67,
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

// Characterisation gates for four things the ESP modules do that read
// badly and were adjudicated rather than changed (see the module
// headers for the sources). None of these tests asserts that the
// behaviour is right; each pins what it IS, so that a future change to
// any of it has to be deliberate and has to come with a decision.
describe('the seams between the ESP modules', () => {
  test('sizePump returns two powers, and they differ by exactly the stage rounding', () => {
    const curve = curveFor('ref-540-2500');
    const tdhFt = 4000;
    const sized = sizePump({
      curve, qBpd: 2500, tdhFt, hz: 60, specificGravity: 0.95, nameplateHp: 250,
    });
    // shaftHp is brake power at the head REQUIRED; stack.bhpTotal is
    // brake power at the head the stack actually MAKES. stageCount
    // rounds up, so the second is always the larger, by exactly the
    // ratio of the two heads and by at most one stage in the stack.
    expect(sized.stack.bhpTotal).toBeGreaterThan(sized.shaftHp);
    expect(rel(sized.stack.bhpTotal / sized.shaftHp, sized.headMadeFt / tdhFt)).toBeLessThan(1e-12);
    expect((sized.stack.bhpTotal - sized.shaftHp) / sized.stack.bhpTotal)
      .toBeLessThanOrEqual(1 / sized.stages);
    // ITEM 2. Every electrical number in this package is built on the
    // LARGER of the two now, which is the published sizing power. It used
    // to be the smaller, so the load fraction, the amps and the cable
    // drop were all light by the stage rounding margin.
    expect(sized.motorSizingHp).toBe(sized.stack.bhpTotal);
    expect(rel(sized.motorLoad.loadFraction * 250, sized.stack.bhpTotal)).toBeLessThan(1e-12);
    expect(sized.motorLoad.sizingHp).toBe(sized.stack.bhpTotal);
    expect(rel(sized.motorLoad.inputKw, (sized.stack.bhpTotal * 0.7457) / 0.85)).toBeLessThan(1e-12);
    // the gap it closes, on this design
    expect(sized.motorLoad.loadFraction).toBeGreaterThan(sized.shaftHp / 250);
  });

  // Item 2, end to end and against the oracle: the same design, the same
  // motor and cable, read at each of the two powers.
  test('the electrical chain is taken at the sizing power, not the duty power', () => {
    const g = G.designs.find((d) => d.electricalAtSizingHp);
    expect(g).toBeDefined();
    const sized = sizePump({
      curve: curveFor(g.inputs.curve),
      qBpd: g.gas.pumpIntakeBpd,
      tdhFt: g.tdhFt,
      hz: g.inputs.hz,
      specificGravity: g.gradientPsiPerFt / PSI_PER_FT_SG,
      nameplateHp: g.inputs.nameplateHp,
    });
    expect(rel(sized.motorSizingHp, g.sized.motorSizingHp)).toBeLessThan(1e-7);
    const req = surfaceRequirement({
      motorHp: sized.motorSizingHp,
      nameplateHp: g.inputs.nameplateHp,
      nameplateAmps: g.inputs.nameplateAmps,
      nameplateVolts: g.inputs.nameplateVolts,
      powerFactor: g.inputs.powerFactor,
      lengthFt: g.inputs.lengthFt,
      ohmsPer1000FtAt77F: g.inputs.ohmsPer1000FtAt77F,
      cableTempF: g.inputs.cableTempF,
    });
    ['amps', 'dropV', 'dropPct', 'kva', 'lossKw']
      .forEach((k) => expect(rel(req[k], g.electricalAtSizingHp[k])).toBeLessThan(1e-6));
    // and the golden carries the other reading too, so the size of the
    // understatement is on the record rather than argued about
    expect(g.electricalAtShaftHp.amps).toBeLessThan(g.electricalAtSizingHp.amps);
    expect(g.electricalAtShaftHp.dropPct).toBeLessThan(g.electricalAtSizingHp.dropPct);
  });

  test('the thrust derate is in the sizing check and not in the current', () => {
    const curve = curveFor('ref-540-2500');
    const sized = sizePump({
      curve, qBpd: 2500, tdhFt: 4000, hz: 60, specificGravity: 0.95,
      nameplateHp: 150, thrustDeratePct: 12,
    });
    const drawn = motorCurrent({
      motorHp: sized.motorSizingHp, nameplateHp: 150, nameplateAmps: 48,
    });
    // Same field name, two questions. sizePump asks what fraction of
    // the motor's USABLE rating the pump wants (selection); motorCurrent
    // asks what fraction of the PLATE it is carrying (amps). Both are
    // taken at the same power now, which is the sizing power.
    expect(rel(sized.motorLoad.derate, 0.88)).toBeLessThan(1e-12);
    expect(rel(sized.motorLoad.loadFraction, drawn.loadFraction / 0.88)).toBeLessThan(1e-12);
    const gapPoints = sized.motorLoad.loadFraction - drawn.loadFraction;
    expect(rel(gapPoints, drawn.loadFraction * (1 / 0.88 - 1))).toBeLessThan(1e-12);
    expect(gapPoints).toBeGreaterThan(0.05);
    // the amps carry no derate at all: they are the plate scaled by the load
    expect(rel(drawn.amps, 48 * (sized.motorSizingHp / 150))).toBeLessThan(1e-12);
  });

  // Not one of the 80. A derate that cannot be read is not no derate.
  test('a thrust derate that is not a number is refused, not treated as none', () => {
    const curve = curveFor('ref-540-2500');
    const args = {
      curve, qBpd: 2500, tdhFt: 4000, hz: 60, specificGravity: 0.95, nameplateHp: 150,
    };
    const bad = sizePump({ ...args, thrustDeratePct: NaN });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('unreadableDerate');
    // a deliberate zero and an absent one are still no derate
    expect(sizePump({ ...args, thrustDeratePct: 0 }).motorLoad.derate).toBe(1);
    expect(sizePump(args).motorLoad.derate).toBe(1);
    expect(sizePump({ ...args, thrustDeratePct: 12 }).motorLoad.derate).toBeCloseTo(0.88, 12);
  });

  // Item 3. There is one gradient conversion now, so the convention that
  // used to be needed to keep the two apart is not needed at all.
  test('the two gradient routes are one conversion, and a true gravity is enough', () => {
    const densityLbFt3 = 52.57683447823375;
    const exact = gradientFromDensity(densityLbFt3);          // 62.4 / 144 route
    const trueSg = densityLbFt3 / 62.4;
    expect(rel(exact, PSI_PER_FT_SG * trueSg)).toBeLessThan(1e-15);
    expect(PSI_PER_FT_SG).toBe(62.4 / 144);
    // the old rounded constant is 0.077 percent away, which is what the
    // two routes used to disagree by on one well
    expect(rel(PSI_PER_FT_SG, 0.433)).toBeGreaterThan(7e-4);
    expect(rel(PSI_PER_FT_SG, 0.433)).toBeLessThan(8e-4);
    // laundering the gravity through the constant is now the identity it
    // always looked like
    const laundered = exact / PSI_PER_FT_SG;
    expect(rel(laundered, densityLbFt3 / 62.4)).toBeLessThan(1e-15);
    expect(rel(PSI_PER_FT_SG * laundered, exact)).toBeLessThan(1e-15);
    const curve = curveFor('ref-540-2500');
    const dp = 1345.1;
    const designHeadFt = dp / exact;
    const d = diagnoseOperation({
      curve, stages: 166, hz: 60, specificGravity: laundered,
      measured: { qBpd: 2500, pIntakePsia: 1000, pDischargePsia: 1000 + dp },
    });
    expect(rel(d.actualHeadFt, designHeadFt)).toBeLessThan(1e-12);
    // hand it the TRUE specific gravity and it now reads the same head,
    // which is the whole of item 3: the two chains meet without anyone
    // knowing a convention
    const naive = diagnoseOperation({
      curve, stages: 166, hz: 60, specificGravity: trueSg,
      measured: { qBpd: 2500, pIntakePsia: 1000, pDischargePsia: 1000 + dp },
    });
    expect(rel(naive.actualHeadFt, designHeadFt)).toBeLessThan(1e-12);
    // against the old rounded constant those same two pressures read
    // 0.077 percent, about 2.8 ft, further up
    const asItWas = dp / (0.433 * trueSg);
    expect(asItWas - designHeadFt).toBeGreaterThan(2.5);
    expect(asItWas - designHeadFt).toBeLessThan(3.5);
  });

  test('on the shipped cable table the ampacity check is inert and drop decides alone', () => {
    // 192 A down 1000 ft of 6 AWG keeps the drop under five percent of
    // a 4160 V motor, so selectCable takes the smallest conductor in
    // the table at a current no 6 AWG cable would be rated for. The
    // check that should have caught it passes because the shipped table
    // carries no ampacity to check against.
    const hot = {
      cables: CABLE_SIZES, maxDropPct: 5, motorHp: 192, nameplateHp: 200,
      nameplateAmps: 200, nameplateVolts: 4160, lengthFt: 1000, cableTempF: 150,
    };
    const pick = selectCable(hot);
    // No candidate on this table carries a rating, so no candidate had
    // its ampacity checked, and `ok` is the drop verdict alone.
    expect(pick.candidates.every((c) => c.ampacityChecked === false)).toBe(true);
    pick.candidates.forEach((c) => expect(c.ok).toBe(c.dropOk));
    expect(pick.requirement.amps).toBeGreaterThan(190);
    expect(pick.cable.awg).toBe('6');
    // give the same candidates a manufacturer ampacity and the check bites
    const rated = selectCable({
      ...hot,
      cables: [
        { ...CABLE_SIZES[0], ampacityA: 105 },
        { ...CABLE_SIZES[1], ampacityA: 140 },
        { ...CABLE_SIZES[2], ampacityA: 190 },
        { ...CABLE_SIZES[3], ampacityA: 220 },
        { ...CABLE_SIZES[4], ampacityA: 255 },
      ],
    });
    expect(rated.cable.awg).toBe('1');
    // Every candidate now carries a rating, so every one was checked;
    // the three the rating rejects are the ones the drop limit would
    // have passed, which is the half of the method the shipped table
    // cannot run.
    expect(rated.candidates.every((c) => c.ampacityChecked === true)).toBe(true);
    const failedOnAmpacity = rated.candidates.filter((c) => c.dropOk && !c.ok);
    expect(failedOnAmpacity).toHaveLength(3);
    failedOnAmpacity.forEach((c) => {
      expect(c.requirement.amps).toBeGreaterThan(c.cable.ampacityA);
    });
  });
});

// The motor warnings are the same defect one step further on: they do not
// merely round a value onto its threshold, they printed a pair of numbers
// that argued AGAINST the warning they were attached to. Both fire on
// `loadFraction`, which is measured against the DERATED rating, and the
// message printed the shaft power and the PLATE only. On a 12 percent
// thrust derate a shaft asking 95.1 hp of a 100 hp motor reads as
// comfortably inside rating, while what fired the flag is 95.1 / (100 x
// 0.88) = 1.08. The underload message named no numbers at all, so it could
// not be checked either way. Messages only; no arithmetic moves.
describe('the motor warnings name the derate that fired them', () => {
  const curve = curveFor('ref-540-2500');

  test('a plate ratio under 1 and a derated ratio over 1 are both in the message', () => {
    const sized = sizePump({
      curve, qBpd: 2500, tdhFt: 3800, hz: 60, specificGravity: 0.95,
      nameplateHp: 100, thrustDeratePct: 12,
    });
    // the two ratios fall on OPPOSITE sides of 1: read against the plate
    // this motor is fine, and only the derated rating fires the flag
    expect(sized.motorSizingHp / 100).toBeLessThan(1);
    expect(sized.motorLoad.loadFraction).toBeGreaterThan(1);
    const w = sized.warnings.find((x) => x.code === 'motorOverloaded');
    expect(w).toBeDefined();
    expect(w.message).toContain(`${sized.stages} stages absorb ${sized.motorSizingHp.toFixed(1)} hp`);
    expect(w.message).toContain('100 hp motor');
    expect(w.message).toContain('derated 12 percent for thrust');
    expect(w.message).toContain(`a usable ${(100 * 0.88).toFixed(1)} hp`);
    expect(w.message).toContain(
      `${(sized.motorLoad.loadFraction * 100).toFixed(1)} percent of what it may carry`);
  });

  test('with no derate the message says nothing about one', () => {
    const sized = sizePump({
      curve, qBpd: 2500, tdhFt: 6000, hz: 60, specificGravity: 0.95, nameplateHp: 60,
    });
    const w = sized.warnings.find((x) => x.code === 'motorOverloaded');
    expect(w).toBeDefined();
    expect(sized.motorLoad.derate).toBe(1);
    expect(w.message).toContain('60 hp motor,');
    expect(w.message).not.toMatch(/derated/);
    expect(w.message).not.toMatch(/usable/);
  });

  test('the underload warning names its numbers too, so a reader can check it', () => {
    const sized = sizePump({
      curve, qBpd: 2500, tdhFt: 2000, hz: 60, specificGravity: 0.95, nameplateHp: 400,
    });
    const w = sized.warnings.find((x) => x.code === 'motorUnderloaded');
    expect(w).toBeDefined();
    expect(sized.motorLoad.loadFraction).toBeLessThan(0.5);
    expect(w.message).toContain(`${sized.stages} stages absorb ${sized.motorSizingHp.toFixed(1)} hp`);
    expect(w.message).toContain('400 hp motor');
    expect(w.message).toContain(
      `${(sized.motorLoad.loadFraction * 100).toFixed(1)} percent of what it may carry`);
    expect(w.message).toContain('the power factor and the cost both suffer');
  });
});

// Second spelling of the same defect (PR #113 was grepped on toFixed(0),
// and Math.round in a message string does the same thing). Here the rate is
// said to be OUTSIDE a range printed in the same sentence, so rounding it
// whole let it print as one of the bounds it is said to be past. One
// decimal narrows the collision by ten, not to nothing; the bounds keep
// their old reading because they are the published range.
describe('the outside-curve warning prints a rate that is not the bound', () => {
  test('a rate a fraction past qMax does not print as qMax', () => {
    const curve = curveFor('ref-540-2500');
    const qBpd = curve.qMax + 0.4;
    const sized = sizePump({
      curve, qBpd, tdhFt: 4000, hz: curve.refHz, specificGravity: 0.95,
    });
    expect(Math.round(qBpd)).toBe(curve.qMax);        // what the old print gave
    expect(qBpd - curve.qMax).toBeGreaterThan(0.05);  // clear of the residual band
    const w = sized.warnings.find((x) => x.code === 'outsideCurve');
    expect(w).toBeDefined();
    expect(w.message).toContain(`At ${qBpd.toFixed(1)} bbl/d`);
    expect(w.message).not.toMatch(new RegExp(`At ${curve.qMax} bbl/d`));
    expect(w.message).toContain(`(${curve.qMin} to ${curve.qMax} bbl/d`);
  });
});

// Item 4. `ampacityOk` was true on a candidate that carried no rating
// at all, so on the shipped CABLE_SIZES every size reported a passed
// ampacity check that had never been run, and a caller reading the
// field saw a cable certified to carry the current when only the
// voltage drop had been looked at. The field now reports the only thing
// this package can honestly report, whether the check happened. No
// ampacity column is invented, and the pick does not move.
describe('the cable ampacity signal says whether the check ran', () => {
  const hot = {
    cables: CABLE_SIZES, maxDropPct: 5, motorHp: 192, nameplateHp: 200,
    nameplateAmps: 200, nameplateVolts: 4160, lengthFt: 1000, cableTempF: 150,
  };

  test('the field that read as a pass is gone from every candidate', () => {
    const pick = selectCable(hot);
    expect(pick.candidates.length).toBe(CABLE_SIZES.length);
    pick.candidates.forEach((c) => {
      expect(c).not.toHaveProperty('ampacityOk');
      expect(c).toHaveProperty('ampacityChecked');
    });
    const rated = selectCable({
      ...hot,
      cables: CABLE_SIZES.map((c, i) => ({ ...c, ampacityA: [105, 140, 190, 220, 255][i] })),
    });
    rated.candidates.forEach((c) => expect(c).not.toHaveProperty('ampacityOk'));
  });

  test('false on the shipped table, true only where a rating was supplied', () => {
    const pick = selectCable(hot);
    // the shipped table is conductor resistance only, so nothing was checked
    pick.candidates.forEach((c) => {
      expect(c.cable.ampacityA).toBeUndefined();
      expect(c.ampacityChecked).toBe(false);
    });
    const rated = selectCable({
      ...hot,
      cables: CABLE_SIZES.map((c, i) => ({ ...c, ampacityA: [105, 140, 190, 220, 255][i] })),
    });
    rated.candidates.forEach((c) => expect(c.ampacityChecked).toBe(true));
    // and a rating on some candidates only reports per candidate, never
    // as one blanket verdict over the table
    const mixed = selectCable({
      ...hot,
      cables: [CABLE_SIZES[0], { ...CABLE_SIZES[1], ampacityA: 140 }, CABLE_SIZES[2]],
    });
    expect(mixed.candidates.map((c) => c.ampacityChecked).sort())
      .toEqual([false, false, true]);
  });

  test('the rename moves the field and not the pick', () => {
    // same two selections as the seam gate above: 6 AWG on the table
    // that carries no ampacity, 1 AWG once the ratings are supplied.
    expect(selectCable(hot).cable.awg).toBe('6');
    const rated = selectCable({
      ...hot,
      cables: CABLE_SIZES.map((c, i) => ({ ...c, ampacityA: [105, 140, 190, 220, 255][i] })),
    });
    expect(rated.cable.awg).toBe('1');
    // an unchecked candidate is still selectable on drop alone: it did
    // not pass a check, it was never given one to sit
    const pick = selectCable(hot);
    expect(pick.candidates.find((c) => c.cable.awg === '6').ok).toBe(true);
    expect(pick.candidates.find((c) => c.cable.awg === '6').ampacityChecked).toBe(false);
  });
});

// Item 26. Both motor warnings fire on `loadFraction`, which is shaft hp
// over the DERATED rating, so a reader can only check the warning if the
// message carries all four of the quantities that make it: the shaft
// power, the plate, the derate, and the load fraction that came out.
// This gate asserts the four in the string itself, on both codes and
// with and without a derate, and reconciles the printed fraction against
// the printed inputs so a message that quietly names a fifth number, or
// drops one, fails here.
describe('both motor warnings carry the four numbers that make them', () => {
  const curve = curveFor('ref-540-2500');

  const fourNumbers = (w, sized, nameplateHp) => {
    // 1. the shaft power the duty asks for
    expect(w.message).toContain(`The ${sized.stages} stages absorb ${sized.motorSizingHp.toFixed(1)} hp`);
    // 2. the nameplate it is asked of
    expect(w.message).toContain(`${nameplateHp} hp motor`);
    // 4. the load fraction that fired the flag
    expect(w.message).toContain(
      `${(sized.motorLoad.loadFraction * 100).toFixed(1)} percent of what it may carry`);
    // and the three reconcile: the reader can redo the arithmetic
    expect(rel(
      sized.motorLoad.loadFraction,
      sized.motorSizingHp / (nameplateHp * sized.motorLoad.derate),
    )).toBeLessThan(1e-12);
  };

  test('overloaded, with a thrust derate', () => {
    const sized = sizePump({
      curve, qBpd: 2500, tdhFt: 3800, hz: 60, specificGravity: 0.95,
      nameplateHp: 100, thrustDeratePct: 12,
    });
    const w = sized.warnings.find((x) => x.code === 'motorOverloaded');
    expect(w).toBeDefined();
    fourNumbers(w, sized, 100);
    // 3. the derate, as the percentage taken and the usable rating left
    expect(w.message).toContain('derated 12 percent for thrust');
    expect(w.message).toContain(`a usable ${(100 * sized.motorLoad.derate).toFixed(1)} hp`);
  });

  test('underloaded, with a thrust derate, gets the same four', () => {
    const sized = sizePump({
      curve, qBpd: 2500, tdhFt: 2000, hz: 60, specificGravity: 0.95,
      nameplateHp: 400, thrustDeratePct: 12,
    });
    const w = sized.warnings.find((x) => x.code === 'motorUnderloaded');
    expect(w).toBeDefined();
    expect(sized.motorLoad.derate).toBeLessThan(1);
    fourNumbers(w, sized, 400);
    expect(w.message).toContain('derated 12 percent for thrust');
    expect(w.message).toContain(`a usable ${(400 * sized.motorLoad.derate).toFixed(1)} hp`);
    // the underload message used to name no numbers at all, so a reader
    // had nothing to check it against
    expect(w.message).toContain('the power factor and the cost both suffer');
  });

  test('with no derate the fourth number is the plate, and the message says so', () => {
    const heavy = sizePump({
      curve, qBpd: 2500, tdhFt: 6000, hz: 60, specificGravity: 0.95, nameplateHp: 60,
    });
    const over = heavy.warnings.find((x) => x.code === 'motorOverloaded');
    expect(over).toBeDefined();
    expect(heavy.motorLoad.derate).toBe(1);
    fourNumbers(over, heavy, 60);
    // no derate was taken, so none is claimed and the load fraction is
    // read straight against the plate
    expect(over.message).not.toMatch(/derated|usable/);
    expect(rel(heavy.motorLoad.loadFraction, heavy.motorSizingHp / 60)).toBeLessThan(1e-12);

    const light = sizePump({
      curve, qBpd: 2500, tdhFt: 2000, hz: 60, specificGravity: 0.95, nameplateHp: 400,
    });
    const under = light.warnings.find((x) => x.code === 'motorUnderloaded');
    expect(under).toBeDefined();
    fourNumbers(under, light, 400);
    expect(under.message).not.toMatch(/derated|usable/);
  });

  test('neither message rounds a printed quantity onto the threshold it crossed', () => {
    const sized = sizePump({
      curve, qBpd: 2500, tdhFt: 3800, hz: 60, specificGravity: 0.95,
      nameplateHp: 100, thrustDeratePct: 12,
    });
    const w = sized.warnings.find((x) => x.code === 'motorOverloaded');
    // the flag fires strictly above 1.0, and the printed fraction has to
    // be able to sit off it: 108.0, not "100 percent"
    expect(sized.motorLoad.loadFraction).toBeGreaterThan(1);
    expect(w.message).not.toMatch(/\b100 percent of what it may carry\b/);
    // and no dash forms in either string (item 62 copy rule)
    sized.warnings.forEach((x) => {
      expect(x.message).not.toMatch(/--|—|–/);
    });
  });
});

// Items 23 and 24. An RMSE is an average, and an average hides one bad
// point among five good ones. The same two percent bar is applied to the
// worst single residual, and what the head at BEP was read off travels
// with the BEP.
describe('items 23 and 24: the fit quality, point by point', () => {
  const points = G.vendorCurve.points;

  test('the per-point residuals match the oracle', () => {
    const curve = fitStageCurve({ points });
    const q = curve.headFitQuality;
    expect(q.pointResiduals).toHaveLength(G.vendorCurve.headResiduals.length);
    q.pointResiduals.forEach((r, i) => {
      const g = G.vendorCurve.headResiduals[i];
      expect(r.qBpd).toBe(g.qBpd);
      expect(Math.abs(r.residualFt - g.residualFt)).toBeLessThan(1e-9);
    });
    expect(Math.abs(q.maxAbsResidualFt - G.vendorCurve.headMaxAbsResidualFt)).toBeLessThan(1e-9);
    expect(Math.abs(q.rmseFt - G.vendorCurve.headRmse)).toBeLessThan(1e-9);
    expect(q.curveHeightFt).toBe(G.vendorCurve.headCurveHeightFt);
    // the published curve is a clean transcription on both measures
    expect(q.rmseWithinTwoPercent).toBe(true);
    expect(q.everyPointWithinTwoPercent).toBe(true);
    expect(curve.warnings.join(' ')).not.toMatch(/misses the point/);
  });

  test('one bad point can pass the RMSE bar and fail the point bar', () => {
    // 1.4 ft on the 2500 bbl/d head, which is the size of a digit
    // transposed on a vendor sheet
    const bad = fitStageCurve({
      points: points.map((p) => (p.qBpd === 2500 ? { ...p, headFt: p.headFt + 1.4 } : p)),
    });
    const q = bad.headFitQuality;
    // the average stays inside the bar, which is how this got through
    expect(q.rmseWithinTwoPercent).toBe(true);
    expect(q.rmsePct).toBeLessThan(2);
    // and the point itself is out by more than it
    expect(q.everyPointWithinTwoPercent).toBe(false);
    expect(q.maxAbsResidualPct).toBeGreaterThan(2);
    expect(q.worstPoint.qBpd).toBe(2500);
    const w = bad.warnings.find((x) => x.includes('misses the point'));
    expect(w).toBeDefined();
    expect(w).toContain('at 2500 bbl/d');
    expect(w).toContain(`${q.maxAbsResidualPct.toFixed(1)} percent`);
    expect(w).not.toMatch(/--|—|–/);
  });

  test('the head at BEP carries the quality of the fit it was read off', () => {
    const clean = fitStageCurve({ points });
    expect(clean.bep.headFitQuality).toBe(clean.headFitQuality);
    expect(clean.bep.headFitQuality.everyPointWithinTwoPercent).toBe(true);
    const bad = fitStageCurve({
      points: points.map((p) => (p.qBpd === 2500 ? { ...p, headFt: p.headFt + 1.4 } : p)),
    });
    // the BEP is still a rate and still a number; what it now says is
    // what the head beside it was read off
    expect(Number.isFinite(bad.bep.headFt)).toBe(true);
    expect(bad.bep.headFitQuality.everyPointWithinTwoPercent).toBe(false);
    expect(bad.bep.headFitQuality.worstPoint.qBpd).toBe(2500);
    // a reference model stage is a fit through its own analytic shape,
    // so it carries the same quality object and it is clean to machine
    // precision: the check is not silently absent there either
    const model = curveFor('ref-540-2500');
    expect(model.bep.headFitQuality).not.toBeNull();
    expect(model.bep.headFitQuality.maxAbsResidualPct).toBeLessThan(1e-9);
    expect(model.bep.headFitQuality.everyPointWithinTwoPercent).toBe(true);
  });
});
