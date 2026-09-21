/** WS7 and WS8 report models against the synthetic report day; every fact cites its records; narratives are records. */
import g from '../test-data/wellsite/report-day.json';
import { buildReportModel, handoverPeriod, dailyPeriod, validateTemplate, citedIds, canonicalJson, fnv1a64, HANDOVER_TEMPLATE, DEFAULT_DAILY_TEMPLATE } from '../engines/wellsite/reports';

const FT = 0.3048;
const now = Date.parse(g.nowUtc);
const tourCfg = { offsetMin: g.offsetMin, tourStartsLocal: g.well.settings.tour_starts_local, reportDayStartLocal: g.well.settings.report_day_start_local };
const section = (m, id) => m.sections.find((s) => s.id === id);
const near = (a, b, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

test('templates validate; a bad one says why', () => {
  expect(validateTemplate(HANDOVER_TEMPLATE)).toEqual([]);
  expect(validateTemplate(DEFAULT_DAILY_TEMPLATE)).toEqual([]);
  expect(validateTemplate({ id: 'x', sections: [{ id: 'a', title: 'A', source: 'weather' }, { id: 'a', title: 'B', source: 'status' }, { id: 'n', title: 'N', source: 'narrative' }] })).toEqual([
    'Section a has an unknown source weather.', 'Section id a is used twice.', 'Section n needs the narrative key it edits.',
  ]);
});

test('the day tour handover: periods, counts, drilled interval, tops, events by type, the narrative record', () => {
  // the handover of the tour that ended at 18:00 rig local (05:00 UTC next day is the night tour end; ask at 18:30 local)
  const at1830 = Date.parse('2026-09-07T17:30:00Z');
  const period = handoverPeriod(at1830, tourCfg);
  expect(new Date(period.startUtc).toISOString()).toBe(g.expected.dayTour.period.start);
  expect(new Date(period.endUtc).toISOString()).toBe(g.expected.dayTour.period.end);
  const m = buildReportModel({ kind: 'handover', period, well: g.well, data: g.data, nowUtcMs: at1830, offsetMin: g.offsetMin });
  const e = g.expected.dayTour;
  expect(section(m, 'tops').rows).toHaveLength(e.topsCalled);
  expect(section(m, 'shows').rows).toHaveLength(e.shows);
  expect(section(m, 'gas').rows).toHaveLength(e.gasRows);
  expect(section(m, 'observations').rows).toHaveLength(e.otherObservations);
  expect(section(m, 'events').rows).toHaveLength(e.events);
  const drilled = section(m, 'drilled').rows;
  near(drilled[2].value_m / FT, e.made_ft, 1e-6);
  const samples = Object.fromEntries(section(m, 'samples').rows.map((r) => [r.label, Number(r.text)]));
  expect(samples['Caught in the period']).toBe(e.caught);
  expect(samples['Described in the period']).toBe(e.described);
  expect(samples['Bagged in the period']).toBe(e.bagged);
  const ev = Object.fromEntries(section(m, 'events').summary.map((x) => [x.label, x.text]));
  expect(ev.Connection).toBe(`${e.connectionMinutes} min`);
  expect(ev.Circulation).toBe(`${e.circulationMinutes} min`);
  expect(section(m, 'summary')).toMatchObject({ kind: 'narrative', text: e.narrative, refs: ['narr-day'], editable: true });
  expect(section(m, 'watch').text).toBe('');
  const status = Object.fromEntries(section(m, 'status').rows.map((r) => [r.label, r]));
  near(status['Bit depth'].value_m / FT, 10440, 1e-6);
  expect(status['Current formation'].text).toBe('Top Agbada (confirmed)');
  expect(status['Current lithology'].text).toMatch(/SST|SH/);
  // every fact cites a record
  for (const s of m.sections) for (const r of s.rows || []) expect(Array.isArray(r.refs)).toBe(true);
  expect(citedIds(m)).toEqual(expect.arrayContaining(['top-c1', 'top-c2', 'narr-day', 'ev-circ', 'show-0']));
  expect(citedIds(m)).not.toContain('narr-night-v2');
});

test('the night tour handover cites the head narrative version and the open sweep', () => {
  const period = handoverPeriod(now + 60000, tourCfg);
  expect(new Date(period.startUtc).toISOString()).toBe(g.expected.nightTour.period.start);
  const m = buildReportModel({ kind: 'handover', period, well: g.well, data: g.data, nowUtcMs: now + 60000, offsetMin: g.offsetMin });
  const e = g.expected.nightTour;
  expect(section(m, 'tops').rows).toHaveLength(e.topsCalled);
  expect(section(m, 'shows').rows).toHaveLength(e.shows);
  expect(section(m, 'gas').rows).toHaveLength(e.gasRows);
  expect(section(m, 'events').rows).toHaveLength(e.events);
  expect(section(m, 'summary')).toMatchObject({ text: e.narrative, refs: ['narr-night-v2'] });
  const open = section(m, 'events').rows.find((r) => r.cells[2] === 'Sweep');
  expect(open.cells[1]).toBe('open');
  expect(section(m, 'status').rows.find((r) => r.label === 'Current operation').text).toBe('Sweep');
});

test('the daily report on the generic template: the whole day, the lithology table, the peak gas, photos', () => {
  const period = dailyPeriod(Date.parse('2026-09-07T12:00:00Z'), tourCfg);
  expect(new Date(period.startUtc).toISOString()).toBe(g.expected.day.period.start);
  expect(new Date(period.endUtc).toISOString()).toBe(g.expected.day.period.end);
  expect(period.dateLabel).toBe('2026-09-07');
  const m = buildReportModel({ kind: 'daily', period, well: g.well, data: g.data, nowUtcMs: now, offsetMin: g.offsetMin });
  const e = g.expected.day;
  expect(m.template.id).toBe('generic-dgr');
  expect(section(m, 'tops').rows).toHaveLength(e.topsCalled);
  expect(section(m, 'shows').rows).toHaveLength(e.shows);
  expect(section(m, 'gas').rows).toHaveLength(e.gasRows);
  expect(section(m, 'gas').summary).toMatchObject({ label: 'Peak total gas', text: e.peakGas, refs: ['gas-11'] });
  expect(section(m, 'events').rows).toHaveLength(e.events);
  expect(section(m, 'photos').rows).toHaveLength(e.photos);
  expect(section(m, 'lithology').rows).toHaveLength(e.lithologyRows);
  near(section(m, 'drilled').rows[2].value_m / FT, e.made_ft, 1e-6);
  expect(m.counts.tops_called).toBe(2);
  // a reordered template changes the output without code
  const reordered = { ...DEFAULT_DAILY_TEMPLATE, id: 'acme-dgr', sections: [...DEFAULT_DAILY_TEMPLATE.sections].reverse().filter((s) => s.id !== 'photos') };
  const m2 = buildReportModel({ kind: 'daily', period, well: g.well, data: g.data, template: reordered, nowUtcMs: now, offsetMin: g.offsetMin });
  expect(m2.sections.map((s) => s.id)[0]).toBe('forecast');
  expect(m2.sections.some((s) => s.id === 'photos')).toBe(false);
  expect(() => buildReportModel({ kind: 'weekly', period, well: g.well, data: g.data, nowUtcMs: now })).toThrow('Unknown report kind weekly.');
});

test('the canonical form is stable under key order and hashes the same', () => {
  const a = { b: 1, a: [{ y: 2, x: 1 }], c: null };
  const b = { c: null, a: [{ x: 1, y: 2 }], b: 1 };
  expect(canonicalJson(a)).toBe(canonicalJson(b));
  expect(canonicalJson(a)).toBe('{"a":[{"x":1,"y":2}],"b":1,"c":null}');
  expect(fnv1a64(canonicalJson(a))).toBe(fnv1a64(canonicalJson(b)));
  expect(fnv1a64('a')).not.toBe(fnv1a64('b'));
  const period = dailyPeriod(Date.parse('2026-09-07T12:00:00Z'), tourCfg);
  const m1 = buildReportModel({ kind: 'daily', period, well: g.well, data: g.data, nowUtcMs: now, offsetMin: g.offsetMin });
  const m2 = buildReportModel({ kind: 'daily', period, well: g.well, data: g.data, nowUtcMs: now, offsetMin: g.offsetMin });
  expect(fnv1a64(canonicalJson(m1))).toBe(fnv1a64(canonicalJson(m2)));
});
