/**
 * W0.1 manifest version gate: readers must refuse manifests written by a
 * newer schema (or a brick encoding they cannot decode) LOUDLY, at the
 * single geometry choke point, instead of decoding future bricks as raw
 * float32 garbage. v1 and pre-versioning manifests pass unchanged.
 */

import {
  MANIFEST_VERSION,
  DERIVED_MANIFEST_VERSION,
  MANIFEST_READ_MAX,
  assertManifestSupported,
  UnsupportedManifestError,
} from '../engines/seismolord/manifest';
import { geomFromManifest } from '../engines/seismolord/sliceAssembly';

const v1Manifest = (overrides = {}) => ({
  manifest_version: 1,
  app: 'seismolord',
  geometry: {
    il: { min: 100, max: 109, step: 1, count: 10 },
    xl: { min: 200, max: 219, step: 1, count: 20 },
    ns: 128,
    dt_us: 4000,
  },
  brick: {
    size: 64,
    grid: [1, 1, 2],
    count: 2,
    dtype: 'float32le',
    layout: 'il-major,xl,sample-fastest',
    path_pattern: 'bricks/{i}-{j}-{k}.f32',
  },
  ...overrides,
});

describe('assertManifestSupported', () => {
  test('the read ceiling covers every writer version today', () => {
    // v1 = ingested seismic, v2 = derived volumes (W2.1), v3 = 2D lines (W5.1)
    expect(MANIFEST_READ_MAX).toBe(3);
    expect(MANIFEST_READ_MAX).toBeGreaterThanOrEqual(DERIVED_MANIFEST_VERSION);
    expect(MANIFEST_READ_MAX).toBeGreaterThanOrEqual(MANIFEST_VERSION);
  });

  test('a v1 manifest passes unchanged', () => {
    expect(() => assertManifestSupported(v1Manifest())).not.toThrow();
  });

  test('a v2 (derived-volume) manifest passes', () => {
    expect(() => assertManifestSupported(v1Manifest({ manifest_version: 2 })))
      .not.toThrow();
  });

  test('a pre-versioning manifest (no manifest_version) passes', () => {
    const m = v1Manifest();
    delete m.manifest_version;
    expect(() => assertManifestSupported(m)).not.toThrow();
  });

  test('a pre-gate brick block without dtype passes (v1-era by construction)', () => {
    const m = v1Manifest();
    delete m.brick.dtype;
    expect(() => assertManifestSupported(m)).not.toThrow();
  });

  test('a future manifest_version is refused by name', () => {
    const m = v1Manifest({ manifest_version: 99 });
    expect(() => assertManifestSupported(m)).toThrow(UnsupportedManifestError);
    try {
      assertManifestSupported(m);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.name).toBe('UNSUPPORTED_MANIFEST');
      expect(e.message).toMatch(/version 99/);
    }
  });

  test('a foreign brick dtype is refused even at version 1 (int16le-scaled joined the accepted set in W4.4)', () => {
    const ok = v1Manifest();
    ok.brick.dtype = 'int16le-scaled';
    expect(() => assertManifestSupported(ok)).not.toThrow();
    const m = v1Manifest();
    m.brick.dtype = 'int8le';
    expect(() => assertManifestSupported(m)).toThrow(UnsupportedManifestError);
    try {
      assertManifestSupported(m);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.name).toBe('UNSUPPORTED_MANIFEST');
      expect(e.message).toMatch(/int8le/);
    }
  });
});

describe('geomFromManifest gate wiring', () => {
  test('v1 geometry extraction is unchanged', () => {
    expect(geomFromManifest(v1Manifest())).toEqual({
      nIl: 10, nXl: 20, ns: 128, brickSize: 64, grid: [1, 1, 2],
    });
  });

  test('the choke point refuses a future manifest', () => {
    expect(() => geomFromManifest(v1Manifest({ manifest_version: MANIFEST_READ_MAX + 1 })))
      .toThrow(UnsupportedManifestError);
  });

  test('the choke point refuses a foreign brick dtype', () => {
    const m = v1Manifest();
    m.brick.dtype = 'float64le';
    expect(() => geomFromManifest(m)).toThrow(UnsupportedManifestError);
  });
});
