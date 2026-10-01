import { BurialCompactionEngine } from './BurialCompactionEngine';
import { HeatTransportEngine } from './HeatTransportEngine';
import { MaturityEngine } from './MaturityEngine';
import { ExpulsionEngine } from './ExpulsionEngine';
import { getThermalProps, mixThermalProps } from './ThermalPropertiesLibrary';
import { Spec } from './PhysicsUtils';
import { PressureEngine } from './PressureEngine';

/**
 * Forward basin model per the G7 spec pinned in
 * tools/validation/basinflow/oracle.py (the independent Python oracle
 * this engine's jest suite validates against). Model summary:
 *
 *  - Layers appear instantaneously at ageStart; time steps DT_MA from
 *    the oldest ageStart down to 0. The schedule always ENDS AT 0: a
 *    basal age that is not a whole number of steps (ICS ages such as
 *    145.5 or 251.902 Ma) gets a shorter last step onto the present
 *    (timeSchedule). Before BF-U1-001 the loop stopped at the fraction
 *    (0.5 Ma for a 145.5 Ma basin), so "present day" was 0.5 Ma and a
 *    layer younger than the fraction (the Holocene) never deposited.
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
        const lib = layer.lithology === 'mixed' && layer.lithologyMix
            ? mixThermalProps(layer.lithologyMix)
            : getThermalProps(layer.lithology);
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
        // binary search for the segment [i, i+1] holding z (the first such
        // segment, as the linear scan it replaces)
        let lo = 0; let hi = n - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (profile[mid].z < z) lo = mid; else hi = mid;
        }
        const i = lo;
        const dz = profile[i + 1].z - profile[i].z;
        if (dz === 0) return profile[i].t;
        return profile[i].t + (z - profile[i].z) * (profile[i + 1].t - profile[i].t) / dz;
    }

    /**
     * Ages of the simulation steps, oldest first, ending at exactly 0, and
     * the length of each step in Ma (the first step's dt is DT_MA, as the
     * first kinetics step always was). Whole-step basins are unchanged.
     * @returns {{ ages: number[], dts: number[] }}
     */
    static timeSchedule(maxAge) {
        const ages = [];
        const top = Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 0;
        for (let i = 0; ; i++) {
            const t = Number((top - i * Spec.DT_MA).toFixed(9));
            if (t <= 1e-9) break;
            ages.push(t);
        }
        ages.push(0);
        const dts = ages.map((a, i) => (i === 0 ? Spec.DT_MA : Number((ages[i - 1] - a).toFixed(9))));
        return { ages, dts };
    }

    /**
     * Sub-cells of a layer for the column profile (U2-004): equal solid
     * slices, about Spec.MAX_CELL_M thick at the present day, so a thick
     * layer has a Ro and temperature through its whole thickness rather
     * than one value at its centre.
     */
    static columnSlices(layer) {
        const h = Number(layer.thickness);
        return Math.max(1, Math.ceil((Number.isFinite(h) ? h : 0) / Spec.MAX_CELL_M - 1e-9));
    }

    /**
     * Geometry of the (sub)slices of one layer whose top sits at `top`.
     * In 'irreversible' compaction the layer keeps the thickness it had at
     * its deepest burial (`maxTop`): the slices are laid out at the
     * maximum-burial top and shifted up rigidly by the uplift.
     */
    static sliceGeometry(layer, top, effTop, n, guesses = null) {
        const { phi0, c } = BurialCompactionEngine.resolveParams(layer);
        const shift = effTop - top;
        const out = new Array(n);
        let z = effTop;
        const hs = layer.solidThickness / n;
        for (let j = 0; j < n; j++) {
            // Newton on solidThickness(z, H) = hs (as calculateLayerProperties)
            let H = guesses && guesses[j] > 0 ? guesses[j] : hs * 1.5;
            for (let i = 0; i < 50; i++) {
                const f = BurialCompactionEngine.solidThickness(z, H, phi0, c) - hs;
                const dH = f / (1 - BurialCompactionEngine.porosity(z + H, phi0, c));
                H -= dH;
                if (Math.abs(dH) < 1e-8) break;
            }
            const zc = z + H / 2;
            out[j] = { top: z - shift, bottom: z + H - shift, phiMid: BurialCompactionEngine.porosity(zc, phi0, c) };
            if (guesses) guesses[j] = H;
            z += H;
        }
        return out;
    }

    static async run(project, onProgress, opts = {}) {
        if (!project || !Array.isArray(project.stratigraphy) || project.stratigraphy.length === 0) {
            throw new Error("Invalid project data: Stratigraphy is missing.");
        }
        const mode = project.settings?.compaction === 'irreversible' ? 'irreversible' : 'elastic';
        if (mode === 'elastic') {
            const r = await SimulationEngine.runOnce(project, onProgress, null, opts);
            r.meta.compaction = { mode, iterations: 1, presentThicknessErrorM: 0 };
            return r;
        }
        // U2-005: in irreversible compaction a layer's present porosity is set
        // by its deepest burial, so the solid thickness that reproduces the
        // present thickness is found at the maximum-burial top. Fixed point:
        // run, take each layer's maximum-burial top, re-derive the solid
        // thickness there, run again until the modelled present thickness
        // matches the input.
        let maxTops = null;
        let r = null;
        let err = Infinity;
        let it = 0;
        for (it = 1; it <= 8; it++) {
            r = await SimulationEngine.runOnce(project, it === 1 ? onProgress : null, maxTops, opts);
            err = 0;
            const byId = new Map(project.stratigraphy.map((l) => [l.id, l]));
            r.meta.layers.forEach((l, li) => {
                const b = r.data.burial[li];
                if (!b?.length) return;
                const last = b[b.length - 1];
                err = Math.max(err, Math.abs(last.thickness - Number(byId.get(l.id)?.thickness)));
            });
            maxTops = r.meta.maxBurialTop;
            if (err < 1e-3) break;
        }
        r.meta.compaction = { mode, iterations: Math.min(it, 8), presentThicknessErrorM: err };
        if (onProgress) onProgress(100);
        return r;
    }

    /** One forward pass. `solidTops` (id -> top depth) re-derives each layer's
     *  solid thickness at that top (irreversible compaction's fixed point). */
    static async runOnce(project, onProgress, solidTops = null, opts = {}) {
        const surfaceT = Number.isFinite(project.settings?.surfaceTemp)
            ? project.settings.surfaceTemp
            : Spec.DEFAULT_SURFACE_TEMP_C;
        const irreversible = project.settings?.compaction === 'irreversible';
        const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : null;

        // Present-day solid thicknesses: stratigraphic order, youngest first.
        const presentOrder = [...project.stratigraphy]
            .sort((a, b) => (a.ageStart || 0) - (b.ageStart || 0));
        let initialized = BurialCompactionEngine.initializeSolidThickness(presentOrder);
        if (solidTops) {
            initialized = initialized.map((l) => {
                const top = solidTops[l.id];
                if (!Number.isFinite(top) || top <= l.presentTop) return l;
                const { phi0, c } = BurialCompactionEngine.resolveParams(l);
                return { ...l, solidThickness: BurialCompactionEngine.solidThickness(top, l.thickness, phi0, c) };
            });
        }

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
            // U2-001: the eroded (phantom) sections, deposited and removed
            phantoms: phantoms.map(() => []),
            // U2-015: overpressure at each layer centre (Pa)
            overpressure: chronologicalLayers.map(() => []),
        };
        const indexById = new Map(chronologicalLayers.map((l, i) => [l.id, i]));
        const phantomIndex = new Map(phantoms.map((p, i) => [p.id, i]));

        const layerStates = {};
        const maxTop = {};
        chronologicalLayers.forEach(l => {
            const sr = l.sourceRock;
            const n = SimulationEngine.columnSlices(l);
            const state = {
                maturity: MaturityEngine.initializeState(sr?.kerogen || 'type2'),
                expelled: 0,
                potentialMass: 0,
                // U2-004: vitrinite state per slice through the layer
                slices: Array.from({ length: n }, () => MaturityEngine.initializeVitrinite()),
                // U2-015: overpressure (Pa) and the last loading excess per slice
                u: new Array(n).fill(0),
                excess: new Array(n).fill(null),
            };
            if (sr?.isSource) {
                const { grainDensity } = BurialCompactionEngine.resolveParams(l);
                state.potentialMass = grainDensity * l.solidThickness
                    * ((Number(sr.toc) || 0) / 100)
                    * ((Number(sr.hi) || 0) / 1000);
            }
            layerStates[l.id] = state;
        });
        allLayers.forEach((l) => { maxTop[l.id] = -Infinity; });

        let prevProfile = null;   // [{z, t}] sorted by z
        let prevBasalGrad = 0;
        let lastSlices = [];
        const sliceGuess = {};

        const schedule = SimulationEngine.timeSchedule(maxAge);
        for (let step = 0; step < schedule.ages.length; step++) {
            if (shouldStop && shouldStop()) throw new Error('Run cancelled.');
            const currentTime = schedule.ages[step];
            const dtMa = schedule.dts[step];

            const active = allLayers.filter(l => {
                if ((l.ageStart || 0) < currentTime - 1e-9) return false;
                if (l.phantom && currentTime <= l.erodeAge + 1e-9) return false;
                return true;
            }).sort((a, b) => (a.ageStart || 0) - (b.ageStart || 0));

            // Geometry, top down.
            let depth = 0;
            const geo = active.map(layer => {
                let props;
                let shift = 0;
                if (irreversible) {
                    const eff = Math.max(depth, maxTop[layer.id]);
                    const p = BurialCompactionEngine.calculateLayerProperties(layer, eff);
                    shift = eff - depth;
                    props = { ...p, topDepth: depth, bottomDepth: depth + p.thickness };
                } else {
                    props = BurialCompactionEngine.calculateLayerProperties(layer, depth);
                }
                depth = props.bottomDepth;
                return { layer, shift, ...props };
            });
            geo.forEach((g) => { maxTop[g.layer.id] = Math.max(maxTop[g.layer.id], g.topDepth + g.shift); });

            // Thermal grid: surface node + cell-centred nodes.
            const nodes = [];
            if (geo.length > 0) {
                const firstComp = BurialCompactionEngine.resolveParams(geo[0].layer);
                const firstTherm = SimulationEngine.resolveThermal(geo[0].layer);
                nodes.push({
                    z: 0,
                    k: HeatTransportEngine.effectiveConductivity(
                        firstTherm.conductivity,
                        BurialCompactionEngine.porosity(geo[0].shift, firstComp.phi0, firstComp.c)),
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
                        const phi = BurialCompactionEngine.porosity(zc + g.shift, comp.phi0, comp.c);
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
                    nodes, dtMa * Spec.SECONDS_PER_MA, surfaceT, basalQ, tOld);
            }

            const profile = nodes
                .map((nd, i) => ({ z: nd.z, t: temps[i] }))
                .sort((a, b) => a.z - b.z);
            prevProfile = profile;
            prevBasalGrad = nodes.length > 0 ? basalQ / nodes[nodes.length - 1].k : 0;

            // Column slices (U2-004 Ro through the column; U2-015 loading).
            const slices = [];
            let sigma = 0; // vertical stress at the running top (Pa)
            geo.forEach((g) => {
                const real = !g.layer.phantom;
                const n = real ? layerStates[g.layer.id].slices.length : 1;
                const { grainDensity } = g;
                if (!sliceGuess[g.layer.id]) sliceGuess[g.layer.id] = new Array(n).fill(0);
                const sg = SimulationEngine.sliceGeometry(g.layer, g.topDepth, g.topDepth + g.shift, n, sliceGuess[g.layer.id]);
                sg.forEach((sl, j) => {
                    const h = sl.bottom - sl.top;
                    const phi = sl.phiMid;
                    const rhoB = phi * Spec.RHO_WATER + (1 - phi) * grainDensity;
                    const zc = (sl.top + sl.bottom) / 2;
                    const sigmaMid = sigma + rhoB * Spec.G * h / 2;
                    sigma += rhoB * Spec.G * h;
                    slices.push({ g, j, real, top: sl.top, bottom: sl.bottom, zc, phi, sigmaMid, grainDensity });
                });
            });

            // Kinetics + bookkeeping (real layers only).
            geo.forEach(g => {
                if (g.layer.phantom) {
                    history.phantoms[phantomIndex.get(g.layer.id)].push({
                        age: currentTime, top: g.topDepth, bottom: g.bottomDepth, thickness: g.thickness,
                    });
                    return;
                }
                const layerIndex = indexById.get(g.layer.id);
                const state = layerStates[g.layer.id];
                const zc = (g.topDepth + g.bottomDepth) / 2;
                const tC = SimulationEngine.interpProfile(profile, prevBasalGrad, zc);

                state.maturity = MaturityEngine.step(state.maturity, tC + 273.15, dtMa);

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

            // Slice vitrinite (U2-004) and overpressure (U2-015).
            slices.forEach((s) => {
                if (!s.real) return;
                const st = layerStates[s.g.layer.id];
                s.temp = SimulationEngine.interpProfile(profile, prevBasalGrad, s.zc);
                s.ro = MaturityEngine.vitriniteStep(st.slices[s.j], s.temp + 273.15, dtMa).Ro;
            });
            PressureEngine.step(slices, layerStates, dtMa * Spec.SECONDS_PER_MA);
            const uSum = new Map();
            slices.forEach((s) => {
                if (!s.real) return;
                const st = layerStates[s.g.layer.id];
                uSum.set(s.g, (uSum.get(s.g) || 0) + st.u[s.j] * (s.bottom - s.top));
            });
            geo.forEach((g) => {
                if (g.layer.phantom) return;
                history.overpressure[indexById.get(g.layer.id)].push({ age: currentTime, value: (uSum.get(g) || 0) / Math.max(1e-9, g.thickness) });
            });
            lastSlices = slices;

            history.timeSteps.push(currentTime);
            if (onProgress) onProgress(maxAge > 0 ? ((maxAge - currentTime) / maxAge) * 100 : 100);
        }

        // U2-004 / U2-015: the present-day column, slice by slice, shallow to deep.
        const column = lastSlices.filter((s) => s.real).map((s) => {
            const st = layerStates[s.g.layer.id];
            const hydro = Spec.RHO_WATER * Spec.G * s.zc;
            return {
                layerId: s.g.layer.id,
                slice: s.j,
                top: s.top,
                bottom: s.bottom,
                depth: s.zc,
                temp: s.temp,
                ro: s.ro,
                porosity: s.phi,
                hydrostaticPa: hydro,
                overburdenPa: s.sigmaMid,
                overpressurePa: st.u[s.j],
                porePressurePa: hydro + st.u[s.j],
            };
        });

        const bottoms = history.burial.flat().map(b => b.bottom);
        return {
            meta: {
                layers: chronologicalLayers.map(l => ({ id: l.id, name: l.name, lithology: l.lithology, color: l.color })),
                maxDepth: bottoms.length > 0 ? Math.max(...bottoms) : 0,
                phantoms: phantoms.map((p) => ({ id: p.id, name: p.name, lithology: p.lithology, depositAge: p.ageStart, erodeAge: p.erodeAge })),
                maxBurialTop: Object.fromEntries(chronologicalLayers.map((l) => [l.id, maxTop[l.id]])),
            },
            data: { ...history, column },
        };
    }
}
