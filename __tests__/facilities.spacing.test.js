// Facilities F8 layout-spacing gates against
// tools/validation/facilities/oracle_spacing.py.
//
// Independent routes: the great-circle distance is checked against BOTH
// the Vincenty sphere formula and a 3D chord-through-the-earth
// derivation (three formulations of the same distance); the radiation
// setbacks are checked by ROUND TRIP -- compute the intensity at the
// returned distance and confirm it equals the allowable -- rather than
// by restating the same rearrangement.
//
// The Facility Layout Mapper has always advertised "safety distances"
// and never computed any. This is that missing half, and it keeps two
// kinds of answer apart on purpose: TABLE spacings are a table and say
// so, while RADIATION setbacks are computed from the duty and move
// when the duty moves.

import fs from 'fs';
import path from 'path';
import {
  SPACING_TABLE_M, requiredSpacingM, haversineM,
  RADIATION_LEVELS, flareSetbackM, poolFireSetbackM,
  checkLayout, nearestNeighbours,
} from '../engines/facilities/spacing';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'test-data', 'facilities', 'goldens', 'spacing_cases.json'),
  'utf8',
));

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

describe('the spacing table', () => {
  test('is symmetric and returns null rather than guessing', () => {
    expect(requiredSpacingM({ typeA: 'wellhead', typeB: 'tank' })).toBe(30);
    expect(requiredSpacingM({ typeA: 'tank', typeB: 'wellhead' })).toBe(30);
    expect(requiredSpacingM({ typeA: 'tank', typeB: 'unicorn' })).toBeNull();
  });

  test('orders the way industry practice does', () => {
    // a flare stands off from everything
    expect(requiredSpacingM({ typeA: 'flare', typeB: 'tank' })).toBeGreaterThan(
      requiredSpacingM({ typeA: 'separator', typeB: 'tank' }),
    );
    // fired equipment stands off from tanks more than a separator does
    expect(requiredSpacingM({ typeA: 'heaterTreater', typeB: 'tank' })).toBeGreaterThan(
      requiredSpacingM({ typeA: 'separator', typeB: 'tank' }),
    );
    // and the control room is the thing kept furthest from a flare
    expect(requiredSpacingM({ typeA: 'flare', typeB: 'control' })).toBeGreaterThanOrEqual(
      requiredSpacingM({ typeA: 'flare', typeB: 'tank' }),
    );
    expect(Object.keys(SPACING_TABLE_M).length).toBeGreaterThan(8);
  });

  test('a site standard can replace the table wholesale', () => {
    const custom = { tank: { flare: 120 } };
    expect(requiredSpacingM({ typeA: 'tank', typeB: 'flare', table: custom })).toBe(120);
  });
});

describe('distance on the map', () => {
  test('haversine matches Vincenty and the chord derivation', () => {
    G.distances.forEach((c) => {
      const d = haversineM(c.input);
      expect(d.error).toBeUndefined();
      expect(rel(d.distanceM, c.expected.vincentyM)).toBeLessThan(1e-9);
      expect(rel(d.distanceM, c.expected.chordM)).toBeLessThan(1e-9);
    });
  });

  test('a degree of latitude is about 111 km and longitude shrinks with latitude', () => {
    const oneDegLat = haversineM({ lat1: 0, lon1: 0, lat2: 1, lon2: 0 }).distanceM;
    expect(oneDegLat / 1000).toBeCloseTo(111.2, 0);
    const atEquator = haversineM({ lat1: 0, lon1: 0, lat2: 0, lon2: 1 }).distanceM;
    const atSixty = haversineM({ lat1: 60, lon1: 0, lat2: 60, lon2: 1 }).distanceM;
    // cos 60 = 0.5, so a degree of longitude is half as long there
    expect(atSixty / atEquator).toBeCloseTo(0.5, 2);
    expect(haversineM({ lat1: 0, lon1: 0, lat2: 1 }).error).toBeTruthy();
  });
});

describe('computed radiation setbacks', () => {
  test('the flare setback round-trips to its own allowable', () => {
    G.flare.forEach((c) => {
      const r = flareSetbackM(c.input);
      expect(r.error).toBeUndefined();
      expect(rel(r.distanceM, c.expected.distanceM)).toBeLessThan(1e-9);
      // the round trip the oracle performed
      expect(rel(c.expected.intensityAtDistance, c.input.allowableKwM2)).toBeLessThan(1e-9);
    });
    expect(flareSetbackM({ reliefRateKgS: 0, lhvKjKg: 46000 }).error).toBeTruthy();
  });

  test.each(G.poolFire.map((c) => [c.name, c]))('pool fire %s matches the oracle', (_, c) => {
    const r = poolFireSetbackM(c.input);
    expect(r.error).toBeUndefined();
    expect(rel(r.qKw, c.expected.qKw)).toBeLessThan(1e-9);
    expect(rel(r.flameHeightM, c.expected.flameHeightM)).toBeLessThan(1e-9);
    expect(rel(r.radiusFromCentreM, c.expected.radiusFromCentreM)).toBeLessThan(1e-9);
    // round trip: the point source at that radius gives the allowable
    expect(rel(c.expected.intensityAtRadius, c.input.allowableKwM2)).toBeLessThan(1e-9);
    expect(r.setbackStatus).toBe(c.expected.setbackStatus);
    if (c.expected.setbackFromEdgeM === 0) expect(r.setbackFromEdgeM).toBe(0);
    else expect(rel(r.setbackFromEdgeM, c.expected.setbackFromEdgeM)).toBeLessThan(1e-9);
    expect(r.note !== null).toBe(c.expected.nearFieldNote || c.expected.setbackStatus === 'within-pool-edge');
  });

  test('S2 NEGATIVE CONTROL: a radius inside the pool edge is flagged, where the retired clamp was silent', () => {
    const c = G.poolFire.find((x) => x.name === 'withinPoolEdgeEdgeCase');
    const r = poolFireSetbackM(c.input);
    // the retired max(0) gave the same 0 with nothing to say why
    expect(c.expected.retiredClampSetbackM).toBe(0);
    expect(r.setbackStatus).toBe('within-pool-edge');
    expect(r.note).toMatch(/within the pool edge/);
    expect(poolFireSetbackM({ poolDiameterM: 20 }).setbackStatus).toBe('beyond-pool-edge');
  });

  test('S2: the pool-fire header describes the point source it computes', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'engines', 'facilities', 'spacing.js'), 'utf8',
    );
    const header = src.slice(src.indexOf('Setback from a liquid pool fire'), src.indexOf('export const poolFireSetbackM'));
    expect(header).toMatch(/POINT-SOURCE/);
    expect(header).toMatch(/No view factor/);
    expect(header).not.toMatch(/view-factor-based intensity/);
    expect(src).not.toMatch(/\u2014/);
  });

  test('THE POINT: a computed setback moves with the duty, a table figure does not', () => {
    const small = poolFireSetbackM({ poolDiameterM: 6 });
    const large = poolFireSetbackM({ poolDiameterM: 40 });
    expect(large.setbackFromEdgeM).toBeGreaterThan(small.setbackFromEdgeM * 3);
    // and a stricter allowable pushes everything further out
    const strict = poolFireSetbackM({ poolDiameterM: 20, allowableKwM2: 1.58 });
    const relaxed = poolFireSetbackM({ poolDiameterM: 20, allowableKwM2: 9.46 });
    expect(strict.setbackFromEdgeM).toBeGreaterThan(relaxed.setbackFromEdgeM);
  });

  test('says when the point-source model is being used too close to the flame', () => {
    // a permissive allowable pulls the radius inside the flame itself
    const close = poolFireSetbackM({ poolDiameterM: 60, allowableKwM2: 100 });
    expect(close.note).toMatch(/lower bound/);
    expect(RADIATION_LEVELS.map((l) => l.kWm2)).toEqual([1.58, 4.73, 6.31, 9.46]);
  });
});

describe('the layout check', () => {
  // A small site: ~0.0001 deg latitude is about 11 m
  const base = 4.8156;
  const lonBase = 7.0498;
  const mk = (id, name, type, dLatM, dLonM = 0) => ({
    id, name, type,
    lat: base + dLatM / 111320,
    lon: lonBase + dLonM / (111320 * Math.cos(base * Math.PI / 180)),
  });
  const pairOf = (v) => (v ? [v.kind, v.aId, v.bId] : null);

  test.each(G.layout.map((c) => [c.name, c]))('%s matches the oracle', (_, c) => {
    const r = checkLayout(c.input);
    const e = c.expected;
    expect(r.checked).toBe(e.checked);
    expect(r.zeroRequirementPairs).toBe(e.zeroRequirementPairs);
    expect(r.pass).toBe(e.pass);
    expect(r.passStatus).toBe(e.passStatus);
    expect(r.complete).toBe(e.complete);
    expect(r.skipped).toEqual(e.skipped);
    expect(r.unknownPairs).toEqual(e.unknownPairs);
    expect(r.violations.map(pairOf)).toEqual(e.violations.map(pairOf));
    r.violations.forEach((v, i) => {
      expect(rel(v.shortfallM, e.violations[i].shortfallM)).toBeLessThan(1e-9);
      expect(rel(v.shortfallFraction, e.violations[i].shortfallFraction)).toBeLessThan(1e-9);
    });
    expect(pairOf(r.worstAbsolute)).toEqual(e.worstAbsolutePair);
    expect(pairOf(r.worstRelative)).toEqual(e.worstRelativePair);
    expect(r.worst).toBeUndefined();
  });

  test('S4 NEGATIVE CONTROL: the retired "worst" was the relative ranking, and the two rankings disagree', () => {
    const c = G.layout.find((x) => x.name === 's4RankingsDisagree');
    const r = checkLayout(c.input);
    expect(c.expected.retiredRule.worstPair).toEqual(['spacing', 'p1', 'p2']);
    expect(pairOf(r.worstAbsolute)).toEqual(['spacing', 'f1', 'c1']);
    expect(pairOf(r.worstRelative)).toEqual(['spacing', 'p1', 'p2']);
    expect(r.worstAbsolute.shortfallM).toBeGreaterThan(r.worstRelative.shortfallM);
    expect(r.worstRelative.shortfallFraction).toBeGreaterThan(r.worstAbsolute.shortfallFraction);
  });

  test('S3 NEGATIVE CONTROL: nothing checked is not a pass', () => {
    const none = G.layout.find((x) => x.name === 's3AllUnplacedNothingChecked');
    expect(none.expected.retiredRule).toEqual({ checked: 0, pass: true, worstPair: null });
    const r = checkLayout(none.input);
    expect(r.pass).toBeNull();
    expect(r.passStatus).toBe('nothing-checked');
    expect(r.complete).toBe(false);
    const zero = G.layout.find((x) => x.name === 's3ZeroRequirementPairOnly');
    // the retired rule counted the valve beside a PSV as one passed check
    expect(zero.expected.retiredRule.checked).toBe(1);
    expect(checkLayout(zero.input).checked).toBe(0);
  });

  test('flags what is too close and sorts the largest shortfall first', () => {
    const items = [
      mk('w1', 'Wellhead 1', 'wellhead', 0),
      mk('s1', 'Separator', 'separator', 5),      // 5 m from the wellhead: needs 15
      mk('t1', 'Tank', 'tank', 100),              // 100 m: fine
    ];
    const r = checkLayout({ items });
    expect(r.pass).toBe(false);
    expect(r.complete).toBe(true);
    expect(r.worstAbsolute.kind).toBe('spacing');
    expect(r.worstAbsolute.requiredM).toBe(15);
    expect(r.worstAbsolute.actualM).toBeLessThan(15);
    for (let i = 1; i < r.violations.length; i += 1) {
      expect(r.violations[i].shortfallM).toBeLessThanOrEqual(r.violations[i - 1].shortfallM);
    }
  });

  test('passes a well-spread site and counts what it checked', () => {
    const items = [
      mk('w1', 'Wellhead 1', 'wellhead', 0),
      mk('s1', 'Separator', 'separator', 200),
      mk('t1', 'Tank', 'tank', 400),
    ];
    const r = checkLayout({ items });
    expect(r.pass).toBe(true);
    expect(r.passStatus).toBe('checked');
    expect(r.violations).toHaveLength(0);
    expect(r.checked).toBe(3); // three pairs, all with a positive requirement
    expect(r.worstAbsolute).toBeNull();
    expect(r.worstRelative).toBeNull();
  });

  test('applies a COMPUTED radiation setback alongside the table', () => {
    const items = [
      mk('f1', 'Flare', 'flare', 0),
      mk('t1', 'Tank', 'tank', 50),   // 50 m: inside this flare's 68 m radiation setback
    ];
    const flare = flareSetbackM({ reliefRateKgS: 20, lhvKjKg: 46000, allowableKwM2: 4.73 });
    const r = checkLayout({
      items,
      radiationSources: [{
        id: 'f1', setbackM: flare.distanceM, allowableKwM2: 4.73, label: 'Flare radiation',
      }],
    });
    const rad = r.violations.find((v) => v.kind === 'radiation');
    expect(rad).toBeTruthy();
    expect(rad.requiredM).toBeCloseTo(flare.distanceM, 6);
    expect(rad.label).toBe('Flare radiation');
  });

  test('reports unknown type pairs instead of silently passing them', () => {
    const items = [
      mk('a', 'Thing', 'unicorn', 0),
      mk('b', 'Tank', 'tank', 2),
    ];
    const r = checkLayout({ items });
    expect(r.unknownPairs.length).toBe(1);
    expect(r.violations).toHaveLength(0); // not judged, not hidden
    expect(r.pass).toBeNull();
    expect(r.complete).toBe(false);
    expect(checkLayout({ items: null }).error).toBeTruthy();
  });

  test('nearest neighbours give the room every item has', () => {
    const items = [
      mk('w1', 'Wellhead 1', 'wellhead', 0),
      mk('w2', 'Wellhead 2', 'wellhead', 20),
      mk('t1', 'Tank', 'tank', 300),
    ];
    const n = nearestNeighbours({ items });
    expect(n.rows).toHaveLength(3);
    const w1 = n.rows.find((r) => r.id === 'w1');
    expect(w1.nearest.id).toBe('w2');
    expect(w1.nearest.distanceM).toBeCloseTo(20, 0);
    expect(w1.requiredM).toBe(3);
    expect(nearestNeighbours({ items: [items[0]] }).error).toBeTruthy();
  });
});
