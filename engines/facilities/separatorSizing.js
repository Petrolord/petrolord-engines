/**
 * Separator and slug catcher vessel sizing (Facilities F5).
 *
 * Mechanical sizing to the API 12J / GPSA method, which is a different
 * question from the flash train in engines/fluid/separator.js: that
 * one says what leaves each stage, this one says how big the vessel
 * must be to let it separate.
 *
 * The predecessor Suite app got the shape of this right and the detail
 * wrong: it hardcoded z = 0.85, used one K for all pressures, sized
 * only two-phase vertical/horizontal, and computed its gas velocity
 * from the PREVIOUS render's diameter. Here:
 *  - z comes from the DAK correlation, inside its validity range only
 *  - K carries the published pressure derating and the mist-extractor
 *    type, and stays overridable
 *  - three-phase sizing places the oil-water interface at its exact
 *    height and checks both dispersed droplets in the sized vessel
 *  - horizontal vessels are sized by the gas-space geometry at the
 *    actual liquid level, not by an assumed half-full split
 *  - the L/D sweep reports the whole family, says which rows can carry
 *    the gas, and prefers the smallest one that can
 *
 * Units: field (MMscfd, bpd, psia, F, ft, minutes).
 *
 * REFUSAL CONTRACT (FC1-0, 2026-09-15)
 *  - A named input that is missing, non-finite or outside its domain
 *    throws a SeparatorInputError whose `input` property and message
 *    name the input. No silent default, clamp or fallback stands in
 *    for it.
 *  - A state the inputs are valid for but the method is not (a z-factor
 *    outside the DAK range, a solve that did not converge, a
 *    non-positive settling velocity, an empty diameter) returns
 *    { error } with the reason, as the module always has.
 *
 * GAS CAPACITY RULES (used by every sizer and by the sweep)
 *  - Vertical: the vessel carries the gas when D >= the gas-required
 *    diameter, that is when the upward gas velocity does not exceed
 *    the Souders-Brown velocity (velocity margin >= 1).
 *  - Horizontal (two and three phase): the vessel carries the gas when
 *    the gas velocity in the gas area (actual gas rate / gas area) does
 *    not exceed the Souders-Brown allowable velocity for the K in use.
 *
 * HELD FOR LITERATURE VERIFICATION (not changed by FC1-0)
 *  - The K pressure derating (0.01 per 100 psi over 100 psig, floored
 *    at 0.12) is the customary GPSA rule of thumb as recorded here; its
 *    exact published form has not been checked against the source.
 *  - Horizontal vessels use the Souders-Brown velocity at the
 *    horizontal K as the droplet settling velocity in the gas length
 *    requirement. That is a packaging of the method still to be checked
 *    against API 12J / Arnold and Stewart. One consequence is pinned by
 *    the FINDING gate in __tests__/facilities.separator.test.js: the gas
 *    length requirement is (gas velocity / vT) x gas height, so under
 *    the horizontal gas capacity rule above it is at most the gas
 *    height. Gas can therefore control only a gas-overloaded vessel or
 *    one shorter than its own diameter.
 */

import {
  suttonPseudoCriticals, dakZ, toRankine, AIR_MW, R_UNIVERSAL,
} from '../production/gasProperties.js';

const FT3_PER_BBL = (42 * 231) / 1728;
const S_PER_DAY = 86400;

/** A named input was missing, non-finite or outside its domain. */
export class SeparatorInputError extends Error {
  constructor(input, message) {
    super(message);
    this.name = 'SeparatorInputError';
    this.input = input;
  }
}

const need = (ok, input, message) => {
  if (!ok) throw new SeparatorInputError(input, message);
};
const isNum = Number.isFinite;
const given = (v) => v !== undefined && v !== null;

/**
 * Print a value with enough digits that the printed number sits on the
 * same side of `bound` as the value itself, so a message never shows a
 * value equal to the threshold it failed.
 */
const beside = (v, bound, fromDigits = 3) => {
  for (let d = fromDigits; d <= 15; d += 1) {
    const s = v.toFixed(d);
    if (Math.sign(Number(s) - bound) === Math.sign(v - bound)) return s;
  }
  return String(v);
};

/* ------------------------------------------------------------------ *
 * The K value
 * ------------------------------------------------------------------ */

/**
 * Souders-Brown K, published base values by vessel orientation and
 * mist-extractor type, with the customary pressure derating above
 * 100 psig (GPSA: K falls about 0.01 per 100 psi over 100 psig).
 * Everything is overridable, because K is ultimately a vendor and
 * service question.
 */
export const K_BASE = [
  { id: 'verticalMesh', label: 'Vertical, wire mesh pad', orientation: 'vertical', k: 0.35 },
  { id: 'verticalVane', label: 'Vertical, vane pack', orientation: 'vertical', k: 0.42 },
  { id: 'verticalNone', label: 'Vertical, no mist extractor', orientation: 'vertical', k: 0.18 },
  { id: 'horizontalMesh', label: 'Horizontal, wire mesh pad', orientation: 'horizontal', k: 0.45 },
  { id: 'horizontalVane', label: 'Horizontal, vane pack', orientation: 'horizontal', k: 0.55 },
  { id: 'horizontalNone', label: 'Horizontal, no mist extractor', orientation: 'horizontal', k: 0.25 },
];

/** The derating floor, below which the rule of thumb means nothing. */
export const K_FLOOR = 0.12;

/**
 * The published derating slope: K falls this much for every 100 psi of
 * gauge pressure above 100 psig. Exported because `nearFloor` below is
 * ONE STEP of this same rule rather than an invented tolerance, so if the
 * literature ever moves the slope the flag moves with it.
 */
export const K_DERATE_PER_100PSI = 0.01;

/**
 * Binary floating point puts a derating that lands EXACTLY on the floor a
 * few parts in 1e17 either side of it: `0.35 - 0.01 * 23` reads as
 * 0.11999999999999997, so a bare `<` floors a K the published rule does
 * not floor. The exact-rational oracle disagreed with this module at
 * verticalMesh/2400 psig for precisely that reason. Every comparison
 * against the floor is therefore made with this slack, which is fifteen
 * orders below the six decimals a K is ever reported at.
 */
const K_FLOOR_EPS = 1e-9;

/** The published rule itself: a base K with the pressure deduction taken off. */
const kDeratedAt = (kBase, pPsig) => (
  kBase - K_DERATE_PER_100PSI * (Math.max(0, pPsig - 100) / 100)
);

export const kBaseOf = (id) => K_BASE.find((k) => k.id === id) || null;

/**
 * K at pressure. The derating is the published rule of thumb (held for
 * literature verification, see the header) and is floored at 0.12.
 * When the derated value falls below the floor, `floored` is true,
 * `kDerated` keeps the value the rule gave, and the warning says the
 * floor bound.
 *
 * `floored` is a cliff, and until this flag existed a K sitting just
 * above it was reported exactly like a robust derated one:
 * verticalNoneAt650psig returns 0.125, which is half a step from the
 * floor. `nearFloor` is the flag beside `floored` for the APPROACH to
 * the cliff, and it is derived from the published rule rather than from
 * a chosen threshold: true when the floor did NOT catch this K and one
 * more 100 psi step of the same rule WOULD put it under. The two are
 * mutually exclusive, because a floored K is on the cliff and not
 * walking towards it.
 *
 * `kOverride` is optional; when it is given it must be positive, and it
 * wins outright. Without it, `internalsId` must name a K_BASE row. A
 * typed K reports `nearFloor` false with the other two: the derating
 * rule did not touch it, so none of the rule's flags can be raised.
 */
export const kValue = ({ internalsId, pPsig, kOverride } = {}) => {
  if (given(kOverride)) {
    need(isNum(kOverride) && kOverride > 0, 'kOverride',
      `kOverride must be a positive K in ft/s when it is given (got ${kOverride}); leave it out to use the published table`);
    return {
      k: kOverride, derated: false, floored: false, nearFloor: false, source: 'typed', warning: null,
    };
  }
  need(typeof internalsId === 'string' && internalsId.length > 0, 'internalsId',
    'internalsId is required: name a mist extractor from K_BASE or give kOverride');
  const base = kBaseOf(internalsId);
  need(base, 'internalsId', `internalsId '${internalsId}' is not a mist extractor in K_BASE`);
  need(isNum(pPsig) && pPsig >= 0, 'pPsig',
    `pPsig must be a finite, non-negative gauge pressure (got ${pPsig})`);
  const kDerated = kDeratedAt(base.k, pPsig);
  const floored = kDerated < K_FLOOR - K_FLOOR_EPS;
  const k = floored ? K_FLOOR : kDerated;
  return {
    k,
    kBase: base.k,
    kDerated,
    derated: pPsig > 100,
    floored,
    nearFloor: !floored && kDeratedAt(base.k, pPsig + 100) < K_FLOOR - K_FLOOR_EPS,
    source: base.label,
    warning: floored
      ? `The 0.12 floor bound: the published derating gives K = ${beside(kDerated, K_FLOOR)} at ${pPsig} psig, below the floor where the rule of thumb stops meaning anything. K is held at 0.12, and a vendor K is the only honest input here.`
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Fluid properties at separator conditions
 * ------------------------------------------------------------------ */

/**
 * DAK validity range, as this repository documents it for Dranchuk and
 * Abou-Kassem (1975) in engines/fluid/blackOil.ts: 1.0 <= Tpr <= 3.0,
 * 0.2 <= Ppr <= 30. gasProperties.js states only the gas-lift dome
 * window, so the fluid engine's statement is the one used.
 *
 * Tpr outside [1.0, 3.0] and Ppr above 30 are refused. Ppr below 0.2
 * is accepted and flagged with a note: the fit data start there, but
 * the DAK surface runs to the ideal-gas limit (z -> 1) as Ppr -> 0,
 * which is where a low-pressure separator sits, so refusing it would
 * refuse the most ordinary vessel in the field.
 */
export const DAK_TPR_MIN = 1.0;
export const DAK_TPR_MAX = 3.0;
export const DAK_PPR_MIN_FIT = 0.2;
export const DAK_PPR_MAX = 30;

export const gasDensityLbFt3 = ({ pPsia, tF, gasSg } = {}) => {
  need(isNum(pPsia) && pPsia > 0, 'pPsia',
    `pPsia must be a finite, positive absolute pressure (got ${pPsia})`);
  need(isNum(tF), 'tF', `tF must be a finite temperature in degF (got ${tF})`);
  need(isNum(gasSg) && gasSg > 0, 'gasSg',
    `gasSg must be a finite, positive gas gravity with air = 1 (got ${gasSg})`);
  const tR = toRankine(tF);
  need(tR > 0, 'tF', `tF ${tF} is below absolute zero`);
  const { tpcR, ppcPsia } = suttonPseudoCriticals(gasSg);
  if (!(tpcR > 0) || !(ppcPsia > 0)) {
    return { error: `the Sutton pseudo-criticals are not physical at gas gravity ${gasSg}` };
  }
  const ppr = pPsia / ppcPsia;
  const tpr = tR / tpcR;
  if (tpr < DAK_TPR_MIN) {
    return {
      error: `Tpr ${beside(tpr, DAK_TPR_MIN)} is below the DAK validity range of 1.0 to 3.0: the z-factor would be an extrapolation below the critical temperature, so it is refused`,
      ppr, tpr,
    };
  }
  if (tpr > DAK_TPR_MAX) {
    return {
      error: `Tpr ${beside(tpr, DAK_TPR_MAX)} is above the DAK validity range of 1.0 to 3.0, so the z-factor is refused`,
      ppr, tpr,
    };
  }
  if (ppr > DAK_PPR_MAX) {
    return {
      error: `Ppr ${beside(ppr, DAK_PPR_MAX)} is above the DAK validity limit of 30, so the z-factor is refused`,
      ppr, tpr,
    };
  }
  const zr = dakZ({ ppr, tpr });
  if (!zr.converged || !(zr.z > 0)) {
    return { error: 'the DAK z-factor did not converge at these conditions', ppr, tpr };
  }
  return {
    rhoLbFt3: (AIR_MW * gasSg * pPsia) / (zr.z * R_UNIVERSAL * tR),
    z: zr.z,
    ppr,
    tpr,
    note: ppr < DAK_PPR_MIN_FIT
      ? `Ppr ${beside(ppr, DAK_PPR_MIN_FIT)} is below the 0.2 where the DAK fit data start; the z-factor here runs toward the ideal-gas limit`
      : null,
  };
};

export const oilDensityLbFt3 = (apiGravity) => (141.5 / (131.5 + apiGravity)) * 62.4;

/**
 * Crude-oil thermal expansion, API MPMS Chapter 11.1 (1980) generalized
 * crude equation: CTL = exp(-a60 * dT * (1 + 0.8 * a60 * dT)) with
 * a60 = K0 / rho60^2 (rho60 in kg/m3, K0 = 341.0957, K1 = 0 for crude oil)
 * and dT = T - 60 degF. a60 comes out near 0.00047 per degF for a 35 API
 * crude, the textbook expansion of a medium crude.
 */
export const CRUDE_K0 = 341.0957;
const WATER_60F_KG_M3 = 999.016;

/**
 * Oil density at a temperature: the 60 degF density from API gravity,
 * times CTL. Gas-free oil at atmospheric pressure: dissolved gas and the
 * (small) liquid compressibility are not included, which is the basis the
 * separator sizing literature uses for the liquid phase. At 60 degF it is
 * oilDensityLbFt3 exactly.
 * @returns {{ rhoLbFt3: number, ctl: number, alpha60: number }}
 */
export const oilDensityAtTLbFt3 = ({ apiGravity, tF } = {}) => {
  need(isNum(apiGravity) && apiGravity > -131.5 && apiGravity < 100, 'apiGravity',
    `apiGravity must be a finite oil gravity between -131.5 and 100 degAPI (got ${apiGravity})`);
  need(isNum(tF), 'tF', `tF must be a finite temperature in degF (got ${tF})`);
  const rho60 = oilDensityLbFt3(apiGravity);
  const rho60Kg = (141.5 / (131.5 + apiGravity)) * WATER_60F_KG_M3;
  const alpha60 = CRUDE_K0 / (rho60Kg * rho60Kg);
  const dT = tF - 60;
  const ctl = Math.exp(-alpha60 * dT * (1 + 0.8 * alpha60 * dT));
  return { rhoLbFt3: rho60 * ctl, ctl, alpha60 };
};

/** Terminal (settling) velocity by Souders-Brown. */
export const terminalVelocityFtS = ({ k, rhoLLbFt3, rhoGLbFt3 }) => {
  if (!(k > 0) || !(rhoLLbFt3 > rhoGLbFt3) || !(rhoGLbFt3 > 0)) {
    return { error: 'settling needs a positive K and a liquid denser than the gas' };
  }
  return { vFtS: k * Math.sqrt((rhoLLbFt3 - rhoGLbFt3) / rhoGLbFt3) };
};

/** Actual gas volumetric rate at separator conditions, ft3/s. */
export const gasActualFt3S = ({ qGasMMscfd, pPsia, tF, z }) => {
  if (!(qGasMMscfd >= 0) || !(pPsia > 0)) return NaN;
  return ((qGasMMscfd * 1e6) / S_PER_DAY) * (14.7 / pPsia) * (toRankine(tF) / 520) * z;
};

/* ------------------------------------------------------------------ *
 * Vertical two-phase
 * ------------------------------------------------------------------ */

/**
 * Vertical separator: the diameter comes from the gas load (the
 * upward velocity must stay below terminal), and the height from the
 * liquid retention volume plus the fixed allowances for the inlet
 * device, the disengagement space and the mist extractor.
 *
 * With `diameterOverride` the vessel is sized at that diameter, and
 * `gasCapacityOk` is false when it is below `diameterGasFt`.
 */
export const verticalTwoPhase = ({
  qGasActFt3S, vTerminalFtS, qLiquidBpd, retentionMin,
  allowanceFt = 6, diameterOverride,
}) => {
  if (!(vTerminalFtS > 0)) return { error: 'a positive settling velocity is needed' };
  const areaGas = qGasActFt3S / vTerminalFtS;
  const dGas = Math.sqrt((4 * areaGas) / Math.PI);
  const d = diameterOverride > 0 ? diameterOverride : dGas;
  const area = (Math.PI * d * d) / 4;
  const liquidVolFt3 = (qLiquidBpd * FT3_PER_BBL) * (retentionMin / 1440);
  const hLiquid = liquidVolFt3 / area;
  const height = hLiquid + allowanceFt;
  return {
    diameterGasFt: dGas,
    diameterFt: d,
    hLiquidFt: hLiquid,
    heightFt: height,
    liquidVolFt3,
    ldRatio: height / d,
    gasVelocityFtS: qGasActFt3S / area,
    velocityMargin: vTerminalFtS / (qGasActFt3S / area),
    gasCapacityOk: d >= dGas,
  };
};

/* ------------------------------------------------------------------ *
 * Horizontal geometry
 * ------------------------------------------------------------------ */

/** Area of the circular segment of depth h in a circle of diameter d. */
const segmentAreaFt2 = (d, h) => {
  const r = d / 2;
  const theta = 2 * Math.acos((r - h) / r);
  return (r * r / 2) * (theta - Math.sin(theta));
};

/**
 * The depth whose circular segment has the given area: the exact
 * inverse of the segment area, by bisection on [0, D] (the area is
 * strictly increasing in depth), 100 halvings. That resolves the depth
 * to the limit of double precision, so the result is exact for any
 * purpose a vessel has.
 */
export const segmentHeightForAreaFt = ({ diameterFt, areaFt2 }) => {
  const total = (Math.PI * diameterFt * diameterFt) / 4;
  if (!(diameterFt > 0) || !(areaFt2 >= 0) || !(areaFt2 <= total)) {
    return { error: 'the area must lie between zero and the full circle' };
  }
  let lo = 0;
  let hi = diameterFt;
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    if (segmentAreaFt2(diameterFt, mid) < areaFt2) lo = mid; else hi = mid;
  }
  return { heightFt: (lo + hi) / 2 };
};

/**
 * Circular-segment areas of a horizontal vessel at a stated liquid
 * fraction of the diameter. Exact, not the assumed half-full split
 * the predecessor used. `liquidLevelFrac` must lie strictly between 0
 * and 1; it defaults to half full when it is left out.
 *
 * `gasLiquidChordFt` is the width of the gas-liquid surface. It is not
 * the oil-water interface, which horizontalThreePhase places itself.
 */
export const horizontalSegments = ({ diameterFt, liquidLevelFrac = 0.5 }) => {
  if (!(diameterFt > 0)) return { error: 'diameter must be positive' };
  need(isNum(liquidLevelFrac) && liquidLevelFrac > 0 && liquidLevelFrac < 1, 'liquidLevelFrac',
    `liquidLevelFrac must lie strictly between 0 and 1 (got ${liquidLevelFrac})`);
  const h = liquidLevelFrac * diameterFt;
  const areaLiquid = segmentAreaFt2(diameterFt, h);
  const areaTotal = (Math.PI * diameterFt * diameterFt) / 4;
  return {
    areaTotalFt2: areaTotal,
    areaLiquidFt2: areaLiquid,
    areaGasFt2: areaTotal - areaLiquid,
    gasHeightFt: diameterFt - h,
    gasLiquidChordFt: 2 * Math.sqrt(Math.max(0, h * (diameterFt - h))),
    liquidLevelFt: h,
  };
};

/**
 * Horizontal two-phase separator at a candidate diameter: the gas must
 * cross the length in less time than a droplet takes to fall through
 * the gas space, and the liquid must stay long enough to degas.
 * Returns BOTH length requirements so the controlling one is visible,
 * and the gas capacity verdict (gas velocity against Souders-Brown).
 */
export const horizontalTwoPhase = ({
  diameterFt, qGasActFt3S, vTerminalFtS, qLiquidBpd, retentionMin,
  liquidLevelFrac = 0.5,
}) => {
  const seg = horizontalSegments({ diameterFt, liquidLevelFrac });
  if (seg.error) return seg;
  if (!(vTerminalFtS > 0)) return { error: 'a positive settling velocity is needed' };
  const vGas = qGasActFt3S / seg.areaGasFt2;
  // droplet fall time across the gas space vs gas residence time
  const lengthGasFt = vGas * (seg.gasHeightFt / vTerminalFtS);
  const liquidVolFt3 = (qLiquidBpd * FT3_PER_BBL) * (retentionMin / 1440);
  const lengthLiquidFt = liquidVolFt3 / seg.areaLiquidFt2;
  const lengthFt = Math.max(lengthGasFt, lengthLiquidFt);
  return {
    ...seg,
    gasVelocityFtS: vGas,
    gasVelocityMargin: vTerminalFtS / vGas,
    gasCapacityOk: vGas <= vTerminalFtS,
    lengthGasFt,
    lengthLiquidFt,
    lengthFt,
    controlling: lengthGasFt >= lengthLiquidFt ? 'gas' : 'liquid',
    ldRatio: lengthFt / diameterFt,
    liquidVolFt3,
  };
};

/* ------------------------------------------------------------------ *
 * Three phase
 * ------------------------------------------------------------------ */

/**
 * Droplet settling between two liquids by Stokes' law, in the form
 * the standards use for oil-water separation:
 *   v = 1.78e-6 * dm^2 * (SGheavy - SGlight) / mu   [ft/s, dm microns]
 */
export const liquidLiquidSettlingFtS = ({
  dropletMicron, sgHeavy, sgLight, muCp,
}) => {
  if (!(dropletMicron > 0) || !(muCp > 0)) return { error: 'settling needs a droplet size and viscosity' };
  if (!(sgHeavy > sgLight)) return { error: 'the heavy phase must be denser than the light phase' };
  return { vFtS: (1.78e-6 * dropletMicron * dropletMicron * (sgHeavy - sgLight)) / muCp };
};

/** Relative gap under which two retention lengths are the same length. */
export const RETENTION_TIE_REL = 1e-9;

const needPositive = (args, name, what) => {
  need(isNum(args[name]) && args[name] > 0, name,
    `${name} is required: ${what} (got ${args[name]})`);
};

/**
 * Horizontal three-phase separator.
 *
 * Interface. The liquid cross-section is split between water and oil
 * in proportion to the two retention volumes (`interfaceSplit`
 * 'retention-proportional'), unless `waterFracOfLiquid` pins the water
 * share (`interfaceSplit` 'explicit'). The oil-water interface height
 * is the exact inverse of the circular-segment area of the water share
 * (segmentHeightForAreaFt). The water layer is that height; the oil
 * layer is the liquid level minus it.
 *
 * Length. With the proportional split, the oil and the water need the
 * same length by construction, so there is one requirement,
 * `liquidRetentionLengthFt` = total retention volume / liquid area.
 * With an explicit split they differ: the requirement is the larger,
 * both are reported in `phaseRetentionLengthsFt`, and `retentionPhase`
 * names the one that sets it (null inside RETENTION_TIE_REL).
 * `controlling` is 'gas' or 'liquid-retention'.
 *
 * Droplets. Water drops fall out of the oil layer and oil drops rise
 * out of the water layer, each at its own named size and by Stokes in
 * its own continuous phase. The residence times are those of the SIZED
 * vessel: layer area x vessel length / phase flow rate. A water drop
 * that needs longer than the oil residence is water carryover; an oil
 * drop that needs longer than the water residence is oil carryunder.
 *
 * Required inputs, refused by name when missing or not positive:
 * qOilBpd, qWaterBpd, oilRetentionMin, waterRetentionMin, sgOil,
 * sgWater (above sgOil), muOilCp, muWaterCp, waterDropletMicron,
 * oilDropletMicron. There are no droplet or viscosity defaults.
 */
export const horizontalThreePhase = (args) => {
  need(!('dropletMicron' in args), 'dropletMicron',
    'dropletMicron was retired: give waterDropletMicron (water drops falling out of the oil) and oilDropletMicron (oil drops rising out of the water)');
  needPositive(args, 'qOilBpd', 'the oil rate in bpd (a vessel with no oil to separate is a two-phase vessel)');
  needPositive(args, 'qWaterBpd', 'the water rate in bpd (a vessel with no water to separate is a two-phase vessel)');
  needPositive(args, 'oilRetentionMin', 'the oil retention time in minutes');
  needPositive(args, 'waterRetentionMin', 'the water retention time in minutes');
  needPositive(args, 'sgOil', 'the oil specific gravity');
  needPositive(args, 'sgWater', 'the water specific gravity');
  need(args.sgWater > args.sgOil, 'sgWater',
    `sgWater (${args.sgWater}) must exceed sgOil (${args.sgOil}) for the water to settle`);
  needPositive(args, 'muOilCp', 'the oil viscosity in cP');
  needPositive(args, 'muWaterCp', 'the water viscosity in cP');
  needPositive(args, 'waterDropletMicron', 'the size in microns of the water drops to remove from the oil');
  needPositive(args, 'oilDropletMicron', 'the size in microns of the oil drops to remove from the water');
  const {
    diameterFt, qGasActFt3S, vTerminalFtS,
    qOilBpd, qWaterBpd, oilRetentionMin, waterRetentionMin,
    liquidLevelFrac = 0.5, waterFracOfLiquid,
    sgOil, sgWater, muOilCp, muWaterCp, waterDropletMicron, oilDropletMicron,
  } = args;
  const explicit = given(waterFracOfLiquid);
  if (explicit) {
    need(isNum(waterFracOfLiquid) && waterFracOfLiquid > 0 && waterFracOfLiquid < 1,
      'waterFracOfLiquid',
      `waterFracOfLiquid must lie strictly between 0 and 1 when it is given (got ${waterFracOfLiquid})`);
  }

  const seg = horizontalSegments({ diameterFt, liquidLevelFrac });
  if (seg.error) return seg;
  if (!(vTerminalFtS > 0)) return { error: 'a positive settling velocity is needed' };

  const volOil = (qOilBpd * FT3_PER_BBL) * (oilRetentionMin / 1440);
  const volWater = (qWaterBpd * FT3_PER_BBL) * (waterRetentionMin / 1440);
  const waterShare = explicit ? waterFracOfLiquid : volWater / (volWater + volOil);
  const areaWater = seg.areaLiquidFt2 * waterShare;
  const areaOil = seg.areaLiquidFt2 - areaWater;

  const interfaceHeightFt = segmentHeightForAreaFt({ diameterFt, areaFt2: areaWater }).heightFt;
  const waterLayerFt = interfaceHeightFt;
  const oilLayerFt = seg.liquidLevelFt - interfaceHeightFt;

  let liquidRetentionLengthFt;
  let phaseRetentionLengthsFt = null;
  let retentionPhase = null;
  if (explicit) {
    const oilFt = volOil / areaOil;
    const waterFt = volWater / areaWater;
    phaseRetentionLengthsFt = { oilFt, waterFt };
    liquidRetentionLengthFt = Math.max(oilFt, waterFt);
    if (Math.abs(oilFt - waterFt) > RETENTION_TIE_REL * liquidRetentionLengthFt) {
      retentionPhase = oilFt > waterFt ? 'oil' : 'water';
    }
  } else {
    liquidRetentionLengthFt = (volOil + volWater) / seg.areaLiquidFt2;
  }

  const vGas = qGasActFt3S / seg.areaGasFt2;
  const lengthGasFt = vGas * (seg.gasHeightFt / vTerminalFtS);
  const lengthFt = Math.max(lengthGasFt, liquidRetentionLengthFt);
  const controlling = lengthGasFt >= liquidRetentionLengthFt ? 'gas' : 'liquid-retention';

  const waterDropVelocityFtS = liquidLiquidSettlingFtS({
    dropletMicron: waterDropletMicron, sgHeavy: sgWater, sgLight: sgOil, muCp: muOilCp,
  }).vFtS;
  const oilDropVelocityFtS = liquidLiquidSettlingFtS({
    dropletMicron: oilDropletMicron, sgHeavy: sgWater, sgLight: sgOil, muCp: muWaterCp,
  }).vFtS;
  const residenceOilS = (areaOil * lengthFt) / ((qOilBpd * FT3_PER_BBL) / S_PER_DAY);
  const residenceWaterS = (areaWater * lengthFt) / ((qWaterBpd * FT3_PER_BBL) / S_PER_DAY);
  const waterDropFallS = oilLayerFt / waterDropVelocityFtS;
  const oilDropRiseS = waterLayerFt / oilDropVelocityFtS;
  const dropChecks = {
    waterDropletMicron,
    oilDropletMicron,
    waterDropVelocityFtS,
    oilDropVelocityFtS,
    waterDropFallS,
    oilDropRiseS,
    residenceOilS,
    residenceWaterS,
    waterCarryover: waterDropFallS > residenceOilS,
    oilCarryunder: oilDropRiseS > residenceWaterS,
  };

  const warnings = [];
  if (dropChecks.waterCarryover) {
    warnings.push(`A ${waterDropletMicron} micron water drop needs ${beside(waterDropFallS, residenceOilS, 0)} s to fall through the ${oilLayerFt.toFixed(2)} ft oil layer and the oil stays ${beside(residenceOilS, waterDropFallS, 0)} s: expect water carryover into the oil outlet, so raise the oil retention or lower the interface.`);
  }
  if (dropChecks.oilCarryunder) {
    warnings.push(`A ${oilDropletMicron} micron oil drop needs ${beside(oilDropRiseS, residenceWaterS, 0)} s to rise through the ${waterLayerFt.toFixed(2)} ft water layer and the water stays ${beside(residenceWaterS, oilDropRiseS, 0)} s: expect oil carryunder into the water outlet.`);
  }

  return {
    ...seg,
    interfaceSplit: explicit ? 'explicit' : 'retention-proportional',
    waterShare,
    areaOilFt2: areaOil,
    areaWaterFt2: areaWater,
    interfaceHeightFt,
    waterLayerFt,
    oilLayerFt,
    liquidRetentionLengthFt,
    phaseRetentionLengthsFt,
    retentionPhase,
    lengthGasFt,
    lengthFt,
    controlling,
    ldRatio: lengthFt / diameterFt,
    gasVelocityFtS: vGas,
    gasVelocityMargin: vTerminalFtS / vGas,
    gasCapacityOk: vGas <= vTerminalFtS,
    dropChecks,
    warnings,
    warning: warnings.length ? warnings.join(' ') : null,
  };
};

/* ------------------------------------------------------------------ *
 * The L/D family
 * ------------------------------------------------------------------ */

export const SWEEP_MODES = ['horizontal2', 'horizontal3', 'vertical2'];

/**
 * Sweep candidate diameters and report the whole family, so the L/D
 * choice is read off a table rather than pinned by an assumption.
 * Customary slenderness (Arnold and Stewart) is 3 to 4 for a two-phase
 * horizontal separator, 3 to 5 for a three-phase one and 2 to 4 for a
 * vertical one; the band is an input, and the defaults below are the widest
 * horizontal band.
 *
 * Rows come back sorted by diameter, smallest first. Each row carries:
 *  - `feasible`: the vessel at that diameter works. It is false when
 *    the sizer refused the diameter ('sizing-error'), when the gas
 *    capacity rule in the header fails ('gas-capacity'), and for a
 *    three-phase vessel when a droplet check fails ('water-carryover',
 *    'oil-carryunder').
 *  - `inRange`: the L/D lies inside [ldMin, ldMax].
 *  - `reasons`: every reason the row cannot be the preferred vessel,
 *    the physical ones above plus 'ld-out-of-band'. Empty for an
 *    eligible row.
 *
 * `preferred` is the SMALLEST feasible diameter inside the L/D band.
 * `preferredStatus` is 'selected' when there is one, 'none-feasible'
 * when no row is feasible, and 'none-in-band' when feasible rows exist
 * but none of them is inside the band. `preferred` is null in both
 * of those cases.
 */
export const ldSweep = ({
  mode, diametersFt, ldMin = 3, ldMax = 5, ...args
}) => {
  if (!SWEEP_MODES.includes(mode)) return { error: `unknown sizing mode '${mode}'` };
  need(Array.isArray(diametersFt) && diametersFt.length > 0
    && diametersFt.every((d) => isNum(d) && d > 0), 'diametersFt',
  'diametersFt must be a non-empty list of positive diameters in ft');
  need(isNum(ldMin) && ldMin > 0, 'ldMin', `ldMin must be a positive slenderness (got ${ldMin})`);
  need(isNum(ldMax) && ldMax >= ldMin, 'ldMax', `ldMax must be a number no smaller than ldMin (got ${ldMax})`);

  const rows = [...diametersFt].sort((a, b) => a - b).map((d) => {
    let r;
    if (mode === 'horizontal2') r = horizontalTwoPhase({ ...args, diameterFt: d });
    else if (mode === 'horizontal3') r = horizontalThreePhase({ ...args, diameterFt: d });
    else r = verticalTwoPhase({ ...args, diameterOverride: d });
    if (r.error) {
      return {
        diameterFt: d, error: r.error, feasible: false, inRange: false, reasons: ['sizing-error'],
      };
    }
    const reasons = [];
    if (!r.gasCapacityOk) reasons.push('gas-capacity');
    if (r.dropChecks?.waterCarryover) reasons.push('water-carryover');
    if (r.dropChecks?.oilCarryunder) reasons.push('oil-carryunder');
    const feasible = reasons.length === 0;
    const ld = r.ldRatio;
    const inRange = ld >= ldMin && ld <= ldMax;
    if (!inRange) reasons.push('ld-out-of-band');
    return {
      diameterFt: d,
      lengthFt: mode === 'vertical2' ? r.heightFt : r.lengthFt,
      ldRatio: ld,
      inRange,
      feasible,
      reasons,
      controlling: r.controlling || null,
      result: r,
    };
  });
  const preferred = rows.find((r) => r.feasible && r.inRange) || null;
  let preferredStatus = 'selected';
  if (!preferred) preferredStatus = rows.some((r) => r.feasible) ? 'none-in-band' : 'none-feasible';
  return {
    rows, preferred, preferredStatus, ldMin, ldMax,
  };
};

/* ------------------------------------------------------------------ *
 * Slug catchers
 * ------------------------------------------------------------------ */

/**
 * Vessel-type slug catcher: hold the arriving slug plus the normal
 * liquid level, with freeboard for the gas. The slug volume itself
 * comes from the line (the F1 studio's pigging tab computes it), so
 * it is an input here rather than a guess.
 *
 * `qLiquidBpd` left out means no normal inflow during the hold; a
 * given value must be finite and non-negative. `holdMin` must be
 * finite and non-negative, `ldRatio` finite and positive.
 */
export const vesselSlugCatcher = ({
  slugBbl, qLiquidBpd, holdMin = 5, fillFraction = 0.6, ldRatio = 4,
}) => {
  if (!(slugBbl > 0)) return { error: 'a slug volume is needed (the line sizing studio computes it)' };
  if (!(fillFraction > 0) || fillFraction >= 1) return { error: 'the fill fraction must be between 0 and 1' };
  need(isNum(ldRatio) && ldRatio > 0, 'ldRatio',
    `ldRatio must be a positive length-to-diameter ratio (got ${ldRatio})`);
  need(isNum(holdMin) && holdMin >= 0, 'holdMin',
    `holdMin must be a non-negative hold time in minutes (got ${holdMin})`);
  if (given(qLiquidBpd)) {
    need(isNum(qLiquidBpd) && qLiquidBpd >= 0, 'qLiquidBpd',
      `qLiquidBpd must be a non-negative liquid rate when it is given (got ${qLiquidBpd})`);
  }
  const normalBbl = (qLiquidBpd || 0) * (holdMin / 1440);
  const workingBbl = slugBbl + normalBbl;
  const volFt3 = (workingBbl * FT3_PER_BBL) / fillFraction;
  // V = (pi/4) D^2 L with L = ldRatio * D
  const d = ((4 * volFt3) / (Math.PI * ldRatio)) ** (1 / 3);
  return {
    normalBbl, workingBbl,
    totalVolumeFt3: volFt3,
    diameterFt: d,
    lengthFt: ldRatio * d,
    ldRatio,
  };
};

/**
 * Finger-type slug catcher: the same volume in parallel pipe legs,
 * which is how large slugs are actually caught (pipe is cheaper than
 * vessel per unit volume and needs no ASME vessel code stamp).
 * `nFingers` must be a whole number of at least 1.
 */
export const fingerSlugCatcher = ({
  slugBbl, fingerIdIn, nFingers, fillFraction = 0.8,
}) => {
  if (!(slugBbl > 0) || !(fingerIdIn > 0)) {
    return { error: 'finger sizing needs a slug volume and a finger bore' };
  }
  need(Number.isInteger(nFingers) && nFingers >= 1, 'nFingers',
    `nFingers must be a whole number of at least 1 (got ${nFingers})`);
  if (!(fillFraction > 0) || fillFraction >= 1) return { error: 'the fill fraction must be between 0 and 1' };
  const volFt3 = (slugBbl * FT3_PER_BBL) / fillFraction;
  const areaFt2 = (Math.PI * fingerIdIn * fingerIdIn) / (4 * 144);
  const lengthFt = volFt3 / (areaFt2 * nFingers);
  return {
    totalVolumeFt3: volFt3,
    fingerLengthFt: lengthFt,
    totalPipeFt: lengthFt * nFingers,
    areaPerFingerFt2: areaFt2,
    warning: lengthFt > 1500
      ? 'fingers longer than about 1500 ft each: add fingers or a larger bore rather than building a very long harp'
      : null,
  };
};
