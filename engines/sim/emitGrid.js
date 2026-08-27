// Cartesian grid emitter (GRID section), block-centred geometry.
// Layer-cake properties: one {dz, poro, permx, permy?, permz} entry per
// layer, constant within the layer. Structure (S4): `tops` may be a
// per-cell nx*ny array of layer-1 top depths (Eclipse natural order,
// I fastest) sampled from a mapped surface — deeper layers stack
// conformably, which is exactly Eclipse's block-centred TOPS rule.
// FIELD units: ft, mD.
import { fmt, starRepeat, wrap } from './deckFormat.js';

function perLayer(grid, key, fallbackKey = null) {
  return grid.layers.map((layer) => {
    const v = layer[key] ?? (fallbackKey ? layer[fallbackKey] : undefined);
    if (v == null || !Number.isFinite(Number(v))) {
      throw new Error(`emitGrid: layer is missing ${key}`);
    }
    return Number(v);
  });
}

function layerConstantBlock(keyword, grid, values) {
  const perLayerCells = grid.nx * grid.ny;
  const tokens = values.map((v) => `${perLayerCells}*${fmt(v, 6)}`).join(' ');
  return [keyword, wrap(` ${tokens} /`), ''].join('\n');
}

/** Layer-1 top depths as a validated nx*ny array (natural order,
 *  I fastest), whether the grid carries a per-cell `tops` array or a
 *  single `topsDepth` scalar. */
export function topsArray(grid) {
  const cells = grid.nx * grid.ny;
  if (Array.isArray(grid.tops)) {
    if (grid.tops.length !== cells) {
      throw new Error(`emitGrid: tops array must have nx*ny = ${cells} values, got ${grid.tops.length}`);
    }
    return grid.tops.map((v, idx) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`emitGrid: tops[${idx}] is not a positive depth (${v})`);
      }
      return n;
    });
  }
  if (!Number.isFinite(Number(grid.topsDepth))) {
    throw new Error('emitGrid: grid needs topsDepth or a tops array');
  }
  return new Array(cells).fill(Number(grid.topsDepth));
}

/** Column top depth at (i, j) (1-based). */
export function columnTopDepth(grid, i, j) {
  const tops = topsArray(grid);
  return tops[(j - 1) * grid.nx + (i - 1)];
}

/** Layer interface depths for column (i, j): nz+1 values, interface[0]
 *  is the column top and interface[k] the base of layer k. */
export function columnInterfaces(grid, i, j) {
  const dz = perLayer(grid, 'dz');
  const out = [columnTopDepth(grid, i, j)];
  dz.forEach((t) => out.push(out[out.length - 1] + t));
  return out;
}

/** Depth envelope over the whole grid: shallowest top, deepest base and
 *  mean top — equilibration defaults and validation use these. */
export function gridDepthRange(grid) {
  const tops = topsArray(grid);
  const thickness = perLayer(grid, 'dz').reduce((s, t) => s + t, 0);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  tops.forEach((t) => {
    if (t < min) min = t;
    if (t > max) max = t;
    sum += t;
  });
  return {
    topMin: min,
    topMax: max,
    topMean: sum / tops.length,
    bottomMax: max + thickness,
    thickness,
  };
}

/**
 * grid: { nx, ny, nz, dx, dy, layers: [{dz, poro, permx, permy?, permz}],
 *   topsDepth } OR { ..., tops: number[nx*ny] } for structural tops.
 * layers.length === nz.
 */
export function emitGrid(grid) {
  const { nx, ny, nz, dx, dy, layers } = grid;
  [nx, ny, nz].forEach((n) => {
    if (!Number.isInteger(n) || n < 1) throw new Error('emitGrid: nx/ny/nz must be positive integers');
  });
  if (!Array.isArray(layers) || layers.length !== nz) {
    throw new Error(`emitGrid: expected ${nz} layer entries, got ${layers?.length ?? 0}`);
  }
  const tops = topsArray(grid);
  const parts = [];
  parts.push(['DX', wrap(` ${nx * ny * nz}*${fmt(dx, 4)} /`), ''].join('\n'));
  parts.push(['DY', wrap(` ${nx * ny * nz}*${fmt(dy, 4)} /`), ''].join('\n'));
  parts.push(layerConstantBlock('DZ', grid, perLayer(grid, 'dz')));
  parts.push(['TOPS', wrap(` ${starRepeat(tops, 2)} /`), ''].join('\n'));
  parts.push(layerConstantBlock('PORO', grid, perLayer(grid, 'poro')));
  parts.push(layerConstantBlock('PERMX', grid, perLayer(grid, 'permx')));
  parts.push(layerConstantBlock('PERMY', grid, perLayer(grid, 'permy', 'permx')));
  parts.push(layerConstantBlock('PERMZ', grid, perLayer(grid, 'permz')));
  return parts.join('\n');
}

/** Total cell count, for RUNSPEC DIMENS + the worker's cap awareness. */
export function gridCellCount(grid) {
  return grid.nx * grid.ny * grid.nz;
}

export { starRepeat as _starRepeat };
