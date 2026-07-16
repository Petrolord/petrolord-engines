import { ActivationEnergies, EasyRoFrequencyFactor, EasyRoWeights, getKerogenParams } from './KerogenLibrary';
import { Spec } from './PhysicsUtils';

/**
 * Maturity Engine — Easy%Ro (Sweeney & Burnham 1990) + generation TR.
 *
 * Carries TWO parallel first-order Arrhenius integrations per layer:
 *  - a VITRINITE state (fixed published Easy%Ro weights) -> F -> %Ro,
 *  - the KEROGEN-TYPE state (library potentials) -> transformation
 *    ratio, which drives mass generation (never %Ro).
 *
 * Arrhenius exponent uses E in J/mol (kcal * 4184) with R = 8.314
 * J/(mol*K) — the pre-G7 engine used R = 1.987 with E in kcal, an
 * exponent 1000x too small (every bin reacted instantly).
 */
export class MaturityEngine {

    static arrheniusRate(aFactor, eKcal, tempK) {
        return aFactor * Math.exp(-(eKcal * Spec.KCAL_TO_J) / (Spec.R_GAS * tempK));
    }

    /**
     * Advance a set of unreacted fractions one step at constant T.
     */
    static kineticStep(fractions, aFactor, tempK, dtMa) {
        const dtSec = dtMa * Spec.SECONDS_PER_MA;
        return fractions.map((x, i) =>
            x * Math.exp(-MaturityEngine.arrheniusRate(aFactor, ActivationEnergies[i], tempK) * dtSec)
        );
    }

    static roFromF(fReacted) {
        return Math.exp(-1.6 + 3.7 * fReacted);
    }

    /**
     * Initialize reaction state for a newly deposited layer.
     */
    static initializeState(kerogenType) {
        const params = getKerogenParams(kerogenType);
        return {
            vitrinite: [...EasyRoWeights],
            kerogen: [...params.potentials],
            aFactor: params.aFactor || 1.0e13,
            potentials: params.potentials,
            Ro: MaturityEngine.roFromF(0),
            totalTransformation: 0,
        };
    }

    /**
     * One simulation step at constant T (K) for dtMa million years.
     */
    static step(state, tempK, dtMa) {
        const vitrinite = MaturityEngine.kineticStep(state.vitrinite, EasyRoFrequencyFactor, tempK, dtMa);
        const f = EasyRoWeights.reduce((acc, w, i) => acc + (w - vitrinite[i]), 0);
        const ro = MaturityEngine.roFromF(f);

        const kerogen = MaturityEngine.kineticStep(state.kerogen, state.aFactor, tempK, dtMa);
        const initialSum = state.potentials.reduce((a, b) => a + b, 0);
        const tr = initialSum > 0 ? 1 - kerogen.reduce((a, b) => a + b, 0) / initialSum : 0;

        return {
            ...state,
            vitrinite,
            kerogen,
            Ro: Math.max(state.Ro, ro), // Ro never decreases
            totalTransformation: Math.max(0, Math.min(1, tr)),
        };
    }
}
