/**
 * Nodal analysis: inflow, tubing outflow, and the operating point where
 * the two meet (Production, extracted from the Suite's Nodal Analysis
 * Studio NA1/NA2/NA3 layer).
 *
 * THE IDEA. A well is two systems bolted together at a node. Below the
 * node the reservoir pushes: the more it flows the lower its flowing
 * bottomhole pressure, so inflow falls monotonically with rate. Above
 * the node the tubing resists: at low rate the column is heavy and
 * gravity dominates, at high rate friction dominates, so the outflow
 * requirement is J-shaped. The well produces where the two curves
 * cross, and NOWHERE ELSE. Everything in this module exists to draw one
 * of those two curves or to find that crossing.
 *
 * WHY THE CROSSING IS NOT A LOOKUP. The J-shape means there can be two
 * crossings. Only the right-hand one is a well that stays put: there,
 * the outflow requirement rises faster with rate than the inflow falls,
 * so a rate perturbation is pushed back. On the left branch the same
 * perturbation runs away, which is heading. A solver that returns "the
 * intersection" without asking which branch it is on will happily
 * report a rate the well cannot hold. So `solveNodeCore` returns EVERY
 * crossing, each with its stability, and the reported operating point
 * is the rightmost stable one.
 *
 * WHAT IS INJECTED, AND WHY. `solveNodeCore` takes the two curves as
 * FUNCTIONS. It does not know what made them. That is deliberate and it
 * is the same discipline `networkSolve` uses for branch relations: it
 * means the solver is checkable without judgement (hand it two curves
 * whose crossing is known in closed form and the answer is arithmetic),
 * and it means a consumer with a validated multiphase traverse of its
 * own -- the Suite marches Beggs-Brill, Hagedorn-Brown, Gray or
 * Fancher-Brown through a real PVT model -- can hand that in rather
 * than this module inventing a gradient. Only the DRY GAS outflow is
 * built here, because Cullender & Smith needs nothing but a z-factor
 * and is therefore honestly self-contained.
 *
 * The z-factor is injected for the same reason. `nodalGasZ` (Sutton +
 * Wichert-Aziz + Dranchuk-Abou-Kassem, from ./gasProperties.js) is the
 * default and is what the goldens are cut against, but a consumer whose
 * whole PVT stack is built on a different correlation must be able to
 * stay on it rather than have this module quietly disagree with the
 * rest of that consumer's numbers by a per-cent of z.
 *
 * UNITS. Field units throughout, as everywhere else in engines/production.
 * They are not converted internally and they are not optional:
 *
 *   pressure          psia            (never psig, never gauge)
 *   oil / liquid rate stb/d
 *   gas rate          Mscf/d, EXCEPT cullenderSmithBhp which takes
 *                     MMscf/d because the published F-squared group is
 *                     written that way
 *   depth             ft (mdFt measured, tvdFt true vertical)
 *   temperature       degF at the interface, degR inside the gas maths
 *   diameter          in
 *   productivity index stb/d/psi
 *
 * REFUSALS. Every entry point returns a NaN-free refusal (an empty
 * curve, a null operating point, a status, a warnings list) rather than
 * a page of NaN, because an inflow that did not calibrate has an
 * absolute open flow of NaN and every rate comparison downstream
 * against NaN is false: the caller sails past its own guards.
 *
 * VALIDATION NOTE. Gated against tools/validation/production/oracle_nodal.py
 * through test-data/production/goldens/nodal_cases.json. The oracle is
 * written from the published method statements, not from this file:
 *
 *   - where this module inverts an IPR by a Brent root find on the
 *     forward relation, the oracle uses the CLOSED-FORM inverse (the
 *     quadratic root of the Vogel ratio, the square root of the
 *     Fetkovich pressure-squared form, the quadratic root of Jones);
 *   - where this module marches Cullender & Smith as the published
 *     two-half-step trapezoid with a Simpson refinement, the oracle
 *     integrates the SAME defining integral as an ODE in depth by
 *     classical RK4 to step convergence, and the test additionally
 *     checks that the pressure this module returns satisfies the
 *     defining equation of the method rather than merely matching
 *     another implementation of it;
 *   - where this module finds crossings by scanning a forty-point grid
 *     and refining with Brent, the oracle scans a four-thousand-point
 *     grid and bisects, and classifies stability from a central
 *     difference five hundred times finer.
 *
 * Two discretizations of one physics agreeing is evidence. A transcription
 * agreeing with its source is not.
 *
 * References: Vogel, JPT 20(1) 1968; Standing, JPT 22(9) 1970 (the
 * composite construction); Fetkovich, SPE 4529, 1973; Jones, Blount and
 * Glaze, SPE 6133, 1976; Rawlins and Schellhardt, USBM Monograph 7,
 * 1935; Houpeurt, Revue IFP 14, 1959; Cullender and Smith, Trans. AIME
 * 207, 1956, as reproduced in Ikoku, Natural Gas Production Engineering
 * and in Guo and Ghalambor, Natural Gas Engineering Handbook (the
 * average temperature and z form is Guo and Ghalambor Eq. 4.54);
 * Colebrook, J. ICE 11, 1939; Beggs, Production Optimization Using
 * Nodal Analysis, for the stability argument.
 */

import { suttonPseudoCriticals, wichertAziz, dakZ } from './gasProperties.js';

/**
 * Rankine offset. 460, not the exact 459.67 that ./gasProperties.js
 * carries, and the difference is deliberate rather than sloppy: every
 * published Cullender and Smith worked example, and every gas
 * deliverability example written against them, is arithmetic in
 * T[degF] + 460, so a module gated on those examples has to be in the
 * same convention as the examples or it disagrees with all of them in
 * the fourth figure for no reason anyone can see. One third of a degree
 * moves a bottomhole pressure by well under a psi; being on a different
 * convention from the reference you are checked against costs more than
 * that. The offset is used for BOTH the integrand temperature and the
 * z-factor here so the module is at least self-consistent.
 */
export const NODAL_RANKINE_OFFSET = 460;

/**
 * The default z-factor: Sutton pseudo-criticals, optional Wichert-Aziz
 * for acid gas, Dranchuk-Abou-Kassem, all from ./gasProperties.js --
 * the correlations are not restated here. Only the Rankine convention
 * is this module's own, for the reason above.
 */
export const nodalGasZ = ({ pPsia, tF, gasSg, yCo2 = 0, yH2s = 0 }) => {
  const base = suttonPseudoCriticals(gasSg);
  const { tpcR, ppcPsia } = wichertAziz({ ...base, yCo2, yH2s });
  return dakZ({ ppr: pPsia / ppcPsia, tpr: (tF + NODAL_RANKINE_OFFSET) / tpcR }).z;
};

// --------------------------------------------------------------------
// Local numerics.
//
// Kept here rather than imported so this module has one dependency
// (the z-factor) and not two. They are small, and a shared numerics
// module that half the domains reach into is how a change to a
// tolerance quietly moves eight engines at once.
// --------------------------------------------------------------------

/** Evenly spaced grid of n points from a to b inclusive. */
export const linspace = (a, b, n) => {
  const count = Math.max(2, Math.floor(n));
  const out = new Array(count);
  const step = (b - a) / (count - 1);
  for (let i = 0; i < count; i += 1) out[i] = a + step * i;
  out[count - 1] = b;
  return out;
};

/** Coerce to a finite number, with a fallback. Strings are parsed. */
export const num = (v, fallback = 0) => {
  const x = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(x) ? x : fallback;
};

/**
 * Brent's method (bisection + secant + inverse quadratic, Press et al.)
 * on a bracket where f(a) and f(b) have opposite signs.
 * returns { root, converged, iterations }; converged false when the
 * bracket does not straddle a root, rather than a guess.
 */
export const brentSolve = (f, a, b, { tol = 1e-8, maxIter = 100 } = {}) => {
  let xa = a;
  let xb = b;
  let fa = f(xa);
  let fb = f(xb);
  if (!Number.isFinite(fa) || !Number.isFinite(fb) || fa * fb > 0) {
    return { root: NaN, converged: false, iterations: 0 };
  }
  if (fa === 0) return { root: xa, converged: true, iterations: 0 };
  if (fb === 0) return { root: xb, converged: true, iterations: 0 };
  let xc = xa;
  let fc = fa;
  let d = xb - xa;
  let e = d;
  for (let iter = 1; iter <= maxIter; iter += 1) {
    if (fb * fc > 0) {
      xc = xa;
      fc = fa;
      d = xb - xa;
      e = d;
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      xa = xb; xb = xc; xc = xa;
      fa = fb; fb = fc; fc = fa;
    }
    const tol1 = 2 * Number.EPSILON * Math.abs(xb) + 0.5 * tol;
    const xm = 0.5 * (xc - xb);
    if (Math.abs(xm) <= tol1 || fb === 0) {
      return { root: xb, converged: true, iterations: iter };
    }
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p;
      let q;
      if (xa === xc) {
        p = 2 * xm * s;
        q = 1 - s;
      } else {
        const qq = fa / fc;
        const r = fb / fc;
        p = s * (2 * xm * qq * (qq - r) - (xb - xa) * (r - 1));
        q = (qq - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      p = Math.abs(p);
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) {
        e = d;
        d = p / q;
      } else {
        d = xm;
        e = d;
      }
    } else {
      d = xm;
      e = d;
    }
    xa = xb;
    fa = fb;
    xb += Math.abs(d) > tol1 ? d : (xm > 0 ? tol1 : -tol1);
    fb = f(xb);
  }
  return { root: xb, converged: false, iterations: maxIter };
};

// --------------------------------------------------------------------
// Pipe friction.
//
// A local Moody factor rather than the facilities line-hydraulics one.
// They differ on purpose: that module switches to turbulent at Re 2100
// because a flowline is either laminar or it is not, while a tubing
// traverse is integrated down the hole and a discontinuity in f at the
// critical Reynolds number puts a step in the gradient the integrator
// then has to climb over. Here the critical zone 2000..4000 is blended
// linearly, which no correlation justifies and which keeps the march
// continuous, and the blend is stated so nobody reads it as physics.
// --------------------------------------------------------------------

const LAMINAR_LIMIT = 2000;
const TURBULENT_LIMIT = 4000;

/** Colebrook-White Darcy friction factor, turbulent. relRough = eps/D. */
export const colebrookFrictionFactor = (re, relRough) => {
  if (!(re > 0)) return 0;
  // Swamee-Jain explicit form as the starting guess, then Colebrook to
  // machine tolerance.
  let f = 0.25 / Math.pow(Math.log10(relRough / 3.7 + 5.74 / Math.pow(re, 0.9)), 2);
  for (let i = 0; i < 50; i += 1) {
    const rhs = -2 * Math.log10(relRough / 3.7 + 2.51 / (re * Math.sqrt(f)));
    const fNew = 1 / (rhs * rhs);
    if (Math.abs(fNew - f) < 1e-12) return fNew;
    f = fNew;
  }
  return f;
};

/** Moody (Darcy) friction factor across all regimes. See the note above. */
export const moodyFrictionFactor = (re, relRough = 0) => {
  if (!(re > 0)) return 0;
  if (re < LAMINAR_LIMIT) return 64 / re;
  if (re > TURBULENT_LIMIT) return colebrookFrictionFactor(re, relRough);
  const fLam = 64 / LAMINAR_LIMIT;
  const fTurb = colebrookFrictionFactor(TURBULENT_LIMIT, relRough);
  const t = (re - LAMINAR_LIMIT) / (TURBULENT_LIMIT - LAMINAR_LIMIT);
  return fLam + t * (fTurb - fLam);
};

// --------------------------------------------------------------------
// Oil inflow (IPR).
//
// Rates are LIQUID rates. The IPR describes total liquid inflow; water
// cut changes what the WELLBORE carries and is therefore the outflow
// side's business. Getting that line wrong is how a high-water-cut well
// ends up with its inflow curve scaled twice.
// --------------------------------------------------------------------

const VOGEL_A = 0.2;
const VOGEL_B = 0.8;

/** The Vogel dimensionless rate at a pressure ratio r = pwf/pr. */
export const vogelRatio = (r) => 1 - VOGEL_A * r - VOGEL_B * r * r;

export const OIL_IPR_MODELS = ['pi', 'vogel', 'composite', 'fetkovich', 'jones'];

/**
 * Rate at a flowing pressure, for a model that is already calibrated.
 * This is the FORWARD evaluation and it is the definition of each
 * model; everything else in the oil inflow section is derived from it.
 */
export const rateAtPwf = (model, pwf) => {
  const p = Math.max(0, pwf);
  switch (model.model) {
    case 'pi':
      return Math.max(0, model.pi * (model.pr - p));
    case 'vogel': {
      if (p >= model.pr) return 0;
      return model.qmax * vogelRatio(p / model.pr);
    }
    case 'composite': {
      const { pr, pb, pi } = model;
      if (p >= pr) return 0;
      if (p >= pb || pb <= 0) return pi * (pr - p);
      const qb = pi * (pr - pb);
      return qb + ((pi * pb) / 1.8) * vogelRatio(p / pb);
    }
    case 'fetkovich': {
      const delta = model.pr * model.pr - p * p;
      return delta > 0 ? model.c * Math.pow(delta, model.n) : 0;
    }
    case 'jones': {
      const { a, b, pr } = model;
      const dp = pr - p;
      if (dp <= 0) return 0;
      if (!(b > 0)) return a > 0 ? dp / a : 0;
      return (-a + Math.sqrt(a * a + 4 * b * dp)) / (2 * b);
    }
    default:
      return 0;
  }
};

/**
 * Flowing pressure at a rate: the inverse evaluation, and the one the
 * node solve actually calls.
 *
 * Solved numerically on the forward relation rather than by the closed
 * form each model happens to have, so that adding a model to
 * `rateAtPwf` cannot leave a stale inverse behind it. The closed forms
 * are what the oracle uses, which is exactly the point of having one.
 */
export const pwfAtRate = (model, q) => {
  if (q <= 0) return model.pr;
  const qmax = model.qmax ?? rateAtPwf(model, 0);
  if (q >= qmax) return 0;
  const solved = brentSolve((p) => rateAtPwf(model, p) - q, 0, model.pr, { tol: 1e-6 });
  return solved.converged ? solved.root : NaN;
};

/**
 * Calibrate the chosen model from its inputs and an optional well test
 * point { q, pwf }. Exactly one of (testPoint, the model's own
 * coefficients) has to pin the curve; the test point wins when both are
 * present, because a measurement beats an estimate.
 */
const calibrate = ({ model, pr, pb, testPoint, pi, qmax, c, n, a, b }) => {
  const warnings = [];
  switch (model) {
    case 'pi': {
      let J = num(pi, NaN);
      if (testPoint) {
        const dp = pr - testPoint.pwf;
        if (dp > 0) J = testPoint.q / dp;
        else warnings.push('Test point pwf is at or above reservoir pressure; PI not calibrated from it.');
      }
      if (!(J > 0)) warnings.push('Productivity index is not positive.');
      return { pi: J, qmax: J * pr, warnings };
    }
    case 'vogel': {
      let qm = num(qmax, NaN);
      if (testPoint) {
        const r = testPoint.pwf / pr;
        const denom = vogelRatio(r);
        if (denom > 0) qm = testPoint.q / denom;
        else warnings.push('Test point sits above reservoir pressure; qmax not calibrated from it.');
      }
      if (!(qm > 0)) warnings.push('Vogel qmax is not positive.');
      return { qmax: qm, warnings };
    }
    case 'composite': {
      const pbv = Math.min(num(pb, 0), pr);
      let J = num(pi, NaN);
      if (testPoint) {
        const { q, pwf } = testPoint;
        if (pwf >= pbv) {
          const dp = pr - pwf;
          if (dp > 0) J = q / dp;
          else warnings.push('Test point pwf is at or above reservoir pressure; PI not calibrated from it.');
        } else {
          // q = J [ (pr - pb) + (pb/1.8) vogelRatio(pwf/pb) ] is linear in J.
          const factor = (pr - pbv) + (pbv / 1.8) * vogelRatio(pwf / pbv);
          if (factor > 0) J = q / factor;
          else warnings.push('Composite calibration factor is not positive; check pb versus pr.');
        }
      }
      if (!(J > 0)) warnings.push('Productivity index is not positive.');
      const qmaxComposite = J > 0 ? J * (pr - pbv) + (J * pbv) / 1.8 : NaN;
      return { pi: J, pb: pbv, qmax: qmaxComposite, warnings };
    }
    case 'fetkovich': {
      const nv = num(n, 1);
      let C = num(c, NaN);
      if (testPoint) {
        const delta = pr * pr - testPoint.pwf * testPoint.pwf;
        if (delta > 0) C = testPoint.q / Math.pow(delta, nv);
        else warnings.push('Test point pwf is at or above reservoir pressure; C not calibrated from it.');
      }
      if (!(C > 0)) warnings.push('Fetkovich C is not positive.');
      if (nv < 0.5 || nv > 1.0) warnings.push('Fetkovich exponent n outside the physical 0.5 to 1.0 band.');
      return { c: C, n: nv, qmax: C > 0 ? C * Math.pow(pr * pr, nv) : NaN, warnings };
    }
    case 'jones': {
      const av = num(a, NaN);
      const bv = num(b, NaN);
      if (!(av >= 0) || !(bv >= 0)) warnings.push('Jones coefficients a and b must be non-negative.');
      const qmaxJones = bv > 0
        ? (-av + Math.sqrt(av * av + 4 * bv * pr)) / (2 * bv)
        : (av > 0 ? pr / av : NaN);
      if (testPoint) {
        const predicted = pr - (av * testPoint.q + bv * testPoint.q * testPoint.q);
        if (Math.abs(predicted - testPoint.pwf) > 0.02 * pr) {
          warnings.push('Jones a, b do not reproduce the test point within 2 percent of pr.');
        }
      }
      return { a: av, b: bv, qmax: qmaxJones, warnings };
    }
    default:
      return { warnings: [`Unknown IPR model "${model}".`] };
  }
};

/**
 * A full oil IPR.
 * inputs: { model, pr, pb, testPoint: { q, pwf } | null, pi, qmax, c, n,
 *           a, b, nPoints = 40 }
 * returns { model, pr, pb, qmax, pi, c, n, a, b, curve: [{ q, pwf }],
 *           warnings }
 *
 * The curve is sampled in PRESSURE from pr down to zero rather than in
 * rate, so the sampling is even where the curve bends hardest and the
 * two ends both land exactly on the axis instead of near it.
 */
export const computeIpr = (inputs) => {
  const model = inputs.model || 'vogel';
  const pr = num(inputs.pr, NaN);
  const warnings = [];
  if (!(pr > 0)) {
    return { model, pr, curve: [], qmax: NaN, warnings: ['Reservoir pressure must be positive.'] };
  }
  const cal = calibrate({ ...inputs, model, pr });
  warnings.push(...(cal.warnings || []));

  const full = { model, pr, pb: cal.pb ?? num(inputs.pb, 0), ...cal };
  const qmax = full.qmax;
  if (!(qmax > 0)) {
    return { ...full, curve: [], warnings };
  }

  const curve = linspace(pr, 0, Math.max(2, inputs.nPoints || 40)).map((pwf) => ({
    q: rateAtPwf(full, pwf),
    pwf,
  }));

  return { ...full, curve, warnings };
};

/**
 * Shift a calibrated IPR to a future reservoir pressure.
 *  - 'pi' and 'jones': coefficients held, pr replaced
 *  - 'vogel': Eickmeier cube rule, qmax_f = qmax_p (prf/prp)^3
 *  - 'composite': PI held, curve recomputed at prf
 *  - 'fetkovich': C_f = C_p (prf/prp), the standard Fetkovich decline
 */
export const futureIpr = (iprResult, { prFuture }) => {
  const prf = num(prFuture, NaN);
  if (!(prf > 0) || !(iprResult?.pr > 0)) {
    return { ...iprResult, curve: [], warnings: ['Future reservoir pressure must be positive.'] };
  }
  const ratio = prf / iprResult.pr;
  switch (iprResult.model) {
    case 'vogel':
      return computeIpr({ model: 'vogel', pr: prf, qmax: iprResult.qmax * ratio ** 3 });
    case 'fetkovich':
      return computeIpr({ model: 'fetkovich', pr: prf, c: iprResult.c * ratio, n: iprResult.n });
    case 'composite':
      return computeIpr({ model: 'composite', pr: prf, pb: Math.min(iprResult.pb, prf), pi: iprResult.pi });
    case 'jones':
      return computeIpr({ model: 'jones', pr: prf, a: iprResult.a, b: iprResult.b });
    case 'pi':
    default:
      return computeIpr({ model: 'pi', pr: prf, pi: iprResult.pi });
  }
};

// --------------------------------------------------------------------
// Gas inflow (deliverability).
//
// Both routes here are the empirical ones, and both have a closed-form
// inverse, which is why they carry `pwfAt`. The theoretical
// pseudo-pressure route does not -- m(p) is a table -- and is left with
// the consumer that owns the gas PVT stack rather than dragged in here.
// --------------------------------------------------------------------

/** Sample a gas IPR from a q(pwf) evaluator, evenly in pressure. */
const sampleGasCurve = (pr, qOf, nPoints) =>
  linspace(pr, 0, Math.max(2, nPoints)).map((pwf) => ({ q: Math.max(0, qOf(pwf)), pwf }));

/**
 * Rawlins and Schellhardt back-pressure deliverability from fitted or
 * entered coefficients:  q = C (pr^2 - pwf^2)^n,  q in Mscf/d.
 * returns { curve, aof, qAt(pwf), pwfAt(q), warnings }
 */
export const backPressureIpr = ({ pr, c, n, nPoints = 40 }) => {
  const prv = num(pr, NaN);
  const C = num(c, NaN);
  const nv = num(n, 1);
  const warnings = [];
  if (!(prv > 0) || !(C > 0)) {
    return { curve: [], aof: NaN, pwfAt: null, qAt: null, warnings: ['Back-pressure IPR needs positive pr and C.'] };
  }
  if (nv < 0.5 || nv > 1.05) warnings.push('Deliverability exponent n outside the physical 0.5 to 1.0 band.');
  const qOf = (pwf) => {
    const delta = prv * prv - pwf * pwf;
    return delta > 0 ? C * Math.pow(delta, nv) : 0;
  };
  const aof = qOf(0);
  // Closed-form inverse: pwf = sqrt(pr^2 - (q/C)^(1/n)).
  const pwfAt = (q) => {
    if (!(q > 0)) return prv;
    if (q >= aof) return 0;
    return Math.sqrt(Math.max(0, prv * prv - Math.pow(q / C, 1 / nv)));
  };
  return {
    model: 'backPressure', pr: prv, c: C, n: nv, aof, pwfAt, qAt: qOf,
    curve: sampleGasCurve(prv, qOf, nPoints), warnings,
  };
};

/**
 * Houpeurt / LIT deliverability on pressure-squared:
 *   pr^2 - pwf^2 = a q + b q^2,  q in Mscf/d.
 * returns { curve, aof, qAt(pwf), pwfAt(q), warnings }
 */
export const litIpr = ({ pr, a, b, nPoints = 40 }) => {
  const prv = num(pr, NaN);
  const av = num(a, NaN);
  const bv = num(b, 0);
  if (!(prv > 0) || (!(av > 0) && !(bv > 0))) {
    return { curve: [], aof: NaN, pwfAt: null, qAt: null, warnings: ['LIT IPR needs positive pr and at least one positive coefficient.'] };
  }
  const qOf = (pwf) => {
    const delta = prv * prv - pwf * pwf;
    if (!(delta > 0)) return 0;
    if (!(bv > 0)) return av > 0 ? delta / av : 0;
    return (-av + Math.sqrt(av * av + 4 * bv * delta)) / (2 * bv);
  };
  const aof = qOf(0);
  // Closed-form inverse: the LIT relation is already explicit in pwf^2.
  const pwfAt = (q) => {
    if (!(q > 0)) return prv;
    const d = prv * prv - (av > 0 ? av * q : 0) - (bv > 0 ? bv * q * q : 0);
    return d > 0 ? Math.sqrt(d) : 0;
  };
  return {
    model: 'lit', pr: prv, a: av, b: bv, aof, pwfAt, qAt: qOf,
    curve: sampleGasCurve(prv, qOf, nPoints), warnings: [],
  };
};

/**
 * Flowing pressure at a rate over a SAMPLED gas IPR, by linear
 * interpolation between the points.
 *
 * This is what a pseudo-pressure IPR has to use, because m(p) is a
 * table and there is no inverse to write down. It is an APPROXIMATION,
 * and not a negligible one: the curve is sampled evenly in pressure,
 * which leaves the samples sparse in RATE exactly where the curve is
 * steepest, and the oracle measures the reading running one to three
 * psi low through the body of both empirical families and thirteen psi
 * low at the low-rate end of a strongly turbulent one. Where the result
 * carries a `pwfAt` -- both families here do -- use
 * `gasPwfAtRateExact`, which is what `solveGasNode` does.
 */
export const gasPwfAtRate = (iprResult, q) => {
  const pts = [...iprResult.curve].sort((a, b) => a.q - b.q);
  if (pts.length === 0) return NaN;
  if (q <= pts[0].q) return pts[0].pwf;
  for (let i = 1; i < pts.length; i += 1) {
    if (q <= pts[i].q) {
      const a = pts[i - 1];
      const b = pts[i];
      const t = b.q === a.q ? 0 : (q - a.q) / (b.q - a.q);
      return a.pwf + t * (b.pwf - a.pwf);
    }
  }
  return 0;
};

/**
 * Flowing pressure at a rate over a gas IPR, exactly where the family
 * has a closed-form inverse and by interpolation where it does not.
 */
export const gasPwfAtRateExact = (iprResult, q) =>
  (typeof iprResult?.pwfAt === 'function' ? iprResult.pwfAt(q) : gasPwfAtRate(iprResult, q));

// --------------------------------------------------------------------
// Dry-gas tubing outflow.
// --------------------------------------------------------------------

const CS_MAX_ITER = 40;
const CS_TOL_PSI = 0.001;

/** Reynolds number for gas in field units: q MMscf/d, d in, mu cp (Katz). */
export const gasReynolds = (qMmscfd, gasSg, muCp, dIn) => {
  if (!(muCp > 0) || !(dIn > 0)) return 0;
  return (20011 * gasSg * Math.abs(qMmscfd)) / (muCp * dIn);
};

/**
 * The Cullender and Smith integrand:
 *
 *   I(p) = (p/Tz) / [ (H/L) (p/Tz)^2 / 1000 + F^2 ]
 *
 * with the defining relation  integral from ptf to pwf of I dp
 * = 18.75 gammaG L,  L the measured depth and H/L the elevation ratio
 * (TVD/MD, one in a vertical hole).
 */
export const csIntegrand = ({ pPsia, tR, z, elevRatio, f2 }) => {
  const ptz = pPsia / (tR * z);
  const denom = (elevRatio * ptz * ptz) / 1000 + f2;
  return denom > 0 ? ptz / denom : 0;
};

/** The friction group F^2 = 0.667 f q^2 / d^5, q in MMscf/d, d in inches. */
export const csFrictionGroup = ({ qMmscfd, fMoody, idIn }) =>
  (0.667 * fMoody * qMmscfd * qMmscfd) / Math.pow(idIn, 5);

/**
 * March one half of the column: solve p2 so that the trapezoid over the
 * half closes,  (p2 - p1)(I1 + I2) = 2 rhsHalf,  by the fixed-point
 * iteration on I2 that Cullender and Smith originally proposed.
 */
const csStepHalf = (p1, i1, rhsHalf, evalI, tolPsi = CS_TOL_PSI) => {
  let p2 = p1 + rhsHalf / Math.max(i1, 1e-12); // first guess: I2 = I1
  for (let k = 0; k < CS_MAX_ITER; k += 1) {
    const i2 = evalI(p2);
    const next = p1 + (2 * rhsHalf) / Math.max(i1 + i2, 1e-12);
    if (Math.abs(next - p2) < tolPsi) return { p: next, i: evalI(next) };
    p2 = next;
  }
  return { p: p2, i: evalI(p2) };
};

/**
 * Static (q = 0) or flowing bottomhole pressure of a dry gas well by
 * Cullender and Smith: the two-half-step trapezoid with the final
 * Simpson's-rule refinement over the whole column.
 *
 * inputs: {
 *   ptf      wellhead tubing pressure, psia
 *   gasSg    gas gravity, air = 1
 *   mdFt     measured depth; tvdFt true vertical (defaults to mdFt)
 *   whtF, bhtF   wellhead and bottomhole temperature, degF
 *   qMmscfd  rate, MMscf/d (0 or omitted gives the static column)
 *   idIn     tubing ID, in; roughnessIn absolute roughness, in
 *   muCp     gas viscosity for the Reynolds number only (the friction
 *            factor is insensitive to it at fully rough turbulence)
 *   fMoody   optional friction-factor override; published worked
 *            examples prescribe their own f and the gates use this
 *   zAt      (pPsia, tF) -> z. Defaults to Sutton + Wichert-Aziz + DAK.
 *   steps    number of sub-intervals, rounded up to an even number.
 *            DEFAULT 2, which is the published method exactly: one
 *            midpoint station, two trapezoid halves, one Simpson pass.
 *            SEE THE WARNING BELOW before leaving it there on a
 *            friction-dominated well.
 *   tolPsi   fixed-point stopping tolerance, default 0.001 psi
 * }
 * returns { pwf, pmf, converged, steps }
 *
 * ON THE STEP COUNT, WHICH IS NOT A COSMETIC CHOICE. Cullender and
 * Smith's two-station construction rests on I(p) being close to linear
 * over the whole column. That holds for a static or gently flowing gas
 * well and the published examples are all of that kind. It stops
 * holding when the friction group F^2 becomes comparable to the gravity
 * term, because I then bends sharply, and the two-station Simpson has
 * nothing to bend with. The independent oracle for this module
 * integrates the SAME defining integral to step convergence, and the
 * gap it exposes is not small: on an 8000 ft, 2.441 in string at
 * 9 MMscf/d the two-station answer is 1.3 psi low, and by 13 MMscf/d it
 * is 10.5 psi low, which moves the nodal operating point of that well
 * by about half a per cent of rate. Marching the same construction over
 * more sub-intervals removes it, and the error falls roughly with the
 * square of the count: on that same well at 13.3 MMscf/d the two-station
 * answer is 11.6 psi low, 16 stations is 0.26 psi low, 64 is 0.016 psi
 * low and 256 is 0.001 psi low, which is the converged integral. The
 * cost is a handful more z-factor evaluations. The default stays at 2
 * so that this module reproduces the published method as published, and
 * every consumer solving a real gas well at rate should raise it.
 */
export const cullenderSmithBhp = ({
  ptf,
  gasSg,
  mdFt,
  tvdFt = mdFt,
  whtF,
  bhtF,
  qMmscfd = 0,
  idIn = 2.441,
  roughnessIn = 0.0006,
  muCp = 0.012,
  fMoody,
  zAt,
  steps = 2,
  tolPsi = CS_TOL_PSI,
}) => {
  if (!(ptf > 0) || !(mdFt > 0) || !(gasSg > 0)) {
    return { pwf: NaN, pmf: NaN, converged: false, steps: 0 };
  }
  const z = zAt || ((pPsia, tF) => nodalGasZ({ pPsia, tF, gasSg }));
  const elevRatio = tvdFt / mdFt;
  let f2 = 0;
  if (qMmscfd > 0) {
    const f = fMoody
      ?? moodyFrictionFactor(gasReynolds(qMmscfd, gasSg, muCp, idIn), roughnessIn / idIn);
    f2 = csFrictionGroup({ qMmscfd, fMoody: f, idIn });
  }

  // Even number of sub-intervals: the Simpson closure works on PAIRS.
  const n = Math.max(2, 2 * Math.round(Math.max(2, steps) / 2));
  const dL = mdFt / n;
  const rhsSub = 18.75 * gasSg * dL;
  const tempAt = (lengthFt) => whtF + ((bhtF - whtF) * lengthFt) / mdFt;
  const evalIAtLength = (lengthFt) => {
    const tF = tempAt(lengthFt);
    const tR = tF + NODAL_RANKINE_OFFSET;
    return (p) => csIntegrand({ pPsia: p, tR, z: z(p, tF), elevRatio, f2 });
  };

  let p = ptf;
  let i0 = evalIAtLength(0)(ptf);
  let pmf = NaN;
  let converged = true;

  // Pair by pair down the hole: two trapezoid half-steps, then the
  // Simpson refinement over the pair, then carry the refined pressure
  // into the next pair. With n = 2 this IS the published method, station
  // for station.
  for (let j = 0; j < n; j += 2) {
    const lMid = (j + 1) * dL;
    const lBot = (j + 2) * dL;
    const evalMid = evalIAtLength(lMid);
    const evalBot = evalIAtLength(lBot);
    const mid = csStepHalf(p, i0, rhsSub, evalMid, tolPsi);
    const bottom = csStepHalf(mid.p, mid.i, rhsSub, evalBot, tolPsi);

    let pEnd = bottom.p;
    let pairConverged = false;
    for (let k = 0; k < CS_MAX_ITER; k += 1) {
      const iEnd = evalBot(pEnd);
      const next = p + (6 * 2 * rhsSub) / Math.max(i0 + 4 * mid.i + iEnd, 1e-12);
      if (Math.abs(next - pEnd) < tolPsi) { pEnd = next; pairConverged = true; break; }
      pEnd = next;
    }
    if (!pairConverged) converged = false;
    if (Math.abs(lMid - mdFt / 2) < 1e-9) pmf = mid.p;
    if (Math.abs(lBot - mdFt / 2) < 1e-9) pmf = pEnd;
    p = pEnd;
    i0 = evalBot(pEnd);
  }

  return { pwf: p, pmf, converged, steps: n };
};

/**
 * Average temperature and z-factor bottomhole pressure (Katz; Guo and
 * Ghalambor Eq. 4.54), the closed-form cousin of Cullender and Smith
 * and a useful second opinion on it:
 *
 *   pwf^2 = e^s ptf^2 + 6.67e-4 (e^s - 1) f q^2 (Tbar zbar)^2 / (d^5 cos)
 *   s     = 0.0375 gammaG L cos / (Tbar zbar)
 *
 * Same input contract as cullenderSmithBhp with qMscfd in Mscf/d.
 * returns { pwf, zBar, converged }
 */
export const averageTzBhp = ({
  ptf,
  gasSg,
  mdFt,
  tvdFt = mdFt,
  whtF,
  bhtF,
  qMscfd = 0,
  idIn = 2.441,
  roughnessIn = 0.0006,
  muCp = 0.012,
  fMoody,
  zAt,
}) => {
  if (!(ptf > 0) || !(mdFt > 0) || !(gasSg > 0)) return { pwf: NaN, zBar: NaN, converged: false };
  const z = zAt || ((pPsia, tF) => nodalGasZ({ pPsia, tF, gasSg }));
  const cos = tvdFt / mdFt;
  const tBarR = (whtF + bhtF) / 2 + NODAL_RANKINE_OFFSET;
  const f = qMscfd > 0
    ? (fMoody
      ?? moodyFrictionFactor(gasReynolds(qMscfd / 1000, gasSg, muCp, idIn), roughnessIn / idIn))
    : 0;

  let pwf = ptf * 1.2;
  let zBar = 0.9;
  for (let k = 0; k < CS_MAX_ITER; k += 1) {
    const pBar = (ptf + pwf) / 2;
    zBar = z(pBar, tBarR - NODAL_RANKINE_OFFSET);
    const s = (0.0375 * gasSg * mdFt * cos) / (tBarR * zBar);
    const es = Math.exp(s);
    const fric = qMscfd > 0
      ? (6.67e-4 * (es - 1) * f * qMscfd * qMscfd * tBarR * tBarR * zBar * zBar)
        / (Math.pow(idIn, 5) * cos)
      : 0;
    const next = Math.sqrt(es * ptf * ptf + fric);
    if (Math.abs(next - pwf) < CS_TOL_PSI) return { pwf: next, zBar, converged: true };
    pwf = next;
  }
  return { pwf, zBar, converged: false };
};

/**
 * The outflow curve: required bottomhole pressure sampled across rate.
 *
 * `bhpAt(q)` is injected for the reason the module header gives. The
 * curve is sampled from a rate just off zero, because most outflow
 * models are singular at zero rate and a chart that starts at a
 * vertical asymptote tells the reader nothing.
 *
 * returns { curve: [{ q, bhp }], minimum: { q, bhp } | null }
 * `minimum` is the bottom of the J: where the well is closest to
 * loading up, and the point a stable operating point always sits to the
 * RIGHT of. It is a REDUCTION over the sampled rows and moves with the
 * sampling, which is why it is gated as its own value. Note that a DRY
 * gas column has no J in it at all -- nothing in Cullender and Smith
 * lightens with rate -- so for that outflow the minimum is simply the
 * lowest sampled rate, and it only becomes interesting once the outflow
 * carries liquid.
 */
export const tubingCurve = ({ bhpAt, qMax, nPoints = 40, qMinFraction = 1e-3 }) => {
  if (!(qMax > 0)) return { curve: [], minimum: null };
  const curve = linspace(qMax * qMinFraction, qMax, Math.max(2, nPoints))
    .map((q) => ({ q, bhp: bhpAt(q) }));
  let minimum = null;
  curve.forEach((pt) => {
    if (!Number.isFinite(pt.bhp)) return;
    if (!minimum || pt.bhp < minimum.bhp) minimum = { q: pt.q, bhp: pt.bhp };
  });
  return { curve, minimum };
};

// --------------------------------------------------------------------
// The node solve.
// --------------------------------------------------------------------

const REL_SLOPE_DQ = 5e-3; // central-difference step as a fraction of qMax

const refineNode = (q, resid, iprPwfAt, qMax) => {
  const dq = qMax * REL_SLOPE_DQ;
  const gPlus = resid(Math.min(q + dq, qMax));
  const gMinus = resid(Math.max(q - dq, qMax * 1e-6));
  return { q, pwf: iprPwfAt(q), stable: gPlus > gMinus };
};

/**
 * Every crossing of an inflow curve and an outflow curve, with its
 * stability, and the operating point that follows.
 *
 * inputs: {
 *   iprPwfAt (q) -> inflow pressure at the node, psia, falling in q
 *   vlpBhpAt (q) -> outflow pressure required at the node, psia
 *   qMax     upper rate bound (the absolute open flow, or the model qmax)
 *   nGrid    scan resolution, default 40
 * }
 * returns { intersections: [{ q, pwf, stable }], op, status, curve }
 *   status  'flowing'             a stable crossing was found
 *           'no-stable-solution'  crossings exist, none of them holds
 *           'dead'                the outflow is above the inflow at
 *                                 every sampled rate
 *
 * The reported `op` is the RIGHTMOST STABLE crossing, which is the
 * reduction over the rows and is gated as its own value, not inferred
 * from the rows being right.
 */
export const solveNodeCore = ({ iprPwfAt, vlpBhpAt, qMax, nGrid = 40 }) => {
  if (!(qMax > 0)) return { intersections: [], op: null, status: 'dead', curve: [] };

  const qs = linspace(qMax * 1e-3, qMax * 0.999, nGrid);
  const resid = (q) => vlpBhpAt(q) - iprPwfAt(q);
  const curve = qs.map((q) => {
    const vlp = vlpBhpAt(q);
    const ipr = iprPwfAt(q);
    return { q, vlp, ipr, g: vlp - ipr };
  });

  const intersections = [];
  for (let i = 1; i < curve.length; i += 1) {
    const a = curve[i - 1];
    const b = curve[i];
    if (!Number.isFinite(a.g) || !Number.isFinite(b.g)) continue;
    if (a.g === 0) intersections.push(refineNode(a.q, resid, iprPwfAt, qMax));
    if (a.g * b.g < 0) {
      const solved = brentSolve(resid, a.q, b.q, { tol: Math.max(qMax * 1e-8, 1e-8) });
      if (solved.converged) intersections.push(refineNode(solved.root, resid, iprPwfAt, qMax));
    }
    // The last sample is only ever a bracket end, never an `a`, so an
    // exact zero sitting on it is picked up here rather than dropped.
    if (i === curve.length - 1 && b.g === 0) {
      intersections.push(refineNode(b.q, resid, iprPwfAt, qMax));
    }
  }

  const stable = intersections.filter((x) => x.stable);
  const op = stable.length > 0 ? stable[stable.length - 1] : null;
  const status = op
    ? 'flowing'
    : intersections.length > 0
      ? 'no-stable-solution'
      : 'dead';
  return { intersections, op, status, curve };
};

/**
 * Oil-well operating point: a calibrated IPR against an injected
 * outflow. The outflow stays injected because a black-oil traverse is
 * the consumer's, not this module's -- see the header.
 */
export const solveOilNode = ({ ipr, vlpBhpAt, nGrid = 40 }) => {
  const qMax = ipr?.qmax ?? (ipr ? rateAtPwf(ipr, 0) : NaN);
  if (!(qMax > 0)) {
    return { intersections: [], op: null, status: 'dead', curve: [], qMax: NaN };
  }
  return {
    ...solveNodeCore({
      iprPwfAt: (q) => pwfAtRate(ipr, q),
      vlpBhpAt,
      qMax,
      nGrid,
    }),
    qMax,
  };
};

/**
 * Gas-well operating point: a gas deliverability curve against the
 * Cullender and Smith column, all rates in Mscf/d.
 *
 * inputs: { iprResult, tubing (the cullenderSmithBhp inputs bar the
 *   rate), nGrid, bhpAt (an outflow override, for a wet-gas traverse
 *   the consumer owns) }
 *
 * The inflow is inverted EXACTLY where the family allows it. Reading it
 * off the sampled curve instead biases the crossing: the golden carries
 * the size of that bias, and on the gated wells it moves the operating
 * rate by around half a Mscf/d in eleven thousand. Small, but there is
 * no reason to carry it when the inverse is a square root.
 */
export const solveGasNode = ({ iprResult, tubing, bhpAt, nGrid = 40 }) => {
  const qMax = iprResult?.aof;
  if (!(qMax > 0)) {
    return { intersections: [], op: null, status: 'dead', curve: [], qMax: NaN };
  }
  const vlpBhpAt = bhpAt
    || ((q) => cullenderSmithBhp({ ...tubing, qMmscfd: q / 1000 }).pwf);
  return {
    ...solveNodeCore({
      iprPwfAt: (q) => gasPwfAtRateExact(iprResult, q),
      vlpBhpAt,
      qMax,
      nGrid,
    }),
    qMax,
  };
};

/**
 * Sensitivity sweep: the operating point over a list of labelled cases.
 * Each case carries its own solve as a thunk, so a sweep over tubing
 * size and a sweep over wellhead pressure are the same call.
 *
 * cases: [{ label, value, solve: () => solveNodeCore-shaped result }]
 * returns [{ label, value, status, q, pwf }]
 */
export const operatingPointSweep = (cases) =>
  (cases || []).map((c) => {
    const solved = c.solve();
    return {
      label: c.label,
      value: c.value,
      status: solved.status,
      q: solved.op ? solved.op.q : 0,
      pwf: solved.op ? solved.op.pwf : NaN,
    };
  });
