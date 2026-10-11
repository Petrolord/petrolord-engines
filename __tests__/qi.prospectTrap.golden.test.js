/**
 * Golden gate for engines/qi/prospectTrap.js (QI course gate E2-B). Every value comes from
 * tools/validation/qi/oracle_qi_prospect_trap.py: brute-force nearest node and crest climb, the spill
 * by union-find over decreasing elevation (the engine floods with a max-heap), closures by
 * breadth-first search with explicit GRV sums, its own bilinear read of the attribute map and the
 * documented decision table. Every assertion calls the shipped engine, on float32 surfaces framed
 * as the Suite's registry door frames them (spec, nodeXY, sampleAt from the engines' grid maths).
 */
import G from '../test-data/qi/goldens.prospectTrap.json';
import { gridXY, sampleAtXY, isNull } from '../lib/gridding/gridmath';
import { analyseProspect, climbToCrest, nearestNode, anomalyMaskOn, keepTouching } from '../engines/qi/prospectTrap';

const frame = (s) => {
  const spec = { x0: s.x0, y0: s.y0, dx: s.dx, dy: s.dy, nx: s.nx, ny: s.ny };
  const grid = Float32Array.from(s.z);
  return { ok: true, grid, spec, nodeXY: (r, c) => gridXY(spec, r, c), sampleAt: (x, y) => { const v = sampleAtXY(grid, spec, x, y); return isNull(v) ? null : v; } };
};
const F = Object.fromEntries(Object.entries(G.surfaces).map(([k, s]) => [k, frame(s)]));
const close = (got, want, rel = 1e-9, abs = 1e-9) => {
  if (want == null) { expect(got == null || !Number.isFinite(got)).toBe(true); return; }
  expect(Math.abs(got - want)).toBeLessThanOrEqual(abs + rel * Math.abs(want));
};

describe('analyseProspect against the oracle', () => {
  for (const c of G.cases) {
    test(c.name, () => {
      const r = analyseProspect({ depth: F[c.surface], attr: c.attr ? F[c.attr] : null, prospect: c.prospect, feasibility: c.feasibility });
      const t = c.trap;
      for (const k of ['x', 'y', 'depthM']) { close(r.trap.crest[k], t.crest[k], 0, 0); close(r.trap.spill[k], t.spill[k], 0, 0); }
      close(r.trap.columnM, t.columnM, 0, 0);
      close(r.trap.areaKm2, t.areaKm2, 1e-12, 0);
      close(r.trap.grvSpillM3, t.grvSpillM3, 1e-9, 1e-3);
      expect(r.trap.limitedByEdge).toBe(t.limitedByEdge);
      expect(r.trap.merges).toBe(t.merges);
      if (!c.anomaly) expect(r.anomaly).toBeNull();
      else {
        const a = c.anomaly;
        expect(r.anomaly.nodes).toBe(a.nodes);
        close(r.anomaly.areaKm2, a.areaKm2, 1e-12, 0);
        for (const k of ['conformance', 'edgeSdM', 'insideClosure', 'impliedContactDepthM', 'edgeBelowSpillM', 'impliedAboveSpillM']) close(r.anomaly[k], a[k], 1e-9, 1e-9);
        close(r.anomaly.grvImpliedM3, a.grvImpliedM3, 1e-9, 1e-3);
      }
      expect(r.evidence.independent).toBe(c.independent);
      expect(r.assessment.recommendation).toBe(c.recommendation);
      const why = r.assessment.reasons.join(' ');
      expect(/edge of the mapped area/.test(why)).toBe(c.edgeReason);
      expect(/Held at investigate/.test(why)).toBe(c.heldAtInvestigate);
      expect(/below the spill point; the contact is held at the spill/.test(why)).toBe(c.belowSpillReason);
    });
  }
});

describe('the helpers', () => {
  const d = F.T1;
  test('nearest node by brute force, never a null node', () => {
    for (const h of G.helpers.nearest) expect(nearestNode(F[h.surface || 'T1'], h.x, h.y)).toBe(h.node);
  });
  test('the climb to the local crest', () => {
    const z = Float64Array.from(d.grid);
    for (const h of G.helpers.climb) expect(climbToCrest(z, d.spec, h.start)).toBe(h.crest);
  });
  test('the anomaly read on another frame, and the patches that reach the closure', () => {
    const m = anomalyMaskOn(d, F.A1, { threshold: 0.5, sense: 'high' });
    expect(m.reduce((a, v) => a + v, 0)).toBe(G.helpers.mask.count);
    expect(m[0]).toBe(G.helpers.mask.corner);
    const ins = new Uint8Array(m.length); ins[G.cases[0].seed] = 1;
    expect(keepTouching(m, d.spec, ins).reduce((a, v) => a + v, 0)).toBe(G.helpers.mask.kept);
  });
});
