/**
 * Surface/pick import mirrors — round-trip against the byte-golden
 * writers (parse(write(g)) reproduces g within each dialect's decimal
 * precision), malformed-file domain errors, and lattice landing /
 * resampling on hand-computed fixtures. The oracle-golden parse tests
 * (committed dome files) run in the Suite.
 */
import {
  detectSurfaceFormat, parseSurfaceFile, parseCPS3, parseZMAP, parseIrapClassic,
  parseXYZGrid, surfaceGridStats,
} from '../lib/gridding/surfaceImport';
import {
  writeXYZ, writeCPS3, writeZMAP, writeIrapClassic,
} from '../lib/gridding/surfaceExport';
import {
  detectPickFormat, parsePickFile, rowsToPickLattice,
} from '../engines/seismolord/pickImport';
import {
  picksToPickRows, writeCharismaHorizon, writeIlXlXyz, writeXyzPoints,
} from '../engines/seismolord/pickExport';
import {
  sampleSurfaceAt, latticeSampleSurface,
} from '../engines/seismolord/surfaceOnLattice';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

/** 5x4 dome-ish grid with a null hole, exact .25-friendly values. */
function fixtureGrid() {
  const nx = 5;
  const ny = 4;
  const z = new Float32Array(nx * ny);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      z[r * nx + c] = -5000 - 12.25 * c - 7.5 * r;
    }
  }
  z[1 * nx + 2] = NULL_F32;
  return {
    nx,
    ny,
    dx: 25,
    dy: 50,
    x0: 1000,
    y0: 2000,
    z,
    x: [1000, 1025, 1050, 1075, 1100],
    y: [2000, 2050, 2100, 2150],
  };
}

const expectGridsClose = (a, b, tol) => {
  expect(a.nx).toBe(b.nx);
  expect(a.ny).toBe(b.ny);
  expect(a.x0).toBeCloseTo(b.x0, 4);
  expect(a.y0).toBeCloseTo(b.y0, 4);
  expect(a.dx).toBeCloseTo(b.dx, 4);
  expect(a.dy).toBeCloseTo(b.dy, 4);
  for (let k = 0; k < a.z.length; k++) {
    const av = a.z[k];
    const bv = b.z[k];
    if (Math.abs(bv) > 1e29) expect(Math.abs(av)).toBeGreaterThan(1e29);
    else expect(Math.abs(av - bv)).toBeLessThanOrEqual(tol);
  }
};

describe('surface import round-trips its own writers', () => {
  const g = fixtureGrid();

  test('XYZ', () => {
    const p = parseSurfaceFile(writeXYZ(g));
    expect(p.format).toBe('xyz');
    expectGridsClose(p, g, 1e-4);
  });

  test('CPS-3', () => {
    const p = parseSurfaceFile(writeCPS3(g));
    expect(p.format).toBe('cps3');
    expectGridsClose(p, g, 1e-4);
  });

  test('ZMAP+', () => {
    const p = parseSurfaceFile(writeZMAP({ ...g, name: 'fixture' }));
    expect(p.format).toBe('zmap');
    expectGridsClose(p, g, 1e-3);
  });

  test('Irap classic', () => {
    const p = parseSurfaceFile(writeIrapClassic(g));
    expect(p.format).toBe('irap');
    expectGridsClose(p, g, 1e-5);
  });

  test('stats see the null hole', () => {
    const s = surfaceGridStats(fixtureGrid());
    expect(s.live).toBe(19);
    expect(s.nulls).toBe(1);
    expect(s.zMax).toBeCloseTo(-5000, 5);
  });
});

describe('surface import malformed-file errors', () => {
  test('empty file', () => {
    expect(() => detectSurfaceFormat('')).toThrow(/empty/);
  });

  test('CPS-3 with a lying node count names the mismatch', () => {
    const text = 'FSASCI 0 1 "x" 0 1.0E+30\nFSLIMI 0 100 0 100 -1 1\nFSNROW 3 3\nFSXINC 50 50\n1 2 3 4\n';
    expect(() => parseCPS3(text)).toThrow(/4 values.*promises 9/s);
  });

  test('ZMAP+ without a closing @ is rejected', () => {
    expect(() => parseZMAP('@g HEADER, GRID, 5\n20, 1e30, , 7, 1\n2, 2, 0, 1, 0, 1\n'))
      .toThrow(/never closes/);
  });

  test('rotated Irap grids are refused with the rotation named', () => {
    const text = '-996 2 25 25\n0 25 0 25\n2 30.000000 0 0\n0 0 0 0 0 0 0\n1 2 3 4\n';
    expect(() => parseIrapClassic(text)).toThrow(/rotation 30/);
  });

  test('scattered XYZ points are refused (import does not grid)', () => {
    const text = '0 0 1\n13.7 1 2\n1 27.3 3\n40 40 4\n';
    expect(() => parseXYZGrid(text)).toThrow(/not regularly spaced|re-grid/);
  });

  test('non-numeric body value carries its line number', () => {
    const text = '-996 2 25 25\n0 25 0 25\n2 0 0 0\n0 0 0 0 0 0 0\n1 oops 3 4\n';
    expect(() => parseIrapClassic(text)).toThrow(/Line 5/);
  });
});

describe('pick import round-trips its own writers', () => {
  const geom = { nIl: 3, nXl: 4, ns: 64 };
  const lines = { il0: 10, ilStep: 2, xl0: 200, xlStep: 3 };
  const affine = {
    origin: { x: 500000, y: 6700000 },
    ilVec: { x: 0, y: 25 },
    xlVec: { x: 25, y: 0 },
  };
  const picks = new Float32Array(12).fill(NULL_F32);
  picks[0] = 10.25;
  picks[5] = 20.5;
  picks[11] = 40;
  const dtMs = 4;
  const rows = picksToPickRows(picks, geom, affine, (s) => -(s * dtMs), lines);

  test('Charisma text lands back on the identical lattice cells', () => {
    const { format, rows: parsed } = parsePickFile(writeCharismaHorizon(rows));
    expect(format).toBe('charisma');
    const out = rowsToPickLattice(parsed, geom, lines, affine, (z) => -z / dtMs);
    expect(out.placed).toBe(3);
    expect(out.skipped).toBe(0);
    expect(out.collisions).toBe(0);
    for (const cell of [0, 5, 11]) {
      expect(Math.abs(out.picks[cell] - picks[cell])).toBeLessThan(1e-4 / dtMs + 1e-9);
    }
    expect(out.picks[1]).toBe(NULL_F32);
  });

  test('five-column text round-trips through il/xl numbering', () => {
    const { format, rows: parsed } = parsePickFile(writeIlXlXyz(rows));
    expect(format).toBe('ilxlxyz');
    const out = rowsToPickLattice(parsed, geom, lines, affine, (z) => -z / dtMs);
    expect(out.placed).toBe(3);
  });

  test('bare XYZ text locates cells through the inverse affine', () => {
    const { format, rows: parsed } = parsePickFile(writeXyzPoints(rows));
    expect(format).toBe('xyz');
    const out = rowsToPickLattice(parsed, geom, lines, affine, (z) => -z / dtMs);
    expect(out.placed).toBe(3);
    expect(out.picks[5]).toBeCloseTo(20.5, 3);
  });

  test('off-lattice line numbers and out-of-range times are counted, not invented', () => {
    const parsed = [
      { il: 11, xl: 200, z: 40 },            // il0 10 step 2 -> off-step
      { il: 10, xl: 200, z: 40 },            // good
      { il: 12, xl: 203, z: 9999 },          // sample 2499.75 > ns-1
      { il: 99, xl: 200, z: 40 },            // outside the survey
    ];
    const out = rowsToPickLattice(parsed, geom, lines, null, (z) => z / dtMs);
    expect(out.placed).toBe(1);
    expect(out.skipped).toBe(3);
  });

  test('nothing landing is a domain error, not an empty horizon', () => {
    expect(() => rowsToPickLattice(
      [{ il: 1, xl: 1, z: 40 }], geom, lines, null, (z) => z / dtMs,
    )).toThrow(/No picks landed/);
  });

  test('a colliding cell keeps the last row and counts the collision', () => {
    const out = rowsToPickLattice(
      [{ il: 10, xl: 200, z: 40 }, { il: 10, xl: 200, z: 80 }],
      geom, lines, null, (z) => z / dtMs,
    );
    expect(out.placed).toBe(1);
    expect(out.collisions).toBe(1);
    expect(out.picks[0]).toBeCloseTo(20, 6);
  });
});

describe('surface -> lattice resampling', () => {
  const g = fixtureGrid();   // x0 1000, dx 25; y0 2000, dy 50; null at r1,c2

  test('bilinear interior sample is exact for a bilinear field', () => {
    // away from the null hole the fixture is linear in c and r
    const v = sampleSurfaceAt(g, 1012.5, 2025);        // c=0.5, r=0.5
    expect(v).toBeCloseTo(-5000 - 12.25 * 0.5 - 7.5 * 0.5, 4);
  });

  test('outside the extent and beside the null hole go null', () => {
    expect(Math.abs(sampleSurfaceAt(g, 900, 2025))).toBeGreaterThan(1e29);
    // support square (c2..c3, r0..r1) contains the null node
    expect(Math.abs(sampleSurfaceAt(g, 1062, 2025))).toBeGreaterThan(1e29);
  });

  test('lattice resample lands values through the affine and counts live cells', () => {
    const affine = {
      origin: { x: 1000, y: 2000 },
      ilVec: { x: 0, y: 50 },                          // il along +Y, one surface row
      xlVec: { x: 25, y: 0 },                          // xl along +X, one surface col
    };
    const geom = { nIl: 4, nXl: 5 };
    const { values, live } = latticeSampleSurface(g, affine, geom);
    // lattice == surface nodes here, so values equal the grid (nulls kept)
    expect(live).toBe(19);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 5; j++) {
        const a = values[i * 5 + j];
        const b = g.z[i * 5 + j];
        if (Math.abs(b) > 1e29) expect(Math.abs(a)).toBeGreaterThan(1e29);
        else expect(a).toBeCloseTo(b, 4);
      }
    }
  });
});
