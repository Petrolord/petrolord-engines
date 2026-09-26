// Timing of engines/economics/gasContract.js at app sizes (Economics EC8).
//
//   npx jest --testMatch '<rootDir>/tools/validation/economics/timing_gascontract.js'
//
// Run through jest because the engine imports npv, deriveGasRoyaltyRate and
// calendarDays from engines/economics/cashflow.ts (babel transforms it).
// Milliseconds per call, one run, machine dependent. Inputs are built from the
// Ekene GSA fixtures with seeded (lib/stats mulberry32) changes.
// FINDINGS-gasContract.md records a run and the caps it supports.
import fs from 'fs';
import path from 'path';
import { mulberry32 } from '../../../lib/stats/stats.js';
import * as T from '../../../engines/economics/gasContract.js';

const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test-data', 'economics', 'ekene-gsa', f), 'utf8'));
const PW = read('domestic-power.json');
const EX = read('export-feed.json');
const time = (f) => { const t = performance.now(); const r = f(); const ms = performance.now() - t; if (r && r.error) throw new Error(r.error); return ms; };

test('timing', () => {
  const rng = mulberry32(20270101);
  const rows = [['case', 'size', 'ms']];
  [30, 100].forEach((n) => {
    const years = Array.from({ length: n }, (_, i) => ({ year: 2027 + i, acq: 7665000, taken: Math.round(7665000 * (0.6 + 0.5 * rng())), contractPrice: 2.18, topPrice: 2.18, makeUpPrice: 0 }));
    rows.push(['takeOrPay with carry-forward', `${n} years`, time(() => T.takeOrPay({ years, topPct: 80, makeUp: { periodYears: 5, order: 'after-top-quantity', endOfTerm: 'refund' }, carryForward: { periodYears: 3, base: 'top-quantity', capPct: 50 } })).toFixed(2)]);
    rows.push(['gsaCashFlows', `${n} years`, time(() => T.gsaCashFlows({ contract: { years, topPct: 80, makeUp: { periodYears: 5, order: 'first', endOfTerm: 'forfeit' } }, royalty: { terrain: 'onshore' }, discountRate: 0.1, baseYear: 2026 })).toFixed(2)]);
  });
  const days = Array.from({ length: 366 }, (_, i) => {
    const d = new Date(Date.UTC(2028, 0, 1 + i)).toISOString().slice(0, 10);
    const nom = Math.round(21000 * (0.8 + 0.4 * rng()));
    return { date: d, nominated: nom, available: nom, taken: Math.round(nom * (0.9 + 0.1 * rng())) };
  });
  rows.push(['dailyBalance', '366 days', time(() => T.dailyBalance({ dcq: 21000, maxDcqPct: 110, days })).toFixed(2)]);
  const months = [];
  for (let i = 0; i < 1200; i += 1) months.push({ month: `${String(1950 + Math.floor(i / 12))}-${String((i % 12) + 1).padStart(2, '0')}`, values: { oil: 40 + 60 * rng(), fo: 300 + 200 * rng() } });
  const p = EX.price;
  rows.push(['priceSeries oil-indexed S-curve', '1,188 months priced', time(() => T.priceSeries({ months, formula: p.formula, from: '1951-01', to: '2049-12', averagingMonths: 6, lagMonths: 1, resetMonths: 3, rounding: 'model-gsa-4dp' })).toFixed(2)]);
  rows.push(['priceSeries basket', '1,188 months priced', time(() => T.priceSeries({ months, formula: { type: 'basket', basePrice: 5, weights: { oil: 0.5, fo: 0.5 }, baseValues: { oil: 70, fo: 400 } }, from: '1951-01', to: '2049-12', averagingMonths: 12, lagMonths: 1 })).toFixed(2)]);
  rows.push(['takeOrPay power fixture', '8 years', time(() => T.takeOrPay({ years: PW.years, topPct: PW.topPct, makeUp: PW.makeUp })).toFixed(2)]);
  console.log(rows.map((r) => `| ${r.join(' | ')} |`).join('\n'));
});
