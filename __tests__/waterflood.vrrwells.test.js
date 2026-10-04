// Gates for VRR-U2-002 (per-well free gas) and VRR-U2-004 (voidage by well
// for the bubble map): vrrLedger.js buildWellVoidage. vrr.js is untouched;
// every gate calls the shipped function and holds it against vrr.js
// computeVRRSeries and buildVoidageLedger.
//
// Hand oracle on the V2 fixture (Bo 1.2, Bw 1.0, Bg 0.9 RB/Mscf, Rs 500 scf/STB).
// Free gas per well = max(0, Gp - Rs Np / 1000), each well on its own:
//   2025-01  P-1 6,000 - 5,000 = 1,000; P-2 2,000 - 2,500 -> 0     (field nets 500)
//   2025-02  P-1 5,000 - 4,500 =   500; P-2 1,800 - 2,250 -> 0     (field nets 50)
//   2025-03  P-1 4,200 - 4,000 =   200; P-2 1,500 - 2,000 -> 0     (field nets 0)
//   per well 1,700 Mscf x 0.9 = 1,530 RB; field 550 Mscf x 0.9 = 495 RB
//   produced, per-well free gas: 21,900 + 20,650 + 19,580 = 62,130 RB
//   cumulative VRR with per-well free gas 58,400 / 62,130 = 0.939964590375...
import fs from 'fs';
import path from 'path';
import { buildWellVoidage, buildFieldPeriods, buildVoidageLedger } from '../engines/waterflood/vrrLedger.js';
import { computeVRRSeries } from '../engines/waterflood/vrr.js';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/waterflood/vrr-ledger-fixture.json'), 'utf8'));
const FVF = fixture.fvf;

describe('buildWellVoidage, hand oracle', () => {
  const w = buildWellVoidage(fixture.rows, FVF);
  it('free gas of each well, each month, on its own floor', () => {
    expect(w.periods.map((p) => [p.label, p.freeGasMscfField, p.freeGasMscfByWell])).toEqual([
      ['2025-01', expect.closeTo(500, 9), expect.closeTo(1000, 9)],
      ['2025-02', expect.closeTo(50, 9), expect.closeTo(500, 9)],
      ['2025-03', expect.closeTo(0, 9), expect.closeTo(200, 9)],
    ]);
    const p1 = w.wells.find((x) => x.well === 'P-1');
    const p2 = w.wells.find((x) => x.well === 'P-2');
    expect(p1.freeGasMscf).toBeCloseTo(1700, 9);
    expect(p2.freeGasMscf).toBe(0);
    expect(p1.type).toBe('producer');
  });
  it('produced voidage and VRR with per-well free gas', () => {
    expect(w.periods.map((p) => p.producedRBByWell)).toEqual([21900, 20650, 19580].map((v) => expect.closeTo(v, 9)));
    expect(w.totals.freeGasRBByWell).toBeCloseTo(1530, 9);
    expect(w.totals.freeGasRBField).toBeCloseTo(495, 9);
    expect(w.totals.producedRBByWell).toBeCloseTo(62130, 9);
    expect(w.totals.producedRBField).toBeCloseTo(61095, 9);
    expect(w.totals.cumulativeVRRByWell).toBeCloseTo(58400 / 62130, 12);
    expect(w.totals.cumulativeVRRField).toBeCloseTo(58400 / 61095, 12);
  });
  it('voidage of every well: producers produce, injectors inject', () => {
    const byName = Object.fromEntries(w.wells.map((x) => [x.well, x]));
    expect(byName['P-1'].producedRB).toBeCloseTo(27000 * 1.2 + 7500 + 1530, 9);
    expect(byName['P-2'].producedRB).toBeCloseTo(13500 * 1.2 + 4500, 9);
    expect(byName['I-1'].injectedRB).toBeCloseTo(53000, 9);
    expect(byName['I-2'].injectedRB).toBeCloseTo(6000 * 0.9, 9);
    expect(byName['I-1'].type).toBe('injector');
    expect(w.wells.map((x) => x.well)).toEqual(['I-1', 'I-2', 'P-1', 'P-2']);
  });
});

describe('invariants against vrr.js', () => {
  it('oil, water and injection by well sum to the field ledger to float noise', () => {
    const w = buildWellVoidage(fixture.rows, FVF);
    const field = buildVoidageLedger(buildFieldPeriods(fixture.rows), FVF);
    const sum = (k) => w.wells.reduce((s, x) => s + x[k], 0);
    expect(sum('oilRB')).toBeCloseTo(field.totals.oilRB, 9);
    expect(sum('waterRB')).toBeCloseTo(field.totals.waterRB, 9);
    expect(sum('injectedRB')).toBeCloseTo(field.totals.injectedRB, 9);
    expect(w.totals.producedRBField).toBeCloseTo(field.totals.producedRB, 9);
  });
  it('one producing well: per-well free gas equals the field figure exactly', () => {
    const one = fixture.rows.filter((r) => r.well !== 'P-2');
    const w = buildWellVoidage(one, FVF);
    const s = computeVRRSeries(buildFieldPeriods(one), FVF);
    w.periods.forEach((p, i) => {
      expect(p.freeGasMscfByWell).toBe(p.freeGasMscfField);
      expect(p.producedRBByWell).toBeCloseTo(s[i].producedVoidage, 9);
    });
    expect(w.totals.cumulativeVRRByWell).toBeCloseTo(s[s.length - 1].cumulativeVRR, 12);
  });
  it('per-well free gas is never below the field figure, period by period', () => {
    const w = buildWellVoidage(fixture.rows, FVF);
    w.periods.forEach((p) => expect(p.freeGasMscfByWell).toBeGreaterThanOrEqual(p.freeGasMscfField - 1e-9));
  });
  it('a per-period FVF set by label applies to every well of that month (the pressure track)', () => {
    const byLabel = { '2025-02': { Bo: 1.3, Bw: 1.01, Bg: 1.1, Rs: 420 } };
    const w = buildWellVoidage(fixture.rows, FVF, byLabel);
    // P-1 Feb: 5,000 - 420 x 9 = 1,220; P-2 Feb: 1,800 - 420 x 4.5 = -90 -> 0
    expect(w.periods[1].freeGasMscfByWell).toBeCloseTo(1220, 9);
    const fieldFeb = buildVoidageLedger([{ ...buildFieldPeriods(fixture.rows)[1], ...byLabel['2025-02'] }], FVF).rows[0];
    expect(w.periods[1].producedRBField).toBeCloseTo(fieldFeb.producedRB, 9);
    expect(w.periods[1].fvf).toEqual({ Bo: 1.3, Bw: 1.01, Bg: 1.1, Rs: 420 });
  });
  it('rows without a month or a well are left out; an empty ledger gives nulls', () => {
    const w = buildWellVoidage([{ date: 'x', well: 'A', oil_stb: 5 }, { date: '2025-01', well: '', oil_stb: 5 }], FVF);
    expect(w.wells).toEqual([]);
    expect(w.totals.cumulativeVRRByWell).toBeNull();
  });
});
