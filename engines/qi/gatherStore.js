// The prestack gather store (QI programme Q3): NMO-corrected CDP gathers in
// regular offset (or angle) bins, kept so any single gather can be read
// without the rest. The survey's CDP lattice is cut into blocks of cb x cb
// CDPs; one object per block holds, CDP by CDP (inline-major, then
// crossline), every bin's trace of ns float32 samples, nulls as 1e30 where
// a bin has no trace (low fold). A fold count per CDP and bin travels in a
// separate Uint16 object, so fold maps never read the samples. Pure.

export const GATHER_NULL = 1.0e30;
export const GATHER_STORE_VERSION = 1;

/** Object key of a gather block or its fold, relative to the dataset prefix. */
export const gatherBlockKey = (bi, bj) => `gathers/${bi}-${bj}.f32`;
export const foldBlockKey = (bi, bj) => `gathers/${bi}-${bj}.fold.u16`;

/** Floats in one block and the offset of a CDP's gather inside it. */
export function blockLayout({ cb, nBins, ns }) {
  if (!(cb > 0 && nBins > 0 && ns > 0)) throw new Error('The block size, bin count and sample count must be positive.');
  const gatherFloats = nBins * ns;
  return { gatherFloats, blockFloats: cb * cb * gatherFloats, cdpOffset: (li, lj) => (li * cb + lj) * gatherFloats };
}

/** Bytes a block builder holds while it fills (float32 sums and the fold). */
export const builderBytes = ({ cb, nBins, ns }) => cb * cb * nBins * (ns * 4 + 2);

/**
 * A block builder: add traces (stacking any that share a CDP and bin, as
 * the mean), then take the block's samples and fold. Sums are float32: a bin
 * holds a few traces, and a builder per block of a brick row is held at once
 * during an ingest, so memory is what counts.
 */
export function blockBuilder({ cb, nBins, ns }) {
  const layout = blockLayout({ cb, nBins, ns });
  const sum = new Float32Array(layout.blockFloats);
  const fold = new Uint16Array(cb * cb * nBins);
  return {
    add(li, lj, bin, samples) {
      if (!(li >= 0 && li < cb && lj >= 0 && lj < cb && bin >= 0 && bin < nBins)) return false;
      const at = layout.cdpOffset(li, lj) + bin * ns;
      for (let s = 0; s < ns; s++) {
        const v = samples[s];
        sum[at + s] += Number.isFinite(v) && Math.abs(v) < 1e29 ? v : 0;
      }
      const f = (li * cb + lj) * nBins + bin;
      if (fold[f] < 65535) fold[f] += 1;
      return true;
    },
    finish() {
      const data = new Float32Array(layout.blockFloats).fill(GATHER_NULL);
      for (let c = 0; c < cb * cb; c++) {
        for (let b = 0; b < nBins; b++) {
          const n = fold[c * nBins + b];
          if (!n) continue;
          const at = c * layout.gatherFloats + b * ns;
          for (let s = 0; s < ns; s++) data[at + s] = sum[at + s] / n;
        }
      }
      return { data, fold };
    },
  };
}

/** One CDP's gather from a block: nBins traces of ns samples (subarray views) and their fold. */
export function readGather(block, foldBlock, { cb, nBins, ns }, li, lj) {
  const layout = blockLayout({ cb, nBins, ns });
  const at = layout.cdpOffset(li, lj);
  const traces = Array.from({ length: nBins }, (_, b) => block.subarray(at + b * ns, at + (b + 1) * ns));
  const fold = Array.from(foldBlock.subarray((li * cb + lj) * nBins, (li * cb + lj + 1) * nBins));
  return { traces, fold };
}

/**
 * The dataset manifest of a gather store.
 * @param {{name, il: {min, step, count}, xl: {min, step, count}, ns, dtUs, cb, bins: {kind: 'offset'|'angle', width, centres: number[]}, affine?, crs?, source?}} p
 */
export function gatherManifest({ name, il, xl, ns, dtUs, cb, bins, affine = null, crs = null, source = null }) {
  if (!['offset', 'angle'].includes(bins?.kind)) throw new Error('The bins must be offset or angle bins.');
  return {
    store_version: GATHER_STORE_VERSION,
    kind: bins.kind === 'offset' ? 'gathers_offset' : 'gathers_angle',
    name,
    geometry: { il, xl, ns, dt_us: dtUs, ...(affine ? { affine } : {}), ...(crs ? { crs } : {}) },
    blocks: { size: cb, grid: [Math.ceil(il.count / cb), Math.ceil(xl.count / cb)], dtype: 'float32le', null_value: GATHER_NULL, path_pattern: 'gathers/{i}-{j}.f32', fold_pattern: 'gathers/{i}-{j}.fold.u16' },
    bins: { kind: bins.kind, width: bins.width, centres: bins.centres },
    ...(source ? { source } : {}),
  };
}

/**
 * Which block and slot a CDP lands in.
 * @returns {{bi, bj, li, lj}}
 */
export function cdpSlot(ilIdx, xlIdx, cb) {
  return { bi: Math.floor(ilIdx / cb), bj: Math.floor(xlIdx / cb), li: ilIdx % cb, lj: xlIdx % cb };
}
