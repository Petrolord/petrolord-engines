import { tdma, Spec } from './PhysicsUtils';
import { BurialCompactionEngine } from './BurialCompactionEngine';

/**
 * Pressure Engine (Basin & Charge Modeling U2-015): 1D compaction-
 * disequilibrium overpressure on the burial history.
 *
 * Model (single-phase, Gibson 1958 / Bethke 1985 loading form):
 *
 *     S du/dt = d/dz( (k/mu) du/dz ) + S d(sigma_v - p_h)/dt
 *
 * u is the overpressure (pore pressure above hydrostatic), sigma_v the
 * vertical stress from the bulk densities above, p_h the hydrostatic
 * pressure. Undrained loading raises u by the change of the excess
 * load; flow to the drained surface (u = 0 at z = 0) bleeds it off; the
 * base is closed (no flow). Cells are the burial-history slices, which
 * move with the rock (Lagrangian); a slice is deposited drained (u = 0).
 *
 * Properties:
 *  - Storage S = c phi / ((1 - phi)^2 (rho_g - rho_w) g), the uniaxial
 *    framework compressibility of the Athy law under hydrostatic
 *    effective stress (grains and water incompressible).
 *  - Permeability by Kozeny-Carman, k = phi^3 / (5 Ss^2 (1 - phi)^2), with
 *    a specific surface Ss per lithology (order-of-magnitude defaults
 *    below; a layer may carry permeability.ss).
 *  - Water viscosity Spec.MU_WATER.
 *
 * v1 limitation (said in the app): the overpressure does not feed back
 * into compaction (the porosity stays the hydrostatic Athy porosity), so
 * it is an estimate of the pressure the burial rate can trap, not a
 * coupled solution. The solver itself (diffuseStep) is validated against
 * the analytic constant-loading solution (Carslaw and Jaeger).
 */

/** Specific surface of the solid, 1/m (Kozeny-Carman). */
export const SPECIFIC_SURFACE = Object.freeze({
    sandstone: 1.0e5,
    shale: 1.0e8,
    limestone: 1.0e6,
    salt: 1.0e9,
    coal: 1.0e7,
    default: 1.0e7,
});

const own = (t, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(t, k);

export class PressureEngine {
    static specificSurface(layer) {
        const o = Number(layer?.permeability?.ss);
        if (Number.isFinite(o) && o > 0) return o;
        const mix = layer?.lithology === 'mixed' ? layer.lithologyMix : null;
        if (mix) {
            // geometric mean of permeability <=> geometric mean of Ss
            let tot = 0; let acc = 0;
            for (const [k, w] of Object.entries(mix)) {
                const f = Number(w);
                if (!(f > 0)) continue;
                tot += f; acc += f * Math.log(own(SPECIFIC_SURFACE, k) ? SPECIFIC_SURFACE[k] : SPECIFIC_SURFACE.default);
            }
            if (tot > 0) return Math.exp(acc / tot);
        }
        const key = String(layer?.lithology || '').toLowerCase();
        return own(SPECIFIC_SURFACE, key) ? SPECIFIC_SURFACE[key] : SPECIFIC_SURFACE.default;
    }

    static permeability(phi, ss) {
        const p = Math.min(0.95, Math.max(1e-4, phi));
        return Math.max(1e-24, (p ** 3) / (5 * ss * ss * (1 - p) ** 2));
    }

    static storage(phi, c, grainDensity) {
        const p = Math.min(0.95, Math.max(0, phi));
        const s = (c * p) / ((1 - p) ** 2 * (grainDensity - Spec.RHO_WATER) * Spec.G);
        return Math.max(1e-12, s);
    }

    /**
     * One implicit step of S du/dt = d/dz(K du/dz) + S dE/dt on cells.
     * @param {Array<{zc:number, h:number, S:number, K:number}>} cells shallow to deep (K = k/mu)
     * @param {number[]} uOld overpressure per cell (Pa)
     * @param {number[]} dE change of the excess load per cell over the step (Pa)
     * @param {number} dtSec
     * @returns {number[]} new overpressure (Pa)
     */
    static diffuseStep(cells, uOld, dE, dtSec) {
        const n = cells.length;
        if (n === 0) return [];
        const a = new Array(Math.max(0, n - 1)).fill(0);
        const b = new Array(n).fill(0);
        const c = new Array(Math.max(0, n - 1)).fill(0);
        const d = new Array(n).fill(0);
        const harm = (x, y) => (x > 0 && y > 0 ? (2 * x * y) / (x + y) : 0);
        for (let i = 0; i < n; i++) {
            const ci = cells[i];
            const wT = (ci.S * ci.h) / dtSec;
            let diag = wT;
            // top interface: to the surface (drained, u = 0) for the first cell
            if (i === 0) {
                diag += ci.K / Math.max(1e-9, ci.zc);
            } else {
                const up = cells[i - 1];
                const w = harm(up.K, ci.K) / Math.max(1e-9, ci.zc - up.zc);
                diag += w;
                a[i - 1] = -w;
            }
            if (i < n - 1) {
                const dn = cells[i + 1];
                const w = harm(dn.K, ci.K) / Math.max(1e-9, dn.zc - ci.zc);
                diag += w;
                c[i] = -w;
            }
            b[i] = diag;
            d[i] = wT * (uOld[i] + dE[i]);
        }
        return tdma(a, b, c, d);
    }

    /**
     * Advance the overpressure of the column slices one burial-history step.
     * Mutates the per-layer state (u, excess); phantom (eroded) sections get
     * a state of their own while they exist.
     */
    static layerConstants(layer) {
        let k = PressureEngine._cache.get(layer);
        if (!k) {
            k = { c: BurialCompactionEngine.resolveParams(layer).c, ss: PressureEngine.specificSurface(layer) };
            PressureEngine._cache.set(layer, k);
        }
        return k;
    }

    static step(slices, layerStates, dtSec) {
        if (!slices.length) return;
        const cells = []; const uOld = []; const dE = []; const refs = [];
        slices.forEach((s) => {
            const id = s.g.layer.id;
            if (!layerStates[id]) layerStates[id] = { u: [], excess: [] };
            const st = layerStates[id];
            if (st.u[s.j] === undefined) st.u[s.j] = 0;
            if (st.excess[s.j] === undefined) st.excess[s.j] = null;
            const E = s.sigmaMid - Spec.RHO_WATER * Spec.G * s.zc;
            const de = st.excess[s.j] === null ? 0 : E - st.excess[s.j];
            st.excess[s.j] = E;
            const { c, ss } = PressureEngine.layerConstants(s.g.layer);
            cells.push({
                zc: s.zc,
                h: Math.max(1e-6, s.bottom - s.top),
                S: PressureEngine.storage(s.phi, c, s.grainDensity),
                K: PressureEngine.permeability(s.phi, ss) / Spec.MU_WATER,
            });
            uOld.push(st.u[s.j]);
            dE.push(de);
            refs.push([st, s.j]);
        });
        const u = PressureEngine.diffuseStep(cells, uOld, dE, dtSec);
        refs.forEach(([st, j], i) => { st.u[j] = u[i]; });
    }
}

PressureEngine._cache = new WeakMap();
