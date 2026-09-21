/**
 * Pressure relief and flare sizing (Facilities F2).
 *
 * API 520 Part I sizing in its published USC forms: gas/vapor
 * (critical and subcritical with the F2 closed form), liquid with the
 * published viscosity-correction equation, steam with the Napier
 * correction, and the API 521 fire case with the wetted-area heat
 * input evaluated at the ACTUAL relieving pressure. Plus the flare
 * side: API 521 drag-coefficient droplet settling for the knockout
 * drum, the point-source radiation model solved both ways (intensity
 * at a distance, and the distance an allowable intensity demands), and
 * an adiabatic vessel blowdown march.
 *
 * What is typed rather than computed, and why: the balanced-bellows
 * back-pressure factors (Kb gas, Kw liquid) and the steam superheat
 * factor KSH are published as CHARTS and TABLES, not equations.
 * Reproducing a plotted curve from memory is what this package
 * refuses, so those enter as inputs with their references named and a
 * warning where the default stops being safe. The closed forms that
 * ARE published (C from k, F2 subcritical, Kv viscosity, KN Napier)
 * are computed.
 *
 * EVERY CERTIFIED COEFFICIENT IS VALIDATED, and the rule is the same
 * one everywhere: a certified coefficient is a fraction of an ideal,
 * so 0 < K <= 1. A typed zero used to return Infinity with no `error`
 * key and a typed 1.5 used to return an area no valve can deliver;
 * both now refuse by name. Every function in this module returns
 * either a finite result or an object carrying `error`: a non-finite
 * number with no error is what a caller's `if (r.error)` guard cannot
 * see (FC5-0).
 *
 * Units: USC as published by API 520 — flow lb/hr (gas, steam) and
 * gpm (liquid), pressure psia, temperature Rankine, area in2. The
 * validation oracle implements the PUBLISHED SI FORMS of the same
 * equations, so agreement is two published routes meeting.
 */

/** API 526 standard orifices, in2. */
export const API_ORIFICES = [
  { orifice: 'D', areaIn2: 0.11 }, { orifice: 'E', areaIn2: 0.196 },
  { orifice: 'F', areaIn2: 0.307 }, { orifice: 'G', areaIn2: 0.503 },
  { orifice: 'H', areaIn2: 0.785 }, { orifice: 'J', areaIn2: 1.287 },
  { orifice: 'K', areaIn2: 1.838 }, { orifice: 'L', areaIn2: 2.853 },
  { orifice: 'M', areaIn2: 3.6 }, { orifice: 'N', areaIn2: 4.34 },
  { orifice: 'P', areaIn2: 6.38 }, { orifice: 'Q', areaIn2: 11.05 },
  { orifice: 'R', areaIn2: 16.0 }, { orifice: 'T', areaIn2: 26.0 },
];

/**
 * A certified coefficient is a fraction of an ideal: 0 < K <= 1.
 * Returns an error string naming the offender, or null.
 */
const coefficientError = (pairs) => {
  for (let i = 0; i < pairs.length; i += 1) {
    const [name, v] = pairs[i];
    if (!Number.isFinite(v) || !(v > 0) || v > 1) {
      return `${name} must be a number above 0 and no more than 1: a certified coefficient cannot add capacity`;
    }
  }
  return null;
};

/** Smallest standard orifice at or above the required area. */
export const selectOrifice = (requiredAreaIn2) => {
  if (!Number.isFinite(requiredAreaIn2) || !(requiredAreaIn2 > 0)) {
    return { error: 'required area must be a finite positive number' };
  }
  const hit = API_ORIFICES.find((o) => o.areaIn2 >= requiredAreaIn2);
  if (!hit) {
    // Print the figure that made the statement true, not a rounding of
    // it: 26.0001 rounded to 26.00 reads as a contradiction (FC5-0).
    const shown = Number(requiredAreaIn2.toPrecision(8));
    return {
      error: `required area ${shown} in2 exceeds a T orifice (26 in2): use multiple valves`,
      multipleOfT: Math.ceil(requiredAreaIn2 / 26),
    };
  }
  return { ...hit, requiredAreaIn2, margin: hit.areaIn2 / requiredAreaIn2 };
};

/** C in the USC form: C = 520 sqrt(k (2/(k+1))^((k+1)/(k-1))). */
export const gasConstantC = (k) => {
  if (!(k > 1)) return NaN;
  return 520 * Math.sqrt(k * (2 / (k + 1)) ** ((k + 1) / (k - 1)));
};

/** Critical flow pressure ratio: Pcf/P1 = (2/(k+1))^(k/(k-1)). */
export const criticalPressureRatio = (k) => (k > 1 ? (2 / (k + 1)) ** (k / (k - 1)) : NaN);

/**
 * F2 subcritical flow factor (API 520 closed form), r = P2/P1.
 */
export const subcriticalF2 = ({ k, r }) => {
  if (!(k > 1) || !(r > 0) || r >= 1) return NaN;
  return Math.sqrt((k / (k - 1)) * r ** (2 / k) * ((1 - r ** ((k - 1) / k)) / (1 - r)));
};

/**
 * Gas/vapor required area, critical or subcritical decided from the
 * back pressure against the critical ratio. Kb is 1.0 for a
 * conventional valve in critical flow BY THE STANDARD; for balanced
 * bellows above about 30 percent back-pressure ratio the chart value
 * must be typed (armed literature reference, API 520 Fig. 30).
 */
export const gasVaporArea = ({
  wLbHr, p1Psia, p2Psia = 14.7, tR, mw, z = 1, k = 1.4,
  kd = 0.975, kb = 1.0, kc = 1.0,
}) => {
  if (!(wLbHr > 0) || !(p1Psia > 0) || !(tR > 0) || !(mw > 0) || !(z > 0) || !(k > 1)) {
    return { error: 'gas sizing needs positive flow, pressure, temperature, MW, z and k above 1' };
  }
  if (!Number.isFinite(p2Psia) || p2Psia < 0) return { error: 'back pressure must be a finite pressure, zero or more' };
  const bad = coefficientError([['Kd', kd], ['Kb', kb], ['Kc', kc]]);
  if (bad) return { error: bad };
  if (!(p2Psia < p1Psia)) return { error: 'back pressure meets or exceeds relieving pressure: the valve cannot flow' };
  const rCrit = criticalPressureRatio(k);
  const critical = p2Psia <= rCrit * p1Psia;
  let areaIn2;
  if (critical) {
    const c = gasConstantC(k);
    areaIn2 = (wLbHr * Math.sqrt(tR * z / mw)) / (c * kd * p1Psia * kb * kc);
  } else {
    const f2 = subcriticalF2({ k, r: p2Psia / p1Psia });
    // API 520 subcritical: A = W / (735 F2 Kd Kc) * sqrt(T Z / (M P1 (P1-P2)))
    areaIn2 = (wLbHr / (735 * f2 * kd * kc))
      * Math.sqrt((tR * z) / (mw * p1Psia * (p1Psia - p2Psia)));
  }
  return {
    areaIn2, critical, criticalRatio: rCrit,
    warning: !critical && kb !== 1.0
      ? 'subcritical flow uses F2 in place of Kb, so the typed Kb was ignored'
      : (critical && p2Psia / p1Psia > 0.3 && kb === 1.0
        ? 'back pressure exceeds 30 percent of relieving pressure: a balanced-bellows valve needs its chart Kb (API 520 Fig. 30), typed here'
        : null),
  };
};

/**
 * Kv viscosity correction, API 520 closed form on the Reynolds number,
 * CLAMPED AT 1.0. The published fit asymptotes to 1/0.9935 = 1.00654,
 * and applying that unclamped lets a viscosity correction UNDERSIZE a
 * valve by up to 0.65 percent, which a correction for viscous drag
 * physically cannot do (FC5-0). The clamp is a stated convention, not
 * a derivation: `liquidKvUnclamped` keeps the raw fit so the asymptote
 * stays inspectable.
 */
export const liquidKvUnclamped = (reynolds) => {
  if (!Number.isFinite(reynolds) || !(reynolds > 0)) return NaN;
  return 1 / (0.9935 + 2.878 / Math.sqrt(reynolds) + 342.75 / reynolds ** 1.5);
};

export const liquidKv = (reynolds) => {
  const raw = liquidKvUnclamped(reynolds);
  return Number.isNaN(raw) ? NaN : Math.min(raw, 1.0);
};

/**
 * Liquid required area (certified-valve form):
 * A = Q sqrt(G) / (38 Kd Kw Kc Kv sqrt(P1 - P2)), Q gpm.
 * Kv iterates with area through the Reynolds number when a viscosity
 * is given, because R depends on the orifice the answer picks. The
 * iteration reports whether it converged and in how many passes: a
 * fixed point that quietly ran out of passes used to look exactly like
 * one that converged (FC5-0).
 */
export const liquidArea = ({
  qGpm, p1Psig, p2Psig = 0, sg, muCp = 0,
  kd = 0.65, kw = 1.0, kc = 1.0,
}) => {
  if (!(qGpm > 0) || !(sg > 0)) return { error: 'liquid sizing needs a positive rate and specific gravity' };
  if (!Number.isFinite(muCp) || muCp < 0) return { error: 'viscosity must be a finite number, zero or more' };
  if (!Number.isFinite(p1Psig) || !Number.isFinite(p2Psig)) return { error: 'liquid sizing needs finite set and back pressures' };
  const bad = coefficientError([['Kd', kd], ['Kw', kw], ['Kc', kc]]);
  if (bad) return { error: bad };
  const dp = p1Psig - p2Psig;
  if (!(dp > 0)) return { error: 'no differential across the valve: back pressure meets set pressure' };
  const base = (kv) => (qGpm * Math.sqrt(sg)) / (38 * kd * kw * kc * kv * Math.sqrt(dp));
  let kv = 1.0;
  let areaIn2 = base(kv);
  let reynolds = null;
  let iterations = 0;
  let converged = true;
  let residual = 0;
  if (muCp > 0) {
    converged = false;
    for (let i = 0; i < 40; i += 1) {
      iterations = i + 1;
      // API 520: R = Q (2800 G) / (mu sqrt(A))
      reynolds = (qGpm * 2800 * sg) / (muCp * Math.sqrt(areaIn2));
      const next = liquidKv(reynolds);
      residual = Math.abs(next - kv);
      kv = next;
      areaIn2 = base(kv);
      if (residual < 1e-12) { converged = true; break; }
    }
    // the Reynolds number belongs to the area that is returned
    reynolds = (qGpm * 2800 * sg) / (muCp * Math.sqrt(areaIn2));
  }
  return {
    areaIn2, kv, reynolds, kvIterations: iterations, kvConverged: converged, kvResidual: residual,
    warning: muCp > 0 && kv < 0.5
      ? 'viscosity correction below 0.5: this service is far off the certified test envelope; consider a different device'
      : (muCp > 0 && !converged
        ? 'the viscosity correction did not converge in 40 passes: treat the area as indicative'
        : null),
  };
};

/**
 * KN Napier correction, published closed form, applies above 1500 psia.
 * KN crosses back through 1.0 at 1580.31 psia, so between 1500 and
 * there the correction makes the valve BIGGER; `steamArea` says so
 * rather than leaving the step to be discovered.
 */
export const steamKn = (p1Psia) => {
  if (!Number.isFinite(p1Psia) || !(p1Psia > 0)) return NaN;
  if (p1Psia <= 1500) return 1.0;
  if (p1Psia > 3200) return NaN; // outside the published range
  return (0.1906 * p1Psia - 1000) / (0.2292 * p1Psia - 1061);
};

/** Pressure at which the Napier correction returns through 1.0, psia. */
export const NAPIER_UNITY_PSIA = (1061 - 1000) / (0.2292 - 0.1906);

/**
 * Steam required area: A = W / (51.5 P1 Kd Kb Kc KN KSH). KSH is the
 * published superheat TABLE, so it is typed (1.0 saturated).
 */
export const steamArea = ({
  wLbHr, p1Psia, kd = 0.975, kb = 1.0, kc = 1.0, ksh = 1.0,
}) => {
  if (!(wLbHr > 0) || !(p1Psia > 0)) return { error: 'steam sizing needs a positive flow and pressure' };
  const bad = coefficientError([['Kd', kd], ['Kb', kb], ['Kc', kc], ['KSH', ksh]]);
  if (bad) return { error: bad };
  const kn = steamKn(p1Psia);
  if (Number.isNaN(kn)) return { error: 'Napier correction is only published to 3200 psia' };
  return {
    areaIn2: wLbHr / (51.5 * p1Psia * kd * kb * kc * kn * ksh),
    kn,
    warning: p1Psia > 1500 && p1Psia < NAPIER_UNITY_PSIA
      ? `the Napier correction is below 1.0 between 1500 and ${NAPIER_UNITY_PSIA.toFixed(1)} psia, so it makes the required area LARGER here; it steps at 1500 psia and returns through 1.0 at ${NAPIER_UNITY_PSIA.toFixed(1)} psia`
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * API 521 fire case
 * ------------------------------------------------------------------ */

/**
 * Wetted area of a horizontal cylinder to a stated liquid level
 * (exact circular-segment geometry, heads ignored -- conservative for
 * the shell term and standard screening practice), or of a vertical
 * cylinder wetted up the level.
 *
 * `orientation` is matched case-insensitively and an unrecognised one
 * REFUSES: matching one lowercase string with === and falling through
 * to horizontal turned 'Vertical' into a factor of 4 on the area, and
 * through the chain into a different orifice letter (FC5-0).
 */
export const wettedAreaFt2 = ({
  orientation = 'horizontal', diameterFt, lengthFt, liquidLevelFt,
}) => {
  if (!(diameterFt > 0) || !(lengthFt > 0)) return { error: 'vessel geometry must be positive' };
  if (!Number.isFinite(liquidLevelFt) || liquidLevelFt < 0) {
    return { error: 'liquid level must be a finite number, zero or more' };
  }
  const o = String(orientation ?? '').trim().toLowerCase();
  if (o !== 'horizontal' && o !== 'vertical') {
    return { error: `orientation must be 'horizontal' or 'vertical'` };
  }
  if (o === 'vertical') {
    return { areaFt2: Math.PI * diameterFt * Math.min(liquidLevelFt, lengthFt) };
  }
  const h = Math.min(liquidLevelFt, diameterFt);
  const r = diameterFt / 2;
  const theta = 2 * Math.acos((r - h) / r); // wetted arc angle
  return { areaFt2: r * theta * lengthFt };
};

/**
 * API 521 pool-fire heat input: Q = 21000 F A^0.82 with adequate
 * drainage and firefighting, 34500 F A^0.82 without. F is the
 * environment factor (1.0 bare vessel; insulation credits are typed
 * against their table). Only the wetted area below 25 ft matters, and
 * that truncation is the CALLER's job because it depends on plot
 * elevation; the height limit is surfaced as a note.
 *
 * `adequateDrainage` must be a real boolean: the string 'false' is
 * truthy in JavaScript and used to buy the 1.643 drainage credit
 * silently (FC5-0).
 */
export const fireHeatInput = ({ wettedFt2, adequateDrainage = true, envFactor = 1.0 }) => {
  if (!Number.isFinite(wettedFt2) || !(wettedFt2 > 0)) return { error: 'fire case needs a positive wetted area' };
  if (typeof adequateDrainage !== 'boolean') {
    return { error: 'adequate drainage must be the boolean true or false' };
  }
  const bad = coefficientError([['environment factor F', envFactor]]);
  if (bad) return { error: bad };
  const c = adequateDrainage ? 21000 : 34500;
  return {
    qBtuHr: c * envFactor * wettedFt2 ** 0.82,
    note: 'wetted area counts only to 25 ft above grade (API 521); truncate the level before calling',
  };
};

/** Fire relief load: W = Q / latent heat. */
export const fireReliefLoad = ({ qBtuHr, latentBtuLb }) => {
  if (!Number.isFinite(qBtuHr) || !(qBtuHr > 0) || !Number.isFinite(latentBtuLb) || !(latentBtuLb > 0)) {
    return { error: 'relief load needs a positive duty and latent heat' };
  }
  return {
    wLbHr: qBtuHr / latentBtuLb,
    warning: latentBtuLb < 50
      ? 'latent heat below 50 Btu/lb: near-critical fluid, the latent-heat method is breaking down (API 521 c.4.4)'
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Flare knockout drum (API 521 droplet settling)
 * ------------------------------------------------------------------ */

/**
 * Droplet drag coefficient iterated with the settling velocity: the
 * terminal-velocity force balance (weight less buoyancy against form
 * drag on a sphere) with C from the Reynolds number,
 *
 *     Ud = sqrt(4 g d (rhoL - rhoV) / (3 C rhoV))
 *
 * API 521 prints the same balance with sqrt(4/3) rounded to 1.15; the
 * exact coefficient is 1.154701, and the rounding is worth 0.41
 * percent of the velocity, so the balance is evaluated rather than its
 * three-figure packaging (FC5-0). The drag correlation
 * C = 24/Re + 3/sqrt(Re) + 0.34 is an EMPIRICAL FIT and is HELD FOR
 * LITERATURE: no route in this package can derive its constants, and
 * the oracle shares it deliberately and says so.
 *
 * The returned velocity and drag coefficient are consistent with each
 * other: the previous version broke the loop having stored the NEW
 * drag coefficient beside a velocity computed from the OLD one.
 */
export const dropoutVelocityFtS = ({
  dropletMicron = 300, rhoLLbFt3, rhoVLbFt3, muVCp,
}) => {
  if (!Number.isFinite(dropletMicron) || !(dropletMicron > 0)
    || !Number.isFinite(rhoLLbFt3) || !Number.isFinite(rhoVLbFt3)
    || !(rhoLLbFt3 > rhoVLbFt3) || !(rhoVLbFt3 > 0)
    || !Number.isFinite(muVCp) || !(muVCp > 0)) {
    return { error: 'settling needs a positive droplet size, vapor viscosity, and a liquid denser than the vapor' };
  }
  const dFt = dropletMicron * 3.2808398950131233e-6; // 1 micron in ft
  const g = 32.174;
  const coeff = Math.sqrt(4 / 3);
  let c = 1.0;
  let ud = 0;
  let iterations = 0;
  let converged = false;
  let residual = 0;
  for (let i = 0; i < 200; i += 1) {
    iterations = i + 1;
    ud = coeff * Math.sqrt((g * dFt * (rhoLLbFt3 - rhoVLbFt3)) / (rhoVLbFt3 * c));
    const re = (rhoVLbFt3 * ud * dFt) / (muVCp * 6.7196897514e-4); // rho u d / mu, mu in lbm/(ft.s)
    const cNew = re < 0.1 ? 240 : 24 / re + 3 / Math.sqrt(re) + 0.34; // intermediate-law fit
    residual = Math.abs(cNew - c);
    c = cNew;
    if (residual < 1e-12) { converged = true; break; }
  }
  // the velocity that is returned is the one this drag coefficient gives
  ud = coeff * Math.sqrt((g * dFt * (rhoLLbFt3 - rhoVLbFt3)) / (rhoVLbFt3 * c));
  const reynolds = (rhoVLbFt3 * ud * dFt) / (muVCp * 6.7196897514e-4);
  return {
    udFtS: ud, dragC: c, reynolds, iterations, converged, residual,
    warning: converged ? null : 'the drag iteration did not converge in 200 passes: treat the velocity as indicative',
  };
};

/**
 * Liquid area fraction of a horizontal cylinder filled to a DEPTH
 * fraction f of its diameter (exact circular segment).
 */
export const segmentAreaFraction = (depthFraction) => {
  if (!Number.isFinite(depthFraction) || depthFraction < 0 || depthFraction > 1) return NaN;
  const theta = 2 * Math.acos(1 - 2 * depthFraction); // central angle of the liquid segment
  return (theta - Math.sin(theta)) / (2 * Math.PI);
};

/**
 * Horizontal knockout drum screen: at a candidate diameter, the vapor
 * transit time along the drum must exceed the droplet's fall time
 * across the vapor space. Returns the required drum length for the
 * stated diameter plus the actual velocities, so the L/D judgment
 * stays visible.
 *
 * `liquidFraction` is the LIQUID LEVEL as a fraction of the diameter,
 * which is what a level instrument reads. The vapor cross-section is
 * then the exact circular segment above it and the fall distance is
 * the vapor depth D (1 - f). The previous version used (1 - f) for
 * BOTH, and the two cancelled algebraically: the holdup box moved the
 * required length by 9e-16 ft over its whole range, and the answer was
 * 5 percent high at a tenth full and 28 percent low at three-quarters
 * full while being exactly right at half full, which is the one case
 * anyone checks (FC5-0).
 */
export const koDrumHorizontal = ({
  qVaporAcfs, udFtS, diameterFt, liquidFraction = 0.25,
}) => {
  if (!Number.isFinite(qVaporAcfs) || !(qVaporAcfs > 0)
    || !Number.isFinite(udFtS) || !(udFtS > 0)
    || !Number.isFinite(diameterFt) || !(diameterFt > 0)) {
    return { error: 'drum sizing needs positive vapor rate, dropout velocity and diameter' };
  }
  if (!Number.isFinite(liquidFraction) || liquidFraction < 0 || liquidFraction >= 1) {
    return { error: 'liquid level fraction must be a number from 0 up to but not including 1' };
  }
  const areaTotal = (Math.PI * diameterFt * diameterFt) / 4;
  const liquidAreaFraction = segmentAreaFraction(liquidFraction);
  const areaVapor = areaTotal * (1 - liquidAreaFraction);
  const vVapor = qVaporAcfs / areaVapor;
  const fallFt = diameterFt * (1 - liquidFraction); // vapor depth above the level
  const requiredLengthFt = vVapor * (fallFt / udFtS);
  const ld = requiredLengthFt / diameterFt;
  return {
    vVaporFtS: vVapor,
    requiredLengthFt,
    ld,
    liquidDepthFt: diameterFt * liquidFraction,
    liquidAreaFraction,
    areaVaporFt2: areaVapor,
    fallFt,
    note: ld > 6
      ? 'L/D above 6: go to a larger diameter'
      : (ld < 2 ? 'L/D below 2: a smaller drum may do' : null),
  };
};

/* ------------------------------------------------------------------ *
 * Flare radiation (API 521 point source)
 * ------------------------------------------------------------------ */

const radiationInputError = ({ fractionRadiated, transmissivity }) => coefficientError([
  ['the radiated fraction', fractionRadiated], ['transmissivity', transmissivity],
]);

/** Intensity at a distance: K = tau F Q / (4 pi R^2), kW/m2 with Q kW, R m. */
export const radiationIntensity = ({ qKw, distanceM, fractionRadiated = 0.3, transmissivity = 1.0 }) => {
  if (!Number.isFinite(qKw) || !(qKw > 0) || !Number.isFinite(distanceM) || !(distanceM > 0)) {
    return { error: 'radiation needs a positive heat release and distance' };
  }
  const bad = radiationInputError({ fractionRadiated, transmissivity });
  if (bad) return { error: bad };
  return { kWm2: (transmissivity * fractionRadiated * qKw) / (4 * Math.PI * distanceM ** 2) };
};

/**
 * The distance an allowable intensity demands: the same model
 * inverted, and validating the SAME four inputs. It used to check two
 * of them, so a radiated fraction of zero returned a safe distance of
 * zero metres (FC5-0).
 */
export const distanceForIntensity = ({ qKw, allowableKwM2, fractionRadiated = 0.3, transmissivity = 1.0 }) => {
  if (!Number.isFinite(qKw) || !(qKw > 0) || !Number.isFinite(allowableKwM2) || !(allowableKwM2 > 0)) {
    return { error: 'distance solve needs a positive duty and allowable' };
  }
  const bad = radiationInputError({ fractionRadiated, transmissivity });
  if (bad) return { error: bad };
  return { distanceM: Math.sqrt((transmissivity * fractionRadiated * qKw) / (4 * Math.PI * allowableKwM2)) };
};

/**
 * API 521 customary allowable levels, kW/m2, for the UI to offer.
 *
 * THE LABELS ARE HELD FOR LITERATURE: the values are customary and the
 * wording is this package's, with no source checked. The wording is
 * kept IDENTICAL to engines/facilities/spacing.js, which exports the
 * same table for the same physics and whose wording a merged NextGen
 * course already teaches; a gate asserts the two tables stay equal, so
 * one learner cannot meet two sets of words for one table (FC5-0).
 */
export const RADIATION_LEVELS = [
  { kWm2: 1.58, label: 'Continuous exposure, no time limit (site boundary, control room)' },
  { kWm2: 4.73, label: 'Emergency action of several minutes, with clothing' },
  { kWm2: 6.31, label: 'Emergency action up to about a minute' },
  { kWm2: 9.46, label: 'Seconds only: escape route' },
];

/* ------------------------------------------------------------------ *
 * Adiabatic blowdown march
 * ------------------------------------------------------------------ */

/**
 * Vessel depressuring through a fixed orifice: isentropic gas
 * expansion in the vessel, critical-flow discharge, explicit march.
 * Returns the trajectory so the 15-minute API 521 question is read
 * off a curve, not asserted.
 *
 * Three things were wrong with the march and all three were invisible
 * on the answer (FC5-0):
 *
 *  - A step that would have removed more mass than the vessel held
 *    BROKE the loop and returned `timeS: 0` with no `error` key and the
 *    vessel still at its start pressure, which printed as a vessel
 *    depressured in 0.0 minutes, inside the customary 15. The step is
 *    now SUBDIVIDED so no step removes more than 5 percent of the
 *    inventory, and the march is midpoint (second order) rather than
 *    Euler.
 *  - The caller's discharge coefficient was multiplied by a hidden
 *    0.975, a relief valve's certified Kd with no business inside a
 *    blowdown orifice, so a typed 0.85 ran as 0.829 and the time came
 *    out 2.6 percent long.
 *  - The answer was quantised to one dtS because the march overshot
 *    the end pressure by up to a full step. The final step is now
 *    interpolated onto the end pressure, so refining dtS converges
 *    instead of stepping.
 *
 * The flow is taken as choked throughout, which is the model's stated
 * limit: below pBackPsia / critical ratio it is not, and the result
 * says so rather than reporting an optimistic time in silence.
 */
export const blowdown = ({
  volumeFt3, p0Psia, t0R, pEndPsia, mw, k = 1.4, z = 0.9,
  orificeDIn, cd = 0.85, dtS = 0.1, maxS = 7200, pBackPsia = 14.7,
}) => {
  if (!Number.isFinite(volumeFt3) || !(volumeFt3 > 0)
    || !Number.isFinite(p0Psia) || !Number.isFinite(pEndPsia)
    || !(p0Psia > pEndPsia) || !(pEndPsia > 0)
    || !Number.isFinite(t0R) || !(t0R > 0)
    || !Number.isFinite(mw) || !(mw > 0) || !(k > 1)
    || !Number.isFinite(z) || !(z > 0)
    || !Number.isFinite(orificeDIn) || !(orificeDIn > 0)) {
    return { error: 'blowdown needs positive geometry, a start above the end pressure, and gas properties' };
  }
  const bad = coefficientError([['the discharge coefficient', cd]]);
  if (bad) return { error: bad };
  // dtS <= 0 used to be an UNBOUNDED LOOP: time never advanced, so the
  // maxS exit could never fire and the call never returned (FC5-0).
  if (!Number.isFinite(dtS) || !(dtS > 0)) return { error: 'the time step must be a finite number above zero' };
  if (!Number.isFinite(maxS) || !(maxS > 0)) return { error: 'the time limit must be a finite number above zero' };

  const aFt2 = cd * (Math.PI / 4) * (orificeDIn / 12) ** 2;
  const c = gasConstantC(k);
  const rGas = 1545.349 / mw; // ft.lbf/(lbm.R)
  const m0 = (p0Psia * 144 * volumeFt3) / (z * rGas * t0R); // lbm

  // state is a function of mass alone: isentropic in the vessel
  const tOf = (m) => t0R * (m / m0) ** (k - 1);
  const pOf = (m, t) => (m * z * rGas * t) / (144 * volumeFt3);
  // choked mass flow, lbm/s, at the caller's discharge coefficient
  const wOf = (m) => {
    const t = tOf(m);
    return (c * pOf(m, t) * (aFt2 * 144) * Math.sqrt(mw / (t * z))) / 3600;
  };

  let mass = m0;
  let t = t0R;
  let p = p0Psia;
  let time = 0;
  let steps = 0;
  let substeps = 0;
  const stations = [{ tS: 0, pPsia: p, tR: t }];
  const MAX_STEPS = 5e6;

  while (p > pEndPsia) {
    if (time >= maxS) return { error: 'did not reach the end pressure inside the time limit: check the orifice size' };
    if (steps >= MAX_STEPS) return { error: 'blowdown march did not finish inside its step budget: raise the time step' };
    steps += 1;
    let dt = Math.min(dtS, maxS - time);
    // no step may remove more than 5 percent of the inventory
    const cap = 0.05 * mass;
    const w0 = wOf(mass);
    if (w0 * dt > cap) { dt = cap / w0; substeps += 1; }
    // midpoint (second order) on dm/dt = -w(m)
    const mHalf = mass - w0 * (dt / 2);
    const massNew = mass - wOf(mHalf) * dt;
    const tNew = tOf(massNew);
    const pNew = pOf(massNew, tNew);
    if (pNew <= pEndPsia) {
      // land ON the end pressure instead of overshooting by up to a
      // whole step, which quantised the answer to one dtS: bisect the
      // fraction of this step, using the march's own state functions
      let lo = 0;
      let hi = 1;
      for (let j = 0; j < 80; j += 1) {
        const mid = (lo + hi) / 2;
        const mTry = mass + (massNew - mass) * mid;
        if (pOf(mTry, tOf(mTry)) > pEndPsia) lo = mid; else hi = mid;
      }
      const frac = (lo + hi) / 2;
      time += frac * dt;
      mass += (massNew - mass) * frac;
      t = tOf(mass);
      p = pOf(mass, t);
      break;
    }
    mass = massNew;
    t = tNew;
    p = pNew;
    time += dt;
    if (stations.length < 2000 && steps % 10 === 0) stations.push({ tS: time, pPsia: p, tR: t });
  }
  stations.push({ tS: time, pPsia: p, tR: t });
  const rCrit = criticalPressureRatio(k);
  const chokedToPsia = Number.isFinite(pBackPsia) && pBackPsia > 0 ? pBackPsia / rCrit : null;
  return {
    timeS: time,
    stations,
    finalTR: t,
    finalPPsia: p,
    massRemainingLb: mass,
    initialMassLb: m0,
    steps,
    substeps,
    dtS,
    chokedToPsia,
    warning: chokedToPsia !== null && pEndPsia < chokedToPsia
      ? `the march assumes choked flow throughout, and it stops being choked below ${chokedToPsia.toFixed(1)} psia against a ${pBackPsia} psia back pressure: the time below that is optimistic`
      : null,
  };
};
