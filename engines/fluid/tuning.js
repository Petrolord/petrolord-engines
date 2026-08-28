/**
 * EOS tuning to lab data — ET1 seam (plan of record:
 * docs/scope/FluidSystemsStudio-STATUS.md, ET program section).
 *
 * Tuning is plain data with exactly four knobs, applied to the C7+ plus
 * fraction ONLY (library components are never touched):
 *
 *   { fTc, fPc, kC1, sPlus }
 *
 *   fTc    multiplier on the characterized pseudo's Tc      [0.85, 1.15]
 *   fPc    multiplier on the characterized pseudo's Pc      [0.70, 1.30]
 *   kC1    absolute C1-C7+ BIP (replaces Chueh-Prausnitz)   [0, 0.25]
 *   sPlus  absolute C7+ volume shift s = c/b (replaces J-Y) [-0.30, 0.40]
 *
 * This module is the ONE place tuning touches the thermodynamics: it
 * post-processes a characterizePlusFraction result before the mixture is
 * assembled. Both mixture seams (eosAnalysis.buildMixture for the sync
 * consumers, envelope.worker for the trace) route plus-fraction fluids
 * through tunedMixtureWithPlusFraction so every consumer sees the same
 * tuned fluid. An absent or identity tuning MUST leave results bitwise
 * identical to the untuned path (gated in jest and harness CASE 23).
 */

import { characterizePlusFraction, mixtureWithPlusFraction } from './characterization.js';

/** Bounds, shared by the ET2 regression and UI validation. */
export const TUNING_BOUNDS = {
  fTc: [0.85, 1.15],
  fPc: [0.7, 1.3],
  kC1: [0, 0.25],
  sPlus: [-0.3, 0.4],
};

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Normalize raw tuning state (UI/persisted, possibly strings or partial)
 * into a clean {fTc, fPc, kC1, sPlus} object, or null when there is
 * nothing to apply (absent, disabled, or identity within float noise).
 * Values are clamped to TUNING_BOUNDS: persisted state from a future
 * version or hand-edited payloads must never push the EOS outside the
 * regression box.
 */
export function normalizeTuning(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const clamp = (v, [lo, hi]) => Math.min(Math.max(v, lo), hi);
  const fTc = Number(raw.fTc);
  const fPc = Number(raw.fPc);
  const kC1 = Number(raw.kC1);
  const sPlus = Number(raw.sPlus);
  const out = {
    fTc: isFiniteNumber(fTc) ? clamp(fTc, TUNING_BOUNDS.fTc) : 1,
    fPc: isFiniteNumber(fPc) ? clamp(fPc, TUNING_BOUNDS.fPc) : 1,
    kC1: isFiniteNumber(kC1) ? clamp(kC1, TUNING_BOUNDS.kC1) : null,
    sPlus: isFiniteNumber(sPlus) ? clamp(sPlus, TUNING_BOUNDS.sPlus) : null,
  };
  const identity = out.fTc === 1 && out.fPc === 1 && out.kC1 === null && out.sPlus === null;
  return identity ? null : out;
}

/**
 * Characterize the plus fraction and apply tuning to the result. With a
 * null/absent tuning this IS characterizePlusFraction (same object path,
 * bitwise identical downstream). kC1/sPlus are absolute replacements
 * (null = keep the correlation value); fTc/fPc are multipliers.
 */
export function tunedPlusCharacterization(plus, tuning, opts = {}) {
  const ch = plus.comp ? plus : characterizePlusFraction(plus, opts);
  const t = normalizeTuning(tuning);
  if (!t) return ch;
  return {
    comp: {
      ...ch.comp,
      tcR: ch.comp.tcR * t.fTc,
      pcPsia: ch.comp.pcPsia * t.fPc,
      ...(t.sPlus !== null ? { shift: t.sPlus } : {}),
    },
    bip: t.kC1 !== null ? { ...ch.bip, C1: t.kC1 } : ch.bip,
    meta: { ...ch.meta, tuning: t },
  };
}

/**
 * Assemble the EOS mixture for a plus-fraction fluid with tuning applied.
 * Drop-in for mixtureWithPlusFraction; both mixture seams call this.
 */
export function tunedMixtureWithPlusFraction(baseKeys, plus, tuning, opts = {}) {
  return mixtureWithPlusFraction(baseKeys, tunedPlusCharacterization(plus, tuning, opts), opts);
}
