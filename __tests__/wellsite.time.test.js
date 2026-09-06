/** Wellsite WS0 time model: UTC plus rig offset, tours and report days by arithmetic. */
import {
  toRigLocal, fromRigLocal, tourAt, previousTours, reportPeriod, assertUtc, nowStamp, offsetLabel, durationMin,
} from '../engines/wellsite/time';

const utc = (s) => Date.parse(s);

test('rig local wall clock is pure arithmetic on the offset', () => {
  const l = toRigLocal(utc('2026-09-06T04:59:00Z'), 60);
  expect(l.iso).toBe('2026-09-06T05:59:00');
  expect(l.hhmm).toBe('05:59');
  expect(l.dateIso).toBe('2026-09-06');
  const w = toRigLocal(utc('2026-09-06T03:30:00Z'), -300);
  expect(w.iso).toBe('2026-09-05T22:30:00');
  expect(fromRigLocal('2026-09-05T22:30', -300)).toBe(utc('2026-09-06T03:30:00Z'));
  expect(fromRigLocal('2026-09-06T05:59:30', 60)).toBe(utc('2026-09-06T04:59:30Z'));
  expect(fromRigLocal('nonsense', 0)).toBeNull();
  expect(offsetLabel(60)).toBe('UTC+01:00');
  expect(offsetLabel(-330)).toBe('UTC-05:30');
  expect(durationMin(utc('2026-09-06T00:00:00Z'), utc('2026-09-06T01:30:00Z'))).toBe(90);
});

describe('tours (06:00 and 18:00 rig local)', () => {
  const cfg = { offsetMin: 60, tourStartsLocal: ['06:00', '18:00'] };
  test('05:59 local belongs to the previous day night tour', () => {
    const t = tourAt(utc('2026-09-06T04:59:00Z'), cfg);
    expect(t.label).toBe('Night');
    expect(t.startLocal).toBe('2026-09-05T18:00:00');
    expect(t.endLocal).toBe('2026-09-06T06:00:00');
  });
  test('06:00 local starts the day tour', () => {
    const t = tourAt(utc('2026-09-06T05:00:00Z'), cfg);
    expect(t.label).toBe('Day');
    expect(t.startLocal).toBe('2026-09-06T06:00:00');
    expect(t.endLocal).toBe('2026-09-06T18:00:00');
    expect(t.index).toBe(0);
  });
  test('an offset west of UTC crossing midnight UTC still resolves by rig time', () => {
    const w = { offsetMin: -300, tourStartsLocal: ['06:00', '18:00'] };
    const t = tourAt(utc('2026-09-06T03:30:00Z'), w); // 22:30 local on the 5th
    expect(t.label).toBe('Night');
    expect(t.startLocal).toBe('2026-09-05T18:00:00');
    expect(t.startUtc).toBe(utc('2026-09-05T23:00:00Z'));
  });
  test('previous tours are the completed ones, most recent first', () => {
    const now = utc('2026-09-06T09:00:00Z'); // 10:00 local, day tour in progress
    const p = previousTours(now, cfg, { count: 2 });
    expect(p.map((t) => t.label)).toEqual(['Night', 'Day']);
    expect(p[0].endLocal).toBe('2026-09-06T06:00:00');
    expect(p[1].startLocal).toBe('2026-09-05T06:00:00');
    const atBoundary = previousTours(utc('2026-09-06T05:00:00Z'), cfg, { count: 1 });
    expect(atBoundary[0].label).toBe('Night');
    expect(atBoundary[0].endLocal).toBe('2026-09-06T06:00:00');
  });
  test('three tours label by number', () => {
    const t = tourAt(utc('2026-09-06T12:00:00Z'), { offsetMin: 0, tourStartsLocal: ['00:00', '08:00', '16:00'] });
    expect(t.label).toBe('Tour 2');
  });
});

test('report day runs from the configured local start', () => {
  const cfg = { offsetMin: 60, reportDayStartLocal: '06:00' };
  const p = reportPeriod(utc('2026-09-06T04:59:00Z'), cfg); // 05:59 local: still the 5th
  expect(p.dateLabel).toBe('2026-09-05');
  expect(p.startUtc).toBe(utc('2026-09-05T05:00:00Z'));
  expect(p.endUtc).toBe(utc('2026-09-06T05:00:00Z'));
  expect(reportPeriod(utc('2026-09-06T05:00:00Z'), cfg).dateLabel).toBe('2026-09-06');
});

test('records must carry UTC and an in-range offset', () => {
  expect(assertUtc({})).toHaveLength(2);
  expect(assertUtc({ occurred_at: '2026-09-06T00:00:00Z', local_offset_min: 61 })).toEqual([]);
  expect(assertUtc({ occurred_at: '2026-09-06T00:00:00Z', local_offset_min: 1000 })).toHaveLength(1);
  expect(assertUtc({ occurred_at: 'soon', local_offset_min: 0 })).toHaveLength(1);
  expect(nowStamp(60, utc('2026-09-06T00:00:00Z'))).toEqual({ occurred_at: '2026-09-06T00:00:00.000Z', local_offset_min: 60 });
});
