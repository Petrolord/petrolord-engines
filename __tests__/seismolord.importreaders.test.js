/**
 * Tolerant interpretation readers against COMMITTED dialect fixtures
 * (test-data/seismolord/{picks,faults}, see the README there): every
 * fixture imports with its exact point, horizon, fault and stick
 * counts, lands on a known survey lattice, and bad rows are reported
 * by line and column without sinking the file. The existing round-trip
 * and legacy-contract tests (seismolord.import / .faultimport) stay
 * as they are.
 */
import fs from 'fs';
import path from 'path';

import {
  detectHorizonFormat, parseHorizonFile, gridToPickLattice, parseCharismaTokens,
} from '../engines/seismolord/horizonImport';
import {
  detectFaultFormat, parseFaultSticks, parseFaultStickFile, faultSticksToLattice,
} from '../engines/seismolord/faultImport';
import { rowsToPickLattice } from '../engines/seismolord/pickImport';
import { suggestImportKind } from '../engines/seismolord/importSniff';
import { parseMappedColumns, describeReject, MAX_STORED_REJECTS } from '../engines/seismolord/importText';
import { writeCPS3, writeZMAP } from '../lib/gridding/surfaceExport';
import { NULL_VALUE } from '../engines/seismolord/manifest';

const NULL_F32 = Math.fround(NULL_VALUE);
const DATA = path.join(__dirname, '..', 'test-data', 'seismolord');
const pick = (f) => fs.readFileSync(path.join(DATA, 'picks', f), 'utf8');
const fault = (f) => fs.readFileSync(path.join(DATA, 'faults', f), 'utf8');

// the survey the hand-written fixtures were computed against
const geom = { nIl: 6, nXl: 8, ns: 500 };
const lines = { il0: 1000, ilStep: 2, xl0: 2000, xlStep: 1 };
const affine = {
  origin: { x: 456000, y: 6780000 },
  ilVec: { x: 0, y: 25 },
  xlVec: { x: 12.5, y: 0 },
};
const dtMs = 4;
const zToSample = (z) => z / dtMs;                     // fixtures are positive-down ms
const cell = (il, xl) => ((il - 1000) / 2) * geom.nXl + (xl - 2000);
const truthZ = (il, xl, base = 1500) => base + 4 * ((il - 1000) / 2) + 2 * (xl - 2000);

const counts = (h) => Object.fromEntries(h.horizons.map((x) => [x.name, x.rows.length]));
const stickSizes = (f) => Object.fromEntries(f.faults.map((x) => [x.name, x.sticks.map((s) => s.length)]));

describe('Charisma 3D interpretation lines', () => {
  test('Petrel layout: 12 points, one horizon, lands on 12 exact cells', () => {
    const p = parseHorizonFile(pick('charisma3d_petrel.txt'), { fallbackName: 'H1' });
    expect(p.format).toBe('charisma');
    expect(p.rows).toBe(12);
    expect(counts(p)).toEqual({ H1: 12 });
    expect(p.rejectCount).toBe(0);
    const out = rowsToPickLattice(p.horizons[0].rows, geom, lines, affine, zToSample);
    expect(out.placed).toBe(12);
    expect(out.skipped).toBe(0);
    expect(out.picks[cell(1004, 2003)]).toBeCloseTo(truthZ(1004, 2003) / dtMs, 6);
  });

  test('tester variants: every marker form reads, headers and comments skipped', () => {
    const text = pick('charisma3d_tester_variants.txt');
    expect(detectHorizonFormat(text).format).toBe('charisma');
    const p = parseHorizonFile(text, { fallbackName: 'H1' });
    expect(p.rows).toBe(10);
    expect(p.rejectCount).toBe(0);
    expect(p.ignored).toBe(3);                          // 2 comments + the column header
    const out = rowsToPickLattice(p.horizons[0].rows, geom, lines, affine, zToSample);
    expect(out.placed).toBe(10);
    for (const [il, xl] of [[1006, 2004], [1008, 2006], [1010, 2007]]) {
      expect(out.picks[cell(il, xl)]).toBeCloseTo(truthZ(il, xl) / dtMs, 6);
    }
  });

  test.each([
    ['INLINE : 1001 XLINE : 2001 1 2 3', 1001, 2001, true],
    ['INLINE: 1001 XLINE: 2001 1 2 3', 1001, 2001, true],
    ['INLINE:1001 XLINE:2001 1 2 3', 1001, 2001, true],
    ['INLINE- 1001 2001 1 2 3', 1001, 2001, false],
    ['INLINE - 1001 2001 1 2 3', 1001, 2001, false],
    ['INLINE-1001 2001 1 2 3', 1001, 2001, false],
    ['INLINE -1001 XLINE -2001 1 2 3', 1001, 2001, true],
    ['INLINE 1001 CROSSLINE 2001 1 2 3', 1001, 2001, true],
    ['"Top A" INLINE : 1001 XLINE : 2001 1 2 3', 1001, 2001, true],
  ])('marker form %p', (line, il, xl, marker) => {
    const t = parseCharismaTokens(line);
    expect(t.il).toBe(il);
    expect(t.xl).toBe(xl);
    expect(t.hasXlMarker).toBe(marker);
    expect(t.values).toEqual([1, 2, 3]);
  });

  test('a leading name splits a multi-horizon file, interleaved rows regrouped', () => {
    const p = parseHorizonFile(pick('charisma3d_named_multi.txt'));
    expect(counts(p)).toEqual({ Top_Reservoir: 8, Base_Reservoir: 6 });
    const base = p.horizons.find((h) => h.name === 'Base_Reservoir');
    const out = rowsToPickLattice(base.rows, geom, lines, affine, zToSample);
    expect(out.placed).toBe(6);
    expect(out.picks[cell(1002, 2002)]).toBeCloseTo(truthZ(1002, 2002, 1620) / dtMs, 6);
  });

  test('bad rows are rejected by line and column; the good 9 still import', () => {
    const p = parseHorizonFile(pick('charisma3d_bad_rows.txt'));
    expect(p.rows).toBe(9);
    expect(p.rejectCount).toBe(3);
    expect(p.rejects.map((r) => [r.line, r.column, r.field])).toEqual([
      [4, 9, 'z'],
      [8, 9, 'z'],
      [9, 8, 'y'],
    ]);
    expect(p.rejects[0].reason).toMatch(/"n\/a" is not a number/);
    expect(describeReject(p.rejects[0])).toBe('Line 4, column 9 (z): "n/a" is not a number (expected z)');
    expect(p.rejects[2].text).toMatch(/^INLINE : {3}1004/);
  });

  test('a file with nothing readable is refused, naming lines and columns', () => {
    let err;
    try {
      parseHorizonFile('INLINE : x XLINE : 1 2 3 4\nINLINE : 5 XLINE : 6 7 8 oops\n', { format: 'charisma' });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.message).toMatch(/No horizon picks could be read/);
    expect(err.message).toMatch(/Line 1, column 3 \(inline\)/);
    expect(err.message).toMatch(/Line 2, column 9 \(z\)/);
    expect(err.rejects).toHaveLength(2);
  });

  test('all-zero line numbers (resqpy placeholders) fall back to XY', () => {
    const text = 'INLINE : 0 XLINE : 0 456012.5 6780025 1500\nINLINE : 0 XLINE : 0 456025 6780025 1502\n';
    const p = parseHorizonFile(text);
    expect(p.lineNumbersIgnored).toBe(true);
    const out = rowsToPickLattice(p.horizons[0].rows, geom, lines, affine, zToSample);
    expect(out.placed).toBe(2);
    expect(out.picks[cell(1002, 2001)]).toBeCloseTo(1500 / dtMs, 6);
  });
});

describe('IESX horizons', () => {
  test('Petrel card image, two PROFILE blocks: 6 + 3 points, MAXFLOAT null counted', () => {
    const p = parseHorizonFile(pick('iesx3d_petrel_two_horizons.txt'));
    expect(p.format).toBe('iesx');
    expect(counts(p)).toEqual({ H1_TWT: 6, H2_TWT: 3 });
    expect(p.nulls).toBe(1);
    expect(p.rejectCount).toBe(0);
    const h1 = p.horizons[0];
    expect(h1.rows[4]).toMatchObject({ il: 1002, xl: 2001 });
    const out = rowsToPickLattice(h1.rows, geom, lines, affine, zToSample);
    expect(out.placed).toBe(6);
    expect(out.picks[cell(1002, 2002)]).toBeCloseTo(truthZ(1002, 2002) / dtMs, 6);
  });

  test('OpendTect export (CC0 excerpt): EOD prefixes and echo lines tolerated, 20 points', () => {
    const p = parseHorizonFile(pick('iesx3d_opendtect_segment_excerpt.dat'));
    expect(p.format).toBe('iesx');
    expect(counts(p)).toEqual({ Segment: 20 });
    expect(p.rejectCount).toBe(0);
    expect(p.horizons[0].rows[0]).toEqual({
      x: 620986.88, y: 6080882.36, z: 648.62, il: 376, xl: 914,
    });
  });
});

describe('EarthVision, CPS-3 points and generic columns', () => {
  test('EarthVision scattered data: 12 points named from the description', () => {
    const text = pick('earthvision_scattered.dat');
    expect(detectHorizonFormat(text).format).toBe('earthvision');
    const p = parseHorizonFile(text);
    expect(counts(p)).toEqual({ 'H1_TWT exported from Petrel': 12 });
    const out = rowsToPickLattice(p.horizons[0].rows, geom, lines, affine, zToSample);
    expect(out.placed).toBe(12);
    expect(out.picks[cell(1004, 2003)]).toBeCloseTo(truthZ(1004, 2003) / dtMs, 6);
  });

  test('CPS-3 scattered points: FFASCI/FFATTR/-> headers, 8 points, 1 null', () => {
    const text = pick('cps3_scattered_points.dat');
    expect(detectHorizonFormat(text).format).toBe('cps3points');
    const p = parseHorizonFile(text, { fallbackName: 'H1' });
    expect(p.rows).toBe(8);
    expect(p.nulls).toBe(1);
    expect(p.rejectCount).toBe(0);
  });

  test('generic CSV with a header: mapping suggested from names, two horizons', () => {
    const text = pick('generic_named_horizons.csv');
    const d = detectHorizonFormat(text);
    expect(d.format).toBe('columns');
    expect(d.suggested).toEqual({ name: 0, il: 1, xl: 2, x: 3, y: 4, z: 5 });
    const p = parseHorizonFile(text);
    expect(counts(p)).toEqual({ H_A: 4, H_B: 3 });
  });

  test('OpendTect multi-horizon (CC0 excerpt): commented header + unlisted name column', () => {
    const text = pick('opendtect_multi_named_ilxl_excerpt.dat');
    const d = detectHorizonFormat(text);
    expect(d.format).toBe('columns');
    expect(d.suggested).toEqual({ name: 0, il: 1, xl: 2, z: 3 });
    const p = parseHorizonFile(text);
    expect(counts(p)).toEqual({ F3_Demo_2_FS6: 6, F3_Demo_4_Truncation: 5 });
    expect(p.horizons[1].rows[0]).toEqual({ il: 110, xl: 554, z: 998.13723564147949 });
  });

  test('an explicit mapping overrides detection; bad cells name their column', () => {
    const text = 'a;b;c;d\n1;1000;2000;1500\n2;1002;x;1502\n3;1004;2002\n';
    const p = parseHorizonFile(text, {
      format: 'columns', mapping: { columns: { il: 1, xl: 2, z: 3 }, delimiter: ';' },
    });
    expect(p.rows).toBe(1);
    expect(p.rejects.map((r) => [r.line, r.column, r.field])).toEqual([[3, 3, 'crossline'], [4, 4, 'Z']]);
  });

  test('mapping must be able to place points', () => {
    expect(() => parseMappedColumns('1 2 3', { columns: { z: 2 } }))
      .toThrow(/Map X and Y columns, or inline and crossline/);
    expect(() => parseMappedColumns('1 2 3', { columns: { x: 0, y: 1 } }, { required: ['z'] }))
      .toThrow(/Map a column to Z/);
  });

  test('stored rejects are capped, the count is not', () => {
    const bad = Array.from({ length: MAX_STORED_REJECTS + 5 }, () => '1 2 x').join('\n');
    const p = parseHorizonFile(`${bad}\n1 2 3\n`, { format: 'xyz' });
    expect(p.rejects).toHaveLength(MAX_STORED_REJECTS);
    expect(p.rejectCount).toBe(MAX_STORED_REJECTS + 5);
  });
});

describe('grids as horizons', () => {
  // a 4 x 3 node grid on the survey's own nodes (xl 2000..2003, il 1000..1004)
  const g = {
    nx: 4, ny: 3, x0: 456000, y0: 6780000, dx: 12.5, dy: 25,
    x: [456000, 456012.5, 456025, 456037.5], y: [6780000, 6780025, 6780050],
    z: Float32Array.from([1500, 1502, 1504, 1506, 1504, 1506, 1508, 1510, 1508, 1510, NULL_F32, 1514]),
  };

  test.each([['cps3', writeCPS3], ['zmap', (x) => writeZMAP({ ...x, name: 'g' })]])(
    '%s grid samples onto the lattice; nulls stay holes',
    (fmt, write) => {
      const p = parseHorizonFile(write(g));
      expect(p.format).toBe(fmt);
      expect(p.kind).toBe('grid');
      const out = gridToPickLattice(p.grid, geom, affine, zToSample);
      expect(out.placed).toBe(11);
      expect(out.picks[cell(1002, 2001)]).toBeCloseTo(1506 / dtMs, 3);
      expect(out.picks[cell(1004, 2002)]).toBe(NULL_F32);
    },
  );

  test('a grid off the survey is refused', () => {
    expect(() => gridToPickLattice({ ...g, x0: 0, y0: 0 }, geom, affine, zToSample))
      .toThrow(/No part of this grid lands on the volume/);
  });
});

describe('fault sticks', () => {
  const land = (p) => faultSticksToLattice(p.faults, geom, lines, affine, zToSample);

  test('Charisma (Petrel layout): 2 faults, 4 sticks, 10 points, all placed', () => {
    const p = parseFaultSticks(fault('charisma_faultsticks_petrel.txt'));
    expect(p.format).toBe('charisma');
    expect(p.points).toBe(10);
    expect(stickSizes(p)).toEqual({ Fault_A: [3, 3], Fault_B: [2, 2] });
    const out = land(p);
    expect(out.placed).toBe(10);
    expect(out.skipped).toBe(0);
    expect(out.faults[0].sticks[1].points[0]).toEqual({ il: 3, xl: 2, s: 1410 / dtMs });
  });

  test('Charisma tester variants: split, joined, tabbed, XLINE-marked, quoted names', () => {
    const text = fault('charisma_faultsticks_tester_variants.txt');
    expect(detectFaultFormat(text).format).toBe('charisma');
    const p = parseFaultSticks(text);
    expect(p.points).toBe(9);
    expect(p.ignored).toBe(2);
    expect(p.rejectCount).toBe(0);
    expect(stickSizes(p)).toEqual({ Fault_A: [3, 3], 'Main Fault': [3] });
    expect(land(p).placed).toBe(9);
  });

  test('resqpy writer: inline/crossline 0 placeholders locate by XY', () => {
    const p = parseFaultSticks(fault('charisma_faultsticks_resqpy_zero_lines.txt'));
    expect(p.lineNumbersIgnored).toBe(true);
    expect(stickSizes(p)).toEqual({ F1: [3, 3] });
    const out = land(p);
    expect(out.placed).toBe(6);
    expect(out.faults[0].sticks[1].points[2].il).toBeCloseTo(3, 9);
    expect(out.faults[0].sticks[1].points[2].xl).toBeCloseTo(3, 9);
  });

  test('bad rows: 8 points kept, 3 rejects by line and column', () => {
    const p = parseFaultSticks(fault('charisma_faultsticks_bad_rows.txt'));
    expect(p.points).toBe(8);
    expect(p.rejects.map((r) => [r.line, r.column, r.field])).toEqual([
      [4, 6, 'z'], [7, 7, 'stick'], [8, 5, 'y'],
    ]);
    expect(stickSizes(p)).toEqual({ Fault_A: [3, 2], Fault_B: [3] });
    // the older contract still throws on the first bad row
    expect(() => parseFaultStickFile(fault('charisma_faultsticks_bad_rows.txt'))).toThrow(/^Line 4/);
  });

  test('IESX fault sticks: PROFILE per fault, stick index column, 10 points', () => {
    const text = fault('iesx_faultsticks.txt');
    expect(detectFaultFormat(text).format).toBe('iesx');
    const p = parseFaultSticks(text);
    expect(stickSizes(p)).toEqual({ Fault_A: [3, 3], Fault_B: [2, 2] });
    expect(p.faults[0].sticks[0][0]).toMatchObject({ il: 1002, xl: 2001, z: 1400 });
    expect(p.faults[1].sticks[0][0].il).toBeUndefined();   // 2D-style rows: XY only
    const out = land(p);
    expect(out.placed).toBe(10);
    expect(out.faults[1].sticks[1].points[0].il).toBeCloseTo(4, 9);
  });

  test('generic CSV with column mapping from the header: sticks sorted by number', () => {
    const text = fault('generic_faultsticks.csv');
    const d = detectFaultFormat(text);
    expect(d.format).toBe('columns');
    expect(d.suggested).toEqual({ name: 0, stick: 1, x: 2, y: 3, z: 4 });
    const p = parseFaultSticks(text);
    expect(stickSizes(p)).toEqual({ F_North: [3, 3], F_South: [2, 2] });
    expect(p.faults[0].sticks[0][0].z).toBe(1400);          // stick 1 first though filed second
    expect(land(p).placed).toBe(10);
  });

  test('generic x y z with blank-line stick breaks', () => {
    const p = parseFaultSticks(fault('generic_faultsticks_blankline.dat'), {
      format: 'columns', mapping: { columns: { x: 0, y: 1, z: 2 } }, fallbackName: 'F9',
    });
    expect(stickSizes(p)).toEqual({ F9: [3, 2, 3] });
  });

  test('a Charisma horizon file is refused as fault sticks', () => {
    expect(() => detectFaultFormat(pick('charisma3d_petrel.txt')))
      .toThrow(/Unrecognised fault-stick file.*horizon/);
  });

  test('nothing readable is refused naming the rows', () => {
    expect(() => parseFaultSticks('INLINE- 1 2 3 4 five F 1\nINLINE- 1 2\n', { format: 'charisma' }))
      .toThrow(/No fault sticks could be read.*Line 1, column 6 \(z\).*Line 2/);
  });
});

describe('import kind from content', () => {
  test.each([
    ['picks', 'charisma3d_petrel.txt', 'picks', 'charisma'],
    ['picks', 'charisma3d_tester_variants.txt', 'picks', 'charisma'],
    ['picks', 'iesx3d_petrel_two_horizons.txt', 'picks', 'iesx'],
    ['picks', 'earthvision_scattered.dat', 'picks', 'earthvision'],
    ['picks', 'cps3_scattered_points.dat', 'picks', 'cps3points'],
    ['picks', 'generic_named_horizons.csv', 'picks', 'columns'],
    ['faults', 'charisma_faultsticks_petrel.txt', 'faults', 'charisma'],
    ['faults', 'charisma_faultsticks_tester_variants.txt', 'faults', 'charisma'],
    ['faults', 'iesx_faultsticks.txt', 'faults', 'iesx'],
    ['faults', 'generic_faultsticks.csv', 'faults', 'columns'],
  ])('%s/%s -> %s (%s)', (dir, file, kind, format) => {
    const text = dir === 'picks' ? pick(file) : fault(file);
    expect(suggestImportKind(text)).toMatchObject({ kind, format });
  });

  test('grids are surfaces', () => {
    const g = {
      nx: 2, ny: 2, x0: 0, y0: 0, dx: 1, dy: 1, x: [0, 1], y: [0, 1], z: Float32Array.from([1, 2, 3, 4]),
    };
    expect(suggestImportKind(writeCPS3(g)).kind).toBe('surface');
    expect(suggestImportKind('0 0 1\n1 0 2\n0 1 3\n1 1 4\n')).toMatchObject({ kind: 'surface', format: 'xyz' });
    expect(suggestImportKind('0 0 1\n13.7 1 2\n1 27.3 3\n')).toMatchObject({ kind: 'picks', format: 'xyz' });
  });
});
