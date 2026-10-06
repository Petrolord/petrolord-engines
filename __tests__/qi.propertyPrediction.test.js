import G from '../test-data/qi/goldens.propertyPrediction.json';
import {
  fitLinearTransform, predictWithInterval, fitFaciesModel, faciesPosterior, confusionMatrix,
} from '../engines/qi/propertyPrediction';

describe('linear transform with prediction interval', () => {
  const fit = fitLinearTransform(G.transform.x, G.transform.y);
  test('coefficients, residual and fit match scipy', () => {
    expect(fit.a).toBeCloseTo(G.transform.a, 10);
    expect(fit.b).toBeCloseTo(G.transform.b, 14);
    expect(fit.s).toBeCloseTo(G.transform.s, 12);
    expect(fit.r2).toBeCloseTo(G.transform.r2, 10);
  });
  test('the 80 percent prediction interval (Q10 and Q90) matches scipy, wider away from the data', () => {
    for (const p of G.transform.pred) {
      const r = predictWithInterval(fit, p.x);
      expect(r.y).toBeCloseTo(p.y, 10);
      expect(r.lo).toBeCloseTo(p.lo, 8);
      expect(r.hi).toBeCloseTo(p.hi, 8);
    }
    const w = (x) => { const r = predictWithInterval(fit, x); return r.hi - r.lo; };
    expect(w(10000)).toBeGreaterThan(w(7000));
  });
  test('negative control: a normal (z) interval is narrower than the gate accepts', () => {
    const p = G.transform.pred[1];
    const z = 1.2815515655446004 * fit.s * Math.sqrt(1 + 1 / fit.n + (p.x - fit.xMean) ** 2 / fit.sxx);
    expect(Math.abs((p.hi - p.y) - z)).toBeGreaterThan(1e-5);
  });
  test('refusals', () => {
    expect(() => fitLinearTransform([1, 2], [1, 2])).toThrow(/three/);
    expect(() => fitLinearTransform([1, 1, 1], [1, 2, 3])).toThrow(/one value/);
  });
});

describe('Bayesian facies', () => {
  for (const set of G.sets) {
    for (const kind of ['gaussian', 'kde']) {
      test(`${set.dims}D ${kind}: posteriors match scipy`, () => {
        const model = fitFaciesModel(set.samples, { kind });
        set.queries.forEach((q, k) => {
          const { probs } = faciesPosterior(model, q);
          probs.forEach((p, j) => expect(p).toBeCloseTo(set[kind][k][j], 9));
        });
      });
    }
  }
  test('the gas sand is the most likely at low impedance and low Vp/Vs, and the classes separate', () => {
    const set = G.sets[1];
    const model = fitFaciesModel(set.samples);
    const { best } = faciesPosterior(model, [5900, 1.62]);
    expect(model.classes[best].name).toBe('gas sand');
    const cm = confusionMatrix(model, set.samples);
    expect(cm.accuracy).toBeGreaterThan(0.85);
    expect(cm.counts.flat().reduce((a, v) => a + v, 0)).toBe(set.samples.length);
  });
  test('priors move the posterior, and a missing value gives no class', () => {
    const set = G.sets[0];
    const even = fitFaciesModel(set.samples, { priors: { shale: 1, 'brine sand': 1, 'gas sand': 1 } });
    const counted = fitFaciesModel(set.samples);
    const gas = (m) => faciesPosterior(m, [6400]).probs[m.classes.findIndex((c) => c.name === 'gas sand')];
    expect(gas(even)).toBeGreaterThan(gas(counted)); // the gas sand has the fewest samples
    expect(faciesPosterior(counted, [NaN]).best).toBe(-1);
  });
  test('negative control: with Vp/Vs dropped the 2D separation is lost in part', () => {
    const set = G.sets[1];
    const two = confusionMatrix(fitFaciesModel(set.samples), set.samples).accuracy;
    const oneD = set.samples.map((s) => ({ facies: s.facies, x: [s.x[0]] }));
    const one = confusionMatrix(fitFaciesModel(oneD), oneD).accuracy;
    expect(two).toBeGreaterThan(one);
  });
  test('refusals', () => {
    expect(() => fitFaciesModel([])).toThrow(/No labelled/);
    expect(() => fitFaciesModel([{ facies: 'a', x: [1] }, { facies: 'a', x: [2] }])).toThrow(/at least 3/);
    expect(() => fitFaciesModel(G.sets[0].samples, { priors: { shale: 1 } })).toThrow(/No prior/);
  });
});
