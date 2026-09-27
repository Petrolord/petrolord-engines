// Timing of engines/supplychain/inventory.js at app sizes (Supply Chain SC3).
//
//   npx jest --testMatch '<rootDir>/tools/validation/supplychain/timing_inventory.js'
//
// Run through jest like the other supply-chain timings. Milliseconds per
// call, one run, machine dependent. Registers are built by copying the
// synthetic Ekene items with seeded (mulberry32) changes. The stated caps:
// 5,000 items (criticality, ABC, slow-moving), 20 price breaks, a Poisson
// mean of 500, 1,000 spares searched, 200,000 Monte Carlo iterations.
// FINDINGS-inventory.md records a run and the caps it supports.
import fs from 'fs';
import path from 'path';
import { mulberry32 } from '../../../lib/stats/stats.js';
import * as I from '../../../engines/supplychain/inventory.js';

const REG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test-data', 'supplychain', 'ekene-materials', 'register.json'), 'utf8'));
const time = (f) => { const t = performance.now(); const r = f(); const ms = performance.now() - t; if (r && r.error) throw new Error(r.error); return ms; };

const itemsOf = (n) => {
  const rng = mulberry32(20270301);
  return Array.from({ length: n }, (_, i) => {
    const b = REG.items[i % REG.items.length];
    const f = 0.5 + rng();
    return { ...b, id: `${b.id}-${i}`, annualUsage: b.annualUsage * f, unitCost: b.unitCost * (0.5 + rng()), onHand: Math.round(b.onHand * f), monthsSinceLastIssue: Math.floor(48 * rng()) };
  });
};

test('timing', () => {
  const P = REG.policy;
  const rows = [['items', 'criticality ms', 'abcClassification ms', 'slowMoving ms']];
  [18, 500, 5000].forEach((n) => {
    const it = itemsOf(n);
    const c = time(() => I.criticality({ ...P.criticality, items: it.map(({ id, scores }) => ({ id, scores })) }));
    const a = time(() => I.abcClassification({ items: it.map(({ id, annualUsage, unitCost }) => ({ id, annualUsage, unitCost })), ...P.abc }));
    const s = time(() => I.slowMoving({ items: it.map(({ id, onHand, unitCost, monthsSinceLastIssue, monthlyUsage }) => ({ id, onHand, unitCost, monthsSinceLastIssue, monthlyUsage })), ...P.slowMoving }));
    rows.push([n, c.toFixed(1), a.toFixed(1), s.toFixed(1)]);
  });
  const breaks = Array.from({ length: 20 }, (_, i) => ({ minQuantity: i * 50, unitPrice: 100 - 2 * i }));
  const qd = ['all-units', 'incremental'].map((t) => time(() => I.quantityDiscount({ annualDemand: 20000, orderCost: 900, holdingRate: 0.2, breaks, discountType: t, rounding: { rule: 'nearest', multiple: 1 } })).toFixed(1));
  const ss = time(() => I.safetyStock({ demandMean: 250, demandSd: 182.5, leadTime: 2, leadTimeSd: 0.4, reviewPeriod: 0, serviceMeasure: 'fill-rate', serviceLevel: 0.999, orderQuantity: 228, safetyFactorRounding: { rule: 'none' }, minimumSafetyFactor: null, rounding: { rule: 'up', multiple: 1 } })).toFixed(2);
  const ps = time(() => I.poissonStock({ demandRate: 5, leadTime: 100, reviewPeriod: 0, serviceMeasure: 'cycle-service', serviceLevel: 0.999999 })).toFixed(2);
  const ins = time(() => I.insuranceSpares({ failuresPerYear: 365, leadTimeDays: 500, daysPerYear: 365, unitCost: 1000, holdingRate: 0.2, downtimeCostPerDay: 50, maxSpares: 1000 })).toFixed(2);
  const mc = [['iterations', 'leadTimeRisk ms']];
  const lr = { ...REG.cases.leadTimeRisk };
  delete lr.item;
  [2000, 20000, 200000].forEach((n) => mc.push([n, time(() => I.leadTimeRisk({ ...lr, iterations: n })).toFixed(0)]));
  // eslint-disable-next-line no-console
  console.log([`node ${process.version}`].concat(rows.map((r) => r.join(' | ')),
    `quantityDiscount 20 breaks: all-units ${qd[0]} ms, incremental ${qd[1]} ms`,
    `safetyStock fill rate 0.999: ${ss} ms; poissonStock mean 500 at 0.999999: ${ps} ms; insuranceSpares mean 500, 1,000 spares: ${ins} ms`,
    mc.map((r) => r.join(' | '))).join('\n'));
});
