/**
 * Centrifugal pump hydraulics and station design (Facilities F10).
 *
 * The other half of the F0-retired Compressor & Pump Pack, which
 * printed "Head: 450 ft" and "NPSHa: 12 ft" as literal strings.
 *
 * The organising idea is that a pump does not have an operating point
 * until it is connected to something. The system curve and the pump
 * curve are separate objects here, and the duty point is SOLVED as
 * their intersection rather than assumed, which is what makes the
 * knock-on questions answerable: what a trim does, what a speed change
 * does, what happens when two run in parallel, and whether the suction
 * still has margin when the flow rises.
 *
 * Also carried, because they are where pump selections actually fail:
 *  - NPSH available computed from the real suction side, and compared
 *    against required with the customary margin
 *  - the Hydraulic Institute viscosity corrections, which move a duty
 *    point a long way on anything heavier than light crude
 *  - preferred and allowable operating regions relative to best
 *    efficiency, because a pump run far off BEP does not last
 *
 * Units: field (gpm, ft of head, psi, cp, hp).
 */

/* ------------------------------------------------------------------ *
 * Curves
 * ------------------------------------------------------------------ */

/**
 * System curve: static lift plus friction that goes as the square of
 * flow. Expressed through a reference point so the caller can state
 * it the way a hydraulics calculation hands it over (a friction head
 * at a known flow) rather than as an abstract coefficient.
 */
export const systemCurve = ({ staticHeadFt, frictionHeadFt, atFlowGpm }) => {
  if (!(atFlowGpm > 0) || !(frictionHeadFt >= 0)) {
    return { error: 'a system curve needs a friction head at a stated positive flow' };
  }
  const kFt = frictionHeadFt / (atFlowGpm * atFlowGpm);
  return {
    kFt,
    headAt: (qGpm) => staticHeadFt + kFt * qGpm * qGpm,
    staticHeadFt,
  };
};

/**
 * Fit a pump curve to catalogue points. A quadratic in flow is the
 * customary description of a centrifugal head curve and is what a
 * three-point catalogue reading supports; anything higher order
 * would be inventing detail the data does not carry.
 *
 * Solved by normal equations on the Vandermonde system, with the flow
 * scaled to keep it well conditioned.
 */
export const fitPumpCurve = ({ points }) => {
  if (!Array.isArray(points) || points.length < 3) {
    return { error: 'a pump curve needs at least three flow and head points' };
  }
  const qs = points.map((p) => p.qGpm);
  const scale = Math.max(...qs) || 1;
  const n = points.length;
  // basis 1, x, x^2 with x = q/scale
  let s0 = 0; let s1 = 0; let s2 = 0; let s3 = 0; let s4 = 0;
  let t0 = 0; let t1 = 0; let t2 = 0;
  for (const p of points) {
    if (!(p.qGpm >= 0) || !(p.headFt >= 0)) return { error: 'pump curve points need non-negative flow and head' };
    const x = p.qGpm / scale;
    const y = p.headFt;
    s0 += 1; s1 += x; s2 += x * x; s3 += x ** 3; s4 += x ** 4;
    t0 += y; t1 += x * y; t2 += x * x * y;
  }
  // 3x3 solve
  const A = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]];
  const b = [t0, t1, t2];
  for (let c = 0; c < 3; c += 1) {
    let piv = c;
    for (let r = c + 1; r < 3; r += 1) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    if (Math.abs(A[c][c]) < 1e-14) return { error: 'the pump curve points are degenerate: give three distinct flows' };
    for (let r = c + 1; r < 3; r += 1) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 3; k += 1) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r -= 1) {
    let acc = b[r];
    for (let k = r + 1; k < 3; k += 1) acc -= A[r][k] * x[k];
    x[r] = acc / A[r][r];
  }
  const [c0, c1, c2] = x;
  const headAt = (qGpm) => c0 + c1 * (qGpm / scale) + c2 * (qGpm / scale) ** 2;
  // residual, so a bad fit is visible rather than silent
  let sse = 0; let sst = 0;
  const meanY = t0 / n;
  for (const p of points) {
    sse += (p.headFt - headAt(p.qGpm)) ** 2;
    sst += (p.headFt - meanY) ** 2;
  }
  return {
    coefficients: { c0, c1, c2, scale },
    headAt,
    rSquared: sst > 0 ? 1 - sse / sst : 1,
    shutoffHeadFt: headAt(0),
    warning: c2 >= 0
      ? 'the fitted curve does not fall with flow: check the points, because a centrifugal head curve must droop'
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * The duty point
 * ------------------------------------------------------------------ */

/**
 * Where the pump and the system meet. Solved by bisection on the head
 * difference, which needs no derivative and cannot run away.
 *
 * A pump with no intersection is a real answer, not an error to hide:
 * it means the system needs more head than the pump makes at any
 * flow, and the studio says exactly that.
 */
export const dutyPoint = ({ pump, system, qMaxGpm }) => {
  if (!pump?.headAt || !system?.headAt) return { error: 'both a pump curve and a system curve are needed' };
  const hi = qMaxGpm > 0 ? qMaxGpm : 1e5;
  const diff = (q) => pump.headAt(q) - system.headAt(q);
  if (diff(0) <= 0) {
    return {
      error: 'the system needs more head at zero flow than the pump makes at shutoff: this pump cannot start this system',
      shutoffHeadFt: pump.headAt(0),
      systemStaticHeadFt: system.headAt(0),
    };
  }
  if (diff(hi) > 0) {
    return { error: `the curves do not cross below ${hi} gpm: raise the search limit or check the system curve` };
  }
  let lo = 0; let high = hi;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + high) / 2;
    if (diff(mid) > 0) lo = mid; else high = mid;
  }
  const qGpm = (lo + high) / 2;
  return { qGpm, headFt: pump.headAt(qGpm) };
};

/* ------------------------------------------------------------------ *
 * Power
 * ------------------------------------------------------------------ */

/** Specific gravity to the field head-to-pressure conversion. */
export const headFtToPsi = ({ headFt, sg }) => (headFt * sg) / 2.31;
export const psiToHeadFt = ({ psi, sg }) => (psi * 2.31) / sg;

/**
 * Hydraulic and brake horsepower:
 *   whp = Q(gpm) * H(ft) * SG / 3960
 * 3960 is the field packaging of (8.34 lb/gal) / (33000 ft.lbf/min/hp).
 */
export const pumpPower = ({ qGpm, headFt, sg, efficiency, motorEfficiency = 0.94 }) => {
  if (!(qGpm > 0) || !(headFt > 0) || !(sg > 0)) {
    return { error: 'power needs a positive flow, head and specific gravity' };
  }
  if (!(efficiency > 0) || efficiency > 1) return { error: 'pump efficiency must be between 0 and 1' };
  const whp = (qGpm * headFt * sg) / 3960;
  const bhp = whp / efficiency;
  return {
    hydraulicHp: whp,
    brakeHp: bhp,
    motorInputHp: bhp / motorEfficiency,
    motorInputKw: (bhp / motorEfficiency) * 0.7457,
  };
};

/* ------------------------------------------------------------------ *
 * NPSH
 * ------------------------------------------------------------------ */

/**
 * NPSH available, from the real suction side rather than a number
 * typed into a box:
 *   NPSHa = (Pa - Pv) * 2.31 / SG + static suction head - suction friction
 * Reported with the margin over NPSHr, because that margin is where
 * cavitation decisions are actually made and the customary rule is
 * the larger of 3 ft and 1.35 times NPSHr.
 */
export const npshAvailable = ({
  suctionPressurePsia, vapourPressurePsia, sg,
  staticSuctionLiftFt = 0, suctionFrictionFt = 0,
}) => {
  if (!(sg > 0)) return { error: 'NPSH needs a positive specific gravity' };
  if (!(suctionPressurePsia > 0) || !(vapourPressurePsia >= 0)) {
    return { error: 'NPSH needs a suction pressure and a vapour pressure' };
  }
  const pressureHeadFt = ((suctionPressurePsia - vapourPressurePsia) * 2.31) / sg;
  const npshaFt = pressureHeadFt + staticSuctionLiftFt - suctionFrictionFt;
  return {
    pressureHeadFt,
    npshaFt,
    warning: suctionPressurePsia <= vapourPressurePsia
      ? 'the suction pressure is at or below the vapour pressure: the liquid is already flashing before it reaches the pump'
      : null,
  };
};

export const npshCheck = ({ npshaFt, npshrFt }) => {
  if (!(npshrFt > 0)) return { error: 'a required NPSH is needed for the check' };
  const requiredMarginFt = Math.max(3, 0.35 * npshrFt);
  const marginFt = npshaFt - npshrFt;
  return {
    marginFt,
    requiredMarginFt,
    ratio: npshaFt / npshrFt,
    pass: marginFt >= requiredMarginFt,
    severity: marginFt < 0 ? 'cavitating' : (marginFt < requiredMarginFt ? 'marginal' : 'adequate'),
    note: marginFt < 0
      ? 'NPSH available is below required: this pump will cavitate at this duty'
      : (marginFt < requiredMarginFt
        ? `margin of ${marginFt.toFixed(1)} ft is below the customary ${requiredMarginFt.toFixed(1)} ft: acceptable only with vendor agreement and a stable suction`
        : null),
  };
};

/* ------------------------------------------------------------------ *
 * Affinity laws and trimming
 * ------------------------------------------------------------------ */

/**
 * Speed change follows the affinity laws exactly for a geometrically
 * similar machine: Q ~ N, H ~ N^2, P ~ N^3.
 */
export const speedChange = ({ qGpm, headFt, brakeHp, speedRatio }) => {
  if (!(speedRatio > 0)) return { error: 'the speed ratio must be positive' };
  return {
    qGpm: qGpm * speedRatio,
    headFt: headFt * speedRatio ** 2,
    brakeHp: brakeHp * speedRatio ** 3,
  };
};

/**
 * Impeller trim does NOT follow the affinity laws exactly, and
 * treating it as if it does is a common over-estimate of what a trim
 * buys. The published correction applies the square law to the
 * diameter ratio for head and a linear law for flow only over modest
 * trims, and real machines fall short of even that as the trim grows
 * because the impeller no longer matches its casing.
 *
 * The engine applies the customary correction and states the shortfall
 * rather than quietly using the ideal law.
 */
export const impellerTrim = ({ qGpm, headFt, brakeHp, diameterRatio }) => {
  if (!(diameterRatio > 0) || diameterRatio > 1) {
    return { error: 'a trim ratio must be between 0 and 1 (you cannot trim an impeller larger)' };
  }
  const idealQ = qGpm * diameterRatio;
  const idealH = headFt * diameterRatio ** 2;
  // published shortfall: real trims under-deliver as the cut deepens
  const trimPct = (1 - diameterRatio) * 100;
  const shortfall = trimPct <= 5 ? 0 : Math.min(0.12, (trimPct - 5) * 0.006);
  return {
    trimPercent: trimPct,
    idealQGpm: idealQ,
    idealHeadFt: idealH,
    qGpm: idealQ * (1 - shortfall * 0.5),
    headFt: idealH * (1 - shortfall),
    brakeHp: brakeHp * diameterRatio ** 3,
    shortfallPct: shortfall * 100,
    warning: trimPct > 20
      ? `a ${trimPct.toFixed(0)} percent trim is beyond what most casings tolerate: efficiency falls away and the vendor limit usually sits near 20 percent`
      : null,
  };
};

/* ------------------------------------------------------------------ *
 * Viscosity correction (Hydraulic Institute method)
 * ------------------------------------------------------------------ */

/**
 * The HI viscosity corrections, in the parametric form the standard
 * publishes. B is the correlating parameter; the correction factors
 * for flow, head and efficiency follow from it.
 *
 * This is where a pump selection made on water quietly fails on
 * crude: at a few hundred centistokes the efficiency correction alone
 * is worth tens of percent.
 */
export const viscosityCorrection = ({
  qBepGpm, headBepFt, viscosityCSt, speedRpm = 3560,
}) => {
  if (!(qBepGpm > 0) || !(headBepFt > 0) || !(viscosityCSt > 0)) {
    return { error: 'the viscosity correction needs a BEP flow, head and a kinematic viscosity' };
  }
  if (viscosityCSt <= 1) {
    return {
      B: 0, cQ: 1, cH: 1, cEta: 1,
      note: 'at water viscosity there is nothing to correct',
    };
  }
  // HI 9.6.7 parameter
  const B = 26.6 * (Math.sqrt(viscosityCSt) * headBepFt ** 0.0625)
    / (qBepGpm ** 0.375 * speedRpm ** 0.25);
  if (B <= 1) {
    return { B, cQ: 1, cH: 1, cEta: 1, note: 'B at or below 1: no correction applies' };
  }
  const cQ = Math.exp(-0.165 * Math.log10(B) ** 3.15);
  const cH = cQ; // at BEP the standard takes the head factor equal to the flow factor
  const cEta = B ** (-0.0547 * B ** 0.69);
  return {
    B,
    cQ,
    cH,
    cEta,
    correctedQGpm: qBepGpm * cQ,
    correctedHeadFt: headBepFt * cH,
    warning: B > 40
      ? 'B above 40 is outside the published correlation: this service needs a positive-displacement pump or vendor viscous test data, not a corrected centrifugal curve'
      : (cEta < 0.6
        ? `the efficiency correction is ${(cEta * 100).toFixed(0)} percent: a centrifugal pump is a poor choice for a fluid this viscous`
        : null),
  };
};

/* ------------------------------------------------------------------ *
 * Multiple pumps
 * ------------------------------------------------------------------ */

/**
 * Pumps in parallel add flow at equal head; in series they add head at
 * equal flow. The point people get wrong is that two identical pumps
 * in parallel on a friction-dominated system deliver far less than
 * twice the flow, because the system head rises with the square of
 * it. The engine solves the combined duty rather than doubling.
 */
export const combineParallel = ({ pump, n }) => {
  if (!pump?.headAt || !(n >= 1)) return { error: 'parallel operation needs a pump curve and a count' };
  return { headAt: (qGpm) => pump.headAt(qGpm / n), n, mode: 'parallel' };
};

export const combineSeries = ({ pump, n }) => {
  if (!pump?.headAt || !(n >= 1)) return { error: 'series operation needs a pump curve and a count' };
  return { headAt: (qGpm) => n * pump.headAt(qGpm), n, mode: 'series' };
};

/* ------------------------------------------------------------------ *
 * Operating region
 * ------------------------------------------------------------------ */

/**
 * Where the duty sits relative to best efficiency. The published
 * preferred region is roughly 70 to 120 percent of BEP flow and the
 * allowable region wider; outside them a pump suffers recirculation,
 * high radial loads and short bearing and seal life. This is the
 * check that separates a pump that works from a pump that works for
 * a fortnight.
 */
export const operatingRegion = ({ qGpm, qBepGpm }) => {
  if (!(qBepGpm > 0) || !(qGpm >= 0)) return { error: 'a BEP flow is needed to judge the operating region' };
  const pct = (qGpm / qBepGpm) * 100;
  let region;
  let note = null;
  if (pct >= 70 && pct <= 120) region = 'preferred';
  else if (pct >= 50 && pct < 70) {
    region = 'allowable, low';
    note = 'below 70 percent of best efficiency flow: suction and discharge recirculation begin here, and bearing and seal life shorten';
  } else if (pct > 120 && pct <= 140) {
    region = 'allowable, high';
    note = 'above 120 percent of best efficiency flow: NPSH required climbs steeply here, so check the suction margin again at this duty';
  } else if (pct < 50) {
    region = 'outside';
    note = 'far below best efficiency flow: this pump is being throttled hard, which wastes power and damages the machine. A smaller pump, a trim or a variable speed drive is the answer';
  } else {
    region = 'outside';
    note = 'far above best efficiency flow: the pump will run out of NPSH and may cavitate, and the driver may overload';
  }
  return { percentOfBep: pct, region, note, preferred: region === 'preferred' };
};
