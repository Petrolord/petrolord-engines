/**
 * FS7 gates — CCE + differential liberation + composite black-oil table.
 *
 * GATE (oracle): CCE relative volume / liquid dropout, DL stage
 * Bod/Rsd/gas properties, residual oil, and the separator-adjusted
 * composite table (Rs/Bo/Bg/Z/LBC viscosities, KPIs) must match the
 * independent Python oracle counterparts in goldens.json `experiments`
 * on the committed pressure grids.
 * Identity gates: exact truths — single phase above Psat, relVol -> 1
 * approaching Psat, DL mole balance, Rsd telescoping to the cooldown
 * gas, Bo(Pb) = Bofb and Rs(Pb) = Rsfb, monotonic saturated columns,
 * Bg matching the black-oil 0.00504 zT/p convention, and the documented
 * degradations (missing Psat throws; a gas feed yields ok: false).
 */

import { mixtureFromKeys } from '../engines/fluid/pr78.js';
import { mixtureWithPlusFraction } from '../engines/fluid/characterization.js';
import { saturationPressure } from '../engines/fluid/envelope.js';
import { degFtoR } from '../engines/fluid/units.js';
import { SCF_PER_LBMOL, FT3_PER_BBL } from '../engines/fluid/separator.js';
import {
  cceExperiment, differentialLiberation, eosBlackOilTable, bgRbPerScf,
} from '../engines/fluid/experiments.js';
import goldens from '../test-data/fluid/goldens.json';

const relErr = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
const buildMix = (job) => (job.plus
  ? mixtureWithPlusFraction(job.keys, job.plus)
  : mixtureFromKeys(job.keys));

describe('FS7 GATE: CCE vs oracle', () => {
  describe.each(goldens.experiments)('$fluid', (job) => {
    const mix = buildMix(job);
    const tR = degFtoR(job.tF);

    test('saturation pressure agrees with the oracle boundary', () => {
      const sat = saturationPressure(mix, job.x, tR, {});
      expect(relErr(sat.pPsia, job.psatPsia)).toBeLessThan(1e-4);
    });

    test('CCE rows on the committed grid', () => {
      const cce = cceExperiment(mix, job.x, tR,
        { psatPsia: job.psatPsia, pressures: job.ccePressures });
      expect(cce.rows.length).toBe(job.cce.rows.length);
      job.cce.rows.forEach((g, i) => {
        const e = cce.rows[i];
        expect(e.phases).toBe(g.phases);
        expect(Math.abs(e.relVol - g.relVol)).toBeLessThan(1e-7);
        if (g.liquidVolFrac != null) {
          expect(Math.abs(e.liquidVolFrac - g.liquidVolFrac)).toBeLessThan(1e-7);
        }
        if (g.beta != null) expect(Math.abs(e.beta - g.beta)).toBeLessThan(1e-7);
      });
    });

    test('identities: single phase above Psat, monotonic expansion', () => {
      const cce = cceExperiment(mix, job.x, tR,
        { psatPsia: job.psatPsia, pressures: job.ccePressures });
      cce.rows.filter((r) => r.pPsia > job.psatPsia)
        .forEach((r) => expect(r.phases).toBe(1));
      const sorted = cce.rows.slice().sort((a, b) => b.pPsia - a.pPsia);
      sorted.forEach((r, i) => {
        if (i > 0) expect(r.relVol).toBeGreaterThanOrEqual(sorted[i - 1].relVol - 1e-12);
      });
      const nearSat = cceExperiment(mix, job.x, tR,
        { psatPsia: job.psatPsia, pressures: [job.psatPsia * 1.0005] });
      expect(Math.abs(nearSat.rows[0].relVol - 1)).toBeLessThan(5e-3);
    });
  });
});

describe('FS7 GATE: DL + composite table vs oracle', () => {
  const job = goldens.experiments.find((j) => j.dlPressures);
  const mix = mixtureWithPlusFraction(job.keys, job.plus);
  const tR = degFtoR(job.tF);
  const table = eosBlackOilTable(mix, job.x, tR,
    job.sepStagesF.map(([tF, pPsia]) => ({ tR: degFtoR(tF), pPsia })),
    {
      psatPsia: job.psatPsia,
      dlPressures: job.dlPressures,
      undersatPressures: job.undersatPressures,
    });

  test('DL stages match the oracle', () => {
    expect(table.ok).toBe(true);
    const { dl } = table;
    expect(dl.stages.length).toBe(job.table.dl.stages.length);
    job.table.dl.stages.forEach((g, i) => {
      const e = dl.stages[i];
      expect(Math.abs(e.oilMoles - g.oilMoles)).toBeLessThan(5e-7);
      expect(Math.abs(e.bod - g.bod)).toBeLessThan(5e-7);
      expect(Math.abs(e.rsd - g.rsd)).toBeLessThan(1e-4);
      if (g.gasGravity != null) expect(Math.abs(e.gasGravity - g.gasGravity)).toBeLessThan(1e-7);
      if (g.gasZ != null) expect(Math.abs(e.gasZ - g.gasZ)).toBeLessThan(1e-7);
    });
    expect(relErr(dl.residual.density, job.table.dl.residual.density)).toBeLessThan(1e-8);
  });

  test('composite rows and KPIs match the oracle transcription', () => {
    expect(table.rows.length).toBe(job.table.rows.length);
    job.table.rows.forEach((g, i) => {
      const e = table.rows[i];
      expect(e.phase).toBe(g.phase);
      expect(Math.abs(e.Rs - g.Rs)).toBeLessThan(1e-4);
      expect(Math.abs(e.Bo - g.Bo)).toBeLessThan(1e-7);
      if (g.Bg != null) expect(Math.abs(e.Bg - g.Bg)).toBeLessThan(1e-9);
      if (g.Z != null) expect(Math.abs(e.Z - g.Z)).toBeLessThan(1e-8);
      expect(Math.abs(e.mu_o - g.mu_o)).toBeLessThan(1e-7);
      if (g.mu_g != null) expect(Math.abs(e.mu_g - g.mu_g)).toBeLessThan(1e-8);
    });
    Object.entries(job.table.kpis).forEach(([k, v]) => {
      expect(relErr(table.kpis[k], v)).toBeLessThan(1e-8);
    });
  });

  test('identities: mole balance, telescoping, Pb pinning, monotonicity', () => {
    const { dl } = table;
    const gasMoles = dl.stages.reduce((s, st) => s + st.gasMolesRemoved, 0)
      + dl.cooldownGasScf / SCF_PER_LBMOL;
    expect(Math.abs(dl.residual.moles + gasMoles - 1)).toBeLessThan(1e-10);
    expect(Math.abs(
      dl.stages[dl.stages.length - 1].rsd
      - dl.cooldownGasScf / (dl.residual.volFt3 / FT3_PER_BBL),
    )).toBeLessThan(1e-9);

    const pbRow = table.rows.find((r) => r.phase === 'saturated');
    expect(Math.abs(pbRow.Bo - table.kpis.bofb)).toBeLessThan(1e-12);
    expect(Math.abs(pbRow.Rs - table.kpis.rsfb)).toBeLessThan(1e-9);
    const sat = table.rows.filter((r) => r.phase !== 'undersaturated');
    sat.forEach((r, i) => {
      if (i === 0) return;
      expect(r.Rs).toBeLessThanOrEqual(sat[i - 1].Rs + 1e-9);
      expect(r.Bo).toBeLessThanOrEqual(sat[i - 1].Bo + 1e-12);
    });
    // undersaturated rows continuous with the Pb row and compressing upward
    const under = table.rows.filter((r) => r.phase === 'undersaturated');
    under.forEach((r) => {
      expect(r.Rs).toBe(table.kpis.rsfb);
      expect(r.Bo).toBeLessThan(table.kpis.bofb);
    });
  });

  test('Bg matches the black-oil 0.00504 zT/p convention', () => {
    // black-oil bgAt uses the rounded 0.00504 and tempF + 460; agree to ~1e-6
    expect(bgRbPerScf(1, degFtoR(200), 1000))
      .toBeCloseTo((0.00504 * (200 + 460)) / 1000, 5);
    // exact statement: (z T / p) (Psc/Tsc) / 5.614583
    expect(bgRbPerScf(0.9, 660, 1500))
      .toBeCloseTo(((0.9 * 660) / 1500) * (14.696 / 519.67) / 5.614583, 15);
  });
});

describe('FS7 degradations', () => {
  const job = goldens.experiments.find((j) => j.dlPressures);
  const mix = mixtureWithPlusFraction(job.keys, job.plus);

  test('missing Psat throws (the caller owns the slow solve)', () => {
    expect(() => cceExperiment(mix, job.x, degFtoR(job.tF), {})).toThrow(/psatPsia/);
    expect(() => differentialLiberation(mix, job.x, degFtoR(job.tF), {})).toThrow(/psatPsia/);
    expect(() => eosBlackOilTable(mix, job.x, degFtoR(job.tF), [], {})).toThrow(/psatPsia/);
  });

  test('a lean-gas feed yields ok: false with the no-liquid warning', () => {
    const lean = mixtureFromKeys(['N2', 'CO2', 'C1', 'C2', 'C3']);
    const zg = [0.02, 0.02, 0.85, 0.07, 0.04];
    // fabricate a nominal psat; the DL sweep vaporizes everything
    const res = eosBlackOilTable(lean, zg, degFtoR(150), [], { psatPsia: 1000 });
    expect(res.ok).toBe(false);
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});
