/**
 * Well Test U2-013: negative skin on the radial, rectangle and
 * dual-porosity models through the effective-wellbore-radius mapping with
 * every rw-based group rescaled (modelCatalog withNegativeSkin).
 *
 * Gates (each calls the catalog's own pwdLaplace):
 *  1. on the infinite homogeneous radial solution the mapping equals the WT1
 *     homogeneous model's negative-skin route (pwdLaplaceHomogeneous);
 *  2. once the near-well transient is over, a skin only shifts the pressure:
 *     pwD(tD; S < 0) - pwD(tD; 0) = S at late time for every model, through
 *     its boundary or its fissure transition (no storage);
 *  3. the infinite-acting part sits on the radial semilog line
 *     0.5 (ln tD + 0.80907) + S;
 *  4. negative control: a mapping that rescales time but not the boundary
 *     distances (or lambda) breaks gate 2 by far more than its tolerance.
 */
import { stehfestInvert } from '../engines/welltest/numerics.js';
import { pwdLaplaceHomogeneous } from '../engines/welltest/models/homogeneous.js';
import { makeRadialPwdLaplace } from '../engines/welltest/models/radial.js';
import { getModel, withNegativeSkin, toDimensionlessGroups, evaluateDrawdown } from '../engines/welltest/models/modelCatalog.js';

const pwd = (lap, d, tD) => stehfestInvert((u) => lap(u, d), tD, 12);

describe('negative skin on the non-homogeneous models', () => {
  test('gate 1: the infinite radial solution with the mapping equals the homogeneous model', () => {
    const lap = withNegativeSkin(makeRadialPwdLaplace({ mode: 'homogeneous', boundaryType: 'infinite' }));
    for (const S of [-1, -3, -4.5]) {
      for (const tD of [1e2, 1e4, 1e6]) {
        const a = pwd(lap, { skin: 0, skinRaw: S, cd: 0 }, tD);
        const b = pwd(pwdLaplaceHomogeneous, { skin: S, cd: 0 }, tD);
        expect(Math.abs(a - b) / Math.abs(b)).toBeLessThan(1e-9);
      }
    }
  });

  const CASES = [
    ['homogeneous-sealing-fault', { ld: 2000 }],
    ['homogeneous-constant-pressure', { ld: 2000 }],
    ['homogeneous-channel', { wd: 3000 }],
    ['homogeneous-closed-circle', { reD: 5000 }],
    ['homogeneous-closed-rectangle', { xeD: 6000, xwD: 2000, yeD: 4000, ywD: 2000 }],
    ['dual-porosity-pss', { omega: 0.05, lambda: 1e-6, interporosity: 'pss' }],
    ['dual-porosity-slab', { omega: 0.05, lambda: 1e-6, interporosity: 'transient-slab' }],
    ['dual-porosity-pss-fault', { omega: 0.05, lambda: 1e-6, interporosity: 'pss', ld: 3000 }],
  ];

  test.each(CASES)('gate 2: %s, pwD(S = -3) - pwD(S = 0) is -3 through the boundary or the transition', (id, extra) => {
    const m = getModel(id);
    expect(m.parameters.find((p) => p.key === 'skin').min).toBe(-5);
    for (const tD of [3e5, 3e6, 3e7]) {
      const neg = pwd(m.pwdLaplace, { skin: 0, skinRaw: -3, cd: 0, ...extra }, tD);
      const zero = pwd(m.pwdLaplace, { skin: 0, skinRaw: 0, cd: 0, ...extra }, tD);
      expect(Math.abs(neg - zero - -3)).toBeLessThan(0.01);
    }
  });

  test('gate 3: the sealing fault before the boundary is on the radial semilog line with S', () => {
    const m = getModel('homogeneous-sealing-fault');
    for (const tD of [1e4, 1e5]) {
      const v = pwd(m.pwdLaplace, { skin: 0, skinRaw: -2, cd: 0, ld: 1e5 }, tD);
      expect(Math.abs(v - (0.5 * (Math.log(tD) + 0.80907) - 2))).toBeLessThan(0.01);
    }
  });

  test('gate 4 (negative control): rescaling time only moves the fault and the fissure transition', () => {
    const timeOnly = (lap) => (u, d) => {
      const S = d.skinRaw; const a = Math.exp(2 * S);
      return lap(u / a, { ...d, skin: 0, skinRaw: 0, cd: (d.cd ?? 0) * a }) / a;
    };
    for (const [id, extra] of [['homogeneous-sealing-fault', { ld: 300 }], ['dual-porosity-pss', { omega: 0.05, lambda: 1e-6, interporosity: 'pss' }]]) {
      const base = makeRadialPwdLaplace(id.startsWith('dual')
        ? { mode: 'dual-porosity', boundaryType: 'infinite' } : { mode: 'homogeneous', boundaryType: 'fault' });
      const worst = Math.max(...[3e5, 3e6, 3e7].map((tD) => {
        const neg = pwd(timeOnly(base), { skin: 0, skinRaw: -3, cd: 0, ...extra }, tD);
        const zero = pwd(base, { skin: 0, skinRaw: 0, cd: 0, ...extra }, tD);
        return Math.abs(neg - zero - -3);
      }));
      expect(worst).toBeGreaterThan(0.2);
    }
  });

  test('the catalog evaluates a stimulated well with storage on a fault, and the fracture and horizontal models keep S >= 0', () => {
    const reservoir = { h: 45, phi: 0.18, rw: 0.354, B: 1.25, mu: 0.9, ct: 0.000012, q: 450, pi: 4800 };
    const out = evaluateDrawdown({ model: getModel('homogeneous-sealing-fault'), params: { k: 50, skin: -3, C: 0.01, L: 300 }, reservoir, times: [0.01, 1, 100] });
    for (const r of out) expect(r.dp > 0 && Number.isFinite(r.dp)).toBe(true);
    expect(getModel('fracture-infinite-conductivity').parameters.find((p) => p.key === 'skin').min).toBe(0);
    expect(getModel('horizontal-well').parameters.find((p) => p.key === 'skin').min).toBe(0);
    expect(toDimensionlessGroups({ ...reservoir, k: 50 }).tdPerHour).toBeGreaterThan(0);
  });
});
