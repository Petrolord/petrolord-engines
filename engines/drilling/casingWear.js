// Casing wear from drillstring rotation (energy-dissipation wear model,
// White & Dawson 1987 SPE 16006 lineage; crescent groove geometry).
//
// Model
//   Wear volume per casing interval:  V = WF · N · L
//     WF  wear factor (m³ per J of friction work is the physical quantity;
//         the industry convention mm³/(kN·m) is accepted at the API and is
//         numerically identical to 1e-12 m³/(N·m))
//     N   tool-joint side force against the casing over the interval (N),
//         taken from a rotating-mode soft-string T&D profile
//     L   sliding distance of the tool joint against the casing (m):
//         L = 2π·r_tj · rpm · 60 · hours  attributed to the interval by the
//         operations schedule.
//   The worn groove is a CRESCENT: the tool-joint circle (radius r) bites
//   depth d into the casing wall from the inner radius R. Groove
//   cross-section area A(d) is the part of the tool-joint disc lying outside
//   the original casing bore, computed with the exact circle-circle lens
//   formula and inverted for d by bisection (deterministic). The legacy app's
//   full-circumference smear V/(πD·L) is deliberately NOT used.
//   Remaining wall t = t0 − d; Barlow burst derate P = P0·(t/t0).
//   Collapse derate is intentionally ABSENT in v1: API 5C3 collapse is
//   regime-dependent (yield/plastic/transition/elastic) and ships with the
//   D6 casing upgrade; the summary carries a note instead of a fake number.
//
// Units: metres, N, N·m, hours for schedule durations, rpm; wearFactor in
// mm³/(kN·m). No silent conversion.
//
// Validation: closed-form round-trips in __tests__/drilling.casingwear.test.js
// and oracle goldens test-data/drilling/goldens/casingwear_cases.json.

const TWO_PI = 2 * Math.PI;

// Area of intersection of two discs with radii R and r whose centres are c
// apart (standard lens formula).
function lensArea(R, r, c) {
  if (c >= R + r) return 0;
  if (c <= Math.abs(R - r)) return Math.PI * Math.min(R, r) ** 2;
  const a1 = Math.acos((c * c + R * R - r * r) / (2 * c * R));
  const a2 = Math.acos((c * c + r * r - R * R) / (2 * c * r));
  return R * R * (a1 - Math.sin(2 * a1) / 2) + r * r * (a2 - Math.sin(2 * a2) / 2);
}

// Crescent groove area for wear depth d: tool joint radius r inside casing
// inner radius R, centre offset c = R − r + d (starts tangent at d = 0).
// A(d) = area of the tool-joint disc lying outside the bore circle.
export function grooveArea({ casingIrM, tjRadiusM, depthM }) {
  const R = casingIrM;
  const r = tjRadiusM;
  if (!(R > 0) || !(r > 0) || r >= R) throw new Error('Need 0 < tool-joint radius < casing inner radius.');
  if (!(depthM >= 0)) throw new Error('Wear depth must be >= 0.');
  const c = R - r + depthM;
  return Math.PI * r * r - lensArea(R, r, c);
}

// Invert grooveArea for depth by bisection. areaM2 per metre of groove length
// (i.e. groove cross-section area). Deterministic, 1e-12 m tolerance.
export function grooveDepthForArea({ casingIrM, tjRadiusM, areaM2 }) {
  if (!(areaM2 >= 0)) throw new Error('Groove area must be >= 0.');
  if (areaM2 === 0) return 0;
  const maxDepth = 2 * tjRadiusM; // full disc outside the bore, upper bound
  const maxArea = grooveArea({ casingIrM, tjRadiusM, depthM: maxDepth });
  if (areaM2 >= maxArea) return maxDepth;
  let lo = 0;
  let hi = maxDepth;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (grooveArea({ casingIrM, tjRadiusM, depthM: mid }) < areaM2) lo = mid; else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  return (lo + hi) / 2;
}

export function slidingDistanceM({ tjRadiusM, rpm, hours }) {
  if (!(tjRadiusM > 0) || !(rpm >= 0) || !(hours >= 0)) throw new Error('Invalid sliding-distance inputs.');
  return TWO_PI * tjRadiusM * rpm * 60 * hours;
}

// Main entry.
//   tdProfile     profile rows from computeTorqueDrag in a rotating mode:
//                 [{md, sideForceNPerM, ...}] (side force per metre of string)
//   casing        {idM, wallM, fromMd, toMd, burstRatingPa?}
//   tjRadiusM     tool-joint radius rubbing the casing (m)
//   schedule      [{rpm, hours}] rotating exposure entries, all applied to the
//                 casing interval (drilling progresses below the shoe; the
//                 casing sees every rotating hour of the schedule)
//   wearFactorMm3PerKNm   industry wear factor, mm³/(kN·m)
//   intervalM     casing discretisation step (default 30 m)
export function computeCasingWear({
  tdProfile, casing, tjRadiusM, schedule, wearFactorMm3PerKNm, intervalM = 30,
}) {
  if (!Array.isArray(tdProfile) || tdProfile.length < 2) throw new Error('Need a T&D profile.');
  if (!Array.isArray(schedule) || schedule.length === 0) throw new Error('Need at least one schedule entry.');
  if (!(wearFactorMm3PerKNm >= 0)) throw new Error('Wear factor must be >= 0.');
  const { idM, wallM, fromMd = 0, toMd, burstRatingPa = null } = casing ?? {};
  if (!(idM > 0) || !(wallM > 0) || !(toMd > fromMd)) throw new Error('Invalid casing definition.');
  const casingIrM = idM / 2;
  if (!(tjRadiusM > 0) || tjRadiusM >= casingIrM) throw new Error('Tool-joint radius must fit inside the casing.');

  // Wear factor to SI: mm³/(kN·m) = 1e-9 m³ / (1e3 N·m) = 1e-12 m³/(N·m).
  const wfSi = wearFactorMm3PerKNm * 1e-12;
  const totalSlideM = schedule.reduce(
    (acc, s) => acc + slidingDistanceM({ tjRadiusM, rpm: s.rpm, hours: s.hours }), 0,
  );

  const sideAt = (md) => {
    // Piecewise-linear interpolation of side force per length over the profile.
    const p = tdProfile;
    if (md <= p[0].md) return p[0].sideForceNPerM;
    for (let i = 1; i < p.length; i += 1) {
      if (md <= p[i].md) {
        const f = (md - p[i - 1].md) / (p[i].md - p[i - 1].md);
        return p[i - 1].sideForceNPerM + f * (p[i].sideForceNPerM - p[i - 1].sideForceNPerM);
      }
    }
    return p[p.length - 1].sideForceNPerM;
  };

  const rows = [];
  let maxDepthM = 0;
  let minRemainingWallM = wallM;
  for (let top = fromMd; top < toMd - 1e-9; top += intervalM) {
    const bottom = Math.min(top + intervalM, toMd);
    const midMd = (top + bottom) / 2;
    const lenM = bottom - top;
    // Tool-joint side force carried over this interval (N): per-length side
    // force × interval length.
    const sideForceN = sideAt(midMd) * lenM;
    const wearVolumeM3 = wfSi * sideForceN * totalSlideM;
    const areaM2 = wearVolumeM3 / lenM;
    const depthM = grooveDepthForArea({ casingIrM, tjRadiusM, areaM2 });
    const remainingWallM = Math.max(0, wallM - depthM);
    rows.push({
      fromMd: top,
      toMd: bottom,
      sideForceN,
      wearVolumeM3,
      wearDepthM: depthM,
      remainingWallM,
      wallLossPct: (depthM / wallM) * 100,
      burstDeratedPa: burstRatingPa != null ? burstRatingPa * (remainingWallM / wallM) : null,
    });
    if (depthM > maxDepthM) maxDepthM = depthM;
    if (remainingWallM < minRemainingWallM) minRemainingWallM = remainingWallM;
  }

  const worst = rows.reduce((a, b) => (b.wearDepthM > a.wearDepthM ? b : a), rows[0]);
  return {
    engine: 'casingWear-1.0.0',
    totalSlidingDistanceM: totalSlideM,
    rows,
    summary: {
      maxWearDepthM: maxDepthM,
      minRemainingWallM,
      maxWallLossPct: (maxDepthM / wallM) * 100,
      worstFromMd: worst.fromMd,
      worstToMd: worst.toMd,
      burstDeratedMinPa: burstRatingPa != null ? burstRatingPa * (minRemainingWallM / wallM) : null,
      collapseNote: 'Collapse derating requires API 5C3 regime logic and ships with the D6 casing upgrade.',
    },
  };
}
