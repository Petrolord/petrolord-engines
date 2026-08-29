/**
 * CO2 / H2S corrosion and integrity screening (Facilities F6).
 *
 * The predecessor Suite model was the de Waard-Milliams nomogram
 * equation multiplied by two flat fudge factors (oil wetting 0.1,
 * scale 0.2) with no velocity term at all, which is the one thing a
 * facilities engineer most needs: the same fluid in a bigger line
 * corrodes differently, and a flat multiplier cannot say that.
 *
 * What is here instead:
 *  - de Waard-Milliams 1995 in its RESISTANCE-IN-SERIES form, where
 *    the reaction rate and the mass-transfer rate combine as
 *    1/CR = 1/Vr + 1/Vm. The mass-transfer term carries velocity and
 *    diameter explicitly, so the model responds to line size the way
 *    the phenomenon does.
 *  - the published scale factor above 60 C (protective siderite forms
 *    and the rate FALLS with temperature, which is why a naive
 *    Arrhenius extrapolation of the 1991 equation is wrong hot)
 *  - CO2 fugacity rather than partial pressure at high pressure
 *  - wall shear stress, the number that actually decides whether an
 *    inhibitor film survives
 *  - inhibitor EFFICIENCY and AVAILABILITY as separate inputs,
 *    because a 95 percent inhibitor running 80 percent of the time is
 *    not a 95 percent solution and the arithmetic of that surprises
 *    people
 *  - remaining life against a stated corrosion allowance, and the
 *    NACE MR0175 sour-service region from pH2S AND pH, not a single
 *    threshold
 *
 * Units: field-adjacent SI mix as the correlations are published
 * (temperature C, pressures bar, rates mm/yr, velocity m/s, diameter
 * m). The Suite layer converts.
 */

/* ------------------------------------------------------------------ *
 * CO2 fugacity
 * ------------------------------------------------------------------ */

/**
 * Fugacity coefficient of CO2 (de Waard 1995 published form):
 *   log(a) = (0.0031 - 1.4/T_K) * P_bar,  capped at 250 bar
 * Below ~2 bar total pressure it is 1 for practical purposes.
 */
export const co2FugacityCoefficient = ({ tC, pTotalBar }) => {
  const tK = tC + 273.15;
  const p = Math.min(Math.max(pTotalBar, 0), 250);
  return 10 ** ((0.0031 - 1.4 / tK) * p);
};

export const co2Fugacity = ({ tC, pTotalBar, co2MolFrac }) => {
  if (!(pTotalBar > 0) || !(co2MolFrac >= 0)) {
    return { error: 'fugacity needs a positive total pressure and a CO2 fraction' };
  }
  const pco2 = pTotalBar * co2MolFrac;
  const a = co2FugacityCoefficient({ tC, pTotalBar });
  return { pco2Bar: pco2, fugacityCoefficient: a, fco2Bar: a * pco2 };
};

/* ------------------------------------------------------------------ *
 * de Waard-Milliams 1995
 * ------------------------------------------------------------------ */

/**
 * Reaction (kinetic) contribution:
 *   log Vr = 4.93 - 1119/T_K + 0.58 log fCO2   [mm/yr, T in K]
 */
export const dwmReactionRate = ({ tC, fco2Bar }) => {
  if (!(fco2Bar > 0)) return 0;
  const tK = tC + 273.15;
  return 10 ** (4.93 - 1119 / tK + 0.58 * Math.log10(fco2Bar));
};

/**
 * Mass-transfer contribution (de Waard 1995):
 *   Vm = 2.45 * (U^0.8 / d^0.2) * fCO2   [mm/yr, U m/s, d m]
 * This is where velocity and line size enter, and why the same fluid
 * in a bigger line at the same rate corrodes less.
 */
export const dwmMassTransferRate = ({ velocityMS, diameterM, fco2Bar }) => {
  if (!(velocityMS > 0) || !(diameterM > 0) || !(fco2Bar > 0)) return Infinity;
  return 2.45 * (velocityMS ** 0.8 / diameterM ** 0.2) * fco2Bar;
};

/**
 * Scale (protective-film) factor. Above about 60 C siderite becomes
 * protective and the rate falls with further heating; the published
 * correction is applied as a reduction factor on the combined rate.
 *   log Fscale = 2400/T_K - 0.6 log(fCO2) - 6.7    (applied when < 1)
 */
export const scaleFactor = ({ tC, fco2Bar }) => {
  if (!(fco2Bar > 0)) return 1;
  const tK = tC + 273.15;
  const logF = 2400 / tK - 0.6 * Math.log10(fco2Bar) - 6.7;
  const f = 10 ** logF;
  return f < 1 ? f : 1;
};

/**
 * pH correction relative to the saturated-water pH the correlation was
 * fitted at. Higher pH (buffered by bicarbonate or by glycol) slows
 * the cathodic reaction; the published slope is about -0.5 per pH
 * unit above the reference.
 */
export const phFactor = ({ ph, phReference = 4 }) => {
  if (!(ph > 0)) return 1;
  return ph > phReference ? 10 ** (-0.5 * (ph - phReference)) : 1;
};

/**
 * Combined de Waard-Milliams 1995 rate:
 *   1/CR = 1/Vr + 1/Vm, then scale, pH, water wetting and inhibition.
 * Every factor is reported, so the answer can be argued with rather
 * than accepted.
 */
export const corrosionRate = ({
  tC, pTotalBar, co2MolFrac, velocityMS, diameterM,
  ph, waterCutFrac = 1, flowRegime = 'waterWet',
  inhibitorEfficiencyPct = 0, inhibitorAvailabilityPct = 100,
}) => {
  const f = co2Fugacity({ tC, pTotalBar, co2MolFrac });
  if (f.error) return f;
  if (!(f.fco2Bar > 0)) {
    return {
      ...f, rateMmYr: 0, reactionMmYr: 0, massTransferMmYr: 0,
      note: 'no CO2: this model has nothing to predict, and any corrosion here is another mechanism',
    };
  }
  const vr = dwmReactionRate({ tC, fco2Bar: f.fco2Bar });
  const vm = dwmMassTransferRate({ velocityMS, diameterM, fco2Bar: f.fco2Bar });
  const combined = 1 / (1 / vr + 1 / vm);
  const fScale = scaleFactor({ tC, fco2Bar: f.fco2Bar });
  const fPh = phFactor({ ph });

  // Water wetting: an oil-continuous line does not corrode where the
  // steel is oil-wet. This is a REGIME, not a multiplier applied
  // always, so it is stated rather than assumed.
  const fWater = flowRegime === 'oilWet' ? 0 : (flowRegime === 'intermittent' ? waterCutFrac : 1);

  const uninhibited = combined * fScale * fPh * fWater;

  // Inhibition: efficiency only counts while the inhibitor is
  // available. The uninhibited rate applies for the rest of the time,
  // and that time-average is what eats the wall.
  const eff = Math.min(Math.max(inhibitorEfficiencyPct, 0), 99.9) / 100;
  const avail = Math.min(Math.max(inhibitorAvailabilityPct, 0), 100) / 100;
  const rate = uninhibited * (avail * (1 - eff) + (1 - avail));

  return {
    ...f,
    reactionMmYr: vr,
    massTransferMmYr: Number.isFinite(vm) ? vm : null,
    combinedMmYr: combined,
    controlling: Number.isFinite(vm) && vm < vr ? 'mass transfer' : 'reaction kinetics',
    scaleFactor: fScale,
    phFactor: fPh,
    waterWettingFactor: fWater,
    uninhibitedMmYr: uninhibited,
    rateMmYr: rate,
    effectiveInhibitionPct: uninhibited > 0 ? (1 - rate / uninhibited) * 100 : 0,
    warning: avail < 1 && eff > 0.9
      ? `a ${inhibitorEfficiencyPct} percent inhibitor at ${inhibitorAvailabilityPct} percent availability gives ${((1 - (avail * (1 - eff) + (1 - avail))) * 100).toFixed(0)} percent effective protection: availability, not efficiency, is what limits it`
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Wall shear stress
 * ------------------------------------------------------------------ */

/**
 * Wall shear stress from the Blasius friction factor:
 *   tau = 0.5 * f * rho * U^2,  f = 0.046 Re^-0.2 (Fanning)
 * This is the number that decides whether an inhibitor film survives;
 * above roughly 100 Pa most films are stripped and the inhibitor
 * program stops meaning what the datasheet says.
 */
export const wallShearStressPa = ({
  velocityMS, diameterM, densityKgM3, viscosityPaS,
}) => {
  if (!(velocityMS > 0) || !(diameterM > 0) || !(densityKgM3 > 0) || !(viscosityPaS > 0)) {
    return { error: 'shear stress needs positive velocity, diameter, density and viscosity' };
  }
  const re = (densityKgM3 * velocityMS * diameterM) / viscosityPaS;
  const fFanning = re > 4000 ? 0.046 * re ** -0.2 : 16 / Math.max(re, 1);
  const tau = 0.5 * fFanning * densityKgM3 * velocityMS * velocityMS;
  return {
    reynolds: re,
    fanningFriction: fFanning,
    tauPa: tau,
    filmRisk: tau > 100 ? 'high' : (tau > 50 ? 'moderate' : 'low'),
    warning: tau > 100
      ? 'wall shear above about 100 Pa: most inhibitor films are stripped at this shear, so the inhibitor efficiency on the datasheet is not what the line will see'
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * NACE MR0175 sour service
 * ------------------------------------------------------------------ */

/**
 * The sour-service severity region from H2S partial pressure AND
 * in-situ pH, which is how MR0175 / ISO 15156 actually draws it. A
 * single H2S threshold (what the predecessor used) misses that low pH
 * makes a modest H2S far more dangerous.
 *
 * Region 0 below 0.05 psi (0.0035 bar) H2S: not sour service.
 * Regions 1 to 3 above it, by increasing pH2S and decreasing pH.
 */
export const SOUR_THRESHOLD_BAR = 0.0035; // 0.05 psia

export const sourServiceRegion = ({ ph2sBar, ph }) => {
  if (!(ph2sBar >= 0)) return { error: 'H2S partial pressure must be non-negative' };
  if (ph2sBar < SOUR_THRESHOLD_BAR) {
    return {
      region: 0,
      sour: false,
      label: 'Not sour service',
      note: 'H2S partial pressure is below the 0.05 psi threshold of MR0175 / ISO 15156, so the sour-service requirements do not apply.',
    };
  }
  // Boundaries follow the shape of the ISO 15156-2 region diagram:
  // severity rises with pH2S and falls with pH.
  const x = Math.log10(ph2sBar / SOUR_THRESHOLD_BAR); // decades above threshold
  const severity = x - (ph - 3.5); // low pH shifts a case up a region
  let region;
  if (severity < 1) region = 1;
  else if (severity < 2.5) region = 2;
  else region = 3;
  const labels = {
    1: 'Region 1: mildest sour service',
    2: 'Region 2: intermediate severity',
    3: 'Region 3: most severe sour service',
  };
  return {
    region,
    sour: true,
    label: labels[region],
    decadesAboveThreshold: x,
    note: 'MR0175 / ISO 15156 region from H2S partial pressure and in-situ pH. The region sets which materials are qualified; it does not by itself set a corrosion rate.',
    materialGuidance: region === 1
      ? 'Most carbon steels qualified to MR0175 are acceptable with hardness control.'
      : (region === 2
        ? 'Carbon steel needs hardness and heat-treatment control; qualify weldments explicitly.'
        : 'Severe: qualified CRA or fully qualified low-alloy steel with documented testing. Do not extrapolate a Region 1 qualification here.'),
  };
};

/**
 * Which corrosion product governs, from the H2S to CO2 ratio. The
 * published transition is around 1:500: above it iron sulphide
 * dominates rather than iron carbonate, and a CO2-only rate model
 * stops describing the surface.
 */
export const corrosionRegime = ({ ph2sBar, pco2Bar }) => {
  if (!(pco2Bar > 0)) return { regime: 'unknown', ratio: null };
  const ratio = ph2sBar / pco2Bar;
  if (ratio < 1 / 500) {
    return { ratio, regime: 'carbonate', note: 'iron carbonate governs: the CO2 rate model applies' };
  }
  if (ratio < 1 / 20) {
    return {
      ratio,
      regime: 'mixed',
      note: 'mixed sulphide and carbonate films: the CO2 rate is an upper bound and the real rate depends on which film persists',
    };
  }
  return {
    ratio,
    regime: 'sulphide',
    note: 'iron sulphide dominates: a CO2-only model no longer describes this surface, and the rate here should come from sour-service testing rather than this correlation',
  };
};

/* ------------------------------------------------------------------ *
 * Integrity: allowance and remaining life
 * ------------------------------------------------------------------ */

/**
 * Remaining life against a corrosion allowance, and the allowance a
 * target life demands. The predecessor reported neither, which is
 * what the tile had been advertising.
 */
export const remainingLife = ({
  rateMmYr, corrosionAllowanceMm, consumedMm = 0, designLifeYears,
}) => {
  if (!(corrosionAllowanceMm > 0)) return { error: 'a positive corrosion allowance is needed' };
  if (!(rateMmYr >= 0)) return { error: 'the corrosion rate must be non-negative' };
  const remainingMm = corrosionAllowanceMm - consumedMm;
  if (remainingMm <= 0) {
    return { error: 'the corrosion allowance is already consumed: this is an inspection and fitness-for-service question, not a design one' };
  }
  const years = rateMmYr > 0 ? remainingMm / rateMmYr : Infinity;
  const requiredAllowanceMm = designLifeYears > 0 ? rateMmYr * designLifeYears : null;
  return {
    remainingMm,
    remainingYears: years,
    requiredAllowanceMm,
    meetsDesignLife: designLifeYears > 0 ? years >= designLifeYears : null,
    shortfallMm: designLifeYears > 0 && requiredAllowanceMm > remainingMm
      ? requiredAllowanceMm - remainingMm
      : 0,
  };
};

/** Customary rate bands, for labelling only. */
export const rateCategory = (mmYr) => {
  if (!(mmYr > 0)) return 'negligible';
  if (mmYr < 0.1) return 'low';
  if (mmYr < 0.5) return 'moderate';
  if (mmYr < 1.0) return 'high';
  return 'severe';
};

/**
 * The whole screening in one call, so the Suite layer stays wiring.
 */
export const screen = ({
  tC, pTotalBar, co2MolFrac, h2sMolFrac = 0, ph,
  velocityMS, diameterM, densityKgM3, viscosityPaS,
  waterCutFrac = 1, flowRegime = 'waterWet',
  inhibitorEfficiencyPct = 0, inhibitorAvailabilityPct = 100,
  corrosionAllowanceMm, consumedMm = 0, designLifeYears,
}) => {
  const rate = corrosionRate({
    tC, pTotalBar, co2MolFrac, velocityMS, diameterM, ph,
    waterCutFrac, flowRegime, inhibitorEfficiencyPct, inhibitorAvailabilityPct,
  });
  if (rate.error) return rate;
  const shear = wallShearStressPa({ velocityMS, diameterM, densityKgM3, viscosityPaS });
  const ph2sBar = pTotalBar * h2sMolFrac;
  const sour = sourServiceRegion({ ph2sBar, ph });
  const regime = corrosionRegime({ ph2sBar, pco2Bar: rate.pco2Bar });
  const life = corrosionAllowanceMm > 0
    ? remainingLife({
      rateMmYr: rate.rateMmYr, corrosionAllowanceMm, consumedMm, designLifeYears,
    })
    : null;
  return {
    rate,
    shear,
    sour,
    regime,
    life,
    category: rateCategory(rate.rateMmYr),
    ph2sBar,
  };
};
