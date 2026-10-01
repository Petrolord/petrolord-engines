/**
 * Pore Pressure Studio U2 engine gates (2026-10-01). Every gate calls the
 * shipped function and carries a negative control that re-breaks the
 * physics and must fail.
 *
 *  U2-003 casing seats: the published Applied Drilling Engineering example
 *         (test-data/porepressure/casing-seat-example.json).
 *  U2-001 resistivity Eaton: Eaton's published exponent (1.2) recovers an
 *         imposed pore pressure from resistivity generated with it; the
 *         sonic exponent (3.0) does not.
 *  U2-005 segmented NCT; U2-006/007 calibration fits; U2-012 fracture
 *         methods (Zhang and Yin 2017 identities and the LOT round trip).
 */

import fs from 'fs';
import path from 'path';
import {
  casingSeatsBottomUp, marginLines, lineAt, seatHolds,
} from '../engines/porepressure/casingSeats';
import {
  nctResistivity, fitResistivityNct, eatonResistivity, EATON_N_RESISTIVITY, EATON_N_SONIC,
} from '../engines/porepressure/resistivity';
import { nctDt, nctDtSegmented, fitNct } from '../engines/porepressure/nct';
import { computeProfile } from '../engines/porepressure/profile';
import { eaton } from '../engines/porepressure/eaton';
import { bowersVLoading, bowersVUnloading, bowersSigmaLoading } from '../engines/porepressure/bowers';
import {
  fitEatonExponent, fitBowersLoading, fitBowersU, minimise1d,
} from '../engines/porepressure/calibrationFit';
import {
  eatonK, fracPressure, matthewsKellyFP, dainesFP, k0FromLot, dainesBetaFromLot, fracCoefficient,
  MATTHEWS_KELLY_K0_MOST_LIKELY,
} from '../engines/porepressure/fracgrad';
import { PA_PER_PSI } from '../engines/porepressure/constants';

const root = path.join(__dirname, '..');
const goldens = JSON.parse(fs.readFileSync(path.join(root, 'test-data/porepressure/goldens.json'), 'utf8'));
const EX = JSON.parse(fs.readFileSync(path.join(root, 'test-data/porepressure/casing-seat-example.json'), 'utf8'));
const W = goldens.well;
const P = W.params;
const baseParams = {
  waterDepthM: P.water_depth_m,
  rhoSeawaterKgM3: P.rho_seawater,
  rhoFluidKgM3: P.rho_fluid,
  nct: { dtMlUsPerM: P.dt_ml_us_per_m, dtMaUsPerM: P.dt_ma_us_per_m, cPerM: P.c_nct_per_m },
  method: 'eaton',
  eatonN: P.eaton_n,
  nu: P.nu,
};

// ---- U2-003 casing seats ---------------------------------------------------
describe('U2-003 casing seats: the published bottom-up example', () => {
  const depths = EX.data.map((r) => r[0]);
  const ppPcf = EX.data.map((r) => (r[1] / r[0]) * 144); // psi/ft x 144 = pcf
  const fgPcf = EX.data.map((r) => r[2] * 144);
  const run = (trip, kick, extra = {}) => casingSeatsBottomUp({
    depths, ppEmw: ppPcf, fgEmw: fgPcf, tripMargin: trip, kickMargin: kick, ...extra,
  });

  test('the design lines reproduce the published EMW table to its printed digit', () => {
    const { mud, designFg } = marginLines(ppPcf, fgPcf, 4, 4);
    EX.publishedEmwTable.rows.forEach(([z, pp, mw, fg, dfg], i) => {
      expect(depths[i]).toBe(z);
      // printed to one decimal, some truncated: within 0.1 pcf
      expect(Math.abs(ppPcf[i] - pp)).toBeLessThan(0.1);
      expect(Math.abs(mud[i] - mw)).toBeLessThan(0.1);
      expect(Math.abs(fgPcf[i] - fg)).toBeLessThan(0.1);
      expect(Math.abs(designFg[i] - dfg)).toBeLessThan(0.1);
    });
  });

  test('the mud at TD and the number of protective strings match the published answer', () => {
    const r = run(4, 4);
    expect(lineAt(depths, r.mud, 15000)).toBeCloseTo(EX.publishedAnswer.mudAtTdPcf, 1);
    // published: intermediate and surface strings above the 15,000 ft TD
    expect(r.seats).toHaveLength(2);
    expect(r.closedAt).toBeNull();
  });

  test('intermediate seat: the minimum depth lies at or above the published 11,700 ft, within the chart reading', () => {
    const r = run(4, 4);
    const inter = r.seats[r.seats.length - 1];
    // design line equals 128.3 pcf between 11,000 (125.6) and 12,000 ft (130.6)
    expect(inter.depth).toBeCloseTo(11000 + ((128.3 - 125.6) / (130.6 - 125.6)) * 1000, -1);
    expect(inter.depth).toBeLessThanOrEqual(EX.publishedAnswer.intermediateSeatFt);
    expect(EX.publishedAnswer.intermediateSeatFt - inter.depth).toBeLessThan(200);
    // the published seat holds the TD mud by the engine's own test
    expect(seatHolds({ depths, ppEmw: ppPcf, fgEmw: fgPcf, tripMargin: 4, kickMargin: 4 }, EX.publishedAnswer.intermediateSeatFt, 15000)).toBe(true);
  });

  test('surface seat: with the published 110 pcf to drill to 11,700 ft, the minimum lies at or above the published 6,600 ft', () => {
    // The published surface seat follows from the published intermediate
    // seat and its chart-read mud (110 pcf); the engine's own minimum chain
    // (11,540 ft, then the table mud there) lands shallower, as "at least"
    // allows. Step the engine from the published intermediate seat.
    const mudTo = EX.publishedAnswer.mudToDrillToIntermediatePcf;
    const zs = depths.filter((z) => z <= 11700);
    const fg = zs.map((z) => lineAt(depths, fgPcf, z));
    // a pore line whose planned mud is 110 pcf over the section isolates the step
    const pp = zs.map(() => mudTo - 4);
    const r = casingSeatsBottomUp({ depths: [...zs, 11700], ppEmw: [...pp, mudTo - 4], fgEmw: [...fg, lineAt(depths, fgPcf, 11700)], tripMargin: 4, kickMargin: 4 });
    const surface = r.seats[0];
    expect(surface.depth).toBeCloseTo(6000 + ((110 - 109.76) / (115.5 - 109.76)) * 2000, -1);
    expect(surface.depth).toBeLessThanOrEqual(EX.publishedAnswer.surfaceSeatFt);
    expect(EX.publishedAnswer.surfaceSeatFt - surface.depth).toBeLessThan(600);
    // the aquifer minimum is honoured when the seat would be shallower
    const shallow = run(4, 4, { minShallowSeat: 8000 });
    expect(shallow.seats[0].depth).toBe(8000);
    expect(shallow.seats[0].driver).toBe('minimum shallow seat');
  });

  test('negative control: no margins puts the intermediate seat 2,000 ft shallow of the published one', () => {
    const r = run(0, 0);
    const inter = r.seats[r.seats.length - 1];
    expect(EX.publishedAnswer.intermediateSeatFt - inter.depth).toBeGreaterThan(1500);
    // and a gate with the published tolerance would fail it
    expect(EX.publishedAnswer.intermediateSeatFt - inter.depth < 200).toBe(false);
  });

  test('negative control: margins read as ppg in a pcf table (4 ppg = 29.9 pcf) close the window', () => {
    const r = run(4 * 7.48052, 4 * 7.48052);
    expect(r.closedAt).not.toBeNull();
  });

  test('hostile input refused', () => {
    expect(() => casingSeatsBottomUp({ depths: [1, 1], ppEmw: [1, 1], fgEmw: [2, 2], tripMargin: 0, kickMargin: 0 })).toThrow(/increase/);
    expect(() => casingSeatsBottomUp({ depths: [1, 2], ppEmw: [1, NaN], fgEmw: [2, 2], tripMargin: 0, kickMargin: 0 })).toThrow(/Bad sample/);
    expect(() => casingSeatsBottomUp({ depths: [1, 2], ppEmw: [1, 1], fgEmw: [2, 2], tripMargin: -1, kickMargin: 0 })).toThrow(/margins/);
  });
});

// ---- U2-001 resistivity Eaton ----------------------------------------------
describe('U2-001 resistivity Eaton', () => {
  const r0 = 0.6; const b = 2.0e-4;
  // resistivity generated by inverting Eaton with the published exponent on
  // the goldens' imposed pore pressure (forward-inverse consistent)
  const resGen = (n) => W.z_bml_m.map((z, i) => {
    const S = W.overburden_pa[i]; const Ph = W.hydrostatic_pa[i]; const PP = W.pore_pressure_pa[i];
    const ratio = S - Ph > 1 ? ((S - PP) / (S - Ph)) ** (1 / n) : 1;
    return ratio * nctResistivity(z, r0, b);
  });
  const res12 = resGen(1.2);
  const params = { ...baseParams, method: 'eaton-resistivity', resNct: { r0OhmM: r0, bPerM: b } };

  test("Eaton's published exponents", () => {
    expect(EATON_N_RESISTIVITY).toBe(1.2);
    expect(EATON_N_SONIC).toBe(3.0);
  });

  test("Eaton's Gulf Coast case: S 1.0 psi/ft, normal 0.465 psi/ft, R/Rn 0.5 gives 1.0 - 0.535 x 0.5^1.2", () => {
    const D = 10000;
    const pp = eatonResistivity(1.0 * D * PA_PER_PSI, 0.465 * D * PA_PER_PSI, 0.5, 1.0);
    expect(pp / PA_PER_PSI / D).toBeCloseTo(1.0 - 0.535 * 0.5 ** 1.2, 12);
    expect(pp / PA_PER_PSI / D).toBeCloseTo(0.76713, 5);
  });

  test('the profile with n = 1.2 recovers the imposed pore pressure from resistivity', () => {
    const out = computeProfile({ zBmlM: W.z_bml_m, dtUsPerM: W.dt_us_per_m, rhoKgM3: W.rho_kg_m3, resOhmM: res12, params });
    let worst = 0;
    out.porePressurePa.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - W.pore_pressure_pa[i])); });
    expect(worst).toBeLessThan(1e-3); // Pa, on pressures near 50 MPa
    expect(out.resNormalOhmM[10]).toBeCloseTo(nctResistivity(W.z_bml_m[10], r0, b), 12);
  });

  test('negative control: the sonic exponent 3.0 on resistivity misses the ramp by megapascals', () => {
    const out = computeProfile({ zBmlM: W.z_bml_m, dtUsPerM: W.dt_us_per_m, rhoKgM3: W.rho_kg_m3, resOhmM: res12, params: { ...params, eatonNRes: 3.0 } });
    let worst = 0;
    out.porePressurePa.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - W.pore_pressure_pa[i])); });
    expect(worst).toBeGreaterThan(2e6);
  });

  test('the resistivity trend fit is exact on normally pressured picks', () => {
    const picks = W.z_bml_m.map((z, i) => [z, res12[i]]).filter(([z]) => z > 200 && z < 2400 && Math.round(z) % 200 === 0);
    const fit = fitResistivityNct(picks.map((p) => p[0]), picks.map((p) => p[1]));
    expect(fit.r0OhmM).toBeCloseTo(r0, 10);
    expect(fit.bPerM).toBeCloseTo(b, 14);
  });

  test('a sample with no sonic still computes from resistivity where density is logged; with neither it refuses', () => {
    const dt = [...W.dt_us_per_m]; dt[50] = null;
    const out = computeProfile({ zBmlM: W.z_bml_m, dtUsPerM: dt, rhoKgM3: W.rho_kg_m3, resOhmM: res12, params });
    expect(Math.abs(out.porePressurePa[50] - W.pore_pressure_pa[50])).toBeLessThan(1e-3);
    const rho = [...W.rho_kg_m3]; rho[50] = null;
    expect(() => computeProfile({ zBmlM: W.z_bml_m, dtUsPerM: dt, rhoKgM3: rho, resOhmM: res12, params })).toThrow(/overburden needs/);
    const bad = [...res12]; bad[7] = -999.25;
    expect(() => computeProfile({ zBmlM: W.z_bml_m, dtUsPerM: W.dt_us_per_m, rhoKgM3: W.rho_kg_m3, resOhmM: bad, params })).toThrow(/resistivity/);
    // the sonic method stays strict about a missing transit time
    expect(() => computeProfile({ zBmlM: W.z_bml_m, dtUsPerM: dt, rhoKgM3: W.rho_kg_m3, params: baseParams })).toThrow(/transit time/);
  });
});

// ---- U2-005 segmented NCT ---------------------------------------------------
describe('U2-005 segmented normal compaction trend', () => {
  const base = baseParams.nct;
  test('no segment reproduces the goldens', () => {
    const out = computeProfile({ zBmlM: W.z_bml_m, dtUsPerM: W.dt_us_per_m, rhoKgM3: W.rho_kg_m3, params: { ...baseParams, nctSegments: [] } });
    out.porePressurePa.forEach((v, i) => expect(Math.abs(v - W.pore_pressure_pa[i])).toBeLessThan(1e-3));
  });
  test('a segment applies from its top down, fitted on its own picks', () => {
    const seg = { zTopM: 1500, dtMlUsPerM: 600, cPerM: 5e-4 };
    expect(nctDtSegmented(1000, base, [seg])).toBe(nctDt(1000, base.dtMlUsPerM, base.dtMaUsPerM, base.cPerM));
    expect(nctDtSegmented(1500, base, [seg])).toBe(nctDt(1500, 600, base.dtMaUsPerM, 5e-4));
    const zs = [1600, 1800, 2000, 2200];
    const fit = fitNct(zs, zs.map((z) => nctDt(z, 600, base.dtMaUsPerM, 5e-4)), base.dtMaUsPerM);
    expect(fit.dtMl).toBeCloseTo(600, 9);
    expect(fit.c).toBeCloseTo(5e-4, 13);
    const out = computeProfile({ zBmlM: W.z_bml_m, dtUsPerM: W.dt_us_per_m, rhoKgM3: W.rho_kg_m3, params: { ...baseParams, nctSegments: [seg] } });
    const i = W.z_bml_m.indexOf(2000);
    expect(out.dtNormalUsPerM[i]).toBe(nctDt(2000, 600, base.dtMaUsPerM, 5e-4));
    // negative control: the segment changes the answer below its top only
    const j = W.z_bml_m.indexOf(1000);
    const plain = computeProfile({ zBmlM: W.z_bml_m, dtUsPerM: W.dt_us_per_m, rhoKgM3: W.rho_kg_m3, params: baseParams });
    expect(out.porePressurePa[j]).toBe(plain.porePressurePa[j]);
    expect(Math.abs(out.porePressurePa[i] - W.pore_pressure_pa[i])).toBeGreaterThan(1e5);
  });
  test('bad segments refused', () => {
    expect(() => computeProfile({ zBmlM: W.z_bml_m, dtUsPerM: W.dt_us_per_m, params: { ...baseParams, nctSegments: [{ zTopM: 0, dtMlUsPerM: 600, cPerM: 1e-4 }] } })).toThrow(/below the mudline/);
    expect(() => computeProfile({ zBmlM: W.z_bml_m, dtUsPerM: W.dt_us_per_m, params: { ...baseParams, nctSegments: [{ zTopM: 500, dtMlUsPerM: 600, cPerM: 1e-4 }, { zTopM: 500, dtMlUsPerM: 600, cPerM: 1e-4 }] } })).toThrow(/differ/);
  });
});

// ---- U2-006 / U2-007 calibration fits ---------------------------------------
describe('U2-006 fit Eaton n to measured pressures; U2-007 Bowers fits', () => {
  const at = [2600, 3000, 3400, 3800].map((z) => W.z_bml_m.indexOf(z));
  const ratioAt = (i) => W.dt_normal_us_per_m[i] / W.dt_us_per_m[i];

  test('n = 3 is recovered from four points of the imposed pressure', () => {
    const pts = at.map((i) => ({ S: W.overburden_pa[i], Ph: W.hydrostatic_pa[i], ratio: ratioAt(i), ppMeasured: W.pore_pressure_pa[i] }));
    const fit = fitEatonExponent(pts);
    expect(fit.n).toBeCloseTo(3, 7);
    expect(fit.rmsPa).toBeLessThan(1);
    expect(fit.atBound).toBe(false);
  });

  test('negative control: points 2 MPa high pull n off 3 and the misfit says so', () => {
    const pts = at.map((i) => ({ S: W.overburden_pa[i], Ph: W.hydrostatic_pa[i], ratio: ratioAt(i), ppMeasured: W.pore_pressure_pa[i] + 2e6 }));
    const fit = fitEatonExponent(pts);
    expect(Math.abs(fit.n - 3)).toBeGreaterThan(0.2);
  });

  test('resistivity: n = 1.2 recovered', () => {
    const pts = at.map((i) => {
      const S = W.overburden_pa[i]; const Ph = W.hydrostatic_pa[i]; const PP = W.pore_pressure_pa[i];
      return { S, Ph, ratio: ((S - PP) / (S - Ph)) ** (1 / 1.2), ppMeasured: PP };
    });
    expect(fitEatonExponent(pts).n).toBeCloseTo(1.2, 7);
  });

  test('Bowers A and B recovered exactly from loading points', () => {
    const A = 10; const B = 0.75;
    const pts = [5e6, 10e6, 20e6, 30e6].map((sig) => ({ vMs: bowersVLoading(sig, A, B), S: sig + 40e6, ppMeasured: 40e6 }));
    const fit = fitBowersLoading(pts);
    expect(fit.A).toBeCloseTo(A, 9);
    expect(fit.B).toBeCloseTo(B, 12);
    expect(fit.rmsPa).toBeLessThan(1e-3);
    // negative control: one point with a 5 MPa error moves A and B
    const bad = pts.map((p, k) => (k === 2 ? { ...p, ppMeasured: p.ppMeasured + 5e6 } : p));
    expect(Math.abs(fitBowersLoading(bad).B - B)).toBeGreaterThan(0.01);
  });

  test('Bowers U recovered for a given sigma max; sigma max from V max', () => {
    const A = 10; const B = 0.75; const U = 4; const smax = 35e6;
    expect(bowersSigmaLoading(bowersVLoading(smax, A, B), A, B)).toBeCloseTo(smax, 3);
    const pts = [10e6, 18e6, 25e6].map((sig) => ({ vMs: bowersVUnloading(sig, smax, A, B, U), S: sig + 50e6, ppMeasured: 50e6 }));
    const fit = fitBowersU(pts, { A, B, sigmaMaxPa: smax });
    expect(fit.U).toBeCloseTo(U, 6);
  });

  test('the 1-D search does not stop in a side dip', () => {
    const f = (x) => (x < 1 ? (x - 0.5) ** 2 + 0.2 : (x - 4) ** 2);
    expect(minimise1d(f, 0, 6).x).toBeCloseTo(4, 8);
  });

  test('hostile points refused', () => {
    expect(() => fitEatonExponent([])).toThrow(/at least one/);
    expect(() => fitEatonExponent([{ S: 1, Ph: 0.5, ratio: NaN, ppMeasured: 0.6 }])).toThrow(/ratio/);
    expect(() => fitBowersLoading([{ vMs: 1000, S: 1e6, ppMeasured: 2e6 }])).toThrow(/two points/);
  });
});

// ---- U2-012 fracture methods ------------------------------------------------
describe('U2-012 fracture methods (Zhang and Yin 2017, eqs. 3, 4, 7)', () => {
  const S = 60e6; const PP = 35e6;
  test('Eaton equals Matthews and Kelly when k0 = nu / (1 - nu): nu 3/7 gives the published k0 0.75', () => {
    expect(eatonK(3 / 7)).toBeCloseTo(MATTHEWS_KELLY_K0_MOST_LIKELY, 14);
    expect(matthewsKellyFP(S, PP, 0.75)).toBeCloseTo(fracPressure(S, PP, eatonK(3 / 7)), 6);
    expect(eatonK(1 / 3)).toBeCloseTo(0.5, 14); // sandstones, nu 0.3 to 1/3
  });
  test('Daines with beta 0 is Eaton; with beta it adds beta (S - PP)', () => {
    expect(dainesFP(S, PP, 0.25, 0)).toBe(fracPressure(S, PP, eatonK(0.25)));
    expect(dainesFP(S, PP, 0.25, 0.1) - dainesFP(S, PP, 0.25, 0)).toBeCloseTo(0.1 * (S - PP), 6);
  });
  test('LOT round trip: k0 and beta from a LOT reproduce the LOT at its depth', () => {
    const lot = 52e6;
    expect(matthewsKellyFP(S, PP, k0FromLot(lot, S, PP))).toBeCloseTo(lot, 6);
    expect(dainesFP(S, PP, 0.3, dainesBetaFromLot(lot, S, PP, 0.3))).toBeCloseTo(lot, 6);
  });
  test('the profile uses the chosen method; Eaton stays the default', () => {
    const run = (extra) => computeProfile({ zBmlM: W.z_bml_m, dtUsPerM: W.dt_us_per_m, rhoKgM3: W.rho_kg_m3, params: { ...baseParams, ...extra } });
    const e = run({});
    W.frac_pressure_pa.forEach((v, i) => expect(Math.abs(e.fracPressurePa[i] - v)).toBeLessThan(1e-6));
    const mk = run({ fracMethod: 'matthews-kelly', k0: 0.75 });
    const i = 300;
    expect(mk.fracPressurePa[i]).toBeCloseTo(0.75 * (mk.overburdenPa[i] - mk.porePressurePa[i]) + mk.porePressurePa[i], 6);
    // negative control: k0 applied to the total overburden instead of the effective one
    expect(Math.abs(mk.fracPressurePa[i] - (0.75 * mk.overburdenPa[i] + mk.porePressurePa[i]))).toBeGreaterThan(1e7);
    const d = run({ fracMethod: 'daines', beta: 0.05 });
    expect(d.fracPressurePa[i]).toBeCloseTo((0.05 + eatonK(P.nu)) * (d.overburdenPa[i] - d.porePressurePa[i]) + d.porePressurePa[i], 6);
    expect(() => fracCoefficient({ fracMethod: 'hubbert' })).toThrow(/Unknown/);
    expect(() => run({ fracMethod: 'matthews-kelly', k0: 2 })).toThrow(/k0/);
  });
});
