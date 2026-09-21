// Wellsite Studio WS0: the depth structure (docs/scope/WellsiteStudio-PLAN.md
// section 4, spec sections 10 and 11).
//
// No geological record may carry a bare depth. An entered depth is
// { value, unit, reference, datum, kind } and every field is mandatory;
// validateDepth refuses anything less. toCanonicalMd turns the entry into
// the registry's canonical depth (metres MD below KB) plus the calculated
// TVD and subsea depth, and records the survey version and the method it
// used, so a later survey revision never silently changes what was
// stored (recalculate does that explicitly and keeps the original).
//
// Reuses the drilling survey math (sanctioned edge wellsite -> drilling):
// tvdAt is exact partial minimum curvature, mdsAtTvd finds every MD at
// which the path crosses a TVD plane. A second implementation of either
// would be a second thing to be wrong.
//
// Datum shifts (KB, RT, GL, MSL) are applied as a length along the hole.
// That is exact because the hole is vertical between the surface datums
// (a conductor is vertical); the same shift applies to TVD by definition.
// Subsea depth (tvdssM) is positive below mean sea level, the wellPath
// convention; elevationM is its negative for map users.

import { tvdAt } from '../drilling/wellControl.js';
import { computeWellPath, mdsAtTvd } from '../drilling/surveyMath.js';

export const DEPTH_UNITS = Object.freeze(['m', 'ft']);
export const DEPTH_REFERENCES = Object.freeze(['MD', 'TVD', 'TVDSS']);
export const DEPTH_DATUMS = Object.freeze(['KB', 'RT', 'GL', 'MSL']);
export const DEPTH_KINDS = Object.freeze(['bit_depth', 'lagged_sample', 'logged', 'prognosis', 'planned', 'event']);
export const M_PER_FT = 0.3048;
export const DEPTH_METHODS = Object.freeze(['minimum_curvature', 'minimum_curvature_extrapolated', 'vertical']);

const DEG = Math.PI / 180;

export function toMetres(value, unit) {
  return unit === 'ft' ? value * M_PER_FT : value;
}
export function fromMetres(m, unit) {
  return unit === 'ft' ? m / M_PER_FT : m;
}

/** Every field present and in its set. Errors are one per defect. */
export function validateDepth(d) {
  const errors = [];
  if (!d || typeof d !== 'object') return { ok: false, errors: ['A depth entry is required.'] };
  if (!Number.isFinite(d.value)) errors.push('Depth value is missing or not a number.');
  if (!DEPTH_UNITS.includes(d.unit)) errors.push('Depth unit is missing, expected m or ft.');
  if (!DEPTH_REFERENCES.includes(d.reference)) errors.push('Depth reference is missing, expected MD, TVD or TVDSS.');
  if (!DEPTH_DATUMS.includes(d.datum)) errors.push('Depth datum is missing, expected KB, RT, GL or MSL.');
  if (!DEPTH_KINDS.includes(d.kind)) errors.push(`Depth kind is missing, expected one of ${DEPTH_KINDS.join(', ')}.`);
  if (d.reference === 'TVDSS' && d.datum && d.datum !== 'MSL') errors.push('TVDSS is measured from MSL, choose datum MSL.');
  return { ok: errors.length === 0, errors };
}

/** Elevation of a datum above MSL from the well context. */
export function datumElevationM(datum, ctx) {
  if (datum === 'MSL') return 0;
  if (datum === 'KB') return ctx.kbElevM;
  if (datum === 'RT') return Number.isFinite(ctx.rtElevM) ? ctx.rtElevM : ctx.kbElevM;
  if (datum === 'GL') return ctx.glElevM;
  return undefined;
}

function checkCtx(ctx, datum) {
  const errors = [];
  if (!ctx || !Number.isFinite(ctx.kbElevM)) errors.push('The well needs a KB elevation above MSL before depths can be stored.');
  if (datum === 'GL' && !(ctx && Number.isFinite(ctx.glElevM))) errors.push('Datum GL needs a ground level elevation on the well.');
  return errors;
}

function surveyOf(ctx) {
  const s = ctx && ctx.survey;
  if (!s || !Array.isArray(s.stations) || s.stations.length < 2) return null;
  return s;
}

/** TVD below KB at an MD below KB, extrapolating along the last attitude past the last station. */
export function mdToTvd(mdM, ctx) {
  const s = surveyOf(ctx);
  const kb = ctx.kbElevM;
  if (!s) return { tvdM: mdM, tvdssM: mdM - kb, elevationM: kb - mdM, surveyVersion: null, method: 'vertical', warnings: [] };
  const st = s.stations;
  const last = st[st.length - 1];
  const warnings = [];
  let tvd;
  let method = 'minimum_curvature';
  if (mdM > last.md) {
    tvd = tvdAt(st, last.md) + (mdM - last.md) * Math.cos(last.inc * DEG);
    method = 'minimum_curvature_extrapolated';
    warnings.push(`MD ${mdM} m is beyond the last survey station at ${last.md} m, TVD extrapolated along the last attitude.`);
  } else {
    tvd = tvdAt(st, Math.max(mdM, st[0].md));
  }
  return { tvdM: tvd, tvdssM: tvd - kb, elevationM: kb - tvd, surveyVersion: s.version ?? null, method, warnings };
}

/** MD below KB at a TVD below KB. Refuses ambiguous (multiple crossing) and unreachable TVDs. */
export function tvdToMd(tvdM, ctx) {
  const s = surveyOf(ctx);
  if (!s) return { mdM: tvdM, crossings: 1, method: 'vertical', surveyVersion: null };
  const st = s.stations;
  const path = computeWellPath(st, { kb: ctx.kbElevM });
  const mds = mdsAtTvd(st, path, tvdM);
  if (mds.length === 1) return { mdM: mds[0], crossings: 1, method: 'minimum_curvature', surveyVersion: s.version ?? null };
  if (mds.length > 1) return { error: `TVD ${tvdM} m crosses the well path ${mds.length} times, enter the depth as MD.`, crossings: mds.length };
  const last = st[st.length - 1];
  const lastTvd = path[path.length - 1].tvd;
  const cosInc = Math.cos(last.inc * DEG);
  if (tvdM > lastTvd && cosInc > 1e-6) {
    return {
      mdM: last.md + (tvdM - lastTvd) / cosInc,
      crossings: 1,
      method: 'minimum_curvature_extrapolated',
      surveyVersion: s.version ?? null,
      warning: `TVD ${tvdM} m is below the last survey station, MD extrapolated along the last attitude.`,
    };
  }
  return { error: `TVD ${tvdM} m is not reached by the surveyed path, extend the survey or enter MD.`, crossings: 0 };
}

/**
 * Entered depth to the canonical record.
 * ctx: { kbElevM, rtElevM?, glElevM?, survey: { stations:[{md,inc,azi}], version, method? } | null }
 * Returns { ok:true, mdM, original, calculated, warnings } or { ok:false, errors }.
 */
export function toCanonicalMd(entry, ctx, { atUtc = null } = {}) {
  const v = validateDepth(entry);
  const errors = [...v.errors, ...checkCtx(ctx, entry && entry.datum)];
  if (errors.length) return { ok: false, errors };
  const valueM = toMetres(entry.value, entry.unit);
  const shift = ctx.kbElevM - datumElevationM(entry.datum, ctx); // metres to add to a depth below the datum to get depth below KB
  const warnings = [];
  let mdM;
  let calc;
  if (entry.reference === 'MD') {
    mdM = valueM + shift;
    calc = mdToTvd(mdM, ctx);
  } else {
    const tvdKb = entry.reference === 'TVDSS' ? valueM + ctx.kbElevM : valueM + shift;
    const r = tvdToMd(tvdKb, ctx);
    if (r.error) return { ok: false, errors: [r.error] };
    if (r.warning) warnings.push(r.warning);
    mdM = r.mdM;
    calc = mdToTvd(mdM, ctx);
  }
  warnings.push(...calc.warnings);
  return {
    ok: true,
    mdM,
    original: { value: entry.value, unit: entry.unit, reference: entry.reference, datum: entry.datum, kind: entry.kind },
    calculated: {
      mdM, tvdM: calc.tvdM, tvdssM: calc.tvdssM, elevationM: calc.elevationM,
      surveyVersion: calc.surveyVersion, method: calc.method, computedAtUtc: atUtc,
    },
    warnings,
  };
}

/** Canonical MD to a display value in the requested unit, reference and datum. */
export function toDisplay(mdM, { unit = 'm', reference = 'MD', datum = 'KB' } = {}, ctx) {
  const c = mdToTvd(mdM, ctx);
  let valueM;
  if (reference === 'TVDSS') valueM = c.tvdssM;
  else {
    const shift = ctx.kbElevM - datumElevationM(datum, ctx);
    valueM = (reference === 'MD' ? mdM : c.tvdM) - shift;
  }
  return { value: fromMetres(valueM, unit), unit, reference, datum: reference === 'TVDSS' ? 'MSL' : datum, method: c.method };
}

export function depthDigits(unit) { return unit === 'ft' ? 0 : 1; }
export function fmtDepth(value, unit, digits = depthDigits(unit)) {
  if (!Number.isFinite(value)) return '';
  return `${value.toFixed(digits)} ${unit}`;
}

/** Is a stored calculated depth still current against the well's active survey? */
export function depthProvenance(rec, ctx) {
  const current = (ctx && ctx.survey && ctx.survey.version) ?? null;
  const stored = (rec && rec.calculated && rec.calculated.surveyVersion) ?? null;
  const stale = stored !== current;
  return {
    stale,
    storedVersion: stored,
    currentVersion: current,
    reason: stale ? `Calculated with survey ${stored ?? 'none'}, the current survey is ${current ?? 'none'}.` : 'Current.',
  };
}

/** Re-run the calculation from the original entry with the current survey; the original is untouched. */
export function recalculate(rec, ctx, { atUtc = null } = {}) {
  const out = toCanonicalMd(rec.original, ctx, { atUtc });
  if (!out.ok) return out;
  return { ...out, previous: rec.calculated };
}
