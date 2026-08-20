// Seismic survey reprojection: traces are NEVER resampled. A survey's
// placement is its IL/XL -> world affine, so changing CRS means refitting
// that affine in the target CRS and nothing else. The native affine stays
// recorded in provenance, and any later reprojection starts from native
// again, so error never accumulates across CRS changes.
//
// A map projection is not an affine map, so the refit has a residual: we
// transform a lattice of sample points exactly, fit the best affine
// through them, and report the worst disagreement as maxResidualM. For
// survey-sized extents between sensible projected CRSs this is
// centimetre-scale; a large residual means the survey genuinely cannot be
// carried as an affine in the target CRS and the caller must warn.

import {
  makeAffineFit, affineFitAdd, solveAffineFit, ilxlToWorld,
} from '../../engines/seismolord/surveyGeometry';

const LATTICE_N = 5;

/**
 * Refit a survey affine in another CRS.
 *
 * @param {{origin:Object, ilVec:Object, xlVec:Object}} affine native affine
 *   (index-space, as from surveyAffine())
 * @param {number} nIl inline count
 * @param {number} nXl crossline count
 * @param {{forward:(x:number,y:number)=>{x:number,y:number}}} transformer
 *   native CRS -> target CRS (makeTransformer())
 * @returns {{affine:Object, maxResidualM:number,
 *   cornerShifts:{i:number,j:number,dx:number,dy:number}[]}|null}
 *   null when the transformed lattice cannot determine an affine
 *   (degenerate survey or a transform that collapses it)
 */
export function reprojectAffine(affine, nIl, nXl, transformer) {
  const iMax = Math.max(1, nIl - 1);
  const jMax = Math.max(1, nXl - 1);
  const samples = [];
  const fit = makeAffineFit();
  for (let a = 0; a < LATTICE_N; a += 1) {
    for (let b = 0; b < LATTICE_N; b += 1) {
      const i = (a / (LATTICE_N - 1)) * iMax;
      const j = (b / (LATTICE_N - 1)) * jMax;
      const native = ilxlToWorld(affine, i, j);
      const t = transformer.forward(native.x, native.y);
      if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) return null;
      samples.push({ i, j, x: t.x, y: t.y });
      affineFitAdd(fit, i, j, t.x, t.y);
    }
  }
  const solved = solveAffineFit(fit, { ilMin: 0, ilStep: 1, xlMin: 0, xlStep: 1 });
  if (!solved) return null;

  let maxResidualM = 0;
  for (const s of samples) {
    const p = ilxlToWorld(solved, s.i, s.j);
    maxResidualM = Math.max(maxResidualM, Math.hypot(p.x - s.x, p.y - s.y));
  }

  const cornerShifts = [
    { i: 0, j: 0 }, { i: 0, j: jMax }, { i: iMax, j: 0 }, { i: iMax, j: jMax },
  ].map(({ i, j }) => {
    const native = ilxlToWorld(affine, i, j);
    const target = ilxlToWorld(solved, i, j);
    return { i, j, dx: target.x - native.x, dy: target.y - native.y };
  });

  return { affine: solved, maxResidualM, cornerShifts };
}

/** Warn threshold for the refit residual: max(0.5 m, a quarter bin). */
export function residualWarnThresholdM(binM) {
  return Math.max(0.5, (Number.isFinite(binM) ? binM : 0) / 4);
}
