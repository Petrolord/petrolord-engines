// Surge/swab + hole cleaning: identities, monotonicity, oracle agreement.
import fs from 'fs';
import path from 'path';
import {
  computeSurgeSwab, sweepTripSpeeds, maxTripSpeed,
} from '../engines/drilling/surgeSwab.js';
import {
  computeHoleCleaning, minFlowRate, slipVelocity, dragCoefficient,
} from '../engines/drilling/holeCleaning.js';
import { fitModels } from '../engines/drilling/rheology.js';

const G = (name) => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'drilling', 'goldens', name), 'utf8'));

const g = 9.80665;

function expectClose(a, b, rtol, atol = 0) {
  if (!Number.isFinite(a)) throw new Error(`non-finite value ${a} (expected ~ ${b})`);
  const tol = atol + rtol * Math.abs(b);
  if (Math.abs(a - b) > tol) {
    throw new Error(`expected ${a} ~ ${b} (rtol ${rtol}, atol ${atol})`);
  }
}

const golden = G('hydraulics_cases.json');
const caseOf = (well, mudName) => golden.cases.find((c) => c.well === well && c.mudName === mudName);
const mudOf = (c) => ({ densityKgM3: c.mud.densityKgM3, model: fitModels(c.mud.fann).herschelBulkley });

describe('surge & swab', () => {
  const c = caseOf('horizontal', 'kcl_polymer');
  const args = () => ({
    stations: c.stations, string: c.string, geometry: c.geometry, mud: mudOf(c),
  });

  test('zero trip speed: surge = swab = static density', () => {
    const r = computeSurgeSwab({ ...args(), tripSpeedMs: 0 });
    expectClose(r.surgeEmwKgM3, c.mud.densityKgM3, 1e-12);
    expectClose(r.swabEmwKgM3, c.mud.densityKgM3, 1e-12);
    expect(r.dpPa).toBe(0);
  });

  test('surge/swab symmetric about static and monotone in speed', () => {
    const sweep = sweepTripSpeeds({ ...args(), speeds: [0.2, 0.5, 1.0] });
    for (const row of sweep) {
      expectClose(row.surgeEmwKgM3 - c.mud.densityKgM3, c.mud.densityKgM3 - row.swabEmwKgM3, 1e-9);
    }
    expect(sweep[1].dpPa).toBeGreaterThan(sweep[0].dpPa);
    expect(sweep[2].dpPa).toBeGreaterThan(sweep[1].dpPa);
  });

  test('closed-ended displaces more than open-ended', () => {
    const closed = computeSurgeSwab({ ...args(), tripSpeedMs: 0.5, mode: 'closed' });
    const open = computeSurgeSwab({ ...args(), tripSpeedMs: 0.5, mode: 'open' });
    expect(closed.dpPa).toBeGreaterThan(open.dpPa);
  });

  test('maxTripSpeed respects a swab (pore) limit and is attained', () => {
    const mud = mudOf(c);
    const swabAt05 = computeSurgeSwab({ ...args(), tripSpeedMs: 0.5 }).swabEmwKgM3;
    const v = maxTripSpeed({ ...args(), poreEmwKgM3: swabAt05 });
    expectClose(v, 0.5, 1e-3);
    expect(maxTripSpeed({ ...args(), poreEmwKgM3: mud.densityKgM3 + 1 })).toBe(0);
    expect(maxTripSpeed({ ...args() })).toBe(3);
  });

  test('oracle golden agreement', () => {
    for (const cc of golden.cases) {
      const mud = mudOf(cc);
      for (const [key, exp] of Object.entries(cc.expected.surgeSwab)) {
        const open = key.startsWith('open_');
        const v = parseFloat(key.replace('open_v_', '').replace('v_', ''));
        const r = computeSurgeSwab({
          stations: cc.stations, string: cc.string, geometry: cc.geometry, mud,
          tripSpeedMs: v, mode: open ? 'open' : 'closed',
        });
        expectClose(r.dpPa, exp.dpPa, 1e-6, 1);
        expectClose(r.surgeEmwKgM3, exp.surgeEmwKgM3, 1e-6, 1e-4);
        expectClose(r.swabEmwKgM3, exp.swabEmwKgM3, 1e-6, 1e-4);
      }
    }
  });
});

describe('hole cleaning', () => {
  const c = caseOf('slant', 'kcl_polymer');
  const args = () => ({
    stations: c.stations, string: c.string, geometry: c.geometry, mud: mudOf(c),
  });

  test('drag coefficient regimes', () => {
    expectClose(dragCoefficient(0.5), 48, 1e-12);
    expectClose(dragCoefficient(2000), 0.44, 1e-12);
    const re = 50;
    expectClose(dragCoefficient(re), (24 / re) * (1 + 0.15 * re ** 0.687), 1e-12);
  });

  test('Stokes limit: tiny particle recovers vs = g·d²·Δρ/(18μ)', () => {
    const newton = { type: 'bingham', pvPaS: 0.05, ypPa: 0 };
    const { slipMs } = slipVelocity({
      mudModel: newton, rhoFluidKgM3: 1200, rhoSolidKgM3: 2600, dParticleM: 1e-4, gammaDot: 100,
    });
    const stokes = (g * 1e-8 * 1400) / (18 * 0.05);
    expectClose(slipMs, stokes, 1e-3);
  });

  test('oracle golden agreement + inclination warning', () => {
    for (const cc of golden.cases) {
      const res = computeHoleCleaning({
        stations: cc.stations, string: cc.string, geometry: cc.geometry, mud: mudOf(cc),
        flowRateM3s: 0.025, cuttings: { ropMs: 0.005, dParticleM: 0.006, rhoSolidKgM3: 2600 },
      });
      const exp = cc.expected.holeCleaning;
      expectClose(res.summary.minTransportRatio, exp.minTransportRatio, 1e-6, 1e-9);
      expectClose(res.summary.feedM3s, exp.feedM3s, 1e-6, 1e-12);
      expect(res.rows.length).toBe(exp.rows.length);
      for (let i = 0; i < res.rows.length; i += 1) {
        expectClose(res.rows[i].slipMs, exp.rows[i].slipMs, 1e-6, 1e-9);
        expectClose(res.rows[i].transportRatio, exp.rows[i].transportRatio, 1e-6, 1e-9);
      }
    }
    const horiz = caseOf('horizontal', 'kcl_polymer');
    const res = computeHoleCleaning({
      stations: horiz.stations, string: horiz.string, geometry: horiz.geometry, mud: mudOf(horiz),
      flowRateM3s: 0.025, cuttings: {},
    });
    expect(res.summary.warnings.join(' ')).toMatch(/35 deg/);
  });

  test('minFlowRate: bisection lands on the target transport ratio', () => {
    const q = minFlowRate({ ...args(), targetTr: 0.85, qMaxM3s: 0.2 });
    expect(q).not.toBeNull();
    const at = computeHoleCleaning({ ...args(), flowRateM3s: q }).summary.minTransportRatio;
    expectClose(at, 0.85, 5e-3);
    expect(minFlowRate({ ...args(), targetTr: 0.999999, qMaxM3s: 0.03 })).toBeNull();
  });
});
