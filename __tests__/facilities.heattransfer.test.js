// Facilities F4 heat-transfer gates: the energy balance and its
// stream-cross refusal, LMTD against numerical integration of the
// driving force, the Bowman F correction against the INDEPENDENT
// effectiveness-NTU identity (F = NTU_counter / NTU_1-2), eps-NTU
// against an RK4 march of the exchanger ODEs, the overall coefficient
// and tube-side film re-derived in SI, TEMA bundle geometry, and the
// air cooler including its hot-day derate.
//
// The F correction is the point of this module. The predecessor Suite
// app made the user TYPE an Ft, which is exactly where a design goes
// quietly wrong; here it is computed from the published closed form
// and checked against a different published route to the same number.

import fs from 'fs';
import path from 'path';
import {
  capacityRate, energyBalance, lmtd, lmtdGroups, lmtdCorrectionF,
  overallU, tubeSideFilm, areaRequired, tubeCount,
  effectivenessFromNtu, ntuFromEffectiveness,
  airDensityLbFt3, airCooler,
} from '../engines/facilities/heatTransfer';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'heattransfer_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('energy balance', () => {
  test('closes from a duty or from either outlet, consistently', () => {
    const cHot = capacityRate({ mLbHr: 50000, cpBtuLbF: 0.55 });
    const cCold = capacityRate({ mLbHr: 80000, cpBtuLbF: 1.0 });
    const fromQ = energyBalance({ cHot, cCold, thIn: 300, tcIn: 100, qBtuHr: 2.75e6 });
    const fromHot = energyBalance({ cHot, cCold, thIn: 300, tcIn: 100, thOut: fromQ.thOut });
    const fromCold = energyBalance({ cHot, cCold, thIn: 300, tcIn: 100, tcOut: fromQ.tcOut });
    expect(rel(fromHot.qBtuHr, 2.75e6)).toBeLessThan(1e-12);
    expect(rel(fromCold.qBtuHr, 2.75e6)).toBeLessThan(1e-12);
    expect(fromQ.thOut).toBeCloseTo(300 - 2.75e6 / cHot, 9);
  });

  test('refuses a crossed exchanger instead of returning a negative LMTD', () => {
    const cHot = capacityRate({ mLbHr: 10000, cpBtuLbF: 0.5 });
    const cCold = capacityRate({ mLbHr: 10000, cpBtuLbF: 0.5 });
    // asking for more duty than the streams can exchange
    const r = energyBalance({ cHot, cCold, thIn: 300, tcIn: 100, qBtuHr: 5e6 });
    expect(r.error).toMatch(/crosses the streams/);
    expect(energyBalance({ cHot, cCold, thIn: 100, tcIn: 300, qBtuHr: 1e5 }).error).toBeTruthy();
    expect(energyBalance({ cHot, cCold, thIn: 300, tcIn: 100 }).error).toMatch(/duty or one outlet/);
  });
});

describe('LMTD', () => {
  test('the log mean matches numerical integration of the driving force', () => {
    G.lmtd.forEach((row) => {
      const r = lmtd(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.lmtdF, row.lmtdF)).toBeLessThan(1e-4);
    });
  });

  test('equal-approach ends give the arithmetic mean, and a cross refuses', () => {
    const equal = lmtd({ thIn: 300, thOut: 200, tcIn: 100, tcOut: 200 });
    expect(equal.lmtdF).toBeCloseTo(100, 9);
    expect(lmtd({ thIn: 200, thOut: 150, tcIn: 100, tcOut: 220 }).error).toMatch(/cross/);
  });
});

describe('the LMTD correction factor', () => {
  test('Bowman matches the independent eps-NTU identity', () => {
    G.fCorrection.forEach((row) => {
      const r = lmtdCorrectionF({ p: row.p, r: row.r });
      expect(r.error).toBeUndefined();
      // two published routes to the same F
      expect(rel(r.f, row.f)).toBeLessThan(1e-6);
    });
  });

  test('F is at most 1, falls as the duty gets harder, and warns below 0.8', () => {
    const easy = lmtdCorrectionF({ p: 0.1, r: 1.0 });
    const mid = lmtdCorrectionF({ p: 0.45, r: 1.0 });
    const hard = lmtdCorrectionF({ p: 0.55, r: 1.0 });
    expect(easy.f).toBeLessThanOrEqual(1);
    expect(easy.f).toBeGreaterThan(mid.f);
    expect(mid.f).toBeGreaterThan(hard.f);
    expect(easy.warning).toBeNull();
    expect(hard.warning).toMatch(/Add a shell pass/);
  });

  test('more shell passes recover a duty a single shell cannot reach', () => {
    // At R = 1 a single 1-2 shell has a hard ceiling in P. P = 0.6
    // is past it; two shells in series reach it comfortably.
    const one = lmtdCorrectionF({ p: 0.6, r: 1.0, shellPasses: 1 });
    const two = lmtdCorrectionF({ p: 0.6, r: 1.0, shellPasses: 2 });
    expect(one.error).toBeTruthy();
    expect(two.error).toBeUndefined();
    expect(two.f).toBeGreaterThan(0.8);
    // A harder duty still needs three; the engine says so rather than
    // returning a number the configuration cannot deliver.
    expect(lmtdCorrectionF({ p: 0.75, r: 1.0, shellPasses: 2 }).error).toBeTruthy();
    expect(lmtdCorrectionF({ p: 0.75, r: 1.0, shellPasses: 3 }).f).toBeGreaterThan(0.8);
  });

  test('P and R come from the terminal temperatures', () => {
    const g = lmtdGroups({ thIn: 300, thOut: 200, tcIn: 100, tcOut: 180 });
    expect(g.p).toBeCloseTo(80 / 200, 12);
    expect(g.r).toBeCloseTo(100 / 80, 12);
    expect(lmtdGroups({ thIn: 100, thOut: 90, tcIn: 100, tcOut: 110 }).error).toBeTruthy();
  });
});

describe('effectiveness-NTU', () => {
  test('the closed form matches an RK4 march of the exchanger ODEs', () => {
    G.epsNtu.forEach((row) => {
      const e = effectivenessFromNtu({ ntu: row.ntu, cr: row.cr });
      expect(rel(e, row.epsOde)).toBeLessThan(1e-5);
    });
  });

  test('inverts, and refuses effectiveness the arrangement cannot reach', () => {
    [['counter', 0.6], ['parallel', 0.5], ['shell1', 0.55]].forEach(([arrangement, eff]) => {
      const n = ntuFromEffectiveness({ effectiveness: eff, cr: 0.5, arrangement });
      expect(n.error).toBeUndefined();
      expect(rel(effectivenessFromNtu({ ntu: n.ntu, cr: 0.5, arrangement }), eff)).toBeLessThan(1e-9);
    });
    // parallel flow has a hard ceiling of 1/(1+Cr) whatever the area
    const bad = ntuFromEffectiveness({ effectiveness: 0.7, cr: 0.5, arrangement: 'parallel' });
    expect(bad.error).toMatch(/cannot exceed/);
    const badShell = ntuFromEffectiveness({ effectiveness: 0.95, cr: 0.8, arrangement: 'shell1' });
    expect(badShell.error).toMatch(/cannot exceed/);
  });

  test('counter beats shell beats parallel at the same NTU', () => {
    const at = (arrangement) => effectivenessFromNtu({ ntu: 2, cr: 0.7, arrangement });
    expect(at('counter')).toBeGreaterThan(at('shell1'));
    expect(at('shell1')).toBeGreaterThan(at('parallel'));
  });
});

describe('overall coefficient and films', () => {
  test('U matches the SI re-derivation and names its controlling resistance', () => {
    G.u.forEach((row) => {
      const r = overallU(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.uDirtyBtuHrFt2F, row.uDirtyBtuHrFt2F)).toBeLessThan(1e-6);
      expect(rel(r.uCleanBtuHrFt2F, row.uCleanBtuHrFt2F)).toBeLessThan(1e-6);
      expect(r.uDirtyBtuHrFt2F).toBeLessThan(r.uCleanBtuHrFt2F);
      expect(r.foulingPenaltyPct).toBeGreaterThan(0);
    });
    // the low film coefficient controls
    const r = overallU({ hoBtuHrFt2F: 50, hiBtuHrFt2F: 2000, doIn: 0.75, diIn: 0.62 });
    expect(r.controlling).toBe('outsideFilm');
  });

  test('the tube-side film matches SI Dittus-Boelter and refuses the transition band', () => {
    G.tubeFilm.forEach((row) => {
      const r = tubeSideFilm(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.re, row.re)).toBeLessThan(2e-3);
      expect(rel(r.hBtuHrFt2F, row.hBtuHrFt2F)).toBeLessThan(3e-3);
    });
    const trans = tubeSideFilm({
      mLbHr: 250000, diIn: 0.62, muCp: 5, kBtuHrFtF: 0.08, cpBtuLbF: 0.5, nTubes: 100, passes: 1,
    });
    expect(trans.re).toBeGreaterThan(2300);
    expect(trans.re).toBeLessThan(10000);
    expect(trans.error).toMatch(/transition band/);
    const lam = tubeSideFilm({
      mLbHr: 2000, diIn: 0.62, muCp: 50, kBtuHrFtF: 0.08, cpBtuLbF: 0.5, nTubes: 100, passes: 1,
    });
    expect(lam.regime).toBe('laminar');
    expect(lam.warning).toBeTruthy();
  });

  test('the Sieder-Tate correction moves the film the right way', () => {
    const base = {
      mLbHr: 150000, diIn: 0.62, muCp: 0.5, kBtuHrFtF: 0.08, cpBtuLbF: 0.5, nTubes: 200, passes: 2,
    };
    const plain = tubeSideFilm(base);
    const heated = tubeSideFilm({ ...base, muWallCp: 0.3 }); // hot wall, thinner there
    expect(heated.hBtuHrFt2F).toBeGreaterThan(plain.hBtuHrFt2F);
    expect(heated.siederTate).toBe(true);
  });
});

describe('sizing and bundle geometry', () => {
  test('area follows Q = U A F dTlm and refuses missing pieces', () => {
    const a = areaRequired({ qBtuHr: 5e6, uBtuHrFt2F: 120, lmtdF: 80, f: 0.9 });
    expect(a.areaFt2).toBeCloseTo(5e6 / (120 * 0.9 * 80), 9);
    expect(areaRequired({ qBtuHr: 5e6, uBtuHrFt2F: 0, lmtdF: 80 }).error).toBeTruthy();
  });

  test('tube count covers the area and the bundle grows with it', () => {
    const small = tubeCount({ areaFt2: 500, doIn: 0.75, tubeLengthFt: 16 });
    const big = tubeCount({ areaFt2: 2000, doIn: 0.75, tubeLengthFt: 16 });
    expect(small.actualAreaFt2).toBeGreaterThanOrEqual(500);
    expect(big.nTubes).toBeGreaterThan(small.nTubes);
    expect(big.bundleDiameterIn).toBeGreaterThan(small.bundleDiameterIn);
    expect(big.shellDiameterIn).toBeGreaterThan(big.bundleDiameterIn);
    expect(tubeCount({ areaFt2: 500, doIn: 0.75, tubeLengthFt: 16, passes: 3 }).error).toMatch(/1, 2, 4 and 6/);
    expect(tubeCount({ areaFt2: 500, doIn: 0.75, tubeLengthFt: 16, layoutDeg: 17 }).error).toBeTruthy();
  });
});

describe('air coolers', () => {
  test('area, air flow and fan power match the SI oracle', () => {
    G.airCooler.forEach((row) => {
      const r = airCooler(row);
      expect(r.error).toBeUndefined();
      expect(rel(r.lmtdF, row.lmtdF)).toBeLessThan(1e-9);
      expect(rel(r.areaFt2, row.areaFt2)).toBeLessThan(1e-9);
      expect(rel(r.acfm, row.acfm)).toBeLessThan(1e-9);
      expect(rel(r.fanBhp, row.fanBhp)).toBeLessThan(1e-9);
      expect(rel(r.airDensityLbFt3, row.airDensityLbFt3)).toBeLessThan(1e-9);
    });
    expect(airDensityLbFt3(60)).toBeCloseTo(0.0764, 3);
  });

  test('the hot-day derate is the point: capacity falls with the approach', () => {
    const r = airCooler({
      qBtuHr: 20e6, processInF: 250, processOutF: 150, ambientF: 95, airRiseF: 30,
      uBtuHrFt2F: 4.5, checkAmbientF: 110,
    });
    expect(r.hotDay.dutyFraction).toBeLessThan(1);
    expect(r.hotDay.qBtuHr).toBeLessThan(20e6);
    // an ambient above the process outlet makes the outlet unreachable
    const impossible = airCooler({
      qBtuHr: 20e6, processInF: 250, processOutF: 150, ambientF: 95, airRiseF: 30,
      uBtuHrFt2F: 4.5, checkAmbientF: 160,
    });
    expect(impossible.hotDay.error).toMatch(/no longer cold enough/);
  });

  test('motor horsepower carries the drive losses', () => {
    const r = airCooler({
      qBtuHr: 8e6, processInF: 180, processOutF: 120, ambientF: 90, airRiseF: 25,
      uBtuHrFt2F: 5, motorEfficiency: 0.9,
    });
    expect(r.motorHp).toBeCloseTo(r.fanBhp / 0.9, 9);
  });
});
