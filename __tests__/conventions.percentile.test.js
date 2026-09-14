// Suite-wide percentile conventions (owner decision, 2026-09-09), moved here
// from the Suite's src/lib/percentileConventions.js so the Suite apps and the
// NextGen courses import ONE copy of the words. Ported from the Suite's
// percentileConventions.test.js: the words, and the P-label gate helper with
// its negative control. The Petrophysics type-well order gate stays in the
// Suite, because it runs the Suite's probabilistic petrophysics engine.
import {
  EXCEEDANCE_DEFINITION, OUTCOME_LABELS, OUTCOME_ORDER, P_LABELS, CASES,
  parameterPercentileLabel, casePercentile, caseLabel, caseOutcomeLabel, findPLabels, outcomeOrderViolation,
} from '../lib/conventions/percentile.js';

test('the words: definition sentence, outcome labels, case labels with the direction, parameter percentiles', () => {
  expect(EXCEEDANCE_DEFINITION).toBe('P90 means a 90% probability the actual quantity meets or exceeds this value, per SPE PRMS.');
  expect(OUTCOME_LABELS).toEqual({ p90: 'P90', p50: 'P50', p10: 'P10' });
  expect(OUTCOME_ORDER).toEqual(['p90', 'p50', 'p10']);
  expect(P_LABELS).toEqual(['P10', 'P50', 'P90']);
  expect(CASES.map((c) => c.label)).toEqual(['Low case', 'Best case', 'High case']);
  expect(caseOutcomeLabel('low')).toBe('P90');
  expect(caseOutcomeLabel('high')).toBe('P10');
  expect(parameterPercentileLabel('Sw', 'q90')).toBe('90th percentile of Sw');
  expect(parameterPercentileLabel('PHIE', 10)).toBe('10th percentile of PHIE');
  expect(parameterPercentileLabel(null, 'q50')).toBe('50th percentile');
  expect(casePercentile('low', false)).toBe('q90');
  expect(casePercentile('high', false)).toBe('q10');
  expect(casePercentile('low', true)).toBe('q10');
  expect(casePercentile('best', true)).toBe('q50');
  expect(caseLabel('low', 'Sw', false)).toBe('Low case Sw (high value)');
  expect(caseLabel('high', 'Sw', false)).toBe('High case Sw (low value)');
  expect(caseLabel('low', 'porosity', true)).toBe('Low case porosity (low value)');
  expect(caseLabel('best', 'Sw', false)).toBe('Best case Sw');
});

test('gate helper: findPLabels catches a P-label and ignores look-alikes (negative control)', () => {
  const clean = ['Sw', 'PHIE', 'breakeven price'].flatMap((qty) => ['q10', 'q50', 'q90'].map((k) => parameterPercentileLabel(qty, k)));
  expect(findPLabels(clean)).toEqual([]);
  expect(findPLabels(['Sw P90', 'ok', 'P10 of phi'])).toEqual(['Sw P90', 'P10 of phi']);
  expect(findPLabels(['SP90', 'P100'])).toEqual([]);
});

test('outcome order: P90 <= P50 <= P10, NaN tolerated, a violation named', () => {
  expect(outcomeOrderViolation({ p90: 4, p50: 5, p10: 6 }, 'x')).toBeNull();
  expect(outcomeOrderViolation({ p90: 5, p50: 4, p10: 6 }, 'x')).toMatch(/violated/);
  expect(outcomeOrderViolation({ p90: NaN, p50: 4, p10: 6 }, 'x')).toBeNull();
});
