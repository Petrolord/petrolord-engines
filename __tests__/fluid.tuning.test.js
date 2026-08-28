/**
 * ET1 tuning-seam gates (plan of record: FluidSystemsStudio-STATUS.md, ET
 * program). The load-bearing contracts:
 *   1. Absent/identity tuning is BITWISE identical to the untuned path,
 *      through every consumer seam (flash, separator, saturation pressure).
 *      The envelope WORKER and the eosAnalysis request plumbing are Suite
 *      seams rather than engine code, so their identity gates stay in the
 *      Suite's own suite alongside the modules they exercise.
 *   2. A volume-shift-only tune changes densities but NOT the phase split
 *      (Peneloux is volumes-only in PR78) - the two-stage decoupling the
 *      ET2 regression leans on.
 *   3. Knobs move the physics in the right direction and only via the
 *      plus fraction; library components stay untouched.
 */
import {
  normalizeTuning, tunedPlusCharacterization, tunedMixtureWithPlusFraction, TUNING_BOUNDS,
} from '../engines/fluid/tuning.js';
import { characterizePlusFraction, mixtureWithPlusFraction } from '../engines/fluid/characterization.js';
import { COMPONENTS } from '../engines/fluid/components.js';
import { flashPT } from '../engines/fluid/flash.js';
import { saturationPressure } from '../engines/fluid/envelope.js';
import { separatorTrain } from '../engines/fluid/separator.js';
import { degFtoR } from '../engines/fluid/units.js';

// The char-oil goldens fluid (FS4) - a realistic tuning subject.
const KEYS = ['CO2', 'N2', 'C1', 'C2', 'C3', 'nC4', 'nC5', 'nC6'];
const Z = [0.01, 0.005, 0.35, 0.06, 0.045, 0.04, 0.03, 0.035, 0.425];
const PLUS = { mw: 210, sg: 0.85 };
const T_R = degFtoR(200);

describe('normalizeTuning', () => {
  it('returns null for absent, non-object, and identity inputs', () => {
    expect(normalizeTuning(undefined)).toBeNull();
    expect(normalizeTuning(null)).toBeNull();
    expect(normalizeTuning('x')).toBeNull();
    expect(normalizeTuning({})).toBeNull();
    expect(normalizeTuning({ fTc: 1, fPc: 1 })).toBeNull();
    expect(normalizeTuning({ fTc: '1', junk: 3 })).toBeNull();
  });

  it('parses strings, keeps absolute knobs null when absent, clamps to bounds', () => {
    const t = normalizeTuning({ fTc: '1.05', fPc: 0.9 });
    expect(t).toEqual({ fTc: 1.05, fPc: 0.9, kC1: null, sPlus: null });
    const clamped = normalizeTuning({ fTc: 9, fPc: 0, kC1: -1, sPlus: 99 });
    expect(clamped.fTc).toBe(TUNING_BOUNDS.fTc[1]);
    expect(clamped.fPc).toBe(TUNING_BOUNDS.fPc[0]);
    expect(clamped.kC1).toBe(TUNING_BOUNDS.kC1[0]);
    expect(clamped.sPlus).toBe(TUNING_BOUNDS.sPlus[1]);
  });
});

describe('identity: no tuning is bitwise the untuned path', () => {
  it('tunedPlusCharacterization without tuning returns the plain characterization', () => {
    expect(tunedPlusCharacterization(PLUS, null)).toEqual(characterizePlusFraction(PLUS));
    expect(tunedPlusCharacterization(PLUS, { fTc: 1, fPc: 1 })).toEqual(characterizePlusFraction(PLUS));
  });

  it('flash, Psat and separator results are identical through the mixture seam', () => {
    const untuned = mixtureWithPlusFraction(KEYS, PLUS);
    const seam = tunedMixtureWithPlusFraction(KEYS, PLUS, null);
    expect(flashPT(seam, Z, T_R, 2000)).toEqual(flashPT(untuned, Z, T_R, 2000));
    expect(saturationPressure(seam, Z, T_R, {})).toEqual(saturationPressure(untuned, Z, T_R, {}));
    const stages = [{ tR: degFtoR(75), pPsia: 114.7 }];
    expect(separatorTrain(seam, Z, stages)).toEqual(separatorTrain(untuned, Z, stages));
  });
});

describe('tuning moves the physics through the plus fraction only', () => {
  it('applies multipliers/overrides to the pseudo and leaves the library untouched', () => {
    const t = { fTc: 1.05, fPc: 0.9, kC1: 0.08, sPlus: 0.02 };
    const base = characterizePlusFraction(PLUS);
    const tuned = tunedPlusCharacterization(PLUS, t);
    expect(tuned.comp.tcR).toBeCloseTo(base.comp.tcR * 1.05, 10);
    expect(tuned.comp.pcPsia).toBeCloseTo(base.comp.pcPsia * 0.9, 10);
    expect(tuned.comp.shift).toBe(0.02);
    expect(tuned.bip.C1).toBe(0.08);
    expect(tuned.comp.mw).toBe(base.comp.mw);
    expect(tuned.bip.CO2).toBe(base.bip.CO2);
    expect(COMPONENTS.C1.tcR).toBeCloseTo(343.01, 10);
    const mix = tunedMixtureWithPlusFraction(KEYS, PLUS, t);
    const c1 = mix.comps.find((c) => c.key === 'C1');
    expect(c1.tcR).toBe(COMPONENTS.C1.tcR);
  });

  it('raising the C1-C7+ BIP raises the oil bubble point', () => {
    const base = saturationPressure(mixtureWithPlusFraction(KEYS, PLUS), Z, T_R, {});
    const bumped = saturationPressure(
      tunedMixtureWithPlusFraction(KEYS, PLUS, { kC1: 0.12 }), Z, T_R, {},
    );
    expect(base.kind).toBe('bubble');
    expect(bumped.kind).toBe('bubble');
    expect(bumped.pPsia).toBeGreaterThan(base.pPsia);
  });

  it('a shift-only tune changes densities but not the phase split (Peneloux decoupling)', () => {
    const untuned = mixtureWithPlusFraction(KEYS, PLUS);
    const shifted = tunedMixtureWithPlusFraction(KEYS, PLUS, { sPlus: 0.15 });
    const a = flashPT(untuned, Z, T_R, 2000);
    const b = flashPT(shifted, Z, T_R, 2000);
    expect(b.phases).toBe(a.phases);
    expect(b.beta).toBe(a.beta);
    expect(b.K).toEqual(a.K);
    expect(b.x).toEqual(a.x);
    expect(b.liquid.density).not.toBe(a.liquid.density);
  });
});

