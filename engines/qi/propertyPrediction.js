// Property prediction from inverted impedance (QI programme Q9a, SOW
// section 10). Two tools, both calibrated at the wells after the logs are
// upscaled to seismic scale:
//  - a linear transform (porosity from impedance, say) by least squares,
//    with the prediction interval of a new observation (Student t on n - 2
//    degrees of freedom; the 80 percent interval gives Q10 and Q90);
//  - Bayesian facies classification: a density per facies in attribute
//    space (Gaussian, or a Gaussian kernel density with Scott's bandwidth
//    as in scipy.stats.gaussian_kde), priors (the wells' proportions
//    unless stated), and the posterior probability of each facies with the
//    most likely one (Avseth et al. 2005, Quantitative Seismic
//    Interpretation, ch. 4).
// Pure, float64.

import { studentTUpperQuantile } from '../dataai/quality.js';

const fin = Number.isFinite;

// ---- linear transform -----------------------------------------------------

/** Least-squares y = a + b x over the pairs where both are finite. */
export function fitLinearTransform(x, y) {
  const px = []; const py = [];
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (fin(x[i]) && fin(y[i])) { px.push(x[i]); py.push(y[i]); }
  const n = px.length;
  if (n < 3) throw new Error('A transform needs at least three calibration points.');
  const mx = px.reduce((a, v) => a + v, 0) / n; const my = py.reduce((a, v) => a + v, 0) / n;
  let sxx = 0; let sxy = 0; let syy = 0;
  for (let i = 0; i < n; i++) { sxx += (px[i] - mx) ** 2; sxy += (px[i] - mx) * (py[i] - my); syy += (py[i] - my) ** 2; }
  if (!(sxx > 0)) throw new Error('The calibration points share one value of the predictor.');
  const b = sxy / sxx; const a = my - b * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (py[i] - a - b * px[i]) ** 2;
  return { a, b, n, xMean: mx, sxx, s: Math.sqrt(sse / (n - 2)), r2: syy > 0 ? 1 - sse / syy : NaN };
}

/** Prediction with the central interval of a new observation (level 0.8 gives Q10 and Q90). */
export function predictWithInterval(fit, x0, level = 0.8) {
  if (!fin(x0)) return { y: NaN, lo: NaN, hi: NaN };
  const y = fit.a + fit.b * x0;
  const t = studentTUpperQuantile((1 - level) / 2, fit.n - 2);
  const half = t * fit.s * Math.sqrt(1 + 1 / fit.n + (x0 - fit.xMean) ** 2 / fit.sxx);
  return { y, lo: y - half, hi: y + half };
}

// ---- Bayesian facies --------------------------------------------------------

function meanCov(rows, d) {
  const n = rows.length;
  const mean = new Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r[j] / n;
  const cov = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const r of rows) for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) cov[i][j] += ((r[i] - mean[i]) * (r[j] - mean[j])) / (n - 1);
  return { mean, cov };
}

function cholesky(a) {
  const d = a.length;
  const L = Array.from({ length: d }, () => new Array(d).fill(0));
  for (let i = 0; i < d; i++) {
    for (let j = 0; j <= i; j++) {
      let s = a[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (!(s > 0)) throw new Error('A facies covariance is not positive definite: too few or collinear samples.');
        L[i][i] = Math.sqrt(s);
      } else L[i][j] = s / L[j][j];
    }
  }
  return L;
}

/** log N(x; mean, L L^T) */
function logGauss(x, mean, L) {
  const d = mean.length;
  const z = new Array(d);
  let logDet = 0;
  for (let i = 0; i < d; i++) {
    let s = x[i] - mean[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * z[k];
    z[i] = s / L[i][i];
    logDet += Math.log(L[i][i]);
  }
  let q = 0;
  for (const v of z) q += v * v;
  return -0.5 * q - logDet - 0.5 * d * Math.log(2 * Math.PI);
}

const logSumExp = (xs) => {
  const m = Math.max(...xs);
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (const v of xs) s += Math.exp(v - m);
  return m + Math.log(s);
};

/**
 * The facies model from labelled samples.
 * @param {Array<{facies: string, x: number[]}>} samples attribute vectors (1 to 3 dimensions)
 * @param {{kind?: 'gaussian'|'kde', priors?: Object<string, number>}} [opts]
 * @returns {{kind, dims, classes: Array<{name, n, prior, mean, cov, L, points?}>}}
 */
export function fitFaciesModel(samples, { kind = 'gaussian', priors = null } = {}) {
  const clean = samples.filter((s) => s && s.facies != null && Array.isArray(s.x) && s.x.every(fin));
  if (!clean.length) throw new Error('No labelled samples.');
  const dims = clean[0].x.length;
  if (dims < 1 || dims > 3 || clean.some((s) => s.x.length !== dims)) throw new Error('Use one to three attributes, the same for every sample.');
  const groups = new Map();
  for (const s of clean) { if (!groups.has(s.facies)) groups.set(s.facies, []); groups.get(s.facies).push(s.x); }
  const total = clean.length;
  const classes = [];
  for (const [name, rows] of groups) {
    if (rows.length < dims + 2) throw new Error(`Facies ${name} has ${rows.length} samples; at least ${dims + 2} are needed.`);
    const { mean, cov } = meanCov(rows, dims);
    const c = { name, n: rows.length, prior: rows.length / total, mean, cov };
    if (kind === 'kde') {
      // scipy.stats.gaussian_kde: kernel covariance = data covariance x Scott's factor squared
      const f = rows.length ** (-1 / (dims + 4));
      c.points = rows;
      c.L = cholesky(cov.map((r) => r.map((v) => v * f * f)));
    } else {
      c.L = cholesky(cov);
    }
    classes.push(c);
  }
  if (priors) {
    let s = 0;
    for (const c of classes) { const p = priors[c.name]; if (!(p >= 0)) throw new Error(`No prior for facies ${c.name}.`); s += p; }
    if (!(s > 0)) throw new Error('The priors sum to zero.');
    for (const c of classes) c.prior = priors[c.name] / s;
  }
  return { kind, dims, classes };
}

/** log density of x under one class. */
export function classLogDensity(c, x, kind) {
  if (kind === 'kde') return logSumExp(c.points.map((p) => logGauss(x, p, c.L))) - Math.log(c.points.length);
  return logGauss(x, c.mean, c.L);
}

/**
 * Posterior probability of each facies at x, and the most likely.
 * @returns {{probs: number[], best: number}} probs in model.classes order
 */
export function faciesPosterior(model, x) {
  if (!x.every(fin)) return { probs: model.classes.map(() => NaN), best: -1 };
  const lp = model.classes.map((c) => (c.prior > 0 ? Math.log(c.prior) + classLogDensity(c, x, model.kind) : -Infinity));
  const z = logSumExp(lp);
  const probs = lp.map((v) => Math.exp(v - z));
  let best = 0;
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i;
  return { probs, best };
}

/** Confusion counts true (rows) x predicted (columns), and the share classified correctly. */
export function confusionMatrix(model, samples) {
  const idx = new Map(model.classes.map((c, i) => [c.name, i]));
  const m = model.classes.map(() => model.classes.map(() => 0));
  let ok = 0; let n = 0;
  for (const s of samples) {
    if (!idx.has(s.facies) || !s.x.every(fin)) continue;
    const { best } = faciesPosterior(model, s.x);
    m[idx.get(s.facies)][best] += 1;
    if (best === idx.get(s.facies)) ok += 1;
    n += 1;
  }
  return { names: model.classes.map((c) => c.name), counts: m, accuracy: n ? ok / n : NaN };
}
