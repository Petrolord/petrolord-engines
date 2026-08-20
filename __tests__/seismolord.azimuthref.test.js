// Azimuth-reference conversion oracles: a true-north survey in UTM 31N
// at 52N 5E, where analytic TM convergence gives the grid azimuth of
// true north as -(lon-lon0)sin(lat) = -1.576 degrees. A horizontal
// eastward step converted with the wrong reference lands sideways by
// depth * sin(convergence): that is the misplacement this prevents.

import proj4 from 'proj4';
import { catalogGet } from '../lib/crs/catalog';
import { makeProjector } from '../lib/crs/transform';
import { gridConvergenceDeg } from '../lib/crs/convergence';
import { toGridAzimuths, computeWellPath } from '../engines/seismolord/wellPath';

const proj = makeProjector(proj4, catalogGet('EPSG:32631').proj4);
const wellhead = proj.fromLonLat(5, 52);
const gamma = gridConvergenceDeg(proj, wellhead.x, wellhead.y);

test('grid reference is a no-op; unknown reference throws', () => {
  const stations = [{ md: 0, inc: 0, azi: 0 }, { md: 100, inc: 30, azi: 45 }];
  expect(toGridAzimuths(stations)).toEqual(stations);
  expect(toGridAzimuths(stations, { azimuthRef: 'grid', convergenceDeg: 5 })).toEqual(stations);
  expect(() => toGridAzimuths(stations, { azimuthRef: 'astro' })).toThrow(/reference/);
  expect(() => toGridAzimuths(stations, { azimuthRef: 'true', convergenceDeg: NaN })).toThrow(/finite/);
});

test('true-north azimuths rotate by the convergence, magnetic by declination too', () => {
  const stations = [{ md: 0, inc: 0, azi: 10 }, { md: 100, inc: 45, azi: 10 }];
  const g = toGridAzimuths(stations, { azimuthRef: 'true', convergenceDeg: gamma });
  expect(g[1].azi).toBeCloseTo(10 + gamma, 10);
  const m = toGridAzimuths(stations, {
    azimuthRef: 'magnetic', convergenceDeg: gamma, declinationDeg: -1.2,
  });
  expect(m[1].azi).toBeCloseTo(10 - 1.2 + gamma, 10);
  expect(m[1].azi).toBeGreaterThanOrEqual(0);
});

test('a due-true-north horizontal run lands along the meridian, not grid north', () => {
  // 1000 m horizontal run due true north from the wellhead.
  const stations = [
    { md: 0, inc: 90, azi: 0 },
    { md: 1000, inc: 90, azi: 0 },
  ];
  const grid = toGridAzimuths(stations, { azimuthRef: 'true', convergenceDeg: gamma });
  const path = computeWellPath(grid, { surfaceX: wellhead.x, surfaceY: wellhead.y, kb: 0 });
  const end = path[path.length - 1];

  // Ground truth: the same run in geographic terms is ~1000 m of
  // northward latitude at constant longitude.
  const endTrue = proj.fromLonLat(5, 52 + 1000 / 111195);
  expect(Math.hypot(end.x - endTrue.x, end.y - endTrue.y)).toBeLessThan(1.5);

  // Ignoring the reference (treating true as grid) misplaces the TD by
  // about 1000 * sin(1.576 deg) = 27.5 m. The correction removes it.
  const wrong = computeWellPath(stations, { surfaceX: wellhead.x, surfaceY: wellhead.y, kb: 0 });
  const wrongEnd = wrong[wrong.length - 1];
  const misplacement = Math.hypot(wrongEnd.x - endTrue.x, wrongEnd.y - endTrue.y);
  expect(misplacement).toBeGreaterThan(20);
  expect(misplacement).toBeLessThan(35);
});
