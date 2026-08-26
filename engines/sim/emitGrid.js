// Cartesian box-grid emitter (GRID section). Layer-cake properties:
// one {dz, poro, permx, permy?, permz} entry per layer, constant within
// the layer (the S3 scope; corner-point from surfaces is an S4 idea).
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

/**
 * grid: { nx, ny, nz, dx, dy, topsDepth, layers: [{dz, poro, permx,
 * permy?, permz}] } with layers.length === nz.
 */
export function emitGrid(grid) {
  const { nx, ny, nz, dx, dy, topsDepth, layers } = grid;
  [nx, ny, nz].forEach((n) => {
    if (!Number.isInteger(n) || n < 1) throw new Error('emitGrid: nx/ny/nz must be positive integers');
  });
  if (!Array.isArray(layers) || layers.length !== nz) {
    throw new Error(`emitGrid: expected ${nz} layer entries, got ${layers?.length ?? 0}`);
  }
  const cells = nx * ny;
  const parts = [];
  parts.push(['DX', wrap(` ${nx * ny * nz}*${fmt(dx, 4)} /`), ''].join('\n'));
  parts.push(['DY', wrap(` ${nx * ny * nz}*${fmt(dy, 4)} /`), ''].join('\n'));
  parts.push(layerConstantBlock('DZ', grid, perLayer(grid, 'dz')));
  parts.push(['TOPS', wrap(` ${cells}*${fmt(topsDepth, 4)} /`), ''].join('\n'));
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
