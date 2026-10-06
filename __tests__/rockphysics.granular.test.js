/**
 * Granular rock physics gates (QI programme Q2, Milestone A1). Every gate
 * calls the shipped function. Expected values come from the independent
 * stdlib oracle (tools/validation/rockphysics/oracle_granular.py, which
 * asserts nine physics anchors before it writes goldens.granular.json); the
 * goldens also agree with rockphypy to 3e-15 (crosscheck_rockphypy.py,
 * dev time). Negative controls re-break the physics and must fail.
 */

import fs from 'fs';
import path from 'path';
import {
  poisson, hashinShtrikman, hertzMindlin, softSand, stiffSand, contactCement, constantCement,
  brieFluid, dryToVelocities, calibrateGranular,
} from '../engines/rockphysics/granular';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/rockphysics/goldens.granular.json'), 'utf8'));
const GPa = 1e9;
const MPa = 1e6;
const QZ = { K: 36.6 * GPa, G: 45 * GPa };
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-30);
const TOL = 1e-12;

describe('goldens: every model against the oracle', () => {
  test('Hertz-Mindlin (18 cases, both slip conditions)', () => {
    expect(G.hertzMindlin).toHaveLength(18);
    for (const r of G.hertzMindlin) {
      const m = hertzMindlin({ K: r.K, G: r.G, phiC: r.phiC, n: r.n, P: r.P, f: r.f });
      expect(rel(m.K, r.k)).toBeLessThan(TOL);
      expect(rel(m.G, r.g)).toBeLessThan(TOL);
    }
  });
  test.each([['softSand', softSand], ['stiffSand', stiffSand]])('%s', (key, fn) => {
    for (const r of G[key]) {
      const m = fn({ K: r.K, G: r.G, phi: r.phi, phiC: r.phiC, n: r.n, P: r.P });
      expect(rel(m.K, r.k)).toBeLessThan(TOL);
      expect(rel(m.G, r.g)).toBeLessThan(TOL);
    }
  });
  test('contact cement, both schemes', () => {
    expect(new Set(G.contactCement.map((r) => r.scheme))).toEqual(new Set(['surface', 'contact']));
    for (const r of G.contactCement) {
      const m = contactCement(r);
      expect(rel(m.K, r.k)).toBeLessThan(TOL);
      expect(rel(m.G, r.g)).toBeLessThan(TOL);
    }
  });
  test('constant cement', () => {
    for (const r of G.constantCement) {
      const m = constantCement(r);
      expect(rel(m.K, r.k)).toBeLessThan(TOL);
      expect(rel(m.G, r.g)).toBeLessThan(TOL);
    }
  });
  test('Hashin-Shtrikman-Walpole, including a fluid phase', () => {
    for (const r of G.hs) {
      const b = hashinShtrikman(r.phases);
      for (const k of ['kUpper', 'kLower', 'gUpper', 'gLower']) {
        if (r[k] === 0) expect(b[k]).toBe(0);
        else expect(rel(b[k], r[k])).toBeLessThan(TOL);
      }
    }
  });
  test('Brie', () => {
    for (const r of G.brie) expect(rel(brieFluid(r), r.k)).toBeLessThan(TOL);
  });
});

describe('physics identities', () => {
  const hm = hertzMindlin({ ...QZ, phiC: 0.36, n: 9, P: 20 * MPa });
  test('soft and stiff sand equal Hertz-Mindlin at critical porosity and the mineral at zero', () => {
    for (const fn of [softSand, stiffSand]) {
      const c = fn({ ...QZ, phi: 0.36, phiC: 0.36, n: 9, P: 20 * MPa });
      expect(rel(c.K, hm.K)).toBeLessThan(TOL);
      expect(rel(c.G, hm.G)).toBeLessThan(TOL);
      const z = fn({ ...QZ, phi: 0, phiC: 0.36, n: 9, P: 20 * MPa });
      expect(rel(z.K, QZ.K)).toBeLessThan(TOL);
      expect(rel(z.G, QZ.G)).toBeLessThan(TOL);
    }
  });
  test('stiff sand bounds soft sand from above at every interior porosity', () => {
    for (const phi of [0.02, 0.1, 0.2, 0.3, 0.35]) {
      const s = softSand({ ...QZ, phi, phiC: 0.36, n: 9, P: 20 * MPa });
      const t = stiffSand({ ...QZ, phi, phiC: 0.36, n: 9, P: 20 * MPa });
      expect(t.K).toBeGreaterThan(s.K);
      expect(t.G).toBeGreaterThan(s.G);
    }
  });
  test('Hertz-Mindlin moduli scale as pressure to the 1/3', () => {
    const a = hertzMindlin({ ...QZ, phiC: 0.36, n: 9, P: 10 * MPa });
    const b = hertzMindlin({ ...QZ, phiC: 0.36, n: 9, P: 80 * MPa });
    expect(rel(b.K / a.K, 2)).toBeLessThan(TOL);
    expect(rel(b.G / a.G, 2)).toBeLessThan(TOL);
  });
  test('frictionless contacts (f = 0): shear over the no-slip shear is (2 - nu) / (5 - 4 nu); bulk unchanged', () => {
    const r = hertzMindlin({ ...QZ, phiC: 0.36, n: 9, P: 20 * MPa, f: 0 });
    const nu = poisson(QZ.K, QZ.G);
    expect(rel(r.G / hm.G, (2 - nu) / (5 - 4 * nu))).toBeLessThan(TOL);
    expect(rel(r.K, hm.K)).toBeLessThan(TOL);
  });
  test('HS bounds of one phase are the phase; bounds sit inside Voigt-Reuss; equal phases collapse', () => {
    const one = hashinShtrikman([{ ...QZ, f: 1 }]);
    expect(rel(one.kUpper, QZ.K)).toBeLessThan(TOL);
    expect(rel(one.gLower, QZ.G)).toBeLessThan(TOL);
    const two = hashinShtrikman([{ ...QZ, f: 0.6 }, { K: 21 * GPa, G: 7 * GPa, f: 0.4 }]);
    const kV = 0.6 * QZ.K + 0.4 * 21 * GPa;
    const kR = 1 / (0.6 / QZ.K + 0.4 / (21 * GPa));
    expect(two.kLower).toBeGreaterThanOrEqual(kR);
    expect(two.kUpper).toBeLessThanOrEqual(kV);
    expect(two.kUpper).toBeGreaterThan(two.kLower);
    const same = hashinShtrikman([{ ...QZ, f: 0.5 }, { ...QZ, f: 0.5 }]);
    expect(rel(same.kUpper, same.kLower)).toBeLessThan(TOL);
  });
  test('soft sand is the HS lower bound of the pack and the mineral', () => {
    const phi = 0.2;
    const hs = hashinShtrikman([{ K: hm.K, G: hm.G, f: phi / 0.36 }, { ...QZ, f: 1 - phi / 0.36 }]);
    const s = softSand({ ...QZ, phi, phiC: 0.36, n: 9, P: 20 * MPa });
    const t = stiffSand({ ...QZ, phi, phiC: 0.36, n: 9, P: 20 * MPa });
    expect(rel(s.K, hs.kLower)).toBeLessThan(TOL);
    expect(rel(s.G, hs.gLower)).toBeLessThan(TOL);
    expect(rel(t.K, hs.kUpper)).toBeLessThan(TOL);
    expect(rel(t.G, hs.gUpper)).toBeLessThan(TOL);
  });
  test('Brie: e = 1 is the Voigt mix; full water is the liquid; dry is the gas', () => {
    expect(rel(brieFluid({ kLiquid: 2.8e9, kGas: 5e7, sw: 0.4, e: 1 }), 0.4 * 2.8e9 + 0.6 * 5e7)).toBeLessThan(TOL);
    expect(brieFluid({ kLiquid: 2.8e9, kGas: 5e7, sw: 1, e: 5 })).toBe(2.8e9);
    expect(brieFluid({ kLiquid: 2.8e9, kGas: 5e7, sw: 0, e: 5 })).toBe(5e7);
  });
  test('contact cement stiffens monotonically as cement fills the pore space', () => {
    let prev = { K: 0, G: 0 };
    for (const phi of [0.359, 0.35, 0.33, 0.3, 0.25]) {
      const c = contactCement({ ...QZ, Kc: QZ.K, Gc: QZ.G, phi, phi0: 0.36, n: 9 });
      expect(c.K).toBeGreaterThan(prev.K);
      expect(c.G).toBeGreaterThan(prev.G);
      prev = c;
    }
  });
  test('constant cement meets contact cement at its end porosity and the mineral at zero', () => {
    const args = { ...QZ, Kc: QZ.K, Gc: QZ.G, phiB: 0.33, phi0: 0.36, n: 9 };
    const b = contactCement({ ...args, phi: 0.33 });
    const c = constantCement({ ...args, phi: 0.33 });
    expect(rel(c.K, b.K)).toBeLessThan(TOL);
    const z = constantCement({ ...args, phi: 0 });
    expect(rel(z.G, QZ.G)).toBeLessThan(TOL);
  });
  test('Gassmann: a dry rock with the mineral as fluid returns the mineral modulus', () => {
    const d = softSand({ ...QZ, phi: 0.2, phiC: 0.36, n: 9, P: 20 * MPa });
    const v = dryToVelocities({ kdry: d.K, gdry: d.G, kmin: QZ.K, kfl: QZ.K, phi: 0.2, rhoMin: 2650, rhoFl: 1000 });
    expect(rel(v.ksat, QZ.K)).toBeLessThan(1e-10);
  });
});

describe('calibration', () => {
  const mineral = { ...QZ, rho: 2650 };
  const fluid = { K: 2.8 * GPa, rho: 1030 };
  const synth = (model, n) => [0.12, 0.18, 0.22, 0.27, 0.31].map((phi) => {
    const d = model({ ...QZ, phi, phiC: 0.36, n, P: 20 * MPa });
    const v = dryToVelocities({ kdry: d.K, gdry: d.G, kmin: QZ.K, kfl: fluid.K, phi, rhoMin: 2650, rhoFl: 1030 });
    return { phi, vp: v.vp, vs: v.vs };
  });
  test('recovers the coordination number of synthetic soft-sand data with zero residual', () => {
    const r = calibrateGranular({ model: 'soft', samples: synth(softSand, 8), mineral, fluid, phiC: 0.36, P: 20 * MPa });
    expect(r.n).toBe(8);
    expect(r.rmsMs).toBeLessThan(1e-6);
    expect(r.atEdge).toBe(false);
  });
  test('negative control: the wrong model leaves a large residual', () => {
    const r = calibrateGranular({ model: 'stiff', samples: synth(softSand, 8), mineral, fluid, phiC: 0.36, P: 20 * MPa });
    expect(r.rmsMs).toBeGreaterThan(100);
  });
  test('flags a best fit on the edge of the grid', () => {
    const r = calibrateGranular({ model: 'soft', samples: synth(softSand, 30), mineral, fluid, phiC: 0.36, P: 20 * MPa });
    expect(r.n).toBe(20);
    expect(r.atEdge).toBe(true);
  });
  test('refuses too few usable samples', () => {
    expect(() => calibrateGranular({ model: 'soft', samples: synth(softSand, 8).slice(0, 2), mineral, fluid, phiC: 0.36, P: 20 * MPa })).toThrow(/at least 3/);
  });
});

describe('negative controls: broken physics fails the goldens', () => {
  test('Hertz-Mindlin with G instead of G squared misses', () => {
    const r = G.hertzMindlin[0];
    const nu = poisson(r.K, r.G);
    const broken = Math.cbrt((r.n * r.n * (1 - r.phiC) ** 2 * r.G * r.P) / (Math.PI ** 2 * (1 - nu) ** 2) / 18);
    expect(rel(broken, r.k)).toBeGreaterThan(0.5);
  });
  test('swapping soft and stiff sand misses the goldens at interior porosity', () => {
    const r = G.softSand.find((x) => x.phi === 0.2);
    const wrong = stiffSand({ K: r.K, G: r.G, phi: r.phi, phiC: r.phiC, n: r.n, P: r.P });
    expect(rel(wrong.K, r.k)).toBeGreaterThan(0.1);
  });
  test('swapping the cement schemes misses the goldens', () => {
    const r = G.contactCement.find((x) => x.scheme === 'surface' && x.phi === 0.3);
    const wrong = contactCement({ ...r, scheme: 'contact' });
    expect(rel(wrong.K, r.k)).toBeGreaterThan(0.01);
  });
  test('the Wood (Reuss) fluid mix is not Brie e = 1', () => {
    const r = G.brie.find((x) => x.e === 1 && x.sw === 0.5);
    const wood = 1 / (r.sw / r.kLiquid + (1 - r.sw) / r.kGas);
    expect(rel(wood, r.k)).toBeGreaterThan(0.5);
  });
});

describe('input guards', () => {
  test.each([
    ['porosity above critical', () => softSand({ ...QZ, phi: 0.4, phiC: 0.36, n: 9, P: 1e7 })],
    ['negative pressure', () => hertzMindlin({ ...QZ, phiC: 0.36, n: 9, P: -1 })],
    ['fractions not summing to 1', () => hashinShtrikman([{ ...QZ, f: 0.5 }])],
    ['unknown cement scheme', () => contactCement({ ...QZ, Kc: QZ.K, Gc: QZ.G, phi: 0.3, phi0: 0.36, n: 9, scheme: 'x' })],
    ['Brie exponent below 1', () => brieFluid({ kLiquid: 2.8e9, kGas: 5e7, sw: 0.5, e: 0.5 })],
    ['unknown model', () => calibrateGranular({ model: 'cement', samples: [], mineral: {}, fluid: {}, phiC: 0.36, P: 1e7 })],
  ])('throws on %s', (_n, fn) => expect(fn).toThrow());
});
