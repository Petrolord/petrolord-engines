/**
 * Atmospheric storage tank shell design, venting and losses
 * (Facilities F12a).
 *
 * Three questions that are usually asked separately and answered
 * inconsistently, put in one place because they share a geometry:
 *
 *  1. How thick does each shell course have to be (API 650, the
 *     one-foot method)?
 *  2. How much has the tank got to breathe, in and out, normally
 *     (API 2000 thermal and liquid movement) and in a fire (the
 *     wetted-area heat input)?
 *  3. How much product evaporates out of it in a year (the standing
 *     and working loss relations), which is both a money question and
 *     an emissions one?
 *
 * The venting one is where tanks are actually destroyed. A tank is a
 * thin-walled vessel designed for inches of water column, so an
 * undersized vacuum vent will pull it flat during a cold rainstorm on
 * a full tank, and an undersized pressure vent will lift the roof in
 * a fire. Both cases are computed here rather than assumed.
 *
 * Units: field (ft, bbl, psi, F, scfh).
 */

const FT3_PER_BBL = (42 * 231) / 1728;

/* ------------------------------------------------------------------ *
 * Geometry and capacity
 * ------------------------------------------------------------------ */

export const tankCapacity = ({ diameterFt, heightFt, fillHeightFt }) => {
  if (!(diameterFt > 0) || !(heightFt > 0)) {
    return { error: 'a tank needs a positive diameter and height' };
  }
  const areaFt2 = (Math.PI * diameterFt * diameterFt) / 4;
  const nominalBbl = (areaFt2 * heightFt) / FT3_PER_BBL;
  const fill = Number.isFinite(fillHeightFt) ? Math.min(fillHeightFt, heightFt) : heightFt;
  return {
    crossSectionFt2: areaFt2,
    nominalBbl,
    nominalFt3: areaFt2 * heightFt,
    workingBbl: (areaFt2 * fill) / FT3_PER_BBL,
    bblPerFt: areaFt2 / FT3_PER_BBL,
  };
};

/* ------------------------------------------------------------------ *
 * Shell thickness (API 650 one-foot method)
 * ------------------------------------------------------------------ */

/**
 * API 650 one-foot method, both the design and hydrostatic-test
 * conditions, because either can govern and which one does depends on
 * the product's specific gravity:
 *   td = 2.6 D (H - 1) G / (Sd) + CA
 *   tt = 2.6 D (H - 1) / (St)
 * A light product makes the water test govern, which is exactly the
 * case people forget when they design for the product alone.
 */
export const shellCourse = ({
  diameterFt, courseBottomHeightFt, liquidLevelFt, sg,
  designStressPsi = 23200, testStressPsi = 24900,
  corrosionAllowanceIn = 0, minimumThicknessIn = 0.1875,
}) => {
  if (!(diameterFt > 0) || !(liquidLevelFt > 0)) {
    return { error: 'a course needs a positive diameter and liquid level' };
  }
  if (!(sg > 0)) return { error: 'a specific gravity is needed' };
  // head acting on this course: from the design liquid level down to
  // one foot above the course bottom
  const h = Math.max(0, liquidLevelFt - courseBottomHeightFt);
  const tDesign = (2.6 * diameterFt * Math.max(h - 1, 0) * sg) / designStressPsi
    + corrosionAllowanceIn;
  const tTest = (2.6 * diameterFt * Math.max(h - 1, 0)) / testStressPsi;
  const required = Math.max(tDesign, tTest, minimumThicknessIn);
  let governing;
  if (required === minimumThicknessIn) governing = 'minimum plate thickness';
  else if (tTest > tDesign) governing = 'hydrostatic test';
  else governing = 'product design';
  return {
    headFt: h,
    tDesignIn: tDesign,
    tTestIn: tTest,
    requiredIn: required,
    governing,
    note: governing === 'hydrostatic test'
      ? 'the water test governs this course, not the product: a light product does not stress the shell as hard as the water it will be tested with, and designing for the product alone would under-thickness it'
      : null,
  };
};

/** All courses of a tank, bottom to top. */
export const shellCourses = ({
  diameterFt, heightFt, courseHeightFt = 8, liquidLevelFt, sg, ...rest
}) => {
  if (!(courseHeightFt > 0) || !(heightFt > 0)) {
    return { error: 'courses need a positive tank and course height' };
  }
  const n = Math.ceil(heightFt / courseHeightFt);
  const level = Number.isFinite(liquidLevelFt) ? liquidLevelFt : heightFt;
  const courses = [];
  for (let i = 0; i < n; i += 1) {
    const bottom = i * courseHeightFt;
    const c = shellCourse({
      diameterFt, courseBottomHeightFt: bottom, liquidLevelFt: level, sg, ...rest,
    });
    if (c.error) return c;
    courses.push({ course: i + 1, bottomFt: bottom, topFt: Math.min(bottom + courseHeightFt, heightFt), ...c });
  }
  return { courses, count: n };
};

/* ------------------------------------------------------------------ *
 * Normal venting (API 2000)
 * ------------------------------------------------------------------ */

/**
 * Thermal venting. The published tables give inbreathing and
 * outbreathing per unit tank capacity; the relations here follow the
 * standard's own basis, which is the volumetric rate of the vapour
 * space cooling or warming.
 *
 * INBREATHING is the dangerous one: a cold rainstorm on a hot tank
 * cools the vapour space fast, and a tank designed for a few inches
 * of water column will collapse if it cannot draw air in quickly
 * enough.
 */
export const thermalVenting = ({ nominalBbl, latitudeFactor = 1.0, insulated = false }) => {
  if (!(nominalBbl > 0)) return { error: 'thermal venting needs a tank capacity' };
  // API 2000 basis: inbreathing at 1 scfh of air per barrel of
  // capacity for uninsulated tanks in temperate latitudes; the
  // outbreathing thermal rate is 60 percent of it for a low-volatility
  // product and equal to it for a high-volatility one.
  const inScfh = nominalBbl * 1.0 * latitudeFactor * (insulated ? 0.25 : 1);
  return {
    inbreathingScfh: inScfh,
    outbreathingScfhLowVolatility: 0.6 * inScfh,
    outbreathingScfhHighVolatility: inScfh,
    note: insulated
      ? 'insulation cuts the thermal rate substantially, and the credit taken here is the customary one; the standard allows a calculated credit for a documented insulation system'
      : null,
  };
};

/**
 * Venting from liquid movement. Pumping in displaces vapour out;
 * pumping out draws air in. For a high-volatility product the
 * outbreathing is doubled, because the incoming liquid also
 * evaporates.
 */
export const movementVenting = ({ fillBblPerHr = 0, drawBblPerHr = 0, highVolatility = false }) => {
  const ft3PerBbl = FT3_PER_BBL;
  const outScfh = fillBblPerHr * ft3PerBbl * (highVolatility ? 2 : 1);
  const inScfh = drawBblPerHr * ft3PerBbl;
  return { outbreathingScfh: outScfh, inbreathingScfh: inScfh };
};

/** Total normal venting: thermal plus movement, in each direction. */
export const normalVenting = ({
  nominalBbl, fillBblPerHr = 0, drawBblPerHr = 0,
  highVolatility = false, latitudeFactor = 1.0, insulated = false,
}) => {
  const t = thermalVenting({ nominalBbl, latitudeFactor, insulated });
  if (t.error) return t;
  const m = movementVenting({ fillBblPerHr, drawBblPerHr, highVolatility });
  const thermalOut = highVolatility
    ? t.outbreathingScfhHighVolatility
    : t.outbreathingScfhLowVolatility;
  return {
    thermal: t,
    movement: m,
    outbreathingScfh: thermalOut + m.outbreathingScfh,
    inbreathingScfh: t.inbreathingScfh + m.inbreathingScfh,
    governing: (thermalOut + m.outbreathingScfh) > (t.inbreathingScfh + m.inbreathingScfh)
      ? 'pressure (outbreathing)' : 'vacuum (inbreathing)',
    warning: t.inbreathingScfh + m.inbreathingScfh > thermalOut + m.outbreathingScfh
      ? 'vacuum governs. A tank is a thin-walled vessel designed for inches of water column, and an undersized vacuum vent will pull it flat during a cold rainstorm on a draining tank. This is the case that destroys tanks'
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Emergency (fire) venting
 * ------------------------------------------------------------------ */

/** Wetted area of a vertical tank, to the API 2000 height limit of 30 ft. */
export const wettedAreaFt2 = ({ diameterFt, liquidLevelFt }) => {
  if (!(diameterFt > 0) || !(liquidLevelFt > 0)) {
    return { error: 'wetted area needs a diameter and a liquid level' };
  }
  const effective = Math.min(liquidLevelFt, 30);
  return {
    areaFt2: Math.PI * diameterFt * effective,
    effectiveHeightFt: effective,
    note: liquidLevelFt > 30
      ? 'only the wetted shell below 30 ft counts for fire venting (API 2000): a flame does not reach higher in the standard\'s basis'
      : null,
  };
};

/**
 * Emergency venting from the API 2000 heat-input relations. The
 * published Q depends on the wetted area band, and the vent capacity
 * follows from it through the latent heat and molecular weight.
 */
export const fireVenting = ({
  wettedFt2, environmentFactor = 1.0,
  latentBtuLb = 130, molecularWeight = 90, tempR = 560,
}) => {
  if (!(wettedFt2 > 0)) return { error: 'fire venting needs a wetted area' };
  let qBtuHr;
  if (wettedFt2 < 200) qBtuHr = 20000 * wettedFt2;
  else if (wettedFt2 < 1000) qBtuHr = 199300 * wettedFt2 ** 0.566;
  else if (wettedFt2 < 2800) qBtuHr = 963400 * wettedFt2 ** 0.338;
  else qBtuHr = 21000 * wettedFt2 ** 0.82;
  qBtuHr *= environmentFactor;
  // API 2000 vent capacity in scfh of air equivalent
  const scfhAir = (1107 * qBtuHr) / (latentBtuLb * Math.sqrt(molecularWeight * tempR)) * Math.sqrt(1);
  return {
    qBtuHr,
    ventScfhAir: scfhAir,
    note: 'the fire case is normally an order of magnitude above normal venting, which is why an emergency vent or a weak roof-to-shell seam exists at all',
  };
};

/* ------------------------------------------------------------------ *
 * Evaporative losses
 * ------------------------------------------------------------------ */

/**
 * Standing (breathing) and working losses for a fixed-roof tank, in
 * the published form. This is simultaneously a money question and an
 * emissions one, and the two are the same arithmetic.
 */
export const evaporativeLosses = ({
  diameterFt, vapourSpaceHeightFt, vapourPressurePsia,
  turnoversPerYear, throughputBbl,
  molecularWeight = 65, tempSwingF = 20, avgTempR = 530,
  ventSettingPsi = 0.03, atmosphericPsia = 14.7,
  workingTurnoverFactor = 1.0, productFactor = 1.0,
}) => {
  if (!(diameterFt > 0) || !(vapourSpaceHeightFt > 0)) {
    return { error: 'losses need a tank diameter and vapour space height' };
  }
  if (!(vapourPressurePsia > 0)) {
    return { error: 'a true vapour pressure is needed: a product with none does not evaporate' };
  }
  const vapourSpaceFt3 = (Math.PI * diameterFt * diameterFt / 4) * vapourSpaceHeightFt;
  // vapour density in the space
  const vapourDensityLbFt3 = (molecularWeight * vapourPressurePsia) / (10.731 * avgTempR);
  // vapour space expansion factor: thermal plus the pressure the vent
  // holds before it lifts
  const ke = tempSwingF / avgTempR
    + Math.max(0, (vapourPressurePsia * (tempSwingF / avgTempR)) - ventSettingPsi)
      / (atmosphericPsia - vapourPressurePsia);
  const ks = 1 / (1 + 0.053 * vapourPressurePsia * vapourSpaceHeightFt);
  const standingLbYr = 365 * vapourSpaceFt3 * vapourDensityLbFt3 * ke * ks;
  const workingLbYr = Number.isFinite(throughputBbl) && throughputBbl > 0
    ? throughputBbl * FT3_PER_BBL * vapourDensityLbFt3 * workingTurnoverFactor * productFactor
    : 0;
  return {
    vapourSpaceFt3,
    vapourDensityLbFt3,
    expansionFactorKe: ke,
    saturationFactorKs: ks,
    standingLossLbYr: standingLbYr,
    workingLossLbYr: workingLbYr,
    totalLossLbYr: standingLbYr + workingLbYr,
    totalLossTonsYr: (standingLbYr + workingLbYr) / 2000,
    turnoversPerYear,
    note: 'the same arithmetic answers the money question and the emissions one: what evaporates is both lost product and a reportable release',
  };
};

/**
 * What a floating roof or a vapour recovery unit saves. Control
 * efficiencies are typed with their customary ranges named, because
 * they are equipment and operating questions rather than physics.
 */
export const lossControl = ({ uncontrolledLbYr, controlEfficiencyPct }) => {
  if (!(uncontrolledLbYr >= 0)) return { error: 'an uncontrolled loss is needed' };
  const eff = Math.min(Math.max(controlEfficiencyPct, 0), 100) / 100;
  return {
    savedLbYr: uncontrolledLbYr * eff,
    remainingLbYr: uncontrolledLbYr * (1 - eff),
    note: 'an internal floating roof customarily saves 60 to 90 percent and a vapour recovery unit 90 to 98 percent; both figures are equipment and operating questions, so they are typed here rather than assumed',
  };
};
