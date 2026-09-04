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
 *    choking, because damage starts long before the flow chokes
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
 * Units: field (gpm, scfh, psia, F).
 */

/* ------------------------------------------------------------------ *
 * Published valve-style data
 * ------------------------------------------------------------------ */

/**
 * FL (liquid pressure recovery factor) and xT (terminal pressure drop
 * ratio) by valve style, from the published tables. These ARE table
 * values and the engine says so; a vendor number for a specific trim
 * always wins.
 */
export const VALVE_STYLES = [
  { id: 'globeSingleFlow', label: 'Globe, single seat, flow to open', fl: 0.90, xt: 0.72, fd: 0.46 },
  { id: 'globeSingleClose', label: 'Globe, single seat, flow to close', fl: 0.80, xt: 0.55, fd: 1.00 },
  { id: 'globeCage', label: 'Globe, cage guided', fl: 0.90, xt: 0.75, fd: 0.41 },
  { id: 'globeAntiCav', label: 'Globe, multistage anti-cavitation trim', fl: 0.97, xt: 0.90, fd: 0.10 },
  { id: 'butterfly60', label: 'Butterfly, 60 degrees open', fl: 0.68, xt: 0.38, fd: 0.57 },
  { id: 'butterfly90', label: 'Butterfly, 90 degrees open', fl: 0.55, xt: 0.20, fd: 0.70 },
  { id: 'ballSegmented', label: 'Ball, segmented', fl: 0.66, xt: 0.30, fd: 0.98 },
  { id: 'ballFullBore', label: 'Ball, full bore', fl: 0.55, xt: 0.15, fd: 0.99 },
];

export const styleOf = (id) => VALVE_STYLES.find((v) => v.id === id) || null;

/* ------------------------------------------------------------------ *
 * Liquid sizing
 * ------------------------------------------------------------------ */

/** Liquid critical pressure ratio factor: FF = 0.96 - 0.28 sqrt(Pv/Pc). */
export const liquidCriticalRatioFF = ({ pvPsia, pcPsia }) => {
  if (!(pvPsia >= 0) || !(pcPsia > 0)) return NaN;
  return 0.96 - 0.28 * Math.sqrt(pvPsia / pcPsia);
};

/**
 * Liquid sizing with the choking boundary put first.
 *
 * The allowable pressure drop is FL^2 (P1 - FF Pv). Below it the valve
 * is not choked and Cv follows the ordinary equation; at or above it
 * the flow is choked, extra drop does nothing, and sizing on the full
 * stated drop would badly undersize the valve.
 */
export const liquidValve = ({
  qGpm, p1Psia, p2Psia, sg, pvPsia = 0, pcPsia = 3200,
  styleId = 'globeCage', flOverride, fp = 1,
}) => {
  if (!(qGpm > 0) || !(sg > 0)) return { error: 'liquid sizing needs a positive rate and specific gravity' };
  if (!(p1Psia > p2Psia)) return { error: 'the inlet pressure must exceed the outlet pressure' };
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
  // service cavitation index; incipient damage well before choking
  const sigma = pvPsia > 0 ? (p1Psia - pvPsia) / dpStated : Infinity;
  let regime;
  if (flashing) regime = 'flashing';
  else if (choked) regime = 'choked, cavitating';
  else if (sigma < 2) regime = 'cavitating';
  else if (sigma < 3) regime = 'incipient cavitation';
  else regime = 'stable';

  return {
    cv,
    fl,
    ff,
    dpStatedPsi: dpStated,
    dpAllowablePsi: dpAllowable,
    dpUsedPsi: dpUsed,
    choked,
    flashing,
    sigma,
    regime,
    warning: flashing
      ? 'the outlet is at or below the vapour pressure: this service is FLASHING, not cavitating, and an anti-cavitation trim will not help it. Size for two-phase flow and use hardened trim with an expanded outlet'
      : (choked
        ? 'choked flow: the stated pressure drop is beyond what the valve can use, so sizing on it would undersize the valve badly. The allowable drop has been used instead, and this service wants a multistage or anti-cavitation trim'
        : (sigma < 3
          ? `cavitation index ${sigma.toFixed(2)}: damage begins well before choking, and below about 2 it becomes rapid. Consider a higher-recovery-factor trim`
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
  const style = styleOf(styleId);
  if (!style && !(xtOverride > 0)) return { error: `unknown valve style '${styleId}'` };
  const xt = xtOverride > 0 ? xtOverride : style.xt;
  const fk = specificHeatFactor(k);
  const x = (p1Psia - p2Psia) / p1Psia;
  const xChoked = fk * xt;
  const choked = x >= xChoked;
  const xUsed = choked ? xChoked : x;
  const y = 1 - xUsed / (3 * fk * xt); // equals 2/3 exactly when choked
  const tR = tF + 459.67;
  const cv = (qScfh / (1360 * fp * p1Psia * y)) * Math.sqrt((gasSg * tR * z) / xUsed);
  return {
    cv,
    xt,
    fk,
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
 */
export const characteristicFor = ({ authority }) => {
  if (!(authority > 0)) return { error: 'a valve authority is needed' };
  if (authority >= 0.5) {
    return {
      characteristic: 'linear',
      reason: 'the valve takes most of the system drop, so its inherent curve is close to its installed curve and linear trim gives even loop gain',
    };
  }
  return {
    characteristic: 'equal percentage',
    reason: 'the system absorbs most of the drop as flow rises, which flattens the installed curve. Equal-percentage trim is shaped to cancel exactly that and restore something close to linear installed gain',
  };
};

/* ------------------------------------------------------------------ *
 * Noise
 * ------------------------------------------------------------------ */

/**
 * Aerodynamic noise indicator. The full IEC 60534-8-3 prediction needs
 * geometry this tool does not have, so what is offered is the
 * screening form: sound power scales with the stream power and the
 * pressure ratio, and the result is stated as an INDICATION with its
 * limits named rather than a dBA number pretending to be a prediction.
 */
export const noiseIndication = ({ p1Psia, p2Psia, qScfh, gasSg, tF }) => {
  if (!(p1Psia > p2Psia) || !(qScfh > 0)) {
    return { error: 'a noise indication needs a pressure drop and a flow' };
  }
  const ratio = p1Psia / p2Psia;
  // mass flow, lb/hr, from scfh
  const mLbHr = (qScfh / 379.49) * 28.9625 * gasSg;
  // stream power indicator, arbitrary but monotonic in the physics
  const streamPowerKw = (mLbHr / 3600) * 0.4536 * 287 * ((tF + 459.67) / 1.8)
    * Math.log(ratio) / 1000;
  let band;
  if (ratio < 2) band = 'low';
  else if (ratio < 4) band = 'moderate';
  else if (ratio < 10) band = 'high';
  else band = 'severe';
  return {
    pressureRatio: ratio,
    streamPowerKw,
    band,
    note: 'a screening indication only: a real noise prediction needs the IEC 60534-8-3 method with valve and pipe geometry. Use this to know whether to ask the question, not to answer it',
    warning: ratio >= 4
      ? 'pressure ratio at or above 4: expect aerodynamic noise to need attention through multistage trim, a diffuser, heavier pipe wall or acoustic insulation'
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
 */
export const travelCheck = ({
  cvRequiredMin, cvRequiredNormal, cvRequiredMax, cvRated,
  characteristic = 'equalPercentage', rangeability = 50,
}) => {
  if (!(cvRated > 0)) return { error: 'a rated Cv is needed' };
  const travelFor = (cv) => {
    if (!(cv > 0)) return null;
    const frac = cv / cvRated;
    if (frac > 1) return null; // beyond the valve
    if (characteristic === 'linear') return frac * 100;
    // equal percentage: Cv/Cvmax = R^(h-1), h in [0,1]
    const h = 1 + Math.log(Math.max(frac, 1e-9)) / Math.log(rangeability);
    return Math.max(0, Math.min(1, h)) * 100;
  };
  const min = travelFor(cvRequiredMin);
  const normal = travelFor(cvRequiredNormal);
  const max = travelFor(cvRequiredMax);
  const warnings = [];
  // Each travel warning below fires on a strict inequality and prints
  // the travel it fired on, so the print carries one decimal: at whole
  // percent a valve 9.7 percent open reported "10 percent open" under a
  // flag that only fires BELOW 10. One decimal narrows that collision
  // by ten rather than removing it (anything within 0.05 of the
  // threshold still prints as the threshold). Gated by `the travel
  // warnings print a travel off their own threshold` in
  // __tests__/facilities.controlvalve.test.js.
  if (max === null) warnings.push('the maximum flow needs more Cv than the valve is rated for: it will not pass the design case');
  if (min !== null && min < 10) warnings.push(`at minimum flow the valve is only ${min.toFixed(1)} percent open: near the seat the characteristic collapses and control is poor. A smaller valve, or a split range, is the answer`);
  if (max !== null && max > 90) warnings.push(`at maximum flow the valve is ${max.toFixed(1)} percent open: there is no margin left for fouling, wear or a future rate increase`);
  if (normal !== null && (normal < 20 || normal > 80)) warnings.push(`normal flow sits at ${normal.toFixed(1)} percent travel: the customary target is 20 to 80 percent`);
  return {
    minTravelPct: min,
    normalTravelPct: normal,
    maxTravelPct: max,
    warnings,
    pass: warnings.length === 0,
  };
};
