// Versioned brick-store manifest (plan of record: manifest schema is
// versioned from day 1 — brick stores outlive code).

import { affineToManifest } from './surveyGeometry';

export const MANIFEST_VERSION = 1;

/** Highest manifest_version this reader understands. Bump ONLY together
 *  with reader support for the new schema. */
export const MANIFEST_READ_MAX = 1;

/** Named refusal: a manifest this reader must not attempt to decode.
 *  Catch by `e.name === 'UNSUPPORTED_MANIFEST'`. */
export class UnsupportedManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UNSUPPORTED_MANIFEST';
  }
}

/**
 * Refuse manifests written by a newer schema or with a brick payload
 * encoding this reader cannot decode. A stale cached client decoding a
 * future int16/v2 brick store as raw float32 would render garbage
 * silently; refusing loudly here is the only safe behaviour. Pre-gate
 * manifests (missing version / dtype fields) are v1-era by construction
 * and pass unchanged.
 */
export function assertManifestSupported(manifest) {
  const version = manifest?.manifest_version ?? MANIFEST_VERSION;
  if (version > MANIFEST_READ_MAX) {
    throw new UnsupportedManifestError(
      `Manifest version ${version} is newer than this reader supports (max ${MANIFEST_READ_MAX}).`,
    );
  }
  const dtype = manifest?.brick?.dtype ?? 'float32le';
  if (dtype !== 'float32le') {
    throw new UnsupportedManifestError(
      `Unsupported brick dtype "${dtype}"; this reader decodes float32le only.`,
    );
  }
}

/** Playbook null: propagates everywhere, never enters statistics. */
export const NULL_VALUE = 1.0e30;

export const DEFAULT_BRICK_SIZE = 64;

/** Storage layout under the private 'seismic' bucket (owner-path RLS). */
export const volumeDir = (userId, volumeId) => `${userId}/${volumeId}`;
export const manifestPath = (userId, volumeId) => `${volumeDir(userId, volumeId)}/manifest.json`;
export const brickRelPath = (i, j, k) => `bricks/${i}-${j}-${k}.f32`;
export const brickPath = (userId, volumeId, i, j, k) =>
  `${volumeDir(userId, volumeId)}/${brickRelPath(i, j, k)}`;

/**
 * Build the manifest.json content for an ingested volume.
 *
 * @param {Object} p
 * @param {string} p.volumeId
 * @param {string} p.name display name (usually the source file name)
 * @param {Object} p.scan scanGeometry() result (full scan, regular grid)
 * @param {Object} p.transcode transcodeToBricks() result
 * @param {string} p.sourceFileName
 * @param {number} p.sourceFileSize
 * @param {Object} [p.crs] CRS block from the import step's decision:
 *   {project, native, native_affine, native_xy_unit, transform,
 *   max_residual_m} — geometry.affine is IN the project CRS when this is
 *   present; native_affine preserves the as-scanned placement so any
 *   later reprojection restarts from native, never chains.
 */
export function buildManifest({ volumeId, name, scan, transcode, sourceFileName, sourceFileSize, crs }) {
  return {
    manifest_version: MANIFEST_VERSION,
    app: 'seismolord',
    volume_id: volumeId,
    name,
    source: {
      file_name: sourceFileName,
      file_size: sourceFileSize,
      sample_format: scan.formatCode,
      il_byte: scan.mapping.ilByte,
      xl_byte: scan.mapping.xlByte,
      x_byte: scan.mapping.xByte,
      y_byte: scan.mapping.yByte,
      scalar_byte: scan.mapping.scalarByte,
    },
    geometry: {
      il: scan.il,
      xl: scan.xl,
      ns: scan.ns,
      dt_us: scan.dtUs,
      coord_scalar: scan.coordScalar,
      corners: scan.corners,
      // measured survey affine (rotation + rectangular bins); additive
      // field — pre-affine manifests fall back to the corner assumption
      affine: affineToManifest(scan.affine),
      ...(crs ? { crs } : {}),
    },
    brick: {
      size: transcode.brickGrid.brickSize,
      grid: [transcode.brickGrid.ni, transcode.brickGrid.nj, transcode.brickGrid.nk],
      count: transcode.brickGrid.ni * transcode.brickGrid.nj * transcode.brickGrid.nk,
      dtype: 'float32le',
      // data[(li*size + lj)*size + lk]: local inline major, crossline,
      // sample fastest — matches trace memory order.
      layout: 'il-major,xl,sample-fastest',
      path_pattern: 'bricks/{i}-{j}-{k}.f32',
      null_value: NULL_VALUE,
    },
    stats: transcode.stats,
    trace_count: transcode.traceCount,
  };
}
