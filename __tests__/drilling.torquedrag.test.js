// Soft-string torque & drag: closed-form exactness + oracle golden agreement.
// Goldens: tools/validation/drilling/oracle_torquedrag.py (independent RK4
// on the Johancsik/Sheppard ODE with vector-slerp attitude).
import fs from 'fs';
import path from 'path';
import {
  computeTorqueDrag, bucklingLimits, stringProperties, buoyancyFactor,
  STEEL_DENSITY_KGM3,
} from '../engines/drilling/torqueDrag.js';

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

describe('closed forms (exact)', () => {
  const pipe = { type: 'dp', lengthM: 2000, odM: 0.127, idM: 0.1086, weightKgM: 33.13 };
  const mud = { densityKgM3: 1440 };
  const bf = buoyancyFactor(1440);

  test('vertical well: trip hookload = buoyed weight, zero torque', () => {
    const stations = [{ md: 0, inc: 0, azi: 0 }, { md: 2000, inc: 0, azi: 0 }];
    const geometry = [{ fromMd: 0, toMd: 2000, frictionFactor: 0.3, holeIdM: 0.2205, cased: true }];
    const res = computeTorqueDrag({
      stations, string: [pipe], geometry, mud, operation: 'trip_out', params: { stepM: 10 },
    });
    const w = pipe.weightKgM * g * bf * 2000;
    expectClose(res.summary.hookloadN, w, 1e-9);
    expect(res.summary.surfaceTorqueNm).toBe(0);
  });

  test('straight slant: T = wL(cos θ ± μ sin θ) exactly, any step', () => {
    const theta = 30;
    const mu = 0.3;
    const stations = [{ md: 0, inc: theta, azi: 45 }, { md: 1500, inc: theta, azi: 45 }];
    const geometry = [{ fromMd: 0, toMd: 1500, frictionFactor: mu, holeIdM: 0.2159, cased: false }];
    const w = pipe.weightKgM * g * bf;
    const c = Math.cos((theta * Math.PI) / 180);
    const s = Math.sin((theta * Math.PI) / 180);
    for (const [op, sign] of [['trip_out', +1], ['trip_in', -1]]) {
      const res = computeTorqueDrag({
        stations, string: [{ ...pipe, lengthM: 1500 }], geometry, mud, operation: op,
        params: { stepM: 50 },
      });
      expectClose(res.summary.hookloadN, w * 1500 * (c + sign * mu * s), 1e-9);
    }
  });

  test('horizontal string: pickup μwL, rotating torque μwLr', () => {
    const mu = 0.25;
    const stations = [{ md: 0, inc: 90, azi: 0 }, { md: 1000, inc: 90, azi: 0 }];
    const geometry = [{ fromMd: 0, toMd: 1000, frictionFactor: mu, holeIdM: 0.2159, cased: false }];
    const str = [{ ...pipe, lengthM: 1000, tooljointOdM: 0.1683 }];
    const w = pipe.weightKgM * g * bf;
    const out = computeTorqueDrag({ stations, string: str, geometry, mud, operation: 'trip_out', params: { stepM: 25 } });
    expectClose(out.summary.hookloadN, mu * w * 1000, 1e-9);
    const rot = computeTorqueDrag({ stations, string: str, geometry, mud, operation: 'rotate_off_bottom', params: { stepM: 25 } });
    expectClose(rot.summary.surfaceTorqueNm, mu * w * 1000 * (0.1683 / 2), 1e-9);
    expectClose(rot.summary.hookloadN, 0, 0, 1e-9);
  });

  test('capstan limit: weightless quarter arc, slide compression = WOB·e^{μβ}', () => {
    // Build 0→90° over 900 m (DLS 3°/30m), weightless string, WOB at the bit.
    const stations = [];
    for (let md = 0; md <= 900; md += 30) {
      stations.push({ md, inc: md / 10, azi: 0 });
    }
    const mu = 0.3;
    const wob = 100000;
    const geometry = [{ fromMd: 0, toMd: 900, frictionFactor: mu, holeIdM: 0.2159, cased: false }];
    const str = [{ type: 'dp', lengthM: 900, odM: 0.127, idM: 0.1086, weightKgM: 0 }];
    const res = computeTorqueDrag({
      stations, string: str, geometry, mud: { densityKgM3: 0 }, operation: 'slide_drill',
      params: { stepM: 0.5, wobN: wob },
    });
    const capstan = -wob * Math.exp((mu * Math.PI) / 2);
    expectClose(res.summary.hookloadN, capstan, 1e-3);
  });

  test('rotating with WOB through weightless arc: M = μ·WOB·β·r exactly', () => {
    const stations = [];
    for (let md = 0; md <= 900; md += 30) stations.push({ md, inc: md / 10, azi: 0 });
    const mu = 0.3;
    const wob = 100000;
    const rTj = 0.1683 / 2;
    const geometry = [{ fromMd: 0, toMd: 900, frictionFactor: mu, holeIdM: 0.2159, cased: false }];
    const str = [{ type: 'dp', lengthM: 900, odM: 0.127, idM: 0.1086, weightKgM: 0, tooljointOdM: 0.1683 }];
    const res = computeTorqueDrag({
      stations, string: str, geometry, mud: { densityKgM3: 0 }, operation: 'rotate_on_bottom',
      params: { stepM: 0.5, wobN: wob, bitTorqueNm: 0 },
    });
    expectClose(res.summary.surfaceTorqueNm, mu * wob * (Math.PI / 2) * rTj, 1e-3);
    // Rotating carries no axial friction: hookload = −WOB exactly (weightless).
    expectClose(res.summary.hookloadN, -wob, 1e-9);
  });
});

describe('oracle golden agreement (torquedrag_cases.json)', () => {
  const golden = G('torquedrag_cases.json');
  for (const c of golden.cases) {
    for (const [op, exp] of Object.entries(c.expected)) {
      test(`${c.name} / ${op}`, () => {
        const res = computeTorqueDrag({
          stations: c.stations,
          string: c.string,
          geometry: c.geometry,
          mud: { densityKgM3: c.mudDensityKgM3 },
          operation: op,
          params: { ...c.params, stepM: 1 },
        });
        const atolF = 200; // N floor for ~1e5-1e6 N values
        const atolM = 5;   // N·m floor
        expectClose(res.summary.hookloadN, exp.hookloadN, 1e-4, atolF);
        expectClose(res.summary.surfaceTorqueNm, exp.surfaceTorqueNm, 1e-4, atolM);
        expectClose(res.summary.maxTensionN, exp.maxTensionN, 1e-4, atolF);
        expectClose(res.summary.minTensionN, exp.minTensionN, 1e-4, atolF);
        for (const cp of exp.checkpoints) {
          const row = res.profile.find((r) => Math.abs(r.md - cp.md) < 0.51);
          expect(row).toBeTruthy();
          expectClose(row.tensionN, cp.tensionN, 2e-4, atolF);
          expectClose(row.torqueNm, cp.torqueNm, 2e-4, atolM);
        }
      });
    }
  }
});

describe('buckling and properties', () => {
  test('Paslay–Dawson / Chen–Cheatham algebra', () => {
    const eiNm2 = 2.1e6;
    const wc = 300;
    const r = 0.04;
    const lim = bucklingLimits({ eiNm2, wcNPerM: wc, incDeg: 60, radialClearanceM: r });
    const base = Math.sqrt((eiNm2 * wc * Math.sin(Math.PI / 3)) / r);
    expectClose(lim.sinusoidalN, 2 * base, 1e-12);
    expectClose(lim.helicalN, 2 * (2 * Math.SQRT2 - 1) * base, 1e-12);
  });

  test('stringProperties: area/EI/capacities for 5" 19.50 S-135', () => {
    const p = stringProperties({ odM: 0.127, idM: 0.1086, yieldPa: 9.30792195e8 });
    const area = (Math.PI / 4) * (0.127 ** 2 - 0.1086 ** 2);
    expectClose(p.areaM2, area, 1e-12);
    expectClose(p.tensileCapacityN, 9.30792195e8 * area, 1e-12);
    expect(p.eiNm2).toBeGreaterThan(0);
  });

  test('buoyancy factor and input guards', () => {
    expectClose(buoyancyFactor(1440), 1 - 1440 / STEEL_DENSITY_KGM3, 1e-15);
    expect(() => buoyancyFactor(8000)).toThrow();
    expect(() => computeTorqueDrag({ stations: [{ md: 0, inc: 0, azi: 0 }], string: [], geometry: [], mud: {}, operation: 'trip_out' })).toThrow();
    expect(() => computeTorqueDrag({
      stations: [{ md: 0, inc: 0, azi: 0 }, { md: 100, inc: 0, azi: 0 }],
      string: [{ type: 'dp', lengthM: 100, odM: 0.127, idM: 0.1086, weightKgM: 30 }],
      geometry: [{ fromMd: 0, toMd: 100, frictionFactor: 0.3, holeIdM: 0.22, cased: true }],
      mud: { densityKgM3: 1200 },
      operation: 'no_such_op',
    })).toThrow(/Unknown operation/);
  });

  test('horizontal compression flags buckling in the golden well', () => {
    const golden = G('torquedrag_cases.json');
    const c = golden.cases.find((x) => x.name === 'horizontal');
    const res = computeTorqueDrag({
      stations: c.stations, string: c.string, geometry: c.geometry,
      mud: { densityKgM3: c.mudDensityKgM3 }, operation: 'slide_drill',
      params: { ...c.params, stepM: 1 },
    });
    expect(res.summary.minTensionN).toBeLessThan(0);
    expect(res.profile.some((r) => r.buckling !== 'none')).toBe(true);
    expect(res.summary.bucklingFirstMd).not.toBeNull();
    expect(res.summary.warnings.length).toBeGreaterThan(0);
  });
});
