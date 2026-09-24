// Timing of engines/dataai/cluster.js at app sizes (Data & AI D3).
//
//   node tools/validation/dataai/timing_cluster.mjs [rows ...]
//
// Seeded synthetic facies logs (synthetic_wells.js syntheticFacies, four
// logs). Milliseconds per call, one run; machine dependent.
// FINDINGS-cluster.md records a run.
import { syntheticFacies } from './synthetic_wells.js';
import * as CL from '../../../engines/dataai/cluster.js';

const time = (f) => { const t = performance.now(); const r = f(); const ms = performance.now() - t; if (r && r.error) throw new Error(r.error); return [ms, r]; };
const f0 = (v) => v.toFixed(0);

const main = () => {
  const sizes = process.argv.slice(2).map(Number).filter(Boolean);
  const ns = sizes.length ? sizes : [10000, 50000];
  console.log(`node ${process.version}`);
  console.log(['n', 'pca', 'kmeans k5 nInit1', 'kmeans k5 nInit10', 'passes (best run)', 'elbow k1-8 nInit1', 'silhouette sample 5000', 'cart depth6', 'cart depth10', 'knn k5 (1,000 new)', 'match'].join(' | '));
  ns.forEach((n) => {
    const { X, facies } = syntheticFacies(n, 4);
    const [tP] = time(() => CL.pca({ X }));
    const [tK1] = time(() => CL.kmeans({ X, k: 5, seed: 1, nInit: 1 }));
    const [tK, km] = time(() => CL.kmeans({ X, k: 5, seed: 1 }));
    const [tE] = time(() => CL.elbow({ X, kMax: 8, seed: 1, nInit: 1 }));
    const [tS] = time(() => CL.silhouette({ X, labels: km.labels, sampleSize: 5000, seed: 1 }));
    const [tC] = time(() => CL.cartFit({ X, y: facies, maxDepth: 6 }));
    const [tC10] = time(() => CL.cartFit({ X, y: facies, maxDepth: 10 }));
    const [tN] = time(() => CL.knnClassify({ X, y: facies, Xnew: X.slice(0, 1000), k: 5 }));
    const [tM] = time(() => CL.matchClusters({ yTrue: facies, clusters: km.labels, mode: 'majority' }));
    console.log([n, f0(tP), f0(tK1), f0(tK), km.iterations, f0(tE), f0(tS), f0(tC), f0(tC10), f0(tN), f0(tM)].join(' | '));
  });
  console.log('agglomerative (rows | ward | complete | average | silhouette full)');
  [1000, 2000, 3000].forEach((n) => {
    const { X } = syntheticFacies(n, 4);
    const r = ['ward', 'complete', 'average'].map((linkage) => f0(time(() => CL.agglomerative({ X, linkage, k: 4 }))[0]));
    const km = CL.kmeans({ X, k: 4, seed: 1, nInit: 1 });
    console.log([n, ...r, f0(time(() => CL.silhouette({ X, labels: km.labels }))[0])].join(' | '));
  });
  const { X, facies } = syntheticFacies(10000, 4);
  const km = CL.kmeans({ X, k: 4, seed: 1, nInit: 1 });
  console.log(`silhouette full at 10,000 rows: ${f0(time(() => CL.silhouette({ X, labels: km.labels }))[0])} ms; knn 10,000 x 10,000: ${f0(time(() => CL.knnClassify({ X, y: facies, Xnew: X, k: 5 }))[0])} ms`);
};

if (import.meta.url === `file://${process.argv[1]}`) main();
