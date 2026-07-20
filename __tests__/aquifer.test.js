/**
 * MB2 — the §4.1 HARD GATE (docs/scope/ReservoirEngineering-Module.md):
 * the client Carter-Tracy must reproduce the Dake Exercise 9.2 finite-aquifer
 * benchmark (reD = 5, wedge 140°, U = 6446 rb/psi) before the Reservoir
 * Balance aquifer tab ships.
 *
 * Truth chain:
 *   - GATE A anchors the client against Dake's published Hurst-van Everdingen
 *     solution (final We 89.2 MM rb at year 10). Carter-Tracy is an
 *     approximation of the HvE convolution; on this dataset the exact-pD CT
 *     lands 3.4% below HvE (86.13 vs 89.2 MM rb) — a documented METHOD gap,
 *     same family as the server harness CASE 2C reasoning (its blended-pD CT
 *     gives 88.05). Tolerance ±5% of the HvE truth, plus a ±1% regression pin
 *     on the client's own value so silent drift is caught.
 *   - GATE B cross-validates client vs the committed SERVER We history
 *     (goldens/dake92-we.json, regenerate via
 *     npx tsx tools/validation/gen-dake92-client-golden.ts). The server
 *     marches with the Lee-Wattenbarger infinite-acting polynomial blended to
 *     pseudo-steady state (tanh switch at tD = 0.4·reD²); the client uses the
 *     EXACT bounded-circle pD (Stehfest-inverted van Everdingen-Hurst
 *     solution from the Well Test engine). Measured deviation is systematic
 *     and peaks at 2.72% of final We (year 7); tolerance ±3.5% of final We
 *     per step.
 *   - Physics gates pin the finite pD itself: exact PSS late-time behavior
 *     (slope 2/(reD²-1), intercept from the full van Everdingen-Hurst PSS
 *     expansion 2(tD+1/4)/(reD²-1) - (3reD⁴-4reD⁴ln reD-2reD²-1)/(4(reD²-1)²)),
 *     the infinite-reD limit collapsing to the line source at late tD, and
 *     the infinite-acting march staying untouched when reD is absent.
 */
import fs from 'fs';
import path from 'path';
import {
  carterTracy,
  pDFinite,
  pDprimeFinite,
  pD,
  influxConstant,
} from '../engines/aquifer/aquiferInflux.js';

const golden = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../test-data/aquifer/dake92-we.json'), 'utf8'),
);

const DAKE_HISTORY = golden.series.map((s) => ({ t: s.t_days, p: s.p_psia }));
const DAKE_PARAMS = {
  phi: 0.25, h: 100, ct: 7e-6, rR: 9200, k: 200, muw: 0.55, theta: 140, reD: 5,
};
const HVE_FINAL_WE_RB = golden.dake_final_we_hve_mmrb * 1e6; // 89.2 MM rb

describe('MB2 hard gate: client Carter-Tracy vs Dake Exercise 9.2', () => {
  const result = carterTracy(DAKE_HISTORY, DAKE_PARAMS);

  test('aquifer constant U reproduces Dake exactly (6446 rb/psi)', () => {
    expect(influxConstant(DAKE_PARAMS)).toBeCloseTo(6446, -1);
    expect(result.U).toBeCloseTo(6446, -1);
  });

  test('GATE A: final We within 5% of the Dake HvE truth (89.2 MM rb)', () => {
    const relErr = Math.abs(result.cumulativeWe - HVE_FINAL_WE_RB) / HVE_FINAL_WE_RB;
    expect(relErr).toBeLessThan(0.05);
  });

  test('GATE A pin: client final We stays at its validated value (86.13 MM rb ±1%)', () => {
    expect(result.cumulativeWe / 1e6).toBeGreaterThan(86.13 * 0.99);
    expect(result.cumulativeWe / 1e6).toBeLessThan(86.13 * 1.01);
  });

  test('GATE B: stepwise We tracks the server engine within 3.5% of final We', () => {
    for (let i = 1; i < golden.series.length; i++) {
      const server = golden.series[i].We_rb;
      const client = result.series[i].We;
      const devOfFinal = Math.abs(client - server) / golden.series.at(-1).We_rb;
      expect(devOfFinal).toBeLessThan(0.035);
    }
  });

  test('finite-aquifer support matters: infinite-acting CT overshoots hugely', () => {
    const { reD, ...noReD } = DAKE_PARAMS;
    const inf = carterTracy(DAKE_HISTORY, noReD);
    // Infinite-acting gives ~151 MM rb on this history; the finite reD=5
    // answer must be far below it (this is what the hard gate exists for).
    expect(inf.cumulativeWe).toBeGreaterThan(1.5 * result.cumulativeWe);
    expect(inf.reD).toBeUndefined();
    expect(result.reD).toBe(5);
  });
});

describe('MB2 physics gates: bounded-circle pD(tD, reD)', () => {
  const reD = 5;

  test('late-time slope equals the exact PSS 2/(reD^2 - 1)', () => {
    // Finite difference over [40, 60] carries ~1e-4 relative Stehfest noise;
    // the exact-derivative check below pins the slope more tightly.
    const slope = (pDFinite(60, reD) - pDFinite(40, reD)) / 20;
    expect(slope).toBeCloseTo(2 / (reD * reD - 1), 3);
  });

  test('pDprimeFinite settles on the PSS slope at late time', () => {
    expect(pDprimeFinite(50, reD)).toBeCloseTo(2 / (reD * reD - 1), 4);
  });

  test('late-time value matches the FULL van Everdingen-Hurst PSS expansion', () => {
    // pwD_pss = 2(tD + 1/4)/(reD^2-1)
    //         - (3 reD^4 - 4 reD^4 ln reD - 2 reD^2 - 1) / (4 (reD^2-1)^2)
    const tD = 50;
    const r2 = reD * reD;
    const b =
      (3 * r2 * r2 - 4 * r2 * r2 * Math.log(reD) - 2 * r2 - 1) /
      (4 * (r2 - 1) * (r2 - 1));
    const exact = (2 * (tD + 0.25)) / (r2 - 1) - b;
    expect(pDFinite(tD, reD)).toBeCloseTo(exact, 3);
  });

  test('infinite-reD limit collapses to the line source at late tD', () => {
    // The bounded solution at huge reD is the cylindrical-source pwD, which
    // approaches the line-source ½E1(1/(4tD)) only once tD is large (the
    // classic pD(tD=1) = 0.802 vs line-source 0.522 gap closes by tD ~ 100).
    for (const tD of [100, 300, 1000]) {
      const cyl = pDFinite(tD, 1e6);
      const line = pD(tD);
      expect(Math.abs(cyl - line) / line).toBeLessThan(0.01);
    }
  });

  test('cylindrical-source classic value pD(tD=1) = 0.802 at large reD', () => {
    expect(pDFinite(1, 1e6)).toBeCloseTo(0.802, 2);
  });

  test('monotonically increasing in tD', () => {
    let prev = 0;
    for (const tD of [0.5, 1, 2, 5, 10, 20, 50, 100]) {
      const v = pDFinite(tD, reD);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  test('reD guard falls back to the infinite-acting line source', () => {
    expect(pDFinite(10, undefined)).toBeCloseTo(pD(10), 12);
    expect(pDFinite(10, 1)).toBeCloseTo(pD(10), 12);
    expect(pDprimeFinite(10, NaN)).toBeCloseTo(
      Math.exp(-1 / 40) / 20, 12,
    );
  });
});
