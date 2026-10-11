/**
 * AVO at the wells against the independent oracle (QI course gate E2):
 * tools/validation/qi/oracle_qi_avo_wells.py takes the scale as the vertex of
 * the exact pooled misfit parabola. Every assertion calls the shipped engine.
 */
import G from '../test-data/qi/goldens.avoWells.json';
import { compareAtWells, wellPoints } from '../engines/qi/avoWells';

const close = (a, b, tol = 1e-12) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(b)));

describe('compareAtWells against the oracle', () => {
  test('the sweep is not empty', () => expect(G.cases.length).toBeGreaterThanOrEqual(4));
  for (const c of G.cases) {
    test(c.name, () => {
      const r = compareAtWells(c.rows);
      if (c.expect.scale === null) expect(r.scale).toBeNaN();
      else close(r.scale, c.expect.scale, 1e-13);
      expect(r.n).toBe(c.expect.n);
      expect(r.agree).toBe(c.expect.agree);
      expect(r.wells).toHaveLength(c.expect.wells.length);
      r.wells.forEach((w, k) => {
        const e = c.expect.wells[k];
        expect(w.name).toBe(e.name);
        if (e.error) { expect(w.error).toBe(e.error); expect(w.scaled).toBeUndefined(); return; }
        expect(w.error).toBeUndefined();
        close(w.scaled.A, e.scaled.A); close(w.scaled.B, e.scaled.B);
        close(w.residual, e.residual, 1e-11);
        expect(w.modelledClass).toBe(e.modelledClass);
        expect(w.observedClass).toBe(e.observedClass);
        expect(w.agree).toBe(e.agree);
      });
    });
  }
});

test('wellPoints keeps the usable wells with a zone-top time', () => {
  expect(wellPoints(G.wellPoints.rows)).toEqual(G.wellPoints.points);
});

describe('observations pinned (FINDINGS-E2a.md), not endorsed', () => {
  const base = [
    { name: 'a', modelled: { A: 0.1, B: -0.2 }, observed: { A: 0.2, B: -0.4 } },
    { name: 'b', modelled: { A: -0.05, B: -0.1 }, observed: { A: -0.1, B: -0.2 } },
  ];
  test('a well flagged with an error still enters the pooled scale', () => {
    const r = compareAtWells([...base, { name: 'c', modelled: { A: 0.1, B: 0.1 }, observed: { A: 1, B: 1 }, error: 'x' }]);
    expect(r.n).toBe(3);
    expect(r.scale).not.toBeCloseTo(2, 3);
  });
  test('an observed B that is null counts as zero; one that is NaN poisons the scale', () => {
    const nul = compareAtWells([...base, { name: 'c', modelled: { A: 0.1, B: -0.2 }, observed: { A: 0.2, B: null } }]);
    expect(Number.isFinite(nul.scale)).toBe(true);
    expect(nul.scale).toBeLessThan(2);
    const nan = compareAtWells([...base, { name: 'c', modelled: { A: 0.1, B: -0.2 }, observed: { A: 0.2, B: NaN } }]);
    expect(nan.scale).toBeNaN();
  });
});
