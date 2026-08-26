// Gates for the V4 vrrLedger allocation/pattern/recommendation additions,
// on the same hand-computed fixture as the V2 ledger gates.
// Full allocation used below: I-1 (water) -> P-1 0.6 / P-2 0.4;
// I-2 (gas) -> P-1 1.0. Every row sums to 1, so one pattern holding all
// producers must reproduce the field series exactly (the invariant).
import fs from 'fs';
import path from 'path';
import {
  validateAllocation, allocateInjection, patternHasAllocation,
  buildPatternPeriods, buildFieldPeriods, recommendPatternInjection,
} from '../engines/waterflood/vrrLedger.js';
import { computeVRRSeries } from '../engines/waterflood/vrr.js';

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../test-data/waterflood/vrr-ledger-fixture.json'), 'utf8'));

const FULL_ALLOC = {
  'I-1': { 'P-1': 0.6, 'P-2': 0.4 },
  'I-2': { 'P-1': 1.0 },
};
const ALL_PATTERN = { id: 'all', name: 'Whole field', producers: ['P-1', 'P-2'] };
const P1_PATTERN = { id: 'p1', name: 'P-1 area', producers: ['P-1'] };

describe('validateAllocation', () => {
  it('accepts full rows, warns on partial rows, rejects overs and negatives', () => {
    expect(validateAllocation(FULL_ALLOC)).toMatchObject({ ok: true, errors: [], warnings: [] });

    const partial = validateAllocation({ 'I-1': { 'P-1': 0.5 } });
    expect(partial.ok).toBe(true);
    expect(partial.warnings[0]).toMatch(/out-of-zone/);

    expect(validateAllocation({ 'I-1': { 'P-1': 0.7, 'P-2': 0.5 } }).ok).toBe(false);
    expect(validateAllocation({ 'I-1': { 'P-1': -0.1 } }).ok).toBe(false);
    expect(validateAllocation({ 'I-1': { 'P-1': 'abc' } }).ok).toBe(false);
  });
});

describe('allocateInjection (conservation audit)', () => {
  it('conserves volumes exactly: allocated + unallocated == injected', () => {
    // Fixture totals: I-1 water 15000+18000+20000 = 53000; I-2 gas 6000.
    const { perProducer, unallocated } = allocateInjection(fixture.rows, FULL_ALLOC);
    expect(perProducer['P-1'].winj_stb).toBeCloseTo(0.6 * 53000, 9);
    expect(perProducer['P-2'].winj_stb).toBeCloseTo(0.4 * 53000, 9);
    expect(perProducer['P-1'].ginj_mscf).toBeCloseTo(6000, 9);
    expect(unallocated.winj_stb).toBeCloseTo(0, 9);
    expect(unallocated.ginj_mscf).toBeCloseTo(0, 9);
  });

  it('books the row-sum shortfall as unallocated (out-of-zone)', () => {
    const { perProducer, unallocated } = allocateInjection(fixture.rows, { 'I-1': { 'P-1': 0.5 } });
    expect(perProducer['P-1'].winj_stb).toBeCloseTo(26500, 9);
    expect(unallocated.winj_stb).toBeCloseTo(26500, 9);
    expect(unallocated.ginj_mscf).toBeCloseTo(6000, 9); // I-2 has no row at all
  });
});

describe('buildPatternPeriods', () => {
  it('INVARIANT: one pattern with all producers and rows summing to 1 equals the field', () => {
    const patternPeriods = buildPatternPeriods(fixture.rows, ALL_PATTERN, FULL_ALLOC);
    expect(patternPeriods).toEqual(buildFieldPeriods(fixture.rows));
    const pSeries = computeVRRSeries(patternPeriods, fixture.fvf);
    expect(pSeries[2].cumulativeVRR).toBeCloseTo(fixture.oracle.cumulativeVRR_last, 12);
  });

  it('splits a sub-pattern by allocation fractions', () => {
    const p = buildPatternPeriods(fixture.rows, P1_PATTERN, FULL_ALLOC);
    // 2025-01: P-1 production only; injection = 0.6*15000 water + 1.0*3000 gas.
    expect(p[0]).toEqual({ label: '2025-01', Np: 10000, Wp: 2000, Gp: 6000, Wi: 9000, Gi: 3000 });
  });

  it('patternHasAllocation is the withholding predicate', () => {
    expect(patternHasAllocation(P1_PATTERN, FULL_ALLOC)).toBe(true);
    expect(patternHasAllocation(P1_PATTERN, {})).toBe(false);
    expect(patternHasAllocation({ producers: ['P-9'] }, FULL_ALLOC)).toBe(false);
  });
});

describe('recommendPatternInjection', () => {
  it('scales recent allocated injection by target/current rolling VRR', () => {
    const r = recommendPatternInjection(fixture.rows, ALL_PATTERN, FULL_ALLOC, fixture.fvf, { targetVRR: 1.0, windowPeriods: 2 });
    // Rolling window 2 (hand oracle from the V2 gates): 40700/39645.
    const current = (19800 + 20900) / (20245 + 19400);
    expect(r.withheld).toBe(false);
    expect(r.currentVRR).toBeCloseTo(current, 12);
    expect(r.scale).toBeCloseTo(1 / current, 12);
    expect(r.clamped).toBe(false);
    expect(r.currentWi).toBeCloseTo(19000, 9); // (18000+20000)/2
    expect(r.recommendedWi).toBeCloseTo(19000 / current, 6);
    expect(r.perInjector).toHaveLength(1); // gas injector I-2 is reported via Gi, not scaled
    expect(r.perInjector[0]).toMatchObject({ well: 'I-1' });
    expect(r.perInjector[0].currentWi).toBeCloseTo(19000, 9);
    expect(r.perInjector[0].recommendedWi).toBeCloseTo(19000 / current, 6);
  });

  it('clamps implausible scale steps and says so', () => {
    const r = recommendPatternInjection(fixture.rows, ALL_PATTERN, FULL_ALLOC, fixture.fvf, { targetVRR: 10, windowPeriods: 2 });
    expect(r.scale).toBe(2.0);
    expect(r.clamped).toBe(true);
    const low = recommendPatternInjection(fixture.rows, ALL_PATTERN, FULL_ALLOC, fixture.fvf, { targetVRR: 0.01, windowPeriods: 2 });
    expect(low.scale).toBe(0.5);
    expect(low.clamped).toBe(true);
  });

  it('is withheld (never faked) without allocation, rows, or produced voidage', () => {
    expect(recommendPatternInjection(fixture.rows, P1_PATTERN, {}, fixture.fvf).withheld).toBe(true);
    expect(recommendPatternInjection(fixture.rows, P1_PATTERN, {}, fixture.fvf).reason).toMatch(/allocation/i);

    expect(recommendPatternInjection([], ALL_PATTERN, FULL_ALLOC, fixture.fvf).withheld).toBe(true);

    // Allocation routes to a "producer" that never produces: injection with
    // no produced voidage in the window.
    const rows = [
      { date: '2025-01-01', well: 'I-1', oil_stb: 0, water_stb: 0, gas_mscf: 0, winj_stb: 1000, ginj_mscf: 0 },
    ];
    const r = recommendPatternInjection(rows, { producers: ['P-X'] }, { 'I-1': { 'P-X': 1 } }, fixture.fvf);
    expect(r.withheld).toBe(true);
    expect(r.reason).toMatch(/produced voidage/i);
  });
});
