// Versioned brick-store manifest (plan of record: manifest schema is
// versioned from day 1 — brick stores outlive code).

import { affineToManifest } from './surveyGeometry';

export const MANIFEST_VERSION = 1;

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
 */
export function buildManifest({ volumeId, name, scan, transcode, sourceFileName, sourceFileSize }) {
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
