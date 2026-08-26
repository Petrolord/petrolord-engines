// Gates for the V3 vrrLedger pressure/fill-up/FVF-track additions.
// Pressure oracle: surveys 3000 psia @ 2025-01-01 and 2700 psia @
// 2025-05-01 span exactly 4 month-coordinates, so the track declines
// 75 psi/month and the Jan..Apr mid-month pressures are
// 2962.5 / 2887.5 / 2812.5 / 2737.5.
import {
  monthCoordOf, attachPressure, findFillUp, interpolateFvfTrack,
} from '../engines/waterflood/vrrLedger.js';
import { computeVRRSeries } from '../engines/waterflood/vrr.js';

const SURVEYS = [
  { date: '2025-01-01', p_psia: 3000 },
  { date: '2025-05-01', p_psia: 2700 },
];
const PERIODS = ['2025-01', '2025-02', '2025-03', '2025-04'].map((label) => ({ label }));

// Bg=0/Rs=0 keeps voidage arithmetic trivial: produced = Np, injected = Wi.
const UNIT_FVF = { Bo: 1, Bw: 1, Bg: 0, Rs: 0 };

describe('monthCoordOf', () => {
  it('is pure string arithmetic with a deterministic day fraction', () => {
    expect(monthCoordOf('2025-01')).toBe(2025 * 12);
    expect(monthCoordOf('2025-01-01')).toBe(2025 * 12);
    expect(monthCoordOf('2025-02-01')).toBe(2025 * 12 + 1);
    expect(monthCoordOf('2025-01-16')).toBeCloseTo(2025 * 12 + 15 / 31, 12);
    expect(monthCoordOf('garbage')).toBe(null);
    expect(monthCoordOf('2025-13')).toBe(null);
  });
});

describe('attachPressure', () => {
  it('interpolates the survey line onto mid-month coordinates', () => {
    const withP = attachPressure(PERIODS, SURVEYS);
    expect(withP.map((p) => p.pressure)).toEqual([2962.5, 2887.5, 2812.5, 2737.5]);
  });

  it('computes dp/dt in psi/month (one-sided at the ends)', () => {
    const withP = attachPressure(PERIODS, SURVEYS);
    withP.forEach((p) => expect(p.dpdt).toBeCloseTo(-75, 9));
  });

  it('clamps flat outside the survey range', () => {
    const withP = attachPressure(
      [{ label: '2024-11' }, { label: '2025-07' }],
      SURVEYS,
    );
    expect(withP[0].pressure).toBe(3000);
    expect(withP[1].pressure).toBe(2700);
    // A single period has no neighbor to difference against: dpdt null.
    expect(attachPressure([{ label: '2025-02' }], SURVEYS)[0].dpdt).toBe(null);
  });

  it('yields nulls for non-month labels and empty surveys, never throws', () => {
    expect(attachPressure([{ label: 'P1' }], SURVEYS)[0]).toMatchObject({ pressure: null, dpdt: null });
    expect(attachPressure(PERIODS, [])[0]).toMatchObject({ pressure: null, dpdt: null });
    expect(attachPressure(PERIODS, [{ date: 'bad', p_psia: 'x' }])[0].pressure).toBe(null);
  });

  it('does not mutate its inputs', () => {
    const periods = [{ label: '2025-01' }];
    attachPressure(periods, SURVEYS);
    expect(periods[0]).toEqual({ label: '2025-01' });
  });
});

describe('findFillUp', () => {
  it('finds the first cumulative-VRR >= 1 crossing from below', () => {
    const series = computeVRRSeries([
      { label: '2025-01', Np: 100, Wp: 0, Gp: 0, Wi: 50, Gi: 0 },   // cum 0.5
      { label: '2025-02', Np: 100, Wp: 0, Gp: 0, Wi: 200, Gi: 0 },  // cum 1.25
      { label: '2025-03', Np: 100, Wp: 0, Gp: 0, Wi: 100, Gi: 0 },
    ], UNIT_FVF);
    expect(findFillUp(series)).toEqual({ index: 1, label: '2025-02', startedAbove: false });
  });

  it('returns null when cumulative VRR never reaches 1', () => {
    const series = computeVRRSeries([
      { label: '2025-01', Np: 100, Wp: 0, Gp: 0, Wi: 50, Gi: 0 },
      { label: '2025-02', Np: 100, Wp: 0, Gp: 0, Wi: 60, Gi: 0 },
    ], UNIT_FVF);
    expect(findFillUp(series)).toBe(null);
  });

  it('flags records that begin already above 1 (crossing not in the record)', () => {
    const series = computeVRRSeries([
      { label: '2025-01', Np: 100, Wp: 0, Gp: 0, Wi: 200, Gi: 0 },
    ], UNIT_FVF);
    expect(findFillUp(series)).toEqual({ index: 0, label: '2025-01', startedAbove: true });
  });

  it('skips undefined leading periods (no production yet)', () => {
    const series = computeVRRSeries([
      { label: '2025-01', Np: 0, Wp: 0, Gp: 0, Wi: 100, Gi: 0 },    // cum null
      { label: '2025-02', Np: 100, Wp: 0, Gp: 0, Wi: 50, Gi: 0 },   // cum 1.5 (inj carried)
    ], UNIT_FVF);
    expect(findFillUp(series)).toEqual({ index: 1, label: '2025-02', startedAbove: true });
  });
});

describe('interpolateFvfTrack', () => {
  const TABLE = [
    { p: 2000, Bo: 1.3, Bw: 1.02, Bg: 1.1, Rs: 600 },
    { p: 3000, Bo: 1.25, Bw: 1.01, Bg: 0.9, Rs: 500 },
  ];

  it('interpolates linearly between table rows', () => {
    const [f] = interpolateFvfTrack(TABLE, [2500]);
    expect(f.Bo).toBeCloseTo(1.275, 12);
    expect(f.Bw).toBeCloseTo(1.015, 12);
    expect(f.Bg).toBeCloseTo(1.0, 12);
    expect(f.Rs).toBeCloseTo(550, 12);
  });

  it('clamps flat outside the table range', () => {
    const [lo, hi] = interpolateFvfTrack(TABLE, [1500, 3500]);
    expect(lo).toEqual({ Bo: 1.3, Bw: 1.02, Bg: 1.1, Rs: 600 });
    expect(hi).toEqual({ Bo: 1.25, Bw: 1.01, Bg: 0.9, Rs: 500 });
  });

  it('maps null/invalid pressures to null and tolerates an empty table', () => {
    expect(interpolateFvfTrack(TABLE, [null, 'x'])).toEqual([null, null]);
    expect(interpolateFvfTrack([], [2500])).toEqual([null]);
  });
});
