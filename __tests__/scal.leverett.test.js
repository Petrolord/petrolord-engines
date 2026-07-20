/**
 * SC2 — the Leverett-principle suite.
 *
 * Leverett (1941), "Capillary Behavior in Porous Solids," Trans. AIME 142,
 * is the locked golden reference for SCAL Studio
 * (ReservoirEngineering-Module.md §4.2). The paper's central, machine-
 * testable claim is the COLLAPSE: capillary pressure curves measured on
 * rocks of different k, phi and fluid systems reduce to a single
 * dimensionless J(Sw) curve through J = C * (Pc/(sigma*cos(theta))) *
 * sqrt(k/phi). That claim is tested here EXACTLY: synthetic Pc data
 * generated for three very different rocks from one J curve must collapse
 * back to that curve to machine precision, and the multi-sample averaging
 * must return the source.
 *
 * The paper's numeric correlation is published as drainage/imbibition
 * CURVES, not tables, and the paper itself is paywalled (OnePetro,
 * SPE-941152-G; the AIME digital library scan is member-gated). Per the
 * repo's armed-fixture doctrine (values typed from the source, never
 * recalled), the golden below is SOURCED (SC7a, 2026-07-18) from the
 * faithful reproduction in Ahmed, Reservoir Engineering Handbook, 4th ed.
 * (Gulf Professional / Elsevier, 2010, ISBN 978-1-85617-803-7), the same
 * library copy the well-test Earlougher fixture was typed from
 * (irmat-ucan.com, accessed 2026-07-18):
 *   - Figure 4-18, "The Leverett J-function for unconsolidated sands.
 *     (After Leverett, 1941.)", p. 225 — the 1941 correlation figure,
 *     drainage curve read at a stated tolerance.
 *   - Example 4-7 (Nameless Field), pp. 224-226 — a fully printed
 *     J-function worked example (lab table -> J -> reservoir Pc).
 * A re-read against the original Trans. AIME 142 scan remains the upgrade
 * path if the owner supplies the OnePetro PDF — kept visible as the todo
 * at the bottom.
 */
import {
  computeJTable,
  averageJCurves,
  fitJPowerLaw,
  makeJFunction,
  pcFromJ,
} from '../engines/scal/scal.js';

// One "true" J curve (a power law, evaluated on true Sw with Swirr = 0.1).
const TRUE_J = { a: 0.25, b: 1.35, Swirr: 0.1 };
const jTrue = (Sw) => TRUE_J.a * Math.pow((Sw - TRUE_J.Swirr) / (1 - TRUE_J.Swirr), -TRUE_J.b);

// Three rocks with very different k/phi and lab fluid systems.
const ROCKS = [
  { name: 'coarse sand', k_md: 850, phi: 0.31, sigma_dyncm: 72, thetaDeg: 0 },      // air-brine
  { name: 'tight sand', k_md: 8, phi: 0.12, sigma_dyncm: 367, thetaDeg: 40 },       // air-mercury convention: 480*cos(40) printed as sigma*cos pair
  { name: 'mid perm', k_md: 120, phi: 0.22, sigma_dyncm: 26, thetaDeg: 30 },        // oil-brine
];

const SW_GRID = Array.from({ length: 13 }, (_, i) => 0.2 + i * 0.06); // 0.2 .. 0.92

// Generate each rock's lab Pc from the true J: Pc = J * sigma*cos / (C*sqrt(k/phi))
const labPcFor = (rock) => {
  const back = pcFromJ(
    { type: 'table', rows: SW_GRID.map((Sw) => ({ Sw, J: jTrue(Sw) })) },
    rock,
    { n: SW_GRID.length - 1, SwMin: SW_GRID[0], SwMax: SW_GRID[SW_GRID.length - 1] },
  );
  return back.rows.map((r) => ({ Sw: r.Sw, Pc_psi: r.Pc_psi }));
};

describe('Leverett collapse (the 1941 claim, exact)', () => {
  test('three rocks with different k, phi and fluids collapse to one J curve at 1e-9', () => {
    const jTables = ROCKS.map((rock) => {
      const res = computeJTable(labPcFor(rock), rock);
      expect(res.ok).toBe(true);
      return res.rows;
    });
    for (let i = 0; i < SW_GRID.length; i++) {
      const values = jTables.map((rows) => rows[i].J);
      const spread = Math.max(...values) - Math.min(...values);
      expect(spread).toBeLessThan(1e-9);
      expect(values[0]).toBeCloseTo(jTrue(SW_GRID[i]), 9);
    }
  });

  test('averageJCurves over the three rocks returns the source curve', () => {
    const samples = ROCKS.map((rock) => ({
      name: rock.name,
      jRows: computeJTable(labPcFor(rock), rock).rows.map((r) => ({ Sw: r.Sw, J: r.J })),
    }));
    // Explicit Swirr (the Capillary tab override): without it the per-sample
    // data-min heuristic distorts the Sw* axis when true Swirr sits lower.
    const avg = averageJCurves(samples, { nGrid: 21, Swirr: TRUE_J.Swirr });
    expect(avg.ok).toBe(true);
    expect(avg.sampleCount).toBe(3);
    for (const g of avg.grid) {
      // Identical underlying curves: band collapses onto the mean.
      expect(g.Jmax - g.Jmin).toBeLessThan(1e-9);
      expect(g.count).toBe(3);
    }
    // The refit of the mean curve is a usable reservoir jSpec.
    expect(avg.fit).toBeTruthy();
    expect(avg.fit.converged).toBe(true);
    expect(avg.fit.r2Log).toBeGreaterThan(0.999);
  });

  test('a mis-scaled sample breaks the collapse (the diagnostic the plot shows)', () => {
    const rock = ROCKS[0];
    const wrongK = { ...rock, k_md: rock.k_md * 4 }; // analyst typo: 4x permeability
    const good = computeJTable(labPcFor(rock), rock).rows;
    const bad = computeJTable(labPcFor(rock), wrongK).rows;
    // sqrt(4) = 2: the bad J curve rides exactly 2x above the truth.
    for (let i = 0; i < good.length; i++) {
      expect(bad[i].J / good[i].J).toBeCloseTo(2, 9);
    }
  });

  test('fitJPowerLaw on collapsed data recovers the generating parameters', () => {
    const rows = computeJTable(labPcFor(ROCKS[2]), ROCKS[2]).rows
      .map((r) => ({ Sw: r.Sw, J: r.J }));
    const fit = fitJPowerLaw(rows, { Swirr: TRUE_J.Swirr });
    expect(fit.ok).toBe(true);
    expect(Math.abs(fit.a - TRUE_J.a)).toBeLessThan(1e-6);
    expect(Math.abs(fit.b - TRUE_J.b)).toBeLessThan(1e-6);
  });
});

// ── SC7a armed goldens — typed from Ahmed 4th ed. (provenance in header) ─────

// Example 4-7, p. 224: lab core, Nameless Field. Table typed as printed
// (Sw descending); the engine sorts ascending internally.
const AHMED_EX_4_7 = {
  lab: { k_md: 80, phi: 0.16, sigma_dyncm: 50, thetaDeg: 0 },
  reservoir: { k_md: 120, phi: 0.19, sigma_dyncm: 50, thetaDeg: 0 },
  pcRows: [
    { Sw: 1.0, Pc_psi: 0.50 },
    { Sw: 0.8, Pc_psi: 0.60 },
    { Sw: 0.6, Pc_psi: 0.75 },
    { Sw: 0.4, Pc_psi: 1.05 },
    { Sw: 0.2, Pc_psi: 1.75 },
  ],
  // Step 1 printed: J(Sw) = 0.096799 pc, rounded to 3 decimals in the book.
  publishedJ: [
    { Sw: 1.0, J: 0.048 },
    { Sw: 0.8, J: 0.058 },
    { Sw: 0.6, J: 0.073 },
    { Sw: 0.4, J: 0.102 },
    { Sw: 0.2, J: 0.169 },
  ],
  // Step 3 printed: pc = 9.192 J(Sw), computed by the book from the rounded
  // J column above.
  publishedReservoirPc: [
    { Sw: 1.0, Pc_psi: 0.441 },
    { Sw: 0.8, Pc_psi: 0.533 },
    { Sw: 0.6, Pc_psi: 0.671 },
    { Sw: 0.4, Pc_psi: 0.938 },
    { Sw: 0.2, Pc_psi: 1.553 },
  ],
};

describe('Ahmed Example 4-7 (published J-function worked example)', () => {
  test('computeJTable reproduces the printed J column (3-decimal print)', () => {
    const res = computeJTable(AHMED_EX_4_7.pcRows, AHMED_EX_4_7.lab);
    expect(res.ok).toBe(true);
    for (const pub of AHMED_EX_4_7.publishedJ) {
      const row = res.rows.find((r) => Math.abs(r.Sw - pub.Sw) < 1e-9);
      expect(row).toBeTruthy();
      // Printed values are rounded to 3 decimals: half-ulp tolerance.
      expect(Math.abs(row.J - pub.J)).toBeLessThanOrEqual(5.5e-4);
    }
  });

  test('pcFromJ rebuilds the printed reservoir Pc table from the printed J column', () => {
    // Step 3 exactly as the book does it: the ROUNDED printed J values are
    // the tabulated spec, rescaled to the reservoir rock.
    const jSpec = { type: 'table', rows: AHMED_EX_4_7.publishedJ };
    const res = pcFromJ(jSpec, AHMED_EX_4_7.reservoir, { n: 4, SwMin: 0.2, SwMax: 1.0 });
    expect(res.ok).toBe(true);
    for (const pub of AHMED_EX_4_7.publishedReservoirPc) {
      const row = res.rows.find((r) => Math.abs(r.Sw - pub.Sw) < 1e-9);
      expect(row).toBeTruthy();
      // Book rounds the factor to 9.192 and the products to 3 decimals.
      expect(Math.abs(row.Pc_psi - pub.Pc_psi)).toBeLessThanOrEqual(2e-3);
    }
  });
});

// Figure 4-18, p. 225 ("After Leverett, 1941"): drainage-branch curve reads.
// Read tolerance ±0.05 J (stated; the y grid is 0.2 per division). The curve
// asymptotes near Sw ≈ 0.09 and flattens to a plateau just above J = 0.4.
const FIG_4_18_READ_TOL = 0.05;
const FIG_4_18_SWIRR_READ = 0.09;
const FIG_4_18_DRAINAGE = [
  { Sw: 0.2, J: 0.6 },
  { Sw: 0.25, J: 0.53 },
  { Sw: 0.3, J: 0.5 },
  { Sw: 0.4, J: 0.46 },
  { Sw: 0.5, J: 0.44 },
  { Sw: 0.6, J: 0.43 },
  { Sw: 0.7, J: 0.425 },
  { Sw: 0.8, J: 0.42 },
  { Sw: 0.9, J: 0.41 },
];

describe('Leverett 1941 figure-read golden (Fig. 4-18, after Leverett)', () => {
  test('the published drainage curve has the 1941 shape: monotone, steep front, flat plateau', () => {
    for (let i = 1; i < FIG_4_18_DRAINAGE.length; i++) {
      expect(FIG_4_18_DRAINAGE[i].J).toBeLessThan(FIG_4_18_DRAINAGE[i - 1].J);
    }
    const j = (Sw) => FIG_4_18_DRAINAGE.find((r) => r.Sw === Sw).J;
    // Front-to-plateau contrast and plateau flatness as printed.
    expect(j(0.2) / j(0.9)).toBeGreaterThan(1.3);
    expect(j(0.5) - j(0.9)).toBeLessThanOrEqual(0.04);
  });

  test('fitJPowerLaw represents the published curve within the read tolerance', () => {
    const fit = fitJPowerLaw(FIG_4_18_DRAINAGE, { Swirr: FIG_4_18_SWIRR_READ });
    expect(fit.ok).toBe(true);
    expect(fit.converged).toBe(true);
    const { j } = makeJFunction({ type: 'power', a: fit.a, b: fit.b, Swirr: fit.Swirr });
    for (const r of FIG_4_18_DRAINAGE) {
      expect(Math.abs(j(r.Sw) - r.J)).toBeLessThanOrEqual(FIG_4_18_READ_TOL);
    }
  });

  test('the typed curve round-trips through two legend rocks (scaling invariance on real data)', () => {
    // Permeabilities from the figure legend (214 darcies water-kerosene,
    // 3.63 darcies water-air); porosity and sigma are arbitrary consistent
    // values — the round trip is invariant to them by construction.
    const rocks = [
      { k_md: 214000, phi: 0.38, sigma_dyncm: 49, thetaDeg: 0 },
      { k_md: 3630, phi: 0.35, sigma_dyncm: 72, thetaDeg: 0 },
    ];
    const jSpec = { type: 'table', rows: FIG_4_18_DRAINAGE };
    const jBack = rocks.map((rock) => {
      const pc = pcFromJ(jSpec, rock, { n: 7, SwMin: 0.2, SwMax: 0.9 });
      expect(pc.ok).toBe(true);
      const back = computeJTable(pc.rows.map((r) => ({ Sw: r.Sw, Pc_psi: r.Pc_psi })), rock);
      expect(back.ok).toBe(true);
      return back.rows;
    });
    const evaluator = makeJFunction(jSpec);
    for (let i = 0; i < jBack[0].length; i++) {
      expect(Math.abs(jBack[0][i].J - jBack[1][i].J)).toBeLessThan(1e-12);
      expect(jBack[0][i].J).toBeCloseTo(evaluator.j(jBack[0][i].Sw), 12);
    }
  });

  // Upgrade path: re-read against the original Trans. AIME 142 figure if the
  // owner supplies the OnePetro scan (the original carries both drainage and
  // imbibition branches at full plate scale).
  test.todo('re-read the golden from the original Trans. AIME 142 scan (owner to supply PDF)');
});
