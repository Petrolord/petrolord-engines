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
 *  - Layers appear instantaneously at ageStart (settings.deposition
 *    'instant', the default); 'continuous' builds each layer up through
 *    its interval (expandSubLayers). Time steps DT_MA (or
 *    settings.timeStepMa, one of TIME_STEPS_MA) from
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

    /** Allowed simulation steps (Ma). 1 is the G7 oracle step and the default. */
    static TIME_STEPS_MA = [1, 0.5, 0.25, 0.1];

    /** Most sub-layers one input layer is cut into in continuous deposition. */
    static MAX_SUBLAYERS = 40;

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
    static timeSchedule(maxAge, dtMa = Spec.DT_MA) {
        const ages = [];
        const top = Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 0;
        const step = SimulationEngine.stepOf(dtMa);
        for (let i = 0; ; i++) {
            const t = Number((top - i * step).toFixed(9));
            if (t <= 1e-9) break;
            ages.push(t);
        }
        ages.push(0);
        const dts = ages.map((a, i) => (i === 0 ? step : Number((ages[i - 1] - a).toFixed(9))));
        return { ages, dts };
    }

    /**
     * The simulation step (Ma): settings.timeStepMa when it is one of the
     * allowed values, else Spec.DT_MA (1 Ma, the G7 oracle step). A Neogene
     * basin whose layers last less than 1 Ma needs a finer step for its
     * layers to deposit one after another.
     */
    static stepOf(dtMa) {
        const v = Number(dtMa);
        return SimulationEngine.TIME_STEPS_MA.includes(v) ? v : Spec.DT_MA;
    }

    /**
     * BF continuous deposition (2026-10-14). In 'instant' deposition (the G7
     * spec, the default) a layer appears whole at its ageStart. In
     * 'continuous' deposition it builds up through its interval: the layer is
     * cut into k sub-layers of equal present thickness, k = its duration over
     * the step (1 to MAX_SUBLAYERS), whose ages split the interval evenly,
     * oldest at the base. Each sub-layer deposits when its part of the
     * interval ends, so a layer deposited at a constant rate is buried at
     * that rate, step by step. The
     * present-day geometry is the same in both modes (the sub-layers stack
     * to the input thickness). Results are reported for the input layers
     * (aggregateSubLayers).
     * @returns {{project: object, parents: Array<{id, subIds: string[]}>}|null}
     */
    static expandSubLayers(project, dtMa) {
        if (project?.settings?.deposition !== 'continuous') return null;
        const step = SimulationEngine.stepOf(dtMa);
        const parents = [];
        const stratigraphy = [];
        project.stratigraphy.forEach((l) => {
            const aS = Number(l.ageStart); const aE = Number(l.ageEnd);
            const dur = Number.isFinite(aS) && Number.isFinite(aE) ? aS - aE : 0;
            const k = dur > 0 ? Math.min(SimulationEngine.MAX_SUBLAYERS, Math.max(1, Math.round(dur / step))) : 1;
            const subIds = [];
            for (let j = 0; j < k; j++) {
                // j = 0 is the base (the oldest sub-layer)
                const id = k === 1 ? l.id : `${l.id}::d${j}`;
                subIds.push(id);
                // a sub-layer is put down whole at the END of its interval
                // (when it is complete), so the deposited thickness at a step
                // is rate x (ageStart - age), exactly, at every step. The base
                // sub-layer of the oldest layer starts the model one sub-layer
                // after the layer's ageStart (the column is never empty).
                const end = Number((aS - ((j + 1) * dur) / k).toFixed(9));
                stratigraphy.push({
                    ...l,
                    id,
                    thickness: Number(l.thickness) / k,
                    ageStart: k === 1 ? l.ageStart : end,
                    ageEnd: k === 1 ? l.ageEnd : end,
                });
            }
            parents.push({ id: l.id, subIds });
        });
        return { project: { ...project, stratigraphy }, parents };
    }

    /** Interpolate a value at depth z through points [{z, v}] sorted by z (nearest end beyond them). */
    static atDepth(pts, z) {
        if (pts.length === 1 || z <= pts[0].z) return pts[0].v;
        const n = pts.length;
        if (z >= pts[n - 1].z) return pts[n - 1].v;
        for (let i = 0; i < n - 1; i++) {
            if (z >= pts[i].z && z <= pts[i + 1].z) {
                const dz = pts[i + 1].z - pts[i].z;
                return dz > 0 ? pts[i].v + ((z - pts[i].z) * (pts[i + 1].v - pts[i].v)) / dz : pts[i].v;
            }
        }
        return pts[n - 1].v;
    }

    /**
     * Sub-layer results back to the input layers. At each age, over the
     * sub-layers deposited by then: the burial spans them; temperature and
     * Ro are read at the layer's centre (interpolated between sub-layer
     * centres); generation and expulsion (kg/m2) add up; the transformation
     * ratio is the generated mass over the potential; overpressure is the
     * thickness-weighted mean. The present-day column carries the input
     * layer's id.
     */
    static aggregateSubLayers(r, expansion, project) {
        const { parents } = expansion;
        const idx = new Map(r.meta.layers.map((l, i) => [l.id, i]));
        const potential = r.meta.potentialMass || {};
        const byId = new Map(project.stratigraphy.map((l) => [l.id, l]));
        const order = [...parents].sort((a, b) => (Number(byId.get(b.id).ageStart) || 0) - (Number(byId.get(a.id).ageStart) || 0));
        const data = {
            timeSteps: r.data.timeSteps,
            burial: [], temperature: [], maturity: [], transformation: [], generation: [], expulsion: [],
            phantoms: r.data.phantoms, overpressure: [],
        };
        order.forEach((p) => {
            const subs = p.subIds.map((id) => idx.get(id));
            const series = { burial: [], temperature: [], maturity: [], transformation: [], generation: [], expulsion: [], overpressure: [] };
            const maps = subs.map((si) => ({
                burial: new Map(r.data.burial[si].map((e) => [e.age, e])),
                temperature: new Map(r.data.temperature[si].map((e) => [e.age, e])),
                maturity: new Map(r.data.maturity[si].map((e) => [e.age, e])),
                generation: new Map(r.data.generation[si].map((e) => [e.age, e])),
                expulsion: new Map(r.data.expulsion[si].map((e) => [e.age, e])),
                overpressure: new Map(r.data.overpressure[si].map((e) => [e.age, e])),
                potential: potential[r.meta.layers[si].id] || 0,
            }));
            r.data.timeSteps.forEach((age) => {
                const live = maps.filter((m) => m.burial.has(age));
                if (!live.length) return;
                const bs = live.map((m) => m.burial.get(age));
                const top = Math.min(...bs.map((b) => b.top));
                const bottom = Math.max(...bs.map((b) => b.bottom));
                const zc = (top + bottom) / 2;
                const pts = (key) => live.map((m, i) => ({ z: (bs[i].top + bs[i].bottom) / 2, v: m[key].get(age).value })).sort((a, b) => a.z - b.z);
                const gen = live.reduce((a, m) => a + m.generation.get(age).value, 0);
                const pot = live.reduce((a, m) => a + m.potential, 0);
                const thick = bs.reduce((a, b) => a + b.thickness, 0);
                series.burial.push({ age, top, bottom, thickness: bottom - top });
                series.temperature.push({ age, value: SimulationEngine.atDepth(pts('temperature'), zc), depth: zc });
                series.maturity.push({ age, value: SimulationEngine.atDepth(pts('maturity'), zc) });
                series.generation.push({ age, value: gen });
                series.expulsion.push({ age, value: live.reduce((a, m) => a + m.expulsion.get(age).value, 0) });
                series.transformation.push({ age, value: pot > 0 ? Math.max(0, Math.min(1, gen / pot)) : 0 });
                series.overpressure.push({ age, value: thick > 0 ? live.reduce((a, m, i) => a + m.overpressure.get(age).value * bs[i].thickness, 0) / thick : 0 });
            });
            Object.keys(series).forEach((k) => data[k].push(series[k]));
        });
        const parentOf = new Map();
        parents.forEach((p) => p.subIds.forEach((id) => parentOf.set(id, p.id)));
        const sliceNo = {};
        data.column = (r.data.column || []).map((c) => {
            const pid = parentOf.get(c.layerId) || c.layerId;
            sliceNo[pid] = (sliceNo[pid] ?? -1) + 1;
            return { ...c, layerId: pid, slice: sliceNo[pid], subLayerId: c.layerId };
        });
        const youngest = (p) => p.subIds[p.subIds.length - 1];
        return {
            meta: {
                ...r.meta,
                layers: order.map((p) => { const l = byId.get(p.id); return { id: l.id, name: l.name, lithology: l.lithology, color: l.color }; }),
                maxBurialTop: Object.fromEntries(order.map((p) => [p.id, r.meta.maxBurialTop?.[youngest(p)]])),
                potentialMass: Object.fromEntries(order.map((p) => [p.id, p.subIds.reduce((a, id) => a + (potential[id] || 0), 0)])),
                deposition: { mode: 'continuous', subLayers: parents.reduce((a, p) => a + p.subIds.length, 0) },
            },
            data,
        };
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
        const dtMa = SimulationEngine.stepOf(project.settings?.timeStepMa);
        const expansion = SimulationEngine.expandSubLayers(project, dtMa);
        if (expansion) {
            const sub = await SimulationEngine.run({ ...expansion.project, settings: { ...project.settings, deposition: 'expanded' } }, onProgress, opts);
            const out = SimulationEngine.aggregateSubLayers(sub, expansion, project);
            out.meta.compaction = sub.meta.compaction;
            out.meta.timeStepMa = dtMa;
            return out;
        }
        const mode = project.settings?.compaction === 'irreversible' ? 'irreversible' : 'elastic';
        if (mode === 'elastic') {
            const r = await SimulationEngine.runOnce(project, onProgress, null, opts);
            r.meta.compaction = { mode, iterations: 1, presentThicknessErrorM: 0 };
            r.meta.timeStepMa = dtMa;
            if (!r.meta.deposition) r.meta.deposition = { mode: 'instant' };
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
        r.meta.timeStepMa = dtMa;
        if (!r.meta.deposition) r.meta.deposition = { mode: 'instant' };
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

        const schedule = SimulationEngine.timeSchedule(maxAge, project.settings?.timeStepMa);
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
                // a loop, not Math.max(...bottoms): a fine step makes the list too long to spread
                maxDepth: bottoms.reduce((m, b) => (b > m ? b : m), bottoms.length > 0 ? -Infinity : 0),
                phantoms: phantoms.map((p) => ({ id: p.id, name: p.name, lithology: p.lithology, depositAge: p.ageStart, erodeAge: p.erodeAge })),
                maxBurialTop: Object.fromEntries(chronologicalLayers.map((l) => [l.id, maxTop[l.id]])),
                potentialMass: Object.fromEntries(chronologicalLayers.map((l) => [l.id, layerStates[l.id].potentialMass])),
            },
            data: { ...history, column },
        };
    }
}
