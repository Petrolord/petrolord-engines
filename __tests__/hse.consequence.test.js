// HSE H4 gates: consequence modelling (source terms, Gaussian plume, pool
// fire solid flame, TNT and Kinney-Graham blast, probits) against the
// independent oracle (tools/validation/hse/oracle_consequence.py, numpy and
// scipy in /root/hseenv) and the published worked examples and tables it
// transcribes.
//
// Every golden below is CALLED THROUGH THE ENGINE. What the routes check:
//
//  - route A (the oracle's own transcription of each source formula):
//    1e-10 relative for closed forms, 1e-9 for roots;
//  - PUBLISHED: YB worked examples (liquid and hydrogen outflow, benzene
//    pool fire, the jet flame view factor), YB Table 6.A.1, PB Table 5.1,
//    PB Appendix 6.B (plume and CO probit), OSD/30 Tables 2, 17, 18 and
//    Equation 4, a secondary Kinney-Graham table; tolerance per case;
//  - route B: numerical integration of the view factor (400 x 400
//    Gauss-Legendre), the isentropic nozzle maximised over throat
//    pressure, Torricelli, and a mass-flux integral of the ENGINE'S OWN
//    plume done here in the test (a lost ground reflection halves it).
//
// Negative controls: tools/validation/hse/negcontrol_consequence.sh.

import fs from 'fs';
import path from 'path';
import * as C from '../engines/hse/consequence';
import { criticalPressureRatio } from '../engines/facilities/relief';
import { poolFireSetbackM } from '../engines/facilities/spacing';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'hse', 'goldens', 'consequence_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
const RTOL = 1e-10;
const ROOT_TOL = 1e-9;
const P_TOL = 2e-7;

const expectClose = (actual, expected, tol = RTOL) => {
  expect(typeof actual).toBe('number');
  expect(rel(actual, expected)).toBeLessThan(tol);
};

describe('golden file', () => {
  test('is the oracle output and every case says where it came from', () => {
    expect(G.module).toBe('consequence');
    expect(G.generatedBy).toBe('tools/validation/hse/oracle_consequence.py');
    const all = [
      ...G.sourceTerms.liquid, ...G.sourceTerms.gas, ...G.sourceTerms.pools, ...G.sourceTerms.evaporation,
      ...G.dispersion.plume, ...G.dispersion.distance, ...G.dispersion.conversions,
      ...G.fires.burningRate, ...G.fires.flameLength, ...G.fires.tilt, ...G.fires.viewFactor, ...G.fires.transmissivity, G.fires.ybPoolFire,
      ...G.explosions.tnt, ...G.explosions.kinneyGraham, ...G.explosions.inverse,
      ...G.probits.thermal, ...G.probits.lethalDose, ...G.probits.toxic, ...G.probits.overpressure,
    ];
    all.forEach((c) => expect(c.source).toMatch(/^(PUBLISHED|ORACLE-DERIVED): /));
    expect(all.filter((c) => c.source.startsWith('PUBLISHED')).length).toBeGreaterThanOrEqual(20);
  });
});

describe('what this engine does not re-grade', () => {
  test('no point-source radiation or setback is re-exposed (FC1 and FC5 grade those in facilities)', () => {
    ['radiationIntensity', 'distanceForIntensity', 'flareSetbackM', 'poolFireSetbackM', 'RADIATION_LEVELS'].forEach((name) => {
      expect(C[name]).toBeUndefined();
    });
  });

  test('the still-air Thomas flame length IS the spacing.js expression, bit for bit', () => {
    [[10, 0.055], [30, 0.078], [2.5, 0.101]].forEach(([d, m]) => {
      const mine = C.poolFireFlameLength({ method: 'thomas-still-air', poolDiameterM: d, burningFluxKgM2S: m }).flameLengthM;
      const theirs = poolFireSetbackM({ poolDiameterM: d, burnRateKgM2S: m }).flameHeightM;
      expect(mine).toBe(theirs);
    });
  });
});

/* ------------------------------------------------------------------ */
describe('source terms', () => {
  test.each(G.sourceTerms.liquid.map((c) => [c.id, c]))('liquid outflow %s', (id, c) => {
    const r = C.liquidOrificeDischarge(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.massRateKgS, c.expected.massRateKgS);
    if ('routeB' in c) expectClose(r.massRateKgS, c.routeB);
    if ('printed' in c) expect(rel(r.massRateKgS, c.printed)).toBeLessThan(c.publishedRelTol);
    expect(r.basis.source).toMatch(/2\.194/);
  });

  test('YB Table 2.8 t = 0 row does not reproduce: its level gives 58.64, not the printed 60.915 (erratum, not gated)', () => {
    const e = G.sourceTerms.erratumTable28;
    const r = C.liquidOrificeDischarge({ dischargeCoefficient: 0.62, holeDiameterM: 0.1, liquidDensityKgM3: 812.5, liquidHeadM: e.printedT0LevelM });
    expectClose(r.massRateKgS, e.bernoulliAtThatLevel);
    expect(rel(r.massRateKgS, e.printedT0MassRateKgS)).toBeGreaterThan(0.03);
  });

  test.each(G.sourceTerms.gas.map((c) => [c.id, c]))('gas outflow %s', (id, c) => {
    const r = C.gasOrificeDischarge(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.massRateKgS, c.expected.massRateKgS);
    expect(r.choked).toBe(c.expected.choked);
    expect(r.regime).toBe(c.expected.choked ? 'CHOKED' : 'SUBSONIC');
    expectClose(r.massRateKgS, c.routeB, ROOT_TOL);
    if ('outflowCoefficientPsi' in c.expected) expectClose(r.outflowCoefficientPsi, c.expected.outflowCoefficientPsi);
    if ('printed' in c) expect(Number(r.massRateKgS.toFixed(c.printedDecimals))).toBe(c.printed);
  });

  test('exactly at the critical pressure ratio the flow is CHOKED, and psi is continuous across it', () => {
    const gamma = 1.4;
    const rc = criticalPressureRatio(gamma);
    const pa = 101325;
    // find an upstream pressure whose ratio is the critical ratio in double
    let p0 = pa / rc;
    for (let k = 0; k < 64 && pa / p0 !== rc; k += 1) p0 = pa / rc * (1 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * Number.EPSILON);
    expect(pa / p0).toBe(rc);
    const base = { dischargeCoefficient: 0.62, holeDiameterM: 0.01, upstreamTemperatureK: 300, molarMassKgMol: 0.029, heatCapacityRatio: gamma, ambientPressurePa: pa };
    const at = C.gasOrificeDischarge({ ...base, upstreamPressurePa: p0 });
    expect(at.regime).toBe('CHOKED');
    const below = C.gasOrificeDischarge({ ...base, upstreamPressurePa: p0 * (1 - 1e-9) });
    expect(below.regime).toBe('SUBSONIC');
    expect(Math.abs(below.outflowCoefficientPsi - 1)).toBeLessThan(1e-9);
    expect(rel(below.massRateKgS, at.massRateKgS)).toBeLessThan(1e-8);
    expect(at.criticalPressureRatio).toBe(rc);
  });

  test.each(G.sourceTerms.pools.map((c) => [c.id, c]))('pool %s', (id, c) => {
    const r = C.poolFromSpill(c.args);
    expect(r.error).toBeUndefined();
    Object.entries(c.expected).forEach(([k, v]) => (typeof v === 'string' ? expect(r[k]).toBe(v) : expectClose(r[k], v)));
    if (c.printed) {
      // the YB prints 42.445 for 42.44566: truncated, not rounded
      expect(Math.abs(r.equivalentDiameterM - c.printed.equivalentDiameterM)).toBeLessThan(1e-3);
      expect(Math.round(r.areaM2)).toBe(c.printed.areaM2);
    }
  });

  test.each(G.sourceTerms.evaporation.map((c) => [c.id, c]))('evaporation %s', (id, c) => {
    const r = C.poolEvaporationMackayMatsugu(c.args);
    expect(r.error).toBeUndefined();
    Object.entries(c.expected).forEach(([k, v]) => expectClose(r[k], v));
    expect(C.MACKAY_MATSUGU_C).toBe(0.004786);
  });
});

/* ------------------------------------------------------------------ */
describe('dispersion', () => {
  test('the Briggs rural table is ALOHA Table 13 (sz2 for class D is 0.0015)', () => {
    Object.entries(G.dispersion.briggsTable).forEach(([cls, row]) => {
      expect({ ...C.BRIGGS_RURAL[cls] }).toEqual(row);
    });
    expect(C.BRIGGS_RURAL.D.sz2).toBe(0.0015);
  });

  test.each(G.dispersion.sigmas.map((s) => [s.stabilityClass, s.downwindDistanceM, s]))('sigmas class %s at %p m', (cls, x, s) => {
    const r = C.briggsRuralSigmas({ stabilityClass: cls, downwindDistanceM: x });
    expectClose(r.sigmaYM, s.sigmaYM);
    expectClose(r.sigmaZM, s.sigmaZM);
    expect(Boolean(r.warning)).toBe(s.warning);
  });

  test('the stability class is read case-insensitively and anything else is refused by name', () => {
    expect(C.briggsRuralSigmas({ stabilityClass: 'd', downwindDistanceM: 500 }).stabilityClass).toBe('D');
    ['G', '', null, 4].forEach((cls) => expect(C.briggsRuralSigmas({ stabilityClass: cls, downwindDistanceM: 500 }).field).toBe('stabilityClass'));
  });

  test.each(G.dispersion.plume.map((c) => [c.id, c]))('plume %s', (id, c) => {
    const r = C.gaussianPlume(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.concentrationKgM3, c.expected.concentrationKgM3);
    expectClose(r.concentrationMgM3, c.expected.concentrationKgM3 * 1e6);
    if ('concentrationPpm' in c.expected) expectClose(r.concentrationPpm, c.expected.concentrationPpm);
    if ('sigmaYM' in c.expected) { expectClose(r.sigmaYM, c.expected.sigmaYM); expectClose(r.sigmaZM, c.expected.sigmaZM); }
    if ('warning' in c) expect(Boolean(r.warning)).toBe(c.warning);
    if (c.printed) expect(Number((r.concentrationKgM3 * 1000).toFixed(1))).toBe(c.printed.concentrationGM3);
    expect(Math.abs(c.routeB - 1)).toBeLessThan(1e-9);
  });

  test('route B in the test: u x the integral of the ENGINE plume over y and z >= 0 is the release rate', () => {
    // Gauss-Legendre, 96 points per axis on +-10 sigma_y and [0, h + 10 sigma_z].
    const gl = (n) => {
      const x = []; const w = [];
      for (let i = 1; i <= n; i += 1) {
        let z = Math.cos(Math.PI * (i - 0.25) / (n + 0.5));
        let pp;
        for (let it = 0; it < 100; it += 1) {
          let p1 = 1; let p2 = 0;
          for (let j = 1; j <= n; j += 1) { const p3 = p2; p2 = p1; p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j; }
          pp = (n * (z * p1 - p2)) / (z * z - 1);
          const z1 = z; z = z1 - p1 / pp;
          if (Math.abs(z - z1) < 1e-15) break;
        }
        x.push(z); w.push(2 / ((1 - z * z) * pp * pp));
      }
      return { x, w };
    };
    const { x, w } = gl(96);
    [['D', 1000, 0], ['F', 500, 5], ['C', 2000, 50], ['A', 150, 2]].forEach(([cls, dist, h]) => {
      const s = C.briggsRuralSigmas({ stabilityClass: cls, downwindDistanceM: dist });
      const ya = -10 * s.sigmaYM; const yb = 10 * s.sigmaYM; const zb = h + 10 * s.sigmaZM;
      let total = 0;
      for (let i = 0; i < x.length; i += 1) {
        const y = ya + (yb - ya) * (x[i] + 1) / 2;
        for (let j = 0; j < x.length; j += 1) {
          const z = zb * (x[j] + 1) / 2;
          const c = C.gaussianPlume({ massRateKgS: 2, windSpeedMS: 4, downwindDistanceM: dist, stabilityClass: cls, crosswindDistanceM: y, receptorHeightM: z, releaseHeightM: h }).concentrationKgM3;
          total += w[i] * w[j] * c;
        }
      }
      total *= ((yb - ya) / 2) * (zb / 2);
      expect(Math.abs(4 * total / 2 - 1)).toBeLessThan(1e-6);
    });
  });

  test.each(G.dispersion.distance.map((c) => [c.id, c]))('distance to a concentration %s', (id, c) => {
    const r = C.plumeDistanceToConcentration(c.args);
    expect(r.error).toBeUndefined();
    expect(r.state).toBe(c.expected.state);
    expect(rel(r.peakConcentrationMgM3, c.expected.peakConcentrationMgM3)).toBeLessThan(1e-8);
    ['nearDistanceM', 'farDistanceM'].forEach((k) => {
      if (c.expected[k] === null) expect(r[k]).toBeNull();
      else {
        expectClose(r[k], c.expected[k], ROOT_TOL);
        const back = C.gaussianPlume({ ...c.args, targetConcentrationMgM3: undefined, downwindDistanceM: r[k] });
        expect(rel(back.concentrationMgM3, c.args.targetConcentrationMgM3)).toBeLessThan(1e-8);
      }
    });
  });

  test.each(G.dispersion.conversions.map((c) => [c.id, c]))('ppm to mg/m3 %s', (id, c) => {
    const r = C.ppmToMgM3(c.args);
    expectClose(r.concentrationMgM3, c.expected.concentrationMgM3);
    if ('printed' in c) expect(rel(r.concentrationMgM3, c.printed)).toBeLessThan(1e-3);
    const back = C.mgM3ToPpm({ ...c.args, concentrationPpm: undefined, concentrationMgM3: r.concentrationMgM3 });
    expectClose(back.concentrationPpm, c.args.concentrationPpm, 1e-14);
  });
});

/* ------------------------------------------------------------------ */
describe('fires', () => {
  test.each(G.fires.burningRate.map((c) => [c.id, c]))('burning rate %s', (id, c) => {
    const r = C.poolBurningRate(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.burningFluxKgM2S, c.expected.burningFluxKgM2S);
  });

  test('the Babrauskas table is YB Table 6.5', () => {
    expect(C.POOL_FIRE_FUELS.gasoline).toEqual({ massBurningFluxInfKgM2S: 0.055, kBetaPerM: 2.1 });
    expect(C.POOL_FIRE_FUELS.benzene).toEqual({ massBurningFluxInfKgM2S: 0.085, kBetaPerM: 2.7 });
    expect(C.POOL_FIRE_FUELS.methanol.kBetaPerM).toBeNull();
    expect(Object.keys(C.POOL_FIRE_FUELS)).toHaveLength(13);
  });

  test.each(G.fires.flameLength.map((c) => [c.id, c]))('flame length %s', (id, c) => {
    const r = C.poolFireFlameLength(c.args);
    expect(r.error).toBeUndefined();
    Object.entries(c.expected).forEach(([k, v]) => expectClose(r[k], v));
  });

  test.each(G.fires.tilt.map((c) => [c.id, c]))('tilt %s', (id, c) => {
    const r = C.poolFireTilt(c.args);
    Object.entries(c.expected).forEach(([k, v]) => expectClose(r[k], v));
  });

  test.each(G.fires.viewFactor.map((c) => [c.id, c]))('view factor %s', (id, c) => {
    const r = C.cylinderViewFactor(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.viewFactorVertical, c.expected.viewFactorVertical);
    expectClose(r.viewFactorHorizontal, c.expected.viewFactorHorizontal);
    expectClose(r.viewFactorMax, c.expected.viewFactorMax);
    expect(Math.abs(r.viewFactorVertical - c.routeB.viewFactorVertical)).toBeLessThan(1e-9);
    expect(Math.abs(r.viewFactorHorizontal - c.routeB.viewFactorHorizontal)).toBeLessThan(1e-9);
    if (c.printed) {
      expect(Math.abs(r.viewFactorVertical - c.printed.viewFactorVertical)).toBeLessThan(c.printedAbsTol);
      expect(Math.abs(r.viewFactorHorizontal - c.printed.viewFactorHorizontal)).toBeLessThan(c.printedAbsTol);
    }
  });

  test(`YB Table 6.A.1 (Raj): ${G.fires.rajTable.length} printed cells reproduced to the last printed digit`, () => {
    expect(G.fires.rajTable).toHaveLength(303);
    G.fires.rajTable.forEach((cell) => {
      const r = C.cylinderViewFactor({ flameRadiusM: 1, flameLengthM: cell.hr, distanceFromAxisM: cell.xr });
      const v = { Fh: r.viewFactorHorizontal, Fv: r.viewFactorVertical, Fmax: r.viewFactorMax }[cell.table];
      expect(Math.abs(1e3 * v - cell.printed)).toBeLessThanOrEqual(1.0);
    });
  });

  test('YB Table 6.A.1 misprints: Fmax at (1.2, 0.1) and (1.4, 0.2) do not follow from their own Fh and Fv', () => {
    expect(G.fires.rajTableMisprints.map((m) => [m.table, m.xr, m.hr, m.printed])).toEqual([['Fmax', 1.2, 0.1, 210], ['Fmax', 1.4, 0.2, 117]]);
    G.fires.rajTableMisprints.forEach((m) => {
      const r = C.cylinderViewFactor({ flameRadiusM: 1, flameLengthM: m.hr, distanceFromAxisM: m.xr });
      expect(Math.abs(1e3 * r.viewFactorMax - m.computed1e3)).toBeLessThan(1e-9);
    });
  });

  test('a flame reaching over the target is refused: there the closed form departs from route B', () => {
    G.fires.overhangDeparture.forEach((o) => {
      expect(Math.abs(o.closedFormFv - o.routeBFv)).toBeGreaterThan(5e-3);
      const r = C.cylinderViewFactor({ flameRadiusM: 1, flameLengthM: o.a, distanceFromAxisM: o.b, tiltDeg: o.tiltDeg });
      expect(r.field).toBe('tiltDeg');
    });
  });

  test.each(G.fires.transmissivity.map((c) => [c.id, c]))('transmissivity %s', (id, c) => {
    const r = C.atmosphericTransmissivityBagster(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.transmissivity, c.expected.transmissivity);
  });

  test('Bagster range endpoints are inside; one step outside is refused', () => {
    expect(C.atmosphericTransmissivityBagster({ waterVapourPartialPressurePa: 1000, pathLengthM: 10 }).error).toBeUndefined();
    expect(C.atmosphericTransmissivityBagster({ waterVapourPartialPressurePa: 1000, pathLengthM: 100 }).error).toBeUndefined();
    expect(C.atmosphericTransmissivityBagster({ waterVapourPartialPressurePa: 1000, pathLengthM: 9.999 }).field).toBe('pathLengthM');
    expect(C.atmosphericTransmissivityBagster({ waterVapourPartialPressurePa: 1000, pathLengthM: 100.001 }).field).toBe('pathLengthM');
  });

  test('SEP by the three YB methods', () => {
    const y = G.fires.ybPoolFire;
    const D = y.args.poolDiameterM;
    const m = C.surfaceEmissivePower({ method: 'mudan-diameter', poolDiameterM: D });
    expectClose(m.surfaceEmissivePowerWM2, y.intermediate.sepMudan);
    expect(rel(m.surfaceEmissivePowerWM2, y.printed.sepMudan)).toBeLessThan(y.publishedRelTol.sepMudan);
    const L = y.expected.flameLengthM;
    const f = C.surfaceEmissivePower({ method: 'radiative-fraction', poolDiameterM: D, radiativeFraction: 0.4, burningFluxKgM2S: y.args.burningFluxKgM2S, heatOfCombustionJKg: 4.015e7, flameLengthM: L });
    expectClose(f.surfaceEmissivePowerWM2, y.intermediate.sepMax);
    expect(rel(f.surfaceEmissivePowerWM2, y.printed.sepMax)).toBeLessThan(y.publishedRelTol.sepMax);
  });

  test('YB 6.6.3 benzene pool fire, steps 1 to 13, end to end', () => {
    const y = G.fires.ybPoolFire;
    expect(Math.abs(y.args.poolDiameterM - y.printed.equivalentDiameterM)).toBeLessThan(1e-3);
    const r = C.poolFireSolidFlame(y.args);
    expect(r.error).toBeUndefined();
    Object.entries(y.expected).forEach(([k, v]) => expectClose(r[k], v));
    const pr = y.printed; const tol = y.publishedRelTol;
    const L = C.poolFireFlameLength({ method: 'thomas-wind', poolDiameterM: y.args.poolDiameterM, burningFluxKgM2S: y.args.burningFluxKgM2S, airDensityKgM3: 1.2243, windSpeed10mMS: 5 });
    expect(rel(L.characteristicWindSpeedMS, pr.characteristicWindSpeedMS)).toBeLessThan(tol.characteristicWindSpeedMS);
    expect(rel(L.scaledWindSpeed, pr.scaledWindSpeed)).toBeLessThan(tol.scaledWindSpeed);
    expect(rel(L.lengthToDiameter, pr.lengthToDiameter)).toBeLessThan(tol.lengthToDiameter);
    expect(rel(r.flameLengthM, pr.flameLengthM)).toBeLessThan(tol.flameLengthM);
    const t = C.poolFireTilt({ poolDiameterM: y.args.poolDiameterM, windSpeed10mMS: 5, airKinematicViscosityM2S: 7.5133e-6 });
    expect(rel(t.reynoldsNumber, pr.reynoldsNumber)).toBeLessThan(tol.reynoldsNumber);
    expect(rel(t.tiltParameter, pr.tiltParameter)).toBeLessThan(tol.tiltParameter);
    expect(rel(r.tiltDeg, pr.tiltDeg)).toBeLessThan(tol.tiltDeg);
    // the printed Froude number is a misprint: the printed tilt follows from the correct one
    expect(rel(t.froudeNumber, pr.froudeNumber)).toBeGreaterThan(0.09);
    expect(rel(r.surfaceEmissivePowerWM2, pr.sepAct)).toBeLessThan(tol.sepAct);
    expect(rel(r.viewFactorVertical, pr.viewFactorVertical)).toBeLessThan(2e-4);
    expect(rel(r.viewFactorHorizontal, pr.viewFactorHorizontal)).toBeLessThan(3e-4);
    expect(rel(r.viewFactorMax, pr.viewFactorMax)).toBeLessThan(tol.viewFactorMax);
    expect(rel(r.heatFluxWM2, pr.heatFluxWM2)).toBeLessThan(tol.heatFluxWM2);
  });

  test('the distance to a heat flux lands on the target and moves outward for a lower target', () => {
    const args = { poolDiameterM: 20, burningFluxKgM2S: 0.055, heatOfCombustionJKg: 4.3e7, sep: { method: 'mudan-diameter' }, transmissivity: 0.8 };
    const d1 = C.solidFlameDistanceForHeatFlux({ ...args, targetHeatFluxWM2: 12500 });
    const d2 = C.solidFlameDistanceForHeatFlux({ ...args, targetHeatFluxWM2: 4730 });
    expect(d1.state).toBe('REACHED');
    expect(d2.distanceFromCentreM).toBeGreaterThan(d1.distanceFromCentreM);
    [d1, d2].forEach((d, i) => {
      const q = C.poolFireSolidFlame({ ...args, distanceFromCentreM: d.distanceFromCentreM }).heatFluxWM2;
      expect(rel(q, [12500, 4730][i])).toBeLessThan(1e-9);
    });
    expect(C.solidFlameDistanceForHeatFlux({ ...args, targetHeatFluxWM2: 1e6 }).state).toBe('NOT_REACHED');
    expect(C.solidFlameDistanceForHeatFlux({ ...args, transmissivity: undefined, waterVapourPartialPressurePa: 1200, targetHeatFluxWM2: 4730 }).field).toBe('transmissivity');
  });
});

/* ------------------------------------------------------------------ */
describe('explosions', () => {
  test.each(G.explosions.tnt.map((c) => [c.id, c]))('TNT equivalence %s', (id, c) => {
    expectClose(C.tntEquivalentMass(c.args).tntMassKg, c.expected.tntMassKg);
  });

  test.each(G.explosions.kinneyGraham.map((c) => [c.id, c]))('Kinney-Graham %s', (id, c) => {
    const r = C.kinneyGrahamOverpressure(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.overpressurePa, c.expected.overpressurePa);
    if ('printedKPa' in c) expect(rel(r.overpressurePa / 1000, c.printedKPa)).toBeLessThan(c.publishedRelTol);
  });

  test('scaling is the cube root: Z = R / W^(1/3)', () => {
    expect(C.scaledDistance({ distanceM: 20, tntMassKg: 8 }).scaledDistanceMKg13).toBeCloseTo(10, 14);
    const a = C.kinneyGrahamOverpressure({ distanceM: 30, tntMassKg: 27 });
    const b = C.kinneyGrahamOverpressure({ scaledDistanceMKg13: 10 });
    expect(rel(a.overpressurePa, b.overpressurePa)).toBeLessThan(1e-14);
  });

  test('the fit falls monotonically over its range, so the inverse is unique', () => {
    expect(G.explosions.kinneyGrahamMonotoneOnRange).toBe(true);
    expect(C.KINNEY_GRAHAM_Z_RANGE).toEqual({ min: 0.05, max: 40 });
    expect(C.kinneyGrahamOverpressure({ scaledDistanceMKg13: 0.05 }).error).toBeUndefined();
    expect(C.kinneyGrahamOverpressure({ scaledDistanceMKg13: 40 }).error).toBeUndefined();
  });

  test.each(G.explosions.inverse.map((c) => [c.id, c]))('distance for an overpressure %s', (id, c) => {
    const r = C.distanceForOverpressure(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.scaledDistanceMKg13, c.expected.scaledDistanceMKg13, ROOT_TOL);
    expectClose(r.distanceM, c.expected.distanceM, ROOT_TOL);
    const back = C.kinneyGrahamOverpressure({ distanceM: r.distanceM, tntMassKg: c.args.tntMassKg });
    expect(rel(back.overpressurePa, c.args.overpressurePa)).toBeLessThan(1e-9);
  });
});

/* ------------------------------------------------------------------ */
describe('probits', () => {
  test(`PB Table 5.1: ${G.probits.table51.length} cells reproduce to the printed two decimals`, () => {
    // 99 printed cells: 97 reproduce, 2 sit on a rounding edge (next test)
    expect(G.probits.table51).toHaveLength(97);
    G.probits.table51.forEach((row) => {
      const y = C.probabilityToProbit(row.probability).probit;
      expect(Math.abs(y - row.probit)).toBeLessThan(1e-5);
      expect(Math.round(y * 100 + 1e-9) / 100).toBeCloseTo(row.printedProbit, 10);
    });
  });

  test('PB Table 5.1 cells on a rounding edge (0.12, 0.88) sit within 0.006 of print', () => {
    expect(G.probits.table51Misprints.map((r) => r.probability)).toEqual([0.12, 0.88]);
    G.probits.table51Misprints.forEach((row) => {
      expect(Math.abs(C.probabilityToProbit(row.probability).probit - row.printedProbit)).toBeLessThan(0.006);
    });
  });

  test('P = Phi(Y - 5) against scipy across the range', () => {
    G.probits.table51.forEach((row) => {
      expect(Math.abs(C.probitToProbability(row.probit).probability - row.probability)).toBeLessThan(P_TOL);
    });
    expect(C.probitToProbability(5).probability).toBeCloseTo(0.5, 8);
  });

  test.each(G.probits.thermal.map((c) => [c.id, c]))('thermal probit %s', (id, c) => {
    const r = C.thermalProbit(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.probit, c.expected.probit);
    expect(Math.abs(r.probability - c.expected.probability)).toBeLessThan(P_TOL);
  });

  test("the brief's form of Eisenberg, -14.9 + 2.56 ln(t q^(4/3) / 1e4) with q in W/m2, is the kW/m2 preset", () => {
    const b = G.probits.briefEisenbergForm;
    const r = C.thermalProbit({ coefficients: 'eisenberg', heatFluxWM2: b.heatFluxWM2, exposureTimeS: b.exposureTimeS });
    expectClose(r.probit, b.probit, 1e-13);
  });

  test('the Purple Book heat probit is Tsao and Perry in W/m2 (-12.8 - 2.56 ln 1e4 = -36.378), not Eisenberg', () => {
    const pb = C.thermalProbit({ coefficients: 'purple-book', heatFluxWM2: 15000, exposureTimeS: 20 }).probit;
    const tp = C.thermalProbit({ coefficients: 'tsao-perry', heatFluxWM2: 15000, exposureTimeS: 20 }).probit;
    const ei = C.thermalProbit({ coefficients: 'eisenberg', heatFluxWM2: 15000, exposureTimeS: 20 }).probit;
    expect(Math.abs(pb - tp)).toBeLessThan(0.003);
    expect(tp - ei).toBeCloseTo(2.1, 10);
  });

  test.each(G.probits.lethalDose.map((c) => [c.id, c]))('OSD/30 Table 17 lethal thermal doses, %s', (id, c) => {
    const d1 = C.probitDoseForProbability({ a: c.a, b: c.b, probability: 0.01 }).dose;
    const d50 = C.probitDoseForProbability({ a: c.a, b: c.b, probability: 0.5 }).dose;
    expect(rel(d1, c.expected1)).toBeLessThan(1e-6);
    expect(rel(d50, c.expected50)).toBeLessThan(1e-9);
    expect(rel(d1, c.printed1)).toBeLessThan(c.publishedRelTol);
    expect(rel(d50, c.printed50)).toBeLessThan(c.publishedRelTol);
  });

  test('the OSD/30 TNO row (-15.3, 3.02) does not reproduce its own lethal doses, so it is not a preset', () => {
    const t = G.probits.tnoOsdRowDoesNotReproduce;
    expect(rel(t.computed50, t.printed50)).toBeGreaterThan(0.01);
    expect(C.THERMAL_PROBITS.tno).toBeUndefined();
  });

  test('OSD/30 Table 18 (Tsao and Perry fatality percent) within one percentage point, every cell', () => {
    G.probits.osdTable18.forEach((row) => {
      const p = C.thermalProbit({ coefficients: 'tsao-perry', heatFluxWM2: row.heatFluxWM2, exposureTimeS: row.exposureTimeS }).probability;
      expect(Math.abs(100 * p - row.percent)).toBeLessThan(1e-4);
      expect(Math.abs(100 * p - row.printedPercent)).toBeLessThanOrEqual(1.0);
    });
  });

  test.each(G.probits.toxic.map((c) => [c.id, c]))('toxic probit %s', (id, c) => {
    const r = C.toxicProbit(c.args);
    expect(r.error).toBeUndefined();
    expectClose(r.probit, c.expected.probit);
    expect(Math.abs(r.probability - c.expected.probability)).toBeLessThan(P_TOL);
    if (c.printed) {
      expect(Number(r.probit.toFixed(2))).toBe(c.printed.probit);
      expect(Math.abs(r.probability - c.printed.probability)).toBeLessThan(c.printedProbabilityAbsTol);
    }
  });

  test(`OSD/30 Table 2 (Lees 2005): all ${G.probits.leesLc.length} LC1 and LC50 columns reproduce within 1 percent`, () => {
    expect(G.probits.leesLcMisprints).toEqual([]);
    expect(G.probits.leesLc).toHaveLength(52);
    G.probits.leesLc.forEach((row) => {
      const c = C.TOXIC_PROBITS[row.preset];
      const dose = C.probitDoseForProbability({ a: c.a, b: c.b, probability: row.probability }).dose;
      const ppm = (dose / row.exposureMinutes) ** (1 / c.n);
      expect(rel(ppm, row.ppm)).toBeLessThan(1e-5);
      expect(rel(ppm, row.printedPpm) <= 0.01 || Math.abs(ppm - row.printedPpm) <= 1).toBe(true);
    });
  });

  test('toxic dose sums C^n dt over a history, and a constant history is C^n t', () => {
    const d = C.toxicDose({ n: 2, history: [{ concentration: 100, minutes: 5 }, { concentration: 50, minutes: 10 }] });
    expect(d.dose).toBe(100 ** 2 * 5 + 50 ** 2 * 10);
    const r = C.toxicProbit({ coefficients: 'lees-chlorine', concentrationPpm: 100, exposureMinutes: 15 });
    expect(r.dose).toBe(C.toxicDose({ n: 2, history: [{ concentration: 100, minutes: 15 }] }).dose);
  });

  test('HSC overpressure probit (OSD/30 Equation 4a) against its printed 1, 50 and 95 percent pressures', () => {
    G.probits.hscPrinted.forEach((row) => {
      const dose = C.probitDoseForProbability({ ...C.OVERPRESSURE_PROBITS.hsc, probability: row.probability }).dose;
      expect(rel(dose, row.psig)).toBeLessThan(1e-6);
      expect(rel(dose, row.printedPsig)).toBeLessThan(row.publishedRelTol);
    });
    G.probits.overpressure.forEach((c) => {
      const r = C.overpressureProbit(c.args);
      expectClose(r.probit, c.expected.probit);
    });
  });
});

/* ------------------------------------------------------------------ */
describe('refusals, by name', () => {
  test.each(G.refusals.map((c, i) => [i, c.fn, c.field, c]))('#%p %s refuses %s', (i, fn, field, c) => {
    const r = C[fn](c.args);
    expect(r.error).toBeDefined();
    expect(r.field).toBe(field);
    expect(r.error.startsWith(`${field}:`)).toBe(true);
  });

  test('every successful result carries a basis naming its model and source', () => {
    const results = [
      C.liquidOrificeDischarge(G.sourceTerms.liquid[0].args), C.gasOrificeDischarge(G.sourceTerms.gas[0].args),
      C.poolFromSpill(G.sourceTerms.pools[0].args), C.poolEvaporationMackayMatsugu(G.sourceTerms.evaporation[0].args),
      C.gaussianPlume(G.dispersion.plume[1].args), C.cylinderViewFactor(G.fires.viewFactor[0].args),
      C.poolFireSolidFlame(G.fires.ybPoolFire.args), C.kinneyGrahamOverpressure({ scaledDistanceMKg13: 5 }),
      C.thermalProbit({ heatFluxWM2: 1e4, exposureTimeS: 10 }), C.toxicProbit(G.probits.toxic[0].args),
    ];
    results.forEach((r) => {
      expect(r.error).toBeUndefined();
      expect(typeof r.basis.model).toBe('string');
      expect(typeof r.basis.source).toBe('string');
    });
  });
});
