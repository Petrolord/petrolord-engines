/**
 * Basin & Charge Modeling, continuous deposition and the time step
 * (2026-10-14). Every gate calls the shipped engine.
 *
 *  - 'instant' deposition (the G7 spec) stays the default: the goldens in
 *    basin.test.js and basin.u2.test.js are unchanged.
 *  - 'continuous' builds each layer up through its interval; the present-day
 *    geometry is the same as in 'instant' mode.
 *  - Known truth: a non-compacting layer deposited at a constant rate is
 *    buried linearly in time (the instant mode fails this: negative control).
 *  - Known truth: Easy%Ro (Sweeney and Burnham 1990) under a constant heating
 *    rate against the exact Arrhenius integral; the step the engine takes
 *    stays within 0.01 %Ro at 0.25 Ma; the pre-G7 unit error (E read in
 *    kcal with R in J) is caught.
 */
import fs from 'fs';
import path from 'path';
import { SimulationEngine } from '../engines/basin/SimulationEngine';
import { MaturityEngine } from '../engines/basin/MaturityEngine';
import { EasyRoWeights, EasyRoFrequencyFactor, ActivationEnergies } from '../engines/basin/KerogenLibrary';
import { Spec } from '../engines/basin/PhysicsUtils';

const goldens = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/basin/goldens.json'), 'utf8'));
const refProject = (settings = {}) => {
    const p = goldens.reference_basin.project;
    return {
        stratigraphy: p.stratigraphy.map((l) => ({
            ...l,
            sourceRock: l.sourceRock ? { ...l.sourceRock, kerogen: { potentials: l.sourceRock.kerogen.potentials, aFactor: l.sourceRock.kerogen.a_factor } } : undefined,
        })),
        heatFlow: p.heatFlow,
        erosionEvents: p.erosionEvents,
        settings: { ...p.settings, ...settings },
    };
};
const last = (a) => a[a.length - 1];

describe('the time step', () => {
    test('allowed steps are taken; anything else is the 1 Ma oracle step', () => {
        expect(SimulationEngine.stepOf(0.25)).toBe(0.25);
        expect(SimulationEngine.stepOf('0.5')).toBe(0.5);
        for (const bad of [0, -1, 0.3, 2, 'x', null, undefined]) expect(SimulationEngine.stepOf(bad)).toBe(Spec.DT_MA);
        const s = SimulationEngine.timeSchedule(30, 0.25);
        expect(s.ages[0]).toBe(30);
        expect(last(s.ages)).toBe(0);
        expect(s.ages.length).toBe(121);
        expect(s.dts.every((d) => d === 0.25)).toBe(true);
    });

    test('the default run reports instant deposition at 1 Ma', async () => {
        const r = await SimulationEngine.run(refProject());
        expect(r.meta.deposition).toEqual({ mode: 'instant' });
        expect(r.meta.timeStepMa).toBe(1);
    });
});

describe('continuous deposition', () => {
    let inst; let cont;
    beforeAll(async () => {
        inst = await SimulationEngine.run(refProject({ timeStepMa: 1 }));
        cont = await SimulationEngine.run(refProject({ timeStepMa: 1, deposition: 'continuous' }));
    });

    test('results are reported for the input layers, oldest first', () => {
        expect(cont.meta.layers.map((l) => l.id)).toEqual(inst.meta.layers.map((l) => l.id));
        expect(cont.meta.deposition.mode).toBe('continuous');
        expect(cont.meta.deposition.subLayers).toBeGreaterThan(cont.meta.layers.length);
        const ids = new Set(cont.meta.layers.map((l) => l.id));
        expect(cont.data.column.every((c) => ids.has(c.layerId))).toBe(true);
    });

    test('the present-day geometry is the same as in instant deposition', () => {
        cont.meta.layers.forEach((l, i) => {
            const a = last(cont.data.burial[i]); const b = last(inst.data.burial[i]);
            expect(a.age).toBe(0);
            expect(a.top).toBeCloseTo(b.top, 6);
            expect(a.bottom).toBeCloseTo(b.bottom, 6);
        });
    });

    test('the source potential is conserved and the series are physical', () => {
        const si = cont.meta.layers.findIndex((l) => l.id === 'source_shale');
        // potential of the sub-layers adds up to the layer's (solid thickness is additive)
        expect(cont.meta.potentialMass.source_shale).toBeCloseTo(inst.meta.potentialMass.source_shale, 6);
        const tr = cont.data.transformation[si].map((e) => e.value);
        expect(tr.every((v) => v >= 0 && v <= 1)).toBe(true);
        const ex = cont.data.expulsion[si].map((e) => e.value);
        for (let i = 1; i < ex.length; i++) expect(ex[i]).toBeGreaterThanOrEqual(ex[i - 1] - 1e-9);
        // generated mass = TR x potential at the present day
        expect(last(cont.data.generation[si]).value).toBeCloseTo(last(tr) * cont.meta.potentialMass.source_shale, 6);
    });

    // a single layer that does not compact (porosity 0), deposited at a
    // constant rate: its base is buried at that rate, exactly
    const ramp = (deposition, timeStepMa = 0.5) => ({
        stratigraphy: [{ id: 'r', name: 'Ramp', lithology: 'sandstone', ageStart: 10, ageEnd: 0, thickness: 1000, compaction: { phi0: 0, c: 0 } }],
        heatFlow: { type: 'constant', value: 60 }, erosionEvents: [], settings: { surfaceTemp: 20, deposition, timeStepMa },
    });

    test('known truth: constant-rate deposition buries the base linearly (100 m per Ma)', async () => {
        const r = await SimulationEngine.run(ramp('continuous'));
        const b = r.data.burial[0];
        // the first 50 m sub-layer is complete at 9.5 Ma, the model starts there
        expect(b.length).toBe(20);
        expect(b[0].age).toBe(9.5);
        b.forEach((e) => expect(e.bottom).toBeCloseTo(100 * (10 - e.age), 6));
    });

    test('control: instant deposition puts the whole layer down at once and fails the same check', async () => {
        const r = await SimulationEngine.run(ramp('instant'));
        const mid = r.data.burial[0].find((e) => e.age === 5);
        expect(Math.abs(mid.bottom - 500)).toBeGreaterThan(400);
    });

    test('the source maturity converges as the step shrinks', async () => {
        const roAt = async (dt) => {
            const r = await SimulationEngine.run(refProject({ deposition: 'continuous', timeStepMa: dt }));
            const si = r.meta.layers.findIndex((l) => l.id === 'source_shale');
            return last(r.data.maturity[si]).value;
        };
        const [r1, r05, r025, r01] = [await roAt(1), await roAt(0.5), await roAt(0.25), await roAt(0.1)];
        // the reference basin's source (Ro about 1.51) agrees to 0.005 %Ro at every step
        for (const r of [r1, r05, r025]) expect(Math.abs(r - r01)).toBeLessThan(0.005);
    });

    test('a layer shorter than the step is one sub-layer, and an instant run ignores the setting', async () => {
        const e = SimulationEngine.expandSubLayers({ stratigraphy: [{ id: 'a', ageStart: 15.4, ageEnd: 14.8, thickness: 32 }], settings: { deposition: 'continuous' } }, 1);
        expect(e.parents[0].subIds).toEqual(['a']);
        expect(SimulationEngine.expandSubLayers({ stratigraphy: [], settings: {} }, 1)).toBeNull();
    });
});

describe('Easy%Ro under a constant heating rate (known truth)', () => {
    // exact: x_i(t) = w_i exp(-integral A exp(-E_i/RT(t)) dt), the integral by
    // composite Simpson on a fine grid; T rises 2 C/Ma from 20 C
    const RATE = 2; const T0 = 20;
    const exactRo = (ma) => {
        const n = 4000; const h = ma / n;
        let F = 0;
        EasyRoWeights.forEach((w, i) => {
            const k = (t) => EasyRoFrequencyFactor * Math.exp(-(ActivationEnergies[i] * 4184) / (8.314 * (T0 + RATE * t + 273.15)));
            let s = k(0) + k(ma);
            for (let j = 1; j < n; j++) s += (j % 2 ? 4 : 2) * k(j * h);
            const I = (s * h / 3) * Spec.SECONDS_PER_MA;
            F += w * (1 - Math.exp(-I));
        });
        return Math.exp(-1.6 + 3.7 * F);
    };
    // the engine: the temperature at the end of each step (as SimulationEngine runs it)
    const engineRo = (ma, dt, energies = undefined) => {
        let st = MaturityEngine.initializeState('type2');
        let x = [...EasyRoWeights];
        for (let t = dt; t <= ma + 1e-9; t += dt) {
            const T = T0 + RATE * t + 273.15;
            if (energies) x = MaturityEngine.kineticStep(x, EasyRoFrequencyFactor, T, dt, energies);
            else st = MaturityEngine.step(st, T, dt);
        }
        if (energies) return MaturityEngine.roFromF(EasyRoWeights.reduce((a, w, i) => a + (w - x[i]), 0));
        return st.Ro;
    };

    test('the engine step tracks the exact integral: within 0.01 %Ro at 0.25 Ma and 0.03 at 1 Ma', () => {
        for (const ma of [40, 60, 70, 80, 90]) {
            const ex = exactRo(ma);
            expect(Math.abs(engineRo(ma, 0.25) - ex)).toBeLessThan(0.01);
            expect(Math.abs(engineRo(ma, 1) - ex)).toBeLessThan(0.03);
        }
    });

    test('control: the pre-G7 unit error (kcal energies with R in J) is far off', () => {
        const bad = ActivationEnergies.map((e) => e / 1000);
        expect(Math.abs(engineRo(60, 0.25, bad) - exactRo(60))).toBeGreaterThan(1);
    });
});
