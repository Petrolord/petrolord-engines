// ISCWSA anti-collision engine (Well Design Studio WD4): the
// Well-Collision-Avoidance Separation Rule of SPE-187073 (Sawaryn et
// al. 2019) with the pedal-curve (directional-projection) uncertainty
// radius, as standardised by ISCWSA and implemented by welleng 0.29.0
// (Apache-2.0, jonnymaserati/welleng). For every station on the
// reference well: find the closest point on the offset well (coarse
// nearest station, then the exact closed-form closest point on the two
// adjacent minimum-curvature arcs), combine both wells' projected
// positional uncertainties along the centre-to-centre direction, and
// report the separation factor
//
//   SF = (C-C distance − Rref − Roff − Sm) / (k · sqrt(σs² + σpa²))
//
// plus the ladder / traveling-cylinder chart series. Gated against the
// official ISCWSA clearance example wells (11 offset scenarios incl. a
// KOP-sliced sidetrack reference) in
// test-data/drilling/goldens/iscwsa_clearance_wells.json.
//
// Frames: positions are [N, E, TVD(+down)] in a shared local frame;
// azimuths are grid/frame-north referenced degrees. Covariances are
// NEV. Depths in metres. Pure math, worker-safe, no I/O.

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// vector helpers on [N, E, V] triples
// ---------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

function tangentNEV(incRad, aziRad) {
  return [
    Math.sin(incRad) * Math.cos(aziRad),
    Math.sin(incRad) * Math.sin(aziRad),
    Math.cos(incRad),
  ];
}

/** u' C u for a 3x3 covariance. */
function quadForm(u, c) {
  return (
    u[0] * (c[0][0] * u[0] + c[0][1] * u[1] + c[0][2] * u[2])
    + u[1] * (c[1][0] * u[0] + c[1][1] * u[1] + c[1][2] * u[2])
    + u[2] * (c[2][0] * u[0] + c[2][1] * u[1] + c[2][2] * u[2])
  );
}

function lerpCov(a, b, f) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r][c] = a[r][c] + f * (b[r][c] - a[r][c]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// well preparation
// ---------------------------------------------------------------------------

/**
 * Normalize one well's inputs. stations: [{md, inc, azi}] (degrees,
 * frame-north azimuths). positions: [{n, e, tvd}] per station (same
 * local frame for both wells). cov: [n][3][3] NEV covariance per
 * station. radius: borehole radius in metres (scalar).
 */
function prepWell({ stations, positions, cov, radius }) {
  const n = stations.length;
  const md = stations.map((s) => s.md);
  const inc = stations.map((s) => s.inc * DEG);
  const azi = stations.map((s) => s.azi * DEG);
  const pos = positions.map((p) => [p.n, p.e, p.tvd]);
  const tan = inc.map((I, i) => tangentNEV(I, azi[i]));
  const dogleg = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    dogleg[i] = Math.acos(Math.min(1, Math.max(-1, dot(tan[i - 1], tan[i]))));
  }
  return { n, md, inc, azi, pos, tan, dogleg, cov, radius };
}

/**
 * Closed-form closest MD-offset x in [0, dmd] on a minimum-curvature
 * arc (start P0, unit tangents t0 -> t1, subtended angle dogleg) to an
 * external point Q. Straight legs reduce to projection onto t0.
 */
export function closestXOnArc(P0, t0, t1, dmd, dogleg, Q, eps = 1e-9) {
  if (dogleg < eps) {
    return Math.min(dmd, Math.max(0, dot(sub(Q, P0), t0)));
  }
  const R = dmd / dogleg;
  const a = t0;
  let b = sub(t1, scale(t0, dot(t1, t0)));
  const nb = norm(b);
  if (nb < eps) return Math.min(dmd, Math.max(0, dot(sub(Q, P0), t0)));
  b = scale(b, 1 / nb);
  const qc = sub(Q, add(P0, scale(b, R)));
  const qa = dot(qc, a);
  const qb = dot(qc, b);
  const thetaStar = Math.atan2(qa, -qb);
  let theta;
  if (thetaStar >= 0 && thetaStar <= dogleg) {
    theta = thetaStar;
  } else {
    const f0 = -qb;
    const fd = qa * Math.sin(dogleg) - qb * Math.cos(dogleg);
    theta = f0 >= fd ? 0 : dogleg;
  }
  return theta * R;
}

/**
 * Position at distance x along leg i of a prepared well: tangent slerp
 * on the arc to the interior attitude, then the exact min-curvature
 * step from the leg-start attitude.
 */
function posAtLeg(well, i, x) {
  const dmd = well.md[i + 1] - well.md[i];
  const dl = well.dogleg[i + 1];
  let t2;
  if (dl < 1e-12 || dmd <= 0) {
    t2 = well.tan[i];
  } else {
    const th = (x / dmd) * dl;
    const sd = Math.sin(dl);
    const t = add(
      scale(well.tan[i], Math.sin(dl - th) / sd),
      scale(well.tan[i + 1], Math.sin(th) / sd),
    );
    t2 = scale(t, 1 / norm(t));
  }
  const t1 = well.tan[i];
  const stepDl = Math.acos(Math.min(1, Math.max(-1, dot(t1, t2))));
  const rf = stepDl < 1e-7 ? 1 : (2 / stepDl) * Math.tan(stepDl / 2);
  return add(well.pos[i], scale(add(t1, t2), 0.5 * x * rf));
}

// ---------------------------------------------------------------------------
// KOP (sidetrack) reference slicing
// ---------------------------------------------------------------------------

/**
 * Reference covariance below a kick-off point, zeroed at the KOP per
 * the ISCWSA sidetrack convention (SPE-187073 para. 81): systematic
 * sources restart their correlated running sum at the KOP
 * (σ - σ_kop), random sources shed the covariance already accrued
 * (cov - cov_kop); depth-scale sources (D-only e_DIA) keep their full
 * MD-proportional sigma but are zeroed exactly at the KOP station.
 * `sources` is computeErrorModel(...).sources for the full reference.
 */
export function covBelowKop(sources, kopIndex) {
  if (!sources || sources.length === 0) {
    throw new Error('kopDepth slicing needs the reference well error-model sources.');
  }
  const nBelow = sources[0].covNEV.length - kopIndex;
  const out = Array.from({ length: nBelow }, () => [[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  for (const src of sources) {
    if (src.propagation === 'random') {
      const base = src.covNEV[kopIndex];
      for (let i = 0; i < nBelow; i++) {
        const cov = src.covNEV[kopIndex + i];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) {
            out[i][r][c] += src.depthOnly
              ? (i === 0 ? 0 : cov[r][c])
              : cov[r][c] - base[r][c];
          }
        }
      }
    } else {
      const base = src.sigmaENEV[kopIndex];
      for (let i = 0; i < nBelow; i++) {
        const s = src.sigmaENEV[kopIndex + i];
        const sig = src.depthOnly
          ? (i === 0 ? [0, 0, 0] : s)
          : [s[0] - base[0], s[1] - base[1], s[2] - base[2]];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) out[i][r][c] += sig[r] * sig[c];
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the separation-rule scan
// ---------------------------------------------------------------------------

/**
 * ISCWSA separation-factor scan of a reference well against one offset
 * well.
 *
 * reference / offset: {stations, positions, cov, radius, sources?}
 * (see prepWell; `sources` only needed on the reference when kopDepth
 * is used). options: {k, sigmaPa, Sm, kopDepth}.
 *
 * Returns per-reference-station arrays (post-KOP stations when sliced):
 * {md, sf, distanceCC, refPcr, offPcr, sigmaS, eouBoundary,
 *  wellboreSeparation, eouSeparation, masd, calcHole, hozBearingDeg,
 *  toolfaceBearingDeg, travCylAziDeg, closestPointOffset:[{n,e,tvd,md}]}
 * plus {kopIndex, summary:{minSf, minSfMd, minSfIndex, minDistanceCC}}.
 */
export function computeClearance(reference, offset, {
  k = 3.5, sigmaPa = 0.5, Sm = 0.3, kopDepth = null,
} = {}) {
  let ref = prepWell(reference);
  let kopIndex = 0;
  if (kopDepth != null && Number.isFinite(kopDepth)) {
    kopIndex = ref.md.findIndex((m) => m >= kopDepth);
    if (kopIndex < 0) kopIndex = ref.n;
  }
  if (kopIndex > 0) {
    const covSliced = covBelowKop(reference.sources, kopIndex);
    ref = {
      n: ref.n - kopIndex,
      md: ref.md.slice(kopIndex),
      inc: ref.inc.slice(kopIndex),
      azi: ref.azi.slice(kopIndex),
      pos: ref.pos.slice(kopIndex),
      tan: ref.tan.slice(kopIndex),
      dogleg: [0, ...ref.dogleg.slice(kopIndex + 1)],
      cov: covSliced,
      radius: ref.radius,
    };
  }
  const off = prepWell(offset);

  const nRef = ref.n;
  const out = {
    md: ref.md.slice(),
    sf: new Array(nRef),
    distanceCC: new Array(nRef),
    refPcr: new Array(nRef),
    offPcr: new Array(nRef),
    sigmaS: new Array(nRef),
    eouBoundary: new Array(nRef),
    wellboreSeparation: new Array(nRef),
    eouSeparation: new Array(nRef),
    masd: new Array(nRef),
    calcHole: new Array(nRef),
    hozBearingDeg: new Array(nRef),
    toolfaceBearingDeg: new Array(nRef),
    travCylAziDeg: new Array(nRef),
    closestPointOffset: new Array(nRef),
    kopIndex,
  };

  for (let i = 0; i < nRef; i++) {
    const P = ref.pos[i];
    // coarse nearest offset station
    let idx = 0;
    let best = Infinity;
    for (let j = 0; j < off.n; j++) {
      const d2 = (off.pos[j][0] - P[0]) ** 2
        + (off.pos[j][1] - P[1]) ** 2 + (off.pos[j][2] - P[2]) ** 2;
      if (d2 < best) { best = d2; idx = j; }
    }
    // exact closest point on the two adjacent arcs
    let bestDist = Infinity;
    let bestPos = off.pos[idx];
    let bestCov = off.cov[idx];
    let bestMd = off.md[idx];
    for (const j0 of [idx - 1, idx]) {
      if (j0 < 0 || j0 >= off.n - 1) continue;
      const segMd = off.md[j0 + 1] - off.md[j0];
      const x = closestXOnArc(
        off.pos[j0], off.tan[j0], off.tan[j0 + 1], segMd, off.dogleg[j0 + 1], P,
      );
      const q = posAtLeg(off, j0, x);
      const d = norm(sub(q, P));
      if (d < bestDist) {
        bestDist = d;
        bestPos = q;
        bestCov = lerpCov(off.cov[j0], off.cov[j0 + 1], segMd > 0 ? x / segMd : 0);
        bestMd = off.md[j0] + x;
      }
    }

    const dist = bestDist === Infinity ? norm(sub(bestPos, P)) : bestDist;
    const u = dist > 0 ? scale(sub(bestPos, P), 1 / dist) : [0, 0, 0];

    const refVar = Math.max(0, quadForm(u, ref.cov[i]));
    const offVar = Math.max(0, quadForm(u, bestCov));
    const refPcr = Math.sqrt(refVar);
    const offPcr = Math.sqrt(offVar);
    const sigmaS = Math.sqrt(refVar + offVar);
    const eouBoundary = k * Math.sqrt(sigmaS * sigmaS + sigmaPa * sigmaPa);
    const calcHole = ref.radius + off.radius;
    const wellboreSeparation = dist - calcHole - Sm;

    // bearings: horizontal (compass) and highside toolface of the C-C vector
    const hoz = ((Math.atan2(u[1], u[0]) / DEG) + 360) % 360;
    const ci = Math.cos(ref.inc[i]); const si = Math.sin(ref.inc[i]);
    const ca = Math.cos(ref.azi[i]); const sa = Math.sin(ref.azi[i]);
    const hComp = ci * ca * u[0] + ci * sa * u[1] - si * u[2];
    const lComp = -sa * u[0] + ca * u[1];
    const toolface = ((Math.atan2(lComp, hComp) / DEG) + 360) % 360;

    out.sf[i] = wellboreSeparation / eouBoundary;
    out.distanceCC[i] = dist;
    out.refPcr[i] = refPcr;
    out.offPcr[i] = offPcr;
    out.sigmaS[i] = sigmaS;
    out.eouBoundary[i] = eouBoundary;
    out.wellboreSeparation[i] = wellboreSeparation;
    out.eouSeparation[i] = wellboreSeparation - eouBoundary;
    out.masd[i] = eouBoundary + calcHole + Sm;
    out.calcHole[i] = calcHole;
    out.hozBearingDeg[i] = hoz;
    out.toolfaceBearingDeg[i] = toolface;
    out.travCylAziDeg[i] = ((ref.azi[i] / DEG) + toolface + 360) % 360;
    out.closestPointOffset[i] = {
      n: bestPos[0], e: bestPos[1], tvd: bestPos[2], md: bestMd,
    };
  }

  let minSfIndex = 0;
  for (let i = 1; i < nRef; i++) {
    if (out.sf[i] < out.sf[minSfIndex]) minSfIndex = i;
  }
  out.summary = {
    minSf: out.sf[minSfIndex],
    minSfMd: out.md[minSfIndex],
    minSfIndex,
    minDistanceCC: Math.min(...out.distanceCC),
  };
  return out;
}

// ---------------------------------------------------------------------------
// chart series
// ---------------------------------------------------------------------------

/**
 * Ladder-plot series from one or more clearance results: per offset a
 * {label, points: [{md, distanceCC, sf, masd}]} row, distance vs
 * reference MD.
 */
export function ladderSeries(results) {
  return results.map(({ label, clearance }) => ({
    label,
    points: clearance.md.map((md, i) => ({
      md,
      distanceCC: clearance.distanceCC[i],
      sf: clearance.sf[i],
      masd: clearance.masd[i],
    })),
  }));
}

/**
 * Traveling-cylinder series: polar points (azimuth = highside-referenced
 * traveling-cylinder angle by default, or 'north' for north-referenced;
 * radius = centre-to-centre distance) per offset well, walked along the
 * reference MD.
 */
export function travelingCylinderSeries(results, { referenceFrame = 'highside' } = {}) {
  return results.map(({ label, clearance }) => ({
    label,
    points: clearance.md.map((md, i) => ({
      md,
      azimuthDeg: referenceFrame === 'north'
        ? clearance.travCylAziDeg[i]
        : clearance.toolfaceBearingDeg[i],
      radius: clearance.distanceCC[i],
      sf: clearance.sf[i],
    })),
  }));
}

/**
 * Classify a clearance scan against SPE-187073-style action thresholds.
 * rules: {noGo, review} SF thresholds (defaults 1.0 / 1.5).
 */
export function classifyClearance(clearance, { noGo = 1.0, review = 1.5 } = {}) {
  const { minSf } = clearance.summary;
  const status = minSf < noGo ? 'no-go' : minSf < review ? 'review' : 'clear';
  const violations = [];
  for (let i = 0; i < clearance.md.length; i++) {
    if (clearance.sf[i] < review) {
      violations.push({
        md: clearance.md[i],
        sf: clearance.sf[i],
        level: clearance.sf[i] < noGo ? 'no-go' : 'review',
      });
    }
  }
  return { status, minSf, thresholds: { noGo, review }, violations };
}
