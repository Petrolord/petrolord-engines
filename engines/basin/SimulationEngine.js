import { BurialCompactionEngine } from './BurialCompactionEngine';
import { HeatTransportEngine } from './HeatTransportEngine';
import { MaturityEngine } from './MaturityEngine';
import { ExpulsionEngine } from './ExpulsionEngine';
import { getThermalProps } from './ThermalPropertiesLibrary';
import { Spec } from './PhysicsUtils';

/**
 * Forward basin model per the G7 spec pinned in
 * tools/validation/basinflow/oracle.py (the independent Python oracle
 * this engine's jest suite validates against). Model summary:
 *
 *  - Layers appear instantaneously at ageStart; time steps DT_MA from
 *    the oldest ageStart down to 0.
 *  - Geometry: solid-thickness-conserving Athy decompaction, top down.
 *    V1 limitation (deliberate, documented): compaction is elastic in
 *    depth — unroofed layers re-expand; max-burial hysteresis is a
 *    recorded follow-on.
 *  - Heat: cell-centred grid (cells <= MAX_CELL_M per layer) plus a
 *    surface node; porosity-weighted effective properties; first solve
 *    is steady-state, later steps backward Euler with the previous
 *    profile interpolated onto the new grid (basal-gradient
 *    extrapolation below the old bottom). Basal heat flow follows
 *    heatFlow.history (piecewise-linear in age) when type='variable'.
 *  - Erosion event {age, amount}: a phantom shale section (deposited
 *    thickness `amount`) appears at the youngest pre-event ageEnd and
 *    is removed at the event age; it deepens and heats the layers
 *    below during the hiatus and is not reported.
 *  - Kinetics at each layer's centre temperature: Easy%Ro vitrinite
 *    state -> Ro; kerogen-type potentials -> TR -> mass generation
 *    (rho_grain * Hs * TOC/100 * HI/1000 per m2) -> monotone
 *    saturation-bucket expulsion.
 */
export class SimulationEngine {

    static resolveThermal(layer) {
        const lib = getThermalProps(layer.lithology);
        const o = layer.thermal || {};
        return {
            conductivity: Number.isFinite(o.conductivity) ? o.conductivity : lib.conductivity,
            radiogenic: Number.isFinite(o.radiogenic) ? o.radiogenic : lib.radiogenic,
            heatCapacity: Number.isFinite(o.heatCapacity) ? o.heatCapacity : lib.heatCapacity,
        };
    }

    static heatFlowAt(heatFlow, age) {
        if (heatFlow?.type === 'variable' && Array.isArray(heatFlow.history) && heatFlow.history.length > 0) {
            const pts = heatFlow.history
                .map(p => ({ x: p.age, y: p.value }))
                .sort((a, b) => a.x - b.x);
            if (age <= pts[0].x) return pts[0].y / 1000;
            if (age >= pts[pts.length - 1].x) return pts[pts.length - 1].y / 1000;
            for (let i = 0; i < pts.length - 1; i++) {
                if (age >= pts[i].x && age <= pts[i + 1].x) {
                    const f = (age - pts[i].x) / (pts[i + 1].x - pts[i].x);
                    return (pts[i].y + f * (pts[i + 1].y - pts[i].y)) / 1000;
                }
            }
        }
        return (heatFlow?.value ?? 60) / 1000;
    }

    static buildPhantoms(layers, erosionEvents) {
        const phantoms = [];
        (erosionEvents || []).forEach((ev, idx) => {
            const age = Number(ev.age);
            const amount = Number(ev.amount);
            if (!(amount > 0) || !Number.isFinite(age)) return;
            const ends = layers
                .map(l => Number(l.ageEnd))
                .filter(e => Number.isFinite(e) && e > age);
            if (ends.length === 0) return;
            const depositAge = Math.min(...ends);
            const { phi0, c } = BurialCompactionEngine.resolveParams({ lithology: 'shale' });
            phantoms.push({
                id: `__phantom_${idx}`,
                name: `Eroded section ${idx}`,
                lithology: 'shale',
                ageStart: depositAge,
                erodeAge: age,
                solidThickness: BurialCompactionEngine.solidThickness(0, amount, phi0, c),
                phantom: true,
            });
        });
        return phantoms;
    }

    static interpProfile(profile, basalGrad, z) {
        const n = profile.length;
        if (n === 0) return 0;
        if (z <= profile[0].z) return profile[0].t;
        if (z > profile[n - 1].z) {
            return profile[n - 1].t + basalGrad * (z - profile[n - 1].z);
        }
        for (let i = 0; i < n - 1; i++) {
            if (z >= profile[i].z && z <= profile[i + 1].z) {
                const dz = profile[i + 1].z - profile[i].z;
                if (dz === 0) return profile[i].t;
                return profile[i].t + (z - profile[i].z) * (profile[i + 1].t - profile[i].t) / dz;
            }
        }
        return profile[n - 1].t;
    }

    static async run(project, onProgress) {
        if (!project || !Array.isArray(project.stratigraphy) || project.stratigraphy.length === 0) {
            throw new Error("Invalid project data: Stratigraphy is missing.");
        }
        const surfaceT = Number.isFinite(project.settings?.surfaceTemp)
            ? project.settings.surfaceTemp
            : Spec.DEFAULT_SURFACE_TEMP_C;

        // Present-day solid thicknesses: stratigraphic order, youngest first.
        const presentOrder = [...project.stratigraphy]
            .sort((a, b) => (a.ageStart || 0) - (b.ageStart || 0));
        const initialized = BurialCompactionEngine.initializeSolidThickness(presentOrder);

        // Reporting order: oldest first (stable contract for meta/data).
        const chronologicalLayers = [...initialized]
            .sort((a, b) => (b.ageStart || 0) - (a.ageStart || 0));

        const phantoms = SimulationEngine.buildPhantoms(chronologicalLayers, project.erosionEvents);
        const allLayers = [...chronologicalLayers, ...phantoms];

        const maxAge = Math.max(...chronologicalLayers.map(l => l.ageStart || 0));

        const history = {
            timeSteps: [],
            burial: chronologicalLayers.map(() => []),
            temperature: chronologicalLayers.map(() => []),
            maturity: chronologicalLayers.map(() => []),
            transformation: chronologicalLayers.map(() => []),
            generation: chronologicalLayers.map(() => []),
            expulsion: chronologicalLayers.map(() => []),
        };
        const indexById = new Map(chronologicalLayers.map((l, i) => [l.id, i]));

        const layerStates = {};
        chronologicalLayers.forEach(l => {
            const sr = l.sourceRock;
            const state = {
                maturity: MaturityEngine.initializeState(sr?.kerogen || 'type2'),
                expelled: 0,
                potentialMass: 0,
            };
            if (sr?.isSource) {
                const { grainDensity } = BurialCompactionEngine.resolveParams(l);
                state.potentialMass = grainDensity * l.solidThickness
                    * ((Number(sr.toc) || 0) / 100)
                    * ((Number(sr.hi) || 0) / 1000);
            }
            layerStates[l.id] = state;
        });

        let prevProfile = null;   // [{z, t}] sorted by z
        let prevBasalGrad = 0;

        for (let t = maxAge; t >= -1e-9; t -= Spec.DT_MA) {
            const currentTime = Math.max(0, t);

            const active = allLayers.filter(l => {
                if ((l.ageStart || 0) < currentTime - 1e-9) return false;
                if (l.phantom && currentTime <= l.erodeAge + 1e-9) return false;
                return true;
            }).sort((a, b) => (a.ageStart || 0) - (b.ageStart || 0));

            // Geometry, top down.
            let depth = 0;
            const geo = active.map(layer => {
                const props = BurialCompactionEngine.calculateLayerProperties(layer, depth);
                depth = props.bottomDepth;
                return { layer, ...props };
            });

            // Thermal grid: surface node + cell-centred nodes.
            const nodes = [];
            if (geo.length > 0) {
                const firstComp = BurialCompactionEngine.resolveParams(geo[0].layer);
                const firstTherm = SimulationEngine.resolveThermal(geo[0].layer);
                nodes.push({
                    z: 0,
                    k: HeatTransportEngine.effectiveConductivity(
                        firstTherm.conductivity,
                        BurialCompactionEngine.porosity(0, firstComp.phi0, firstComp.c)),
                    rhoCp: 1,
                    aVol: 0,
                });
                geo.forEach(g => {
                    const comp = BurialCompactionEngine.resolveParams(g.layer);
                    const therm = SimulationEngine.resolveThermal(g.layer);
                    // - 1e-9 so thicknesses landing exactly on a cell
                    // boundary resolve identically to the oracle
                    const m = Math.max(1, Math.ceil(g.thickness / Spec.MAX_CELL_M - 1e-9));
                    const dz = g.thickness / m;
                    for (let j = 0; j < m; j++) {
                        const zc = g.topDepth + (j + 0.5) * dz;
                        const phi = BurialCompactionEngine.porosity(zc, comp.phi0, comp.c);
                        nodes.push({
                            z: zc,
                            k: HeatTransportEngine.effectiveConductivity(therm.conductivity, phi),
                            rhoCp: HeatTransportEngine.volumetricHeatCapacity(phi, comp.grainDensity, therm.heatCapacity),
                            aVol: therm.radiogenic * (1 - phi),
                        });
                    }
                });
            }

            const basalQ = SimulationEngine.heatFlowAt(project.heatFlow, currentTime);

            let temps;
            if (prevProfile === null) {
                temps = HeatTransportEngine.solve(nodes, null, surfaceT, basalQ, null);
            } else {
                const tOld = nodes.map(nd =>
                    SimulationEngine.interpProfile(prevProfile, prevBasalGrad, nd.z));
                temps = HeatTransportEngine.solve(
                    nodes, Spec.DT_MA * Spec.SECONDS_PER_MA, surfaceT, basalQ, tOld);
            }

            const profile = nodes
                .map((nd, i) => ({ z: nd.z, t: temps[i] }))
                .sort((a, b) => a.z - b.z);
            prevProfile = profile;
            prevBasalGrad = nodes.length > 0 ? basalQ / nodes[nodes.length - 1].k : 0;

            // Kinetics + bookkeeping (real layers only).
            geo.forEach(g => {
                if (g.layer.phantom) return;
                const layerIndex = indexById.get(g.layer.id);
                const state = layerStates[g.layer.id];
                const zc = (g.topDepth + g.bottomDepth) / 2;
                const tC = SimulationEngine.interpProfile(profile, prevBasalGrad, zc);

                state.maturity = MaturityEngine.step(state.maturity, tC + 273.15, Spec.DT_MA);

                // TR/generation/expulsion are source-rock quantities;
                // non-source layers report zeros (oracle contract).
                const isSource = !!g.layer.sourceRock?.isSource;
                let generated = 0;
                const tr = isSource ? state.maturity.totalTransformation : 0;
                if (isSource) {
                    generated = state.potentialMass * tr;
                    const cap = ExpulsionEngine.retentionCap(g.thickness, g.phiAvg);
                    state.expelled = ExpulsionEngine.expelledCumulative(state.expelled, generated, cap);
                }

                history.burial[layerIndex].push({
                    age: currentTime,
                    top: g.topDepth,
                    bottom: g.bottomDepth,
                    thickness: g.thickness,
                });
                history.temperature[layerIndex].push({ age: currentTime, value: tC, depth: zc });
                history.maturity[layerIndex].push({ age: currentTime, value: state.maturity.Ro });
                history.transformation[layerIndex].push({ age: currentTime, value: tr });
                history.generation[layerIndex].push({ age: currentTime, value: generated });
                history.expulsion[layerIndex].push({ age: currentTime, value: state.expelled });
            });

            history.timeSteps.push(currentTime);
            if (onProgress) onProgress(maxAge > 0 ? ((maxAge - currentTime) / maxAge) * 100 : 100);
        }

        const bottoms = history.burial.flat().map(b => b.bottom);
        return {
            meta: {
                layers: chronologicalLayers.map(l => ({ id: l.id, name: l.name, lithology: l.lithology, color: l.color })),
                maxDepth: bottoms.length > 0 ? Math.max(...bottoms) : 0,
            },
            data: history,
        };
    }
}
