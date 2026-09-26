// Timing of engines/economics/jointVenture.js at app sizes (Economics EC9).
//
//   npx jest --testMatch '<rootDir>/tools/validation/economics/timing_jointventure.js'
//
// Run through jest because the engine imports applyPSC and npv from
// engines/economics/cashflow.ts (babel transforms it). Milliseconds per call,
// one run, machine dependent. Inputs are built from the Ekene JV fixture with
// seeded (lib/stats mulberry32) changes. FINDINGS-jointVenture.md records a
// run and the caps it supports.
import fs from 'fs';
import path from 'path';
import { mulberry32 } from '../../../lib/stats/stats.js';
import * as J from '../../../engines/economics/jointVenture.js';

const FX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test-data', 'economics', 'ekene-jv', 'ekene-jv.json'), 'utf8'));
const time = (f) => { const t = performance.now(); const r = f(); const ms = performance.now() - t; if (r && r.error) throw new Error(r.error); return ms; };

test('timing', () => {
  const rng = mulberry32(20270101);
  const rows = [['case', 'size', 'ms']];
  const parties = Array.from({ length: 20 }, (_, i) => ({ id: `P${i}`, participatingPct: 5 }));
  const carries = [{ carried: 'P0', carriedPct: 100, carriers: 'pro-rata' }];
  [120, 600].forEach((n) => {
    const months = Array.from({ length: n }, (_, i) => {
      const f = Math.round(1e6 * (1 + 10 * rng()));
      return { month: `${2027 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, forecast: f, actual: Math.round(f * (0.85 + 0.3 * rng())) };
    });
    rows.push(['cashCalls, 20 parties', `${n} months`, time(() => J.cashCalls({ parties, carries, months, reconciliationLagMonths: 2, negativeCall: 'carry', noCallBelow: 1.5e6 })).toFixed(2)]);
  });
  [30, 100].forEach((n) => {
    const years = Array.from({ length: n }, (_, i) => ({ year: 2027 + i, cost: i < 5 ? 5e7 : 0, entitlement: i < 5 ? 0 : Math.round(1e8 * rng()) }));
    rows.push(['carryRecovery compound, 20 parties, NPV', `${n} years`, time(() => J.carryRecovery({ parties, carries, carried: 'P0', years, uplift: { type: 'compound', ratePctPerYear: 8 }, recoverFromPct: 50, basis: 'contract', discountRate: 0.1, baseYear: 2027 })).toFixed(2)]);
    const py = years.map((y) => ({ year: y.year, grossRevenue: y.entitlement * 2, capex: y.cost, opex: 1e7 }));
    rows.push(['pscCostRecovery, 20 parties, NPV', `${n} years`, time(() => J.pscCostRecovery({ years: py, royaltyPct: 12.5, costOilLimitPct: 60, costOilLimitBase: 'gross', contractorProfitSharePct: 60, taxRatePct: 30, openingCostPool: 0, parties, discountRate: 0.1, baseYear: 2027 })).toFixed(2)]);
    const ny = years.map((y) => ({ year: y.year, grossValue: y.entitlement, deductions: y.entitlement / 4 }));
    rows.push(['nonConsent, 10 non-consenting', `${n} years`, time(() => J.nonConsent({ parties, consenting: parties.slice(0, 10).map((p) => p.id), operation: { name: 'well', cost: 5e7 }, premiumMultiplePct: 400, mode: 'recover-from-production', years: ny })).toFixed(2)]);
  });
  rows.push(['budgetControl', '200 items', time(() => J.budgetControl({ items: Array.from({ length: 200 }, (_, i) => ({ item: `i${i}`, approved: 1e6, actual: Math.round(1.2e6 * rng()) })), itemTolerancePct: 10, budgetTolerance: { pct: 5, amount: 3e6 } })).toFixed(2)]);
  rows.push(['defaultCover, 19 defaulters, working days', '20 parties', time(() => J.defaultCover({ parties, callTotal: 1e7, dueDate: '2027-03-01', asOf: '2027-12-31', defaulters: parties.slice(1).map((p) => ({ id: p.id, paid: 0 })), interest: { annualRatePct: 8, dayBasis: 365 }, suspension: { after: 200, unit: 'working-days', from: '2027-03-01' } })).toFixed(2)]);
  rows.push(['Ekene fixture cash calls', '12 months', time(() => J.cashCalls({ parties: FX.parties, carries: FX.carries, ...FX.cashCalls, year: undefined })).toFixed(2)]);
  console.log(rows.map((r) => `| ${r.join(' | ')} |`).join('\n'));
});
