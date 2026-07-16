import { getCompactionParams } from './CompactionModelLibrary';

/**
 * Burial & Compaction Engine
 * Athy/Sclater-Christie exponential porosity, solid-thickness
 * conservation, Newton-Raphson decompaction (the validation oracle
 * inverts the same integral by bisection — deliberately different
 * method, tools/validation/basinflow/oracle.py).
 *
 * Input layer thickness = PRESENT-DAY thickness; solid thickness is
 * derived once from the present-day stack (top down) and is invariant
 * through the simulation.
 */
export class BurialCompactionEngine {

    /** Per-layer compaction params: explicit override, else lithology library. */
    static resolveParams(layer) {
        const lib = getCompactionParams(layer.lithology);
        const o = layer.compaction || {};
        return {
            phi0: Number.isFinite(o.phi0) ? o.phi0 : lib.phi0,
            c: Number.isFinite(o.c) ? o.c : lib.c,
            grainDensity: Number.isFinite(o.grainDensity) ? o.grainDensity : lib.grainDensity,
        };
    }

    static porosity(z, phi0, c) {
        return phi0 * Math.exp(-c * z);
    }

    /** Hs = integral_top^{top+H} (1 - phi0 e^{-cz}) dz (analytic). */
    static solidThickness(top, thickness, phi0, c) {
        if (c === 0) return thickness * (1 - phi0);
        return thickness + (phi0 / c) * Math.exp(-c * top) * (Math.exp(-c * thickness) - 1);
    }

    /**
     * Given a layer's invariant solid thickness and its current top
     * depth, find its compacted thickness and average properties.
     */
    static calculateLayerProperties(layer, topDepth) {
        const { phi0, c, grainDensity } = BurialCompactionEngine.resolveParams(layer);
        const Hs = layer.solidThickness;

        // Newton-Raphson on f(H) = solidThickness(top, H) - Hs
        // df/dH = 1 - phi(top + H)
        let H = Hs * 1.5;
        for (let i = 0; i < 50; i++) {
            const f = BurialCompactionEngine.solidThickness(topDepth, H, phi0, c) - Hs;
            const df = 1 - BurialCompactionEngine.porosity(topDepth + H, phi0, c);
            const dH = f / df;
            H = H - dH;
            if (Math.abs(dH) < 1e-8) break;
        }

        const bottomDepth = topDepth + H;
        const phiTop = BurialCompactionEngine.porosity(topDepth, phi0, c);
        const phiBottom = BurialCompactionEngine.porosity(bottomDepth, phi0, c);
        const phiAvg = (phiTop + phiBottom) / 2;

        return {
            thickness: H,
            topDepth,
            bottomDepth,
            phiAvg,
            grainDensity,
        };
    }

    /**
     * Derive each layer's invariant solid thickness from the
     * PRESENT-DAY stack. `layers` must be in stratigraphic order,
     * youngest (shallowest) first. Returns NEW layer objects — callers
     * must use the returned array (the pre-G7 engine discarded it,
     * which made every simulation output NaN).
     */
    static initializeSolidThickness(layers) {
        let currentDepth = 0;
        return layers.map(layer => {
            const { phi0, c } = BurialCompactionEngine.resolveParams(layer);
            const top = currentDepth;
            const Hs = BurialCompactionEngine.solidThickness(top, layer.thickness, phi0, c);
            currentDepth = top + layer.thickness;
            return {
                ...layer,
                solidThickness: Hs,
                presentTop: top,
                presentBottom: currentDepth,
            };
        });
    }
}
