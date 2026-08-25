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
// Pure math, worker-safe, no I/O.

import { tangent, doglegRad } from '../seismolord/wellPath.js';
import { attitudeFromTangent, normalizeAzi } from './surveyMath.js';

const DEG = Math.PI / 180;

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
export function solveSlant({ tieOn = { inc: 0, azi: null }, target, buildRate, mdUnit = 'm' }) {
  if (!(buildRate > 0)) return { feasible: false, error: 'Build rate must be positive.' };
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
  return {
    feasible: true,
    segments,
    report: {
      aziDeg, holdIncDeg, buildLen: sol.arcLen, holdLen: sol.holdLen,
      endMdDelta: sol.arcLen + sol.holdLen, radius: R, dropping,
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
  kopLen = 0, buildRate, dropRate, finalIncDeg = 0, target, mdUnit = 'm',
}) {
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
  return {
    feasible: true,
    segments,
    report: {
      aziDeg, holdIncDeg: thetaDeg, finalIncDeg,
      buildLen: R1 * theta, holdLen, dropLen: R2 * (theta - thetaF),
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
export function solveContinuousBuild({ tieOn, delta, mdUnit = 'm', maxDls = null }) {
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
      report: { straight: true, endMdDelta: Lc, dls: 0 },
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
    report: { dls, toolfaceDeg, arcLen, endInc: endAtt.inc, endAzi: endAtt.azi, endMdDelta: arcLen, radius: R },
  };
}

// ---- (iv) horizontal landing: curve - hold - curve (SPE 84246) ------------

/**
 * From an arbitrary tie-on attitude to a landing point {dN, dE, dTvd}
 * with a specified landing attitude (default horizontal at landingAzi).
 * Sawaryn & Thorogood vector iteration on the hold direction u; each
 * arc endpoint is closed-form via the minimum-curvature kite identity
 *   chord = R tan(beta/2) (t_start + t_end).
 */
export function solveHorizontalLanding({
  tieOn, landing, rate1, rate2, mdUnit = 'm', maxIter = 100,
}) {
  if (!(rate1 > 0) || !(rate2 > 0)) {
    return { feasible: false, error: 'Both curve rates must be positive.' };
  }
  const r1 = radiusFor(rate1, mdUnit);
  const r2 = radiusFor(rate2, mdUnit);
  const interval = intervalFor(mdUnit);
  const t1 = tangent(tieOn.inc || 0, tieOn.azi || 0);
  const landInc = landing.incDeg == null ? 90 : landing.incDeg;
  const t4 = tangent(landInc, landing.aziDeg || 0);
  const P1 = { e: 0, n: 0, v: 0 };
  const P4 = { e: landing.dE, n: landing.dN, v: landing.dTvd };
  if (norm(sub(P4, P1)) < 1e-9) return { feasible: false, error: 'Landing point coincides with the tie-on.' };

  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
  let u = unit(sub(P4, P1));
  let P2 = P1;
  let P3 = P4;
  let converged = false;
  for (let k = 0; k < maxIter; k++) {
    const b1 = angle(t1, u);
    const b2 = angle(u, t4);
    if (b1 > Math.PI - 1e-6 || b2 > Math.PI - 1e-6) {
      return { feasible: false, error: 'Degenerate geometry: a curve section would reverse direction. Adjust rates or the landing attitude.' };
    }
    P2 = b1 < 1e-12 ? P1 : add(P1, scale(add(t1, u), r1 * Math.tan(b1 / 2)));
    P3 = b2 < 1e-12 ? P4 : sub(P4, scale(add(u, t4), r2 * Math.tan(b2 / 2)));
    const gap = sub(P3, P2);
    const gapLen = norm(gap);
    if (gapLen < 1e-9) { converged = true; break; }
    const uNew = scale(gap, 1 / gapLen);
    const diff = norm(sub(uNew, u));
    u = uNew;
    if (diff < 1e-13) { converged = true; break; }
  }
  if (!converged) return { feasible: false, error: 'Curve-hold-curve iteration did not converge for this geometry.' };
  const hold = sub(P3, P2);
  const holdLen = norm(hold);
  if (holdLen > 1e-9 && dot(hold, u) < 0) {
    return { feasible: false, error: 'No valid hold section exists between the two curves (they overlap). Increase the rates or move the landing.' };
  }
  const b1 = angle(t1, u);
  const b2 = angle(u, t4);
  const segments = [];
  const report = { holdLen, endMdDelta: 0 };
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
  const holdAtt = attitudeFromTangent(u, tieOn.azi || 0);
  report.holdInc = holdAtt.inc;
  report.holdAzi = holdAtt.azi;
  report.landInc = landInc;
  report.landAzi = normalizeAzi(landing.aziDeg || 0);
  report.endMdDelta = (report.arc1Len || 0) + holdLen + (report.arc2Len || 0);
  return { feasible: true, segments, report };
}

// ---- (v) nudge: build out, hold, drop back to vertical --------------------

/** Forward nudge from a vertical tie-on. */
export function solveNudge({ nudgeIncDeg, nudgeAziDeg, holdLen = 0, buildRate, dropRate, mdUnit = 'm' }) {
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
