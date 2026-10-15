// AVO calibration and classes (QI upgrade P2.10, 2026-10-15):
//  - a scale per well: the least-squares factor s with observed = s x
//    modelled over the well's intercept and gradient (the convention of the
//    pooled scale of qi/avoWells.js, at one well); a volume divided by s
//    reads in reflectivity;
//  - a scale field: those scales spread over the map by inverse distance or
//    kriging (qi/lfmModels.js weights), so a volume can be scaled trace by
//    trace when the amplitude scale drifts across the survey; at a well the
//    field is that well's scale;
//  - the class code of a sample (Rutherford and Williams I to III,
//    Castagna's IV, one classifier with Rock Physics: rockphysics/avo.js) as
//    a number for class volumes and maps: 1 to 4, 2.5 never used;
//  - the Shuey terms a set of angles supports: three (with the curvature C)
//    only when there are three angles or more and the farthest reaches 35
//    degrees, two otherwise (the two-term fit biases the gradient past about
//    30 degrees, and the curvature is unresolved with near angles only).
// Pure, float64.

import { avoClass } from '../rockphysics/avo.js';
import { lfmWeights } from './lfmModels.js';

const fin = Number.isFinite;

export const CLASS_CODES = Object.freeze({ I: 1, II: 2, III: 3, IV: 4 });
export const CLASS_NAMES = Object.freeze({ 1: 'I', 2: 'II', 3: 'III', 4: 'IV' });

/** The class code (1 to 4) of an intercept and gradient, NaN when either is not a number. */
export function avoClassCode(A, B, band = 0.02) {
  const c = avoClass(A, B, band);
  return c ? CLASS_CODES[c] : NaN;
}

/**
 * One well's scale by least squares, observed = s x modelled over (A, B):
 * s = (mA oA + mB oB) / (mA^2 + mB^2).
 * @returns {number} NaN when the modelled pair is zero or a value is not finite
 */
export function wellScale({ modelled, observed }) {
  const { A: mA, B: mB } = modelled || {}; const { A: oA, B: oB } = observed || {};
  if (![mA, mB, oA, oB].every(fin)) return NaN;
  const d = mA * mA + mB * mB;
  return d > 0 ? (mA * oA + mB * oB) / d : NaN;
}

/**
 * The scale field at a map position from the wells' scales.
 * @param {Array<{name, x, y, scale}>} wells
 * @param {{x, y}} at
 * @param {{method?: 'idw'|'kriging', power?, variogram?, barriers?}} [o]
 */
export function scaleFieldAt(wells, at, o = {}) {
  const live = wells.filter((w) => fin(w.scale));
  if (!live.length) throw new Error('No well has a scale to spread.');
  const { wells: used, weights } = lfmWeights(live, at, o);
  let s = 0; let ws = 0;
  used.forEach((w, i) => { s += weights[i] * w.scale; ws += weights[i]; });
  return s / ws;
}

/** How many Shuey terms the stack angles support (3 needs three angles or more, the farthest at 35 degrees or more). */
export function shueyTermsFor(anglesDeg, { minFarDeg = 35 } = {}) {
  const a = (anglesDeg || []).filter(fin);
  return a.length >= 3 && Math.max(...a) >= minFarDeg ? 3 : 2;
}
