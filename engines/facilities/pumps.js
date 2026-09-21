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
 *
 * EVERY REFUSAL IS A NAMED REFUSAL. A function that cannot read its
 * inputs returns { error } and never a NaN, an Infinity or a plausible
 * number, because a caller's `if (result.error)` guard is the only
 * check most callers make and a non-finite value slipped past it is
 * worse than no guard at all. The FC3-0 wave found eleven inputs in
 * this module that returned a number they should not have, and the
 * shape was always the same: the guarded half of the input set was
 * guarded properly, which is exactly what made the gaps invisible.
 * `pumpPower` validated flow, head, gravity and pump efficiency and
 * then divided by an unvalidated motor efficiency; `npshAvailable`
 * validated gravity, suction and vapour pressure and then added two
 * unvalidated head terms.
 *
 * THE ONE EXCEPTION is the pair of bare-number converters
 * `headFtToPsi` and `psiToHeadFt`, which have no object to put an
 * error in and return NaN by DOCUMENTED CONTRACT. Giving them an
 * object return is a signature change across two shipped studios and
 * a graded course field, so the contract is stated instead: they
 * return NaN, never Infinity and never a plausible number, and a
 * caller that needs a message checks the value with Number.isFinite.
 */

import { KW_PER_HP } from '../../lib/units/fieldUnits.js';

/** Binary floating point does not land on a decimal boundary. A trim
 *  ratio of 0.95 is meant to be exactly five percent, and
 *  (1 - 0.95) * 100 is 5.000000000000004, so `trimPct <= 5` was false
 *  at the very ratio the rule says carries no shortfall and a
 *  shortfall of 2.66e-15 appeared. Both of this module's percentage
 *  boundaries are compared with this slack, which is far below any
 *  trim anyone can machine and far above the representation error.
 *  This is FC1's floor-comparison finding in a second module. */
const PCT_SLACK = 1e-9;

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
  // Omitted, this returned a healthy-looking object whose kFt was
  // right and whose headAt() was NaN at every flow, so the failure
  // only appeared when the curve was called. A static head may be
  // negative (the destination sits below the pump); it may not be
  // absent.
  if (!Number.isFinite(staticHeadFt)) {
    return { error: 'a system curve needs a static head: it may be negative, but it cannot be missing' };
  }
  const kFt = frictionHeadFt / (atFlowGpm * atFlowGpm);
  return {
    kFt,
    headAt: (qGpm) => staticHeadFt + kFt * qGpm * qGpm,
    staticHeadFt,
  };
};

/** 1-norm condition number of a 3x3, by the exact cofactor inverse.
 *  Infinity on a singular matrix, which is a report and not a throw. */
const cond1 = (M) => {
  const norm1 = (X) => Math.max(...[0, 1, 2].map(
    (c) => Math.abs(X[0][c]) + Math.abs(X[1][c]) + Math.abs(X[2][c]),
  ));
  const cof = (r, c) => {
    const [r1, r2] = [0, 1, 2].filter((i) => i !== r);
    const [c1, c2] = [0, 1, 2].filter((i) => i !== c);
    return ((r + c) % 2 ? -1 : 1) * (M[r1][c1] * M[r2][c2] - M[r1][c2] * M[r2][c1]);
  };
  const det = M[0][0] * cof(0, 0) + M[0][1] * cof(0, 1) + M[0][2] * cof(0, 2);
  if (!Number.isFinite(det) || det === 0) return Infinity;
  // inverse is the TRANSPOSED cofactor matrix over the determinant
  const inv = [0, 1, 2].map((r) => [0, 1, 2].map((c) => cof(c, r) / det));
  return norm1(M) * norm1(inv);
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
  // Kept before elimination destroys it, because the conditioning of
  // THIS matrix is what the coefficients are bought at and nothing
  // reported it. The normal equations square the condition number of
  // the design matrix, which is the price of solving a least-squares
  // problem this way; scaling the flow keeps that price small, and
  // `conditionNumber` is the measurement rather than the assurance.
  const normal = A.map((row) => row.slice());
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
  const conditionNumber = cond1(normal);
  // residual, so a bad fit is visible rather than silent
  let sse = 0; let sst = 0;
  const meanY = t0 / n;
  for (const p of points) {
    sse += (p.headFt - headAt(p.qGpm)) ** 2;
    sst += (p.headFt - meanY) ** 2;
  }
  // A drooping head curve is the defining shape of a centrifugal
  // machine, and `droops` is the machine-readable form of the warning
  // below so that `dutyPoint` can refuse a crossing on a curve this
  // function has already disowned. It travels through combineParallel
  // and combineSeries for the same reason.
  const droops = c2 < 0;
  return {
    coefficients: { c0, c1, c2, scale },
    headAt,
    // R squared is the share of the variance the fit explains. With
    // three identical heads there is no variance to explain, sst is
    // zero and the quantity is undefined: returning 1 reported a
    // horizontal line that explains nothing as a perfect fit, beside a
    // droop warning saying the opposite. Undefined is null, not 1.
    rSquared: sst > 0 ? 1 - sse / sst : null,
    shutoffHeadFt: headAt(0),
    droops,
    // The solve, reported. Nothing in this module used to carry a flag
    // on its own numerics: `rSquared` measures how well the fitted
    // curve describes the points and says nothing about whether the
    // linear system behind it was solvable. On the swept catalogue
    // sets this lands between 3e2 and 7e2, which is a comfortable
    // solve in double precision; a degenerate set is refused above at
    // the pivot, and this is the continuous warning between the two.
    conditionNumber,
    conditioningNote: conditionNumber > 1e10
      ? `the normal-equation matrix has a 1-norm condition number of ${conditionNumber.toExponential(3)}: the fitted coefficients carry correspondingly few significant figures, so spread the catalogue flows further apart`
      : null,
    warning: droops
      ? null
      : 'the fitted curve does not fall with flow: check the points, because a centrifugal head curve must droop',
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
 *
 * A curve that does not droop is NOT such an answer. `fitPumpCurve`
 * warns that a rising point set is not a centrifugal head curve, and
 * this function used to return a duty flow and a duty head off it
 * anyway: on one rising set the studio printed 833.333 gpm at 216.667
 * ft as its two headline figures with the warning rendered beneath
 * them as a note. Two halves of one module disagreed about the same
 * curve and the trusting half was the bug.
 */
export const dutyPoint = ({ pump, system, qMaxGpm }) => {
  if (!pump?.headAt || !system?.headAt) return { error: 'both a pump curve and a system curve are needed' };
  if (pump.droops === false) {
    return {
      error: 'this curve does not fall with flow, so it is not a centrifugal head curve and its crossing with a system curve is not a duty point: check the catalogue points',
    };
  }
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
  let iterations = 0;
  // It ran a fixed 200 bisections and returned the midpoint WHATEVER HAD
  // HAPPENED, with no flag on the solve at all. The loop is unchanged in
  // what it computes: it breaks on a bracket that can no longer be halved
  // in double precision, which is exactly where 200 blind halvings
  // silently arrived, so THE ANSWER IS BIT FOR BIT THE ONE THIS FUNCTION
  // ALWAYS GAVE and no golden moves for it. What is new is that the state
  // it stopped in is reported instead of discarded.
  for (; iterations < 200; iterations += 1) {
    const mid = (lo + high) / 2;
    if (mid === lo || mid === high) break;
    if (diff(mid) > 0) lo = mid; else high = mid;
  }
  const qGpm = (lo + high) / 2;
  const bracketGpm = high - lo;
  const residualFt = diff(qGpm);
  const headFt = pump.headAt(qGpm);
  // Converged when the bracket is at the resolution of the numbers
  // themselves AND the head difference there is really zero. The second
  // half is the one that can fail: on a bracketed sign change bisection
  // always collapses, so a flag made only of the bracket width could
  // never be false and would be another check that validates nothing.
  // A curve that returns a non-finite head somewhere inside the bracket
  // sends the comparison `diff(mid) > 0` false at every step, and the
  // loop then marches quietly to the bottom of the range and returns a
  // flow with no crossing under it. That is what this catches.
  const headScale = Math.max(Math.abs(headFt), Math.abs(pump.headAt(0)), 1);
  const converged = bracketGpm <= 8 * Number.EPSILON * Math.max(qGpm, hi * 1e-12)
    && Number.isFinite(residualFt)
    && Math.abs(residualFt) <= 1e-9 * headScale;
  return {
    qGpm,
    headFt,
    systemHeadFt: system.headAt(qGpm),
    // The evidence the solve leaves behind: the width of the bracket it
    // finished on, the head difference at the answer it returned, and
    // how many halvings it took to get there.
    bracketGpm,
    residualFt,
    iterations,
    converged,
    warning: converged ? null
      : `the duty-point bisection finished on a bracket of ${bracketGpm} gpm with a head difference of ${residualFt} ft between the pump and the system: the crossing is not resolved and this flow should not be sized on`,
  };
};

/* ------------------------------------------------------------------ *
 * Power
 * ------------------------------------------------------------------ */

/**
 * Specific gravity to the field head-to-pressure conversion.
 *
 * BARE-NUMBER CONTRACT, see the module header: these two return NaN
 * and never Infinity when they cannot read their inputs. A gravity of
 * zero used to give Infinity out of psiToHeadFt, which is a
 * non-answer that arithmetic downstream carries silently.
 */
export const headFtToPsi = ({ headFt, sg }) => (
  Number.isFinite(headFt) && sg > 0 ? (headFt * sg) / 2.31 : NaN
);
export const psiToHeadFt = ({ psi, sg }) => (
  Number.isFinite(psi) && sg > 0 ? (psi * 2.31) / sg : NaN
);

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
  // The pump efficiency was bounded and the motor efficiency was not,
  // one line apart. At 5 the return was a motor drawing a fifth of
  // what its shaft delivers; at -0.5 it drew a negative 184 kW; at 0
  // it drew Infinity with no error key.
  if (!(motorEfficiency > 0) || motorEfficiency > 1) {
    return { error: 'motor efficiency must be greater than 0 and at most 1' };
  }
  const whp = (qGpm * headFt * sg) / 3960;
  const bhp = whp / efficiency;
  return {
    hydraulicHp: whp,
    brakeHp: bhp,
    motorInputHp: bhp / motorEfficiency,
    motorInputKw: (bhp / motorEfficiency) * KW_PER_HP,
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
 * cavitation decisions are actually made and the customary rule is a
 * MARGIN of the larger of 3 ft and 35 percent of NPSHr (equivalently
 * NPSHa >= 1.35 NPSHr once 0.35 NPSHr is the binding half). The header
 * used to state that as "the larger of 3 ft and 1.35 times NPSHr",
 * which describes a ratio rule as if it were a margin rule and would
 * have a reader demanding nearly four times the margin the code
 * applies. The code was right all along.
 */
export const npshAvailable = ({
  suctionPressurePsia, vapourPressurePsia, sg,
  staticSuctionLiftFt = 0, suctionFrictionFt = 0,
}) => {
  if (!(sg > 0)) return { error: 'NPSH needs a positive specific gravity' };
  if (!(suctionPressurePsia > 0) || !(vapourPressurePsia >= 0)) {
    return { error: 'NPSH needs a suction pressure and a vapour pressure' };
  }
  // Three validated inputs and then two head terms added unchecked.
  // Either one non-finite made npshaFt NaN while pressureHeadFt stayed
  // correct, so the object looked half right and carried no error.
  // Both may be negative; neither may be unreadable.
  if (!Number.isFinite(staticSuctionLiftFt) || !Number.isFinite(suctionFrictionFt)) {
    return { error: 'the static suction head and the suction friction must both be numbers: they may be negative, but they cannot be missing' };
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
  // A verdict returned for an input it could not read. With npshaFt
  // absent or NaN, neither `marginFt < 0` nor `marginFt <
  // requiredMarginFt` is true, so the severity ternary fell to its
  // last branch and the return read `pass: false, severity:
  // 'adequate'` in one object. With Infinity it read `pass: true,
  // severity: 'adequate'`. An available head is the whole input to
  // this check and it is not optional.
  if (!Number.isFinite(npshaFt)) {
    return { error: 'the margin check needs a finite available NPSH: there is no verdict to give on a suction head that cannot be read' };
  }
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

/** The band over which a speed change is reported without comment.
 *  THIS IS A SANITY BOUND AND NOT A PUBLISHED CORRELATION LIMIT: no
 *  publication in this repository states where the affinity laws stop
 *  holding for a real machine, and a factor of two either way is far
 *  beyond any drive turndown rather than a claim about where the
 *  error becomes material. It is warned on and never used to refuse,
 *  and nothing computed from it decides a value. */
const SPEED_RATIO_MIN = 0.5;
const SPEED_RATIO_MAX = 1.5;

/**
 * Speed change follows the affinity laws exactly for a geometrically
 * similar machine: Q ~ N, H ~ N^2, P ~ N^3.
 *
 * Exactly, but only over a modest change of speed. At a ratio of 100
 * this returned 100,000 gpm, 3,000,000 ft and 100,000,000 brake hp
 * with nothing to say it had left the ground, and the cube on power
 * means the error grows fastest on the number that buys the motor.
 * The laws are still applied as stated, because they are the laws;
 * the extrapolation is now named.
 */
export const speedChange = ({ qGpm, headFt, brakeHp, speedRatio }) => {
  if (!(speedRatio > 0)) return { error: 'the speed ratio must be positive' };
  if (!Number.isFinite(qGpm) || !Number.isFinite(headFt) || !Number.isFinite(brakeHp)) {
    return { error: 'a speed change needs a duty to change: give the flow, the head and the brake power at the present speed' };
  }
  return {
    qGpm: qGpm * speedRatio,
    headFt: headFt * speedRatio ** 2,
    brakeHp: brakeHp * speedRatio ** 3,
    warning: (speedRatio < SPEED_RATIO_MIN || speedRatio > SPEED_RATIO_MAX)
      ? `a speed ratio of ${speedRatio} is far outside the range over which the affinity laws describe a real machine: the power leg goes as the cube, so this is an extrapolation on the number that sizes the driver`
      : null,
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
 *
 * THE POWER LEG IS THE IDEAL CUBE while the head and flow legs are
 * both de-rated, so the return implies an efficiency change. That may
 * well be the intended physics and the shortfall model has no
 * publication behind it in this repository, so de-rating the power leg
 * here would be inventing a second unsourced model on top of the
 * first. The implied ratio is COMPUTED AND RETURNED instead, because
 * the defect was that a reader who divided the returned power into the
 * returned head and flow got a number the module never mentioned.
 */
export const impellerTrim = ({ qGpm, headFt, brakeHp, diameterRatio }) => {
  if (!(diameterRatio > 0) || diameterRatio > 1) {
    return { error: 'a trim ratio must be between 0 and 1 (you cannot trim an impeller larger)' };
  }
  if (!Number.isFinite(qGpm) || !Number.isFinite(headFt) || !Number.isFinite(brakeHp)) {
    return { error: 'a trim needs a duty to trim: give the flow, the head and the brake power at the full diameter' };
  }
  // The trim warning fires above 20 percent and names 20 percent in the
  // same sentence, so the trim it prints carries a decimal: at whole
  // percent a 20.25 percent trim read "a 20 percent trim ... the vendor
  // limit usually sits near 20 percent". One decimal narrows the
  // collision to 0.05 points rather than closing it. Gated in
  // __tests__/facilities.pumps.test.js.
  const idealQ = qGpm * diameterRatio;
  const idealH = headFt * diameterRatio ** 2;
  // published shortfall: real trims under-deliver as the cut deepens.
  // Both percentage comparisons carry PCT_SLACK, so the rule's own
  // boundaries fall where the rule says rather than where binary
  // floating point puts them.
  const trimPct = (1 - diameterRatio) * 100;
  const shortfall = trimPct <= 5 + PCT_SLACK ? 0 : Math.min(0.12, (trimPct - 5) * 0.006);
  return {
    trimPercent: trimPct,
    idealQGpm: idealQ,
    idealHeadFt: idealH,
    qGpm: idealQ * (1 - shortfall * 0.5),
    headFt: idealH * (1 - shortfall),
    brakeHp: brakeHp * diameterRatio ** 3,
    shortfallPct: shortfall * 100,
    // The hydraulic product Q x H against the ideal cube on power. At
    // a 25 percent trim this is 0.8272, so the return implies a 17.28
    // percent efficiency loss; stated here rather than left to be
    // discovered by division.
    impliedEfficiencyRatio: (1 - shortfall * 0.5) * (1 - shortfall),
    warning: trimPct > 20 + PCT_SLACK
      ? `a ${trimPct.toFixed(1)} percent trim is beyond what most casings tolerate: efficiency falls away and the vendor limit usually sits near 20 percent`
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
 *
 * B IS REPORTED ON EVERY BRANCH and the corrected values are always
 * present. The water branch used to return B: 0, which is a sentinel
 * dressed as a value: the correlating parameter at 1 cSt is a real
 * positive number (0.3168 on the swept case) and the engine said zero,
 * so a millionth of a centistoke higher moved the reported B from
 * 0.0000 to 0.4257. The two no-correction branches also omitted
 * correctedQGpm and correctedHeadFt entirely, so a caller reading them
 * got undefined on exactly the cases where the answer is "the
 * catalogue values, unchanged".
 */
export const viscosityCorrection = ({
  qBepGpm, headBepFt, viscosityCSt, speedRpm = 3560,
}) => {
  if (!(qBepGpm > 0) || !(headBepFt > 0) || !(viscosityCSt > 0)) {
    return { error: 'the viscosity correction needs a BEP flow, head and a kinematic viscosity' };
  }
  // A speed of zero made B Infinity and every factor zero; a negative
  // speed made every field NaN and did not even warn.
  if (!(speedRpm > 0)) {
    return { error: 'the viscosity correction needs a positive pump speed in rpm' };
  }
  // HI 9.6.7 parameter
  const B = 26.6 * (Math.sqrt(viscosityCSt) * headBepFt ** 0.0625)
    / (qBepGpm ** 0.375 * speedRpm ** 0.25);
  const uncorrected = (note) => ({
    B,
    cQ: 1,
    cH: 1,
    cEta: 1,
    correctedQGpm: qBepGpm,
    correctedHeadFt: headBepFt,
    note,
    warning: null,
  });
  if (viscosityCSt <= 1) return uncorrected('at water viscosity there is nothing to correct');
  if (B <= 1) return uncorrected('B at or below 1: no correction applies');
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
    note: null,
    // One decimal on the efficiency correction for the same reason as
    // the trim warning above: at whole percent a correction of 59.75
    // read "60 percent" under a flag that only fires below 60.
    warning: B > 40
      ? 'B above 40 is outside the published correlation, so a corrected centrifugal curve cannot be used here: this service needs a positive-displacement pump or vendor viscous test data'
      : (cEta < 0.6
        ? `the efficiency correction is ${(cEta * 100).toFixed(1)} percent: a centrifugal pump is a poor choice for a fluid this viscous`
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
 *
 * The count is a number of MACHINES. The guard used to be `n >= 1`
 * with no integer check, so two and a half pumps in parallel returned
 * a curve and read 504.287 ft at 1000 gpm: an answer to a question
 * that has none.
 */
const machineCount = (n) => Number.isInteger(n) && n >= 1;

export const combineParallel = ({ pump, n }) => {
  if (!pump?.headAt || !machineCount(n)) {
    return { error: 'parallel operation needs a pump curve and a whole number of machines, at least one' };
  }
  return { headAt: (qGpm) => pump.headAt(qGpm / n), n, mode: 'parallel', droops: pump.droops };
};

export const combineSeries = ({ pump, n }) => {
  if (!pump?.headAt || !machineCount(n)) {
    return { error: 'series operation needs a pump curve and a whole number of machines, at least one' };
  }
  return { headAt: (qGpm) => n * pump.headAt(qGpm), n, mode: 'series', droops: pump.droops };
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
    note = 'above 120 percent of best efficiency flow: the required NPSH climbs steeply with flow here, and this module carries NPSHr as a single number rather than a curve, so the vendor curve has to be read at THIS flow before the suction margin means anything';
  } else if (pct < 50) {
    region = 'outside';
    note = 'far below best efficiency flow: this pump is being throttled hard, which wastes power and damages the machine. A smaller pump, a trim or a variable speed drive is the answer';
  } else {
    region = 'outside';
    note = 'far above best efficiency flow: the pump will run out of NPSH and may cavitate, and the driver may overload';
  }
  return { percentOfBep: pct, region, note, preferred: region === 'preferred' };
};
