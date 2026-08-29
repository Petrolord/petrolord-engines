/**
 * Produced water treatment (Facilities F7).
 *
 * The predecessor Suite model was a lookup table of fixed removal
 * efficiencies multiplied stage by stage: an API separator always
 * removed 60 percent of the oil, a hydrocyclone always 90 percent,
 * whatever the water was and whatever the device was sized for. The
 * temperature and salinity inputs were collected and never used at
 * all, which is the tell: in real produced water they are most of the
 * story, because they set the water's viscosity and the density
 * difference, and those set what any of these devices can catch.
 *
 * The physics here is the standard one:
 *  - oil in produced water is a DROPLET SIZE DISTRIBUTION, taken as
 *    log-normal, not a single concentration
 *  - every device has a GRADE EFFICIENCY curve: it removes big
 *    droplets well and small ones poorly, characterised by its cut
 *    size d50
 *  - the removal a device achieves is the distribution integrated
 *    against that curve, so the SAME device on finer water performs
 *    worse, which is what actually happens and what a fixed
 *    efficiency can never express
 *  - d50 itself comes from the device physics: Stokes rise for
 *    gravity separators (API 421), centrifugal scaling for
 *    hydrocyclones, bubble attachment for flotation
 *  - and Stokes rise depends on water viscosity and the density
 *    difference, which is where temperature and salinity finally
 *    matter
 *
 * Units: SI internally (m, s, kg/m3, Pa.s, micron for droplets); the
 * Suite layer converts from bwpd and F.
 */

const G = 9.80665;

/* ------------------------------------------------------------------ *
 * Water properties: where temperature and salinity enter
 * ------------------------------------------------------------------ */

/**
 * Viscosity of water, Pa.s, by the published Vogel-type fit, then
 * corrected for salinity. Both effects are large: 25 to 90 C roughly
 * halves the viscosity twice over, and 150,000 ppm TDS raises it by
 * tens of percent. Both change what a separator can catch.
 */
export const waterViscosityPaS = ({ tC, tdsPpm = 0 }) => {
  if (!(tC > -10) || tC > 200) return { error: 'water viscosity fit holds from -10 to 200 C' };
  // Fresh water: A * 10^(B/(T - C)) with the published constants
  const muFresh = 2.414e-5 * 10 ** (247.8 / (tC + 273.15 - 140));
  // Salinity correction: roughly linear in mass fraction at these
  // concentrations (published brine data), about +1.8 relative per
  // unit mass fraction.
  const w = Math.min(Math.max(tdsPpm, 0), 300000) / 1e6;
  return { muPaS: muFresh * (1 + 1.8 * w), muFreshPaS: muFresh, salinityFactor: 1 + 1.8 * w };
};

/** Brine density, kg/m3: fresh-water density plus the dissolved solids. */
export const waterDensityKgM3 = ({ tC, tdsPpm = 0 }) => {
  // Fresh water density fit, good to ~0.1 percent from 0 to 100 C
  const rho0 = 1000 * (1 - ((tC + 288.9414) / (508929.2 * (tC + 68.12963)))
    * (tC - 3.9863) ** 2);
  const w = Math.min(Math.max(tdsPpm, 0), 300000) / 1e6;
  return rho0 + 700 * w; // dissolved solids raise density
};

/** Oil density from API gravity, corrected for temperature. */
export const oilDensityKgM3 = ({ apiGravity, tC }) => {
  const sg60 = 141.5 / (131.5 + apiGravity);
  // thermal expansion, about -0.0007 per C for crude
  return sg60 * 999.0 * (1 - 0.0007 * (tC - 15.56));
};

/* ------------------------------------------------------------------ *
 * Droplet distribution
 * ------------------------------------------------------------------ */

/**
 * Log-normal droplet volume distribution: the fraction of oil volume
 * carried by droplets SMALLER than d. Produced water is customarily
 * described this way, with d50 the volume-median diameter and sigma
 * the log-standard-deviation (typically 0.6 to 0.9; shear from a pump
 * or a choke drives d50 down and leaves sigma about where it was).
 */
const erf = (x) => {
  // Abramowitz & Stegun 7.1.26
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
};

export const logNormalCdf = ({ d, d50, sigma }) => {
  if (!(d > 0) || !(d50 > 0) || !(sigma > 0)) return NaN;
  return 0.5 * (1 + erf(Math.log(d / d50) / (sigma * Math.SQRT2)));
};

/**
 * Discretise the inlet distribution into volume bins, so a grade
 * efficiency can be integrated against it exactly rather than
 * assumed away.
 */
export const dropletBins = ({ d50, sigma, nBins = 60, spanSigma = 4 }) => {
  if (!(d50 > 0) || !(sigma > 0)) return { error: 'the distribution needs a positive d50 and sigma' };
  const lnLo = Math.log(d50) - spanSigma * sigma;
  const lnHi = Math.log(d50) + spanSigma * sigma;
  const step = (lnHi - lnLo) / nBins;
  const bins = [];
  let below = logNormalCdf({ d: Math.exp(lnLo), d50, sigma });
  for (let i = 0; i < nBins; i += 1) {
    const lnA = lnLo + step * i;
    const lnB = lnA + step;
    const dMid = Math.exp((lnA + lnB) / 2);
    const cdfB = logNormalCdf({ d: Math.exp(lnB), d50, sigma });
    bins.push({ dMicron: dMid, volumeFraction: cdfB - below });
    below = cdfB;
  }
  // normalise the truncated tails away
  const total = bins.reduce((s, b) => s + b.volumeFraction, 0);
  return { bins: bins.map((b) => ({ ...b, volumeFraction: b.volumeFraction / total })) };
};

/**
 * Grade efficiency of a device with cut size d50c and sharpness m
 * (the customary reduced-efficiency form): a droplet at the cut size
 * is removed half the time, bigger ones better, smaller ones worse.
 * m is the separation sharpness, typically 2 to 4.
 */
export const gradeEfficiency = ({ dMicron, d50cMicron, sharpness = 3 }) => {
  if (!(dMicron > 0) || !(d50cMicron > 0)) return 0;
  const r = (dMicron / d50cMicron) ** sharpness;
  return r / (1 + r);
};

/**
 * Apply a device to a distribution: integrate the grade efficiency
 * over the bins to get the removal, and return the OUTLET
 * distribution, because the next device sees finer water than the
 * inlet did. That coupling is the whole point and is exactly what a
 * table of fixed efficiencies throws away.
 */
export const applyDevice = ({ bins, d50cMicron, sharpness = 3 }) => {
  if (!Array.isArray(bins) || !bins.length) return { error: 'no inlet distribution' };
  let removed = 0;
  const out = [];
  for (const b of bins) {
    const eff = gradeEfficiency({ dMicron: b.dMicron, d50cMicron, sharpness });
    removed += b.volumeFraction * eff;
    out.push({ dMicron: b.dMicron, volumeFraction: b.volumeFraction * (1 - eff) });
  }
  const passed = 1 - removed;
  const outletBins = passed > 1e-12
    ? out.map((b) => ({ ...b, volumeFraction: b.volumeFraction / passed }))
    : out;
  return { removalFraction: removed, passFraction: passed, outletBins };
};

/** Volume-median diameter of a bin set, for reporting the shift. */
export const medianOfBins = (bins) => {
  let acc = 0;
  for (const b of bins) {
    acc += b.volumeFraction;
    if (acc >= 0.5) return b.dMicron;
  }
  return bins.length ? bins[bins.length - 1].dMicron : NaN;
};

/* ------------------------------------------------------------------ *
 * Device physics: where each d50 comes from
 * ------------------------------------------------------------------ */

/** Stokes rise velocity of an oil droplet in water, m/s. */
export const stokesRiseMS = ({ dMicron, rhoWater, rhoOil, muPaS }) => {
  if (!(dMicron > 0) || !(muPaS > 0)) return { error: 'rise velocity needs a droplet size and viscosity' };
  if (!(rhoWater > rhoOil)) return { error: 'the oil must be lighter than the water for it to rise' };
  const d = dMicron * 1e-6;
  return { vMS: (G * d * d * (rhoWater - rhoOil)) / (18 * muPaS) };
};

/**
 * API 421 gravity separator (or skim tank): the design droplet is the
 * one whose rise velocity just clears the water depth over the
 * residence time. Short-circuiting and turbulence are the published
 * correction factor F, customarily 1.3 to 1.8.
 */
export const apiSeparator = ({
  flowM3S, lengthM, widthM, depthM, rhoWater, rhoOil, muPaS, shortCircuitF = 1.5,
}) => {
  if (!(flowM3S > 0) || !(lengthM > 0) || !(widthM > 0) || !(depthM > 0)) {
    return { error: 'a gravity separator needs a positive flow and basin geometry' };
  }
  const areaPlanM2 = lengthM * widthM;
  const overflowRateMS = flowM3S / areaPlanM2;          // the classic surface loading
  const designRise = overflowRateMS * shortCircuitF;    // rise a droplet must beat
  // invert Stokes for the cut size
  const d = Math.sqrt((18 * muPaS * designRise) / (G * (rhoWater - rhoOil)));
  const horizontalVMS = flowM3S / (widthM * depthM);
  const residenceS = lengthM / horizontalVMS;
  return {
    d50cMicron: d * 1e6,
    overflowRateMS,
    horizontalVelocityMS: horizontalVMS,
    residenceS,
    warning: horizontalVMS > 0.015
      ? 'horizontal velocity above about 15 mm/s: API 421 limits it because faster flow re-entrains the oil the basin has already separated'
      : null,
  };
};

/**
 * Corrugated plate interceptor: the same physics with the plate pack
 * multiplying the effective settling area, which is why a CPI is far
 * smaller than an API basin for the same cut.
 */
export const plateInterceptor = ({
  flowM3S, plateAreaM2, nPlates, rhoWater, rhoOil, muPaS, efficiencyFactor = 0.7,
}) => {
  if (!(flowM3S > 0) || !(plateAreaM2 > 0) || !(nPlates >= 1)) {
    return { error: 'a plate pack needs a positive flow, plate area and plate count' };
  }
  const effectiveAreaM2 = plateAreaM2 * nPlates * efficiencyFactor;
  const designRise = flowM3S / effectiveAreaM2;
  const d = Math.sqrt((18 * muPaS * designRise) / (G * (rhoWater - rhoOil)));
  return {
    d50cMicron: d * 1e6,
    effectiveAreaM2,
    designRiseMS: designRise,
  };
};

/**
 * De-oiling hydrocyclone. The centrifugal field replaces gravity, so
 * the same Stokes balance runs at many g. The published scaling for
 * the cut size of a liner is
 *   d50 ~ sqrt(18 mu Dc Q_ref / (dRho * G_field))
 * expressed here through the acceleration ratio the liner develops at
 * its design flow, which is where the flow-turndown behaviour comes
 * from: a hydrocyclone starved of flow loses its g field and its cut.
 */
export const hydrocyclone = ({
  flowM3S, linerDiameterM = 0.035, nLiners = 1, designFlowPerLinerM3S = 0.0006,
  rhoWater, rhoOil, muPaS, gFieldAtDesign = 1000,
}) => {
  if (!(flowM3S > 0) || !(nLiners >= 1) || !(linerDiameterM > 0)) {
    return { error: 'a hydrocyclone needs a positive flow, liner size and liner count' };
  }
  const perLiner = flowM3S / nLiners;
  const turndown = perLiner / designFlowPerLinerM3S;
  // the g field goes as the square of the tangential velocity, i.e.
  // the square of the flow through a fixed inlet area
  const gField = gFieldAtDesign * turndown * turndown;
  if (!(gField > 0)) return { error: 'no flow through the liners: no centrifugal field, no separation' };
  const designRise = perLiner / (Math.PI * linerDiameterM * linerDiameterM / 4) / 100; // residence-scaled
  const d = Math.sqrt((18 * muPaS * designRise) / (gField * G * (rhoWater - rhoOil)));
  return {
    d50cMicron: d * 1e6,
    perLinerM3S: perLiner,
    turndownRatio: turndown,
    gField,
    warning: turndown < 0.5
      ? 'below about half the design flow per liner the centrifugal field collapses with the square of the flow, and the cut size degrades fast: shut liners in rather than running them all starved'
      : (turndown > 1.3
        ? 'above about 1.3 times design flow per liner the pressure drop and shear rise sharply, and the shear itself makes finer droplets'
        : null),
  };
};

/**
 * Gas flotation (induced or dissolved). Removal is a first-order
 * bubble-attachment process: the rate depends on the bubble flux and
 * the collision efficiency, and both favour big droplets, so an
 * equivalent cut size follows from the residence time.
 */
export const flotation = ({
  flowM3S, cellVolumeM3, nCells = 1, gasRatio = 0.3, bubbleMicron = 300,
  rhoWater, rhoOil, muPaS, collisionEfficiency = 0.5,
}) => {
  if (!(flowM3S > 0) || !(cellVolumeM3 > 0)) {
    return { error: 'flotation needs a positive flow and cell volume' };
  }
  const residenceS = (cellVolumeM3 * nCells) / flowM3S;
  const bubbleRise = stokesRiseMS({
    dMicron: bubbleMicron, rhoWater, rhoOil: 1.2, muPaS,
  });
  if (bubbleRise.error) return bubbleRise;
  // bubble number flux per unit volume, from the gas ratio
  const bubbleVolM3 = (Math.PI / 6) * (bubbleMicron * 1e-6) ** 3;
  const bubbleCountPerM3 = (gasRatio * 1) / bubbleVolM3;
  // first-order rate constant: flux x cross-section x efficiency
  const kPerS = bubbleCountPerM3 * (Math.PI / 4) * (bubbleMicron * 1e-6) ** 2
    * bubbleRise.vMS * collisionEfficiency;
  // droplets attach in proportion to their own rise plus the sweep;
  // express the result as the cut size at this residence
  const attachFraction = 1 - Math.exp(-kPerS * residenceS);
  // the equivalent gravity cut over the same residence, sharpened by
  // the flotation: the effective rise is the cell depth over residence
  const effectiveRise = (cellVolumeM3 / (flowM3S * residenceS)) / Math.max(residenceS, 1e-9);
  const d = Math.sqrt((18 * muPaS * Math.max(effectiveRise, 1e-9))
    / (G * (rhoWater - rhoOil) * Math.max(attachFraction, 1e-6)));
  return {
    d50cMicron: Math.min(d * 1e6, 500),
    residenceS,
    rateConstantPerS: kPerS,
    attachFraction,
    warning: residenceS < 60
      ? 'less than a minute of flotation residence: the attachment process needs time and this cell is too small for the flow'
      : null,
  };
};

/**
 * Deep-bed media or walnut-shell filter. Removal is depth filtration:
 * capture per unit depth, so efficiency rises exponentially with bed
 * depth and falls with loading rate.
 */
export const mediaFilter = ({
  flowM3S, areaM2, bedDepthM = 0.9, mediaMicron = 800, filterCoefficientPerM = 3.5,
}) => {
  if (!(flowM3S > 0) || !(areaM2 > 0) || !(bedDepthM > 0)) {
    return { error: 'a filter needs a positive flow, area and bed depth' };
  }
  const loadingMS = flowM3S / areaM2;
  const loadingMHr = loadingMS * 3600;
  // the filter coefficient falls with loading rate (published trend)
  const lambda = filterCoefficientPerM * (10 / Math.max(loadingMHr, 1)) ** 0.5;
  const penetration = Math.exp(-lambda * bedDepthM);
  return {
    loadingMHr,
    filterCoefficientPerM: lambda,
    removalFraction: 1 - penetration,
    // an equivalent cut size for the train arithmetic
    d50cMicron: 5 * (loadingMHr / 10) ** 0.5,
    warning: loadingMHr > 25
      ? 'loading above about 25 m/hr: media filters lose depth capture at this rate and break through early'
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * The train
 * ------------------------------------------------------------------ */

/**
 * Run a train of devices against one inlet distribution, carrying the
 * OUTLET distribution forward at every stage. Reports the oil in
 * water after each device, the droplet median as it shifts finer, and
 * whether the discharge spec is met.
 *
 * The finer-water coupling is the physical reason a train of three
 * "90 percent" devices does not remove 99.9 percent: each one leaves
 * behind the droplets the next one is worst at.
 */
export const treatmentTrain = ({
  inletOiwPpm, inletD50Micron, sigma = 0.7, devices, specPpm,
}) => {
  if (!(inletOiwPpm > 0)) return { error: 'an inlet oil-in-water concentration is needed' };
  const dist = dropletBins({ d50: inletD50Micron, sigma });
  if (dist.error) return dist;
  let bins = dist.bins;
  let oiw = inletOiwPpm;
  const stages = [];
  for (const dev of devices) {
    if (!dev || !(dev.d50cMicron > 0)) {
      stages.push({ ...dev, error: 'this device has no cut size: check its inputs' });
      continue;
    }
    const applied = applyDevice({
      bins, d50cMicron: dev.d50cMicron, sharpness: dev.sharpness ?? 3,
    });
    if (applied.error) return applied;
    oiw *= applied.passFraction;
    bins = applied.outletBins;
    stages.push({
      name: dev.name,
      d50cMicron: dev.d50cMicron,
      removalPct: applied.removalFraction * 100,
      outletOiwPpm: oiw,
      outletMedianMicron: medianOfBins(bins),
      warning: dev.warning || null,
    });
  }
  return {
    stages,
    outletOiwPpm: oiw,
    overallRemovalPct: (1 - oiw / inletOiwPpm) * 100,
    outletMedianMicron: medianOfBins(bins),
    inletMedianMicron: inletD50Micron,
    meetsSpec: specPpm > 0 ? oiw <= specPpm : null,
    marginPpm: specPpm > 0 ? specPpm - oiw : null,
  };
};
