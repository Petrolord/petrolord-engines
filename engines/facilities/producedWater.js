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
 *    log-normal, and a concentration on its own does not say how hard
 *    the oil is to remove
 *  - every device has a GRADE EFFICIENCY curve: it removes big
 *    droplets well and small ones poorly, characterised by its cut
 *    size d50c
 *  - the removal a device achieves is the distribution integrated
 *    against that curve, so the SAME device on finer water performs
 *    worse, which is what actually happens and what a fixed
 *    efficiency can never express
 *  - d50c itself comes from the device physics: Stokes rise against a
 *    surface loading for gravity separators (API 421), a radial
 *    migration in the liner's centrifugal field for hydrocyclones,
 *    bubble-attachment kinetics for flotation, and depth filtration
 *    for a media bed
 *  - and Stokes rise depends on water viscosity and the density
 *    difference, which is where temperature and salinity finally
 *    matter
 *
 * CONTRACT. Every exported function except the three leaf helpers
 * (`logNormalCdf`, `gradeEfficiency`, `medianOfBins`) returns either a
 * result object or `{ error }`, and never a NaN dressed as an answer.
 * The three leaves return a bare number and return NaN on input they
 * cannot use; they are documented as leaves at their definitions and
 * their one in-module caller turns the NaN into a named refusal.
 *
 * WHAT THIS MODULE DOES NOT KNOW. Recorded here because a stated limit
 * is the only honest form for a number this repository does not carry:
 *  - the API 421 horizontal velocity rule is implemented in its
 *    fixed-velocity half only (see `API_421`)
 *  - produced water carries DISSOLVED and soluble oil that none of
 *    these devices removes, so there is a floor under every outlet
 *    this module reports; the floor's value is not stated here and
 *    `treatmentTrain` takes it as an optional input
 *  - no discharge limit is stated anywhere in this module; the spec is
 *    the caller's, from the caller's own permit
 *  - the device shape and scale constants in `DECLARED_CONSTANTS` are
 *    this module's declared choices, not published measurements, and
 *    the gate PINS them rather than validating them
 *
 * Units: SI internally (m, s, kg/m3, Pa.s, micron for droplets); the
 * Suite layer converts from bwpd and F.
 */

const G = 9.80665;

/* ------------------------------------------------------------------ *
 * Declared constants
 *
 * Every number in this module that is a choice rather than a
 * derivation lives here, with what is behind it. NONE of these is a
 * published measurement traceable in this repository. The gate pins
 * them by value and says in as many words that a pin is not a
 * validation: what it buys is that moving one is a reviewed act
 * instead of a silent one.
 * ------------------------------------------------------------------ */
export const DECLARED_CONSTANTS = Object.freeze({
  // --- water and oil property fits ---
  /** Vogel-type fresh-water viscosity fit A * 10^(B/(T-C)), T in K. */
  vogelA: 2.414e-5,
  vogelB: 247.8,
  vogelC: 140,
  /** Relative viscosity rise per unit TDS mass fraction, brine data. */
  salinityViscosityMultiplier: 1.8,
  /** Density rise per unit TDS mass fraction, kg/m3. */
  brineDensitySlopeKgM3: 700,
  /** Crude thermal expansion, per C, and the water density the API
   *  gravity definition's specific gravity is taken against. */
  crudeThermalExpansionPerC: 0.0007,
  crudeReferenceWaterKgM3: 999.0,

  // --- the distribution grid ---
  defaultNBins: 60,
  defaultSpanSigma: 4,

  // --- grade efficiency shapes ---
  /** Reduced-efficiency sharpness for the gravity and centrifugal
   *  devices. One shape constant, worth about seventeen points of
   *  removal between m = 1 and m = 6, and it has no source here. */
  defaultSharpness: 3,
  /** Flotation and depth filtration both capture by INTERCEPTION,
   *  whose rate goes as the square of the droplet diameter, so their
   *  grade curve is an exponential in (d/d50c)^2. The reduced
   *  efficiency family with m = 2 has the same half point and the
   *  same leading power, and is what the train integrates. DERIVED,
   *  not chosen. */
  interceptionSharpness: 2,
  /** Stokes-flow interception: a droplet of diameter d is intercepted
   *  by a collector of diameter dc with efficiency A (d/dc)^2. */
  interceptionCoefficient: 1.5,

  // --- API 421 gravity basin ---
  shortCircuitFDefault: 1.5,
  plateEfficiencyFactor: 0.7,

  // --- hydrocyclone ---
  linerDiameterM: 0.035,
  linerLengthM: 0.7,
  designFlowPerLinerM3S: 0.0006,
  gFieldAtDesign: 1000,
  /** The oil core, as a fraction of the liner radius: a droplet that
   *  reaches it is in the reject stream. */
  coreRadiusFraction: 0.5,
  /** Operating envelope, in multiples of the design flow per liner. */
  starvedTurndown: 0.5,
  overloadTurndown: 1.3,
  maxTurndown: 2.0,

  // --- flotation ---
  flotationCellDepthM: 3,
  flotationGasDensityKgM3: 1.2,
  bubbleMicronDefault: 300,
  gasRatioDefault: 0.2,
  gasRatioMax: 3,
  bubbleMicronMin: 20,
  bubbleMicronMax: 2000,
  /** The probability that a collision sticks. This is the ONE number
   *  in the flotation model with no derivation at all: it is a
   *  calibration, chosen so a cell at this module's own default
   *  conditions cuts in the ten-to-twenty micron range that induced
   *  gas flotation is customarily credited with. It is an input so
   *  that a caller with a vendor curve can move it. */
  attachmentEfficiency: 0.01,
  gasHoldupWarn: 0.2,
  coarseCutWarnMicron: 100,

  // --- media / walnut shell filter ---
  filterCoefficientPerM: 3.5,
  filterReferenceLoadingMHr: 10,
  filterLoadingExponent: 0.5,
  filterReferenceDropletMicron: 20,
  filterReferenceMediaMicron: 800,
  filterBreakthroughLoadingMHr: 25,
  filterBedDepthDefaultM: 0.9,

  // --- bands ---
  /** Stokes law is stated for creeping flow. Above this Reynolds
   *  number it overstates the rise velocity and the module says so. */
  stokesReynoldsLimit: 1,
  waterViscosityMinC: -10,
  waterViscosityMaxC: 200,
  waterDensityMinC: 0,
  waterDensityMaxC: 100,
  tdsMaxPpm: 300000,
  apiGravityMin: 5,
  apiGravityMax: 100,
  sigmaMax: 2,
  sigmaCustomaryMin: 0.5,
  sigmaCustomaryMax: 1.0,
  /** The inlet spread the train assumes when the caller states none. */
  trainSigmaDefault: 0.7,
});

/**
 * API 421's horizontal velocity rule, in the half of it this module
 * can state. HELD FOR LITERATURE: the standard limits the horizontal
 * velocity to the LESSER of a fixed velocity and a multiple of the
 * design droplet's rise velocity. Only the fixed half is here, because
 * the standard is not in this repository, and every return that
 * carries the check also carries `velocityRuleComplete: false` so no
 * caller can mistake a clean bill for the whole rule.
 */
export const API_421 = Object.freeze({
  horizontalVelocityLimitMS: 0.015,
  velocityRuleComplete: false,
  velocityRuleNote: 'only the fixed-velocity half of the API 421 horizontal velocity rule is applied here: the standard also limits the horizontal velocity to a multiple of the design droplet rise velocity, and that half is not in this module because the standard is not in this repository',
  shortCircuitCustomaryMin: 1.3,
  shortCircuitCustomaryMax: 1.8,
  shortCircuitMax: 5,
});

/** The basis every concentration in this module is carried on. */
export const CONCENTRATION_BASIS = 'the removal is a fraction of the OIL, so it is dimensionless and the outlet concentration comes back on whatever basis the inlet was given on: ppm by mass in, ppm by mass out. Comparing the result with a limit written in mg/l is a conversion the caller must make, and this module states no limit.';

/** What no device in this module removes. */
export const DISSOLVED_OIL_NOTE = 'this is the DISPERSED oil the devices can catch. Produced water also carries dissolved and soluble oil that none of these devices removes, so there is a floor under any outlet this train can reach. No value for that floor is stated in this module; pass dissolvedOilFloorPpm to apply your own.';

const joinWarnings = (list) => {
  const kept = list.filter(Boolean);
  return kept.length ? kept.join('; ') : null;
};

/* ------------------------------------------------------------------ *
 * Water properties: where temperature and salinity enter
 * ------------------------------------------------------------------ */

const tdsGuard = (tdsPpm, what) => {
  if (!Number.isFinite(tdsPpm)) return { error: `${what} needs a total dissolved solids figure in ppm`, tdsPpm };
  if (tdsPpm < 0) return { error: `total dissolved solids cannot be negative and this is ${tdsPpm} ppm`, tdsPpm };
  if (tdsPpm > DECLARED_CONSTANTS.tdsMaxPpm) {
    return {
      error: `the salinity correction in this module is stated to ${DECLARED_CONSTANTS.tdsMaxPpm} ppm TDS and this is ${tdsPpm} ppm: past saturation a linear correction has nothing behind it`,
      tdsPpm,
      tdsMaxPpm: DECLARED_CONSTANTS.tdsMaxPpm,
    };
  }
  return null;
};

/**
 * Viscosity of water, Pa.s, by the Vogel-type fit, then corrected for
 * salinity. Both effects are large: 25 to 90 C roughly halves the
 * viscosity twice over, and 150,000 ppm TDS raises it by tens of
 * percent. Both change what a separator can catch.
 *
 * The TDS input used to be CLAMPED at both ends, silently, so 300,000
 * and 1,000,000 ppm returned the same viscosity to twelve digits and
 * a negative TDS was read as fresh water. It is refused now, by name.
 */
export const waterViscosityPaS = ({ tC, tdsPpm = 0 }) => {
  const { waterViscosityMinC: lo, waterViscosityMaxC: hi } = DECLARED_CONSTANTS;
  if (!Number.isFinite(tC)) return { error: 'water viscosity needs a temperature in degrees C', tC };
  if (tC < lo || tC > hi) return { error: `the water viscosity fit holds from ${lo} to ${hi} C and this is ${tC} C`, tC };
  const bad = tdsGuard(tdsPpm, 'water viscosity');
  if (bad) return bad;
  const { vogelA, vogelB, vogelC, salinityViscosityMultiplier } = DECLARED_CONSTANTS;
  const muFresh = vogelA * 10 ** (vogelB / (tC + 273.15 - vogelC));
  const w = tdsPpm / 1e6;
  const salinityFactor = 1 + salinityViscosityMultiplier * w;
  return { muPaS: muFresh * salinityFactor, muFreshPaS: muFresh, salinityFactor };
};

/**
 * Brine density, kg/m3: fresh-water density plus the dissolved solids.
 *
 * CONTRACT CHANGE (FC7-0): this used to return a bare number with no
 * guard of any kind, and answered 861.16 kg/m3 at 201 C where its own
 * neighbour refused. It returns `{ rhoKgM3 }` or `{ error }` now, over
 * the band its own fit is stated for.
 */
export const waterDensityKgM3 = ({ tC, tdsPpm = 0 }) => {
  const { waterDensityMinC: lo, waterDensityMaxC: hi } = DECLARED_CONSTANTS;
  if (!Number.isFinite(tC)) return { error: 'water density needs a temperature in degrees C', tC };
  if (tC < lo || tC > hi) return { error: `the fresh-water density fit is stated from ${lo} to ${hi} C and this is ${tC} C`, tC };
  const bad = tdsGuard(tdsPpm, 'water density');
  if (bad) return bad;
  const rho0 = 1000 * (1 - ((tC + 288.9414) / (508929.2 * (tC + 68.12963)))
    * (tC - 3.9863) ** 2);
  const w = tdsPpm / 1e6;
  return { rhoKgM3: rho0 + DECLARED_CONSTANTS.brineDensitySlopeKgM3 * w, rhoFreshKgM3: rho0 };
};

/**
 * Oil density from API gravity, corrected for temperature.
 *
 * CONTRACT CHANGE (FC7-0): a bare number before, with no guard, so an
 * API gravity of -131.5 returned Infinity and -200 returned a NEGATIVE
 * density that the Suite then printed a 3027 kg/m3 density difference
 * from. `{ rhoKgM3, sg60 }` or `{ error }` now.
 */
export const oilDensityKgM3 = ({ apiGravity, tC }) => {
  const {
    apiGravityMin, apiGravityMax, waterViscosityMinC: lo, waterViscosityMaxC: hi,
    crudeThermalExpansionPerC, crudeReferenceWaterKgM3,
  } = DECLARED_CONSTANTS;
  if (!Number.isFinite(apiGravity)) return { error: 'oil density needs an API gravity', apiGravity };
  if (apiGravity < apiGravityMin || apiGravity > apiGravityMax) {
    return { error: `this module holds API gravity to ${apiGravityMin} to ${apiGravityMax} degrees and this is ${apiGravity}`, apiGravity };
  }
  if (!Number.isFinite(tC)) return { error: 'oil density needs a temperature in degrees C', tC };
  if (tC < lo || tC > hi) return { error: `the crude thermal expansion is stated from ${lo} to ${hi} C and this is ${tC} C`, tC };
  const sg60 = 141.5 / (131.5 + apiGravity);
  return {
    rhoKgM3: sg60 * crudeReferenceWaterKgM3 * (1 - crudeThermalExpansionPerC * (tC - 15.56)),
    sg60,
  };
};

/* ------------------------------------------------------------------ *
 * Droplet distribution
 * ------------------------------------------------------------------ */

const erf = (x) => {
  // Abramowitz & Stegun 7.1.26
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
};

/**
 * LEAF. Log-normal droplet volume distribution: the fraction of oil
 * volume carried by droplets SMALLER than d. Bare number, NaN on input
 * it cannot use; its callers here turn that into a named refusal.
 */
export const logNormalCdf = ({ d, d50, sigma }) => {
  if (!(d > 0) || !(d50 > 0) || !(sigma > 0)) return NaN;
  return 0.5 * (1 + erf(Math.log(d / d50) / (sigma * Math.SQRT2)));
};

/**
 * Discretise the inlet distribution into volume bins, so a grade
 * efficiency can be integrated against it exactly rather than assumed
 * away. Each bin carries its EDGES as well as its midpoint, because
 * the median of a bin set is interpolated across the bin it falls in
 * and a bare midpoint quantises the answer to the grid (the outlet
 * median used to saturate at one bin value across six orders of
 * magnitude of outlet concentration).
 *
 * `nBins` and `spanSigma` are numerical parameters that MOVE THE
 * ANSWER, so they are reported back rather than hidden, along with the
 * volume in the truncated tails that the normalisation throws away.
 */
export const dropletBins = ({
  d50, sigma,
  nBins = DECLARED_CONSTANTS.defaultNBins,
  spanSigma = DECLARED_CONSTANTS.defaultSpanSigma,
}) => {
  const { sigmaMax, sigmaCustomaryMin, sigmaCustomaryMax } = DECLARED_CONSTANTS;
  if (!(d50 > 0)) return { error: 'the droplet distribution needs a positive median diameter d50', d50 };
  if (!(sigma > 0)) return { error: 'the droplet distribution needs a positive log-standard-deviation sigma', sigma };
  if (sigma > sigmaMax) {
    return { error: `a log-standard-deviation of ${sigma} describes a distribution far wider in diameter than produced water carries: this module holds sigma to ${sigmaMax}`, sigma };
  }
  if (!Number.isFinite(nBins) || nBins < 10 || nBins !== Math.round(nBins)) {
    return { error: `the distribution needs a whole number of bins, at least 10, and this is ${nBins}`, nBins };
  }
  if (!Number.isFinite(spanSigma) || spanSigma < 3) {
    return { error: `the distribution must span at least 3 sigma either side of the median and this spans ${spanSigma}`, spanSigma };
  }
  const lnLo = Math.log(d50) - spanSigma * sigma;
  const lnHi = Math.log(d50) + spanSigma * sigma;
  const step = (lnHi - lnLo) / nBins;
  const bins = [];
  const cdfLo = logNormalCdf({ d: Math.exp(lnLo), d50, sigma });
  let below = cdfLo;
  for (let i = 0; i < nBins; i += 1) {
    const lnA = lnLo + step * i;
    const lnB = lnA + step;
    const cdfB = logNormalCdf({ d: Math.exp(lnB), d50, sigma });
    bins.push({
      dMicron: Math.exp((lnA + lnB) / 2),
      dLoMicron: Math.exp(lnA),
      dHiMicron: Math.exp(lnB),
      volumeFraction: cdfB - below,
    });
    below = cdfB;
  }
  const total = bins.reduce((s, b) => s + b.volumeFraction, 0);
  if (!(total > 0)) return { error: 'the distribution carries no volume at these parameters', d50, sigma };
  return {
    bins: bins.map((b) => ({ ...b, volumeFraction: b.volumeFraction / total })),
    nBins,
    spanSigma,
    // what the normalisation absorbed: 2 * Phi(-spanSigma) exactly
    truncatedTailFraction: 1 - total,
    warning: (sigma < sigmaCustomaryMin || sigma > sigmaCustomaryMax)
      ? `a log-standard-deviation of ${sigma} is outside the ${sigmaCustomaryMin} to ${sigmaCustomaryMax} produced water is customarily described with: the removal this distribution gives is very sensitive to it`
      : null,
  };
};

/**
 * LEAF. Grade efficiency of a device with cut size d50c and sharpness
 * m, in the customary reduced-efficiency form: a droplet at the cut
 * size is removed half the time, bigger ones better, smaller ones
 * worse. Bare number; NaN on input it cannot use, so that the ABSENCE
 * of a device can never be mistaken for a device that caught nothing.
 */
export const gradeEfficiency = ({
  dMicron, d50cMicron, sharpness = DECLARED_CONSTANTS.defaultSharpness,
}) => {
  if (!(dMicron > 0) || !(d50cMicron > 0) || !(sharpness > 0)) return NaN;
  const r = (dMicron / d50cMicron) ** sharpness;
  if (!Number.isFinite(r)) return 1;
  return r / (1 + r);
};

/**
 * Apply a device to a distribution: integrate the grade efficiency
 * over the bins to get the removal, and return the OUTLET
 * distribution, because the next device sees finer water than the
 * inlet did. That coupling is the whole point and is exactly what a
 * table of fixed efficiencies throws away.
 */
export const applyDevice = ({
  bins, d50cMicron, sharpness = DECLARED_CONSTANTS.defaultSharpness,
}) => {
  if (!Array.isArray(bins) || !bins.length) return { error: 'no inlet droplet distribution to apply a device to' };
  if (!(d50cMicron > 0)) return { error: `a device cannot be applied without a positive cut size and this one reports ${d50cMicron}`, d50cMicron };
  if (!(sharpness > 0)) return { error: `the grade efficiency needs a positive sharpness and this is ${sharpness}`, sharpness };
  let removed = 0;
  const out = [];
  for (const b of bins) {
    const eff = gradeEfficiency({ dMicron: b.dMicron, d50cMicron, sharpness });
    if (!Number.isFinite(eff)) {
      return { error: `the grade efficiency is not a number at ${b.dMicron} micron against a cut of ${d50cMicron} micron`, d50cMicron };
    }
    removed += b.volumeFraction * eff;
    out.push({ ...b, volumeFraction: b.volumeFraction * (1 - eff) });
  }
  const passed = 1 - removed;
  const survivingVolume = out.reduce((s, b) => s + b.volumeFraction, 0);
  // Below the floor the surviving volume is numerical dust and the
  // shape of what is left means nothing. It used to be left
  // un-normalised, which made medianOfBins walk off the end of the
  // bins and report the COARSEST droplet in the distribution as the
  // median of the cleanest water the module can make.
  const normalised = survivingVolume > 1e-9;
  return {
    removalFraction: removed,
    passFraction: passed,
    survivingVolume,
    outletNormalised: normalised,
    outletBins: normalised
      ? out.map((b) => ({ ...b, volumeFraction: b.volumeFraction / survivingVolume }))
      : out,
    warning: normalised ? null
      : `this device leaves ${survivingVolume.toExponential(2)} of the oil volume behind: what is left is numerical dust and no outlet droplet median is reported for it`,
  };
};

/**
 * LEAF. Volume-median diameter of a bin set. Bare number, NaN when the
 * bins carry no volume.
 *
 * Interpolated in LOG diameter across the bin the median falls in. The
 * bare bin midpoint quantises the answer to the grid: on this module's
 * own 60 bins at sigma 0.7 one step is 6.5 percent of a diameter, so
 * the reported median used to sit on the same value across six orders
 * of magnitude of outlet concentration, and the median of the
 * UNTREATED inlet came back 4.6 percent below the d50 it was built
 * from. Interpolated, the inlet median reproduces its own d50.
 */
export const medianOfBins = (bins) => {
  if (!Array.isArray(bins) || !bins.length) return NaN;
  let total = 0;
  for (const b of bins) {
    if (!(b.volumeFraction >= 0)) return NaN;
    total += b.volumeFraction;
  }
  if (!(total > 0)) return NaN;
  let acc = 0;
  for (const b of bins) {
    const f = b.volumeFraction / total;
    if (acc + f >= 0.5) {
      if (b.dLoMicron > 0 && b.dHiMicron > b.dLoMicron && f > 0) {
        const within = (0.5 - acc) / f;
        return Math.exp(Math.log(b.dLoMicron) + within * Math.log(b.dHiMicron / b.dLoMicron));
      }
      return b.dMicron;
    }
    acc += f;
  }
  return NaN;
};

/* ------------------------------------------------------------------ *
 * Rise velocities
 * ------------------------------------------------------------------ */

/**
 * Stokes rise velocity of an oil droplet in water, m/s, with the
 * Reynolds number it implies. Stokes is creeping flow: above
 * Re about 1 it overstates the rise, and this module now says so
 * instead of returning a "cut size" at Re 1.85 in silence.
 */
export const stokesRiseMS = ({ dMicron, rhoWater, rhoOil, muPaS }) => {
  if (!(dMicron > 0)) return { error: 'rise velocity needs a positive droplet size in micron', dMicron };
  if (!(muPaS > 0)) return { error: 'rise velocity needs a positive water viscosity in Pa.s', muPaS };
  if (!(rhoWater > rhoOil)) return { error: 'the oil must be lighter than the water for it to rise', rhoWater, rhoOil };
  const d = dMicron * 1e-6;
  const vMS = (G * d * d * (rhoWater - rhoOil)) / (18 * muPaS);
  const reynolds = (rhoWater * vMS * d) / muPaS;
  return {
    vMS,
    reynolds,
    warning: reynolds > DECLARED_CONSTANTS.stokesReynoldsLimit
      ? `this droplet rises at Reynolds ${reynolds.toFixed(2)}: Stokes law is creeping flow and is stated here to Re ${DECLARED_CONSTANTS.stokesReynoldsLimit}, above which it overstates the rise velocity and so understates the cut size`
      : null,
  };
};

/**
 * Terminal rise velocity from the full drag balance, with the
 * Schiller-Naumann drag coefficient, solved by damped iteration. This
 * is the same physics as `stokesRiseMS` and reduces to it as Re goes
 * to zero; it exists because the flotation bubble rises at Reynolds in
 * the tens, where Stokes is not the settling law and the previous
 * module used it anyway.
 */
export const terminalRiseMS = ({
  dMicron, rhoHeavy, rhoLight, muPaS, maxIter = 300, tolerance = 1e-13,
}) => {
  if (!(dMicron > 0)) return { error: 'terminal rise needs a positive diameter in micron', dMicron };
  if (!(muPaS > 0)) return { error: 'terminal rise needs a positive continuous-phase viscosity in Pa.s', muPaS };
  if (!(rhoHeavy > rhoLight)) return { error: 'terminal rise needs the continuous phase to be the denser one', rhoHeavy, rhoLight };
  const d = dMicron * 1e-6;
  const dRho = rhoHeavy - rhoLight;
  let v = (G * d * d * dRho) / (18 * muPaS);
  let iterations = 0;
  let converged = false;
  for (let i = 1; i <= maxIter; i += 1) {
    iterations = i;
    const re = (rhoHeavy * v * d) / muPaS;
    const cd = re < 1e-12 ? 1e12 : (re > 1000 ? 0.44 : (24 / re) * (1 + 0.15 * re ** 0.687));
    const vBalance = Math.sqrt((4 * G * d * dRho) / (3 * cd * rhoHeavy));
    const next = 0.5 * (v + vBalance);
    const moved = Math.abs(next - v) / Math.max(next, 1e-30);
    v = next;
    if (moved <= tolerance) { converged = true; break; }
  }
  if (!converged) {
    return { error: `the terminal rise velocity did not converge in ${maxIter} iterations for a ${dMicron} micron sphere`, dMicron, iterations };
  }
  const reynolds = (rhoHeavy * v * d) / muPaS;
  return {
    vMS: v,
    reynolds,
    dragCoefficient: reynolds > 1000 ? 0.44 : (24 / reynolds) * (1 + 0.15 * reynolds ** 0.687),
    iterations,
  };
};

/* ------------------------------------------------------------------ *
 * Device physics: where each d50c comes from
 * ------------------------------------------------------------------ */

/** Every device needs these two, and each is refused by its own name. */
const fluidGuard = (what, { rhoWater, rhoOil, muPaS }) => {
  if (!Number.isFinite(muPaS) || !(muPaS > 0)) {
    return { error: `${what} needs the water viscosity in Pa.s to size its cut, and this is ${muPaS}`, muPaS };
  }
  if (!Number.isFinite(rhoWater) || !Number.isFinite(rhoOil)) {
    return { error: `${what} needs both densities in kg/m3 to size its cut`, rhoWater, rhoOil };
  }
  if (!(rhoWater > rhoOil)) {
    return { error: 'the oil must be lighter than the water for it to rise', rhoWater, rhoOil };
  }
  return null;
};

/** The Stokes cut size for a device whose droplets must rise at `riseMS`. */
const cutFromRise = (riseMS, { rhoWater, rhoOil, muPaS }) => {
  const d = Math.sqrt((18 * muPaS * riseMS) / (G * (rhoWater - rhoOil)));
  const dMicron = d * 1e6;
  return { dMicron, reynolds: (rhoWater * riseMS * d) / muPaS };
};

/**
 * API 421 gravity separator (or skim tank): the design droplet is the
 * one whose rise velocity just clears the water depth over the
 * residence time, which is the surface loading times the short-circuit
 * factor. F is the published turbulence and short-circuiting
 * allowance, customarily 1.3 to 1.8; it used to be unvalidated, and an
 * F of zero produced a cut size of exactly zero, which the train then
 * read as a broken device and silently DELETED from the train.
 */
export const apiSeparator = ({
  flowM3S, lengthM, widthM, depthM, rhoWater, rhoOil, muPaS,
  shortCircuitF = DECLARED_CONSTANTS.shortCircuitFDefault,
}) => {
  if (!(flowM3S > 0)) return { error: 'a gravity separator needs a positive flow in m3/s', flowM3S };
  if (!(lengthM > 0)) return { error: 'a gravity separator needs a positive basin length in m', lengthM };
  if (!(widthM > 0)) return { error: 'a gravity separator needs a positive basin width in m', widthM };
  if (!(depthM > 0)) return { error: 'a gravity separator needs a positive water depth in m', depthM };
  if (!(shortCircuitF > 0)) {
    return { error: `the short-circuit factor F must be positive and this is ${shortCircuitF}: an F of zero or less is not a perfect separator, it is an undefined one`, shortCircuitF };
  }
  if (shortCircuitF > API_421.shortCircuitMax) {
    return { error: `the short-circuit factor F is a turbulence allowance customarily between ${API_421.shortCircuitCustomaryMin} and ${API_421.shortCircuitCustomaryMax}, and this module holds it to ${API_421.shortCircuitMax}; this is ${shortCircuitF}`, shortCircuitF };
  }
  const bad = fluidGuard('a gravity separator', { rhoWater, rhoOil, muPaS });
  if (bad) return bad;

  const areaPlanM2 = lengthM * widthM;
  const overflowRateMS = flowM3S / areaPlanM2;       // the classic surface loading
  const designRiseMS = overflowRateMS * shortCircuitF;
  const cut = cutFromRise(designRiseMS, { rhoWater, rhoOil, muPaS });
  const horizontalVelocityMS = flowM3S / (widthM * depthM);
  const residenceS = lengthM / horizontalVelocityMS;
  return {
    d50cMicron: cut.dMicron,
    cutReynolds: cut.reynolds,
    sharpness: DECLARED_CONSTANTS.defaultSharpness,
    overflowRateMS,
    designRiseMS,
    horizontalVelocityMS,
    residenceS,
    shortCircuitF,
    horizontalVelocityLimitMS: API_421.horizontalVelocityLimitMS,
    velocityRuleComplete: API_421.velocityRuleComplete,
    velocityRuleNote: API_421.velocityRuleNote,
    warning: joinWarnings([
      horizontalVelocityMS > API_421.horizontalVelocityLimitMS
        ? `horizontal velocity ${(horizontalVelocityMS * 1000).toFixed(1)} mm/s is above the ${API_421.horizontalVelocityLimitMS * 1000} mm/s API 421 limits it to, because faster flow re-entrains the oil the basin has already separated`
        : null,
      (shortCircuitF < API_421.shortCircuitCustomaryMin || shortCircuitF > API_421.shortCircuitCustomaryMax)
        ? `a short-circuit factor of ${shortCircuitF} is outside the ${API_421.shortCircuitCustomaryMin} to ${API_421.shortCircuitCustomaryMax} API 421 is customarily read with`
        : null,
      cut.reynolds > DECLARED_CONSTANTS.stokesReynoldsLimit
        ? `the cut droplet settles at Reynolds ${cut.reynolds.toFixed(2)}, outside the creeping flow Stokes is stated for, so this cut size is optimistic`
        : null,
    ]),
  };
};

/**
 * Corrugated plate interceptor: the same physics with the plate pack
 * multiplying the effective settling area, which is why a CPI is far
 * smaller than an API basin for the same cut.
 */
export const plateInterceptor = ({
  flowM3S, plateAreaM2, nPlates, rhoWater, rhoOil, muPaS,
  efficiencyFactor = DECLARED_CONSTANTS.plateEfficiencyFactor,
}) => {
  if (!(flowM3S > 0)) return { error: 'a plate pack needs a positive flow in m3/s', flowM3S };
  if (!(plateAreaM2 > 0)) return { error: 'a plate pack needs a positive projected plate area in m2', plateAreaM2 };
  if (!(nPlates >= 1)) return { error: `a plate pack needs at least one plate and this is ${nPlates}`, nPlates };
  if (!(efficiencyFactor > 0) || efficiencyFactor > 1) {
    return { error: `the plate pack efficiency factor is the fraction of the projected area that actually settles, so it lies between 0 and 1, and this is ${efficiencyFactor}`, efficiencyFactor };
  }
  const bad = fluidGuard('a plate pack', { rhoWater, rhoOil, muPaS });
  if (bad) return bad;

  const effectiveAreaM2 = plateAreaM2 * nPlates * efficiencyFactor;
  const designRiseMS = flowM3S / effectiveAreaM2;
  const cut = cutFromRise(designRiseMS, { rhoWater, rhoOil, muPaS });
  return {
    d50cMicron: cut.dMicron,
    cutReynolds: cut.reynolds,
    sharpness: DECLARED_CONSTANTS.defaultSharpness,
    effectiveAreaM2,
    designRiseMS,
    efficiencyFactor,
    warning: cut.reynolds > DECLARED_CONSTANTS.stokesReynoldsLimit
      ? `the cut droplet settles at Reynolds ${cut.reynolds.toFixed(2)}, outside the creeping flow Stokes is stated for, so this cut size is optimistic`
      : null,
  };
};

/**
 * De-oiling hydrocyclone.
 *
 * REBUILT IN FC7-0. The previous form inverted Stokes against an axial
 * velocity divided by a bare 100, in a field that went as the SQUARE
 * of the flow with nothing above it, so the cut size fell as
 * 1/sqrt(turndown) without limit and every liner REMOVED from the bank
 * made the reported water cleaner: the shipped Suite default ran its
 * liners at 7.667 times their design flow at 58,786 g, and clearing
 * the liner count box gave one liner at 23.5 million g. A studio that
 * tells a designer to buy fewer liners is worse than no studio.
 *
 * The model now states its geometry, so the answer can be checked by
 * marching a droplet through it:
 *  - the liner is a tube of `linerDiameterM` by `linerLengthM`, and
 *    the residence time is its volume over the flow through it
 *  - the inlet spreads the droplets uniformly over the cross-section
 *    BY AREA, so the median droplet starts at the half-area radius
 *    R/sqrt(2)
 *  - a droplet is captured when it reaches the oil core, taken at
 *    `coreRadiusFraction` of the radius
 *  - so the cut size is the droplet whose radial Stokes migration in
 *    the liner's centrifugal field just crosses that gap in the
 *    residence time
 *  - the field goes as the square of the tangential velocity and so
 *    as the square of the flow, UP TO the top of the operating
 *    envelope: past `overloadTurndown` the inlet slot chokes, the
 *    field stops rising, the shear at the inlet breaks the droplets
 *    finer, and the cut gets worse rather than better
 *  - past `maxTurndown` the module refuses and says how many liners
 *    the flow needs
 *
 * The cut this ideal gives is FINER than field de-oilers are
 * customarily credited with, because it ignores re-entrainment, the
 * reject split and the shear the liner itself applies. No vendor
 * performance curve exists in this repository to calibrate against.
 * HELD FOR LITERATURE.
 */
export const hydrocyclone = ({
  flowM3S,
  linerDiameterM = DECLARED_CONSTANTS.linerDiameterM,
  linerLengthM = DECLARED_CONSTANTS.linerLengthM,
  nLiners,
  designFlowPerLinerM3S = DECLARED_CONSTANTS.designFlowPerLinerM3S,
  gFieldAtDesign = DECLARED_CONSTANTS.gFieldAtDesign,
  coreRadiusFraction = DECLARED_CONSTANTS.coreRadiusFraction,
  rhoWater, rhoOil, muPaS,
}) => {
  const { starvedTurndown, overloadTurndown, maxTurndown } = DECLARED_CONSTANTS;
  if (!(flowM3S > 0)) return { error: 'a hydrocyclone needs a positive flow in m3/s', flowM3S };
  if (!(nLiners >= 1)) return { error: `a hydrocyclone needs at least one liner and this is ${nLiners}`, nLiners };
  if (!(linerDiameterM > 0)) return { error: 'a hydrocyclone needs a positive liner bore in m', linerDiameterM };
  if (!(linerLengthM > 0)) return { error: 'a hydrocyclone needs a positive liner length in m: the residence time in the liner is what the droplet has to cross it in', linerLengthM };
  if (!(designFlowPerLinerM3S > 0)) return { error: 'a hydrocyclone needs the design flow per liner in m3/s: it is what the liner develops its rated field at', designFlowPerLinerM3S };
  if (!(gFieldAtDesign > 0)) {
    return { error: `this liner is declared to develop ${gFieldAtDesign} g at its design flow: with no field at the design point there is no centrifugal separation at any flow`, gFieldAtDesign };
  }
  if (!(coreRadiusFraction > 0) || coreRadiusFraction >= Math.SQRT1_2) {
    return { error: `the oil core must sit inside the half-area radius for the median droplet to have anything to cross, so its radius fraction lies between 0 and ${Math.SQRT1_2.toFixed(4)}, and this is ${coreRadiusFraction}`, coreRadiusFraction };
  }
  const bad = fluidGuard('a hydrocyclone', { rhoWater, rhoOil, muPaS });
  if (bad) return bad;

  const perLinerM3S = flowM3S / nLiners;
  const turndownRatio = perLinerM3S / designFlowPerLinerM3S;
  const linersAtDesignFlow = Math.ceil(flowM3S / designFlowPerLinerM3S);
  if (turndownRatio > maxTurndown) {
    return {
      error: `these ${nLiners} liners each carry ${perLinerM3S.toExponential(3)} m3/s, ${turndownRatio.toFixed(2)} times their ${designFlowPerLinerM3S} m3/s design flow: this module holds a liner bank to ${maxTurndown} times design, because past it the pressure drop and the inlet shear decide the answer and this model does not carry them. ${linersAtDesignFlow} liners would run this flow at its design point`,
      perLinerM3S,
      turndownRatio,
      designFlowPerLinerM3S,
      nLiners,
      linersAtDesignFlow,
      maxTurndown,
    };
  }

  // the field goes as the square of the tangential velocity, i.e. the
  // square of the flow through a fixed inlet slot, and stops rising
  // when the slot chokes at the top of the envelope
  const fieldTurndown = Math.min(turndownRatio, overloadTurndown);
  const gField = gFieldAtDesign * fieldTurndown * fieldTurndown;

  const radiusM = linerDiameterM / 2;
  const halfAreaRadiusM = radiusM * Math.SQRT1_2;
  const coreRadiusM = radiusM * coreRadiusFraction;
  const radialTravelM = halfAreaRadiusM - coreRadiusM;
  const linerVolumeM3 = Math.PI * radiusM * radiusM * linerLengthM;
  const residenceS = linerVolumeM3 / perLinerM3S;
  const requiredRiseMS = radialTravelM / residenceS;

  // the same Stokes balance, at gField times gravity
  const dIdeal = Math.sqrt((18 * muPaS * requiredRiseMS) / (gField * G * (rhoWater - rhoOil)));
  // above the envelope the inlet shear breaks the droplets finer, so
  // the cut the liner achieves degrades with the overload rather than
  // improving with it
  const shearPenalty = turndownRatio > overloadTurndown
    ? Math.sqrt(turndownRatio / overloadTurndown)
    : 1;
  return {
    d50cMicron: dIdeal * 1e6 * shearPenalty,
    idealD50cMicron: dIdeal * 1e6,
    shearPenalty,
    cutReynolds: (rhoWater * requiredRiseMS * dIdeal) / muPaS,
    sharpness: DECLARED_CONSTANTS.defaultSharpness,
    perLinerM3S,
    turndownRatio,
    linersAtDesignFlow,
    gField,
    gFieldAtDesign,
    designFlowPerLinerM3S,
    linerLengthM,
    linerVolumeM3,
    residenceS,
    radialTravelM,
    requiredRiseMS,
    cutBasis: 'an ideal capture: the median droplet crossing from the half-area radius to the oil core in the residence time. Re-entrainment, the reject split and the shear the liner itself applies are not in it, and field de-oilers are customarily credited with a coarser cut than this',
    warning: joinWarnings([
      turndownRatio < starvedTurndown
        ? `these liners run at ${turndownRatio.toFixed(2)} of their design flow: below about ${starvedTurndown} the centrifugal field collapses with the square of the flow and the cut size degrades fast, so shut liners in rather than running them all starved`
        : null,
      turndownRatio > overloadTurndown
        ? `these liners run at ${turndownRatio.toFixed(2)} times their design flow: above about ${overloadTurndown} the inlet slot chokes, so the field stops rising with the flow, while the inlet shear itself makes finer droplets. The cut size gets WORSE from here, not better, and ${linersAtDesignFlow} liners would run this flow at its design point`
        : null,
    ]),
  };
};

/**
 * Gas flotation, induced or dissolved.
 *
 * REBUILT IN FC7-0. The previous form computed a bubble-attachment
 * fraction that was exactly 1.000000000000 across gas ratios from
 * 0.001 to 3 and bubbles from 20 to 1500 micron, so the whole
 * attachment model was inert: the bubble size could not move the cut
 * size by a single digit, which made INDUCED and DISSOLVED gas
 * flotation numerically the same device behind two menu entries. What
 * did set the cut was an "effective rise" of
 * (V / (Q tau)) / tau, which is identically 1/(n tau) with a hidden
 * metre in it, so counting the same cell volume as 1 x 32 m3 or
 * 16 x 2 m3 changed the answer fourfold at the same residence time.
 *
 * The model now is the standard flotation kinetics, and it is a GRADE
 * EFFICIENCY rather than a single number:
 *  - the gas is fed at `gasRatio` times the water flow and rises
 *    through the cell's plan area, so the superficial gas velocity is
 *    vg = gasRatio * Q / (V / depth)
 *  - the bubble swarm's holdup is vg over the bubble rise velocity,
 *    which comes from the full drag balance, not from Stokes: a 300
 *    micron bubble rises at Reynolds in the tens
 *  - a droplet is captured by INTERCEPTION on a rising bubble, with
 *    efficiency A (d/db)^2, so the first-order rate constant is
 *      k(d) = (3/2) A eps vg d^2 / db^3
 *    in which the bubble rise velocity cancels
 *  - the cut size is the droplet for which k(d) tau = ln 2
 *
 * Every input now moves the answer: the gas ratio, the bubble size,
 * the cell depth, the cell count and the residence time. Finer bubbles
 * cut finer, which is the whole difference between DAF and IGF.
 */
export const flotation = ({
  flowM3S, cellVolumeM3, nCells = 1,
  cellDepthM = DECLARED_CONSTANTS.flotationCellDepthM,
  gasRatio = DECLARED_CONSTANTS.gasRatioDefault,
  bubbleMicron = DECLARED_CONSTANTS.bubbleMicronDefault,
  rhoWater, rhoOil, muPaS,
  attachmentEfficiency = DECLARED_CONSTANTS.attachmentEfficiency,
  gasDensityKgM3 = DECLARED_CONSTANTS.flotationGasDensityKgM3,
}) => {
  const {
    bubbleMicronMin, bubbleMicronMax, gasRatioMax, interceptionCoefficient,
    gasHoldupWarn, coarseCutWarnMicron,
  } = DECLARED_CONSTANTS;
  if (!(flowM3S > 0)) return { error: 'flotation needs a positive flow in m3/s', flowM3S };
  if (!(cellVolumeM3 > 0)) return { error: 'flotation needs a positive cell volume in m3', cellVolumeM3 };
  if (!(nCells >= 1)) return { error: `flotation needs at least one cell and this is ${nCells}`, nCells };
  if (!(cellDepthM > 0)) return { error: 'flotation needs a positive cell depth in m: it is what turns the cell volume into the plan area the gas rises through', cellDepthM };
  if (!(gasRatio > 0)) return { error: `flotation needs a positive gas-to-water ratio and this is ${gasRatio}: with no gas there is nothing for the droplets to attach to`, gasRatio };
  if (gasRatio > gasRatioMax) return { error: `a gas-to-water volume ratio of ${gasRatio} is past anything this module will describe as a flotation cell; it holds the ratio to ${gasRatioMax}`, gasRatio };
  if (!(bubbleMicron >= bubbleMicronMin) || bubbleMicron > bubbleMicronMax) {
    return { error: `the bubble diameter must lie between ${bubbleMicronMin} and ${bubbleMicronMax} micron for this attachment model and this is ${bubbleMicron}`, bubbleMicron };
  }
  if (!(attachmentEfficiency > 0) || attachmentEfficiency > 1) {
    return { error: `the attachment efficiency is the probability that a collision sticks, so it lies between 0 and 1, and this is ${attachmentEfficiency}`, attachmentEfficiency };
  }
  if (!(gasDensityKgM3 > 0)) return { error: 'flotation needs a positive gas density in kg/m3', gasDensityKgM3 };
  const bad = fluidGuard('flotation', { rhoWater, rhoOil, muPaS });
  if (bad) return bad;

  const residenceS = (cellVolumeM3 * nCells) / flowM3S;
  const planAreaM2 = cellVolumeM3 / cellDepthM;
  // the gas is induced into EACH cell at this ratio of the water flow,
  // so a four-cell unit uses four times the gas of a single cell of the
  // same total volume, and that is the only reason how you COUNT the
  // cells moves the answer: at equal total gas and equal total volume
  // the arrangement makes no difference at all
  const gasFlowM3S = gasRatio * flowM3S;
  const superficialGasMS = gasFlowM3S / planAreaM2;
  const rise = terminalRiseMS({
    dMicron: bubbleMicron, rhoHeavy: rhoWater, rhoLight: gasDensityKgM3, muPaS,
  });
  if (rise.error) return { error: `the bubble rise velocity could not be found: ${rise.error}`, bubbleMicron };
  const gasHoldup = superficialGasMS / rise.vMS;

  const dB = bubbleMicron * 1e-6;
  // k(d) = rateCoefficientPerSPerM2 * d^2, d in metres
  const rateCoefficientPerSPerM2 = (1.5 * interceptionCoefficient * attachmentEfficiency
    * superficialGasMS) / (dB * dB * dB);
  const d50c = Math.sqrt(Math.LN2 / (rateCoefficientPerSPerM2 * residenceS));
  const d50cMicron = d50c * 1e6;
  return {
    d50cMicron,
    sharpness: DECLARED_CONSTANTS.interceptionSharpness,
    residenceS,
    planAreaM2,
    gasFlowPerCellM3S: gasFlowM3S,
    totalGasFlowM3S: gasFlowM3S * nCells,
    superficialGasMS,
    bubbleRiseMS: rise.vMS,
    bubbleReynolds: rise.reynolds,
    gasHoldup,
    rateCoefficientPerSPerM2,
    attachmentEfficiency,
    bubbleMicron,
    gasRatio,
    cellDepthM,
    cutBasis: 'interception of droplets on a rising bubble swarm: the rate goes as the square of the droplet diameter and as the gas rate over the cube of the bubble diameter, and the cut size is the droplet the cell removes half of in its residence time',
    warning: joinWarnings([
      residenceS < 60
        ? `less than a minute of flotation residence (${residenceS.toFixed(1)} s): the attachment process needs time and this cell is too small for the flow`
        : null,
      gasHoldup > gasHoldupWarn
        ? `a gas holdup of ${(gasHoldup * 100).toFixed(1)} percent: past about ${gasHoldupWarn * 100} percent the bubbles coalesce and churn and a swarm of independent bubbles is no longer what is in the cell`
        : null,
      d50cMicron > coarseCutWarnMicron
        ? `a cut size of ${d50cMicron.toPrecision(4)} micron is coarser than the oil produced water customarily carries: this cell is doing very little at these conditions`
        : null,
    ]),
  };
};

/**
 * Deep-bed media or walnut-shell filter.
 *
 * REBUILT IN FC7-0. The previous form computed its removal TWICE by
 * two routes that disagreed - depth filtration said 73.83 percent
 * where the cut-size route said 84.82 percent on the same water - and
 * the train read only the cut-size route while the gate validated only
 * the depth-filtration one. The cut size was a function of the loading
 * rate alone, so the bed depth moved the train's answer by exactly
 * nothing between 0.1 m and 10 m, and the declared grain size was
 * never read at all.
 *
 * There is one route now. Depth filtration IS the physics, and the cut
 * size is an inversion of it rather than a second opinion:
 *  - capture in a packed bed is by INTERCEPTION, so the filter
 *    coefficient of a droplet of diameter d on a grain of diameter dc
 *    goes as d^2 / dc^3
 *  - lambda is declared at a reference droplet, a reference grain and
 *    a reference loading, and falls with loading rate
 *  - the penetration of a droplet through depth L is exp(-lambda L)
 *  - so the cut size is the droplet the bed removes half of:
 *    lambda(d50c) L = ln 2
 *
 * The declared triple (3.5 per m at 20 micron droplets, 800 micron
 * media and 10 m/hr) is ONE calibration of this module and has no
 * published source here.
 */
export const mediaFilter = ({
  flowM3S, areaM2,
  bedDepthM = DECLARED_CONSTANTS.filterBedDepthDefaultM,
  mediaMicron = DECLARED_CONSTANTS.filterReferenceMediaMicron,
  filterCoefficientPerM = DECLARED_CONSTANTS.filterCoefficientPerM,
  referenceDropletMicron = DECLARED_CONSTANTS.filterReferenceDropletMicron,
}) => {
  const {
    filterReferenceLoadingMHr, filterLoadingExponent, filterReferenceMediaMicron,
    filterBreakthroughLoadingMHr,
  } = DECLARED_CONSTANTS;
  if (!(flowM3S > 0)) return { error: 'a filter needs a positive flow in m3/s', flowM3S };
  if (!(areaM2 > 0)) return { error: 'a filter needs a positive bed area in m2', areaM2 };
  if (!(bedDepthM > 0)) return { error: 'a filter needs a positive bed depth in m', bedDepthM };
  if (!(mediaMicron > 0)) return { error: 'a filter needs a positive media grain size in micron', mediaMicron };
  if (!(filterCoefficientPerM > 0)) return { error: `the filter coefficient must be positive and this is ${filterCoefficientPerM}`, filterCoefficientPerM };
  if (!(referenceDropletMicron > 0)) return { error: 'the filter coefficient is declared at a reference droplet size in micron', referenceDropletMicron };

  const loadingMS = flowM3S / areaM2;
  const loadingMHr = loadingMS * 3600;
  // the filter coefficient falls with loading rate, and goes as the
  // inverse cube of the grain size at a fixed droplet size, because
  // both the number of collectors per unit volume and the
  // interception efficiency of each one depend on it
  const mediaFactor = (filterReferenceMediaMicron / mediaMicron) ** 3;
  const lambdaAtRefPerM = filterCoefficientPerM * mediaFactor
    * (filterReferenceLoadingMHr / Math.max(loadingMHr, 1)) ** filterLoadingExponent;
  const penetrationAtRefDroplet = Math.exp(-lambdaAtRefPerM * bedDepthM);
  // lambda(d) = lambdaAtRef (d / dRef)^2, so lambda(d50c) L = ln 2
  const d50cMicron = referenceDropletMicron
    * Math.sqrt(Math.LN2 / (lambdaAtRefPerM * bedDepthM));
  return {
    d50cMicron,
    sharpness: DECLARED_CONSTANTS.interceptionSharpness,
    loadingMHr,
    bedDepthM,
    mediaMicron,
    referenceDropletMicron,
    filterCoefficientPerM: lambdaAtRefPerM,
    penetrationAtRefDroplet,
    removalAtRefDroplet: 1 - penetrationAtRefDroplet,
    cutBasis: 'depth filtration, inverted: the filter coefficient is declared at a reference droplet, a reference grain and a reference loading, it goes as the square of the droplet diameter, and the cut size is the droplet the bed removes half of over its depth. The removal the train reports is this same curve integrated over the droplet distribution, not a second opinion',
    warning: loadingMHr > filterBreakthroughLoadingMHr
      ? `a loading of ${loadingMHr.toFixed(1)} m/hr is above the ${filterBreakthroughLoadingMHr} m/hr this module warns at: media filters lose depth capture at this rate and break through early`
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * The train
 * ------------------------------------------------------------------ */

/**
 * Run a train of devices against one inlet distribution, carrying the
 * OUTLET distribution forward at every stage. Reports the oil in water
 * after each device, the droplet median as it shifts finer, and
 * whether the discharge spec is met.
 *
 * The finer-water coupling is the physical reason a train of three
 * "90 percent" devices does not remove 99.9 percent: each one leaves
 * behind the droplets the next one is worst at.
 *
 * A STAGE THAT DID NOT RUN NOW WITHHOLDS THE VERDICT. This used to
 * push the raw device into the stage list, `continue`, and go on to
 * return `meetsSpec: true` with a margin, computed over whatever did
 * run, with no count and no flag: clearing the plate area box in the
 * shipped Suite studio dropped the CPI and the studio still printed
 * 1.220 ppm, 99.76 percent removal and MEETS with a 27.78 ppm margin.
 * A verdict on a train that did not run is a verdict on equipment that
 * is not there.
 */
export const treatmentTrain = ({
  inletOiwPpm, inletD50Micron, sigma = DECLARED_CONSTANTS.trainSigmaDefault,
  devices, specPpm,
  nBins = DECLARED_CONSTANTS.defaultNBins,
  spanSigma = DECLARED_CONSTANTS.defaultSpanSigma,
  dissolvedOilFloorPpm = null,
}) => {
  if (!(inletOiwPpm > 0)) return { error: 'the train needs a positive inlet oil-in-water concentration', inletOiwPpm };
  if (!Array.isArray(devices)) {
    return { error: `the train needs an array of devices and it was given ${devices === null ? 'null' : typeof devices}`, devices: typeof devices };
  }
  if (!devices.length) return { error: 'the train has no devices in it' };
  if (dissolvedOilFloorPpm !== null && dissolvedOilFloorPpm !== undefined
    && !(dissolvedOilFloorPpm > 0)) {
    return { error: `a dissolved oil floor must be a positive concentration and this is ${dissolvedOilFloorPpm}`, dissolvedOilFloorPpm };
  }
  const dist = dropletBins({ d50: inletD50Micron, sigma, nBins, spanSigma });
  if (dist.error) return dist;

  const inletBins = dist.bins;
  let bins = inletBins;
  let oiw = inletOiwPpm;
  const stages = [];
  const skippedStages = [];
  devices.forEach((dev, i) => {
    const name = (dev && dev.name) || `stage ${i + 1}`;
    if (!dev || typeof dev !== 'object') {
      stages.push({ name, ran: false, error: 'this stage is not a device' });
      skippedStages.push(name);
      return;
    }
    if (dev.error) {
      stages.push({ name, ran: false, error: `this device did not run: ${dev.error}` });
      skippedStages.push(name);
      return;
    }
    if (!(dev.d50cMicron > 0)) {
      stages.push({ name, ran: false, error: `this device reports no cut size (${dev.d50cMicron}): check its inputs` });
      skippedStages.push(name);
      return;
    }
    const sharpness = dev.sharpness ?? DECLARED_CONSTANTS.defaultSharpness;
    const coarsestMicron = bins[bins.length - 1].dHiMicron;
    const uselesslyCoarse = dev.d50cMicron > coarsestMicron;
    const applied = applyDevice({ bins, d50cMicron: dev.d50cMicron, sharpness });
    if (applied.error) {
      stages.push({ name, ran: false, error: `this device could not be applied: ${applied.error}` });
      skippedStages.push(name);
      return;
    }
    oiw *= applied.passFraction;
    bins = applied.outletBins;
    stages.push({
      name,
      ran: true,
      d50cMicron: dev.d50cMicron,
      sharpness,
      removalPct: applied.removalFraction * 100,
      outletOiwPpm: oiw,
      outletMedianMicron: applied.outletNormalised ? medianOfBins(bins) : NaN,
      warning: joinWarnings([
        dev.warning,
        applied.warning,
        uselesslyCoarse
          ? `this device cuts at ${dev.d50cMicron.toPrecision(4)} micron, coarser than the ${coarsestMicron.toPrecision(4)} micron largest droplet in the water reaching it: there is nothing here for it to catch`
          : null,
      ]),
    });
  });

  const stagesRun = stages.filter((s) => s.ran).length;
  const complete = skippedStages.length === 0;
  let outletOiwPpm = oiw;
  let floorApplied = false;
  if (dissolvedOilFloorPpm > 0 && outletOiwPpm < dissolvedOilFloorPpm) {
    outletOiwPpm = dissolvedOilFloorPpm;
    floorApplied = true;
  }

  let verdictWithheldReason = null;
  if (!complete) {
    verdictWithheldReason = `${skippedStages.length} of ${devices.length} stages did not run (${skippedStages.join(', ')}), so there is no train here to give a verdict on. The concentrations below are what the stages that DID run would leave`;
  } else if (specPpm === undefined || specPpm === null || specPpm === '') {
    verdictWithheldReason = 'no discharge specification was given';
  } else if (!(specPpm > 0)) {
    verdictWithheldReason = `a discharge specification must be a positive concentration and this is ${specPpm}`;
  }

  return {
    stages,
    stagesRun,
    stagesSkipped: skippedStages.length,
    skippedStages,
    complete,
    outletOiwPpm,
    dispersedOutletOiwPpm: oiw,
    overallRemovalPct: (1 - outletOiwPpm / inletOiwPpm) * 100,
    overallRemovalBasis: complete
      ? 'over every stage in the train'
      : `over the ${stagesRun} of ${devices.length} stages that ran`,
    outletMedianMicron: medianOfBins(bins),
    inletMedianMicron: medianOfBins(inletBins),
    inletD50Micron,
    medianBasis: 'both medians are the volume median of the same bin set, interpolated across the bin the median falls in, so they are comparable with each other',
    nBins: dist.nBins,
    spanSigma: dist.spanSigma,
    truncatedTailFraction: dist.truncatedTailFraction,
    meetsSpec: verdictWithheldReason ? null : outletOiwPpm <= specPpm,
    marginPpm: verdictWithheldReason ? null : specPpm - outletOiwPpm,
    verdictWithheldReason,
    specPpm: specPpm > 0 ? specPpm : null,
    concentrationBasis: CONCENTRATION_BASIS,
    dissolvedOilFloorPpm: dissolvedOilFloorPpm > 0 ? dissolvedOilFloorPpm : null,
    floorApplied,
    dissolvedOilNote: DISSOLVED_OIL_NOTE,
    warning: joinWarnings([
      complete ? null : `${skippedStages.length} of ${devices.length} stages did not run: ${skippedStages.join(', ')}`,
      dist.warning,
      floorApplied
        ? `the dispersed oil falls to ${oiw.toExponential(2)} ppm, below the ${dissolvedOilFloorPpm} ppm floor the caller gave, so the outlet is reported at the floor`
        : null,
    ]),
  };
};
