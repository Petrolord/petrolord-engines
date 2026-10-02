/**
 * Report inputs for the Well Test Analysis Studio: total compressibility
 * from its components, the flow and shut-in summary, and the gas PVT table
 * naming the correlations it used. Values are checked against the longhand
 * arithmetic in tools/validation/welltest/oracle_partial_penetration.py.
 */
import fs from 'fs';
import path from 'path';
import { totalCompressibility, TOTAL_COMPRESSIBILITY_FORMULA } from '../engines/welltest/compressibility.js';
import { summarizeFlowPeriods } from '../engines/welltest/flowSummary.js';
import {
  buildGasPvtTable, makePseudoPressure, GAS_PVT_CORRELATIONS, GAS_PVT_SUPPLIED_TABLE, gasZFactor, gasViscosity,
} from '../engines/welltest/gas.js';

const goldens = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../test-data/welltest/partial-penetration-goldens.json'), 'utf8'),
);

describe('total compressibility', () => {
  test.each(goldens.totalCompressibility.map((r, i) => [i + 1, r]))('golden %i', (_i, r) => {
    const out = totalCompressibility(r);
    expect(out.ok).toBe(true);
    expect(out.ct).toBeCloseTo(r.ct, 18);
    // the terms are the sum: nothing is added that is not listed
    expect(out.terms.reduce((s, t) => s + t.product, 0)).toBe(out.ct);
    expect(out.formula).toBe(TOTAL_COMPRESSIBILITY_FORMULA);
  });

  test('negative control: an unweighted sum of the compressibilities is a different number', () => {
    const r = goldens.totalCompressibility[1];
    expect(totalCompressibility(r).ct).not.toBeCloseTo(r.cf + r.co + r.cw + r.cg, 6);
  });

  test('the terms carry each saturation, compressibility and product', () => {
    const out = totalCompressibility({ cf: 4e-6, so: 0.75, co: 1.2e-5, sw: 0.25, cw: 3e-6 });
    expect(out.terms.map((t) => t.key)).toEqual(['formation', 'oil', 'water']);
    expect(out.terms[1]).toMatchObject({ label: 'So co', saturation: 0.75, compressibility: 1.2e-5 });
    expect(out.terms[1].product).toBeCloseTo(9e-6, 18);
    expect(out.saturationSum).toBeCloseTo(1, 12);
  });

  test.each([
    ['no cf', { so: 1, co: 1e-5 }, 'no-formation-compressibility'],
    ['a saturation with no compressibility', { cf: 4e-6, so: 0.75, sw: 0.25, cw: 3e-6 }, 'no-phase-compressibility'],
    ['saturations that do not sum to one', { cf: 4e-6, so: 0.5, co: 1e-5, sw: 0.25, cw: 3e-6 }, 'saturations-do-not-sum'],
    ['a saturation above one', { cf: 4e-6, so: 1.2, co: 1e-5 }, 'bad-saturation'],
    ['no saturations at all', { cf: 4e-6 }, 'no-saturations'],
  ])('refused: %s', (_name, input, code) => {
    const out = totalCompressibility(input);
    expect(out).toMatchObject({ ok: false, code });
    expect(out.ct).toBeUndefined();
  });

  test('a phase at zero saturation needs no compressibility', () => {
    expect(totalCompressibility({ cf: 4e-6, so: 1, co: 1e-5, sw: 0, sg: 0 })).toMatchObject({ ok: true });
  });
});

describe('flow and shut-in summary', () => {
  test.each(goldens.flowSummary.map((r, i) => [i + 1, r]))('golden %i', (_i, r) => {
    const out = summarizeFlowPeriods({ history: r.history, endTime: r.endTime });
    expect(out.periods.length).toBe(r.volumes.length);
    out.periods.forEach((p, i) => {
      if (r.durations[i] == null) {
        expect(Number.isNaN(p.duration)).toBe(true);
        expect(Number.isNaN(p.volume)).toBe(true);
      } else {
        expect(p.duration).toBeCloseTo(r.durations[i], 12);
        expect(p.volume).toBeCloseTo(r.volumes[i], 10);
      }
    });
    if (r.total == null) expect(Number.isNaN(out.totalVolume)).toBe(true);
    else expect(out.totalVolume).toBeCloseTo(r.total, 10);
  });

  test('types, order and the running total', () => {
    const out = summarizeFlowPeriods({ history: [{ t: 0, q: 450 }, { t: 36, q: 0 }], endTime: 108 });
    expect(out.periods.map((p) => p.type)).toEqual(['flow', 'shut-in']);
    expect(out.periods.map((p) => p.index)).toEqual([1, 2]);
    expect(out.periods[1]).toMatchObject({ start: 36, end: 108, duration: 72, rate: 0, volume: 0, cumulative: 675 });
    expect(out.flowingHours).toBe(36);
    expect(out.shutInHours).toBe(72);
  });

  test('an injection period reports the injected volume as a positive number', () => {
    const out = summarizeFlowPeriods({ history: [{ t: 0, q: -1200 }, { t: 48, q: 0 }], endTime: 60 });
    expect(out.periods[0]).toMatchObject({ type: 'injection', volume: 2400 });
  });

  test('no rate history and an end time before the last step', () => {
    expect(summarizeFlowPeriods({ history: [] })).toMatchObject({ periods: [], totalVolume: 0 });
    expect(summarizeFlowPeriods().periods).toEqual([]);
    const out = summarizeFlowPeriods({ history: [{ t: 0, q: 450 }, { t: 36, q: 0 }], endTime: 10 });
    expect(Number.isNaN(out.periods[1].duration)).toBe(true);
  });
});

describe('the gas PVT table says where it came from', () => {
  test('the correlation path names the functions it called', () => {
    const rows = buildGasPvtTable({ gasGravity: 0.65, tempF: 180, pMax: 6000 });
    expect(rows.source).toBe(GAS_PVT_CORRELATIONS);
    expect(rows.source).toMatchObject({ kind: 'correlation', z: 'Papay', viscosity: 'Lee-Gonzalez-Eakin', pseudoCriticals: 'Sutton (1985)' });
    // and the rows really are those functions' values
    const mid = rows[30];
    expect(mid.z).toBe(gasZFactor(mid.p, 180, 0.65));
    expect(mid.mu).toBe(gasViscosity(mid.p, 180, 0.65, mid.z));
    // the source does not show up as a row or a key
    expect(Object.keys(rows)).not.toContain('source');
    expect(JSON.parse(JSON.stringify(rows)).length).toBe(rows.length);
  });

  test('a supplied table is reported as a supplied table, never as a correlation', () => {
    const table = [{ p: 0, mu: 0.012, z: 1 }, { p: 2000, mu: 0.018, z: 0.86 }, { p: 4000, mu: 0.024, z: 0.9 }];
    const rows = buildGasPvtTable({ gasGravity: 0.65, tempF: 180, table });
    expect(rows.source).toBe(GAS_PVT_SUPPLIED_TABLE);
    expect(rows.source.kind).toBe('table');
    expect(rows.source.z).not.toMatch(/Papay/);
  });

  test('the pseudo-pressure transform passes the source through', () => {
    const corr = makePseudoPressure(buildGasPvtTable({ gasGravity: 0.65, tempF: 180, pMax: 6000 }));
    expect(corr.source).toBe(GAS_PVT_CORRELATIONS);
    const plain = makePseudoPressure([{ p: 0, mu: 0.012, z: 1 }, { p: 2000, mu: 0.018, z: 0.86 }, { p: 4000, mu: 0.024, z: 0.9 }]);
    expect(plain.source).toBeNull();
  });
});
