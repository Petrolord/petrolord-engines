// A clamped triangular fit writes a note, and the Probabilistic Breakeven
// Analyzer appends that note to the insight it shows. The note used to say
// "too near the P10" and "too near the P90", which put a P-label on a
// PARAMETER on screen, against the Suite percentile convention
// (lib/conventions/percentile.js). Found by the EC3 teaching digest after the
// EC3-0 relabel, whose gate only ran exact fits.
import fs from 'fs';
import path from 'path';
import { fitTriangularToPercentiles } from '../lib/stats/stats.js';
import { generateBreakevenData } from '../engines/economics/breakeven.js';
import { findPLabels, P_LABEL_RE } from '../lib/conventions/percentile.js';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'economics', 'goldens', 'breakeven_cases.json'), 'utf8',
));

test('both clamp notes use percentile words and carry no P-label', () => {
  const left = fitTriangularToPercentiles(0, 1, 100);
  const right = fitTriangularToPercentiles(0, 99, 100);
  expect(left.exact).toBe(false);
  expect(right.exact).toBe(false);
  expect(left.note).toMatch(/too near the 10th percentile/);
  expect(right.note).toMatch(/too near the 90th percentile/);
  expect(findPLabels([left.note, right.note])).toEqual([]);
});

test('the breakeven insight on a doubly clamped case carries no P-label (negative control included)', () => {
  const c = G.monteCarlo.find((x) => x.id === 'mc_inexact_fit_note');
  const r = generateBreakevenData(c.inputs);
  expect(r.distributionFits.capex.exact).toBe(false);
  expect(r.distributionFits.opex.exact).toBe(false);
  expect(r.insights).toMatch(/capex: the stated median sits too near the 10th percentile/);
  expect(r.insights).toMatch(/opex: the stated median sits too near the 90th percentile/);
  expect(P_LABEL_RE.test(r.insights)).toBe(false);
  // The gate would have caught the old wording.
  expect(findPLabels([r.insights.replace('10th percentile', 'P10')])).toHaveLength(1);
});
