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
    expect(operatingRegion({ qGpm: 1300, qBepGpm: 1000 }).note).toMatch(/NPSH required climbs/);
    const throttled = operatingRegion({ qGpm: 300, qBepGpm: 1000 });
    expect(throttled.region).toBe('outside');
    expect(throttled.note).toMatch(/variable speed drive/);
    expect(operatingRegion({ qGpm: 100, qBepGpm: 0 }).error).toBeTruthy();
  });
});
