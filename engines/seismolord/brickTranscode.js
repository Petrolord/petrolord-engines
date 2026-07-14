// Streaming SEG-Y -> 64^3 float32 brick transcoder with a fixed memory
// budget. Never holds the file: processes inline bands of brickSize
// inlines; when a band's bricks exceed the budget the band is re-streamed
// once per sample-window (k-group), trading I/O for bounded memory.
//
// Padding beyond the survey extent and (future) dead traces are
// NULL_VALUE and are excluded from statistics (playbook: nulls never
// enter sums).

import {
  TEXT_HEADER_BYTES,
  BIN_HEADER_BYTES,
  TRACE_HEADER_BYTES,
  decodeSamples,
  readHeaderInt32,
} from './segyDecode';
import { NULL_VALUE, DEFAULT_BRICK_SIZE } from './manifest';

/**
 * @param {import('./reader').ByteReader} reader
 * @param {Object} scan full (non-sampled) scanGeometry() result
 * @param {Object} [opts]
 * @param {number} [opts.brickSize]
 * @param {number} [opts.memoryBudgetBytes] hard ceiling for engine buffers
 * @param {number} [opts.readChunkBytes]
 * @param {(brick: {i:number,j:number,k:number,data:Float32Array}) => Promise<void>|void} opts.onBrick
 *   invoked once per completed brick; the Float32Array is released to the
 *   callback (transferable) and never touched again by the engine
 * @param {(done:number,total:number,phase:string)=>void} [opts.onProgress]
 */
export async function transcodeToBricks(reader, scan, opts = {}) {
  const {
    brickSize = DEFAULT_BRICK_SIZE,
    memoryBudgetBytes = 256 * 1024 * 1024,
    readChunkBytes = 4 * 1024 * 1024,
    onBrick,
    onProgress,
  } = opts;

  if (scan.sampled) throw new Error('Transcode requires a full header scan, not a sampled preview.');
  if (!scan.regular) throw new Error('Transcode requires a regular inline/crossline grid — fix the header mapping first.');
  if (!scan.inlineSorted) throw new Error('Phase 1 ingestion requires inline-sorted traces.');
  if (!onBrick) throw new Error('onBrick callback is required.');

  const { ns, traceBytes, totalTraces, mapping } = scan;
  const nIl = scan.il.count;
  const nXl = scan.xl.count;

  const ni = Math.ceil(nIl / brickSize);
  const nj = Math.ceil(nXl / brickSize);
  const nk = Math.ceil(ns / brickSize);
  const brickFloats = brickSize * brickSize * brickSize;
  const brickBytes = brickFloats * 4;

  // Memory plan: brick buffers for one (band x k-group) + one read chunk
  // + one decoded-trace scratch. kGroup = how many k-blocks per pass.
  const chunkBytes = Math.max(readChunkBytes, traceBytes);   // >= one whole trace
  const scratchBytes = ns * 4;
  const fixedBytes = chunkBytes + scratchBytes;
  const kGroupMax = Math.floor((memoryBudgetBytes - fixedBytes) / (nj * brickBytes));
  if (kGroupMax < 1) {
    const need = fixedBytes + nj * brickBytes;
    throw new Error(
      `Memory budget ${memoryBudgetBytes} B is too small: one transcode pass needs `
      + `at least ${need} B (${nj} bricks x ${brickBytes} B + ${fixedBytes} B buffers).`);
  }
  const kGroup = Math.min(nk, kGroupMax);
  const passesPerBand = Math.ceil(nk / kGroup);
  let peakBytes = 0;
  const notePeak = (bricksAllocated) => {
    const now = fixedBytes + bricksAllocated * brickBytes;
    if (now > peakBytes) peakBytes = now;
  };

  const scratch = new Float32Array(ns);
  const NULL_F32 = Math.fround(NULL_VALUE);   // what a Float32Array stores
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let nLive = 0;

  const totalBricks = ni * nj * nk;
  let bricksDone = 0;
  let traceCount = 0;

  for (let bi = 0; bi < ni; bi++) {
    const ilIdx0 = bi * brickSize;
    const ilIdx1 = Math.min(ilIdx0 + brickSize, nIl);          // exclusive
    const bandTrace0 = ilIdx0 * nXl;
    const bandTraces = (ilIdx1 - ilIdx0) * nXl;

    for (let pass = 0; pass < passesPerBand; pass++) {
      const bk0 = pass * kGroup;                                // first k-block
      const bk1 = Math.min(bk0 + kGroup, nk);                   // exclusive
      const k0 = bk0 * brickSize;                               // first sample
      const k1 = Math.min(bk1 * brickSize, ns);                 // exclusive

      /** @type {Float32Array[]} bricks[(bj)*(bk1-bk0) + (bk-bk0)] */
      const bricks = [];
      for (let n = 0; n < nj * (bk1 - bk0); n++) {
        bricks.push(new Float32Array(brickFloats).fill(NULL_VALUE));
      }
      notePeak(bricks.length);

      const tracesPerChunk = Math.max(1, Math.floor(chunkBytes / traceBytes));
      for (let t = 0; t < bandTraces; t += tracesPerChunk) {
        const count = Math.min(tracesPerChunk, bandTraces - t);
        const off = TEXT_HEADER_BYTES + BIN_HEADER_BYTES + (bandTrace0 + t) * traceBytes;
        const buf = await reader.read(off, count * traceBytes);
        const view = new DataView(buf);

        for (let c = 0; c < count; c++) {
          const tOff = c * traceBytes;
          const th = new DataView(buf, tOff, TRACE_HEADER_BYTES);
          const il = readHeaderInt32(th, mapping.ilByte);
          const xl = readHeaderInt32(th, mapping.xlByte);
          const ilIdx = (il - scan.il.min) / scan.il.step;
          const xlIdx = (xl - scan.xl.min) / scan.xl.step;
          const expectedIl = ilIdx0 + Math.floor((t + c) / nXl);
          const expectedXl = (t + c) % nXl;
          if (ilIdx !== expectedIl || xlIdx !== expectedXl) {
            throw new Error(
              `Trace ${bandTrace0 + t + c} has (il ${il}, xl ${xl}) where `
              + 'the regular inline-sorted grid predicted '
              + `(il ${scan.il.min + expectedIl * scan.il.step}, `
              + `xl ${scan.xl.min + expectedXl * scan.xl.step}).`);
          }

          const nsWin = k1 - k0;
          const win = scratch.subarray(0, nsWin);
          decodeSamples(view, tOff + TRACE_HEADER_BYTES + k0 * 4, nsWin, scan.formatCode, win);

          const li = ilIdx - ilIdx0;
          const bj = Math.floor(xlIdx / brickSize);
          const lj = xlIdx - bj * brickSize;
          for (let k = k0; k < k1; k++) {
            const v = win[k - k0];
            const bk = Math.floor(k / brickSize);
            const lk = k - bk * brickSize;
            bricks[bj * (bk1 - bk0) + (bk - bk0)][(li * brickSize + lj) * brickSize + lk] = v;
            if (v !== NULL_F32) {
              if (v < min) min = v;
              if (v > max) max = v;
              sum += v;
              sumSq += v * v;
              nLive += 1;
            }
          }
          if (pass === 0) traceCount += 1;
        }
      }

      for (let bj = 0; bj < nj; bj++) {
        for (let bk = bk0; bk < bk1; bk++) {
          const idx = bj * (bk1 - bk0) + (bk - bk0);
          await onBrick({ i: bi, j: bj, k: bk, data: bricks[idx] });
          bricks[idx] = null;                                   // released
          bricksDone += 1;
          if (onProgress) onProgress(bricksDone, totalBricks, 'transcode');
        }
      }
    }
  }

  return {
    brickGrid: { ni, nj, nk, brickSize },
    stats: {
      min,
      max,
      mean: sum / nLive,
      rms: Math.sqrt(sumSq / nLive),
      live_samples: nLive,
    },
    traceCount,
    peakBytes,
    passesPerBand,
  };
}
