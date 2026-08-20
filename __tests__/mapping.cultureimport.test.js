/**
 * W1.3 culture import oracles: shapefile parsing against committed
 * golden binaries (hand-written per the ESRI spec by
 * tools/validation/mapping/culture/gen_shapefiles.py — big-endian file
 * header, little-endian geometry, dBASE III attributes), GeoJSON
 * normalization, reprojection, bbox, and label helpers.
 */

import fs from 'fs';
import path from 'path';
import {
  parseGeoJSON, parseShapefile, parseDbf, reprojectFeatures,
  featuresBBox, geometryTypeOf, labelOf,
} from '../engines/mapping/cultureImport';

const DATA = path.join(__dirname, '..', 'test-data', 'mapping', 'culture');
// Node Buffers are pooled Uint8Array views (nonzero byteOffset) — hand
// them to the parser's Uint8Array path, never raw .buffer
const load = (name) => fs.readFileSync(path.join(DATA, name));
const loadU8 = load;

describe('parseShapefile', () => {
  test('points.shp: two named points, exact coordinates and attributes', () => {
    const { features, skipped, bbox } = parseShapefile(load('points.shp'), load('points.dbf'));
    expect(skipped).toBe(0);
    expect(features).toEqual([
      { type: 'point', x: 500000.0, y: 300000.0, props: { NAME: 'ALPHA-1' } },
      { type: 'point', x: 500250.5, y: 300125.25, props: { NAME: 'BETA-2' } },
    ]);
    expect(bbox).toEqual({ x0: 500000.0, y0: 300000.0, x1: 500250.5, y1: 300125.25 });
  });

  test('lines.shp: one polyline record splits into its two parts', () => {
    const { features } = parseShapefile(load('lines.shp'));
    expect(features).toHaveLength(1);
    expect(features[0].type).toBe('polyline');
    expect(features[0].paths).toEqual([
      [[0, 0], [100, 50], [200, 50]],
      [[500, 500], [600, 625]],
    ]);
  });

  test('blocks.shp: polygon keeps outer ring + hole, dbf numerics parse', () => {
    const { features } = parseShapefile(load('blocks.shp'), load('blocks.dbf'));
    expect(features).toHaveLength(1);
    const f = features[0];
    expect(f.type).toBe('polygon');
    expect(f.rings).toHaveLength(2);
    expect(f.rings[0]).toHaveLength(5);
    expect(f.rings[0][2]).toEqual([1000, 1000]);
    expect(f.rings[1][0]).toEqual([200, 200]);
    expect(f.props).toEqual({ NAME: 'OML-42', AREA_KM2: 0.96 });
  });

  test('pointz.shp: Z tail skipped cleanly, null shape counts as skipped', () => {
    const { features, skipped } = parseShapefile(load('pointz.shp'));
    expect(features).toEqual([{ type: 'point', x: 7.5, y: -3.25, props: {} }]);
    expect(skipped).toBe(1);
  });

  test('Uint8Array input works; junk is refused loudly', () => {
    const { features } = parseShapefile(loadU8('points.shp'));
    expect(features).toHaveLength(2);
    expect(() => parseShapefile(new ArrayBuffer(10))).toThrow(/too short/);
    const junk = new Uint8Array(120);
    expect(() => parseShapefile(junk)).toThrow(/bad magic/);
  });
});

describe('parseDbf standalone', () => {
  test('character trims and numeric conversion', () => {
    const rows = parseDbf(load('blocks.dbf'));
    expect(rows).toEqual([{ NAME: 'OML-42', AREA_KM2: 0.96 }]);
  });
});

describe('parseGeoJSON', () => {
  test('FeatureCollection with every geometry type normalizes and flattens', () => {
    const doc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'p' } },
        { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[3, 4], [5, 6]] }, properties: {} },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: {} },
        {
          type: 'Feature',
          geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[9, 9], [10, 9], [10, 10], [9, 9]]]] },
          properties: { name: 'two blocks' },
        },
      ],
    };
    const { features, skipped } = parseGeoJSON(doc);
    expect(skipped).toBe(0);
    expect(features.map((f) => f.type))
      .toEqual(['point', 'point', 'point', 'polyline', 'polygon', 'polygon']);
    expect(features[0]).toEqual({ type: 'point', x: 1, y: 2, props: { name: 'p' } });
    expect(features[5].rings[0]).toEqual([[9, 9], [10, 9], [10, 10], [9, 9]]);
  });

  test('string input, bare geometry, GeometryCollection, junk counting', () => {
    const { features } = parseGeoJSON('{"type":"Point","coordinates":[7,8]}');
    expect(features).toEqual([{ type: 'point', x: 7, y: 8, props: {} }]);
    const gc = parseGeoJSON({
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [0, 0] },
        { type: 'Bogus' },
        { type: 'LineString', coordinates: [[0, 0]] },   // one vertex: junk
      ],
    });
    expect(gc.features).toHaveLength(1);
    expect(gc.skipped).toBe(2);
    expect(() => parseGeoJSON('nope{')).toThrow(/Not valid JSON/);
  });
});

describe('helpers', () => {
  const set = [
    { type: 'point', x: 5, y: -1, props: { NAME: 'A' } },
    { type: 'polyline', paths: [[[0, 0], [10, 20]]], props: {} },
    { type: 'polygon', rings: [[[2, 2], [3, 2], [3, 3]]], props: { NAME: '' } },
  ];

  test('reprojectFeatures maps every coordinate through the transform', () => {
    const shifted = reprojectFeatures(set, (x, y) => [x + 100, y - 100]);
    expect(shifted[0]).toMatchObject({ x: 105, y: -101 });
    expect(shifted[1].paths[0][1]).toEqual([110, -80]);
    expect(shifted[2].rings[0][0]).toEqual([102, -98]);
    // originals untouched
    expect(set[0].x).toBe(5);
  });

  test('featuresBBox spans all geometry; empty set is null', () => {
    expect(featuresBBox(set)).toEqual({ x0: 0, y0: -1, x1: 10, y1: 20 });
    expect(featuresBBox([])).toBeNull();
  });

  test('geometryTypeOf and labelOf', () => {
    expect(geometryTypeOf(set)).toBe('mixed');
    expect(geometryTypeOf([set[0]])).toBe('point');
    expect(labelOf(set[0], 'NAME')).toBe('A');
    expect(labelOf(set[2], 'NAME')).toBeNull();
    expect(labelOf(set[0], null)).toBeNull();
  });
});
