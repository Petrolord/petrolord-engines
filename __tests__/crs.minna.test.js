// Minna (Nigeria) datum transformations: provenance and oracles.
//
// Oracle: test-data/crs/goldens/minna_epsg_goldens.json, written by
// test-data/crs/generate_minna_goldens.py from the EPSG Geodetic Parameter
// Dataset (v12.029, as shipped in PROJ 9.8.1 proj.db). It holds
//  - every non-deprecated EPSG Minna to WGS 84 Helmert transformation, read
//    straight from the dataset (parameters, method, accuracy, area), and
//  - coordinates computed by PROJ (the C library, independent of proj4js)
//    through each NAMED EPSG operation, for geographic and projected Minna.
// The catalog is hand-transcribed; these tests prove the transcription and
// prove proj4js, driven by the catalog, lands where PROJ does.

import fs from 'fs';
import path from 'path';
import proj4 from 'proj4';
import {
  catalogGet, searchCatalog, MINNA_TO_WGS84, datumTransformGet, datumTransformFor,
  isDatumTransformOption, catalogDef, catalogPairDefs,
} from '../lib/crs/catalog';
import { makeTransformer, makeProjector } from '../lib/crs/transform';

const G = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../test-data/crs/goldens/minna_epsg_goldens.json'), 'utf8',
));
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
const MINNA_CODES = ['EPSG:26391', 'EPSG:26392', 'EPSG:26393', 'EPSG:26331', 'EPSG:26332'];

// 1e-7 deg is about 1 cm: far inside any transformation's accuracy, far
// outside any real difference between two EPSG transformations (metres).
const DEG_TOL = 1e-7;

describe('EPSG provenance of MINNA_TO_WGS84', () => {
  test('every catalog transformation equals the EPSG dataset record', () => {
    for (const t of MINNA_TO_WGS84) {
      const g = G.transforms.find((r) => r.code === t.code);
      expect(g).toBeTruthy();
      expect(t.name).toBe(g.name);
      expect(t.method).toBe(g.method);
      expect(t.accuracyM).toBe(g.accuracyM);
      const want = [g.tx, g.ty, g.tz];
      if (g.rx != null) {
        expect(g.rotationUnit).toBe('arc-second');
        expect(g.scaleUnit).toBe('parts per million');
        want.push(g.rx, g.ry, g.rz, g.scaleDifference);
      }
      expect(t.params).toEqual(want);
      expect(t.areaBboxLonLat).toEqual(g.area.bboxLonLat);
      expect(t.areaName).toBe(g.area.description.replace(/\.$/, ''));
    }
  });

  test('the dataset lists nothing for Nigeria that the catalog left out', () => {
    const missing = G.transforms
      .filter((g) => !datumTransformGet(g.code))
      .map((g) => g.code);
    // EPSG:1167 is Cameroon onshore only (EPSG remark: Minna is used in
    // Nigeria, not Cameroon).
    expect(missing).toEqual(['EPSG:1167']);
  });

  test('no Coordinate Frame method sneaks in (it would need rotation signs flipped)', () => {
    for (const t of MINNA_TO_WGS84) expect(t.method).not.toMatch(/Coordinate Frame/i);
  });
});

describe('regional defaults (owner decision 2026-09-22)', () => {
  test('onshore belts, offshore UTM pair and Minna lat/lon', () => {
    expect(catalogGet('EPSG:26391').datumTransform).toBe('EPSG:1754');
    expect(catalogGet('EPSG:26392').datumTransform).toBe('EPSG:1754');
    expect(catalogGet('EPSG:26393').datumTransform).toBe('EPSG:1168');
    expect(catalogGet('EPSG:26331').datumTransform).toBe('EPSG:15706');
    expect(catalogGet('EPSG:26332').datumTransform).toBe('EPSG:15706');
    expect(catalogGet('EPSG:4263').datumTransform).toBe('EPSG:1168');
  });

  test('datumAccuracyM is the published accuracy of the default transformation', () => {
    for (const code of [...MINNA_CODES, 'EPSG:4263']) {
      const e = catalogGet(code);
      expect(e.datumAccuracyM).toBe(datumTransformGet(e.datumTransform).accuracyM);
      expect(e.proj4).toContain(datumTransformGet(e.datumTransform).towgs84);
      expect(e.datumTransformOptions[0]).toBe(e.datumTransform);
    }
  });

  test('options overlap the CRS area; the East Belt cannot use the Niger delta set', () => {
    expect(isDatumTransformOption('EPSG:26393', 'EPSG:1754')).toBe(false);
    expect(isDatumTransformOption('EPSG:26393', 'EPSG:1824')).toBe(true);
    expect(isDatumTransformOption('EPSG:26391', 'EPSG:1168')).toBe(true);
    expect(isDatumTransformOption('EPSG:32631', 'EPSG:1168')).toBe(false);
    expect(() => datumTransformFor('EPSG:26393', 'EPSG:1754')).toThrow(/not a published/);
    expect(() => datumTransformFor('EPSG:32631', 'EPSG:1168')).toThrow(/no selectable/);
    expect(datumTransformFor('EPSG:32631')).toBeNull();
  });

  test('searching Nigeria and Minna each find all five Minna projected systems', () => {
    for (const q of ['Nigeria', 'Minna', 'nigeria', 'MINNA']) {
      const codes = searchCatalog(q).map((e) => e.code);
      for (const c of MINNA_CODES) expect(codes).toContain(c);
    }
  });
});

describe('PROJ oracle', () => {
  test('geographic Minna -> WGS 84 through each named transformation', () => {
    for (const g of G.geographic) {
      if (!datumTransformGet(g.transform)) continue;
      const t = makeTransformer(proj4, catalogDef('EPSG:4263', g.transform), WGS84);
      const p = t.forward(g.lonMinna, g.latMinna);
      expect(Math.abs(p.x - g.lonWgs84)).toBeLessThan(DEG_TOL);
      expect(Math.abs(p.y - g.latWgs84)).toBeLessThan(DEG_TOL);
    }
  });

  test('projected Minna grid -> WGS 84 lon/lat, defaults and overrides', () => {
    expect(G.projected.length).toBeGreaterThanOrEqual(11);
    for (const g of G.projected) {
      const proj = makeProjector(proj4, catalogDef(g.crs, g.transform));
      const ll = proj.toLonLat(g.x, g.y);
      expect(Math.abs(ll.lon - g.lonWgs84)).toBeLessThan(DEG_TOL);
      expect(Math.abs(ll.lat - g.latWgs84)).toBeLessThan(DEG_TOL);
    }
  });

  test('negative control: the old single shift misses the EPSG:1754 answer by metres', () => {
    const g = G.projected.find((r) => r.crs === 'EPSG:26391' && r.transform === 'EPSG:1754');
    const old = makeProjector(proj4, catalogDef('EPSG:26391', 'EPSG:1168')).toLonLat(g.x, g.y);
    const dE = (old.lon - g.lonWgs84) * 111320 * Math.cos((g.latWgs84 * Math.PI) / 180);
    const dN = (old.lat - g.latWgs84) * 110600;
    expect(Math.hypot(dE, dN)).toBeGreaterThan(5);
  });
});

describe('same-datum pairs stay a pure projection change', () => {
  test('West Belt (EPSG:1754) to East Belt (EPSG:1168) injects no datum shift', () => {
    const [a, b] = catalogPairDefs('EPSG:26391', 'EPSG:26393');
    const pure = makeTransformer(
      proj4,
      catalogGet('EPSG:26391').proj4.replace(/\+towgs84=\S+/, ''),
      catalogGet('EPSG:26393').proj4.replace(/\+towgs84=\S+/, ''),
    );
    const got = makeTransformer(proj4, a, b).forward(300000, 400000);
    const want = pure.forward(300000, 400000);
    // 1 mm: proj4 still round-trips through geocentric, float noise only.
    expect(Math.abs(got.x - want.x)).toBeLessThan(1e-3);
    expect(Math.abs(got.y - want.y)).toBeLessThan(1e-3);
    // Without the pairing the two defaults disagree by metres.
    const naive = makeTransformer(proj4, catalogGet('EPSG:26391').proj4, catalogGet('EPSG:26393').proj4)
      .forward(300000, 400000);
    expect(Math.hypot(naive.x - want.x, naive.y - want.y)).toBeGreaterThan(1);
  });

  test('cross-datum pairs honour each side’s chosen transformation', () => {
    const [a, b] = catalogPairDefs('EPSG:26331', 'EPSG:32631', { fromTransform: 'EPSG:1818' });
    expect(a).toContain(datumTransformGet('EPSG:1818').towgs84);
    expect(b).toBe(catalogGet('EPSG:32631').proj4);
  });
});
