/**
 * Wellsite WS0 depth structure against test-data/wellsite/ws0-goldens.json
 * (stdlib oracle tools/validation/wellsite/oracle_ws0.py) plus the
 * refusal rules that make a bare depth impossible.
 */
import g from '../test-data/wellsite/ws0-goldens.json';
import {
  validateDepth, toCanonicalMd, mdToTvd, tvdToMd, toDisplay, depthProvenance, recalculate,
  DEPTH_KINDS, M_PER_FT,
} from '../engines/wellsite/depth';
import { tvdAt } from '../engines/drilling/wellControl';

const near = (a, b, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('validateDepth refuses anything incomplete', () => {
  test('every field is mandatory and named in the error', () => {
    const r = validateDepth({ value: 100 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/unit/);
    expect(r.errors.join(' ')).toMatch(/reference/);
    expect(r.errors.join(' ')).toMatch(/datum/);
    expect(r.errors.join(' ')).toMatch(/kind/);
    expect(r.errors).toHaveLength(4);
  });
  test('units, references, datums and kinds are closed sets', () => {
    expect(validateDepth({ value: 1, unit: 'yd', reference: 'MD', datum: 'KB', kind: 'bit_depth' }).ok).toBe(false);
    expect(validateDepth({ value: 1, unit: 'm', reference: 'SSTVD', datum: 'KB', kind: 'bit_depth' }).ok).toBe(false);
    expect(validateDepth({ value: 1, unit: 'm', reference: 'MD', datum: 'DF', kind: 'bit_depth' }).ok).toBe(false);
    expect(validateDepth({ value: 1, unit: 'm', reference: 'MD', datum: 'KB', kind: 'sample' }).ok).toBe(false);
    for (const kind of DEPTH_KINDS) expect(validateDepth({ value: 1, unit: 'm', reference: 'MD', datum: 'KB', kind }).ok).toBe(true);
  });
  test('TVDSS must be from MSL', () => {
    const r = validateDepth({ value: 1, unit: 'm', reference: 'TVDSS', datum: 'KB', kind: 'event' });
    expect(r.errors).toEqual(['TVDSS is measured from MSL, choose datum MSL.']);
  });
  test('a well without a KB elevation cannot store depths', () => {
    const r = toCanonicalMd({ value: 1, unit: 'm', reference: 'MD', datum: 'KB', kind: 'event' }, {});
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/KB elevation/);
  });
});

describe('vertical well golden (KB 25 m, GL 4 m)', () => {
  const ctx = { kbElevM: g.vertical.kbElevM, glElevM: g.vertical.glElevM, survey: null };
  test('3000 ft MD below GL is 935.4 m MD below KB, method vertical', () => {
    const r = toCanonicalMd(g.vertical.entry, ctx, { atUtc: '2026-09-06T00:00:00Z' });
    expect(r.ok).toBe(true);
    near(r.mdM, g.vertical.expected.mdM);
    near(r.calculated.tvdM, g.vertical.expected.tvdM);
    near(r.calculated.tvdssM, g.vertical.expected.tvdssM);
    expect(r.calculated.method).toBe('vertical');
    expect(r.calculated.surveyVersion).toBeNull();
    expect(r.calculated.computedAtUtc).toBe('2026-09-06T00:00:00Z');
    expect(r.original).toEqual(g.vertical.entry);
    expect(r.warnings).toEqual([]);
  });
  test('GL datum without a ground level is refused', () => {
    const r = toCanonicalMd(g.vertical.entry, { kbElevM: 25, survey: null });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['Datum GL needs a ground level elevation on the well.']);
  });
  test('display round trip in ft from RT (RT = KB by default) and TVDSS', () => {
    const d = toDisplay(g.vertical.expected.mdM, { unit: 'ft', reference: 'MD', datum: 'RT' }, ctx);
    near(d.value, g.vertical.expected.displayFtRt, 1e-9);
    const ss = toDisplay(g.vertical.expected.mdM, { unit: 'm', reference: 'TVDSS' }, ctx);
    near(ss.value, g.vertical.expected.tvdssM);
    expect(ss.datum).toBe('MSL');
    const gl = toDisplay(g.vertical.expected.mdM, { unit: 'ft', reference: 'MD', datum: 'GL' }, ctx);
    near(gl.value, 3000, 1e-9);
  });
  test('TVDSS entry converts back through KB', () => {
    const r = toCanonicalMd({ value: g.vertical.expected.tvdssM, unit: 'm', reference: 'TVDSS', datum: 'MSL', kind: 'prognosis' }, ctx);
    expect(r.ok).toBe(true);
    near(r.mdM, g.vertical.expected.mdM);
  });
});

describe('deviated well golden (vertical to 1400 m, build to 30 deg at 1750 m)', () => {
  const survey = { stations: g.deviated.stations, version: 'v2' };
  const ctx = { kbElevM: g.deviated.kbElevM, survey };
  test('TVD at 1600 m MD is the longhand partial minimum curvature, and equals the drilling tvdAt', () => {
    const r = mdToTvd(1600, ctx);
    near(r.tvdM, g.deviated.expected.tvdAt1600, 1e-6);
    near(r.tvdM, tvdAt(survey.stations, 1600), 1e-9);
    expect(r.method).toBe('minimum_curvature');
    expect(r.surveyVersion).toBe('v2');
    near(mdToTvd(1750, ctx).tvdM, g.deviated.expected.tvdAt1750, 1e-6);
  });
  test('beyond the last station the TVD extrapolates along the last attitude and says so', () => {
    const r = mdToTvd(1900, ctx);
    near(r.tvdM, g.deviated.expected.tvdAt1900Extrapolated, 1e-6);
    expect(r.method).toBe('minimum_curvature_extrapolated');
    expect(r.warnings[0]).toMatch(/beyond the last survey station at 1750 m/);
  });
  test('a TVD entry resolves to the single MD that reaches it', () => {
    const tvd = g.deviated.expected.tvdAt1600;
    const back = tvdToMd(tvd, ctx);
    expect(back.crossings).toBe(1);
    near(back.mdM, 1600, 1e-6);
    const r = toCanonicalMd({ value: tvd / M_PER_FT, unit: 'ft', reference: 'TVD', datum: 'KB', kind: 'prognosis' }, ctx);
    expect(r.ok).toBe(true);
    near(r.mdM, 1600, 1e-6);
  });
  test('a TVD below the surveyed path extrapolates with a warning when the hole still goes down', () => {
    const r = tvdToMd(g.deviated.expected.tvdAt1900Extrapolated, ctx);
    near(r.mdM, 1900, 1e-6);
    expect(r.method).toBe('minimum_curvature_extrapolated');
  });
  test('a TVD the path crosses twice is refused with an MD instruction', () => {
    // toe-up lateral: vertical to 1000, build through horizontal to 100 deg, hold
    const up = { kbElevM: 25, survey: { stations: [{ md: 0, inc: 0, azi: 0 }, { md: 1000, inc: 0, azi: 0 }, { md: 1300, inc: 100, azi: 0 }, { md: 1900, inc: 100, azi: 0 }], version: 'v1' } };
    const tvdAtToe = mdToTvd(1900, up).tvdM;
    const r = tvdToMd(tvdAtToe, up);
    expect(r.error).toBe(`TVD ${tvdAtToe} m crosses the well path 2 times, enter the depth as MD.`);
    const c = toCanonicalMd({ value: tvdAtToe, unit: 'm', reference: 'TVD', datum: 'KB', kind: 'event' }, up);
    expect(c.ok).toBe(false);
    expect(c.errors[0]).toMatch(/crosses the well path 2 times/);
  });
  test('a TVD the path never reaches is refused', () => {
    const flat = { kbElevM: 0, survey: { stations: [{ md: 0, inc: 0, azi: 0 }, { md: 1000, inc: 0, azi: 0 }, { md: 1200, inc: 90, azi: 0 }, { md: 2000, inc: 90, azi: 0 }], version: 'v1' } };
    const r = tvdToMd(5000, flat);
    expect(r.error).toMatch(/not reached by the surveyed path/);
  });
});

describe('provenance', () => {
  const stations = g.deviated.stations;
  test('a record calculated with an older survey is flagged stale and recalculates from its original', () => {
    const ctx1 = { kbElevM: 25, survey: { stations, version: 'v1' } };
    const rec = toCanonicalMd({ value: 1600, unit: 'm', reference: 'MD', datum: 'KB', kind: 'logged' }, ctx1);
    expect(depthProvenance(rec, ctx1).stale).toBe(false);
    const deeper = { kbElevM: 25, survey: { stations: [...stations, { md: 2000, inc: 45, azi: 90 }], version: 'v2' } };
    const p = depthProvenance(rec, deeper);
    expect(p.stale).toBe(true);
    expect(p.reason).toBe('Calculated with survey v1, the current survey is v2.');
    const again = recalculate(rec, deeper, { atUtc: 'later' });
    expect(again.ok).toBe(true);
    expect(again.previous).toEqual(rec.calculated);
    expect(again.calculated.surveyVersion).toBe('v2');
    expect(again.original).toEqual(rec.original);
    near(again.mdM, rec.mdM);
  });
});
