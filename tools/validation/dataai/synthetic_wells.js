// Seeded synthetic well data for the ml.js scale checks (Data & AI D2).
// mulberry32 from lib/stats, Box-Muller normals. Wells of 500 rows; p
// features on three magnitudes (1, 10, 100) with 30 percent scatter; a
// per-well offset; a continuous target and an overlapping binary label.
// `separatedLabel` is 1 exactly when feature 1 is above 1, a complete
// separation. Used by __tests__/dataai.ml.test.js and timing_ml.mjs.
import { mulberry32 } from '../../../lib/stats/stats.js';

export const syntheticWells = (n, p, seed = 20260924) => {
  const rng = mulberry32(seed);
  const gauss = () => { const u = 1 - rng(); const v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const X = []; const y = []; const label = []; const separatedLabel = []; const groups = [];
  let off = 0;
  for (let i = 0; i < n; i += 1) {
    if (i % 500 === 0) off = 0.3 * gauss();
    const row = [];
    for (let j = 0; j < p; j += 1) row.push(10 ** (j % 3) * (1 + 0.3 * gauss()));
    const z = row.reduce((a, v, j) => a + ((j % 2 ? -1 : 1) * v) / 10 ** (j % 3), 0) / p;
    X.push(row);
    y.push(z + off + 0.2 * gauss());
    label.push(z + off + 0.5 * gauss() > 0 ? 1 : 0);
    separatedLabel.push(row[0] > 1 ? 1 : 0);
    groups.push(`W${String(Math.floor(i / 500)).padStart(4, '0')}`);
  }
  return { X, y, label, separatedLabel, groups };
};

// Seeded synthetic facies logs for the cluster.js scale checks (Data & AI
// D3). Four facies (sandstone, shaly sand, shale, limestone) in blocky runs
// (a facies holds with probability 0.8 per row); GR, RHOB, NPHI and PEF
// drawn from per-facies normals; wells of 500 rows. Used by
// __tests__/dataai.cluster.test.js and timing_cluster.mjs.
const FACIES = [
  ['sandstone', [45, 9], [2.33, 0.04], [0.20, 0.025], [1.9, 0.2]],
  ['shaly_sand', [78, 10], [2.42, 0.04], [0.25, 0.03], [2.6, 0.25]],
  ['shale', [118, 12], [2.52, 0.04], [0.33, 0.03], [3.2, 0.25]],
  ['limestone', [28, 7], [2.64, 0.035], [0.07, 0.02], [4.9, 0.3]],
];

export const syntheticFacies = (n, p = 4, seed = 20260924) => {
  const rng = mulberry32(seed);
  const gauss = () => { const u = 1 - rng(); const v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const X = []; const facies = []; const groups = [];
  let f = 0;
  for (let i = 0; i < n; i += 1) {
    if (i % 500 === 0 || rng() > 0.8) f = Math.floor(rng() * FACIES.length);
    const spec = FACIES[f];
    const row = [];
    for (let j = 0; j < p; j += 1) { const [m, s] = spec[1 + (j % 4)]; row.push(m + s * gauss()); }
    X.push(row);
    facies.push(spec[0]);
    groups.push(`W${String(Math.floor(i / 500)).padStart(4, '0')}`);
  }
  return { X, facies, groups };
};
