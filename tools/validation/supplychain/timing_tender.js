// Timing of engines/supplychain/tender.js at app sizes (Supply Chain SC2).
//
//   npx jest --testMatch '<rootDir>/tools/validation/supplychain/timing_tender.js'
//
// Run through jest because the engine imports the canonical npv from
// engines/economics/cashflow.ts (babel transforms it). Milliseconds per call,
// one run, machine dependent. Synthetic tenders are built by copying the
// Ekene well-services bids with seeded (mulberry32) price and score changes.
// FINDINGS-tender.md records a run and the caps it supports.
import fs from 'fs';
import path from 'path';
import { mulberry32 } from '../../../lib/stats/stats.js';
import * as T from '../../../engines/supplychain/tender.js';

const WS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'test-data', 'supplychain', 'ekene-tender', 'well-services.json'), 'utf8'));
const time = (f) => { const t = performance.now(); const r = f(); const ms = performance.now() - t; if (r && r.error) throw new Error(r.error); return ms; };

const tenderOf = (nBids, nLines) => {
  const rng = mulberry32(20270211);
  const base = WS.bids.filter((b) => b.id !== 'WS6');
  return Array.from({ length: nBids }, (_, i) => {
    const b = base[i % base.length];
    const lines = Array.from({ length: nLines }, (_, j) => {
      const l = b.lines[j % b.lines.length];
      const f = 0.8 + 0.4 * rng();
      return { id: `${l.id}-${j}`, quantity: l.quantity, unitRate: l.unitRate * f, quotedAmount: l.quantity * l.unitRate * f };
    });
    return {
      id: `B${String(i).padStart(3, '0')}`, receivedAt: b.receivedAt, mandatory: b.mandatory,
      scores: Object.fromEntries(Object.keys(b.scores).map((k) => [k, Math.min(4, Math.max(3, b.scores[k]))])),
      lines, completionWeeks: b.completionWeeks,
    };
  });
};

test('timing', () => {
  const rows = [['bids', 'lines/bid', 'evaluateTender combined ms', 'evaluateTender lowest ms']];
  [[6, 6], [20, 100], [100, 100], [100, 1000]].forEach(([n, l]) => {
    const bids = tenderOf(n, l);
    const common = { criteria: WS.criteria.map(({ id, weight, maxScore }) => ({ id, weight, maxScore })), passMark: 70, bids, omissionRule: 'average', schedule: WS.schedule };
    const tc = time(() => T.evaluateTender({ ...common, award: 'combined', technicalWeight: 0.7, priceMethod: 'lowest-ratio', technicalMethod: 'relative' }));
    const tl = time(() => T.evaluateTender({ ...common, award: 'lowest-cost' }));
    rows.push([n, l, tc.toFixed(1), tl.toFixed(1)]);
  });
  const c = { ...WS.contracting };
  delete c.note;
  const mc = [['iterations', 'contractTypes (wellCost program) ms', 'contractTypes (triangular days) ms']];
  [2000, 20000, 200000].forEach((it) => {
    const a = time(() => T.contractTypes({ ...c, iterations: it }));
    const b = time(() => T.contractTypes({ ...c, duration: { min: 12, mode: 14, max: 22 }, iterations: it }));
    mc.push([it, a.toFixed(0), b.toFixed(0)]);
  });
  // eslint-disable-next-line no-console
  console.log([`node ${process.version}`].concat(rows.map((r) => r.join(' | ')), mc.map((r) => r.join(' | '))).join('\n'));
});
