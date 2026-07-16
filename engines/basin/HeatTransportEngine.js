import { tdma, Spec } from './PhysicsUtils';

/**
 * Heat Transport Engine
 * 1D conduction on a cell-centred non-uniform grid: implicit backward
 * Euler (or steady state when dtSec is null), harmonic-mean interface
 * conductivities, Dirichlet surface node at z = 0, Neumann basal heat
 * flow through the harmonic mean of the last two nodes.
 *
 * Effective properties (porosity-weighted) are the CALLER's job — this
 * solver takes nodes as given.
 */
export class HeatTransportEngine {

    /**
     * @param {Array} nodes - [{z, k, rhoCp, aVol}] with nodes[0] the
     *   surface node at z = 0
     * @param {number|null} dtSec - time step in seconds; null solves
     *   the steady state (time term dropped)
     * @param {number} topTemp - surface temperature (C)
     * @param {number} basalHeatFlow - basal heat flow (W/m2)
     * @param {Array|null} tOld - previous temperature per node
     * @returns {Array} temperatures per node (C)
     */
    static solve(nodes, dtSec, topTemp, basalHeatFlow, tOld) {
        const n = nodes.length;
        if (n === 0) return [];
        if (n === 1) return [topTemp];

        const a = new Array(n - 1).fill(0); // Lower diag
        const b = new Array(n).fill(0);     // Main diag
        const c = new Array(n - 1).fill(0); // Upper diag
        const d = new Array(n).fill(0);     // RHS

        // Top: Dirichlet surface node
        b[0] = 1;
        c[0] = 0;
        d[0] = topTemp;

        for (let i = 1; i < n - 1; i++) {
            const node = nodes[i];
            const prev = nodes[i - 1];
            const next = nodes[i + 1];

            const dzUp = node.z - prev.z;
            const dzDown = next.z - node.z;
            const dzAvg = (dzUp + dzDown) / 2;

            // Harmonic mean conductivities at interfaces
            const kUp = 2 * (node.k * prev.k) / (node.k + prev.k);
            const kDown = 2 * (node.k * next.k) / (node.k + next.k);

            const wUp = kUp / (dzUp * dzAvg);
            const wDown = kDown / (dzDown * dzAvg);
            const wTime = dtSec !== null ? node.rhoCp / dtSec : 0;

            a[i - 1] = -wUp;
            b[i] = wTime + wUp + wDown;
            c[i] = -wDown;
            d[i] = node.aVol + (dtSec !== null ? wTime * tOld[i] : 0);
        }

        // Bottom: Neumann fixed heat flow
        // (T_n - T_{n-1}) / dz = Q / k_harm
        const last = nodes[n - 1];
        const beforeLast = nodes[n - 2];
        const dzLast = last.z - beforeLast.z;
        const kHarm = 2 * (last.k * beforeLast.k) / (last.k + beforeLast.k);
        a[n - 2] = -1;
        b[n - 1] = 1;
        d[n - 1] = (basalHeatFlow * dzLast) / kHarm;

        return tdma(a, b, c, d);
    }

    static effectiveConductivity(kMatrix, phi) {
        return Math.pow(kMatrix, 1 - phi) * Math.pow(Spec.K_WATER, phi);
    }

    static volumetricHeatCapacity(phi, rhoGrain, cpMatrix) {
        return phi * Spec.RHO_WATER * Spec.CP_WATER + (1 - phi) * rhoGrain * cpMatrix;
    }
}
