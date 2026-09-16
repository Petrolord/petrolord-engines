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
 * WHAT THIS PACKAGE DOES NOT CARRY. Several numbers in this module
 * belong to standards that are not in this repository, and each one is
 * named where it is used rather than guessed:
 *
 *  - the API 2000 air-equivalence relation that turns a fire duty into
 *    a required vent capacity. `fireVenting` returns the duty and
 *    WITHHOLDS the vent, by name, because the two plausible forms of
 *    that relation differ by a factor of about 24 and an undersized
 *    emergency vent is the failure this module exists to prevent.
 *  - API 650's minimum shell plate thickness band table.
 *    `minimumThicknessIn` is therefore a stated input with a stated
 *    default, and the result says which value was in force.
 *  - the diameter above which API 650 requires the variable design
 *    point method instead of the one-foot method.
 *  - the API 2000 thermal venting table above the capacity at which it
 *    stops being proportional, and the latitude and insulation credits
 *    the standard allows.
 *  - AP-42's turnover factor Kn. The turnover input that never fed it
 *    has been removed rather than echoed back as though it worked.
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
  if (Number.isFinite(fillHeightFt) && fillHeightFt < 0) {
    return { error: 'a fill height cannot be negative: a tank does not hold less than nothing' };
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
    ft3PerBbl: FT3_PER_BBL,
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
 *
 * THE MINIMUM PLATE THICKNESS IS A STATED INPUT, NOT A CONSTANT.
 * API 650 bands it by tank diameter and this package does not carry
 * the band table, so the value in force is whatever the caller states
 * and the result says so. The default below is the smallest band and
 * is therefore the least conservative choice available: a larger tank
 * needs a thicker floor on this number and the caller has to supply
 * it. Returned as `minimumThicknessIn` with `minimumThicknessBasis`
 * so no screen can print "minimum plate thickness" with no number
 * attached to the phrase.
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
  if (!(designStressPsi > 0) || !(testStressPsi > 0)) {
    return { error: 'a course needs a positive design and test allowable stress' };
  }
  if (!(minimumThicknessIn >= 0)) {
    return { error: 'the minimum plate thickness must be a stated non-negative value' };
  }
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
  let note = null;
  if (governing === 'hydrostatic test') {
    note = 'the water test governs this course, not the product: a light product does not stress the shell as hard as the water it will be tested with, and designing for the product alone would under-thickness it';
  } else if (governing === 'minimum plate thickness') {
    note = `neither the product nor the water test needs this much plate: the stated minimum of ${minimumThicknessIn} in governs this course`;
  }
  return {
    headFt: h,
    tDesignIn: tDesign,
    tTestIn: tTest,
    requiredIn: required,
    governing,
    minimumThicknessIn,
    minimumThicknessBasis: 'a stated input. API 650 bands the minimum shell plate thickness by tank diameter and this package does not carry that band table, so this value is the caller\'s and not the standard\'s',
    methodNote: 'the one-foot method. API 650 sets a diameter above which the variable design point method is required instead, and that limit is not carried here, so a large tank must be checked against the standard before this thickness is used',
    note,
  };
};

/** All courses of a tank, bottom to top, with a summary of what governs. */
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
  // A course list with no summary makes every caller re-derive the same
  // four facts, and the Suite did exactly that with its own `.some()`.
  const thickest = courses.reduce((a, b) => (b.requiredIn > a.requiredIn ? b : a));
  const testGoverned = courses.filter((c) => c.governing === 'hydrostatic test');
  const minimumGoverned = courses.filter((c) => c.governing === 'minimum plate thickness');
  return {
    courses,
    count: n,
    thickestCourse: thickest.course,
    thickestRequiredIn: thickest.requiredIn,
    governingCourse: thickest.course,
    governingReason: thickest.governing,
    testGovernedCount: testGoverned.length,
    minimumGovernedCount: minimumGoverned.length,
    minimumThicknessIn: courses[0].minimumThicknessIn,
    summary: `${n} courses. The thickest is course ${thickest.course} at ${thickest.requiredIn.toFixed(4)} in, governed by ${thickest.governing}. The water test governs ${testGoverned.length} of them and the stated ${courses[0].minimumThicknessIn} in minimum governs ${minimumGoverned.length}`,
  };
};

/* ------------------------------------------------------------------ *
 * Normal venting (API 2000)
 * ------------------------------------------------------------------ */

/**
 * Thermal venting. The published tables give inbreathing and
 * outbreathing per unit tank capacity; the relation used here is the
 * proportional one, and the capacity above which the published table
 * stops being proportional IS NOT CARRIED BY THIS PACKAGE. That limit
 * is a stated screen (`proportionalLimitBbl`), not a citation, and a
 * tank above it is warned rather than silently extrapolated.
 *
 * INBREATHING is the dangerous one: a cold rainstorm on a hot tank
 * cools the vapour space fast, and a tank designed for a few inches
 * of water column will collapse if it cannot draw air in quickly
 * enough.
 *
 * The latitude factor and the insulation credit are the engine's
 * stated choices. Neither is sourced to a document in this repository
 * and neither may be presented as published.
 */
export const thermalVenting = ({
  nominalBbl, latitudeFactor = 1.0, insulated = false,
  scfhPerBbl = 1.0, lowVolatilityOutFactor = 0.6, insulationCredit = 0.25,
  proportionalLimitBbl = 20000,
}) => {
  if (!(nominalBbl > 0)) return { error: 'thermal venting needs a tank capacity' };
  if (!(latitudeFactor > 0)) {
    return { error: 'the latitude factor must be a positive multiplier on the thermal rate' };
  }
  if (latitudeFactor > 2) {
    return { error: 'a latitude factor above 2 is outside anything this package will apply: state the thermal rate directly instead' };
  }
  const inScfh = nominalBbl * scfhPerBbl * latitudeFactor * (insulated ? insulationCredit : 1);
  const notes = [];
  if (insulated) {
    notes.push(`insulation cuts the thermal rate substantially and the credit applied here is ${insulationCredit}, which is this engine's stated choice rather than a value read from the standard; the standard allows a calculated credit for a documented insulation system`);
  }
  return {
    inbreathingScfh: inScfh,
    outbreathingScfhLowVolatility: lowVolatilityOutFactor * inScfh,
    outbreathingScfhHighVolatility: inScfh,
    scfhPerBbl,
    latitudeFactor,
    basis: `${scfhPerBbl} scfh of air per barrel of capacity for an uninsulated tank at a latitude factor of 1, with the low-volatility outbreathing at ${lowVolatilityOutFactor} of it. These factors are this engine's stated choices and are not cited to a document in this repository`,
    aboveProportionalLimit: nominalBbl > proportionalLimitBbl,
    warning: nominalBbl > proportionalLimitBbl
      ? `this tank holds ${nominalBbl.toLocaleString('en-US', { maximumFractionDigits: 1 })} bbl, above the ${proportionalLimitBbl.toLocaleString('en-US')} bbl at which this package stops claiming the thermal rate is proportional to capacity. The published table above that capacity is not carried here, so this inbreathing figure is an extrapolation and must be checked against API 2000 before a vent is bought`
      : null,
    note: notes.length ? notes.join('. ') : null,
  };
};

/**
 * Venting from liquid movement. Pumping in displaces vapour out;
 * pumping out draws air in. For a high-volatility product the
 * outbreathing is doubled, because the incoming liquid also
 * evaporates.
 */
export const movementVenting = ({ fillBblPerHr = 0, drawBblPerHr = 0, highVolatility = false }) => {
  if (!(fillBblPerHr >= 0) || !(drawBblPerHr >= 0)) {
    return { error: 'movement venting needs non-negative fill and draw rates: a negative rate is the other direction, which is the other field' };
  }
  const ft3PerBbl = FT3_PER_BBL;
  const outScfh = fillBblPerHr * ft3PerBbl * (highVolatility ? 2 : 1);
  const inScfh = drawBblPerHr * ft3PerBbl;
  return { outbreathingScfh: outScfh, inbreathingScfh: inScfh };
};

/** Total normal venting: thermal plus movement, in each direction. */
export const normalVenting = ({
  nominalBbl, fillBblPerHr = 0, drawBblPerHr = 0,
  highVolatility = false, latitudeFactor = 1.0, insulated = false,
  ...rest
}) => {
  const t = thermalVenting({ nominalBbl, latitudeFactor, insulated, ...rest });
  if (t.error) return t;
  const m = movementVenting({ fillBblPerHr, drawBblPerHr, highVolatility });
  if (m.error) return m;
  const thermalOut = highVolatility
    ? t.outbreathingScfhHighVolatility
    : t.outbreathingScfhLowVolatility;
  const out = thermalOut + m.outbreathingScfh;
  const inn = t.inbreathingScfh + m.inbreathingScfh;
  // ONE predicate, computed once. Two expressions disagreed at the tie:
  // the label said vacuum and the warning stayed silent.
  const vacuumGoverns = inn >= out;
  return {
    thermal: t,
    movement: m,
    outbreathingScfh: out,
    inbreathingScfh: inn,
    governing: vacuumGoverns ? 'vacuum (inbreathing)' : 'pressure (outbreathing)',
    thermalWarning: t.warning,
    warning: vacuumGoverns
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
 * Emergency fire venting.
 *
 * THE HEAT INPUT IS COMPUTED. THE VENT CAPACITY IS WITHHELD.
 *
 * The wetted-area heat input bands are in this package and are
 * returned. The step after them, the API 2000 relation that turns a
 * duty in Btu/hr into a required vent capacity in scfh of air
 * equivalent, is NOT in this package, and it cannot be reconstructed
 * safely from what is here:
 *
 *  - the line this engine used to carry divided by
 *    sqrt(molecularWeight * tempR) beside a dead `* Math.sqrt(1)`;
 *  - 1107 is a field-unit packaged constant with a reference
 *    temperature already folded into it, and a packaged constant
 *    cannot coexist with a free absolute temperature in the same
 *    denominator, because the answer would then depend on whether the
 *    temperature were written in Rankine or in Kelvin;
 *  - `tempR` was an input no screen exposed and it moved the answer
 *    by 29 percent across a plausible range;
 *  - if the customary packaged form 1107 Q / (L sqrt(M)) is the right
 *    one, the line that was here UNDER-STATED the required vent by
 *    about 23.7 times.
 *
 * An emergency vent that is 24 times too small is the failure this
 * module's own header says destroys tanks. A number that might be
 * wrong in that direction is worse than no number, so this returns no
 * number and says why. Get API 2000, put the relation in with its
 * clause, and the duty below is ready for it.
 */
export const FIRE_VENT_WITHHELD = 'the required vent capacity is withheld. Turning this duty into scfh of air equivalent needs the API 2000 air-equivalence relation, and this package does not carry it. The relation that used to be here divided by the square root of an absolute temperature beside a packaged field constant, which cannot both be right, and the two plausible forms of it differ by a factor of about 24. An emergency vent sized 24 times too small is how a tank is destroyed, so no figure is offered here. Size the vent from API 2000 against the heat input above, or from the vent manufacturer\'s certified capacity curve';

export const fireVenting = ({
  wettedFt2, environmentFactor = 1.0,
}) => {
  if (!(wettedFt2 > 0)) return { error: 'fire venting needs a wetted area' };
  if (!(environmentFactor > 0) || environmentFactor > 1) {
    return { error: 'the environment factor is a credit for drainage, insulation or a water spray and lies between 0 and 1: a factor above 1 would be a penalty, which this relation does not carry' };
  }
  let qBtuHr;
  let band;
  if (wettedFt2 < 200) { qBtuHr = 20000 * wettedFt2; band = 'below 200 ft2'; }
  else if (wettedFt2 < 1000) { qBtuHr = 199300 * wettedFt2 ** 0.566; band = '200 to 1000 ft2'; }
  else if (wettedFt2 < 2800) { qBtuHr = 963400 * wettedFt2 ** 0.338; band = '1000 to 2800 ft2'; }
  else { qBtuHr = 21000 * wettedFt2 ** 0.82; band = 'above 2800 ft2'; }
  qBtuHr *= environmentFactor;
  return {
    qBtuHr,
    band,
    environmentFactor,
    ventScfhAir: null,
    ventWithheld: true,
    ventWithheldReason: FIRE_VENT_WITHHELD,
    warning: wettedFt2 > 2800
      ? 'above 2800 ft2 the heat-input relation used here has no upper bound in this package. Whether the standard\'s relation, or the fire case itself, still applies to a tank this large is not something this package can answer'
      : null,
    note: 'the fire duty is normally far above the normal venting duty, which is why an emergency vent or a weak roof-to-shell seam exists at all. The two cannot be compared as vent capacities here, because the vent capacity is withheld',
  };
};

/* ------------------------------------------------------------------ *
 * Evaporative losses
 * ------------------------------------------------------------------ */

/**
 * Standing (breathing) and working losses for a fixed-roof tank, in
 * the published form. This is simultaneously a money question and an
 * emissions one, and the two are the same arithmetic.
 *
 * A true vapour pressure at or above the stated atmospheric pressure
 * is REFUSED. The vapour space expansion factor has (atmospheric - Pva)
 * in a denominator, so a product that boils at ambient returned a
 * negative annual emission below atmospheric and an infinite one at
 * it, while the total still printed positive because the working loss
 * was unaffected.
 *
 * AP-42's turnover factor Kn is not carried by this package. The
 * `turnoversPerYear` input that was here never fed it, moved nothing
 * over 1 to 500 turnovers, and was returned in the result as though
 * it had worked, so it has been removed. The turnover effect is the
 * separate, stated `workingTurnoverFactor`.
 */
export const evaporativeLosses = ({
  diameterFt, vapourSpaceHeightFt, vapourPressurePsia,
  throughputBbl,
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
  if (!(atmosphericPsia > 0)) return { error: 'a positive atmospheric pressure is needed' };
  if (vapourPressurePsia >= atmosphericPsia) {
    return {
      error: `a true vapour pressure of ${vapourPressurePsia} psia is at or above the stated atmospheric pressure of ${atmosphericPsia} psia: the product boils at ambient and this is not a fixed-roof tank problem. It needs a pressure vessel or a refrigerated tank, and these relations do not apply to it`,
    };
  }
  if (!(avgTempR > 0) || !(tempSwingF >= 0) || !(molecularWeight > 0)) {
    return { error: 'losses need a positive vapour molecular weight, a positive average absolute temperature and a non-negative temperature swing' };
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
    totalLossShortTonsYr: (standingLbYr + workingLbYr) / 2000,
    atmosphericPsia,
    ventSettingPsi,
    avgTempR,
    workingTurnoverFactor,
    productFactor,
    turnoverFactorNote: 'the turnover effect is the stated workingTurnoverFactor. AP-42\'s turnover factor Kn is not carried by this package, so a turnover count is not an input here',
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
  if (!Number.isFinite(controlEfficiencyPct)) {
    return { error: 'a control efficiency is needed: leaving it out is not the same as saying zero' };
  }
  if (controlEfficiencyPct < 0 || controlEfficiencyPct > 100) {
    return { error: `a control efficiency of ${controlEfficiencyPct} percent is impossible: it lies between 0 and 100` };
  }
  const eff = controlEfficiencyPct / 100;
  return {
    savedLbYr: uncontrolledLbYr * eff,
    remainingLbYr: uncontrolledLbYr * (1 - eff),
    controlEfficiencyPct,
    note: 'an internal floating roof customarily saves 60 to 90 percent and a vapour recovery unit 90 to 98 percent; both figures are equipment and operating questions, so they are typed here rather than assumed',
  };
};
