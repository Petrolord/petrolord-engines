// Supply Chain SC2 tender evaluation gates. Every case in
// test-data/supplychain/goldens/tender_cases.json is run THROUGH THE ENGINE
// and compared with the value the independent stdlib oracle
// (tools/validation/supplychain/oracle_tender.py) computed from the published
// rules by a different road (exact Fractions, its own ranking, integer
// mulberry32, the wellCost duration forms re-derived). The published worked
// examples (World Bank Guidance, Kiiver and Kodym 2015, Chen 2008) are checked
// against their printed figures too. Property tests compare engine outputs
// with each other, never with a restated formula;
// tools/validation/supplychain/negcontrol_tender.sh proves the gates go red
// when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as T from '../engines/supplychain/tender';
import { findPLabels } from '../lib/conventions/percentile';

const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));
const G = read('test-data', 'supplychain', 'goldens', 'tender_cases.json');
const WS = read('test-data', 'supplychain', 'ekene-tender', 'well-services.json');
const MS = read('test-data', 'supplychain', 'ekene-tender', 'materials.json');
const FLOOR = G.tolerance.absoluteFloor;

const diff = (actual, expected, tol, where = '') => {
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return [`${where}: ${actual} is not a finite number (expected ${expected})`];
    const d = Math.abs(actual - expected);
    return d <= FLOOR || d <= tol * Math.abs(expected) ? [] : [`${where}: ${actual} vs ${expected} (abs ${d})`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [`${where}: array length ${actual && actual.length} vs ${expected.length}`];
    return expected.flatMap((e, i) => diff(actual[i], e, tol, `${where}[${i}]`));
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return [`${where}: ${actual} is not an object`];
    const extra = Object.keys(actual).filter((k) => !(k in expected) && k !== 'basis');
    const missing = Object.keys(expected).filter((k) => !(k in actual));
    const keyErr = extra.length || missing.length ? [`${where}: keys differ (engine only: ${extra.join(', ')}; oracle only: ${missing.join(', ')})`] : [];
    return keyErr.concat(Object.keys(expected).flatMap((k) => diff(actual[k], expected[k], tol, `${where}.${k}`)));
  }
  return actual === expected ? [] : [`${where}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`];
};

const clone = (x) => JSON.parse(JSON.stringify(x));
const call = (c) => T[c.fn](clone(c.args));
const byId = (id) => {
  const c = G.cases.find((x) => x.id === id);
  if (!c) throw new Error(`golden case ${id} is missing from tender_cases.json`);
  return c;
};
const memo = new Map();
const run = (id) => { if (!memo.has(id)) memo.set(id, call(byId(id))); return memo.get(id); };

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('tender');
    expect(G.generatedBy).toBe('tools/validation/supplychain/oracle_tender.py');
    expect(G.cases.length).toBeGreaterThanOrEqual(130);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by at least one golden, and refused at least once', () => {
    const fns = Object.keys(T).filter((k) => typeof T[k] === 'function');
    expect(fns.sort()).toEqual(['contentPreference', 'contractTypes', 'correctArithmetic', 'evaluateTender', 'evaluatedCosts',
      'nigerianContent', 'rankTender', 'shouldCost', 'technicalEvaluation', 'weightingBand']);
    const used = new Set(G.cases.map((c) => c.fn));
    expect(fns.filter((f) => !used.has(f))).toEqual([]);
    const refused = new Set(G.cases.filter((c) => c.expected.error === true).map((c) => c.fn));
    expect(fns.filter((f) => !refused.has(f))).toEqual([]);
  });

  test.each(G.cases.map((c) => [c.id, c]))('%s', (id, c) => {
    const r = run(id);
    const e = c.expected;
    if (e && e.error === true) {
      expect([typeof r.error, r.field]).toEqual(['string', e.field]);
      expect(r.error.startsWith(e.field.replace(/[.[].*$/, ''))).toBe(true);
      expect(r.error).toBe(e.message);
      return;
    }
    expect(r && r.error).toBeFalsy();
    expect(diff(r, e, c.tol, c.fn)).toEqual([]);
  });
});

describe('published worked examples: the engine against the printed figures', () => {
  const printed = G.cases.filter((c) => c.published);
  test('five sources are carried', () => {
    expect(printed.length).toBeGreaterThanOrEqual(7);
  });
  test.each(printed.map((c) => [c.id, c]))('%s', (id, c) => {
    const r = run(id);
    const p = c.published;
    const tol = p.printedTolerance ?? 0;
    const row = (bid) => r.bids.find((b) => b.id === bid);
    if (p.weightedPoints) Object.entries(p.weightedPoints).forEach(([k, v]) => expect(row(k).weightedPoints).toBe(v));
    if (p.totals) Object.entries(p.totals).forEach(([k, v]) => expect(row(k).technicalPercent).toBe(v));
    if (p.rejected) expect(r.excluded.map((x) => x.id)).toEqual(p.rejected);
    if (p.rank) expect(r.bids.map((b) => b.id)).toEqual(p.rank);
    const near = (a, b) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol + 1e-9);
    if (p.combined) Object.entries(p.combined).forEach(([k, v]) => near(row(k).combinedScore, v));
    if (p.commercial) Object.entries(p.commercial).forEach(([k, v]) => near(row(k).commercialScore, v));
    if (p.technicalWeighted) Object.entries(p.technicalWeighted).forEach(([k, v]) => near(0.8 * row(k).technicalScore, v));
    if (p.financialComparative) Object.entries(p.financialComparative).forEach(([k, v]) => expect(Math.abs(row(k).commercialScore - v)).toBeLessThanOrEqual(0.05));
  });
  test('the Guidance prints truncated or rounded figures that are not the exact ones (printed alike is not equal)', () => {
    const r = run('wb-guidance-fig-x-to-xii');
    const d = r.bids.find((b) => b.id === 'D');
    expect(d.combinedScore).not.toBe(98.34);
    expect(Number(d.combinedScore.toFixed(2))).toBe(98.33);
    const a3 = run('wb-guidance-annex-3-combined');
    expect(a3.bids[0].combinedScore).toBe(94.375);
  });
  test('Chen (2008) ranking paradox: declaring A invalid widens the B to C gap from 15 to 18.75 points', () => {
    const full = run('chen-2008-price-formula');
    const cut = run('chen-2008-price-formula-a-invalid');
    const gap = (r) => r.bids.find((b) => b.id === 'B').combinedScore - r.bids.find((b) => b.id === 'C').combinedScore;
    expect(gap(full)).toBe(15);
    expect(gap(cut)).toBe(18.75);
  });
});

describe('fixtures: synthetic and wired to the engine', () => {
  test('both files say they are synthetic, name their generator, and carry no em or en dash', () => {
    [WS, MS].forEach((f) => {
      expect(f.synthetic).toMatch(/^SYNTHETIC teaching data for the Ekene field/);
      expect(f.generatedBy).toBe('tools/validation/supplychain/make_tender_fixtures.py');
      f.bids.forEach((b) => expect(b.name).toMatch(/\(synthetic\)$/));
    });
    ['well-services.json', 'materials.json', 'README.md'].forEach((f) => {
      const s = fs.readFileSync(path.join(__dirname, '..', 'test-data', 'supplychain', 'ekene-tender', f), 'utf8');
      expect(/[–—]/.test(s)).toBe(false);
    });
  });
  test('sizes: 6 well-services bids, 5 materials bids (5 to 7 per tender)', () => {
    expect(WS.bids.length).toBe(6);
    expect(MS.bids.length).toBe(5);
  });
  test('the wells named are Ekene field wells', () => {
    const field = read('test-data', 'ekene-dynamic', 'field.json');
    const names = field.wells.map((w) => w.name);
    ['Ekene-3', 'Ekene-5'].forEach((w) => { expect(names).toContain(w); expect(WS.title).toContain(w); });
  });
  test('every Nigerian content item names a Schedule line the engine holds', () => {
    [WS, MS].forEach((f) => f.nc.items.forEach((it) => expect(Object.prototype.hasOwnProperty.call(T.NC_SCHEDULE, it.scheduleLine)).toBe(true)));
  });
  test('the planted situations hold (the README describes these)', () => {
    const ws = run('ws-tender-combined');
    expect(ws.excluded.map((x) => [x.id, x.stage])).toEqual([['WS4', 'technical'], ['WS6', 'technical']]);
    expect(ws.technical.bids.find((b) => b.id === 'WS5').technicalPercent).toBe(70);
    expect(ws.commercial.lowestEvaluatedCost).toBe('WS5');
    expect(ws.award).toBe('WS3');
    expect(run('ms-tender-lowest-cost').award).toBe('MS4');
    expect(run('ms-tender-highest-rule').award).toBe('MS2');
    expect(run('ms-tender-content-points').award).toBe('MS4');
    expect(run('ms-tender-content-relative').award).toBe('MS2');
    expect(run('ms-tender-content-relative').contentPreference.section16.map((x) => [x.id, x.withinMargin])).toEqual([['MS3', true]]);
  });
});

describe('properties', () => {
  test('the Schedule percentages are the Act\'s and every line has a measured unit', () => {
    Object.values(T.NC_SCHEDULE).forEach((s) => {
      expect(s.ncPct).toBeGreaterThan(0);
      expect(s.ncPct).toBeLessThanOrEqual(100);
      s.measures.forEach((m) => expect(T.NC_MEASURES).toContain(m));
    });
    expect(T.NC_SCHEDULE['coiled-tubing-services'].ncPct).toBe(75);
    expect(T.NC_SCHEDULE['pumping-services'].ncPct).toBe(95);
    expect(T.NC_SCHEDULE.valves.measures).toEqual(['number']);
  });
  test('a bid whose technical envelope fails never has its price opened', () => {
    const r = run('ws-tender-combined');
    expect(r.commercial.bids.map((b) => b.id)).not.toContain('WS4');
    expect(r.commercial.bids.map((b) => b.id)).not.toContain('WS6');
  });
  test('the combined score is linear in the technical weight between its two ends', () => {
    const r0 = run('ws-rank-price-only');
    const r1 = run('ws-rank-technical-only');
    const rm = run('ws-rank-combined');
    rm.bids.forEach((b) => {
      const s0 = r0.bids.find((x) => x.id === b.id).combinedScore;
      const s1 = r1.bids.find((x) => x.id === b.id).combinedScore;
      expect(b.combinedScore).toBeCloseTo(0.3 * s0 + 0.7 * s1, 10);
    });
  });
  test('omission rule: the highest rule never gives a lower evaluated cost than the average rule', () => {
    const a = run('ms-evaluated-average');
    const h = run('ms-evaluated-highest');
    a.bids.forEach((b) => expect(h.bids.find((x) => x.id === b.id).evaluatedCost).toBeGreaterThanOrEqual(b.evaluatedCost));
  });
  test('contract types: who carries the overrun adds up, lump sum leaves none to the company, cost plus leaves more than all of it', () => {
    const r = run('ws-contract-types');
    Object.values(r.types).forEach((t) => expect(t.overrun.companyPays + t.overrun.contractorAbsorbs).toBeCloseTo(r.overrun.expectedOverrun, 6));
    expect(r.types.lumpSum.overrun.companyShare).toBe(0);
    expect(r.types.reimbursable.overrun.companyShare).toBeCloseTo(1.12, 10);
    expect(r.types.lumpSum.companyCost.p90).toBe(r.types.lumpSum.companyCost.p10);
  });
  test('contract types: percentiles are in exceedance order for a cost (P90 low, P10 high) and carry the definition', () => {
    const r = run('ws-contract-types');
    ['dayRate', 'reimbursable'].forEach((k) => {
      const c = r.types[k].companyCost;
      expect(c.p90).toBeLessThanOrEqual(c.p50);
      expect(c.p50).toBeLessThanOrEqual(c.p10);
    });
    expect(r.percentileDefinition).toMatch(/^P90 means a 90% probability/);
  });
  test('contract types: seeded, so the same seed gives the same answer and another seed does not', () => {
    const args = clone(byId('ct-triangular-fixed-fee-plan').args);
    expect(T.contractTypes(args)).toEqual(T.contractTypes(clone(args)));
    expect(T.contractTypes({ ...args, seed: 43 }).types.dayRate.companyCost.mean).not.toBe(T.contractTypes(args).types.dayRate.companyCost.mean);
  });
  test('should-cost calls the wellCost engine: more NPT raises the estimate by the per-day items only', () => {
    const a = clone(byId('ws-should-cost').args);
    const lo = T.shouldCost(a);
    const hi = T.shouldCost({ ...a, nptFrac: a.nptFrac + 0.1 });
    const perDay = a.items.filter((i) => i.basis === 'per-day').reduce((s, i) => s + i.rate, 0);
    expect(hi.estimate - lo.estimate).toBeCloseTo((1 + a.contingencyFrac) * perDay * (hi.totalDays - lo.totalDays), 6);
  });
  test('no parameter output carries a P-label in its reasons', () => {
    const r = run('ws-tender-combined');
    const strings = [r.reason].concat(...r.commercial.bids.map((b) => b.reasons));
    expect(findPLabels(strings)).toEqual([]);
  });
  test('refusal and reason strings carry no em dash and no en dash', () => {
    G.cases.forEach((c) => {
      const s = JSON.stringify(run(c.id));
      expect(/[–—]/.test(s)).toBe(false);
    });
  });
});

describe('caps', () => {
  test('bids above the cap are refused with the cap in the message', () => {
    const bids = Array.from({ length: T.DEFAULTS.MAX_BIDS + 1 }, (_, i) => ({ id: `B${i}`, technicalPercent: 50, evaluatedCost: 1000 + i, receivedAt: '2027-01-01T00:00:00Z' }));
    const r = T.rankTender({ bids, technicalWeight: 0.5, priceMethod: 'linear', technicalMethod: 'relative' });
    expect(r.error).toBe(`bids has ${T.DEFAULTS.MAX_BIDS + 1} entries; the cap is ${T.DEFAULTS.MAX_BIDS}`);
  });
  test('iterations above the cap are refused', () => {
    const a = clone(byId('ct-constant-everything').args);
    expect(T.contractTypes({ ...a, iterations: T.DEFAULTS.MAX_ITERATIONS + 1 }).field).toBe('iterations');
  });
});
