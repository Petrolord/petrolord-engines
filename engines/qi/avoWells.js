// AVO at the wells (QI programme Q7b, 2026-10-07; closes Rock Physics
// U2-008; moved from the Suite's QIStudio/services/avoWells.js on 2026-10-11,
// QI course gate E2): the intercept and gradient Rock Physics Studio modelled
// at each well's zone top (the published gather, in situ and fluid
// substituted) against the intercept and gradient the AVO volumes show at that
// well's trace and time. One least-squares scale ties the volumes' amplitudes
// to reflectivity over every usable well (A and B together); each well's
// residual and its AVO class, modelled and observed, say where they agree.
// A well with an error, or without finite A and B on both sides, stays out of
// the scale and is listed in `excluded` with the reason. Pure.
// Oracle: tools/validation/qi/oracle_qi_avo_wells.py.

import { avoClass } from './avo.js';

const fin = Number.isFinite;

/** The well points for sample_volumes, from prepared wells and their zone-top times. */
export function wellPoints(rows) {
  return rows.filter((r) => r.ok && fin(r.topTwt)).map((r) => ({ name: r.name, il: r.il, xl: r.xl, t_ms: r.topTwt }));
}

/**
 * Why a row stays out of the pooled scale, or null when it enters it. A row
 * enters only with no error and with finite A and B both modelled and observed
 * (owner decision 2026-10-12: a well flagged with an error, or one whose
 * seismic gradient is null, no longer pulls the scale).
 */
export function exclusionReason(r) {
  if (r.error) return r.error;
  if (!r.observed) return 'no observed value';
  if (!fin(r.modelled?.A) || !fin(r.modelled?.B)) return 'no modelled intercept and gradient';
  if (!fin(r.observed.A) || !fin(r.observed.B)) return 'the seismic intercept or gradient is null at this well';
  return null;
}

/**
 * The comparison.
 * @param {Array<{name, modelled: {A, B}, substituted?: {A, B}, observed: ?{A, B}, error?: string}>} rows
 * @returns {{scale: number, wells: Array, agree: number, n: number, excluded: Array<{name, reason}>}}
 */
export function compareAtWells(rows) {
  let so = 0; let sm = 0; let n = 0;
  const excluded = [];
  for (const r of rows) {
    const reason = exclusionReason(r);
    if (reason) { excluded.push({ name: r.name, reason }); continue; }
    for (const k of ['A', 'B']) { so += r.observed[k] * r.modelled[k]; sm += r.modelled[k] * r.modelled[k]; }
    n += 1;
  }
  const scale = n && sm > 0 ? so / sm : NaN;
  const wells = rows.map((r) => {
    const reason = exclusionReason(r);
    if (reason || !fin(scale)) return { ...r, error: reason || 'no observed value' };
    const obs = { A: r.observed.A / scale, B: r.observed.B / scale };
    const res = Math.hypot(obs.A - r.modelled.A, obs.B - r.modelled.B);
    const mClass = avoClass(r.modelled.A, r.modelled.B); const oClass = avoClass(obs.A, obs.B);
    return { ...r, scaled: obs, residual: res, modelledClass: mClass, observedClass: oClass, agree: mClass === oClass };
  });
  return { scale, wells, n, agree: wells.filter((w) => w.agree).length, excluded };
}
