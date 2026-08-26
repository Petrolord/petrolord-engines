// Rheology fits: closed-form identities + oracle golden agreement.
import fs from 'fs';
import path from 'path';
import {
  fitModels, stressAtRate, localPowerLaw, apparentViscosity,
  TAU_PER_DEG_PA, GAMMA_PER_RPM,
} from '../engines/drilling/rheology.js';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8'));

function expectClose(a, b, rtol, atol = 0) {
  if (!Number.isFinite(a)) throw new Error(`non-finite value ${a} (expected ~ ${b})`);
  const tol = atol + rtol * Math.abs(b);
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} ~ ${b} (rtol ${rtol}, atol ${atol})`);
  }
}

const R600 = 600 * GAMMA_PER_RPM;
const R300 = 300 * GAMMA_PER_RPM;

describe('closed-form identities', () => {
  const fann = { theta600: 64, theta300: 38, theta6: 7, theta3: 6 };
  const fits = fitModels(fann);

  test('every fitted model reproduces the 300 and 600 rpm readings exactly', () => {
    const t600 = TAU_PER_DEG_PA * fann.theta600;
    const t300 = TAU_PER_DEG_PA * fann.theta300;
    for (const m of [fits.bingham, fits.powerLaw, fits.herschelBulkley]) {
      expectClose(stressAtRate(m, R300), t300, 1e-12);
      expectClose(stressAtRate(m, R600), t600, 1e-12);
    }
  });

  test('HB yield sits at the RP 13D low-shear estimate', () => {
    expectClose(fits.herschelBulkley.tauYPa, TAU_PER_DEG_PA * (2 * 6 - 7), 1e-12);
  });

  test('localPowerLaw: exact n for power law, n=1 for Newtonian', () => {
    expectClose(localPowerLaw(fits.powerLaw, 100).nPrime, fits.powerLaw.n, 1e-12);
    const newton = { type: 'bingham', pvPaS: 0.03, ypPa: 0 };
    expectClose(localPowerLaw(newton, 500).nPrime, 1, 1e-12);
    expectClose(apparentViscosity(newton, 500), 0.03, 1e-12);
  });

  test('guards', () => {
    expect(() => fitModels({ theta600: 30, theta300: 38 })).toThrow();
    expect(() => stressAtRate({ type: 'nope' }, 1)).toThrow(/Unknown/);
    expect(() => stressAtRate(fits.bingham, -1)).toThrow();
  });
});

describe('oracle golden agreement (hydraulics_cases.json fits)', () => {
  const golden = G('hydraulics_cases.json');
  for (const c of golden.cases) {
    test(`${c.well}/${c.mudName} fits`, () => {
      const fits = fitModels(c.mud.fann);
      expectClose(fits.bingham.pvPaS, c.fits.bingham.pvPaS, 1e-6, 1e-9);
      expectClose(fits.bingham.ypPa, c.fits.bingham.ypPa, 1e-6, 1e-9);
      expectClose(fits.powerLaw.n, c.fits.powerLaw.n, 1e-6, 1e-9);
      expectClose(fits.powerLaw.kPaSn, c.fits.powerLaw.kPaSn, 1e-6, 1e-9);
      expectClose(fits.herschelBulkley.tauYPa, c.fits.herschelBulkley.tauYPa, 1e-6, 1e-9);
      expectClose(fits.herschelBulkley.n, c.fits.herschelBulkley.n, 1e-6, 1e-9);
      expectClose(fits.herschelBulkley.kPaSn, c.fits.herschelBulkley.kPaSn, 1e-6, 1e-9);
    });
  }
});
