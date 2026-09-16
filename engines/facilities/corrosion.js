/**
 * CO2 corrosion rate screening and remaining life (Facilities F6).
 *
 * The predecessor Suite model was the de Waard-Milliams nomogram
 * equation multiplied by two flat fudge factors (oil wetting 0.1,
 * scale 0.2) with no velocity term at all, which is the one thing a
 * facilities engineer most needs: the same fluid in a bigger line
 * corrodes differently, and a flat multiplier cannot say that.
 *
 * What is here:
 *  - de Waard-Milliams 1995 in its RESISTANCE-IN-SERIES form, where
 *    the reaction rate and the mass-transfer rate combine as
 *    1/CR = 1/Vr + 1/Vm. The mass-transfer term carries velocity and
 *    diameter explicitly, so the model responds to line size the way
 *    the phenomenon does.
 *  - a protective-scale factor that reduces the rate once iron
 *    carbonate plates out, with the onset temperature COMPUTED from
 *    the correlation rather than quoted as a round number, because it
 *    moves with CO2 fugacity
 *  - CO2 fugacity rather than partial pressure at high pressure
 *  - wall shear stress, and the rate is computed WITH the inhibitor
 *    credit removed once the shear says the film is gone, so the
 *    number and the sentence beside it agree
 *  - inhibitor EFFICIENCY and AVAILABILITY as separate inputs,
 *    because a 95 percent inhibitor running 80 percent of the time is
 *    not a 95 percent solution and the arithmetic of that surprises
 *    people
 *  - remaining life against a stated corrosion allowance
 *  - a binding constraint: which of the model's own limits governs
 *
 * WHAT THIS MODULE DOES NOT PROVIDE, and will not pretend to:
 *  - a sour-service severity region and a material selection. An
 *    earlier version of this file drew regions from
 *    log10(pH2S / threshold) - (pH - 3.5) with break points at 1 and
 *    2.5, called them MR0175 / ISO 15156 regions, and served named
 *    material guidance off them. That fit was invented here. It has
 *    been WITHDRAWN rather than adjusted, because a curve carrying a
 *    standard's name and telling an engineer what steel to buy is not
 *    a tolerance question. What survives is the plain comparison of
 *    H2S partial pressure against a threshold, and the threshold value
 *    itself is HELD: it is not sourced in this repository.
 *  - an inspection interval, a minimum thickness or a retirement
 *    thickness. Those require a standard this module does not have.
 *  - a pitting, SSC, HIC, chloride, oxygen, organic-acid or
 *    top-of-line criterion, and no erosional-velocity limit.
 *  - the rate below the pH correction's reference pH, where the
 *    published behaviour is not established here. It refuses.
 *
 * EVERY CORRELATION CONSTANT IN THIS FILE IS HELD, meaning it is
 * pinned against a literal in the gate and is NOT validated by the
 * oracle, because a constant typed in two files cannot be checked by
 * comparing the two files. See `HELD_FOR_LITERATURE` below and
 * tools/validation/facilities/FINDINGS-corrosion.md.
 *
 * Units: field-adjacent SI mix as the correlations are published
 * (temperature C, pressures bar, rates mm/yr, velocity m/s, diameter
 * m). The Suite layer converts.
 */

const ABSOLUTE_ZERO_C = -273.15;

/** bar to psia, exact by definition of the bar and the pound-force. */
export const BAR_TO_PSIA = 14.503773800721815;

/**
 * Everything in this module that is a number without a source in this
 * repository. Returned in `limits` so a caller can show it rather
 * than discover it.
 */
export const HELD_FOR_LITERATURE = Object.freeze([
  'every de Waard-Milliams constant (0.0031, 1.4, the 250 bar cap, 4.93, 1119, 0.58, 2.45, the 0.8 velocity exponent, the 0.2 diameter exponent) and the published validity band of each',
  'whether the protective-scale factor multiplies the REACTION term or the COMBINED rate. This module multiplies the COMBINED rate, after the series combination. The two give materially different answers whenever mass transfer controls, which it does at typical line conditions, and which of them is the published form is not established here',
  'the scale factor constants 2400, 0.6 and 6.7, and the temperature at which the published correlation turns protective',
  'the pH correction slope of -0.5 per pH unit, its reference pH of 4, and what the correlation does BELOW that reference. This module refuses below the reference rather than returning 1',
  'the 250 bar fugacity cap and what the correlation does above it',
  'the H2S partial pressure threshold of 0.0035 bar',
  'the H2S to CO2 transition ratios of 1/500 and 1/20',
  'the 100 Pa film-stripping threshold and the 50 Pa moderate band',
  'the rate category bands of 0.1, 0.5 and 1.0 mm/yr, which carry no source and may be optimistic by one or two steps against the bands commonly cited for carbon steel in production service',
  'the Blasius coefficients 0.046 and -0.2 and the laminar to turbulent switch at Reynolds 4000',
  'an erosional-velocity criterion, a pitting criterion, and an SSC or HIC criterion, none of which this module has',
]);

/** What a caller must not read out of this module as if it were here. */
export const NOT_PROVIDED = Object.freeze([
  'a sour-service severity region: withdrawn, see the module header',
  'material selection or metallurgy guidance: withdrawn, see the module header',
  'an inspection interval',
  'a minimum or retirement thickness',
  'a fitness-for-service assessment',
  'an erosional velocity limit',
  'a pitting, SSC or HIC criterion',
  'a localised-attack rate: the one rate here is a general uniform rate',
]);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/* ------------------------------------------------------------------ *
 * CO2 fugacity
 * ------------------------------------------------------------------ */

/** The pressure above which the fugacity correlation is held flat. HELD. */
export const FUGACITY_CAP_BAR = 250;

/**
 * Fugacity coefficient of CO2 (de Waard 1995 published form):
 *   log10(a) = (0.0031 - 1.4/T_K) * P_bar,  held flat above 250 bar
 * Below about 2 bar total pressure it is 1 for practical purposes.
 * Returns NaN rather than finite garbage for a temperature at or below
 * absolute zero, or for a non-finite input.
 */
export const co2FugacityCoefficient = ({ tC, pTotalBar }) => {
  if (!finite(tC) || !finite(pTotalBar)) return NaN;
  if (tC <= ABSOLUTE_ZERO_C) return NaN;
  const tK = tC + 273.15;
  const p = Math.min(Math.max(pTotalBar, 0), FUGACITY_CAP_BAR);
  return 10 ** ((0.0031 - 1.4 / tK) * p);
};

export const co2Fugacity = ({ tC, pTotalBar, co2MolFrac }) => {
  if (!finite(tC)) return { error: 'a finite temperature is required' };
  if (tC <= ABSOLUTE_ZERO_C) return { error: `a temperature above absolute zero is required: ${tC} C is at or below ${ABSOLUTE_ZERO_C} C` };
  if (!finite(pTotalBar) || !(pTotalBar > 0)) return { error: 'a positive total pressure is required' };
  if (!finite(co2MolFrac)) return { error: 'a finite CO2 mole fraction is required' };
  if (co2MolFrac < 0 || co2MolFrac > 1) return { error: `the CO2 mole fraction must be between 0 and 1: ${co2MolFrac} is outside it` };
  const pco2 = pTotalBar * co2MolFrac;
  const a = co2FugacityCoefficient({ tC, pTotalBar });
  const capped = pTotalBar > FUGACITY_CAP_BAR;
  return {
    pco2Bar: pco2,
    fugacityCoefficient: a,
    fco2Bar: a * pco2,
    pressureCapApplied: capped,
    pressureCapBar: FUGACITY_CAP_BAR,
    note: capped
      ? `the fugacity coefficient is held at its ${FUGACITY_CAP_BAR} bar value: ${pTotalBar} bar is above the cap and what the correlation does above it is not established here`
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * de Waard-Milliams 1995
 * ------------------------------------------------------------------ */

/**
 * Reaction (kinetic) contribution:
 *   log10 Vr = 4.93 - 1119/T_K + 0.58 log10 fCO2   [mm/yr, T in K]
 * Zero when there is no CO2, NaN when the inputs are not usable.
 */
export const dwmReactionRate = ({ tC, fco2Bar }) => {
  if (!finite(tC) || !finite(fco2Bar) || tC <= ABSOLUTE_ZERO_C) return NaN;
  if (fco2Bar <= 0) return 0;
  const tK = tC + 273.15;
  return 10 ** (4.93 - 1119 / tK + 0.58 * Math.log10(fco2Bar));
};

/**
 * Mass-transfer contribution (de Waard 1995):
 *   Vm = 2.45 * (U^0.8 / d^0.2) * fCO2   [mm/yr, U m/s, d m]
 * This is where velocity and line size enter, and why the same fluid
 * in a bigger line at the same rate corrodes less.
 *
 * Returns NaN, NOT Infinity, when velocity or diameter is missing. An
 * absent velocity is not an unlimited mass-transfer capacity, and the
 * previous Infinity made the combined rate silently equal the
 * reaction rate and then named "reaction kinetics" as the controlling
 * mechanism from an input that was never supplied.
 */
export const dwmMassTransferRate = ({ velocityMS, diameterM, fco2Bar }) => {
  if (!finite(velocityMS) || !finite(diameterM) || !finite(fco2Bar)) return NaN;
  if (!(velocityMS > 0) || !(diameterM > 0) || fco2Bar < 0) return NaN;
  return 2.45 * (velocityMS ** 0.8 / diameterM ** 0.2) * fco2Bar;
};

/**
 * Scale (protective-film) factor. Once iron carbonate plates out the
 * rate falls with further heating, which a naive Arrhenius
 * extrapolation of the low-temperature equation misses.
 *   log10 Fscale = 2400/T_K - 0.6 log10(fCO2) - 6.7   (applied when < 1)
 *
 * The onset temperature is NOT a fixed 60 C. It is where that
 * expression crosses zero, it moves with fCO2, and `scaleOnsetTC`
 * computes it. At a typical 1.34 bar fCO2 the onset is near 81 C.
 *
 * HELD: the constants, and whether this factor belongs on the
 * reaction term or on the combined rate. This module applies it to
 * the COMBINED rate. See HELD_FOR_LITERATURE.
 */
export const scaleFactor = ({ tC, fco2Bar }) => {
  if (!finite(tC) || !finite(fco2Bar) || tC <= ABSOLUTE_ZERO_C) return NaN;
  if (!(fco2Bar > 0)) return 1;
  const tK = tC + 273.15;
  const logF = 2400 / tK - 0.6 * Math.log10(fco2Bar) - 6.7;
  const f = 10 ** logF;
  return f < 1 ? f : 1;
};

/**
 * The temperature at which the scale factor crosses 1, from the same
 * correlation: 2400/T = 6.7 + 0.6 log10 fCO2. Below it the factor is
 * clamped at 1 and no protective film is credited; above it the rate
 * is reduced. Returns NaN where the correlation has no crossing.
 */
export const scaleOnsetTC = ({ fco2Bar }) => {
  if (!finite(fco2Bar) || !(fco2Bar > 0)) return NaN;
  const denom = 6.7 + 0.6 * Math.log10(fco2Bar);
  if (!(denom > 0)) return NaN;
  return 2400 / denom - 273.15;
};

/** The pH the correction is referenced to. HELD. */
export const PH_REFERENCE = 4;

/**
 * pH correction relative to the pH the correlation was fitted at:
 *   F = 10^(-0.5 (pH - pHref))  for pH at or above the reference
 *
 * BELOW the reference this module REFUSES. The previous version
 * returned 1 for every pH at or below 4, so pH 2.0, 3.0, 3.5 and 4.0
 * all produced the identical rate to sixteen figures while a more
 * acid water is not a less corrosive one. What the published
 * correction does below its reference is HELD, and a silent 1 is the
 * least-limiting answer to a question this module cannot answer.
 *
 * Returns { factor, phReference } or { error }, not a bare number.
 */
export const phFactor = ({ ph, phReference = PH_REFERENCE }) => {
  if (!finite(ph)) return { error: 'a finite in-situ pH is required' };
  if (ph < 0 || ph > 14) return { error: `an in-situ pH between 0 and 14 is required: ${ph} is outside it` };
  if (!finite(phReference)) return { error: 'a finite reference pH is required' };
  if (ph < phReference) {
    return {
      error: `the pH correction is only defined at or above its reference pH of ${phReference}, and pH ${ph} is below it. What the correlation does below the reference is not established in this module, so no factor is returned rather than a factor of 1`,
      phReference,
    };
  }
  return { factor: 10 ** (-0.5 * (ph - phReference)), phReference };
};

/** Flow regimes, matched case and punctuation insensitively. */
const REGIMES = { waterwet: 'waterWet', oilwet: 'oilWet', intermittent: 'intermittent' };
const normaliseRegime = (s) => {
  if (typeof s !== 'string') return null;
  return REGIMES[s.replace(/[^a-z]/gi, '').toLowerCase()] || null;
};

/** How far the effective protection may fall short before it is called out, in percentage points. */
export const INHIBITOR_SHORTFALL_PP = 0.1;

/** Within this relative gap the two resistances are reported as comparable rather than one being named. */
export const CONTROLLING_MARGIN = 0.1;

/**
 * Combined de Waard-Milliams 1995 rate:
 *   1/CR = 1/Vr + 1/Vm, then scale, pH, water wetting and inhibition.
 * Every factor is reported, so the answer can be argued with rather
 * than accepted.
 *
 * `inhibitorFilmIntact: false` removes the inhibitor credit entirely.
 * `screen` passes false when the wall shear says the film is gone, so
 * the rate and the warning printed next to it agree.
 */
export const corrosionRate = ({
  tC, pTotalBar, co2MolFrac, velocityMS, diameterM,
  ph, waterCutFrac = 1, flowRegime = 'waterWet',
  inhibitorEfficiencyPct = 0, inhibitorAvailabilityPct = 100,
  inhibitorFilmIntact = true,
}) => {
  const f = co2Fugacity({ tC, pTotalBar, co2MolFrac });
  if (f.error) return f;

  if (!finite(velocityMS) || !(velocityMS > 0)) {
    return { error: 'a positive velocity is required: an absent velocity is not an unlimited mass-transfer capacity' };
  }
  if (!finite(diameterM) || !(diameterM > 0)) {
    return { error: 'a positive line inside diameter is required: an absent diameter is not an unlimited mass-transfer capacity' };
  }

  const regime = normaliseRegime(flowRegime);
  if (!regime) {
    return { error: `the wetting regime must be one of waterWet, intermittent or oilWet: "${flowRegime}" is not recognised` };
  }
  if (regime === 'intermittent') {
    if (!finite(waterCutFrac)) return { error: 'the intermittent regime needs a finite water cut fraction' };
    if (waterCutFrac < 0 || waterCutFrac > 1) {
      return { error: `the water cut fraction must be between 0 and 1: ${waterCutFrac} is outside it` };
    }
  }

  if (!finite(inhibitorEfficiencyPct) || !finite(inhibitorAvailabilityPct)) {
    return { error: 'the inhibitor efficiency and availability must be finite percentages' };
  }

  const clamps = [];
  let effPct = inhibitorEfficiencyPct;
  if (effPct < 0 || effPct > 100) {
    effPct = Math.min(Math.max(effPct, 0), 100);
    clamps.push(`the inhibitor efficiency was clamped from ${inhibitorEfficiencyPct} to ${effPct} percent`);
  }
  let availPct = inhibitorAvailabilityPct;
  if (availPct < 0 || availPct > 100) {
    availPct = Math.min(Math.max(availPct, 0), 100);
    clamps.push(`the inhibitor availability was clamped from ${inhibitorAvailabilityPct} to ${availPct} percent`);
  }

  if (!(f.fco2Bar > 0)) {
    return {
      ...f,
      rateMmYr: 0,
      reactionMmYr: 0,
      massTransferMmYr: 0,
      uninhibitedMmYr: 0,
      effectiveInhibitionPct: null,
      clamps,
      rateApplies: false,
      note: 'no CO2 in the stream, so this CO2 model has nothing to predict. A rate of zero here means the model does not apply, not that the line is not corroding: any corrosion at these conditions is another mechanism.',
    };
  }

  const phc = phFactor({ ph });
  if (phc.error) return { error: phc.error };

  const vr = dwmReactionRate({ tC, fco2Bar: f.fco2Bar });
  const vm = dwmMassTransferRate({ velocityMS, diameterM, fco2Bar: f.fco2Bar });
  if (!finite(vr) || !finite(vm)) {
    return { error: 'the de Waard-Milliams terms did not evaluate at these conditions' };
  }
  const combined = 1 / (1 / vr + 1 / vm);
  const fScale = scaleFactor({ tC, fco2Bar: f.fco2Bar });
  const fPh = phc.factor;

  // Water wetting: an oil-continuous line does not corrode where the
  // steel is oil-wet. This is a REGIME, not a multiplier applied
  // always, so it is stated rather than assumed.
  const fWater = regime === 'oilWet' ? 0 : (regime === 'intermittent' ? waterCutFrac : 1);

  const uninhibited = combined * fScale * fPh * fWater;

  // Inhibition: efficiency only counts while the inhibitor is
  // available. The uninhibited rate applies for the rest of the time,
  // and that time-average is what eats the wall.
  const eff = inhibitorFilmIntact ? effPct / 100 : 0;
  const avail = availPct / 100;
  const retained = avail * (1 - eff) + (1 - avail);
  const rate = uninhibited * retained;

  const effectivePct = uninhibited > 0 ? (1 - retained) * 100 : null;
  const shortfallPp = effectivePct === null ? null : effPct - effectivePct;

  let warning = null;
  if (!inhibitorFilmIntact && effPct > 0) {
    warning = `the inhibitor credit has been removed: the wall shear at these conditions strips the film, so the ${effPct} percent on the datasheet is not what this line sees and the rate above is the uninhibited rate`;
  } else if (effectivePct !== null && shortfallPp > INHIBITOR_SHORTFALL_PP) {
    const lossRatio = retained / Math.max(1 - effPct / 100, 1e-12);
    warning = `a ${effPct} percent inhibitor at ${availPct} percent availability gives ${effectivePct.toFixed(1)} percent effective protection, which is ${lossRatio.toFixed(2)} times the metal loss of the datasheet number: availability, not efficiency, is what limits it`;
  }

  const notes = [];
  if (f.note) notes.push(f.note);
  if (regime === 'oilWet') {
    notes.push('the oil wet regime sets the water wetting factor to zero, so this rate is zero by assumption rather than by calculation. Whether the wall is oil wet is an input and it is the largest single lever in this model.');
  }
  if (effPct === 100) {
    notes.push('an efficiency of 100 percent is the arithmetic of the number typed in, not a prediction: no inhibitor removes all metal loss while it is on.');
  }

  const margin = Math.abs(vm - vr) / Math.max(Math.min(vm, vr), 1e-12);
  const controlling = margin < CONTROLLING_MARGIN
    ? 'comparable'
    : (vm < vr ? 'mass transfer' : 'reaction kinetics');

  return {
    ...f,
    note: notes.length ? notes.join(' ') : null,
    reactionMmYr: vr,
    massTransferMmYr: vm,
    combinedMmYr: combined,
    controlling,
    controllingMargin: margin,
    scaleFactor: fScale,
    scaleOnsetTC: scaleOnsetTC({ fco2Bar: f.fco2Bar }),
    phFactor: fPh,
    phReference: phc.phReference,
    waterWettingFactor: fWater,
    flowRegime: regime,
    uninhibitedMmYr: uninhibited,
    rateMmYr: rate,
    inhibitorFilmIntact,
    effectiveInhibitionPct: effectivePct,
    inhibitorShortfallPp: shortfallPp,
    clamps,
    rateApplies: true,
    warning,
  };
};

/* ------------------------------------------------------------------ *
 * Wall shear stress
 * ------------------------------------------------------------------ */

/** Film risk thresholds in Pa. Both HELD. */
export const FILM_STRIP_PA = 100;
export const FILM_MODERATE_PA = 50;
/** The Reynolds number at which the friction factor switches branch. HELD. */
export const SHEAR_SWITCH_RE = 4000;

/**
 * Wall shear stress from the Blasius friction factor:
 *   tau = 0.5 * f * rho * U^2,  f = 0.046 Re^-0.2 (Fanning, turbulent)
 *   f = 16/Re (laminar)
 * This is the number that decides whether an inhibitor film survives.
 *
 * The branch switch at Reynolds 4000 is a DISCONTINUITY: the shear
 * jumps by about 2.2 times across a fraction of a percent of
 * velocity, and both the switch and the film thresholds are HELD.
 * The jump is reported rather than smoothed, because smoothing it
 * would be a third invented correlation.
 *
 * Note the scope overlap: the line hydraulics module owns a friction
 * factor and a Reynolds number of its own, with a different
 * correlation and a different switch. The two will not agree.
 */
export const wallShearStressPa = ({
  velocityMS, diameterM, densityKgM3, viscosityPaS,
}) => {
  if (!finite(velocityMS) || !(velocityMS > 0)) return { error: 'wall shear stress needs a positive velocity' };
  if (!finite(diameterM) || !(diameterM > 0)) return { error: 'wall shear stress needs a positive line inside diameter' };
  if (!finite(densityKgM3) || !(densityKgM3 > 0)) return { error: 'wall shear stress needs a positive density' };
  if (!finite(viscosityPaS) || !(viscosityPaS > 0)) return { error: 'wall shear stress needs a positive viscosity' };
  const re = (densityKgM3 * velocityMS * diameterM) / viscosityPaS;
  const turbulent = re > SHEAR_SWITCH_RE;
  const fFanning = turbulent ? 0.046 * re ** -0.2 : 16 / re;
  const tau = 0.5 * fFanning * densityKgM3 * velocityMS * velocityMS;
  const nearSwitch = re > SHEAR_SWITCH_RE * 0.9 && re < SHEAR_SWITCH_RE * 1.1;
  return {
    reynolds: re,
    flowRegime: turbulent ? 'turbulent' : 'laminar',
    switchReynolds: SHEAR_SWITCH_RE,
    nearSwitch,
    fanningFriction: fFanning,
    tauPa: tau,
    filmRisk: tau > FILM_STRIP_PA ? 'high' : (tau > FILM_MODERATE_PA ? 'moderate' : 'low'),
    filmStripThresholdPa: FILM_STRIP_PA,
    warning: tau > FILM_STRIP_PA
      ? `wall shear above ${FILM_STRIP_PA} Pa: at this shear an inhibitor film is taken to be stripped, so the efficiency on the datasheet is not what the line will see. The ${FILM_STRIP_PA} Pa threshold itself is not sourced in this module.`
      : null,
    note: nearSwitch
      ? `Reynolds ${re.toFixed(0)} sits on the laminar to turbulent switch at ${SHEAR_SWITCH_RE}, where this friction factor is discontinuous and the shear jumps by about a factor of two. Read this number as a bracket, not a value.`
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * H2S: the threshold comparison, and which film governs
 * ------------------------------------------------------------------ */

/**
 * The H2S partial pressure above which a stream is screened as sour.
 * HELD: this value is not sourced in this repository. Note that
 * 0.0035 bar is 0.050763 psia, which is not the same as 0.05 psia
 * (0.0034474 bar); the previous comment here claimed it was.
 */
export const SOUR_THRESHOLD_BAR = 0.0035;
export const SOUR_THRESHOLD_PSIA = SOUR_THRESHOLD_BAR * BAR_TO_PSIA;

/**
 * Sour or not sour, and nothing more.
 *
 * WITHDRAWN from this function: the severity region 1 to 3 and the
 * named material guidance that went with it. They were computed from
 * severity = log10(pH2S / threshold) - (pH - 3.5) with break points
 * at 1 and 2.5, an expression invented in this file and labelled with
 * a standard's name. Nothing here replaces it: this module does not
 * classify sour-service severity and does not select materials. A
 * user who needs that needs the standard, not this screen.
 */
export const sourServiceScreen = ({ ph2sBar }) => {
  if (!finite(ph2sBar)) return { error: 'a finite H2S partial pressure is required' };
  if (ph2sBar < 0) return { error: 'the H2S partial pressure must be non-negative' };
  const above = ph2sBar >= SOUR_THRESHOLD_BAR;
  return {
    ph2sBar,
    ph2sPsia: ph2sBar * BAR_TO_PSIA,
    thresholdBar: SOUR_THRESHOLD_BAR,
    thresholdPsia: SOUR_THRESHOLD_PSIA,
    thresholdHeld: true,
    sour: above,
    decadesAboveThreshold: ph2sBar > 0 ? Math.log10(ph2sBar / SOUR_THRESHOLD_BAR) : null,
    regionProvided: false,
    materialGuidanceProvided: false,
    label: above ? 'Above the H2S screening threshold' : 'Below the H2S screening threshold',
    note: above
      ? `H2S partial pressure ${ph2sBar.toExponential(3)} bar (${(ph2sBar * BAR_TO_PSIA).toExponential(3)} psia) is at or above the ${SOUR_THRESHOLD_BAR} bar (${SOUR_THRESHOLD_PSIA.toFixed(6)} psia) screening threshold used here. This module does not classify a severity region and does not recommend materials. The threshold value itself is not sourced here.`
      : `H2S partial pressure ${ph2sBar.toExponential(3)} bar (${(ph2sBar * BAR_TO_PSIA).toExponential(3)} psia) is below the ${SOUR_THRESHOLD_BAR} bar (${SOUR_THRESHOLD_PSIA.toFixed(6)} psia) screening threshold used here. This module does not classify a severity region and does not recommend materials. The threshold value itself is not sourced here.`,
  };
};

/** The H2S to CO2 ratio boundaries. Both HELD. */
export const REGIME_CARBONATE_MAX = 1 / 500;
export const REGIME_MIXED_MAX = 1 / 20;

/**
 * Which corrosion product governs, from the H2S to CO2 ratio. Above
 * about 1:500 iron sulphide starts to compete with iron carbonate,
 * and above about 1:20 a CO2-only rate model has stopped describing
 * the surface. Both ratios are HELD.
 *
 * Both arguments are PARTIAL PRESSURES. The rate above is driven by
 * CO2 FUGACITY, and this ratio is not: feeding a fugacity here is a
 * real error and the gate checks for it.
 */
export const corrosionRegime = ({ ph2sBar, pco2Bar }) => {
  if (!finite(ph2sBar) || !finite(pco2Bar)) {
    return {
      regime: 'unknown',
      ratio: null,
      rateApplies: null,
      note: 'the H2S to CO2 ratio needs finite partial pressures for both, so which film governs is not known here.',
    };
  }
  if (!(pco2Bar > 0)) {
    return {
      regime: 'unknown',
      ratio: null,
      rateApplies: null,
      note: 'with no CO2 partial pressure there is no H2S to CO2 ratio, so which film governs is not known here. A CO2 rate model is not the right model for this stream.',
    };
  }
  const ratio = ph2sBar / pco2Bar;
  if (ratio < REGIME_CARBONATE_MAX) {
    return {
      ratio,
      regime: 'carbonate',
      rateApplies: true,
      note: 'iron carbonate governs: the CO2 rate model applies',
    };
  }
  if (ratio < REGIME_MIXED_MAX) {
    return {
      ratio,
      regime: 'mixed',
      rateApplies: true,
      rateIsUpperBound: true,
      note: 'mixed sulphide and carbonate films: the CO2 rate is an upper bound and the real rate depends on which film persists',
    };
  }
  return {
    ratio,
    regime: 'sulphide',
    rateApplies: false,
    note: 'iron sulphide dominates: a CO2-only model no longer describes this surface, and the rate here should come from sour-service testing rather than this correlation',
  };
};

/* ------------------------------------------------------------------ *
 * Integrity: allowance and remaining life
 * ------------------------------------------------------------------ */

/**
 * Remaining life against a corrosion allowance, and the allowance a
 * target life demands.
 *
 * A zero rate does NOT return a life of Infinity with a passing
 * verdict. It returns no life and no verdict, because an unbounded
 * life is reachable from an oil-wet assumption, from no CO2 and from
 * a 100 percent inhibitor, and the strongest reassurance on a screen
 * should not arrive from the weakest input.
 */
export const remainingLife = ({
  rateMmYr, corrosionAllowanceMm, consumedMm = 0, designLifeYears,
}) => {
  if (!finite(corrosionAllowanceMm) || !(corrosionAllowanceMm > 0)) return { error: 'a positive corrosion allowance is needed' };
  if (!finite(consumedMm) || consumedMm < 0) return { error: 'the consumed allowance must be a non-negative number' };
  if (!finite(rateMmYr) || rateMmYr < 0) return { error: 'the corrosion rate must be a finite non-negative number' };
  if (designLifeYears !== undefined && designLifeYears !== null && !finite(designLifeYears)) {
    return { error: 'the design life must be a finite number of years, or left out' };
  }
  const remainingMm = corrosionAllowanceMm - consumedMm;
  if (remainingMm <= 0) {
    return { error: 'the corrosion allowance is already consumed: this is an inspection and fitness-for-service question, not a design one' };
  }
  const hasDesignLife = finite(designLifeYears) && designLifeYears > 0;
  if (!(rateMmYr > 0)) {
    return {
      remainingMm,
      remainingYears: null,
      unbounded: true,
      requiredAllowanceMm: hasDesignLife ? 0 : null,
      meetsDesignLife: null,
      shortfallMm: 0,
      note: 'the corrosion rate is zero, so no finite life comes out of this division. Check WHY the rate is zero before reading it as a pass: an oil-wet assumption, a stream with no CO2 and a perfect inhibitor all land here.',
    };
  }
  const years = remainingMm / rateMmYr;
  const requiredAllowanceMm = hasDesignLife ? rateMmYr * designLifeYears : null;
  return {
    remainingMm,
    remainingYears: years,
    unbounded: false,
    requiredAllowanceMm,
    meetsDesignLife: hasDesignLife ? years >= designLifeYears : null,
    shortfallMm: hasDesignLife && requiredAllowanceMm > remainingMm
      ? requiredAllowanceMm - remainingMm
      : 0,
    note: null,
  };
};

/**
 * Customary rate bands, for labelling only. HELD, and the bands are
 * looser than those commonly cited for carbon steel in production
 * service, so a label here may be optimistic by a step or two.
 */
export const RATE_CATEGORY_BANDS = Object.freeze({ low: 0.1, moderate: 0.5, high: 1.0 });

export const rateCategory = (mmYr) => {
  if (!finite(mmYr)) return null;
  if (!(mmYr > 0)) return 'negligible';
  if (mmYr < RATE_CATEGORY_BANDS.low) return 'low';
  if (mmYr < RATE_CATEGORY_BANDS.moderate) return 'moderate';
  if (mmYr < RATE_CATEGORY_BANDS.high) return 'high';
  return 'severe';
};

/* ------------------------------------------------------------------ *
 * The whole screening
 * ------------------------------------------------------------------ */

/**
 * The whole screening in one call, so the Suite layer stays wiring.
 *
 * Order matters here. The wall shear is computed FIRST, because the
 * rate depends on whether the inhibitor film survives it, and a shear
 * that cannot be computed means the screening is incomplete and no
 * rate is issued. The previous version put `shear.error` into a field
 * and returned normally, so a caller's `if (result.error)` guard saw
 * nothing and the summary quietly dropped the film-survival row.
 */
export const screen = ({
  tC, pTotalBar, co2MolFrac, h2sMolFrac = 0, ph,
  velocityMS, diameterM, densityKgM3, viscosityPaS,
  waterCutFrac = 1, flowRegime = 'waterWet',
  inhibitorEfficiencyPct = 0, inhibitorAvailabilityPct = 100,
  corrosionAllowanceMm, consumedMm = 0, designLifeYears,
}) => {
  if (!finite(h2sMolFrac)) return { error: 'a finite H2S mole fraction is required' };
  if (h2sMolFrac < 0 || h2sMolFrac > 1) {
    return { error: `the H2S mole fraction must be between 0 and 1: ${h2sMolFrac} is outside it` };
  }
  if (finite(co2MolFrac) && co2MolFrac >= 0 && co2MolFrac + h2sMolFrac > 1) {
    return { error: `the CO2 and H2S mole fractions sum to ${(co2MolFrac + h2sMolFrac).toFixed(4)}, so their partial pressures would exceed the total pressure` };
  }

  const shear = wallShearStressPa({ velocityMS, diameterM, densityKgM3, viscosityPaS });
  if (shear.error) {
    return { error: `screening incomplete: the inhibitor film survival check did not run. ${shear.error}` };
  }

  const filmStripped = shear.filmRisk === 'high';
  const common = {
    tC, pTotalBar, co2MolFrac, velocityMS, diameterM, ph,
    waterCutFrac, flowRegime, inhibitorEfficiencyPct, inhibitorAvailabilityPct,
  };
  const rate = corrosionRate({ ...common, inhibitorFilmIntact: !filmStripped });
  if (rate.error) return rate;

  // Reported alongside, so the cost of the shear verdict is visible
  // rather than implied.
  const withFilmCredit = filmStripped
    ? corrosionRate({ ...common, inhibitorFilmIntact: true })
    : rate;

  const ph2sBar = pTotalBar * h2sMolFrac;
  const sour = sourServiceScreen({ ph2sBar });
  const regime = corrosionRegime({ ph2sBar, pco2Bar: rate.pco2Bar });

  let withheld = null;
  if (regime.rateApplies === false) {
    withheld = {
      what: 'the corrosion rate category and the remaining life',
      why: 'the H2S to CO2 ratio puts this stream in the sulphide regime, where a CO2-only rate model no longer describes the surface. The rate above is retained only as an upper bound.',
      upperBoundMmYr: rate.rateMmYr,
    };
  } else if (rate.rateApplies === false) {
    withheld = {
      what: 'the corrosion rate category and the remaining life',
      why: 'there is no CO2 in the stream, so this CO2 model has nothing to predict and a rate of zero is not a statement that the line is not corroding.',
      upperBoundMmYr: null,
    };
  } else if (rate.waterWettingFactor === 0) {
    withheld = {
      what: 'the corrosion rate category and the remaining life',
      why: 'the wetting regime is oil wet, so the rate is zero because that was assumed and not because it was calculated. An unbounded life off a dropdown is the strongest reassurance on the screen arriving from the weakest input.',
      upperBoundMmYr: null,
    };
  }

  const category = withheld ? null : rateCategory(rate.rateMmYr);

  // No allowance arithmetic on a rate the module has just withheld.
  const life = (!withheld && finite(corrosionAllowanceMm) && corrosionAllowanceMm > 0)
    ? remainingLife({
      rateMmYr: rate.rateMmYr, corrosionAllowanceMm, consumedMm, designLifeYears,
    })
    : null;

  // The binding constraint: which of this module's own limits is the
  // thing that governs the answer. Derived from what is already
  // computed above, in descending order of what would change first.
  let binding;
  if (withheld) {
    binding = {
      what: 'the model does not apply',
      why: withheld.why,
      valueLabel: null,
    };
  } else if (filmStripped) {
    binding = {
      what: 'wall shear on the inhibitor film',
      why: `wall shear ${shear.tauPa.toFixed(0)} Pa is above the ${FILM_STRIP_PA} Pa at which this module takes the film to be stripped, so the inhibitor credit is removed and the rate is ${(rate.rateMmYr / Math.max(withFilmCredit.rateMmYr, 1e-12)).toFixed(2)} times what the datasheet efficiency would give. Slowing the line changes this answer before anything else does.`,
      valueLabel: `${shear.tauPa.toFixed(0)} Pa wall shear`,
    };
  } else if (life && life.meetsDesignLife === false) {
    binding = {
      what: 'the corrosion allowance against the design life',
      why: `at ${rate.rateMmYr.toFixed(3)} mm/yr the allowance runs out in ${life.remainingYears.toFixed(1)} years against a ${designLifeYears} year design life, short by ${life.shortfallMm.toFixed(2)} mm of allowance.`,
      valueLabel: `${life.remainingYears.toFixed(1)} yr of ${designLifeYears} yr`,
    };
  } else if (rate.controlling === 'comparable') {
    binding = {
      what: 'neither resistance alone',
      why: `the reaction and mass-transfer resistances are within ${(CONTROLLING_MARGIN * 100).toFixed(0)} percent of each other, so neither governs on its own and changing either one moves the rate.`,
      valueLabel: `${rate.reactionMmYr.toFixed(2)} and ${rate.massTransferMmYr.toFixed(2)} mm/yr`,
    };
  } else if (rate.controlling === 'mass transfer') {
    binding = {
      what: 'mass transfer to the wall',
      why: `the transport term ${rate.massTransferMmYr.toFixed(2)} mm/yr is below the reaction term ${rate.reactionMmYr.toFixed(2)} mm/yr, so velocity and line size move this rate and the chemistry does not.`,
      valueLabel: `${rate.massTransferMmYr.toFixed(2)} mm/yr transport limit`,
    };
  } else {
    binding = {
      what: 'reaction kinetics',
      why: `the reaction term ${rate.reactionMmYr.toFixed(2)} mm/yr is below the transport term ${rate.massTransferMmYr.toFixed(2)} mm/yr, so temperature, CO2 and pH move this rate and slowing the line will not.`,
      valueLabel: `${rate.reactionMmYr.toFixed(2)} mm/yr kinetic limit`,
    };
  }

  const notes = [];
  if (rate.note) notes.push(rate.note);
  if (shear.note) notes.push(shear.note);
  if (sour.sour) notes.push(sour.note);

  return {
    rate,
    rateWithFilmCreditMmYr: withFilmCredit.rateMmYr,
    filmStripped,
    shear,
    sour,
    regime,
    life,
    category,
    categoryHeld: true,
    ph2sBar,
    ph2sFugacityApplied: false,
    withheld,
    binding,
    screeningComplete: true,
    clamps: rate.clamps || [],
    notProvided: [...NOT_PROVIDED],
    notes,
    limits: [...HELD_FOR_LITERATURE],
  };
};
