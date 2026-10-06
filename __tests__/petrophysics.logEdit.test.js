/**
 * Log editing gates (QI programme Q1, A3): splice, interval edits with a
 * ledger, and sonic drift correction against checkshots. Expected values
 * come from the stdlib oracle (tools/validation/petrophysics/oracle_log_edit.py,
 * anchors D1-D5: a linear true sonic integrates exactly, so the drift of a
 * biased sonic is known in closed form). Negative controls must fail.
 */
import fs from 'fs';
import path from 'path';
import { spliceRuns, applyEdits, integrateSlowness, sonicDriftCorrection } from '../engines/petrophysics/logEdit';

const G = JSON.parse(fs.readFileSync(path.join(__dirname, '../test-data/petrophysics/goldens.logEdit.json'), 'utf8'));
const Z = Array.from({ length: 2001 }, (_, i) => 1000 + 0.5 * i);
const trueDt = (z) => 400 - 0.08 * (z - 1000);
const bias = (z) => (z >= 1100 && z < 1400 ? 6 : z >= 1600 && z < 1900 ? -4 : 0);
const shots = G.drift.levels.map((l) => ({ md: l.md, owtS: l.owtS }));
const nanify = (a) => a.map((v) => (v === null ? NaN : v));

describe('sonic drift correction', () => {
  const rec = Z.map((z) => trueDt(z) + bias(z));
  const r = sonicDriftCorrection({ depth: Z, dt: rec, checkshots: shots });
  test('drift table and interval corrections equal the oracle', () => {
    r.drift.forEach((d, k) => {
      expect(Math.abs(d.driftMs - G.drift.table[k].driftMs)).toBeLessThan(1e-9);
      expect(Math.abs(d.sonicS - G.drift.table[k].sonicS)).toBeLessThan(1e-12);
    });
    r.corrections.forEach((c, k) => expect(Math.abs(c.dtCorrUsM - G.drift.corrections[k].dtCorrUsM)).toBeLessThan(1e-9));
    for (const p of G.drift.picks) expect(Math.abs(r.dt[p.i] - p.dtOut)).toBeLessThan(1e-9);
  });
  test('closed form: the +6 us/m block over 300 m is a 1.8 ms drift at 1500 m', () => {
    expect(r.drift.find((d) => d.md === 1500).driftMs).toBeCloseTo(-1.8, 9);
  });
  test('the corrected sonic closes on the checkshots within the stated bound', () => {
    const cs = r.corrections.map((c) => c.dtCorrUsM);
    const bound = 0.5 * (Math.max(...cs) - Math.min(...cs)) * 0.5 * 1e-3;
    expect(r.closureMs).toBeLessThanOrEqual(bound + 1e-12);
    expect(r.closureMs).toBeLessThan(0.002);
  });
  test('negative control: the uncorrected sonic misses the 1500 m checkshot by 1.8 ms', () => {
    const t = integrateSlowness(Z, rec).t;
    const i1500 = Z.indexOf(1500);
    expect(Math.abs((shots[0].owtS + t[i1500]) - shots[2].owtS) * 1e3).toBeGreaterThan(1.7);
  });
  test('a true sonic has no drift and is returned unchanged', () => {
    const tr = Z.map(trueDt);
    const q = sonicDriftCorrection({ depth: Z, dt: tr, checkshots: shots });
    for (const d of q.drift) expect(Math.abs(d.driftMs)).toBeLessThan(1e-9);
    expect(Math.max(...q.dt.map((v, i) => Math.abs(v - tr[i])))).toBeLessThan(1e-9);
  });
  test('levels outside the sonic are ignored and the ends are reported', () => {
    const q = sonicDriftCorrection({ depth: Z, dt: rec, checkshots: [{ md: 900, owtS: 0.3 }, ...shots.slice(1, 4)] });
    expect(q.usedLevels).toBe(3);
    expect(q.outside).toEqual({ above: true, below: true });
  });
  test('refusals', () => {
    expect(() => sonicDriftCorrection({ depth: Z, dt: rec, checkshots: shots.slice(0, 1) })).toThrow(/at least two checkshot levels/);
    expect(() => sonicDriftCorrection({ depth: Z, dt: rec, checkshots: [shots[0], { md: 1500, owtS: 0.1 }] })).toThrow(/increase with depth/);
  });
  test('integration bridges interior gaps and reports their length', () => {
    const dt = Z.map(trueDt);
    for (let i = 100; i < 110; i++) dt[i] = NaN;
    const { gapM } = integrateSlowness(Z, dt);
    expect(gapM).toBeCloseTo(5.5, 9);
  });
});

describe('splice', () => {
  const s = G.splice;
  test('joins the runs with the level match at the join, as the oracle', () => {
    const r = spliceRuns(s.depth, [{ x: nanify(s.run1), top: 100, base: 112, name: 'Run 1' }, { x: s.run2, top: 110, base: 120, name: 'Run 2' }], { matchWindowM: 3 });
    expect(r.joins).toEqual([{ run: 'Run 2', at: 110, offset: s.joins[0].offset, nOverlap: s.joins[0].nOverlap }]);
    r.x.forEach((v, i) => expect(v).toBeCloseTo(s.out[i], 12));
    expect(Array.from(r.source)).toEqual(s.source);
  });
  test('negative control: without the level match the later run keeps its 2.5 offset', () => {
    const r = spliceRuns(s.depth, [{ x: nanify(s.run1), top: 100, base: 112 }, { x: s.run2, top: 110, base: 120 }]);
    expect(r.x[15] - s.out[15]).toBeCloseTo(2.5, 12);
    expect(r.joins[0].offset).toBe(0);
  });
  test('refuses a run off the grid', () => {
    expect(() => spliceRuns(s.depth, [{ x: [1, 2], top: 100, base: 110 }])).toThrow(/not on the depth grid/);
  });
});

describe('interval edits', () => {
  const d = Array.from({ length: 11 }, (_, i) => 100 + i);
  const x = [1, 2, 3, 100, 5, 6, 7, 8, 9, 10, 11];
  test('each operation, in order, with a ledger of what changed', () => {
    const r = applyEdits(d, x, [
      { op: 'despike', top: 100, base: 110, halfWindow: 2, nSigma: 3 },
      { op: 'null', top: 108, base: 108 },
      { op: 'interpolate', top: 107, base: 109 },
      { op: 'scale', top: 100, base: 101, factor: 10 },
      { op: 'offset', top: 110, base: 110, value: -1 },
      { op: 'clip', top: 100, base: 110, min: 0, max: 15 },
    ]);
    // the spike at 103 m becomes the median of its window (2, 3, 100, 5, 6)
    expect(r.x[3]).toBe(5);
    // 108 m nulled, then 107 to 109 m rebuilt as a line from 106 m (7) to 110 m (11)
    expect(Array.from(r.x.slice(6, 10))).toEqual([7, 8, 9, 10]);
    expect(r.x[0]).toBe(10);
    expect(r.x[10]).toBe(10);
    // 2 x 10 = 20 is above the clip at 15, so it is nulled
    expect(Number.isNaN(r.x[1])).toBe(true);
    expect(r.ledger.map((l) => [l.op, l.changed])).toEqual([['despike', 1], ['null', 1], ['interpolate', 1], ['scale', 2], ['offset', 1], ['clip', 1]]);
    expect(r.ledger[5].params).toEqual({ min: 0, max: 15 });
  });

  test('negative control: the raw input is never changed', () => {
    const raw = x.slice();
    applyEdits(d, raw, [{ op: 'null', top: 100, base: 110 }]);
    expect(raw).toEqual(x);
  });

  test('refusals', () => {
    expect(() => applyEdits(d, x, [{ op: 'smear', top: 100, base: 101 }])).toThrow(/Unknown edit/);
    expect(() => applyEdits(d, x, [{ op: 'interpolate', top: 100, base: 102 }])).toThrow(/above and below/);
    expect(() => applyEdits(d, x, [{ op: 'constant', top: 100, base: 101 }])).toThrow(/needs a value/);
  });
});
