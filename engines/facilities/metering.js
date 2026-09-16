/**
 * Flow measurement: orifice plates, turbine meters and uncertainty
 * (Facilities F12b).
 *
 * The point of a metering app is not the flow equation, which is
 * simple, but the UNCERTAINTY, which is what a custody transfer
 * argument is actually about. So this engine computes the flow and
 * then propagates the uncertainty of every input through it, and the
 * result names which term dominates.
 *
 * WHICH TERM DOMINATES IS A RESULT, NOT A SLOGAN. This header used to
 * assert that the differential-pressure transmitter contributes far
 * more than the plate bore ever does. On a well ranged run at the top
 * of its span it does not: the discharge coefficient's own uncertainty
 * is the largest single term and the budget says so. The transmitter
 * takes over as the reading falls down the span, which is why
 * `orificeUncertainty` now takes the reading and the span and DERIVES
 * the differential term from the transmitter instead of taking a typed
 * figure that could not agree with it. The two used to be separate
 * routes that never met and were displayed side by side.
 *
 * Orifice: the AGA-3 / ISO 5167 form with the Reader-Harris/Gallagher
 * discharge coefficient, which is the published equation rather than
 * a constant, and the expansibility factor for compressible flow.
 *
 * WHAT THIS PACKAGE DOES NOT CARRY:
 *  - the published lower Reynolds number limit of the
 *    Reader-Harris/Gallagher correlation at each beta and bore. Every
 *    coefficient returned therefore carries a note saying the low
 *    Reynolds end is an extrapolation of this package rather than a
 *    validated point.
 *  - the ISO 5167 / AGA 3 straight-run table for two elbows in
 *    different planes. The column that was here FELL by 15 diameters
 *    between beta 0.5 and 0.6 and then rose by 20, which no published
 *    table does, so that fitting is WITHHELD by name rather than
 *    answered from a table that cannot be right.
 *  - the API MPMS temperature and pressure correction tables. A
 *    turbine volume here is gross and is labelled gross: there is no
 *    CTL, no CPL and no net standard volume anywhere in this module.
 *
 * Units: field (in, psia, F, lb/hr, scfh).
 */

/* ------------------------------------------------------------------ *
 * Reader-Harris/Gallagher discharge coefficient
 * ------------------------------------------------------------------ */

export const RG_REYNOLDS_BASIS = 'the published lower Reynolds number limit of this correlation, which varies with beta and bore, is not carried by this package. A coefficient returned at a low Reynolds number is an extrapolation of the equation rather than a validated point of it';

/**
 * The RG equation for a flange-tapped orifice. This is the published
 * correlation, and it is worth computing rather than using a constant
 * 0.61: across the beta and Reynolds range of a real meter run it
 * moves by several percent, which is many times the uncertainty
 * anybody is arguing about.
 */
export const dischargeCoefficient = ({ beta, reynolds, pipeIdIn }) => {
  if (!(beta > 0) || beta >= 1) return { error: 'beta must be between 0 and 1' };
  if (!(reynolds > 0)) return { error: 'a positive pipe Reynolds number is needed' };
  if (!(pipeIdIn > 0)) return { error: 'a pipe bore is needed' };
  const D = pipeIdIn * 25.4; // mm, as the correlation is written
  const b = beta;
  const A = (19000 * b / reynolds) ** 0.8;
  // Flange taps: L1 = L2' = 25.4/D(mm)
  const L1 = 25.4 / D;
  const L2p = 25.4 / D;
  const M2p = (2 * L2p) / (1 - b);
  let cd = 0.5961
    + 0.0261 * b ** 2
    - 0.216 * b ** 8
    + 0.000521 * (1e6 * b / reynolds) ** 0.7
    + (0.0188 + 0.0063 * A) * b ** 3.5 * (1e6 / reynolds) ** 0.3
    + (0.043 + 0.080 * Math.exp(-10 * L1) - 0.123 * Math.exp(-7 * L1))
      * (1 - 0.11 * A) * (b ** 4 / (1 - b ** 4))
    - 0.031 * (M2p - 0.8 * M2p ** 1.1) * b ** 1.3;
  // small-bore correction below 71.12 mm (2.8 in)
  const smallBore = D < 71.12;
  if (smallBore) {
    cd += 0.011 * (0.75 - b) * (2.8 - D / 25.4);
  }
  return {
    cd,
    beta: b,
    reynolds,
    l1: L1,
    m2Prime: M2p,
    smallBoreCorrectionApplied: smallBore,
    betaInPublishedRange: b >= 0.1 && b <= 0.75,
    reynoldsBasis: RG_REYNOLDS_BASIS,
    warning: (b < 0.1 || b > 0.75)
      ? `beta of ${b.toFixed(3)} is outside the 0.1 to 0.75 range the flange-tap correlation is published for`
      : null,
  };
};

/**
 * Expansibility (expansion) factor for compressible flow. Returns a
 * bare number, which is deliberate and is why every caller must guard
 * its arguments BEFORE calling: the differential above the static
 * pressure is refused by name in `orificeFlow`, not discovered as a
 * NaN here.
 */
export const expansibility = ({ beta, dpPsi, p1Psia, k }) => {
  if (!(p1Psia > 0) || !(k > 0)) return NaN;
  if (!(beta > 0) || beta >= 1) return NaN;
  if (!(dpPsi >= 0) || dpPsi >= p1Psia) return NaN;
  const tau = (p1Psia - dpPsi) / p1Psia;
  return 1 - (0.351 + 0.256 * beta ** 4 + 0.93 * beta ** 8) * (1 - tau ** (1 / k));
};

/* ------------------------------------------------------------------ *
 * Orifice flow
 * ------------------------------------------------------------------ */

const INH2O_TO_PSI = 0.0361273;

/**
 * Mass flow through a flange-tapped orifice, iterating the discharge
 * coefficient against the Reynolds number it depends on.
 *
 *   qm = (Cd / sqrt(1 - beta^4)) * eps * (pi/4) d^2 sqrt(2 dP rho)
 */
export const orificeFlow = ({
  pipeIdIn, orificeIdIn, dpInH2O, p1Psia, densityLbFt3, viscosityCp,
  k = 1.3, compressible = true,
}) => {
  if (!(pipeIdIn > 0) || !(orificeIdIn > 0) || orificeIdIn >= pipeIdIn) {
    return { error: 'the orifice bore must be positive and smaller than the pipe bore' };
  }
  if (!(dpInH2O > 0) || !(densityLbFt3 > 0) || !(viscosityCp > 0)) {
    return { error: 'flow needs a positive differential, density and viscosity' };
  }
  const beta = orificeIdIn / pipeIdIn;
  const dpPsi = dpInH2O * INH2O_TO_PSI;
  if (compressible) {
    if (!(p1Psia > 0)) {
      return { error: 'a compressible flow needs a positive static pressure' };
    }
    // Named, not discovered downstream as a NaN. A differential larger
    // than the line pressure used to fall through to "a positive pipe
    // Reynolds number is needed", which is not the problem.
    if (dpPsi >= p1Psia) {
      return {
        error: `the differential of ${dpInH2O} in H2O is ${dpPsi.toFixed(2)} psi, which is at or above the static pressure of ${p1Psia} psia. The downstream pressure would be zero or negative, so this is a differential range or a static pressure that is wrong rather than a flow`,
      };
    }
  }
  const dFt = orificeIdIn / 12;
  const areaFt2 = (Math.PI * dFt * dFt) / 4;
  const eps = compressible ? expansibility({ beta, dpPsi, p1Psia, k }) : 1;
  if (!Number.isFinite(eps)) {
    return { error: 'the expansibility factor did not form: check the beta, the differential, the static pressure and the specific heat ratio' };
  }

  // iterate Cd with Re
  let cd = 0.61;
  let massLbS = 0;
  let re = 1e5;
  let cdResult = null;
  for (let i = 0; i < 60; i += 1) {
    // qm = Cd/sqrt(1-b^4) * eps * A * sqrt(2 dP rho); dP in lbf/ft2
    const dpLbfFt2 = dpPsi * 144;
    massLbS = (cd / Math.sqrt(1 - beta ** 4)) * eps * areaFt2
      * Math.sqrt(2 * dpLbfFt2 * densityLbFt3 * 32.174);
    const velocityFtS = massLbS / (densityLbFt3 * (Math.PI * (pipeIdIn / 12) ** 2) / 4);
    re = (1488 * densityLbFt3 * velocityFtS * (pipeIdIn / 12)) / viscosityCp;
    const next = dischargeCoefficient({ beta, reynolds: Math.max(re, 1), pipeIdIn });
    if (next.error) return next;
    cdResult = next;
    if (Math.abs(next.cd - cd) < 1e-12) { cd = next.cd; break; }
    cd = next.cd;
  }
  return {
    beta,
    cd,
    expansibility: eps,
    reynolds: re,
    massLbHr: massLbS * 3600,
    // Named for what it is. This is the volume at the FLOWING density
    // supplied, not a standard volume: there is no base pressure or
    // base temperature anywhere in this function.
    volumetricFt3HrAtFlowing: (massLbS * 3600) / densityLbFt3,
    dpPsi,
    betaInPublishedRange: beta >= 0.1 && beta <= 0.75,
    reynoldsBasis: cdResult ? cdResult.reynoldsBasis : RG_REYNOLDS_BASIS,
    warning: beta < 0.1 || beta > 0.75
      ? `beta of ${beta.toFixed(3)} is outside the 0.1 to 0.75 range the flange-tap correlation is published for: resize the plate rather than trusting this number`
      : (beta > 0.6
        ? 'beta above 0.6: the permanent pressure loss falls but the uncertainty and the straight-run requirement both rise'
        : null),
  };
};

/**
 * Size the plate for a target flow: solve the bore that gives the
 * wanted differential, by bisection on beta.
 *
 * It brackets inside the correlation's own published beta range and it
 * NEVER RETURNS A BORE BESIDE AN ERROR. It used to: a refused flow
 * mapped to NaN, every comparison against NaN was false, both bracket
 * guards passed, and the bisection walked to the low bracket and
 * returned beta 0.05 with an error key on the same object.
 */
export const sizeOrifice = ({
  pipeIdIn, targetMassLbHr, dpInH2O, p1Psia, densityLbFt3, viscosityCp, k = 1.3,
  betaMin = 0.1, betaMax = 0.75,
}) => {
  if (!(targetMassLbHr > 0)) return { error: 'a target mass flow is needed' };
  if (!(betaMin > 0) || !(betaMax > betaMin) || betaMax >= 1) {
    return { error: 'the beta bracket must satisfy 0 < betaMin < betaMax < 1' };
  }
  const at = (beta) => orificeFlow({
    pipeIdIn, orificeIdIn: beta * pipeIdIn, dpInH2O, p1Psia, densityLbFt3, viscosityCp, k,
  });
  const hiR = at(betaMax);
  if (hiR.error) return { error: hiR.error };
  const loR = at(betaMin);
  if (loR.error) return { error: loR.error };
  if (hiR.massLbHr < targetMassLbHr) {
    return { error: `even a ${betaMax} beta plate cannot pass this flow at this differential: it passes ${hiR.massLbHr.toLocaleString('en-US', { maximumFractionDigits: 1 })} lb/hr. Raise the differential range or use a larger meter run` };
  }
  if (loR.massLbHr > targetMassLbHr) {
    return { error: `even a ${betaMin} beta plate passes more than this flow at this differential: it passes ${loR.massLbHr.toLocaleString('en-US', { maximumFractionDigits: 1 })} lb/hr. Lower the differential range` };
  }
  let lo = betaMin; let hi = betaMax;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const r = at(mid);
    if (r.error) return { error: r.error };
    if (r.massLbHr < targetMassLbHr) lo = mid; else hi = mid;
  }
  const beta = (lo + hi) / 2;
  const bore = beta * pipeIdIn;
  const flow = at(beta);
  if (flow.error) return { error: flow.error };
  return {
    beta,
    orificeIdIn: bore,
    betaBracket: [betaMin, betaMax],
    boreNote: `a plate is bored to a stock size, so ${bore.toFixed(4)} in is the bore this duty asks for rather than the bore that will be ordered. Take the nearest stock plate and recompute the differential it gives at this flow`,
    ...flow,
  };
};

/**
 * Permanent pressure loss across an orifice (published relation).
 *
 * The discharge coefficient is REQUIRED. It used to default to a
 * constant 0.61 in a module whose whole point is that 0.61 is not a
 * constant, and the default and the computed value differ by enough to
 * see on the screen.
 */
export const permanentLoss = ({ dpInH2O, beta, cd }) => {
  if (!(dpInH2O > 0) || !(beta > 0) || beta >= 1) {
    return { error: 'permanent loss needs a differential and a valid beta' };
  }
  if (!(cd > 0) || cd >= 1) {
    return { error: 'permanent loss needs the discharge coefficient of this run. This module exists to show that it is not a constant 0.61, so it will not assume one' };
  }
  const r = (Math.sqrt(1 - beta ** 4 * (1 - cd * cd)) - cd * beta * beta)
    / (Math.sqrt(1 - beta ** 4 * (1 - cd * cd)) + cd * beta * beta);
  return { lossInH2O: r * dpInH2O, lossFraction: r, cd };
};

/* ------------------------------------------------------------------ *
 * Uncertainty
 * ------------------------------------------------------------------ */

/**
 * A differential transmitter's uncertainty as a percentage of READING
 * rises as the reading falls, because its accuracy is quoted on span.
 * This is the single most misunderstood thing in gas measurement, and
 * the reason it is misunderstood is a unit confusion this function
 * used to commit itself.
 *
 * THE TURNDOWN IT REPORTS IS A DIFFERENTIAL TURNDOWN AND IT SAYS SO.
 * Flow through an orifice goes as the square root of the differential,
 * so the customary three-to-one FLOW rule is a NINE-to-one differential
 * turndown. The warning used to fire on a differential turndown of 3,
 * which is a flow turndown of 1.73, about five times too early, and the
 * sentence it fired with conflated the two quantities.
 */
export const transmitterUncertaintyPct = ({ dpInH2O, spanInH2O, accuracyPctOfSpan = 0.075 }) => {
  if (!(dpInH2O > 0) || !(spanInH2O > 0)) {
    return { error: 'transmitter uncertainty needs a reading and a span' };
  }
  if (!(accuracyPctOfSpan > 0)) {
    return { error: 'a transmitter accuracy as a percentage of span is needed' };
  }
  if (dpInH2O > spanInH2O) return { error: 'the reading is above the transmitter span' };
  const pct = (accuracyPctOfSpan * spanInH2O) / dpInH2O;
  const differentialTurndown = spanInH2O / dpInH2O;
  const flowTurndown = Math.sqrt(differentialTurndown);
  return {
    uncertaintyPctOfReading: pct,
    differentialTurndown,
    flowTurndown,
    flowTurndownLimit: 3,
    differentialTurndownLimit: 9,
    turndownNote: `a differential turndown of ${differentialTurndown.toFixed(1)} to 1 is a FLOW turndown of ${flowTurndown.toFixed(2)} to 1, because flow goes as the square root of the differential. The customary three-to-one flow rule is a nine-to-one differential turndown`,
    warning: flowTurndown > 3
      ? `at a flow turndown of ${flowTurndown.toFixed(1)} to 1, which is a differential turndown of ${differentialTurndown.toFixed(1)} to 1, the transmitter alone contributes ${pct.toFixed(2)} percent of reading. An orifice run has a usable FLOW turndown of about three to one because of exactly this, and a second transmitter on a lower span, or a different meter, is the answer`
      : null,
  };
};

/**
 * Propagate input uncertainties through the orifice equation by the
 * root-sum-square of sensitivity times uncertainty. The sensitivities
 * come from the equation itself:
 *   qm ~ Cd, eps, d^2, (1-b^4)^-1/2, dP^1/2, rho^1/2
 *
 * THE DIFFERENTIAL TERM COMES FROM THE TRANSMITTER when a reading and
 * a span are given. The budget and the transmitter used to be two
 * routes that never met: the transmitter said 0.15 percent, the budget
 * used a typed 0.5 percent, and both numbers were displayed on the
 * same screen. A typed `dpUncertaintyPct` is still accepted and is
 * used when no reading and span are given, and the result says which
 * of the two it used.
 *
 * The result NAMES THE DOMINANT TERM and now says how far ahead it is,
 * because a ranking of six numbers with no margin will name a winner
 * on a photo finish and then tell the user that improving anything
 * else is wasted effort.
 */
export const orificeUncertainty = ({
  beta, cdUncertaintyPct = 0.5, expansibilityUncertaintyPct = 0.2,
  boreUncertaintyPct = 0.05, pipeUncertaintyPct = 0.1,
  dpUncertaintyPct = 0.5, densityUncertaintyPct = 0.3,
  dpInH2O, spanInH2O, transmitterAccuracyPctOfSpan = 0.075,
}) => {
  if (!(beta > 0) || beta >= 1) return { error: 'a valid beta is needed' };
  // The differential term, from the transmitter where the caller has
  // given one, otherwise from the typed figure.
  let dpPct = dpUncertaintyPct;
  let dpSource = 'a typed differential uncertainty';
  let transmitter = null;
  if (Number.isFinite(dpInH2O) && Number.isFinite(spanInH2O)) {
    transmitter = transmitterUncertaintyPct({
      dpInH2O, spanInH2O, accuracyPctOfSpan: transmitterAccuracyPctOfSpan,
    });
    if (transmitter.error) return { error: transmitter.error };
    dpPct = transmitter.uncertaintyPctOfReading;
    dpSource = `the differential transmitter: ${transmitterAccuracyPctOfSpan} percent of a ${spanInH2O} in H2O span read at ${dpInH2O} in H2O is ${dpPct.toFixed(3)} percent of reading`;
  }
  if (!(dpPct >= 0)) return { error: 'the differential uncertainty must be non-negative' };
  const b4 = beta ** 4;
  // sensitivity of qm to each input
  const terms = [
    { name: 'discharge coefficient', sensitivity: 1, uncertaintyPct: cdUncertaintyPct },
    { name: 'expansibility', sensitivity: 1, uncertaintyPct: expansibilityUncertaintyPct },
    { name: 'orifice bore', sensitivity: 2 + (2 * b4) / (1 - b4), uncertaintyPct: boreUncertaintyPct },
    { name: 'pipe bore', sensitivity: (2 * b4) / (1 - b4), uncertaintyPct: pipeUncertaintyPct },
    { name: 'differential pressure', sensitivity: 0.5, uncertaintyPct: dpPct },
    { name: 'density', sensitivity: 0.5, uncertaintyPct: densityUncertaintyPct },
  ];
  const contributions = terms.map((t) => ({
    ...t,
    contributionPct: t.sensitivity * t.uncertaintyPct,
    squared: (t.sensitivity * t.uncertaintyPct) ** 2,
  }));
  const total = Math.sqrt(contributions.reduce((s, c) => s + c.squared, 0));
  if (!(total > 0)) {
    return { error: 'every stated uncertainty is zero, so there is no budget to apportion' };
  }
  const sorted = [...contributions].sort((a, b) => b.squared - a.squared);
  const topShare = (sorted[0].squared / (total * total)) * 100;
  const runnerUpShare = (sorted[1].squared / (total * total)) * 100;
  const leadPct = topShare - runnerUpShare;
  const clear = leadPct >= 10;
  return {
    totalUncertaintyPct: total,
    contributions: sorted.map((c) => ({
      ...c, shareOfVariancePct: (c.squared / (total * total)) * 100,
    })),
    dominant: sorted[0].name,
    dominantShareOfVariancePct: topShare,
    runnerUp: sorted[1].name,
    runnerUpShareOfVariancePct: runnerUpShare,
    dominanceIsClear: clear,
    differentialUncertaintyPct: dpPct,
    differentialUncertaintySource: dpSource,
    transmitter,
    note: clear
      ? `${sorted[0].name} contributes ${topShare.toFixed(1)} percent of the variance against ${runnerUpShare.toFixed(1)} percent for ${sorted[1].name}: spend on it first`
      : `${sorted[0].name} contributes ${topShare.toFixed(1)} percent of the variance and ${sorted[1].name} ${runnerUpShare.toFixed(1)} percent. That is too close to call a dominant term: improving either one alone will move the total very little`,
  };
};

/* ------------------------------------------------------------------ *
 * Turbine meters and meter runs
 * ------------------------------------------------------------------ */

/**
 * Turbine meter volume from pulses and a K factor, with the
 * meter-factor correction that a proving run produces.
 *
 * THE VOLUME IS GROSS AND NOTHING HERE MAKES IT NET. A net standard
 * volume needs the API MPMS temperature and pressure correction tables
 * (CTL and CPL) and this package does not carry them, so no figure
 * here may be used as a custody transfer quantity.
 */
export const turbineVolume = ({ pulses, kFactorPulsesPerBbl, meterFactor = 1.0 }) => {
  if (!(pulses >= 0) || !(kFactorPulsesPerBbl > 0)) {
    return { error: 'turbine volume needs pulses and a K factor' };
  }
  if (!(meterFactor > 0)) return { error: 'a meter factor must be positive' };
  const indicated = pulses / kFactorPulsesPerBbl;
  const offBy = Math.abs(meterFactor - 1) * 100;
  return {
    indicatedBbl: indicated,
    grossBbl: indicated * meterFactor,
    meterFactor,
    grossNote: 'gross volume at metering conditions. A net standard volume needs the API MPMS temperature and pressure corrections, and this package carries neither, so this is not a custody transfer quantity',
    warning: offBy > 1
      ? `a meter factor of ${meterFactor} is ${offBy.toFixed(1)} percent from unity. A proving run on a healthy meter lands within about one percent of 1, and further out than that is a proving failure, a wrong K factor or a damaged rotor rather than a volume. This screen is this engine's stated choice`
      : null,
  };
};

/**
 * Straight-run requirements. These ARE table values, they depend on
 * beta and on what is upstream, and the engine says so rather than
 * pretending to compute them.
 *
 * THE TWO-ELBOWS-IN-DIFFERENT-PLANES COLUMN IS WITHHELD. Swept across
 * its own breakpoints it used to return 34, 50, 75, 65, 60, 80
 * diameters for beta 0.2, 0.4, 0.5, 0.6, 0.67 and 0.75: it FELL by 15
 * diameters as beta rose and then rose by 20. A published straight-run
 * requirement rises with beta, so that column cannot be right, and it
 * cannot be repaired without the table. It is refused by name.
 *
 * None of the remaining columns is cited to a document in this
 * repository either, so all of them are labelled as this engine's
 * stated table data. Above beta 0.75 nothing is offered: the
 * flange-tap correlation the rest of this module is built on is
 * published to 0.75 and answering at 0.95 by falling through to the
 * last row is not an answer.
 */
export const STRAIGHT_RUN_WITHHELD_FITTINGS = {
  twoElbowsDifferentPlanes: 'the straight-run requirement for two elbows in different planes is withheld. The column that used to be here fell by 15 diameters between beta 0.5 and 0.6 and then rose by 20, and a published requirement rises with beta, so it cannot be right. Repairing it needs the ISO 5167 or AGA 3 table, which this package does not carry. Two elbows out of plane is the worst common upstream arrangement, so take the requirement from the standard or fit a flow conditioner',
};

export const straightRunDiameters = ({ beta, upstreamFitting = 'singleElbow' }) => {
  if (!(beta > 0) || beta >= 1) return { error: 'a valid beta is needed' };
  if (STRAIGHT_RUN_WITHHELD_FITTINGS[upstreamFitting]) {
    return {
      withheld: true,
      upstreamDiameters: null,
      downstreamDiameters: null,
      error: STRAIGHT_RUN_WITHHELD_FITTINGS[upstreamFitting],
    };
  }
  const table = {
    singleElbow: [[0.2, 10], [0.4, 14], [0.5, 18], [0.6, 26], [0.67, 36], [0.75, 44]],
    twoElbowsSamePlane: [[0.2, 10], [0.4, 16], [0.5, 22], [0.6, 42], [0.67, 44], [0.75, 44]],
    reducer: [[0.2, 5], [0.4, 5], [0.5, 8], [0.6, 9], [0.67, 12], [0.75, 13]],
    fullBoreValve: [[0.2, 12], [0.4, 12], [0.5, 12], [0.6, 14], [0.67, 19], [0.75, 24]],
  };
  const rows = table[upstreamFitting];
  if (!rows) return { error: `no straight-run table for '${upstreamFitting}'` };
  const tableMaxBeta = rows[rows.length - 1][0];
  if (beta > tableMaxBeta) {
    return {
      error: `beta of ${beta.toFixed(3)} is above ${tableMaxBeta}, where this table stops and where the flange-tap correlation this module is built on stops being published. Answering here would mean reading off the last row, which is not a requirement for this beta`,
    };
  }
  let need = rows[rows.length - 1][1];
  for (const [b, d] of rows) {
    if (beta <= b) { need = d; break; }
  }
  return {
    upstreamDiameters: need,
    downstreamDiameters: beta <= 0.5 ? 4 : 5,
    tableMaxBeta,
    note: 'these are table values, not a calculation: they depend on the fitting and the beta, and a flow conditioner shortens them substantially. They are this engine\'s stated table data and are not cited to a document in this repository',
  };
};
