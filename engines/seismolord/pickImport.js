// Horizon pick READERS — the import mirror of pickExport's writers:
// Charisma 3D horizon rows, five-column il/xl/x/y/z points and bare
// xyz points, plus the mapper that lands parsed rows on a volume's
// il/xl lattice as a pick grid (sample indices, 1e30 nulls) ready for
// horizonsService.saveHorizon.
//
// Errors are plain row-numbered domain Errors (the wellImport house
// style). Malformed rows never silently vanish: parsing throws on the
// first bad row; lattice mapping COUNTS what it skips (off-survey,
// off-lattice, out of time range) and reports collisions.

import { NULL_VALUE } from './manifest';
import { worldToIlxl } from './surveyGeometry';

const NULL_F32 = Math.fround(NULL_VALUE);

const isComment = (s) => s.startsWith('#') || s.startsWith('!') || s.startsWith('//');
const numbersOf = (s) => s.split(/[\s,]+/).filter(Boolean).map(Number);

/**
 * Sniff a pick file's dialect from its first content line.
 * @returns {'charisma'|'ilxlxyz'|'xyz'}
 */
export function detectPickFormat(text) {
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || isComment(s)) continue;
    const tok = s.split(/\s+/);
    if (tok.some((t) => /^INLINE/i.test(t))) return 'charisma';
    const nums = numbersOf(s);
    if (nums.length >= 5 && nums.slice(0, 5).every(Number.isFinite)) return 'ilxlxyz';
    if (nums.length >= 3 && nums.slice(0, 3).every(Number.isFinite)) return 'xyz';
    throw new Error(`Unrecognised pick file: first data line is "${s}".`);
  }
  throw new Error('The file is empty.');
}

/**
 * Parse a pick file into labeled rows.
 * Charisma rows are 9+ whitespace tokens (markers at 1/2 and 4/5,
 * inline at 3, crossline at 6, then x y z); five-column rows are
 * `il xl x y z`; xyz rows are `x y z` (il/xl resolved later through
 * the survey affine).
 * @returns {{format: string, rows: Array<{il?: number, xl?: number,
 *   x?: number, y?: number, z: number}>}}
 */
export function parsePickFile(text, format = null) {
  const fmt = format || detectPickFormat(text);
  const rows = [];
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i].trim();
    if (!s || isComment(s)) continue;
    const n = i + 1;
    if (fmt === 'charisma') {
      const tok = s.split(/\s+/);
      if (tok.length < 9) {
        throw new Error(`Line ${n}: Charisma rows need 9 columns, got ${tok.length}.`);
      }
      const il = Number(tok[2]);
      const xl = Number(tok[5]);
      const x = Number(tok[6]);
      const y = Number(tok[7]);
      const z = Number(tok[8]);
      if (![il, xl, x, y, z].every(Number.isFinite)) {
        throw new Error(`Line ${n}: non-numeric inline/crossline/x/y/z in "${s}".`);
      }
      rows.push({ il, xl, x, y, z });
    } else if (fmt === 'ilxlxyz') {
      const v = numbersOf(s);
      if (v.length < 5 || !v.slice(0, 5).every(Number.isFinite)) {
        throw new Error(`Line ${n}: expected "il xl x y z", got "${s}".`);
      }
      rows.push({ il: v[0], xl: v[1], x: v[2], y: v[3], z: v[4] });
    } else {
      const v = numbersOf(s);
      if (v.length < 3 || !v.slice(0, 3).every(Number.isFinite)) {
        throw new Error(`Line ${n}: expected "x y z", got "${s}".`);
      }
      rows.push({ x: v[0], y: v[1], z: v[2] });
    }
  }
  if (!rows.length) throw new Error('The file has no pick rows.');
  return { format: fmt, rows };
}

/**
 * Land parsed rows on the volume lattice as a pick grid.
 *
 * Rows with il/xl numbers use them directly (they must sit on the
 * survey's numbering: (il - il0) divisible by the step); bare xyz rows
 * resolve through the inverse survey affine to the NEAREST cell.
 * z (positive-down ms) converts through zToSample; samples outside
 * [0, ns-1] are skipped (the volume cannot display them). A cell hit
 * twice keeps the LAST row and counts a collision.
 *
 * @param {Array<{il?, xl?, x?, y?, z}>} rows
 * @param {{nIl: number, nXl: number, ns: number}} geom
 * @param {{il0: number, ilStep: number, xl0: number, xlStep: number}} lines
 * @param {?Object} affine survey affine (needed for xyz rows only)
 * @param {(z: number) => number} zToSample positive-down ms -> sample
 * @returns {{picks: Float32Array, placed: number, skipped: number,
 *   collisions: number}}
 */
export function rowsToPickLattice(rows, geom, lines, affine, zToSample) {
  const picks = new Float32Array(geom.nIl * geom.nXl).fill(NULL_F32);
  let placed = 0;
  let skipped = 0;
  let collisions = 0;
  for (const r of rows) {
    let i;
    let j;
    if (r.il != null && r.xl != null) {
      i = (r.il - lines.il0) / lines.ilStep;
      j = (r.xl - lines.xl0) / lines.xlStep;
      if (!Number.isInteger(i) || !Number.isInteger(j)) { skipped += 1; continue; }
    } else {
      if (!affine) throw new Error('XYZ picks need survey coordinates to locate cells.');
      const g = worldToIlxl(affine, r.x, r.y);
      if (!g) throw new Error('The survey affine is not invertible — cannot place XYZ picks.');
      i = Math.round(g.i);
      j = Math.round(g.j);
      // a point more than half a bin outside the survey is not ours
      if (g.i < -0.5 || g.j < -0.5 || g.i > geom.nIl - 0.5 || g.j > geom.nXl - 0.5) {
        skipped += 1;
        continue;
      }
    }
    if (i < 0 || i >= geom.nIl || j < 0 || j >= geom.nXl) { skipped += 1; continue; }
    const s = zToSample(r.z);
    if (!Number.isFinite(s) || s < 0 || s > geom.ns - 1) { skipped += 1; continue; }
    const cell = i * geom.nXl + j;
    if (picks[cell] !== NULL_F32) collisions += 1;
    else placed += 1;
    picks[cell] = s;
  }
  if (!placed) {
    throw new Error('No picks landed on this volume\'s lattice — check that the file '
      + 'belongs to this survey (line numbering, coordinates and time range).');
  }
  return { picks, placed, skipped, collisions };
}
