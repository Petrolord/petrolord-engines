// Derived-volume compute job (interpreter program Wave 2 / W2.1): walk
// the parent volume one (i,j) brick column at a time — read the column's
// nk bricks, run a per-trace compute over every live trace, emit nk
// output bricks in the identical layout. Memory is bounded at ~2·nk
// bricks (parent column + output column) plus one trace scratch,
// mirroring the ingest transcoder's discipline. Emitted Float32Arrays
// are released to the onBrick callback (transferable) and never touched
// again by the engine.
//
// The output volume copies the parent lattice VERBATIM: same brick
// size, same grid, same padding (samples beyond the survey extent stay
// NULL_VALUE), which is what guarantees lattice identity for
// co-rendering (W2.4). Statistics accumulate over non-null OUTPUT
// samples only (playbook: nulls never enter sums).

import { NULL_VALUE } from './manifest';

const NULL_LIM = 1.0e29;

/** Named cancellation: catch by `e.name === 'VOLUME_JOB_CANCELLED'`. */
export class VolumeJobCancelledError extends Error {
  constructor() {
    super('Attribute computation cancelled.');
    this.name = 'VOLUME_JOB_CANCELLED';
  }
}

/**
 * @param {Object} p
 * @param {import('./sliceAssembly').VolumeGeom} p.geom geomFromManifest(parent)
 * @param {(trace: Float32Array, out: Float32Array) => void} p.compute
 *   per-trace attribute (attributes.makeTraceCompute); reads ns samples
 *   with NULL_VALUE nulls, writes ns samples with NULL_VALUE nulls
 * @param {(i:number,j:number,k:number) => Promise<Float32Array>} p.fetchBrick
 *   parent brick payload (brickSize^3 floats)
 * @param {(brick: {i:number,j:number,k:number,data:Float32Array}) => Promise<void>|void} p.onBrick
 *   one completed output brick; the array is transferred to the callback
 * @param {(done:number,total:number,phase:string)=>void} [p.onProgress]
 *   done/total count output BRICKS (matching the ingest progress shape)
 * @param {() => boolean} [p.shouldCancel] polled once per brick column
 * @returns {Promise<{brickGrid: {ni:number,nj:number,nk:number,brickSize:number},
 *   stats: {min:number,max:number,mean:number,rms:number,live_samples:number},
 *   traceCount: number}>}
 */
export async function runVolumeJob({ geom, compute, fetchBrick, onBrick, onProgress, shouldCancel }) {
  const { nIl, nXl, ns, brickSize: b } = geom;
  const [ni, nj, nk] = geom.grid;
  if (!compute) throw new Error('A per-trace compute is required.');
  if (!onBrick) throw new Error('onBrick callback is required.');

  const brickFloats = b * b * b;
  const trace = new Float32Array(ns);
  const outTrace = new Float32Array(ns);
  const NULL_F32 = Math.fround(NULL_VALUE);

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let nLive = 0;
  let traceCount = 0;

  const totalBricks = ni * nj * nk;
  let bricksDone = 0;

  for (let bi = 0; bi < ni; bi++) {
    for (let bj = 0; bj < nj; bj++) {
      if (shouldCancel && shouldCancel()) throw new VolumeJobCancelledError();

      const parents = await Promise.all(
        Array.from({ length: nk }, (_, bk) => fetchBrick(bi, bj, bk)),
      );
      const outs = [];
      for (let bk = 0; bk < nk; bk++) {
        outs.push(new Float32Array(brickFloats).fill(NULL_VALUE));
      }

      const liMax = Math.min(b, nIl - bi * b);
      const ljMax = Math.min(b, nXl - bj * b);
      for (let li = 0; li < liMax; li++) {
        for (let lj = 0; lj < ljMax; lj++) {
          const base = (li * b + lj) * b;
          // gather the trace across the k bricks; track liveness so
          // dead / padding traces skip the compute and stay null
          let anyLive = false;
          for (let k = 0; k < ns; k++) {
            const bk = Math.floor(k / b);
            const v = parents[bk][base + (k - bk * b)];
            trace[k] = v;
            if (!anyLive && Math.abs(v) <= NULL_LIM) anyLive = true;
          }
          if (!anyLive) continue;
          traceCount += 1;

          compute(trace, outTrace);

          for (let k = 0; k < ns; k++) {
            const v = outTrace[k];
            const bk = Math.floor(k / b);
            outs[bk][base + (k - bk * b)] = v;
            // stats describe the STORED float32 payload, not the f64 math
            const f = Math.fround(v);
            if (f !== NULL_F32 && Math.abs(f) <= NULL_LIM) {
              if (f < min) min = f;
              if (f > max) max = f;
              sum += f;
              sumSq += f * f;
              nLive += 1;
            }
          }
        }
      }

      for (let bk = 0; bk < nk; bk++) {
        await onBrick({ i: bi, j: bj, k: bk, data: outs[bk] });
        outs[bk] = null; // released
        bricksDone += 1;
        if (onProgress) onProgress(bricksDone, totalBricks, 'compute');
      }
    }
  }

  return {
    brickGrid: { ni, nj, nk, brickSize: b },
    stats: {
      min: nLive > 0 ? min : 0,
      max: nLive > 0 ? max : 0,
      mean: nLive > 0 ? sum / nLive : 0,
      rms: nLive > 0 ? Math.sqrt(sumSq / nLive) : 0,
      live_samples: nLive,
    },
    traceCount,
  };
}
