// Catalog integrity + transform oracles.
//
// Oracle sources:
// - EPSG Guidance Note 7-2, Transverse Mercator worked example (OSGB36):
//   lat 50 30 00 N, lon 00 30 00 E -> E 577274.99, N 69740.50 (cm-rounded).
// - Projection definition identities: a TM/LCC natural origin maps to its
//   false easting/northing exactly; UTM zones are congruent under 6-degree
//   longitude shifts; east/west symmetry about the central meridian.
// - Independent 3-parameter Helmert implemented here from first
//   principles (geodetic -> geocentric -> shift -> geodetic), compared
//   against proj4's datum path for ED50 and Minna.

import proj4 from 'proj4';
import {
  CRS_CATALOG, catalogGet, searchCatalog, unitToMetres, M_PER_FT_US,
} from '../lib/crs/catalog';
import { makeTransformer, makeProjector, convertUnit } from '../lib/crs/transform';

describe('catalog integrity', () => {
  test('codes are unique and well-formed', () => {
    const codes = CRS_CATALOG.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^EPSG:\d{4,5}$/);
  });

  test('every definition is accepted by proj4 and round-trips a point', () => {
    for (const e of CRS_CATALOG) {
      const proj = makeProjector(proj4, e.proj4);
      const [w, s, ee, n] = e.areaBboxLonLat;
      const lon = (w + ee) / 2;
      const lat = (s + n) / 2;
      const p = proj.fromLonLat(lon, lat);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      const back = proj.toLonLat(p.x, p.y);
      expect(back.lon).toBeCloseTo(lon, 6);
      expect(back.lat).toBeCloseTo(lat, 6);
    }
  });

  test('expected families are present', () => {
    expect(CRS_CATALOG.length).toBeGreaterThanOrEqual(160);
    expect(catalogGet('EPSG:32631').name).toBe('WGS 84 / UTM zone 31N');
    expect(catalogGet('EPSG:23031').name).toBe('ED50 / UTM zone 31N');
    expect(catalogGet('EPSG:26392').name).toBe('Minna / Nigeria Mid Belt');
    expect(catalogGet('EPSG:26331').name).toBe('Minna / UTM zone 31N');
    expect(catalogGet('EPSG:27700').unit).toBe('m');
    expect(catalogGet('EPSG:2274').unit).toBe('ftUS');
    expect(catalogGet('EPSG:4326').kind).toBe('geographic');
  });

  test('search matches code, name and region words', () => {
    expect(searchCatalog('minna belt').length).toBe(3);
    expect(searchCatalog('32631')[0].code).toBe('EPSG:32631');
    expect(searchCatalog('nigeria').length).toBeGreaterThanOrEqual(6);
  });
});

describe('unit handling', () => {
  test('US survey foot is exact', () => {
    expect(M_PER_FT_US).toBe(1200 / 3937);
    expect(convertUnit(3937, 'ftUS', 'm')).toBe(1200);
    expect(convertUnit(1, 'ft', 'm')).toBe(0.3048);
    expect(convertUnit(5, 'm', 'm')).toBe(5);
    expect(() => unitToMetres('yd')).toThrow();
  });
});

describe('transform oracles', () => {
  test('EPSG GN7-2 OSGB36 worked example: 50°30′N 0°30′E -> 577274.99, 69740.50', () => {
    const t = makeTransformer(proj4, catalogGet('EPSG:4277').proj4, catalogGet('EPSG:27700').proj4);
    const p = t.forward(0.5, 50.5);
    expect(Math.abs(p.x - 577274.99)).toBeLessThan(0.02);
    expect(Math.abs(p.y - 69740.5)).toBeLessThan(0.02);
  });

  test('UTM natural origin: (3E, 0N) -> (500000, 0) in zone 31N', () => {
    const proj = makeProjector(proj4, catalogGet('EPSG:32631').proj4);
    const p = proj.fromLonLat(3, 0);
    expect(p.x).toBeCloseTo(500000, 4);
    expect(p.y).toBeCloseTo(0, 4);
  });

  test('UTM east/west symmetry about the central meridian', () => {
    const proj = makeProjector(proj4, catalogGet('EPSG:32631').proj4);
    const east = proj.fromLonLat(4.25, 8);
    const west = proj.fromLonLat(1.75, 8);
    expect(east.x - 500000).toBeCloseTo(500000 - west.x, 5);
    expect(east.y).toBeCloseTo(west.y, 5);
  });

  test('UTM zones are congruent under 6-degree shifts', () => {
    const z31 = makeProjector(proj4, catalogGet('EPSG:32631').proj4);
    const z32 = makeProjector(proj4, catalogGet('EPSG:32632').proj4);
    const a = z31.fromLonLat(4.1, 52.3);
    const b = z32.fromLonLat(10.1, 52.3);
    expect(a.x).toBeCloseTo(b.x, 5);
    expect(a.y).toBeCloseTo(b.y, 5);
  });

  test('Minna Mid Belt natural origin: (8.5E, 4N) -> (670553.98, 0)', () => {
    const proj = makeProjector(proj4, catalogGet('EPSG:26392').proj4);
    // fromLonLat crosses the WGS84 datum shift, so project from Minna
    // geographic instead: the belt and EPSG:4263 share the datum.
    const t = makeTransformer(proj4, catalogGet('EPSG:4263').proj4, catalogGet('EPSG:26392').proj4);
    const p = t.forward(8.5, 4);
    expect(p.x).toBeCloseTo(670553.98, 3);
    expect(p.y).toBeCloseTo(0, 3);
    expect(Number.isFinite(proj.fromLonLat(8.5, 4).x)).toBe(true);
  });

  test('Tennessee ftUS natural origin maps to its false easting in survey feet', () => {
    const t = makeTransformer(proj4, '+proj=longlat +ellps=GRS80 +no_defs', catalogGet('EPSG:2274').proj4);
    const p = t.forward(-86, 34.33333333333334);
    // False easting is 600000 m; the CRS speaks US survey feet, so the
    // natural origin reads 600000 / (1200/3937) = 1968500 ftUS exactly.
    expect(p.x).toBeCloseTo(600000 / M_PER_FT_US, 3);
    expect(p.x).toBeCloseTo(1968500, 3);
    expect(p.y).toBeCloseTo(0, 3);
  });
});

// Independent Helmert: geodetic -> geocentric on the source ellipsoid,
// apply the 3-parameter shift, geocentric -> geodetic on WGS84. Written
// from the standard closed formulas, sharing no code with proj4.
function helmert3ToWgs84(lonDeg, latDeg, a, rf, [dX, dY, dZ]) {
  const d2r = Math.PI / 180;
  const e2 = (2 - 1 / rf) / rf;
  const lat = latDeg * d2r;
  const lon = lonDeg * d2r;
  const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  let X = nu * Math.cos(lat) * Math.cos(lon) + dX;
  let Y = nu * Math.cos(lat) * Math.sin(lon) + dY;
  let Z = (nu * (1 - e2)) * Math.sin(lat) + dZ;

  const aW = 6378137;
  const e2W = (2 - 1 / 298.257223563) / 298.257223563;
  const p = Math.hypot(X, Y);
  let latW = Math.atan2(Z, p * (1 - e2W));
  for (let k = 0; k < 8; k += 1) {
    const nuW = aW / Math.sqrt(1 - e2W * Math.sin(latW) ** 2);
    latW = Math.atan2(Z + e2W * nuW * Math.sin(latW), p);
  }
  return { lon: Math.atan2(Y, X) / d2r, lat: latW / d2r };
}

describe('datum shift oracles (independent Helmert)', () => {
  test('ED50 -> WGS84 at 52N 4E matches first-principles Helmert', () => {
    const t = makeTransformer(proj4, catalogGet('EPSG:4230').proj4, catalogGet('EPSG:4326').proj4);
    const got = t.forward(4, 52);
    const want = helmert3ToWgs84(4, 52, 6378388, 297, [-87, -98, -121]);
    expect(got.x).toBeCloseTo(want.lon, 7);
    expect(got.y).toBeCloseTo(want.lat, 7);
    // ED50 -> WGS84 in the North Sea shifts on the order of 100 m.
    const shiftM = Math.hypot((got.x - 4) * 111320 * Math.cos((52 * Math.PI) / 180), (got.y - 52) * 111320);
    expect(shiftM).toBeGreaterThan(50);
    expect(shiftM).toBeLessThan(250);
  });

  test('Minna -> WGS84 at 6N 5E matches first-principles Helmert', () => {
    const t = makeTransformer(proj4, catalogGet('EPSG:4263').proj4, catalogGet('EPSG:4326').proj4);
    const got = t.forward(5, 6);
    const want = helmert3ToWgs84(5, 6, 6378249.145, 293.465, [-92, -93, 122]);
    expect(got.x).toBeCloseTo(want.lon, 7);
    expect(got.y).toBeCloseTo(want.lat, 7);
  });
});
