/**
 * Inclusion rock physics gates (QI programme Q2, Milestone A1b): Berryman
 * P and Q, Kuster-Toksoz, differential effective medium and Xu-White. Every
 * gate calls the shipped function. Expected values come from the
 * independent stdlib oracle (tools/validation/rockphysics/oracle_inclusion.py,
 * anchors B1-B7, DEM by RK4 at 20,000 steps); the goldens agree with
 * rockphypy's P and Q to 6e-15 and with an adaptive odeint DEM to 2e-12.
 * Negative controls re-break the physics and must fail.
 */

import fs from 'fs';
import path from 'path';
import { berrymanPQ, kusterToksoz, differentialEffectiveMedium, xuWhite } from '../engines/rockphysics/inclusion';
import { hashinShtrikman } from '../engines/rockphysics/granular';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/rockphysics/goldens.inclusion.json'), 'utf8'));
const GPa = 1e9;
const QZ = { K: 36.6 * GPa, G: 45 * GPa };
const CL = { K: 21 * GPa, G: 7 * GPa };
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-30);

describe('goldens', () => {
  test('P and Q: dry, fluid and clay inclusions, oblate to prolate (21 cases)', () => {
    expect(G.pq).toHaveLength(21);
    for (const r of G.pq) {
      const { P, Q } = berrymanPQ(r.Km, r.Gm, r.Ki, r.Gi, r.alpha);
      expect(rel(P, r.P)).toBeLessThan(1e-12);
      expect(rel(Q, r.Q)).toBeLessThan(1e-12);
    }
  });
  test('Kuster-Toksoz', () => {
    for (const r of G.kt) {
      const m = kusterToksoz({ Km: r.Km, Gm: r.Gm, inclusions: r.inclusions });
      expect(rel(m.K, r.K)).toBeLessThan(1e-12);
      expect(rel(m.G, r.G)).toBeLessThan(1e-12);
    }
  });
  test('differential effective medium, one and two pore types, at the default 400 steps', () => {
    for (const r of G.dem) {
      const m = differentialEffectiveMedium({ Km: r.Km, Gm: r.Gm, inclusions: r.inclusions, y: r.y });
      expect(rel(m.K, r.K)).toBeLessThan(1e-7);
      expect(rel(m.G, r.G)).toBeLessThan(1e-7);
    }
  });
  test('Xu-White dry frame and mineral moduli', () => {
    for (const r of G.xuWhite) {
      const m = xuWhite({ phi: r.phi, vclay: r.vclay, sand: { ...QZ, rho: 2650 }, clay: { ...CL, rho: 2600 } });
      expect(rel(m.kmin, r.kmin)).toBeLessThan(1e-12);
      expect(rel(m.gmin, r.gmin)).toBeLessThan(1e-12);
      expect(rel(m.kdry, r.kdry)).toBeLessThan(1e-7);
      expect(rel(m.gdry, r.gdry)).toBeLessThan(1e-7);
    }
  });
});

describe('physics identities', () => {
  test('DEM dry spheres in a Poisson 0.2 host: K and G scale as (1 - phi)^2', () => {
    const m = differentialEffectiveMedium({ Km: 40 * GPa, Gm: 30 * GPa, inclusions: [{ K: 0, G: 0, alpha: 1, w: 1 }], y: 0.3 });
    expect(rel(m.K, 40 * GPa * 0.49)).toBeLessThan(1e-8);
    expect(rel(m.G, 30 * GPa * 0.49)).toBeLessThan(1e-8);
  });
  test('Kuster-Toksoz with dry spheres equals the Hashin-Shtrikman upper bound', () => {
    const kt = kusterToksoz({ Km: QZ.K, Gm: QZ.G, inclusions: [{ K: 0, G: 0, alpha: 1, x: 0.2 }] });
    const hs = hashinShtrikman([{ ...QZ, f: 0.8 }, { K: 0, G: 0, f: 0.2 }]);
    expect(rel(kt.K, hs.kUpper)).toBeLessThan(1e-12);
    expect(rel(kt.G, hs.gUpper)).toBeLessThan(1e-12);
  });
  test('P and Q are continuous through the sphere', () => {
    const s = berrymanPQ(QZ.K, QZ.G, 0, 0, 1);
    for (const a of [0.9999, 1.0001]) {
      const p = berrymanPQ(QZ.K, QZ.G, 0, 0, a);
      expect(rel(p.P, s.P)).toBeLessThan(1e-3);
      expect(rel(p.Q, s.Q)).toBeLessThan(1e-3);
    }
  });
  test('an inclusion of the host material changes nothing', () => {
    const m = differentialEffectiveMedium({ Km: QZ.K, Gm: QZ.G, inclusions: [{ ...QZ, alpha: 0.05, w: 1 }], y: 0.3 });
    expect(rel(m.K, QZ.K)).toBeLessThan(1e-12);
    expect(rel(m.G, QZ.G)).toBeLessThan(1e-12);
  });
  test('flatter pores are softer at equal porosity; clay-related pores soften Xu-White', () => {
    const round = differentialEffectiveMedium({ Km: QZ.K, Gm: QZ.G, inclusions: [{ K: 0, G: 0, alpha: 0.5, w: 1 }], y: 0.15 });
    const flat = differentialEffectiveMedium({ Km: QZ.K, Gm: QZ.G, inclusions: [{ K: 0, G: 0, alpha: 0.05, w: 1 }], y: 0.15 });
    expect(flat.K).toBeLessThan(round.K);
    const sand = { ...QZ, rho: 2650 };
    const same = xuWhite({ phi: 0.2, vclay: 0.2, sand, clay: { ...CL, rho: 2600 }, alphaClay: 0.12 });
    const real = xuWhite({ phi: 0.2, vclay: 0.2, sand, clay: { ...CL, rho: 2600 } });
    expect(real.kdry).toBeLessThan(same.kdry);
  });
  test('Xu-White with brine: velocities fall with porosity and with clay; Vp/Vs above sqrt(2)', () => {
    const run = (phi, vclay) => xuWhite({ phi, vclay, sand: { ...QZ, rho: 2650 }, clay: { ...CL, rho: 2600 }, fluid: { K: 2.8 * GPa, rho: 1030 } });
    const a = run(0.15, 0.1);
    const b = run(0.25, 0.1);
    const c = run(0.15, 0.3);
    expect(b.vp).toBeLessThan(a.vp);
    expect(c.vp).toBeLessThan(a.vp);
    expect(a.vp / a.vs).toBeGreaterThan(Math.SQRT2);
    expect(a.vp).toBeGreaterThan(3000);
    expect(a.vp).toBeLessThan(5500);
  });
});

describe('negative controls', () => {
  test('swapping the background bulk and shear moduli (the rockphypy DEM defect) misses the goldens', () => {
    const r = G.pq.find((x) => x.alpha === 0.12 && x.Ki === 0);
    const wrong = berrymanPQ(r.Gm, r.Km, r.Ki, r.Gi, r.alpha);
    expect(rel(wrong.P, r.P)).toBeGreaterThan(0.01);
  });
  test('prolate theta with 1/cosh in place of arccosh (the rockphypy PQ defect) misses', () => {
    const r = G.pq.find((x) => x.alpha === 2 && x.Ki === 0);
    // the correct engine matches; a 1/cosh theta gives a different P
    const a = 2;
    const thetaBad = (a / (a * a - 1) ** 1.5) * (a * Math.sqrt(a * a - 1) - 1 / Math.cosh(a));
    const thetaOk = (a / (a * a - 1) ** 1.5) * (a * Math.sqrt(a * a - 1) - Math.acosh(a));
    expect(rel(thetaBad, thetaOk)).toBeGreaterThan(0.1);
    expect(rel(berrymanPQ(r.Km, r.Gm, r.Ki, r.Gi, a).P, r.P)).toBeLessThan(1e-12);
  });
  test('dilute Kuster-Toksoz is not DEM at real porosity with flat pores', () => {
    const r = G.dem.find((x) => x.inclusions.length === 1 && x.inclusions[0].alpha === 0.12 && x.y === 0.25);
    const kt = kusterToksoz({ Km: r.Km, Gm: r.Gm, inclusions: [{ K: 0, G: 0, alpha: 0.12, x: 0.25 }] });
    expect(rel(kt.K, r.K)).toBeGreaterThan(0.1);
  });
  test('too few DEM steps are measurably off the oracle', () => {
    const r = G.dem.find((x) => x.inclusions.length === 2);
    const coarse = differentialEffectiveMedium({ Km: r.Km, Gm: r.Gm, inclusions: r.inclusions, y: r.y, steps: 2 });
    expect(rel(coarse.K, r.K)).toBeGreaterThan(1e-6);
  });
});

describe('guards', () => {
  test.each([
    ['shares not summing to 1', () => differentialEffectiveMedium({ Km: QZ.K, Gm: QZ.G, inclusions: [{ K: 0, G: 0, alpha: 0.1, w: 0.5 }], y: 0.1 })],
    ['zero aspect ratio', () => berrymanPQ(QZ.K, QZ.G, 0, 0, 0)],
    ['clay above the solid', () => xuWhite({ phi: 0.3, vclay: 0.8, sand: { ...QZ, rho: 2650 }, clay: { ...CL, rho: 2600 } })],
    ['a frame with no usable stiffness', () => differentialEffectiveMedium({ Km: QZ.K, Gm: QZ.G, inclusions: [{ K: 0, G: 0, alpha: 0.001, w: 1 }], y: 0.5 })],
    ['Kuster-Toksoz far outside its dilute range', () => kusterToksoz({ Km: QZ.K, Gm: QZ.G, inclusions: [{ K: 0, G: 0, alpha: 0.001, x: 0.5 }] })],
  ])('throws on %s', (_n, fn) => expect(fn).toThrow());
});
