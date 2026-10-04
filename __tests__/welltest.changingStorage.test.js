/**
 * Changing wellbore storage (Well Test U2-002, 2026-10-04): Hegeman,
 * Hallford and Joseph (1993) error-function and Fair (1981) exponential
 * phase-redistribution pressure, composed in Laplace space with the
 * catalog's sandface solutions (engines/welltest/models/changingStorage.js).
 *
 * The published type curves of the 1993 paper were not readable from this
 * box; the model equations were read in Tobing (Lemigas Scientific
 * Contributions 31(2), 2008, eqs. 2 to 7). The gates therefore are:
 *   1. an independent oracle: Fair's wellbore balance solved in REAL TIME
 *      as a Volterra equation (Duhamel convolution of the no-storage
 *      sandface response, implicit step by step), which shares nothing with
 *      the Laplace composition under test but the sandface response;
 *   2. exact limits: C_phiD = 0 is the constant-storage model to rounding (1e-8 after Stehfest, the algebra differs);
 *      the early unit slope sits on the stated initial storage Ci; the late
 *      response is the constant-storage one at the final storage C;
 *   3. negative controls: the Fair kernel and a sign-flipped C_phiD both
 *      fail gate 1 against the error-function oracle.
 */
import { stehfestInvert } from '../engines/welltest/numerics.js';
import { pwdLaplaceHomogeneous } from '../engines/welltest/models/homogeneous.js';
import {
  withChangingStorage, phaseRedistributionPressure, cphiDFromRatio, erfcx,
} from '../engines/welltest/models/changingStorage.js';
import {
  getModel, splitModelId, composeModelId, evaluateDrawdown, evaluateBuildup, toDimensionlessGroups, MODEL_CATALOG,
} from '../engines/welltest/models/modelCatalog.js';
import { autoFitModel } from '../engines/welltest/autoFit.js';

const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

// ---- the independent real-time oracle -------------------------------------
function volterraOracle({ skin, cd, kind, cphiD, alphaD }) {
  const ps = (t) => stehfestInvert((u) => pwdLaplaceHomogeneous(u, { skin, cd: 0 }), t, 12);
  const G = 4000; const lg0 = Math.log(1e-4); const lg1 = Math.log(2e7);
  const gy = Array.from({ length: G }, (_, i) => ps(Math.exp(lg0 + ((lg1 - lg0) * i) / (G - 1))));
  const S = (t) => {
    if (t <= 0) return 0;
    const f = ((Math.log(t) - lg0) / (lg1 - lg0)) * (G - 1);
    if (f <= 0) return gy[0];
    const i = Math.min(Math.floor(f), G - 2);
    const w = f - i;
    return gy[i] * (1 - w) + gy[i + 1] * w;
  };
  const pphi = (t) => {
    // written out here, not imported: erf by its own series and asymptote
    const x = t / alphaD;
    if (kind === 'fair') return cphiD * (1 - Math.exp(-x));
    let erf;
    if (x < 3) { let term = x; let sum = x; for (let n = 1; n < 120; n += 1) { term *= -(x * x) / n; sum += term / (2 * n + 1); } erf = (2 / Math.sqrt(Math.PI)) * sum; } else erf = 1 - Math.exp(-x * x) / (x * Math.sqrt(Math.PI)) * (1 - 1 / (2 * x * x));
    return cphiD * erf;
  };
  const N = 1500; const t0 = 1e-2; const t1 = 1e7;
  const ts = [0, ...Array.from({ length: N }, (_, i) => t0 * Math.pow(t1 / t0, i / (N - 1)))];
  const pw = [0]; const q = [0];
  for (let n = 1; n <= N; n += 1) {
    let acc = 0;
    for (let j = 1; j < n; j += 1) acc += q[j] * (S(ts[n] - ts[j - 1]) - S(ts[n] - ts[j]));
    const dt = ts[n] - ts[n - 1];
    const a = S(dt);
    const dphi = pphi(ts[n]) - pphi(ts[n - 1]);
    const pn = (acc + a * (1 + (cd * (pw[n - 1] + dphi)) / dt)) / (1 + (a * cd) / dt);
    pw.push(pn);
    q.push(1 - (cd * (pn - pw[n - 1] - dphi)) / dt);
  }
  return (t) => {
    const i = ts.findIndex((x) => x >= t);
    return pw[i - 1] + ((pw[i] - pw[i - 1]) * (t - ts[i - 1])) / (ts[i] - ts[i - 1]);
  };
}

const TIMES = [1, 10, 100, 1e3, 1e4, 2e4, 5e4, 1e5, 1e6];
const engineAt = (kind, d) => (t) => stehfestInvert((u) => withChangingStorage(pwdLaplaceHomogeneous, kind)(u, d), t, 12);

describe('Hegeman changing storage against the real-time oracle', () => {
  const cases = [
    { name: 'decreasing storage, Ci/C = 4', ratio: 4, skin: 0 },
    { name: 'increasing storage with the hump, Ci/C = 0.25', ratio: 0.25, skin: 0 },
    { name: 'decreasing storage with skin 5, Ci/C = 10', ratio: 10, skin: 5 },
  ];
  test.each(cases)('$name: within 1 percent at every time', ({ ratio, skin }) => {
    const cd = 1000; const alphaD = 2e4;
    const cphiD = cphiDFromRatio({ kind: 'hegeman', ciOverC: ratio, alphaD, cd });
    const oracle = volterraOracle({ skin, cd, kind: 'hegeman', cphiD, alphaD });
    const eng = engineAt('hegeman', { skin, cd, cphiD, alphaD });
    for (const t of TIMES) expect(rel(eng(t), oracle(t))).toBeLessThan(0.01);
  });

  test('Fair exponential against its own oracle', () => {
    const cd = 1000; const alphaD = 2e4;
    const cphiD = cphiDFromRatio({ kind: 'fair', ciOverC: 5, alphaD, cd });
    const oracle = volterraOracle({ skin: 2, cd, kind: 'fair', cphiD, alphaD });
    const eng = engineAt('fair', { skin: 2, cd, cphiD, alphaD });
    for (const t of TIMES) expect(rel(eng(t), oracle(t))).toBeLessThan(0.01);
  });

  test('negative controls: the Fair kernel and a sign-flipped C_phiD miss the error-function oracle', () => {
    const cd = 1000; const alphaD = 2e4;
    const cphiD = cphiDFromRatio({ kind: 'hegeman', ciOverC: 4, alphaD, cd });
    const oracle = volterraOracle({ skin: 0, cd, kind: 'hegeman', cphiD, alphaD });
    const wrongKernel = engineAt('fair', { skin: 0, cd, cphiD, alphaD });
    const flipped = engineAt('hegeman', { skin: 0, cd, cphiD: -cphiD, alphaD });
    const worst = (f) => Math.max(...TIMES.map((t) => rel(f(t), oracle(t))));
    expect(worst(wrongKernel)).toBeGreaterThan(0.05);
    expect(worst(flipped)).toBeGreaterThan(0.5);
  });
});

describe('exact limits', () => {
  test('C_phiD = 0 is the constant-storage model to rounding', () => {
    for (const [skin, cd] of [[0, 100], [5, 1e4], [-2, 50]]) {
      for (const t of [0.1, 10, 1e3, 1e5]) {
        const a = stehfestInvert((u) => withChangingStorage(pwdLaplaceHomogeneous, 'hegeman')(u, { skin, cd, cphiD: 0, alphaD: 10 }), t);
        const b = stehfestInvert((u) => pwdLaplaceHomogeneous(u, { skin, cd }), t);
        expect(rel(a, b)).toBeLessThan(1e-8);
      }
    }
  });

  test('the early unit slope sits on the stated initial storage Ci, the late radial on the constant model', () => {
    const cd = 1000; const alphaD = 2e4;
    for (const kind of ['hegeman', 'fair']) {
      for (const ratio of [0.3, 3, 20]) {
        const cphiD = cphiDFromRatio({ kind, ciOverC: ratio, alphaD, cd });
        const eng = engineAt(kind, { skin: 0, cd, cphiD, alphaD });
        expect(eng(1) / (1 / (ratio * cd))).toBeCloseTo(1, 2); // pwD = tD / CiD
        const late = stehfestInvert((u) => pwdLaplaceHomogeneous(u, { skin: 0, cd }), 1e7);
        expect(rel(eng(1e7), late)).toBeLessThan(2e-3);
      }
    }
  });

  test('erfcx against exp(x^2) erfc(x) known values', () => {
    // erfc(0.5) = 0.4795001221869535, erfc(2) = 0.004677734981047266, erfc(4) = 1.541725790028002e-8
    expect(erfcx(0)).toBeCloseTo(1, 14);
    expect(erfcx(0.5) / (Math.exp(0.25) * 0.4795001221869535)).toBeCloseTo(1, 12);
    expect(erfcx(2) / (Math.exp(4) * 0.004677734981047266)).toBeCloseTo(1, 12);
    expect(erfcx(4) / (Math.exp(16) * 1.541725790028002e-8)).toBeCloseTo(1, 10);
    expect(erfcx(1e4) * 1e4 * Math.sqrt(Math.PI)).toBeCloseTo(1, 6);
    expect(phaseRedistributionPressure(1e9, { kind: 'hegeman', cphiD: 2, alphaD: 1 })).toBeCloseTo(2, 12);
  });
});

describe('the catalog', () => {
  const reservoir = { h: 45, phi: 0.18, rw: 0.354, B: 1.25, mu: 0.9, ct: 0.000012, q: 450, pi: 4800 };
  test('every model composes with both changing-storage kinds; ids round trip', () => {
    for (const base of MODEL_CATALOG) {
      for (const kind of ['hegeman', 'fair']) {
        const id = composeModelId(base.id, kind);
        expect(splitModelId(id)).toEqual({ baseId: base.id, wellbore: kind });
        const m = getModel(id);
        expect(m).toBe(getModel(id));
        expect(m.parameters.map((p) => p.key)).toEqual([...base.parameters.map((p) => p.key), 'ciOverC', 'alpha']);
        const params = Object.fromEntries(m.parameters.map((p) => [p.key, p.default]));
        const out = evaluateDrawdown({ model: m, params, reservoir, times: [0.01, 1, 100] });
        for (const r of out) expect(Number.isFinite(r.dp) && r.dp > 0).toBe(true);
      }
    }
    expect(getModel('homogeneous+constant')).toBe(getModel('homogeneous'));
    expect(getModel('homogeneous+nonsense')).toBeNull();
  });

  test('Ci/C = 1 reproduces the constant-storage buildup of the same model', () => {
    const params = { k: 85, skin: 6.5, C: 0.015 };
    const dts = [0.01, 0.1, 1, 10, 50];
    const a = evaluateBuildup({ model: getModel('homogeneous'), params, reservoir, tp: 36, dts });
    const b = evaluateBuildup({ model: getModel('homogeneous+hegeman'), params: { ...params, ciOverC: 1, alpha: 0.05 }, reservoir, tp: 36, dts });
    a.forEach((r, i) => expect(rel(b[i].dp, r.dp)).toBeLessThan(1e-7));
  });

  test('auto-fit recovers k, skin, C, Ci/C and alpha from a synthetic Hegeman buildup', () => {
    const model = getModel('homogeneous+hegeman');
    const truth = { k: 85, skin: 6.5, C: 0.015, ciOverC: 4, alpha: 0.05 };
    const dts = Array.from({ length: 50 }, (_, i) => Math.pow(10, -3 + (4.5 * i) / 49));
    const data = evaluateBuildup({ model, params: truth, reservoir, tp: 36, dts }).map((p) => ({ dt: p.dt, dp: p.dp }));
    const fit = autoFitModel({
      model, testType: 'buildup', data, reservoir, tp: 36,
      initialParams: { k: 50, skin: 3, C: 0.01, ciOverC: 2, alpha: 0.1 },
    });
    expect(rel(fit.params.k, truth.k)).toBeLessThan(0.02);
    expect(Math.abs(fit.params.skin - truth.skin)).toBeLessThan(0.2);
    expect(rel(fit.params.C, truth.C)).toBeLessThan(0.05);
    expect(rel(fit.params.ciOverC, truth.ciOverC)).toBeLessThan(0.1);
    expect(rel(fit.params.alpha, truth.alpha)).toBeLessThan(0.15);
    const g = toDimensionlessGroups({ ...reservoir, k: truth.k });
    expect(g.cdPerBblPsi).toBeGreaterThan(0);
  }, 120000);
});
