// Gates for the VRR-U1 voidage ledger (vrrLedger.js: resolvePeriodFvf,
// voidageTerms, buildVoidageLedger, applyPeriodFvf, and the periodFvf option
// of recommendPatternInjection). vrr.js is untouched; every gate here calls
// the shipped functions and holds the terms against vrr.js computeVRRSeries.
//
// Hand oracle on the V2 fixture (Bo 1.2, Bw 1.0, Bg 0.9 RB/Mscf, Rs 500 scf/STB):
//   2025-01  oil 15,000 x 1.2 = 18,000; water 3,000 x 1.0 = 3,000;
//            free gas 8,000 - 500 x 15,000 / 1,000 = 500 Mscf x 0.9 = 450 RB;
//            produced 21,450 RB; injected 15,000 x 1.0 + 3,000 x 0.9 = 17,700 RB
//   2025-02  16,200 + 4,000 + (6,800 - 6,750) x 0.9 = 45  -> 20,245; injected 18,000 + 1,800 = 19,800
//   2025-03  14,400 + 5,000 + 0 (5,700 below the 6,000 of solution gas) -> 19,400; injected 20,000 + 900 = 20,900
//   totals   produced 61,095 RB, injected 58,400 RB, cumulative VRR 0.955888
import fs from 'fs';
import path from 'path';
import {
  resolvePeriodFvf, voidageTerms, buildVoidageLedger, applyPeriodFvf,
  buildFieldPeriods, buildPatternPeriods, recommendPatternInjection, computeRollingVRR,
} from '../engines/waterflood/vrrLedger.js';
import { computeVRRSeries } from '../engines/waterflood/vrr.js';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/waterflood/vrr-ledger-fixture.json'), 'utf8'));
const FVF = fixture.fvf;
const periods = buildFieldPeriods(fixture.rows);

describe('voidageTerms and the ledger, hand oracle', () => {
  const ledger = buildVoidageLedger(periods, FVF);
  it('every term of every period', () => {
    expect(ledger.rows.map((r) => [r.oilRB, r.waterRB, r.freeGasMscf, r.freeGasRB, r.producedRB, r.injWaterRB, r.injGasRB, r.injectedRB])).toEqual([
      [18000, 3000, 500, 450, 21450, 15000, 2700, 17700],
      [16200, 4000, 50, 45, 20245, 18000, 1800, 19800],
      [14400, 5000, 0, 0, 19400, 20000, 900, 20900],
    ].map((row) => row.map((v) => expect.closeTo(v, 9))));
  });
  it('totals close on the periods and on vrr.js', () => {
    expect(ledger.totals.producedRB).toBeCloseTo(61095, 9);
    expect(ledger.totals.injectedRB).toBeCloseTo(58400, 9);
    expect(ledger.totals.cumulativeVRR).toBeCloseTo(58400 / 61095, 12);
    expect(ledger.rows[2].cumulativeVRR).toBeCloseTo(58400 / 61095, 12);
    expect(ledger.closure).toBeLessThan(1e-12);
  });
  it('names the FVF set of each period and where it came from', () => {
    expect(ledger.rows[0].fvf).toEqual({ Bo: 1.2, Bw: 1.0, Bg: 0.9, Rs: 500 });
    expect(ledger.rows[0].fvfFrom).toEqual({ Bo: 'global', Bw: 'global', Bg: 'global', Rs: 'global' });
  });
});

describe('closure against vrr.js where the terms are large', () => {
  // the free gas term is small in the fixture; here it is most of the voidage,
  // and every period carries its own FVF set (the pressure track case)
  const big = [
    { label: '2025-01', Np: 10000, Wp: 500, Gp: 40000, Wi: 0, Gi: 30000, Bo: 1.31, Bg: 0.82, Rs: 610 },
    { label: '2025-02', Np: 9000, Wp: 900, Gp: 52000, Wi: 25000, Gi: 0, Bo: '1.29', Bw: '1.03', Bg: '0.95', Rs: '560' },
    { label: '2025-03', Np: 8000, Wp: 1500, Gp: 61000, Wi: 30000, Gi: 20000, Bg: '', Rs: null },
  ];
  const ledger = buildVoidageLedger(big, FVF);
  it('the terms sum to computeVRRSeries for every period to float noise', () => {
    const s = computeVRRSeries(big, FVF);
    ledger.rows.forEach((r, i) => {
      expect(r.producedRB).toBeCloseTo(s[i].producedVoidage, 9);
      expect(r.injectedRB).toBeCloseTo(s[i].injectedVoidage, 9);
      expect(r.cumulativeVRR).toBe(s[i].cumulativeVRR);
    });
    expect(ledger.closure).toBeLessThan(1e-12);
    // free gas 40,000 - 6,100 = 33,900 Mscf x 0.82 = 27,798 RB of 41,428 produced
    expect(ledger.rows[0].freeGasRB).toBeCloseTo(27798, 9);
  });
  it('a blank or null per-period value falls back to the global set, as vrr.js does', () => {
    expect(resolvePeriodFvf(FVF, big[2])).toMatchObject({ Bo: 1.2, Bg: 0.9, Rs: 500, from: { Bo: 'global', Bg: 'global', Rs: 'global' } });
    expect(resolvePeriodFvf(FVF, big[1])).toMatchObject({ Bo: 1.29, Bw: 1.03, from: { Bo: 'period', Bw: 'period' } });
  });
  it('free gas never goes negative', () => {
    expect(voidageTerms({ Np: 1000, Gp: 100 }, { Bo: 1, Bw: 1, Bg: 1, Rs: 500 }).freeGasMscf).toBe(0);
  });
});

describe('per-period FVFs in patterns and the injection advice', () => {
  const ALL = { id: 'all', name: 'Whole field', producers: ['P-1', 'P-2'] };
  const ALLOC = { 'I-1': { 'P-1': 0.6, 'P-2': 0.4 }, 'I-2': { 'P-1': 1.0 } };
  const track = { '2025-01': { Bo: 1.31, Bw: 1.02, Bg: 0.8, Rs: 600 }, '2025-02': { Bo: 1.29, Bw: 1.02, Bg: 0.9, Rs: 560 }, '2025-03': { Bo: 1.27, Bw: 1.02, Bg: 1.0, Rs: 520 } };

  it('INVARIANT: one pattern with all producers reproduces the field series under the same per-period FVFs', () => {
    const field = computeVRRSeries(applyPeriodFvf(periods, track), FVF);
    const pattern = computeVRRSeries(applyPeriodFvf(buildPatternPeriods(fixture.rows, ALL, ALLOC), track), FVF);
    pattern.forEach((p, i) => expect(p.cumulativeVRR).toBeCloseTo(field[i].cumulativeVRR, 12));
    // and differs from the constant set: the track moves the number
    expect(Math.abs(field[2].cumulativeVRR - computeVRRSeries(periods, FVF)[2].cumulativeVRR)).toBeGreaterThan(0.01);
  });

  it('the advice divides by the voidage the pattern shows (periodFvf), and without it keeps the old answer', () => {
    const withTrack = recommendPatternInjection(fixture.rows, ALL, ALLOC, FVF, { targetVRR: 1, windowPeriods: 3, periodFvf: track });
    const fieldTrack = computeVRRSeries(applyPeriodFvf(periods, track), FVF);
    expect(withTrack.currentVRR).toBeCloseTo(computeRollingVRR(fieldTrack, 3)[2], 12);
    const plain = recommendPatternInjection(fixture.rows, ALL, ALLOC, FVF, { targetVRR: 1, windowPeriods: 3 });
    expect(plain.currentVRR).toBeCloseTo(computeRollingVRR(computeVRRSeries(periods, FVF), 3)[2], 12);
    expect(withTrack.currentVRR).not.toBeCloseTo(plain.currentVRR, 3);
  });

  it('applyPeriodFvf leaves unlisted labels and null values alone', () => {
    const out = applyPeriodFvf([{ label: '2025-01', Np: 1 }, { label: 'constructor', Np: 2 }], { '2025-01': { Bo: 1.4, Bg: null } });
    expect(out[0]).toEqual({ label: '2025-01', Np: 1, Bo: 1.4 });
    expect(out[1]).toEqual({ label: 'constructor', Np: 2 });
  });
});
