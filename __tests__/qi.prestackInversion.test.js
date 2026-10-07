// Prestack simultaneous inversion (QI Q8b) against pylops
// (tools/validation/qi/oracle_prestack_inversion.py): the Fatti forward
// model is pylops' operator, the regularised inversion matches pylops'
// solution, and density needs the far angles: with the near angles only its
// detail is lost (the negative control).
import G from '../test-data/qi/goldens.prestackInversion.json';
import { fattiCoefficients, forwardFatti, forwardFattiAdjoint, simultaneousInversion } from '../engines/qi/prestackInversion';

const n = G.nt;
const split = (m) => ({ lnAi: m.slice(0, n), lnSi: m.slice(n, 2 * n), lnRho: m.slice(2 * n) });
const corr = (a, b) => {
  const ma = a.reduce((s, v) => s + v, 0) / a.length; const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.sqrt(saa * sbb);
};
const detail = (m) => corr(Array.from(m.lnRho, (v, i) => v - G.m0.lnRho[i]), G.truth.lnRho.map((v, i) => v - G.m0.lnRho[i]));

describe('Fatti prestack inversion', () => {
  test('the coefficients are Fatti\'s', () => {
    const [g] = fattiCoefficients([30], 0.5);
    const t = Math.PI / 6;
    expect(g[0]).toBeCloseTo(0.5 * (1 + Math.tan(t) ** 2), 14);
    expect(g[1]).toBeCloseTo(-4 * 0.25 * Math.sin(t) ** 2, 14);
    expect(g[2]).toBeCloseTo(0.5 * (4 * 0.25 * Math.sin(t) ** 2 - Math.tan(t) ** 2), 14);
  });
  test('the forward model is pylops\' operator', () => {
    const syn = forwardFatti(G.truth, G.thetas, G.wavelet, G.vsVp);
    syn.forEach((tr, k) => tr.forEach((v, i) => expect(v).toBeCloseTo(G.cleanFull[k][i], 10)));
  });
  test('the adjoint passes the dot test', () => {
    const x = { lnAi: G.m0.lnAi.map((v, i) => Math.sin(i)), lnSi: G.m0.lnSi.map((v, i) => Math.cos(i / 3)), lnRho: G.m0.lnRho.map((v, i) => Math.sin(i / 7)) };
    const y = G.thetas.map((_, k) => Float64Array.from({ length: n }, (_, i) => Math.cos(i / 5 + k)));
    const Fx = forwardFatti(x, G.thetas, G.wavelet, G.vsVp);
    const Aty = forwardFattiAdjoint(y, G.thetas, G.wavelet, G.vsVp);
    let lhs = 0; let rhs = 0;
    Fx.forEach((tr, k) => tr.forEach((v, i) => { lhs += v * y[k][i]; }));
    ['lnAi', 'lnSi', 'lnRho'].forEach((key, p) => x[key].forEach((v, i) => { rhs += v * Aty[p][i]; }));
    expect(Math.abs(lhs - rhs) / Math.abs(lhs)).toBeLessThan(1e-12);
  });
  test('the inversion of the noisy gather matches pylops\' solution', () => {
    const m = simultaneousInversion({ traces: G.dFull, thetaDeg: G.thetas, wavelets: G.wavelet, vsVp: G.vsVp, m0: G.m0, eps: G.eps, iters: 3000 });
    const ref = split(G.mFull);
    let worst = 0;
    for (const key of ['lnAi', 'lnSi', 'lnRho']) for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(m[key][i] - ref[key][i]));
    expect(worst).toBeLessThan(2e-4);
    expect(detail(m)).toBeGreaterThan(0.7);
  });
  test('negative control: with the near angles only (0 to 16 degrees) the density detail is lost', () => {
    const near = simultaneousInversion({ traces: G.dNear, thetaDeg: G.thetas.slice(0, 3), wavelets: G.wavelet, vsVp: G.vsVp, m0: G.m0, eps: G.eps, iters: 3000 });
    const ref = split(G.mNear);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(near.lnRho[i] - ref.lnRho[i]));
    expect(worst).toBeLessThan(5e-4);
    expect(detail(near)).toBeLessThan(0.55);
  });
  test('refusals', () => {
    expect(() => simultaneousInversion({ traces: [], thetaDeg: [0], wavelets: G.wavelet, vsVp: 0.5, m0: G.m0, eps: G.eps })).toThrow(/One trace per angle/);
    expect(() => simultaneousInversion({ traces: [G.dFull[0]], thetaDeg: [0], wavelets: G.wavelet, vsVp: 1.2, m0: G.m0, eps: G.eps })).toThrow(/Vs\/Vp/);
  });
});
