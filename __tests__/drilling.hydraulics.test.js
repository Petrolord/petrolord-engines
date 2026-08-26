// Circulating hydraulics: closed forms (Hagen-Poiseuille, power-law
// laminar, bit/ECD algebra) + oracle golden agreement.
import fs from 'fs';
import path from 'path';
import {
  computeHydraulics, elementLoss, bitHydraulics, buildFlowElements,
} from '../engines/drilling/hydraulics.js';
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

describe('closed forms', () => {
  test('Newtonian laminar pipe = Hagen-Poiseuille exactly', () => {
    const mu = 0.05;
    const model = { type: 'bingham', pvPaS: mu, ypPa: 0 };
    const d = 0.1086;
    const L = 1000;
    const q = 0.004; // laminar: v=0.43 m/s, Re ~ 1350
    const v = q / ((Math.PI / 4) * d * d);
    const loss = elementLoss({ model, rhoKgM3: 1440, vMs: v, dCharM: d, kind: 'pipe', lengthM: L });
    const hp = (128 * mu * L * q) / (Math.PI * d ** 4);
    expect(loss.regime).toBe('laminar');
    expectClose(loss.dpPa, hp, 1e-12);
  });

  test('power-law laminar pipe: ΔP = 4·L·τw/d exactly', () => {
    const model = { type: 'powerLaw', n: 0.7, kPaSn: 0.5 };
    const d = 0.1086;
    const L = 800;
    const q = 0.006;
    const v = q / ((Math.PI / 4) * d * d);
    const gw = ((8 * v) / d) * ((3 * 0.7 + 1) / (4 * 0.7));
    const tw = 0.5 * gw ** 0.7;
    const loss = elementLoss({ model, rhoKgM3: 1300, vMs: v, dCharM: d, kind: 'pipe', lengthM: L });
    expect(loss.regime).toBe('laminar');
    expectClose(loss.dpPa, (4 * L * tw) / d, 1e-9);
  });

  test('Newtonian laminar slot annulus: ΔP = 12·μ·v·L/h² exactly', () => {
    const mu = 0.04;
    const model = { type: 'bingham', pvPaS: mu, ypPa: 0 };
    const dChar = 0.05; // = 2h
    const h = dChar / 2;
    const v = 0.4;
    const L = 500;
    const loss = elementLoss({ model, rhoKgM3: 1200, vMs: v, dCharM: dChar, kind: 'annulus', lengthM: L });
    expect(loss.regime).toBe('laminar');
    expectClose(loss.dpPa, (12 * mu * v * L) / (h * h), 1e-9);
  });

  test('bit algebra: ΔP = ρQ²/(2Cd²A²), power and impact identities', () => {
    const bit = bitHydraulics({ rhoKgM3: 1440, flowRateM3s: 0.025, nozzleTfaM2: 4.618e-4 });
    expectClose(bit.dpPa, (1440 * 0.025 ** 2) / (2 * 0.95 ** 2 * 4.618e-4 ** 2), 1e-12);
    expectClose(bit.jetVelocityMs, 0.025 / 4.618e-4, 1e-12);
    expectClose(bit.hydraulicPowerW, bit.dpPa * 0.025, 1e-12);
    expectClose(bit.impactForceN, 1440 * 0.025 * bit.jetVelocityMs, 1e-12);
  });

  test('ECD algebra on a vertical well: ECD = ρ + ΔP_ann/(g·TVD)', () => {
    const stations = [{ md: 0, inc: 0, azi: 0 }, { md: 2000, inc: 0, azi: 0 }];
    const string = [{ type: 'dp', lengthM: 2000, odM: 0.127, idM: 0.1086, weightKgM: 33.1 }];
    const geometry = [{ fromMd: 0, toMd: 2000, frictionFactor: 0.25, holeIdM: 0.2205, cased: true }];
    const mud = { densityKgM3: 1440, model: fitModels({ theta600: 64, theta300: 38, theta6: 7, theta3: 6 }).herschelBulkley };
    const res = computeHydraulics({ stations, string, geometry, mud, flowRateM3s: 0.025, nozzleTfaM2: 4.618e-4 });
    const last = res.ecdProfile[res.ecdProfile.length - 1];
    expectClose(last.tvd, 2000, 1e-9);
    expectClose(last.ecdKgM3, 1440 + res.summary.annulusDpPa / (g * 2000), 1e-9);
    expectClose(res.summary.pumpPressurePa,
      res.summary.pipeDpPa + res.summary.bitDpPa + res.summary.annulusDpPa, 1e-12);
  });

  test('guards and warnings', () => {
    const stations = [{ md: 0, inc: 0, azi: 0 }, { md: 1000, inc: 0, azi: 0 }];
    const string = [{ type: 'dp', lengthM: 1000, odM: 0.127, idM: 0.1086, weightKgM: 33.1 }];
    const geometry = [{ fromMd: 0, toMd: 500, frictionFactor: 0.25, holeIdM: 0.2205, cased: true }];
    const mud = { densityKgM3: 1200, model: { type: 'powerLaw', n: 0.7, kPaSn: 0.4 } };
    const res = computeHydraulics({ stations, string, geometry, mud, flowRateM3s: 0.02 });
    expect(res.summary.warnings.join(' ')).toMatch(/does not cover/);
    expect(res.summary.warnings.join(' ')).toMatch(/No nozzle TFA/);
    expect(() => computeHydraulics({ stations, string, geometry, mud, flowRateM3s: 0 })).toThrow();
    expect(buildFlowElements({ stations, string, geometry }).bitMd).toBe(1000);
  });
});

describe('oracle golden agreement (hydraulics_cases.json)', () => {
  const golden = G('hydraulics_cases.json');
  for (const c of golden.cases) {
    const mud = { densityKgM3: c.mud.densityKgM3, model: fitModels(c.mud.fann).herschelBulkley };
    for (const q of c.flowRates) {
      test(`${c.well}/${c.mudName} q=${q}`, () => {
        const exp = c.expected.hydraulics[`q_${q}`];
        const res = computeHydraulics({
          stations: c.stations, string: c.string, geometry: c.geometry,
          mud, flowRateM3s: q, nozzleTfaM2: c.nozzleTfaM2,
        });
        expectClose(res.summary.pumpPressurePa, exp.pumpPressurePa, 1e-6, 1);
        expectClose(res.summary.pipeDpPa, exp.pipeDpPa, 1e-6, 1);
        expectClose(res.summary.annulusDpPa, exp.annulusDpPa, 1e-6, 1);
        expectClose(res.summary.bitDpPa, exp.bitDpPa, 1e-6, 1);
        expectClose(res.summary.ecdAtTdKgM3, exp.ecdAtTdKgM3, 1e-6, 1e-4);
        expectClose(res.summary.minAnnularVelocityMs, exp.minAnnularVelocityMs, 1e-6, 1e-9);
      });
    }
  }
});
