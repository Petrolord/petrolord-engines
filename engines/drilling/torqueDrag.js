// Soft-string torque & drag model (Johancsik et al. 1984, SPE 11380; standard
// differential form per Sheppard et al. 1987, SPE 15463).
//
// Model summary
//   The drillstring is treated as a weighted cable lying along the wellbore
//   centreline (zero bending stiffness). Marching from the bit to surface over
//   fine MD intervals:
//     contact force  N = sqrt[(T·Δφ·sinθ̄)² + (T·Δθ + w·Δs·sinθ̄)²]   (force, N)
//     axial          ΔT = w·Δs·cosθ̄ + fa·μ·N                          (N)
//     torque         ΔM = ft·μ·N·r                                     (N·m)
//   where fa = va/|v| (signed: pipe moving UP = +, DOWN = −) and ft = vt/|v|
//   partition Coulomb friction by the resultant sliding velocity, so pure
//   rotation carries no axial friction and pure axial motion carries no
//   torque, while combined modes (backreaming) split the budget without ever
//   exceeding μ·N. T inside N uses a midpoint predictor (weight-only half
//   step) for O(h²) convergence.
//
// Simplifications (documented, deliberate for v1):
//   * True tension, no pressure-area (piston) terms — Johancsik's original
//     formulation. Buoyancy enters as a weight factor (1 − ρmud/ρsteel).
//   * Pure Coulomb friction, one factor per hole section (cased / open axis
//     is expressed by the geometry sections the caller passes).
//   * Buckling limits are the straight-inclined Paslay–Dawson sinusoidal and
//     Chen–Cheatham helical forms; near-vertical (sinθ→0) they tend to zero,
//     which flags any compression — conservative, stated in the header of
//     bucklingLimits().
//
// Units (STRICT, no silent conversion — UI converts for display):
//   lengths/MD metres, angles degrees at the API boundary, forces N,
//   torque N·m, densities kg/m³, linear weight kg/m (in air), diameters m.
//
// Validation: tools/validation/drilling/oracle_torquedrag.py (independent
// numpy RK4 integration of the ODE form) → test-data/drilling/goldens/
// torquedrag_cases.json; closed-form gates (vertical, slant, horizontal,
// capstan limit) in __tests__/drilling.torquedrag.test.js.

import { resample, attitudeAtMd, wrapDeltaDeg } from './surveyMath.js';

const DEG = Math.PI / 180;
export const STEEL_DENSITY_KGM3 = 7850;
export const STEEL_E_PA = 206.8e9;
const G = 9.80665;

export const OPERATIONS = [
  'trip_out', 'trip_in', 'rotate_off_bottom', 'rotate_on_bottom',
  'slide_drill', 'backream',
];

// Signed axial velocity (m/s, up +) and rotary speed for each operation.
// tripSpeedMs / rpm come from params; on-bottom modes take WOB / bit torque
// boundary conditions at the bit.
function velocityModel(operation, { tripSpeedMs = 0.3, rpm = 120 } = {}) {
  switch (operation) {
    case 'trip_out': return { va: +tripSpeedMs, rpm: 0, onBottom: false };
    case 'trip_in': return { va: -tripSpeedMs, rpm: 0, onBottom: false };
    case 'rotate_off_bottom': return { va: 0, rpm, onBottom: false };
    case 'rotate_on_bottom': return { va: 0, rpm, onBottom: true };
    case 'slide_drill': return { va: -tripSpeedMs, rpm: 0, onBottom: true };
    case 'backream': return { va: +tripSpeedMs, rpm, onBottom: false };
    default: throw new Error(`Unknown operation '${operation}'.`);
  }
}

export function buoyancyFactor(mudDensityKgM3, steelDensityKgM3 = STEEL_DENSITY_KGM3) {
  if (!(steelDensityKgM3 > 0)) throw new Error('Steel density must be positive.');
  if (!(mudDensityKgM3 >= 0)) throw new Error('Mud density must be >= 0.');
  if (mudDensityKgM3 >= steelDensityKgM3) throw new Error('Mud density must be below steel density.');
  return 1 - mudDensityKgM3 / steelDensityKgM3;
}

// Cross-section area, moment of inertia, EI, and capacities for a component.
// yieldPa optional; capacities are null without it.
export function stringProperties({ odM, idM = 0, yieldPa = null }) {
  if (!(odM > 0) || !(idM >= 0) || idM >= odM) throw new Error('Invalid component OD/ID.');
  const area = (Math.PI / 4) * (odM * odM - idM * idM);
  const inertia = (Math.PI / 64) * (odM ** 4 - idM ** 4);
  const polar = 2 * inertia;
  const ei = STEEL_E_PA * inertia;
  let tensileCapacityN = null;
  let torsionalCapacityNm = null;
  if (yieldPa != null) {
    if (!(yieldPa > 0)) throw new Error('yieldPa must be positive when given.');
    tensileCapacityN = yieldPa * area;
    // Distortion-energy shear yield 0.577·σy at the outer fibre.
    torsionalCapacityNm = (0.577 * yieldPa * polar) / (odM / 2);
  }
  return { areaM2: area, inertiaM4: inertia, polarM4: polar, eiNm2: ei, tensileCapacityN, torsionalCapacityNm };
}

// Paslay–Dawson sinusoidal / Chen–Cheatham helical buckling limits for a
// straight inclined section. wcNPerM = buoyed weight per length (N/m),
// radialClearanceM = (hole ID − pipe OD)/2. Near-vertical the limits tend to
// zero and any compression flags — conservative by construction.
export function bucklingLimits({ eiNm2, wcNPerM, incDeg, radialClearanceM }) {
  if (!(eiNm2 > 0) || !(wcNPerM >= 0) || !(radialClearanceM > 0)) {
    throw new Error('bucklingLimits needs positive EI and clearance, non-negative weight.');
  }
  const s = Math.sin(Math.max(incDeg, 0) * DEG);
  const base = Math.sqrt((eiNm2 * wcNPerM * s) / radialClearanceM);
  return {
    sinusoidalN: 2 * base,
    helicalN: 2 * (2 * Math.SQRT2 - 1) * base,
  };
}

function buildComponentLookup(string) {
  if (!Array.isArray(string) || string.length === 0) throw new Error('String needs at least one component.');
  let total = 0;
  for (const c of string) {
    if (!(c.lengthM > 0)) throw new Error('Every component needs lengthM > 0.');
    if (!(c.weightKgM >= 0)) throw new Error('Every component needs weightKgM >= 0.');
    if (!(c.odM > 0)) throw new Error('Every component needs odM > 0.');
    total += c.lengthM;
  }
  // string is listed bottom-up: string[0] sits at the bit.
  return {
    totalLengthM: total,
    // distFromBit in [0, total): which component occupies that span.
    at(distFromBit) {
      let acc = 0;
      for (const c of string) {
        acc += c.lengthM;
        if (distFromBit < acc + 1e-9) return c;
      }
      return string[string.length - 1];
    },
  };
}

function sectionAt(geometry, md) {
  for (const g of geometry) {
    if (md >= g.fromMd - 1e-9 && md <= g.toMd + 1e-9) return g;
  }
  return null;
}

// Main entry. See file header for the model and units.
//   stations  [{md, inc, azi}] metres/degrees (grid azimuth)
//   string    bottom-up [{type, lengthM, weightKgM, odM, idM, tooljointOdM?, yieldPa?}]
//   geometry  [{fromMd, toMd, frictionFactor, holeIdM, cased}] covering [0, bitMd]
//   mud       {densityKgM3}
//   operation one of OPERATIONS
//   params    {wobN=0, bitTorqueNm=0, tripSpeedMs=0.3, rpm=120, stepM=10,
//              blockWeightN=0, steelDensityKgM3=7850}
export function computeTorqueDrag({ stations, string, geometry, mud, operation, params = {} }) {
  if (!Array.isArray(stations) || stations.length < 2) throw new Error('Need at least 2 survey stations.');
  if (!Array.isArray(geometry) || geometry.length === 0) throw new Error('Need at least one hole section.');
  const {
    wobN = 0, bitTorqueNm = 0, stepM = 10, blockWeightN = 0,
    steelDensityKgM3 = STEEL_DENSITY_KGM3,
  } = params;
  if (!(stepM > 0)) throw new Error('stepM must be positive.');
  if (!(wobN >= 0)) throw new Error('wobN must be >= 0.');

  const bf = buoyancyFactor(mud?.densityKgM3 ?? 0, steelDensityKgM3);
  const lookup = buildComponentLookup(string);
  const tdMax = stations[stations.length - 1].md;
  const bitMd = Math.min(lookup.totalLengthM, tdMax);
  const { va, rpm, onBottom } = velocityModel(operation, params);

  // Fine grid over [surfaceMd, bitMd]. Stations may start below 0 md only in
  // pathological inputs; the survey convention starts at md 0.
  const surfaceMd = stations[0].md;
  if (!(bitMd > surfaceMd)) throw new Error('String does not reach below the first survey station.');
  const fine = resample(stations, { step: stepM }).filter((s) => s.md <= bitMd + 1e-9);
  if (fine[fine.length - 1].md < bitMd - 1e-9) {
    const att = attitudeAtMd(stations, bitMd);
    fine.push({ md: bitMd, inc: att.inc, azi: att.azi });
  }

  // Boundary condition at the bit.
  let T = onBottom ? -wobN : 0;
  let M = onBottom ? bitTorqueNm : 0;

  const profile = new Array(fine.length);
  const warnings = [];
  let maxT = T;
  let minT = T;
  let maxSide = 0;
  let bucklingFirstMd = null;
  let missingSection = false;

  // Seed the bit-end profile row.
  {
    const cBit = lookup.at(0);
    profile[fine.length - 1] = makeRow(fine[fine.length - 1], T, M, 0, cBit, geometry, bf);
  }

  for (let i = fine.length - 1; i > 0; i -= 1) {
    const lo = fine[i];
    const hi = fine[i - 1];
    const ds = lo.md - hi.md;
    const midMd = (lo.md + hi.md) / 2;
    const distFromBit = bitMd - midMd;
    const comp = lookup.at(distFromBit);
    const sec = sectionAt(geometry, midMd);
    if (!sec && !missingSection) {
      missingSection = true;
      warnings.push('Hole geometry does not cover the full string; missing spans use friction 0.');
    }
    const mu = sec ? sec.frictionFactor : 0;

    const thetaMid = ((lo.inc + hi.inc) / 2) * DEG;
    const dTheta = (hi.inc - lo.inc) * DEG; // marching upward
    const dPhi = wrapDeltaDeg(lo.azi, hi.azi) * DEG;

    const w = comp.weightKgM * G * bf; // buoyed weight, N/m
    // Midpoint tension predictor (weight only) keeps the recursion O(h²).
    const Tmid = T + 0.5 * w * Math.cos(thetaMid) * ds;

    const N = Math.hypot(
      Tmid * dPhi * Math.sin(thetaMid),
      Tmid * dTheta + w * ds * Math.sin(thetaMid),
    );

    const rTorque = (comp.tooljointOdM ?? comp.odM) / 2;
    const vt = (2 * Math.PI * rTorque * rpm) / 60;
    const vres = Math.hypot(va, vt);
    const fa = vres > 0 ? va / vres : 0;
    const ft = vres > 0 ? vt / vres : 0;

    T += w * Math.cos(thetaMid) * ds + fa * mu * N;
    M += ft * mu * N * rTorque;

    const row = makeRow(hi, T, M, N / ds, comp, geometry, bf);
    profile[i - 1] = row;
    if (T > maxT) maxT = T;
    if (T < minT) minT = T;
    if (row.sideForceNPerM > maxSide) maxSide = row.sideForceNPerM;
  }

  // Buckling + utilization sweep (post-hoc, per row). bucklingFirstMd is the
  // SHALLOWEST buckled station: the top of the buckled interval.
  for (const row of profile) {
    if (row.buckling !== 'none' && (bucklingFirstMd == null || row.md < bucklingFirstMd)) {
      bucklingFirstMd = row.md;
    }
  }
  const utilMax = profile.reduce((m, r) => Math.max(m,
    r.utilization?.tension ?? 0, r.utilization?.torsion ?? 0), 0);
  if (bucklingFirstMd != null) {
    warnings.push(`Compression exceeds the sinusoidal buckling limit (buckled interval starts at ${bucklingFirstMd.toFixed(0)} m MD).`);
  }
  if (utilMax > 0.8) warnings.push('Tension or torsion utilization exceeds 80% of pipe capacity.');

  return {
    engine: 'torqueDrag-1.0.0',
    operation,
    bitMd,
    profile,
    summary: {
      hookloadN: T + blockWeightN,
      surfaceTorqueNm: M,
      maxTensionN: maxT,
      minTensionN: minT,
      maxSideForceNPerM: maxSide,
      bucklingFirstMd,
      warnings,
    },
  };
}

function makeRow(station, T, M, sideForceNPerM, comp, geometry, bf) {
  const sec = sectionAt(geometry, station.md);
  let buckling = 'none';
  if (T < 0 && sec) {
    const clearance = (sec.holeIdM - comp.odM) / 2;
    if (clearance > 0) {
      const props = stringProperties(comp);
      const limits = bucklingLimits({
        eiNm2: props.eiNm2,
        wcNPerM: comp.weightKgM * G * bf,
        incDeg: station.inc,
        radialClearanceM: clearance,
      });
      if (-T > limits.helicalN) buckling = 'helical';
      else if (-T > limits.sinusoidalN) buckling = 'sinusoidal';
    }
  }
  let utilization = null;
  if (comp.yieldPa != null) {
    const props = stringProperties(comp);
    utilization = {
      tension: props.tensileCapacityN ? Math.abs(T) / props.tensileCapacityN : null,
      torsion: props.torsionalCapacityNm ? Math.abs(M) / props.torsionalCapacityNm : null,
    };
  }
  return {
    md: station.md,
    incDeg: station.inc,
    tensionN: T,
    torqueNm: M,
    sideForceNPerM,
    buckling,
    utilization,
  };
}
