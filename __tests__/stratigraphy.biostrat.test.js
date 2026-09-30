/**
 * Biostratigraphic events and the event-based age model (STRAT-U2-009/010).
 *
 * Gate: the least-squares core that fits the age model reproduces the NIST
 * StRD certified values for the Norris data set (lower difficulty linear
 * regression; test-data/stratigraphy/nist-strd-norris.dat, read from the
 * published file, not restated): B0, B1, their standard deviations, the
 * residual standard deviation and R-squared, each to 1e-9 relative.
 * Negative control: dividing the residual sum of squares by n instead of
 * n - 2 misses the certified residual SD. The age-model cases are
 * hand-derived (a line through exact points recovers its rate; a hiatus
 * restarts the line; an outlier is flagged, never dropped).
 */
import fs from 'fs';
import path from 'path';
import {
  BIO_EVENTS, bioEvent, eventTopName, parseEventName, rangeChart, dictionaryAge, leastSquaresLine, eventAgeModel,
} from '../engines/stratigraphy/biostrat';

const readNorris = () => {
  const txt = fs.readFileSync(path.join(__dirname, '..', 'test-data', 'stratigraphy', 'nist-strd-norris.dat'), 'utf8');
  const lines = txt.split('\n');
  const num = (label) => {
    const l = lines.find((x) => x.trim().startsWith(label));
    return l.trim().split(/\s+/).slice(1).map(Number);
  };
  const [b0, sb0] = num('B0'); const [b1, sb1] = num('B1');
  const sd = Number(lines.find((x) => x.includes('Standard Deviation') && /\d/.test(x)).trim().split(/\s+/).pop());
  const r2 = Number(lines.find((x) => x.trim().startsWith('R-Squared')).trim().split(/\s+/).pop());
  const at = lines.findIndex((x) => /^Data:\s+y\s+x/.test(x.trim()));
  const data = lines.slice(at + 1).map((x) => x.trim()).filter(Boolean).map((x) => x.split(/\s+/).map(Number));
  return { b0, sb0, b1, sb1, sd, r2, x: data.map((d) => d[1]), y: data.map((d) => d[0]) };
};
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-300, Math.abs(b));

describe('gate: NIST StRD Norris certified regression', () => {
  const c = readNorris();
  test('the file holds 36 observations and the certified values', () => {
    expect(c.x).toHaveLength(36);
    expect(c.b0).toBe(-0.262323073774029);
    expect(c.b1).toBe(1.00211681802045);
  });
  test('leastSquaresLine reproduces every certified statistic to 1e-9 relative', () => {
    const f = leastSquaresLine(c.x, c.y);
    expect(rel(f.a, c.b0)).toBeLessThan(1e-9);
    expect(rel(f.b, c.b1)).toBeLessThan(1e-9);
    expect(rel(f.se_a, c.sb0)).toBeLessThan(1e-9);
    expect(rel(f.se_b, c.sb1)).toBeLessThan(1e-9);
    expect(rel(f.sd, c.sd)).toBeLessThan(1e-9);
    expect(rel(f.r2, c.r2)).toBeLessThan(1e-9);
  });
  test('negative control: the n-denominator residual SD misses the certified value', () => {
    const f = leastSquaresLine(c.x, c.y);
    const wrong = Math.sqrt(f.residuals.reduce((s, r) => s + r * r, 0) / f.n);
    expect(rel(wrong, c.sd)).toBeGreaterThan(1e-3);
  });
});

describe('events', () => {
  test('the dictionary of events and their well-site meaning', () => {
    expect(BIO_EVENTS.map((e) => e.code)).toEqual(['FDO', 'LDO', 'LAD', 'FAD', 'ACME_TOP', 'ACME_BASE', 'LCO', 'FCO']);
    expect(bioEvent('ho').code).toBe('FDO');
    expect(bioEvent('base acme').code).toBe('ACME_BASE');
    expect(bioEvent('XYZ')).toBeNull();
    expect(eventTopName('lad', ' Discoaster  quinqueramus ')).toBe('LAD Discoaster quinqueramus');
    expect(() => eventTopName('nope', 'X')).toThrow(/not a biostratigraphic event/);
  });
  test('event names parse in the common forms; formation tops do not', () => {
    expect(parseEventName('LAD Discoaster quinqueramus')).toEqual({ event: 'LAD', taxon: 'Discoaster quinqueramus' });
    expect(parseEventName('FDO: Globorotalia margaritae')).toEqual({ event: 'FDO', taxon: 'Globorotalia margaritae' });
    expect(parseEventName('Amaurolithus primus (LDO)')).toEqual({ event: 'LDO', taxon: 'Amaurolithus primus' });
    expect(parseEventName('ACME_TOP Discoaster brouweri')).toEqual({ event: 'ACME_TOP', taxon: 'Discoaster brouweri' });
    expect(parseEventName('Top Dome')).toBeNull();      // a formation top is never read as an event
    expect(parseEventName('Mid Shale')).toBeNull();
  });
  test('range chart: one column per taxon, highest to lowest event, open ends named', () => {
    const r = rangeChart([
      { name: 'FDO Taxon A', md_m: 1000 }, { name: 'LDO Taxon A', md_m: 1200 },
      { name: 'FDO Taxon B', md_m: 1100 }, { name: 'Top Sand', md_m: 1050 },
    ]);
    expect(r.events).toBe(3);
    expect(r.taxa.map((t) => [t.taxon, t.top_md_m, t.base_md_m, t.openAbove, t.openBelow])).toEqual([['Taxon A', 1000, 1200, false, false], ['Taxon B', 1100, 1100, false, true]]);
  });
  test('dictionary ages: direct, or FDO through the LAD row', () => {
    const dict = [{ taxon: 'Discoaster quinqueramus', event: 'LAD', age_ma: 5.53 }, { taxon: 'Amaurolithus primus', event: 'FAD', age_ma: 7.39 }];
    expect(dictionaryAge(dict, 'LAD', 'discoaster quinqueramus')).toMatchObject({ age_ma: 5.53, via: null });
    expect(dictionaryAge(dict, 'FDO', 'Discoaster quinqueramus')).toMatchObject({ age_ma: 5.53, via: 'LAD' });
    expect(dictionaryAge(dict, 'LDO', 'Amaurolithus primus')).toMatchObject({ age_ma: 7.39, via: 'FAD' });
    expect(dictionaryAge(dict, 'ACME_TOP', 'Discoaster quinqueramus')).toBeNull();
  });
});

describe('age model', () => {
  test('exact points on a 200 m/Ma line recover the rate and zero residuals', () => {
    const pts = [1000, 1200, 1500, 1900].map((d, i) => ({ name: `E${i}`, md_m: d, age_ma: 2 + (d - 1000) / 200 }));
    const m = eventAgeModel(pts);
    expect(m.segments).toHaveLength(1);
    expect(m.segments[0].rate_m_per_ma).toBeCloseTo(200, 9);
    expect(m.points.every((p) => Math.abs(p.residual_ma) < 1e-9)).toBe(true);
    expect(m.ageAt(1300)).toBeCloseTo(3.5, 9);
  });
  test('an unconformity restarts the line; a lone event below it is named', () => {
    const pts = [{ name: 'A', md_m: 1000, age_ma: 2 }, { name: 'B', md_m: 1100, age_ma: 3 }, { name: 'C', md_m: 1300, age_ma: 12 }, { name: 'D', md_m: 1400, age_ma: 13 }, { name: 'E', md_m: 1600, age_ma: 20 }];
    const m = eventAgeModel(pts, { breaks: [1200, 1500] });
    expect(m.segments.map((s) => Number(s.rate_m_per_ma.toFixed(6)))).toEqual([100, 100]);
    expect(m.ageAt(1250)).toBeCloseTo(11.5, 9);
    expect(m.skipped).toEqual([{ name: 'E', reason: 'the only dated depth in its segment (a line needs two)' }]);
  });
  test('an event far off the line is flagged and kept', () => {
    const pts = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ name: `E${i}`, md_m: 1000 + i * 100, age_ma: 1 + i * 0.5 + (i % 2 ? 0.02 : -0.02) }));
    pts[4].age_ma += 2; // caved LDO read too old
    const m = eventAgeModel(pts);
    expect(m.points.filter((p) => p.flagged).map((p) => p.name)).toEqual(['E4']);
    expect(m.points).toHaveLength(8);
  });
  test('ages decreasing downhole are reported as an inverted line', () => {
    const m = eventAgeModel([{ name: 'A', md_m: 1000, age_ma: 5 }, { name: 'B', md_m: 1100, age_ma: 4 }]);
    expect(m.segments[0].inverted).toBe(true);
    expect(m.segments[0].rate_m_per_ma).toBeNull();
  });
});
