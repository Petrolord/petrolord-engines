// Fault-stick READERS — the import mirror of pickExport's fault-stick
// writer. Two ASCII dialects:
//
//  - Charisma fault sticks (Petrel "Charisma fault sticks", the
//    seismiqb FAULT_STICKS column layout): 8+ whitespace tokens per row
//    `INLINE- <il> <xl> <x> <y> <z> <name> <stick#>`. Distinguished
//    from a Charisma 3D HORIZON row (also INLINE-marked) by the second
//    token: horizons carry the literal `:` there, fault sticks carry
//    the inline number. Fault names may contain spaces — the name is
//    every token between z and the trailing stick number.
//  - Plain `x y z stick#` rows (generic single-fault stick export; the
//    fault takes the caller's name).
//
// Errors are plain row-numbered domain Errors (the wellImport house
// style); parsing throws on the first bad row. Lattice mapping COUNTS
// what it skips (off-survey, out of time range) and what it drops
// (sticks left with fewer than two points).
//
// ORDER IS LOAD-BEARING: faultBarriers walks crossings in stored stick
// order and interpMesh lofts ribbons between consecutive sticks, so
// sticks are emitted sorted by their file stick number and points keep
// file order within a stick.

import { worldToIlxl } from './surveyGeometry';

const isComment = (s) => s.startsWith('#') || s.startsWith('!') || s.startsWith('//');
const numbersOf = (s) => s.split(/[\s,]+/).filter(Boolean).map(Number);

/**
 * Sniff a fault-stick file's dialect from its first content line.
 * @returns {'charisma'|'xyzn'}
 */
export function detectFaultStickFormat(text) {
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || isComment(s)) continue;
    const tok = s.split(/\s+/);
    if (/^INLINE/i.test(tok[0]) && tok.length >= 8 && Number.isFinite(Number(tok[1]))) {
      return 'charisma';
    }
    const nums = numbersOf(s);
    if (nums.length >= 4 && nums.slice(0, 4).every(Number.isFinite)) return 'xyzn';
    throw new Error(`Unrecognised fault-stick file: first data line is "${s}".`);
  }
  throw new Error('The file is empty.');
}

/**
 * Parse a fault-stick file into named faults with ordered sticks.
 *
 * Rows group by fault name (first-appearance order), then by stick
 * number (ascending); points keep file order within a stick. The
 * `xyzn` dialect has no name column — its single fault is named
 * `fallbackName`.
 *
 * @returns {{format: string, faults: Array<{name: string,
 *   sticks: Array<Array<{il?: number, xl?: number, x: number,
 *   y: number, z: number}>>}>, points: number}}
 */
export function parseFaultStickFile(text, format = null, fallbackName = 'Imported fault') {
  const fmt = format || detectFaultStickFormat(text);
  const byFault = new Map(); // name -> Map(stickNo -> points[])
  let points = 0;
  const raw = text.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i].trim();
    if (!s || isComment(s)) continue;
    const n = i + 1;
    let name;
    let stickNo;
    let pt;
    if (fmt === 'charisma') {
      const tok = s.split(/\s+/);
      if (tok.length < 8) {
        throw new Error(`Line ${n}: Charisma fault-stick rows need 8 columns, got ${tok.length}.`);
      }
      const il = Number(tok[1]);
      const xl = Number(tok[2]);
      const x = Number(tok[3]);
      const y = Number(tok[4]);
      const z = Number(tok[5]);
      stickNo = Number(tok[tok.length - 1]);
      name = tok.slice(6, tok.length - 1).join(' ');
      if (![il, xl, x, y, z].every(Number.isFinite) || !Number.isFinite(stickNo)) {
        throw new Error(`Line ${n}: non-numeric inline/crossline/x/y/z/stick in "${s}".`);
      }
      if (!name) throw new Error(`Line ${n}: missing fault name in "${s}".`);
      pt = { il, xl, x, y, z };
    } else {
      const v = numbersOf(s);
      if (v.length < 4 || !v.slice(0, 4).every(Number.isFinite)) {
        throw new Error(`Line ${n}: expected "x y z stick#", got "${s}".`);
      }
      name = fallbackName;
      stickNo = v[3];
      pt = { x: v[0], y: v[1], z: v[2] };
    }
    if (!byFault.has(name)) byFault.set(name, new Map());
    const sticks = byFault.get(name);
    if (!sticks.has(stickNo)) sticks.set(stickNo, []);
    sticks.get(stickNo).push(pt);
    points += 1;
  }
  if (!points) throw new Error('The file has no fault-stick rows.');
  const faults = [...byFault.entries()].map(([name, sticks]) => ({
    name,
    sticks: [...sticks.keys()].sort((a, b) => a - b).map((k) => sticks.get(k)),
  }));
  return { format: fmt, faults, points };
}

/**
 * Land parsed fault sticks on the volume lattice as the stored
 * seismic_faults stick shape.
 *
 * Unlike horizon picks, stick points are CONTINUOUS lattice positions
 * (fractional il/xl indices draw, project and cross exactly —
 * faultBarriers and the 3D ribbons interpolate). Rows with il/xl line
 * numbers use them directly; xyzn rows resolve through the inverse
 * survey affine. A point more than half a bin outside the survey, or
 * whose z falls outside the volume time window, is skipped; a stick
 * left with fewer than two points is dropped whole (a one-point stick
 * cannot draw or loft).
 *
 * @param {Array<{name, sticks}>} faults parseFaultStickFile output
 * @param {{nIl: number, nXl: number, ns: number}} geom
 * @param {{il0: number, ilStep: number, xl0: number, xlStep: number}} lines
 * @param {?Object} affine survey affine (needed for xyzn rows only)
 * @param {(z: number) => number} zToSample positive-down ms -> sample
 * @returns {{faults: Array<{name: string,
 *   sticks: Array<{points: {il, xl, s}[]}>}>, placed: number,
 *   skipped: number, droppedSticks: number}}
 */
export function faultSticksToLattice(faults, geom, lines, affine, zToSample) {
  const out = [];
  let placed = 0;
  let skipped = 0;
  let droppedSticks = 0;
  for (const f of faults) {
    const sticks = [];
    for (const stick of f.sticks) {
      const pts = [];
      for (const r of stick) {
        let i;
        let j;
        if (r.il != null && r.xl != null) {
          i = (r.il - lines.il0) / lines.ilStep;
          j = (r.xl - lines.xl0) / lines.xlStep;
        } else {
          if (!affine) throw new Error('XYZ fault sticks need survey coordinates to locate cells.');
          const g = worldToIlxl(affine, r.x, r.y);
          if (!g) throw new Error('The survey affine is not invertible — cannot place fault sticks.');
          i = g.i;
          j = g.j;
        }
        if (i < -0.5 || j < -0.5 || i > geom.nIl - 0.5 || j > geom.nXl - 0.5) {
          skipped += 1;
          continue;
        }
        const s = zToSample(r.z);
        if (!Number.isFinite(s) || s < 0 || s > geom.ns - 1) { skipped += 1; continue; }
        pts.push({ il: i, xl: j, s });
        placed += 1;
      }
      if (pts.length >= 2) sticks.push({ points: pts });
      else {
        droppedSticks += 1;
        placed -= pts.length;
        skipped += pts.length;
      }
    }
    if (sticks.length) out.push({ name: f.name, sticks });
  }
  if (!placed) {
    throw new Error('No fault sticks landed on this volume\'s lattice — check that the '
      + 'file belongs to this survey (line numbering, coordinates and time range).');
  }
  return { faults: out, placed, skipped, droppedSticks };
}
