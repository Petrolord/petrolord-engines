// Data & AI D4 production forecasting gates. Every case in
// test-data/dataai/goldens/forecast_cases.json is run THROUGH THE ENGINE and
// compared with the value the independent stdlib oracle
// (tools/validation/dataai/oracle_forecast.py) computed from the published
// equations by different roads (Decimal error-correction recursions, a zoom
// grid for the estimated parameters, exact Fraction metrics, integer
// mulberry32 bootstrap, fitArpsModel's algorithm in Decimal). The NIST/
// SEMATECH 6.4.3 examples carry published figures. The pins in
// test-data/dataai/pins/forecast_pins.json are a second witness
// (statsmodels, scipy, scikit-learn). Property tests compare engine outputs
// with each other, never with a restated formula; tools/validation/dataai/
// negcontrol_forecast.sh proves the gates go red when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as FC from '../engines/dataai/forecast';
import { fitArpsModel } from '../engines/dca/arps';
import { syntheticProduction } from '../tools/validation/dataai/synthetic_wells';

const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));
const G = read('test-data', 'dataai', 'goldens', 'forecast_cases.json');
const PINS = read('test-data', 'dataai', 'pins', 'forecast_pins.json');
const FLOOR = G.tolerance.absoluteFloor;

const get = (obj, dotted) => (dotted === '' ? obj : dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj));

const diff = (actual, expected, tol, where = '', floor = FLOOR) => {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return [`${where}: ${actual} is not a finite number (expected ${expected})`];
    const d = Math.abs(actual - expected);
    return d <= floor || d <= tol * Math.abs(expected) ? [] : [`${where}: ${actual} vs ${expected} (abs ${d}, rel ${d / Math.abs(expected)})`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${where}: array length ${actual && actual.length} vs ${expected.length}`];
    return expected.flatMap((e, i) => diff(actual[i], e, tol, `${where}[${i}]`, floor));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return [`${where}: ${actual} is not an object`];
    return Object.keys(expected).flatMap((k) => diff(actual[k], expected[k], tol, `${where}.${k}`, floor));
  }
  return actual === expected ? [] : [`${where}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`];
};

/** Top-level fields compared with their own { rel, abs } when the case gives fieldTol. */
const diffCase = (r, c) => {
  const floor = c.abs ?? FLOOR;
  const ft = c.fieldTol || {};
  return Object.keys(c.expected).flatMap((k) => {
    const t = ft[k];
    return diff(r[k], c.expected[k], t ? (t.rel ?? 0) : c.tol, `${c.fn}.${k}`, t ? (t.abs ?? floor) : floor);
  });
};

const call = (c) => FC[c.fn](JSON.parse(JSON.stringify(c.args)));
const byId = (id) => {
  const c = G.cases.find((x) => x.id === id);
  if (!c) throw new Error(`golden case ${id} is missing from forecast_cases.json`);
  return c;
};
const args = (id) => JSON.parse(JSON.stringify(byId(id).args));

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('forecast');
    expect(G.generatedBy).toBe('tools/validation/dataai/oracle_forecast.py');
    expect(G.cases.length).toBeGreaterThan(100);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by at least one golden, and refused at least once', () => {
    const fns = Object.keys(FC).filter((k) => typeof FC[k] === 'function');
    const used = new Set(G.cases.map((c) => c.fn));
    expect(fns.filter((f) => !used.has(f))).toEqual([]);
    const refused = new Set(G.cases.filter((c) => c.expected.error === true).map((c) => c.fn));
    expect(fns.filter((f) => !refused.has(f))).toEqual([]);
  });

  test.each(G.cases.map((c) => [c.id, c]))('%s', (_id, c) => {
    const r = call(c);
    const e = c.expected;
    if (e && e.error === true) {
      expect([typeof r.error, r.field]).toEqual(['string', e.field]);
      expect(r.error.startsWith(e.field.replace(/[.[].*$/, ''))).toBe(true);
      expect(r.error).toBe(e.message);
      return;
    }
    expect(r && r.error).toBeFalsy();
    expect(diffCase(r, c)).toEqual([]);
  });
});

describe('published values: NIST/SEMATECH e-Handbook 6.4.3', () => {
  const pub = G.cases.filter((c) => c.source === 'published');
  test('six NIST cases carry published figures', () => expect(pub.length).toBe(6));
  test.each(pub.flatMap((c) => c.published.map((p) => [`${c.id} ${p.field}`, c, p])))('%s', (_n, c, p) => {
    const v = get(call(c), p.field);
    expect(Math.round(v * 10 ** p.digits) / 10 ** p.digits).toBe(p.value);
  });
});

describe('second witness: statsmodels / scipy / scikit-learn pins', () => {
  test('the pin file names its generator and library versions', () => {
    expect(PINS.generatedBy).toBe('tools/validation/dataai/pin_forecast.py');
    expect(Object.keys(PINS.versions).sort()).toEqual(['numpy', 'scikit-learn', 'scipy', 'statsmodels']);
    expect(PINS.pins.length).toBeGreaterThan(40);
  });

  test.each(PINS.pins.map((p) => [p.id, p]))('%s', (_id, p) => {
    const r = call(byId(p.case));
    let v = get(r, p.field);
    if (p.from !== undefined) v = v.slice(p.from);
    if (p.compare === 'atMost') {
      // the engine's minimum is no worse than the library optimiser's
      expect(v).toBeLessThanOrEqual(p.value * (1 + p.tol));
      return;
    }
    expect(diff(v, p.value, p.tol, `${p.case}.${p.field}`, p.abs ?? FLOOR)).toEqual([]);
  });
});

describe('smoothing: properties', () => {
  test('damped with phi = 1 is Holt', () => {
    const a = args('damped-ekene2-phi-1');
    const d = FC.fitSmoothing(a);
    const h = FC.fitSmoothing({ y: a.y, method: 'holt', alpha: a.alpha, beta: a.beta, h: a.h });
    expect(d.forecast).toEqual(h.forecast);
    expect(d.sse).toBe(h.sse);
  });
  test('holt with beta = 0 and alpha = 1 forecasts the last value plus the first difference per step', () => {
    const y = args('holt-beta-0').y;
    const r = FC.fitSmoothing({ y, method: 'holt', alpha: 1, beta: 0, h: 3 });
    const dy = y[1] - y[0];
    r.forecast.forEach((f, j) => expect(f).toBeCloseTo(y[y.length - 1] + (j + 1) * dy, 9));
  });
  test('the fitted SSE is no worse than every coarse grid point and every fixed-parameter case on the same data', () => {
    const a = args('holt-ekene1-fit');
    const r = FC.fitSmoothing(a);
    expect(r.sse).toBeLessThanOrEqual(r.optimiser.gridSse);
    expect(r.sse).toBeLessThanOrEqual(FC.fitSmoothing({ ...a, alpha: 0.4, beta: 0.15 }).sse);
  });
  test('holding the estimated parameters fixed reproduces the fit exactly', () => {
    const a = args('damped-ekene3-fit');
    const r = FC.fitSmoothing(a);
    const again = FC.fitSmoothing({ ...a, ...r.params });
    expect(again.sse).toBe(r.sse);
    expect(again.forecast).toEqual(r.forecast);
    expect(again.optimiser).toBe(null);
  });
  test('the damped forecast flattens: the step-to-step change shrinks by phi', () => {
    const r = call(byId('damped-ekene1-fixed'));
    const d1 = r.forecast[1] - r.forecast[0]; const d2 = r.forecast[2] - r.forecast[1];
    expect(d2 / d1).toBeCloseTo(0.9, 12);
  });
  test('residuals are null before scoredFrom and y - fitted after it', () => {
    const r = call(byId('holt-ekene1-fixed'));
    const y = args('holt-ekene1-fixed').y;
    expect(r.scoredFrom).toBe(2);
    expect(r.residuals.slice(0, 2)).toEqual([null, null]);
    for (let t = 2; t < y.length; t += 1) expect(r.residuals[t]).toBe(y[t] - r.fitted[t]);
    expect(r.sse).toBeCloseTo(r.residuals.slice(2).reduce((s, e) => s + e * e, 0), 6);
  });
});

describe('backtest, accuracy and comparison: properties', () => {
  test('a one-step backtest with fixed alpha reproduces the fitted one-step residuals', () => {
    const a = args('bt-ses-fixed-step1-h1');
    const bt = FC.backtest(a);
    const fit = FC.fitSmoothing({ y: a.y, method: 'ses', alpha: a.alpha });
    bt.perOrigin.forEach((row) => expect(row.errors[0]).toBeCloseTo(fit.residuals[row.origin], 10));
  });
  test('refit false holds the first window parameters at every origin', () => {
    const r = call(byId('bt-holt-refit-false'));
    r.perOrigin.forEach((row) => expect(row.params).toEqual(r.perOrigin[0].params));
  });
  test('pooled metrics equal accuracy() on the concatenated errors when every origin shares one scale', () => {
    const bt = call(byId('bt-ses-fixed'));
    const actual = bt.perOrigin.flatMap((r) => r.actual);
    const forecast = bt.perOrigin.flatMap((r) => r.forecast);
    const acc = FC.accuracy({ actual, forecast });
    ['mae', 'rmse', 'me', 'smape'].forEach((k) => expect(bt.overall[k]).toBeCloseTo(acc[k], 10));
  });
  test('compareWithArps uses the same origins and the same smoothing numbers as backtest', () => {
    const a = args('cmp-ekene1');
    const cmp = FC.compareWithArps(a);
    const bt = FC.backtest({ y: a.y, method: 'holt', firstOrigin: a.firstOrigin, horizon: a.horizon, step: a.step });
    const row = cmp.rows.find((r) => r.method === 'holt');
    expect(row.origins).toEqual(bt.origins);
    expect(row.mase).toBe(bt.overall.mase);
    expect(cmp.rows.find((r) => r.method === 'arps').origins).toEqual(bt.origins);
  });
  test('the Arps row is fitArpsModel itself (imported, not re-implemented)', () => {
    const y = args('arps-clean-auto').y;
    const r = FC.arpsForecast({ y });
    const direct = fitArpsModel(y.map((rate, k) => ({ date: new Date(Date.UTC(2000, 0, 1) + k * 86400000).toISOString(), rate })), 'Auto-Select');
    expect([r.qi, r.Di, r.b, r.modelType]).toEqual([direct.parameters.qi, direct.parameters.Di, direct.parameters.b, direct.parameters.modelType]);
    const src = fs.readFileSync(path.join(__dirname, '..', 'engines', 'dataai', 'forecast.js'), 'utf8');
    expect(src).toMatch(/from '\.\.\/dca\/arps\.js'/);
    expect(src.includes('Math.random')).toBe(false);
    expect(/Math\.pow\(1 \+ b/.test(src)).toBe(false);
  });
  test('MAPE and MASE report their reason instead of a number', () => {
    const r = call(byId('acc-zero-actual'));
    expect(r.mape).toBe(null);
    expect(r.notes.mape).toBe('MAPE is undefined: actual[1] is 0 and MAPE divides by each actual');
  });
});

describe('basis text: conventions the goldens do not carry', () => {
  const NOT_CENTRED = "residuals are drawn as fitted without centring (their mean is not subtracted), so a method whose residuals have a non-zero mean drifts: on a declining well a flat method's paths can fall below its own point forecast";
  test('the bootstrap basis states that residuals are not centred, and counts paths in the singular for one', () => {
    const one = call(byId('pi-ses-nsims-1')).basis.bootstrap;
    expect(one.startsWith('1 path; each step adds a residual')).toBe(true);
    expect(one.endsWith(`the simulated value updates the state; ${NOT_CENTRED}`)).toBe(true);
    expect(call(byId('pi-holt-ekene1')).basis.bootstrap.startsWith('1000 paths; each step adds a residual')).toBe(true);
  });
  test('the stated drift is real: a flat method on a declining well has negative mean residuals and paths below its point forecast', () => {
    const y = args('arps-clean-auto').y;
    const fit = FC.fitSmoothing({ y, method: 'ses', alpha: 0.3 });
    const res = fit.residuals.slice(fit.scoredFrom);
    expect(res.reduce((s, v) => s + v, 0) / res.length).toBeLessThan(0);
    const r = FC.forecastIntervals({ y, method: 'ses', alpha: 0.3, h: 12, seed: 7 });
    expect(r.P10[11]).toBeLessThan(r.forecast[11]);
  });
  test('the backtest basis names the forecast window, y[o] alone at horizon 1', () => {
    expect(call(byId('bt-ses-fixed-step1-h1')).basis.origins).toBe('expanding window: origin o trains on y[0..o-1] and forecasts y[o]; origins 6, 6 + 1, ... while o + 1 <= 12');
    expect(call(byId('bt-ses-last-origin-exact')).basis.origins).toBe('expanding window: origin o trains on y[0..o-1] and forecasts y[o..o+2]; origins 9, 9 + 1, ... while o + 3 <= 12');
  });
});

describe('bootstrap: properties', () => {
  test('the same seed gives the same percentiles; another seed differs', () => {
    const a = args('pi-holt-ekene1');
    expect(FC.forecastIntervals(a)).toEqual(FC.forecastIntervals(a));
    expect(FC.forecastIntervals({ ...a, seed: a.seed + 1 }).P50).not.toEqual(FC.forecastIntervals(a).P50);
  });
  test('P90 <= P50 <= P10 at every step (exceedance labels: P90 is the low case)', () => {
    const r = call(byId('pi-damped-ekene2'));
    r.P90.forEach((v, j) => { expect(v).toBeLessThanOrEqual(r.P50[j]); expect(r.P50[j]).toBeLessThanOrEqual(r.P10[j]); });
  });
  test('nonNegative clips only the negative percentiles', () => {
    const c = call(byId('pi-holt-clipped'));
    const u = call(byId('pi-holt-unclipped'));
    expect(c.clippedToZero).toBeGreaterThan(0);
    ['P90', 'P50', 'P10'].forEach((k) => u[k].forEach((v, j) => expect(c[k][j]).toBe(Math.max(0, v))));
  });
});

describe('scale: Ekene synthetic production', () => {
  const wells = syntheticProduction(4, 120);
  test('the generator is seeded, with a shut-in of zeros and a workover uplift', () => {
    expect(syntheticProduction(4, 120)).toEqual(wells);
    wells.forEach((w) => {
      expect(w.rate.length).toBe(120);
      const [s, e] = w.shutIn;
      for (let t = s; t <= e; t += 1) expect(w.rate[t]).toBe(0);
      expect(w.workover).toBe(e + 1);
    });
  });
  test('every method fits every well, and the comparison runs with Arps through the shut-in', () => {
    wells.forEach((w) => {
      ['ses', 'holt', 'damped'].forEach((method) => {
        const r = FC.fitSmoothing({ y: w.rate, method, h: 12 });
        expect(r.error).toBeUndefined();
        expect(r.optimiser.converged).toBe(true);
      });
      const cmp = FC.compareWithArps({ y: w.rate, firstOrigin: 84, horizon: 12, step: 12 });
      expect(cmp.error).toBeUndefined();
      expect(cmp.ranking.length).toBeGreaterThanOrEqual(3);
    });
  });
  test('row caps: 100,000 values accepted, 100,001 refused', () => {
    const big = new Array(100001).fill(1);
    expect(FC.fitSmoothing({ y: big, method: 'ses', alpha: 0.5 }).error).toBe('y has 100001 values, above the 100000 this engine accepts');
    expect(FC.fitSmoothing({ y: big.slice(1), method: 'ses', alpha: 0.5 }).sse).toBe(0);
  });
});
