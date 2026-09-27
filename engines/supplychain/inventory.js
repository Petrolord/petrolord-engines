/**
 * Materials, spares and inventory management (Supply Chain SC3): criticality
 * classes, ABC by annual usage value, the economic order quantity with and
 * without quantity discounts, safety stock and the reorder point (normal
 * demand and Poisson demand), insurance spares, lead-time risk by Monte Carlo,
 * and slow-moving and obsolete stock.
 *
 * Pure functions, no I/O. Every function returns either a result object
 * carrying a `basis` (the rules applied and where they come from, so a course
 * can print the working) or `{ error, field }`, where `field` names the input
 * refused and the message starts with that name and states the exact
 * condition that failed. There are no hidden defaults: every cost, rate,
 * service level, band, cut-off and rounding rule is a stated input.
 *
 * Sources (FINDINGS-inventory.md has URLs, editions, pages and the dates read):
 *   Harris 1913   F. W. Harris, "How Many Parts to Make at Once", Factory, The
 *                 Magazine of Management 10(2), Feb 1913, pp. 135-136, 152
 *                 (public domain; read in the Operations Research 38(6) 1990
 *                 reprint, pp. 947-950): X = sqrt(240 M S / C), the three
 *                 worked lots 2,190, 6,850 and 48.5.
 *   Caplice L7/8  C. Caplice, MIT ESD.260J Logistics Systems, Fall 2006,
 *                 lectures 7 and 8 (MIT OpenCourseWare, CC BY-NC-SA 4.0): EOQ,
 *                 all-units and incremental discounts (slides 9, 11 to 15).
 *   Caplice L11   lecture 11 slides 4, 12 to 24: s = xL + k sigmaL; cycle service level P1 =
 *                 Phi(k); item fill rate P2 = 1 - sigmaL G(k) / Q with the
 *                 unit normal loss G(k) = phi(k) - k (1 - Phi(k)); the
 *                 13,000-unit example (slide 24 table).
 *   Caplice L12   lecture 12 slides 5 and 6: (s, Q) to (R, S) by L -> R + L, Q -> D R.
 *   Caplice L13   lecture 13 slides 10 to 12: Poisson demand for slow movers;
 *                 the discrete loss function L(x+1) = L(x) - (1 - F(x)); the
 *                 lambda = 0.8 example.
 *   MIL-HDBK-338B US DoD Electronic Reliability Design Handbook, 1 Oct 1998,
 *                 section 5.3.8, eq. 5.58 and example 5.3.8.1 (probability of
 *                 r or fewer failures in t; two spares over 500 h at 0.001/h:
 *                 0.986).
 *
 * Conventions, stated once:
 *   money       one currency throughout, whatever unit the caller uses.
 *   time        eoq and quantityDiscount work in years (demand a year, holding
 *               a year). safetyStock and poissonStock work in any period the
 *               caller chooses, with demand, lead time and review period all
 *               in that period. insuranceSpares takes failures a year, lead
 *               time in days and the stated days a year.
 *   ties        two figures TIE when they agree to 12 significant digits
 *               (Number(x.toPrecision(12))); every cut-off, band edge and
 *               service target is compared on that key.
 *   rounding    a stated rule { rule: 'none' } or { rule: 'up' | 'down' |
 *               'nearest', multiple }; the quotient x / multiple is read at 12
 *               significant digits, then taken up, down, or to the nearest
 *               whole number with halves upward, and multiplied back.
 *   z           the inverse standard normal is Wichura's AS241 (PPND16,
 *               about 16 digits); Phi is 1 - Q(1/2, z^2 / 2) / 2 through the
 *               regularised incomplete gamma of engines/hse/safetyStats.js.
 *   Monte Carlo lib/stats mulberry32(seed), one stream; per iteration the lead
 *               time draw comes first, then the demand rate draw when it
 *               varies; each value is the triangular inverse CDF of its
 *               uniform (lib/stats triInvCDF). Summaries by lib/stats
 *               basicStats: P90 is the 10th percentile of the sorted values
 *               (index floor(0.1 n)), P50 floor(0.5 n), P10 floor(0.9 n), the
 *               exceedance labels of lib/conventions/percentile.js.
 *   NPV         none: nothing here is discounted.
 *   reasons     money prints rounded to the cent and a computed quantity,
 *               factor or probability to 6 decimal places (both half away
 *               from zero, trailing zeros dropped); stated inputs print as
 *               given. A printed bound is rounded toward the accepted side.
 *
 * Validation: tools/validation/supplychain/oracle_inventory.py (stdlib
 * python) writes test-data/supplychain/goldens/inventory_cases.json;
 * negcontrol_inventory.sh, timing_inventory.js. Fixtures (synthetic Ekene
 * materials register): test-data/supplychain/ekene-materials/.
 */

import { mulberry32, triInvCDF, basicStats, mean as statMean } from '../../lib/stats/stats.js';
import { EXCEEDANCE_DEFINITION } from '../../lib/conventions/percentile.js';
import { regularizedGammaQ } from '../hse/safetyStats.js';

export const DEFAULTS = Object.freeze({
  TIE_DIGITS: 12,
  WEIGHT_SUM: 100,
  WEIGHT_SUM_TOLERANCE: 1e-9,
  MAX_ITEMS: 5000,
  MAX_CRITERIA: 20,
  MAX_CLASSES: 10,
  MAX_BREAKS: 20,
  MAX_BANDS: 10,
  MAX_DECIMALS: 6,
  MAX_ITERATIONS: 200000,
  MAX_POISSON_MEAN: 500,
  MAX_SPARES: 1000,
});

const CITE = Object.freeze({
  harris: 'Harris (1913), How Many Parts to Make at Once, Factory 10(2) pp. 135-136, 152; Caplice, MIT ESD.260J (2006) lecture 7 and lecture 8 slide 3',
  allUnits: 'Caplice, MIT ESD.260J (2006) lecture 8 slides 11 and 12 (all-units discount)',
  incremental: 'Caplice, MIT ESD.260J (2006) lecture 8 slides 13 to 15 (incremental discount: Fi = Fi-1 + (vi-1 - vi) Qi, EOQi = sqrt(2 D (A + Fi) / (r vi)))',
  normal: 'Caplice, MIT ESD.260J (2006) lecture 11 (s = xL + k sigmaL; P1 = Phi(k); P2 = 1 - sigmaL G(k) / Q) and lecture 12 ((R, S): L becomes R + L)',
  poisson: 'Caplice, MIT ESD.260J (2006) lecture 13 (Poisson demand; L(x+1) = L(x) - (1 - F(x))); MIL-HDBK-338B (1998) section 5.3.8, eq. 5.58',
  spares: 'MIL-HDBK-338B (1998) section 5.3.8, eq. 5.58 (probability of n or fewer failures); Caplice, MIT ESD.260J (2006) lecture 13 (Poisson loss function)',
});

// ---- helpers ---------------------------------------------------------------

const refuse = (field, message) => ({ error: `${field} ${message}`, field });
const fmt = (x) => String(x);
const money = (x) => fmt(Number(x.toFixed(2)));
const dec = (x) => fmt(Number(x.toFixed(6)));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// a measured figure printed with its unit in agreement: 1 month, 1.5 months
const unit = (text, x, one, many = `${one}s`) => `${text} ${x === 1 ? one : many}`;
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const key12 = (x) => Number(x.toPrecision(DEFAULTS.TIE_DIGITS));
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// A printed bound (a maximum a refusal names) is the 6-decimal figure nearest
// the exact bound on the ACCEPTED side: rounded down for a maximum, and
// checked with the refusal's own rule, so typing the printed figure back
// passes. `ok` is that rule.
const boundMax = (x, ok) => {
  let k = Math.floor(x * 1e6);
  while (ok((k + 1) / 1e6)) k += 1;
  while (!ok(k / 1e6)) k -= 1;
  const v = k / 1e6;
  return v === x ? fmt(v) : `${fmt(v)} (rounded down at the sixth decimal so that it is accepted)`;
};

const nonNeg = (field, v) => (fin(v) && v >= 0 ? null : refuse(field, `must be a finite number at or above 0; got ${fmt(v)}`));
const positive = (field, v) => (fin(v) && v > 0 ? null : refuse(field, `must be a finite number above 0; got ${fmt(v)}`));
const fraction01 = (field, v) => (fin(v) && v > 0 && v < 1 ? null : refuse(field, `must be a number strictly between 0 and 1; got ${fmt(v)}`));
const first = (...checks) => checks.find((c) => c) || null;

const checkList = (list, field, max) => {
  if (!Array.isArray(list) || list.length < 1) return refuse(field, 'must be an array of at least 1 entry');
  if (list.length > max) return refuse(field, `has ${list.length} entries; the cap is ${max}`);
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const x = list[i];
    if (!isObj(x)) return refuse(`${field}[${i}]`, 'must be an object');
    if (typeof x.id !== 'string' || x.id === '') return refuse(`${field}[${i}].id`, 'must be a non-empty string');
    if (seen.has(x.id)) return refuse(`${field}[${i}].id`, `repeats the id '${x.id}'`);
    seen.add(x.id);
  }
  return null;
};

const ROUNDING_RULES = ['none', 'up', 'down', 'nearest'];
const checkRounding = (r, field) => {
  if (!isObj(r) || !ROUNDING_RULES.includes(r.rule)) return refuse(field, "must be a stated rounding rule { rule: 'none' } or { rule: 'up' | 'down' | 'nearest', multiple }");
  if (r.rule === 'none') return r.multiple === undefined ? null : refuse(`${field}.multiple`, "must be left out when the rule is 'none'");
  return positive(`${field}.multiple`, r.multiple);
};
const roundTo = (x, r) => {
  if (r.rule === 'none') return x;
  const q = key12(x / r.multiple);
  const n = r.rule === 'up' ? Math.ceil(q) : r.rule === 'down' ? Math.floor(q) : Math.floor(q + 0.5);
  return n * r.multiple;
};
const roundingText = (r) => (r.rule === 'none' ? 'no rounding' : r.rule === 'nearest' ? `the nearest multiple of ${fmt(r.multiple)} (halves upward)` : `${r.rule} to a multiple of ${fmt(r.multiple)}`);

// ---- accepted keys ---------------------------------------------------------
//
// Every public function refuses an input key it does not read, at every
// level, so a misspelt key (holdingrate for holdingRate) is never dropped
// silently. The walk checks an object's own keys in their order, then its
// children in the order listed here; a key whose value is undefined counts as
// absent. Id-keyed maps (an item's scores) are checked by the function.
const O = (keys, children = {}) => ({ t: 'obj', keys, children });
const L = (of) => ({ t: 'list', of });
const TRI = O(['min', 'mode', 'max']);
const TRI_OR_NUMBER = { t: 'tri' };
const ROUNDING = O(['rule', 'multiple']);
export const ACCEPTED_KEYS = Object.freeze({
  criticality: O(['criteria', 'scoreMax', 'items', 'classes', 'topClassOnMaxScore'], {
    criteria: L(O(['id', 'label', 'weight'])), items: L(O(['id', 'name', 'scores'])), classes: L(O(['label', 'minScore'])),
  }),
  abcClassification: O(['items', 'cutoffs', 'boundaryRule'], { items: L(O(['id', 'name', 'annualUsage', 'unitCost'])), cutoffs: O(['aPct', 'bPct']) }),
  eoq: O(['annualDemand', 'orderCost', 'holdingCostPerUnitYear', 'unitCost', 'holdingRate', 'rounding'], { rounding: ROUNDING }),
  quantityDiscount: O(['annualDemand', 'orderCost', 'holdingRate', 'breaks', 'discountType', 'rounding'], { breaks: L(O(['minQuantity', 'unitPrice'])), rounding: ROUNDING }),
  safetyStock: O(['demandMean', 'demandSd', 'leadTime', 'leadTimeSd', 'reviewPeriod', 'serviceMeasure', 'serviceLevel', 'orderQuantity', 'safetyFactorRounding', 'minimumSafetyFactor', 'rounding'], {
    safetyFactorRounding: O(['rule', 'decimals']), rounding: ROUNDING,
  }),
  poissonStock: O(['demandRate', 'leadTime', 'reviewPeriod', 'serviceMeasure', 'serviceLevel', 'orderQuantity']),
  insuranceSpares: O(['failuresPerYear', 'leadTimeDays', 'daysPerYear', 'unitCost', 'holdingRate', 'downtimeCostPerDay', 'maxSpares']),
  leadTimeRisk: O(['demandPerDay', 'leadTimeDays', 'reorderPoint', 'serviceLevel', 'iterations', 'seed'], { demandPerDay: TRI_OR_NUMBER, leadTimeDays: TRI_OR_NUMBER }),
  slowMoving: O(['items', 'bands', 'excessCoverMonths'], {
    items: L(O(['id', 'name', 'onHand', 'unitCost', 'monthsSinceLastIssue', 'monthlyUsage'])), bands: L(O(['label', 'minMonths', 'writeDownPct'])),
  }),
});

const unknownKey = (path, key, keys) => refuse(path ? `${path}.${key}` : key, `is not an accepted key; the accepted keys ${path ? `of ${path}` : 'at the top level'} are ${keys.join(', ')}`);
const walkKeys = (v, spec, path) => {
  if (spec.t === 'tri') return isObj(v) ? walkKeys(v, TRI, path) : null;
  if (spec.t === 'list') {
    if (!Array.isArray(v)) return null;
    for (let i = 0; i < v.length; i += 1) { const e = walkKeys(v[i], spec.of, `${path}[${i}]`); if (e) return e; }
    return null;
  }
  if (!isObj(v)) return null;
  for (const k of Object.keys(v)) if (v[k] !== undefined && !spec.keys.includes(k)) return unknownKey(path, k, spec.keys);
  for (const k of spec.keys) {
    if (own(spec.children, k) && v[k] !== undefined) { const e = walkKeys(v[k], spec.children[k], path ? `${path}.${k}` : k); if (e) return e; }
  }
  return null;
};
const guard = (name, impl) => (args = {}) => {
  if (!isObj(args)) return refuse('options', 'must be an object of named inputs');
  const e = walkKeys(args, ACCEPTED_KEYS[name], '');
  return e || impl(args);
};

// ---- the normal and Poisson numerics ---------------------------------------

// Wichura (1988) AS241 PPND16: the inverse standard normal to about 16 digits.
const inverseNormal = (p) => {
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    const num = (((((((2509.0809287301226727 * r + 33430.575583588128105) * r + 67265.770927008700853) * r
      + 45921.953931549871457) * r + 13731.693765509461125) * r + 1971.5909503065514427) * r
      + 133.14166789178437745) * r + 3.387132872796366608) * q;
    const den = ((((((5226.495278852545561 * r + 28729.085735721942674) * r + 39307.89580009271061) * r
      + 21213.794301586595867) * r + 5394.1960214247511077) * r + 687.1870074920579083) * r
      + 42.313330701600911252) * r + 1;
    return num / den;
  }
  let r = q <= 0 ? p : 1 - p;
  r = Math.sqrt(-Math.log(r));
  let num;
  let den;
  if (r <= 5) {
    r -= 1.6;
    num = ((((((7.7454501427834140764e-4 * r + 0.0227238449892691845833) * r + 0.24178072517745061177) * r
      + 1.27045825245236838258) * r + 3.64784832476320460504) * r + 5.7694972214606914055) * r
      + 4.6303378461565452959) * r + 1.42343711074968357734;
    den = ((((((1.05075007164441684324e-9 * r + 5.475938084995344946e-4) * r + 0.0151986665636164571966) * r
      + 0.14810397642748007459) * r + 0.68976733498510000455) * r + 1.6763848301838038494) * r
      + 2.05319162663775882187) * r + 1;
  } else {
    r -= 5;
    num = ((((((2.01033439929228813265e-7 * r + 2.71155556874348757815e-5) * r + 0.0012426609473880784386) * r
      + 0.026532189526576123093) * r + 0.29656057182850489123) * r + 1.7848265399172913358) * r
      + 5.4637849111641143699) * r + 6.6579046435011037772;
    den = ((((((2.04426310338993978564e-15 * r + 1.4215117583164458887e-7) * r + 1.8463183175100546818e-5) * r
      + 7.868691311456132591e-4) * r + 0.0148753612908506148525) * r + 0.13692988092273580531) * r
      + 0.59983220655588793769) * r + 1;
  }
  const x = num / den;
  return q < 0 ? -x : x;
};

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const halfQ = (x) => 0.5 * regularizedGammaQ(0.5, (x * x) / 2);
/** Standard normal CDF Phi(x), to double precision in both tails. */
const normalCdf = (x) => (x >= 0 ? 1 - halfQ(x) : halfQ(x));
const upperTail = (x) => (x >= 0 ? halfQ(x) : 1 - halfQ(x));
const normalPdf = (x) => Math.exp(-(x * x) / 2) / SQRT_2PI;
/** Unit normal loss G(k) = phi(k) - k (1 - Phi(k)): expected units short per unit of sigma. */
const unitNormalLoss = (k) => normalPdf(k) - k * upperTail(k);
// The smallest k (to the last binary digit) with G(k) at or below t. G falls
// strictly, so bisection between a bracket that doubles outward.
const solveLoss = (t) => {
  let lo = -1;
  let hi = 1;
  while (unitNormalLoss(lo) <= t) lo *= 2;
  while (unitNormalLoss(hi) > t && hi < 64) hi *= 2;
  for (let i = 0; i < 400; i += 1) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (unitNormalLoss(mid) > t) lo = mid; else hi = mid;
  }
  return hi;
};

// Poisson(m) rows 0..n: probability, cumulative and the loss E[(X - s)+],
// by p(x) = p(x - 1) m / x and L(x + 1) = L(x) - (1 - F(x)).
const poissonRows = (m, until) => {
  const rows = [];
  let p = Math.exp(-m);
  let F = p;
  let Ls = m;
  rows.push({ s: 0, probability: p, cumulative: F, expectedShort: Ls });
  for (let x = 1; !until(rows[rows.length - 1]) && x <= DEFAULTS.MAX_POISSON_MEAN * 4 + 100; x += 1) {
    Ls -= 1 - F;
    if (Ls < 0) Ls = 0;
    p = (p * m) / x;
    F += p;
    rows.push({ s: x, probability: p, cumulative: Math.min(F, 1), expectedShort: Ls });
  }
  return rows;
};

// ---- criticality -----------------------------------------------------------

/**
 * Criticality class from stated criteria and weights (safety, production,
 * lead time, redundancy, or whatever the caller names). Weighted score =
 * sum over criteria of weight x score / scoreMax (weights add to 100, so the
 * score runs 0 to 100). Classes are stated with a minimum score each, in
 * descending order ending at 0; an item takes the first class whose minimum
 * it meets (at or above). topClassOnMaxScore names criteria on which a
 * maximum score places the item in the first class whatever its weighted
 * score (a stated override; [] for none).
 */
const criticalityImpl = ({ criteria, scoreMax, items, classes, topClassOnMaxScore } = {}) => {
  let e = checkList(criteria, 'criteria', DEFAULTS.MAX_CRITERIA);
  if (e) return e;
  for (let i = 0; i < criteria.length; i += 1) {
    const w = criteria[i].weight;
    if (!fin(w) || w <= 0 || w > 100) return refuse(`criteria[${i}].weight`, `must be a number above 0 and at most 100; got ${fmt(w)}`);
  }
  const wsum = criteria.reduce((s, c) => s + c.weight, 0);
  if (Math.abs(wsum - DEFAULTS.WEIGHT_SUM) > DEFAULTS.WEIGHT_SUM_TOLERANCE) return refuse('criteria', `weights must add to 100; they add to ${fmt(wsum)}`);
  e = positive('scoreMax', scoreMax);
  if (e) return e;
  if (!Array.isArray(classes) || classes.length < 2) return refuse('classes', 'must be an array of at least 2 classes, highest first');
  if (classes.length > DEFAULTS.MAX_CLASSES) return refuse('classes', `has ${classes.length} entries; the cap is ${DEFAULTS.MAX_CLASSES}`);
  const labels = new Set();
  for (let i = 0; i < classes.length; i += 1) {
    const c = classes[i];
    if (!isObj(c) || typeof c.label !== 'string' || c.label === '') return refuse(`classes[${i}].label`, 'must be a non-empty string');
    if (labels.has(c.label)) return refuse(`classes[${i}].label`, `repeats the label '${c.label}'`);
    labels.add(c.label);
    if (!fin(c.minScore) || c.minScore < 0 || c.minScore > 100) return refuse(`classes[${i}].minScore`, `must be a number from 0 to 100; got ${fmt(c.minScore)}`);
    if (i > 0 && !(c.minScore < classes[i - 1].minScore)) return refuse(`classes[${i}].minScore`, `must be below the class above it (${fmt(classes[i - 1].minScore)}); got ${fmt(c.minScore)}`);
  }
  if (classes[classes.length - 1].minScore !== 0) return refuse(`classes[${classes.length - 1}].minScore`, `must be 0 so that every item takes a class; got ${fmt(classes[classes.length - 1].minScore)}`);
  const ids = criteria.map((c) => c.id);
  if (!Array.isArray(topClassOnMaxScore)) return refuse('topClassOnMaxScore', 'must be an array of criterion ids (empty for none)');
  for (let i = 0; i < topClassOnMaxScore.length; i += 1) {
    if (!ids.includes(topClassOnMaxScore[i])) return refuse(`topClassOnMaxScore[${i}]`, `must be a criterion id (${ids.join(', ')}); got ${fmt(topClassOnMaxScore[i])}`);
  }
  e = checkList(items, 'items', DEFAULTS.MAX_ITEMS);
  if (e) return e;
  for (let i = 0; i < items.length; i += 1) {
    const s = items[i].scores;
    if (!isObj(s)) return refuse(`items[${i}].scores`, 'must be an object keyed by criterion id');
    for (const k of Object.keys(s)) if (s[k] !== undefined && !ids.includes(k)) return refuse(`items[${i}].scores.${k}`, `is not a criterion; the criteria are ${ids.join(', ')}`);
    for (const c of criteria) {
      const v = s[c.id];
      if (!fin(v) || v < 0 || v > scoreMax) return refuse(`items[${i}].scores.${c.id}`, `must be a number from 0 to scoreMax ${fmt(scoreMax)}; got ${fmt(v)}`);
    }
  }
  const top = classes[0].label;
  const out = items.map((it) => {
    const contributions = {};
    let score = 0;
    for (const c of criteria) {
      const v = (c.weight * it.scores[c.id]) / scoreMax;
      contributions[c.id] = v;
      score += v;
    }
    const forcing = topClassOnMaxScore.filter((id) => it.scores[id] === scoreMax);
    const byScore = classes.find((c) => key12(score) >= key12(c.minScore));
    let cls = byScore.label;
    let reason;
    if (forcing.length && byScore.label !== top) {
      cls = top;
      reason = `${it.id}: scores the maximum ${fmt(scoreMax)} on ${forcing.join(' and ')}, which places an item in class ${top} whatever its weighted score (${dec(score)}, class ${byScore.label} by score alone)`;
    } else {
      reason = `${it.id}: weighted score ${dec(score)} is at or above ${fmt(byScore.minScore)}, the minimum for class ${byScore.label}`;
      const i = classes.indexOf(byScore);
      if (i > 0) reason += `, and below ${fmt(classes[i - 1].minScore)} for class ${classes[i - 1].label}`;
    }
    return { id: it.id, weightedScore: score, contributions, class: cls, forcedBy: forcing.length && byScore.label !== top ? forcing : [], reason };
  });
  const counts = Object.fromEntries(classes.map((c) => [c.label, out.filter((r) => r.class === c.label).length]));
  return {
    items: out,
    counts,
    basis: {
      rule: `weighted score = sum of weight x score / ${fmt(scoreMax)} over ${plural(criteria.length, 'criterion', 'criteria')}; classes ${classes.map((c) => `${c.label} at or above ${fmt(c.minScore)}`).join(', ')}; compared at 12 significant digits`,
      override: topClassOnMaxScore.length ? `a maximum score on ${topClassOnMaxScore.join(' or ')} places the item in class ${top}` : 'none stated',
      source: 'the criteria, weights, classes and override are the caller\'s stated policy; the course names VED (vital, essential, desirable) as one such scheme',
    },
  };
};

// ---- ABC -------------------------------------------------------------------

const BOUNDARY_RULES = ['at-or-below', 'include-crossing'];
/**
 * ABC by annual usage value (annualUsage x unitCost), ranked highest first
 * (ties by id). With boundaryRule 'at-or-below' an item is A while its
 * cumulative share of value, itself included, is at or below aPct, B while at
 * or below bPct, else C. With 'include-crossing' the cumulative share BEFORE
 * the item decides (below aPct is A, below bPct is B), so the item that
 * crosses a cut-off joins the higher class.
 */
const abcImpl = ({ items, cutoffs, boundaryRule } = {}) => {
  let e = checkList(items, 'items', DEFAULTS.MAX_ITEMS);
  if (e) return e;
  for (let i = 0; i < items.length; i += 1) {
    e = first(nonNeg(`items[${i}].annualUsage`, items[i].annualUsage), nonNeg(`items[${i}].unitCost`, items[i].unitCost));
    if (e) return e;
  }
  if (!isObj(cutoffs)) return refuse('cutoffs', 'must be { aPct, bPct }, the cumulative value shares that close classes A and B');
  if (!fin(cutoffs.aPct) || cutoffs.aPct <= 0 || cutoffs.aPct >= 100) return refuse('cutoffs.aPct', `must be a number above 0 and below 100; got ${fmt(cutoffs.aPct)}`);
  if (!fin(cutoffs.bPct) || cutoffs.bPct <= cutoffs.aPct || cutoffs.bPct >= 100) return refuse('cutoffs.bPct', `must be a number above aPct ${fmt(cutoffs.aPct)} and below 100; got ${fmt(cutoffs.bPct)}`);
  if (!BOUNDARY_RULES.includes(boundaryRule)) return refuse('boundaryRule', "must be 'at-or-below' (the cumulative share including the item decides) or 'include-crossing' (the share before the item decides, so the item crossing a cut-off joins the higher class)");
  const rows = items.map((it) => ({ id: it.id, annualValue: it.annualUsage * it.unitCost }));
  const total = rows.reduce((s, r) => s + r.annualValue, 0);
  if (!(total > 0)) return refuse('items', 'must carry some annual usage value; every annualUsage x unitCost is 0');
  rows.sort((a, b) => (key12(a.annualValue) !== key12(b.annualValue) ? b.annualValue - a.annualValue : cmpStr(a.id, b.id)));
  let cum = 0;
  const { aPct, bPct } = cutoffs;
  const out = rows.map((r, i) => {
    const before = (100 * cum) / total;
    cum += r.annualValue;
    const after = (100 * cum) / total;
    const sharePct = (100 * r.annualValue) / total;
    let cls;
    let reason;
    if (boundaryRule === 'at-or-below') {
      cls = key12(after) <= key12(aPct) ? 'A' : key12(after) <= key12(bPct) ? 'B' : 'C';
      reason = cls === 'C'
        ? `${r.id}: cumulative share ${dec(after)}% is above ${fmt(bPct)}%`
        : `${r.id}: cumulative share ${dec(after)}% is at or below ${fmt(cls === 'A' ? aPct : bPct)}%${cls === 'B' ? ` and above ${fmt(aPct)}%` : ''}`;
    } else {
      cls = key12(before) < key12(aPct) ? 'A' : key12(before) < key12(bPct) ? 'B' : 'C';
      reason = cls === 'C'
        ? `${r.id}: cumulative share before it ${dec(before)}% is at or above ${fmt(bPct)}%`
        : `${r.id}: cumulative share before it ${dec(before)}% is below ${fmt(cls === 'A' ? aPct : bPct)}%${cls === 'B' ? ` and at or above ${fmt(aPct)}%` : ''}`;
    }
    return { id: r.id, rank: i + 1, annualValue: r.annualValue, sharePct, cumulativePct: after, class: cls, reason };
  });
  const summary = {};
  ['A', 'B', 'C'].forEach((c) => {
    const inC = out.filter((r) => r.class === c);
    const v = inC.reduce((s, r) => s + r.annualValue, 0);
    summary[c] = { count: inC.length, itemSharePct: (100 * inC.length) / out.length, annualValue: v, valueSharePct: (100 * v) / total };
  });
  return {
    items: out,
    totalAnnualValue: total,
    summary,
    basis: {
      rule: `annual usage value = annualUsage x unitCost, ranked highest first (ties by id); ${boundaryRule === 'at-or-below' ? 'the cumulative share including the item' : 'the cumulative share before the item'} decides against A ${fmt(aPct)}% and B ${fmt(bPct)}%; compared at 12 significant digits`,
      source: 'Caplice, MIT ESD.260J (2006) lecture 11 slide 4 (standard ABC analysis; the classes are arbitrary, so the cut-offs are the caller\'s stated policy)',
    },
  };
};

// ---- EOQ -------------------------------------------------------------------

/**
 * Harris-Wilson EOQ: Q* = sqrt(2 A D / h), with A the cost of an order, D the
 * annual demand and h the holding cost of a unit for a year, stated directly
 * (holdingCostPerUnitYear) or as holdingRate x unitCost. The stated rounding
 * rule gives the quantity ordered; costs are reported at that quantity and
 * at Q*.
 */
const eoqImpl = ({ annualDemand, orderCost, holdingCostPerUnitYear, unitCost, holdingRate, rounding } = {}) => {
  let e = first(positive('annualDemand', annualDemand), positive('orderCost', orderCost));
  if (e) return e;
  if ((holdingCostPerUnitYear === undefined) === (holdingRate === undefined)) return refuse('holdingCostPerUnitYear', 'or holdingRate: state exactly one (holdingRate goes with unitCost)');
  let h;
  if (holdingRate !== undefined) {
    e = first(positive('holdingRate', holdingRate), unitCost === undefined ? refuse('unitCost', 'is required with holdingRate (the holding cost is holdingRate x unitCost)') : positive('unitCost', unitCost));
    if (e) return e;
    h = holdingRate * unitCost;
  } else {
    e = first(positive('holdingCostPerUnitYear', holdingCostPerUnitYear), unitCost === undefined ? null : nonNeg('unitCost', unitCost));
    if (e) return e;
    h = holdingCostPerUnitYear;
  }
  e = checkRounding(rounding, 'rounding');
  if (e) return e;
  const q = Math.sqrt((2 * orderCost * annualDemand) / h);
  const qr = roundTo(q, rounding);
  if (!(qr > 0)) return refuse('rounding', `gives an order quantity of 0 from the EOQ ${dec(q)}; state a smaller multiple or another rule`);
  const orderingCost = (orderCost * annualDemand) / qr;
  const holdingCost = (h * qr) / 2;
  const relevantCost = orderingCost + holdingCost;
  const optimum = Math.sqrt(2 * orderCost * annualDemand * h);
  return {
    eoq: q,
    quantity: qr,
    holdingCostPerUnitYear: h,
    ordersPerYear: annualDemand / qr,
    cycleYears: qr / annualDemand,
    orderingCost,
    holdingCost,
    relevantCost,
    relevantCostAtEoq: optimum,
    roundingPenaltyPct: (100 * (relevantCost - optimum)) / optimum,
    purchaseCost: unitCost === undefined ? null : annualDemand * unitCost,
    reason: `EOQ = sqrt(2 x ${fmt(orderCost)} x ${fmt(annualDemand)} / ${dec(h)}) = ${dec(q)}; ordered as ${dec(qr)} (${roundingText(rounding)}), a relevant cost of ${money(relevantCost)} a year against ${money(optimum)} at the EOQ`,
    basis: {
      rule: 'Q* = sqrt(2 A D / h); ordering cost A D / Q; holding cost h Q / 2; relevant cost at Q* = sqrt(2 A D h)',
      source: CITE.harris,
    },
  };
};

// ---- quantity discounts ----------------------------------------------------

const DISCOUNT_TYPES = ['all-units', 'incremental'];
/**
 * EOQ under a price schedule. breaks are [{ minQuantity, unitPrice }] from
 * minQuantity 0, quantities rising and prices falling. Holding a unit for a
 * year costs holdingRate x its price. All-units: one price for the whole lot,
 * set by the lot's band; per band the EOQ at that price if it lies in the
 * band, the band's first quantity if the EOQ lies below it, nothing if above.
 * Incremental: each unit is priced by its own band, so a lot of Q in band i
 * costs Fi + vi Q with Fi = Fi-1 + (vi-1 - vi) Qi; per band the EOQ with
 * A + Fi if it lies in the band. Candidates are rounded by the stated rule and
 * costed at the rounded quantity; the lowest total cost wins, ties to the
 * smaller quantity.
 */
const quantityDiscountImpl = ({ annualDemand, orderCost, holdingRate, breaks, discountType, rounding } = {}) => {
  let e = first(positive('annualDemand', annualDemand), positive('orderCost', orderCost), positive('holdingRate', holdingRate));
  if (e) return e;
  if (!Array.isArray(breaks) || breaks.length < 1) return refuse('breaks', 'must be an array of at least 1 price band { minQuantity, unitPrice }');
  if (breaks.length > DEFAULTS.MAX_BREAKS) return refuse('breaks', `has ${breaks.length} entries; the cap is ${DEFAULTS.MAX_BREAKS}`);
  for (let i = 0; i < breaks.length; i += 1) {
    const b = breaks[i];
    if (!isObj(b)) return refuse(`breaks[${i}]`, 'must be an object { minQuantity, unitPrice }');
    e = first(nonNeg(`breaks[${i}].minQuantity`, b.minQuantity), positive(`breaks[${i}].unitPrice`, b.unitPrice));
    if (e) return e;
    if (i === 0 && b.minQuantity !== 0) return refuse('breaks[0].minQuantity', `must be 0 so that every quantity has a price; got ${fmt(b.minQuantity)}`);
    if (i > 0 && !(b.minQuantity > breaks[i - 1].minQuantity)) return refuse(`breaks[${i}].minQuantity`, `must be above the band before it (${fmt(breaks[i - 1].minQuantity)}); got ${fmt(b.minQuantity)}`);
    if (i > 0 && !(b.unitPrice < breaks[i - 1].unitPrice)) return refuse(`breaks[${i}].unitPrice`, `must be below the band before it (${fmt(breaks[i - 1].unitPrice)}); got ${fmt(b.unitPrice)}`);
  }
  if (!DISCOUNT_TYPES.includes(discountType)) return refuse('discountType', "must be 'all-units' (the band's price applies to the whole lot) or 'incremental' (each unit is priced by its own band)");
  e = checkRounding(rounding, 'rounding');
  if (e) return e;
  if (rounding.rule !== 'none') {
    for (let i = 1; i < breaks.length; i += 1) {
      const q = key12(breaks[i].minQuantity / rounding.multiple);
      if (q !== Math.round(q)) return refuse(`breaks[${i}].minQuantity`, `must be a multiple of rounding.multiple ${fmt(rounding.multiple)}, so that ordering at the break keeps its price; got ${fmt(breaks[i].minQuantity)}`);
    }
  }
  const A = orderCost;
  const D = annualDemand;
  const r = holdingRate;
  const F = [0];
  for (let i = 1; i < breaks.length; i += 1) F.push(F[i - 1] + (breaks[i - 1].unitPrice - breaks[i].unitPrice) * breaks[i].minQuantity);
  const bandOf = (Q) => {
    let i = 0;
    while (i + 1 < breaks.length && key12(Q) >= key12(breaks[i + 1].minQuantity)) i += 1;
    return i;
  };
  const costAt = (Q) => {
    const i = bandOf(Q);
    const v = breaks[i].unitPrice;
    const lot = discountType === 'all-units' ? v * Q : F[i] + v * Q;
    const effective = lot / Q;
    return {
      band: i, unitPrice: v, effectiveUnitPrice: effective,
      purchaseCost: D * effective, orderingCost: (A * D) / Q, holdingCost: (r * lot) / 2,
    };
  };
  const candidates = [];
  for (let i = 0; i < breaks.length; i += 1) {
    const v = breaks[i].unitPrice;
    const lo = breaks[i].minQuantity;
    const hi = i + 1 < breaks.length ? breaks[i + 1].minQuantity : Infinity;
    const q = Math.sqrt((2 * D * (A + (discountType === 'all-units' ? 0 : F[i]))) / (r * v));
    const inBand = key12(q) >= key12(lo) && (hi === Infinity || key12(q) < key12(hi));
    let quantity = null;
    let reason;
    if (inBand) {
      quantity = roundTo(q, rounding);
      if (!(quantity > 0)) return refuse('rounding', `gives an order quantity of 0 from the band ${i} EOQ ${dec(q)}; state a smaller multiple or another rule`);
      reason = `band ${i} at ${fmt(v)}: EOQ ${dec(q)} lies in the band from ${fmt(lo)}${hi === Infinity ? ' upward' : ` to below ${fmt(hi)}`}; candidate ${dec(quantity)}`;
    } else if (discountType === 'all-units' && key12(q) < key12(lo)) {
      quantity = lo;
      reason = `band ${i} at ${fmt(v)}: EOQ ${dec(q)} lies below the break ${fmt(lo)}, so the break quantity is the candidate`;
    } else {
      reason = `band ${i} at ${fmt(v)}: EOQ ${dec(q)} lies ${key12(q) < key12(lo) ? `below the band's first quantity ${fmt(lo)}` : `at or above the next break ${fmt(hi)}`}, so the band gives no candidate`;
    }
    const row = { band: i, unitPrice: v, fixedCost: F[i], eoq: q, feasible: quantity !== null, quantity, totalCost: null, reason };
    if (quantity !== null) {
      const c = costAt(quantity);
      Object.assign(row, { costedBand: c.band, effectiveUnitPrice: c.effectiveUnitPrice, purchaseCost: c.purchaseCost, orderingCost: c.orderingCost, holdingCost: c.holdingCost, totalCost: c.purchaseCost + c.orderingCost + c.holdingCost });
      row.reason += `, total cost ${money(row.totalCost)} a year`;
    }
    candidates.push(row);
  }
  const live = candidates.filter((c) => c.feasible);
  live.sort((a, b) => (key12(a.totalCost) !== key12(b.totalCost) ? a.totalCost - b.totalCost : a.quantity - b.quantity));
  if (!live.length) return refuse('breaks', 'give no band whose EOQ lies inside it; check the schedule');
  const best = live[0];
  const baseQ = Math.sqrt((2 * D * A) / (r * breaks[0].unitPrice));
  return {
    discountType,
    candidates,
    quantity: best.quantity,
    band: best.costedBand,
    totalCost: best.totalCost,
    savingsAgainstNoDiscount: D * breaks[0].unitPrice + Math.sqrt(2 * A * D * r * breaks[0].unitPrice) - best.totalCost,
    reason: `order ${dec(best.quantity)} at a total cost of ${money(best.totalCost)} a year (band ${best.costedBand}), the lowest of ${plural(live.length, 'candidate')}${live.length > 1 && key12(live[1].totalCost) === key12(best.totalCost) ? '; tied on cost, the smaller quantity is taken' : ''}`,
    basis: {
      rule: discountType === 'all-units'
        ? 'TC(Q) = D v + A D / Q + r v Q / 2 with v the price of the band holding Q'
        : 'lot cost Fi + vi Q in band i, Fi = Fi-1 + (vi-1 - vi) Qi; TC(Q) = D (Fi + vi Q) / Q + A D / Q + r (Fi + vi Q) / 2',
      baseline: `no-discount baseline: the EOQ ${dec(baseQ)} at the band 0 price`,
      rounding: roundingText(rounding),
      source: discountType === 'all-units' ? CITE.allUnits : CITE.incremental,
    },
  };
};

// ---- safety stock under normal demand --------------------------------------

const MEASURES = ['cycle-service', 'fill-rate'];
/**
 * Safety stock and the reorder point (continuous review, reviewPeriod 0) or
 * the order-up-to level (periodic review) for normal demand. Over the
 * protection period P = leadTime + reviewPeriod the demand has mean d P and
 * standard deviation sqrt(P sd_d^2 + d^2 sd_L^2). cycle-service: k =
 * Phi^-1(level), the probability of no stockout in a replenishment cycle.
 * fill-rate: the smallest k with sigma G(k) at or below Q (1 - level), the
 * fraction of demand met from stock. k is then rounded by the stated rule
 * and floored at the stated minimum (null for none); the level is rounded by
 * the stated rule and the service it achieves is reported.
 */
const safetyStockImpl = ({ demandMean, demandSd, leadTime, leadTimeSd, reviewPeriod, serviceMeasure, serviceLevel, orderQuantity, safetyFactorRounding, minimumSafetyFactor, rounding } = {}) => {
  let e = first(nonNeg('demandMean', demandMean), nonNeg('demandSd', demandSd), nonNeg('leadTime', leadTime), nonNeg('leadTimeSd', leadTimeSd), nonNeg('reviewPeriod', reviewPeriod));
  if (e) return e;
  if (!(leadTime + reviewPeriod > 0)) return refuse('leadTime', 'and reviewPeriod add to 0; the protection period must be above 0');
  if (!MEASURES.includes(serviceMeasure)) return refuse('serviceMeasure', "must be 'cycle-service' (probability of no stockout in a replenishment cycle) or 'fill-rate' (fraction of demand met from stock)");
  e = fraction01('serviceLevel', serviceLevel);
  if (e) return e;
  if (orderQuantity === undefined && serviceMeasure === 'fill-rate') return refuse('orderQuantity', 'is required for a fill rate (units short are measured against the quantity each cycle brings)');
  if (orderQuantity !== undefined) { e = positive('orderQuantity', orderQuantity); if (e) return e; }
  if (!isObj(safetyFactorRounding) || (safetyFactorRounding.rule !== 'none' && safetyFactorRounding.rule !== 'nearest')) return refuse('safetyFactorRounding', "must be { rule: 'none' } or { rule: 'nearest', decimals } (a table read to that many decimals)");
  if (safetyFactorRounding.rule === 'none' && safetyFactorRounding.decimals !== undefined) return refuse('safetyFactorRounding.decimals', "must be left out when the rule is 'none'");
  if (safetyFactorRounding.rule === 'nearest' && !(Number.isInteger(safetyFactorRounding.decimals) && safetyFactorRounding.decimals >= 0 && safetyFactorRounding.decimals <= DEFAULTS.MAX_DECIMALS)) return refuse('safetyFactorRounding.decimals', `must be a whole number from 0 to ${DEFAULTS.MAX_DECIMALS}; got ${fmt(safetyFactorRounding.decimals)}`);
  if (minimumSafetyFactor !== null && !fin(minimumSafetyFactor)) return refuse('minimumSafetyFactor', `must be a stated number or null for no floor; got ${fmt(minimumSafetyFactor)}`);
  e = checkRounding(rounding, 'rounding');
  if (e) return e;
  const P = leadTime + reviewPeriod;
  const mu = demandMean * P;
  const sigma = Math.sqrt(P * demandSd * demandSd + demandMean * demandMean * leadTimeSd * leadTimeSd);
  if (!(sigma > 0) && serviceMeasure === 'fill-rate') return refuse('demandSd', 'and leadTimeSd are both 0, so demand over the protection period is certain and a fill rate sets no safety factor');
  const kExact = serviceMeasure === 'cycle-service' ? inverseNormal(serviceLevel) : solveLoss((orderQuantity * (1 - serviceLevel)) / sigma);
  const kRounded = safetyFactorRounding.rule === 'nearest' ? Number(kExact.toFixed(safetyFactorRounding.decimals)) : kExact;
  const floored = minimumSafetyFactor !== null && kRounded < minimumSafetyFactor;
  const k = floored ? minimumSafetyFactor : kRounded;
  const safety = k * sigma;
  const level = mu + safety;
  const levelRounded = roundTo(level, rounding);
  const kAchieved = sigma > 0 ? (levelRounded - mu) / sigma : null;
  const shortPerCycle = sigma > 0 ? sigma * unitNormalLoss(kAchieved) : Math.max(0, mu - levelRounded);
  const achievedCycleService = sigma > 0 ? normalCdf(kAchieved) : (levelRounded >= mu ? 1 : 0);
  const name = reviewPeriod > 0 ? 'order-up-to level S' : 'reorder point s';
  const target = serviceMeasure === 'cycle-service'
    ? `a cycle service level of ${fmt(serviceLevel)} gives k = Phi^-1(${fmt(serviceLevel)}) = ${dec(kExact)}`
    : `a fill rate of ${fmt(serviceLevel)} needs G(k) at or below ${fmt(orderQuantity)} x (1 - ${fmt(serviceLevel)}) / ${dec(sigma)} = ${dec((orderQuantity * (1 - serviceLevel)) / sigma)}, so k = ${dec(kExact)}`;
  let reason = `${target}${safetyFactorRounding.rule === 'nearest' ? `, read as ${fmt(kRounded)}` : ''}`;
  if (floored) reason += `; below the stated minimum ${fmt(minimumSafetyFactor)}, so k = ${fmt(minimumSafetyFactor)}`;
  reason += `; safety stock ${dec(safety)} over a demand of ${dec(mu)} with sigma ${dec(sigma)} gives the ${name} ${dec(level)}, held as ${dec(levelRounded)} (${roundingText(rounding)})`;
  return {
    policy: reviewPeriod > 0 ? 'periodic (R, S)' : 'continuous (s, Q)',
    protectionPeriod: P,
    demandOverProtection: mu,
    sigma,
    safetyFactorExact: kExact,
    safetyFactor: k,
    safetyStock: safety,
    level,
    levelRounded,
    achievedCycleService,
    expectedShortPerCycle: shortPerCycle,
    achievedFillRate: orderQuantity === undefined ? null : 1 - shortPerCycle / orderQuantity,
    reason,
    basis: {
      rule: 'sigma = sqrt(P sd_d^2 + d^2 sd_L^2) with P = leadTime + reviewPeriod; level = d P + k sigma; P1 = Phi(k); expected units short per cycle = sigma G(k), G(k) = phi(k) - k (1 - Phi(k)); P2 = 1 - sigma G(k) / Q',
      numerics: 'Phi^-1 by Wichura AS241; Phi through the regularised incomplete gamma (engines/hse/safetyStats.js); the fill-rate k by bisection to the last binary digit',
      source: CITE.normal,
    },
  };
};

// ---- Poisson demand (slow movers and spares) -------------------------------

const poissonMeanCheck = (demandRate, leadTime, reviewPeriod) => {
  if (demandRate * (leadTime + reviewPeriod) <= DEFAULTS.MAX_POISSON_MEAN) return null;
  const at = boundMax(DEFAULTS.MAX_POISSON_MEAN / demandRate - reviewPeriod, (v) => demandRate * (v + reviewPeriod) <= DEFAULTS.MAX_POISSON_MEAN);
  return refuse('leadTime', `must be at most ${at} so that the mean demand demandRate x ${reviewPeriod > 0 ? '(leadTime + reviewPeriod)' : 'leadTime'} is at most ${DEFAULTS.MAX_POISSON_MEAN}; above that the normal safetyStock serves; got ${fmt(leadTime)}`);
};

/**
 * Stock level for Poisson demand over the protection period P = leadTime +
 * reviewPeriod (mean m = demandRate x P). cycle-service: the smallest level s
 * with P(X <= s) at or above the service level, read as the probability of
 * no stockout over the lead time. fill-rate: the smallest s with the expected
 * units short E[(X - s)+] at or below orderQuantity x (1 - level).
 */
const poissonStockImpl = ({ demandRate, leadTime, reviewPeriod, serviceMeasure, serviceLevel, orderQuantity } = {}) => {
  let e = first(positive('demandRate', demandRate), nonNeg('leadTime', leadTime), nonNeg('reviewPeriod', reviewPeriod));
  if (e) return e;
  if (!(leadTime + reviewPeriod > 0)) return refuse('leadTime', 'and reviewPeriod add to 0; the protection period must be above 0');
  e = poissonMeanCheck(demandRate, leadTime, reviewPeriod);
  if (e) return e;
  if (!MEASURES.includes(serviceMeasure)) return refuse('serviceMeasure', "must be 'cycle-service' (probability of no stockout over the protection period) or 'fill-rate' (fraction of demand met from stock)");
  e = fraction01('serviceLevel', serviceLevel);
  if (e) return e;
  if (orderQuantity === undefined && serviceMeasure === 'fill-rate') return refuse('orderQuantity', 'is required for a fill rate (units short are measured against the quantity each cycle brings)');
  if (orderQuantity !== undefined) { e = positive('orderQuantity', orderQuantity); if (e) return e; }
  const m = demandRate * (leadTime + reviewPeriod);
  const limit = serviceMeasure === 'fill-rate' ? orderQuantity * (1 - serviceLevel) : null;
  const met = serviceMeasure === 'cycle-service'
    ? (row) => key12(row.cumulative) >= key12(serviceLevel)
    : (row) => key12(row.expectedShort) <= key12(limit);
  const rows = poissonRows(m, met);
  const chosen = rows[rows.length - 1];
  const s = chosen.s;
  const prev = s > 0 ? rows[s - 1] : null;
  const reason = serviceMeasure === 'cycle-service'
    ? `level ${s}: P(X <= ${s}) = ${dec(chosen.cumulative)} is at or above ${fmt(serviceLevel)}${prev ? `; at ${s - 1} it is ${dec(prev.cumulative)}` : ''} (Poisson mean ${dec(m)})`
    : `level ${s}: expected units short ${dec(chosen.expectedShort)} is at or below ${fmt(orderQuantity)} x (1 - ${fmt(serviceLevel)}) = ${dec(limit)}${prev ? `; at ${s - 1} it is ${dec(prev.expectedShort)}` : ''} (Poisson mean ${dec(m)})`;
  return {
    mean: m,
    level: s,
    safetyStock: s - m,
    rows,
    achievedCycleService: chosen.cumulative,
    expectedShortPerCycle: chosen.expectedShort,
    achievedFillRate: orderQuantity === undefined ? null : 1 - chosen.expectedShort / orderQuantity,
    reason,
    basis: {
      rule: 'X ~ Poisson(demandRate x (leadTime + reviewPeriod)); p(x) = p(x - 1) m / x from p(0) = exp(-m); F(s) = P(X <= s); L(0) = m, L(x + 1) = L(x) - (1 - F(x)) = E[(X - x - 1)+]; the smallest level meeting the target, compared at 12 significant digits',
      source: CITE.poisson,
    },
  };
};

// ---- insurance spares ------------------------------------------------------

/**
 * Insurance spares for an item that fails at a stated rate across its
 * installed population. Each failure takes a spare and places a replacement
 * order that arrives after the lead time (one for one), so the orders
 * outstanding at a random moment are Poisson with mean m = failuresPerYear x
 * leadTimeDays / daysPerYear. With n spares the expected number of failed
 * units waiting is E[(X - n)+]; each waiting unit costs downtimeCostPerDay.
 * Annual cost of n: holding n x unitCost x holdingRate plus expected downtime
 * E[(X - n)+] x daysPerYear x downtimeCostPerDay. The cheapest n in 0 to
 * maxSpares wins, ties to fewer spares.
 */
const insuranceSparesImpl = ({ failuresPerYear, leadTimeDays, daysPerYear, unitCost, holdingRate, downtimeCostPerDay, maxSpares } = {}) => {
  let e = first(positive('failuresPerYear', failuresPerYear), positive('leadTimeDays', leadTimeDays), positive('daysPerYear', daysPerYear),
    nonNeg('unitCost', unitCost), nonNeg('holdingRate', holdingRate), nonNeg('downtimeCostPerDay', downtimeCostPerDay));
  if (e) return e;
  if (!Number.isInteger(maxSpares) || maxSpares < 0 || maxSpares > DEFAULTS.MAX_SPARES) return refuse('maxSpares', `must be a whole number from 0 to ${DEFAULTS.MAX_SPARES}; got ${fmt(maxSpares)}`);
  const m = (failuresPerYear * leadTimeDays) / daysPerYear;
  if (m > DEFAULTS.MAX_POISSON_MEAN) {
    return refuse('leadTimeDays', `must be at most ${boundMax((DEFAULTS.MAX_POISSON_MEAN * daysPerYear) / failuresPerYear, (v) => (failuresPerYear * v) / daysPerYear <= DEFAULTS.MAX_POISSON_MEAN)} so that the mean number of orders outstanding is at most ${DEFAULTS.MAX_POISSON_MEAN}; got ${fmt(leadTimeDays)}`);
  }
  const rows = poissonRows(m, (row) => row.s >= maxSpares);
  const holdingPerSpare = unitCost * holdingRate;
  const options = rows.map((r) => {
    const holding = r.s * holdingPerSpare;
    const downtime = r.expectedShort * daysPerYear * downtimeCostPerDay;
    return {
      spares: r.s,
      probabilityNoShortage: r.cumulative,
      fillRate: r.s === 0 ? 0 : rows[r.s - 1].cumulative,
      expectedUnitsDown: r.expectedShort,
      holdingCost: holding,
      downtimeCost: downtime,
      totalCost: holding + downtime,
    };
  });
  let best = options[0];
  for (const o of options) if (key12(o.totalCost) < key12(best.totalCost)) best = o;
  const next = options[best.spares + 1];
  let reason = `${plural(best.spares, 'spare')}: holding ${money(best.holdingCost)} a year against expected downtime ${money(best.downtimeCost)}, total ${money(best.totalCost)}, the lowest for 0 to ${maxSpares}`;
  if (next) reason += `; one more spare adds ${money(holdingPerSpare)} of holding and saves ${money(best.downtimeCost - next.downtimeCost)} of downtime`;
  const atLimit = best.spares === maxSpares && maxSpares > 0;
  if (atLimit) reason += `; the search stopped at maxSpares ${maxSpares}, so a larger stock may cost less`;
  return {
    meanOutstanding: m,
    spares: best.spares,
    totalCost: best.totalCost,
    atSearchLimit: atLimit,
    options,
    reason,
    basis: {
      rule: 'orders outstanding X ~ Poisson(failuresPerYear x leadTimeDays / daysPerYear), one for one; expected units down E[(X - n)+]; annual cost n x unitCost x holdingRate + E[(X - n)+] x daysPerYear x downtimeCostPerDay; probability of no shortage P(X <= n); fill rate P(X <= n - 1), the chance a failure finds a spare',
      reading: 'each unit waiting for a spare is one unit down, costed at downtimeCostPerDay; the holding charge falls on all n spares bought',
      source: CITE.spares,
    },
  };
};

// ---- lead-time risk (Monte Carlo) ------------------------------------------

const checkTri = (d, field) => {
  if (fin(d)) return d >= 0 ? null : refuse(field, `must be at or above 0; got ${fmt(d)}`);
  if (!isObj(d) || !fin(d.min) || !fin(d.mode) || !fin(d.max)) return refuse(field, 'must be a number or a triangular distribution { min, mode, max } of finite numbers');
  if (d.min < 0) return refuse(`${field}.min`, `must be at or above 0; got ${fmt(d.min)}`);
  if (!(d.min <= d.mode && d.mode <= d.max)) return refuse(field, `must have min <= mode <= max; got min ${fmt(d.min)}, mode ${fmt(d.mode)}, max ${fmt(d.max)}`);
  return null;
};
const triOf = (d) => (fin(d) ? { min: d, mode: d, max: d } : d);
const varies = (d) => d.max > d.min;
const draw = (d, rng) => (varies(d) ? triInvCDF(rng(), d.min, d.mode, d.max) : d.mode);

/**
 * Lead-time risk sampled through lib/stats (mulberry32 + triangular inverse
 * CDF): per iteration a lead time in days, then a demand rate a day held for
 * that whole lead time; lead-time demand = rate x days. A stockout is a
 * lead-time demand above the reorder point (demand equal to the stock is
 * met). Reports the stockout probability, the expected units short per
 * cycle, P90/P50/P10 of the lead time and the lead-time demand, and, when a
 * serviceLevel is stated, the smallest sampled lead-time demand that at least
 * that share of draws does not exceed.
 */
const leadTimeRiskImpl = ({ demandPerDay, leadTimeDays, reorderPoint, serviceLevel, iterations, seed } = {}) => {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > DEFAULTS.MAX_ITERATIONS) return refuse('iterations', `must be a whole number from 1 to ${DEFAULTS.MAX_ITERATIONS}; got ${fmt(iterations)}`);
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) return refuse('seed', 'must be a whole number from 0 to 4294967295; it is required so that every run can be reproduced');
  let e = first(checkTri(leadTimeDays, 'leadTimeDays'), checkTri(demandPerDay, 'demandPerDay'), nonNeg('reorderPoint', reorderPoint));
  if (e) return e;
  if (serviceLevel !== undefined) { e = fraction01('serviceLevel', serviceLevel); if (e) return e; }
  const lt = triOf(leadTimeDays);
  const dd = triOf(demandPerDay);
  const rng = mulberry32(seed);
  const days = new Array(iterations);
  const ltd = new Array(iterations);
  const short = new Array(iterations);
  let outs = 0;
  for (let i = 0; i < iterations; i += 1) {
    const t = draw(lt, rng);
    const rate = draw(dd, rng);
    const x = rate * t;
    days[i] = t;
    ltd[i] = x;
    short[i] = x > reorderPoint ? x - reorderPoint : 0;
    if (x > reorderPoint) outs += 1;
  }
  const pick = (s) => ({ mean: s.mean, p90: s.p90, p50: s.p50, p10: s.p10, min: s.min, max: s.max });
  const ls = basicStats(days);
  const ds = basicStats(ltd);
  const p = outs / iterations;
  let reorderPointForService = null;
  if (serviceLevel !== undefined) {
    const sorted = ltd.slice().sort((a, b) => a - b);
    reorderPointForService = sorted[Math.max(0, Math.ceil(key12(serviceLevel * iterations)) - 1)];
  }
  return {
    leadTime: pick(ls),
    leadTimeDemand: pick(ds),
    probabilityOfStockout: p,
    cycleServiceLevel: 1 - p,
    expectedShortPerCycle: statMean(short),
    reorderPointForService,
    percentileDefinition: EXCEEDANCE_DEFINITION,
    reason: `${outs} of ${plural(iterations, 'draw')} have a lead-time demand above the reorder point ${fmt(reorderPoint)}: a stockout probability of ${dec(p)} a cycle`,
    basis: {
      sampling: `${plural(iterations, 'iteration')}, one mulberry32(${seed}) stream; per iteration a uniform for the lead time${varies(lt) ? '' : ' (constant: no draw)'} then one for the demand rate${varies(dd) ? '' : ' (constant: no draw)'}; triangular inverse CDF (lib/stats triInvCDF); the rate holds for the whole lead time`,
      percentiles: 'lib/stats basicStats on the sorted values: P90 = index floor(0.1 n), P50 = floor(0.5 n), P10 = floor(0.9 n). P-labels per lib/conventions/percentile.js: P90 means a 90% probability the actual quantity meets or exceeds the value, so for a lead time or a demand P90 is the LOW figure (10th percentile) and the stockout risk sits at the P10 end',
      service: serviceLevel === undefined ? 'no serviceLevel stated' : `reorderPointForService is the sorted lead-time demand at index ceil(${fmt(serviceLevel)} x n) - 1`,
    },
  };
};

// ---- slow-moving and obsolete stock ----------------------------------------

/**
 * Slow-moving and obsolete stock by stated bands of months since the last
 * issue: each band { label, minMonths, writeDownPct }, minMonths rising from
 * 0; an item takes the last band whose minMonths it has reached (at or
 * above). Write-down = onHand x unitCost x writeDownPct / 100. Cover (months
 * of stock) = onHand / monthlyUsage; stock above excessCoverMonths of cover
 * is excess (all of it when there is no usage).
 */
const slowMovingImpl = ({ items, bands, excessCoverMonths } = {}) => {
  if (!Array.isArray(bands) || bands.length < 1) return refuse('bands', 'must be an array of at least 1 band { label, minMonths, writeDownPct }');
  if (bands.length > DEFAULTS.MAX_BANDS) return refuse('bands', `has ${bands.length} entries; the cap is ${DEFAULTS.MAX_BANDS}`);
  const labels = new Set();
  for (let i = 0; i < bands.length; i += 1) {
    const b = bands[i];
    if (!isObj(b) || typeof b.label !== 'string' || b.label === '') return refuse(`bands[${i}].label`, 'must be a non-empty string');
    if (labels.has(b.label)) return refuse(`bands[${i}].label`, `repeats the label '${b.label}'`);
    labels.add(b.label);
    const e = nonNeg(`bands[${i}].minMonths`, b.minMonths);
    if (e) return e;
    if (i === 0 && b.minMonths !== 0) return refuse('bands[0].minMonths', `must be 0 so that every item takes a band; got ${fmt(b.minMonths)}`);
    if (i > 0 && !(b.minMonths > bands[i - 1].minMonths)) return refuse(`bands[${i}].minMonths`, `must be above the band before it (${fmt(bands[i - 1].minMonths)}); got ${fmt(b.minMonths)}`);
    if (!fin(b.writeDownPct) || b.writeDownPct < 0 || b.writeDownPct > 100) return refuse(`bands[${i}].writeDownPct`, `must be a number from 0 to 100; got ${fmt(b.writeDownPct)}`);
  }
  let e = positive('excessCoverMonths', excessCoverMonths);
  if (e) return e;
  e = checkList(items, 'items', DEFAULTS.MAX_ITEMS);
  if (e) return e;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    e = first(nonNeg(`items[${i}].onHand`, it.onHand), nonNeg(`items[${i}].unitCost`, it.unitCost), nonNeg(`items[${i}].monthsSinceLastIssue`, it.monthsSinceLastIssue), nonNeg(`items[${i}].monthlyUsage`, it.monthlyUsage));
    if (e) return e;
  }
  const out = items.map((it) => {
    let bi = 0;
    for (let i = 0; i < bands.length; i += 1) if (key12(it.monthsSinceLastIssue) >= key12(bands[i].minMonths)) bi = i;
    const b = bands[bi];
    const stockValue = it.onHand * it.unitCost;
    const writeDown = (stockValue * b.writeDownPct) / 100;
    const cover = it.monthlyUsage > 0 ? it.onHand / it.monthlyUsage : null;
    const excess = cover === null ? it.onHand > 0 : key12(cover) > key12(excessCoverMonths);
    const excessQuantity = it.monthlyUsage > 0 ? Math.max(0, it.onHand - excessCoverMonths * it.monthlyUsage) : it.onHand;
    let reason = `${it.id}: ${unit(fmt(it.monthsSinceLastIssue), it.monthsSinceLastIssue, 'month')} since the last issue is at or above ${fmt(b.minMonths)}, band ${b.label}${bi + 1 < bands.length ? ` (below ${fmt(bands[bi + 1].minMonths)})` : ''}, written down ${fmt(b.writeDownPct)}% of ${money(stockValue)} = ${money(writeDown)}`;
    reason += cover === null
      ? (it.onHand > 0 ? '; no usage, so all stock on hand is excess' : '; no usage and no stock')
      : `; cover ${unit(dec(cover), Number(dec(cover)), 'month')} ${excess ? `is above ${fmt(excessCoverMonths)}, excess ${unit(dec(excessQuantity), Number(dec(excessQuantity)), 'unit')}` : `is at or below ${fmt(excessCoverMonths)}`}`;
    return { id: it.id, band: b.label, stockValue, writeDownPct: b.writeDownPct, writeDown, coverMonths: cover, excess, excessQuantity, reason };
  });
  const byBand = Object.fromEntries(bands.map((b) => {
    const inB = out.filter((r) => r.band === b.label);
    return [b.label, { count: inB.length, stockValue: inB.reduce((s, r) => s + r.stockValue, 0), writeDown: inB.reduce((s, r) => s + r.writeDown, 0) }];
  }));
  return {
    items: out,
    byBand,
    totalStockValue: out.reduce((s, r) => s + r.stockValue, 0),
    totalWriteDown: out.reduce((s, r) => s + r.writeDown, 0),
    excessCount: out.filter((r) => r.excess).length,
    basis: {
      rule: `bands ${bands.map((x) => `${x.label} from ${unit(fmt(x.minMonths), x.minMonths, 'month')} (${fmt(x.writeDownPct)}%)`).join(', ')}, a band reached at or above its minimum; cover = onHand / monthlyUsage, excess above ${unit(fmt(excessCoverMonths), excessCoverMonths, 'month')}; compared at 12 significant digits`,
      source: 'the bands, write-down percentages and cover limit are the caller\'s stated policy; Caplice, MIT ESD.260J (2006) lecture 13 slide 13 (days of supply IOH / D to find dead stock)',
    },
  };
};

export const criticality = guard('criticality', criticalityImpl);
export const abcClassification = guard('abcClassification', abcImpl);
export const eoq = guard('eoq', eoqImpl);
export const quantityDiscount = guard('quantityDiscount', quantityDiscountImpl);
export const safetyStock = guard('safetyStock', safetyStockImpl);
export const poissonStock = guard('poissonStock', poissonStockImpl);
export const insuranceSpares = guard('insuranceSpares', insuranceSparesImpl);
export const leadTimeRisk = guard('leadTimeRisk', leadTimeRiskImpl);
export const slowMoving = guard('slowMoving', slowMovingImpl);
