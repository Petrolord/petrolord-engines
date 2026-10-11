// Property calibration from an inverted impedance volume (QI programme Q9a,
// 2026-10-07; SOW section 10; moved from the Suite's
// QIStudio/services/propertyRun.js on 2026-10-11, QI course gate E2). The
// wells' impedance and their property logs (porosity, or facies codes) are
// upscaled to seismic scale in time, the transform or the facies model is
// fitted to them (qi/propertyPrediction.js), and the calibration is checked by
// leaving each well out and predicting from the inverted impedance at that
// well. For porosity the left-out residuals carry the inversion's error, which
// the log-against-log fit cannot see; their pooled RMS widens the 80 percent
// band (Q10 to Q90; #987). Pure.
// Oracle: tools/validation/qi/oracle_qi_property_calibration.py.

import {
  fitLinearTransform, predictWithInterval, fitFaciesModel, faciesPosterior,
} from './propertyPrediction.js';
import { lowPassFinite, halfWindowFor } from './inversionQc.js';

export const PROPERTY_DEFAULTS = { upscaleHz: 50, density: 'gaussian', priors: 'wells' };
const fin = Number.isFinite;
const NULL_LIM = 1e29;
const isNull = (v) => !(Math.abs(v) <= NULL_LIM);

/** Most frequent code in a centred window (ties to the centre value); 0 and gaps are no facies. */
export function modeFilter(codes, half) {
  return Array.from(codes, (c0, i) => {
    const count = new Map();
    for (let j = Math.max(0, i - half); j <= Math.min(codes.length - 1, i + half); j++) {
      const c = codes[j];
      if (fin(c) && c > 0) count.set(c, (count.get(c) || 0) + 1);
    }
    if (!count.size) return NaN;
    let best = fin(c0) && c0 > 0 ? c0 : null; let bn = best != null ? count.get(best) || 0 : -1;
    for (const [c, n] of count) if (n > bn) { best = c; bn = n; }
    return best;
  });
}

const inWindow = (k, dtMs, w) => !w || (k * dtMs >= w[0] && k * dtMs <= w[1]);

/** The upscaled well data: AI and the property at seismic scale (one row per well). */
export function upscaleWells(pr, dtMs) {
  const half = halfWindowFor(pr.upscaleHz ?? PROPERTY_DEFAULTS.upscaleHz, dtMs);
  return pr.wells.map((w) => {
    const lnAi = lowPassFinite(w.ln_ai.map((v) => (fin(v) ? v : NaN)), half);
    const target = pr.kind === 'facies'
      ? modeFilter(w.target.map((v) => (fin(v) ? v : NaN)), half)
      : lowPassFinite(w.target.map((v) => (fin(v) ? v : NaN)), half);
    const vpvs = pr.attributes === 'ai_vpvs' ? Array.from(lowPassFinite(w.vpvs.map((v) => (fin(v) ? v : NaN)), half)) : null;
    return { name: w.name, il: w.il, xl: w.xl, ai: Array.from(lnAi, Math.exp), vpvs, target };
  });
}

/** Calibration samples of the upscaled wells (all, or all but one). */
function samplesOf(up, pr, dtMs, exclude) {
  const xs = []; const ys = []; const fac = [];
  for (const w of up) {
    if (w.name === exclude) continue;
    for (let k = 0; k < w.ai.length; k++) {
      if (!inWindow(k, dtMs, pr.window_ms) || !fin(w.ai[k]) || !fin(w.target[k])) continue;
      if (pr.kind === 'facies') {
        if (pr.names[String(w.target[k])] == null) continue;
        if (w.vpvs) { if (!fin(w.vpvs[k])) continue; fac.push({ facies: pr.names[String(w.target[k])], x: [w.ai[k], w.vpvs[k]] }); } else fac.push({ facies: pr.names[String(w.target[k])], x: [w.ai[k]] });
      } else { xs.push(w.ai[k]); ys.push(w.target[k]); }
    }
  }
  return { xs, ys, fac };
}

/** The fitted model from the upscaled wells. */
export function fitProperty(up, pr, dtMs, exclude) {
  const { xs, ys, fac } = samplesOf(up, pr, dtMs, exclude);
  if (pr.kind === 'facies') {
    const names = Object.values(pr.names);
    const present = new Set(fac.map((s) => s.facies));
    const priors = pr.priors === 'equal' ? Object.fromEntries(names.filter((n) => present.has(n)).map((n) => [n, 1])) : null;
    return fitFaciesModel(fac, { kind: pr.density || PROPERTY_DEFAULTS.density, priors });
  }
  return fitLinearTransform(xs, ys);
}

/**
 * Predict one AI trace (impedance, not its log).
 * @returns {Float64Array[]} porosity: [q10, q50, q90]; facies: one probability per class, then the most likely code
 */
export function predictTrace(model, pr, ai, vpvs = null) {
  const n = ai.length;
  if (pr.kind !== 'facies') {
    // t x s once per model from the engine, at the mean (its interval there is t s sqrt(1 + 1/n)); then the same formula per sample
    const atMean = predictWithInterval(model, model.xMean, 0.8);
    const ts = (atMean.hi - atMean.y) / Math.sqrt(1 + 1 / model.n);
    // the fit's scatter is log against log; the error of the inverted
    // impedance adds sExtra (from the wells left out, calibrateProperty), so
    // the band is t x sqrt(s^2 (1 + 1/n + leverage) + sExtra^2)
    const t = model.s > 0 ? ts / model.s : 0;
    const extra2 = fin(model.sExtra) && model.sExtra > 0 ? (t * model.sExtra) ** 2 : 0;
    const out = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    for (let k = 0; k < n; k++) {
      if (isNull(ai[k]) || !fin(ai[k])) { out[0][k] = NaN; out[1][k] = NaN; out[2][k] = NaN; continue; }
      const y = model.a + model.b * ai[k];
      const h = Math.sqrt(ts ** 2 * (1 + 1 / model.n + (ai[k] - model.xMean) ** 2 / model.sxx) + extra2);
      out[0][k] = y - h; out[1][k] = y; out[2][k] = y + h;
    }
    return out;
  }
  const codeOf = Object.fromEntries(Object.entries(pr.names).map(([c, name]) => [name, Number(c)]));
  const two = model.dims === 2;
  if (two && !vpvs) throw new Error('A two-attribute facies model needs the Vp/Vs trace.');
  const table = two ? posteriorTable2D(model) : posteriorTable(model);
  const out = model.classes.map(() => new Float64Array(n));
  const best = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const dead = isNull(ai[k]) || !fin(ai[k]) || (two && (isNull(vpvs[k]) || !fin(vpvs[k])));
    if (dead) { out.forEach((o) => { o[k] = NaN; }); best[k] = NaN; continue; }
    const probs = two ? table(ai[k], vpvs[k]) : table(ai[k]);
    let b = 0;
    probs.forEach((p, j) => { out[j][k] = p; if (p > probs[b]) b = j; });
    best[k] = codeOf[model.classes[b].name];
  }
  return [...out, best];
}

const TABLE_POINTS = 4001;
const tables = new WeakMap();
/**
 * The posterior of a one-attribute facies model tabulated on a fine grid
 * (6 standard deviations beyond the outer classes, 4001 points) and read
 * by linear interpolation, so a volume costs a table lookup per sample
 * whatever the density. Outside the grid the end values hold.
 */
export function posteriorTable(model) {
  if (tables.has(model)) return tables.get(model);
  let lo = Infinity; let hi = -Infinity;
  for (const c of model.classes) {
    const sd = Math.sqrt(c.cov[0][0]);
    lo = Math.min(lo, c.mean[0] - 6 * sd); hi = Math.max(hi, c.mean[0] + 6 * sd);
  }
  const step = (hi - lo) / (TABLE_POINTS - 1);
  const grid = Array.from({ length: TABLE_POINTS }, (_, i) => faciesPosterior(model, [lo + i * step]).probs);
  const read = (x) => {
    const t = Math.min(TABLE_POINTS - 1, Math.max(0, (x - lo) / step));
    const i = Math.min(TABLE_POINTS - 2, Math.floor(t)); const f = t - i;
    return grid[i].map((p, j) => p + f * (grid[i + 1][j] - p));
  };
  tables.set(model, read);
  return read;
}

const TABLE_2D = 201;
/**
 * The posterior of a two-attribute model on a 201 x 201 grid (6 standard
 * deviations beyond the outer classes on each axis), read by bilinear
 * interpolation; outside the grid the edge values hold.
 */
export function posteriorTable2D(model) {
  if (tables.has(model)) return tables.get(model);
  const lim = [0, 1].map((d) => {
    let lo = Infinity; let hi = -Infinity;
    for (const c of model.classes) { const sd = Math.sqrt(c.cov[d][d]); lo = Math.min(lo, c.mean[d] - 6 * sd); hi = Math.max(hi, c.mean[d] + 6 * sd); }
    return { lo, step: (hi - lo) / (TABLE_2D - 1) };
  });
  const grid = [];
  for (let i = 0; i < TABLE_2D; i++) for (let j = 0; j < TABLE_2D; j++) grid.push(faciesPosterior(model, [lim[0].lo + i * lim[0].step, lim[1].lo + j * lim[1].step]).probs);
  const read = (x, y) => {
    const u = Math.min(TABLE_2D - 1, Math.max(0, (x - lim[0].lo) / lim[0].step));
    const v = Math.min(TABLE_2D - 1, Math.max(0, (y - lim[1].lo) / lim[1].step));
    const i = Math.min(TABLE_2D - 2, Math.floor(u)); const j = Math.min(TABLE_2D - 2, Math.floor(v));
    const fu = u - i; const fv = v - j;
    const g = (a, b) => grid[a * TABLE_2D + b];
    return g(i, j).map((p00, c) => (1 - fu) * (1 - fv) * p00 + fu * (1 - fv) * g(i + 1, j)[c] + (1 - fu) * fv * g(i, j + 1)[c] + fu * fv * g(i + 1, j + 1)[c]);
  };
  tables.set(model, read);
  return read;
}

/**
 * The calibration and its check: the model on every well, then each well
 * left out and predicted from the inverted impedance at that well.
 * @param {Object} p
 * @param {Object} p.pr the job's property block
 * @param {Array<ArrayLike<number>>} p.aiTraces the inverted AI at each well, in pr.wells order
 * @param {number} p.dtMs
 */
export function calibrateProperty({ pr, aiTraces, vpvsTraces = null, dtMs }) {
  const up = upscaleWells(pr, dtMs);
  const all = fitProperty(up, pr, dtMs);
  // pass 1: each well left out and predicted from the inverted impedance at it
  const left = up.map((w, k) => {
    let m;
    try { m = fitProperty(up, pr, dtMs, w.name); } catch (e) { return { w, error: e.message }; }
    const pred = predictTrace(m, pr, aiTraces[k], vpvsTraces ? vpvsTraces[k] : null);
    const idx = [];
    for (let i = 0; i < w.target.length; i++) if (inWindow(i, dtMs, pr.window_ms) && fin(w.target[i]) && fin(pred[pred.length - 1][i])) idx.push(i);
    return { w, k, m, pred, idx };
  });
  if (pr.kind === 'facies') {
    const rows = left.map(({ w, error, pred, idx }) => {
      if (error) return { name: w.name, error };
      const known = idx.filter((i) => pr.names[String(w.target[i])] != null);
      const ok = known.filter((i) => pred[pred.length - 1][i] === w.target[i]).length;
      return { name: w.name, n: known.length, accuracy: known.length ? ok / known.length : NaN };
    });
    const summary = { classes: all.classes.map((c) => ({ name: c.name, n: c.n, prior: c.prior, mean: c.mean[0], sd: Math.sqrt(c.cov[0][0]), ...(all.dims === 2 ? { meanVpVs: c.mean[1], sdVpVs: Math.sqrt(c.cov[1][1]) } : {}) })), density: all.kind, attributes: all.dims === 2 ? 'ai_vpvs' : 'ai' };
    return { model: all, summary, rows };
  }
  // porosity: the left-out residuals carry the inversion's error, which the
  // log-against-log fit cannot see (on the Ekene demo the 80 percent band held
  // the log 13 to 47 percent of the time, found 2026-10-10). Their pooled
  // RMS widens the band. Each well's check uses the other wells' residuals
  // only, so the reported coverage stays a test the well did not set.
  const resid = left.map((L) => (L.error ? [] : L.idx.map((i) => L.pred[1][i] - L.w.target[i])));
  const pooledRms = (skip) => {
    let se = 0; let n = 0;
    resid.forEach((r, j) => { if (j === skip) return; for (const v of r) { se += v * v; n += 1; } });
    return n >= 5 ? Math.sqrt(se / n) : NaN;
  };
  const extraFor = (rms, s) => (fin(rms) && fin(s) && rms > s ? Math.sqrt(rms * rms - s * s) : 0);
  const rows = left.map((L, j) => {
    if (L.error) return { name: L.w.name, error: L.error };
    const m = { ...L.m, sExtra: extraFor(pooledRms(j), L.m.s) };
    const pred = predictTrace(m, pr, aiTraces[L.k], vpvsTraces ? vpvsTraces[L.k] : null);
    let se = 0; let sr = 0; let inside = 0; let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
    for (const i of L.idx) {
      const y = L.w.target[i]; const q = pred[1][i];
      se += (q - y) ** 2; sr += q - y;
      if (y >= pred[0][i] && y <= pred[2][i]) inside += 1;
      sx += q; sy += y; sxx += q * q; syy += y * y; sxy += q * y;
    }
    const n = L.idx.length;
    const cov = sxy / n - (sx / n) * (sy / n); const vx = sxx / n - (sx / n) ** 2; const vy = syy / n - (sy / n) ** 2;
    return { name: L.w.name, n, rms: n ? Math.sqrt(se / n) : NaN, bias: n ? sr / n : NaN, corr: vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN, coverage: n ? inside / n : NaN };
  });
  const sLoo = pooledRms(-1);
  const model = { ...all, sExtra: extraFor(sLoo, all.s) };
  const summary = { a: all.a, b: all.b, r2: all.r2, n: all.n, s: all.s, sLoo, sExtra: model.sExtra };
  return { model, summary, rows };
}
