// Horizon amplitude extraction: seismic attribute values along a picked
// horizon — the amplitude AT the (sub-sample) pick, or a windowed
// statistic (RMS / mean / max |amp|) around it — as a survey-lattice
// grid for the map window.
//
// "Value at horizon" evaluates the parabola through the three samples
// around the pick, the same refinement family snapPick uses: a peak
// picked at its parabolic apex reads its true apex amplitude, not the
// nearest sample's. This is a COMPUTED ATTRIBUTE of the stored
// amplitudes (the domain rule that display never interpolates stored
// data is untouched — nothing here feeds the renderer).
//
// Nulls everywhere: untracked cells, dead samples and all-null windows
// stay 1.0E+30 and never enter statistics.
//
// Pure math + brick copies, worker-safe, no I/O.

import { NULL_VALUE } from './manifest';

const NULL_F32 = Math.fround(NULL_VALUE);

/** Attribute modes the extraction supports (UI select options). */
export const AMP_MODES = [
  { key: 'value', label: 'Amplitude', windowed: false },
  { key: 'rms', label: 'RMS amplitude', windowed: true },
  { key: 'mean', label: 'Mean amplitude', windowed: true },
  { key: 'max_abs', label: 'Max |amplitude|', windowed: true },
];

/**
 * Amplitude at fractional sample z on one trace, via the parabola
 * through the samples round(z) ± 1. An incomplete stencil (trace edge
 * or null neighbor) falls back to the nearest sample; a null nearest
 * sample or out-of-range z is null.
 *
 * @param {(s:number) => number} at sample accessor
 * @param {number} ns samples per trace
 * @param {number} z sub-sample position
 */
export function amplitudeAt(at, ns, z) {
  const s1 = Math.round(z);
  if (!Number.isFinite(z) || s1 < 0 || s1 >= ns) return NULL_F32;
  const c = at(s1);
  if (c === NULL_F32) return NULL_F32;
  const l = s1 > 0 ? at(s1 - 1) : NULL_F32;
  const r = s1 < ns - 1 ? at(s1 + 1) : NULL_F32;
  if (l === NULL_F32 || r === NULL_F32) return c;
  const dz = z - s1;
  const a1 = (r - l) / 2;
  const a2 = (l + r) / 2 - c;
  return c + a1 * dz + a2 * dz * dz;
}

/**
 * Windowed statistic around round(z): samples round(z) ± w, nulls
 * excluded; an all-null (or out-of-range) window is null.
 *
 * @param {(s:number) => number} at sample accessor
 * @param {number} ns samples per trace
 * @param {number} z sub-sample position
 * @param {'rms'|'mean'|'max_abs'} mode
 * @param {number} w half-width in samples
 */
export function windowStat(at, ns, z, mode, w) {
  if (!Number.isFinite(z)) return NULL_F32;
  const s0 = Math.max(0, Math.round(z) - w);
  const s1 = Math.min(ns - 1, Math.round(z) + w);
  let sum = 0;
  let mx = 0;
  let n = 0;
  for (let s = s0; s <= s1; s++) {
    const v = at(s);
    if (v === NULL_F32) continue;
    n += 1;
    if (mode === 'rms') sum += v * v;
    else if (mode === 'mean') sum += v;
    else mx = Math.max(mx, Math.abs(v));
  }
  if (n === 0) return NULL_F32;
  if (mode === 'rms') return Math.sqrt(sum / n);
  if (mode === 'mean') return sum / n;
  return mx;
}

/** Per-brick-column (bi-bj) k-ranges the extraction will touch: each
 *  live pick needs round(z) ± (w + 1) — the ±1 covers the parabola
 *  stencil. Shared by the extraction and its brick-key preflight. */
function blockRanges(geom, picks, w) {
  const b = geom.brickSize;
  const m = w + 1;
  const blocks = new Map();
  for (let il = 0; il < geom.nIl; il++) {
    for (let xl = 0; xl < geom.nXl; xl++) {
      const z = picks[il * geom.nXl + xl];
      if (z === NULL_F32 || !Number.isFinite(z)) continue;
      const s0 = Math.max(0, Math.floor(z) - m);
      const s1 = Math.min(geom.ns - 1, Math.ceil(z) + m);
      if (s1 < s0) continue;
      const key = `${Math.floor(il / b)}-${Math.floor(xl / b)}`;
      const k0 = Math.floor(s0 / b);
      const k1 = Math.floor(s1 / b);
      const r = blocks.get(key);
      if (!r) blocks.set(key, { k0, k1 });
      else {
        r.k0 = Math.min(r.k0, k0);
        r.k1 = Math.max(r.k1, k1);
      }
    }
  }
  return blocks;
}

/**
 * The bricks an extraction will fetch — callers that share a cache with
 * scrub cancellation can shield these keys before starting (the
 * traverse-assembly pattern).
 *
 * @returns {{i:number, j:number, k:number}[]}
 */
export function bricksForHorizonAmplitude(geom, picks, w = 0) {
  const out = [];
  for (const [key, r] of blockRanges(geom, picks, w)) {
    const [i, j] = key.split('-').map(Number);
    for (let k = r.k0; k <= r.k1; k++) out.push({ i, j, k });
  }
  return out;
}

/**
 * Extract an amplitude attribute grid along a horizon. Bricks are
 * visited grouped by (bi, bj) column with only the k-range the
 * column's picks need, so each brick downloads exactly once and at
 * most one column's bricks are held at a time.
 *
 * @param {(i:number, j:number, k:number) => Promise<Float32Array>} getBrick
 * @param {import('./sliceAssembly').VolumeGeom} geom
 * @param {Float32Array} picks horizon grid (sub-sample z, 1e30 nulls)
 * @param {{mode?: string, window?: number}} [opts] mode per AMP_MODES;
 *   window is the half-width in samples for the windowed modes
 * @returns {Promise<Float32Array>} attribute values, same lattice
 */
export async function extractHorizonAmplitude(getBrick, geom, picks, opts = {}) {
  const { mode = 'value', window: w = 0 } = opts;
  const b = geom.brickSize;
  const out = new Float32Array(picks.length).fill(NULL_F32);
  for (const [key, r] of blockRanges(geom, picks, w)) {
    const [bi, bj] = key.split('-').map(Number);
    const bricks = [];
    await Promise.all(Array.from({ length: r.k1 - r.k0 + 1 }, (_, q) => {
      const k = r.k0 + q;
      return getBrick(bi, bj, k).then((data) => { bricks[k] = data; });
    }));
    const i0 = bi * b;
    const j0 = bj * b;
    const i1 = Math.min(geom.nIl, i0 + b);
    const j1 = Math.min(geom.nXl, j0 + b);
    for (let il = i0; il < i1; il++) {
      for (let xl = j0; xl < j1; xl++) {
        const cell = il * geom.nXl + xl;
        const z = picks[cell];
        if (z === NULL_F32 || !Number.isFinite(z)) continue;
        const base = ((il - i0) * b + (xl - j0)) * b;
        const at = (s) => bricks[Math.floor(s / b)][base + (s % b)];
        out[cell] = mode === 'value'
          ? amplitudeAt(at, geom.ns, z)
          : windowStat(at, geom.ns, z, mode, w);
      }
    }
  }
  return out;
}
