// Facilities F5 separator-sizing gates against
// tools/validation/facilities/oracle_separator.py.
//
// Independent routes: the circular-segment areas come from NUMERICAL
// INTEGRATION of the chord in the oracle against the closed-form
// (theta - sin theta) here; the Stokes settling comes from the SI law
// v = g d^2 dRho / (18 mu), which CHECKS the field constant 1.78e-6
// rather than repeating it; the vessel balances are re-derived in SI.
//
// This module replaces a predecessor that hardcoded z = 0.85, used one
// K at every pressure, assumed a half-full vessel, and computed its
// gas velocity from the previous render's diameter. The gates below
// hold each of those to the fixed behaviour.

import fs from 'fs';
import path from 'path';
import {
  K_BASE, kBaseOf, kValue, gasDensityLbFt3, oilDensityLbFt3,
  terminalVelocityFtS, gasActualFt3S,
  verticalTwoPhase, horizontalSegments, horizontalTwoPhase,
  liquidLiquidSettlingFtS, horizontalThreePhase, ldSweep,
  vesselSlugCatcher, fingerSlugCatcher,
} from '../engines/facilities/separatorSizing';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'separator_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('the K value', () => {
  test('derates with pressure, floors honestly, and stays overridable', () => {
    const low = kValue({ internalsId: 'verticalMesh', pPsig: 50 });
    const high = kValue({ internalsId: 'verticalMesh', pPsig: 1100 });
    expect(low.k).toBe(0.35);
    expect(low.derated).toBe(false);
    expect(high.k).toBeCloseTo(0.35 - 0.01 * 10, 9);
    expect(high.derated).toBe(true);
    // a very high pressure hits the floor and says so
    const floored = kValue({ internalsId: 'verticalNone', pPsig: 3000 });
    expect(floored.k).toBe(0.12);
    expect(floored.warning).toMatch(/vendor K/);
    // an override wins outright
    expect(kValue({ internalsId: 'verticalMesh', pPsig: 1100, kOverride: 0.4 }).k).toBe(0.4);
    expect(kValue({ internalsId: 'nope', pPsig: 100 }).error).toBeTruthy();
  });

  test('the published table is complete and horizontal beats vertical', () => {
    expect(K_BASE).toHaveLength(6);
    expect(kBaseOf('horizontalMesh').k).toBeGreaterThan(kBaseOf('verticalMesh').k);
    expect(kBaseOf('verticalVane').k).toBeGreaterThan(kBaseOf('verticalNone').k);
  });
});

describe('fluid properties and settling', () => {
  test('gas density uses the validated z, not a hardcoded 0.85', () => {
    const r = gasDensityLbFt3({ pPsia: 1000, tF: 100, gasSg: 0.65 });
    expect(r.error).toBeUndefined();
    expect(r.z).toBeGreaterThan(0.5);
    expect(r.z).toBeLessThan(1);
    expect(r.z).not.toBe(0.85);
    // density rises with pressure faster than ideally
    const lo = gasDensityLbFt3({ pPsia: 100, tF: 100, gasSg: 0.65 });
    expect(r.rhoLbFt3 / lo.rhoLbFt3).toBeGreaterThan(10);
  });

  test('Souders-Brown matches the SI re-derivation', () => {
    G.soudersBrown.forEach((row) => {
      const r = terminalVelocityFtS({
        k: row.k, rhoLLbFt3: row.rhoLLbFt3, rhoGLbFt3: row.rhoGLbFt3,
      });
      expect(rel(r.vFtS, row.vFtS)).toBeLessThan(1e-9);
    });
    expect(terminalVelocityFtS({ k: 0.35, rhoLLbFt3: 1, rhoGLbFt3: 5 }).error).toBeTruthy();
    expect(oilDensityLbFt3(10)).toBeCloseTo(62.4, 6);
  });

  test('the Stokes field constant reproduces the SI law', () => {
    G.stokes.forEach((row) => {
      const r = liquidLiquidSettlingFtS(row);
      expect(r.error).toBeUndefined();
      // 1.78e-6 is a rounded packaging of 2 g r^2 dRho / (9 mu);
      // agreement to half a percent confirms the constant.
      expect(rel(r.vFtS, row.vFtS)).toBeLessThan(5e-3);
    });
    expect(liquidLiquidSettlingFtS({
      dropletMicron: 500, sgHeavy: 0.8, sgLight: 1.05, muCp: 2,
    }).error).toMatch(/denser/);
  });
});

describe('horizontal geometry', () => {
  test('the closed-form segment matches numerical integration of the chord', () => {
    G.segments.forEach((row) => {
      const r = horizontalSegments(row);
      expect(rel(r.areaLiquidFt2, row.areaLiquidFt2)).toBeLessThan(1e-6);
    });
  });

  test('half full is exactly half the circle, and the parts add up', () => {
    const half = horizontalSegments({ diameterFt: 8, liquidLevelFrac: 0.5 });
    expect(half.areaLiquidFt2).toBeCloseTo((Math.PI * 16) / 2, 9);
    expect(half.areaLiquidFt2 + half.areaGasFt2).toBeCloseTo(half.areaTotalFt2, 9);
    // the chord is widest at the centreline
    const low = horizontalSegments({ diameterFt: 8, liquidLevelFrac: 0.2 });
    expect(half.interfaceChordFt).toBeGreaterThan(low.interfaceChordFt);
  });
});

describe('two-phase sizing', () => {
  test('vertical matches the SI oracle', () => {
    G.vertical.forEach((row) => {
      const r = verticalTwoPhase(row);
      expect(rel(r.diameterFt, row.diameterFt)).toBeLessThan(1e-9);
      expect(rel(r.heightFt, row.heightFt)).toBeLessThan(1e-9);
    });
  });

  test('horizontal reports BOTH length requirements and names the controlling one', () => {
    G.horizontal.forEach((row) => {
      const r = horizontalTwoPhase(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.lengthGasFt, row.lengthGasFt)).toBeLessThan(1e-5);
      expect(rel(r.lengthLiquidFt, row.lengthLiquidFt)).toBeLessThan(1e-5);
      expect(r.lengthFt).toBeCloseTo(Math.max(r.lengthGasFt, r.lengthLiquidFt), 9);
      expect(['gas', 'liquid']).toContain(r.controlling);
    });
  });

  test('the gas velocity comes from the vessel being sized, not a stale one', () => {
    // the predecessor read the PREVIOUS render's diameter here
    const r = horizontalTwoPhase({
      diameterFt: 8, qGasActFt3S: 12, vTerminalFtS: 0.85,
      qLiquidBpd: 3000, retentionMin: 3,
    });
    expect(r.gasVelocityFtS).toBeCloseTo(12 / r.areaGasFt2, 9);
    expect(r.gasVelocityFtS).toBeGreaterThan(0);
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
});

describe('three-phase sizing', () => {
  const base = {
    diameterFt: 10, qGasActFt3S: 20, vTerminalFtS: 1.0,
    qOilBpd: 6000, qWaterBpd: 4000, oilRetentionMin: 5, waterRetentionMin: 5,
    sgOil: 0.85, sgWater: 1.05,
  };

  test('solves both liquid retentions against one vessel and names the winner', () => {
    const r = horizontalThreePhase(base);
    expect(r.error).toBeUndefined();
    expect(r.lengthFt).toBeCloseTo(Math.max(r.lengthOilFt, r.lengthWaterFt, r.lengthGasFt), 9);
    expect(['gas', 'oil retention', 'water retention']).toContain(r.controlling);
    expect(r.areaOilFt2 + r.areaWaterFt2).toBeCloseTo(r.areaLiquidFt2, 9);
  });

  test('a longer water retention lengthens the vessel and shifts the interface', () => {
    const short = horizontalThreePhase({ ...base, waterRetentionMin: 3 });
    const long = horizontalThreePhase({ ...base, waterRetentionMin: 20 });
    expect(long.lengthFt).toBeGreaterThan(short.lengthFt);
    expect(long.waterShare).toBeGreaterThan(short.waterShare);
  });

  test('catches the vessel that meets retention but still carries water over', () => {
    // a thick, cold oil: the water droplet cannot cross the oil layer
    const bad = horizontalThreePhase({
      ...base, muOilCp: 200, dropletMicron: 100, oilRetentionMin: 1,
    });
    expect(bad.dropChecks.waterCarryover).toBe(true);
    expect(bad.warning).toMatch(/water carryover/);
    // a light oil with generous retention is clean
    const good = horizontalThreePhase({ ...base, muOilCp: 1, dropletMicron: 500, oilRetentionMin: 15 });
    expect(good.dropChecks.waterCarryover).toBe(false);
    expect(good.warning).toBeNull();
  });

  test('refuses an interface split that leaves a layer with no area', () => {
    expect(horizontalThreePhase({ ...base, waterFracOfLiquid: 0 }).error).toBeTruthy();
    expect(horizontalThreePhase({ ...base, qOilBpd: 0, qWaterBpd: 0 }).error).toBeTruthy();
  });
});

describe('the L/D family', () => {
  test('sweeps diameters and prefers the first in the customary band', () => {
    const s = ldSweep({
      mode: 'horizontal2',
      diametersFt: [4, 6, 8, 10, 12],
      qGasActFt3S: 30, vTerminalFtS: 1.1, qLiquidBpd: 12000, retentionMin: 5,
    });
    expect(s.rows).toHaveLength(5);
    // slenderness falls as the vessel fattens
    const lds = s.rows.map((r) => r.ldRatio);
    for (let i = 1; i < lds.length; i += 1) expect(lds[i]).toBeLessThan(lds[i - 1]);
    if (s.preferred) {
      expect(s.preferred.ldRatio).toBeGreaterThanOrEqual(3);
      expect(s.preferred.ldRatio).toBeLessThanOrEqual(5);
    }
    expect(ldSweep({ mode: 'nope', diametersFt: [8] }).error).toBeTruthy();
  });
});

describe('slug catchers', () => {
  test('vessel type matches the SI oracle', () => {
    G.vesselSlug.forEach((row) => {
      const r = vesselSlugCatcher(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.diameterFt, row.diameterFt)).toBeLessThan(1e-9);
      expect(rel(r.lengthFt, row.lengthFt)).toBeLessThan(1e-9);
      expect(rel(r.totalVolumeFt3, row.totalVolumeFt3)).toBeLessThan(1e-9);
    });
  });

  test('finger type matches the oracle and warns on a very long harp', () => {
    G.fingerSlug.forEach((row) => {
      const r = fingerSlugCatcher(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.fingerLengthFt, row.fingerLengthFt)).toBeLessThan(1e-9);
    });
    const long = fingerSlugCatcher({ slugBbl: 5000, fingerIdIn: 12, nFingers: 2 });
    expect(long.warning).toMatch(/add fingers/);
    expect(fingerSlugCatcher({ slugBbl: 0, fingerIdIn: 12, nFingers: 2 }).error).toBeTruthy();
    expect(vesselSlugCatcher({ slugBbl: 200, fillFraction: 1.2 }).error).toBeTruthy();
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
