// Checkshot conventions vs the closed-form oracle (PT0, 2026-09-03).
// test-data/wells/goldens/checkshots_cases.json is written by
// tools/validation/wells/oracle_checkshots.py from analytic trajectories.
import fs from 'fs';
import path from 'path';
import {
  makeDepthFrame, toStoredCheckshots, fromStoredCheckshots, rebaseStoredCheckshots,
  validateStoredCheckshots, makeCheckshotProvenance, PETREL_CHECKSHOT_CONVENTION, M_PER_FT,
} from '../engines/welldata/checkshots.js';

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'wells', 'goldens', 'checkshots_cases.json'), 'utf8'));
const TOL = golden.tolerance_m;
const byName = Object.fromEntries(golden.cases.map((c) => [c.name, c]));
const frameOf = (c, kb = c.kb_m, stations = c.stations) => makeDepthFrame({ deviation: stations, kbM: kb });

const expectRows = (rows, expected) => {
  expect(rows).toHaveLength(expected.length);
  rows.forEach((r, i) => {
    expect(Math.abs(r.tvdss_m - expected[i].tvdss_m)).toBeLessThanOrEqual(TOL);
    expect(r.twt_ms).toBe(expected[i].twt_ms);
    if ('md_m' in expected[i]) expect(Math.abs(r.md_m - expected[i].md_m)).toBeLessThanOrEqual(TOL);
    else expect(r).not.toHaveProperty('md_m');
  });
};

describe.each(golden.cases.filter((c) => c.kind === 'convert').map((c) => [c.name, c]))('convert %s', (_n, c) => {
  test('stored rows match the closed form; warnings name the flagged rows', () => {
    const { rows, warnings } = toStoredCheckshots(c.rows_in, c.convention, frameOf(c));
    expectRows(rows, c.expected.rows);
    for (const w of c.expected.warnings_contains) expect(warnings.join('\n')).toContain(w);
    if (!c.expected.warnings_contains.length) expect(warnings).toEqual([]);
    // the stored core validates and carries only the three keys
    for (const r of validateStoredCheckshots(rows)) expect(Object.keys(r).sort()).toEqual(expect.arrayContaining(['tvdss_m', 'twt_ms']));
  });
});

describe.each(golden.cases.filter((c) => c.kind === 'error').map((c) => [c.name, c]))('refusal %s', (_n, c) => {
  test('is a plain domain error without sorting', () => {
    expect(() => toStoredCheckshots(c.rows_in, c.convention, frameOf(c))).toThrow(c.expected_error_contains);
  });
});

describe.each(golden.cases.filter((c) => c.kind === 'rebase').map((c) => [c.name, c]))('rebase %s', (_n, c) => {
  test('re-derives per the entered reference', () => {
    const frame = frameOf(c, c.new_kb_m, c.new_stations || c.stations);
    const { rows, provenance } = rebaseStoredCheckshots(c.stored, c.provenance, frame);
    expectRows(rows, c.expected_rows);
    expect(provenance.kb_m_used).toBe(c.new_kb_m);
    expect(provenance.units_in).toEqual(c.provenance.units_in);
  });
});

test('vertical wells: MD = TVD, TVDSS = MD - KB in m and ft', () => {
  const f = makeDepthFrame({ deviation: [], kbM: 30 });
  expect(f.isVertical).toBe(true);
  expect(f.mdToTvdss(1000)).toEqual({ tvd: 1000, tvdss: 970, extrapolated: false });
  expect(f.tvdssToMd(970)).toEqual({ md: 1000, ambiguous: false, extrapolated: false });
  const { rows } = toStoredCheckshots([{ depth: 1000, time: 100 }, { depth: 2000, time: 180 }], { depthRef: 'md', time: 'owt', depthUnit: 'ft' }, f);
  expect(rows[0].md_m).toBe(1000 * M_PER_FT);
  expect(rows[0].twt_ms).toBe(200);
});

test('display round trip: MD ft / OWT typed values come back to 1e-9', () => {
  const c = byName.buildhold_md_owt;
  const f = frameOf(c);
  const typed = [{ depth: 820, time: 120 }, { depth: 2001, time: 262 }, { depth: 3937, time: 425 }];
  const conv = { depthRef: 'md', time: 'owt', depthUnit: 'ft' };
  const { rows } = toStoredCheckshots(typed, conv, f);
  const back = fromStoredCheckshots(rows, conv, f);
  back.forEach((b, i) => {
    expect(Math.abs(b.depth - typed[i].depth)).toBeLessThan(1e-9);
    expect(b.time).toBe(typed[i].time);
    expect(b.owt_ms).toBe(typed[i].time);
  });
});

test('legacy rows without md_m display through the analytic inverse; the uphill case is flagged ambiguous', () => {
  const c = byName.uphill_ambiguous;
  const f = frameOf(c);
  const legacy = c.expected.rows.map(({ tvdss_m, twt_ms }) => ({ tvdss_m, twt_ms }));
  const shown = fromStoredCheckshots(legacy, PETREL_CHECKSHOT_CONVENTION, f);
  expect(shown[1].ambiguous).toBe(true);
  expect(Math.abs(shown[1].md_m - c.expected.all_mds_row2[0])).toBeLessThanOrEqual(TOL);
});

test('a survey starting below KB is assumed vertical to its first station', () => {
  const f = makeDepthFrame({ deviation: [{ md: 100, inc: 0, azi: 0 }, { md: 400, inc: 0, azi: 0 }], kbM: 10 });
  expect(f.assumedVerticalToFirstStation).toBe(true);
  expect(f.mdToTvdss(50).tvd).toBeCloseTo(50, 9);
  expect(f.mdToTvdss(300).tvdss).toBeCloseTo(290, 9);
});

test('provenance records the convention, KB and station count', () => {
  const p = makeCheckshotProvenance({ depthRef: 'md', time: 'owt', depthUnit: 'ft' }, { source: 'well-import', kbM: 30, stations: 12, now: new Date('2026-09-03T00:00:00Z') });
  expect(p).toEqual({ units_in: { depth_ref: 'md', time: 'owt', depth_unit: 'ft' }, source: 'well-import', kb_m_used: 30, deviation_stations_used: 12, edited_at: '2026-09-03T00:00:00.000Z' });
  expect(() => makeCheckshotProvenance({ depthRef: 'depth' })).toThrow(/depth reference/);
});
