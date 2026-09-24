// Timing of engines/dataai/forecast.js at app sizes (Data & AI D4).
//
//   node tools/validation/dataai/timing_forecast.mjs
//
// Seeded Ekene synthetic production (synthetic_wells.js
// syntheticProduction). Milliseconds per call, one run; machine dependent.
// FINDINGS-forecast.md records a run.
import { syntheticProduction } from './synthetic_wells.js';
import * as FC from '../../../engines/dataai/forecast.js';

const time = (f) => { const t = performance.now(); const r = f(); const ms = performance.now() - t; if (r && r.error) throw new Error(r.error); return [ms, r]; };
const f0 = (v) => v.toFixed(0);

const main = () => {
  console.log(`node ${process.version}`);
  console.log(['points', 'method', 'fit', 'evaluations', 'backtest refit (origins)', 'backtest held', 'intervals h12 x1000'].join(' | '));
  [600, 5000].forEach((n) => {
    const y = syntheticProduction(1, n, 11)[0].rate;
    const first = Math.floor(n * 0.8);
    ['ses', 'holt', 'damped'].forEach((method) => {
      const [tF, fit] = time(() => FC.fitSmoothing({ y, method, h: 12 }));
      const [tB, bt] = time(() => FC.backtest({ y, method, firstOrigin: first, horizon: 12, step: Math.max(1, Math.floor(n / 100)) }));
      const [tH] = time(() => FC.backtest({ y, method, firstOrigin: first, horizon: 12, step: Math.max(1, Math.floor(n / 100)), refit: false }));
      const [tI] = time(() => FC.forecastIntervals({ y, method, h: 12, seed: 1 }));
      console.log([n, method, f0(tF), fit.optimiser.evaluations, `${f0(tB)} (${bt.origins.length})`, f0(tH), f0(tI)].join(' | '));
    });
  });
  const wells = syntheticProduction(200, 120);
  const [tAll] = time(() => { wells.forEach((w) => ['ses', 'holt', 'damped'].forEach((method) => FC.fitSmoothing({ y: w.rate, method, h: 24 }))); return null; });
  const [tCmp] = time(() => { wells.forEach((w) => FC.compareWithArps({ y: w.rate, firstOrigin: 96, horizon: 12, step: 6 })); return null; });
  const [tPi] = time(() => { wells.forEach((w) => FC.forecastIntervals({ y: w.rate, method: 'damped', h: 24, seed: 1 })); return null; });
  console.log(`200 wells x 120 months: fit ses+holt+damped (h 24) ${f0(tAll)} ms; compareWithArps (origins 96, 102, 108; horizon 12) ${f0(tCmp)} ms; damped intervals h 24 x 1000 paths ${f0(tPi)} ms`);
};

if (import.meta.url === `file://${process.argv[1]}`) main();
