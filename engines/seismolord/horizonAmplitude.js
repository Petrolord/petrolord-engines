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
//
// W2.5 additions: interval attributes between TWO horizons (A-to-B
// stratal windows — the statistic runs over every sample between the
// two picks, whatever their order), and horizon isofrequency (windowed
// spectral amplitude at one frequency along the horizon — Hann taper,
// 4x zero-padding to a power of two; recipe pinned by the numpy goldens
// in test-data/seismolord/isofrequency/).

import { NULL_VALUE } from './manifest';
import { fft, nextPow2 } from '../../lib/fft';

const NULL_F32 = Math.fround(NULL_VALUE);

/** Attribute modes the extraction supports (UI select options). */
export const AMP_MODES = [
  { key: 'value', label: 'Amplitude', windowed: false },
  { key: 'rms', label: 'RMS amplitude', windowed: true },
  { key: 'mean', label: 'Mean amplitude', windowed: true },
  { key: 'max_abs', label: 'Max |amplitude|', windowed: true },
];

/** Interval (A-to-B) statistic modes — value-at-pick has no interval
 *  meaning, so the windowed trio only. */
export const INTERVAL_MODES = [
  { key: 'rms', label: 'Interval RMS' },
  { key: 'mean', label: 'Interval mean' },
  { key: 'max_abs', label: 'Interval max |amplitude|' },
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

/** Interval statistic over samples [round(min(zA,zB)), round(max(zA,zB))]
 *  clamped to the trace — the A-to-B stratal window. Same null policy
 *  as windowStat; null when either pick is missing. */
export function intervalStat(at, ns, zA, zB, mode) {
  if (!Number.isFinite(zA) || !Number.isFinite(zB)) return NULL_F32;
  const s0 = Math.max(0, Math.round(Math.min(zA, zB)));
  const s1 = Math.min(ns - 1, Math.round(Math.max(zA, zB)));
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

/** Per-brick-column (bi-bj) k-ranges an extraction will touch.
 *  spanForCell(cell) returns [s0, s1] in samples (pre-clamp) or null
 *  for a cell the extraction skips. Shared by every extraction and its
 *  brick-key preflight. */
function blockRangesFromSpan(geom, spanForCell) {
  const b = geom.brickSize;
  const blocks = new Map();
  for (let il = 0; il < geom.nIl; il++) {
    for (let xl = 0; xl < geom.nXl; xl++) {
      const span = spanForCell(il * geom.nXl + xl);
      if (!span) continue;
      const s0 = Math.max(0, span[0]);
      const s1 = Math.min(geom.ns - 1, span[1]);
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

/** Single-horizon span: round(z) ± (w + 1) — the ±1 covers the parabola
 *  stencil. Behavior identical to the pre-W2.5 blockRanges. */
const singleSpan = (picks, w) => (cell) => {
  const z = picks[cell];
  if (z === NULL_F32 || !Number.isFinite(z)) return null;
  return [Math.floor(z) - (w + 1), Math.ceil(z) + (w + 1)];
};

/** A-to-B span: both picks live, the full interval plus the ±1 margin. */
const intervalSpan = (picksA, picksB) => (cell) => {
  const a = picksA[cell];
  const bz = picksB[cell];
  if (a === NULL_F32 || !Number.isFinite(a)) return null;
  if (bz === NULL_F32 || !Number.isFinite(bz)) return null;
  return [Math.floor(Math.min(a, bz)) - 1, Math.ceil(Math.max(a, bz)) + 1];
};

function blockRanges(geom, picks, w) {
  return blockRangesFromSpan(geom, singleSpan(picks, w));
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
  return extractOverBlocks(getBrick, geom, blockRanges(geom, picks, w), (at, cell) => {
    const z = picks[cell];
    if (z === NULL_F32 || !Number.isFinite(z)) return NULL_F32;
    return mode === 'value'
      ? amplitudeAt(at, geom.ns, z)
      : windowStat(at, geom.ns, z, mode, w);
  });
}

/** Shared brick-column walk: fetch each column's k-range once, evaluate
 *  cellValue(at, cell) for every trace of the column. */
async function extractOverBlocks(getBrick, geom, blocks, cellValue) {
  const b = geom.brickSize;
  const out = new Float32Array(geom.nIl * geom.nXl).fill(NULL_F32);
  for (const [key, r] of blocks) {
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
        const base = ((il - i0) * b + (xl - j0)) * b;
        const at = (s) => bricks[Math.floor(s / b)][base + (s % b)];
        out[cell] = cellValue(at, cell);
      }
    }
  }
  return out;
}

/** Brick preflight for an A-to-B interval extraction. */
export function bricksForIntervalAttribute(geom, picksA, picksB) {
  const out = [];
  for (const [key, r] of blockRangesFromSpan(geom, intervalSpan(picksA, picksB))) {
    const [i, j] = key.split('-').map(Number);
    for (let k = r.k0; k <= r.k1; k++) out.push({ i, j, k });
  }
  return out;
}

/**
 * Interval attribute grid between two horizons: per cell, the statistic
 * over every sample from pick A to pick B (order-free). Null where
 * either horizon is untracked.
 *
 * @param {(i,j,k) => Promise<Float32Array>} getBrick
 * @param {import('./sliceAssembly').VolumeGeom} geom
 * @param {Float32Array} picksA @param {Float32Array} picksB
 * @param {{mode?: 'rms'|'mean'|'max_abs'}} [opts]
 * @returns {Promise<Float32Array>}
 */
export async function extractIntervalAttribute(getBrick, geom, picksA, picksB, opts = {}) {
  const { mode = 'rms' } = opts;
  if (!INTERVAL_MODES.some((m) => m.key === mode)) {
    throw new Error(`Unknown interval mode "${mode}".`);
  }
  const blocks = blockRangesFromSpan(geom, intervalSpan(picksA, picksB));
  return extractOverBlocks(getBrick, geom, blocks, (at, cell) => {
    const a = picksA[cell];
    const bz = picksB[cell];
    if (a === NULL_F32 || !Number.isFinite(a)) return NULL_F32;
    if (bz === NULL_F32 || !Number.isFinite(bz)) return NULL_F32;
    return intervalStat(at, geom.ns, a, bz, mode);
  });
}

/**
 * Windowed spectral amplitude at one frequency for a single trace
 * position — the isofrequency kernel. Recipe (pinned by the numpy
 * goldens): samples round(z) ± hw clamped to the trace (edge windows
 * shrink; windows shorter than 4 samples are null), nulls zero-filled
 * (an all-null window is null), full-window Hann taper
 * h[m] = 0.5 - 0.5*cos(2*pi*m/(n-1)) (np.hanning), zero-pad to
 * nfft = nextpow2(4n), FFT, |X| at bin round(freqHz * nfft * dt_s)
 * clamped to [0, nfft/2].
 *
 * @param {(s:number) => number} at sample accessor
 * @param {number} ns @param {number} z pick (fractional samples)
 * @param {{freqHz: number, hw: number, dtS: number}} p
 */
export function isofrequencyAt(at, ns, z, { freqHz, hw, dtS }) {
  if (!Number.isFinite(z)) return NULL_F32;
  const c = Math.round(z);
  if (c < 0 || c >= ns) return NULL_F32;
  const s0 = Math.max(0, c - hw);
  const s1 = Math.min(ns - 1, c + hw);
  const n = s1 - s0 + 1;
  if (n < 4) return NULL_F32;
  const nfft = nextPow2(4 * n);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  let live = 0;
  for (let s = s0; s <= s1; s++) {
    const v = at(s);
    if (v === NULL_F32) continue;
    live += 1;
    const m = s - s0;
    re[m] = v * (0.5 - 0.5 * Math.cos((2 * Math.PI * m) / (n - 1)));
  }
  if (live === 0) return NULL_F32;
  fft(re, im, false);
  const bin = Math.min(nfft / 2, Math.max(0, Math.round(freqHz * nfft * dtS)));
  return Math.hypot(re[bin], im[bin]);
}

/**
 * Isofrequency grid along a horizon: spectral amplitude at `freqHz`
 * in a Hann-tapered window about each pick.
 *
 * @param {(i,j,k) => Promise<Float32Array>} getBrick
 * @param {import('./sliceAssembly').VolumeGeom} geom
 * @param {Float32Array} picks
 * @param {{freqHz: number, window: number, dtUs: number}} opts
 *   window = half-width in samples (the bricksForHorizonAmplitude
 *   preflight with the same value covers the fetch set)
 * @returns {Promise<Float32Array>}
 */
export async function extractHorizonIsofrequency(getBrick, geom, picks, opts) {
  const { freqHz, window: hw, dtUs } = opts;
  const dtS = dtUs * 1e-6;
  const nyquist = 1 / (2 * dtS);
  if (!(freqHz > 0) || !(freqHz <= nyquist)) {
    throw new Error(`Frequency ${freqHz} Hz is outside (0, ${nyquist.toFixed(0)}] Hz for dt ${dtUs} us.`);
  }
  if (!(hw >= 2)) throw new Error(`Isofrequency needs a window half-width of at least 2 samples, got ${hw}.`);
  return extractOverBlocks(getBrick, geom, blockRanges(geom, picks, hw), (at, cell) => {
    const z = picks[cell];
    if (z === NULL_F32 || !Number.isFinite(z)) return NULL_F32;
    return isofrequencyAt(at, geom.ns, z, { freqHz, hw, dtS });
  });
}
