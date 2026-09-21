/**
 * Consequence modelling (HSE H4): source terms, dispersion, fires,
 * explosions and probits.
 *
 * Pure functions. Every input carries its unit in its name (massRateKgS,
 * downwindDistanceM, heatFluxWM2, exposureTimeS, exposureMinutes). Every
 * function returns either a finite result carrying `basis` (the model and
 * its source) or an object carrying `error` and `field`, the name of the
 * input that was refused. FINDINGS-consequence.md in tools/validation/hse/
 * carries the verbatim passages, the errata found in the sources and every
 * judgement call.
 *
 * SOURCES, and what each one fixes.
 *
 *   YB   TNO "Yellow Book", Methods for the calculation of physical
 *        effects, CPR 14E, 3rd ed. 2nd revised print (2005). Gas outflow
 *        through a hole (2.22) to (2.26); liquid outflow through a hole
 *        (2.194) to (2.197); Mackay and Matsugu evaporation (3.13), (3.24),
 *        (3.25); pool diameter (6.64), (6.65); pool burning rate (6.66),
 *        Table 6.5 (Babrauskas 1983) and Burgess (6.67); Thomas flame
 *        length with wind (6.12) to (6.14); flame tilt (6.68) to (6.70);
 *        surface emissive power (6.19), (6.20), (6.71); Bagster
 *        transmissivity (6.29) and its stated range; solid flame heat flux
 *        (6.4); view factors of a vertical cylinder (Raj, 6.A.10, 6.A.11,
 *        Table 6.A.1) and of a tilted cylinder (Mudan, 6.A.14, 6.A.15,
 *        6.A.18); TNT equivalence (5.1).
 *   PB   TNO "Purple Book", Guidelines for quantitative risk assessment,
 *        CPR 18E (1999): P = Phi(Pr - 5) and Table 5.1; toxic probit
 *        (5.3) and Table 5.2; heat radiation probit (5.4); the worked CO
 *        plume and probit of Appendix 6.B.
 *   OSD  UK HSE SPC/Tech/OSD/30, Indicative human vulnerability to the
 *        hazardous agents present offshore: thermal probits (Table 17),
 *        Lees (2005) toxic probits in ppm and minutes (Table 2), the
 *        overpressure probit of the HSC road and rail study (Equation 4a).
 *   ALOHA NOAA Technical Memorandum NOS OR&R 43, ALOHA Technical
 *        Documentation (2013): the continuous Gaussian plume with ground
 *        reflection, and the Briggs (1973) rural open-country sigma
 *        coefficients of Table 13 (with its note that an sz2 of 0.00015
 *        printed since Briggs 1973 should read 0.0015).
 *   KG   Kinney and Graham (1985), Explosive Shocks in Air, 2nd ed., the
 *        free-air peak side-on overpressure closed form, as reproduced by
 *        Guzas and Earls (2010), Steel and Composite Structures 10(5), eq.
 *        5.
 *   CCOHS ppm and mg/m3 at 25 C and 760 torr through 24.45 L/mol; this
 *        engine uses the ideal gas molar volume at the stated T and P, of
 *        which 24.45 is the rounded 25 C, 1 atm value.
 *
 * REUSED, NOT RESTATED. The critical pressure ratio is
 * engines/facilities/relief.js `criticalPressureRatio`. The still-air
 * Thomas flame height is engines/facilities/spacing.js
 * `thomasFlameHeightM`, the expression poolFireSetbackM has always used.
 * The standard normal CDF is lib/stats/stats.js `normalCDF`.
 *
 * WHAT IS NOT HERE, AND WHY. The POINT-SOURCE radiation model (flare and
 * pool fire) and the setback it implies already live in
 * engines/facilities/relief.js and engines/facilities/spacing.js, and the
 * NextGen courses FC1 and FC5 grade them; this engine adds the SOLID
 * FLAME model and does not re-expose the point source. Dropped for want
 * of a reproducible public closed form or a clean worked example: two
 * phase discharge, unconfined pool spreading beyond a stated thickness,
 * the instantaneous puff, urban dispersion coefficients (sigma y is not in
 * the source read), jet fires (the YB Chamberlain model's only worked
 * example carries internal inconsistencies, see the findings), the
 * Kingery-Bulmash polynomial fits and the TNO multi-energy method (both
 * published as curves in the sources read).
 */

import { criticalPressureRatio } from '../facilities/relief.js';
import { thomasFlameHeightM } from '../facilities/spacing.js';
import { normalCDF } from '../../lib/stats/stats.js';

/** Own-property preset lookup. `TABLE[key]` walks the prototype chain, so
 *  'constructor', 'toString', 'valueOf', 'hasOwnProperty' and '__proto__'
 *  are "found" in every object literal and walk through a falsy guard. */
const ownPreset = (table, key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);


export const G_M_S2 = 9.80665;
export const R_J_MOL_K = 8.314462618;
export const ATM_PA = 101325;
export const PA_PER_PSI = 6894.757293168361;

const SRC = Object.freeze({
  YB: 'TNO Yellow Book CPR 14E (2005)',
  PB: 'TNO Purple Book CPR 18E (1999)',
  OSD: 'UK HSE SPC/Tech/OSD/30, Indicative human vulnerability to the hazardous agents present offshore',
  ALOHA: 'NOAA TM NOS OR&R 43, ALOHA Technical Documentation (2013)',
  KG: 'Kinney and Graham (1985) Explosive Shocks in Air, 2nd ed.; as printed by Guzas and Earls (2010) eq. 5',
  CCOHS: 'CCOHS, Converting occupational exposure limits from mg/m3 to ppm (24.45 L/mol at 25 C, 760 torr)',
});

export const CONSEQUENCE_SOURCES = SRC;

const refuse = (field, message) => ({ error: `${field}: ${message}`, field });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const positive = (v) => isNum(v) && v > 0;

/** Bisection on a monotone function f with f(lo) and f(hi) of opposite sign. */
const bisect = (f, lo, hi, relTol = 1e-12) => {
  let a = lo;
  let b = hi;
  let fa = f(a);
  for (let i = 0; i < 400; i += 1) {
    const m = 0.5 * (a + b);
    const fm = f(m);
    if (fm === 0) return m;
    if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else { b = m; }
    if (b - a <= relTol * Math.abs(m)) break;
  }
  return 0.5 * (a + b);
};

/** Hole area from an area or a diameter; the caller names one of them. */
const holeArea = ({ holeAreaM2, holeDiameterM }) => {
  if (holeAreaM2 !== undefined && holeAreaM2 !== null) {
    if (!positive(holeAreaM2)) return refuse('holeAreaM2', 'must be an area above 0 m2');
    if (holeDiameterM !== undefined && holeDiameterM !== null) {
      return refuse('holeDiameterM', 'give the hole area or its diameter, not both');
    }
    return { areaM2: holeAreaM2 };
  }
  if (!positive(holeDiameterM)) return refuse('holeDiameterM', 'a hole diameter above 0 m (or holeAreaM2) is required');
  return { areaM2: (Math.PI / 4) * holeDiameterM * holeDiameterM };
};

const dischargeCoefficientError = (cd) => (
  positive(cd) && cd <= 1 ? null : refuse('dischargeCoefficient', 'must lie in (0, 1]: the YB recommends 0.62 for a sharp orifice')
);

/* ------------------------------------------------------------------ */
/* 1. Source terms                                                     */
/* ------------------------------------------------------------------ */

/**
 * Liquid outflow through a hole (YB 2.194 to 2.196, Bernoulli, initial
 * liquid velocity neglected):
 *
 *     qS = Cd Ah sqrt(2 (P - Pa) rhoL),   P = rhoL g hL + PaL
 *
 * pressureAboveLiquidPa is PaL, absolute; liquidHeadM is hL, the liquid
 * height above the hole. Refused when P <= Pa: no outflow.
 */
export const liquidOrificeDischarge = ({
  dischargeCoefficient, holeDiameterM, holeAreaM2, liquidDensityKgM3,
  liquidHeadM = 0, pressureAboveLiquidPa = ATM_PA, ambientPressurePa = ATM_PA,
} = {}) => {
  const cdErr = dischargeCoefficientError(dischargeCoefficient);
  if (cdErr) return cdErr;
  const hole = holeArea({ holeAreaM2, holeDiameterM });
  if (hole.error) return hole;
  if (!positive(liquidDensityKgM3)) return refuse('liquidDensityKgM3', 'must be a density above 0 kg/m3');
  if (!isNum(liquidHeadM) || liquidHeadM < 0) return refuse('liquidHeadM', 'must be a liquid height of 0 m or more above the hole');
  if (!positive(pressureAboveLiquidPa)) return refuse('pressureAboveLiquidPa', 'must be an absolute pressure above 0 Pa');
  if (!positive(ambientPressurePa)) return refuse('ambientPressurePa', 'must be an absolute pressure above 0 Pa');
  const hydrostaticPa = liquidDensityKgM3 * G_M_S2 * liquidHeadM;
  const totalPa = hydrostaticPa + pressureAboveLiquidPa;
  const deltaPa = totalPa - ambientPressurePa;
  if (!(deltaPa > 0)) {
    return refuse('pressureAboveLiquidPa', 'the pressure at the hole does not exceed ambient, so nothing flows out');
  }
  const massRateKgS = dischargeCoefficient * hole.areaM2 * Math.sqrt(2 * deltaPa * liquidDensityKgM3);
  return {
    massRateKgS,
    holeAreaM2: hole.areaM2,
    pressureAtHolePa: totalPa,
    drivingPressurePa: deltaPa,
    jetVelocityMS: massRateKgS / (liquidDensityKgM3 * dischargeCoefficient * hole.areaM2),
    basis: {
      model: 'Bernoulli liquid outflow through a hole, qS = Cd Ah sqrt(2 (P - Pa) rhoL), P = rhoL g hL + PaL',
      source: `${SRC.YB} eqs. 2.194 to 2.196`,
      units: 'kg/s; Pa absolute; m; g = 9.80665 m/s2',
    },
  };
};

/**
 * Gas outflow through a hole (YB 2.22 to 2.26), ideal gas upstream:
 *
 *     qS = Cd Ah psi sqrt(rho0 P0 gamma (2/(gamma+1))^((gamma+1)/(gamma-1)))
 *
 * choked when P0/Pa >= ((gamma+1)/2)^(gamma/(gamma-1)), i.e. when Pa/P0 is
 * at or below the critical pressure ratio (relief.js). psi^2 = 1 choked;
 * subsonic
 *
 *     psi^2 = 2/(gamma-1) ((gamma+1)/2)^((gamma+1)/(gamma-1))
 *             (Pa/P0)^(2/gamma) (1 - (Pa/P0)^((gamma-1)/gamma))
 *
 * which equals 1 at the critical ratio, so the boundary is continuous and
 * a ratio exactly at the critical value is reported CHOKED (the YB's >=).
 */
export const gasOrificeDischarge = ({
  dischargeCoefficient, holeDiameterM, holeAreaM2, upstreamPressurePa,
  upstreamTemperatureK, molarMassKgMol, heatCapacityRatio, ambientPressurePa = ATM_PA,
} = {}) => {
  const cdErr = dischargeCoefficientError(dischargeCoefficient);
  if (cdErr) return cdErr;
  const hole = holeArea({ holeAreaM2, holeDiameterM });
  if (hole.error) return hole;
  if (!positive(upstreamPressurePa)) return refuse('upstreamPressurePa', 'must be an absolute pressure above 0 Pa');
  if (!positive(upstreamTemperatureK)) return refuse('upstreamTemperatureK', 'must be an absolute temperature above 0 K');
  if (!positive(molarMassKgMol)) return refuse('molarMassKgMol', 'must be a molar mass above 0 kg/mol (hydrogen is 0.002016)');
  if (!isNum(heatCapacityRatio) || !(heatCapacityRatio > 1)) return refuse('heatCapacityRatio', 'gamma = Cp/Cv must be above 1');
  if (!positive(ambientPressurePa)) return refuse('ambientPressurePa', 'must be an absolute pressure above 0 Pa');
  if (!(upstreamPressurePa > ambientPressurePa)) {
    return refuse('upstreamPressurePa', 'must exceed the ambient pressure, or nothing flows out');
  }
  const g = heatCapacityRatio;
  const rcrit = criticalPressureRatio(g);
  const r = ambientPressurePa / upstreamPressurePa;
  const choked = r <= rcrit;
  const psiSquared = choked
    ? 1
    : (2 / (g - 1)) * ((g + 1) / 2) ** ((g + 1) / (g - 1)) * r ** (2 / g) * (1 - r ** ((g - 1) / g));
  const rho0 = (upstreamPressurePa * molarMassKgMol) / (R_J_MOL_K * upstreamTemperatureK);
  const massRateKgS = dischargeCoefficient * hole.areaM2 * Math.sqrt(psiSquared)
    * Math.sqrt(rho0 * upstreamPressurePa * g * (2 / (g + 1)) ** ((g + 1) / (g - 1)));
  return {
    massRateKgS,
    choked,
    regime: choked ? 'CHOKED' : 'SUBSONIC',
    pressureRatio: r,
    criticalPressureRatio: rcrit,
    outflowCoefficientPsi: Math.sqrt(psiSquared),
    upstreamDensityKgM3: rho0,
    holeAreaM2: hole.areaM2,
    basis: {
      model: 'ideal gas outflow through a hole, choked when Pa/P0 <= (2/(gamma+1))^(gamma/(gamma-1)) (exactly at the ratio counts as choked), subsonic psi from YB 2.25',
      source: `${SRC.YB} eqs. 2.22 to 2.26; critical ratio from engines/facilities/relief.js`,
      units: 'kg/s; Pa absolute; K; kg/mol; R = 8.314462618 J/(mol K)',
    },
  };
};

/**
 * Pool area and equivalent diameter from a spill.
 *
 *   CONFINED (bundAreaM2 given): the pool covers the bund floor, the
 *   depth is V / A, and a depth above bundWallHeightM (when given) is
 *   refused: the bund overtops and the pool is no longer confined.
 *   UNCONFINED (poolThicknessM given): A = V / delta, D = sqrt(4 V / (pi
 *   delta)) (YB 6.65). The thickness is the caller's; no spreading model
 *   is implemented (YB 6.5.5 is a differential equation for a fed pool).
 *
 * D = sqrt(4 A / pi) (YB 6.64) in both cases.
 */
export const poolFromSpill = ({ spillVolumeM3, bundAreaM2, bundWallHeightM, poolThicknessM } = {}) => {
  if (!positive(spillVolumeM3)) return refuse('spillVolumeM3', 'must be a volume above 0 m3');
  const hasBund = bundAreaM2 !== undefined && bundAreaM2 !== null;
  const hasThickness = poolThicknessM !== undefined && poolThicknessM !== null;
  if (hasBund && hasThickness) return refuse('poolThicknessM', 'give a bund area (confined) or a pool thickness (unconfined), not both');
  let areaM2;
  let depthM;
  let containment;
  if (hasBund) {
    if (!positive(bundAreaM2)) return refuse('bundAreaM2', 'must be a bund floor area above 0 m2');
    areaM2 = bundAreaM2;
    depthM = spillVolumeM3 / bundAreaM2;
    containment = 'CONFINED';
    if (bundWallHeightM !== undefined && bundWallHeightM !== null) {
      if (!positive(bundWallHeightM)) return refuse('bundWallHeightM', 'must be a wall height above 0 m');
      if (depthM > bundWallHeightM) {
        return refuse('spillVolumeM3', 'the spill overtops the bund (depth above the wall height), so the pool is not confined by it');
      }
    }
  } else if (hasThickness) {
    if (!positive(poolThicknessM)) return refuse('poolThicknessM', 'must be a pool thickness above 0 m');
    areaM2 = spillVolumeM3 / poolThicknessM;
    depthM = poolThicknessM;
    containment = 'UNCONFINED_STATED_THICKNESS';
  } else {
    return refuse('bundAreaM2', 'a bund area (confined pool) or a pool thickness (unconfined pool) is required: no spreading model is implemented');
  }
  return {
    areaM2,
    depthM,
    equivalentDiameterM: Math.sqrt((4 * areaM2) / Math.PI),
    containment,
    basis: {
      model: containment === 'CONFINED'
        ? 'pool covers the bund floor; D = sqrt(4 A / pi)'
        : 'A = V / delta with the stated thickness; D = sqrt(4 V / (pi delta))',
      source: `${SRC.YB} eqs. 6.64, 6.65`,
      units: 'm3, m2, m',
    },
  };
};

/** YB 3.24 constant, m^0.33 / s^0.22. */
export const MACKAY_MATSUGU_C = 0.004786;

/**
 * Evaporation of a non-boiling pool, Mackay and Matsugu as the YB states
 * it (3.13, 3.24, 3.25):
 *
 *     km = 0.004786 u10^0.78 (2 r)^-0.11 Sc^-0.67        m/s
 *     q"v = km Pv(T) mu / (R T)                           kg/(m2 s)
 *
 * Sc defaults to 0.8, the YB's "in general for gases and vapours". The
 * pool surface temperature is the caller's (no heat balance here). A
 * vapour pressure at or above ambient is a boiling pool, outside this
 * model, and is refused. A wind speed of 0 gives km = 0, which is the
 * correlation's form and not physics, and is refused.
 */
export const poolEvaporationMackayMatsugu = ({
  poolDiameterM, windSpeed10mMS, vapourPressurePa, molarMassKgMol, liquidTemperatureK,
  schmidtNumber = 0.8, ambientPressurePa = ATM_PA,
} = {}) => {
  if (!positive(poolDiameterM)) return refuse('poolDiameterM', 'must be a pool diameter above 0 m');
  if (!positive(windSpeed10mMS)) return refuse('windSpeed10mMS', 'must be above 0 m/s: the correlation gives zero evaporation in calm air, which is its form and not physics');
  if (!positive(vapourPressurePa)) return refuse('vapourPressurePa', 'must be a vapour pressure above 0 Pa');
  if (!positive(ambientPressurePa)) return refuse('ambientPressurePa', 'must be an absolute pressure above 0 Pa');
  if (!(vapourPressurePa < ambientPressurePa)) return refuse('vapourPressurePa', 'is at or above ambient: the pool is boiling, and this non-boiling evaporation model does not apply');
  if (!positive(molarMassKgMol)) return refuse('molarMassKgMol', 'must be a molar mass above 0 kg/mol');
  if (!positive(liquidTemperatureK)) return refuse('liquidTemperatureK', 'must be an absolute temperature above 0 K');
  if (!positive(schmidtNumber)) return refuse('schmidtNumber', 'must be above 0');
  const kmMS = MACKAY_MATSUGU_C * windSpeed10mMS ** 0.78 * poolDiameterM ** -0.11 * schmidtNumber ** -0.67;
  const fluxKgM2S = (kmMS * vapourPressurePa * molarMassKgMol) / (R_J_MOL_K * liquidTemperatureK);
  const areaM2 = (Math.PI / 4) * poolDiameterM * poolDiameterM;
  return {
    massTransferCoefficientMS: kmMS,
    evaporationFluxKgM2S: fluxKgM2S,
    poolAreaM2: areaM2,
    evaporationRateKgS: fluxKgM2S * areaM2,
    basis: {
      model: 'Mackay and Matsugu: km = 0.004786 u10^0.78 (2r)^-0.11 Sc^-0.67; q = km Pv mu / (R T) x A',
      source: `${SRC.YB} eqs. 3.13, 3.24, 3.25, 3.141`,
      units: 'm/s, kg/(m2 s), kg/s; wind at 10 m; Pa; K; kg/mol',
    },
  };
};

/* ------------------------------------------------------------------ */
/* 2. Dispersion                                                       */
/* ------------------------------------------------------------------ */

/**
 * Briggs (1973) rural (open country) dispersion coefficients, as ALOHA
 * Table 13 prints them:
 *
 *     sigma_y = sy1 x / sqrt(1 + sy2 x)
 *     sigma_z = sz1 x (1 + sz2 x)^sz3
 *
 * ALOHA notes that "an incorrect value of 0.00015 for sz2 was presented in
 * Briggs (1973) and many later references" and uses 0.0015. The note does
 * not say which row; in ALOHA's table 0.0015 appears in the rural D row
 * and in the urban E and F rows (the urban set is not implemented here).
 */
export const BRIGGS_RURAL = Object.freeze({
  A: Object.freeze({ sy1: 0.22, sy2: 0.0001, sz1: 0.2, sz2: 0, sz3: 0 }),
  B: Object.freeze({ sy1: 0.16, sy2: 0.0001, sz1: 0.12, sz2: 0, sz3: 0 }),
  C: Object.freeze({ sy1: 0.11, sy2: 0.0001, sz1: 0.08, sz2: 0.0002, sz3: -0.5 }),
  D: Object.freeze({ sy1: 0.08, sy2: 0.0001, sz1: 0.06, sz2: 0.0015, sz3: -0.5 }),
  E: Object.freeze({ sy1: 0.06, sy2: 0.0001, sz1: 0.03, sz2: 0.0003, sz3: -1 }),
  F: Object.freeze({ sy1: 0.04, sy2: 0.0001, sz1: 0.016, sz2: 0.0003, sz3: -1 }),
});

export const STABILITY_CLASSES = Object.freeze(Object.keys(BRIGGS_RURAL));

/** Distances outside which the result carries a warning, m. See findings. */
export const BRIGGS_ADVISORY_RANGE_M = Object.freeze({ min: 100, max: 10000 });

export const briggsRuralSigmas = ({ stabilityClass, downwindDistanceM } = {}) => {
  const cls = typeof stabilityClass === 'string' ? stabilityClass.trim().toUpperCase() : stabilityClass;
  if (!STABILITY_CLASSES.includes(cls)) {
    return refuse('stabilityClass', `must be a Pasquill-Gifford class, one of ${STABILITY_CLASSES.join(', ')}`);
  }
  if (!positive(downwindDistanceM)) return refuse('downwindDistanceM', 'must be a downwind distance above 0 m');
  const c = ownPreset(BRIGGS_RURAL, cls) ? BRIGGS_RURAL[cls] : undefined;
  if (!c) return refuse('stabilityClass', `must be a Pasquill-Gifford class, one of ${STABILITY_CLASSES.join(', ')}`);
  const x = downwindDistanceM;
  const sigmaYM = (c.sy1 * x) / Math.sqrt(1 + c.sy2 * x);
  const sigmaZM = c.sz1 * x * (1 + c.sz2 * x) ** c.sz3;
  const out = {
    stabilityClass: cls,
    sigmaYM,
    sigmaZM,
    basis: {
      model: 'Briggs (1973) rural open country: sigma_y = sy1 x / sqrt(1 + sy2 x); sigma_z = sz1 x (1 + sz2 x)^sz3',
      source: `${SRC.ALOHA} section 4.3.1, Table 13`,
      units: 'm',
    },
  };
  if (x < BRIGGS_ADVISORY_RANGE_M.min || x > BRIGGS_ADVISORY_RANGE_M.max) {
    out.warning = 'the downwind distance is outside 100 m to 10 km, the range these curves are usually quoted for; treat the result as an extrapolation';
  }
  return out;
};

const plumeSigmas = ({ stabilityClass, downwindDistanceM, sigmaYM, sigmaZM }) => {
  const hasClass = stabilityClass !== undefined && stabilityClass !== null;
  const hasSigmas = sigmaYM !== undefined || sigmaZM !== undefined;
  if (hasClass && hasSigmas) return refuse('stabilityClass', 'give a stability class or explicit sigmas, not both');
  if (hasClass) return briggsRuralSigmas({ stabilityClass, downwindDistanceM });
  if (!positive(sigmaYM)) return refuse('sigmaYM', 'a stability class or a sigma_y above 0 m is required');
  if (!positive(sigmaZM)) return refuse('sigmaZM', 'a stability class or a sigma_z above 0 m is required');
  return { sigmaYM, sigmaZM, stabilityClass: null };
};

const plumeKernel = (q, u, sy, sz, y, z, h) => (q / (2 * Math.PI * sy * sz * u))
  * Math.exp(-(y * y) / (2 * sy * sy))
  * (Math.exp(-((z - h) ** 2) / (2 * sz * sz)) + Math.exp(-((z + h) ** 2) / (2 * sz * sz)));

/** Ideal gas molar volume, m3/mol. */
export const molarVolumeM3Mol = (temperatureK = 298.15, pressurePa = ATM_PA) => (R_J_MOL_K * temperatureK) / pressurePa;

const conversionInputs = ({ molarMassGMol, temperatureK, pressurePa }) => {
  if (!positive(molarMassGMol)) return refuse('molarMassGMol', 'must be a molar mass above 0 g/mol');
  if (!positive(temperatureK)) return refuse('temperatureK', 'must be an absolute temperature above 0 K');
  if (!positive(pressurePa)) return refuse('pressurePa', 'must be an absolute pressure above 0 Pa');
  return null;
};

/**
 * ppm by volume to mg/m3 at the stated T and P, ideal gas:
 * mg/m3 = ppm x M[g/mol] / Vm[L/mol], Vm = R T / P. At 25 C and 1 atm
 * Vm = 24.465 L/mol; the CCOHS and NIOSH 24.45 is its rounding.
 */
export const ppmToMgM3 = ({ concentrationPpm, molarMassGMol, temperatureK = 298.15, pressurePa = ATM_PA } = {}) => {
  const bad = conversionInputs({ molarMassGMol, temperatureK, pressurePa });
  if (bad) return bad;
  if (!isNum(concentrationPpm) || concentrationPpm < 0) return refuse('concentrationPpm', 'must be a concentration of 0 ppm or more');
  const vmLMol = molarVolumeM3Mol(temperatureK, pressurePa) * 1000;
  return {
    concentrationMgM3: (concentrationPpm * molarMassGMol) / vmLMol,
    molarVolumeLMol: vmLMol,
    basis: { model: 'mg/m3 = ppm x M / Vm, Vm = R T / P (ideal gas)', source: SRC.CCOHS, units: 'ppm by volume; mg/m3; g/mol; K; Pa' },
  };
};

export const mgM3ToPpm = ({ concentrationMgM3, molarMassGMol, temperatureK = 298.15, pressurePa = ATM_PA } = {}) => {
  const bad = conversionInputs({ molarMassGMol, temperatureK, pressurePa });
  if (bad) return bad;
  if (!isNum(concentrationMgM3) || concentrationMgM3 < 0) return refuse('concentrationMgM3', 'must be a concentration of 0 mg/m3 or more');
  const vmLMol = molarVolumeM3Mol(temperatureK, pressurePa) * 1000;
  return {
    concentrationPpm: (concentrationMgM3 * vmLMol) / molarMassGMol,
    molarVolumeLMol: vmLMol,
    basis: { model: 'ppm = mg/m3 x Vm / M, Vm = R T / P (ideal gas)', source: SRC.CCOHS, units: 'ppm by volume; mg/m3; g/mol; K; Pa' },
  };
};

const plumeInputs = ({ massRateKgS, windSpeedMS, releaseHeightM, receptorHeightM }) => {
  if (!positive(massRateKgS)) return refuse('massRateKgS', 'must be a release rate above 0 kg/s');
  if (!positive(windSpeedMS)) return refuse('windSpeedMS', 'must be above 0 m/s: the Gaussian plume divides by the wind speed and has no calm-air form');
  if (!isNum(releaseHeightM) || releaseHeightM < 0) return refuse('releaseHeightM', 'must be a height of 0 m or more');
  if (!isNum(receptorHeightM) || receptorHeightM < 0) return refuse('receptorHeightM', 'must be a height of 0 m or more');
  return null;
};

/**
 * Continuous point source, Gaussian plume with total reflection at the
 * ground (ALOHA 4.3; PB Appendix 6.B uses the same expression):
 *
 *   C = Q / (2 pi sy sz u) exp(-y^2 / 2 sy^2)
 *       [exp(-(z - h)^2 / 2 sz^2) + exp(-(z + h)^2 / 2 sz^2)]
 *
 * which at ground level on the centreline is Q / (pi sy sz u) exp(-h^2 /
 * 2 sz^2). Sigmas from a Pasquill-Gifford class (Briggs rural) or given
 * explicitly (sigmaYM, sigmaZM) for another parameterisation.
 */
export const gaussianPlume = ({
  massRateKgS, windSpeedMS, downwindDistanceM, crosswindDistanceM = 0,
  receptorHeightM = 0, releaseHeightM = 0, stabilityClass, sigmaYM, sigmaZM,
  molarMassGMol, temperatureK = 298.15, pressurePa = ATM_PA,
} = {}) => {
  const bad = plumeInputs({ massRateKgS, windSpeedMS, releaseHeightM, receptorHeightM });
  if (bad) return bad;
  if (!positive(downwindDistanceM)) return refuse('downwindDistanceM', 'must be a downwind distance above 0 m: the plume is undefined at the source');
  if (!isNum(crosswindDistanceM)) return refuse('crosswindDistanceM', 'must be a finite crosswind distance in m');
  const s = plumeSigmas({ stabilityClass, downwindDistanceM, sigmaYM, sigmaZM });
  if (s.error) return s;
  const c = plumeKernel(massRateKgS, windSpeedMS, s.sigmaYM, s.sigmaZM, crosswindDistanceM, receptorHeightM, releaseHeightM);
  const out = {
    concentrationKgM3: c,
    concentrationMgM3: c * 1e6,
    sigmaYM: s.sigmaYM,
    sigmaZM: s.sigmaZM,
    stabilityClass: s.stabilityClass,
    basis: {
      model: 'continuous point source Gaussian plume, total ground reflection (image source at -h)',
      source: `${SRC.ALOHA} section 4.3; sigmas ${s.stabilityClass ? 'Briggs rural (ALOHA Table 13)' : 'as given'}`,
      units: 'kg/s, m/s, m; kg/m3 and mg/m3',
    },
  };
  if (s.warning) out.warning = s.warning;
  if (molarMassGMol !== undefined && molarMassGMol !== null) {
    const p = mgM3ToPpm({ concentrationMgM3: out.concentrationMgM3, molarMassGMol, temperatureK, pressurePa });
    if (p.error) return p;
    out.concentrationPpm = p.concentrationPpm;
  }
  return out;
};

/**
 * The downwind distances at which the centreline concentration at the
 * receptor height equals a target, for a Pasquill-Gifford class. With
 * h = z = 0 the concentration falls monotonically and there is one
 * distance (farDistanceM). An elevated release rises to a peak and falls,
 * so there are two (nearDistanceM, farDistanceM), found by bisection on
 * either side of the peak, which is located by golden-section search.
 * States: REACHED, NOT_REACHED (the peak is below the target),
 * BEYOND_SEARCH_RANGE (still above the target at maxDistanceM).
 */
export const plumeDistanceToConcentration = ({
  massRateKgS, windSpeedMS, stabilityClass, targetConcentrationMgM3,
  releaseHeightM = 0, receptorHeightM = 0, minDistanceM = 1, maxDistanceM = 100000,
} = {}) => {
  const bad = plumeInputs({ massRateKgS, windSpeedMS, releaseHeightM, receptorHeightM });
  if (bad) return bad;
  const probe = briggsRuralSigmas({ stabilityClass, downwindDistanceM: 1000 });
  if (probe.error) return probe;
  if (!positive(targetConcentrationMgM3)) return refuse('targetConcentrationMgM3', 'must be a concentration above 0 mg/m3');
  if (!positive(minDistanceM)) return refuse('minDistanceM', 'must be above 0 m');
  if (!positive(maxDistanceM) || !(maxDistanceM > minDistanceM)) return refuse('maxDistanceM', 'must exceed minDistanceM');
  const cls = probe.stabilityClass;
  const conc = (x) => {
    const sg = briggsRuralSigmas({ stabilityClass: cls, downwindDistanceM: x });
    return 1e6 * plumeKernel(massRateKgS, windSpeedMS, sg.sigmaYM, sg.sigmaZM, 0, receptorHeightM, releaseHeightM);
  };
  // Peak by golden-section search in log x (unimodal for these sigmas).
  let a = Math.log(minDistanceM);
  let b = Math.log(maxDistanceM);
  const gr = (Math.sqrt(5) - 1) / 2;
  let c1 = b - gr * (b - a);
  let c2 = a + gr * (b - a);
  let f1 = conc(Math.exp(c1));
  let f2 = conc(Math.exp(c2));
  for (let i = 0; i < 200 && b - a > 1e-12; i += 1) {
    if (f1 > f2) { b = c2; c2 = c1; f2 = f1; c1 = b - gr * (b - a); f1 = conc(Math.exp(c1)); } else { a = c1; c1 = c2; f1 = f2; c2 = a + gr * (b - a); f2 = conc(Math.exp(c2)); }
  }
  let peakX = Math.exp(0.5 * (a + b));
  let peak = conc(peakX);
  const cMin = conc(minDistanceM);
  if (cMin >= peak) { peakX = minDistanceM; peak = cMin; }
  const target = targetConcentrationMgM3;
  const base = {
    stabilityClass: cls,
    targetConcentrationMgM3: target,
    peakConcentrationMgM3: peak,
    peakDistanceM: peakX,
    basis: {
      model: 'root of the ground-reflected Gaussian plume centreline concentration, Briggs rural sigmas; bisection',
      source: `${SRC.ALOHA} sections 4.3, 4.3.1`,
      units: 'm; mg/m3',
    },
  };
  if (peak < target) return { ...base, state: 'NOT_REACHED', nearDistanceM: null, farDistanceM: null };
  const g = (x) => conc(x) - target;
  const cMax = conc(maxDistanceM);
  const farDistanceM = cMax >= target ? null : bisect(g, peakX, maxDistanceM);
  let nearDistanceM = null;
  if (peakX > minDistanceM && cMin < target) nearDistanceM = bisect(g, minDistanceM, peakX);
  return {
    ...base,
    state: farDistanceM === null ? 'BEYOND_SEARCH_RANGE' : 'REACHED',
    nearDistanceM,
    farDistanceM,
  };
};

/* ------------------------------------------------------------------ */
/* 3. Fires: pool fire, solid flame                                    */
/* ------------------------------------------------------------------ */

/**
 * Large pool burning rate estimates, Babrauskas (1983), YB Table 6.5.
 * kBetaPerM null: "value independent of diameter in turbulent regime".
 */
export const POOL_FIRE_FUELS = Object.freeze({
  'liquid-hydrogen': Object.freeze({ massBurningFluxInfKgM2S: 0.169, kBetaPerM: 6.1 }),
  lng: Object.freeze({ massBurningFluxInfKgM2S: 0.078, kBetaPerM: 1.1 }),
  lpg: Object.freeze({ massBurningFluxInfKgM2S: 0.099, kBetaPerM: 1.4 }),
  butane: Object.freeze({ massBurningFluxInfKgM2S: 0.078, kBetaPerM: 2.7 }),
  hexane: Object.freeze({ massBurningFluxInfKgM2S: 0.074, kBetaPerM: 1.9 }),
  heptane: Object.freeze({ massBurningFluxInfKgM2S: 0.101, kBetaPerM: 1.1 }),
  benzene: Object.freeze({ massBurningFluxInfKgM2S: 0.085, kBetaPerM: 2.7 }),
  xylene: Object.freeze({ massBurningFluxInfKgM2S: 0.09, kBetaPerM: 1.4 }),
  gasoline: Object.freeze({ massBurningFluxInfKgM2S: 0.055, kBetaPerM: 2.1 }),
  kerosene: Object.freeze({ massBurningFluxInfKgM2S: 0.039, kBetaPerM: 3.5 }),
  'jp-5': Object.freeze({ massBurningFluxInfKgM2S: 0.054, kBetaPerM: 1.6 }),
  methanol: Object.freeze({ massBurningFluxInfKgM2S: 0.015, kBetaPerM: null }),
  ethanol: Object.freeze({ massBurningFluxInfKgM2S: 0.015, kBetaPerM: null }),
});

/**
 * Pool burning flux, kg/(m2 s).
 *
 *   'babrauskas'  m" = m"inf (1 - exp(-k beta D)) (YB 6.66), m"inf and
 *                 k beta from a named fuel (Table 6.5) or given.
 *   'burgess'     m" = 0.001 dHc / (dHv + Cp (Tb - Ta)) (YB 6.67), for a
 *                 single-component liquid below its boiling point; a
 *                 boiling point below ambient is refused (the printed
 *                 form would then shrink the denominator).
 */
export const poolBurningRate = ({
  method, fuel, massBurningFluxInfKgM2S, kBetaPerM, poolDiameterM,
  heatOfCombustionJKg, heatOfVaporisationJKg, liquidHeatCapacityJKgK, boilingPointK, ambientTemperatureK,
} = {}) => {
  if (method === 'babrauskas') {
    let mInf = massBurningFluxInfKgM2S;
    let kb = kBetaPerM;
    if (fuel !== undefined && fuel !== null) {
      const f = ownPreset(POOL_FIRE_FUELS, fuel) ? POOL_FIRE_FUELS[fuel] : undefined;
      if (!f) return refuse('fuel', `must be one of ${Object.keys(POOL_FIRE_FUELS).join(', ')}, or give massBurningFluxInfKgM2S and kBetaPerM`);
      if (mInf !== undefined || kb !== undefined) return refuse('fuel', 'give a named fuel or the two coefficients, not both');
      mInf = f.massBurningFluxInfKgM2S;
      kb = f.kBetaPerM;
    }
    if (!positive(mInf)) return refuse('massBurningFluxInfKgM2S', 'must be a burning flux above 0 kg/(m2 s)');
    if (kb !== null && !positive(kb)) return refuse('kBetaPerM', 'must be above 0 per m, or null for a fuel whose burning rate is independent of diameter');
    if (!positive(poolDiameterM)) return refuse('poolDiameterM', 'must be a pool diameter above 0 m');
    const m = kb === null ? mInf : mInf * (1 - Math.exp(-kb * poolDiameterM));
    return {
      burningFluxKgM2S: m,
      massBurningFluxInfKgM2S: mInf,
      kBetaPerM: kb,
      basis: {
        model: kb === null ? 'm" = m"inf (independent of diameter)' : 'm" = m"inf (1 - exp(-k beta D))',
        source: `${SRC.YB} eq. 6.66, Table 6.5 (Babrauskas 1983)`,
        units: 'kg/(m2 s); per m; m',
      },
    };
  }
  if (method === 'burgess') {
    if (!positive(heatOfCombustionJKg)) return refuse('heatOfCombustionJKg', 'must be above 0 J/kg');
    if (!positive(heatOfVaporisationJKg)) return refuse('heatOfVaporisationJKg', 'must be above 0 J/kg');
    if (!positive(liquidHeatCapacityJKgK)) return refuse('liquidHeatCapacityJKgK', 'must be above 0 J/(kg K)');
    if (!positive(boilingPointK)) return refuse('boilingPointK', 'must be an absolute temperature above 0 K');
    if (!positive(ambientTemperatureK)) return refuse('ambientTemperatureK', 'must be an absolute temperature above 0 K');
    if (boilingPointK < ambientTemperatureK) return refuse('boilingPointK', 'is below ambient: the liquid boils, and the printed Burgess form assumes a liquid heated from ambient to its boiling point');
    const m = (0.001 * heatOfCombustionJKg)
      / (heatOfVaporisationJKg + liquidHeatCapacityJKgK * (boilingPointK - ambientTemperatureK));
    return {
      burningFluxKgM2S: m,
      basis: {
        model: 'Burgess: m" = 0.001 dHc / (dHv + Cp (Tb - Ta))',
        source: `${SRC.YB} eq. 6.67 (Burgess 1974)`,
        units: 'kg/(m2 s); J/kg; J/(kg K); K',
      },
    };
  }
  return refuse('method', "must be 'babrauskas' or 'burgess'");
};

/**
 * Mean flame length of a pool fire, m.
 *
 *   'thomas-still-air'  L = D 42 (m" / (rho_air sqrt(g D)))^0.61, the
 *                       expression engines/facilities/spacing.js uses.
 *   'thomas-wind'       L/D = 55 (m" / (rho_air sqrt(g D)))^0.67 u*^-0.21,
 *                       u* = u10 / uc, uc = (g m" D / rho_air)^(1/3), and
 *                       u* = 1 when u10 < uc (YB 6.12 to 6.14).
 */
export const poolFireFlameLength = ({
  method, poolDiameterM, burningFluxKgM2S, airDensityKgM3 = 1.2, windSpeed10mMS = 0,
} = {}) => {
  if (!positive(poolDiameterM)) return refuse('poolDiameterM', 'must be a pool diameter above 0 m');
  if (!positive(burningFluxKgM2S)) return refuse('burningFluxKgM2S', 'must be a burning flux above 0 kg/(m2 s)');
  if (!positive(airDensityKgM3)) return refuse('airDensityKgM3', 'must be a density above 0 kg/m3');
  if (method === 'thomas-still-air') {
    const L = thomasFlameHeightM({ poolDiameterM, burnRateKgM2S: burningFluxKgM2S, airDensityKgM3 });
    return {
      flameLengthM: L,
      lengthToDiameter: L / poolDiameterM,
      basis: {
        model: 'Thomas (1963), still air: L/D = 42 (m" / (rho_air sqrt(g D)))^0.61',
        source: 'Thomas (1963), via engines/facilities/spacing.js thomasFlameHeightM',
        units: 'm',
      },
    };
  }
  if (method === 'thomas-wind') {
    if (!isNum(windSpeed10mMS) || windSpeed10mMS < 0) return refuse('windSpeed10mMS', 'must be a wind speed of 0 m/s or more');
    const ucMS = (G_M_S2 * burningFluxKgM2S * poolDiameterM / airDensityKgM3) ** (1 / 3);
    const uStar = Math.max(1, windSpeed10mMS / ucMS);
    const ld = 55 * (burningFluxKgM2S / (airDensityKgM3 * Math.sqrt(G_M_S2 * poolDiameterM))) ** 0.67 * uStar ** -0.21;
    return {
      flameLengthM: ld * poolDiameterM,
      lengthToDiameter: ld,
      characteristicWindSpeedMS: ucMS,
      scaledWindSpeed: uStar,
      basis: {
        model: 'Thomas with wind: L/D = 55 (m" / (rho_air sqrt(g D)))^0.67 u*^-0.21, u* = max(1, u10 / uc)',
        source: `${SRC.YB} eqs. 6.12 to 6.14`,
        units: 'm; m/s',
      },
    };
  }
  return refuse('method', "must be 'thomas-still-air' or 'thomas-wind'");
};

/**
 * Pool fire flame tilt from the vertical (YB 6.68 to 6.70):
 * Fr10 = u10^2 / (g D), Re = u10 D / nu, tan(t)/cos(t) = 0.666 Fr^0.333
 * Re^0.117 = c, t = asin((sqrt(4 c^2 + 1) - 1) / (2 c)). No wind, no tilt.
 */
export const poolFireTilt = ({ poolDiameterM, windSpeed10mMS, airKinematicViscosityM2S } = {}) => {
  if (!positive(poolDiameterM)) return refuse('poolDiameterM', 'must be a pool diameter above 0 m');
  if (!isNum(windSpeed10mMS) || windSpeed10mMS < 0) return refuse('windSpeed10mMS', 'must be a wind speed of 0 m/s or more');
  if (!positive(airKinematicViscosityM2S)) return refuse('airKinematicViscosityM2S', 'must be above 0 m2/s (air at 15 C is about 1.5e-5; the YB example prints 7.5133e-6)');
  const basis = {
    model: 'tan(t)/cos(t) = 0.666 Fr10^0.333 Re^0.117; t = asin((sqrt(4c^2 + 1) - 1) / (2c))',
    source: `${SRC.YB} eqs. 6.16, 6.68 to 6.70`,
    units: 'degrees from the vertical',
  };
  if (windSpeed10mMS === 0) return { tiltDeg: 0, froudeNumber: 0, reynoldsNumber: 0, tiltParameter: 0, basis };
  const fr = windSpeed10mMS ** 2 / (G_M_S2 * poolDiameterM);
  const re = (windSpeed10mMS * poolDiameterM) / airKinematicViscosityM2S;
  const c = 0.666 * fr ** 0.333 * re ** 0.117;
  const tiltDeg = (Math.asin((Math.sqrt(4 * c * c + 1) - 1) / (2 * c)) * 180) / Math.PI;
  return { tiltDeg, froudeNumber: fr, reynoldsNumber: re, tiltParameter: c, basis };
};

/**
 * Surface emissive power, W/m2.
 *
 *   'mudan-diameter'           140e3 exp(-0.12 D) + 20e3 (1 - exp(-0.12 D))  (YB 6.19)
 *   'radiative-fraction'       SEPmax = Fs m" dHc / (1 + 4 L/D)              (YB 6.71)
 *   'radiative-fraction-soot'  SEPmax (1 - soot) + SEPsoot soot              (YB 6.20)
 *
 * Fs is the caller's (YB: "ranges between 0.1 and 0.4"); the soot
 * fraction is the caller's (YB: 80 percent for oil products); SEPsoot
 * defaults to the YB's "about 20e3".
 */
export const surfaceEmissivePower = ({
  method, poolDiameterM, radiativeFraction, burningFluxKgM2S, heatOfCombustionJKg, flameLengthM,
  sootFraction, sootEmissivePowerWM2 = 20000,
} = {}) => {
  if (method === 'mudan-diameter') {
    if (!positive(poolDiameterM)) return refuse('poolDiameterM', 'must be a pool diameter above 0 m');
    const e = Math.exp(-0.12 * poolDiameterM);
    return {
      surfaceEmissivePowerWM2: 140e3 * e + 20e3 * (1 - e),
      basis: { model: 'Mudan: SEP = 140e3 exp(-0.12 D) + 20e3 (1 - exp(-0.12 D))', source: `${SRC.YB} eq. 6.19`, units: 'W/m2' },
    };
  }
  if (method === 'radiative-fraction' || method === 'radiative-fraction-soot') {
    if (!positive(radiativeFraction) || radiativeFraction > 1) return refuse('radiativeFraction', 'must lie in (0, 1]: the YB gives 0.1 to 0.4');
    if (!positive(burningFluxKgM2S)) return refuse('burningFluxKgM2S', 'must be a burning flux above 0 kg/(m2 s)');
    if (!positive(heatOfCombustionJKg)) return refuse('heatOfCombustionJKg', 'must be above 0 J/kg');
    if (!positive(flameLengthM)) return refuse('flameLengthM', 'must be a flame length above 0 m');
    if (!positive(poolDiameterM)) return refuse('poolDiameterM', 'must be a pool diameter above 0 m');
    const sepMax = (radiativeFraction * burningFluxKgM2S * heatOfCombustionJKg) / (1 + (4 * flameLengthM) / poolDiameterM);
    if (method === 'radiative-fraction') {
      return {
        surfaceEmissivePowerWM2: sepMax,
        basis: { model: 'SEPmax = Fs m" dHc / (1 + 4 L/D)', source: `${SRC.YB} eq. 6.71`, units: 'W/m2' },
      };
    }
    if (!isNum(sootFraction) || sootFraction < 0 || sootFraction > 1) return refuse('sootFraction', 'must lie in [0, 1] (the YB quotes 0.8 for oil products)');
    if (!positive(sootEmissivePowerWM2)) return refuse('sootEmissivePowerWM2', 'must be above 0 W/m2');
    return {
      surfaceEmissivePowerWM2: sepMax * (1 - sootFraction) + sootEmissivePowerWM2 * sootFraction,
      clearFlameEmissivePowerWM2: sepMax,
      basis: { model: 'SEPact = SEPmax (1 - soot) + SEPsoot soot, SEPmax = Fs m" dHc / (1 + 4 L/D)', source: `${SRC.YB} eqs. 6.20, 6.71`, units: 'W/m2' },
    };
  }
  return refuse('method', "must be 'mudan-diameter', 'radiative-fraction' or 'radiative-fraction-soot'");
};

/**
 * Geometric view factor from a (tilted) cylindrical flame to a small
 * target at ground level, a distance X from the centre of the flame base
 * (Mudan, YB 6.A.14, 6.A.15; at zero tilt these are Raj's 6.A.10, 6.A.11):
 *
 *   a = L/R, b = X/R, tilt t from the vertical, positive toward the target
 *   A = sqrt(a^2 + (b+1)^2 - 2a(b+1) sin t), B = sqrt(a^2 + (b-1)^2 - 2a(b-1) sin t)
 *   C = sqrt(1 + (b^2 - 1) cos^2 t), D = sqrt((b-1)/(b+1))
 *   E = a cos t / (b - a sin t), F = sqrt(b^2 - 1)
 *   pi Fv = -E atan D + E (a^2 + (b+1)^2 - 2b(1 + a sin t))/(AB) atan(AD/B)
 *           + (cos t / C) [atan((ab - F^2 sin t)/(FC)) + atan(F sin t / C)]
 *   pi Fh = atan(1/D) + (sin t / C) [same two arctangents]
 *           - (a^2 + (b+1)^2 - 2(b + 1 + ab sin t))/(AB) atan(AD/B)
 *   Fmax = sqrt(Fv^2 + Fh^2)  (YB 6.A.18)
 *
 * Refused: a target at or inside the flame base (X <= R), and a flame
 * whose tilted edge reaches over the target's vertical plane (1 + a sin t
 * >= b). There the closed form counts flame surface behind the target as
 * seen, and the numerical integration in the oracle shows Fv wrong.
 */
export const cylinderViewFactor = ({ flameRadiusM, flameLengthM, distanceFromAxisM, tiltDeg = 0 } = {}) => {
  if (!positive(flameRadiusM)) return refuse('flameRadiusM', 'must be a flame radius above 0 m');
  if (!positive(flameLengthM)) return refuse('flameLengthM', 'must be a flame length above 0 m');
  if (!positive(distanceFromAxisM)) return refuse('distanceFromAxisM', 'must be a distance above 0 m from the centre of the flame base');
  if (!isNum(tiltDeg) || !(Math.abs(tiltDeg) < 90)) return refuse('tiltDeg', 'must lie strictly between -90 and 90 degrees from the vertical');
  const a = flameLengthM / flameRadiusM;
  const b = distanceFromAxisM / flameRadiusM;
  if (!(b > 1)) return refuse('distanceFromAxisM', 'the target is at or inside the flame base: a view factor model needs the target outside the flame');
  const t = (tiltDeg * Math.PI) / 180;
  const s = Math.sin(t);
  const co = Math.cos(t);
  if (1 + a * s >= b) {
    return refuse('tiltDeg', 'the tilted flame reaches over the target (1 + (L/R) sin(tilt) >= X/R): the closed form does not apply to a target under the flame');
  }
  const A = Math.sqrt(a * a + (b + 1) ** 2 - 2 * a * (b + 1) * s);
  const B = Math.sqrt(a * a + (b - 1) ** 2 - 2 * a * (b - 1) * s);
  const C = Math.sqrt(1 + (b * b - 1) * co * co);
  const D = Math.sqrt((b - 1) / (b + 1));
  const E = (a * co) / (b - a * s);
  const F = Math.sqrt(b * b - 1);
  const arcs = Math.atan((a * b - F * F * s) / (F * C)) + Math.atan((F * s) / C);
  const atanADB = Math.atan((A * D) / B);
  const fv = (-E * Math.atan(D) + E * ((a * a + (b + 1) ** 2 - 2 * b * (1 + a * s)) / (A * B)) * atanADB + (co / C) * arcs) / Math.PI;
  const fh = (Math.atan(1 / D) + (s / C) * arcs - ((a * a + (b + 1) ** 2 - 2 * (b + 1 + a * b * s)) / (A * B)) * atanADB) / Math.PI;
  return {
    viewFactorVertical: fv,
    viewFactorHorizontal: fh,
    viewFactorMax: Math.sqrt(fv * fv + fh * fh),
    a,
    b,
    basis: {
      model: tiltDeg === 0
        ? 'vertical cylinder view factor (Raj), target at ground level, vertical and horizontal planes; Fmax their vector sum'
        : 'tilted cylinder view factor (Mudan), target at ground level; Fmax the vector sum of Fv and Fh',
      source: `${SRC.YB} Appendix 6.1, eqs. 6.A.10, 6.A.11, 6.A.14, 6.A.15, 6.A.18`,
      units: 'dimensionless; a = L/R, b = X/R',
    },
  };
};

/** Bagster (1989) transmissivity range, pw x in N/m (YB 6.29). */
export const BAGSTER_RANGE_PA_M = Object.freeze({ min: 1e4, max: 1e5 });

/**
 * Atmospheric transmissivity, Bagster's fit (YB 6.29):
 * tau = 2.02 (pw x)^-0.09, pw the partial pressure of water vapour (Pa)
 * and x the path length from the flame SURFACE to the target (m). The YB:
 * "This formula can only be used ... between 1e4 < pw x < 1e5 N/m. In all
 * other cases it is not advised". Outside that range this refuses; the
 * caller then supplies a transmissivity (the YB reads it from Hottel's
 * charts, Figure 6.4).
 */
export const atmosphericTransmissivityBagster = ({ waterVapourPartialPressurePa, pathLengthM } = {}) => {
  if (!positive(waterVapourPartialPressurePa)) return refuse('waterVapourPartialPressurePa', 'must be a partial pressure above 0 Pa (relative humidity times the saturation pressure)');
  if (!positive(pathLengthM)) return refuse('pathLengthM', 'must be a path length above 0 m from the flame surface');
  const p = waterVapourPartialPressurePa * pathLengthM;
  if (p < BAGSTER_RANGE_PA_M.min || p > BAGSTER_RANGE_PA_M.max) {
    return refuse('pathLengthM', 'pw x lies outside 1e4 to 1e5 N/m, where the YB advises against the Bagster fit: supply a transmissivity from another source');
  }
  return {
    transmissivity: 2.02 * p ** -0.09,
    waterVapourPathProductPaM: p,
    basis: { model: 'Bagster: tau = 2.02 (pw x)^-0.09, valid 1e4 < pw x < 1e5 N/m', source: `${SRC.YB} eq. 6.29`, units: 'dimensionless; Pa; m' },
  };
};

/** q" = SEP x Fview x tau (YB 6.4). */
export const solidFlameHeatFlux = ({ surfaceEmissivePowerWM2, viewFactor, transmissivity } = {}) => {
  if (!positive(surfaceEmissivePowerWM2)) return refuse('surfaceEmissivePowerWM2', 'must be above 0 W/m2');
  if (!isNum(viewFactor) || viewFactor < 0 || viewFactor > 1) return refuse('viewFactor', 'must lie in [0, 1]');
  if (!positive(transmissivity) || transmissivity > 1) return refuse('transmissivity', 'must lie in (0, 1]');
  return {
    heatFluxWM2: surfaceEmissivePowerWM2 * viewFactor * transmissivity,
    basis: { model: 'solid flame: q = SEP x F x tau', source: `${SRC.YB} eq. 6.4`, units: 'W/m2' },
  };
};

/**
 * A confined pool fire end to end, solid flame model: burning flux, flame
 * length, tilt, SEP, view factor at a distance from the pool centre,
 * transmissivity and heat flux on the most exposed target orientation
 * (Fmax). The flame radius is D/2 (no wind elongation of the base).
 *
 *   flameLengthMethod     'thomas-still-air' | 'thomas-wind'
 *   sep                   { method, radiativeFraction?, sootFraction?, sootEmissivePowerWM2? }
 *   windSpeed10mMS        > 0 tilts the flame (needs airKinematicViscosityM2S)
 *   transmissivity        given, or computed by Bagster from
 *                         waterVapourPartialPressurePa along x = X - D/2
 */
export const poolFireSolidFlame = ({
  poolDiameterM, burningFluxKgM2S, heatOfCombustionJKg, flameLengthMethod = 'thomas-still-air',
  airDensityKgM3 = 1.2, windSpeed10mMS = 0, airKinematicViscosityM2S, sep = {},
  distanceFromCentreM, transmissivity, waterVapourPartialPressurePa,
} = {}) => {
  const L = poolFireFlameLength({ method: flameLengthMethod, poolDiameterM, burningFluxKgM2S, airDensityKgM3, windSpeed10mMS });
  if (L.error) return L;
  let tiltDeg = 0;
  let tilt = null;
  if (isNum(windSpeed10mMS) && windSpeed10mMS > 0) {
    tilt = poolFireTilt({ poolDiameterM, windSpeed10mMS, airKinematicViscosityM2S });
    if (tilt.error) return tilt;
    tiltDeg = tilt.tiltDeg;
  }
  const e = surfaceEmissivePower({
    ...sep, poolDiameterM, burningFluxKgM2S, heatOfCombustionJKg, flameLengthM: L.flameLengthM,
  });
  if (e.error) return e;
  const vf = cylinderViewFactor({
    flameRadiusM: poolDiameterM / 2, flameLengthM: L.flameLengthM, distanceFromAxisM: distanceFromCentreM, tiltDeg,
  });
  if (vf.error) return vf;
  let tau = transmissivity;
  let tauBasis = 'given';
  if (tau === undefined || tau === null) {
    const t = atmosphericTransmissivityBagster({ waterVapourPartialPressurePa, pathLengthM: distanceFromCentreM - poolDiameterM / 2 });
    if (t.error) return t;
    tau = t.transmissivity;
    tauBasis = t.basis.model;
  }
  const q = solidFlameHeatFlux({ surfaceEmissivePowerWM2: e.surfaceEmissivePowerWM2, viewFactor: vf.viewFactorMax, transmissivity: tau });
  if (q.error) return q;
  return {
    heatFluxWM2: q.heatFluxWM2,
    flameLengthM: L.flameLengthM,
    tiltDeg,
    surfaceEmissivePowerWM2: e.surfaceEmissivePowerWM2,
    viewFactorVertical: vf.viewFactorVertical,
    viewFactorHorizontal: vf.viewFactorHorizontal,
    viewFactorMax: vf.viewFactorMax,
    transmissivity: tau,
    basis: {
      model: 'solid flame pool fire: q = SEP x Fmax x tau, cylinder of radius D/2 and the computed length and tilt',
      source: `${SRC.YB} section 6.5.4 and Appendix 6.1`,
      flameLength: L.basis.model,
      tilt: tilt ? tilt.basis.model : 'no wind, vertical flame',
      surfaceEmissivePower: e.basis.model,
      transmissivity: tauBasis,
      units: 'W/m2; m; degrees',
    },
  };
};

/**
 * The distance from the pool centre at which the solid-flame heat flux
 * (Fmax) falls to a target, by bisection. The transmissivity must be
 * GIVEN (a fixed value): the Bagster fit is only valid over a band of
 * path lengths, which a root search would walk out of.
 */
export const solidFlameDistanceForHeatFlux = ({ targetHeatFluxWM2, maxDistanceM = 10000, ...args } = {}) => {
  if (!positive(targetHeatFluxWM2)) return refuse('targetHeatFluxWM2', 'must be a heat flux above 0 W/m2');
  if (!positive(args.transmissivity) || args.transmissivity > 1) return refuse('transmissivity', 'a fixed transmissivity in (0, 1] is required for a distance search');
  if (!positive(args.poolDiameterM)) return refuse('poolDiameterM', 'must be a pool diameter above 0 m');
  const R = args.poolDiameterM / 2;
  const at = (x) => poolFireSolidFlame({ ...args, distanceFromCentreM: x });
  const far = at(maxDistanceM);
  if (far.error) return far;
  // The nearest admissible distance: just outside the base, or just past
  // the overhang of a tilted flame.
  const L0 = at(maxDistanceM);
  const reach = R + L0.flameLengthM * Math.max(0, Math.sin((L0.tiltDeg * Math.PI) / 180));
  const lo = reach * (1 + 1e-9);
  const near = at(lo);
  if (near.error) return near;
  const basis = {
    model: 'bisection on the solid-flame heat flux (Fmax, fixed transmissivity) against distance from the pool centre',
    source: `${SRC.YB} eq. 6.4 and Appendix 6.1`,
    units: 'm; W/m2',
  };
  if (near.heatFluxWM2 < targetHeatFluxWM2) {
    return { state: 'NOT_REACHED', distanceFromCentreM: null, maxHeatFluxWM2: near.heatFluxWM2, basis };
  }
  if (far.heatFluxWM2 > targetHeatFluxWM2) {
    return { state: 'BEYOND_SEARCH_RANGE', distanceFromCentreM: null, basis };
  }
  const x = bisect((d) => at(d).heatFluxWM2 - targetHeatFluxWM2, lo, maxDistanceM);
  return { state: 'REACHED', distanceFromCentreM: x, distanceFromEdgeM: x - R, basis };
};

/* ------------------------------------------------------------------ */
/* 4. Explosions                                                       */
/* ------------------------------------------------------------------ */

/**
 * TNT equivalent mass (YB 5.1): Q_TNT = alpha_e Qf Emf / Em_TNT. The TNT
 * blast energy is the caller's: the YB notes values "currently in use
 * range from 4.19 to 4.65 MJ/kg", and other texts use 4.68 to 4.69; a
 * value outside 4.0 to 5.0 MJ/kg is refused as a units slip.
 */
export const tntEquivalentMass = ({ fuelMassKg, heatOfCombustionJKg, yieldFactor, tntBlastEnergyJKg } = {}) => {
  if (!positive(fuelMassKg)) return refuse('fuelMassKg', 'must be a fuel mass above 0 kg');
  if (!positive(heatOfCombustionJKg)) return refuse('heatOfCombustionJKg', 'must be above 0 J/kg');
  if (!positive(yieldFactor) || yieldFactor > 1) return refuse('yieldFactor', 'the TNT equivalency (yield) must lie in (0, 1]: the YB reports 0.02 to 0.2 in use');
  if (!isNum(tntBlastEnergyJKg) || tntBlastEnergyJKg < 4.0e6 || tntBlastEnergyJKg > 5.0e6) {
    return refuse('tntBlastEnergyJKg', 'must be the TNT blast energy in J/kg, between 4.0e6 and 5.0e6 (the YB cites 4.19e6 to 4.65e6)');
  }
  return {
    tntMassKg: (yieldFactor * fuelMassKg * heatOfCombustionJKg) / tntBlastEnergyJKg,
    basis: { model: 'Q_TNT = alpha_e Qf Emf / Em_TNT', source: `${SRC.YB} eq. 5.1`, units: 'kg; J/kg' },
  };
};

/** Hopkinson-Cranz scaled distance Z = R / W^(1/3), m/kg^(1/3). */
export const scaledDistance = ({ distanceM, tntMassKg } = {}) => {
  if (!positive(distanceM)) return refuse('distanceM', 'must be a distance above 0 m');
  if (!positive(tntMassKg)) return refuse('tntMassKg', 'must be a TNT mass above 0 kg');
  return {
    scaledDistanceMKg13: distanceM / Math.cbrt(tntMassKg),
    basis: { model: 'Hopkinson-Cranz cube-root scaling, Z = R / W^(1/3)', source: 'Hopkinson (1915), Cranz (1926); Kinney and Graham (1985)', units: 'm/kg^(1/3)' },
  };
};

/**
 * The range of Z over which the Kinney and Graham fit is used here, m/kg^(1/3).
 * A JUDGEMENT (see findings): the fit's own printed range was not
 * available; this is the span of the Kingery-Bulmash TNT compilation.
 */
export const KINNEY_GRAHAM_Z_RANGE = Object.freeze({ min: 0.05, max: 40 });

const kgRatio = (z) => (808 * (1 + (z / 4.5) ** 2))
  / (Math.sqrt(1 + (z / 0.048) ** 2) * Math.sqrt(1 + (z / 0.32) ** 2) * Math.sqrt(1 + (z / 1.35) ** 2));

/**
 * Peak side-on overpressure of a free-air TNT burst, Kinney and Graham:
 *
 *   ps / pa = 808 [1 + (Z/4.5)^2] / (sqrt(1 + (Z/0.048)^2) sqrt(1 + (Z/0.32)^2) sqrt(1 + (Z/1.35)^2))
 *
 * Give Z, or a distance and a TNT mass. Refused outside
 * KINNEY_GRAHAM_Z_RANGE. A surface (hemispherical) burst is NOT modelled:
 * that is the caller's choice of charge weight.
 */
export const kinneyGrahamOverpressure = ({ scaledDistanceMKg13, distanceM, tntMassKg, ambientPressurePa = ATM_PA } = {}) => {
  let z = scaledDistanceMKg13;
  if (z === undefined || z === null) {
    const s = scaledDistance({ distanceM, tntMassKg });
    if (s.error) return s;
    z = s.scaledDistanceMKg13;
  } else if (distanceM !== undefined || tntMassKg !== undefined) {
    return refuse('scaledDistanceMKg13', 'give Z, or a distance and a TNT mass, not both');
  }
  if (!positive(z)) return refuse('scaledDistanceMKg13', 'must be a scaled distance above 0 m/kg^(1/3)');
  if (!positive(ambientPressurePa)) return refuse('ambientPressurePa', 'must be an absolute pressure above 0 Pa');
  if (z < KINNEY_GRAHAM_Z_RANGE.min || z > KINNEY_GRAHAM_Z_RANGE.max) {
    return refuse('scaledDistanceMKg13', 'Z lies outside 0.05 to 40 m/kg^(1/3), the range this fit is used over');
  }
  const ratio = kgRatio(z);
  return {
    scaledDistanceMKg13: z,
    overpressureRatio: ratio,
    overpressurePa: ratio * ambientPressurePa,
    basis: {
      model: 'Kinney and Graham free-air peak side-on overpressure, ps/pa = 808[1+(Z/4.5)^2] / (sqrt(1+(Z/0.048)^2) sqrt(1+(Z/0.32)^2) sqrt(1+(Z/1.35)^2))',
      source: SRC.KG,
      validRange: 'Z in [0.05, 40] m/kg^(1/3) (judgement; see findings)',
      units: 'Pa; m/kg^(1/3)',
    },
  };
};

/** The distance at which a TNT mass gives a peak side-on overpressure (Kinney and Graham), m. */
export const distanceForOverpressure = ({ tntMassKg, overpressurePa, ambientPressurePa = ATM_PA } = {}) => {
  if (!positive(tntMassKg)) return refuse('tntMassKg', 'must be a TNT mass above 0 kg');
  if (!positive(overpressurePa)) return refuse('overpressurePa', 'must be an overpressure above 0 Pa');
  if (!positive(ambientPressurePa)) return refuse('ambientPressurePa', 'must be an absolute pressure above 0 Pa');
  const target = overpressurePa / ambientPressurePa;
  const hi = kgRatio(KINNEY_GRAHAM_Z_RANGE.min);
  const lo = kgRatio(KINNEY_GRAHAM_Z_RANGE.max);
  if (target > hi || target < lo) {
    return refuse('overpressurePa', 'lies outside the overpressures the fit gives over Z = 0.05 to 40 m/kg^(1/3)');
  }
  const z = bisect((zz) => kgRatio(zz) - target, KINNEY_GRAHAM_Z_RANGE.min, KINNEY_GRAHAM_Z_RANGE.max);
  return {
    scaledDistanceMKg13: z,
    distanceM: z * Math.cbrt(tntMassKg),
    basis: { model: 'inverse of the Kinney and Graham fit by bisection on Z', source: SRC.KG, units: 'm; m/kg^(1/3)' },
  };
};

/* ------------------------------------------------------------------ */
/* 5. Probits                                                          */
/* ------------------------------------------------------------------ */

/** P = Phi(Y - 5) (PB eqs. 5.1, 5.2; PB Table 5.1). */
export const probitToProbability = (probit) => {
  if (!isNum(probit)) return refuse('probit', 'must be a finite number');
  return {
    probability: normalCDF(probit - 5),
    basis: { model: 'P = Phi(Y - 5), standard normal CDF (lib/stats normalCDF, Abramowitz and Stegun 7.1.26, |error| <= 1.5e-7)', source: `${SRC.PB} section 5.2.1, Table 5.1`, units: 'probability' },
  };
};

/** Y such that Phi(Y - 5) = P, by bisection on the same CDF. */
export const probabilityToProbit = (probability) => {
  if (!isNum(probability) || !(probability > 0) || !(probability < 1)) return refuse('probability', 'must lie strictly between 0 and 1');
  const y = bisect((v) => normalCDF(v - 5) - probability, -5, 15, 1e-14);
  return {
    probit: y,
    basis: { model: 'Y = 5 + Phi^-1(P), inverted by bisection', source: `${SRC.PB} section 5.2.1, Table 5.1`, units: 'probit' },
  };
};

/**
 * Thermal radiation lethality probits, Y = a + b ln(V), V = t I^(4/3).
 * `intensityUnit` is the unit of I in V as each source prints it.
 */
export const THERMAL_PROBITS = Object.freeze({
  eisenberg: Object.freeze({ a: -14.9, b: 2.56, intensityUnit: 'kW/m2', source: `${SRC.OSD} Table 17: Eisenberg et al. (1975); equivalently -14.9 + 2.56 ln(t q^(4/3) / 1e4) with q in W/m2` }),
  'tsao-perry': Object.freeze({ a: -12.8, b: 2.56, intensityUnit: 'kW/m2', source: `${SRC.OSD} Table 17: Tsao and Perry (1979)` }),
  lees: Object.freeze({ a: -10.7, b: 1.99, intensityUnit: 'kW/m2', source: `${SRC.OSD} Table 17: Lees (1994)` }),
  'purple-book': Object.freeze({ a: -36.38, b: 2.56, intensityUnit: 'W/m2', source: `${SRC.PB} eq. 5.4` }),
});

/**
 * Toxic lethality probits, Y = a + b ln(C^n t), t in minutes, C in the
 * preset's unit. Purple Book Table 5.2 (mg/m3); Lees (2005) via OSD/30
 * Table 2 (ppm), each kept only where the source's own LC1/LC50 columns
 * reproduce (findings).
 */
export const TOXIC_PROBITS = Object.freeze({
  'pb-acrolein': Object.freeze({ a: -4.1, b: 1, n: 1, unit: 'mg/m3' }),
  'pb-acrylonitrile': Object.freeze({ a: -8.6, b: 1, n: 1.3, unit: 'mg/m3' }),
  'pb-allyl-alcohol': Object.freeze({ a: -11.7, b: 1, n: 2, unit: 'mg/m3' }),
  'pb-ammonia': Object.freeze({ a: -15.6, b: 1, n: 2, unit: 'mg/m3' }),
  'pb-azinphos-methyl': Object.freeze({ a: -4.8, b: 1, n: 2, unit: 'mg/m3' }),
  'pb-bromine': Object.freeze({ a: -12.4, b: 1, n: 2, unit: 'mg/m3' }),
  'pb-carbon-monoxide': Object.freeze({ a: -7.4, b: 1, n: 1, unit: 'mg/m3' }),
  'pb-chlorine': Object.freeze({ a: -6.35, b: 0.5, n: 2.75, unit: 'mg/m3' }),
  'pb-ethylene-oxide': Object.freeze({ a: -6.8, b: 1, n: 1, unit: 'mg/m3' }),
  'pb-hydrogen-chloride': Object.freeze({ a: -37.3, b: 3.69, n: 1, unit: 'mg/m3' }),
  'pb-hydrogen-cyanide': Object.freeze({ a: -9.8, b: 1, n: 2.4, unit: 'mg/m3' }),
  'pb-hydrogen-fluoride': Object.freeze({ a: -8.4, b: 1, n: 1.5, unit: 'mg/m3' }),
  'pb-hydrogen-sulfide': Object.freeze({ a: -11.5, b: 1, n: 1.9, unit: 'mg/m3' }),
  'pb-methyl-bromide': Object.freeze({ a: -7.3, b: 1, n: 1.1, unit: 'mg/m3' }),
  'pb-methyl-isocyanate': Object.freeze({ a: -1.2, b: 1, n: 0.7, unit: 'mg/m3' }),
  'pb-nitrogen-dioxide': Object.freeze({ a: -18.6, b: 1, n: 3.7, unit: 'mg/m3' }),
  'pb-parathion': Object.freeze({ a: -6.6, b: 1, n: 2, unit: 'mg/m3' }),
  'pb-phosgene': Object.freeze({ a: -10.6, b: 2, n: 1, unit: 'mg/m3' }),
  'pb-phosphamidon': Object.freeze({ a: -2.8, b: 1, n: 0.7, unit: 'mg/m3' }),
  'pb-phosphine': Object.freeze({ a: -6.8, b: 1, n: 2, unit: 'mg/m3' }),
  'pb-sulphur-dioxide': Object.freeze({ a: -19.2, b: 1, n: 2.4, unit: 'mg/m3' }),
  'pb-tetraethyllead': Object.freeze({ a: -9.8, b: 1, n: 2, unit: 'mg/m3' }),
  'lees-acrolein': Object.freeze({ a: -9.93, b: 2.05, n: 1, unit: 'ppm' }),
  'lees-ammonia': Object.freeze({ a: -35.9, b: 1.85, n: 2, unit: 'ppm' }),
  'lees-benzene': Object.freeze({ a: -109.78, b: 5.3, n: 2, unit: 'ppm' }),
  'lees-carbon-monoxide': Object.freeze({ a: -37.98, b: 3.7, n: 1, unit: 'ppm' }),
  'lees-chlorine': Object.freeze({ a: -8.29, b: 0.92, n: 2, unit: 'ppm' }),
  'lees-hydrogen-chloride': Object.freeze({ a: -16.85, b: 2, n: 1, unit: 'ppm' }),
  'lees-hydrogen-sulphide': Object.freeze({ a: -31.42, b: 3.008, n: 1.43, unit: 'ppm' }),
  'lees-nitrogen-dioxide': Object.freeze({ a: -13.79, b: 1.4, n: 2, unit: 'ppm' }),
  'lees-phosgene': Object.freeze({ a: -19.27, b: 3.686, n: 1, unit: 'ppm' }),
  'lees-sulphur-dioxide': Object.freeze({ a: -15.67, b: 2.1, n: 1, unit: 'ppm' }),
  'lees-toluene': Object.freeze({ a: -6.794, b: 0.41, n: 2.5, unit: 'ppm' }),
  'lees-hydrogen-fluoride': Object.freeze({ a: -35.87, b: 3.354, n: 1, unit: 'ppm' }),
  'lees-hydrogen-cyanide': Object.freeze({ a: -29.42, b: 3.008, n: 1.43, unit: 'ppm' }),
});

/** Blast overpressure fatality, Y = a + b ln(P), P in psig (HSC, via OSD/30 eq. 4a). */
export const OVERPRESSURE_PROBITS = Object.freeze({
  hsc: Object.freeze({ a: 1.47, b: 1.37, unit: 'psig', source: `${SRC.OSD} Equation 4a (HSC road and rail study)` }),
});

const coefficients = (spec, table, field) => {
  if (typeof spec === 'string') {
    const c = table[spec];
    if (!c) return refuse(field, `unknown preset '${spec}'; one of ${Object.keys(table).join(', ')}, or give { a, b } explicitly`);
    return { ...c, preset: spec };
  }
  if (!spec || typeof spec !== 'object') return refuse(field, 'a preset name or { a, b } coefficients are required');
  if (!isNum(spec.a)) return refuse(`${field}.a`, 'must be a finite number');
  if (!positive(spec.b)) return refuse(`${field}.b`, 'must be above 0 (a probit rises with the dose)');
  return { ...spec, preset: null };
};

/** Y = a + b ln(V), with P = Phi(Y - 5). */
export const probit = ({ a, b, dose } = {}) => {
  if (!isNum(a)) return refuse('a', 'must be a finite number');
  if (!positive(b)) return refuse('b', 'must be above 0');
  if (!positive(dose)) return refuse('dose', 'must be above 0: ln(0) has no probit');
  const y = a + b * Math.log(dose);
  return {
    probit: y,
    probability: normalCDF(y - 5),
    basis: { model: 'Y = a + b ln(V); P = Phi(Y - 5)', source: `${SRC.PB} section 5.2.1`, units: 'probit; probability' },
  };
};

/** The dose V at which the probit gives P: V = exp((5 + Phi^-1(P) - a) / b). */
export const probitDoseForProbability = ({ a, b, probability } = {}) => {
  if (!isNum(a)) return refuse('a', 'must be a finite number');
  if (!positive(b)) return refuse('b', 'must be above 0');
  const y = probabilityToProbit(probability);
  if (y.error) return y;
  return {
    dose: Math.exp((y.probit - a) / b),
    probit: y.probit,
    basis: { model: 'V = exp((Y - a) / b), Y = 5 + Phi^-1(P)', source: `${SRC.PB} section 5.2.1`, units: 'the dose unit of the coefficients' },
  };
};

/** Thermal radiation probit: V = t I^(4/3), I in the preset's unit. */
export const thermalProbit = ({ coefficients: spec = 'eisenberg', heatFluxWM2, exposureTimeS } = {}) => {
  const c = coefficients(spec, THERMAL_PROBITS, 'coefficients');
  if (c.error) return c;
  const unit = c.intensityUnit || 'W/m2';
  if (unit !== 'W/m2' && unit !== 'kW/m2') return refuse('coefficients.intensityUnit', "must be 'W/m2' or 'kW/m2'");
  if (!positive(heatFluxWM2)) return refuse('heatFluxWM2', 'must be a heat flux above 0 W/m2');
  if (!positive(exposureTimeS)) return refuse('exposureTimeS', 'must be an exposure time above 0 s');
  const I = unit === 'kW/m2' ? heatFluxWM2 / 1000 : heatFluxWM2;
  const dose = exposureTimeS * I ** (4 / 3);
  const p = probit({ a: c.a, b: c.b, dose });
  return {
    ...p,
    dose,
    doseUnit: `s (${unit})^(4/3)`,
    basis: { ...p.basis, model: 'Y = a + b ln(t I^(4/3))', preset: c.preset, source: c.source || 'coefficients as given' },
  };
};

/**
 * Toxic dose D = sum(C_i^n dt_i) over a concentration history
 * [{ concentration, minutes }] in one unit, or C^n t for a constant C.
 */
export const toxicDose = ({ n, history } = {}) => {
  if (!positive(n)) return refuse('n', 'the toxic load exponent must be above 0');
  if (!Array.isArray(history) || history.length === 0) return refuse('history', 'must be a non-empty list of { concentration, minutes }');
  let dose = 0;
  for (let i = 0; i < history.length; i += 1) {
    const h = history[i] || {};
    if (!isNum(h.concentration) || h.concentration < 0) return refuse(`history[${i}].concentration`, 'must be 0 or more');
    if (!positive(h.minutes)) return refuse(`history[${i}].minutes`, 'must be a duration above 0 min');
    dose += h.concentration ** n * h.minutes;
  }
  return { dose, basis: { model: 'D = sum(C^n dt)', source: `${SRC.PB} section 5.2.2 note 2`, units: 'C^n min' } };
};

/**
 * Toxic probit Y = a + b ln(C^n t). The concentration is given in ppm or
 * mg/m3; when that is not the preset's unit it is converted at the
 * stated T and P, which needs the molar mass.
 */
export const toxicProbit = ({
  coefficients: spec, concentrationPpm, concentrationMgM3, exposureMinutes,
  molarMassGMol, temperatureK = 298.15, pressurePa = ATM_PA,
} = {}) => {
  const c = coefficients(spec, TOXIC_PROBITS, 'coefficients');
  if (c.error) return c;
  if (!positive(c.n)) return refuse('coefficients.n', 'the toxic load exponent n must be above 0');
  if (c.unit !== 'ppm' && c.unit !== 'mg/m3') return refuse('coefficients.unit', "must be 'ppm' or 'mg/m3'");
  const hasPpm = concentrationPpm !== undefined && concentrationPpm !== null;
  const hasMg = concentrationMgM3 !== undefined && concentrationMgM3 !== null;
  if (hasPpm === hasMg) return refuse('concentrationPpm', 'give exactly one of concentrationPpm and concentrationMgM3');
  if (!positive(exposureMinutes)) return refuse('exposureMinutes', 'must be an exposure time above 0 min');
  let C;
  if (hasPpm) {
    if (!positive(concentrationPpm)) return refuse('concentrationPpm', 'must be above 0 ppm');
    if (c.unit === 'ppm') C = concentrationPpm;
    else {
      const m = ppmToMgM3({ concentrationPpm, molarMassGMol, temperatureK, pressurePa });
      if (m.error) return m;
      C = m.concentrationMgM3;
    }
  } else {
    if (!positive(concentrationMgM3)) return refuse('concentrationMgM3', 'must be above 0 mg/m3');
    if (c.unit === 'mg/m3') C = concentrationMgM3;
    else {
      const m = mgM3ToPpm({ concentrationMgM3, molarMassGMol, temperatureK, pressurePa });
      if (m.error) return m;
      C = m.concentrationPpm;
    }
  }
  const dose = C ** c.n * exposureMinutes;
  const p = probit({ a: c.a, b: c.b, dose });
  return {
    ...p,
    dose,
    concentrationInPresetUnit: C,
    doseUnit: `(${c.unit})^${c.n} min`,
    basis: {
      ...p.basis,
      model: 'Y = a + b ln(C^n t), t in minutes',
      preset: c.preset,
      source: c.preset && c.preset.startsWith('pb-') ? `${SRC.PB} eq. 5.3, Table 5.2`
        : (c.preset ? `${SRC.OSD} Table 2 (Lees 2005)` : 'coefficients as given'),
    },
  };
};

/** Overpressure fatality probit, Y = a + b ln(P), P in the preset's unit. */
export const overpressureProbit = ({ coefficients: spec = 'hsc', overpressurePa } = {}) => {
  const c = coefficients(spec, OVERPRESSURE_PROBITS, 'coefficients');
  if (c.error) return c;
  if (!positive(overpressurePa)) return refuse('overpressurePa', 'must be an overpressure above 0 Pa');
  const unit = c.unit || 'Pa';
  let P;
  if (unit === 'psig') P = overpressurePa / PA_PER_PSI;
  else if (unit === 'barg') P = overpressurePa / 1e5;
  else if (unit === 'Pa') P = overpressurePa;
  else return refuse('coefficients.unit', "must be 'psig', 'barg' or 'Pa'");
  const p = probit({ a: c.a, b: c.b, dose: P });
  return {
    ...p,
    overpressureInPresetUnit: P,
    basis: { ...p.basis, model: `Y = a + b ln(P), P in ${unit}`, preset: c.preset, source: c.source || 'coefficients as given' },
  };
};
