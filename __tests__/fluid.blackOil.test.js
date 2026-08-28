/**
 * Central black-oil correlation gates.
 *
 * The code in engines/fluid/blackOil.ts moved unchanged out of
 * engines/mbal/mbalEngine.ts, where the material-balance gates already pin it
 * end to end. These are the DIRECT gates the module needs now that it has
 * consumers of its own: exact thermodynamic and algebraic identities that hold
 * whatever the correlation set, published-range behaviour of the warning
 * functions, and one cross-repo anchor.
 *
 * Identities are asserted, not measured: each one is true by construction and
 * would break under a transcription error in the constants.
 */

import {
  standingPb, standingRs, standingBoSat,
  vasquezBeggsPb, vasquezBeggsRs, vasquezBeggsBoSat,
  glasoPb, glasoRs, glasoBoSat,
  hallYarboroughZ, dranchukAbouKassemZ,
  bgRbPerScf, bwApprox, mccainBw, mccainMuW,
  bealDeadOilViscosity, beggsRobinsonLiveOilViscosity,
  vasquezBeggsUndersaturatedOilViscosity, leeGonzalezEakinGasViscosity,
  correlationValidityWarnings, viscosityValidityWarnings,
} from '../engines/fluid/blackOil';
import { bgRbPerScf as eosBg } from '../engines/fluid/experiments.js';

const API = 32;
const GAS_SG = 0.75;
const TEMP_F = 180;
const OIL_SG = 141.5 / (API + 131.5);

describe('cross-repo anchor: the Ekene fluid', () => {
  // The NextGen RC5 Simulation Essentials course grades the solution gas
  // Standing returns at Ekene's 2000 psia bubble point for its 32 API oil, and
  // pins it independently in petrolord-nextgen's own teaching lab. Both sides
  // must be reading the same correlation.
  it('reproduces the RC5 graded Rs at the bubble point', () => {
    expect(standingRs(2000, 2000, GAS_SG, API, TEMP_F)).toBe(421.93922752270595);
  });
});

describe('Pb and Rs are inverses of one another', () => {
  // Each correlation pair solves the same relation for a different unknown, so
  // composing them has to return the input. This is the gate that catches a
  // mistyped exponent, because a single digit breaks the round trip.
  const RS = 500;
  it('Standing', () => {
    const pb = standingPb(RS, GAS_SG, API, TEMP_F);
    expect(standingRs(pb, pb, GAS_SG, API, TEMP_F)).toBeCloseTo(RS, 8);
  });
  it('Vasquez-Beggs', () => {
    const pb = vasquezBeggsPb(RS, GAS_SG, API, TEMP_F);
    expect(vasquezBeggsRs(pb, pb, GAS_SG, API, TEMP_F)).toBeCloseTo(RS, 8);
  });
  it('Glaso', () => {
    const pb = glasoPb(RS, GAS_SG, API, TEMP_F);
    expect(glasoRs(pb, pb, GAS_SG, API, TEMP_F)).toBeCloseTo(RS, 8);
  });
});

describe('Rs saturates at the bubble point, in all three correlations', () => {
  // Undersaturated oil has released no gas, so Rs above pb is Rsb. Standing
  // was the one of the three that took pb and ignored it; the clamp was added
  // when these correlations were centralized, and this is the gate that keeps
  // the contract from depending on which correlation a caller selected.
  const PB = 2000;
  it.each([
    ['Standing', standingRs],
    ['Vasquez-Beggs', vasquezBeggsRs],
    ['Glaso', glasoRs],
  ])('%s', (_name, rsFn) => {
    const at_pb = rsFn(PB, PB, GAS_SG, API, TEMP_F);
    expect(rsFn(PB + 1500, PB, GAS_SG, API, TEMP_F)).toBe(at_pb);
    expect(rsFn(PB - 1500, PB, GAS_SG, API, TEMP_F)).toBeLessThan(at_pb);
  });
});

describe('Bo rises with solution gas', () => {
  // More dissolved gas swells a stock tank barrel, in every correlation.
  it.each([
    ['Standing', (rs) => standingBoSat(rs, GAS_SG, OIL_SG, TEMP_F)],
    ['Vasquez-Beggs', (rs) => vasquezBeggsBoSat(rs, GAS_SG, API, TEMP_F)],
    ['Glaso', (rs) => glasoBoSat(rs, GAS_SG, OIL_SG, TEMP_F)],
  ])('%s', (_name, boFn) => {
    const rows = [0, 200, 400, 600, 800].map(boFn);
    rows.forEach((bo, i) => {
      expect(bo).toBeGreaterThan(1);
      if (i > 0) expect(bo).toBeGreaterThan(rows[i - 1]);
    });
  });
});

describe('gas z-factor', () => {
  // Both correlations solve the same reduced-state surface by different means:
  // Hall-Yarborough by Newton on a reduced density, Dranchuk-Abou-Kassem by
  // an eleven-constant fit. They agree where both are valid.
  it('approaches the ideal-gas limit as pressure falls', () => {
    expect(hallYarboroughZ(0.05, 1.5)).toBeGreaterThan(0.98);
    expect(dranchukAbouKassemZ(0.05, 1.5)).toBeGreaterThan(0.98);
  });
  it('dips below unity in the compressible region and recovers above it', () => {
    const z_mid = hallYarboroughZ(2.5, 1.5);
    expect(z_mid).toBeLessThan(1);
    expect(hallYarboroughZ(10, 1.5)).toBeGreaterThan(z_mid);
  });
  it('the two correlations agree within 2 percent over the common range', () => {
    for (const tpr of [1.3, 1.5, 2.0, 2.5]) {
      for (const ppr of [0.5, 1.5, 3, 5, 8]) {
        const hy = hallYarboroughZ(ppr, tpr);
        const dak = dranchukAbouKassemZ(ppr, tpr);
        expect(Math.abs(hy - dak) / dak).toBeLessThan(0.02);
      }
    }
  });
});

describe('gas formation volume factor', () => {
  // Bg = 0.005035 z T_R / p in rb/scf, so it is exactly inverse in pressure at
  // fixed z and exactly linear in ABSOLUTE temperature, on the 459.67 offset.
  it('is inverse in pressure and linear in absolute temperature', () => {
    expect(bgRbPerScf(2000, TEMP_F, 0.9) / bgRbPerScf(4000, TEMP_F, 0.9)).toBeCloseTo(2, 12);
    expect(bgRbPerScf(2000, 180, 0.9) / bgRbPerScf(2000, 60, 0.9))
      .toBeCloseTo((180 + 459.67) / (60 + 459.67), 12);
  });
  it('carries the 0.005035 rb/scf convention on a 459.67 Rankine offset', () => {
    expect(bgRbPerScf(1000, 40.33, 1)).toBeCloseTo(0.005035 * 500 / 1000, 15);
  });
});

describe('SHARP EDGE: two bgRbPerScf live in engines/fluid', () => {
  // blackOil.ts carries the textbook 0.005035 constant and takes
  // (p_psia, temp_f, z). experiments.js carries the exact standard-conditions
  // form PSC/TSC/FT3_PER_BBL and takes (z, tR, p_psia) — a different constant
  // AND a different argument order under the same name.
  //
  // Neither is wrong. Importing the wrong one is, and reversing the arguments
  // is worse. The systematic gap is pinned so that nobody harmonizes one into
  // the other without deciding to.
  it('differ by a fixed 0.0356 percent, whatever the state', () => {
    for (const [p, tF, z] of [[2000, 180, 0.85], [1000, 120, 0.9], [4000, 220, 0.95]]) {
      const tR = tF + 459.67;
      const gap = (bgRbPerScf(p, tF, z) - eosBg(z, tR, p)) / eosBg(z, tR, p);
      expect(gap).toBeCloseTo(-0.000356, 6);
    }
  });
});

describe('water properties', () => {
  it('bwApprox is exactly one at the initial pressure and shrinks above it', () => {
    expect(bwApprox(1.03, 3000, 3000, 3e-6)).toBe(1.03);
    expect(bwApprox(1.03, 4000, 3000, 3e-6)).toBeLessThan(1.03);
    expect(bwApprox(1.03, 2000, 3000, 3e-6)).toBeGreaterThan(1.03);
  });
  it('McCain Bw expands with temperature and contracts with pressure', () => {
    expect(mccainBw(3000, 220)).toBeGreaterThan(mccainBw(3000, 100));
    expect(mccainBw(5000, 180)).toBeLessThan(mccainBw(1000, 180));
  });
  it('McCain water viscosity falls with temperature and rises with salinity', () => {
    expect(mccainMuW(3000, 220)).toBeLessThan(mccainMuW(3000, 100));
    expect(mccainMuW(3000, 180, 100000)).toBeGreaterThan(mccainMuW(3000, 180, 0));
  });
});

describe('oil viscosity', () => {
  it('dead oil thins with temperature and with API', () => {
    expect(bealDeadOilViscosity(API, 220)).toBeLessThan(bealDeadOilViscosity(API, 100));
    expect(bealDeadOilViscosity(40, TEMP_F)).toBeLessThan(bealDeadOilViscosity(20, TEMP_F));
  });
  it('dissolved gas thins the oil below the dead-oil value', () => {
    const mu_od = bealDeadOilViscosity(API, TEMP_F);
    const mu_ob = beggsRobinsonLiveOilViscosity(400, mu_od);
    expect(mu_ob).toBeLessThan(mu_od);
    expect(beggsRobinsonLiveOilViscosity(800, mu_od)).toBeLessThan(mu_ob);
  });
  it('undersaturated oil thickens above the bubble point and is continuous at it', () => {
    const mu_ob = 0.9;
    expect(vasquezBeggsUndersaturatedOilViscosity(2000, 2000, mu_ob)).toBeCloseTo(mu_ob, 12);
    expect(vasquezBeggsUndersaturatedOilViscosity(4000, 2000, mu_ob)).toBeGreaterThan(mu_ob);
  });
});

describe('Lee-Gonzalez-Eakin gas viscosity', () => {
  it('rises with pressure through the density it is a function of', () => {
    const lo = leeGonzalezEakinGasViscosity(1000, TEMP_F, GAS_SG, hallYarboroughZ(0.4, 1.4));
    const hi = leeGonzalezEakinGasViscosity(5000, TEMP_F, GAS_SG, hallYarboroughZ(2.0, 1.4));
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeGreaterThan(0.005);
    expect(hi).toBeLessThan(0.1);
  });
});

describe('validity warnings carry the published training ranges', () => {
  // The point of these functions is that a number produced outside the range a
  // correlation was fitted over is reported as such rather than quietly used.
  it('stays silent inside every range', () => {
    expect(correlationValidityWarnings('vasquez_beggs', 'hall_yarborough', 'mccain', {
      pi: 3000, temp_f: 180, api: 32, gas_sg: 0.75, ppr_max: 5, tpr: 1.5,
    })).toEqual([]);
    expect(viscosityValidityWarnings('beggs_robinson', 'lee_gonzalez_eakin', {
      pi: 3000, temp_f: 180, api: 32, gas_sg: 0.75, rs_max: 500,
    })).toEqual([]);
  });
  it('names the correlation and the violated bound when a condition is outside', () => {
    const w = correlationValidityWarnings('vasquez_beggs', 'hall_yarborough', 'mccain', {
      pi: 3000, temp_f: 400, api: 32, gas_sg: 0.75, ppr_max: 5, tpr: 1.5,
    });
    expect(w.length).toBeGreaterThan(0);
    expect(w.join(' ')).toMatch(/Vasquez-Beggs/);
    expect(w.join(' ')).toMatch(/400/);
  });
  it('reports a gas viscosity condition outside the Lee-Gonzalez-Eakin range', () => {
    const w = viscosityValidityWarnings('beggs_robinson', 'lee_gonzalez_eakin', {
      pi: 12000, temp_f: 180, api: 32, gas_sg: 0.75, rs_max: 500,
    });
    expect(w.join(' ')).toMatch(/Lee-Gonzalez-Eakin/);
  });
});
