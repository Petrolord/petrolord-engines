// Facilities F5 separator-sizing gates against
// tools/validation/facilities/oracle_separator.py.
//
// Independent routes: the circular-segment areas come from NUMERICAL
// INTEGRATION of the chord and from an alternative closed form in the
// oracle against (theta - sin theta) here; the oil-water interface
// height from NEWTON in the oracle against bisection here; the Stokes
// settling from the SI law, which CHECKS the 1.78e-6 field constant;
// the K derating in exact rational arithmetic; DAK z by bisection in
// the oracle against Newton here; the vessel balances in SI.
//
// FC1-0 (2026-09-15) repaired D1-D9. Every retired rule has a NEGATIVE
// CONTROL below: the golden carries what the old rule gave, and the
// gate shows the engine no longer gives it.

import fs from 'fs';
import path from 'path';
import {
  K_BASE, K_FLOOR, kBaseOf, kValue, gasDensityLbFt3, oilDensityLbFt3,
  terminalVelocityFtS, gasActualFt3S, SeparatorInputError,
  verticalTwoPhase, horizontalSegments, horizontalTwoPhase, segmentHeightForAreaFt,
  liquidLiquidSettlingFtS, horizontalThreePhase, ldSweep,
  vesselSlugCatcher, fingerSlugCatcher,
} from '../engines/facilities/separatorSizing';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'separator_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

/** Assert a SeparatorInputError naming `input` (and matching `re`). */
const refuses = (fn, input, re) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(SeparatorInputError);
  expect(err.input).toBe(input);
  expect(err.message).toContain(input);
  if (re) expect(err.message).toMatch(re);
};

const THREE = {
  diameterFt: 10, qGasActFt3S: 20, vTerminalFtS: 1.0,
  qOilBpd: 6000, qWaterBpd: 4000, oilRetentionMin: 5, waterRetentionMin: 5,
  sgOil: 0.85, sgWater: 1.05, muOilCp: 2, muWaterCp: 0.7,
  waterDropletMicron: 500, oilDropletMicron: 200,
};

describe('the K value', () => {
  test.each(G.kValue.map((c) => [c.name, c]))('%s matches the exact derating', (_, c) => {
    const r = kValue(c.input);
    expect(rel(r.k, c.expected.k)).toBeLessThan(1e-12);
    expect(rel(r.kDerated, c.expected.kDerated)).toBeLessThan(1e-12);
    expect(r.floored).toBe(c.expected.floored);
    expect(r.derated).toBe(c.expected.derated);
    if (c.expected.floored) {
      expect(r.k).toBe(K_FLOOR);
      expect(r.warning).toMatch(/0\.12 floor bound/);
      expect(r.warning).toMatch(/vendor K/);
    } else {
      expect(r.warning).toBeNull();
    }
  });

  test('an override wins outright', () => {
    const r = kValue({ internalsId: 'verticalMesh', pPsig: 1100, kOverride: 0.4 });
    expect(r.k).toBe(0.4);
    expect(r.source).toBe('typed');
    // with an override the mist extractor is not needed
    expect(kValue({ kOverride: 0.3 }).k).toBe(0.3);
  });

  test('D6 NEGATIVE CONTROL: a zero or negative override is refused, not ignored', () => {
    // the retired rule silently fell back to the table for kOverride 0
    refuses(() => kValue({ internalsId: 'verticalMesh', pPsig: 100, kOverride: 0 }), 'kOverride');
    refuses(() => kValue({ internalsId: 'verticalMesh', pPsig: 100, kOverride: -0.2 }), 'kOverride');
    refuses(() => kValue({ internalsId: 'verticalMesh', pPsig: 100, kOverride: NaN }), 'kOverride');
  });

  test('D6 NEGATIVE CONTROL: a missing or unknown mist extractor is refused by name', () => {
    // the retired default made a missing internalsId a vertical mesh pad
    refuses(() => kValue({ pPsig: 100 }), 'internalsId', /required/);
    refuses(() => kValue({ internalsId: 'nope', pPsig: 100 }), 'internalsId', /not a mist extractor/);
    refuses(() => kValue({ internalsId: 'verticalMesh', pPsig: -5 }), 'pPsig');
  });

  test('the published table is complete and horizontal beats vertical', () => {
    expect(K_BASE).toHaveLength(6);
    expect(kBaseOf('horizontalMesh').k).toBeGreaterThan(kBaseOf('verticalMesh').k);
    expect(kBaseOf('verticalVane').k).toBeGreaterThan(kBaseOf('verticalNone').k);
  });
});

describe('gas density inside the DAK validity range', () => {
  test.each(G.gasDensity.map((c) => [c.name, c]))('%s', (_, c) => {
    const r = gasDensityLbFt3(c.input);
    expect(rel(r.tpr, c.expected.tpr)).toBeLessThan(1e-12);
    expect(rel(r.ppr, c.expected.ppr)).toBeLessThan(1e-12);
    if (c.expected.status === 'ok') {
      expect(r.error).toBeUndefined();
      // Newton here, bisection in the oracle
      expect(rel(r.z, c.expected.z)).toBeLessThan(1e-9);
      // the field constant 10.7316 against the SI gas constant
      expect(rel(r.rhoLbFt3, c.expected.rhoLbFt3)).toBeLessThan(1e-5);
      expect(r.note === null).toBe(!c.expected.pprBelowFit);
    } else {
      expect(r.rhoLbFt3).toBeUndefined();
      const word = {
        'refused-tpr-below-range': /Tpr .* below the DAK validity range of 1\.0 to 3\.0/,
        'refused-tpr-above-range': /Tpr .* above the DAK validity range of 1\.0 to 3\.0/,
        'refused-ppr-above-range': /Ppr .* above the DAK validity limit of 30/,
      }[c.expected.status];
      expect(r.error).toMatch(word);
    }
  });

  test('D7 NEGATIVE CONTROL: Tpr 0.75 is refused where the retired code returned a z', () => {
    // sg 0.65 has Tpc 370.2 R, so Tpr 0.75 is about -182 degF
    const tF = 0.75 * (169.2 + 349.5 * 0.65 - 74 * 0.65 * 0.65) - 459.67;
    const r = gasDensityLbFt3({ pPsia: 500, tF, gasSg: 0.65 });
    expect(r.error).toMatch(/below the DAK validity range/);
    expect(r.error).not.toMatch(/Tpr 1\.000/);
    expect(r.z).toBeUndefined();
  });

  test('D7 NEGATIVE CONTROL: non-finite inputs are refused by name, where NaN pressure gave z = 1', () => {
    refuses(() => gasDensityLbFt3({ pPsia: NaN, tF: 100, gasSg: 0.65 }), 'pPsia');
    refuses(() => gasDensityLbFt3({ pPsia: 0, tF: 100, gasSg: 0.65 }), 'pPsia');
    refuses(() => gasDensityLbFt3({ pPsia: 500, tF: undefined, gasSg: 0.65 }), 'tF');
    refuses(() => gasDensityLbFt3({ pPsia: 500, tF: 100, gasSg: Infinity }), 'gasSg');
  });

  test('density rises with pressure faster than ideally', () => {
    const hi = gasDensityLbFt3({ pPsia: 1000, tF: 100, gasSg: 0.65 });
    const lo = gasDensityLbFt3({ pPsia: 100, tF: 100, gasSg: 0.65 });
    expect(hi.rhoLbFt3 / lo.rhoLbFt3).toBeGreaterThan(10);
    expect(hi.z).not.toBe(0.85);
  });
});

describe('settling', () => {
  test('Souders-Brown matches the SI re-derivation', () => {
    G.soudersBrown.forEach((c) => {
      const r = terminalVelocityFtS(c.input);
      expect(rel(r.vFtS, c.expected.vFtS)).toBeLessThan(1e-9);
    });
    expect(terminalVelocityFtS({ k: 0.35, rhoLLbFt3: 1, rhoGLbFt3: 5 }).error).toBeTruthy();
    expect(oilDensityLbFt3(10)).toBeCloseTo(62.4, 6);
  });

  test('the Stokes field constant reproduces the SI law', () => {
    G.stokes.forEach((c) => {
      const r = liquidLiquidSettlingFtS(c.input);
      expect(r.error).toBeUndefined();
      // 1.78e-6 is a rounded packaging of g d^2 dRho / (18 mu)
      expect(rel(r.vFtS, c.expected.vFtS)).toBeLessThan(5e-3);
    });
    expect(liquidLiquidSettlingFtS({
      dropletMicron: 500, sgHeavy: 0.8, sgLight: 1.05, muCp: 2,
    }).error).toMatch(/denser/);
  });
});

describe('horizontal geometry', () => {
  test('the closed-form segment matches numerical integration of the chord', () => {
    G.segments.forEach((c) => {
      const r = horizontalSegments(c.input);
      expect(rel(r.areaLiquidFt2, c.expected.areaLiquidFt2)).toBeLessThan(1e-6);
    });
  });

  test('half full is exactly half the circle, and the gas-liquid chord is named for what it is', () => {
    const half = horizontalSegments({ diameterFt: 8, liquidLevelFrac: 0.5 });
    expect(half.areaLiquidFt2).toBeCloseTo((Math.PI * 16) / 2, 9);
    expect(half.areaLiquidFt2 + half.areaGasFt2).toBeCloseTo(half.areaTotalFt2, 9);
    expect(half.gasLiquidChordFt).toBeCloseTo(8, 12);
    expect(half.interfaceChordFt).toBeUndefined();
  });

  test('the interface inversion recovers the depth of a known segment', () => {
    [0.05, 0.25, 0.5, 0.8, 0.97].forEach((f) => {
      const seg = horizontalSegments({ diameterFt: 10, liquidLevelFrac: f });
      const h = segmentHeightForAreaFt({ diameterFt: 10, areaFt2: seg.areaLiquidFt2 }).heightFt;
      expect(Math.abs(h - f * 10)).toBeLessThan(1e-9);
    });
  });

  test('D8 NEGATIVE CONTROL: a liquid level outside (0, 1) is refused, not clamped', () => {
    // the retired clamp turned 0 into 0.01 and 1.2 into 0.99
    [0, 1, 1.2, -0.1, NaN].forEach((f) => {
      refuses(() => horizontalSegments({ diameterFt: 8, liquidLevelFrac: f }), 'liquidLevelFrac');
    });
  });
});

describe('two-phase sizing', () => {
  test('vertical matches the SI oracle', () => {
    G.vertical.forEach((c) => {
      const r = verticalTwoPhase(c.input);
      expect(rel(r.diameterFt, c.expected.diameterFt)).toBeLessThan(1e-9);
      expect(rel(r.heightFt, c.expected.heightFt)).toBeLessThan(1e-9);
      expect(r.gasCapacityOk).toBe(true);
    });
  });

  test('horizontal matches the oracle on physical vessels, liquid controlled and in band', () => {
    G.horizontal.forEach((c) => {
      const r = horizontalTwoPhase(c.input);
      expect(r.error).toBeUndefined();
      expect(rel(r.lengthGasFt, c.expected.lengthGasFt)).toBeLessThan(1e-5);
      expect(rel(r.lengthLiquidFt, c.expected.lengthLiquidFt)).toBeLessThan(1e-5);
      expect(r.controlling).toBe(c.expected.controlling);
      expect(r.gasCapacityOk).toBe(c.expected.gasCapacityOk);
      // a physical vessel: longer than it is wide and inside the band
      expect(r.ldRatio).toBeGreaterThanOrEqual(3);
      expect(r.ldRatio).toBeLessThanOrEqual(5);
    });
  });

  test('the gas velocity comes from the vessel being sized', () => {
    const r = horizontalTwoPhase({
      diameterFt: 8, qGasActFt3S: 12, vTerminalFtS: 0.85,
      qLiquidBpd: 3000, retentionMin: 3,
    });
    expect(r.gasVelocityFtS).toBeCloseTo(12 / r.areaGasFt2, 9);
    expect(r.gasVelocityMargin).toBeCloseTo(0.85 / r.gasVelocityFtS, 12);
  });

  test('a bigger vessel needs less length and lowers the gas velocity', () => {
    const args = {
      qGasActFt3S: 30, vTerminalFtS: 1.1, qLiquidBpd: 12000, retentionMin: 5,
    };
    const small = horizontalTwoPhase({ ...args, diameterFt: 8 });
    const big = horizontalTwoPhase({ ...args, diameterFt: 12 });
    expect(big.lengthFt).toBeLessThan(small.lengthFt);
    expect(big.gasVelocityFtS).toBeLessThan(small.gasVelocityFtS);
  });

  test('FINDING: under the held method gas can control only a vessel it overloads or one shorter than its diameter', () => {
    // Lgas = (vGas / vT) * gasHeight, so vGas <= vT gives Lgas <= gasHeight < D
    [4, 6, 8, 12].forEach((d) => [0.3, 0.5, 0.7].forEach((f) => {
      const r = horizontalTwoPhase({
        diameterFt: d, qGasActFt3S: 15, vTerminalFtS: 0.9, qLiquidBpd: 100, retentionMin: 1, liquidLevelFrac: f,
      });
      if (r.gasCapacityOk) expect(r.lengthGasFt).toBeLessThanOrEqual(r.gasHeightFt + 1e-12);
    }));
  });
});

describe('three-phase sizing', () => {
  const checkThree = (r, e) => {
    expect(r.error).toBeUndefined();
    expect(r.interfaceSplit).toBe(e.interfaceSplit);
    expect(rel(r.waterShare, e.waterShare)).toBeLessThan(1e-12);
    expect(rel(r.areaWaterFt2, e.areaWaterFt2)).toBeLessThan(1e-9);
    expect(rel(r.areaOilFt2, e.areaOilFt2)).toBeLessThan(1e-9);
    // bisection here, Newton on a different closed form in the oracle
    expect(rel(r.interfaceHeightFt, e.interfaceHeightFt)).toBeLessThan(1e-9);
    expect(rel(r.waterLayerFt, e.waterLayerFt)).toBeLessThan(1e-9);
    expect(rel(r.oilLayerFt, e.oilLayerFt)).toBeLessThan(1e-9);
    expect(rel(r.liquidRetentionLengthFt, e.liquidRetentionLengthFt)).toBeLessThan(1e-9);
    expect(rel(r.lengthGasFt, e.lengthGasFt)).toBeLessThan(1e-9);
    expect(rel(r.lengthFt, e.lengthFt)).toBeLessThan(1e-9);
    expect(r.controlling).toBe(e.controlling);
    expect(r.retentionPhase).toBe(e.retentionPhase);
    expect(r.gasCapacityOk).toBe(e.gasCapacityOk);
    if (e.phaseRetentionLengthsFt) {
      expect(rel(r.phaseRetentionLengthsFt.oilFt, e.phaseRetentionLengthsFt.oilFt)).toBeLessThan(1e-9);
      expect(rel(r.phaseRetentionLengthsFt.waterFt, e.phaseRetentionLengthsFt.waterFt)).toBeLessThan(1e-9);
    } else {
      expect(r.phaseRetentionLengthsFt).toBeNull();
    }
    const d = r.dropChecks;
    ['waterDropFallS', 'oilDropRiseS', 'residenceOilS', 'residenceWaterS'].forEach((k) => {
      expect(rel(d[k], e.dropChecks[k])).toBeLessThan(1e-9);
    });
    expect(d.waterCarryover).toBe(e.dropChecks.waterCarryover);
    expect(d.oilCarryunder).toBe(e.dropChecks.oilCarryunder);
  };

  test.each(G.threePhase.map((c) => [c.name, c]))('%s matches the oracle', (_, c) => {
    checkThree(horizontalThreePhase(c.input), c.expected);
  });

  test('D2 NEGATIVE CONTROL: the water layer is 2.54 ft on the probe, where the chord rule gave 1.57 ft', () => {
    const c = G.threePhase.find((x) => x.name === 'd2Probe10ftHalfFull40pctWaterExplicit');
    const r = horizontalThreePhase(c.input);
    expect(r.waterLayerFt).toBeCloseTo(2.5407, 4);
    expect(c.expected.retiredChordRule.waterLayerFt).toBeCloseTo(Math.PI / 2, 12);
    // the golden discriminates: the two rules differ by far more than the gate tolerance
    expect(rel(r.waterLayerFt, c.expected.retiredChordRule.waterLayerFt)).toBeGreaterThan(0.5);
    expect(r.oilLayerFt + r.waterLayerFt).toBeCloseTo(r.liquidLevelFt, 12);
  });

  test('D3 NEGATIVE CONTROL: the proportional split reports one retention requirement and no phase label', () => {
    const r = horizontalThreePhase(THREE);
    // the retired code labelled 'oil retention' or 'water retention' on a float tie
    expect(r.controlling).toBe('liquid-retention');
    expect(r.retentionPhase).toBeNull();
    expect(r.phaseRetentionLengthsFt).toBeNull();
    expect(r.lengthOilFt).toBeUndefined();
    expect(r.lengthWaterFt).toBeUndefined();
  });

  test('D3: an explicit split that makes the phases differ names the phase', () => {
    const r = horizontalThreePhase({ ...THREE, waterFracOfLiquid: 0.25 });
    expect(r.retentionPhase).toBe('water');
    expect(r.phaseRetentionLengthsFt.waterFt).toBeGreaterThan(r.phaseRetentionLengthsFt.oilFt);
  });

  test('residence times belong to the sized vessel and set the verdicts', () => {
    const r = horizontalThreePhase(THREE);
    const qOilFt3S = (6000 * 5.614583333333333) / 86400;
    expect(r.dropChecks.residenceOilS).toBeCloseTo((r.areaOilFt2 * r.lengthFt) / qOilFt3S, 6);
    // a gas-controlled vessel is longer than retention needs, so the oil stays longer
    const g = G.threePhase.find((x) => x.name === 'gasOverloaded6ftGasControls');
    const rg = horizontalThreePhase(g.input);
    expect(rg.dropChecks.residenceOilS).toBeGreaterThan(g.input.oilRetentionMin * 60 * 10);
  });

  test('carryover and carryunder each raise a warning', () => {
    const w = horizontalThreePhase(G.threePhase.find((x) => x.name === 'thickOilWaterCarryover').input);
    expect(w.warning).toMatch(/water carryover/);
    const o = horizontalThreePhase(G.threePhase.find((x) => x.name === 'lowLevelSmallOilDropCarryunder').input);
    expect(o.warning).toMatch(/oil carryunder/);
    expect(horizontalThreePhase(THREE).warning).toBeNull();
  });

  test('D4 NEGATIVE CONTROL: missing fluid data and droplet sizes are refused by name', () => {
    // the retired code read a missing sgOil as "no carryover" and defaulted the drop to 500 microns
    ['sgOil', 'sgWater', 'muOilCp', 'muWaterCp', 'waterDropletMicron', 'oilDropletMicron',
      'qOilBpd', 'qWaterBpd', 'oilRetentionMin', 'waterRetentionMin'].forEach((name) => {
      const args = { ...THREE };
      delete args[name];
      refuses(() => horizontalThreePhase(args), name, /required/);
    });
    refuses(() => horizontalThreePhase({ ...THREE, sgWater: 0.8 }), 'sgWater', /must exceed sgOil/);
    refuses(() => horizontalThreePhase({ ...THREE, dropletMicron: 500 }), 'dropletMicron', /retired/);
    refuses(() => horizontalThreePhase({ ...THREE, waterFracOfLiquid: 0 }), 'waterFracOfLiquid');
  });

  test('D5 NEGATIVE CONTROL: a non-positive settling velocity is refused as two-phase refuses it', () => {
    // the retired code returned lengthGasFt 0 and sized on the liquid alone
    const r = horizontalThreePhase({ ...THREE, vTerminalFtS: 0 });
    const two = horizontalTwoPhase({
      diameterFt: 10, qGasActFt3S: 20, vTerminalFtS: 0, qLiquidBpd: 100, retentionMin: 3,
    });
    expect(r.error).toBe(two.error);
    expect(r.lengthGasFt).toBeUndefined();
  });
});

describe('the L/D family', () => {
  test.each(G.sweep.map((c) => [c.name, c]))('%s matches the oracle', (_, c) => {
    const s = ldSweep(c.input);
    expect(s.rows.map((r) => r.diameterFt)).toEqual(c.expected.rows.map((r) => r.diameterFt));
    s.rows.forEach((r, i) => {
      const e = c.expected.rows[i];
      expect(rel(r.lengthFt, e.lengthFt)).toBeLessThan(1e-9);
      expect(rel(r.ldRatio, e.ldRatio)).toBeLessThan(1e-9);
      expect(r.feasible).toBe(e.feasible);
      expect(r.inRange).toBe(e.inRange);
      expect(r.reasons).toEqual(e.reasons);
    });
    expect(s.preferred ? s.preferred.diameterFt : null).toBe(c.expected.preferredDiameterFt);
    expect(s.preferredStatus).toBe(c.expected.preferredStatus);
  });

  test('D1 NEGATIVE CONTROL: every sweep golden disagrees with the retired first-in-band rule', () => {
    G.sweep.forEach((c) => {
      const s = ldSweep(c.input);
      expect(c.expected.retiredPreferredDiameterFt).not.toBeNull();
      expect(s.preferred ? s.preferred.diameterFt : null)
        .not.toBe(c.expected.retiredPreferredDiameterFt);
    });
    // the probe itself: 4 ft at velocity margin 0.34 against a 6.91 ft requirement
    const probe = ldSweep(G.sweep.find((x) => x.name === 'd1ProbeVertical4ftGasOverloaded').input);
    const four = probe.rows[0];
    expect(four.inRange).toBe(true);
    expect(four.feasible).toBe(false);
    expect(four.reasons).toEqual(['gas-capacity']);
    expect(four.result.velocityMargin).toBeCloseTo(0.335, 3);
    expect(four.result.diameterGasFt).toBeCloseTo(6.91, 2);
    expect(probe.preferred).toBeNull();
  });

  test('refuses what cannot be swept', () => {
    expect(ldSweep({ mode: 'nope', diametersFt: [8] }).error).toBeTruthy();
    refuses(() => ldSweep({ mode: 'horizontal2', diametersFt: [] }), 'diametersFt');
    refuses(() => ldSweep({ mode: 'horizontal2', diametersFt: [8, -1] }), 'diametersFt');
    refuses(() => ldSweep({
      mode: 'horizontal2', diametersFt: [8], ldMin: 5, ldMax: 3,
    }), 'ldMax');
  });
});

describe('slug catchers', () => {
  test('vessel type matches the SI oracle', () => {
    G.vesselSlug.forEach((c) => {
      const r = vesselSlugCatcher(c.input);
      expect(r.error).toBeUndefined();
      expect(rel(r.diameterFt, c.expected.diameterFt)).toBeLessThan(1e-9);
      expect(rel(r.lengthFt, c.expected.lengthFt)).toBeLessThan(1e-9);
      expect(rel(r.totalVolumeFt3, c.expected.totalVolumeFt3)).toBeLessThan(1e-9);
    });
  });

  test('finger type matches the oracle and warns on a very long harp', () => {
    G.fingerSlug.forEach((c) => {
      const r = fingerSlugCatcher(c.input);
      expect(r.error).toBeUndefined();
      expect(rel(r.fingerLengthFt, c.expected.fingerLengthFt)).toBeLessThan(1e-9);
    });
    const long = fingerSlugCatcher({ slugBbl: 5000, fingerIdIn: 12, nFingers: 2 });
    expect(long.warning).toMatch(/add fingers/);
    expect(fingerSlugCatcher({ slugBbl: 0, fingerIdIn: 12, nFingers: 2 }).error).toBeTruthy();
    expect(vesselSlugCatcher({ slugBbl: 200, fillFraction: 1.2 }).error).toBeTruthy();
  });

  test('D9 NEGATIVE CONTROL: bad L/D, hold time and finger count are refused by name', () => {
    refuses(() => vesselSlugCatcher({ slugBbl: 200, ldRatio: 0 }), 'ldRatio');
    refuses(() => vesselSlugCatcher({ slugBbl: 200, ldRatio: -4 }), 'ldRatio');
    refuses(() => vesselSlugCatcher({ slugBbl: 200, holdMin: -5 }), 'holdMin');
    refuses(() => vesselSlugCatcher({ slugBbl: 200, qLiquidBpd: -100 }), 'qLiquidBpd');
    refuses(() => fingerSlugCatcher({ slugBbl: 500, fingerIdIn: 16, nFingers: 2.5 }), 'nFingers');
    refuses(() => fingerSlugCatcher({ slugBbl: 500, fingerIdIn: 16, nFingers: 0 }), 'nFingers');
    refuses(() => fingerSlugCatcher({ slugBbl: 500, fingerIdIn: 16 }), 'nFingers');
  });

  test('more fingers or a bigger bore shortens each one', () => {
    const few = fingerSlugCatcher({ slugBbl: 1500, fingerIdIn: 24, nFingers: 4 });
    const many = fingerSlugCatcher({ slugBbl: 1500, fingerIdIn: 24, nFingers: 8 });
    expect(many.fingerLengthFt).toBeCloseTo(few.fingerLengthFt / 2, 9);
    expect(many.totalPipeFt).toBeCloseTo(few.totalPipeFt, 9);
  });
});

describe('the actual-rate conversion', () => {
  test('gas shrinks with pressure and grows with temperature', () => {
    const base = { qGasMMscfd: 30, tF: 100, z: 0.9 };
    const lo = gasActualFt3S({ ...base, pPsia: 1000 });
    const hi = gasActualFt3S({ ...base, pPsia: 500 });
    expect(hi).toBeGreaterThan(lo);
    const hot = gasActualFt3S({ ...base, pPsia: 1000, tF: 200 });
    expect(hot).toBeGreaterThan(lo);
  });
});

describe('user-facing strings', () => {
  test('carry no em dashes', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'engines', 'facilities', 'separatorSizing.js'), 'utf8',
    );
    expect(src).not.toMatch(/—/);
  });
});
