// Timing of engines/dataai/ml.js at app sizes (Data & AI D2).
//
//   node tools/validation/dataai/timing_ml.mjs [rows ...]
//
// Seeded synthetic well data (synthetic_wells.js). Prints one row per
// (n, p) with the wall time of each call in milliseconds, for overlapping
// labels and for a completely separated label. Timings are
// machine dependent; FINDINGS-ml.md records a run.
import { syntheticWells } from './synthetic_wells.js';
import * as ML from '../../../engines/dataai/ml.js';

const time = (f) => { const t = performance.now(); const r = f(); const ms = performance.now() - t; if (r && r.error) throw new Error(r.error); return [ms, r]; };

const main = () => {
  const sizes = process.argv.slice(2).map(Number).filter(Boolean);
  const ns = sizes.length ? sizes : [10000, 50000, 200000];
  const cols = ['n', 'p', 'ols', 'ridge', 'logistic', 'logistic l2=1', 'lp pivots', 'newton its', 'groupKFold k5', 'permImp ols r2 x5', 'permImp logistic auc x5', 'rocCurve', 'minmax', 'separated: refusal', 'separated l2=1', 'sep lp pivots'];
  console.log(`node ${process.version}`);
  console.log(cols.join(' | '));
  ns.forEach((n) => [3, 8].forEach((p) => {
    const { X, y, label, groups } = syntheticWells(n, p);
    const [tOls, mOls] = time(() => ML.ols({ X, y }));
    const [tRidge] = time(() => ML.ridge({ X, y, lambda: 1 }));
    const [tLog, mLog] = time(() => ML.logistic({ X, y: label }));
    const [tLog2] = time(() => ML.logistic({ X, y: label, l2: 1 }));
    const [tK] = time(() => ML.groupKFold({ groups, k: 5, seed: 1 }));
    const [tPi] = time(() => ML.permutationImportance({ model: mOls, X, y, metric: 'r2', nRepeats: 5, seed: 1 }));
    const [tPl] = time(() => ML.permutationImportance({ model: mLog, X, y: label, metric: 'auc', nRepeats: 5, seed: 1 }));
    const [tRoc] = time(() => ML.rocCurve({ yTrue: label, scores: mLog.probabilities }));
    const [tMm] = time(() => ML.fitMinMaxScaler({ X }));
    const { separatedLabel } = syntheticWells(n, p);
    const t0 = performance.now(); const sep = ML.logistic({ X, y: separatedLabel }); const tSep = performance.now() - t0;
    if (!sep.error) throw new Error('separated label was not refused');
    const [tSep2, mSep2] = time(() => ML.logistic({ X, y: separatedLabel, l2: 1 }));
    const f = (v) => v.toFixed(0);
    console.log([n, p, f(tOls), f(tRidge), f(tLog), f(tLog2), mLog.separation.lpPivots, mLog.iterations, f(tK), f(tPi), f(tPl), f(tRoc), f(tMm), f(tSep), f(tSep2), mSep2.separation.lpPivots].join(' | '));
  }));
};

if (import.meta.url === `file://${process.argv[1]}`) main();
