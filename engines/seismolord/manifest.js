// Versioned brick-store manifest (plan of record: manifest schema is
// versioned from day 1 — brick stores outlive code).

import { affineToManifest } from './surveyGeometry';

export const MANIFEST_VERSION = 1;

/** Derived (attribute) volumes are written as manifest v2: same geometry
 *  and brick schema as v1 plus `kind` / `parent` / `attribute`
 *  provenance. The version bump rides W0.1's aged gate — pre-Wave-2
 *  clients refuse derived volumes with upgrade copy instead of guessing
 *  at fields they were never written against. */
export const DERIVED_MANIFEST_VERSION = 2;

/** 2D line manifests (W5.1) are version 3, kind '2d_line' — the version
 *  bump rides the aged gate exactly like Wave 2's derived volumes. */
export const LINE_MANIFEST_VERSION = 3;

/** Large-survey brick stores (manifest v4): an 8-bit display copy with
 *  levels of detail plus a compressed float32 copy, both bricked 64^3,
 *  each brick its own object. Additive over v1 (geometry, brick, stats,
 *  trace_count, source keep their meaning; brick.path_pattern points at
 *  the float32 copy). See buildManifestV4. */
export const BRICKS_V4_MANIFEST_VERSION = 4;

/** Highest manifest_version this reader understands. Bump ONLY together
 *  with reader support for the new schema. v4 readers: BrickSource v4
 *  (display levels) and v4BrickFetcher (float32 through the v1 path
 *  names every existing consumer uses). */
export const MANIFEST_READ_MAX = 4;

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
  if (version === BRICKS_V4_MANIFEST_VERSION) assertV4Codecs(manifest);
  const dtype = manifest?.brick?.dtype ?? 'float32le';
  // W4.4: 'int16le-scaled' joins float32le (decoded in BrickCache via
  // brickCodec). Anything else is still a future encoding — refuse.
  if (dtype !== 'float32le' && dtype !== 'int16le-scaled') {
    throw new UnsupportedManifestError(
      `Unsupported brick dtype "${dtype}"; this reader decodes float32le and int16le-scaled only.`,
    );
  }
}

const V4_COMPRESSIONS = ['deflate-raw', 'none'];

/** v4 stores name their codecs; anything this reader cannot decode is a
 *  future encoding and is refused by name, like a future version. */
function assertV4Codecs(manifest) {
  const d = manifest?.display;
  const f = manifest?.f32;
  if (!d || d.codec !== 'u8' || !V4_COMPRESSIONS.includes(d.compression)
    || !Array.isArray(d.levels) || d.levels.length === 0) {
    throw new UnsupportedManifestError(
      `Unsupported v4 display copy (codec "${d?.codec}", compression "${d?.compression}").`);
  }
  if (!f || f.codec !== 'f32-shuffle-deflate' || !V4_COMPRESSIONS.includes(f.compression)) {
    throw new UnsupportedManifestError(
      `Unsupported v4 float32 copy (codec "${f?.codec}", compression "${f?.compression}").`);
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

// v4 object paths (plan of record section 3): every brick is its own
// Storage object, fetchable on its own.
export const V4_DIR = 'v4';
export const displayLevelDir = (level) => `${V4_DIR}/d${level}`;
export const f32Dir = () => `${V4_DIR}/f`;
export const displayBrickRelPath = (level, i, j, k) => `${displayLevelDir(level)}/${i}-${j}-${k}.u8z`;
export const f32BrickRelPath = (i, j, k) => `${f32Dir()}/${i}-${j}-${k}.f32z`;
export const displayPathPattern = (level) => `${displayLevelDir(level)}/{i}-{j}-{k}.u8z`;
export const F32_PATH_PATTERN = `${V4_DIR}/f/{i}-{j}-{k}.f32z`;

/** Is this a v4 (two-copy) brick store? */
export const isV4Manifest = (manifest) =>
  (manifest?.manifest_version ?? MANIFEST_VERSION) === BRICKS_V4_MANIFEST_VERSION;

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

/**
 * Build the manifest.json content for a DERIVED (attribute) volume —
 * manifest v2. Geometry and the brick block are copied VERBATIM from
 * the parent manifest: lattice identity is the contract that lets
 * derived volumes co-render against their parent with no resampling.
 *
 * @param {Object} p
 * @param {string} p.volumeId new volume id
 * @param {string} p.name display name
 * @param {Object} p.parentManifest the parent volume's (effective) manifest
 * @param {{name: string, params?: Object}} p.attribute registry attribute + params
 * @param {Object} p.job runVolumeJob() result ({brickGrid, stats, traceCount})
 */
export function buildDerivedManifest({ volumeId, name, parentManifest, attribute, job }) {
  const pb = parentManifest.brick;
  const g = job.brickGrid;
  if (pb.dtype !== 'float32le') {
    throw new Error(`Derived volumes require a float32le parent, got "${pb.dtype}".`);
  }
  if (g.ni !== pb.grid[0] || g.nj !== pb.grid[1] || g.nk !== pb.grid[2] || g.brickSize !== pb.size) {
    throw new Error(
      `Job brick grid ${g.ni}x${g.nj}x${g.nk}@${g.brickSize} does not match the parent `
      + `${pb.grid.join('x')}@${pb.size} — the derived lattice must be identical.`,
    );
  }
  return {
    manifest_version: DERIVED_MANIFEST_VERSION,
    app: 'seismolord',
    volume_id: volumeId,
    name,
    kind: 'attribute',
    parent: {
      volume_id: parentManifest.volume_id,
      name: parentManifest.name,
    },
    attribute: {
      name: attribute.name,
      params: attribute.params ?? {},
    },
    geometry: JSON.parse(JSON.stringify(parentManifest.geometry)),
    // derived bricks are always raw float32 under bricks/: a v4 parent's
    // lattice is copied, its v4 object paths are not
    brick: { ...JSON.parse(JSON.stringify(pb)), path_pattern: 'bricks/{i}-{j}-{k}.f32' },
    stats: job.stats,
    trace_count: job.traceCount,
  };
}

/**
 * Build the manifest v4 content (large-survey plan section 4): the v1
 * block (source, geometry, brick, stats, trace_count) with brick.path_pattern
 * naming the compressed float32 copy, plus `display` (the u8 copy and its
 * levels of detail) and `f32`. Both copies start incomplete; the upload
 * job flips display.complete after stage 1 and f32.complete after stage 2
 * (withV4Complete).
 *
 * @param {Object} p as buildManifest, with p.transcode a transcodeV4()
 *   result ({brickGrid, stats, traceCount, display, compression})
 */
export function buildManifestV4({ volumeId, name, scan, transcode, sourceFileName, sourceFileSize, crs }) {
  const m = buildManifest({ volumeId, name, scan, transcode, sourceFileName, sourceFileSize, crs });
  const d = transcode.display;
  m.manifest_version = BRICKS_V4_MANIFEST_VERSION;
  m.brick.path_pattern = F32_PATH_PATTERN;
  m.display = {
    codec: 'u8',
    // q = 128 + sign(a) * round(min(|a| / clip, 1) * 127), 0 = null
    quantisation: { zero: 128, steps: 127, null: 0, rounding: 'half-away-from-zero' },
    clip: d.clip,
    clip_percentile: d.clipPercentile,
    clip_source: d.clipSource,
    percentiles: d.percentiles,
    histogram: d.histogram,
    brick_size: transcode.brickGrid.brickSize,
    layout: 'il-major,xl,sample-fastest',
    compression: transcode.compression,
    // level L is 2^L decimated per axis: the mean of the live values of
    // the 2x2x2 block one level finer, then quantised
    levels: d.levels.map((l) => ({
      level: l.level,
      dims: l.dims,
      bricks: l.grid,
      count: l.grid[0] * l.grid[1] * l.grid[2],
      path_pattern: displayPathPattern(l.level),
    })),
    complete: false,
  };
  m.f32 = {
    codec: 'f32-shuffle-deflate',
    compression: transcode.compression,
    path_pattern: F32_PATH_PATTERN,
    complete: false,
  };
  return m;
}

/** A copy of a v4 manifest with completion flags set. */
export function withV4Complete(manifest, { display, f32 } = {}) {
  const m = JSON.parse(JSON.stringify(manifest));
  if (display != null) m.display.complete = Boolean(display);
  if (f32 != null) m.f32.complete = Boolean(f32);
  return m;
}
