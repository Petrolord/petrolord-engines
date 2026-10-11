/**
 * E1b gate for engines/qi/avo.js: every assertion calls the shipped function
 * and compares it with tools/validation/qi/oracle_qi_avo.py (exact Zoeppritz
 * differentiated at zero contrast, Householder QR, rational elimination,
 * eigenvector plus golden-section trend). Negative controls:
 * tools/validation/qi/negcontrol_e1b.sh.
 */
import G from '../test-data/qi/goldens.qiAvo.json';
import {
  akiRichards, shueyTerms, fitShuey, contrastsFromAB, backgroundTrend, offTrend, chiProjection, avoClass,
} from '../engines/qi/avo';

const near = (got, want, tol) => {
  if (!(Math.abs(got - want) <= tol)) throw new Error(`got ${got}, want ${want} (tol ${tol})`);
};
const arr = (xs) => xs.map((v) => (v === null ? NaN : v));

describe('linearised reflectivity against the exact Zoeppritz limit', () => {
  test.each(G.weak.map((w) => [w.name, w]))('%s: akiRichards is dR/d(contrast) of exact Zoeppritz at every angle', (_, w) => {
    expect(w.angles.length).toBeGreaterThan(0);
    w.angles.forEach((th, i) => near(akiRichards(w.contrasts, th), w.linear[i], 1e-10));
  });
  test.each(G.weak.map((w) => [w.name, w]))('%s: shueyTerms are the intercept, sin^2 slope and curvature of that limit', (_, w) => {
    const t = shueyTerms(w.contrasts);
    near(t.A, w.A, 1e-11);
    near(t.B, w.B, 1e-8);
    near(t.C, w.C, 2e-8);
  });
  test('the four classic cases: shueyTerms equal the bruges-checked A, B, C and the class', () => {
    expect(G.classics).toHaveLength(4);
    for (const c of G.classics) {
      const t = shueyTerms(c.contrasts);
      near(t.A, c.A, 1e-12); near(t.B, c.B, 1e-12); near(t.C, c.C, 1e-12);
      expect(avoClass(t.A, t.B)).toBe(c.expect);
    }
  });
});

describe('fitShuey against Householder QR', () => {
  test.each(G.fits.map((f) => [f.name, f]))('%s', (_, f) => {
    const r = fitShuey(f.angles, arr(f.amps), { terms: f.terms, weights: f.weights });
    expect(r.n).toBe(f.n);
    near(r.A, f.A, 1e-12); near(r.B, f.B, 1e-11); near(r.C, f.C, 1e-10);
  });
});

describe('contrastsFromAB against rational elimination', () => {
  test('contrasts and fluid factor', () => {
    expect(G.contrasts.length).toBeGreaterThan(5);
    for (const c of G.contrasts) {
      const r = contrastsFromAB(c.A, c.B, c.vsVp);
      near(r.dVpVp, c.dVpVp, 1e-14); near(r.dRhoRho, c.dRhoRho, 1e-14);
      near(r.dVsVs, c.dVsVs, 1e-13); near(r.fluidFactor, c.fluidFactor, 1e-13);
    }
  });
});

describe('the I-G plane', () => {
  test.each(G.trends.map((t) => [t.name, t]))('background trend %s is the principal axis (not OLS)', (_, t) => {
    const r = backgroundTrend(arr(t.As), arr(t.Bs));
    expect(r.n).toBe(t.n);
    if (t.m === null) { expect(r.m).toBeNaN(); return; } // too few points: no trend
    near(r.m, t.m, 1e-11);
    expect(Math.abs(r.m - t.olsSlope)).toBeGreaterThan(1e-4);
  });
  test('offTrend is the signed perpendicular distance', () => {
    expect(G.offTrend.length).toBeGreaterThan(0);
    for (const o of G.offTrend) near(offTrend(o.A, o.B, o.m), o.d, 1e-14);
  });
  test('chiProjection', () => {
    expect(G.chi.length).toBeGreaterThan(0);
    for (const c of G.chi) near(chiProjection(c.A, c.B, c.chi), c.value, 1e-15);
  });
  test('avoClass, boundaries included', () => {
    expect(G.classes.length).toBeGreaterThan(0);
    for (const c of G.classes) expect(avoClass(c.A, c.B)).toBe(c.avoClass);
  });
});
