/**
 * Basin & Charge Modeling upgrade U2 (2026-10-01): engine additions,
 * each gate calling the shipped engine.
 *
 *  U2-001 the eroded (phantom) section is reported with its burial history
 *  U2-004 Ro and temperature through the column (slices about 100 m thick)
 *  U2-005 maximum-burial (irreversible) compaction
 *  U2-006 BHT corrections (Horner, AAPG, Harrison)
 *  U2-013 Pepper and Corvi (1995) organofacies kinetics; lithology mixing
 *  U2-015 compaction-disequilibrium overpressure
 */
import fs from 'fs';
import path from 'path';

import { SimulationEngine } from '../engines/basin/SimulationEngine';
import { MaturityEngine } from '../engines/basin/MaturityEngine';
import { BurialCompactionEngine } from '../engines/basin/BurialCompactionEngine';
import { PressureEngine } from '../engines/basin/PressureEngine';
import { hornerCorrection, aapgCorrection, harrisonCorrection, correctTemperatures } from '../engines/basin/BhtCorrection';
import {
    EasyRoWeights, EasyRoFrequencyFactor, ActivationEnergies,
    PepperCorvi1995, gaussianKinetics, organofaciesKinetics, getKerogenParams,
} from '../engines/basin/KerogenLibrary';
import { mixCompactionParams, LithologyCompaction } from '../engines/basin/CompactionModelLibrary';
import { mixThermalProps, ThermalProperties } from '../engines/basin/ThermalPropertiesLibrary';
import { Spec } from '../engines/basin/PhysicsUtils';
import { calibrationProfile, finalDepthProfile } from '../engines/basin/results';
import { HeatFlowFitter } from '../engines/basin/HeatFlowFitter';

const goldens = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/basin/goldens.json'), 'utf8'));
const refProject = () => {
    const p = goldens.reference_basin.project;
    return {
        stratigraphy: p.stratigraphy.map((l) => ({
            ...l,
            sourceRock: l.sourceRock ? { ...l.sourceRock, kerogen: { potentials: l.sourceRock.kerogen.potentials, aFactor: l.sourceRock.kerogen.a_factor } } : undefined,
        })),
        heatFlow: p.heatFlow,
        erosionEvents: p.erosionEvents,
        settings: p.settings,
    };
};

let ref;
beforeAll(async () => { ref = await SimulationEngine.run(refProject()); });

describe('U2-001 the eroded section is reported', () => {
    test('the phantom is deposited 600 m thick at 20 Ma, sits on the Upper Shale and is gone at the event', () => {
        expect(ref.meta.phantoms).toHaveLength(1);
        expect(ref.meta.phantoms[0]).toMatchObject({ depositAge: 20, erodeAge: 10 });
        const s = ref.data.phantoms[0];
        expect(s[0].age).toBe(20);
        expect(s[0].top).toBe(0);
        expect(Math.abs(s[0].thickness - 600)).toBeLessThan(1e-6);
        expect(s[s.length - 1].age).toBe(11);
        expect(s.every((e) => e.age > 10)).toBe(true);
        const li = ref.meta.layers.findIndex((l) => l.id === 'upper_shale');
        for (const e of s) {
            const b = ref.data.burial[li].find((x) => x.age === e.age);
            expect(Math.abs(b.top - e.bottom)).toBeLessThan(1e-9);
        }
        // it is the top of the column while it exists, so it keeps its deposited thickness
        s.forEach((e) => { expect(e.top).toBe(0); expect(Math.abs(e.thickness - 600)).toBeLessThan(1e-6); });
    });

    test('control: no erosion, no phantom', async () => {
        const p = refProject(); p.erosionEvents = [];
        const r = await SimulationEngine.run(p);
        expect(r.meta.phantoms).toEqual([]);
        expect(r.data.phantoms).toEqual([]);
    });
});

describe('U2-004 Ro through the column', () => {
    test('Easy%Ro: the published parameters (Sweeney and Burnham 1990, Table 2) and range', () => {
        expect(EasyRoFrequencyFactor).toBe(1.0e13);
        expect(ActivationEnergies).toEqual([34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72]);
        expect(EasyRoWeights.reduce((a, b) => a + b, 0)).toBeCloseTo(0.85, 12);
        expect(MaturityEngine.roFromF(0)).toBeCloseTo(0.2019, 4);
        // 0.20 to 4.69 %Ro, the published range of the model's output
        expect(MaturityEngine.roFromF(0.85)).toBeCloseTo(4.688, 3);
    });

    test('Easy%Ro through the engine equals the closed form at constant temperature', () => {
        // isothermal: F(t) = sum w_i (1 - exp(-A exp(-E_i/RT) t)), exact for any step length
        for (const [tC, ma] of [[100, 50], [140, 10], [180, 3]]) {
            const T = tC + 273.15;
            let st = MaturityEngine.initializeState('type2');
            for (let i = 0; i < 10; i++) st = MaturityEngine.step(st, T, ma / 10);
            const t = ma * 3.1536e13;
            const F = EasyRoWeights.reduce((acc, w, i) => acc + w * (1 - Math.exp(-1e13 * Math.exp(-(ActivationEnergies[i] * 4184) / (8.314 * T)) * t)), 0);
            expect(st.Ro).toBeCloseTo(Math.exp(-1.6 + 3.7 * F), 10);
        }
    });

    const thinThick = () => ({
        stratigraphy: [
            { id: 'thick', name: 'Thick shale', lithology: 'shale', ageStart: 100, ageEnd: 40, thickness: 1500 },
            { id: 'thin', name: 'Thin sand', lithology: 'sandstone', ageStart: 40, ageEnd: 30, thickness: 80 },
            { id: 'top', name: 'Overburden', lithology: 'shale', ageStart: 30, ageEnd: 0, thickness: 1200 },
        ],
        heatFlow: { type: 'constant', value: 65 },
        erosionEvents: [],
        settings: { surfaceTemp: 15 },
    });

    test('a layer of one slice reads the same Ro in the column as at its centre; a thick layer has a profile', async () => {
        const r = await SimulationEngine.run(thinThick());
        const col = r.data.column;
        const thin = col.filter((c) => c.layerId === 'thin');
        expect(thin).toHaveLength(1);
        const li = r.meta.layers.findIndex((l) => l.id === 'thin');
        const ro = r.data.maturity[li][r.data.maturity[li].length - 1].value;
        expect(Math.abs(thin[0].ro - ro)).toBeLessThan(1e-9);
        const thick = col.filter((c) => c.layerId === 'thick');
        expect(thick).toHaveLength(15);
        for (let i = 1; i < thick.length; i++) {
            expect(thick[i].depth).toBeGreaterThan(thick[i - 1].depth);
            expect(thick[i].ro).toBeGreaterThan(thick[i - 1].ro);
            expect(thick[i].temp).toBeGreaterThan(thick[i - 1].temp);
        }
        // the slices tile the layer exactly
        const b = r.data.burial[r.meta.layers.findIndex((l) => l.id === 'thick')].slice(-1)[0];
        expect(Math.abs(thick[0].top - b.top)).toBeLessThan(1e-6);
        expect(Math.abs(thick[thick.length - 1].bottom - b.bottom)).toBeLessThan(1e-6);
        // the single centre value sits inside the spread the profile shows
        const cRo = r.data.maturity[r.meta.layers.findIndex((l) => l.id === 'thick')].slice(-1)[0].value;
        expect(cRo).toBeGreaterThan(thick[0].ro);
        expect(cRo).toBeLessThan(thick[thick.length - 1].ro);
        expect(thick[thick.length - 1].ro - thick[0].ro).toBeGreaterThan(0.1);
    });
});

describe('U2-004 calibration reads the column', () => {
    test('the profile is the column when the result has one, the layer centres for an older result', () => {
        const p = calibrationProfile(ref);
        expect(p.length).toBe(ref.data.column.length);
        for (let i = 1; i < p.length; i++) expect(p[i].depth).toBeGreaterThan(p[i - 1].depth);
        const old = { ...ref, data: { ...ref.data, column: undefined } };
        expect(calibrationProfile(old)).toEqual(finalDepthProfile(old));
    });

    test('the heat-flow fit recovers the truth from Ro sampled inside thick layers', async () => {
        const truthProject = { ...refProject(), heatFlow: { type: 'constant', value: 72 } };
        const truth = await SimulationEngine.run(truthProject);
        const pts = truth.data.column.filter((_, i) => i % 6 === 3).map((c, i) => ({ id: i, depth: c.depth, value: c.ro }));
        const fitted = await HeatFlowFitter.fit({ ...truthProject, heatFlow: { type: 'constant', value: 50 } }, pts, []);
        expect(Math.abs(fitted.heatFlow.value - 72)).toBeLessThan(1.5);
    });
});

describe('U2-005 maximum-burial (irreversible) compaction', () => {
    const uplift = (mode) => ({
        stratigraphy: [
            { id: 'res', name: 'Reservoir shale', lithology: 'shale', ageStart: 100, ageEnd: 50, thickness: 800 },
            { id: 'ob', name: 'Overburden', lithology: 'shale', ageStart: 50, ageEnd: 20, thickness: 500 },
        ],
        heatFlow: { type: 'constant', value: 60 },
        erosionEvents: [{ age: 10, amount: 2500 }],
        settings: { surfaceTemp: 15, ...(mode ? { compaction: mode } : {}) },
    });

    // independent inverse: bisection on the solid-thickness integral
    const thicknessAt = (hs, top, phi0, c) => {
        let lo = hs; let hi = hs / (1 - phi0) + 1;
        for (let i = 0; i < 200; i++) {
            const mid = (lo + hi) / 2;
            const s = mid + (phi0 / c) * Math.exp(-c * top) * (Math.exp(-c * mid) - 1);
            if (s > hs) hi = mid; else lo = mid;
        }
        return (lo + hi) / 2;
    };

    test('a layer keeps its maximum-burial thickness after unroofing, and the present thickness is the input', async () => {
        const r = await SimulationEngine.run(uplift('irreversible'));
        expect(r.meta.compaction.mode).toBe('irreversible');
        expect(r.meta.compaction.presentThicknessErrorM).toBeLessThan(1e-3);
        const li = r.meta.layers.findIndex((l) => l.id === 'res');
        const b = r.data.burial[li];
        const atMax = b.find((e) => e.age === 11);
        const now = b[b.length - 1];
        expect(Math.abs(now.thickness - 800)).toBeLessThan(1e-3);
        expect(Math.abs(now.thickness - atMax.thickness)).toBeLessThan(1e-6);
        // the max-burial thickness from the same solid thickness by bisection
        const { phi0, c } = LithologyCompaction.shale;
        const hs = BurialCompactionEngine.solidThickness(r.meta.maxBurialTop.res, 800, phi0, c);
        expect(Math.abs(thicknessAt(hs, r.meta.maxBurialTop.res, phi0, c) - atMax.thickness)).toBeLessThan(1e-5);
        expect(r.meta.maxBurialTop.res).toBeGreaterThan(now.top + 1000);
    });

    test('control: elastic compaction re-expands the layer on unroofing', async () => {
        const r = await SimulationEngine.run(uplift(null));
        expect(r.meta.compaction.mode).toBe('elastic');
        const li = r.meta.layers.findIndex((l) => l.id === 'res');
        const b = r.data.burial[li];
        const atMax = b.find((e) => e.age === 11);
        expect(b[b.length - 1].thickness - atMax.thickness).toBeGreaterThan(50);
    });

    test('with no uplift the two modes agree', async () => {
        const p = uplift('irreversible'); p.erosionEvents = [];
        const e = uplift(null); e.erosionEvents = [];
        const a = await SimulationEngine.run(p);
        const b = await SimulationEngine.run(e);
        const li = a.meta.layers.findIndex((l) => l.id === 'res');
        expect(a.data.maturity[li].slice(-1)[0].value).toBeCloseTo(b.data.maturity[li].slice(-1)[0].value, 9);
    });
});

describe('U2-006 BHT corrections', () => {
    test('Horner: the ZetaWare worked example (10 h circulation; 115 at 8 h, 120 at 12 h) gives 134.80', () => {
        const r = hornerCorrection([{ shutInH: 8, temp: 115 }, { shutInH: 12, temp: 120 }], 10);
        expect(r.ok).toBe(true);
        expect(r.temp).toBeCloseTo(134.80, 2);
        expect(r.warnings.join(' ')).toMatch(/third run/);
    });

    test('Horner: three collinear runs fit with r2 = 1 and the same intercept', () => {
        const tc = 6; const tInf = 150; const m = -20;
        const runs = [4, 9, 16].map((ts) => ({ shutInH: ts, temp: tInf + m * Math.log((tc + ts) / ts) }));
        const r = hornerCorrection(runs, tc);
        expect(r.temp).toBeCloseTo(150, 9);
        expect(r.r2).toBeCloseTo(1, 12);
    });

    test('Horner refuses what it cannot do', () => {
        expect(hornerCorrection([{ shutInH: 8, temp: 115 }], 10).ok).toBe(false);
        expect(hornerCorrection([{ shutInH: 8, temp: 115 }, { shutInH: 12, temp: 120 }], 0).ok).toBe(false);
        expect(hornerCorrection([{ shutInH: 8, temp: 115 }, { shutInH: 8, temp: 120 }], 5).ok).toBe(false);
    });

    test('AAPG (Kehle, Gregory et al. 1980) in F and ft, converted: 10,000 ft adds 31.77 F = 17.65 C', () => {
        const r = aapgCorrection(100, 3048);
        expect(r.deltaC * 9 / 5).toBeCloseTo(31.77, 2);
        expect(r.temp).toBeCloseTo(100 + 31.768 * 5 / 9, 2);
    });

    test('Harrison (1983): 2,000 m adds 10.73 C; shallow wells get no negative correction', () => {
        expect(harrisonCorrection(80, 2000).deltaC).toBeCloseTo(10.728, 3);
        const s = harrisonCorrection(40, 500);
        expect(s.deltaC).toBeLessThan(0);
        expect(s.temp).toBe(40);
        expect(s.warnings[0]).toMatch(/negative/);
    });

    test('a list keeps the raw value, passes DST temperatures and says why a point was not corrected', () => {
        const out = correctTemperatures([
            { depth: 3048, value: 100 },
            { depth: 2500, value: 95, kind: 'DST' },
        ], 'aapg');
        expect(out[0].raw).toBe(100);
        expect(out[0].value).toBeGreaterThan(117);
        expect(out[1].value).toBe(95);
        expect(out[1].note).toMatch(/not corrected/);
        const h = correctTemperatures([{ depth: 3000, value: 100 }], 'horner');
        expect(h[0].value).toBe(100);
        expect(h[0].note).toMatch(/circulation time/);
    });
});

describe('U2-013 kinetics and lithology mixing', () => {
    // TR of a kinetics set under linear heating from 20 C at `rate` C/Ma,
    // through the engine's kineticStep (midpoint temperature, 0.05 Ma steps)
    const trWindow = (kin, rate = 2) => {
        let x = [...kin.potentials];
        const total = x.reduce((a, b) => a + b, 0);
        const sub = 0.05; let T = 20; let t10 = null; let t90 = null;
        while (T < 260 && t90 == null) {
            x = MaturityEngine.kineticStep(x, kin.aFactor, T + rate * sub / 2 + 273.15, sub, kin.energies);
            T += rate * sub;
            const tr = 1 - x.reduce((a, b) => a + b, 0) / total;
            if (t10 == null && tr >= 0.1) t10 = T;
            if (t90 == null && tr >= 0.9) t90 = T;
        }
        return [t10, t90];
    };

    test('Pepper and Corvi (1995) Table 3 as published', () => {
        expect(PepperCorvi1995.A).toMatchObject({ aFactor: 2.13e13, eMeanKJ: 206.4, sigmaKJ: 8.2 });
        expect(PepperCorvi1995.F).toMatchObject({ aFactor: 1.23e17, eMeanKJ: 259.1, sigmaKJ: 6.6 });
    });

    test('the Gaussian bins keep the published mean and spread', () => {
        const k = organofaciesKinetics('B');
        expect(k.potentials.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
        const mean = k.potentials.reduce((a, p, i) => a + p * k.energies[i] * 4.184, 0);
        const sd = Math.sqrt(k.potentials.reduce((a, p, i) => a + p * (k.energies[i] * 4.184 - mean) ** 2, 0));
        expect(mean).toBeCloseTo(215.2, 6);
        expect(Math.abs(sd - 8.3) / 8.3).toBeLessThan(0.01);
    });

    test('their oil window at 2 C/Ma: about 95-135 C for A and 145-175 C for F (through the engine)', () => {
        const [a10, a90] = trWindow(organofaciesKinetics('A'));
        const [f10, f90] = trWindow(organofaciesKinetics('F'));
        expect(Math.abs(a10 - 95)).toBeLessThan(6);
        expect(Math.abs(a90 - 135)).toBeLessThan(6);
        expect(Math.abs(f10 - 145)).toBeLessThan(6);
        expect(Math.abs(f90 - 175)).toBeLessThan(6);
        // and the window moves hotter A < B < C < D/E < F
        const t50 = ['A', 'B', 'C', 'DE', 'F'].map((k) => trWindow(organofaciesKinetics(k)).reduce((p, q) => p + q) / 2);
        for (let i = 1; i < t50.length; i++) expect(t50[i]).toBeGreaterThan(t50[i - 1]);
    });

    test('control: A with the kinetics of F misses the published A window', () => {
        const swapped = gaussianKinetics({ ...PepperCorvi1995.F });
        const [a10] = trWindow(swapped);
        expect(Math.abs(a10 - 95)).toBeGreaterThan(20);
    });

    test('kinetics resolve by key in a run, and the type II default is unchanged', async () => {
        expect(getKerogenParams('pc-A').energies.length).toBeGreaterThan(20);
        expect(getKerogenParams('type2').energies).toBeUndefined();
        const run = async (kerogen) => {
            const p = refProject();
            p.stratigraphy = p.stratigraphy.map((l) => (l.sourceRock ? { ...l, sourceRock: { ...l.sourceRock, kerogen } } : l));
            const r = await SimulationEngine.run(p);
            const li = r.meta.layers.findIndex((l) => l.id === 'source_shale');
            return r.data.transformation[li].slice(-1)[0].value;
        };
        const a = await run('pc-A'); const f = await run('pc-F');
        expect(a).toBeGreaterThan(f);
    });

    test('mixing: pure end members are the library; 50/50 sand-shale conductivity is the geometric mean', () => {
        expect(mixCompactionParams({ shale: 100 })).toEqual(LithologyCompaction.shale);
        const t = mixThermalProps({ sandstone: 1 });
        expect(t.conductivity).toBeCloseTo(ThermalProperties.sandstone.conductivity, 12);
        const m = mixThermalProps({ sandstone: 50, shale: 50 });
        expect(m.conductivity).toBeCloseTo(Math.sqrt(3.5 * 1.8), 12);
        expect(m.conductivity).not.toBeCloseTo((3.5 + 1.8) / 2, 2);
        expect(m.radiogenic).toBeCloseTo((1.2e-6 + 1.8e-6) / 2, 18);
        const c = mixCompactionParams({ sandstone: 30, shale: 70 });
        expect(c.phi0).toBeCloseTo(0.3 * 0.49 + 0.7 * 0.63, 12);
        expect(c.c).toBeCloseTo(0.3 * 0.00027 + 0.7 * 0.00051, 15);
        expect(mixCompactionParams({ nonsense: 5, __proto__: 3 })).toEqual(LithologyCompaction.default);
    });

    test('a mixed layer models between its end members', async () => {
        const proj = (lith, mix) => ({
            stratigraphy: [
                { id: 'a', name: 'A', lithology: lith, lithologyMix: mix, ageStart: 80, ageEnd: 30, thickness: 2000 },
                { id: 'b', name: 'B', lithology: 'shale', ageStart: 30, ageEnd: 0, thickness: 1000 },
            ],
            heatFlow: { type: 'constant', value: 60 }, erosionEvents: [], settings: { surfaceTemp: 15 },
        });
        const temp = async (p) => { const r = await SimulationEngine.run(p); return r.data.temperature[0].slice(-1)[0].value; };
        const sand = await temp(proj('sandstone'));
        const shale = await temp(proj('shale'));
        const mix = await temp(proj('mixed', { sandstone: 50, shale: 50 }));
        expect(mix).toBeGreaterThan(Math.min(sand, shale));
        expect(mix).toBeLessThan(Math.max(sand, shale));
    });
});

describe('U2-015 compaction-disequilibrium overpressure', () => {
    test('the solver matches the analytic constant-loading solution (Carslaw and Jaeger)', () => {
        const L = 1000; const n = 100; const h = L / n;
        const S = 1e-9; const K = 2e-16; const D = K / S; // m2/s
        const gamma = 1e6 / Spec.SECONDS_PER_MA; // 1 MPa/Ma
        const cells = Array.from({ length: n }, (_, i) => ({ zc: (i + 0.5) * h, h, S, K }));
        const dt = 0.0005 * Spec.SECONDS_PER_MA;
        let u = new Array(n).fill(0);
        const steps = 200;
        for (let k = 0; k < steps; k++) u = PressureEngine.diffuseStep(cells, u, new Array(n).fill(gamma * dt), dt);
        const t = steps * dt;
        const exact = (z) => {
            let s = 0;
            for (let m = 0; m < 400; m++) {
                const lam = ((2 * m + 1) * Math.PI) / (2 * L);
                s += (Math.sin(lam * z) * Math.exp(-D * lam * lam * t)) / lam ** 3;
            }
            return (gamma / D) * (L * z - (z * z) / 2 - (2 / L) * s);
        };
        const umax = exact(L - h / 2);
        expect(umax).toBeGreaterThan(5e4);
        cells.forEach((cl, i) => expect(Math.abs(u[i] - exact(cl.zc)) / umax).toBeLessThan(0.01));
    });

    test('control: with no loading nothing builds up; a drained top holds no pressure', () => {
        const cells = Array.from({ length: 10 }, (_, i) => ({ zc: (i + 0.5) * 10, h: 10, S: 1e-9, K: 1e-15 }));
        const u = PressureEngine.diffuseStep(cells, new Array(10).fill(0), new Array(10).fill(0), 1e12);
        expect(Math.max(...u.map(Math.abs))).toBe(0);
    });

    const fastShale = (ss) => ({
        stratigraphy: [
            { id: 'deep', name: 'Deep shale', lithology: 'shale', ageStart: 12, ageEnd: 6, thickness: 2500, ...(ss ? { permeability: { ss } } : {}) },
            { id: 'young', name: 'Young shale', lithology: 'shale', ageStart: 6, ageEnd: 0, thickness: 2500, ...(ss ? { permeability: { ss } } : {}) },
        ],
        heatFlow: { type: 'constant', value: 55 }, erosionEvents: [], settings: { surfaceTemp: 10 },
    });

    test('a fast-buried shale traps pressure below the overburden; a permeable one does not', async () => {
        const r = await SimulationEngine.run(fastShale(null));
        const col = r.data.column;
        const base = col[col.length - 1];
        expect(base.overpressurePa).toBeGreaterThan(5e6);
        col.forEach((c) => {
            expect(c.porePressurePa).toBeLessThanOrEqual(c.overburdenPa + 1);
            expect(c.hydrostaticPa).toBeCloseTo(Spec.RHO_WATER * Spec.G * c.depth, 6);
        });
        // monotone in depth below the drained top
        for (let i = 1; i < col.length; i++) expect(col[i].overpressurePa).toBeGreaterThanOrEqual(col[i - 1].overpressurePa - 1);
        const open = await SimulationEngine.run(fastShale(1e4));
        const ob = open.data.column[open.data.column.length - 1];
        expect(ob.overpressurePa).toBeLessThan(0.01 * base.overpressurePa);
    });

    test('the reference basin (slow burial) stays near hydrostatic and every value is finite', () => {
        ref.data.column.forEach((c) => {
            expect(Number.isFinite(c.porePressurePa)).toBe(true);
            expect(c.overpressurePa).toBeLessThan(0.5 * (c.overburdenPa - c.hydrostaticPa));
        });
        expect(ref.data.overpressure.every((s) => s.every((e) => Number.isFinite(e.value)))).toBe(true);
    });
});
