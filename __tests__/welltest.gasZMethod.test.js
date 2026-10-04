/**
 * Well Test U1 (2026-10-04): the z-factor of a gas well test can run on the
 * canonical Dranchuk-Abou-Kassem engine (engines/fluid/blackOil.ts), the
 * default of Fluid Systems Studio, instead of Papay.
 *
 * What is held:
 *   1. The welltest route CALLS the canonical engine: its z equals
 *      blackOil gasZFactor to the last bit, through gasZByMethod and through
 *      every row of the PVT table the studio builds.
 *   2. Against readings of the Standing-Katz chart (test-data, the gate the
 *      fluid engine already uses), the table built on Dranchuk-Abou-Kassem
 *      stays inside the chart error stated for that method over its window.
 *      Negative control: the same check on Papay leaves the band, so the
 *      check can tell the methods apart.
 *   3. Back-compatibility: with no method named, nothing changes (Papay),
 *      so the Nodal gas IPR and the NextGen lab keep their numbers.
 *   4. The table names the method it was built on, for the report.
 */
import fs from 'fs';
import path from 'path';
import {
  gasZFactor, gasZByMethod, buildGasPvtTable, makePseudoPressure, gasPvtCorrelations,
  WELLTEST_Z_METHODS, DEFAULT_WELLTEST_Z_METHOD, resolveZMethod, GAS_PVT_CORRELATIONS,
} from '../engines/welltest/gas.js';
import { gasZFactor as canonicalZ, suttonPseudoCriticals, GAS_Z_METHODS } from '../engines/fluid/blackOil.ts';

const chart = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-data', 'fluid', 'standingKatzChart.json'), 'utf8'));
const GG = 0.65;

describe('welltest z-factor by method', () => {
  test('Dranchuk-Abou-Kassem and Hall-Yarborough are the canonical engine, bit for bit', () => {
    for (const method of ['dranchuk_abou_kassem', 'hall_yarborough']) {
      for (const p of [150, 800, 2500, 4800, 7200, 9500]) {
        for (const [tF, gg] of [[120, 0.6], [180, 0.65], [260, 0.8]]) {
          expect(gasZByMethod(p, tF, gg, method)).toBe(canonicalZ(p, tF, gg, method));
        }
      }
    }
  });

  test('every row of a Dranchuk-Abou-Kassem table is the canonical z', () => {
    const rows = buildGasPvtTable({ gasGravity: GG, tempF: 180, pMax: 7000, points: 70, zMethod: 'dranchuk_abou_kassem' });
    for (const r of rows.filter((x) => x.p > 0)) expect(r.z).toBe(canonicalZ(r.p, 180, GG, 'dranchuk_abou_kassem'));
    expect(rows.source).toMatchObject({ kind: 'correlation', z: 'Dranchuk-Abou-Kassem', zMethod: 'dranchuk_abou_kassem', viscosity: 'Lee-Gonzalez-Eakin', pseudoCriticals: 'Sutton (1985)' });
  });

  test('with no method named the module stays on Papay (back-compatible)', () => {
    expect(DEFAULT_WELLTEST_Z_METHOD).toBe('papay');
    const rows = buildGasPvtTable({ gasGravity: GG, tempF: 180, pMax: 7000, points: 70 });
    for (const r of rows.filter((x) => x.p > 0)) expect(r.z).toBe(gasZFactor(r.p, 180, GG));
    expect(rows.source).toBe(GAS_PVT_CORRELATIONS);
    expect(resolveZMethod('nonsense')).toBe('papay');
    expect(gasZByMethod(3000, 180, GG, 'nonsense')).toBe(gasZFactor(3000, 180, GG));
    expect(gasPvtCorrelations('papay')).toBe(GAS_PVT_CORRELATIONS);
  });

  test('the names come from the canonical method list', () => {
    expect(WELLTEST_Z_METHODS.dranchuk_abou_kassem.label).toBe(GAS_Z_METHODS.dranchuk_abou_kassem.label);
    expect(WELLTEST_Z_METHODS.hall_yarborough.label).toBe(GAS_Z_METHODS.hall_yarborough.label);
  });
});

describe('the studio route against the Standing-Katz chart', () => {
  // A chart point as a (p, T) the studio would see for a 0.65 gravity gas.
  const { ppc, tpc } = suttonPseudoCriticals(GG);
  const inWindow = (m) => chart.points.filter(([tpr, ppr]) => tpr >= m.chartTpr[0] && tpr <= m.chartTpr[1] && ppr >= m.chartPpr[0] && ppr <= m.chartPpr[1]);
  const worst = (method, points) => Math.max(...points.map(([tpr, ppr, z]) => {
    const z2 = gasZByMethod(ppr * ppc, tpr * tpc - 459.67, GG, method);
    return Math.abs(z2 - z) / z;
  }));

  test('Dranchuk-Abou-Kassem stays inside its stated chart error over its window', () => {
    const m = GAS_Z_METHODS.dranchuk_abou_kassem;
    const pts = inWindow(m);
    expect(pts.length).toBeGreaterThan(40);
    expect(worst('dranchuk_abou_kassem', pts)).toBeLessThanOrEqual(m.chartError);
  });

  test('negative control: Papay leaves that band, so the check discriminates', () => {
    const m = GAS_Z_METHODS.dranchuk_abou_kassem;
    expect(worst('papay', inWindow(m))).toBeGreaterThan(m.chartError);
  });
});

describe('what the change does to a gas test (before and after, for the record)', () => {
  test('m(p) at 4,800 psia, 180 degF, gravity 0.65 moves by under 3 percent', () => {
    const pap = makePseudoPressure(buildGasPvtTable({ gasGravity: GG, tempF: 180, pMax: 7200, points: 120 }));
    const dak = makePseudoPressure(buildGasPvtTable({ gasGravity: GG, tempF: 180, pMax: 7200, points: 120, zMethod: 'dranchuk_abou_kassem' }));
    const a = pap.mOfP(4800);
    const b = dak.mOfP(4800);
    expect(Math.abs(b - a) / a).toBeLessThan(0.03);
    expect(dak.source.z).toBe('Dranchuk-Abou-Kassem');
  });
});
