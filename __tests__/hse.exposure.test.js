// HSE H2 occupational hygiene gates: noise dose and TWA (OSHA 1910.95
// App. A, NIOSH 98-126), LEX,8h (2003/10/EC, HSE L108), hearing
// protector estimates, chemical TWA/STEL/mixture (1910.1000(d)) and
// Brief and Scala, WBGT and the NIOSH 2016 heat limits, against the
// independent stdlib oracle (tools/validation/hse/oracle_exposure.py).
//
// Every case CALLS THE ENGINE. Three kinds of truth are checked:
//
//  - `expect`: the oracle's value, to 1e-9 relative or absolute. The
//    oracle takes its own routes (sound pressure for LEX, bisection for
//    an exact-coefficient TWA, exact rationals for the chemistry) and
//    its header says, route by route, what it cannot check;
//  - `published`: the value the SOURCE PRINTS, at the tolerance its
//    printed precision allows. These are what discriminate the shared
//    constants: Table A-1 separates 16.61 from 10, NIOSH Table 1-2
//    separates 10.0 from 3/log10(2), Table G-16a and Table 1-1 pin the
//    exchange rates;
//  - `errata`: printed values the source's own formula does NOT
//    reproduce (FINDINGS-exposure.md). The engine must stay OUTSIDE
//    their printed tolerance, so matching a typo turns this red.
//
// Refusals are checked BY NAME: each must return `error` and the
// `field` the golden names.

import fs from 'fs';
import path from 'path';
import * as E from '../engines/hse/exposure';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'hse', 'goldens', 'exposure_cases.json'),
  'utf8',
));

const TOL = G.oracleTolerance;

const at = (obj, key) => key.split('.').reduce(
  (o, k) => (o === undefined || o === null ? undefined : o[/^\d+$/.test(k) ? Number(k) : k]),
  obj,
);

const call = (fn, args) => {
  expect(typeof E[fn]).toBe('function');
  return E[fn](...args);
};

const close = (a, b, tol) => Math.abs(a - b) <= Math.max(tol, tol * Math.abs(b));

describe('golden file', () => {
  test('is non-trivial, ids are unique, and every export is exercised', () => {
    expect(G.module).toBe('exposure');
    expect(G.cases.length).toBeGreaterThan(400);
    const ids = [...G.cases, ...G.errata, ...G.refusals].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const used = new Set([...G.cases, ...G.errata, ...G.refusals].map((c) => c.fn));
    const fns = Object.keys(E).filter((k) => typeof E[k] === 'function' && k !== 'resolveNoiseCriterion');
    expect(fns.filter((f) => !used.has(f))).toEqual([]);
  });

  test('the published tables are all there', () => {
    const count = (prefix) => G.cases.filter((c) => c.id.startsWith(prefix)).length
      + G.errata.filter((c) => c.id.startsWith(prefix)).length;
    expect(count('g16a-')).toBe(51);
    expect(count('a1-')).toBe(151);
    expect(count('niosh-t11-')).toBe(50);
    expect(count('niosh-t12-')).toBe(84);
  });
});

describe('engine against the oracle and the published values', () => {
  test.each(G.cases.map((c) => [c.id, c]))('%s', (_id, c) => {
    const r = call(c.fn, c.args);
    expect(r.error).toBeUndefined();
    Object.entries(c.expect).forEach(([key, want]) => {
      const got = at(r, key);
      if (typeof want === 'number') {
        expect({ key, got, ok: typeof got === 'number' && close(got, want, TOL) })
          .toEqual({ key, got, ok: true });
      } else {
        expect({ key, got }).toEqual({ key, got: want });
      }
    });
    Object.entries(c.published || {}).forEach(([key, { value, tolerance }]) => {
      const got = at(r, key);
      expect({ key, got, printed: value, ok: Math.abs(got - value) <= tolerance })
        .toEqual({ key, got, printed: value, ok: true });
    });
  });
});

describe('published errata stay errata', () => {
  test.each(G.errata.map((c) => [c.id, c]))('%s', (_id, c) => {
    const r = call(c.fn, c.args);
    expect(r.error).toBeUndefined();
    const got = at(r, c.key);
    expect(Math.abs(got - c.printed)).toBeGreaterThan(c.tolerance);
  });
});

describe('refusals, by name', () => {
  test.each(G.refusals.map((c) => [c.id, c]))('%s', (_id, c) => {
    const r = call(c.fn, c.args);
    expect(typeof r.error).toBe('string');
    expect(r.error.length).toBeGreaterThan(0);
    expect(r.field).toBe(c.field);
  });
});

describe('criteria and the returned criterion', () => {
  test('presets carry their published parameters', () => {
    expect(E.NOISE_CRITERIA.OSHA_PEL).toMatchObject({
      criterionLevelDbA: 90, exchangeRateDb: 5, thresholdDbA: 90, twaCoefficientDb: 16.61, limitDosePct: 100,
    });
    expect(E.NOISE_CRITERIA.OSHA_ACTION_LEVEL).toMatchObject({
      criterionLevelDbA: 90, exchangeRateDb: 5, thresholdDbA: 80, twaCoefficientDb: 16.61, limitDosePct: 50,
    });
    expect(E.NOISE_CRITERIA.NIOSH_REL).toMatchObject({
      criterionLevelDbA: 85, exchangeRateDb: 3, thresholdDbA: 80, twaCoefficientDb: 10, ceilingDbA: 115,
    });
  });

  test('16.61 and 10.0 are the printed roundings of q / log10(2)', () => {
    expect(5 / Math.log10(2)).toBeCloseTo(16.61, 3);
    expect(3 / Math.log10(2)).toBeCloseTo(9.966, 3);
  });

  test('every result names the criterion or source it used', () => {
    expect(E.noiseDose([{ levelDbA: 92, durationH: 8 }], 'NIOSH_REL').criterion.id).toBe('NIOSH_REL');
    expect(E.noiseTwaFromDoseDbA(100, 'OSHA_ACTION_LEVEL').criterion.id).toBe('OSHA_ACTION_LEVEL');
    expect(E.hearingProtectorEstimate({ exposureDb: 98, nrrDb: 25, method: 'OSHA_FIELD_50' }).source)
      .toMatch(/Appendix E/);
    expect(E.lexEightHourDbA([{ laeqDbA: 85, durationH: 8 }]).criterion.limitLexDbA).toBe(87);
    expect(E.mixtureExposureIndex([{ concentration: 1, limit: 2 }]).source).toMatch(/1910\.1000\(d\)\(2\)/);
    expect(E.nioshRecommendedAlertLimitC(300).criterion).toBe('NIOSH_RAL');
  });

  test('a custom criterion without a coefficient uses the exact q / log10(2)', () => {
    const c = { criterionLevelDbA: 85, exchangeRateDb: 3, thresholdDbA: 80 };
    const r = E.noiseDose([{ levelDbA: 97, durationH: 8 }], c);
    // a constant level held 8 hours has a TWA equal to it
    expect(r.twaDbA).toBeCloseTo(97, 10);
    expect(r.criterion.twaCoefficientDb).toBeCloseTo(3 / Math.log10(2), 12);
  });

  test('the NIOSH printed 10.0 makes a constant 100 dBA read 100.05', () => {
    // This is the source's own arithmetic (Table 1-2 is built on 10.0), kept
    // on purpose and recorded in FINDINGS-exposure.md.
    const r = E.noiseDose([{ levelDbA: 100, durationH: 8 }], 'NIOSH_REL');
    expect(r.dosePct).toBeCloseTo(3200, 9);
    expect(r.twaDbA).toBeCloseTo(100.0515, 3);
  });
});

describe('edges', () => {
  test('exactly at criterion: D = 100 and TWA = 90, and not over the limit', () => {
    const r = E.noiseDose([{ levelDbA: 90, durationH: 8 }], 'OSHA_PEL');
    expect(r.dosePct).toBe(100);
    expect(r.twaDbA).toBe(90);
    expect(r.exceedsLimit).toBe(false);
  });

  test('a level below the threshold contributes nothing, at the threshold it counts', () => {
    const below = E.noiseDose([{ levelDbA: 89.999, durationH: 8 }], 'OSHA_PEL');
    expect(below.dosePct).toBe(0);
    expect(below.twaDbA).toBeNull();
    expect(below.contributions[0].integrated).toBe(false);
    expect(E.noiseDose([{ levelDbA: 80, durationH: 8 }], 'OSHA_ACTION_LEVEL').dosePct).toBe(25);
  });

  test('the action level is 50 percent of the SAME dose scale', () => {
    const r = E.noiseDose([{ levelDbA: 85, durationH: 8 }], 'OSHA_ACTION_LEVEL');
    expect(r.dosePct).toBe(50);
    expect(r.twaDbA).toBeCloseTo(85, 2);
    expect(r.exceedsLimit).toBe(false);
    expect(E.noiseDose([{ levelDbA: 85.1, durationH: 8 }], 'OSHA_ACTION_LEVEL').exceedsLimit).toBe(true);
  });

  test('warnings above the tables and the NIOSH ceiling', () => {
    expect(E.noiseDose([{ levelDbA: 132, durationH: 0.01 }], 'OSHA_PEL').warnings.join(' ')).toMatch(/130 dBA/);
    expect(E.noiseDose([{ levelDbA: 116, durationH: 0.1 }], 'OSHA_PEL').warnings.join(' ')).toMatch(/115 dBA/);
    expect(E.noiseDose([{ levelDbA: 116, durationH: 0.1 }], 'NIOSH_REL').warnings.join(' ')).toMatch(/ceiling/);
  });

  test('a protector with too small an NRR is floored and says so', () => {
    const r = E.hearingProtectorEstimate({ exposureDb: 92, nrrDb: 5 });
    expect(r.protectedDbA).toBe(92);
    expect(r.warnings).toHaveLength(1);
  });

  test('chemical TWA warns about unsampled time and long shifts', () => {
    expect(E.chemicalTwa8h([{ concentration: 10, durationH: 6 }]).warnings).toHaveLength(1);
    expect(E.chemicalTwa8h([{ concentration: 10, durationH: 10 }]).warnings[0]).toMatch(/unusual shift/);
    expect(E.chemicalTwa8h([{ concentration: 10, durationH: 8 }]).warnings).toHaveLength(0);
  });

  test('heat limits warn outside the plotted metabolic range', () => {
    expect(E.nioshRecommendedExposureLimitC(700).warnings).toHaveLength(1);
    expect(E.nioshRecommendedExposureLimitC(300).warnings).toHaveLength(0);
  });

  test('every refusal is an object with error and field, never a throw or NaN', () => {
    const r = E.noiseDose('not an array');
    expect(r.error).toBeTruthy();
    expect(r.field).toBe('periods');
  });
});

describe('a refusal names one input, in its field and in its message', () => {
  // nioshHeatAssessment renames a refused period field from periods[i] to
  // wbgtPeriods[i] or metabolicPeriods[i]. The message has to be renamed with
  // it: a message saying "periods[0].wbgtC" beside a field saying
  // "wbgtPeriods[0].wbgtC" points a caller at an input that does not exist.
  const heat = G.refusals.filter((c) => c.fn === 'nioshHeatAssessment' && /^(wbgt|metabolic)Periods\[/.test(c.field));
  test('the golden carries at least one renamed per-period heat refusal', () => {
    expect(heat.length).toBeGreaterThan(0);
  });
  test.each(heat.map((c) => [c.id, c]))('%s: the message starts with the field it names', (_id, c) => {
    const r = call(c.fn, c.args);
    expect(r.field).toBe(c.field);
    expect(r.error.startsWith(r.field)).toBe(true);
  });
  test('the same holds for a refused metabolic period', () => {
    const r = E.nioshHeatAssessment({
      acclimatized: true,
      wbgtPeriods: [{ wbgtC: 28, durationMin: 60 }],
      metabolicPeriods: [{ metabolicRateW: 'heavy', durationMin: 60 }],
    });
    expect(r.field).toBe('metabolicPeriods[0].metabolicRateW');
    expect(r.error.startsWith(r.field)).toBe(true);
  });
});
