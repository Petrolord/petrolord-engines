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

/** Smallest standard orifice at or above the required area. */
export const selectOrifice = (requiredAreaIn2) => {
  if (!(requiredAreaIn2 > 0)) return { error: 'required area must be positive' };
  const hit = API_ORIFICES.find((o) => o.areaIn2 >= requiredAreaIn2);
  if (!hit) {
    return {
      error: `required area ${requiredAreaIn2.toFixed(2)} in2 exceeds a T orifice (26 in2): use multiple valves`,
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
      ? 'subcritical flow uses F2, not Kb; the typed Kb was ignored'
      : (critical && p2Psia / p1Psia > 0.3 && kb === 1.0
        ? 'back pressure exceeds 30 percent of relieving pressure: a balanced-bellows valve needs its chart Kb (API 520 Fig. 30), typed here'
        : null),
  };
};

/** Kv viscosity correction, API 520 closed form on the Reynolds number. */
export const liquidKv = (reynolds) => {
  if (!(reynolds > 0)) return NaN;
  return 1 / (0.9935 + 2.878 / Math.sqrt(reynolds) + 342.75 / reynolds ** 1.5);
};

/**
 * Liquid required area (certified-valve form):
 * A = Q sqrt(G) / (38 Kd Kw Kc Kv sqrt(P1 - P2)), Q gpm.
 * Kv iterates with area through the Reynolds number when a viscosity
 * is given, because R depends on the orifice the answer picks.
 */
export const liquidArea = ({
  qGpm, p1Psig, p2Psig = 0, sg, muCp = 0,
  kd = 0.65, kw = 1.0, kc = 1.0,
}) => {
  if (!(qGpm > 0) || !(sg > 0)) return { error: 'liquid sizing needs a positive rate and specific gravity' };
  const dp = p1Psig - p2Psig;
  if (!(dp > 0)) return { error: 'no differential across the valve: back pressure meets set pressure' };
  const base = (kv) => (qGpm * Math.sqrt(sg)) / (38 * kd * kw * kc * kv * Math.sqrt(dp));
  let kv = 1.0;
  let areaIn2 = base(kv);
  let reynolds = null;
  if (muCp > 0) {
    for (let i = 0; i < 40; i += 1) {
      // API 520: R = Q (2800 G) / (mu sqrt(A))
      reynolds = (qGpm * 2800 * sg) / (muCp * Math.sqrt(areaIn2));
      const next = liquidKv(reynolds);
      if (Math.abs(next - kv) < 1e-10) { kv = next; break; }
      kv = next;
      areaIn2 = base(kv);
    }
    areaIn2 = base(kv);
  }
  return {
    areaIn2, kv, reynolds,
    warning: muCp > 0 && kv < 0.5
      ? 'viscosity correction below 0.5: this service is far off the certified test envelope; consider a different device'
      : null,
  };
};

/** KN Napier correction, published closed form, applies above 1500 psia. */
export const steamKn = (p1Psia) => {
  if (!(p1Psia > 0)) return NaN;
  if (p1Psia <= 1500) return 1.0;
  if (p1Psia > 3200) return NaN; // outside the published range
  return (0.1906 * p1Psia - 1000) / (0.2292 * p1Psia - 1061);
};

/**
 * Steam required area: A = W / (51.5 P1 Kd Kb Kc KN KSH). KSH is the
 * published superheat TABLE, so it is typed (1.0 saturated).
 */
export const steamArea = ({
  wLbHr, p1Psia, kd = 0.975, kb = 1.0, kc = 1.0, ksh = 1.0,
}) => {
  if (!(wLbHr > 0) || !(p1Psia > 0)) return { error: 'steam sizing needs a positive flow and pressure' };
  const kn = steamKn(p1Psia);
  if (Number.isNaN(kn)) return { error: 'Napier correction is only published to 3200 psia' };
  return { areaIn2: wLbHr / (51.5 * p1Psia * kd * kb * kc * kn * ksh), kn };
};

/* ------------------------------------------------------------------ *
 * API 521 fire case
 * ------------------------------------------------------------------ */

/**
 * Wetted area of a horizontal cylinder to a stated liquid level
 * (exact circular-segment geometry, heads ignored -- conservative for
 * the shell term and standard screening practice), or of a vertical
 * cylinder wetted up the level.
 */
export const wettedAreaFt2 = ({
  orientation = 'horizontal', diameterFt, lengthFt, liquidLevelFt,
}) => {
  if (!(diameterFt > 0) || !(lengthFt > 0)) return { error: 'vessel geometry must be positive' };
  const h = Math.min(Math.max(liquidLevelFt, 0), diameterFt);
  if (orientation === 'vertical') {
    return { areaFt2: Math.PI * diameterFt * Math.min(liquidLevelFt, lengthFt) };
  }
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
 */
export const fireHeatInput = ({ wettedFt2, adequateDrainage = true, envFactor = 1.0 }) => {
  if (!(wettedFt2 > 0)) return { error: 'fire case needs a positive wetted area' };
  const c = adequateDrainage ? 21000 : 34500;
  return {
    qBtuHr: c * envFactor * wettedFt2 ** 0.82,
    note: 'wetted area counts only to 25 ft above grade (API 521); truncate the level before calling',
  };
};

/** Fire relief load: W = Q / latent heat. */
export const fireReliefLoad = ({ qBtuHr, latentBtuLb }) => {
  if (!(qBtuHr > 0) || !(latentBtuLb > 0)) return { error: 'relief load needs a positive duty and latent heat' };
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
 * Droplet drag coefficient iterated with the settling velocity
 * (API 521's C-Re method, spherical drag in the intermediate regime):
 * Ud = 1.15 sqrt(g d (rhoL - rhoV) / (rhoV C)), C from Re.
 */
export const dropoutVelocityFtS = ({
  dropletMicron = 300, rhoLLbFt3, rhoVLbFt3, muVCp,
}) => {
  if (!(dropletMicron > 0) || !(rhoLLbFt3 > rhoVLbFt3) || !(rhoVLbFt3 > 0) || !(muVCp > 0)) {
    return { error: 'settling needs a positive droplet size, vapor viscosity, and a liquid denser than the vapor' };
  }
  const dFt = dropletMicron * 3.2808e-6;
  const g = 32.174;
  let c = 1.0;
  let ud = 0;
  for (let i = 0; i < 80; i += 1) {
    ud = 1.15 * Math.sqrt((g * dFt * (rhoLLbFt3 - rhoVLbFt3)) / (rhoVLbFt3 * c));
    const re = (rhoVLbFt3 * ud * dFt) / (muVCp * 6.7197e-4); // rho u d / mu, mu in lbm/(ft.s)
    const cNew = re < 0.1 ? 240 : 24 / re + 3 / Math.sqrt(re) + 0.34; // intermediate-law fit
    if (Math.abs(cNew - c) < 1e-10) { c = cNew; break; }
    c = cNew;
  }
  return { udFtS: ud, dragC: c };
};

/**
 * Horizontal knockout drum screen: at a candidate diameter, the vapor
 * transit time along the drum must exceed the droplet's fall time
 * across it. Returns the required drum length for the stated diameter
 * plus the actual velocities, so the L/D judgment stays visible.
 */
export const koDrumHorizontal = ({
  qVaporAcfs, udFtS, diameterFt, liquidFraction = 0.25,
}) => {
  if (!(qVaporAcfs > 0) || !(udFtS > 0) || !(diameterFt > 0)) {
    return { error: 'drum sizing needs positive vapor rate, dropout velocity and diameter' };
  }
  if (!(liquidFraction >= 0) || liquidFraction >= 1) return { error: 'liquid fraction must be below 1' };
  const areaTotal = (Math.PI * diameterFt * diameterFt) / 4;
  const areaVapor = areaTotal * (1 - liquidFraction);
  const vVapor = qVaporAcfs / areaVapor;
  const fallFt = diameterFt * (1 - liquidFraction);
  const requiredLengthFt = vVapor * (fallFt / udFtS);
  return {
    vVaporFtS: vVapor,
    requiredLengthFt,
    ld: requiredLengthFt / diameterFt,
    note: requiredLengthFt / diameterFt > 6
      ? 'L/D above 6: go to a larger diameter'
      : (requiredLengthFt / diameterFt < 2 ? 'L/D below 2: a smaller drum may do' : null),
  };
};

/* ------------------------------------------------------------------ *
 * Flare radiation (API 521 point source)
 * ------------------------------------------------------------------ */

/** Intensity at a distance: K = tau F Q / (4 pi R^2), kW/m2 with Q kW, R m. */
export const radiationIntensity = ({ qKw, distanceM, fractionRadiated = 0.3, transmissivity = 1.0 }) => {
  if (!(qKw > 0) || !(distanceM > 0) || !(fractionRadiated > 0) || !(transmissivity > 0)) {
    return { error: 'radiation needs positive heat release, distance and factors' };
  }
  return { kWm2: (transmissivity * fractionRadiated * qKw) / (4 * Math.PI * distanceM ** 2) };
};

/** The distance an allowable intensity demands: the same model inverted. */
export const distanceForIntensity = ({ qKw, allowableKwM2, fractionRadiated = 0.3, transmissivity = 1.0 }) => {
  if (!(qKw > 0) || !(allowableKwM2 > 0)) return { error: 'distance solve needs a positive duty and allowable' };
  return { distanceM: Math.sqrt((transmissivity * fractionRadiated * qKw) / (4 * Math.PI * allowableKwM2)) };
};

/** API 521 customary allowable levels, kW/m2, for the UI to offer. */
export const RADIATION_LEVELS = [
  { kWm2: 1.58, label: 'Continuous exposure, no time limit' },
  { kWm2: 4.73, label: 'Emergency actions of several minutes, with clothing' },
  { kWm2: 6.31, label: 'Emergency actions up to about a minute' },
  { kWm2: 9.46, label: 'Seconds only: immediate escape' },
];

/* ------------------------------------------------------------------ *
 * Adiabatic blowdown march
 * ------------------------------------------------------------------ */

/**
 * Vessel depressuring through a fixed orifice: isentropic gas
 * expansion in the vessel, critical-flow discharge, explicit march.
 * Returns the trajectory so the 15-minute API 521 question is read
 * off a curve, not asserted.
 */
export const blowdown = ({
  volumeFt3, p0Psia, t0R, pEndPsia, mw, k = 1.4, z = 0.9,
  orificeDIn, cd = 0.85, dtS = 0.1, maxS = 7200,
}) => {
  if (!(volumeFt3 > 0) || !(p0Psia > pEndPsia) || !(pEndPsia > 0) || !(t0R > 0)
    || !(mw > 0) || !(k > 1) || !(z > 0) || !(orificeDIn > 0)) {
    return { error: 'blowdown needs positive geometry, a start above the end pressure, and gas properties' };
  }
  const aFt2 = cd * (Math.PI / 4) * (orificeDIn / 12) ** 2;
  const c = gasConstantC(k);
  const rGas = 1545.349 / mw; // ft.lbf/(lbm.R)
  let p = p0Psia;
  let t = t0R;
  let mass = (p * 144 * volumeFt3) / (z * rGas * t); // lbm
  const stations = [{ tS: 0, pPsia: p, tR: t }];
  let time = 0;
  while (p > pEndPsia && time < maxS) {
    const wLbHr = c * 0.975 * p * (aFt2 * 144) * Math.sqrt(mw / (t * z));
    const dm = (wLbHr / 3600) * dtS;
    if (dm >= mass) break;
    const massNew = mass - dm;
    const tNew = t * (massNew / mass) ** (k - 1);
    mass = massNew;
    t = tNew;
    p = (mass * z * rGas * t) / (144 * volumeFt3);
    time += dtS;
    if (stations.length < 2000 && Math.round(time / dtS) % 10 === 0) {
      stations.push({ tS: time, pPsia: p, tR: t });
    }
  }
  if (time >= maxS) return { error: 'did not reach the end pressure inside two hours: check the orifice size' };
  stations.push({ tS: time, pPsia: p, tR: t });
  return { timeS: time, stations, finalTR: t };
};
