// Facilities F10 pump gates against
// tools/validation/facilities/oracle_pumps.py.
//
// Independent routes: the quadratic curve fit is solved by CRAMER'S
// RULE in the oracle against Gaussian elimination here, and separately
// checked by RESIDUAL ORTHOGONALITY (the defining property of a
// least-squares solution, which no amount of matching arithmetic can
// fake); the duty point is found by a two-million-point SCAN plus
// refinement against the module's bisection; power goes through SI
// watts rather than the 3960 field packaging; and NPSH available is
// re-derived from a pressure balance in pascals.
//
// This is the other half of the F0-retired Compressor & Pump Pack,
// which printed "Head: 450 ft" and "NPSHa: 12 ft" as literal strings.

import fs from 'fs';
import path from 'path';
import {
  systemCurve, fitPumpCurve, dutyPoint,
  headFtToPsi, psiToHeadFt, pumpPower,
  npshAvailable, npshCheck,
  speedChange, impellerTrim, viscosityCorrection,
  combineParallel, combineSeries, operatingRegion,
} from '../engines/facilities/pumps';
import { KW_PER_HP } from '../lib/units/fieldUnits';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'pumps_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('curve fitting', () => {
  test('matches the Cramer solve and is a true least-squares fit', () => {
    G.curves.forEach((row) => {
      const f = fitPumpCurve({ points: row.points });
      expect(f.error).toBeUndefined();
      expect(rel(f.coefficients.c0, row.c0)).toBeLessThan(1e-8);
      expect(rel(f.coefficients.c1, row.c1)).toBeLessThan(1e-8);
      expect(rel(f.coefficients.c2, row.c2)).toBeLessThan(1e-8);
      expect(rel(f.shutoffHeadFt, row.shutoffHeadFt)).toBeLessThan(1e-8);
      // the oracle proved the residual is orthogonal to the basis,
      // which is what makes it least squares rather than any old fit
      expect(row.maxOrthogonalityResidual).toBeLessThan(1e-6);
    });
  });

  test('refuses degenerate input and flags a curve that does not droop', () => {
    expect(fitPumpCurve({ points: [{ qGpm: 0, headFt: 100 }] }).error).toBeTruthy();
    expect(fitPumpCurve({
      points: [{ qGpm: 100, headFt: 50 }, { qGpm: 100, headFt: 60 }, { qGpm: 100, headFt: 70 }],
    }).error).toBeTruthy();
    // a rising "pump curve" is physically wrong and is called out
    const rising = fitPumpCurve({
      points: [{ qGpm: 0, headFt: 100 }, { qGpm: 500, headFt: 150 }, { qGpm: 1000, headFt: 260 }],
    });
    expect(rising.warning).toMatch(/must droop/);
  });
});

describe('the duty point', () => {
  test('matches the scan-and-refine oracle', () => {
    G.duty.forEach((row) => {
      const pump = fitPumpCurve({ points: row.points });
      const system = systemCurve({
        staticHeadFt: row.staticHeadFt,
        frictionHeadFt: row.frictionHeadFt,
        atFlowGpm: row.atFlowGpm,
      });
      const d = dutyPoint({ pump, system, qMaxGpm: 3000 });
      expect(d.error).toBeUndefined();
      expect(rel(d.qGpm, row.qGpm)).toBeLessThan(1e-6);
      expect(rel(d.headFt, row.headFt)).toBeLessThan(1e-6);
    });
  });

  test('the intersection really is where the two curves agree', () => {
    const pump = fitPumpCurve({ points: G.duty[0].points });
    const system = systemCurve({ staticHeadFt: 150, frictionHeadFt: 200, atFlowGpm: 1500 });
    const d = dutyPoint({ pump, system, qMaxGpm: 3000 });
    expect(rel(pump.headAt(d.qGpm), system.headAt(d.qGpm))).toBeLessThan(1e-9);
  });

  test('says plainly when a pump cannot start a system', () => {
    const pump = fitPumpCurve({ points: G.duty[1].points }); // shutoff 180 ft
    const tooHigh = systemCurve({ staticHeadFt: 400, frictionHeadFt: 50, atFlowGpm: 500 });
    const d = dutyPoint({ pump, system: tooHigh, qMaxGpm: 2000 });
    expect(d.error).toMatch(/cannot start this system/);
    expect(d.shutoffHeadFt).toBeGreaterThan(0);
  });
});

describe('power', () => {
  test('the 3960 packaging matches the SI derivation', () => {
    G.power.forEach((row) => {
      const p = pumpPower(row);
      expect(p.error).toBeUndefined();
      // 3960 is a rounded packaging; agreement to a few parts in 1000
      expect(rel(p.brakeHp, row.brakeHp)).toBeLessThan(2e-3);
    });
  });

  test('head and pressure convert both ways', () => {
    const psi = headFtToPsi({ headFt: 231, sg: 1.0 });
    expect(psi).toBeCloseTo(100, 6);
    expect(psiToHeadFt({ psi, sg: 1.0 })).toBeCloseTo(231, 6);
    // a denser liquid makes more pressure from the same head
    expect(headFtToPsi({ headFt: 100, sg: 1.2 }))
      .toBeGreaterThan(headFtToPsi({ headFt: 100, sg: 0.8 }));
    expect(pumpPower({ qGpm: 100, headFt: 100, sg: 1, efficiency: 0 }).error).toBeTruthy();
  });
});

describe('NPSH', () => {
  test('available matches the pascal pressure balance', () => {
    G.npsh.forEach((row) => {
      const r = npshAvailable(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.npshaFt, row.npshaFt)).toBeLessThan(3e-3);
    });
  });

  test('the margin rule is the customary one and cavitation is named', () => {
    const ok = npshCheck({ npshaFt: 25, npshrFt: 12 });
    expect(ok.pass).toBe(true);
    expect(ok.severity).toBe('adequate');
    const marginal = npshCheck({ npshaFt: 14, npshrFt: 12 });
    expect(marginal.pass).toBe(false);
    expect(marginal.severity).toBe('marginal');
    expect(marginal.note).toMatch(/vendor agreement/);
    const bad = npshCheck({ npshaFt: 8, npshrFt: 12 });
    expect(bad.severity).toBe('cavitating');
    expect(bad.note).toMatch(/will cavitate/);
  });

  test('flags a suction already below the vapour pressure', () => {
    const r = npshAvailable({
      suctionPressurePsia: 5, vapourPressurePsia: 8, sg: 0.7,
    });
    expect(r.warning).toMatch(/already flashing/);
  });
});

describe('affinity laws and trimming', () => {
  test('speed follows the cube law for power exactly', () => {
    const s = speedChange({ qGpm: 1000, headFt: 300, brakeHp: 100, speedRatio: 0.8 });
    expect(s.qGpm).toBeCloseTo(800, 9);
    expect(s.headFt).toBeCloseTo(300 * 0.64, 9);
    expect(s.brakeHp).toBeCloseTo(100 * 0.512, 9);
    expect(speedChange({ speedRatio: -1 }).error).toBeTruthy();
  });

  test('THE POINT: a trim under-delivers what the affinity laws promise', () => {
    const small = impellerTrim({ qGpm: 1000, headFt: 300, brakeHp: 100, diameterRatio: 0.97 });
    // a small trim behaves ideally
    expect(small.shortfallPct).toBe(0);
    expect(small.headFt).toBeCloseTo(small.idealHeadFt, 9);
    // a deep trim does not
    const deep = impellerTrim({ qGpm: 1000, headFt: 300, brakeHp: 100, diameterRatio: 0.80 });
    expect(deep.shortfallPct).toBeGreaterThan(0);
    expect(deep.headFt).toBeLessThan(deep.idealHeadFt);
    // 20 percent is the vendor limit itself, so it does not warn; past it does
    expect(deep.warning).toBeNull();
    const tooDeep = impellerTrim({ qGpm: 1000, headFt: 300, brakeHp: 100, diameterRatio: 0.72 });
    expect(tooDeep.warning).toMatch(/beyond what most casings tolerate/);
    expect(tooDeep.shortfallPct).toBeGreaterThan(deep.shortfallPct);
    expect(impellerTrim({ diameterRatio: 1.2 }).error).toMatch(/cannot trim an impeller larger/);
  });
});

describe('viscosity correction', () => {
  test('matches the HI parametric oracle', () => {
    G.viscosity.forEach((row) => {
      const r = viscosityCorrection(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.B, row.B)).toBeLessThan(1e-9);
      expect(rel(r.cQ, row.cQ)).toBeLessThan(1e-9);
      expect(rel(r.cEta, row.cEta)).toBeLessThan(1e-9);
    });
  });

  test('THE POINT: a heavy fluid costs a centrifugal most of its efficiency', () => {
    const light = viscosityCorrection({ qBepGpm: 1500, headBepFt: 300, viscosityCSt: 100 });
    const heavy = viscosityCorrection({ qBepGpm: 800, headBepFt: 200, viscosityCSt: 500, speedRpm: 1780 });
    expect(light.cEta).toBeGreaterThan(heavy.cEta);
    expect(heavy.cEta).toBeLessThan(0.6);
    expect(heavy.warning).toMatch(/poor choice/);
    // water needs no correction at all
    const water = viscosityCorrection({ qBepGpm: 1500, headBepFt: 300, viscosityCSt: 1 });
    expect(water.cQ).toBe(1);
    expect(water.note).toMatch(/nothing to correct/);
  });

  test('refuses to correct outside the published range', () => {
    const wild = viscosityCorrection({ qBepGpm: 200, headBepFt: 400, viscosityCSt: 20000, speedRpm: 1180 });
    expect(wild.B).toBeGreaterThan(40);
    expect(wild.warning).toMatch(/positive-displacement/);
  });
});

describe('pumps together', () => {
  test('THE OTHER POINT: two pumps in parallel do NOT double the flow', () => {
    const pump = fitPumpCurve({ points: G.duty[0].points });
    // a friction-dominated system: most of the head is velocity head
    const system = systemCurve({ staticHeadFt: 50, frictionHeadFt: 300, atFlowGpm: 1500 });
    const one = dutyPoint({ pump, system, qMaxGpm: 4000 });
    const two = dutyPoint({ pump: combineParallel({ pump, n: 2 }), system, qMaxGpm: 4000 });
    expect(two.qGpm).toBeGreaterThan(one.qGpm);
    expect(two.qGpm).toBeLessThan(one.qGpm * 2); // the whole point
    // series adds head at the same flow instead
    const series = combineSeries({ pump, n: 2 });
    expect(series.headAt(1000)).toBeCloseTo(2 * pump.headAt(1000), 9);
    expect(combineParallel({ pump: null, n: 2 }).error).toBeTruthy();
  });
});

describe('the operating region', () => {
  test('names where the duty sits and what that costs', () => {
    expect(operatingRegion({ qGpm: 1000, qBepGpm: 1000 }).region).toBe('preferred');
    expect(operatingRegion({ qGpm: 600, qBepGpm: 1000 }).region).toBe('allowable, low');
    expect(operatingRegion({ qGpm: 600, qBepGpm: 1000 }).note).toMatch(/recirculation/);
    // G5. The note used to end "check the suction margin again at this
    // duty", which is advice a reader cannot follow: npshrFt is a SCALAR
    // input to npshCheck and there is no NPSHr-against-flow curve
    // anywhere in this module, so re-checking rereads the same number.
    // The note now says where the curve has to come from.
    expect(operatingRegion({ qGpm: 1300, qBepGpm: 1000 }).note).toMatch(/required NPSH climbs steeply with flow/);
    expect(operatingRegion({ qGpm: 1300, qBepGpm: 1000 }).note).toMatch(/single number rather than a curve/);
    const throttled = operatingRegion({ qGpm: 300, qBepGpm: 1000 });
    expect(throttled.region).toBe('outside');
    expect(throttled.note).toMatch(/variable speed drive/);
    expect(operatingRegion({ qGpm: 100, qBepGpm: 0 }).error).toBeTruthy();
  });
});

// Both warnings below fire on a strict inequality and then print the value
// they fired on. At whole percent a 20.25 percent trim read "a 20 percent
// trim ... the vendor limit usually sits near 20 percent", a false alarm on
// the face of it. One decimal narrows the collision to the 0.05 either side
// of the threshold; it does not close it, and it errs upward as readily as
// down. The fixtures sit inside each flag's band and clear of that residue.
describe('the pump warnings print a value off their own threshold', () => {
  test('a trim past 20 percent prints past 20 percent', () => {
    const t = impellerTrim({ qGpm: 1000, headFt: 200, brakeHp: 60, diameterRatio: 0.7975 });
    expect(t.trimPercent).toBeGreaterThan(20.05);
    expect(t.trimPercent).toBeLessThan(20.5);
    expect(t.warning).toMatch(/a 20\.3 percent trim/);
    expect(t.warning).not.toMatch(/\ba 20 percent trim\b/);
    // the limit the sentence quotes stays exactly as it reads today
    expect(t.warning).toContain('the vendor limit usually sits near 20 percent');
  });

  test('a viscosity efficiency correction under 60 percent prints under 60', () => {
    // B is the HI correlating parameter and its published form is
    // invertible, so the viscosity is chosen to put B where cEta is 59.75
    // percent: inside the band the flag fires on, and rendered "60 percent"
    // by the old whole-number format.
    const qBepGpm = 900;
    const headBepFt = 220;
    const speedRpm = 3560;
    const B = 8.5355100209;
    const viscosityCSt = (
      (B * qBepGpm ** 0.375 * speedRpm ** 0.25) / (26.6 * headBepFt ** 0.0625)
    ) ** 2;
    const v = viscosityCorrection({ qBepGpm, headBepFt, viscosityCSt, speedRpm });
    expect(v.cEta).toBeLessThan(0.5995);
    expect(v.cEta).toBeGreaterThan(0.595);
    expect(v.warning).toMatch(/59\.8 percent/);
    expect(v.warning).not.toMatch(/\b60 percent\b/);
  });
});

/* ==================================================================== *
 * FC3-0. The repair wave before the NextGen Rotating Equipment course.
 *
 * Eleven inputs returned a confident wrong number and eighteen returned a
 * NaN or an Infinity with NO error key, so every caller's
 * `if (result.error)` guard passed and the non-finite value propagated.
 * Each test below names the defective input, the corrected behaviour and
 * the boundary, because a guard tested only in the middle of its range is
 * a guard nobody has checked the edge of.
 * ==================================================================== */

describe('FC3-0: a refusal is a named refusal', () => {
  const duty = { qGpm: 1000, headFt: 300, brakeHp: 100 };

  test('systemCurve refuses a missing static head, and keeps a negative one', () => {
    // The object used to look healthy: kFt was right, staticHeadFt was
    // undefined, and headAt(q) was NaN at every flow, so the failure only
    // appeared when the curve was called.
    const missing = systemCurve({ frictionHeadFt: 200, atFlowGpm: 1500 });
    expect(missing.error).toMatch(/needs a static head/);
    // negative is legal: the destination can sit below the pump
    const below = systemCurve({ staticHeadFt: -40, frictionHeadFt: 200, atFlowGpm: 1500 });
    expect(below.error).toBeUndefined();
    expect(below.headAt(1500)).toBeCloseTo(160, 9);
    // and zero is legal
    expect(systemCurve({ staticHeadFt: 0, frictionHeadFt: 200, atFlowGpm: 1500 }).headAt(0)).toBe(0);
  });

  test('pumpPower bounds the motor efficiency it used to divide by unchecked', () => {
    const base = { qGpm: 1500, headFt: 300, sg: 0.85, efficiency: 0.78 };
    // 5 returned a motor drawing a fifth of what its shaft delivers
    expect(pumpPower({ ...base, motorEfficiency: 5 }).error).toMatch(/motor efficiency/);
    // -0.5 returned -184.7 kW
    expect(pumpPower({ ...base, motorEfficiency: -0.5 }).error).toMatch(/motor efficiency/);
    // 0 returned Infinity with no error key
    expect(pumpPower({ ...base, motorEfficiency: 0 }).error).toMatch(/motor efficiency/);
    // BOUNDARY: 1 is a real machine-shop answer and is allowed; just past is not
    const unity = pumpPower({ ...base, motorEfficiency: 1 });
    expect(unity.error).toBeUndefined();
    expect(unity.motorInputHp).toBeCloseTo(unity.brakeHp, 12);
    expect(pumpPower({ ...base, motorEfficiency: 1.0001 }).error).toMatch(/motor efficiency/);
  });

  test('npshCheck refuses an available head it cannot read', () => {
    // absent: pass false beside severity 'adequate', in one object
    expect(npshCheck({ npshrFt: 12 }).error).toMatch(/finite available NPSH/);
    expect(npshCheck({ npshaFt: NaN, npshrFt: 12 }).error).toMatch(/finite available NPSH/);
    // Infinity: pass TRUE beside severity 'adequate'
    expect(npshCheck({ npshaFt: Infinity, npshrFt: 12 }).error).toMatch(/finite available NPSH/);
    // BOUNDARY: a finite available head below required is a verdict, not a refusal
    const cavitating = npshCheck({ npshaFt: -5, npshrFt: 12 });
    expect(cavitating.error).toBeUndefined();
    expect(cavitating.severity).toBe('cavitating');
  });

  test('npshAvailable refuses unreadable suction terms and keeps negative ones', () => {
    const base = { suctionPressurePsia: 14.7, vapourPressurePsia: 0.5, sg: 0.85 };
    expect(npshAvailable({ ...base, staticSuctionLiftFt: NaN }).error).toMatch(/static suction head/);
    expect(npshAvailable({ ...base, suctionFrictionFt: NaN }).error).toMatch(/static suction head/);
    // BOUNDARY: a pump above its source is a negative static term and is legal
    const lift = npshAvailable({ ...base, staticSuctionLiftFt: -12, suctionFrictionFt: 3 });
    expect(lift.error).toBeUndefined();
    expect(lift.npshaFt).toBeCloseTo(lift.pressureHeadFt - 15, 9);
  });

  test('speedChange and impellerTrim refuse a change with no duty to change', () => {
    // all three outputs were NaN; four were, respectively
    expect(speedChange({ speedRatio: 0.8 }).error).toMatch(/needs a duty to change/);
    expect(impellerTrim({ diameterRatio: 0.8 }).error).toMatch(/needs a duty to trim/);
    // BOUNDARY: a zero-power duty is readable and is not refused
    expect(speedChange({ ...duty, brakeHp: 0, speedRatio: 0.8 }).error).toBeUndefined();
  });

  test('viscosityCorrection refuses a speed it cannot turn at', () => {
    const base = { qBepGpm: 1500, headBepFt: 300, viscosityCSt: 100 };
    // 0 gave B Infinity and every factor 0; negative gave all NaN and no warning
    expect(viscosityCorrection({ ...base, speedRpm: 0 }).error).toMatch(/positive pump speed/);
    expect(viscosityCorrection({ ...base, speedRpm: -3560 }).error).toMatch(/positive pump speed/);
    expect(viscosityCorrection({ ...base, speedRpm: 1 }).error).toBeUndefined();
  });

  test('the two bare-number converters hold a NaN contract, never Infinity', () => {
    // These have nowhere to put an error key. The contract is that they
    // return NaN and never a plausible number: sg 0 used to give Infinity.
    expect(psiToHeadFt({ psi: 100, sg: 0 })).toBeNaN();
    expect(psiToHeadFt({ psi: 100, sg: -1 })).toBeNaN();
    expect(headFtToPsi({ sg: 1 })).toBeNaN();
    expect(headFtToPsi({ headFt: 231, sg: 0 })).toBeNaN();
    // BOUNDARY: the round trip still holds where the inputs are readable
    expect(psiToHeadFt({ psi: headFtToPsi({ headFt: 231, sg: 0.85 }), sg: 0.85 })).toBeCloseTo(231, 9);
  });
});

describe('FC3-0: the numbers that were confidently wrong', () => {
  const duty = { qGpm: 1000, headFt: 300, brakeHp: 100 };

  test('P2: a duty point is not returned for a curve the module has disowned', () => {
    const rising = fitPumpCurve({
      points: [{ qGpm: 0, headFt: 100 }, { qGpm: 500, headFt: 150 }, { qGpm: 1000, headFt: 260 }],
    });
    expect(rising.droops).toBe(false);
    expect(rising.warning).toMatch(/must droop/);
    const system = systemCurve({ staticHeadFt: 50, frictionHeadFt: 60, atFlowGpm: 500 });
    // it used to return 833.333 gpm at 216.667 ft, which the studio printed
    // as its two headline figures with the warning beneath them
    const d = dutyPoint({ pump: rising, system, qMaxGpm: 3000 });
    expect(d.error).toMatch(/not a centrifugal head curve/);
    expect(d.qGpm).toBeUndefined();
    // and the disowning travels through a combination, which is the only
    // way a flag on the fit can reach a curve built out of it
    expect(dutyPoint({ pump: combineParallel({ pump: rising, n: 2 }), system, qMaxGpm: 3000 }).error)
      .toMatch(/not a centrifugal head curve/);
    // BOUNDARY: a drooping curve is still solved
    const ok = fitPumpCurve({
      points: [{ qGpm: 0, headFt: 180 }, { qGpm: 500, headFt: 168 }, { qGpm: 1000, headFt: 130 }],
    });
    expect(ok.droops).toBe(true);
    expect(dutyPoint({ pump: ok, system, qMaxGpm: 3000 }).error).toBeUndefined();
  });

  test('P4: the affinity laws still apply exactly, and the extrapolation is named', () => {
    // the law is unchanged: this is the control
    const modest = speedChange({ ...duty, speedRatio: 0.8 });
    expect(modest.qGpm).toBeCloseTo(800, 9);
    expect(modest.brakeHp).toBeCloseTo(51.2, 9);
    expect(modest.warning).toBeNull();
    // a ratio of 100 returned 100,000,000 brake hp with nothing to say so
    const wild = speedChange({ ...duty, speedRatio: 100 });
    expect(wild.brakeHp).toBe(1e8);
    expect(wild.warning).toMatch(/far outside the range/);
    // BOUNDARY: the band is inclusive at each end
    expect(speedChange({ ...duty, speedRatio: 0.5 }).warning).toBeNull();
    expect(speedChange({ ...duty, speedRatio: 1.5 }).warning).toBeNull();
    expect(speedChange({ ...duty, speedRatio: 0.49 }).warning).toMatch(/far outside/);
    expect(speedChange({ ...duty, speedRatio: 1.51 }).warning).toMatch(/far outside/);
  });

  test('P5: the efficiency a trim implies is stated instead of left to be divided out', () => {
    const deep = impellerTrim({ ...duty, diameterRatio: 0.75 });
    // head takes the whole shortfall, flow half of it, power none
    expect(deep.shortfallPct).toBe(12);
    expect(deep.impliedEfficiencyRatio).toBeCloseTo(0.94 * 0.88, 12);
    expect(deep.impliedEfficiencyRatio).toBeCloseTo(0.8272, 12);
    // and it is exactly the product a reader would form by division
    expect(deep.impliedEfficiencyRatio)
      .toBeCloseTo((deep.qGpm / deep.idealQGpm) * (deep.headFt / deep.idealHeadFt), 12);
    // BOUNDARY: with no shortfall the trim is ideal and the ratio is 1
    expect(impellerTrim({ ...duty, diameterRatio: 0.97 }).impliedEfficiencyRatio).toBe(1);
  });

  test('F8: the five percent boundary falls where the rule says, not where binary does', () => {
    // (1 - 0.95) * 100 is 5.000000000000004, so `trimPct <= 5` was false at
    // the very ratio the rule says carries no shortfall
    const at = impellerTrim({ ...duty, diameterRatio: 0.95 });
    expect(at.trimPercent).toBeGreaterThan(5);          // the float is still the float
    expect(at.shortfallPct).toBe(0);                     // the rule is not
    expect(at.headFt).toBe(at.idealHeadFt);
    expect(at.qGpm).toBe(at.idealQGpm);
    // BOUNDARY: a ten-thousandth past it and the shortfall is real again
    const past = impellerTrim({ ...duty, diameterRatio: 0.9499 });
    expect(past.shortfallPct).toBeGreaterThan(0);
    expect(past.shortfallPct).toBeCloseTo(0.006, 9);
    // the 20 percent warning boundary is exclusive by the same slack
    expect(impellerTrim({ ...duty, diameterRatio: 0.8 }).warning).toBeNull();
    expect(impellerTrim({ ...duty, diameterRatio: 0.7999 }).warning).toMatch(/beyond what most casings/);
  });

  test('G3: B is the parameter on every branch and the corrected values are always present', () => {
    const base = { qBepGpm: 1150, headBepFt: 430, speedRpm: 1780 };
    const water = viscosityCorrection({ ...base, viscosityCSt: 1 });
    // it used to report B: 0 here, a sentinel dressed as a value
    expect(water.B).toBeGreaterThan(0);
    const justOver = viscosityCorrection({ ...base, viscosityCSt: 1.000001 });
    // a millionth of a centistoke moved the reported B from 0 to 0.4257
    expect(water.B).toBeCloseTo(justOver.B, 5);
    // and the answer on a no-correction branch is the catalogue value, which
    // is a value: both keys used to be absent on exactly these rows
    expect(water.correctedQGpm).toBe(1150);
    expect(water.correctedHeadFt).toBe(430);
    expect(water.cQ).toBe(1);
    expect(justOver.correctedQGpm).toBe(1150);
    // BOUNDARY: a corrected row still corrects
    const corrected = viscosityCorrection({ ...base, viscosityCSt: 100 });
    expect(corrected.correctedQGpm).toBeLessThan(1150);
    expect(corrected.note).toBeNull();
  });

  test('G6: a machine count is a whole number of machines', () => {
    const pump = fitPumpCurve({
      points: [{ qGpm: 0, headFt: 540 }, { qGpm: 600, headFt: 512 }, { qGpm: 1200, headFt: 424 }],
    });
    // two and a half pumps in parallel used to return a curve and read a head
    expect(combineParallel({ pump, n: 2.5 }).error).toMatch(/whole number of machines/);
    expect(combineSeries({ pump, n: 1.5 }).error).toMatch(/whole number of machines/);
    expect(combineParallel({ pump, n: 0 }).error).toMatch(/whole number of machines/);
    // BOUNDARY: one machine is a machine
    expect(combineParallel({ pump, n: 1 }).error).toBeUndefined();
    expect(combineSeries({ pump, n: 3 }).headAt(1000)).toBeCloseTo(3 * pump.headAt(1000), 9);
  });

  test('G8: R squared is null when there is no variance to explain', () => {
    const flat = fitPumpCurve({
      points: [{ qGpm: 0, headFt: 140 }, { qGpm: 500, headFt: 140 }, { qGpm: 1000, headFt: 140 }],
    });
    // it used to return 1, reporting a horizontal line that explains nothing
    // as a perfect fit, beside a droop warning saying the opposite
    expect(flat.rSquared).toBeNull();
    expect(flat.warning).toMatch(/must droop/);
    // BOUNDARY: a real fit still reports a real R squared
    const real = fitPumpCurve({
      points: [{ qGpm: 0, headFt: 540 }, { qGpm: 600, headFt: 512 }, { qGpm: 1200, headFt: 424 }, { qGpm: 1900, headFt: 250 }],
    });
    expect(real.rSquared).toBeGreaterThan(0.99);
    expect(real.rSquared).toBeLessThanOrEqual(1);
  });

  test('F4: the kilowatt packaging is the derived constant, not 0.7457', () => {
    const p = pumpPower({ qGpm: 1500, headFt: 300, sg: 0.85, efficiency: 0.78, motorEfficiency: 1 });
    expect(p.motorInputKw / p.motorInputHp).toBe(KW_PER_HP);
    // the rounding it replaces was 1.722e-7 high, which is a cause and not a
    // tolerance: this asserts the direction and the size of the correction
    expect(0.7457 / KW_PER_HP).toBeCloseTo(1.0000001722110123, 15);
  });
});

describe('FC3-0: G4, the solve reports what it did', () => {
  const points = [
    { qGpm: 0, headFt: 540 }, { qGpm: 600, headFt: 512 },
    { qGpm: 1200, headFt: 424 }, { qGpm: 1900, headFt: 250 },
  ];

  test('the duty point carries the evidence of its own bisection', () => {
    const pump = fitPumpCurve({ points });
    const system = systemCurve({ staticHeadFt: 210, frictionHeadFt: 165, atFlowGpm: 1100 });
    const d = dutyPoint({ pump, system, qMaxGpm: 7500 });
    // it used to return { qGpm, headFt } and nothing else, after a fixed
    // 200 halvings, whatever had happened inside them
    expect(d.converged).toBe(true);
    expect(d.warning).toBeNull();
    expect(d.iterations).toBeGreaterThan(0);
    expect(d.iterations).toBeLessThan(200);
    expect(Math.abs(d.residualFt)).toBeLessThan(1e-9);
    // the crossing is a crossing: the two curves agree there
    expect(d.systemHeadFt).toBeCloseTo(d.headFt, 9);
  });

  test('NEGATIVE CONTROL: a curve that goes non-finite inside the bracket is not reported as converged', () => {
    // `diff(mid) > 0` is false for NaN, so every halving moved the upper
    // bound down and the loop marched quietly to the bottom of the range
    // and returned a flow with no crossing under it. A flag made only of
    // the bracket width could not have caught this, because the bracket
    // collapses perfectly well on nonsense.
    const poisoned = {
      droops: true,
      headAt: (q) => (q > 900 ? NaN : 540 - (q / 1200) ** 2 * 116),
    };
    const system = systemCurve({ staticHeadFt: 210, frictionHeadFt: 165, atFlowGpm: 1100 });
    const d = dutyPoint({ pump: poisoned, system, qMaxGpm: 7500 });
    expect(d.converged).toBe(false);
    expect(d.warning).toMatch(/crossing is not resolved/);
    // and the control is a control: the same system on a sound curve passes
    expect(dutyPoint({ pump: fitPumpCurve({ points }), system, qMaxGpm: 7500 }).converged).toBe(true);
  });

  test('the curve fit reports the conditioning of the system it solved', () => {
    const f = fitPumpCurve({ points });
    // rSquared measures the FIT; nothing measured the SOLVE. On the swept
    // catalogue sets this sits in the hundreds, which is a comfortable
    // solve in double precision.
    expect(f.conditionNumber).toBeGreaterThan(1);
    expect(f.conditionNumber).toBeLessThan(1e4);
    expect(f.conditioningNote).toBeNull();
    // and it is a measurement, not a constant: crowding the flows together
    // makes the normal equations far worse and the note fires
    const crowded = fitPumpCurve({
      points: [
        { qGpm: 1000, headFt: 500 }, { qGpm: 1001, headFt: 499.99992 },
        { qGpm: 1002, headFt: 499.99968 }, { qGpm: 1003, headFt: 499.99928 },
      ],
    });
    expect(crowded.error).toBeUndefined();
    expect(crowded.conditionNumber).toBeGreaterThan(f.conditionNumber * 1e6);
    expect(crowded.conditioningNote).toMatch(/condition number/);
    // and a set crowded past what the pivot will carry is still refused
    // outright rather than reported with a condition number
    expect(fitPumpCurve({
      points: [
        { qGpm: 1000, headFt: 500 }, { qGpm: 1000.0001, headFt: 499.99999 },
        { qGpm: 1000.0002, headFt: 499.99997 }, { qGpm: 1000.0003, headFt: 499.99994 },
      ],
    }).error).toMatch(/degenerate/);
  });
});
