/**
 * Flow measurement: orifice plates, turbine meters and uncertainty
 * (Facilities F12b).
 *
 * The point of a metering app is not the flow equation, which is
 * simple, but the UNCERTAINTY, which is what a custody transfer
 * argument is actually about. So this engine computes the flow and
 * then propagates the uncertainty of every input through it, and the
 * result names which term dominates. On a typical orifice run the
 * answer surprises people: the differential-pressure transmitter at
 * the bottom of its range contributes far more than the plate bore
 * ever does.
 *
 * Orifice: the AGA-3 / ISO 5167 form with the Reader-Harris/Gallagher
 * discharge coefficient, which is the published equation rather than
 * a constant, and the expansibility factor for compressible flow.
 *
 * Units: field (in, psia, F, lb/hr, scfh).
 */

/* ------------------------------------------------------------------ *
 * Reader-Harris/Gallagher discharge coefficient
 * ------------------------------------------------------------------ */

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
  const M2 = (2 * 0.47) / (1 - b); // flange taps: L2' = 0.47/(D in inches)... see below
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
  if (D < 71.12) {
    cd += 0.011 * (0.75 - b) * (2.8 - D / 25.4);
  }
  return { cd, beta: b, reynolds, l1: L1, m2Prime: M2p, unusedM2: M2 };
};

/** Expansibility (expansion) factor for compressible flow. */
export const expansibility = ({ beta, dpPsi, p1Psia, k }) => {
  if (!(p1Psia > 0) || !(k > 0)) return NaN;
  const tau = (p1Psia - dpPsi) / p1Psia;
  return 1 - (0.351 + 0.256 * beta ** 4 + 0.93 * beta ** 8) * (1 - tau ** (1 / k));
};

/* ------------------------------------------------------------------ *
 * Orifice flow
 * ------------------------------------------------------------------ */

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
  if (beta < 0.1 || beta > 0.75) {
    // still computed, but the correlation's range is stated
    // (ISO 5167 covers 0.1 to 0.75 for flange taps)
  }
  const dpPsi = dpInH2O * 0.0361273;
  const dFt = orificeIdIn / 12;
  const areaFt2 = (Math.PI * dFt * dFt) / 4;
  const eps = compressible ? expansibility({ beta, dpPsi, p1Psia, k }) : 1;

  // iterate Cd with Re
  let cd = 0.61;
  let massLbS = 0;
  let re = 1e5;
  for (let i = 0; i < 60; i += 1) {
    // qm = Cd/sqrt(1-b^4) * eps * A * sqrt(2 dP rho); dP in lbf/ft2
    const dpLbfFt2 = dpPsi * 144;
    massLbS = (cd / Math.sqrt(1 - beta ** 4)) * eps * areaFt2
      * Math.sqrt(2 * dpLbfFt2 * densityLbFt3 * 32.174);
    const velocityFtS = massLbS / (densityLbFt3 * (Math.PI * (pipeIdIn / 12) ** 2) / 4);
    re = (1488 * densityLbFt3 * velocityFtS * (pipeIdIn / 12)) / viscosityCp;
    const next = dischargeCoefficient({ beta, reynolds: Math.max(re, 1), pipeIdIn });
    if (next.error) return next;
    if (Math.abs(next.cd - cd) < 1e-12) { cd = next.cd; break; }
    cd = next.cd;
  }
  return {
    beta,
    cd,
    expansibility: eps,
    reynolds: re,
    massLbHr: massLbS * 3600,
    volumetricFt3Hr: (massLbS * 3600) / densityLbFt3,
    dpPsi,
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
 */
export const sizeOrifice = ({
  pipeIdIn, targetMassLbHr, dpInH2O, p1Psia, densityLbFt3, viscosityCp, k = 1.3,
}) => {
  if (!(targetMassLbHr > 0)) return { error: 'a target mass flow is needed' };
  const at = (beta) => {
    const r = orificeFlow({
      pipeIdIn, orificeIdIn: beta * pipeIdIn, dpInH2O, p1Psia, densityLbFt3, viscosityCp, k,
    });
    return r.error ? NaN : r.massLbHr;
  };
  let lo = 0.05; let hi = 0.8;
  if (at(hi) < targetMassLbHr) {
    return { error: 'even a 0.8 beta plate cannot pass this flow at this differential: raise the differential range or use a larger meter run' };
  }
  if (at(lo) > targetMassLbHr) {
    return { error: 'even a 0.05 beta plate passes more than this flow at this differential: lower the differential range' };
  }
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (at(mid) < targetMassLbHr) lo = mid; else hi = mid;
  }
  const beta = (lo + hi) / 2;
  const bore = beta * pipeIdIn;
  return {
    beta,
    orificeIdIn: bore,
    ...orificeFlow({
      pipeIdIn, orificeIdIn: bore, dpInH2O, p1Psia, densityLbFt3, viscosityCp, k,
    }),
  };
};

/** Permanent pressure loss across an orifice (published relation). */
export const permanentLoss = ({ dpInH2O, beta, cd = 0.61 }) => {
  if (!(dpInH2O > 0) || !(beta > 0) || beta >= 1) {
    return { error: 'permanent loss needs a differential and a valid beta' };
  }
  const r = (Math.sqrt(1 - beta ** 4 * (1 - cd * cd)) - cd * beta * beta)
    / (Math.sqrt(1 - beta ** 4 * (1 - cd * cd)) + cd * beta * beta);
  return { lossInH2O: r * dpInH2O, lossFraction: r };
};

/* ------------------------------------------------------------------ *
 * Uncertainty
 * ------------------------------------------------------------------ */

/**
 * Propagate input uncertainties through the orifice equation by the
 * root-sum-square of sensitivity times uncertainty. The sensitivities
 * come from the equation itself:
 *   qm ~ Cd, eps, d^2, (1-b^4)^-1/2, dP^1/2, rho^1/2
 *
 * The result NAMES THE DOMINANT TERM, which is the useful part: on a
 * typical run the differential transmitter at the bottom of its range
 * swamps everything else, and no amount of plate precision fixes that.
 */
export const orificeUncertainty = ({
  beta, cdUncertaintyPct = 0.5, expansibilityUncertaintyPct = 0.2,
  boreUncertaintyPct = 0.05, pipeUncertaintyPct = 0.1,
  dpUncertaintyPct = 0.5, densityUncertaintyPct = 0.3,
}) => {
  if (!(beta > 0) || beta >= 1) return { error: 'a valid beta is needed' };
  const b4 = beta ** 4;
  // sensitivity of qm to each input
  const terms = [
    { name: 'discharge coefficient', sensitivity: 1, uncertaintyPct: cdUncertaintyPct },
    { name: 'expansibility', sensitivity: 1, uncertaintyPct: expansibilityUncertaintyPct },
    { name: 'orifice bore', sensitivity: 2 + (2 * b4) / (1 - b4), uncertaintyPct: boreUncertaintyPct },
    { name: 'pipe bore', sensitivity: (2 * b4) / (1 - b4), uncertaintyPct: pipeUncertaintyPct },
    { name: 'differential pressure', sensitivity: 0.5, uncertaintyPct: dpUncertaintyPct },
    { name: 'density', sensitivity: 0.5, uncertaintyPct: densityUncertaintyPct },
  ];
  const contributions = terms.map((t) => ({
    ...t,
    contributionPct: t.sensitivity * t.uncertaintyPct,
    squared: (t.sensitivity * t.uncertaintyPct) ** 2,
  }));
  const total = Math.sqrt(contributions.reduce((s, c) => s + c.squared, 0));
  const sorted = [...contributions].sort((a, b) => b.squared - a.squared);
  return {
    totalUncertaintyPct: total,
    contributions: sorted.map((c) => ({
      ...c, shareOfVariancePct: (c.squared / (total * total)) * 100,
    })),
    dominant: sorted[0].name,
    note: `${sorted[0].name} contributes ${((sorted[0].squared / (total * total)) * 100).toFixed(0)} percent of the variance: improving anything else first is wasted effort`,
  };
};

/**
 * A differential transmitter's uncertainty as a percentage of READING
 * rises as the reading falls, because its accuracy is quoted on span.
 * This is why an orifice run has a usable turndown of about three to
 * one and no more, and it is the single most misunderstood thing in
 * gas measurement.
 */
export const transmitterUncertaintyPct = ({ dpInH2O, spanInH2O, accuracyPctOfSpan = 0.075 }) => {
  if (!(dpInH2O > 0) || !(spanInH2O > 0)) {
    return { error: 'transmitter uncertainty needs a reading and a span' };
  }
  if (dpInH2O > spanInH2O) return { error: 'the reading is above the transmitter span' };
  const pct = (accuracyPctOfSpan * spanInH2O) / dpInH2O;
  const turndown = spanInH2O / dpInH2O;
  return {
    uncertaintyPctOfReading: pct,
    turndown,
    warning: turndown > 3
      ? `at ${turndown.toFixed(1)} to 1 turndown the transmitter alone contributes ${pct.toFixed(2)} percent of reading. An orifice run has a usable turndown of about three to one because of exactly this, and a second transmitter on a lower span, or a different meter, is the answer`
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Turbine meters and meter runs
 * ------------------------------------------------------------------ */

/**
 * Turbine meter volume from pulses and a K factor, with the
 * meter-factor correction that a proving run produces.
 */
export const turbineVolume = ({ pulses, kFactorPulsesPerBbl, meterFactor = 1.0 }) => {
  if (!(pulses >= 0) || !(kFactorPulsesPerBbl > 0)) {
    return { error: 'turbine volume needs pulses and a K factor' };
  }
  return {
    indicatedBbl: pulses / kFactorPulsesPerBbl,
    grossBbl: (pulses / kFactorPulsesPerBbl) * meterFactor,
    meterFactor,
  };
};

/**
 * Straight-run requirements. These ARE table values from the
 * standards, they depend on beta and on what is upstream, and the
 * engine says so rather than pretending to compute them.
 */
export const straightRunDiameters = ({ beta, upstreamFitting = 'singleElbow' }) => {
  if (!(beta > 0) || beta >= 1) return { error: 'a valid beta is needed' };
  const table = {
    singleElbow: [[0.2, 10], [0.4, 14], [0.5, 18], [0.6, 26], [0.67, 36], [0.75, 44]],
    twoElbowsSamePlane: [[0.2, 10], [0.4, 16], [0.5, 22], [0.6, 42], [0.67, 44], [0.75, 44]],
    twoElbowsDifferentPlanes: [[0.2, 34], [0.4, 50], [0.5, 75], [0.6, 65], [0.67, 60], [0.75, 80]],
    reducer: [[0.2, 5], [0.4, 5], [0.5, 8], [0.6, 9], [0.67, 12], [0.75, 13]],
    fullBoreValve: [[0.2, 12], [0.4, 12], [0.5, 12], [0.6, 14], [0.67, 19], [0.75, 24]],
  };
  const rows = table[upstreamFitting];
  if (!rows) return { error: `no published straight-run table for '${upstreamFitting}'` };
  let need = rows[rows.length - 1][1];
  for (const [b, d] of rows) {
    if (beta <= b) { need = d; break; }
  }
  return {
    upstreamDiameters: need,
    downstreamDiameters: beta <= 0.5 ? 4 : 5,
    note: 'these are published table values, not a calculation: they depend on the fitting and the beta, and a flow conditioner shortens them substantially',
  };
};
