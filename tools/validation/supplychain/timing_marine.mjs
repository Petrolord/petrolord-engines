// Timing of engines/supplychain/marineLogistics.js at app sizes and at the
// caps (Supply Chain SC4).
//
//   node tools/validation/supplychain/timing_marine.mjs
//
// Plain node (the engine is pure JavaScript and imports only lib/stats and
// lib/conventions). Milliseconds per call, one run, machine dependent. The
// Ekene fixture is the base; larger cases copy its installations and deck
// items. The FINDINGS text for marine records a run and the caps it supports.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as M from '../../../engines/supplychain/marineLogistics.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'test-data', 'supplychain', 'ekene-marine', 'marine.json'), 'utf8'));
const time = (f) => { const t = performance.now(); const r = f(); const ms = performance.now() - t; if (r && r.error) throw new Error(r.error); return ms; };

const installations = (n) => Array.from({ length: n }, (_, i) => {
  const x = FX.installations[i % FX.installations.length];
  return { id: `I${i}`, distanceFromBaseNm: x.distanceFromBaseNm, fieldHours: x.fieldHours, minVisits: x.minVisits, demand: x.demand };
});
const fleetArgs = (n) => ({
  vessel: FX.vessels.psv, products: FX.products, installations: installations(n), route: { mode: 'dedicated' }, portHours: FX.portHours,
  weather: { factor: FX.weather.factor, appliesTo: FX.weather.appliesTo }, fuelPricePerT: FX.fuelPricePerT,
  periodDays: FX.period.periodDays, vesselAvailableDays: FX.period.vesselAvailableDays, voyageRounding: 'up', vesselRounding: 'up',
});

const rows = [`node ${process.version}`];
[4, 50].forEach((n) => {
  const a = fleetArgs(n);
  const v = { ...a, installations: a.installations.map(({ id, distanceFromBaseNm, fieldHours, demand }) => ({ id, distanceFromBaseNm, fieldHours, cargo: demand })) };
  ['periodDays', 'vesselAvailableDays', 'voyageRounding', 'vesselRounding'].forEach((k) => delete v[k]);
  rows.push(`installations ${n}: voyagePlan ${time(() => M.voyagePlan(v)).toFixed(1)} ms, fleetSize ${time(() => M.fleetSize(a)).toFixed(1)} ms`);
});
[[4, 20000], [4, 200000], [50, 20000], [50, 40000]].forEach(([n, it]) => {
  const a = { ...fleetArgs(n), weather: { factor: FX.variability.weatherFactor, appliesTo: FX.weather.appliesTo }, demandFactor: FX.variability.demandFactor, plannedVessels: 2, iterations: it, seed: 1 };
  rows.push(`fleetVariability installations ${n} x ${it} iterations: ${time(() => M.fleetVariability(a)).toFixed(0)} ms`);
});
[[1, 1], [10, 20], [M.DEFAULTS.MAX_UNITS / 50, M.DEFAULTS.MAX_DECK_VOYAGES]].forEach(([mult, voyages]) => {
  const items = FX.deckItems.map((x) => ({ ...x, quantity: Math.min(M.DEFAULTS.MAX_QUANTITY, x.quantity * mult) }));
  let units = items.reduce((s, x) => s + x.quantity, 0);
  while (units > M.DEFAULTS.MAX_UNITS) { const x = items.find((y) => y.quantity > 1); x.quantity -= 1; units -= 1; }
  rows.push(`deckPlan ${units} units, ${voyages} voyages: FFD ${time(() => M.deckPlan({ deck: FX.deck, items, voyages, rule: 'first-fit-decreasing-area' })).toFixed(1)} ms`);
});
const { name, ...sb } = FX.shoreBase;
rows.push(`shoreBase Ekene M/M/c with target: ${time(() => M.shoreBase({ ...sb, model: 'M/M/c', targetMeanWaitHours: 0.5 })).toFixed(2)} ms`);
rows.push(`shoreBase 100 berths M/D/c, target search to the cap: ${time(() => M.shoreBase({ berths: 100, arrivalsPerDay: 2350, workingHoursPerDay: 24, service: { fixedHours: 1, lifts: 0, liftsPerHour: 1, bulkM3: 0, bulkM3PerHour: 1, concurrent: false }, model: 'M/D/c', targetMeanWaitHours: 0 })).toFixed(2)} ms`);
// eslint-disable-next-line no-console
console.log(rows.join('\n'));
