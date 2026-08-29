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
 *  - z comes from the validated DAK correlation
 *  - K carries the published pressure derating and the mist-extractor
 *    type, and stays overridable
 *  - three-phase sizing solves BOTH liquid retention times against the
 *    same vessel, because the oil and water each need their own and
 *    the larger requirement wins
 *  - horizontal vessels are sized by the gas-space geometry at the
 *    actual liquid level, not by an assumed half-full split
 *  - the L/D sweep reports the whole family so the choice is visible
 *
 * Units: field (MMscfd, bpd, psia, F, ft, minutes).
 */

import { suttonPseudoCriticals, dakZ, toRankine } from '../production/gasProperties.js';

const FT3_PER_BBL = (42 * 231) / 1728;
const S_PER_DAY = 86400;

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

export const kBaseOf = (id) => K_BASE.find((k) => k.id === id) || null;

/**
 * K at pressure. The derating is the published rule of thumb and is
 * floored at 0.12, below which the correlation stops meaning anything
 * and a vendor number is the only honest input.
 */
export const kValue = ({ internalsId = 'verticalMesh', pPsig, kOverride }) => {
  if (kOverride > 0) return { k: kOverride, derated: false, source: 'typed' };
  const base = kBaseOf(internalsId);
  if (!base) return { error: `unknown mist extractor '${internalsId}'` };
  if (!(pPsig >= 0)) return { error: 'pressure must be non-negative' };
  const over = Math.max(0, pPsig - 100);
  const k = Math.max(0.12, base.k - 0.01 * (over / 100));
  return {
    k, kBase: base.k, derated: pPsig > 100, source: base.label,
    floored: k === 0.12,
    warning: k === 0.12
      ? 'K is at the floor of the published derating: at this pressure the rule of thumb has stopped meaning anything and a vendor K is the only honest input'
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Fluid properties at separator conditions
 * ------------------------------------------------------------------ */

export const gasDensityLbFt3 = ({ pPsia, tF, gasSg }) => {
  const tR = toRankine(tF);
  const { tpcR, ppcPsia } = suttonPseudoCriticals(gasSg);
  const z = dakZ({ ppr: pPsia / ppcPsia, tpr: tR / tpcR }).z;
  if (!(z > 0)) return { error: 'z-factor did not converge at these conditions' };
  return { rhoLbFt3: (28.9625 * gasSg * pPsia) / (z * 10.7316 * tR), z };
};

export const oilDensityLbFt3 = (apiGravity) => (141.5 / (131.5 + apiGravity)) * 62.4;

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
  };
};

/* ------------------------------------------------------------------ *
 * Horizontal geometry
 * ------------------------------------------------------------------ */

/**
 * Circular-segment areas of a horizontal vessel at a stated liquid
 * fraction of the diameter. Exact, not the assumed half-full split
 * the predecessor used.
 */
export const horizontalSegments = ({ diameterFt, liquidLevelFrac = 0.5 }) => {
  if (!(diameterFt > 0)) return { error: 'diameter must be positive' };
  const f = Math.min(Math.max(liquidLevelFrac, 0.01), 0.99);
  const r = diameterFt / 2;
  const h = f * diameterFt;
  const theta = 2 * Math.acos((r - h) / r);          // wetted angle
  const areaLiquid = (r * r / 2) * (theta - Math.sin(theta));
  const areaTotal = Math.PI * r * r;
  const chord = 2 * Math.sqrt(Math.max(0, h * (diameterFt - h)));
  return {
    areaTotalFt2: areaTotal,
    areaLiquidFt2: areaLiquid,
    areaGasFt2: areaTotal - areaLiquid,
    gasHeightFt: diameterFt - h,
    interfaceChordFt: chord,
    liquidLevelFt: h,
  };
};

/**
 * Horizontal two-phase separator at a candidate diameter: the gas must
 * cross the length in less time than a droplet takes to fall through
 * the gas space, and the liquid must stay long enough to degas.
 * Returns BOTH length requirements so the controlling one is visible.
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

/**
 * Horizontal three-phase separator. The oil and the water each need
 * their own retention time in their own layer, and BOTH must be
 * satisfied by one vessel: the length is the larger requirement, and
 * the studio reports which phase set it. Also checks that each
 * dispersed droplet can cross its own layer in the residence
 * available, which is the check that actually catches a vessel that
 * meets its retention times but still carries water over.
 */
export const horizontalThreePhase = ({
  diameterFt, qGasActFt3S, vTerminalFtS,
  qOilBpd, qWaterBpd, oilRetentionMin, waterRetentionMin,
  liquidLevelFrac = 0.5, waterFracOfLiquid,
  sgOil, sgWater, muOilCp = 2, muWaterCp = 0.7, dropletMicron = 500,
}) => {
  const seg = horizontalSegments({ diameterFt, liquidLevelFrac });
  if (seg.error) return seg;
  const totalLiquidBpd = qOilBpd + qWaterBpd;
  if (!(totalLiquidBpd > 0)) return { error: 'a three-phase vessel needs liquid to separate' };
  // interface height: split the liquid area in proportion to the
  // retention volumes unless the caller pins it
  const waterShare = Number.isFinite(waterFracOfLiquid)
    ? waterFracOfLiquid
    : (qWaterBpd * waterRetentionMin) / (qWaterBpd * waterRetentionMin + qOilBpd * oilRetentionMin);
  const areaWater = seg.areaLiquidFt2 * waterShare;
  const areaOil = seg.areaLiquidFt2 - areaWater;
  if (!(areaOil > 0) || !(areaWater > 0)) {
    return { error: 'the interface split leaves one liquid layer with no area' };
  }
  const volOil = (qOilBpd * FT3_PER_BBL) * (oilRetentionMin / 1440);
  const volWater = (qWaterBpd * FT3_PER_BBL) * (waterRetentionMin / 1440);
  const lengthOil = volOil / areaOil;
  const lengthWater = volWater / areaWater;
  const vGas = qGasActFt3S / seg.areaGasFt2;
  const lengthGas = vTerminalFtS > 0 ? vGas * (seg.gasHeightFt / vTerminalFtS) : 0;
  const lengthFt = Math.max(lengthOil, lengthWater, lengthGas);
  const controlling = lengthFt === lengthGas ? 'gas'
    : (lengthFt === lengthWater ? 'water retention' : 'oil retention');

  // Dispersed-droplet checks: can a water drop cross the oil layer,
  // and an oil drop rise through the water, in the residence time?
  const oilLayerFt = areaOil / Math.max(seg.interfaceChordFt, 1e-9);
  const waterLayerFt = areaWater / Math.max(seg.interfaceChordFt, 1e-9);
  const wInOil = liquidLiquidSettlingFtS({
    dropletMicron, sgHeavy: sgWater, sgLight: sgOil, muCp: muOilCp,
  });
  const oInWater = liquidLiquidSettlingFtS({
    dropletMicron, sgHeavy: sgWater, sgLight: sgOil, muCp: muWaterCp,
  });
  const residenceOilS = (volOil / (qOilBpd * FT3_PER_BBL / S_PER_DAY));
  const residenceWaterS = (volWater / (qWaterBpd * FT3_PER_BBL / S_PER_DAY));
  const dropChecks = {
    waterDropFallS: wInOil.error ? null : oilLayerFt / wInOil.vFtS,
    oilDropRiseS: oInWater.error ? null : waterLayerFt / oInWater.vFtS,
    residenceOilS,
    residenceWaterS,
  };
  dropChecks.waterCarryover = dropChecks.waterDropFallS !== null
    && dropChecks.waterDropFallS > residenceOilS;
  dropChecks.oilCarryunder = dropChecks.oilDropRiseS !== null
    && dropChecks.oilDropRiseS > residenceWaterS;

  return {
    ...seg,
    waterShare,
    areaOilFt2: areaOil,
    areaWaterFt2: areaWater,
    lengthOilFt: lengthOil,
    lengthWaterFt: lengthWater,
    lengthGasFt: lengthGas,
    lengthFt,
    controlling,
    ldRatio: lengthFt / diameterFt,
    gasVelocityFtS: vGas,
    dropChecks,
    warning: dropChecks.waterCarryover
      ? 'the vessel meets its retention times but a water droplet cannot cross the oil layer in the residence available: expect water carryover, so raise the retention time or lower the interface'
      : (dropChecks.oilCarryunder
        ? 'an oil droplet cannot rise through the water layer in the residence available: expect oil under-carry into the water outlet'
        : null),
  };
};

/* ------------------------------------------------------------------ *
 * The L/D family
 * ------------------------------------------------------------------ */

/**
 * Sweep candidate diameters and report the whole family, so the L/D
 * choice is read off a table rather than pinned by an assumption.
 * Customary slenderness is 3 to 5 for horizontal separators and 2 to 4
 * for vertical ones.
 */
export const ldSweep = ({
  mode, diametersFt, ldMin = 3, ldMax = 5, ...args
}) => {
  const rows = [];
  for (const d of diametersFt) {
    let r;
    if (mode === 'horizontal2') r = horizontalTwoPhase({ ...args, diameterFt: d });
    else if (mode === 'horizontal3') r = horizontalThreePhase({ ...args, diameterFt: d });
    else if (mode === 'vertical2') r = verticalTwoPhase({ ...args, diameterOverride: d });
    else return { error: `unknown sizing mode '${mode}'` };
    if (r.error) { rows.push({ diameterFt: d, error: r.error }); continue; }
    const ld = r.ldRatio;
    rows.push({
      diameterFt: d,
      lengthFt: mode === 'vertical2' ? r.heightFt : r.lengthFt,
      ldRatio: ld,
      inRange: ld >= ldMin && ld <= ldMax,
      controlling: r.controlling || null,
      result: r,
    });
  }
  const preferred = rows.find((r) => r.inRange) || null;
  return { rows, preferred, ldMin, ldMax };
};

/* ------------------------------------------------------------------ *
 * Slug catchers
 * ------------------------------------------------------------------ */

/**
 * Vessel-type slug catcher: hold the arriving slug plus the normal
 * liquid level, with freeboard for the gas. The slug volume itself
 * comes from the line (the F1 studio's pigging tab computes it), so
 * it is an input here rather than a guess.
 */
export const vesselSlugCatcher = ({
  slugBbl, qLiquidBpd, holdMin = 5, fillFraction = 0.6, ldRatio = 4,
}) => {
  if (!(slugBbl > 0)) return { error: 'a slug volume is needed (the line sizing studio computes it)' };
  if (!(fillFraction > 0) || fillFraction >= 1) return { error: 'the fill fraction must be between 0 and 1' };
  const normalBbl = (qLiquidBpd > 0 ? qLiquidBpd : 0) * (holdMin / 1440);
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
 */
export const fingerSlugCatcher = ({
  slugBbl, fingerIdIn, nFingers, fillFraction = 0.8,
}) => {
  if (!(slugBbl > 0) || !(fingerIdIn > 0) || !(nFingers >= 1)) {
    return { error: 'finger sizing needs a slug volume, a finger bore and a finger count' };
  }
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
