/**
 * Lattice -> world-grid resampling (the amplitude-map export path).
 * Validation-first: bilinear interpolation composed with an affine
 * lattice->world map is EXACT on fields linear in world coordinates,
 * so a rotated survey carrying v = A + Bx + Cy must reproduce
 * A + Bx + Cy at every live export node in closed form. Null policy
 * and the latticeSampleSurface round-trip pin the rest.
 */
import {
  sampleLatticeAt, latticeToWorldGrid, latticeSampleSurface,
} from '../engines/seismolord/surfaceOnLattice';
import { ilxlToWorld } from '../engines/seismolord/surveyGeometry';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

// rotated (30 deg), non-square-bin survey affine
const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);
const AFF = {
  origin: { x: 5000, y: 12000 },
  ilVec: { x: 25 * COS, y: 25 * SIN },
  xlVec: { x: -12.5 * SIN, y: 12.5 * COS },
};
const GEOM = { nIl: 21, nXl: 31 };

const linearField = (A, B, C) => {
  const v = new Float32Array(GEOM.nIl * GEOM.nXl);
  for (let i = 0; i < GEOM.nIl; i++) {
    for (let j = 0; j < GEOM.nXl; j++) {
      const w = ilxlToWorld(AFF, i, j);
      v[i * GEOM.nXl + j] = A + B * w.x + C * w.y;
    }
  }
  return v;
};

describe('sampleLatticeAt', () => {
  const values = Float32Array.from([1, 2, 3, 4, 5, 6]); // 2 x 3
  const geom = { nIl: 2, nXl: 3 };

  test('bilinear inside, exact on nodes', () => {
    expect(sampleLatticeAt(values, geom, 0, 0)).toBe(1);
    expect(sampleLatticeAt(values, geom, 1, 2)).toBe(6);
    expect(sampleLatticeAt(values, geom, 0.5, 0.5)).toBeCloseTo((1 + 2 + 4 + 5) / 4, 12);
  });

  test('outside the lattice is null', () => {
    expect(sampleLatticeAt(values, geom, -0.01, 1)).toBe(NULL_VALUE);
    expect(sampleLatticeAt(values, geom, 1.01, 1)).toBe(NULL_VALUE);
    expect(sampleLatticeAt(values, geom, 0.5, 2.01)).toBe(NULL_VALUE);
  });

  test('contributing null corner poisons; zero-weight null corner does not', () => {
    const holed = Float32Array.from([1, NULL_F32, 3, 4, 5, 6]);
    // between live (0,0) and the null (0,1): null, no invented values
    expect(sampleLatticeAt(holed, geom, 0, 0.5)).toBe(NULL_VALUE);
    // exactly ON the live node beside the hole: the hole has weight 0
    expect(sampleLatticeAt(holed, geom, 0, 0)).toBe(1);
    expect(sampleLatticeAt(holed, geom, 1, 1)).toBe(5);
  });
});

describe('latticeToWorldGrid', () => {
  test('exact on a world-linear field across a rotated survey', () => {
    const A = 0.75;
    const B = 3e-4;
    const C = -2e-4;
    const values = linearField(A, B, C);
    // a spec inset well inside the survey so every node is live
    const c0 = ilxlToWorld(AFF, 6, 8);
    const spec = { x0: c0.x, y0: c0.y, dx: 5, dy: 5, nx: 12, ny: 9 };
    const { z, live, vMin, vMax } = latticeToWorldGrid(values, AFF, GEOM, spec);
    expect(live).toBe(spec.nx * spec.ny);
    for (let r = 0; r < spec.ny; r++) {
      for (let c = 0; c < spec.nx; c++) {
        const truth = A + B * (spec.x0 + c * spec.dx) + C * (spec.y0 + r * spec.dy);
        expect(z[r * spec.nx + c]).toBeCloseTo(truth, 5); // float32 storage
      }
    }
    expect(vMin).toBeLessThan(vMax);
  });

  test('nodes outside the rotated survey stay null and are excluded from stats', () => {
    const values = linearField(1, 0, 0); // constant 1 everywhere live
    // axis-aligned bbox of a rotated survey necessarily has corners
    // outside the survey polygon
    const xs = [];
    const ys = [];
    for (const [i, j] of [[0, 0], [0, GEOM.nXl - 1], [GEOM.nIl - 1, 0], [GEOM.nIl - 1, GEOM.nXl - 1]]) {
      const w = ilxlToWorld(AFF, i, j);
      xs.push(w.x);
      ys.push(w.y);
    }
    const b = {
      x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
    };
    const spec = {
      x0: b.x0, y0: b.y0, dx: 10, dy: 10,
      nx: Math.floor((b.x1 - b.x0) / 10) + 1,
      ny: Math.floor((b.y1 - b.y0) / 10) + 1,
    };
    const { z, live, vMin, vMax } = latticeToWorldGrid(values, AFF, GEOM, spec);
    expect(live).toBeGreaterThan(0);
    expect(live).toBeLessThan(spec.nx * spec.ny); // bbox corners off-survey
    expect(vMin).toBe(1);
    expect(vMax).toBe(1);
    let nulls = 0;
    for (const v of z) {
      if (v === NULL_F32) nulls += 1;
      else expect(v).toBe(1);
    }
    expect(nulls).toBe(spec.nx * spec.ny - live);
  });

  test('null holes in the lattice never invent values', () => {
    const values = linearField(2, 0, 0);
    values[10 * GEOM.nXl + 15] = NULL_F32;
    const c0 = ilxlToWorld(AFF, 9, 14);
    const spec = { x0: c0.x, y0: c0.y, dx: 4, dy: 4, nx: 10, ny: 10 };
    const { z, live } = latticeToWorldGrid(values, AFF, GEOM, spec);
    expect(live).toBeLessThan(spec.nx * spec.ny); // the hole shadows nodes
    for (const v of z) {
      if (v !== NULL_F32) expect(v).toBe(2);
    }
  });

  test('round-trips latticeSampleSurface on a linear field', () => {
    const A = -1.5;
    const B = 1e-4;
    const C = 4e-4;
    const values = linearField(A, B, C);
    const c0 = ilxlToWorld(AFF, 3, 4);
    const spec = { x0: c0.x, y0: c0.y, dx: 6, dy: 6, nx: 40, ny: 30 };
    const world = latticeToWorldGrid(values, AFF, GEOM, spec);
    const g = {
      nx: spec.nx, ny: spec.ny, x0: spec.x0, y0: spec.y0, dx: spec.dx, dy: spec.dy, z: world.z,
    };
    const back = latticeSampleSurface(g, AFF, GEOM);
    expect(back.live).toBeGreaterThan(0);
    for (let i = 0; i < GEOM.nIl; i++) {
      for (let j = 0; j < GEOM.nXl; j++) {
        const v = back.values[i * GEOM.nXl + j];
        if (v === NULL_F32) continue; // outside the inset export grid
        expect(v).toBeCloseTo(values[i * GEOM.nXl + j], 4);
      }
    }
  });

  test('unusable affine throws a domain error', () => {
    const values = linearField(1, 0, 0);
    const degenerate = {
      origin: { x: 0, y: 0 }, ilVec: { x: 1, y: 0 }, xlVec: { x: 2, y: 0 },
    };
    expect(() => latticeToWorldGrid(values, degenerate, GEOM,
      { x0: 0, y0: 0, dx: 1, dy: 1, nx: 2, ny: 2 })).toThrow(/survey coordinates/);
    expect(() => latticeToWorldGrid(values, null, GEOM,
      { x0: 0, y0: 0, dx: 1, dy: 1, nx: 2, ny: 2 })).toThrow(/survey coordinates/);
  });
});

describe('ZMAP CRS stamp (CRS program, Phase 8)', () => {
  test('a crsLabel adds one comment line; absent label leaves output byte-identical', async () => {
    const { writeZMAP, NULL_VALUE } = await import('../lib/gridding/surfaceExport');
    const g = {
      name: 'top_x', nx: 2, ny: 2, dx: 25, dy: 25,
      x: [0, 25], y: [0, 25],
      z: Float32Array.from([1, 2, 3, NULL_VALUE ?? 1.0e30]),
    };
    const plain = writeZMAP(g);
    const stamped = writeZMAP({ ...g, crsLabel: 'EPSG:32631 (WGS 84 / UTM zone 31N)' });
    expect(stamped).toContain('!  CRS: EPSG:32631 (WGS 84 / UTM zone 31N)');
    expect(stamped.split('\n').filter((l) => !l.startsWith('!  CRS:')).join('\n')).toBe(plain);
    expect(plain).not.toContain('!  CRS:');
  });
});
