/**
 * Beam pumping unit geometry and torque (Production P6).
 *
 * A conventional (Class I, crank-balanced) unit is a planar four-bar
 * linkage: the crank turns, the pitman pushes the back of the walking
 * beam, and the beam rocks the horsehead that carries the polished
 * rod. Everything this module reports follows from solving that
 * linkage exactly, so nothing here is a chart or a rule of thumb.
 *
 * WHY THE MOTION MATTERS. The predecessor Artificial Lift Designer
 * assumed the polished rod moves as a pure sine wave. It does not: the
 * crank turns at constant speed but the beam does not, so the upstroke
 * and the downstroke take different times and the acceleration is not
 * symmetric. That asymmetry is most of the difference between a real
 * peak torque and a textbook one, and it is why the unit is solved
 * rather than assumed. `simpleHarmonicPosition` is provided so the two
 * can be compared, not so either can be substituted for the other.
 *
 * THE TORQUE FACTOR is the one definition worth stating plainly. By
 * virtual work, a load W at the polished rod produces a crankshaft
 * torque W ds/dtheta, where s is polished rod position and theta is
 * crank angle. So the torque factor IS ds/dtheta, in inches per
 * radian, and it is computed here by differentiating the linkage
 * solution rather than by quoting a formula. The energy identity that
 * follows -- torque integrated over a revolution equals the area of
 * the dynamometer card -- is the gate on it.
 *
 * NO NAMED UNITS. Real beam dimensions are manufacturer data and
 * differ between makers for the same API designation, so this module
 * ships no dimension set under any real name.
 * `genericConventionalGeometry` builds a self-consistent GENERIC
 * linkage that achieves a requested stroke and says so; a real design
 * types the dimensions off the unit's own drawing.
 *
 * Units: all lengths inches, angles radians unless named ...Deg,
 * loads lb, torque in-lb.
 */

/**
 * Geometry of a conventional unit.
 *
 *   aIn   saddle bearing to polished rod (the front arm / horsehead radius)
 *   cIn   saddle bearing to equalizer bearing (the rear arm)
 *   pIn   pitman length
 *   crankBehindIn, crankBelowIn   crankshaft centre relative to the
 *         saddle bearing, read straight off a drawing
 *   rIn   crank radius (the throw that sets the stroke)
 */
export const conventionalGeometry = ({
  aIn, cIn, pIn, crankBehindIn, crankBelowIn, rIn,
}) => ({
  aIn, cIn, pIn, crankBehindIn, crankBelowIn, rIn,
  kind: 'conventional',
});

/**
 * Beam angle at one crank angle, by closing the linkage.
 *
 * The equalizer bearing lies on two circles at once: radius C about
 * the saddle bearing, radius P about the crank pin. Intersecting them
 * is the whole solution. The branch is chosen once and held, because a
 * working four-bar never flips between them; a geometry that fails to
 * close at some crank angle is reported rather than clamped, since it
 * means the dimensions cannot be a real unit.
 */
export const beamAngleAt = (geom, thetaRad, branch = 1) => {
  const { cIn, pIn, crankBehindIn, crankBelowIn, rIn } = geom;
  const ox = -crankBehindIn;
  const oy = -crankBelowIn;
  const px = ox + rIn * Math.cos(thetaRad);
  const py = oy + rIn * Math.sin(thetaRad);
  const d = Math.hypot(px, py);
  if (d > cIn + pIn || d < Math.abs(cIn - pIn) || d === 0) return null;
  const a = (cIn * cIn - pIn * pIn + d * d) / (2 * d);
  const hSq = cIn * cIn - a * a;
  if (hSq < 0) return null;
  const h = Math.sqrt(hSq);
  const mx = (a * px) / d;
  const my = (a * py) / d;
  const ex = mx + branch * h * (-py / d);
  const ey = my + branch * h * (px / d);
  return Math.atan2(ey, ex);
};

/**
 * The full kinematic cycle: polished rod position and torque factor at
 * every crank angle.
 *
 * Position is measured DOWNWARD from the top of the stroke, matching
 * the convention the rod dynamics use. The torque factor is ds/dtheta
 * by five-point central difference on the linkage solution.
 *
 * returns { ok, error, samples: [{ thetaRad, psiRad, positionIn,
 *           torqueFactorIn }], strokeIn, upstrokeFraction }
 */
export const unitKinematics = (geom, { steps = 360, branch = 1 } = {}) => {
  const n = Math.max(72, Math.round(steps));
  const psi = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const theta = (2 * Math.PI * i) / n;
    const value = beamAngleAt(geom, theta, branch);
    if (value === null) {
      return {
        ok: false,
        error: 'The linkage does not close at every crank angle: with these dimensions the pitman cannot reach the beam. Check the crank radius, the pitman length and the crankshaft position.',
      };
    }
    psi[i] = value;
  }
  // Unwrap so the derivative is not corrupted by a branch cut.
  for (let i = 1; i < n; i += 1) {
    while (psi[i] - psi[i - 1] > Math.PI) psi[i] -= 2 * Math.PI;
    while (psi[i] - psi[i - 1] < -Math.PI) psi[i] += 2 * Math.PI;
  }
  const psiMin = Math.min(...psi);
  const psiMax = Math.max(...psi);
  const dTheta = (2 * Math.PI) / n;
  const at = (i) => psi[((i % n) + n) % n];
  const samples = psi.map((value, i) => {
    // Five-point central difference, wrapped: the cycle is periodic.
    const dPsi = (-at(i + 2) + 8 * at(i + 1) - 8 * at(i - 1) + at(i - 2)) / (12 * dTheta);
    return {
      thetaRad: (2 * Math.PI * i) / n,
      psiRad: value,
      // Beam rocks: the rear arm rising drops the horsehead, so the
      // downward polished rod position follows the rear-arm angle.
      positionIn: geom.aIn * (value - psiMin),
      torqueFactorIn: geom.aIn * dPsi,
    };
  });
  const strokeIn = geom.aIn * (psiMax - psiMin);
  // Crank angle at the BOTTOM of the polished rod stroke. Position is
  // measured downward, so the bottom is the maximum. This is the phase
  // reference the counterweights are hung against: anchoring them to
  // the stroke rather than to whichever crank angle happens to be
  // called zero makes the torque equation independent of that
  // convention, and guarantees the counterweight opposes the rod load
  // instead of adding to it.
  let bottomIndex = 0;
  samples.forEach((sm, i) => { if (sm.positionIn > samples[bottomIndex].positionIn) bottomIndex = i; });
  const crankAngleAtBottomRad = samples[bottomIndex].thetaRad;
  // Fraction of the revolution the polished rod spends going up. On a
  // conventional unit this is not a half: the linkage is asymmetric.
  const up = samples.filter((s) => s.torqueFactorIn < 0).length;
  return {
    ok: true,
    samples,
    strokeIn,
    upstrokeFraction: up / n,
    crankAngleAtBottomRad,
    bottomIndex,
    psiMin,
    psiMax,
  };
};

/**
 * Polished rod position as a function of cycle fraction, in FEET and
 * downward-positive, which is what the rod dynamics take. Built by
 * interpolating the kinematic cycle.
 */
export const surfacePositionFn = (kin) => {
  const n = kin.samples.length;
  return (tFrac) => {
    const x = (((tFrac % 1) + 1) % 1) * n;
    const i = Math.floor(x);
    const f = x - i;
    const a = kin.samples[i % n].positionIn;
    const b = kin.samples[(i + 1) % n].positionIn;
    return (a + (b - a) * f) / 12;
  };
};

/** Pure sine motion, for comparison with the real linkage only. */
export const simpleHarmonicPosition = (strokeFt) =>
  (tFrac) => (strokeFt / 2) * (1 - Math.cos(2 * Math.PI * tFrac));

/**
 * Net gearbox torque through the revolution.
 *
 *   T(theta) = TF(theta) [ PRL(theta) - SU ] + M sin(theta - theta_b + tau)
 *
 * The first term is the load the rods put on the crankshaft through
 * the linkage, less the structural unbalance the beam itself carries.
 * The second is the moment of the crank counterweights, which is a
 * sine because the weights turn with the crank; tau is the offset
 * angle on units whose cranks lead or lag.
 *
 * theta_b is the crank angle at the BOTTOM of the polished rod stroke,
 * so the counterweights are at the top of their travel exactly when
 * the rods are at the bottom of theirs. They then fall through the
 * upstroke, which is when the gearbox needs the help, and are lifted
 * again on the downstroke by the rods coming down. Anchoring the phase
 * to the stroke rather than to whichever crank position a maker calls
 * zero is what makes the sign of this term right by construction: an
 * earlier draft used a bare sin(theta) and the counterweights ADDED to
 * the peak torque at every setting, so no balance point existed at all.
 *
 * `cardLoadAt` maps cycle fraction to polished rod load, i.e. the
 * surface dynamometer card from the rod dynamics.
 */
export const netTorque = ({
  kin, cardLoadAt, counterbalanceMomentInLb, structuralUnbalanceLb = 0,
  crankOffsetDeg = 0,
}) => {
  const n = kin.samples.length;
  const tau = (crankOffsetDeg * Math.PI) / 180;
  const ref = kin.crankAngleAtBottomRad;
  return kin.samples.map((s, i) => {
    const prl = cardLoadAt(i / n);
    const rod = s.torqueFactorIn * (prl - structuralUnbalanceLb);
    const cb = counterbalanceMomentInLb * Math.sin(s.thetaRad - ref + tau);
    // Plus, not minus: the counterweight opposes the rod load, and the
    // phase reference above is what fixes that.
    return {
      thetaRad: s.thetaRad,
      torqueFactorIn: s.torqueFactorIn,
      prlLb: prl,
      rodTorqueInLb: rod,
      counterbalanceTorqueInLb: cb,
      netTorqueInLb: rod + cb,
    };
  });
};

/**
 * Counterbalance effect: the polished rod load the counterweights hold
 * up, which is how a counterbalance is quoted and how it is measured
 * in the field.
 *
 * It is read a quarter turn from the bottom of the stroke, where the
 * counterweight moment is at its maximum M. Balancing the rod load
 * there gives TF x CBE = M, so CBE = M / TF at that crank angle. It is
 * NOT M divided by the beam's front arm: the torque factor at the
 * quarter turn is not the arm length, and using the arm understates
 * the effect by roughly a factor of two.
 */
export const counterbalanceEffect = ({ kin, momentInLb, structuralUnbalanceLb = 0 }) => {
  const n = kin.samples.length;
  const quarter = (kin.bottomIndex + Math.round(n / 4)) % n;
  const tf = Math.abs(kin.samples[quarter].torqueFactorIn);
  if (!(tf > 0)) return structuralUnbalanceLb;
  return momentInLb / tf + structuralUnbalanceLb;
};

/**
 * The counterbalance moment that levels the gearbox.
 *
 * A unit is balanced when the largest torque the gearbox sees on the
 * upstroke equals the largest it sees on the downstroke. That is one
 * scalar condition in one unknown, and the peak torque is a continuous
 * piecewise-smooth function of the moment, so it is closed by
 * bisection on the difference between the two peaks.
 *
 * returns { momentInLb, peakTorqueInLb, counterbalanceEffectLb, balanced }
 */
export const balanceUnit = ({
  kin, cardLoadAt, structuralUnbalanceLb = 0, crankOffsetDeg = 0, aIn,
}) => {
  const peaks = (moment) => {
    const t = netTorque({
      kin, cardLoadAt, counterbalanceMomentInLb: moment,
      structuralUnbalanceLb, crankOffsetDeg,
    });
    const upPeak = Math.max(...t.filter((r) => r.torqueFactorIn < 0)
      .map((r) => Math.abs(r.netTorqueInLb)), 0);
    const downPeak = Math.max(...t.filter((r) => r.torqueFactorIn >= 0)
      .map((r) => Math.abs(r.netTorqueInLb)), 0);
    return { upPeak, downPeak, diff: upPeak - downPeak, all: t };
  };
  // With no counterweight the upstroke dominates; with a very large one
  // the downstroke does, so the difference changes sign in between.
  let lo = 0;
  const maxTf = Math.max(...kin.samples.map((s) => Math.abs(s.torqueFactorIn)));
  const maxLoad = Math.max(...kin.samples.map((_, i) => Math.abs(cardLoadAt(i / kin.samples.length))));
  let hi = maxTf * maxLoad * 4 + 1;
  let fLo = peaks(lo).diff;
  let fHi = peaks(hi).diff;
  if (fLo * fHi > 0) {
    const p = peaks(lo);
    return {
      momentInLb: lo,
      peakTorqueInLb: Math.max(p.upPeak, p.downPeak),
      counterbalanceEffectLb: structuralUnbalanceLb,
      balanced: false,
      torque: p.all,
    };
  }
  for (let i = 0; i < 100; i += 1) {
    const mid = 0.5 * (lo + hi);
    const fMid = peaks(mid).diff;
    if (fLo * fMid <= 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
  }
  const moment = 0.5 * (lo + hi);
  const p = peaks(moment);
  void fHi;
  void aIn;
  return {
    momentInLb: moment,
    peakTorqueInLb: Math.max(p.upPeak, p.downPeak),
    counterbalanceEffectLb: counterbalanceEffect({
      kin, momentInLb: moment, structuralUnbalanceLb,
    }),
    balanced: true,
    torque: p.all,
  };
};

/**
 * A GENERIC conventional linkage that achieves a requested stroke.
 *
 * The SHAPE is fixed by dimensionless ratios, so the angular swing is
 * a property of the shape alone; the whole linkage is then scaled so
 * the stroke comes out where it was asked for. The result is a
 * self-consistent unit that behaves like a conventional pumping unit.
 * It is NOT any manufacturer's product and carries no designation.
 */
export const genericConventionalGeometry = ({
  strokeIn, rOverC = 0.45, pOverC = 1.25, behindOverC = 1.45, belowOverC = 0.95,
  cOverA = 0.6,
}) => {
  const probe = conventionalGeometry({
    aIn: 1 / cOverA, cIn: 1, pIn: pOverC, crankBehindIn: behindOverC,
    crankBelowIn: belowOverC, rIn: rOverC,
  });
  const kin = unitKinematics(probe, { steps: 720 });
  if (!kin.ok) return { ok: false, error: kin.error };
  const swing = kin.psiMax - kin.psiMin;      // radians, shape only
  const aIn = strokeIn / swing;
  const cIn = aIn * cOverA;
  return {
    ok: true,
    generic: true,
    geometry: conventionalGeometry({
      aIn,
      cIn,
      pIn: cIn * pOverC,
      crankBehindIn: cIn * behindOverC,
      crankBelowIn: cIn * belowOverC,
      rIn: cIn * rOverC,
    }),
    note: 'Generic conventional geometry, scaled to the requested stroke. Not a manufacturer’s unit; enter real dimensions for a real design.',
  };
};

/**
 * API unit designation, e.g. C-228D-200-74.
 *
 * Type, gearbox rating in thousands of in-lb, structural capacity in
 * hundreds of lb, and stroke in inches. Parsing it is worth doing
 * because those three numbers are exactly what a design has to be
 * checked against.
 */
export const parseUnitDesignation = (text) => {
  const m = String(text || '').trim().toUpperCase()
    .match(/^([CMA])\s*-\s*(\d+(?:\.\d+)?)\s*([DS])?\s*-\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const KIND = { C: 'conventional', M: 'Mark II', A: 'air balanced' };
  return {
    kind: KIND[m[1]],
    torqueRatingInLb: Number(m[2]) * 1000,
    reduction: m[3] === 'S' ? 'single' : 'double',
    structuralCapacityLb: Number(m[4]) * 100,
    strokeIn: Number(m[5]),
    designation: `${m[1]}-${m[2]}${m[3] || ''}-${m[4]}-${m[5]}`,
  };
};
