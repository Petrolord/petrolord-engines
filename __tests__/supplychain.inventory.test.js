// Supply Chain SC3 inventory and spares gates. Every case in
// test-data/supplychain/goldens/inventory_cases.json is run THROUGH THE ENGINE
// and compared with the value the independent stdlib oracle
// (tools/validation/supplychain/oracle_inventory.py) computed from the
// published rules by a different road (exact Fractions, Decimal series for
// Phi and bisection for its inverse and the fill-rate k, direct Poisson
// partial expectations, integer mulberry32). The published worked examples
// (Harris 1913; Caplice, MIT ESD.260J lectures 8, 11, 12 and 13;
// MIL-HDBK-338B 5.3.8.1) are checked against their printed figures too.
// Property tests compare engine outputs with each other, never with a
// restated formula; tools/validation/supplychain/negcontrol_inventory.sh
// proves the gates go red when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as I from '../engines/supplychain/inventory';
import { findPLabels, OUTCOME_ORDER } from '../lib/conventions/percentile';

const read = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));
const G = read('test-data', 'supplychain', 'goldens', 'inventory_cases.json');
const REG = read('test-data', 'supplychain', 'ekene-materials', 'register.json');
const FLOOR = G.tolerance.absoluteFloor;
const ENGINE_SRC = fs.readFileSync(path.join(__dirname, '..', 'engines', 'supplychain', 'inventory.js'), 'utf8');

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
const call = (c) => I[c.fn](clone(c.args));
const byId = (id) => {
  const c = G.cases.find((x) => x.id === id);
  if (!c) throw new Error(`golden case ${id} is missing from inventory_cases.json`);
  return c;
};
const memo = new Map();
const run = (id) => { if (!memo.has(id)) memo.set(id, call(byId(id))); return memo.get(id); };
// 'candidates[2].eoq' read off a result
const at = (obj, p) => p.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const FNS = ['abcClassification', 'criticality', 'eoq', 'insuranceSpares', 'leadTimeRisk', 'poissonStock', 'quantityDiscount', 'safetyStock', 'slowMoving'];

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('inventory');
    expect(G.generatedBy).toBe('tools/validation/supplychain/oracle_inventory.py');
    expect(G.cases.length).toBeGreaterThanOrEqual(160);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by at least one golden, and refused at least once', () => {
    const fns = Object.keys(I).filter((k) => typeof I[k] === 'function');
    expect(fns.sort()).toEqual(FNS);
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
      expect(r.error.startsWith(e.field)).toBe(true);
      expect(r.error).toBe(e.message);
      return;
    }
    expect(r && r.error).toBeFalsy();
    expect(diff(r, e, c.tol, c.fn)).toEqual([]);
  });
});

describe('published worked examples: the engine against the printed figures', () => {
  const printed = G.cases.filter((c) => c.published);
  test('the four sources are carried (Harris 1913, Caplice lectures 8, 11 to 13, MIL-HDBK-338B)', () => {
    expect(printed.length).toBeGreaterThanOrEqual(17);
    const src = printed.map((c) => c.published.source).join(' | ');
    ['Harris (1913)', 'lecture 8', 'lecture 11', 'lecture 12', 'lecture 13', 'MIL-HDBK-338B'].forEach((s) => expect(src).toContain(s));
  });
  test.each(printed.map((c) => [c.id, c]))('%s', (id, c) => {
    const r = run(id);
    c.published.fields.forEach((f) => {
      const v = at(r, f.path);
      expect([f.path, typeof v]).toEqual([f.path, 'number']);
      expect([f.path, Math.abs(v - f.printed) <= f.tolerance + 1e-9]).toEqual([f.path, true]);
    });
    // printed alike is not equal: where a source misprints, the engine keeps the rule
    c.published.discrepancies.forEach((d) => {
      const v = at(r, d.path);
      expect([d.path, Math.abs(v - d.printed) > 0.5 * Math.abs(d.printed) || Math.abs(v - d.printed) > 5]).toEqual([d.path, true]);
    });
  });
  test('Harris prints his lots truncated to three figures; the engine keeps the exact root', () => {
    expect(run('harris-1913-example').eoq).toBeCloseTo(2190.890230020664, 9);
    expect(Math.floor(run('harris-1913-example').eoq)).toBe(2190);
    expect(Math.floor(run('harris-1913-stud').eoq * 10) / 10).toBe(48.5);
  });
  test('Caplice lecture 11: the CSL column reproduces exactly with k read to 2 decimals; the exact k shifts each by under 2 units', () => {
    [[99, 601], [95, 423], [90, 330], [80, 217]].forEach(([l, ss]) => {
      const t = run(`caplice-l11-csl-${l}`);
      expect(t.levelRounded - 500).toBe(ss);
      const x = run(`caplice-l11-csl-${l}-exact`);
      expect(Math.abs(x.safetyStock - ss)).toBeLessThan(2);
    });
    expect(run('caplice-l11-ifr-95').safetyStock).toBeCloseTo(339.18, 2);
  });
});

describe('fixtures: synthetic and wired to the engine', () => {
  test('the register says it is synthetic, names its generator, and carries no em or en dash', () => {
    expect(REG.synthetic).toMatch(/^SYNTHETIC teaching data for the Ekene field/);
    expect(REG.generatedBy).toBe('tools/validation/supplychain/make_inventory_fixtures.py');
    ['register.json', 'README.md'].forEach((f) => {
      const s = fs.readFileSync(path.join(__dirname, '..', 'test-data', 'supplychain', 'ekene-materials', f), 'utf8');
      expect(/[–—]/.test(s)).toBe(false);
    });
    expect(REG.items.length).toBe(18);
  });
  test('the wells named are Ekene field wells', () => {
    const field = read('test-data', 'ekene-dynamic', 'field.json');
    const names = field.wells.map((w) => w.name);
    ['Ekene-2', 'Ekene-4'].forEach((w) => expect(names).toContain(w));
    expect(REG.items.find((i) => i.id === 'ESP-MTR').name).toContain('Ekene-2 and Ekene-4');
  });
  test('the planted situations hold (the README describes these)', () => {
    const c = run('crit-ekene').items;
    const row = (id) => c.find((x) => x.id === id);
    expect([row('PSV-KIT').class, row('PSV-KIT').forcedBy, row('PSV-KIT').weightedScore]).toEqual(['V', ['safety'], 68]);
    expect([row('MECH-SEAL').class, row('MECH-SEAL').weightedScore]).toEqual(['V', 70]);
    expect([row('GASKET-RJ').class, row('GASKET-RJ').weightedScore]).toEqual(['E', 44]);
    expect(run('abc-ekene-at-or-below').items.find((x) => x.id === 'CEM-G').class).toBe('B');
    expect(run('abc-ekene-include-crossing').items.find((x) => x.id === 'CEM-G').class).toBe('A');
    const s = run('sm-ekene').items;
    expect(s.find((x) => x.id === 'CEM-G').band).toBe('slow');
    expect(s.find((x) => x.id === 'GASKET-RJ').band).toBe('very slow');
    expect([s.find((x) => x.id === 'HEAT-TRC').band, s.find((x) => x.id === 'HEAT-TRC').excess]).toEqual(['obsolete', true]);
    expect(s.find((x) => x.id === 'ORING-KIT').coverMonths).toBe(80);
  });
});

describe('canonical imports: no new Monte Carlo, the stated numerics', () => {
  test('the engine samples through lib/stats and labels through lib/conventions/percentile.js', () => {
    expect(ENGINE_SRC).toMatch(/import \{ mulberry32, triInvCDF, basicStats, mean as statMean \} from '\.\.\/\.\.\/lib\/stats\/stats\.js';/);
    expect(ENGINE_SRC).toMatch(/import \{ EXCEEDANCE_DEFINITION \} from '\.\.\/\.\.\/lib\/conventions\/percentile\.js';/);
    expect(ENGINE_SRC).toMatch(/import \{ regularizedGammaQ \} from '\.\.\/hse\/safetyStats\.js';/);
    expect(ENGINE_SRC).not.toMatch(/Math\.random/);
    expect(ENGINE_SRC).not.toMatch(/randomNormal|createCorrelatedSampler/);
    expect(ENGINE_SRC).not.toMatch(/function mulberry32|=>\s*\{\s*let a = seed/);
    expect(ENGINE_SRC).not.toMatch(/\bnpv\b|discountRate/);
  });
  test('the Monte Carlo is the canonical stream: replaying lib/stats by hand gives the engine\'s lead-time demand', async () => {
    const S = await import('../lib/stats/stats.js');
    const a = byId('ltr-one-iteration').args;
    const rng = S.mulberry32(a.seed);
    const t = S.triInvCDF(rng(), a.leadTimeDays.min, a.leadTimeDays.mode, a.leadTimeDays.max);
    const d = S.triInvCDF(rng(), a.demandPerDay.min, a.demandPerDay.mode, a.demandPerDay.max);
    const r = run('ltr-one-iteration');
    expect(r.leadTime.mean).toBe(t);
    expect(r.leadTimeDemand.mean).toBe(d * t);
  });
  test('seeded: the same seed gives the same answer and another seed does not', () => {
    const a = clone(byId('ltr-ekene-mech-seal').args);
    const small = { ...a, iterations: 3000 };
    expect(I.leadTimeRisk(small)).toEqual(I.leadTimeRisk(clone(small)));
    expect(I.leadTimeRisk({ ...small, seed: a.seed + 7 }).leadTimeDemand.mean).not.toBe(I.leadTimeRisk(small).leadTimeDemand.mean);
  });
  test('P-labels: P90 is the low figure and the three are in exceedance order; the definition is carried', () => {
    const r = run('ltr-ekene-mech-seal');
    [r.leadTime, r.leadTimeDemand].forEach((x) => {
      const v = OUTCOME_ORDER.map((k) => x[k]);
      expect(v[0]).toBeLessThanOrEqual(v[1]);
      expect(v[1]).toBeLessThanOrEqual(v[2]);
    });
    expect(r.percentileDefinition).toMatch(/^P90 means a 90% probability/);
    expect(r.basis.percentiles).toMatch(/P90 is the LOW figure/);
  });
});

describe('properties (engine against itself)', () => {
  test('EOQ: ordering and holding cost are equal at the unrounded EOQ, and rounding never lowers the relevant cost', () => {
    const r = run('harris-1913-example');
    expect(r.orderingCost).toBeCloseTo(r.holdingCost, 9);
    G.cases.filter((c) => c.fn === 'eoq' && !c.expected.error).forEach((c) => expect(run(c.id).roundingPenaltyPct).toBeGreaterThanOrEqual(-1e-12));
  });
  test('EOQ: quadrupling demand doubles the EOQ (Harris: consumption must increase four fold to warrant doubling)', () => {
    const a = clone(byId('harris-1913-example').args);
    expect(I.eoq({ ...a, annualDemand: 4 * a.annualDemand }).eoq).toBeCloseTo(2 * I.eoq(a).eoq, 9);
  });
  test('quantity discounts: the chosen total is the lowest of the feasible candidates', () => {
    G.cases.filter((c) => c.fn === 'quantityDiscount' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      r.candidates.filter((x) => x.feasible).forEach((x) => expect(r.totalCost).toBeLessThanOrEqual(x.totalCost + 1e-9));
    });
    expect(run('qd-tie-exact').quantity).toBe(100);
    expect(run('qd-tie-exact').reason).toMatch(/tied on cost, the smaller quantity is taken$/);
  });
  test('safety stock: a higher cycle service level never lowers the safety stock; the achieved service meets the target', () => {
    const ks = [80, 90, 95, 99].map((l) => run(`caplice-l11-csl-${l}-exact`).safetyStock);
    ks.slice(1).forEach((k, i) => expect(k).toBeGreaterThan(ks[i]));
    [99, 95, 90, 80].forEach((l) => {
      const f = run(`caplice-l11-ifr-${l}`);
      expect(f.achievedFillRate).toBeCloseTo(l / 100, 9);
      const c = run(`caplice-l11-csl-${l}-exact`);
      expect(c.achievedCycleService).toBeCloseTo(l / 100, 9);
    });
  });
  test('safety stock: for the same k the fill rate sits above the cycle service level (Caplice lecture 11)', () => {
    [99, 95, 90, 80].forEach((l) => {
      const c = run(`caplice-l11-csl-${l}-exact`);
      expect(c.achievedFillRate).toBeGreaterThan(c.achievedCycleService);
    });
  });
  test('Poisson: the chosen level meets the target and the one below does not', () => {
    G.cases.filter((c) => c.fn === 'poissonStock' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      const a = c.args;
      const meets = (row) => (a.serviceMeasure === 'cycle-service' ? row.cumulative >= a.serviceLevel - 1e-12 : row.expectedShort <= a.orderQuantity * (1 - a.serviceLevel) + 1e-12);
      expect(meets(r.rows[r.level])).toBe(true);
      if (r.level > 0) expect(meets(r.rows[r.level - 1])).toBe(false);
    });
  });
  test('insurance spares: the chosen stock is the cheapest option, and more spares never lower the probability of no shortage', () => {
    G.cases.filter((c) => c.fn === 'insuranceSpares' && !c.expected.error).forEach((c) => {
      const r = run(c.id);
      r.options.forEach((o) => expect(r.totalCost).toBeLessThanOrEqual(o.totalCost + 1e-9));
      r.options.slice(1).forEach((o, i) => expect(o.probabilityNoShortage).toBeGreaterThanOrEqual(r.options[i].probabilityNoShortage));
    });
    expect(run('ins-search-limit').atSearchLimit).toBe(true);
    expect(run('ins-cheap-downtime-holds-none').spares).toBe(0);
    const tie = run('ins-tie-takes-fewer');
    expect([tie.spares, tie.options[0].totalCost.toPrecision(12)]).toEqual([0, tie.options[1].totalCost.toPrecision(12)]);
  });
  test('slow-moving: the write-downs add to the total and every band edge is inclusive', () => {
    const r = run('sm-ekene');
    expect(r.items.reduce((s, x) => s + x.writeDown, 0)).toBeCloseTo(r.totalWriteDown, 6);
    const b = run('sm-boundaries').items;
    expect(b.find((x) => x.id === 'AT12').band).toBe('slow');
    expect(b.find((x) => x.id === 'BELOW12').band).toBe('active');
    expect(b.find((x) => x.id === 'COVER24').excess).toBe(false);
    expect([b.find((x) => x.id === 'COVER25').excess, b.find((x) => x.id === 'COVER25').excessQuantity]).toEqual([true, 1]);
  });
  test('criticality and ABC: every class carries its reason, and the 12-digit key places 69.99999999999999 in V', () => {
    run('crit-ekene').items.forEach((x) => expect(x.reason.startsWith(`${x.id}: `)).toBe(true));
    run('abc-ekene-at-or-below').items.forEach((x) => expect(x.reason.startsWith(`${x.id}: `)).toBe(true));
    const t = run('crit-12-digit-key').items[0];
    expect(t.weightedScore).not.toBe(70);
    expect(t.class).toBe('V');
  });
});

describe('course strings', () => {
  const all = () => G.cases.map((c) => JSON.stringify(run(c.id)));
  test('no em or en dash, no contrastive wording, counts agree with their units', () => {
    all().forEach((t) => {
      expect(/[–—]/.test(t)).toBe(false);
      expect(t).not.toMatch(/, not |rather than|instead of|, never|and not /);
      expect(t).not.toMatch(/(^|[^0-9.])1 (months|units|spares|candidates|draws|iterations|weeks)\b/);
    });
  });
  test('no parameter output carries a P-label in its reasons', () => {
    const strings = G.cases.filter((c) => !c.expected.error).flatMap((c) => {
      const r = run(c.id);
      return [r.reason].concat((r.items || []).map((x) => x.reason), (r.candidates || []).map((x) => x.reason)).filter(Boolean);
    });
    expect(findPLabels(strings)).toEqual([]);
  });
  test('a printed maximum is itself accepted: stating the figure a refusal prints back passes that rule', () => {
    let n = 0;
    G.cases.filter((c) => c.expected.error === true && / must be at most \d/.test(c.expected.message) && ['leadTime', 'leadTimeDays'].includes(c.expected.field)).forEach((c) => {
      const m = c.expected.message.match(/ must be at most (\d+(?:\.\d+)?)[ ,]/);
      const r = I[c.fn]({ ...clone(c.args), [c.expected.field]: Number(m[1]) });
      expect([c.id, r.error || null]).toEqual([c.id, null]);
      n += 1;
    });
    expect(n).toBeGreaterThanOrEqual(3);
    expect(run('ps-refuse-mean-inexact-bound').error).toMatch(/^leadTime must be at most 166\.666666 \(rounded down at the sixth decimal so that it is accepted\) /);
  });
  test('unknown keys: every function refuses one at the top level, and the fixtures pass whole', () => {
    expect(Object.keys(I.ACCEPTED_KEYS).sort()).toEqual(FNS);
    FNS.forEach((f) => {
      const r = I[f]({ notAKey: 1 });
      expect(r.field).toBe('notAKey');
      expect(r.error).toMatch(/^notAKey is not an accepted key; the accepted keys at the top level are /);
    });
    expect(I.eoq('x').error).toBe('options must be an object of named inputs');
  });
  test('no hidden defaults: each required policy input, left out, is refused by name', () => {
    const drop = (id, k) => { const a = clone(byId(id).args); delete a[k]; return a; };
    [['eoq', 'caplice-l8-eoq', 'rounding'], ['quantityDiscount', 'qd-ekene-casing', 'rounding'], ['quantityDiscount', 'qd-ekene-casing', 'discountType'],
      ['safetyStock', 'ss-ekene-choke-beans', 'serviceLevel'], ['safetyStock', 'ss-ekene-choke-beans', 'safetyFactorRounding'],
      ['safetyStock', 'ss-ekene-choke-beans', 'minimumSafetyFactor'], ['safetyStock', 'ss-ekene-choke-beans', 'rounding'],
      ['poissonStock', 'ps-ekene-psv-kits', 'serviceLevel'], ['insuranceSpares', 'ins-ekene-esp-motor', 'holdingRate'],
      ['insuranceSpares', 'ins-ekene-esp-motor', 'daysPerYear'], ['leadTimeRisk', 'ltr-ekene-mech-seal', 'seed'],
      ['slowMoving', 'sm-ekene', 'excessCoverMonths'], ['abcClassification', 'abc-ekene-at-or-below', 'boundaryRule'],
      ['criticality', 'crit-ekene', 'topClassOnMaxScore']].forEach(([fn, id, k]) => {
      const r = I[fn](drop(id, k));
      expect([fn, k, typeof r.error, r.field.split(/[.[]/)[0]]).toEqual([fn, k, 'string', k]);
    });
  });
});

describe('caps', () => {
  test('items above the cap are refused with the cap in the message', () => {
    const items = Array.from({ length: I.DEFAULTS.MAX_ITEMS + 1 }, (_, i) => ({ id: `I${i}`, annualUsage: 1, unitCost: 1 }));
    expect(I.abcClassification({ items, cutoffs: { aPct: 80, bPct: 95 }, boundaryRule: 'at-or-below' }).error).toBe(`items has ${I.DEFAULTS.MAX_ITEMS + 1} entries; the cap is ${I.DEFAULTS.MAX_ITEMS}`);
  });
  test('the Poisson mean cap is stated and refused beyond it', () => {
    expect(I.DEFAULTS.MAX_POISSON_MEAN).toBe(500);
    expect(run('ps-mean-at-cap').mean).toBe(500);
    expect(run('ps-refuse-mean-above-cap').field).toBe('leadTime');
  });
});
