// 1D mechanical earth model + wellbore stability (Drilling D5): horizontal
// stresses, UCS correlations, full-tensor Kirsch stability for arbitrarily
// inclined wells, and the mud-weight window along a planned trajectory.
//
// Design: the engine takes DEPTH-INDEXED PROFILE ARRAYS (TVD, Sv, Pp) as
// inputs and stays pure mechanics — overburden/pore-pressure sources live
// upstream (published pp-1.0.0 curves or the validated porepressure
// package), so no cross-domain engine import is introduced.
//
// Mechanics (Peska & Zoback / Zoback, Reservoir Geomechanics, ch. 6/8):
//   * Horizontal stresses: uniaxial poroelastic estimate
//       Shmin = ν/(1−ν)·(Sv − αPp) + αPp + E/(1−ν²)·(εx + ν·εy)
//     (SHmax with the strains swapped; k0Override replaces ν/(1−ν)),
//     CLAMPED to the Andersonian frictional limits from the friction
//     angle — the limits are BOUNDS, not estimates (the legacy MEM mixed
//     the two; clamps are counted and reported).
//   * Stability: rotate the effective far-field tensor from the principal
//     frame (SHmax azimuth) through geographic (N,E,D) into the borehole
//     frame (high-side x, right-handed), evaluate the Kirsch wall
//     stresses vs circumferential angle θ from the high side
//       σθθ = σ11+σ22 − 2(σ11−σ22)cos2θ − 4σ12·sin2θ − ΔP
//       σzz = σ33 − ν[2(σ11−σ22)cos2θ + 4σ12·sin2θ]
//       τθz = 2(σ23·cosθ − σ13·sinθ),  σrr = ΔP,  ΔP = Pw − Pp
//     principal wall stresses from the (θθ,zz,τθz) block plus σrr.
//     COLLAPSE = smallest Pw keeping Mohr-Coulomb σ1' ≤ UCS + q·σ3'
//     satisfied at EVERY θ (zero-breakout-width criterion, conservative,
//     stated); FRACTURE INITIATION = largest Pw before the least wall
//     stress drops below −T0. Both by deterministic bisection.
//
// Units STRICT SI (Pa, m, degrees at the API). EMW = P/(g·TVD).
// Validation: independent numpy oracle (oracle_geomech.py) + closed-form
// vertical-well fixtures in __tests__/drilling.geomech.test.js.

import { attitudeAtMd } from './surveyMath.js';
import { tvdAt } from './wellControl.js';

const G = 9.80665;
const DEG = Math.PI / 180;

export const LITHOLOGY_SEEDS = [
  { name: 'sandstone', nu: 0.20, frictionAngleDeg: 35, cohesionMPa: 5, eGPa: 30 },
  { name: 'shale', nu: 0.35, frictionAngleDeg: 20, cohesionMPa: 10, eGPa: 15 },
  { name: 'limestone', nu: 0.30, frictionAngleDeg: 40, cohesionMPa: 20, eGPa: 50 },
  { name: 'dolomite', nu: 0.28, frictionAngleDeg: 45, cohesionMPa: 25, eGPa: 60 },
  { name: 'salt', nu: 0.25, frictionAngleDeg: 0, cohesionMPa: 1, eGPa: 25 },
];

// ---- horizontal stresses ---------------------------------------------------

export function frictionalLimitRatio(frictionAngleDeg) {
  const s = Math.sin(frictionAngleDeg * DEG);
  return (1 + s) / (1 - s);
}

export function horizontalStresses({
  svPa, ppPa, nu = 0.25, alphaBiot = 1, ePa = null, epsX = 0, epsY = 0,
  k0Override = null, frictionAngleDeg = 30, regime = 'NF',
}) {
  if (!Array.isArray(svPa) || !Array.isArray(ppPa) || svPa.length !== ppPa.length || !svPa.length) {
    throw new Error('svPa and ppPa must be non-empty arrays of equal length.');
  }
  if (!(nu > 0 && nu < 0.5)) throw new Error('Poisson ratio must sit in (0, 0.5).');
  if (!['NF', 'SS', 'TF'].includes(regime)) throw new Error("regime must be 'NF', 'SS' or 'TF'.");
  const k0 = k0Override != null ? k0Override : nu / (1 - nu);
  const q = frictionalLimitRatio(frictionAngleDeg);
  const strainMin = ePa != null ? (ePa / (1 - nu * nu)) * (epsX + nu * epsY) : 0;
  const strainMax = ePa != null ? (ePa / (1 - nu * nu)) * (epsY + nu * epsX) : 0;

  const shminPa = new Array(svPa.length);
  const shmaxPa = new Array(svPa.length);
  let clampedCount = 0;
  for (let i = 0; i < svPa.length; i += 1) {
    const sv = svPa[i];
    const pp = ppPa[i];
    const sigEffV = sv - alphaBiot * pp;
    let shmin = k0 * sigEffV + alphaBiot * pp + strainMin;
    let shmax = k0 * sigEffV + alphaBiot * pp + strainMax;
    if (shmax < shmin) [shmin, shmax] = [shmax, shmin];
    // Frictional bounds on EFFECTIVE stresses (Andersonian faulting limits):
    // no effective principal ratio may exceed q. The governing pair depends
    // on the regime's principal ordering.
    const lower = sigEffV / q + alphaBiot * pp;   // active limit
    const upper = sigEffV * q + alphaBiot * pp;   // passive limit
    const clamp = (v) => Math.min(Math.max(v, lower), upper);
    const cMin = clamp(shmin);
    const cMax = clamp(shmax);
    if (cMin !== shmin || cMax !== shmax) clampedCount += 1;
    shmin = cMin;
    shmax = Math.max(cMax, shmin);
    // Regime ordering sanity (SS: Shmax >= Sv >= Shmin; TF: both >= Sv).
    if (regime === 'TF' && shmin < sv) shmin = sv;
    if (regime === 'SS' && shmax < sv) shmax = sv;
    if (shmax < shmin) shmax = shmin;
    shminPa[i] = shmin;
    shmaxPa[i] = shmax;
  }
  const warnings = [];
  if (clampedCount > 0) {
    warnings.push(`${clampedCount} of ${svPa.length} samples hit the frictional stress limits and were clamped.`);
  }
  return { shminPa, shmaxPa, clampedCount, warnings, k0Used: k0 };
}

// ---- UCS correlations ------------------------------------------------------

// Published sonic-UCS correlations (provenance in the strings; both are
// lithology-specific and quoted for their original datasets — screening
// values, calibrate to core when available):
//   horsrud  (Horsrud 2001, shale):      UCS[MPa] = 0.77 · Vp[km/s]^3.2
//   mcnally  (McNally 1987, sandstone):  UCS[MPa] = 1200 · e^(−0.036·Δt[µs/ft])
export function ucsFromDt({ dtUsPerM, correlation = 'horsrud', params = {} }) {
  if (!Array.isArray(dtUsPerM) || !dtUsPerM.length) throw new Error('dtUsPerM must be a non-empty array.');
  const out = new Array(dtUsPerM.length);
  let provenance;
  if (correlation === 'constant') {
    const v = params.ucsPa;
    if (!(v > 0)) throw new Error('constant correlation needs params.ucsPa > 0.');
    out.fill(v);
    provenance = `constant UCS ${(v / 1e6).toFixed(1)} MPa`;
  } else if (correlation === 'horsrud') {
    for (let i = 0; i < dtUsPerM.length; i += 1) {
      const dt = dtUsPerM[i];
      if (!(dt > 0)) { out[i] = null; continue; }
      const vpKms = 1e6 / dt / 1000; // us/m -> m/s -> km/s
      out[i] = 0.77 * vpKms ** 3.2 * 1e6;
    }
    provenance = 'Horsrud 2001 (shale): UCS[MPa] = 0.77*Vp[km/s]^3.2';
  } else if (correlation === 'mcnally') {
    for (let i = 0; i < dtUsPerM.length; i += 1) {
      const dt = dtUsPerM[i];
      if (!(dt > 0)) { out[i] = null; continue; }
      const dtUsPerFt = dt * 0.3048;
      out[i] = 1200 * Math.exp(-0.036 * dtUsPerFt) * 1e6;
    }
    provenance = 'McNally 1987 (sandstone): UCS[MPa] = 1200*exp(-0.036*dt[us/ft])';
  } else {
    throw new Error(`Unknown UCS correlation '${correlation}'.`);
  }
  return { ucsPa: out, provenance };
}

// ---- stability at one depth ------------------------------------------------

// Borehole frame from inclination/azimuth (N,E,D world frame):
//   z_b = borehole axis (downhole), x_b = high side, y_b = z_b x x_b.
export function boreholeFrame(incDeg, aziDeg) {
  const i = incDeg * DEG;
  const a = aziDeg * DEG;
  const zb = [Math.sin(i) * Math.cos(a), Math.sin(i) * Math.sin(a), Math.cos(i)];
  // High side: the up-dip direction perpendicular to the axis. For a
  // vertical hole the azimuth direction is used (any choice is valid by
  // symmetry there).
  const xb = incDeg < 1e-9
    ? [Math.cos(a), Math.sin(a), 0]
    : [Math.cos(i) * Math.cos(a), Math.cos(i) * Math.sin(a), -Math.sin(i)];
  const yb = [
    zb[1] * xb[2] - zb[2] * xb[1],
    zb[2] * xb[0] - zb[0] * xb[2],
    zb[0] * xb[1] - zb[1] * xb[0],
  ];
  return { xb, yb, zb };
}

// Effective far-field stress tensor in the borehole frame.
export function farFieldInBoreholeFrame({
  svPa, shmaxPa, shminPa, ppPa, alphaBiot = 1, shmaxAzimuthDeg, incDeg, aziDeg,
}) {
  const g = shmaxAzimuthDeg * DEG;
  // Principal axes in (N,E,D): SHmax, Shmin (=SHmax azimuth + 90), Sv down.
  const axes = [
    [Math.cos(g), Math.sin(g), 0],
    [-Math.sin(g), Math.cos(g), 0],
    [0, 0, 1],
  ];
  const mags = [shmaxPa - alphaBiot * ppPa, shminPa - alphaBiot * ppPa, svPa - alphaBiot * ppPa];
  // sigma_G = sum_k mag_k * axis_k (x) axis_k
  const sG = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < 3; k += 1) {
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) sG[r][c] += mags[k] * axes[k][r] * axes[k][c];
    }
  }
  const { xb, yb, zb } = boreholeFrame(incDeg, aziDeg);
  const R = [xb, yb, zb];
  // sigma_B = R sigma_G R^T
  const sB = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let acc = 0;
      for (let m = 0; m < 3; m += 1) {
        for (let n = 0; n < 3; n += 1) acc += R[r][m] * sG[m][n] * R[c][n];
      }
      sB[r][c] = acc;
    }
  }
  return {
    s11: sB[0][0], s22: sB[1][1], s33: sB[2][2],
    s12: sB[0][1], s13: sB[0][2], s23: sB[1][2],
  };
}

// Principal wall stresses at angle theta for wall pressure differential dP.
export function wallStresses(sig, nu, thetaDeg, dPPa) {
  const t2 = 2 * thetaDeg * DEG;
  const sthth = sig.s11 + sig.s22 - 2 * (sig.s11 - sig.s22) * Math.cos(t2)
    - 4 * sig.s12 * Math.sin(t2) - dPPa;
  const szz = sig.s33 - nu * (2 * (sig.s11 - sig.s22) * Math.cos(t2) + 4 * sig.s12 * Math.sin(t2));
  const th = thetaDeg * DEG;
  const tthz = 2 * (sig.s23 * Math.cos(th) - sig.s13 * Math.sin(th));
  const mean = (sthth + szz) / 2;
  const half = Math.hypot((sthth - szz) / 2, tthz);
  return { tmax: mean + half, tmin: mean - half, srr: dPPa };
}

export function wellboreStability({
  svPa, shmaxPa, shminPa, ppPa, ucsPa, shmaxAzimuthDeg = 0,
  incDeg = 0, aziDeg = 0, frictionAngleDeg = 30, nu = 0.25,
  tensileStrengthPa = 0, alphaBiot = 1, thetaStepDeg = 1,
}) {
  if (!(ucsPa > 0)) throw new Error('UCS must be positive.');
  const q = frictionalLimitRatio(frictionAngleDeg);
  const sig = farFieldInBoreholeFrame({
    svPa, shmaxPa, shminPa, ppPa, alphaBiot, shmaxAzimuthDeg, incDeg, aziDeg,
  });
  const thetas = [];
  for (let t = 0; t < 180; t += thetaStepDeg) thetas.push(t);

  // Mohr-Coulomb margin at the worst theta for a given Pw (negative = safe).
  const mcWorst = (pwPa) => {
    const dP = pwPa - ppPa;
    let worst = -Infinity;
    let worstTheta = 0;
    for (const t of thetas) {
      const w = wallStresses(sig, nu, t, dP);
      const p = [w.tmax, w.tmin, w.srr].sort((a, b) => b - a);
      const margin = p[0] - q * p[2] - ucsPa;
      if (margin > worst) { worst = margin; worstTheta = t; }
    }
    return { worst, worstTheta };
  };
  // Least TANGENTIAL-PLANE wall stress over theta for a given Pw (fracture
  // initiation is a hoop-tension criterion; the radial component going
  // effectively negative below balance is not hydraulic fracturing).
  const minWall = (pwPa) => {
    const dP = pwPa - ppPa;
    let min = Infinity;
    for (const t of thetas) {
      const w = wallStresses(sig, nu, t, dP);
      min = Math.min(min, w.tmin);
    }
    return min;
  };

  const pwMax = 2 * Math.max(svPa, shmaxPa) + 10e6;
  // Collapse: mcWorst is NOT monotone (at very high Pw the radial stress
  // itself violates MC) — find the FIRST positive-to-negative crossing by
  // a 400-step scan then bisection (deterministic spec, mirrored in the
  // oracle).
  let collapsePa = null;
  let breakoutThetaDeg = null;
  {
    const atZero = mcWorst(0);
    if (atZero.worst <= 0) {
      collapsePa = 0; // even an empty hole is stable against MC collapse
      breakoutThetaDeg = atZero.worstTheta;
    } else {
      const N = 400;
      let k = -1;
      for (let i = 1; i <= N; i += 1) {
        if (mcWorst((i / N) * pwMax).worst <= 0) { k = i; break; }
      }
      if (k < 0) {
        collapsePa = pwMax; // cannot stabilize in range (window closed)
        breakoutThetaDeg = atZero.worstTheta;
      } else {
        let lo = ((k - 1) / N) * pwMax;
        let hi = (k / N) * pwMax;
        for (let i = 0; i < 60; i += 1) {
          const mid = (lo + hi) / 2;
          if (mcWorst(mid).worst > 0) lo = mid; else hi = mid;
        }
        collapsePa = hi;
        breakoutThetaDeg = mcWorst(Math.max(0, collapsePa - 1)).worstTheta;
      }
    }
  }
  // Fracture initiation: minWall decreases with Pw; largest Pw with
  // minWall >= -T0.
  let fracInitPa;
  if (minWall(0) < -tensileStrengthPa) {
    fracInitPa = 0;
  } else if (minWall(pwMax) >= -tensileStrengthPa) {
    fracInitPa = pwMax;
  } else {
    let lo = 0;
    let hi = pwMax;
    for (let i = 0; i < 80; i += 1) {
      const mid = (lo + hi) / 2;
      if (minWall(mid) >= -tensileStrengthPa) lo = mid; else hi = mid;
    }
    fracInitPa = lo;
  }
  return { collapsePa, fracInitPa, breakoutThetaDeg };
}

// ---- mud window along a trajectory ----------------------------------------

const interp = (xs, ys, x) => {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i += 1) {
    if (x <= xs[i]) {
      const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
      const a = ys[i - 1];
      const b = ys[i];
      if (a == null || b == null) return a ?? b ?? null;
      return a + f * (b - a);
    }
  }
  return ys[ys.length - 1];
};

export function mudWindowAlongWell({ stations, profile, params = {}, stepMdM = 30 }) {
  const { tvdM, svPa, shmaxPa, shminPa, ppPa, ucsPa } = profile || {};
  for (const [name, arr] of Object.entries({ tvdM, svPa, shmaxPa, shminPa, ppPa, ucsPa })) {
    if (!Array.isArray(arr) || arr.length !== tvdM.length || !arr.length) {
      throw new Error(`Profile array '${name}' must be non-empty and aligned with tvdM.`);
    }
  }
  if (!Array.isArray(stations) || stations.length < 2) throw new Error('Need at least 2 survey stations.');
  const tdMd = stations[stations.length - 1].md;
  const rows = [];
  const warnings = [];
  let tightest = null;
  let inversionMd = null;
  for (let md = Math.max(stations[0].md, stepMdM); md <= tdMd + 1e-9; md += stepMdM) {
    const att = attitudeAtMd(stations, Math.min(md, tdMd));
    const tvd = tvdAt(stations, Math.min(md, tdMd));
    if (!att || !(tvd > 0) || tvd < tvdM[0]) continue;
    const at = {
      svPa: interp(tvdM, svPa, tvd),
      shmaxPa: interp(tvdM, shmaxPa, tvd),
      shminPa: interp(tvdM, shminPa, tvd),
      ppPa: interp(tvdM, ppPa, tvd),
      ucsPa: interp(tvdM, ucsPa, tvd),
    };
    if (Object.values(at).some((v) => v == null || !Number.isFinite(v))) continue;
    const st = wellboreStability({
      ...at,
      shmaxAzimuthDeg: params.shmaxAzimuthDeg ?? 0,
      incDeg: att.inc,
      aziDeg: att.azi,
      frictionAngleDeg: params.frictionAngleDeg ?? 30,
      nu: params.nu ?? 0.25,
      tensileStrengthPa: params.tensileStrengthPa ?? 0,
      alphaBiot: params.alphaBiot ?? 1,
      thetaStepDeg: params.thetaStepDeg ?? 1,
    });
    const denom = G * tvd;
    const row = {
      md,
      tvd,
      incDeg: att.inc,
      ppEmwKgM3: at.ppPa / denom,
      collapseEmwKgM3: st.collapsePa / denom,
      fracInitEmwKgM3: st.fracInitPa / denom,
      breakoutThetaDeg: st.breakoutThetaDeg,
    };
    rows.push(row);
    const lower = Math.max(row.ppEmwKgM3, row.collapseEmwKgM3);
    const width = row.fracInitEmwKgM3 - lower;
    if (tightest == null || width < tightest.widthKgM3) {
      tightest = { md, tvd, widthKgM3: width, lowerEmwKgM3: lower, upperEmwKgM3: row.fracInitEmwKgM3 };
    }
    if (width < 0 && inversionMd == null) inversionMd = md;
  }
  if (!rows.length) throw new Error('No usable depths: the profile does not cover the trajectory TVDs.');
  if (inversionMd != null) {
    warnings.push(`The mud window closes (collapse or PP above fracture initiation) from ${inversionMd.toFixed(0)} m MD.`);
  }
  return { engine: 'geomech-1.0.0', rows, tightest, inversionMd, warnings };
}

// ---- quality score (the salvaged idea, regime-aware) -----------------------

export function qualityScore({ svPa, shmaxPa, shminPa, ppPa, fracInitEmw = null, regime = 'NF' }) {
  let score = 100;
  const warnings = [];
  let orderViolations = 0;
  for (let i = 0; i < svPa.length; i += 1) {
    if ([svPa[i], shmaxPa[i], shminPa[i], ppPa[i]].some((v) => v == null || !Number.isFinite(v) || v < 0)) continue;
    if (shmaxPa[i] < shminPa[i] - 1) orderViolations += 1;
    if (regime === 'NF' && svPa[i] < shmaxPa[i] - 1) orderViolations += 1;
    if (regime === 'TF' && shminPa[i] < svPa[i] - 1) orderViolations += 1;
    if (ppPa[i] > shminPa[i] + 1) orderViolations += 1;
  }
  if (orderViolations > 0) {
    score -= 20;
    warnings.push(`${orderViolations} samples violate the ${regime}-regime stress ordering or have PP above Shmin.`);
  }
  let nanCount = 0;
  for (const arr of [svPa, shmaxPa, shminPa, ppPa]) {
    for (const v of arr) if (v == null || !Number.isFinite(v)) nanCount += 1;
  }
  if (nanCount > 0) {
    score -= 15;
    warnings.push(`${nanCount} missing samples across the stress profiles.`);
  }
  return { score: Math.max(0, score), warnings };
}
