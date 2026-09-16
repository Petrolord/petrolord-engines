/**
 * Control valve sizing to ISA 75.01 / IEC 60534 (Facilities F11).
 *
 * A control valve is the one item of process equipment where the
 * ordinary sizing equation stops working exactly when the service gets
 * difficult: at high pressure drop the flow chokes, and past that
 * point a bigger Cv buys nothing at all. Everything interesting about
 * valve sizing lives at that boundary, so this engine puts the
 * boundary first and reports which side of it the service sits on.
 *
 * Liquid:
 *  - Cv = Q sqrt(SG / dP) below choking
 *  - choked when dP >= FL^2 (P1 - FF Pv), with FF = 0.96 - 0.28 sqrt(Pv/Pc)
 *  - past that the allowable dP is capped and the equation uses it
 *  - the cavitation index sigma says how much margin there is BEFORE
 *    choking, because damage starts long before the flow chokes. A
 *    LIQUID SIZING WITHOUT A VAPOUR PRESSURE IS REFUSED: sigma was
 *    infinite at a vapour pressure of zero, which took the last branch
 *    of the regime ladder, so every liquid service at every drop
 *    reported "stable" in green and the cavitation screen this module
 *    exists for was switched off by an empty box.
 *  - flashing is distinguished from cavitation, because they need
 *    different valves: a flashing service will not be fixed by an
 *    anti-cavitation trim
 *
 * Gas:
 *  - the pressure-drop ratio x = dP/P1 against the terminal xT
 *  - the expansion factor Y = 1 - x/(3 Fk xT), floored at 2/3 when choked
 *  - Cv from the published gas form
 *
 * Also: valve authority (which decides whether a loop can control at
 * all), an inherent-characteristic screen, and a simple aerodynamic
 * noise indicator.
 *
 * WHAT THIS PACKAGE DOES NOT CARRY:
 *  - the ISA 75.01 / IEC 60534 Reynolds number factor FR, so every
 *    liquid sizing here is a fully turbulent one and says so. A heavy
 *    crude or a low-flow trim needs FR and this module takes no
 *    viscosity at all.
 *  - the IEC 60534-8-3 noise prediction. `noiseIndication` is a
 *    screening band and says so.
 *  - the valve style modifier fd, whose only consumers are the two
 *    methods above. It used to sit in the style table read by nothing
 *    and has been removed rather than left as decoration.
 *
 * Every FL, xT and sigma threshold below is a TABLE OR SCREENING VALUE
 * STATED BY THIS ENGINE. None of them is cited to a document in this
 * repository and a vendor number for a specific trim always wins.
 *
 * Units: field (gpm, scfh, psia, F).
 */

/* ------------------------------------------------------------------ *
 * Valve-style data
 * ------------------------------------------------------------------ */

/**
 * FL (liquid pressure recovery factor) and xT (terminal pressure drop
 * ratio) by valve style. These ARE table values and the engine says
 * so; a vendor number for a specific trim always wins.
 */
export const VALVE_STYLES = [
  { id: 'globeSingleFlow', label: 'Globe, single seat, flow to open', fl: 0.90, xt: 0.72 },
  { id: 'globeSingleClose', label: 'Globe, single seat, flow to close', fl: 0.80, xt: 0.55 },
  { id: 'globeCage', label: 'Globe, cage guided', fl: 0.90, xt: 0.75 },
  { id: 'globeAntiCav', label: 'Globe, multistage anti-cavitation trim', fl: 0.97, xt: 0.90 },
  { id: 'butterfly60', label: 'Butterfly, 60 degrees open', fl: 0.68, xt: 0.38 },
  { id: 'butterfly90', label: 'Butterfly, 90 degrees open', fl: 0.55, xt: 0.20 },
  { id: 'ballSegmented', label: 'Ball, segmented', fl: 0.66, xt: 0.30 },
  { id: 'ballFullBore', label: 'Ball, full bore', fl: 0.55, xt: 0.15 },
];

export const VALVE_STYLE_PROVENANCE = 'the FL and xT above are this engine\'s stated table values. They are not cited to a document in this repository, they are trim and vendor dependent by nature, and a certified vendor figure for the specific trim always replaces them';

export const styleOf = (id) => VALVE_STYLES.find((v) => v.id === id) || null;

/** The two inherent characteristics this module knows, one spelling each. */
export const CHARACTERISTICS = ['equalPercentage', 'linear'];

/** The human wording for a characteristic id. One vocabulary, one map. */
export const characteristicLabel = (id) => (
  id === 'linear' ? 'linear' : (id === 'equalPercentage' ? 'equal percentage' : null)
);

/* ------------------------------------------------------------------ *
 * Liquid sizing
 * ------------------------------------------------------------------ */

/** Liquid critical pressure ratio factor: FF = 0.96 - 0.28 sqrt(Pv/Pc). */
export const liquidCriticalRatioFF = ({ pvPsia, pcPsia }) => {
  if (!(pvPsia >= 0) || !(pcPsia > 0)) return NaN;
  return 0.96 - 0.28 * Math.sqrt(pvPsia / pcPsia);
};

/** Sigma thresholds for the regime ladder. This engine's stated screen. */
export const SIGMA_THRESHOLDS = { cavitating: 2, incipient: 3 };

/**
 * Liquid sizing with the choking boundary put first.
 *
 * The allowable pressure drop is FL^2 (P1 - FF Pv). Below it the valve
 * is not choked and Cv follows the ordinary equation; at or above it
 * the flow is choked, extra drop does nothing, and sizing on the full
 * stated drop would badly undersize the valve.
 *
 * Sigma is computed on the drop the valve ACTUALLY USES, not on the
 * stated drop. On a choked service those are different pressure drops
 * and the index reported used to belong to a drop the valve cannot
 * take.
 */
export const liquidValve = ({
  qGpm, p1Psia, p2Psia, sg, pvPsia, pcPsia = 3200,
  styleId = 'globeCage', flOverride, fp = 1,
}) => {
  if (!(qGpm > 0) || !(sg > 0)) return { error: 'liquid sizing needs a positive rate and specific gravity' };
  if (!(p1Psia > p2Psia)) return { error: 'the inlet pressure must exceed the outlet pressure' };
  if (!(pvPsia > 0)) {
    return {
      error: 'a true vapour pressure is needed. The cavitation index is (P1 - Pv) divided by the pressure drop, so with no vapour pressure it is infinite and every service reads as stable: the cavitation screen would not run at all. Every liquid has a vapour pressure at its flowing temperature, so state it',
    };
  }
  if (!(pcPsia > pvPsia)) {
    return { error: 'the critical pressure must exceed the vapour pressure' };
  }
  if (!(fp > 0) || fp > 2) {
    return { error: 'the piping geometry factor Fp is a correction near 1 and must lie between 0 and 2' };
  }
  if (flOverride !== undefined && !(flOverride > 0 && flOverride <= 1)) {
    return { error: 'a liquid pressure recovery factor FL is a fraction and must lie between 0 and 1' };
  }
  const style = styleOf(styleId);
  if (!style && !(flOverride > 0)) return { error: `unknown valve style '${styleId}'` };
  const fl = flOverride > 0 ? flOverride : style.fl;
  const ff = liquidCriticalRatioFF({ pvPsia, pcPsia });
  const dpStated = p1Psia - p2Psia;
  const dpAllowable = fl * fl * (p1Psia - ff * pvPsia);
  const choked = dpStated >= dpAllowable;
  const dpUsed = choked ? dpAllowable : dpStated;
  if (!(dpUsed > 0)) {
    return { error: 'no usable pressure drop: the inlet is at or below the vapour pressure, so the liquid is already flashing' };
  }
  const cv = (qGpm / fp) * Math.sqrt(sg / dpUsed);

  // Cavitation and flashing are different problems with different fixes.
  const flashing = p2Psia <= pvPsia;
  // service cavitation index on the drop the valve uses; incipient
  // damage well before choking
  const sigma = (p1Psia - pvPsia) / dpUsed;
  let regime;
  if (flashing) regime = 'flashing';
  else if (choked) regime = 'choked, cavitating';
  else if (sigma < SIGMA_THRESHOLDS.cavitating) regime = 'cavitating';
  else if (sigma < SIGMA_THRESHOLDS.incipient) regime = 'incipient cavitation';
  else regime = 'stable';

  return {
    cv,
    fl,
    ff,
    fp,
    dpStatedPsi: dpStated,
    dpAllowablePsi: dpAllowable,
    dpUsedPsi: dpUsed,
    choked,
    flashing,
    sigma,
    sigmaBasis: 'computed on the pressure drop the valve uses, which is the allowable drop once the service is choked',
    regime,
    reynoldsFactorApplied: false,
    limitNote: 'sized as fully turbulent. The ISA Reynolds number factor FR is not carried by this package and this module takes no viscosity, so a heavy or a low-flow service needs the standard',
    warning: flashing
      ? 'the outlet is at or below the vapour pressure: this service is FLASHING, not cavitating, and an anti-cavitation trim will not help it. Size for two-phase flow and use hardened trim with an expanded outlet'
      : (choked
        ? 'choked flow: the stated pressure drop is beyond what the valve can use, so sizing on it would undersize the valve badly. The allowable drop has been used instead, and this service wants a multistage or anti-cavitation trim'
        : (sigma < SIGMA_THRESHOLDS.incipient
          ? `cavitation index ${sigma.toFixed(2)}: damage begins well before choking, and below about ${SIGMA_THRESHOLDS.cavitating} it becomes rapid. Consider a higher-recovery-factor trim`
          : null)),
  };
};

/* ------------------------------------------------------------------ *
 * Gas sizing
 * ------------------------------------------------------------------ */

/** Specific heat ratio factor: Fk = k / 1.40. */
export const specificHeatFactor = (k) => (k > 0 ? k / 1.4 : NaN);

/**
 * Gas and vapour sizing. The expansion factor Y falls linearly with
 * the pressure-drop ratio and is floored at two thirds, which is the
 * choked condition: past x = Fk xT the flow is sonic in the vena
 * contracta and more drop buys nothing.
 *
 *   Cv = Q / (1360 Fp P1 Y) * sqrt(G T Z / x)
 * with Q in scfh, P1 psia, T in Rankine.
 */
export const gasValve = ({
  qScfh, p1Psia, p2Psia, gasSg, tF, z = 1, k = 1.4,
  styleId = 'globeCage', xtOverride, fp = 1,
}) => {
  if (!(qScfh > 0) || !(gasSg > 0) || !(p1Psia > 0)) {
    return { error: 'gas sizing needs a positive rate, gravity and inlet pressure' };
  }
  if (!(p1Psia > p2Psia)) return { error: 'the inlet pressure must exceed the outlet pressure' };
  if (!Number.isFinite(tF)) return { error: 'gas sizing needs a flowing temperature' };
  if (!(z > 0)) return { error: 'gas sizing needs a positive compressibility factor' };
  if (!(fp > 0) || fp > 2) {
    return { error: 'the piping geometry factor Fp is a correction near 1 and must lie between 0 and 2' };
  }
  if (xtOverride !== undefined && !(xtOverride > 0 && xtOverride <= 1)) {
    return { error: 'a terminal pressure drop ratio xT is a fraction and must lie between 0 and 1' };
  }
  const style = styleOf(styleId);
  if (!style && !(xtOverride > 0)) return { error: `unknown valve style '${styleId}'` };
  const xt = xtOverride > 0 ? xtOverride : style.xt;
  const fk = specificHeatFactor(k);
  if (!(fk > 0)) return { error: 'gas sizing needs a positive specific heat ratio' };
  const x = (p1Psia - p2Psia) / p1Psia;
  const xChoked = fk * xt;
  const choked = x >= xChoked;
  const xUsed = choked ? xChoked : x;
  const y = 1 - xUsed / (3 * fk * xt); // equals 2/3 exactly when choked
  const tR = tF + 459.67;
  if (!(tR > 0)) return { error: 'the flowing temperature is at or below absolute zero' };
  const cv = (qScfh / (1360 * fp * p1Psia * y)) * Math.sqrt((gasSg * tR * z) / xUsed);
  return {
    cv,
    xt,
    fk,
    fp,
    x,
    xChoked,
    xUsed,
    y,
    choked,
    warning: choked
      ? `choked flow: x of ${x.toFixed(3)} is at or past the terminal ${xChoked.toFixed(3)}, so the flow is sonic in the vena contracta and further pressure drop buys nothing. The terminal ratio has been used for sizing, and the noise and trim wear at this condition need a multistage trim`
      : (x > 0.5 * xChoked
        ? 'more than half the terminal pressure-drop ratio: the valve is working hard and aerodynamic noise is climbing'
        : null),
  };
};

/* ------------------------------------------------------------------ *
 * Valve authority and characteristic
 * ------------------------------------------------------------------ */

/**
 * Valve authority: the fraction of the system's total pressure drop
 * that the valve takes at design flow. This decides whether a loop can
 * control at all, and it is the thing most often got wrong: a valve
 * with low authority has an installed characteristic so distorted that
 * it does all its work in the first few percent of travel.
 */
export const valveAuthority = ({ dpValvePsi, dpSystemTotalPsi }) => {
  if (!(dpValvePsi > 0) || !(dpSystemTotalPsi > 0)) {
    return { error: 'authority needs a positive valve drop and total system drop' };
  }
  if (dpValvePsi > dpSystemTotalPsi) {
    return { error: 'the valve drop cannot exceed the total system drop' };
  }
  const n = dpValvePsi / dpSystemTotalPsi;
  return {
    authority: n,
    verdict: n >= 0.5 ? 'good' : (n >= 0.25 ? 'acceptable' : 'poor'),
    thresholds: { good: 0.5, acceptable: 0.25 },
    thresholdBasis: 'the 0.5 and 0.25 boundaries are this engine\'s stated screen, not a value read from a standard',
    note: n < 0.25
      ? 'authority below 0.25: the installed characteristic is badly distorted and the loop will do nearly all its work in the first few percent of travel. Take more drop across the valve or accept unstable control'
      : (n < 0.5
        ? 'authority between 0.25 and 0.5: workable with equal-percentage trim, which is exactly what that characteristic exists to compensate for'
        : null),
  };
};

/**
 * Recommend an inherent characteristic from the authority, which is
 * the published selection rule: equal percentage where the system
 * absorbs most of the drop (so the installed curve linearises), linear
 * where the valve dominates.
 *
 * Returns the SAME vocabulary `travelCheck` accepts. The two used to
 * speak differently: this returned 'equal percentage' and the check
 * tested for 'linear' and treated every other string, recognised or
 * not, as equal percentage.
 */
export const characteristicFor = ({ authority }) => {
  if (!(authority > 0)) return { error: 'a valve authority is needed' };
  if (authority >= 0.5) {
    return {
      characteristic: 'linear',
      characteristicLabel: 'linear',
      reason: 'the valve takes most of the system drop, so its inherent curve is close to its installed curve and linear trim gives even loop gain',
    };
  }
  return {
    characteristic: 'equalPercentage',
    characteristicLabel: 'equal percentage',
    reason: 'the system absorbs most of the drop as flow rises, which flattens the installed curve. Equal-percentage trim is shaped to cancel exactly that and restore something close to linear installed gain',
  };
};

/* ------------------------------------------------------------------ *
 * Noise
 * ------------------------------------------------------------------ */

/**
 * Aerodynamic noise indicator. The full IEC 60534-8-3 prediction needs
 * geometry this tool does not have, so what is offered is the
 * screening form and the result is stated as an INDICATION with its
 * limits named rather than a dBA number pretending to be a prediction.
 *
 * THE BAND SEES BOTH QUANTITIES. It used to band on the pressure ratio
 * alone while computing a stream power that moved nothing: a 1 scfh
 * bleed at a ratio of 12 read "severe" and a valve passing 100 MMscfh
 * at a ratio of 1.9 read "low". The pressure ratio sets the band and
 * the stream power CAPS AND FLOORS it, because a trickle cannot be
 * loud however hard it is throttled and tens of megawatts of stream
 * power is not quiet however gently. Both power thresholds are this
 * engine's stated screen and neither is read from a standard.
 */
export const NOISE_RATIO_BANDS = { moderate: 2, high: 4, severe: 10 };
export const NOISE_POWER_BANDS = { quietKw: 1, loudKw: 1000 };

export const noiseIndication = ({ p1Psia, p2Psia, qScfh, gasSg, tF }) => {
  if (!(p1Psia > p2Psia) || !(qScfh > 0)) {
    return { error: 'a noise indication needs a pressure drop and a flow' };
  }
  if (!(p2Psia > 0)) {
    return { error: 'a noise indication needs a positive outlet pressure: the pressure ratio is P1 over P2 and an outlet at zero is not a pressure ratio' };
  }
  if (!(gasSg > 0) || !Number.isFinite(tF)) {
    return { error: 'a noise indication needs a gas gravity and a flowing temperature: without them there is no stream power and the band cannot be formed' };
  }
  const tR = tF + 459.67;
  if (!(tR > 0)) return { error: 'the flowing temperature is at or below absolute zero' };
  const ratio = p1Psia / p2Psia;
  // mass flow, lb/hr, from scfh
  const mLbHr = (qScfh / 379.49) * 28.9625 * gasSg;
  // stream power indicator, arbitrary but monotonic in the physics
  const streamPowerKw = (mLbHr / 3600) * 0.4536 * 287 * (tR / 1.8)
    * Math.log(ratio) / 1000;
  if (!Number.isFinite(streamPowerKw) || streamPowerKw <= 0) {
    return { error: 'the stream power did not form, so no band can be offered' };
  }
  const order = ['low', 'moderate', 'high', 'severe'];
  let ratioBand;
  if (ratio < NOISE_RATIO_BANDS.moderate) ratioBand = 'low';
  else if (ratio < NOISE_RATIO_BANDS.high) ratioBand = 'moderate';
  else if (ratio < NOISE_RATIO_BANDS.severe) ratioBand = 'high';
  else ratioBand = 'severe';
  let band = ratioBand;
  let powerEffect = null;
  if (streamPowerKw < NOISE_POWER_BANDS.quietKw && order.indexOf(band) > 0) {
    band = 'low';
    powerEffect = `held down to low: the stream power of ${streamPowerKw.toPrecision(3)} kW is below ${NOISE_POWER_BANDS.quietKw} kW, and a trickle cannot be loud however hard it is throttled. On the pressure ratio alone this service would have read ${ratioBand}`;
  } else if (streamPowerKw > NOISE_POWER_BANDS.loudKw && order.indexOf(band) < 1) {
    band = 'moderate';
    powerEffect = `raised to moderate: the stream power of ${streamPowerKw.toFixed(1)} kW is above ${NOISE_POWER_BANDS.loudKw} kW, which is not a quiet valve at any pressure ratio. On the pressure ratio alone this service would have read ${ratioBand}`;
  }
  return {
    pressureRatio: ratio,
    massFlowLbHr: mLbHr,
    streamPowerKw,
    ratioBand,
    band,
    powerEffect,
    note: 'a screening indication only: a real noise prediction needs the IEC 60534-8-3 method with valve and pipe geometry. Use this to know whether to ask the question, not to answer it. The pressure ratio sets the band and the stream power caps and floors it, and both sets of thresholds are this engine\'s stated screen',
    warning: band === 'high' || band === 'severe'
      ? `pressure ratio ${ratio.toFixed(2)} at ${streamPowerKw.toFixed(1)} kW of stream power: expect aerodynamic noise to need attention through multistage trim, a diffuser, heavier pipe wall or acoustic insulation`
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Travel and rangeability
 * ------------------------------------------------------------------ */

/**
 * Where the valve sits on its own travel at each of the stated flows.
 * A valve sized for the maximum and asked to control at the minimum
 * may be near its seat, where it does not control at all, and that is
 * a rangeability problem no Cv calculation on its own reveals.
 *
 * IT COUNTS ITS CHECKS AND SAYS HOW MANY IT RAN. It used to return
 * `pass: true` having run none: a missing minimum flow skipped the
 * near-seat check silently and the caller printed a verdict over a
 * check that never happened. `pass` is now withheld, as null, whenever
 * a flow is missing.
 *
 * AND IT SEPARATES "BEYOND THE VALVE" FROM "NOT GIVEN". One null used
 * to mean both, and the alarming reading won: a maximum flow box the
 * user had not filled in produced "it will not pass the design case".
 */
export const travelCheck = ({
  cvRequiredMin, cvRequiredNormal, cvRequiredMax, cvRated,
  characteristic = 'equalPercentage', rangeability = 50,
}) => {
  if (!(cvRated > 0)) return { error: 'a rated Cv is needed' };
  if (!CHARACTERISTICS.includes(characteristic)) {
    return {
      error: `unknown inherent characteristic '${characteristic}': this module knows ${CHARACTERISTICS.join(' and ')}. An unrecognised characteristic used to be treated silently as equal percentage`,
    };
  }
  if (!(rangeability > 1)) {
    return { error: 'rangeability is the ratio of maximum to minimum controllable flow and must exceed 1' };
  }
  // state: 'ok' with a travel, 'beyond the valve', or 'not given'.
  const travelFor = (cv) => {
    if (!Number.isFinite(cv)) return { state: 'not given', travel: null };
    if (!(cv > 0)) return { state: 'not given', travel: null };
    const frac = cv / cvRated;
    if (frac > 1) return { state: 'beyond the valve', travel: null };
    if (characteristic === 'linear') return { state: 'ok', travel: frac * 100 };
    // equal percentage: Cv/Cvmax = R^(h-1), h in [0,1]
    const h = 1 + Math.log(Math.max(frac, 1e-9)) / Math.log(rangeability);
    return { state: 'ok', travel: Math.max(0, Math.min(1, h)) * 100 };
  };
  const minR = travelFor(cvRequiredMin);
  const normalR = travelFor(cvRequiredNormal);
  const maxR = travelFor(cvRequiredMax);
  const min = minR.travel;
  const normal = normalR.travel;
  const max = maxR.travel;
  const warnings = [];
  const checksRun = [];
  const checksSkipped = [];
  // Each travel warning below fires on a strict inequality and prints
  // the travel it fired on, so the print carries one decimal: at whole
  // percent a valve 9.7 percent open reported "10 percent open" under a
  // flag that only fires BELOW 10. One decimal narrows that collision
  // by ten rather than removing it (anything within 0.05 of the
  // threshold still prints as the threshold). Gated by `the travel
  // warnings print a travel off their own threshold` in
  // __tests__/facilities.controlvalve.test.js.
  if (maxR.state === 'beyond the valve') {
    checksRun.push('maximum flow against the rated Cv');
    warnings.push('the maximum flow needs more Cv than the valve is rated for: it will not pass the design case');
  } else if (maxR.state === 'ok') {
    checksRun.push('maximum flow against the rated Cv');
    if (max > 90) warnings.push(`at maximum flow the valve is ${max.toFixed(1)} percent open: there is no margin left for fouling, wear or a future rate increase`);
  } else {
    checksSkipped.push('the maximum flow case: no maximum flow was given, so whether the valve can pass its design case is not known');
  }
  if (minR.state === 'ok') {
    checksRun.push('minimum flow near the seat');
    if (min < 10) warnings.push(`at minimum flow the valve is only ${min.toFixed(1)} percent open: near the seat the characteristic collapses and control is poor. A smaller valve, or a split range, is the answer`);
  } else if (minR.state === 'beyond the valve') {
    checksRun.push('minimum flow near the seat');
    warnings.push('the minimum flow already needs more Cv than the valve is rated for: this valve is too small for the whole range');
  } else {
    checksSkipped.push('the near-seat rangeability check: no minimum flow was given, so whether the valve can control at turndown is not known');
  }
  if (normalR.state === 'ok') {
    checksRun.push('normal flow inside the 20 to 80 percent band');
    if (normal < 20 || normal > 80) warnings.push(`normal flow sits at ${normal.toFixed(1)} percent travel: the customary target is 20 to 80 percent`);
  } else if (normalR.state === 'beyond the valve') {
    checksRun.push('normal flow inside the 20 to 80 percent band');
    warnings.push('the normal flow needs more Cv than the valve is rated for: the valve is wide open at its ordinary duty');
  } else {
    checksSkipped.push('the 20 to 80 percent band check: no normal flow was given');
  }
  return {
    minTravelPct: min,
    normalTravelPct: normal,
    maxTravelPct: max,
    minState: minR.state,
    normalState: normalR.state,
    maxState: maxR.state,
    characteristic,
    characteristicLabel: characteristicLabel(characteristic),
    rangeability,
    warnings,
    checksRun,
    checksSkipped,
    checksPerformed: checksRun.length,
    checksPossible: 3,
    // A verdict over checks that did not run is not a verdict. When any
    // of the three flows is missing, `pass` is withheld rather than
    // reported true.
    pass: checksSkipped.length === 0 ? warnings.length === 0 : null,
    verdict: checksSkipped.length > 0
      ? `${checksRun.length} of 3 checks ran`
      : (warnings.length === 0 ? 'all 3 checks passed' : `${warnings.length} of 3 checks raised something`),
    passWithheldReason: checksSkipped.length > 0
      ? `no verdict: ${checksRun.length} of the 3 checks ran. Not run: ${checksSkipped.join('; ')}`
      : null,
  };
};
