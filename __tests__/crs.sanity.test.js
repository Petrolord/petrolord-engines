// Area-of-use sanity: the guard that catches feet-as-metres, swapped
// axes and out-of-area coordinates before they misplace data.
//
// Note what this guard can and cannot see: a pure UTM zone swap keeps
// coordinates inside the neighboring zone's easting/northing band, so it
// is geodetically invisible here and is caught later by the overlay
// guards (data vs data). The cases below are the ones a single dataset
// CAN betray on its own.

import proj4 from 'proj4';
import { catalogGet, M_PER_FT } from '../lib/crs/catalog';
import { makeProjector } from '../lib/crs/transform';
import { checkAreaOfUse } from '../lib/crs/sanity';

const entry31 = catalogGet('EPSG:32631');
const proj31 = makeProjector(proj4, entry31.proj4);
const entryMid = catalogGet('EPSG:26392');
const projMid = makeProjector(proj4, entryMid.proj4);

// Nigeria offshore, squarely inside UTM zone 31N.
const GOOD_31 = [
  { x: 480000, y: 660000 }, { x: 520000, y: 700000 }, { x: 500000, y: 680000 },
];
// Niger Delta area in the Mid Belt frame (false easting 670554,
// northings small because lat_0 = 4N): deliberately asymmetric so a
// swap or rescale leaves the area of use.
const GOOD_MID = [
  { x: 700000, y: 150000 }, { x: 720000, y: 170000 }, { x: 705000, y: 160000 },
];

test('plausible coordinates pass', () => {
  expect(checkAreaOfUse(proj31, entry31, GOOD_31).ok).toBe(true);
  const r = checkAreaOfUse(projMid, entryMid, GOOD_MID);
  expect(r.ok).toBe(true);
  expect(r.verdict).toBe('ok');
  expect(r.suggestion).toBeNull();
});

test('metre coordinates written as feet numbers are flagged unit-feet', () => {
  const feetish = GOOD_31.map((p) => ({ x: p.x / M_PER_FT, y: p.y / M_PER_FT }));
  const r = checkAreaOfUse(proj31, entry31, feetish);
  expect(r.ok).toBe(false);
  expect(r.verdict).toBe('out-of-area');
  expect(r.suggestion).toBe('unit-feet');
});

test('feet values declared for a metric belt suggest unit-metres', () => {
  const metresish = GOOD_MID.map((p) => ({ x: p.x * M_PER_FT, y: p.y * M_PER_FT }));
  const r = checkAreaOfUse(projMid, entryMid, metresish);
  expect(r.ok).toBe(false);
  expect(r.suggestion).toBe('unit-metres');
});

test('swapped easting/northing on an asymmetric frame is spotted', () => {
  const swapped = GOOD_MID.map((p) => ({ x: p.y, y: p.x }));
  const r = checkAreaOfUse(projMid, entryMid, swapped);
  expect(r.ok).toBe(false);
  expect(r.suggestion).toBe('axes-swapped');
});

test('a local engineering grid declared as UTM fails with no rescue', () => {
  const local = [{ x: 4200, y: 5100 }, { x: 4900, y: 5600 }, { x: 4600, y: 5300 }];
  const r = checkAreaOfUse(proj31, entry31, local);
  expect(r.ok).toBe(false);
  expect(r.verdict).toBe('out-of-area');
  expect(r.suggestion).toBeNull();
});

test('no samples is its own verdict', () => {
  const r = checkAreaOfUse(proj31, entry31, [{ x: NaN, y: 1 }]);
  expect(r.verdict).toBe('no-samples');
});
