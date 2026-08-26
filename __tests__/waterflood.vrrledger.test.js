// Gates for the VRR ledger (per-well dated rows -> monthly periods -> VRR).
// Oracle: hand arithmetic over test-data/waterflood/vrr-ledger-fixture.json
// with the vrr.js free-gas physics (Bo 1.2, Bw 1.0, Bg 0.9 RB/Mscf, Rs 500):
//   2025-01: solution 500*15000/1000 = 7500, free 8000-7500 = 500
//            produced 15000*1.2 + 3000*1.0 + 500*0.9   = 21450 RB
//            injected 15000*1.0 + 3000*0.9             = 17700 RB
//   2025-02: solution 6750, free 50
//            produced 13500*1.2 + 4000 + 50*0.9        = 20245 RB
//            injected 18000 + 2000*0.9                 = 19800 RB
//   2025-03: solution 6000, free floored at 0 (5700 < 6000)
//            produced 12000*1.2 + 5000 + 0             = 19400 RB
//            injected 20000 + 1000*0.9                 = 20900 RB
import fs from 'fs';
import path from 'path';
import {
  monthKeyOf, classifyLedgerWells, buildFieldPeriods, computeRollingVRR, flagPeriods, analyzeLedger,
} from '../engines/waterflood/vrrLedger.js';
import { computeVRRSeries } from '../engines/waterflood/vrr.js';

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../test-data/waterflood/vrr-ledger-fixture.json'), 'utf8'));

const PROD = [21450, 20245, 19400];
const INJ = [17700, 19800, 20900];

describe('monthKeyOf', () => {
  it('keys on the YYYY-MM prefix without Date parsing', () => {
    expect(monthKeyOf('2025-01-31')).toBe('2025-01');
    expect(monthKeyOf('2025-01')).toBe('2025-01');
    expect(monthKeyOf('31/01/2025')).toBe(null);
    expect(monthKeyOf('')).toBe(null);
    expect(monthKeyOf(null)).toBe(null);
  });
});

describe('classifyLedgerWells', () => {
  it('classifies water and gas injectors and producers from the fixture', () => {
    const { injectors, producers } = classifyLedgerWells(fixture.rows);
    expect(injectors.sort()).toEqual(fixture.oracle.injectors);
    expect(producers.sort()).toEqual(fixture.oracle.producers);
  });

  it('recognizes a gas-only injector (no water injection at all)', () => {
    const { injectors } = classifyLedgerWells([
      { date: '2025-01-01', well: 'GI-1', oil_stb: 0, water_stb: 0, gas_mscf: 0, winj_stb: 0, ginj_mscf: 500 },
    ]);
    expect(injectors).toEqual(['GI-1']);
  });

  it('injection wins for a converted well (produced first, injects later)', () => {
    const { injectors, producers } = classifyLedgerWells([
      { date: '2025-01-01', well: 'X-1', oil_stb: 100, water_stb: 0, gas_mscf: 0, winj_stb: 0, ginj_mscf: 0 },
      { date: '2025-02-01', well: 'X-1', oil_stb: 0, water_stb: 0, gas_mscf: 0, winj_stb: 900, ginj_mscf: 0 },
    ]);
    expect(injectors).toEqual(['X-1']);
    expect(producers).toEqual([]);
  });
});

describe('buildFieldPeriods', () => {
  it('aggregates the fixture into the hand-computed monthly periods, ordered', () => {
    const periods = buildFieldPeriods(fixture.rows);
    expect(periods).toEqual(fixture.oracle.periods);
  });

  it('is order-independent: shuffled rows give identical periods', () => {
    const shuffled = [...fixture.rows].reverse();
    expect(buildFieldPeriods(shuffled)).toEqual(fixture.oracle.periods);
  });

  it('aggregates daily rows identically to one monthly row', () => {
    const monthly = buildFieldPeriods([
      { date: '2025-01', well: 'P-1', oil_stb: 3000, water_stb: 300, gas_mscf: 900, winj_stb: 0, ginj_mscf: 0 },
    ]);
    const daily = buildFieldPeriods([
      { date: '2025-01-05', well: 'P-1', oil_stb: 1000, water_stb: 100, gas_mscf: 300, winj_stb: 0, ginj_mscf: 0 },
      { date: '2025-01-15', well: 'P-1', oil_stb: 1000, water_stb: 100, gas_mscf: 300, winj_stb: 0, ginj_mscf: 0 },
      { date: '2025-01-25', well: 'P-1', oil_stb: 1000, water_stb: 100, gas_mscf: 300, winj_stb: 0, ginj_mscf: 0 },
    ]);
    expect(daily).toEqual(monthly);
  });

  it('ignores rows without a parseable month key and coerces bad volumes to 0', () => {
    const periods = buildFieldPeriods([
      { date: 'not-a-date', well: 'P-1', oil_stb: 999, water_stb: 0, gas_mscf: 0, winj_stb: 0, ginj_mscf: 0 },
      { date: '2025-01-01', well: 'P-1', oil_stb: 'abc', water_stb: 50, gas_mscf: null, winj_stb: 0, ginj_mscf: 0 },
    ]);
    expect(periods).toEqual([{ label: '2025-01', Np: 0, Wp: 50, Gp: 0, Wi: 0, Gi: 0 }]);
  });
});

describe('ledger -> computeVRRSeries (the untouched vrr.js core)', () => {
  it('reproduces the hand voidage oracle through the whole chain', () => {
    const series = computeVRRSeries(buildFieldPeriods(fixture.rows), fixture.fvf);
    series.forEach((p, i) => {
      expect(p.producedVoidage).toBeCloseTo(PROD[i], 6);
      expect(p.injectedVoidage).toBeCloseTo(INJ[i], 6);
    });
    const cum = series[2].cumulativeVRR;
    expect(cum).toBeCloseTo((17700 + 19800 + 20900) / (21450 + 20245 + 19400), 12);
    expect(cum).toBeCloseTo(fixture.oracle.cumulativeVRR_last, 9);
  });
});

describe('computeRollingVRR', () => {
  const series = computeVRRSeries(buildFieldPeriods(fixture.rows), fixture.fvf);

  it('uses partial trailing windows at the start (computeFieldVRR convention)', () => {
    const rolling = computeRollingVRR(series, 2);
    expect(rolling[0]).toBeCloseTo(17700 / 21450, 12);
    expect(rolling[1]).toBeCloseTo((17700 + 19800) / (21450 + 20245), 12);
    expect(rolling[2]).toBeCloseTo((19800 + 20900) / (20245 + 19400), 12);
  });

  it('window of 1 equals instantaneous VRR', () => {
    const rolling = computeRollingVRR(series, 1);
    series.forEach((p, i) => expect(rolling[i]).toBeCloseTo(p.instantaneousVRR, 12));
  });

  it('returns null (not 0) when the window produced no voidage', () => {
    const empty = computeVRRSeries([{ label: '2025-01', Np: 0, Wp: 0, Gp: 0, Wi: 100, Gi: 0 }], fixture.fvf);
    expect(computeRollingVRR(empty, 3)).toEqual([null]);
  });
});

describe('flagPeriods', () => {
  const series = computeVRRSeries(buildFieldPeriods(fixture.rows), fixture.fvf);

  it('flags against the default 1.0-1.2 operator band', () => {
    // instantaneous VRR: 0.825..., 0.978..., 1.077...
    expect(flagPeriods(series)).toEqual(['under', 'under', 'in-band']);
  });

  it('respects a custom band and marks boundaries inclusive', () => {
    expect(flagPeriods(series, { min: 0.9, max: 1.0 })).toEqual(['under', 'in-band', 'over']);
    const exact = computeVRRSeries([{ label: '2025-01', Np: 1000, Wp: 0, Gp: 0, Wi: 1200, Gi: 0 }], { Bo: 1.2, Bw: 1.0, Bg: 0, Rs: 0 });
    // VRR exactly 1.0 sits in-band at the lower boundary
    expect(flagPeriods(exact, { min: 1.0, max: 1.2 })).toEqual(['in-band']);
  });

  it('returns null where instantaneous VRR is undefined', () => {
    const empty = computeVRRSeries([{ label: '2025-01', Np: 0, Wp: 0, Gp: 0, Wi: 100, Gi: 0 }], fixture.fvf);
    expect(flagPeriods(empty)).toEqual([null]);
  });
});

describe('analyzeLedger', () => {
  it('bundles classification, periods, series, rolling and flags coherently', () => {
    const r = analyzeLedger(fixture.rows, fixture.fvf, { rollingWindow: 2, targetBand: { min: 1.0, max: 1.2 } });
    expect(r.injectors.sort()).toEqual(fixture.oracle.injectors);
    expect(r.periods).toEqual(fixture.oracle.periods);
    expect(r.series[2].cumulativeVRR).toBeCloseTo(fixture.oracle.cumulativeVRR_last, 9);
    expect(r.rolling[2]).toBeCloseTo((19800 + 20900) / (20245 + 19400), 12);
    expect(r.flags).toEqual(['under', 'under', 'in-band']);
  });
});
