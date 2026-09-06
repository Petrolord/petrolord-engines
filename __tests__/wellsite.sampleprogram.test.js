/** WS3 sampling programme and sample lifecycle. */
import {
  SAMPLE_STAGES, validateProgramme, scheduledDepths, applyProgrammeChange, statusConfig, highestStage, canAdvance, advance,
  dueState, inTransit, expectedArrivals,
} from '../engines/wellsite/sampleProgram';

const FT = 0.3048;
const IN = 0.0254;
const MIN = 60000;
const T0 = Date.parse('2026-09-07T06:00:00Z');

test('programme validation and scheduled depths: every 10 ft to 5000 then every 5 ft', () => {
  const p = { version: 1, rows: [{ fromMdM: 0, toMdM: 5000 * FT, intervalM: 10 * FT }, { fromMdM: 5000 * FT, toMdM: null, intervalM: 5 * FT }] };
  expect(validateProgramme(p)).toEqual([]);
  const d = scheduledDepths(p, { fromMdM: 0, toMdM: 10000 * FT });
  expect(d).toHaveLength(500 + 1000);
  expect(d[499].mdM / FT).toBeCloseTo(5000, 6);
  expect(d[500].mdM / FT).toBeCloseTo(5005, 6);
  expect(d[500].rowIndex).toBe(1);
  expect(scheduledDepths(p, { fromMdM: 9990 * FT, toMdM: 10000 * FT }).map((x) => Math.round(x.mdM / FT))).toEqual([9990, 9995, 10000]);
  expect(validateProgramme({ rows: [] })).toEqual(['A sampling programme needs at least one row.']);
  expect(validateProgramme({ rows: [{ fromMdM: 0, toMdM: null, intervalM: 3 }, { fromMdM: 10, toMdM: 20, intervalM: 3 }] })).toContain('Row 1 is open-ended but is not the last row.');
  expect(validateProgramme({ rows: [{ fromMdM: 0, toMdM: 100, intervalM: 3 }, { fromMdM: 90, toMdM: 200, intervalM: 0 }] })).toEqual(['Row 2 needs a positive sample interval.', 'Row 2 overlaps row 1.']);
});

test('a programme change needs an authoriser and bumps the version', () => {
  const p = { version: 1, rows: [{ fromMdM: 0, toMdM: null, intervalM: 3 }] };
  expect(() => applyProgrammeChange(p, p.rows, { authorisedBy: '', atUtc: 'x' })).toThrow(/authorised/);
  const n = applyProgrammeChange(p, [{ fromMdM: 0, toMdM: null, intervalM: 1.5 }], { authorisedBy: 'Ops geologist', atUtc: '2026-09-07T00:00:00Z', reason: 'Approaching the target' });
  expect(n.version).toBe(2);
  expect(n.authorisedBy).toBe('Ops geologist');
  expect(() => applyProgrammeChange(p, [{ fromMdM: 0, toMdM: 5, intervalM: 0 }], { authorisedBy: 'x', atUtc: 'x' })).toThrow(/positive sample interval/);
});

test('status is the highest stage; mandatory stages cannot be skipped; others can', () => {
  const cfg = statusConfig({ mandatory: ['caught', 'described', 'bagged'] });
  expect(SAMPLE_STAGES[0]).toBe('scheduled');
  expect(highestStage([])).toBe('scheduled');
  expect(highestStage([{ stage: 'caught' }, { stage: 'dried' }])).toBe('dried');
  expect(canAdvance([], 'caught', cfg)).toEqual({ ok: true, reason: '' });
  expect(canAdvance([], 'described', cfg)).toEqual({ ok: false, reason: 'Stage described needs the mandatory stage caught first.' });
  expect(canAdvance([{ stage: 'caught' }], 'described', cfg).ok).toBe(true);
  expect(canAdvance([{ stage: 'caught' }], 'photographed', cfg).ok).toBe(false);
  expect(canAdvance([{ stage: 'caught' }, { stage: 'described' }], 'bagged', cfg).ok).toBe(true);
  expect(canAdvance([{ stage: 'caught' }], 'caught', cfg).reason).toBe('The sample is already caught.');
  expect(canAdvance([], 'lost', cfg).reason).toBe('Unknown stage lost.');
  expect(advance([], 'caught', { atUtc: 'now', by: 'me' }, cfg)).toEqual({ stage: 'caught', atUtc: 'now', by: 'me', note: null });
  expect(() => advance([], 'bagged', { atUtc: 'now', by: 'me' }, cfg)).toThrow(/mandatory stage caught/);
});

test('due state: scheduled, in transit, due, overdue after the tolerance, never missed', () => {
  const s = { mdM: 100 };
  expect(dueState(s, { bitMdM: 90, nowUtcMs: T0 }).state).toBe('scheduled');
  expect(dueState(s, { bitMdM: 110, nowUtcMs: T0, arrivalUtcMs: null }).state).toBe('in_transit');
  expect(dueState(s, { bitMdM: 110, nowUtcMs: T0, arrivalUtcMs: T0 + 10 * MIN }).state).toBe('in_transit');
  expect(dueState(s, { bitMdM: 110, nowUtcMs: T0 + 5 * MIN, arrivalUtcMs: T0 }).state).toBe('due');
  const od = dueState(s, { bitMdM: 110, nowUtcMs: T0 + 20 * MIN, arrivalUtcMs: T0, toleranceMin: 15 });
  expect(od.state).toBe('overdue');
  expect(od.minutesPastArrival).toBe(20);
  expect(dueState(s, { bitMdM: 110, nowUtcMs: T0 + 60 * MIN, arrivalUtcMs: T0, stages: [{ stage: 'caught' }] }).state).toBe('caught');
  expect(String(dueState)).not.toMatch(/missed/);
});

test('in transit and expected arrivals from the bit history and pump log', () => {
  const ctx = { geometry: [{ from_md_m: 0, to_md_m: 4000, cased: false, hole_id_m: 12.25 * IN }], bha: [], drillpipe: { odM: 5 * IN, idM: 4.276 * IN }, stations: null, m3PerStroke: 0.0161796 };
  const samples = [{ id: 'a', mdM: 3000, stages: [] }, { id: 'b', mdM: 3010, stages: [] }, { id: 'c', mdM: 3020, stages: [{ stage: 'caught' }] }, { id: 'd', mdM: 3100, stages: [] }];
  expect(inTransit(samples, { bitMdM: 3050, laggedMdM: 3005 }).map((s) => s.id)).toEqual(['b']);
  const hist = [{ utcMs: T0, mdM: 2990 }, { utcMs: T0 + 120 * MIN, mdM: 3050 }];
  const log = [{ utcMs: T0, spm: 60 }];
  const arr = expectedArrivals(samples, { bitDepthHistory: hist, pumpLog: log, lagCtx: ctx, nowUtcMs: T0 + 120 * MIN });
  expect(arr[3].note).toBe('Not yet drilled.');
  expect(arr[0].cutUtcMs).toBeCloseTo(T0 + 20 * MIN, -2);
  const lagMin = (3000 * Math.PI / 4 * ((12.25 * IN) ** 2 - (5 * IN) ** 2)) / 0.0161796 / 60;
  expect((arr[0].arrivalUtcMs - arr[0].cutUtcMs) / MIN).toBeCloseTo(lagMin, 6);
  expect(arr[1].arrivalUtcMs).toBeGreaterThan(arr[0].arrivalUtcMs);
});
