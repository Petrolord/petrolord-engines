// Timing of engines/economics/prms.js at app sizes (Economics EC11).
//
//   npx jest --testMatch '<rootDir>/tools/validation/economics/timing_prms.js'
//
// Run through jest because the engine imports computeCashFlow and applyJV
// from engines/economics/cashflow.ts (babel transforms it). Milliseconds per
// call, one run, machine dependent. Inputs are built from the Ekene PRMS
// fixture with seeded (lib/stats mulberry32) changes. FINDINGS-prms.md
// records a run and the caps it supports.
import fs from 'fs';
import path from 'path';
import { mulberry32 } from '../../../lib/stats/stats.js';
import * as X from '../../../engines/economics/prms.js';

const FX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test-data', 'economics', 'ekene-prms', 'ekene-prms.json'), 'utf8'));
const time = (f) => { const t = performance.now(); const r = f(); const ms = performance.now() - t; if (r && r.error) throw new Error(r.error); return ms; };

test('timing', () => {
  const rng = mulberry32(20271112);
  const rows = [['case', 'size', 'ms']];
  rows.push(['classify, Ekene projects', '8 projects', time(() => { FX.projects.forEach((p) => X.classify(p.args)); return null; }).toFixed(2)]);
  rows.push(['economicLimit, Ekene fixture', '3 cases x 15 years (6 cash-flow runs)', time(() => X.economicLimit(FX.economicLimit)).toFixed(2)]);
  const Y = 100;
  const f = (q0, keep) => Array.from({ length: Y }, (_, i) => ({ year: 2027 + i, oil: Math.round(q0 * keep ** i), gas: Math.round(0.8 * q0 * keep ** i) }));
  const long = {
    ...FX.economicLimit,
    forecasts: { low: f(2e6, 0.96), best: f(3e6, 0.965), high: f(3.6e6, 0.97) },
    prices: Array.from({ length: Y }, (_, i) => ({ year: 2027 + i, oil: 65, gas: 2.5 })),
    costs: { ...FX.economicLimit.costs, opex: Array.from({ length: Y }, (_, i) => ({ year: 2027 + i, amount: 3e6 })) },
    licence: { expiryYear: 2300, renewalExpected: false },
  };
  rows.push(['economicLimit, the year cap', '3 cases x 100 years', time(() => X.economicLimit(long)).toFixed(2)]);
  rows.push(['aggregate, Ekene reserves', '3 projects x 20000 iterations', time(() => X.aggregate(FX.aggregation.reserves)).toFixed(2)]);
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, distribution: { type: 'lognormal', mean: 5 + 10 * rng(), stdDev: 1 + 2 * rng() } }));
  rows.push(['aggregate at the work cap', '50 projects x 10000 iterations, uniform 0.3', time(() => X.aggregate({ resourceClass: 'reserves', level: 'field', unit: 'MMbbl', seed: 1, iterations: 10000, correlation: { type: 'uniform', rho: 0.3 }, projects: many })).toFixed(2)]);
  const two = many.slice(0, 2);
  rows.push(['aggregate at the iteration cap', '2 projects x 200000 iterations', time(() => X.aggregate({ resourceClass: 'reserves', level: 'field', unit: 'MMbbl', seed: 1, iterations: 200000, correlation: { type: 'uniform', rho: 0 }, projects: two })).toFixed(2)]);
  const moves = Array.from({ length: 50 }, (_, i) => ({ type: 'revisions', low: 0.01 * i, best: 0.02 * i, high: 0.03 * i }));
  rows.push(['reconcile at the movement cap', '50 movements', time(() => X.reconcile({ ...FX.reconciliation, movements: moves })).toFixed(2)]);
  // eslint-disable-next-line no-console
  console.log(rows.map((r) => r.join(' | ')).join('\n'));
});
