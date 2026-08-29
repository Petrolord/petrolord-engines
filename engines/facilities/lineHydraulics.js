/**
 * Single-line hydraulics for surface facilities (Facilities F1).
 *
 * Scope is the FLAGSHIP's engine tier: single-phase liquid lines
 * (Darcy-Weisbach with Colebrook-White friction), single-phase gas
 * lines (the Weymouth, Panhandle A, Panhandle B and General Flow
 * equations in their published GPSA field-unit forms, with the
 * standard elevation adjustment), line-pipe wall thickness to
 * B31.4/B31.8 (Barlow with the code design factors), and the pigging
 * estimates a liquids-management screen actually uses.
 *
 * What is deliberately NOT here:
 *  - multiphase pressure drop: the Suite's golden-tested Beggs & Brill
 *    (src/utils/nodal/correlations/beggsBrill.js) is the canonical
 *    correlation and the app composes it; rebuilding it would be the
 *    duplication this platform keeps removing.
 *  - erosional velocity: engines/production/chokePerformance.js owns
 *    RP 14E; compose, don't copy.
 *  - pipe geometry data: engines/production/pipeSchedule.js owns the
 *    checked B36.10 subset, roughness table and fitting K values.
 *
 * Units are field units throughout: rates bpd / scfd, diameters
 * inches, lengths feet (gas equations take miles where the published
 * form does), pressures psia, temperatures Rankine, density lb/ft3,
 * viscosity cp. Every published constant is quoted with its source
 * form in the comment beside it.
 *
 * The transmission equations are empirical and their constants are
 * form-specific; the validation oracle implements the PUBLISHED SI
 * FORMS (different constants, same physics) so agreement is two
 * routes meeting, not code echoing itself.
 */

const FT_PER_MILE = 5280;
const S_PER_DAY = 86400;
// exact: 42 gal x 231 in3/gal over 1728 in3/ft3
const CUFT_PER_BBL = (42 * 231) / 1728;
const GC = 32.174; // lbm.ft / (lbf.s2)
// 1 cp = 6.7197e-4 lbm/(ft.s)
const CP_TO_LBM_FT_S = 6.7197e-4;

/** Standard base conditions of the published gas-equation forms. */
export const BASE_CONDITIONS = { tbR: 520, pbPsia: 14.65 };

/* ------------------------------------------------------------------ *
 * Friction
 * ------------------------------------------------------------------ */

/** Reynolds number of a liquid line. */
export const reynoldsNumber = ({ rhoLbFt3, vFtS, idIn, muCp }) => {
  if (!(rhoLbFt3 > 0) || !(idIn > 0) || !(muCp > 0) || !Number.isFinite(vFtS)) return NaN;
  return (rhoLbFt3 * Math.abs(vFtS) * (idIn / 12)) / (muCp * CP_TO_LBM_FT_S);
};

/**
 * Darcy friction factor. Laminar below Re 2100 (64/Re); Colebrook-White
 * above, solved by fixed-point iteration on 1/sqrt(f). The transition
 * band has no honest correlation, so the turbulent branch is used from
 * 2100 up and the answer carries a `regime` the caller can surface.
 */
export const frictionFactor = ({ re, relRough = 0 }) => {
  if (!(re > 0)) return { f: NaN, regime: 'invalid' };
  if (re < 2100) return { f: 64 / re, regime: 'laminar' };
  let invSqrt = 1 / Math.sqrt(0.02);
  for (let i = 0; i < 60; i += 1) {
    const next = -2 * Math.log10(relRough / 3.7 + (2.51 * invSqrt) / re);
    if (Math.abs(next - invSqrt) < 1e-13) { invSqrt = next; break; }
    invSqrt = next;
  }
  return { f: 1 / (invSqrt * invSqrt), regime: re < 4000 ? 'transitional' : 'turbulent' };
};

/* ------------------------------------------------------------------ *
 * Liquid lines
 * ------------------------------------------------------------------ */

/**
 * Darcy-Weisbach pressure drop of a single-phase liquid line.
 * Friction, fittings (velocity-head K sum) and elevation are returned
 * separately because they answer different questions: friction is what
 * a bigger pipe fixes, elevation is what no pipe fixes.
 */
export const liquidLineDrop = ({
  qBpd, idIn, lengthFt, elevChangeFt = 0,
  rhoLbFt3, muCp, roughnessIn = 0.0018, sumK = 0,
}) => {
  if (!(qBpd > 0) || !(idIn > 0) || !(lengthFt > 0) || !(rhoLbFt3 > 0) || !(muCp > 0)) {
    return { error: 'liquid line drop needs positive rate, bore, length, density and viscosity' };
  }
  const areaFt2 = (Math.PI * idIn * idIn) / (4 * 144);
  const vFtS = (qBpd * CUFT_PER_BBL) / S_PER_DAY / areaFt2;
  const re = reynoldsNumber({ rhoLbFt3, vFtS, idIn, muCp });
  const { f, regime } = frictionFactor({ re, relRough: roughnessIn / idIn });
  const velocityHeadPsi = (rhoLbFt3 * vFtS * vFtS) / (2 * GC) / 144;
  const dpFrictionPsi = f * (lengthFt / (idIn / 12)) * velocityHeadPsi;
  const dpFittingsPsi = sumK * velocityHeadPsi;
  const dpElevationPsi = (rhoLbFt3 * elevChangeFt) / 144;
  return {
    vFtS, re, f, regime,
    dpFrictionPsi, dpFittingsPsi, dpElevationPsi,
    dpTotalPsi: dpFrictionPsi + dpFittingsPsi + dpElevationPsi,
    gradientPsiPerFt: (dpFrictionPsi + dpFittingsPsi) / lengthFt + rhoLbFt3 / 144 * (elevChangeFt / lengthFt),
  };
};

/**
 * March a liquid line along an elevation profile. `profile` is
 * [{ lengthFt, elevChangeFt }] segments; returns the pressure at every
 * station so the app can draw the hydraulic gradient rather than
 * assert one number.
 */
export const liquidLineTraverse = ({
  p1Psia, qBpd, idIn, rhoLbFt3, muCp, roughnessIn = 0.0018, profile,
}) => {
  if (!Array.isArray(profile) || profile.length === 0) {
    return { error: 'a traverse needs at least one profile segment' };
  }
  const stations = [{ distanceFt: 0, elevFt: 0, pPsia: p1Psia }];
  let p = p1Psia; let x = 0; let z = 0;
  for (const seg of profile) {
    const drop = liquidLineDrop({
      qBpd, idIn, lengthFt: seg.lengthFt, elevChangeFt: seg.elevChangeFt || 0,
      rhoLbFt3, muCp, roughnessIn,
    });
    if (drop.error) return { error: drop.error };
    p -= drop.dpTotalPsi;
    x += seg.lengthFt;
    z += seg.elevChangeFt || 0;
    stations.push({ distanceFt: x, elevFt: z, pPsia: p });
  }
  return { stations, p2Psia: p, dpTotalPsi: p1Psia - p };
};

/* ------------------------------------------------------------------ *
 * Gas lines -- the published GPSA field-unit transmission forms.
 * Q scfd at (tbR, pbPsia); d inches; length MILES (the published
 * unit); pressures psia; tAvgR Rankine; zAvg dimensionless; sg air=1;
 * efficiency E multiplies the flow.
 * ------------------------------------------------------------------ */

/**
 * Elevation adjustment shared by all forms: s = 0.0375 G dz / (T Z);
 * the driving term becomes (p1^2 - es p2^2) and the friction length
 * Le = L (es - 1) / s. At dz = 0 both collapse to the flat form.
 */
export const elevationAdjustment = ({ sg, elevChangeFt, tAvgR, zAvg }) => {
  const s = (0.0375 * sg * (elevChangeFt || 0)) / (tAvgR * zAvg);
  if (Math.abs(s) < 1e-12) return { s: 0, es: 1, leFactor: 1 };
  const es = Math.exp(s);
  return { s, es, leFactor: (es - 1) / s };
};

const gasCommon = ({ p1Psia, p2Psia, sg, tAvgR, zAvg, lengthMi, elevChangeFt }) => {
  const { es, leFactor } = elevationAdjustment({ sg, elevChangeFt, tAvgR, zAvg });
  const driving = p1Psia * p1Psia - es * p2Psia * p2Psia;
  return { es, leMi: lengthMi * leFactor, driving };
};

/** Weymouth: Q = 433.5 (Tb/Pb) [(p1^2 - p2^2)/(G T L Z)]^0.5 d^2.667 E (GPSA). */
export const weymouthQ = ({
  p1Psia, p2Psia, idIn, lengthMi, sg, tAvgR, zAvg = 0.9,
  efficiency = 1, elevChangeFt = 0, tbR = BASE_CONDITIONS.tbR, pbPsia = BASE_CONDITIONS.pbPsia,
}) => {
  const { driving, leMi } = gasCommon({ p1Psia, p2Psia, sg, tAvgR, zAvg, lengthMi, elevChangeFt });
  if (driving <= 0) return { error: 'no flow: outlet pressure meets or exceeds inlet head' };
  const q = 433.5 * efficiency * (tbR / pbPsia)
    * Math.sqrt(driving / (sg * tAvgR * leMi * zAvg)) * idIn ** (8 / 3);
  return { qScfd: q };
};

/** Panhandle A: Q = 435.87 (Tb/Pb)^1.0788 [(p1^2-p2^2)/(G^0.8539 T L Z)]^0.5394 d^2.6182 E. */
export const panhandleAQ = ({
  p1Psia, p2Psia, idIn, lengthMi, sg, tAvgR, zAvg = 0.9,
  efficiency = 1, elevChangeFt = 0, tbR = BASE_CONDITIONS.tbR, pbPsia = BASE_CONDITIONS.pbPsia,
}) => {
  const { driving, leMi } = gasCommon({ p1Psia, p2Psia, sg, tAvgR, zAvg, lengthMi, elevChangeFt });
  if (driving <= 0) return { error: 'no flow: outlet pressure meets or exceeds inlet head' };
  const q = 435.87 * efficiency * (tbR / pbPsia) ** 1.0788
    * (driving / (sg ** 0.8539 * tAvgR * leMi * zAvg)) ** 0.5394 * idIn ** 2.6182;
  return { qScfd: q };
};

/** Panhandle B: Q = 737 (Tb/Pb)^1.02 [(p1^2-p2^2)/(G^0.961 T L Z)]^0.51 d^2.53 E. */
export const panhandleBQ = ({
  p1Psia, p2Psia, idIn, lengthMi, sg, tAvgR, zAvg = 0.9,
  efficiency = 1, elevChangeFt = 0, tbR = BASE_CONDITIONS.tbR, pbPsia = BASE_CONDITIONS.pbPsia,
}) => {
  const { driving, leMi } = gasCommon({ p1Psia, p2Psia, sg, tAvgR, zAvg, lengthMi, elevChangeFt });
  if (driving <= 0) return { error: 'no flow: outlet pressure meets or exceeds inlet head' };
  const q = 737 * efficiency * (tbR / pbPsia) ** 1.02
    * (driving / (sg ** 0.961 * tAvgR * leMi * zAvg)) ** 0.51 * idIn ** 2.53;
  return { qScfd: q };
};

/**
 * General Flow equation with an explicit Darcy friction factor:
 * Q = 77.54 (Tb/Pb) [(p1^2-p2^2)/(G T L Z f)]^0.5 d^2.5. The friction
 * factor comes from Colebrook at the gas Reynolds number, which itself
 * depends on Q, so the pair is iterated to a fixed point.
 */
export const generalFlowQ = ({
  p1Psia, p2Psia, idIn, lengthMi, sg, tAvgR, zAvg = 0.9,
  muCp = 0.011, roughnessIn = 0.0007, efficiency = 1, elevChangeFt = 0,
  tbR = BASE_CONDITIONS.tbR, pbPsia = BASE_CONDITIONS.pbPsia,
}) => {
  const { driving, leMi } = gasCommon({ p1Psia, p2Psia, sg, tAvgR, zAvg, lengthMi, elevChangeFt });
  if (driving <= 0) return { error: 'no flow: outlet pressure meets or exceeds inlet head' };
  let f = 0.015;
  let q = 0;
  for (let i = 0; i < 50; i += 1) {
    q = 77.54 * efficiency * (tbR / pbPsia)
      * Math.sqrt(driving / (sg * tAvgR * leMi * zAvg * f)) * idIn ** 2.5;
    // Gas-line Reynolds number, GPSA form: Re = 0.0201 Q G / (d mu)
    // (Q scfd at 14.65/520, d inches, mu cp).
    const re = (0.0201 * q * sg) / (idIn * muCp);
    const next = frictionFactor({ re, relRough: roughnessIn / idIn }).f;
    if (Math.abs(next - f) < 1e-12) { f = next; break; }
    f = next;
  }
  return { qScfd: q, fDarcy: f };
};

/**
 * Outlet pressure for a target rate under any of the forms above,
 * solved by bisection on p2 (the closed inversions differ per form and
 * per elevation term; one solver that calls the published form is one
 * fewer place to transcribe an exponent wrongly).
 */
export const gasOutletPressure = ({ equation = 'weymouth', qScfd, ...rest }) => {
  const forms = {
    weymouth: weymouthQ, panhandleA: panhandleAQ, panhandleB: panhandleBQ, general: generalFlowQ,
  };
  const form = forms[equation];
  if (!form) return { error: `unknown gas flow equation '${equation}'` };
  if (!(qScfd > 0)) return { error: 'outlet-pressure solve needs a positive rate' };
  const atP2 = (p2) => {
    const r = form({ ...rest, p2Psia: p2 });
    return r.error ? NaN : r.qScfd - qScfd;
  };
  let lo = 14.7; let hi = rest.p1Psia;
  const fLo = atP2(lo);
  if (!(fLo > 0)) {
    return { error: 'the line cannot carry the target rate even to atmospheric outlet' };
  }
  for (let i = 0; i < 100; i += 1) {
    const mid = (lo + hi) / 2;
    const fm = atP2(mid);
    if (Number.isNaN(fm) || fm > 0) lo = mid; else hi = mid;
  }
  const p2Psia = (lo + hi) / 2;
  return { p2Psia, dpPsi: rest.p1Psia - p2Psia };
};

/* ------------------------------------------------------------------ *
 * Wall thickness -- Barlow with the B31.4 / B31.8 design factors.
 * ------------------------------------------------------------------ */

/** B31.8 location-class design factors; B31.4 uses a flat 0.72. */
export const B318_DESIGN_FACTORS = [
  { locationClass: 1, f: 0.72 },
  { locationClass: 2, f: 0.60 },
  { locationClass: 3, f: 0.50 },
  { locationClass: 4, f: 0.40 },
];

/**
 * Required wall by Barlow: t = P D / (2 S F E T) + corrosion allowance.
 * `code` picks the design factor family; for B31.8 the location class
 * must be stated, because assuming Class 1 near a school is exactly
 * the mistake the classes exist to prevent.
 */
export const requiredWallIn = ({
  designPsig, odIn, smysPsi, code = 'B31.4', locationClass = 1,
  jointFactor = 1, tempDerate = 1, corrosionAllowanceIn = 0,
}) => {
  if (!(designPsig > 0) || !(odIn > 0) || !(smysPsi > 0)) {
    return { error: 'wall thickness needs positive design pressure, OD and SMYS' };
  }
  let f;
  if (code === 'B31.4') {
    f = 0.72;
  } else if (code === 'B31.8') {
    const row = B318_DESIGN_FACTORS.find((r) => r.locationClass === locationClass);
    if (!row) return { error: `B31.8 has no location class ${locationClass}` };
    f = row.f;
  } else {
    return { error: `unknown design code '${code}'` };
  }
  const tPressureIn = (designPsig * odIn) / (2 * smysPsi * f * jointFactor * tempDerate);
  return {
    designFactor: f,
    tPressureIn,
    tRequiredIn: tPressureIn + corrosionAllowanceIn,
  };
};

/** MAOP of a stated wall, the same Barlow read the other way. */
export const maopPsig = ({
  wallIn, odIn, smysPsi, code = 'B31.4', locationClass = 1,
  jointFactor = 1, tempDerate = 1, corrosionAllowanceIn = 0,
}) => {
  const net = wallIn - corrosionAllowanceIn;
  if (!(net > 0)) return { error: 'no pressure-bearing wall left after corrosion allowance' };
  const req = requiredWallIn({
    designPsig: 1, odIn, smysPsi, code, locationClass, jointFactor, tempDerate,
  });
  if (req.error) return req;
  return { maopPsig: net / req.tPressureIn, designFactor: req.designFactor };
};

/* ------------------------------------------------------------------ *
 * Pigging estimates
 * ------------------------------------------------------------------ */

/** Line volume in barrels. */
export const lineVolumeBbl = ({ idIn, lengthFt }) => {
  if (!(idIn > 0) || !(lengthFt > 0)) return NaN;
  return ((Math.PI * idIn * idIn) / (4 * 144)) * lengthFt / CUFT_PER_BBL;
};

/**
 * Liquid a sphere sweeps ahead of itself: the line volume times the
 * liquid holdup it runs through. The holdup is an INPUT here -- for a
 * multiphase line it comes from the Suite's Beggs & Brill holdup, for
 * a wet-gas line from a measured or assumed loading -- because a
 * pigging estimate is only as honest as the holdup it is fed.
 */
export const sweptLiquidBbl = ({ idIn, lengthFt, holdupFrac }) => {
  if (!(holdupFrac >= 0) || holdupFrac > 1) return { error: 'holdup must be between 0 and 1' };
  return { sweptBbl: lineVolumeBbl({ idIn, lengthFt }) * holdupFrac };
};

/** Run duration at a stated pig speed. */
export const pigRun = ({ lengthFt, pigSpeedFtS }) => {
  if (!(pigSpeedFtS > 0) || !(lengthFt > 0)) {
    return { error: 'a pig run needs a positive length and speed' };
  }
  const seconds = lengthFt / pigSpeedFtS;
  return { runHours: seconds / 3600, pigSpeedFtS };
};

/**
 * Days between runs that keeps the arriving slug inside the catcher:
 * the liquid accumulating between pigs is the dropout rate times the
 * interval, and the slug a receiver sees is that accumulation plus
 * whatever the sweep itself gathers.
 */
export const piggingInterval = ({ maxSlugBbl, dropoutBpd, sweptBbl = 0 }) => {
  if (!(maxSlugBbl > 0) || !(dropoutBpd > 0)) {
    return { error: 'an interval needs a positive slug limit and dropout rate' };
  }
  const roomBbl = maxSlugBbl - sweptBbl;
  if (roomBbl <= 0) {
    return { error: 'the sweep alone already exceeds the slug limit: pig more often or resize the catcher' };
  }
  return { intervalDays: roomBbl / dropoutBpd };
};
