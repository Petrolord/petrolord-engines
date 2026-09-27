// Timing of engines/economics/farmout.js at app sizes (Economics EC10).
//
//   npx jest --testMatch '<rootDir>/tools/validation/economics/timing_farmout.js'
//
// Run through jest because the engine imports applyJV and npv from
// engines/economics/cashflow.ts (babel transforms it). Milliseconds per call,
// one run, machine dependent. Inputs are built from the Ekene farm-out fixture
// with seeded (lib/stats mulberry32) changes. FINDINGS-farmout.md records a
// run and the caps it supports.
import fs from 'fs';
import path from 'path';
import { mulberry32 } from '../../../lib/stats/stats.js';
import * as X from '../../../engines/economics/farmout.js';

const FX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test-data', 'economics', 'ekene-farmout', 'ekene-farmout.json'), 'utf8'));
const time = (f) => { const t = performance.now(); const r = f(); const ms = performance.now() - t; if (r && r.error) throw new Error(r.error); return ms; };

test('timing', () => {
  const rng = mulberry32(20271111);
  const rows = [['case', 'size', 'ms']];
  const base = { parties: FX.parties, farmor: FX.farmor, farminee: FX.farminee };
  rows.push(['dealValue, Ekene fixture', '17 years of flows', time(() => X.dealValue({ ...base, project: FX.project, deal: FX.deal })).toFixed(2)]);
  const flows = Array.from({ length: 100 }, (_, i) => ({ year: 2028 + i, net: Math.round((i < 3 ? -3e8 : 2e8) * rng()) }));
  rows.push(['dealValue, carry-amount cap', '100 years of flows', time(() => X.dealValue({ ...base, project: { ...FX.project, successValue: { cashFlows: flows, discountRate: 0.1, baseYear: 2027 } }, deal: { ...FX.deal, cap: { on: 'carry-amount', amount: 3e6 } } })).toFixed(2)]);
  const events = Array.from({ length: 20 }, (_, i) => ({ name: `well ${i + 1}`, grossCost: Math.round(3e7 * (1 + rng())), farmineePaysPct: 3.5 * (i + 1), earnedPct: 3, cap: { on: 'gross-cost', amount: 4e7, overrunRule: 'post-deal-interests' } }));
  rows.push(['earningObligation, drill-to-earn', '20 events', time(() => X.earningObligation({ ...base, events, vesting: 'per-event', eventsCompleted: 12, cashBonus: 1e6, pastCosts: { amount: 1e7, reimbursedPct: 30 } })).toFixed(2)]);
  const signals = Array.from({ length: 10 }, (_, i) => ({ label: `s${i}`, likelihoodsPct: [i === 0 ? 55 : 5, i === 9 ? 55 : 5] }));
  rows.push(['informationValue, farmor', '10 signals', time(() => X.informationValue({ ...base, project: FX.project, deal: FX.deal, side: 'farmor', information: { cost: 1e6, signals } })).toFixed(2)]);
  rows.push(['riskSharing, Ekene positions (3 holdings)', '20000 draws', time(() => X.riskSharing({ correlation: 0, seed: 1, iterations: 20000, positions: [{ name: 'a', holdings: [{ id: 'x', chanceOfSuccessPct: 25, successValue: 1.5e8, failCost: 2.8e7, successStdDev: 0 }] }, { name: 'b', holdings: [{ id: 'y', chanceOfSuccessPct: 25, successValue: 9e7, failCost: 1.2e7, successStdDev: 0 }, { id: 'c', chanceOfSuccessPct: 100, successValue: 5e6, failCost: 0, successStdDev: 0 }] }] })).toFixed(2)]);
  const holdings = Array.from({ length: 20 }, (_, i) => ({ id: `h${i}`, chanceOfSuccessPct: 25, successValue: 5e7, failCost: 1e7, successStdDev: 1e7 }));
  rows.push(['riskSharing at the work cap, 5 positions x 20 holdings', '5000 draws', time(() => X.riskSharing({ correlation: 0.3, seed: 1, iterations: 5000, positions: Array.from({ length: 5 }, (_, k) => ({ name: `p${k}`, holdings })) })).toFixed(2)]);
  rows.push(['developmentCarry, compound, NPV', '17 years', time(() => X.developmentCarry({ ...base, ...FX.developmentCarry })).toFixed(2)]);
  rows.push(['consentFee with payment', '1', time(() => X.consentFee(FX.consent)).toFixed(2)]);
  rows.push(['interestValue with reserves', '1', time(() => X.interestValue({ project: FX.project, ...FX.interestPrice })).toFixed(2)]);
  // eslint-disable-next-line no-console
  console.log(rows.map((r) => r.join(' | ')).join('\n'));
});
