// Survey geometry: affine IL/XL -> world mapping.
//
// world = origin + i * ilVec + j * xlVec, where i and j are 0-based
// inline/crossline GRID INDICES (not line numbers). This supports rotated
// surveys and rectangular bins; the old axis-aligned two-corner derivation
// survives only as the fallback for pre-affine manifests
// (affineFromCorners), where it reproduces the previous behavior exactly.
//
// The affine is MEASURED, not declared: scanGeometry accumulates a
// least-squares fit x = a + b*il + c*xl (same for y) over every inspected
// trace header, so it averages away coordinate-scalar rounding and never
// trusts a single header. Traces with (0, 0) coordinates — the common
// "missing" convention — are excluded from the fit.

/** Fresh least-squares accumulator. Sums are centered on the first
 * accepted sample so UTM-magnitude coordinates keep float64 precision. */
export function makeAffineFit() {
  return {
    n: 0,
    ref: null,
    sIl: 0, sXl: 0, sX: 0, sY: 0,
    sIlIl: 0, sXlXl: 0, sIlXl: 0,
    sIlX: 0, sXlX: 0, sIlY: 0, sXlY: 0,
    sXX: 0, sYY: 0,
  };
}

/**
 * Accumulate one trace header. il/xl are LINE NUMBERS as read from the
 * header; x/y are scaled world coordinates. (0,0) coordinates are skipped.
 */
export function affineFitAdd(f, il, xl, x, y) {
  if ((x === 0 && y === 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  if (!f.ref) f.ref = { il, xl, x, y };
  const a = il - f.ref.il;
  const b = xl - f.ref.xl;
  const u = x - f.ref.x;
  const v = y - f.ref.y;
  f.n += 1;
  f.sIl += a; f.sXl += b; f.sX += u; f.sY += v;
  f.sIlIl += a * a; f.sXlXl += b * b; f.sIlXl += a * b;
  f.sIlX += a * u; f.sXlX += b * u; f.sIlY += a * v; f.sXlY += b * v;
  f.sXX += u * u; f.sYY += v * v;
}

/**
 * Solve the fit into an index-space affine.
 *
 * @param {ReturnType<typeof makeAffineFit>} f
 * @param {{ilMin:number, ilStep:number, xlMin:number, xlStep:number}} grid
 *   measured line-number range/steps (index i = (il - ilMin) / ilStep)
 * @returns {{origin:{x:number,y:number}, ilVec:{x:number,y:number},
 *   xlVec:{x:number,y:number}, fit:{n:number, rmsM:number}}|null}
 *   null when the samples cannot determine a 2D affine (too few traces,
 *   a single line, or degenerate/collinear il-xl coverage).
 */
export function solveAffineFit(f, grid) {
  if (f.n < 3) return null;
  const n = f.n;
  const mIl = f.sIl / n; const mXl = f.sXl / n;
  const mX = f.sX / n; const mY = f.sY / n;
  const cII = f.sIlIl / n - mIl * mIl;
  const cXX = f.sXlXl / n - mXl * mXl;
  const cIX = f.sIlXl / n - mIl * mXl;
  const det = cII * cXX - cIX * cIX;
  // relative degeneracy guard: det of the centered covariance vanishes
  // when all traces share one inline/crossline or il tracks xl linearly
  if (!(det > 1e-9 * Math.max(1, cII * cXX))) return null;

  const cIu = f.sIlX / n - mIl * mX;
  const cXu = f.sXlX / n - mXl * mX;
  const cIv = f.sIlY / n - mIl * mY;
  const cXv = f.sXlY / n - mXl * mY;
  const bIlX = (cIu * cXX - cXu * cIX) / det;
  const bXlX = (cXu * cII - cIu * cIX) / det;
  const bIlY = (cIv * cXX - cXv * cIX) / det;
  const bXlY = (cXv * cII - cIv * cIX) / det;

  // residual RMS (metres) across both coordinates, from the variance
  // identity SSE = n * (Var(u) - b_il*Cov(il,u) - b_xl*Cov(xl,u))
  const cUU = f.sXX / n - mX * mX;
  const cVV = f.sYY / n - mY * mY;
  const sseX = Math.max(0, n * (cUU - bIlX * cIu - bXlX * cXu));
  const sseY = Math.max(0, n * (cVV - bIlY * cIv - bXlY * cXv));
  const rmsM = Math.sqrt((sseX + sseY) / n);

  // world position at line numbers (il, xl):
  //   ref + centeredIntercept + bIl*(il - ref.il) + bXl*(xl - ref.xl)
  const a0x = mX - bIlX * mIl - bXlX * mXl;
  const a0y = mY - bIlY * mIl - bXlY * mXl;
  const worldAt = (il, xl) => ({
    x: f.ref.x + a0x + bIlX * (il - f.ref.il) + bXlX * (xl - f.ref.xl),
    y: f.ref.y + a0y + bIlY * (il - f.ref.il) + bXlY * (xl - f.ref.xl),
  });

  const ilStep = grid.ilStep || 1;
  const xlStep = grid.xlStep || 1;
  return {
    origin: worldAt(grid.ilMin, grid.xlMin),
    ilVec: { x: bIlX * ilStep, y: bIlY * ilStep },
    xlVec: { x: bXlX * xlStep, y: bXlY * xlStep },
    fit: { n, rmsM },
  };
}

/**
 * Legacy fallback: the axis-aligned affine implied by a two-corner
 * manifest (x along crosslines, y along inlines) — bit-compatible with
 * the previous picksToPoints/surveySpacing derivation. Rotated surveys
 * ingested before affine capture get the same (wrong) geometry they
 * already had; re-ingest fixes them.
 *
 * @param {Object} geometry manifest.geometry (v1)
 */
export function affineFromCorners(geometry) {
  const c = geometry?.corners;
  if (!c?.first || !c?.last) return null;
  const nIl = geometry.il?.count || 0;
  const nXl = geometry.xl?.count || 0;
  const dxPerXl = nXl > 1 ? (c.last.x - c.first.x) / (nXl - 1) : 0;
  const dyPerIl = nIl > 1 ? (c.last.y - c.first.y) / (nIl - 1) : 0;
  if (!Number.isFinite(dxPerXl) || !Number.isFinite(dyPerIl)) return null;
  return {
    origin: { x: c.first.x, y: c.first.y },
    ilVec: { x: 0, y: dyPerIl },
    xlVec: { x: dxPerXl, y: 0 },
    legacyAxisAligned: true,
  };
}

/**
 * Resolve a manifest geometry to an affine: the measured fit when the
 * manifest carries one (geometry.affine, snake_case keys), else the
 * legacy corner derivation, else null.
 * @param {Object} geometry manifest.geometry
 */
export function surveyAffine(geometry) {
  const a = geometry?.affine;
  if (a?.origin && a?.il_vec && a?.xl_vec) {
    return {
      origin: { x: a.origin.x, y: a.origin.y },
      ilVec: { x: a.il_vec.x, y: a.il_vec.y },
      xlVec: { x: a.xl_vec.x, y: a.xl_vec.y },
      fit: a.fit ? { n: a.fit.n, rmsM: a.fit.rms_m } : undefined,
    };
  }
  return affineFromCorners(geometry);
}

/** Manifest (snake_case) form of a solved affine. */
export function affineToManifest(aff) {
  if (!aff) return undefined;
  return {
    origin: { x: aff.origin.x, y: aff.origin.y },
    il_vec: { x: aff.ilVec.x, y: aff.ilVec.y },
    xl_vec: { x: aff.xlVec.x, y: aff.xlVec.y },
    ...(aff.fit ? { fit: { n: aff.fit.n, rms_m: aff.fit.rmsM } } : {}),
  };
}

/** World position of grid indices (i inline, j crossline). */
export function ilxlToWorld(aff, i, j) {
  return {
    x: aff.origin.x + i * aff.ilVec.x + j * aff.xlVec.x,
    y: aff.origin.y + i * aff.ilVec.y + j * aff.xlVec.y,
  };
}

/**
 * Continuous grid indices of a world position, or null when the affine
 * is not invertible (a legacy fallback with zero spacing, degenerate fit).
 * @returns {{i:number, j:number}|null}
 */
export function worldToIlxl(aff, x, y) {
  const det = aff.ilVec.x * aff.xlVec.y - aff.ilVec.y * aff.xlVec.x;
  if (!det) return null;
  const dx = x - aff.origin.x;
  const dy = y - aff.origin.y;
  return {
    i: (dx * aff.xlVec.y - dy * aff.xlVec.x) / det,
    j: (dy * aff.ilVec.x - dx * aff.ilVec.y) / det,
  };
}

/** Ground metres per inline/crossline index step. */
export function cellSpacing(aff) {
  return {
    il: Math.hypot(aff.ilVec.x, aff.ilVec.y),
    xl: Math.hypot(aff.xlVec.x, aff.xlVec.y),
  };
}

/** Axis-aligned world bounding box of the survey's four corners. */
export function surveyBounds(aff, nIl, nXl) {
  const corners = [
    ilxlToWorld(aff, 0, 0),
    ilxlToWorld(aff, 0, nXl - 1),
    ilxlToWorld(aff, nIl - 1, 0),
    ilxlToWorld(aff, nIl - 1, nXl - 1),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return {
    x0: Math.min(...xs), x1: Math.max(...xs),
    y0: Math.min(...ys), y1: Math.max(...ys),
  };
}

/** Crossline-axis bearing, degrees CCW from world +X. 0 = unrotated. */
export function gridAzimuthDeg(aff) {
  return (Math.atan2(aff.xlVec.y, aff.xlVec.x) * 180) / Math.PI;
}

/**
 * Unit direction of world north (+Y) expressed in grid-index space.
 * @returns {{di:number, dj:number}|null} inline/crossline index deltas
 *   per unit of northward ground motion direction (normalized), or null
 *   when the affine is degenerate.
 */
export function northDirInGrid(aff) {
  const g = worldToIlxl(aff, aff.origin.x, aff.origin.y + 1);
  if (!g) return null;
  const len = Math.hypot(g.i, g.j);
  if (!len) return null;
  return { di: g.i / len, dj: g.j / len };
}
