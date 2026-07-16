/**
 * G7.1 engine validation against the independent Python oracle goldens
 * (tools/validation/basin/, test-data/basin/goldens.json).
 *
 * The oracle inverts the decompaction integral by bisection while the
 * engine uses Newton-Raphson, so geometry-derived quantities compare at
 * 1e-5-ish tolerances; closed-form kinetics compare at 1e-10.
 */
import fs from 'fs';
import path from 'path';

import { BurialCompactionEngine } from '../engines/basin/BurialCompactionEngine';
import { HeatTransportEngine } from '../engines/basin/HeatTransportEngine';
import { MaturityEngine } from '../engines/basin/MaturityEngine';
import { SimulationEngine } from '../engines/basin/SimulationEngine';
import { EasyRoWeights, EasyRoFrequencyFactor } from '../engines/basin/KerogenLibrary';
import { Spec } from '../engines/basin/PhysicsUtils';

const goldens = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../test-data/basin/goldens.json'), 'utf8'));

const C = goldens._provenance.constants;

describe('spec constants match the oracle', () => {
    test('shared numeric spec', () => {
        expect(Spec.SECONDS_PER_MA).toBe(C.seconds_per_ma);
        expect(Spec.R_GAS).toBe(C.r_gas_j_mol_k);
        expect(Spec.KCAL_TO_J).toBe(C.kcal_to_j);
        expect(Spec.RHO_WATER).toBe(C.rho_water);
        expect(Spec.CP_WATER).toBe(C.cp_water);
        expect(Spec.K_WATER).toBe(C.k_water);
        expect(Spec.RHO_HC).toBe(C.rho_hc);
        expect(Spec.S_EXPULSION_THRESHOLD).toBe(C.s_expulsion_threshold);
        expect(Spec.MAX_CELL_M).toBe(C.max_cell_m);
        expect(Spec.DT_MA).toBe(C.dt_ma);
        expect(EasyRoFrequencyFactor).toBe(C.easyro_a_per_s);
        expect(EasyRoWeights).toEqual(C.easyro_weights);
    });
});

describe('decompaction vs goldens', () => {
    test.each(goldens.decompaction.map(g => [g]))(
        '%o', (g) => {
            const layer = { lithology: g.lithology };
            const { phi0, c } = BurialCompactionEngine.resolveParams(layer);
            const hs = BurialCompactionEngine.solidThickness(
                g.top_m, g.present_thickness_m, phi0, c);
            expect(hs).toBeCloseTo(g.solid_thickness_m, 9);

            const props = BurialCompactionEngine.calculateLayerProperties(
                { ...layer, solidThickness: g.solid_thickness_m }, 0);
            expect(Math.abs(props.thickness - g.redecompacted_at_top0_m))
                .toBeLessThan(1e-5);
        });
});

describe('steady heat vs goldens', () => {
    test('two-layer exact profile', () => {
        const g = goldens.heat_two_layer_steady;
        const nodes = [{ z: 0, k: g.layers[0].k, rhoCp: 1, aVol: 0 }];
        let z = 0;
        g.layers.forEach(lay => {
            const dz = lay.h_m / lay.cells;
            for (let j = 0; j < lay.cells; j++) {
                nodes.push({ z: z + (j + 0.5) * dz, k: lay.k, rhoCp: 2.0e6, aVol: 0 });
            }
            z += lay.h_m;
        });
        const temps = HeatTransportEngine.solve(
            nodes, null, g.surface_t_c, g.basal_q_w_m2, null);
        g.profile.forEach((p, i) => {
            expect(nodes[i].z).toBeCloseTo(p.z_m, 9);
            expect(temps[i]).toBeCloseTo(p.t_c, 8);
        });
    });
});

describe('Easy%Ro vs goldens', () => {
    // Replicates the oracle's sub-stepped ramp integration
    // (midpoint temperature per 0.01 Ma sub-step).
    const ramp = (t0, rate, tEnd) => {
        const sub = 0.01;
        let fractions = [...EasyRoWeights];
        const out = [];
        const steps = Math.round((tEnd - t0) / rate / sub);
        let nextReport = t0;
        for (let i = 0; i <= steps; i++) {
            const tNow = t0 + rate * i * sub;
            while (nextReport <= tNow + 1e-9) {
                const f = EasyRoWeights.reduce((acc, w, j) => acc + (w - fractions[j]), 0);
                out.push({ t_c: nextReport, ro: MaturityEngine.roFromF(f) });
                nextReport += 1;
            }
            if (i < steps) {
                const tMid = tNow + 0.5 * rate * sub;
                fractions = MaturityEngine.kineticStep(
                    fractions, EasyRoFrequencyFactor, tMid + 273.15, sub);
            }
        }
        return out;
    };

    test.each(Object.keys(goldens.easyro_ramps))('ramp %s C/Ma', (rate) => {
        const table = ramp(20.0, Number(rate), 200.0);
        goldens.easyro_ramps[rate].forEach((g, i) => {
            expect(table[i].t_c).toBeCloseTo(g.t_c, 9);
            expect(table[i].ro).toBeCloseTo(g.ro, 10);
        });
    });
});

describe('kerogen TR vs goldens', () => {
    test.each(goldens.kerogen_isothermal_tr.map(g => [g]))(
        'T=%o', (g) => {
            let fractions = [...g.potentials];
            const steps = Math.round(g.duration_ma / Spec.DT_MA);
            for (let i = 0; i < steps; i++) {
                fractions = MaturityEngine.kineticStep(
                    fractions, g.a_factor, g.temp_c + 273.15, Spec.DT_MA);
            }
            const total = g.potentials.reduce((a, b) => a + b, 0);
            const tr = 1 - fractions.reduce((a, b) => a + b, 0) / total;
            expect(tr).toBeCloseTo(g.tr, 12);
        });
});

describe('full reference-basin run vs goldens', () => {
    const toProject = (p) => ({
        stratigraphy: p.stratigraphy.map(l => ({
            ...l,
            sourceRock: l.sourceRock ? {
                ...l.sourceRock,
                kerogen: {
                    potentials: l.sourceRock.kerogen.potentials,
                    aFactor: l.sourceRock.kerogen.a_factor,
                },
            } : undefined,
        })),
        heatFlow: p.heatFlow,
        erosionEvents: p.erosionEvents,
        settings: p.settings,
    });

    let result;
    beforeAll(async () => {
        result = await SimulationEngine.run(toProject(goldens.reference_basin.project));
    });

    const relClose = (a, b, tol) => {
        const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
        expect(Math.abs(a - b) / scale).toBeLessThan(tol);
    };

    test('series match the oracle at every decimated age', () => {
        const series = goldens.reference_basin.series;
        Object.entries(series).forEach(([lid, s]) => {
            const li = result.meta.layers.findIndex(l => l.id === lid);
            expect(li).toBeGreaterThanOrEqual(0);
            s.age.forEach((age, k) => {
                const bi = result.data.burial[li].findIndex(e => Math.abs(e.age - age) < 1e-6);
                expect(bi).toBeGreaterThanOrEqual(0);
                relClose(result.data.burial[li][bi].top, s.top[k], 1e-5);
                relClose(result.data.burial[li][bi].bottom, s.bottom[k], 1e-5);
                relClose(result.data.temperature[li][bi].value, s.temp_c[k], 1e-5);
                relClose(result.data.maturity[li][bi].value, s.ro[k], 1e-5);
                relClose(result.data.transformation[li][bi].value, s.tr[k], 1e-4);
                relClose(result.data.generation[li][bi].value, s.generated_kg_m2[k], 1e-4);
                relClose(result.data.expulsion[li][bi].value, s.expelled_kg_m2[k], 1e-4);
            });
        });
    });

    test('everything is finite (NaN regression — the pre-G7 engine returned all-NaN)', () => {
        result.data.burial.flat().forEach(e => {
            expect(Number.isFinite(e.top)).toBe(true);
            expect(Number.isFinite(e.bottom)).toBe(true);
        });
        result.data.temperature.flat().forEach(e => expect(Number.isFinite(e.value)).toBe(true));
        result.data.maturity.flat().forEach(e => expect(Number.isFinite(e.value)).toBe(true));
        expect(Number.isFinite(result.meta.maxDepth)).toBe(true);
    });

    test('erosion control: removing the event lowers final source Ro', async () => {
        const project = toProject(goldens.reference_basin.project);
        project.erosionEvents = [];
        const ctl = await SimulationEngine.run(project);
        const li = ctl.meta.layers.findIndex(l => l.id === 'source_shale');
        const roFinal = ctl.data.maturity[li][ctl.data.maturity[li].length - 1].value;
        relClose(roFinal, goldens.reference_basin.final_source_ro_no_erosion, 1e-5);
    });

    test('heat-flow control: constant Q at the final value lowers final source Ro', async () => {
        const project = toProject(goldens.reference_basin.project);
        project.heatFlow = { type: 'constant', value: 60.0 };
        const ctl = await SimulationEngine.run(project);
        const li = ctl.meta.layers.findIndex(l => l.id === 'source_shale');
        const roFinal = ctl.data.maturity[li][ctl.data.maturity[li].length - 1].value;
        relClose(roFinal, goldens.reference_basin.final_source_ro_constant_q, 1e-5);
    });

    test('string kerogen types resolve through the library (wizard contract)', async () => {
        const project = toProject(goldens.reference_basin.project);
        project.stratigraphy = project.stratigraphy.map(l =>
            l.sourceRock ? { ...l, sourceRock: { ...l.sourceRock, kerogen: 'type2' } } : l);
        const viaString = await SimulationEngine.run(project);
        const li = viaString.meta.layers.findIndex(l => l.id === 'source_shale');
        const li2 = result.meta.layers.findIndex(l => l.id === 'source_shale');
        const a = viaString.data.transformation[li][viaString.data.transformation[li].length - 1].value;
        const b = result.data.transformation[li2][result.data.transformation[li2].length - 1].value;
        expect(a).toBeCloseTo(b, 12);
    });
});
