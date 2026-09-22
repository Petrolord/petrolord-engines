// Trajectory profile design solvers (Well Design Studio WD2).
//
// Exact closed-form circular-arc geometry on the minimum-curvature
// circle; iteration only where the industry-standard treatment is
// itself iterative (the curve-hold-curve landing, per the vector
// algorithm of Sawaryn & Thorogood, SPE 84246). Compass azimuth
// convention throughout: azi = atan2(dE, dN), clockwise from grid
// north. Vector frame matches surveyMath: {e, n, v} with v positive
// down; the right-lateral basis r = cross(h, t) is the one the
// toolface goldens validated.
//
// Every solver takes rates in degrees per interval OF THE CALLER'S
// DEPTH UNIT (30 for 'm', 100 for 'ft' — the segmentCompiler rule) and
// returns { feasible, error?, segments, report }. `segments` are
// engine-kind segment specs ready for compileSegments, so a solved
// profile is immediately editable and compilable.
//
// Every solver is total: it never throws and never runs unbounded. All
// inputs are checked for finiteness up front, every iteration carries an
// explicit cap, and the emitted geometry is checked against a length
// budget before it is returned. A caller that hands a solver garbage, or
// asks for geometry no arc can reach, gets { feasible: false, error } —
// an unbounded hold or a NaN-length segment would otherwise be compiled
// into a station list large enough to blow the JS stack downstream.
//
// Pure math, worker-safe, no I/O.

import { tangent, doglegRad } from '../seismolord/wellPath.js';
import { attitudeFromTangent, normalizeAzi } from './surveyMath.js';

const DEG = Math.PI / 180;

// A solved profile longer than this many times the straight-line
// tie-on-to-target distance is degenerate, not a design: the arcs have
// nearly cancelled and the hold has run away. Compass-class planners
// reject the same geometry rather than emit it.
const MAX_LENGTH_RATIO = 50;
// Absolute floor for the budget so near-zero displacements (a target
// almost on the tie-on) still allow a sane minimum profile.
const MIN_LENGTH_BUDGET = 1e4;

/** Names of the non-finite entries in `values`, for a precise error. */
function nonFinite(values) {
  return Object.keys(values).filter((k) => !Number.isFinite(values[k]));
}

const finiteError = (values) => {
  const bad = nonFinite(values);
  return bad.length
    ? `Not a number: ${bad.join(', ')}. Check the dialog fields and the target coordinates.`
    : null;
};

// ---- target frame assertion (Well Design fix, 2026-09-03) ---------------
// The solvers take DISPLACEMENTS from the tie-on in the solver's own depth
// unit. A caller that hands them absolute grid coordinates, or metres
// while solving in feet, gets geometry that is technically solvable and
// completely wrong (a plan that autoscales to 800,000 ft and a "750,253
// ft of hole" refusal). So the boundary fails loudly instead: a
// displacement may carry {unit, frame}; when it does they must match, and
// any displacement beyond MAX_TARGET_REACH_M is a frame mismatch, not a
// well (the longest extended-reach wells are about 15 km).
export const MAX_TARGET_REACH_M = 50000;

export function targetFrameError(t, mdUnit = 'm', label = 'Target') {
  if (!t) return null;
  if (t.unit != null && t.unit !== mdUnit) {
    return `${label} displacement is in ${t.unit} but the solver runs in ${mdUnit}. Convert the target to the wellbore depth unit before solving.`;
  }
  if (t.frame != null && t.frame !== 'local') {
    return `${label} is in the ${t.frame} frame; the solver needs wellhead-relative (local) offsets.`;
  }
  const reach = Math.hypot(t.dE || 0, t.dN || 0, t.dTvd || 0);
  const max = mdUnit === 'ft' ? MAX_TARGET_REACH_M / M_PER_FT_LOCAL : MAX_TARGET_REACH_M;
  if (Number.isFinite(reach) && reach > max) {
    return `${label} is ${reach.toFixed(0)} ${mdUnit} from the tie-on, beyond any well (limit ${Math.round(max).toLocaleString()} ${mdUnit}). Absolute coordinates have been passed as offsets: convert the target to wellhead-relative offsets in ${mdUnit}.`;
  }
  return null;
}
const M_PER_FT_LOCAL = 0.3048;

/** Reject a solution whose emitted geometry has run away. `reach` is the
 *  straight-line distance the profile has to cover. */
function lengthGuard(segments, reach) {
  const budget = Math.max(MIN_LENGTH_BUDGET, Math.abs(reach) * MAX_LENGTH_RATIO);
  let total = 0;
  for (const s of segments) {
    if (!Number.isFinite(s.length) || s.length < 0) {
      return 'The solver produced a segment with no finite length. The geometry is degenerate; adjust the rates, the kickoff or the target.';
    }
    total += s.length;
  }
  if (total > budget) {
    return `The solved profile is ${total.toFixed(0)} long against a reach of only ${Math.abs(reach).toFixed(0)}. The curves have almost cancelled and the hold has run away. Raise the curve rates or move the target.`;
  }
  return null;
}

// ---- vertical to target (tester fix 2026-09-22) ---------------------------
// A target with no horizontal distance from the tie-on is a valid design:
// a vertical well. Every build solver below needs an azimuth, which is
// atan2(dE, dN) and meaningless at zero, and some divide by the horizontal
// distance. So each target solver first asks whether the target is
// vertically below a vertical tie-on, within a horizontal tolerance, and if
// it is answers with one vertical hold to the target TVD. The tolerance is
// in the caller's depth unit; omitted, it is 0.5 m (or its equivalent in
// feet). A tester's vertical well at the slot X and Y was being forced into
// a build and left slightly deviated.
export const DEFAULT_VERTICAL_TOLERANCE_M = 0.5;
// Above this the "tolerance" would call a deviated well vertical.
export const MAX_VERTICAL_TOLERANCE_M = 10;
// A tie-on this close to vertical is vertical (a compiled drop back to
// vertical lands within float noise of zero, never exactly on it).
const VERTICAL_INC_EPS_DEG = 1e-3;

/** Horizontal tolerance in the caller's depth unit, or { error }. */
export function verticalToleranceFor(verticalTolerance, mdUnit = 'm') {
  const perM = mdUnit === 'ft' ? 1 / M_PER_FT_LOCAL : 1;
  if (verticalTolerance == null || verticalTolerance === '') {
    return { tolerance: DEFAULT_VERTICAL_TOLERANCE_M * perM };
  }
  if (!Number.isFinite(verticalTolerance) || verticalTolerance < 0) {
    return { error: 'The vertical tolerance must be a number of zero or more.' };
  }
  if (verticalTolerance > MAX_VERTICAL_TOLERANCE_M * perM + 1e-9) {
    return {
      error: `A vertical tolerance above ${+(MAX_VERTICAL_TOLERANCE_M * perM).toFixed(2)} ${mdUnit} would call a deviated well vertical.`,
    };
  }
  return { tolerance: verticalTolerance };
}

/**
 * The vertical-to-target solution when `target` (displacement from the
 * tie-on) lies within `tolerance` horizontally of a vertical tie-on;
 * null when it does not apply. A target at or above the tie-on is
 * refused, since no hold reaches it.
 */
export function verticalToTarget(target, { tieOnInc = 0, tolerance }) {
  if (!target) return null;
  const H = Math.hypot(target.dE || 0, target.dN || 0);
  if (!(H <= tolerance) || Math.abs(tieOnInc || 0) > VERTICAL_INC_EPS_DEG) return null;
  if (!(target.dTvd > 0)) {
    return {
      feasible: false,
      error: 'The target is directly above the tie-on or level with it, so no hold reaches it. Check its TVD.',
    };
  }
  return {
    feasible: true,
    segments: [{ kind: 'hold', length: target.dTvd }],
    report: {
      profile: 'vertical to target',
      verticalToTarget: true,
      aziDeg: 0,
      holdIncDeg: 0,
      holdLen: target.dTvd,
      buildLen: 0,
      doglegDeg: 0,
      horizontalMiss: H,
      tolerance,
      endMdDelta: target.dTvd,
    },
  };
}

const radiusFor = (rate, mdUnit) => {
  const interval = mdUnit === 'ft' ? 100 : 30;
  return interval / (Math.abs(rate) * DEG);
};
const intervalFor = (mdUnit) => (mdUnit === 'ft' ? 100 : 30);

// ---- vector helpers ({e, n, v}, v down) -----------------------------------

const dot = (a, b) => a.e * b.e + a.n * b.n + a.v * b.v;
const norm = (a) => Math.sqrt(dot(a, a));
const scale = (a, s) => ({ e: a.e * s, n: a.n * s, v: a.v * s });
const add = (a, b) => ({ e: a.e + b.e, n: a.n + b.n, v: a.v + b.v });
const sub = (a, b) => ({ e: a.e - b.e, n: a.n - b.n, v: a.v - b.v });
const unit = (a) => {
  const m = norm(a);
  if (m < 1e-15) throw new Error('Zero-length vector.');
  return scale(a, 1 / m);
};
// Component ordering matches the numpy oracle ([e, n, v] arrays), so
// cross(h, t) is the validated right-lateral direction.
const cross = (a, b) => ({
  e: a.n * b.v - a.v * b.n,
  n: a.v * b.e - a.e * b.v,
  v: a.e * b.n - a.n * b.e,
});

/** Highside/right-lateral frame at a tangent. Vertical holes use the
 *  toolface-from-north convention (h = north), matching the compiler. */
export function toolfaceFrame(t) {
  const sinI = Math.hypot(t.e, t.n);
  if (sinI < 1e-9) {
    const h = { e: 0, n: 1, v: 0 };
    return { h, r: cross(h, t) };
  }
  const up = { e: 0, n: 0, v: -1 };
  const h = unit(sub(up, scale(t, dot(up, t))));
  return { h, r: cross(h, t) };
}

/** Toolface (deg, clockwise from highside) that turns attitude
 *  `from` toward attitude `to` on one circular arc, plus the dogleg. */
export function toolfaceForTarget(from, to) {
  const t1 = tangent(from.inc, from.azi);
  const t2 = tangent(to.inc, to.azi);
  const beta = doglegRad(from.inc, from.azi, to.inc, to.azi);
  if (beta < 1e-12) return { toolfaceDeg: 0, doglegDeg: 0 };
  const d = scale(sub(t2, scale(t1, Math.cos(beta))), 1 / Math.sin(beta));
  const { h, r } = toolfaceFrame(t1);
  return {
    toolfaceDeg: normalizeAzi(Math.atan2(dot(d, r), dot(d, h)) / DEG),
    doglegDeg: beta / DEG,
  };
}

// ---- (i) slant / J: build (or drop) then hold to an in-plane target -------

/**
 * Build-hold from an in-plane tie-on to a target given as displacement
 * from the tie-on position: {dN, dE, dTvd} in the caller's depth unit.
 * tieOn.inc may be nonzero, but its azimuth must lie in the target
 * plane (out-of-plane tie-ons belong to solveContinuousBuild).
 * Exact circle-tangent construction:
 *   theta = atan2(H_t - C_H, V_t - C_V) +- asin(R / c)
 */
export function solveSlant({
  tieOn = { inc: 0, azi: null }, target, buildRate, mdUnit = 'm', kopLen = 0, verticalTolerance,
}) {
  if (!target) return { feasible: false, error: 'No target displacement was supplied.' };
  const frameBad = targetFrameError(target, mdUnit);
  if (frameBad) return { feasible: false, error: frameBad };
  const bad = finiteError({
    'target north': target.dN, 'target east': target.dE, 'target TVD': target.dTvd,
    'tie-on inclination': tieOn.inc ?? 0, 'kickoff length': kopLen,
  });
  if (bad) return { feasible: false, error: bad };
  const tol = verticalToleranceFor(verticalTolerance, mdUnit);
  if (tol.error) return { feasible: false, error: tol.error };
  // Vertical to target first: no azimuth, no build rate, no kickoff split.
  const vertical = verticalToTarget(target, { tieOnInc: tieOn.inc, tolerance: tol.tolerance });
  if (vertical) return vertical;
  if (!Number.isFinite(buildRate)) return { feasible: false, error: finiteError({ 'build rate': buildRate }) };
  if (!(buildRate > 0)) return { feasible: false, error: 'Build rate must be positive.' };
  if (kopLen < 0) return { feasible: false, error: 'Kickoff depth cannot be negative.' };
  if (kopLen > 0) {
    if ((tieOn.inc || 0) > VERTICAL_INC_EPS_DEG) {
      return { feasible: false, error: 'A kickoff depth needs a vertical tie-on.' };
    }
    if (!(target.dTvd > kopLen)) {
      return { feasible: false, error: 'Target TVD must be below the kickoff point.' };
    }
    const below = solveSlant({
      tieOn, target: { ...target, dTvd: target.dTvd - kopLen }, buildRate, mdUnit, verticalTolerance: 0,
    });
    if (!below.feasible) return below;
    return {
      ...below,
      segments: [{ kind: 'hold', length: kopLen }, ...below.segments],
      report: { ...below.report, kopLen, endMdDelta: kopLen + below.report.endMdDelta },
    };
  }
  const aziDeg = normalizeAzi(Math.atan2(target.dE, target.dN) / DEG);
  const H = Math.hypot(target.dE, target.dN);
  const V = target.dTvd;
  const inc0 = tieOn.inc || 0;
  if (inc0 > 1e-6 && tieOn.azi != null) {
    let dAzi = Math.abs(normalizeAzi(tieOn.azi) - aziDeg) % 360;
    if (dAzi > 180) dAzi = 360 - dAzi;
    if (dAzi > 0.5 && H > 1e-9) {
      return { feasible: false, error: 'Tie-on azimuth is out of the target plane; use the continuous build (curve to target) solver.' };
    }
  }
  if (!(V > 0)) return { feasible: false, error: 'Target TVD must be below the tie-on.' };
  const R = radiusFor(buildRate, mdUnit);
  const i0 = inc0 * DEG;
  const t0 = { h: Math.sin(i0), v: Math.cos(i0) };

  const trySide = (side) => {
    // side +1: build (center on +normal); side -1: drop.
    const C = { h: side * Math.cos(i0), v: -side * Math.sin(i0) };
    const cH = C.h * R;
    const cV = C.v * R;
    const dH = H - cH;
    const dV = V - cV;
    const c = Math.hypot(dH, dV);
    if (c < R) return null;
    const phi = Math.atan2(dH, dV);
    const theta = side > 0 ? phi + Math.asin(R / c) : phi - Math.asin(R / c);
    const arc = side > 0 ? theta - i0 : i0 - theta;
    if (arc < -1e-12 || theta < -1e-12 || theta > Math.PI) return null;
    const holdLen = Math.sqrt(Math.max(0, c * c - R * R));
    return { theta, arcLen: R * Math.max(0, arc), holdLen };
  };

  const sol = trySide(1) || trySide(-1);
  if (!sol) {
    const rMin = H > 1e-9 ? (H * H + V * V) / (2 * H) : Infinity;
    const rateMin = (intervalFor(mdUnit) / rMin) / DEG;
    return {
      feasible: false,
      error: `Target is inside the build circle. Increase the build rate above ${rateMin.toFixed(2)} deg per ${intervalFor(mdUnit)} ${mdUnit}, or move the kickoff.`,
    };
  }
  const holdIncDeg = sol.theta / DEG;
  const dropping = holdIncDeg < inc0 - 1e-9;
  const segments = [];
  if (sol.arcLen > 1e-9) {
    segments.push({ kind: 'build', rate: dropping ? -buildRate : buildRate, length: sol.arcLen });
  }
  if (sol.holdLen > 1e-9) segments.push({ kind: 'hold', length: sol.holdLen });
  const runaway = lengthGuard(segments, Math.hypot(H, V));
  if (runaway) return { feasible: false, error: runaway };
  return {
    feasible: true,
    segments,
    report: {
      aziDeg, holdIncDeg, buildLen: sol.arcLen, holdLen: sol.holdLen,
      endMdDelta: sol.arcLen + sol.holdLen, radius: R, dropping,
      doglegDeg: Math.abs(holdIncDeg - inc0),
    },
  };
}

// ---- (ii) S-profile: build, hold, drop to a final inclination -------------

/**
 * Vertical tie-on S-profile. The target {dN, dE, dTvd} (from the
 * tie-on position) is the END OF THE DROP, reached at finalIncDeg.
 * kopLen of vertical hold precedes the build. Two-circle common
 * tangent, radii on opposite sides:
 *   theta = atan2(dH12, dV12) + asin((R1 + R2) / c12)
 */
export function solveSProfile({
  kopLen = 0, buildRate, dropRate, finalIncDeg = 0, target, mdUnit = 'm', verticalTolerance,
}) {
  if (!target) return { feasible: false, error: 'No target displacement was supplied.' };
  const frameBad = targetFrameError(target, mdUnit);
  if (frameBad) return { feasible: false, error: frameBad };
  const targetBad = finiteError({
    'target north': target.dN, 'target east': target.dE, 'target TVD': target.dTvd,
  });
  if (targetBad) return { feasible: false, error: targetBad };
  const tol = verticalToleranceFor(verticalTolerance, mdUnit);
  if (tol.error) return { feasible: false, error: tol.error };
  // A target straight below the slot is a vertical well whatever the
  // kickoff, rates and final inclination say: there is no plane to build in.
  const vertical = verticalToTarget(target, { tolerance: tol.tolerance });
  if (vertical) return vertical;
  const bad = finiteError({
    'target north': target.dN, 'target east': target.dE, 'target TVD': target.dTvd,
    'kickoff length': kopLen, 'build rate': buildRate, 'drop rate': dropRate,
    'final inclination': finalIncDeg,
  });
  if (bad) return { feasible: false, error: bad };
  if (kopLen < 0) return { feasible: false, error: 'Kickoff depth cannot be negative.' };
  if (!(buildRate > 0) || !(dropRate > 0)) {
    return { feasible: false, error: 'Build and drop rates must be positive.' };
  }
  const R1 = radiusFor(buildRate, mdUnit);
  const R2 = radiusFor(dropRate, mdUnit);
  const aziDeg = normalizeAzi(Math.atan2(target.dE, target.dN) / DEG);
  const D = Math.hypot(target.dE, target.dN);
  const V = target.dTvd;
  const thetaF = finalIncDeg * DEG;
  if (!(V > kopLen)) return { feasible: false, error: 'Target TVD must be below the kickoff point.' };

  const C1 = { h: R1, v: kopLen };
  // Drop-arc center: on the opposite side of the final tangent.
  const C2 = { h: D - R2 * Math.cos(thetaF), v: V + R2 * Math.sin(thetaF) };
  const dH = C2.h - C1.h;
  const dV = C2.v - C1.v;
  const c12 = Math.hypot(dH, dV);
  const S = R1 + R2;
  if (c12 < S) {
    return { feasible: false, error: 'Build and drop circles overlap: raise the rates, deepen the target, or reduce displacement.' };
  }
  const theta = Math.atan2(dH, dV) + Math.asin(S / c12);
  if (!(theta > thetaF + 1e-9) || theta > Math.PI / 2 + 60 * DEG) {
    return { feasible: false, error: 'No S-profile solution: the hold inclination does not clear the final inclination. Adjust rates or kickoff.' };
  }
  const holdLen = Math.sqrt(Math.max(0, c12 * c12 - S * S));
  const thetaDeg = theta / DEG;
  const segments = [];
  if (kopLen > 1e-9) segments.push({ kind: 'hold', length: kopLen });
  segments.push({ kind: 'build', rate: buildRate, length: R1 * theta });
  if (holdLen > 1e-9) segments.push({ kind: 'hold', length: holdLen });
  segments.push({ kind: 'build', rate: -dropRate, length: R2 * (theta - thetaF) });
  const runaway = lengthGuard(segments, Math.hypot(D, V));
  if (runaway) return { feasible: false, error: runaway };
  return {
    feasible: true,
    segments,
    report: {
      aziDeg, holdIncDeg: thetaDeg, finalIncDeg,
      buildLen: R1 * theta, holdLen, dropLen: R2 * (theta - thetaF),
      doglegDeg: thetaDeg + (thetaDeg - finalIncDeg),
      endMdDelta: kopLen + R1 * theta + holdLen + R2 * (theta - thetaF),
    },
  };
}

// ---- (iii) continuous build: single 3D arc through a point ----------------

/**
 * The cleanest primitive, fully 3D: one minimum-curvature arc from an
 * arbitrary tie-on attitude through a 3D displacement {dN, dE, dTvd}.
 *   beta = 2*delta,  R = Lc / (2 sin delta),  t2 = 2 cos(delta) c - t1
 * Emits a single toolfaceArc segment (exact under the compiler).
 */
export function solveContinuousBuild({
  tieOn = {}, delta, mdUnit = 'm', maxDls = null, verticalTolerance,
}) {
  if (!delta) return { feasible: false, error: 'No target displacement was supplied.' };
  const frameBad = targetFrameError(delta, mdUnit);
  if (frameBad) return { feasible: false, error: frameBad };
  const bad = finiteError({
    'target north': delta.dN, 'target east': delta.dE, 'target TVD': delta.dTvd,
    'tie-on inclination': tieOn.inc || 0, 'tie-on azimuth': tieOn.azi || 0,
  });
  if (bad) return { feasible: false, error: bad };
  const tol = verticalToleranceFor(verticalTolerance, mdUnit);
  if (tol.error) return { feasible: false, error: tol.error };
  const vertical = verticalToTarget(delta, { tieOnInc: tieOn.inc, tolerance: tol.tolerance });
  if (vertical) return vertical;
  const t1 = tangent(tieOn.inc || 0, tieOn.azi || 0);
  const dvec = { e: delta.dE, n: delta.dN, v: delta.dTvd };
  const Lc = norm(dvec);
  if (Lc < 1e-9) return { feasible: false, error: 'Target coincides with the tie-on.' };
  const c = scale(dvec, 1 / Lc);
  const cosd = Math.max(-1, Math.min(1, dot(t1, c)));
  const deltaAngle = Math.acos(cosd);
  if (deltaAngle < 1e-9) {
    return {
      feasible: true,
      segments: [{ kind: 'hold', length: Lc }],
      report: { straight: true, endMdDelta: Lc, dls: 0, doglegDeg: 0 },
    };
  }
  if (deltaAngle >= Math.PI / 2 - 1e-9) {
    return { feasible: false, error: 'Target lies behind the tie-on direction; no single arc reaches it.' };
  }
  const R = Lc / (2 * Math.sin(deltaAngle));
  const beta = 2 * deltaAngle;
  const arcLen = R * beta;
  const interval = intervalFor(mdUnit);
  const dls = ((beta / DEG) * interval) / arcLen;
  if (maxDls != null && dls > maxDls + 1e-9) {
    return { feasible: false, error: `Required dogleg ${dls.toFixed(2)} exceeds the maximum ${maxDls} deg per ${interval} ${mdUnit}.` };
  }
  const d = scale(sub(c, scale(t1, cosd)), 1 / Math.sin(deltaAngle));
  const { h, r } = toolfaceFrame(t1);
  const toolfaceDeg = normalizeAzi(Math.atan2(dot(d, r), dot(d, h)) / DEG);
  const t2 = sub(scale(c, 2 * cosd), t1);
  const endAtt = attitudeFromTangent(t2, tieOn.azi || 0);
  return {
    feasible: true,
    segments: [{ kind: 'toolfaceArc', dls, toolfaceDeg, length: arcLen }],
    report: {
      dls, toolfaceDeg, arcLen, endInc: endAtt.inc, endAzi: endAtt.azi, endMdDelta: arcLen, radius: R,
      doglegDeg: beta / DEG,
    },
  };
}

// ---- (iv) horizontal landing: curve - hold - curve (SPE 84246) ------------

/**
 * Compass azimuth (deg clockwise from grid north) of the horizontal
 * vector from `heel` to `toe`, both given as {dE, dN} displacements in
 * the same frame. Returns null when the two points are vertically
 * stacked, where a bearing is undefined.
 */
export function bearingBetween(heel, toe, { minSeparation = 1e-6 } = {}) {
  if (!heel || !toe) return null;
  const dE = toe.dE - heel.dE;
  const dN = toe.dN - heel.dN;
  if (!Number.isFinite(dE) || !Number.isFinite(dN)) return null;
  if (Math.hypot(dE, dN) < minSeparation) return null;
  return normalizeAzi(Math.atan2(dE, dN) / DEG);
}

/**
 * Landing attitude implied by a heel/toe target pair, the way Compass
 * derives a landing from "Final Target" plus "Align on Target": the
 * azimuth is the heel-to-toe bearing and the inclination is that
 * vector's angle from vertical (90 deg for a truly horizontal lateral,
 * more when the toe is shallower, less when it is deeper).
 */
export function landingFromTargets(heel, toe, { minSeparation = 1e-6 } = {}) {
  const aziDeg = bearingBetween(heel, toe, { minSeparation });
  if (aziDeg == null) {
    return {
      ok: false,
      error: 'The heel and toe targets sit on the same vertical line, so they do not define a landing azimuth. Pick a different alignment target or set the azimuth by hand.',
    };
  }
  const horizontal = Math.hypot(toe.dE - heel.dE, toe.dN - heel.dN);
  const rise = (toe.dTvd ?? 0) - (heel.dTvd ?? 0);
  return {
    ok: true,
    aziDeg,
    horizontal,
    tvdRise: rise,
    incDeg: normalizeAzi(Math.atan2(horizontal, rise) / DEG),
  };
}

/**
 * From an arbitrary tie-on attitude to a landing point {dN, dE, dTvd}
 * with a specified landing attitude (default horizontal at landingAzi).
 * Sawaryn & Thorogood vector iteration on the hold direction u; each
 * arc endpoint is closed-form via the minimum-curvature kite identity
 *   chord = R tan(beta/2) (t_start + t_end).
 *
 * The landing azimuth is resolved in this order:
 *   1. `landing.aziDeg`, when finite — an explicit manual override;
 *   2. the heel-to-toe bearing, when `landing.alignOn` is supplied
 *      (Compass's "Final Target" + "Align on Target");
 *   3. the bearing from the tie-on to the landing point.
 * `report.landAziSource` says which one was used.
 *
 * The landing inclination resolves the same way:
 *   1. `landing.incDeg`, when finite — the way a lateral planned to
 *      nose up or down (89 or 91 degrees, say) is specified;
 *   2. the heel-to-toe angle from vertical, when `alignOn` is supplied,
 *      so the lateral runs straight from the heel to the toe;
 *   3. horizontal, 90 degrees.
 * `report.landIncSource` says which one was used.
 *
 * The iteration is capped at `maxIter` (clamped to 1..1000) and the
 * emitted geometry is length-checked, so a degenerate request returns
 * { feasible: false, error } rather than a runaway hold.
 */
export function solveHorizontalLanding({
  tieOn = {}, landing, rate1, rate2, mdUnit = 'm', maxIter = 100, verticalTolerance,
}) {
  if (!landing) return { feasible: false, error: 'No landing point was supplied.' };
  const frameBad = targetFrameError(landing, mdUnit, 'Landing')
    || (landing.alignOn ? targetFrameError(landing.alignOn, mdUnit, 'Alignment target') : null);
  if (frameBad) return { feasible: false, error: frameBad };
  const bad = finiteError({
    'landing north': landing.dN, 'landing east': landing.dE, 'landing TVD': landing.dTvd,
    'curve 1 rate': rate1, 'curve 2 rate': rate2,
    'tie-on inclination': tieOn.inc || 0, 'tie-on azimuth': tieOn.azi || 0,
  });
  if (bad) return { feasible: false, error: bad };
  // A landing point straight below a vertical tie-on, with nothing to set
  // a landing direction (no toe, no azimuth), is a vertical well to that
  // point. With a toe or an azimuth the designer has asked for a real
  // landing and gets the curve-hold-curve.
  if (!landing.alignOn && !Number.isFinite(landing.aziDeg)) {
    const tol = verticalToleranceFor(verticalTolerance, mdUnit);
    if (tol.error) return { feasible: false, error: tol.error };
    const vertical = verticalToTarget(landing, { tieOnInc: tieOn.inc, tolerance: tol.tolerance });
    if (vertical) return vertical;
  }
  if (!(rate1 > 0) || !(rate2 > 0)) {
    return { feasible: false, error: 'Both curve rates must be positive.' };
  }

  // Heel-to-toe alignment, resolved once: it can set both the landing
  // azimuth and the landing inclination.
  let alignment = null;
  let alignError = null;
  if (landing.alignOn) {
    const alignBad = finiteError({
      'alignment target north': landing.alignOn.dN,
      'alignment target east': landing.alignOn.dE,
      'alignment target TVD': landing.alignOn.dTvd,
    });
    if (alignBad) return { feasible: false, error: alignBad };
    const a = landingFromTargets(landing, landing.alignOn);
    if (a.ok) alignment = a; else alignError = a.error;
  }

  // Landing azimuth: manual override, else heel-to-toe alignment, else
  // the bearing from the tie-on to the landing point.
  let landAzi;
  let landAziSource;
  if (Number.isFinite(landing.aziDeg)) {
    landAzi = normalizeAzi(landing.aziDeg);
    landAziSource = 'override';
  } else if (alignment) {
    landAzi = alignment.aziDeg;
    landAziSource = 'alignOn';
  } else if (alignError) {
    return { feasible: false, error: alignError };
  } else {
    const reachAzi = bearingBetween({ dE: 0, dN: 0 }, landing);
    if (reachAzi == null) {
      return {
        feasible: false,
        error: 'The landing point is directly below the tie-on, so it does not define a landing azimuth. Add an alignment target or set the azimuth by hand.',
      };
    }
    landAzi = reachAzi;
    landAziSource = 'tieOnToLanding';
  }

  const iterCap = Number.isFinite(maxIter) ? Math.min(1000, Math.max(1, Math.floor(maxIter))) : 100;
  const r1 = radiusFor(rate1, mdUnit);
  const r2 = radiusFor(rate2, mdUnit);
  const interval = intervalFor(mdUnit);
  const t1 = tangent(tieOn.inc || 0, tieOn.azi || 0);
  // Landing inclination: manual override, else the heel-to-toe angle
  // from vertical, else horizontal. A lateral planned to nose up or
  // down (89 or 91 degrees, say) is an override; a lateral that has to
  // run straight from the heel to a toe at a different TVD gets the
  // inclination that vector implies.
  let landInc;
  let landIncSource;
  if (Number.isFinite(landing.incDeg)) {
    landInc = landing.incDeg;
    landIncSource = 'override';
  } else if (alignment) {
    landInc = alignment.incDeg;
    landIncSource = 'alignOn';
  } else {
    landInc = 90;
    landIncSource = 'default';
  }
  if (landInc < 0 || landInc > 180) {
    return { feasible: false, error: 'Landing inclination must be between 0 and 180 degrees.' };
  }
  const t4 = tangent(landInc, landAzi);
  const P1 = { e: 0, n: 0, v: 0 };
  const P4 = { e: landing.dE, n: landing.dN, v: landing.dTvd };
  const reach = norm(sub(P4, P1));
  if (reach < 1e-9) return { feasible: false, error: 'Landing point coincides with the tie-on.' };

  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  let u = unit(sub(P4, P1));
  let P2 = P1;
  let P3 = P4;
  let converged = false;
  let iterations = 0;
  let lastGap = Infinity;
  for (let k = 0; k < iterCap; k++) {
    iterations = k + 1;
    const b1 = angle(t1, u);
    const b2 = angle(u, t4);
    if (!Number.isFinite(b1) || !Number.isFinite(b2)) {
      return { feasible: false, error: 'Degenerate geometry: the curve angles are undefined. Adjust the rates, the landing attitude or the target.' };
    }
    if (b1 > Math.PI - 1e-6 || b2 > Math.PI - 1e-6) {
      return { feasible: false, error: 'Degenerate geometry: a curve section would reverse direction. Adjust rates or the landing attitude.' };
    }
    P2 = b1 < 1e-12 ? P1 : add(P1, scale(add(t1, u), r1 * Math.tan(b1 / 2)));
    P3 = b2 < 1e-12 ? P4 : sub(P4, scale(add(u, t4), r2 * Math.tan(b2 / 2)));
    const gap = sub(P3, P2);
    const gapLen = norm(gap);
    if (!Number.isFinite(gapLen)) {
      return { feasible: false, error: 'Degenerate geometry: the hold section is unbounded. Raise the curve rates or move the landing.' };
    }
    lastGap = gapLen;
    if (gapLen < 1e-9) { converged = true; break; }
    const uNew = scale(gap, 1 / gapLen);
    const diff = norm(sub(uNew, u));
    u = uNew;
    if (diff < 1e-13) { converged = true; break; }
  }
  if (!converged) {
    return {
      feasible: false,
      error: `Curve-hold-curve iteration did not settle in ${iterCap} passes (hold still moving by ${Number.isFinite(lastGap) ? lastGap.toFixed(1) : 'an unbounded amount'}). This geometry has no curve-hold-curve landing: raise the curve rates, move the landing point, or use the single-arc "curve to target" method.`,
      iterations,
    };
  }
  const hold = sub(P3, P2);
  const holdLen = norm(hold);
  if (holdLen > 1e-9 && dot(hold, u) < 0) {
    return { feasible: false, error: 'No valid hold section exists between the two curves (they overlap). Increase the rates or move the landing.' };
  }
  const b1 = angle(t1, u);
  const b2 = angle(u, t4);
  const segments = [];
  const report = { holdLen, endMdDelta: 0, iterations };
  if (b1 > 1e-9) {
    const d1 = scale(sub(u, scale(t1, Math.cos(b1))), 1 / Math.sin(b1));
    const { h, r } = toolfaceFrame(t1);
    const dls1 = ((b1 / DEG) * interval) / (r1 * b1);
    segments.push({
      kind: 'toolfaceArc', dls: dls1,
      toolfaceDeg: normalizeAzi(Math.atan2(dot(d1, r), dot(d1, h)) / DEG),
      length: r1 * b1,
    });
    report.arc1Len = r1 * b1;
    report.arc1DoglegDeg = b1 / DEG;
  }
  if (holdLen > 1e-9) segments.push({ kind: 'hold', length: holdLen });
  if (b2 > 1e-9) {
    const d2 = scale(sub(t4, scale(u, Math.cos(b2))), 1 / Math.sin(b2));
    const { h, r } = toolfaceFrame(u);
    const dls2 = ((b2 / DEG) * interval) / (r2 * b2);
    segments.push({
      kind: 'toolfaceArc', dls: dls2,
      toolfaceDeg: normalizeAzi(Math.atan2(dot(d2, r), dot(d2, h)) / DEG),
      length: r2 * b2,
    });
    report.arc2Len = r2 * b2;
    report.arc2DoglegDeg = b2 / DEG;
  }
  const runaway = lengthGuard(segments, reach);
  if (runaway) return { feasible: false, error: runaway };
  const holdAtt = attitudeFromTangent(u, tieOn.azi || 0);
  report.holdInc = holdAtt.inc;
  report.holdAzi = holdAtt.azi;
  report.landInc = landInc;
  report.landIncSource = landIncSource;
  report.landAzi = landAzi;
  report.landAziSource = landAziSource;
  if (alignment && alignment.ok) {
    report.alignment = {
      aziDeg: alignment.aziDeg,
      horizontal: alignment.horizontal,
      tvdRise: alignment.tvdRise,
      incDeg: alignment.incDeg,
    };
  }
  report.endMdDelta = (report.arc1Len || 0) + holdLen + (report.arc2Len || 0);
  report.doglegDeg = (report.arc1DoglegDeg || 0) + (report.arc2DoglegDeg || 0);
  return { feasible: true, segments, report };
}

// ---- (vi) point: land exactly on a point from the design end -------------

/**
 * Curve at `dls` from the tie-on attitude, then hold a straight tangent
 * to the point (the 3D circle-tangent construction in the plane spanned
 * by the tie-on direction and the point). In that plane, with a along
 * the tie-on direction and b toward the point, the arc centre is (0, R)
 * and the arc of angle theta is followed by a hold of length h when
 *   p - C = R (sin theta, -cos theta) + h (cos theta, sin theta),
 * so theta = phi + asin(R / c), h = sqrt(c^2 - R^2), with
 * (c, phi) the polar form of p - C. The point is reachable exactly when
 * it lies outside the circle, c >= R.
 */
function curveHoldToPoint({ t1, d, R, dls }) {
  const L = norm(d);
  if (L < 1e-9) return { feasible: false, error: 'The point coincides with the current end of the design.' };
  const a = dot(d, t1);
  const perp = sub(d, scale(t1, a));
  const pb = norm(perp);
  if (pb < 1e-9 * Math.max(1, L)) {
    if (a > 0) {
      return { feasible: true, segments: [{ kind: 'hold', length: L }], geometry: 'hold', doglegDeg: 0, arcLen: 0, holdLen: L };
    }
    return { feasible: false, error: 'The point is straight behind the hole direction, so no curve and hold reaches it.' };
  }
  const n = scale(perp, 1 / pb);
  const vH = a;
  const vV = pb - R;
  const c = Math.hypot(vH, vV);
  if (c < R) {
    // Radius of the one arc that passes through the point: the loosest
    // curve that still reaches it.
    const rPoint = (a * a + pb * pb) / (2 * pb);
    return {
      feasible: false,
      unreachable: { insideBy: R - c, rPoint },
    };
  }
  let theta = Math.atan2(vV, vH) + Math.asin(R / c);
  theta = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (theta > Math.PI - 1e-9) {
    return { feasible: false, error: 'Reaching the point would need the hole to turn through more than 180 degrees.' };
  }
  const holdLen = Math.sqrt(Math.max(0, c * c - R * R));
  const { h, r } = toolfaceFrame(t1);
  const toolfaceDeg = normalizeAzi(Math.atan2(dot(n, r), dot(n, h)) / DEG);
  const segments = [];
  if (theta > 1e-12) segments.push({ kind: 'toolfaceArc', dls, toolfaceDeg, length: R * theta });
  if (holdLen > 1e-9) segments.push({ kind: 'hold', length: holdLen });
  return {
    feasible: true, segments, geometry: 'curve-hold',
    doglegDeg: theta / DEG, arcLen: R * theta, holdLen, toolfaceDeg,
  };
}

/**
 * Point method (like Compass's Point): from the current end of the
 * design, land exactly on a point. The point is a displacement from the
 * design end {dN, dE, dTvd} ("Using TVD"), or {dN, dE, md} where md is
 * the course length to the point ("Using MD"; the TVD is solved).
 *
 * The geometry follows from where the point is:
 *   - directly below a vertical end (within the vertical tolerance):
 *     one vertical hold, no DLS needed;
 *   - a vertical end and an offset point: curve at `dls`, then hold a
 *     tangent to the point;
 *   - a deviated end and a point directly below it: drop back to
 *     vertical at `dls` and arrive at the point vertically (a
 *     curve-hold-curve with a vertical landing attitude; when the point
 *     is on the vertical line where a straight drop ends this is exactly
 *     a drop then a vertical hold);
 *   - otherwise: curve at `dls`, then hold a tangent to the point.
 * `arrive` overrides the choice: 'vertical' always arrives vertically
 * (the way a nudged or S-shaped well is dropped back to a point),
 * 'tangent' always curves and holds a tangent, 'auto' (default) picks as
 * above. A point the geometry cannot reach at `dls` is refused, with how
 * far off it is and the smallest DLS that would reach it.
 */
export function solvePoint({
  tieOn = {}, point, dls, mdUnit = 'm', mode = 'tvd', arrive = 'auto', verticalTolerance,
}) {
  if (!point) return { feasible: false, error: 'No point was supplied.' };
  const frameBad = targetFrameError(
    { ...point, dTvd: mode === 'md' ? point.md : point.dTvd }, mdUnit, 'Point',
  );
  if (frameBad) return { feasible: false, error: frameBad };
  if (mode !== 'tvd' && mode !== 'md') return { feasible: false, error: `Unknown point mode ${mode}; use tvd or md.` };
  if (!['auto', 'vertical', 'tangent'].includes(arrive)) {
    return { feasible: false, error: `Unknown arrival ${arrive}; use auto, vertical or tangent.` };
  }
  const bad = finiteError({
    'point north': point.dN, 'point east': point.dE,
    [mode === 'md' ? 'point MD' : 'point TVD']: mode === 'md' ? point.md : point.dTvd,
    'tie-on inclination': tieOn.inc || 0, 'tie-on azimuth': tieOn.azi || 0,
  });
  if (bad) return { feasible: false, error: bad };
  const tol = verticalToleranceFor(verticalTolerance, mdUnit);
  if (tol.error) return { feasible: false, error: tol.error };
  if (mode === 'md') return solvePointByMd({ tieOn, point, dls, mdUnit, arrive, tolerance: tol.tolerance });
  return solvePointByTvd({ tieOn, point, dls, mdUnit, arrive, tolerance: tol.tolerance });
}

function solvePointByTvd({ tieOn, point, dls, mdUnit, arrive, tolerance, quiet = false }) {
  const inc0 = tieOn.inc || 0;
  const azi0 = tieOn.azi || 0;
  const H = Math.hypot(point.dE, point.dN);
  const verticalEnd = Math.abs(inc0) <= VERTICAL_INC_EPS_DEG;
  const interval = intervalFor(mdUnit);
  const withMeta = (sol, geometry, extra = {}) => ({
    ...sol,
    report: {
      ...sol.report, geometry, mode: 'tvd', dls: sol.report.dls ?? dls ?? 0,
      horizontalFromEnd: H, tolerance, ...extra,
    },
  });

  // Straight down from a vertical end: no DLS needed, whatever `arrive`
  // says (a vertical hold is both a tangent and a vertical arrival).
  const vertical = verticalToTarget(point, { tieOnInc: inc0, tolerance });
  if (vertical) {
    if (!vertical.feasible) return vertical;
    return withMeta(vertical, 'vertical', { dls: 0, endInc: 0, endAzi: 0 });
  }
  if (!Number.isFinite(dls)) return { feasible: false, error: finiteError({ DLS: dls }) };
  if (!(dls > 0)) return { feasible: false, error: `Enter a DLS above zero in deg per ${interval} ${mdUnit}.` };
  const R = radiusFor(dls, mdUnit);
  const reach = Math.hypot(point.dE, point.dN, point.dTvd);

  const wantVertical = arrive === 'vertical' || (arrive === 'auto' && !verticalEnd && H <= tolerance);
  if (wantVertical) {
    if (!(point.dTvd > 0)) {
      return { feasible: false, error: 'To arrive vertically the point must be below the current end of the design.' };
    }
    const sol = solveHorizontalLanding({
      tieOn: { inc: inc0, azi: azi0 },
      landing: { dN: point.dN, dE: point.dE, dTvd: point.dTvd, incDeg: 0, aziDeg: azi0 },
      rate1: dls, rate2: dls, mdUnit,
    });
    if (!sol.feasible) {
      if (quiet) return { feasible: false, error: sol.error };
      return refuseWithMinimum({
        what: 'arrive vertically at the point',
        dls, mdUnit,
        test: (rate) => solveHorizontalLanding({
          tieOn: { inc: inc0, azi: azi0 },
          landing: { dN: point.dN, dE: point.dE, dTvd: point.dTvd, incDeg: 0, aziDeg: azi0 },
          rate1: rate, rate2: rate, mdUnit,
        }).feasible,
        deeper: (dTvd) => solveHorizontalLanding({
          tieOn: { inc: inc0, azi: azi0 },
          landing: { dN: point.dN, dE: point.dE, dTvd, incDeg: 0, aziDeg: azi0 },
          rate1: dls, rate2: dls, mdUnit,
        }).feasible,
        dTvd: point.dTvd,
      });
    }
    const geometry = (sol.report.arc2Len || 0) < 1e-6 && (sol.report.holdInc ?? 0) < 1e-6
      ? 'drop to vertical'
      : 'curve-hold-curve to vertical';
    return withMeta(
      {
        ...sol,
        report: {
          ...sol.report, dls, endInc: 0, endAzi: azi0,
          doglegDeg: sol.report.doglegDeg,
        },
      },
      geometry,
    );
  }

  const t1 = tangent(inc0, azi0);
  const d = { e: point.dE, n: point.dN, v: point.dTvd };
  const ch = curveHoldToPoint({ t1, d, R, dls });
  if (!ch.feasible) {
    if (ch.unreachable) {
      const need = (interval / ch.unreachable.rPoint) / DEG;
      return {
        feasible: false,
        shortBy: ch.unreachable.insideBy,
        minDls: need,
        error: `The point cannot be reached at ${fmtRate(dls)} deg/${interval}${mdUnit}: it is ${ch.unreachable.insideBy.toFixed(2)} ${mdUnit} inside the turning circle. Reaching it needs at least ${fmtRate(need)} deg/${interval}${mdUnit}, or move the point.`,
      };
    }
    return ch;
  }
  const runaway = lengthGuard(ch.segments, reach);
  if (runaway) return { feasible: false, error: runaway };
  // End attitude: the tie-on direction turned through theta toward the
  // point (the hold direction), or the tie-on direction for a straight
  // hold.
  let endVec = t1;
  if (ch.geometry === 'curve-hold') {
    const theta = ch.doglegDeg * DEG;
    const perp = sub(d, scale(t1, dot(d, t1)));
    const n = scale(perp, 1 / norm(perp));
    endVec = add(scale(t1, Math.cos(theta)), scale(n, Math.sin(theta)));
  }
  const endAtt = attitudeFromTangent(endVec, azi0);
  return withMeta(
    {
      feasible: true,
      segments: ch.segments,
      report: {
        dls: ch.geometry === 'hold' ? 0 : dls,
        toolfaceDeg: ch.toolfaceDeg ?? null,
        arcLen: ch.arcLen, holdLen: ch.holdLen,
        doglegDeg: ch.doglegDeg,
        endInc: endAtt.inc, endAzi: endAtt.azi,
        endMdDelta: ch.arcLen + ch.holdLen,
      },
    },
    ch.geometry === 'hold' ? 'hold' : 'curve-hold',
  );
}

const fmtRate = (v) => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

/**
 * Refusal for a vertical arrival that the DLS cannot make: the smallest
 * DLS that reaches the point (search over rate), and how much deeper the
 * point would have to be at the given DLS (search over TVD).
 */
function refuseWithMinimum({ what, dls, mdUnit, test, deeper, dTvd }) {
  const interval = intervalFor(mdUnit);
  const minFeasible = (lo, hi, ok, grow) => {
    let a = lo;
    let b = hi;
    let found = false;
    for (let i = 0; i < 40; i++) {
      if (ok(b)) { found = true; break; }
      a = b;
      b = grow(b);
      if (!Number.isFinite(b)) break;
    }
    if (!found) return null;
    for (let i = 0; i < 60; i++) {
      const m = (a + b) / 2;
      if (ok(m)) b = m; else a = m;
    }
    return b;
  };
  const maxRate = 90; // deg per interval: no tool builds faster
  const needRate = minFeasible(dls, Math.min(maxRate, dls * 1.25), test, (r) => (r >= maxRate ? Infinity : Math.min(maxRate, r * 1.25)));
  const maxTvd = mdUnit === 'ft' ? MAX_TARGET_REACH_M / M_PER_FT_LOCAL : MAX_TARGET_REACH_M;
  const needTvd = dTvd > 0
    ? minFeasible(dTvd, Math.min(maxTvd, dTvd * 1.25 + 1), deeper, (z) => (z >= maxTvd ? Infinity : Math.min(maxTvd, z * 1.5 + 1)))
    : null;
  const parts = [`The point cannot be reached at ${fmtRate(dls)} deg/${interval}${mdUnit} to ${what}.`];
  if (needTvd != null) parts.push(`At this DLS it would have to be ${(needTvd - dTvd).toFixed(2)} ${mdUnit} deeper.`);
  if (needRate != null) parts.push(`Reaching it where it is needs at least ${fmtRate(needRate)} deg/${interval}${mdUnit}.`);
  if (needTvd == null && needRate == null) parts.push('No DLS up to 90 deg per interval reaches it; move the point.');
  return {
    feasible: false,
    error: parts.join(' '),
    shortBy: needTvd != null ? needTvd - dTvd : null,
    minDls: needRate,
  };
}

/**
 * "Using MD": the point is N/E plus the course length to it; solve the
 * TVD at which the chosen geometry arrives after exactly that length.
 * The course length of every geometry grows with the point's depth for a
 * fixed N/E, so the TVD is bracketed by a scan and closed by bisection.
 */
function solvePointByMd({ tieOn, point, dls, mdUnit, arrive, tolerance }) {
  const md = point.md;
  if (!(md > 0)) return { feasible: false, error: 'The point MD must be beyond the current end of the design.' };
  const H = Math.hypot(point.dE, point.dN);
  if (H >= md) {
    return {
      feasible: false,
      shortBy: H - md + 1e-9,
      error: `The point is ${H.toFixed(2)} ${mdUnit} away horizontally, more than the ${md.toFixed(2)} ${mdUnit} of hole allowed to reach it.`,
    };
  }
  const at = (z) => solvePointByTvd({
    tieOn, point: { dN: point.dN, dE: point.dE, dTvd: z }, dls, mdUnit, arrive, tolerance, quiet: true,
  });
  const lengthAt = (z) => {
    const s = at(z);
    return s.feasible ? s.report.endMdDelta : null;
  };
  // TVD can be no more than the hole length; scan (0, md] for the first
  // bracket of length(z) - md.
  const N = 400;
  let prevZ = null;
  let prevF = null;
  let bestShort = Infinity;
  for (let i = 1; i <= N; i++) {
    const z = (md * i) / N;
    const len = lengthAt(z);
    if (len == null) { prevZ = null; prevF = null; continue; }
    const f = len - md;
    if (f > 0) bestShort = Math.min(bestShort, f);
    if (Math.abs(f) < 1e-9) return finishMd(at(z), z, md);
    if (prevF != null && prevF < 0 && f > 0) {
      let lo = prevZ;
      let hi = z;
      for (let k = 0; k < 80; k++) {
        const m = (lo + hi) / 2;
        const lm = lengthAt(m);
        if (lm == null) { lo = m; continue; }
        if (lm - md > 0) hi = m; else lo = m;
      }
      const zs = (lo + hi) / 2;
      const sol = at(zs);
      if (sol.feasible && Math.abs(sol.report.endMdDelta - md) < 1e-6 * Math.max(1, md)) return finishMd(sol, zs, md);
    }
    prevZ = z;
    prevF = f;
  }
  const interval = intervalFor(mdUnit);
  return {
    feasible: false,
    shortBy: Number.isFinite(bestShort) ? bestShort : null,
    error: Number.isFinite(bestShort)
      ? `At ${fmtRate(dls || 0)} deg/${interval}${mdUnit} the shortest hole to this N/E is ${(md + bestShort).toFixed(2)} ${mdUnit}, so the MD is ${bestShort.toFixed(2)} ${mdUnit} short. Raise the MD or the DLS.`
      : `No geometry at ${fmtRate(dls || 0)} deg/${interval}${mdUnit} reaches this N/E within ${md.toFixed(2)} ${mdUnit} of hole. Raise the MD or the DLS.`,
  };
}

function finishMd(sol, z, md) {
  return {
    ...sol,
    report: { ...sol.report, mode: 'md', solvedTvd: z, endMdDelta: md },
  };
}

// ---- (v) nudge: build out, hold, drop back to vertical --------------------

/** Forward nudge from a vertical tie-on. */
export function solveNudge({ nudgeIncDeg, nudgeAziDeg, holdLen = 0, buildRate, dropRate, mdUnit = 'm' }) {
  const bad = finiteError({
    'nudge inclination': nudgeIncDeg, 'nudge hold': holdLen,
    'build rate': buildRate, 'drop rate': dropRate,
  });
  if (bad) return { feasible: false, error: bad };
  if (holdLen < 0) return { feasible: false, error: 'Nudge hold length cannot be negative.' };
  if (nudgeIncDeg >= 90) return { feasible: false, error: 'Nudge inclination must be below 90 degrees; the hole has to come back to vertical.' };
  if (!(buildRate > 0) || !(dropRate > 0)) {
    return { feasible: false, error: 'Build and drop rates must be positive.' };
  }
  if (!(nudgeIncDeg > 0)) return { feasible: false, error: 'Nudge inclination must be positive.' };
  const R1 = radiusFor(buildRate, mdUnit);
  const R2 = radiusFor(dropRate, mdUnit);
  const th = nudgeIncDeg * DEG;
  const S = R1 + R2;
  const offset = S * (1 - Math.cos(th)) + holdLen * Math.sin(th);
  const vertical = S * Math.sin(th) + holdLen * Math.cos(th);
  const segments = [
    { kind: 'build', rate: buildRate, length: R1 * th },
  ];
  if (holdLen > 1e-9) segments.push({ kind: 'hold', length: holdLen });
  segments.push({ kind: 'build', rate: -dropRate, length: R2 * th });
  return {
    feasible: true,
    segments,
    report: {
      aziDeg: normalizeAzi(nudgeAziDeg || 0), nudgeIncDeg, offset, verticalLen: vertical,
      endMdDelta: R1 * th + holdLen + R2 * th,
    },
  };
}

/**
 * Inverse nudge: find the nudge inclination and hold length that put
 * the wellbore back on vertical displaced `offset` laterally after a
 * vertical budget `verticalLen`. Closed form:
 *   K cos(theta + psi) = -S,  K = hypot(offset - S, V),
 *   psi = atan2(V, offset - S), then L from back-substitution.
 */
export function solveNudgeInverse({ offset, verticalLen, buildRate, dropRate, mdUnit = 'm' }) {
  const bad = finiteError({
    'lateral offset': offset, 'vertical budget': verticalLen,
    'build rate': buildRate, 'drop rate': dropRate,
  });
  if (bad) return { feasible: false, error: bad };
  if (!(buildRate > 0) || !(dropRate > 0)) {
    return { feasible: false, error: 'Build and drop rates must be positive.' };
  }
  if (!(verticalLen > 0)) return { feasible: false, error: 'Vertical budget must be positive.' };
  if (!(offset > 0)) return { feasible: false, error: 'Offset must be positive.' };
  const R1 = radiusFor(buildRate, mdUnit);
  const R2 = radiusFor(dropRate, mdUnit);
  const S = R1 + R2;
  const K = Math.hypot(offset - S, verticalLen);
  if (K < S) {
    return { feasible: false, error: 'No nudge solution: rates are too low for this offset within the vertical budget.' };
  }
  const psi = Math.atan2(verticalLen, offset - S);
  const theta = Math.acos(-S / K) - psi;
  if (!(theta > 1e-9) || theta > Math.PI / 2) {
    return { feasible: false, error: 'No physical nudge inclination for this geometry.' };
  }
  const cosTh = Math.cos(theta);
  if (Math.abs(cosTh) < 1e-12) return { feasible: false, error: 'Nudge inclination degenerates to horizontal.' };
  const holdLen = (verticalLen - S * Math.sin(theta)) / cosTh;
  if (holdLen < -1e-9) return { feasible: false, error: 'Negative hold length: reduce the offset or extend the vertical budget.' };
  return solveNudge({
    nudgeIncDeg: theta / DEG, holdLen: Math.max(0, holdLen), buildRate, dropRate, mdUnit,
  });
}
