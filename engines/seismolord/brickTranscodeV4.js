// Streaming SEG-Y -> manifest v4 brick store (large-survey plan of record,
// docs/scope/Seismolord-LARGE-SURVEY-PLAN.md in the Suite, section 3).
//
// One conversion writes both copies of the volume:
//
//   display  u8 bricks, level 0 (full resolution) and levels 1..3, where
//            level L is 2^L decimated per axis: each cell is the mean of
//            the LIVE values of the 2x2x2 block one level finer, kept in
//            float32 and quantised only at the end (brickCodecV4 has the
//            quantisation). Every level is bricked 64^3.
//   f32      float32 bricks, byte-shuffled and compressed. Decoded, they
//            are bit-identical to the v1 transcoder's bricks.
//
// Memory plan (the tab target is 1.5 GB with the viewer's ~256 MB cache
// and the app itself alongside, so the conversion worker gets a fixed
// budget, 320 MiB by default):
//
//   The file is streamed in sort order, one band of 64 inlines at a time.
//   A whole band of the tester's survey (710 x 876 x 1,750 samples) is
//   64 x 876 x 1,750 x 4 B = 392 MB of float32 alone, so the band is
//   split along samples into k-groups of whole brick layers, and the band
//   is read once per k-group. Per brick layer the band holds
//     nj float32 bricks (1 MiB) + nj u8 bricks (256 KiB)
//     + the level 1..3 means for that layer (float32, before quantising)
//   = 14 x 1.25 MiB + 2 MiB = 19.5 MiB for the tester's survey. Fixed:
//   the level 1..3 u8 brick ROWS (a level-L row spans 2^L bands, so it
//   lives across bands: 24.5 + 7 + 2 MiB), two read chunks (current and
//   prefetch) and the in-flight encodes. At 320 MiB that is 14 layers per
//   group, 2 groups per band, an estimated peak of about 320 MiB, and the
//   file is read twice in total. A pass count is chosen so the groups are
//   even (14 + 14, never 18 + 10). planTranscodeV4 is the pure statement
//   of this plan; the soak test holds the engine to it.
//
// Clip statistics: sampleAmplitudeClip (a pre-pass over a few thousand
// traces spread evenly through the file) gives the |amplitude| percentile
// used as the quantisation clip (P99.9 by default; the clip must be known
// before the first display brick is written). The full pass then
// accumulates an EXACT |amplitude| histogram (1,024 bins over 4 clips,
// with overflow and the exact maximum) and the exact percentiles are
// reported from it; both go in the manifest, so the viewer's percentile
// control can move the display clip in the shader without re-reading.
//
// Nulls (1.0E+30, NaN, infinities, dead lattice cells, padding past the
// survey edge) never enter a statistic, a histogram or a mean; they are
// code 0 in the display copy and 1.0E+30 in the float32 copy, exactly as
// v1 wrote them (the float32 copy stores whatever the file held, bits
// unchanged; only padding and dead cells are written as 1.0E+30).
//
// Geometry comes from a scan (scanGeometry, full or sampled) or a trace
// index: a regular inline-sorted grid is addressed by prediction and
// every trace header is verified during the first k-group pass; any other
// file is addressed through a lattice (Int32Array, il-major, trace number
// or -1 for a dead cell), reads coalesced per band in file order.

import {
  TEXT_HEADER_BYTES,
  BIN_HEADER_BYTES,
  TRACE_HEADER_BYTES,
  decodeSamples,
  readHeaderInt32,
} from './segyDecode';
import { NULL_VALUE, DEFAULT_BRICK_SIZE } from './manifest';
import {
  quantizeU8,
  isLiveAmplitude,
  safeClip,
  encodeF32Brick,
  encodeU8Brick,
  resolveCodec,
  U8_ZERO,
  U8_STEPS,
} from './brickCodecV4';

const MiB = 1024 * 1024;
const NULL_F32 = Math.fround(NULL_VALUE);

export const V4_DEFAULT_BUDGET_BYTES = 320 * MiB;
export const V4_DEFAULT_LEVELS = 3;
export const V4_DEFAULT_READ_CHUNK_BYTES = 4 * MiB;
export const DEFAULT_CLIP_PERCENTILE = 99.9;
export const DEFAULT_CLIP_SAMPLE_TRACES = 4096;
export const DEFAULT_CLIP_SAMPLE_MAX_SAMPLES = 4_000_000;
export const HISTOGRAM_BINS = 1024;
/** The exact histogram spans [0, HISTOGRAM_RANGE_CLIPS x clip). */
export const HISTOGRAM_RANGE_CLIPS = 4;
export const REPORTED_PERCENTILES = Object.freeze([50, 90, 95, 98, 99, 99.5, 99.9]);

/** Dims of display level L: ceil(n / 2^L) per axis (the same as halving
 *  with ceil L times). */
export function levelDims(dims, level) {
  const f = 2 ** level;
  return dims.map((n) => Math.ceil(n / f));
}

export const brickGridOf = (dims, brickSize) => dims.map((n) => Math.ceil(n / brickSize));

/**
 * Normalise a scan (scanGeometry result, full or sampled) or a trace
 * index into the grid the transcoder reads.
 *
 * @param {Object} scan
 * @param {{lattice?: Int32Array}} [opts] il-major trace numbers, -1 dead
 */
export function gridFromScan(scan, { lattice = null } = {}) {
  const nIl = scan.il.count;
  const nXl = scan.xl.count;
  if (!(nIl >= 1 && nXl >= 1)) throw new Error('The survey has no inline or crossline extent under this mapping.');
  if (lattice) {
    if (lattice.length !== nIl * nXl) {
      throw new Error(`The trace lattice has ${lattice.length} cells for a ${nIl} x ${nXl} survey.`);
    }
  } else {
    if (nIl * nXl !== scan.totalTraces) {
      throw new Error(
        `Grid is not regular under this mapping: ${nIl} x ${nXl} != ${scan.totalTraces} traces. `
        + 'Check the inline/crossline byte positions.');
    }
    if (scan.inlineSorted === false) {
      throw new Error('Traces are not inline-sorted; converting this file needs a trace index.');
    }
  }
  return {
    ns: scan.ns,
    traceBytes: scan.traceBytes,
    formatCode: scan.formatCode,
    totalTraces: scan.totalTraces,
    mapping: { ilByte: scan.mapping.ilByte, xlByte: scan.mapping.xlByte },
    il: { min: scan.il.min, step: scan.il.step, count: nIl },
    xl: { min: scan.xl.min, step: scan.xl.step, count: nXl },
    lattice,
  };
}

/**
 * The memory plan (pure). Throws when even one brick layer per group
 * does not fit the budget.
 *
 * @param {{nIl:number, nXl:number, ns:number, traceBytes?:number}} shape
 * @param {Object} [opts]
 */
export function planTranscodeV4(shape, opts = {}) {
  const {
    brickSize: B = DEFAULT_BRICK_SIZE,
    levels = V4_DEFAULT_LEVELS,
    memoryBudgetBytes = V4_DEFAULT_BUDGET_BYTES,
    readChunkBytes = V4_DEFAULT_READ_CHUNK_BYTES,
    encodeConcurrency = 1,
  } = opts;
  const { nIl, nXl, ns } = shape;
  const traceBytes = shape.traceBytes ?? TRACE_HEADER_BYTES + ns * 4;
  if (!Number.isInteger(levels) || levels < 0 || levels > 6) throw new Error(`Levels of detail must be 0..6, got ${levels}.`);
  if (B % (2 ** levels) !== 0) throw new Error(`Brick size ${B} is not divisible by 2^${levels}.`);

  const dims0 = [nIl, nXl, ns];
  const [ni, nj, nk] = brickGridOf(dims0, B);
  const f32Brick = B ** 3 * 4;
  const u8Brick = B ** 3;

  let lodPerLayer = 0;
  let lodRows = 0;
  const levelInfo = [];
  for (let L = 0; L <= levels; L++) {
    const dims = levelDims(dims0, L);
    const grid = brickGridOf(dims, B);
    levelInfo.push({ level: L, dims, grid, bricks: grid[0] * grid[1] * grid[2] });
    if (L >= 1) {
      lodPerLayer += (B >> L) * dims[1] * (B >> L) * 4;   // float32 means for one layer
      lodRows += grid[1] * grid[2] * u8Brick;              // u8 row, all layers
    }
  }
  const perLayer = nj * (f32Brick + u8Brick) + lodPerLayer;
  const chunk = Math.max(readChunkBytes, traceBytes);
  const fixed = lodRows + 2 * chunk + ns * 4 + encodeConcurrency * 2 * f32Brick
    + HISTOGRAM_BINS * 8;
  const kGroupMax = Math.floor((memoryBudgetBytes - fixed) / perLayer);
  if (kGroupMax < 1) {
    throw new Error(
      `Memory budget ${(memoryBudgetBytes / MiB).toFixed(0)} MiB is too small to convert this survey: `
      + `one brick layer needs ${((fixed + perLayer) / MiB).toFixed(0)} MiB.`);
  }
  const passesPerBand = Math.ceil(nk / Math.min(nk, kGroupMax));
  const kGroup = Math.ceil(nk / passesPerBand);          // even groups
  return {
    brickSize: B,
    levels: levelInfo,
    grid: [ni, nj, nk],
    kGroup,
    passesPerBand,
    perLayerBytes: perLayer,
    fixedBytes: fixed,
    estimatedPeakBytes: fixed + kGroup * perLayer,
    memoryBudgetBytes,
    readChunkBytes: chunk,
    bytesRead: passesPerBand * traceBytes * (shape.liveTraces ?? nIl * nXl),
  };
}

const traceOffset = (traceBytes, t) => TEXT_HEADER_BYTES + BIN_HEADER_BYTES + t * traceBytes;

function headerMismatch(grid, t, il, xl, ilIdx, xlIdx) {
  return new Error(
    `Trace ${t} has (il ${il}, xl ${xl}) where the survey grid predicted `
    + `(il ${grid.il.min + ilIdx * grid.il.step}, xl ${grid.xl.min + xlIdx * grid.xl.step}).`);
}

function checkHeader(grid, view, tOff, t, ilIdx, xlIdx) {
  const th = new DataView(view.buffer, view.byteOffset + tOff, TRACE_HEADER_BYTES);
  const il = readHeaderInt32(th, grid.mapping.ilByte);
  const xl = readHeaderInt32(th, grid.mapping.xlByte);
  if (il !== grid.il.min + ilIdx * grid.il.step || xl !== grid.xl.min + xlIdx * grid.xl.step) {
    throw headerMismatch(grid, t, il, xl, ilIdx, xlIdx);
  }
}

const cellTrace = (grid, ilIdx, xlIdx) => (grid.lattice
  ? grid.lattice[ilIdx * grid.xl.count + xlIdx]
  : ilIdx * grid.xl.count + xlIdx);

/** Nearest-rank percentile of a sorted Float32Array. */
function sortedPercentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

/**
 * Clip pre-pass: |amplitude| percentiles from traces spread evenly
 * through the survey (deterministic, so a restarted conversion
 * quantises identically). Headers are verified like the full pass.
 *
 * @param {import('./reader').ByteReader} reader
 * @param {Object} grid gridFromScan()
 * @param {{traces?: number, maxSamples?: number, percentile?: number}} [opts]
 * @returns {Promise<{clip:number, percentile:number, traces:number,
 *   samples:number, maxAbs:number, percentiles:Object}>}
 */
export async function sampleAmplitudeClip(reader, grid, opts = {}) {
  const {
    traces = DEFAULT_CLIP_SAMPLE_TRACES,
    maxSamples = DEFAULT_CLIP_SAMPLE_MAX_SAMPLES,
    percentile = DEFAULT_CLIP_PERCENTILE,
  } = opts;
  const { ns, traceBytes, formatCode } = grid;
  const nXl = grid.xl.count;
  const nCells = grid.il.count * nXl;
  const want = Math.max(1, Math.min(nCells, traces, Math.floor(maxSamples / ns) || 1));
  const picks = [];
  for (let n = 0; n < want; n++) {
    const cell = Math.min(nCells - 1, Math.floor(((n + 0.5) * nCells) / want));
    const t = cellTrace(grid, Math.floor(cell / nXl), cell % nXl);
    if (t >= 0) picks.push({ t, cell });
  }
  picks.sort((a, b) => a.t - b.t);
  const abs = new Float32Array(picks.length * ns);
  let n = 0;
  let maxAbs = 0;
  const scratch = new Float32Array(ns);
  for (const { t, cell } of picks) {
    const buf = await reader.read(traceOffset(traceBytes, t), traceBytes);
    const view = new DataView(buf);
    checkHeader(grid, view, 0, t, Math.floor(cell / nXl), cell % nXl);
    decodeSamples(view, TRACE_HEADER_BYTES, ns, formatCode, scratch);
    for (let s = 0; s < ns; s++) {
      const v = scratch[s];
      if (!isLiveAmplitude(v)) continue;
      const a = Math.abs(v);
      abs[n++] = a;
      if (a > maxAbs) maxAbs = a;
    }
  }
  const sorted = abs.subarray(0, n).sort();
  const percentiles = {};
  for (const p of REPORTED_PERCENTILES) percentiles[String(p)] = sortedPercentile(sorted, p);
  let clip = sortedPercentile(sorted, percentile);
  if (!(clip > 0)) clip = maxAbs > 0 ? maxAbs : 1;      // sparse or silent data
  return { clip, percentile, traces: picks.length, samples: n, maxAbs, percentiles };
}

/** A new, empty exact |amplitude| histogram over [0, rangeClips x clip). */
export function makeAbsHistogram(clip, { bins = HISTOGRAM_BINS, rangeClips = HISTOGRAM_RANGE_CLIPS } = {}) {
  return {
    of: 'abs',
    bins,
    max: safeClip(clip) * rangeClips,
    counts: new Float64Array(bins),
    overflow: 0,
    live: 0,
    max_abs: 0,
  };
}

/**
 * Percentile of |amplitude| from an exact histogram, linear within the
 * bin. A rank inside the overflow returns the exact maximum.
 * @param {{bins:number, max:number, counts:ArrayLike<number>, overflow:number,
 *   live:number, max_abs:number}} h
 * @param {number} p 0..100
 */
export function percentileFromHistogram(h, p) {
  if (!h.live) return 0;
  const rank = (p / 100) * h.live;
  const width = h.max / h.bins;
  let cum = 0;
  for (let b = 0; b < h.bins; b++) {
    const c = h.counts[b];
    if (c > 0 && cum + c >= rank) return Math.min(h.max_abs, (b + (rank - cum) / c) * width);
    cum += c;
  }
  return h.max_abs;
}

/** Histogram in manifest form (plain arrays, exact percentiles). */
export function histogramForManifest(h) {
  const percentiles = {};
  for (const p of REPORTED_PERCENTILES) percentiles[String(p)] = percentileFromHistogram(h, p);
  return {
    histogram: {
      of: h.of,
      bins: h.bins,
      max: h.max,
      counts: Array.from(h.counts),
      overflow: h.overflow,
      live: h.live,
      max_abs: h.max_abs,
    },
    percentiles,
  };
}

/** Mean of the live values of each 2x2x2 block of a dense il-major
 *  array (NaN = null); NaN where the block has none. */
function downsampleDense(src, [a, b, c], dst) {
  const A = Math.ceil(a / 2);
  const Bn = Math.ceil(b / 2);
  const C = Math.ceil(c / 2);
  for (let i = 0; i < A; i++) {
    const i0 = 2 * i;
    const i1 = Math.min(i0 + 1, a - 1);
    for (let j = 0; j < Bn; j++) {
      const j0 = 2 * j;
      const j1 = Math.min(j0 + 1, b - 1);
      const rows = [
        (i0 * b + j0) * c,
        (i0 * b + j1) * c,
        (i1 * b + j0) * c,
        (i1 * b + j1) * c,
      ];
      // distinct rows only (edges repeat an index; it must count once)
      const uniq = [...new Set(rows)];
      const out = (i * Bn + j) * C;
      for (let k = 0; k < C; k++) {
        const k0 = 2 * k;
        const k1 = k0 + 1 < c ? k0 + 1 : -1;
        let sum = 0;
        let cnt = 0;
        for (let r = 0; r < uniq.length; r++) {
          const v0 = src[uniq[r] + k0];
          if (v0 === v0) { sum += v0; cnt += 1; }
          if (k1 >= 0) {
            const v1 = src[uniq[r] + k1];
            if (v1 === v1) { sum += v1; cnt += 1; }
          }
        }
        dst[out + k] = cnt ? sum / cnt : NaN;
      }
    }
  }
  return [A, Bn, C];
}

/**
 * Convert a SEG-Y volume to a manifest v4 brick store in one streaming
 * pass per k-group (see the header for the memory plan).
 *
 * @param {import('./reader').ByteReader} reader
 * @param {Object} grid gridFromScan()
 * @param {Object} opts
 * @param {(b: {kind:'display'|'f32', level:number, i:number, j:number, k:number,
 *   bytes: Uint8Array, rawBytes:number}) => Promise<void>|void} opts.onBrick
 *   one call per encoded brick; `bytes` belongs to the callee. Awaited
 *   (with up to encodeConcurrency in flight), so a slow sink holds the
 *   conversion back instead of piling buffers up.
 * @param {number|{clip:number, percentile?:number, traces?:number}} [opts.clip]
 *   quantisation clip; sampled by sampleAmplitudeClip when omitted
 * @param {{compression?:string, deflate?:Function}} [opts.codec]
 * @param {number} [opts.encodeConcurrency] encodes in flight (1)
 * @param {number} [opts.memoryBudgetBytes]
 * @param {number} [opts.levels] display levels of detail beyond level 0 (3)
 * @param {(done:number, total:number, phase:string, extra:Object)=>void} [opts.onProgress]
 * @param {() => boolean} [opts.isCancelled]
 */
export async function transcodeV4(reader, grid, opts = {}) {
  const {
    brickSize: B = DEFAULT_BRICK_SIZE,
    levels = V4_DEFAULT_LEVELS,
    memoryBudgetBytes = V4_DEFAULT_BUDGET_BYTES,
    readChunkBytes = V4_DEFAULT_READ_CHUNK_BYTES,
    encodeConcurrency = 1,
    clipPercentile = DEFAULT_CLIP_PERCENTILE,
    onBrick,
    onProgress,
    isCancelled = () => false,
  } = opts;
  if (!onBrick) throw new Error('onBrick callback is required.');
  const codec = resolveCodec(opts.codec);
  // imported bindings copied to locals: a CommonJS build (babel-jest)
  // turns each imported name into a getter call, and these sit in the
  // per-sample loops (10x slower under jest without this)
  const ZERO = U8_ZERO;
  const STEPS = U8_STEPS;
  const quantize = quantizeU8;
  const decode = decodeSamples;
  const { ns, traceBytes, formatCode } = grid;
  const nIl = grid.il.count;
  const nXl = grid.xl.count;
  const plan = planTranscodeV4({ nIl, nXl, ns, traceBytes }, {
    brickSize: B, levels, memoryBudgetBytes, readChunkBytes, encodeConcurrency,
  });
  const [ni, nj, nk] = plan.grid;
  const { kGroup, passesPerBand } = plan;
  const B3 = B ** 3;

  // ---- clip -------------------------------------------------------------
  let clipInfo = opts.clip;
  if (clipInfo == null) clipInfo = await sampleAmplitudeClip(reader, grid, { percentile: clipPercentile });
  if (typeof clipInfo === 'number') clipInfo = { clip: clipInfo, percentile: null, method: 'given' };
  const clip = safeClip(clipInfo.clip);
  const clipSource = clipInfo.method === 'given'
    ? { method: 'given' }
    : { method: 'sampled-traces', traces: clipInfo.traces, samples: clipInfo.samples };

  // ---- buffers (allocated once, reused band to band) --------------------
  const f32Bricks = Array.from({ length: nj * kGroup }, () => new Float32Array(B3));
  const u8Bricks = Array.from({ length: nj * kGroup }, () => new Uint8Array(B3));
  const rows = [null];
  const dense = [null];
  for (let L = 1; L <= levels; L++) {
    const info = plan.levels[L];
    rows.push({
      ...info,
      bricks: Array.from({ length: info.grid[1] * info.grid[2] }, () => new Uint8Array(B3)),
    });
    dense.push(new Float32Array((B >> L) * info.dims[1] * ((kGroup * B) >> L)));
  }
  const scratch = new Float32Array(ns);
  const chunkBytes = plan.readChunkBytes;
  const tracesPerChunk = Math.max(1, Math.floor(chunkBytes / traceBytes));

  // ---- statistics -------------------------------------------------------
  const hist = makeAbsHistogram(clip);
  const histScale = hist.bins / hist.max;
  const histCounts = hist.counts;
  const histBins = hist.bins;
  let histOverflow = 0;
  let maxAbs = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let nLive = 0;
  let traceCount = 0;
  let deadTraces = 0;

  // ---- encode + emit with bounded concurrency ----------------------------
  const out = {
    display: { bricks: 0, rawBytes: 0, storedBytes: 0 },
    f32: { bricks: 0, rawBytes: 0, storedBytes: 0 },
  };
  const totalBricks = plan.levels.reduce((s, l) => s + l.bricks, 0) + ni * nj * nk;
  let bricksDone = 0;
  const inflight = new Set();
  let emitError = null;
  const checkEmit = () => { if (emitError) throw emitError; };
  const emit = async (kind, level, i, j, k, data) => {
    while (inflight.size >= encodeConcurrency) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(inflight);
      checkEmit();
    }
    const task = (async () => {
      const bytes = kind === 'f32' ? await encodeF32Brick(data, codec) : await encodeU8Brick(data, codec);
      await onBrick({ kind, level, i, j, k, bytes, rawBytes: data.byteLength });
      const tally = out[kind];
      tally.bricks += 1;
      tally.rawBytes += data.byteLength;
      tally.storedBytes += bytes.byteLength;
      bricksDone += 1;
    })().catch((e) => { emitError = emitError || e; });
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  };
  const drain = async () => {
    await Promise.all([...inflight]);
    checkEmit();
  };

  // ---- the pass ---------------------------------------------------------
  let liveCells = nIl * nXl;
  if (grid.lattice) {
    liveCells = 0;
    for (let c = 0; c < grid.lattice.length; c++) if (grid.lattice[c] >= 0) liveCells += 1;
  }
  const totalWork = liveCells * passesPerBand;
  let workDone = 0;
  const progress = (phase) => {
    if (onProgress) {
      onProgress(workDone, totalWork, phase, {
        bricksDone, totalBricks, passesPerBand, clip,
      });
    }
  };

  for (let bi = 0; bi < ni; bi++) {
    const ilIdx0 = bi * B;
    const bandIl = Math.min(B, nIl - ilIdx0);

    // read plan: runs of consecutive traces in file order
    const runs = [];
    if (!grid.lattice) {
      const bandTrace0 = ilIdx0 * nXl;
      const bandTraces = bandIl * nXl;
      for (let t = 0; t < bandTraces; t += tracesPerChunk) {
        runs.push({ t0: bandTrace0 + t, count: Math.min(tracesPerChunk, bandTraces - t), cells: null, cell0: t });
      }
    } else {
      const pairs = [];
      for (let li = 0; li < bandIl; li++) {
        for (let x = 0; x < nXl; x++) {
          const t = grid.lattice[(ilIdx0 + li) * nXl + x];
          if (t >= 0) pairs.push([t, li * nXl + x]);
          else deadTraces += 1;
        }
      }
      pairs.sort((a, b) => a[0] - b[0]);
      let r = null;
      for (const [t, cell] of pairs) {
        if (r && t === r.t0 + r.count && r.count < tracesPerChunk) {
          r.cellList.push(cell);
          r.count += 1;
        } else {
          r = { t0: t, count: 1, cellList: [cell] };
          runs.push(r);
        }
      }
      for (const run of runs) { run.cells = Int32Array.from(run.cellList); delete run.cellList; }
    }

    for (let pass = 0; pass < passesPerBand; pass++) {
      const bk0 = pass * kGroup;
      const bk1 = Math.min(bk0 + kGroup, nk);
      const kg = bk1 - bk0;
      const k0 = bk0 * B;
      const k1 = Math.min(bk1 * B, ns);
      const nsWin = k1 - k0;
      for (let n = 0; n < nj * kg; n++) {
        f32Bricks[n].fill(NULL_F32);
        u8Bricks[n].fill(0);
      }

      const readRun = (run) => reader.read(traceOffset(traceBytes, run.t0), run.count * traceBytes);
      let next = runs.length ? readRun(runs[0]) : null;
      for (let r = 0; r < runs.length; r++) {
        if (isCancelled()) throw new Error('Conversion cancelled.');
        const run = runs[r];
        // eslint-disable-next-line no-await-in-loop
        const buf = await next;
        next = r + 1 < runs.length ? readRun(runs[r + 1]) : null;   // prefetch
        const view = new DataView(buf);
        for (let c = 0; c < run.count; c++) {
          const cell = run.cells ? run.cells[c] : run.cell0 + c;
          const li = Math.floor(cell / nXl);
          const x = cell - li * nXl;
          const tOff = c * traceBytes;
          if (pass === 0) {
            checkHeader(grid, view, tOff, run.t0 + c, ilIdx0 + li, x);
            traceCount += 1;
          }
          decode(view, tOff + TRACE_HEADER_BYTES + k0 * 4, nsWin, formatCode, scratch);
          const bj = Math.floor(x / B);
          const base = (li * B + (x - bj * B)) * B;
          for (let bk = bk0; bk < bk1; bk++) {
            const f = f32Bricks[bj * kg + (bk - bk0)];
            const q = u8Bricks[bj * kg + (bk - bk0)];
            const kA = bk * B;
            const kB = Math.min(kA + B, ns);
            for (let k = kA; k < kB; k++) {
              const v = scratch[k - k0];
              const o = base + (k - kA);
              f[o] = v;
              if (!(Math.abs(v) < 1.0e29)) continue;          // null: stays code 0
              if (v < min) min = v;
              if (v > max) max = v;
              sum += v;
              sumSq += v * v;
              nLive += 1;
              const a = v < 0 ? -v : v;
              const hb = Math.floor(a * histScale);
              if (hb < histBins) histCounts[hb] += 1; else histOverflow += 1;
              if (a > maxAbs) maxAbs = a;
              // quantizeU8 inlined (same arithmetic, pinned by the tests)
              const rr = v / clip;
              q[o] = rr >= 0
                ? ZERO + Math.floor((rr > 1 ? 1 : rr) * STEPS + 0.5)
                : ZERO - Math.floor((rr < -1 ? 1 : -rr) * STEPS + 0.5);
            }
          }
        }
        workDone += run.count;
        progress('convert');
      }

      // ---- levels of detail for this band and sample window --------------
      if (levels >= 1) {
        const d1 = dense[1];
        const a1 = Math.ceil(bandIl / 2);
        const b1 = Math.ceil(nXl / 2);
        const c1 = Math.ceil(nsWin / 2);
        for (let i1 = 0; i1 < a1; i1++) {
          const la = 2 * i1;
          const lb = Math.min(la + 1, bandIl - 1);
          for (let x1 = 0; x1 < b1; x1++) {
            const xa = 2 * x1;
            const xb = Math.min(xa + 1, nXl - 1);
            const cols = [];
            for (const li of la === lb ? [la] : [la, lb]) {
              for (const xx of xa === xb ? [xa] : [xa, xb]) {
                const bj = Math.floor(xx / B);
                cols.push(bj, (li * B + (xx - bj * B)) * B);
              }
            }
            const o = (i1 * b1 + x1) * c1;
            // walk brick column by brick column: k0 and the brick size
            // are both even, so a level-1 cell never straddles bricks
            for (let bkRel = 0; bkRel < kg; bkRel++) {
              const t1Start = (bkRel * B) >> 1;
              const t1End = Math.min(c1, ((bkRel + 1) * B) >> 1);
              for (let t1 = t1Start; t1 < t1End; t1++) {
                const lk = (t1 - t1Start) * 2;
                const two = k0 + 2 * t1 + 1 < k1;
                let s = 0;
                let cnt = 0;
                for (let c = 0; c < cols.length; c += 2) {
                  const f = f32Bricks[cols[c] * kg + bkRel];
                  const p = cols[c + 1] + lk;
                  const v0 = f[p];
                  if (Math.abs(v0) < 1.0e29) { s += v0; cnt += 1; }
                  if (two) {
                    const v1 = f[p + 1];
                    if (Math.abs(v1) < 1.0e29) { s += v1; cnt += 1; }
                  }
                }
                d1[o + t1] = cnt ? s / cnt : NaN;
              }
            }
          }
        }
        let dimsL = [a1, b1, c1];
        for (let L = 1; L <= levels; L++) {
          if (L > 1) dimsL = downsampleDense(dense[L - 1], dimsL, dense[L]);
          // quantise into the level-L row buffers
          const row = rows[L];
          const [aL, bL, cL] = dimsL;
          const iBase = (ilIdx0 >> L) - (bi >> L) * B;      // offset inside the row
          const tBase = k0 >> L;
          const nkL = row.grid[2];
          const dL = dense[L];
          for (let i = 0; i < aL; i++) {
            const liL = iBase + i;
            for (let x = 0; x < bL; x++) {
              const bj = Math.floor(x / B);
              const rowBase = (liL * B + (x - bj * B)) * B;
              const o = (i * bL + x) * cL;
              for (let t = 0; t < cL; t++) {
                const tg = tBase + t;
                const bk = Math.floor(tg / B);
                const v = dL[o + t];
                row.bricks[bj * nkL + bk][rowBase + (tg - bk * B)] = v === v ? quantize(v, clip) : 0;
              }
            }
          }
        }
      }

      // ---- emit this window's level-0 bricks ------------------------------
      for (let bj = 0; bj < nj; bj++) {
        for (let bk = bk0; bk < bk1; bk++) {
          const idx = bj * kg + (bk - bk0);
          // eslint-disable-next-line no-await-in-loop
          await emit('f32', 0, bi, bj, bk, f32Bricks[idx]);
          // eslint-disable-next-line no-await-in-loop
          await emit('display', 0, bi, bj, bk, u8Bricks[idx]);
        }
      }
      await drain();                          // buffers are reused next pass
      progress('convert');
    }

    // ---- emit completed level rows ---------------------------------------
    for (let L = 1; L <= levels; L++) {
      const span = 2 ** L;
      if ((bi + 1) % span !== 0 && bi !== ni - 1) continue;
      const row = rows[L];
      const iL = bi >> L;
      for (let bj = 0; bj < row.grid[1]; bj++) {
        for (let bk = 0; bk < row.grid[2]; bk++) {
          // eslint-disable-next-line no-await-in-loop
          await emit('display', L, iL, bj, bk, row.bricks[bj * row.grid[2] + bk]);
        }
      }
      await drain();
      for (const b of row.bricks) b.fill(0);
    }
  }
  await drain();

  hist.overflow = histOverflow;
  hist.max_abs = maxAbs;
  hist.live = nLive;
  const { histogram, percentiles } = histogramForManifest(hist);
  return {
    brickGrid: { ni, nj, nk, brickSize: B },
    stats: {
      min,
      max,
      mean: sum / nLive,
      rms: Math.sqrt(sumSq / nLive),
      live_samples: nLive,
    },
    traceCount,
    deadTraces,
    compression: codec.compression,
    display: {
      clip,
      clipPercentile: clipInfo.percentile ?? null,
      clipSource,
      sampledPercentiles: clipInfo.percentiles || null,
      percentiles,
      histogram,
      levels: plan.levels.map(({ level, dims, grid: g }) => ({ level, dims, grid: g })),
    },
    bricks: out,
    plan,
    passesPerBand,
    peakBytes: plan.estimatedPeakBytes,
  };
}
