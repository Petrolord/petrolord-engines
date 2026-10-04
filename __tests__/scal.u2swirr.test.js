/**
 * SCAL Studio U2 (SCAL-U2-006, SCAL-U2-005).
 *
 * U2-006: fit Swirr with a and b (three-parameter power-law J). Truth is
 * synthetic: lab Pc of two very different rocks made from ONE J curve
 * (a 0.28, b 1.45, Swirr 0.12, the SCAL Studio demo pair) and turned back
 * into J by the engine's computeJTable. The data-driven Swirr (lowest Sw
 * less 0.02) is the negative control: it returns b 1.15 on this data.
 *
 * U2-005: reservoir oil and brine densities from a black-oil description.
 * Checked against the published differential liberation of Good Oil Co.
 * Well No. 4 (Core Laboratories RFL 88001, the study McCain and Ahmed
 * reproduce; typed below from the report copy in the Texas A&M P324 course
 * archive, page 7, as the Suite's e2e/fixtures/fluid-systems/lab/good-oil-dl-twin.csv):
 * the measured oil density at every pressure against the mass balance of
 * the residual oil and the gas still in solution, with the gas gravities
 * of the liberation stages.
 */
import {
  computeJTable, fitJPowerLaw, LEVERETT_C, reservoirFluidGravities, PSI_PER_FT_WATER, heightFromPc,
} from '../engines/scal/scal.js';

const J_TRUE = { a: 0.28, b: 1.45, Swirr: 0.12 };
const jAt = (Sw) => J_TRUE.a * Math.pow((Sw - J_TRUE.Swirr) / (1 - J_TRUE.Swirr), -J_TRUE.b);
const SW = [0.18, 0.24, 0.32, 0.42, 0.55, 0.7, 0.85, 0.95];
const rockRows = (rock) => {
  const pc = SW.map((Sw) => ({ Sw, Pc_psi: (jAt(Sw) * rock.sigma_dyncm * Math.cos((rock.thetaDeg * Math.PI) / 180)) / (LEVERETT_C * Math.sqrt(rock.k_md / rock.phi)) }));
  return computeJTable(pc, rock).rows.map((r) => ({ Sw: r.Sw, J: r.J }));
};
const ROCK_A = { k_md: 420, phi: 0.27, sigma_dyncm: 72, thetaDeg: 0 };
const ROCK_B = { k_md: 35, phi: 0.16, sigma_dyncm: 480, thetaDeg: 40 };

describe('SCAL-U2-006: fit Swirr with a and b', () => {
  const pooled = [...rockRows(ROCK_A), ...rockRows(ROCK_B)];

  it('the two rocks\' lab J, pooled, give back the generating curve, Swirr included', () => {
    const fit = fitJPowerLaw(pooled, { fitSwirr: true });
    expect(fit.ok).toBe(true);
    expect(fit.swirrFitted).toBe(true);
    expect(fit.Swirr).toBeCloseTo(0.12, 6);
    expect(fit.b).toBeCloseTo(1.45, 5);
    expect(fit.a).toBeCloseTo(0.28, 5);
    expect(fit.ci95.Swirr).toHaveLength(2);
    expect(fit.r2Log).toBeGreaterThan(0.999999);
    expect(fit.swirrStart).toBeCloseTo(0.16, 12);
  });

  it('NEGATIVE CONTROL: the data-driven Swirr (lowest Sw less 0.02) gives a wrong exponent', () => {
    const fixed = fitJPowerLaw(pooled);
    expect(fixed.swirrFitted).toBe(false);
    expect(fixed.Swirr).toBeCloseTo(0.16, 12);
    expect(Math.abs(fixed.b - 1.45)).toBeGreaterThan(0.2);
  });

  it('noisy data: Swirr inside its bound and the truth inside the 95% interval', () => {
    const noisy = pooled.map((r, i) => ({ Sw: r.Sw, J: r.J * (1 + 0.03 * Math.sin(2.3 * i + 0.7)) }));
    const fit = fitJPowerLaw(noisy, { fitSwirr: true });
    expect(fit.Swirr).toBeLessThan(0.18);
    expect(fit.Swirr).toBeGreaterThanOrEqual(0);
    expect(fit.ci95.Swirr[0]).toBeLessThan(0.12);
    expect(fit.ci95.Swirr[1]).toBeGreaterThan(0.12);
  });

  it('the two-parameter fit is unchanged and refuses too few points for three', () => {
    const two = fitJPowerLaw(rockRows(ROCK_A), { Swirr: 0.12 });
    expect(two.b).toBeCloseTo(1.45, 6);
    expect(fitJPowerLaw(rockRows(ROCK_A).slice(0, 3), { fitSwirr: true }).ok).toBe(false);
  });
});

describe('SCAL-U2-005: reservoir fluid densities from a black-oil description', () => {
  // pressure psig, Rsd scf/bbl residual oil, Bod, oil density g/cc, incremental gas gravity (air = 1)
  const dl = [
    [2620, 854, 1.600, 0.6562, null], [2350, 763, 1.554, 0.6655, 0.831], [2100, 684, 1.515, 0.6731, 0.810],
    [1850, 612, 1.479, 0.6808, 0.797], [1600, 544, 1.445, 0.6889, 0.791], [1350, 479, 1.412, 0.6969, 0.794],
    [1100, 416, 1.382, 0.7044, 0.809], [850, 354, 1.351, 0.7121, 0.831], [600, 292, 1.320, 0.7198, 0.881],
    [350, 223, 1.283, 0.7291, 0.988], [159, 157, 1.244, 0.7382, 1.213], [0, 0, 1.075, 0.7892, 2.039],
  ].map(([p, Rsd, Bod, rho, gg]) => ({ p, Rsd, Bod, rho, gg }));
  // residual oil at 60 degF: its density at 220 degF and 0 psig times its Bod there
  const residual = dl[dl.length - 1];
  const residualApi = 141.5 / ((residual.rho * residual.Bod) / 0.99904) - 131.5;
  // the gas still in solution at row i: the gas of every later liberation stage, with its gravity
  const gasInSolution = (i) => {
    let scf = 0;
    let gravityScf = 0;
    for (let k = i + 1; k < dl.length; k++) {
      const d = dl[k - 1].Rsd - dl[k].Rsd;
      scf += d;
      gravityScf += d * dl[k].gg;
    }
    return { scf, gravity: scf > 0 ? gravityScf / scf : 1 };
  };

  it('the residual oil is the 35.1 degAPI oil of the study', () => {
    expect(residualApi).toBeCloseTo(35.1, 1);
  });

  it('PUBLISHED CHECK: the measured oil density at every pressure, within 0.2 percent (max 0.07 found)', () => {
    for (let i = 0; i < dl.length - 1; i++) {
      const gas = gasInSolution(i);
      expect(gas.scf).toBeCloseTo(dl[i].Rsd, 6);
      const r = reservoirFluidGravities({ api: residualApi, gasGravity: gas.gravity, Rs_scf_stb: gas.scf, Bo: dl[i].Bod, Bw: 1 });
      const gcc = r.rhoOil_lbft3 / 62.428;
      expect(Math.abs(gcc / dl[i].rho - 1)).toBeLessThan(0.002);
    }
  });

  it('NEGATIVE CONTROL: leaving the dissolved gas out misses the bubble point density by over 10 percent', () => {
    const gas = gasInSolution(0);
    const r = reservoirFluidGravities({ api: residualApi, gasGravity: gas.gravity, Rs_scf_stb: 0, Bo: dl[0].Bod, Bw: 1 });
    expect(Math.abs(r.rhoOil_lbft3 / 62.428 / dl[0].rho - 1)).toBeGreaterThan(0.1);
  });

  it("gravities sit on the height formula's gradient: 0.4335 (gw - go) = (rho_w - rho_o) / 144", () => {
    const r = reservoirFluidGravities({ api: 35, gasGravity: 0.8, Rs_scf_stb: 600, Bo: 1.35, Bw: 1.02, salinity_ppm: 50000 });
    expect(PSI_PER_FT_WATER * (r.gammaWater - r.gammaOil)).toBeCloseTo((r.rhoWater_lbft3 - r.rhoOil_lbft3) / 144, 12);
    expect(heightFromPc(10, { gammaW: r.gammaWater, gammaHc: r.gammaOil })).toBeCloseTo(10 / ((r.rhoWater_lbft3 - r.rhoOil_lbft3) / 144), 9);
    // fresh water at standard conditions is the 60 degF reference
    expect(reservoirFluidGravities({ api: 35, gasGravity: 0.8, Rs_scf_stb: 0, Bo: 1, Bw: 1, salinity_ppm: 0 }).rhoWaterStd_lbft3).toBeCloseTo(62.368, 6);
  });

  it('refuses a description with a missing value, with the reason', () => {
    const r = reservoirFluidGravities({ api: 35, gasGravity: 0.8, Rs_scf_stb: 600, Bw: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/Bo/);
  });
});
