import { Spec } from './PhysicsUtils';

/**
 * Expulsion Engine — saturation-bucket primary migration.
 *
 * The source layer retains hydrocarbons up to a pore-volume cap
 * (per unit column area): cap = thickness * phiAvg * S_threshold *
 * rho_HC. Cumulative expelled mass is a MONOTONE state —
 * expelled_t = max(expelled_{t-1}, generated_t - cap_t) — because
 * expelled hydrocarbons never return even when unroofing rebound
 * grows the cap.
 */
export class ExpulsionEngine {

    static retentionCap(thickness, phiAvg) {
        return thickness * phiAvg * Spec.S_EXPULSION_THRESHOLD * Spec.RHO_HC;
    }

    static expelledCumulative(prevExpelled, generatedCumulative, cap) {
        return Math.max(prevExpelled, generatedCumulative - cap);
    }
}
