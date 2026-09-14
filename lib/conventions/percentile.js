// Suite-wide percentile conventions (owner decision, 2026-09-09).
//
// Petrolord uses ONE meaning of a P-label across every app: the probability
// of exceedance of a hydrocarbon OUTCOME, as SPE PRMS and the SEC define it.
// P90 is the low estimate, P50 the best, P10 the high, always. Parameters
// never carry a P-label, because the exceedance convention is only
// unambiguous where more is better, and Sw is where it breaks: the low
// case of Sw is the HIGH Sw value.
//
// Every app (Petrophysics Studio, Volumetrics, anything that follows)
// imports these strings rather than retyping them, and two jest gates
// (percentileConventions.test.js) fail the build if a P-label lands on a
// parameter output or an outcome's cases are out of order.

/** The sentence recorded with every published probabilistic outcome. */
export const EXCEEDANCE_DEFINITION = 'P90 means a 90% probability the actual quantity meets or exceeds this value, per SPE PRMS.';

/** Outcome labels under the exceedance meaning, low to high. */
export const OUTCOME_LABELS = Object.freeze({ p90: 'P90', p50: 'P50', p10: 'P10' });
/** Order in which outcome cases are shown and must be sorted: low, best, high. */
export const OUTCOME_ORDER = Object.freeze(['p90', 'p50', 'p10']);
/** The strings that must never appear on a parameter output. */
export const P_LABELS = Object.freeze(['P10', 'P50', 'P90']);
export const P_LABEL_RE = /\bP(10|50|90)\b/;

/** Parameter percentile keys, low to high value. */
export const PARAMETER_PERCENTILES = Object.freeze({ q10: 10, q50: 50, q90: 90 });
export const PARAMETER_ORDER = Object.freeze(['q10', 'q50', 'q90']);

const ordinal = (n) => `${n}th`;

/** "90th percentile of Sw" (a parameter statistic; never a P-label). */
export function parameterPercentileLabel(quantity, key) {
  const pct = typeof key === 'number' ? key : PARAMETER_PERCENTILES[key];
  if (!pct) throw new Error(`parameterPercentileLabel: unknown percentile ${key}`);
  return `${ordinal(pct)} percentile${quantity ? ` of ${quantity}` : ''}`;
}

/** Outcome-linked cases, defined by the hydrocarbon outcome. */
export const CASES = Object.freeze([
  { key: 'low', label: 'Low case', outcome: 'p90' },
  { key: 'best', label: 'Best case', outcome: 'p50' },
  { key: 'high', label: 'High case', outcome: 'p10' },
]);

/**
 * Which parameter percentile a case takes for a quantity, given whether
 * more of that quantity helps the hydrocarbon outcome. Sw hurts, so the low
 * case takes its 90th percentile; porosity helps, so the low case takes
 * its 10th.
 * @param {'low'|'best'|'high'} caseKey
 * @param {boolean} moreIsBetter
 * @returns {'q10'|'q50'|'q90'}
 */
export function casePercentile(caseKey, moreIsBetter) {
  if (caseKey === 'best') return 'q50';
  const low = caseKey === 'low';
  return (low === !!moreIsBetter) ? 'q10' : 'q90';
}

/** "Low case Sw (high value)": the direction is in the header so nobody has to remember the rule. */
export function caseLabel(caseKey, quantity, moreIsBetter) {
  const c = CASES.find((x) => x.key === caseKey);
  if (!c) throw new Error(`caseLabel: unknown case ${caseKey}`);
  if (caseKey === 'best') return `${c.label}${quantity ? ` ${quantity}` : ''}`;
  const pct = casePercentile(caseKey, moreIsBetter);
  const dir = pct === 'q10' ? 'low value' : 'high value';
  return `${c.label}${quantity ? ` ${quantity}` : ''} (${dir})`;
}

/** Outcome label for a case key: Low case -> P90. */
export const caseOutcomeLabel = (caseKey) => OUTCOME_LABELS[CASES.find((x) => x.key === caseKey)?.outcome];

/**
 * Gate helper: every string that describes a PARAMETER output must be free
 * of P-labels. Returns the offending strings (empty when compliant).
 */
export function findPLabels(strings) {
  return (strings || []).filter((s) => typeof s === 'string' && P_LABEL_RE.test(s));
}

/**
 * Gate helper: an outcome case set {p90, p50, p10} must satisfy
 * p90 <= p50 <= p10 (NaN entries are skipped). Returns null when in order,
 * else a message naming the violation.
 */
export function outcomeOrderViolation(cases, name = 'outcome') {
  if (!cases) return null;
  const vals = OUTCOME_ORDER.map((k) => cases[k]).filter((v) => Number.isFinite(v));
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] < vals[i - 1]) return `${name}: P90 <= P50 <= P10 violated (${OUTCOME_ORDER.map((k) => `${OUTCOME_LABELS[k]}=${cases[k]}`).join(', ')})`;
  }
  return null;
}
