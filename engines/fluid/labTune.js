/**
 * EOS tuning to lab data — ET2 regression (plan of record:
 * FluidSystemsStudio-STATUS.md, ET program section).
 *
 * Joint weighted least squares over the four ET knobs (fTc, fPc, kC1,
 * sPlus — see eos/tuning.js) against thin-real lab targets:
 *
 *   targets = {
 *     psat:          { tF, pPsia, weight? }
 *     separatorTest: { stagesF: [[tF, pPsia], ...],  // psia, stock tank implicit
 *                      resTF, resPPsia,              // Bo basis (lab Pb / res T)
 *                      totalGor?,                    // scf/STB
 *                      stoApi?,                      // deg API at 60F
 *                      bo?,                          // rb/STB (Bofb)
 *                      weight? }
 *   }
 *
 * Residuals are relative errors (stock-tank API enters as stock-tank SG so
 * every residual is O(0.01) per percent of mismatch). Weak prior-pull
 * regularization keeps under-determined target sets near the untuned
 * start: at PRIOR_WEIGHT = 0.02 a knob must buy about two percent of
 * target improvement to justify a full-bounds excursion.
 *
 * Bo compares at the engine's own saturation pressure when the model is
 * two-phase at the stated reservoir conditions (the CASE 19 convention);
 * as the tune pulls Psat toward the lab value this fallback self-heals.
 *
 * The optimizer is the canonical bounded LM kernel from the Well Test
 * program (lib/welltest/lmFit.js) — imported, not reimplemented.
 */

import { levenbergMarquardt } from '../../lib/welltest/lmFit.js';
import { characterizePlusFraction } from './characterization.js';
import { tunedMixtureWithPlusFraction, TUNING_BOUNDS } from './tuning.js';
import { saturationPressure } from './envelope.js';
import { separatorTrain } from './separator.js';
import { degFtoR } from './units.js';

const WATER_DENSITY = 62.3664; // lb/ft3 at 60F, matches eos/separator.js

/** Finite penalty for residuals the model cannot evaluate (no boundary, no
 * stock-tank liquid). Large against O(0.01) errors, small enough to keep
 * the Jacobian finite. */
const PENALTY = 10;

const PRIOR_WEIGHT = 0.02;
const PRIOR_SCALE = { fTc: 0.15, fPc: 0.3, kC1: 0.25, sPlus: 0.7 };

const KNOBS = ['fTc', 'fPc', 'kC1', 'sPlus'];

/** Saturation-pressure bisection tolerance (the envelope.js phaseBoundaries
 * default, passed explicitly so the step below stays tied to it). */
const SAT_TOL_PSIA = 0.05;
/** How far above a bisected boundary the Bo fallback evaluates the feed:
 * five tolerances, the envelope.js classifyBoundary minimum inset. The
 * boundary is only known to within one tolerance, so a relative step
 * (1e-6 is 0.003 psia at 3000 psia) can land on the two-phase side. */
const SAT_STEP_PSIA = 5 * SAT_TOL_PSIA;

/** Scan window from a reference pressure: cheaper scan, and the boundary of
 * interest cannot sit above ~2x the lab Psat inside the ET bounds. */
const satWindow = (pRefPsia) => (Number.isFinite(pRefPsia)
  ? { pMaxPsia: Math.min(12000, 2.5 * pRefPsia), tolPsia: SAT_TOL_PSIA }
  : { tolPsia: SAT_TOL_PSIA });

const apiToSg = (api) => 141.5 / (api + 131.5);
const sgToApi = (sg) => 141.5 / sg - 131.5;

/** The untuned knob values: multiplier identities plus the correlation
 * BIP and volume shift the tune replaces. */
export function untunedKnobs(plus, opts = {}) {
  const ch = characterizePlusFraction(plus, opts);
  return { fTc: 1, fPc: 1, kC1: ch.bip.C1, sPlus: ch.comp.shift };
}

const thetaToTuning = (theta) => ({
  fTc: theta[0], fPc: theta[1], kC1: theta[2], sPlus: theta[3],
});

/**
 * Predict every target quantity for one tuning state. Returns
 * { psatPsia, totalGor, stoApi, bo, boBasisPsia } with nulls where the
 * model degrades (no boundary / no stock-tank liquid).
 */
export function predictTargets({ keys, plus, z }, targets, tuning) {
  const baseKeys = keys[keys.length - 1] === 'C7+' ? keys.slice(0, -1) : keys;
  const mix = tunedMixtureWithPlusFraction(baseKeys, plus, tuning);
  const out = { psatPsia: null, totalGor: null, stoApi: null, bo: null, boBasisPsia: null };

  const sep = targets.separatorTest;
  // one scan window for every saturation pressure this call computes: the
  // lab Psat when given, else the Bo basis pressure (the lab Pb)
  const window = satWindow(targets.psat?.pPsia ?? sep?.resPPsia);

  let psatSat = null;
  if (targets.psat) {
    psatSat = saturationPressure(mix, z, degFtoR(targets.psat.tF), window);
    out.psatPsia = psatSat ? psatSat.pPsia : null;
  }

  if (sep) {
    const stages = sep.stagesF.map(([tF, pPsia]) => ({ tR: degFtoR(tF), pPsia }));
    const opts = Number.isFinite(sep.resTF) && Number.isFinite(sep.resPPsia)
      ? { resTR: degFtoR(sep.resTF), resPPsia: sep.resPPsia } : {};
    const res = separatorTrain(mix, z, stages, opts);
    out.totalGor = res.totals?.totalGor ?? null;
    out.stoApi = res.stockTank ? sgToApi(res.stockTank.density / WATER_DENSITY) : null;
    let bo = res.bo?.multistage ?? null;
    let basis = sep.resPPsia ?? null;
    if (bo === null && opts.resTR) {
      // two-phase at lab reservoir conditions: compare at the engine Psat,
      // the same one the Psat row reports when it is at the same temperature
      const sat = targets.psat && targets.psat.tF === sep.resTF
        ? psatSat
        : saturationPressure(mix, z, opts.resTR, window);
      if (sat) {
        // step clear of the bisection band so the feed is single-phase
        const resAtSat = separatorTrain(mix, z, stages,
          { resTR: opts.resTR, resPPsia: sat.pPsia + SAT_STEP_PSIA });
        bo = resAtSat.bo?.multistage ?? null;
        basis = sat.pPsia;
      }
    }
    out.bo = bo;
    out.boBasisPsia = bo !== null ? basis : null;
  }
  return out;
}

/** Assemble the measured-target list actually present (name, value, weight). */
const collectTargets = (targets) => {
  const list = [];
  const psatW = targets.psat?.weight ?? 1;
  const sepW = targets.separatorTest?.weight ?? 1;
  if (targets.psat && Number.isFinite(targets.psat.pPsia)) {
    list.push({ name: 'psat', unit: 'psia', measured: targets.psat.pPsia, weight: psatW });
  }
  const sep = targets.separatorTest;
  if (sep) {
    if (Number.isFinite(sep.totalGor)) list.push({ name: 'totalGor', unit: 'scf/STB', measured: sep.totalGor, weight: sepW });
    if (Number.isFinite(sep.stoApi)) list.push({ name: 'stoApi', unit: 'API', measured: sep.stoApi, weight: sepW });
    if (Number.isFinite(sep.bo)) list.push({ name: 'bo', unit: 'rb/STB', measured: sep.bo, weight: sepW });
  }
  return list;
};

/** Relative-error residual for one target row given a prediction set. */
const residualFor = (row, pred) => {
  const value = pred[row.name === 'psat' ? 'psatPsia' : row.name];
  if (value === null || !Number.isFinite(value)) return PENALTY * row.weight;
  if (row.name === 'stoApi') {
    // compare as stock-tank SG so the residual is a well-scaled relative error
    const sgMeas = apiToSg(row.measured);
    return ((apiToSg(value) - sgMeas) / sgMeas) * row.weight;
  }
  return ((value - row.measured) / row.measured) * row.weight;
};

/** Two-sided 95 percent Student t quantiles by degrees of freedom (1 to 30);
 * beyond 30 the normal 1.96 is within 2 percent. Standard tabulated values. */
const T_975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];
export const studentT975 = (dof) => (dof >= 1 && dof <= 30 ? T_975[Math.round(dof) - 1] : 1.96);

/**
 * The regression problem of a tune, as the optimizer sees it: the measured
 * rows, the untuned start and the residual function (target residuals
 * followed by the four prior pulls). tuneToLab minimizes exactly this, and
 * tuneResiduals exposes it so a gate can hold the reported uncertainty
 * against the curvature of the function that was minimized.
 */
function tuneProblem(fluid, targets, opts = {}) {
  const rows = collectTargets(targets);
  const start = untunedKnobs(fluid.plus);
  const theta0 = KNOBS.map((k) => start[k]);
  const priorWeight = opts.priorWeight ?? PRIOR_WEIGHT;
  const residualsFn = (theta) => {
    const pred = predictTargets(fluid, targets, thetaToTuning(theta));
    const r = rows.map((row) => residualFor(row, pred));
    KNOBS.forEach((k, j) => {
      r.push(priorWeight * ((theta[j] - theta0[j]) / PRIOR_SCALE[k]));
    });
    return r;
  };
  return { rows, start, theta0, residualsFn };
}

/** The knob names, in the order of every vector and matrix of a tune. */
export const TUNING_KNOBS = Object.freeze([...KNOBS]);

/**
 * The residual vector of a tune at one tuning state ({fTc, fPc, kC1,
 * sPlus}): one relative error per measured target, then one prior pull per
 * knob. Its sum of squares is the `ssr` tuneToLab reports at the optimum.
 */
export function tuneResiduals(fluid, targets = {}, tuning, opts = {}) {
  if (!fluid?.plus) return null;
  const { rows, residualsFn } = tuneProblem(fluid, targets, opts);
  if (!rows.length) return null;
  return residualsFn(KNOBS.map((k) => tuning[k]));
}

/**
 * Fit the four ET knobs to the lab targets.
 *
 * fluid = { keys, plus, z } in engine form (keys may include the trailing
 * 'C7+'; z sums to 1 with the plus fraction last). Returns
 * { ok, converged, iterations, tuning, start, ssr0, ssr, boundsHit, report,
 *   uncertainty }
 * — report rows carry measured / untuned / tuned values and percent errors
 * for the UI's before/after table. ok:false (with reason) when no numeric
 * target was supplied or the fluid has no plus fraction.
 *
 * `uncertainty` (Fluid U2) is the linearized uncertainty of the tuned
 * knobs from the regression itself: covariance = s^2 (J'J)^-1 at the
 * optimum with s^2 = SSR / (m - n), m residuals (targets plus the four
 * prior pulls) and n = 4 knobs; standard errors are the square roots of
 * its diagonal and the 95 percent interval is value +/- t(0.975, m - n)
 * standard errors. It says how firmly the measured values and the prior
 * hold each knob. It is no statement about the accuracy of the lab data,
 * which the regression is not told. A knob that stopped at a regression
 * bound has no interval (the optimum is not interior), and nothing is
 * reported (`withheld` says why) when J'J cannot be inverted or when the
 * tuned model cannot evaluate one of the targets.
 */
export function tuneToLab(fluid, targets = {}, opts = {}) {
  if (!fluid?.plus) return { ok: false, reason: 'Tuning needs a C7+ plus fraction.' };
  const { rows, start, theta0, residualsFn } = tuneProblem(fluid, targets, opts);
  if (!rows.length) return { ok: false, reason: 'Enter at least one measured lab value.' };

  // opts.start: partial knob overrides for the LM starting point (multi-start
  // and "re-tune from the currently applied tuning"). The prior still pulls
  // toward the UNTUNED values, not the start.
  const thetaStart = KNOBS.map((k, j) => (
    Number.isFinite(opts.start?.[k]) ? opts.start[k] : theta0[j]
  ));
  const bounds = KNOBS.map((k) => TUNING_BOUNDS[k]);

  const r0 = residualsFn(theta0);
  const fit = levenbergMarquardt(residualsFn, thetaStart, {
    maxIterations: opts.maxIterations ?? 80,
    tolerance: opts.tolerance ?? 1e-9,
    bounds,
    // Psat comes from a bisection quantized to tolPsia (0.05 psia); the
    // kernel's default relative step (1e-6) sits below that noise floor
    // and reads a zero derivative for the equilibrium knobs. 1e-3 moves
    // Psat by ~10 psia per step, far above the quantum.
    jacobianStep: [1e-3, 1e-3, 1e-3, 1e-3],
  });

  const tuning = thetaToTuning(fit.theta);
  const boundsHit = KNOBS.filter((k, j) => {
    const [lo, hi] = bounds[j];
    return fit.theta[j] <= lo + 1e-9 || fit.theta[j] >= hi - 1e-9;
  });

  const untunedPred = predictTargets(fluid, targets, null);
  const tunedPred = predictTargets(fluid, targets, tuning);
  const errPct = (row, pred) => {
    const value = pred[row.name === 'psat' ? 'psatPsia' : row.name];
    if (value === null || !Number.isFinite(value)) return null;
    if (row.name === 'stoApi') return value - row.measured; // absolute API points
    return (100 * (value - row.measured)) / row.measured;
  };
  const report = rows.map((row) => ({
    name: row.name,
    unit: row.unit,
    measured: row.measured,
    untuned: untunedPred[row.name === 'psat' ? 'psatPsia' : row.name],
    tuned: tunedPred[row.name === 'psat' ? 'psatPsia' : row.name],
    untunedErr: errPct(row, untunedPred),
    tunedErr: errPct(row, tunedPred),
  }));

  // Fluid U2: the uncertainty the regression itself produces
  const m = rows.length + KNOBS.length;
  const dof = Math.max(m - KNOBS.length, 1);
  const tValue = studentT975(dof);
  const cov = fit.covariance;
  // a target the tuned model cannot evaluate enters as a flat penalty: the
  // curvature there says nothing about the knobs
  const unevaluated = report.filter((r) => r.tuned === null || !Number.isFinite(r.tuned)).map((r) => r.name);
  let withheld = null;
  if (unevaluated.length) withheld = `The tuned model cannot evaluate ${unevaluated.join(', ')}, so the regression has no curvature to read an uncertainty from.`;
  else if (!cov) withheld = 'The normal equations of the regression are singular at the optimum.';
  const knobs = {};
  KNOBS.forEach((k, j) => {
    const [lo, hi] = bounds[j];
    const edge = 1e-5 * (hi - lo);
    const atBound = fit.theta[j] <= lo + edge || fit.theta[j] >= hi - edge;
    const se = !withheld && !atBound && Number.isFinite(fit.standardErrors[j]) ? fit.standardErrors[j] : null;
    knobs[k] = {
      value: fit.theta[j],
      standardError: se,
      ci95: se === null ? null : [fit.theta[j] - tValue * se, fit.theta[j] + tValue * se],
      atBound,
      bounds: [lo, hi],
    };
  });
  const uncertainty = {
    method: 'Linearized regression covariance, s^2 (J\'J)^-1 with s^2 = SSR / (m - n)',
    targets: rows.length,
    residuals: m,
    parameters: KNOBS.length,
    dof,
    tValue,
    order: [...KNOBS],
    covariance: cov && !withheld ? cov.map((row) => [...row]) : null,
    withheld,
    knobs,
  };

  return {
    ok: true,
    converged: fit.converged,
    iterations: fit.iterations,
    tuning,
    start,
    ssr0: r0.reduce((s, v) => s + v * v, 0),
    ssr: fit.ssr,
    boundsHit,
    report,
    boBasisPsia: tunedPred.boBasisPsia,
    uncertainty,
  };
}
