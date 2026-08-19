// Horizon PICK export writers — the interpretation itself (the il/xl
// pick lattice), as opposed to the gridded SURFACE writers in
// lib/gridding/surfaceExport. Picks travel as labeled interpretation
// points (inline, crossline, world X/Y, Z) in the ASCII dialects the
// major interpretation packages import:
//
//  - Charisma 3D horizon: 9 whitespace tokens per row —
//    `INLINE : <il> XLINE : <xl> <x> <y> <z>` (Petrel "Charisma 3D
//    interpretation", also read by OpendTect/seismiqb-style loaders,
//    which skip the marker tokens and take columns 3/6/7/8/9).
//  - IL/XL/X/Y/Z points: plain five-column ASCII (Petrel generic
//    points/interpretation import with column mapping; Kingdom,
//    SeisWorks-style loaders).
//  - XYZ points: bare three-column x y z.
//
// Only LIVE picks are written — a null lattice node is simply absent
// from the file (interpretation points have no null sentinel). Z sign
// is the caller's business via sampleToZ: the suite convention is
// NEGATIVE down; Petrel-bound Charisma files conventionally carry
// positive-down values, so callers may flip the sign.

import { NULL_VALUE } from './manifest';
import { pyFixed } from '../../lib/gridding/surfaceExport';

const NULL_F32 = Math.fround(NULL_VALUE);

/**
 * Pick lattice -> labeled interpretation rows (live picks only,
 * inline-major order). Mirrors picksToPoints' iteration/affine math
 * exactly, adding the survey's real inline/crossline NUMBERS.
 *
 * @param {Float32Array} picks sample indices, nIl x nXl, 1e30 nulls
 * @param {{nIl: number, nXl: number}} geom
 * @param {Object} affine resolved survey affine (surveyAffine(geometry))
 * @param {(sample: number, cell?: number) => number} sampleToZ
 * @param {{il0: number, ilStep: number, xl0: number, xlStep: number}} lines
 *   survey line numbering (manifest geometry il/xl min + step)
 * @returns {Array<{il: number, xl: number, x: number, y: number, z: number}>}
 */
export function picksToPickRows(picks, geom, affine, sampleToZ, lines) {
  if (!affine?.origin) throw new Error('Volume has no usable survey coordinates.');
  const out = [];
  for (let i = 0; i < geom.nIl; i++) {
    for (let j = 0; j < geom.nXl; j++) {
      const cell = i * geom.nXl + j;
      const s = picks[cell];
      if (s === NULL_F32) continue;
      out.push({
        il: lines.il0 + i * lines.ilStep,
        xl: lines.xl0 + j * lines.xlStep,
        x: affine.origin.x + i * affine.ilVec.x + j * affine.xlVec.x,
        y: affine.origin.y + i * affine.ilVec.y + j * affine.xlVec.y,
        z: sampleToZ(s, cell),
      });
    }
  }
  return out;
}

const pad = (s, w) => String(s).padStart(w);

/**
 * Charisma 3D horizon ASCII: fixed-width, 9 whitespace tokens per row.
 * `INLINE :   2405 XLINE :   1024   500000.00  6700000.00   -100.0000`
 * @param {Array<{il, xl, x, y, z}>} rows
 */
export function writeCharismaHorizon(rows) {
  const lines = rows.map((r) => `INLINE :${pad(r.il, 7)} XLINE :${pad(r.xl, 7)}`
    + `${pad(pyFixed(r.x, 2), 12)}${pad(pyFixed(r.y, 2), 12)}${pad(pyFixed(r.z, 4), 12)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Five-column interpretation points: `il xl x y z`, single-space
 * separated (generic ASCII import with column mapping).
 * @param {Array<{il, xl, x, y, z}>} rows
 */
export function writeIlXlXyz(rows) {
  const lines = rows.map((r) => `${r.il} ${r.xl} `
    + `${pyFixed(r.x, 2)} ${pyFixed(r.y, 2)} ${pyFixed(r.z, 4)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Bare XYZ points: `x y z` per live pick.
 * @param {Array<{x, y, z}>} rows
 */
export function writeXyzPoints(rows) {
  const lines = rows.map((r) => `${pyFixed(r.x, 2)} ${pyFixed(r.y, 2)} ${pyFixed(r.z, 4)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Stored fault sticks -> labeled rows (world XY through the survey
 * affine, real line NUMBERS — fractional when a stick point sits
 * between lines, which Charisma readers accept).
 *
 * @param {Array<{points: {il, xl, s}[]}>} sticks stored stick shape
 *   (lattice indices; bare point arrays tolerated like the viewers)
 * @param {Object} affine resolved survey affine
 * @param {(sample: number) => number} sampleToZ
 * @param {{il0, ilStep, xl0, xlStep}} lines survey line numbering
 * @returns {Array<{il, xl, x, y, z, stick: number}>}
 */
export function faultSticksToRows(sticks, affine, sampleToZ, lines) {
  if (!affine?.origin) throw new Error('Volume has no usable survey coordinates.');
  const out = [];
  sticks.forEach((stick, k) => {
    const pts = stick.points || stick;
    for (const q of pts) {
      out.push({
        il: lines.il0 + q.il * lines.ilStep,
        xl: lines.xl0 + q.xl * lines.xlStep,
        x: affine.origin.x + q.il * affine.ilVec.x + q.xl * affine.xlVec.x,
        y: affine.origin.y + q.il * affine.ilVec.y + q.xl * affine.xlVec.y,
        z: sampleToZ(q.s),
        stick: k + 1,
      });
    }
  });
  return out;
}

/**
 * Charisma fault sticks ASCII (Petrel "Charisma fault sticks", the
 * seismiqb FAULT_STICKS column layout): 8 whitespace tokens per row —
 * `INLINE- <il> <xl> <x> <y> <z> <name> <stick#>`. Whitespace in the
 * fault name is flattened to underscores so every reader tokenizes the
 * row the same way.
 * @param {Array<{name: string, rows: Array<{il, xl, x, y, z, stick}>}>} faults
 */
export function writeCharismaFaultSticks(faults) {
  const out = [];
  for (const f of faults) {
    const name = String(f.name || 'fault').trim().replace(/\s+/g, '_') || 'fault';
    for (const r of f.rows) {
      out.push(`INLINE-${pad(pyFixed(r.il, 2), 12)}${pad(pyFixed(r.xl, 2), 12)}`
        + `${pad(pyFixed(r.x, 2), 12)}${pad(pyFixed(r.y, 2), 12)}${pad(pyFixed(r.z, 4), 12)}`
        + ` ${name} ${r.stick}`);
    }
  }
  return `${out.join('\n')}\n`;
}
