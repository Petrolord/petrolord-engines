// Supply Chain SC4 offshore and marine logistics gates. Every case in
// test-data/supplychain/goldens/marine_cases.json is run THROUGH THE ENGINE
// and compared with the value the independent stdlib oracle
// (tools/validation/supplychain/oracle_marine.py) computed from the published
// rules by a different road (exact Fractions of the typed decimals, Erlang C
// by the direct sum of Adan and Resing eq. 5.1, M/D/1 by Pollaczek-Khinchin,
// first-fit decreasing one open voyage at a time, integer mulberry32). The
// published worked examples (Adan and Resing 2015 Tables 5.1 and 5.2;
// Iversen 2001 Example 12.3.1; Skoko et al. 2024 Tables 1 and 7; the
// Wikipedia first-fit-decreasing examples) are checked against their printed
// figures too. Property tests compare engine outputs with each other, never
// with a restated formula; tools/validation/supplychain/negcontrol_marine.sh
// proves the gates go red when the engine is wrong.

import fs from 'fs';
import path from 'path';
import * as M from '../engines/supplychain/marineLogistics';
import { findPLabels, outcomeOrderViolation, EXCEEDANCE_DEFINITION } from '../lib/conventions/percentile';

const ROOT = path.join(__dirname, '..');
const read = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const G = read('test-data', 'supplychain', 'goldens', 'marine_cases.json');
const FX = read('test-data', 'supplychain', 'ekene-marine', 'marine.json');
const SRC = fs.readFileSync(path.join(ROOT, 'engines', 'supplychain', 'marineLogistics.js'), 'utf8');
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
const byId = (id) => {
  const c = G.cases.find((x) => x.id === id);
  if (!c) throw new Error(`golden case ${id} is missing from marine_cases.json`);
  return c;
};
const memo = new Map();
const run = (id) => { if (!memo.has(id)) { const c = byId(id); memo.set(id, M[c.fn](clone(c.args))); } return memo.get(id); };
const FNS = ['deckPlan', 'fleetSize', 'fleetVariability', 'shoreBase', 'voyagePlan'];

describe('goldens: the engine agrees with the oracle', () => {
  test('the golden file is whole', () => {
    expect(G.module).toBe('marineLogistics');
    expect(G.generatedBy).toBe('tools/validation/supplychain/oracle_marine.py');
    expect(G.cases.length).toBeGreaterThanOrEqual(150);
    expect(new Set(G.cases.map((c) => c.id)).size).toBe(G.cases.length);
  });

  test('every exported function is exercised by goldens and refused at least three times', () => {
    const fns = Object.keys(M).filter((k) => typeof M[k] === 'function');
    expect(fns.sort()).toEqual(FNS);
    fns.forEach((f) => {
      expect(G.cases.filter((c) => c.fn === f && c.expected.error !== true).length).toBeGreaterThanOrEqual(5);
      expect(G.cases.filter((c) => c.fn === f && c.expected.error === true).length).toBeGreaterThanOrEqual(3);
    });
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
  test('five sources are carried in at least sixteen cases', () => {
    expect(printed.length).toBeGreaterThanOrEqual(16);
    const src = new Set(printed.map((c) => c.published.source.split(/[:(]/)[0].trim()));
    ['Skoko et al.', 'Adan and Resing', 'Iversen, Teletraffic Engineering Handbook', 'Iversen', 'Wikipedia, First-fit-decreasing bin packing'].forEach((s) => {
      expect([...src].some((x) => x.startsWith(s))).toBe(true);
    });
  });
  test.each(printed.map((c) => [c.id, c]))('%s', (id, c) => {
    const r = run(id);
    const p = c.published;
    const tol = p.printedTolerance ?? 0;
    const near = (a, b, t = tol) => expect(Math.abs(a - b)).toBeLessThanOrEqual(t + 1e-9);
    if (c.fn === 'shoreBase') {
      if (p.probabilityWait !== undefined) near(r.probabilityWait, p.probabilityWait);
      if (p.meanWaitHours !== undefined) near(r.meanWaitHours, p.meanWaitHours, p.meanWaitTolerance ?? tol);
      if (p.meanInSystem !== undefined) near(r.meanInSystem, p.meanInSystem, p.meanInSystemTolerance);
    }
    if (c.fn === 'voyagePlan') {
      const v = r.voyages[0];
      if (p.sailingHours !== undefined) expect(v.hours.sailing).toBe(p.sailingHours);
      if (p.sailingFuelCost !== undefined) near(v.fuelT.sailing * c.args.fuelPricePerT, p.sailingFuelCost, 1e-9);
      if (p.portFuelCost !== undefined) near(v.fuelT.port * c.args.fuelPricePerT, p.portFuelCost, 1e-9);
      if (p.fuelCost !== undefined) expect(Number(r.totals.fuelCost.toFixed(2))).toBe(p.fuelCost);
    }
    if (c.fn === 'deckPlan') {
      const size = Object.fromEntries(c.args.items.map((it) => [it.id, it.lengthM * it.widthM]));
      const used = r.voyages.filter((v) => v.units.length > 0).map((v) => v.units.map((u) => size[u]));
      if (p.bins) expect(used).toEqual(p.bins);
      if (p.binSizes) expect(used).toEqual(p.binSizes);
      if (p.binsUsed !== undefined) expect(r.voyagesUsed).toBe(p.binsUsed);
      expect(r.overflow).toEqual([]);
    }
  });
  test('Adan and Resing Table 5.2: the mean wait stays near 9 to 10 while the number in the system grows (printed alike is not equal)', () => {
    const w = [1, 2, 5, 10, 20].map((c) => run(`adan-resing-table-5-2-c${c}`).meanWaitHours);
    w.slice(1).forEach((x, i) => expect(x).toBeGreaterThan(w[i]));
    expect(run('adan-resing-table-5-2-c20').meanInSystem).not.toBe(214);
    expect(Math.round(run('adan-resing-table-5-2-c20').meanInSystem)).toBe(214);
  });
  test('Adan and Resing Table 5.1 prints 1.53 for c = 5 where the exact mean wait 1.524986 rounds to 1.52', () => {
    const w = run('adan-resing-table-5-1-c5').meanWaitHours;
    expect(Number(w.toFixed(6))).toBe(1.524986);
    expect(Number(w.toFixed(2))).toBe(1.52);
  });
  test('Iversen Example 12.3.1: the two waits add to the printed 0.274 at three decimals', () => {
    const t = run('iversen-2001-example-12-3-1-system-1').meanWaitHours + run('iversen-2001-example-12-3-1-system-2').meanWaitHours;
    expect(Number(t.toFixed(3))).toBe(0.274);
  });
  test('first-fit decreasing is not monotone in capacity: 61 needs one voyage more than 60 (Coffman, Garey and Johnson)', () => {
    expect(run('ffd-wikipedia-cgj-capacity-60').voyagesUsed).toBe(3);
    expect(run('ffd-wikipedia-cgj-capacity-61').voyagesUsed).toBe(4);
    expect(run('ffd-wikipedia-cgj-capacity-61').lowerBound).toBe(3);
    expect(run('ffd-wikipedia-dosa-tight-example').lowerBound).toBe(6);
  });
});

describe('canonical imports and determinism', () => {
  test('the Monte Carlo is lib/stats: mulberry32, triInvCDF and basicStats imported, nothing re-implemented', () => {
    expect(SRC).toMatch(/import \{ mulberry32, triInvCDF, basicStats \} from '\.\.\/\.\.\/lib\/stats\/stats\.js';/);
    expect(SRC).toMatch(/import \{ EXCEEDANCE_DEFINITION \} from '\.\.\/\.\.\/lib\/conventions\/percentile\.js';/);
    expect(SRC).not.toMatch(/Math\.random/);
    expect(SRC).not.toMatch(/Math\.imul|0x6d2b79f5/i);
    expect(SRC).not.toMatch(/\bnpv\b|discount/i);
    expect(SRC).not.toMatch(/Math\.log\(|Math\.exp\(|Box-Muller/);
    expect((SRC.match(/= mulberry32\(/g) || []).length).toBe(1);
  });
  test('seeded: the same seed gives the same answer and another seed does not', () => {
    const a = clone(byId('variability-weather-only').args);
    const r1 = M.fleetVariability(a);
    expect(M.fleetVariability(clone(a))).toEqual(r1);
    expect(M.fleetVariability({ ...a, seed: a.seed + 1 }).vesselDays.mean).not.toBe(r1.vesselDays.mean);
  });
  test('with both factors fixed the Monte Carlo returns fleetSize\'s vessel-days on every iteration', () => {
    const r = run('variability-fixed-factors-equal-fleet-size');
    const f = run('ekene-fleet-psv-milk-run');
    ['mean', 'p90', 'p50', 'p10', 'min', 'max'].forEach((k) => expect(r.vesselDays[k]).toBeCloseTo(f.vesselDays, 12));
    expect(r.plan.vesselDays).toBe(f.vesselDays);
    expect(r.vesselsDistribution).toEqual([{ vessels: f.vessels, probability: 1 }]);
  });
  test('vessel-days exactly at the planned capacity are not short; one vessel fewer is short on every iteration', () => {
    const r = run('variability-at-capacity-is-not-short');
    expect([r.capacityDays, r.vesselDays.max, r.probabilityShort, r.expectedShortVesselDays]).toEqual([14, 14, 0, 0]);
    const s = run('variability-one-vessel-short-always');
    expect([s.probabilityShort, s.expectedShortVesselDays]).toEqual([1, 7]);
  });
  test('percentiles in exceedance order for a requirement (P90 low, P10 high) with the canonical definition', () => {
    G.cases.filter((c) => c.fn === 'fleetVariability' && c.expected.error !== true).forEach((c) => {
      const r = run(c.id);
      expect(outcomeOrderViolation(r.vesselDays, c.id)).toBeNull();
      expect(outcomeOrderViolation(r.vesselsRequired, c.id)).toBeNull();
      expect(r.percentileDefinition).toBe(EXCEEDANCE_DEFINITION);
      expect(r.basis.rule).toMatch(/for a requirement P90 is the LOW figure \(10th percentile\) and P10 the HIGH figure \(90th percentile\)/);
    });
  });
});

describe('properties (engine against engine)', () => {
  test('Little\'s law holds on every shore base result: mean queue = arrivals an hour x mean wait', () => {
    G.cases.filter((c) => c.fn === 'shoreBase' && c.expected.error !== true).forEach((c) => {
      const r = run(c.id);
      expect(r.meanQueue).toBeCloseTo(r.arrivalsPerHour * r.meanWaitHours, 12);
      expect(r.meanTimeAtBaseHours).toBeCloseTo(r.meanWaitHours + r.serviceHours, 12);
    });
  });
  test('M/D/1 waits half as long as M/M/1 (Pollaczek-Khinchin), and M/D/c waits less than M/M/c', () => {
    const a = clone(byId('base-md1-pollaczek-khinchin').args);
    expect(M.shoreBase(a).meanWaitHours).toBeCloseTo(M.shoreBase({ ...a, model: 'M/M/c' }).meanWaitHours / 2, 12);
    expect(run('ekene-base-mdc').meanWaitHours).toBeLessThan(run('ekene-base-mmc').meanWaitHours);
  });
  test('the berth target search returns a count whose wait meets the target and one fewer does not', () => {
    const r = run('ekene-base-mmc-target-one-hour');
    const a = clone(byId('ekene-base-mmc-target-one-hour').args);
    const at = M.shoreBase({ ...a, berths: r.target.berths, targetMeanWaitHours: undefined });
    expect(at.meanWaitHours).toBeLessThanOrEqual(1);
    const below = M.shoreBase({ ...a, berths: r.target.berths - 1, targetMeanWaitHours: undefined });
    expect(below.meanWaitHours).toBeGreaterThan(1);
  });
  test('weather factor 1 on every activity equals calm, and the factor scales only the stated activities', () => {
    const calm = run('ekene-voyage-calm').voyages[0].hours;
    const w = run('ekene-voyage-milk-run-psv').voyages[0].hours;
    expect(w.port).toBe(calm.port);
    expect(w.sailing).toBeCloseTo(1.2 * calm.sailing, 12);
    expect(w.field).toBeCloseTo(1.2 * calm.field, 12);
    const all = run('ekene-voyage-weather-on-all-activities').voyages[0].hours;
    expect(all.total).toBeCloseTo(1.2 * calm.total, 12);
  });
  test('fleet vessel-days are voyages x voyage days, and vessels round as stated', () => {
    const r = run('ekene-fleet-psv-milk-run');
    r.voyageSets.forEach((s) => expect(s.vesselDays).toBeCloseTo(s.voyages * s.voyageDays, 12));
    expect(run('fleet-vessels-up').vessels).toBe(2);
    expect(run('fleet-vessels-nearest-short').vessels).toBe(1);
    expect(run('fleet-vessels-nearest-short').shortVesselDays).toBeGreaterThan(0);
    expect(run('fleet-vessels-nearest-half-rounds-up').vessels).toBe(2);
    expect(run('fleet-vessel-days-exactly-two-vessels').vessels).toBe(2);
    expect(run('fleet-vessel-days-exactly-two-vessels').fleetUtilisation).toBe(1);
  });
  test('a voyage count at exactly a whole number is not rounded up, one ten-thousandth over is', () => {
    expect(run('fleet-demand-exactly-three-voyages').voyageSets[0].voyages).toBe(3);
    expect(run('fleet-decimal-ratio-exactly-three').voyageSets[0].voyages).toBe(3);
    expect(run('fleet-demand-just-over-three-voyages').voyageSets[0].voyages).toBe(4);
    expect(run('fleet-decimal-ratio-2-1-over-0-7-is-three').voyageSets[0].voyages).toBe(3);
    expect(run('fleet-min-visits-equal-demand-names-demand').voyageSets[0].drivenBy).toBe('deck area');
    expect(run('fleet-min-visits-drive').voyageSets[0].drivenBy).toBe('minimum visits');
    expect(run('fleet-no-demand-no-visits').voyageSets[0].drivenBy).toBe('no demand');
  });
  test('capacity checks are inclusive: a load at the capacity is feasible, one tonne over is not', () => {
    expect(run('voyage-at-capacity-feasible').voyages[0].feasible).toBe(true);
    expect(run('voyage-one-over-deck-load').voyages[0].overloaded).toEqual(['deck load']);
    expect(run('voyage-decimal-sum-at-capacity').voyages[0].feasible).toBe(true);
    expect(run('voyage-binding-tie-goes-to-deck-area').voyages[0].binding.constraint).toBe('deck area');
    expect(run('deck-exact-fit-inclusive').overflow).toEqual([]);
    expect(run('deck-decimal-footprints-fill-exactly').overflow).toEqual([]);
  });
  test('deck plan: first-fit decreasing never leaves more area unplaced than first fit on the Ekene deck, and overflow is named', () => {
    const ffd = run('ekene-deck-one-voyage-ffd');
    const ff = run('ekene-deck-one-voyage-first-fit');
    const out = (r) => r.overflow.reduce((s, o) => s + o.areaM2, 0);
    expect(out(ffd)).toBeLessThan(out(ff));
    expect(ffd.overflow.length).toBeGreaterThan(0);
    ffd.overflow.forEach((o) => expect(o.reason).toMatch(new RegExp(`^${o.unit.replace('#', '\\#')} is overflow: `)));
    expect(run('ekene-deck-two-voyages-ffd').overflow).toEqual([]);
    const placed = run('ekene-deck-two-voyages-ffd').voyages.flatMap((v) => v.units).sort();
    expect(placed).toEqual(run('ekene-deck-two-voyages-ffd').packingOrder.slice().sort());
  });
  test('the planted situations of the Ekene fixture hold (the README describes these)', () => {
    const vp = run('ekene-voyage-milk-run-psv').voyages[0];
    expect(vp.binding.constraint).toBe('deck area');
    expect(vp.feasible).toBe(true);
    expect(run('ekene-voyage-deck-overloaded').voyages[0].overloaded).toEqual(['deck area']);
    const f = run('ekene-fleet-psv-milk-run');
    expect([f.voyageSets[0].voyages, f.voyageSets[0].drivenBy, f.vessels]).toEqual([4, 'deck area', 2]);
    const d = run('ekene-fleet-psv-dedicated');
    expect(d.voyageSets.every((s) => s.drivenBy === 'minimum visits')).toBe(true);
    expect(run('ekene-deck-one-voyage-first-fit').overflow.map((o) => o.unit)).toEqual(['pipe-bundle#2']);
    expect(run('ekene-deck-one-voyage-ffd').overflow.length).toBe(11);
    expect(run('ekene-base-mmc').berthUtilisation).toBeLessThan(1);
    expect(run('base-refuse-ekene-one-berth-overloaded').field).toBe('arrivalsPerDay');
  });
});

describe('course content: messages', () => {
  test('refusal and reason strings pass the copy rule (no em or en dash, no contrastives)', () => {
    G.cases.forEach((c) => {
      const s = JSON.stringify(run(c.id));
      expect(/[–—]/.test(s)).toBe(false);
      expect(s).not.toMatch(/, not |rather than|instead of|, never|\band not\b/);
    });
    expect(/[–—]/.test(SRC.split('export const ACCEPTED_KEYS')[1])).toBe(false);
  });
  test('counts agree with their units', () => {
    G.cases.forEach((c) => {
      const s = JSON.stringify(run(c.id));
      expect(s).not.toMatch(/(^|[^0-9.])1 (hours|days|berths|installations|vessels give)\b/);
    });
  });
  test('the steady-state bound is printed on the accepted side and typing it back is accepted', () => {
    const r = run('base-refuse-saturated-thirds');
    expect(r.error).toMatch(/^arrivalsPerDay must be at most 26\.666666 \(rounded down at the sixth decimal so that it is accepted\) for a steady state with 2 berths:/);
    const a = clone(byId('base-refuse-saturated-thirds').args);
    expect(M.shoreBase({ ...a, arrivalsPerDay: 26.666666 }).error).toBeUndefined();
    expect(M.shoreBase({ ...a, arrivalsPerDay: 26.666667 }).field).toBe('arrivalsPerDay');
    expect(run('base-refuse-saturated-exactly').error).toMatch(/^arrivalsPerDay must be at most 19\.999999 \(rounded down at the sixth decimal so that it is accepted\)/);
  });
  test('unknown keys: every function refuses one at the top level and ACCEPTED_KEYS lists every function', () => {
    expect(Object.keys(M.ACCEPTED_KEYS).sort()).toEqual(FNS);
    FNS.forEach((f) => {
      const r = M[f]({ notAKey: 1 });
      expect(r.field).toBe('notAKey');
      expect(r.error).toMatch(/^notAKey is not an accepted key; the accepted keys at the top level are /);
    });
  });
  test('no hidden defaults: dropping any one required top-level input is refused by name', () => {
    const cases = { voyagePlan: 'ekene-voyage-milk-run-psv', fleetSize: 'ekene-fleet-psv-milk-run', fleetVariability: 'variability-weather-only', deckPlan: 'ekene-deck-one-voyage-ffd', shoreBase: 'ekene-base-mmc' };
    Object.entries(cases).forEach(([fn, id]) => {
      const a = clone(byId(id).args);
      Object.keys(a).filter((k) => k !== 'targetMeanWaitHours').forEach((k) => {
        const b = clone(a);
        delete b[k];
        const r = M[fn](b);
        expect([fn, k, typeof r.error]).toEqual([fn, k, 'string']);
        expect(r.field.startsWith(k) || r.field.startsWith('installations')).toBe(true);
      });
    });
  });
  test('no P-label on a parameter output', () => {
    const strings = G.cases.filter((c) => c.expected.error !== true && c.fn !== 'fleetVariability').flatMap((c) => {
      const r = run(c.id);
      return [].concat(r.reasons || [], (r.voyages || []).flatMap((v) => v.reasons || []), (r.overflow || []).map((o) => o.reason));
    });
    expect(findPLabels(strings)).toEqual([]);
  });
});

describe('fixtures: synthetic and wired to the engine', () => {
  test('the file says it is synthetic, names its generator, and every name says synthetic', () => {
    expect(FX.synthetic).toMatch(/^SYNTHETIC teaching data for the Ekene field/);
    expect(FX.generatedBy).toBe('tools/validation/supplychain/make_marine_fixtures.py');
    FX.installations.forEach((x) => expect(x.name).toMatch(/\(synthetic\)$/));
    Object.values(FX.vessels).forEach((v) => expect(v.name).toMatch(/\(synthetic\)$/));
    FX.deckItems.forEach((x) => expect(x.name).toMatch(/\(synthetic\)$/));
    ['marine.json', 'README.md'].forEach((f) => {
      const s = fs.readFileSync(path.join(ROOT, 'test-data', 'supplychain', 'ekene-marine', f), 'utf8');
      expect(/[–—]/.test(s)).toBe(false);
    });
  });
});

describe('caps', () => {
  test('installations above the cap are refused with the cap in the message', () => {
    const a = clone(byId('ekene-fleet-psv-dedicated').args);
    a.installations = Array.from({ length: M.DEFAULTS.MAX_INSTALLATIONS + 1 }, (_, i) => ({ ...a.installations[0], id: `I${i}` }));
    expect(M.fleetSize(a).error).toBe(`installations has ${M.DEFAULTS.MAX_INSTALLATIONS + 1} entries; the cap is ${M.DEFAULTS.MAX_INSTALLATIONS}`);
  });
  test('iterations x voyage sets: the printed limit is accepted and one more is refused', () => {
    const a = clone(byId('variability-refuse-draws-cap').args);
    expect(run('variability-refuse-draws-cap').error).toBe('iterations must be at most 181818 with 11 voyage sets (iterations x voyage sets is capped at 2000000); got 181819');
    const r = M.fleetVariability({ ...a, iterations: 181818 });
    expect(r.error).toBeUndefined();
    expect(outcomeOrderViolation(r.vesselDays, 'at the cap')).toBeNull();
  });
  test('berths above the cap and iterations above the cap are refused', () => {
    expect(run('base-refuse-berths-cap').field).toBe('berths');
    expect(run('variability-refuse-iterations-cap').field).toBe('iterations');
  });
});
