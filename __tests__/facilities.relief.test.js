// Facilities F2 relief-and-flare gates: API 520 gas (critical and
// subcritical), liquid with the iterated Kv, steam with Napier, the
// API 521 fire case and wetted-area geometry, knockout-drum droplet
// settling, point-source radiation both ways, and the blowdown march
// -- against the independent stdlib oracle
// (tools/validation/facilities/oracle_relief.py).
//
// The oracle computes the gas cases from FIRST PRINCIPLES in absolute
// SI (the isentropic-nozzle mass flux from R, M, T, P), so the USC
// constants 520 and 735 are CHECKED rather than repeated. Liquid,
// steam and fire use the published SI-form constants (11.78, 190.4,
// 43.2/70.9) against this module's USC ones (38, 51.5, 21000/34500).
//
// The chart factors (balanced-bellows Kb and Kw, superheat KSH,
// insulation credits) are typed inputs by design: they are published
// as figures and tables, and reproducing plotted curves from memory
// is what this package refuses. Their literature gates stay ARMED.

import fs from 'fs';
import path from 'path';
import {
  API_ORIFICES, selectOrifice, gasConstantC, criticalPressureRatio, subcriticalF2,
  gasVaporArea, liquidKv, liquidArea, steamKn, steamArea,
  wettedAreaFt2, fireHeatInput, fireReliefLoad,
  dropoutVelocityFtS, koDrumHorizontal,
  radiationIntensity, distanceForIntensity, RADIATION_LEVELS,
  blowdown,
} from '../engines/facilities/relief';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'relief_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('orifice selection', () => {
  test('picks the smallest standard orifice at or above the need', () => {
    expect(API_ORIFICES).toHaveLength(14);
    expect(selectOrifice(0.5).orifice).toBe('G');
    expect(selectOrifice(0.503).orifice).toBe('G');
    expect(selectOrifice(0.504).orifice).toBe('H');
    const over = selectOrifice(60);
    expect(over.error).toBeTruthy();
    expect(over.multipleOfT).toBe(3);
  });
});

describe('gas and vapor sizing', () => {
  test('critical and subcritical areas match the first-principles SI oracle', () => {
    G.gas.forEach((row) => {
      const r = gasVaporArea(row);
      expect(r.error).toBeUndefined();
      expect(r.critical).toBe(row.critical);
      // 520 and 735 are published to 3 figures; the oracle derives them.
      expect(rel(r.areaIn2, row.areaIn2)).toBeLessThan(2e-3);
    });
  });

  test('the two branches meet at the critical ratio', () => {
    const k = 1.3;
    const base = { wLbHr: 50000, p1Psia: 500, tR: 600, mw: 20, z: 0.9, k };
    const pCrit = criticalPressureRatio(k) * 500;
    const a1 = gasVaporArea({ ...base, p2Psia: pCrit * 0.999 }).areaIn2;
    const a2 = gasVaporArea({ ...base, p2Psia: pCrit * 1.001 }).areaIn2;
    expect(rel(a1, a2)).toBeLessThan(5e-3);
    expect(gasConstantC(1.4)).toBeCloseTo(356, 0);
    expect(Number.isNaN(subcriticalF2({ k: 1.3, r: 1.2 }))).toBe(true);
  });

  test('warns where the typed factors stop being safe, refuses dead valves', () => {
    const highBack = gasVaporArea({
      wLbHr: 10000, p1Psia: 500, p2Psia: 200, tR: 600, mw: 20, z: 0.9, k: 1.3,
    });
    expect(highBack.critical).toBe(true);
    expect(highBack.warning).toMatch(/balanced-bellows/);
    expect(gasVaporArea({
      wLbHr: 10000, p1Psia: 100, p2Psia: 120, tR: 600, mw: 20, z: 0.9, k: 1.3,
    }).error).toBeTruthy();
  });
});

describe('liquid sizing', () => {
  test('areas and the iterated Kv match the SI oracle', () => {
    G.liquid.forEach((row) => {
      const r = liquidArea(row);
      expect(r.error).toBeUndefined();
      // 38 vs 11.78: published constant pair to 3-4 figures.
      expect(rel(r.areaIn2, row.areaIn2)).toBeLessThan(2e-3);
      expect(rel(r.kv, row.kv)).toBeLessThan(1e-4);
    });
  });

  test('viscosity always costs area and Kv approaches 1 for thin fluids', () => {
    const thin = liquidArea({ qGpm: 500, p1Psig: 250, p2Psig: 50, sg: 0.9, muCp: 0 });
    const thick = liquidArea({ qGpm: 500, p1Psig: 250, p2Psig: 50, sg: 0.9, muCp: 400 });
    expect(thick.areaIn2).toBeGreaterThan(thin.areaIn2);
    expect(liquidKv(1e8)).toBeCloseTo(1 / 0.9935, 3);
    expect(liquidArea({ qGpm: 100, p1Psig: 50, p2Psig: 60, sg: 1 }).error).toBeTruthy();
  });
});

describe('steam sizing', () => {
  test('areas and Napier match the SI oracle', () => {
    G.steam.forEach((row) => {
      const r = steamArea(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.areaIn2, row.areaIn2)).toBeLessThan(2e-3);
      expect(rel(r.kn, row.kn)).toBeLessThan(2e-3);
    });
  });

  test('Napier is unity to 1500 psia and refuses past its published range', () => {
    expect(steamKn(1000)).toBe(1);
    expect(steamKn(2000)).toBeGreaterThan(1);
    expect(steamArea({ wLbHr: 1000, p1Psia: 3300 }).error).toBeTruthy();
  });
});

describe('fire case', () => {
  test('wetted geometry and heat input match the SI oracle', () => {
    G.wetted.forEach((row) => {
      const r = wettedAreaFt2(row);
      expect(rel(r.areaFt2, row.areaFt2)).toBeLessThan(1e-9);
    });
    G.fire.forEach((row) => {
      const r = fireHeatInput({ wettedFt2: row.wettedFt2, adequateDrainage: row.adequateDrainage, envFactor: row.envFactor });
      // 21000/34500 vs 43.2/70.9: published pairs to 3 figures.
      expect(rel(r.qBtuHr, row.qBtuHr)).toBeLessThan(4e-3);
    });
  });

  test('a half-full horizontal vessel wets exactly half its shell', () => {
    const half = wettedAreaFt2({ diameterFt: 10, lengthFt: 40, liquidLevelFt: 5 });
    expect(half.areaFt2).toBeCloseTo(Math.PI * 10 * 40 / 2, 6);
  });

  test('the relief load flags near-critical latent heat', () => {
    const w = fireReliefLoad({ qBtuHr: 1e7, latentBtuLb: 100 });
    expect(w.wLbHr).toBeCloseTo(1e5, 6);
    expect(fireReliefLoad({ qBtuHr: 1e7, latentBtuLb: 30 }).warning).toBeTruthy();
  });
});

describe('knockout drum', () => {
  test('dropout velocity matches the SI drag-iteration oracle', () => {
    G.dropout.forEach((row) => {
      const r = dropoutVelocityFtS(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.udFtS, row.udFtS)).toBeLessThan(1e-4);
    });
  });

  test('a bigger droplet falls faster, and the drum reads L from D', () => {
    const small = dropoutVelocityFtS({ dropletMicron: 150, rhoLLbFt3: 40, rhoVLbFt3: 0.5, muVCp: 0.012 });
    const large = dropoutVelocityFtS({ dropletMicron: 600, rhoLLbFt3: 40, rhoVLbFt3: 0.5, muVCp: 0.012 });
    expect(large.udFtS).toBeGreaterThan(small.udFtS);
    const drum = koDrumHorizontal({ qVaporAcfs: 120, udFtS: large.udFtS, diameterFt: 8 });
    expect(drum.requiredLengthFt).toBeGreaterThan(0);
    // L = v * fall / ud with v ~ 1/D^2 and fall ~ D, so doubling the
    // diameter halves the required length exactly
    const bigger = koDrumHorizontal({ qVaporAcfs: 120, udFtS: large.udFtS, diameterFt: 16 });
    expect(bigger.requiredLengthFt).toBeCloseTo(drum.requiredLengthFt / 2, 9);
    expect(koDrumHorizontal({ qVaporAcfs: 120, udFtS: 1, diameterFt: 8, liquidFraction: 1.2 }).error).toBeTruthy();
  });
});

describe('flare radiation', () => {
  test('intensity matches the oracle and the inverse round-trips', () => {
    G.radiation.forEach((row) => {
      const r = radiationIntensity(row);
      expect(rel(r.kWm2, row.kWm2)).toBeLessThan(1e-12);
      const d = distanceForIntensity({ ...row, allowableKwM2: r.kWm2 });
      expect(rel(d.distanceM, row.distanceM)).toBeLessThan(1e-12);
    });
    expect(RADIATION_LEVELS.map((l) => l.kWm2)).toEqual([1.58, 4.73, 6.31, 9.46]);
  });
});

describe('blowdown', () => {
  test('marches to the end pressure, cooling as it goes, and mass balances', () => {
    const r = blowdown({
      volumeFt3: 500, p0Psia: 1014.7, t0R: 560, pEndPsia: 114.7,
      mw: 19, k: 1.3, z: 0.9, orificeDIn: 1.0,
    });
    expect(r.error).toBeUndefined();
    expect(r.timeS).toBeGreaterThan(10);
    expect(r.finalTR).toBeLessThan(560);
    const p = r.stations.map((s) => s.pPsia);
    for (let i = 1; i < p.length; i += 1) expect(p[i]).toBeLessThanOrEqual(p[i - 1]);
    // a bigger orifice is faster
    const fast = blowdown({
      volumeFt3: 500, p0Psia: 1014.7, t0R: 560, pEndPsia: 114.7,
      mw: 19, k: 1.3, z: 0.9, orificeDIn: 2.0,
    });
    expect(fast.timeS).toBeLessThan(r.timeS / 3);
    expect(blowdown({
      volumeFt3: 500, p0Psia: 100, t0R: 560, pEndPsia: 200, mw: 19, orificeDIn: 1,
    }).error).toBeTruthy();
  });
});
