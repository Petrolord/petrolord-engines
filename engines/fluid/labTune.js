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

  if (targets.psat) {
    // window from the measured value: cheaper scan, and the boundary of
    // interest cannot sit above ~2x the lab Psat inside the ET bounds
    const window = Number.isFinite(targets.psat.pPsia)
      ? { pMaxPsia: Math.min(12000, 2.5 * targets.psat.pPsia) } : {};
    const sat = saturationPressure(mix, z, degFtoR(targets.psat.tF), window);
    out.psatPsia = sat ? sat.pPsia : null;
  }

  const sep = targets.separatorTest;
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
      // two-phase at lab reservoir conditions: compare at the engine Psat
      const sat = saturationPressure(mix, z, opts.resTR, {});
      if (sat) {
        const resAtSat = separatorTrain(mix, z, stages,
          { resTR: opts.resTR, resPPsia: sat.pPsia * (1 + 1e-6) });
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

/**
 * Fit the four ET knobs to the lab targets.
 *
 * fluid = { keys, plus, z } in engine form (keys may include the trailing
 * 'C7+'; z sums to 1 with the plus fraction last). Returns
 * { ok, converged, iterations, tuning, start, ssr0, ssr, boundsHit, report }
 * — report rows carry measured / untuned / tuned values and percent errors
 * for the UI's before/after table. ok:false (with reason) when no numeric
 * target was supplied or the fluid has no plus fraction.
 */
export function tuneToLab(fluid, targets = {}, opts = {}) {
  if (!fluid?.plus) return { ok: false, reason: 'Tuning needs a C7+ plus fraction.' };
  const rows = collectTargets(targets);
  if (!rows.length) return { ok: false, reason: 'Enter at least one measured lab value.' };

  const start = untunedKnobs(fluid.plus);
  // opts.start: partial knob overrides for the LM starting point (multi-start
  // and "re-tune from the currently applied tuning"). The prior still pulls
  // toward the UNTUNED values, not the start.
  const theta0 = KNOBS.map((k) => start[k]);
  const thetaStart = KNOBS.map((k, j) => (
    Number.isFinite(opts.start?.[k]) ? opts.start[k] : theta0[j]
  ));
  const bounds = KNOBS.map((k) => TUNING_BOUNDS[k]);
  const priorWeight = opts.priorWeight ?? PRIOR_WEIGHT;

  const residualsFn = (theta) => {
    const pred = predictTargets(fluid, targets, thetaToTuning(theta));
    const r = rows.map((row) => residualFor(row, pred));
    KNOBS.forEach((k, j) => {
      r.push(priorWeight * ((theta[j] - theta0[j]) / PRIOR_SCALE[k]));
    });
    return r;
  };

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
  };
}
