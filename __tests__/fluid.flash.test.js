/**
 * FS3 gates — stability + Rachford-Rice + SS/GDEM flash.
 *
 * GATE D (oracle): flashPT phase counts, beta, compositions, K-values
 * and phase densities must match the plain-SS oracle flash grid in
 * goldens.json (different accelerator, different RR solver, different
 * cubic route; every two-phase golden is additionally sealed by the
 * oracle's quadrature fugacity-equality check at generation time).
 * GATE E (Raoult limit): at low pressure the EOS K-values collapse to
 * Psat_i/P with Psat anchored by the FS2 NIST gates.
 * Identity gates: exact truths — binary Rachford-Rice closed form,
 * negative-flash root, isofugacity and material balance at convergence.
 */

import { mixtureFromKeys, phaseProps, purePsat } from '../engines/fluid/pr78.js';
import { COMPONENTS } from '../engines/fluid/components.js';
import { degFtoR } from '../engines/fluid/units.js';
import { wilsonK, solveRachfordRice, stabilityTest, flashPT } from '../engines/fluid/flash.js';
import goldens from '../test-data/fluid/goldens.json';

const relErr = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

describe('FS3 GATE D: flashPT vs plain-SS oracle flash grid', () => {
  describe.each(goldens.flash)('mixture $name', ({ keys, x: z, states }) => {
    const mix = mixtureFromKeys(keys);
    test.each(states)('$tF F / $pPsia psia', (st) => {
      const res = flashPT(mix, z, degFtoR(st.tF), st.pPsia);
      expect(res.phases).toBe(st.phases);
      if (st.phases !== 2) return;
      expect(Math.abs(res.beta - st.beta)).toBeLessThan(1e-9);
      res.x.forEach((v, i) => expect(Math.abs(v - st.x[i])).toBeLessThan(1e-9));
      res.y.forEach((v, i) => expect(Math.abs(v - st.y[i])).toBeLessThan(1e-9));
      res.K.forEach((v, i) => expect(relErr(v, st.K[i])).toBeLessThan(1e-8));
      expect(relErr(res.liquid.zFactor, st.zL)).toBeLessThan(1e-9);
      expect(relErr(res.vapor.zFactor, st.zV)).toBeLessThan(1e-9);
      expect(relErr(res.liquid.density, st.rhoL)).toBeLessThan(1e-8);
      expect(relErr(res.vapor.density, st.rhoV)).toBeLessThan(1e-8);
    });
  });

  test('grid exercises both outcomes', () => {
    const all = goldens.flash.flatMap((m) => m.states);
    expect(all.filter((s) => s.phases === 2).length).toBeGreaterThanOrEqual(6);
    expect(all.filter((s) => s.phases === 1).length).toBeGreaterThanOrEqual(6);
  });

  test('stability agrees with the oracle on every two-phase state', () => {
    for (const m of goldens.flash) {
      const mix = mixtureFromKeys(m.keys);
      for (const st of m.states.filter((s) => s.phases === 2)) {
        const stab = stabilityTest(mix, m.x, degFtoR(st.tF), st.pPsia);
        expect(stab.stable).toBe(false);
        expect(stab.kSuggest).not.toBeNull();
      }
    }
  });
});

describe('FS3 identity gates: Rachford-Rice', () => {
  test('binary closed form: beta = -(z1(K1-1) + z2(K2-1)) / ((K1-1)(K2-1))', () => {
    const z = [0.35, 0.65];
    const K = [23.9977, 0.5573];
    const analytic = -(z[0] * (K[0] - 1) + z[1] * (K[1] - 1)) / ((K[0] - 1) * (K[1] - 1));
    const rr = solveRachfordRice(z, K);
    expect(Math.abs(rr.beta - analytic)).toBeLessThan(1e-12);
  });

  test('root satisfies g(beta) = 0 with unit-sum phases and y = Kx', () => {
    const z = [0.1, 0.25, 0.4, 0.25];
    const K = [8, 2.2, 0.7, 0.05];
    const rr = solveRachfordRice(z, K);
    expect(Math.abs(rr.residual)).toBeLessThan(1e-12);
    expect(rr.x.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(rr.y.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    rr.y.forEach((yi, i) => expect(relErr(yi, K[i] * rr.x[i])).toBeLessThan(1e-12));
    // material balance
    rr.x.forEach((xi, i) => {
      expect((1 - rr.beta) * xi + rr.beta * rr.y[i]).toBeCloseTo(z[i], 12);
    });
  });

  test('negative flash: root found outside [0, 1] when the feed is single-phase', () => {
    const z = [0.1, 0.9];
    const K = [1.05, 0.99]; // g(0) < 0: subcooled-side root at beta < 0
    const rr = solveRachfordRice(z, K);
    expect(rr.beta).toBeLessThan(0);
    expect(Math.abs(rr.residual)).toBeLessThan(1e-12);
  });

  test('returns null when K does not straddle 1', () => {
    expect(solveRachfordRice([0.5, 0.5], [2.0, 1.1])).toBeNull();
    expect(solveRachfordRice([0.5, 0.5], [0.9, 0.2])).toBeNull();
  });
});

describe('FS3 identity gates: flash convergence truths', () => {
  const mix = mixtureFromKeys(['C1', 'nC4']);
  const z = [0.35, 0.65];
  const tR = degFtoR(100);
  const res = flashPT(mix, z, tR, 100);

  test('isofugacity at convergence: f_i^L = f_i^V', () => {
    expect(res.phases).toBe(2);
    res.liquid.fugacityPsia.forEach((f, i) => {
      expect(relErr(f, res.vapor.fugacityPsia[i])).toBeLessThan(1e-9);
    });
  });

  test('material balance exact: (1-beta) x + beta y = z', () => {
    res.x.forEach((xi, i) => {
      expect((1 - res.beta) * xi + res.beta * res.y[i]).toBeCloseTo(z[i], 12);
    });
  });

  test('K equals both y/x and the fugacity-coefficient ratio', () => {
    res.K.forEach((k, i) => {
      expect(relErr(k, res.y[i] / res.x[i])).toBeLessThan(1e-9);
      const phiRatio = Math.exp(res.liquid.lnPhi[i] - res.vapor.lnPhi[i]);
      expect(relErr(k, phiRatio)).toBeLessThan(1e-9);
    });
  });

  test('stable feed returns the single-phase state untouched', () => {
    const one = flashPT(mix, z, tR, 2000);
    expect(one.phases).toBe(1);
    expect(one.reason).toBe('stable');
    const direct = phaseProps(mix, z, tR, 2000);
    expect(one.feed.zFactor).toBe(direct.zFactor);
  });

  test('wilsonK reproduces the Wilson correlation componentwise', () => {
    const K = wilsonK(mix, tR, 100);
    mix.comps.forEach((c, i) => {
      const expected = (c.pcPsia / 100) * Math.exp(5.373 * (1 + c.omega) * (1 - c.tcR / tR));
      expect(K[i]).toBe(expected);
    });
  });
});

describe('FS3 GATE E: low-pressure K-value limits anchored to NIST-gated Psat', () => {
  // C3/nC5 at 100 F / 20 psia. For the heavy component (Psat << Pc, so its
  // saturated-vapor fugacity coefficient is ~1) plain Raoult K = Psat/P
  // holds tightly. For the volatile component the dominant departure from
  // Raoult is exactly that coefficient (Lewis rule): K P / Psat = phiSat,
  // observed to ~2% (the residual is Poynting x dilution effects).
  const mix = mixtureFromKeys(['C3', 'nC5']);
  const tR = degFtoR(100);
  const p = 20;
  const res = flashPT(mix, [0.1, 0.9], tR, p);

  test('two-phase at the test condition', () => {
    expect(res.phases).toBe(2);
  });

  test('heavy component obeys Raoult: K_nC5 = Psat/P within 2%', () => {
    expect(relErr(res.K[1], purePsat(COMPONENTS.nC5, tR) / p)).toBeLessThan(0.02);
  });

  test('light component obeys the Lewis rule: K_C3 P / Psat = phiSat within 3%', () => {
    const psatC3 = purePsat(COMPONENTS.C3, tR);
    const satVapor = phaseProps(mixtureFromKeys(['C3']), [1], tR, psatC3, { root: 'max' });
    const phiSat = Math.exp(satVapor.lnPhi[0]);
    expect(relErr((res.K[0] * p) / psatC3, phiSat)).toBeLessThan(0.03);
  });
});
