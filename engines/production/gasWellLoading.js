/**
 * Liquid loading in gas wells (Production P7).
 *
 * A gas well carries its own liquid up as entrained droplets. Below
 * some rate the gas can no longer do that, droplets fall back, liquid
 * accumulates in the tubing, and the growing column kills the well.
 * The rate at which that starts is the single most useful number in
 * gas well surveillance, and it is what this module computes.
 *
 * TURNER'S EQUATION IS DERIVED HERE, NOT QUOTED. The whole thing falls
 * out of two statements about the largest droplet the gas can hold up:
 *
 *   1. At terminal velocity, drag balances weight less buoyancy.
 *        Cd (pi d^2 / 4) rho_g v^2 / (2 gc) = (pi d^3 / 6)(rho_L - rho_g)
 *
 *   2. A droplet bigger than a critical Weber number shatters, so the
 *      largest STABLE droplet is set by
 *        We = rho_g v^2 d / (sigma gc) = We_crit
 *
 * Eliminating d between them gives
 *
 *        v = [ 40 gc^2 sigma (rho_L - rho_g) / (Cd rho_g^2) ]^(1/4)
 *
 * and with Cd = 0.44, We_crit = 30, gc = 32.174 and sigma in dyne/cm
 * the bracket collapses to 1.5936, which IS the 1.593 every gas-well
 * text prints. The gates check that. Deriving it rather than
 * remembering it means the drag coefficient and the critical Weber
 * number are visible inputs a user can argue with, instead of being
 * buried inside a constant.
 *
 * TURNER AND COLEMAN ARE THE SAME EQUATION. Turner et al. (1969) found
 * their field data sat about 20 percent above the theoretical velocity
 * and applied that adjustment. Coleman et al. (1991), working on wells
 * below about 1,000 psi wellhead pressure, found the UNADJUSTED
 * equation fitted better. So the two differ by one factor, and this
 * module treats them that way rather than as two correlations.
 *
 * WHAT IS NOT INVENTED HERE. Interfacial tension and liquid density
 * are inputs. Water and condensate differ by a factor of three in
 * tension and are not interchangeable, and neither is a function of
 * anything this module knows. Turner's own values are offered as
 * labelled starting points, not as correlations.
 *
 * Field units: sigma dyne/cm, densities lb/ft3, velocity ft/s,
 * pressure psia, temperature degR, area ft2, rate Mscf/d.
 */

/** Standard conditions the gas industry meters at. */
export const P_STANDARD_PSIA = 14.7;
export const T_STANDARD_R = 519.67;
export const GC = 32.174;

/**
 * The two numbers Turner's derivation rests on. They are ordinary
 * fluid mechanics, not fitted parameters, and they are exposed so a
 * user with a reason to change them can.
 */
export const DEFAULT_DRAG_COEFFICIENT = 0.44;   // rigid sphere, Newton regime
export const DEFAULT_CRITICAL_WEBER = 30;       // droplet break-up

/** dyne/cm to lbf/ft. */
export const DYNE_CM_TO_LBF_FT = 6.852177e-5;

/**
 * Turner's own fluid properties, offered as starting points and
 * labelled as such. Condensate holds together far less well than
 * water, which is why a gas-condensate well loads at a lower rate than
 * the same well making water.
 */
export const TURNER_FLUIDS = [
  { id: 'water', label: 'Water (Turner)', sigmaDyneCm: 60, densityLbFt3: 67 },
  { id: 'condensate', label: 'Condensate (Turner)', sigmaDyneCm: 20, densityLbFt3: 45 },
];

export const turnerFluid = (id) =>
  TURNER_FLUIDS.find((f) => f.id === id) || TURNER_FLUIDS[0];

/**
 * Real-gas density, lb/ft3.
 *   rho = p M / (z R T),  M = 28.9647 SG
 */
export const AIR_MW = 28.9647;
export const R_PSIA_FT3_LBMOL_R = 10.7316;

export const gasDensityLbFt3 = ({ pPsia, tempR, z, gasSg }) => {
  if (!(tempR > 0) || !(z > 0)) return NaN;
  return (pPsia * AIR_MW * gasSg) / (z * R_PSIA_FT3_LBMOL_R * tempR);
};

/**
 * Terminal velocity of the largest stable droplet, ft/s.
 *
 * This is the derivation in the header, evaluated. `constant` is
 * reported so a caller can see the 1.5936 that the inputs produced.
 */
export const terminalDropletVelocity = ({
  sigmaDyneCm, rhoLiquidLbFt3, rhoGasLbFt3,
  dragCoefficient = DEFAULT_DRAG_COEFFICIENT,
  criticalWeber = DEFAULT_CRITICAL_WEBER,
}) => {
  const dRho = rhoLiquidLbFt3 - rhoGasLbFt3;
  if (!(rhoGasLbFt3 > 0) || !(dRho > 0) || !(sigmaDyneCm > 0)) {
    return { velocityFtS: NaN, constant: NaN, ok: false };
  }
  // v^4 = (4/3) We gc^2 sigma (rho_L - rho_g) / (Cd rho_g^2)
  const bracket = (4 / 3) * criticalWeber * GC * GC * DYNE_CM_TO_LBF_FT / dragCoefficient;
  const constant = Math.pow(bracket, 0.25);
  const velocityFtS = constant
    * Math.pow(sigmaDyneCm, 0.25)
    * Math.pow(dRho, 0.25)
    / Math.sqrt(rhoGasLbFt3);
  return { velocityFtS, constant, ok: true };
};

/**
 * Turner applied a 20 percent upward adjustment to match field data;
 * Coleman, on low-pressure wells, found none was needed. One equation,
 * one factor.
 */
export const LOADING_ADJUSTMENT = { turner: 1.2, coleman: 1.0 };

/** Below this pressure Coleman's data set is the relevant one. */
export const COLEMAN_PRESSURE_LIMIT_PSIA = 1000;

/**
 * How a message names a value that is not a usable number.
 *
 * A formatter is not a validator. `toFixed` and `toLocaleString` are
 * methods on Number, so applying either to a value that reached the
 * message unvalidated throws on `undefined`, on `null` and on a
 * numeric STRING, and prints a bare "NaN" as though it were a reading
 * on `NaN` itself. Every message in this domain that formats a value
 * its function did not check goes through here instead, so a bad input
 * is named rather than crashing or being dressed up as a measurement.
 */
export const describeUnusableNumber = (value) => {
  if (value === undefined) return 'nothing was passed';
  if (value === null) return 'null was passed';
  if (typeof value !== 'number') return `a ${typeof value} was passed, not a number`;
  return `the number passed was ${String(value)}`;
};

/**
 * Critical gas velocity to keep the tubing unloaded, ft/s.
 *
 * `correlation` is 'turner' or 'coleman'; anything else is refused
 * rather than silently treated as one of them.
 */
export const criticalVelocity = ({
  correlation = 'turner', sigmaDyneCm, rhoLiquidLbFt3, pPsia, tempR, z, gasSg,
  dragCoefficient, criticalWeber,
}) => {
  const adjustment = LOADING_ADJUSTMENT[correlation];
  if (!adjustment) {
    return { ok: false, error: `Unknown loading correlation "${correlation}". Use turner or coleman.` };
  }
  const rhoGasLbFt3 = gasDensityLbFt3({ pPsia, tempR, z, gasSg });
  const terminal = terminalDropletVelocity({
    sigmaDyneCm, rhoLiquidLbFt3, rhoGasLbFt3, dragCoefficient, criticalWeber,
  });
  if (!terminal.ok) {
    return { ok: false, error: 'The droplet balance needs a positive gas density, liquid density above it, and an interfacial tension.' };
  }
  return {
    ok: true,
    correlation,
    adjustment,
    rhoGasLbFt3,
    terminalFtS: terminal.velocityFtS,
    velocityFtS: terminal.velocityFtS * adjustment,
    constant: terminal.constant,
  };
};

/**
 * Rate constant, derived rather than remembered.
 *
 *   q_sc = v A x 86400 x (p / p_sc)(T_sc / T)(1 / z)
 *
 * in Mscf/d with A in ft2 gives 3054, which is the 3.06 the texts
 * print for MMscf/d.
 */
export const RATE_CONSTANT_MSCFD = (86400 * T_STANDARD_R) / (P_STANDARD_PSIA * 1000);

/** Gas rate, Mscf/d, that flows at a given velocity. */
export const rateAtVelocity = ({ velocityFtS, areaFt2, pPsia, tempR, z }) =>
  (RATE_CONSTANT_MSCFD * velocityFtS * areaFt2 * pPsia) / (tempR * z);

/** Velocity, ft/s, at a given gas rate. The inverse of the above. */
export const velocityAtRate = ({ qMscfd, areaFt2, pPsia, tempR, z }) => {
  if (!(areaFt2 > 0) || !(pPsia > 0)) return NaN;
  return (qMscfd * tempR * z) / (RATE_CONSTANT_MSCFD * areaFt2 * pPsia);
};

/** Flow area of a round tubing, ft2, from its inside diameter in inches. */
export const tubingAreaFt2 = (idIn) => (Math.PI * idIn * idIn) / (4 * 144);

/**
 * The loading check at ONE point in the well.
 *
 * returns { ok, criticalVelocityFtS, criticalRateMscfd, actualVelocityFtS,
 *           ratio, loaded, ... }
 * `ratio` is actual over critical: below 1 the well is loading up.
 */
export const loadingAt = ({
  correlation, sigmaDyneCm, rhoLiquidLbFt3, pPsia, tempR, z, gasSg, idIn,
  qMscfd, dragCoefficient, criticalWeber,
}) => {
  const vc = criticalVelocity({
    correlation, sigmaDyneCm, rhoLiquidLbFt3, pPsia, tempR, z, gasSg,
    dragCoefficient, criticalWeber,
  });
  if (!vc.ok) return { ok: false, error: vc.error };
  const areaFt2 = tubingAreaFt2(idIn);
  const criticalRateMscfd = rateAtVelocity({
    velocityFtS: vc.velocityFtS, areaFt2, pPsia, tempR, z,
  });
  const actualVelocityFtS = velocityAtRate({ qMscfd, areaFt2, pPsia, tempR, z });
  const ratio = criticalRateMscfd > 0 ? qMscfd / criticalRateMscfd : NaN;
  return {
    ok: true,
    ...vc,
    areaFt2,
    criticalVelocityFtS: vc.velocityFtS,
    criticalRateMscfd,
    actualVelocityFtS,
    ratio,
    loaded: Number.isFinite(ratio) ? ratio < 1 : false,
  };
};

/**
 * The loading check DOWN THE WHOLE STRING, and where it bites first.
 *
 * This matters and is often got wrong. The critical rate is not one
 * number for a well: it goes as roughly the square root of pressure,
 * so it is HIGHEST at the bottom of the tubing. A well can be safely
 * above the critical rate at the wellhead and loading at the shoe,
 * which is exactly where liquid actually starts to collect. So the
 * controlling point is the one with the largest critical rate, and
 * this returns the profile and names it rather than evaluating at the
 * wellhead and hoping.
 *
 * `stations` is [{ depthFt, pPsia, tempR, z, idIn }] from the caller's
 * flowing traverse, top first.
 *
 * returns { ok, points, controlling, loaded, marginPct }
 */
export const loadingProfile = ({
  stations, qMscfd, correlation, sigmaDyneCm, rhoLiquidLbFt3, gasSg,
  dragCoefficient, criticalWeber,
}) => {
  const points = [];
  for (const s of stations || []) {
    const at = loadingAt({
      correlation, sigmaDyneCm, rhoLiquidLbFt3, gasSg, qMscfd,
      pPsia: s.pPsia, tempR: s.tempR, z: s.z, idIn: s.idIn,
      dragCoefficient, criticalWeber,
    });
    if (!at.ok) return { ok: false, error: at.error };
    // The station's own conditions travel with the result. A profile
    // point that does not say what pressure and temperature it was
    // computed at cannot be plotted, and cannot be handed to the tubing
    // sizing that has to be evaluated at the controlling station.
    points.push({
      depthFt: s.depthFt,
      pPsia: s.pPsia,
      tempR: s.tempR,
      z: s.z,
      idIn: s.idIn,
      ...at,
    });
  }
  if (!points.length) {
    return { ok: false, error: 'The loading profile needs at least one station from the flowing traverse.' };
  }
  const controlling = points.reduce(
    (worst, p) => (p.criticalRateMscfd > worst.criticalRateMscfd ? p : worst),
    points[0],
  );
  return {
    ok: true,
    points,
    controlling,
    loaded: controlling.ratio < 1,
    marginPct: (controlling.ratio - 1) * 100,
  };
};

/**
 * Which correlation the well's conditions call for.
 *
 * Coleman's data set was low-pressure wells; Turner's adjustment came
 * from higher-pressure ones. This reports the guidance rather than
 * silently switching, because which one an operator trusts is theirs
 * to decide and the difference is only 20 percent.
 *
 * TWO THINGS THE MESSAGES USED TO GET WRONG.
 *
 * The branch is a STRICT comparison against 1000 psia and the reason
 * then printed the pressure it branched on, rounded whole, so a well at
 * 999.62 psia read "At 1000 psia wellhead this well sits inside the
 * low-pressure range" under a branch that only takes wells BELOW 1000.
 * The reader is shown a number that argues against the recommendation
 * attached to it, and the recommendation is worth 20 percent of every
 * critical rate computed after it. One decimal narrows that collision
 * by ten rather than removing it: a pressure inside 0.05 psi of the
 * limit still prints as the limit.
 *
 * `station` is the label for the pressure being handed in. It defaults
 * to `wellhead`, which is what the messages always said, but this
 * function takes ANY station's pressure and callers do hand it others,
 * so the word is the caller's to set rather than a fact asserted about
 * a number this function cannot see the origin of.
 *
 * AND THE THING THAT FIX ITSELF GOT WRONG. `Math.round` swallows
 * anything: it turned `undefined` into NaN and the string '900' into
 * 900, so a caller handing this function rubbish got a confident
 * correlation and never knew. `toFixed` is a method on Number, so the
 * same three inputs THREW instead. The format was display-only in
 * intent and was not display-only in effect, because nothing had
 * validated what reached the formatter. The pressure is checked before
 * it is formatted now, and a pressure that cannot be read is said to be
 * unreadable rather than printed as "NaN psia" or crashing the caller.
 * What this function returns for a good pressure is untouched.
 *
 * AND WHAT THAT GUARD STILL LEFT. Stopping the crash left the silence,
 * and the silence was the older and larger problem. `belowLimit` and
 * `correlation` are computed BEFORE the finiteness check, and the
 * unreadable branch returned that correlation anyway with the whole
 * disclaimer living in `reason`, which is prose. So the correlation a
 * caller got for an unreadable pressure depended on WHICH KIND of
 * unreadable it was, because `NaN < 1000` is false and `null < 1000` is
 * true:
 *
 *     recommendCorrelation(NaN)        -> 'turner'
 *     recommendCorrelation(null)       -> 'coleman'
 *     recommendCorrelation(undefined)  -> 'turner'
 *     recommendCorrelation('900')      -> 'coleman'
 *
 * Turner IS Coleman plus twenty percent, so a caller that read
 * `.correlation` and ignored `.reason`, which is what callers do,
 * silently applied or declined a twenty percent adjustment to every
 * critical rate in the study according to whether a missing pressure
 * arrived as a null or as a NaN. A refusal a caller cannot test for is
 * not a refusal, it is a comment.
 *
 * WHAT `ok` MEANS. `ok` is true when the pressure was a finite number
 * and the correlation named is a reading of this well's conditions.
 * `ok` is false when no pressure could be read, and then NOTHING else
 * on the result is a recommendation: `correlation` and `adjustment`
 * carry only where the comparison against the Coleman limit happened to
 * land on an unreadable value, and they are returned solely so that
 * callers written against the older shape keep working. A caller
 * seeing `ok: false` should ask for a numeric pressure in psia, or
 * choose the correlation itself, rather than use the one named here.
 *
 * `correlation` deliberately keeps its historical value and its type on
 * a false `ok`. Returning null there would break callers that read the
 * field directly, and that remains the owner's call; the gates pin both
 * halves so a later change to it cannot pass unnoticed.
 */
export const recommendCorrelation = (pPsia, station = 'wellhead') => {
  const belowLimit = pPsia < COLEMAN_PRESSURE_LIMIT_PSIA;
  const correlation = belowLimit ? 'coleman' : 'turner';
  const adjustment = LOADING_ADJUSTMENT[correlation];
  if (!Number.isFinite(pPsia)) {
    return {
      ok: false,
      correlation,
      adjustment,
      reason: `No ${station} pressure could be read here: ${describeUnusableNumber(pPsia)}. Which correlation these conditions call for cannot be said without one, so the name above is only where the comparison against ${COLEMAN_PRESSURE_LIMIT_PSIA} psia happens to land and is not a reading of this well. This result carries ok: false for that reason; test it rather than reading the correlation. Hand a numeric ${station} pressure in psia.`,
    };
  }
  return {
    ok: true,
    correlation,
    adjustment,
    reason: belowLimit
      ? `At ${pPsia.toFixed(1)} psia ${station} this well sits inside the low-pressure range Coleman's data covered, where the unadjusted equation fitted better.`
      : `At ${pPsia.toFixed(1)} psia ${station} this well is above the range Coleman studied, so Turner's 20 percent adjustment is the usual choice.`,
  };
};

/**
 * The tubing that would keep a given rate unloaded.
 *
 * Velocity goes as 1/A, so a smaller string lifts liquid at a lower
 * rate; this is the commonest and cheapest fix for a loading well. The
 * largest inside diameter whose critical rate the well still beats is
 * returned, along with every candidate and its margin, because a
 * tubing change is a workover and the numbers behind it get argued
 * about.
 *
 * THE SAME DEFECT recommendCorrelation HAD, IN ITS OWN SPELLING. This
 * function used to return only `rows` and `largestUnloaded`, and
 * `largestUnloaded: null` said two entirely different things with one
 * value. "No candidate string keeps this well unloaded, so there is no
 * tubing answer here" is a substantive engineering conclusion that a
 * reader will act on. "The rate or the conditions could not be read, so
 * the question was never evaluated" is not a conclusion at all. A
 * caller had no way to tell them apart, and the first is what a null
 * reads as.
 *
 * `ok` separates them. It is true when the question was answerable:
 * there were candidates, the rate was a finite number, and at least one
 * candidate produced a finite ratio. On `ok: false`, `largestUnloaded`
 * is not a finding about this well. `rows` and `largestUnloaded` are
 * computed exactly as before and are untouched by this, so every
 * existing caller keeps working unchanged.
 */
export const sizeTubingForRate = ({
  candidatesIdIn, qMscfd, correlation, sigmaDyneCm, rhoLiquidLbFt3,
  pPsia, tempR, z, gasSg, dragCoefficient, criticalWeber,
}) => {
  const rows = [...(candidatesIdIn || [])]
    .sort((a, b) => b - a)
    .map((idIn) => {
      const at = loadingAt({
        correlation, sigmaDyneCm, rhoLiquidLbFt3, pPsia, tempR, z, gasSg,
        idIn, qMscfd, dragCoefficient, criticalWeber,
      });
      return { idIn, ...at, ok: at.ok !== false };
    });
  const usable = rows.filter((r) => r.ok && r.ratio >= 1);
  const result = {
    rows,
    largestUnloaded: usable.length ? usable[0] : null,
  };
  if (!rows.length) {
    return { ...result, ok: false, reason: 'No candidate tubing sizes were given, so there was nothing to size.' };
  }
  if (!Number.isFinite(qMscfd)) {
    return {
      ...result,
      ok: false,
      reason: `No gas rate could be read here: ${describeUnusableNumber(qMscfd)}. Which tubing keeps a well unloaded is a question about a rate, so it cannot be answered without one. Hand a numeric rate in Mscf/d.`,
    };
  }
  if (!rows.some((r) => r.ok && Number.isFinite(r.ratio))) {
    return {
      ...result,
      ok: false,
      reason: 'None of the candidate sizes could be evaluated at these conditions, so no size was ruled in or out. Check the pressure, temperature, z factor and fluid properties.',
    };
  }
  return { ...result, ok: true };
};
