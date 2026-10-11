/**
 * Prospect assessment against its independent oracle (QI course gate E1c,
 * G8): tools/validation/qi/oracle_qi_prospect.py (stdlib; spill by a
 * union-find over descending elevation, closures by breadth-first search
 * per contact, GRV by explicit cell sums, the edge read from its
 * definition). Every assertion calls the shipped engine, on the shipped
 * closure engine's spill analysis.
 */
import G from '../test-data/qi/goldens.prospectAssessment.json';
import { spillAnalysis } from '../lib/gridding/closure';
import { anomalyConformance, evidenceIndependence, assessProspect, RECOMMENDATIONS } from '../engines/qi/prospectAssessment';

const rel = (got, want, tol) => expect(Math.abs(got - want)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(want)));
const grid = (z) => Float64Array.from(z, (v) => (v === null ? 1e30 : v));

describe('anomaly conformance, implied contact and GRV', () => {
  test.each(G.conformance.map((c) => [c.name, c]))('%s', (_, c) => {
    const z = grid(c.z);
    const spill = spillAnalysis(z, G.spec);
    expect(spill.crest.index).toBe(c.crest);
    rel(spill.spillZ, c.out.spillZ, 1e-12);
    const r = anomalyConformance({ z, spec: G.spec, mask: c.mask, spill });
    expect(r.anomalyNodes).toBe(c.out.anomalyNodes);
    expect(r.edgeNodes).toBe(c.out.edgeNodes);
    for (const k of ['impliedContactZ', 'edgeSdM', 'reliefM', 'conformance', 'insideClosure', 'impliedVsSpillM']) rel(r[k], c.out[k], 1e-10);
    rel(r.grvAtImpliedM3, c.out.grvAtImpliedM3, 1e-10);
    rel(r.grvAtSpillM3, c.out.grvAtSpillM3, 1e-10);
  });
  test('the contact-bounded anomaly GRV is the paraboloid cap within 5 percent', () => {
    const c = G.conformance[0];
    const z = grid(c.z);
    const r = anomalyConformance({ z, spec: G.spec, mask: c.mask, spill: spillAnalysis(z, G.spec) });
    expect(Math.abs(r.grvAtImpliedM3 - G.paraboloid.capM3) / G.paraboloid.capM3).toBeLessThan(0.05);
  });
  test('negative control: the anomaly of one case scored against another case fails the gate', () => {
    const c = G.conformance[0];
    const z = grid(c.z);
    const r = anomalyConformance({ z, spec: G.spec, mask: G.conformance[2].mask, spill: spillAnalysis(z, G.spec) });
    expect(Math.abs(r.conformance - c.out.conformance)).toBeGreaterThan(1e-3);
  });
});

describe('evidence independence', () => {
  test.each(G.evidence.map((c, k) => [k, c]))('case %s', (_, c) => {
    const e = evidenceIndependence(c.items);
    expect(e.independent).toBe(c.out.independent);
    expect(e.supporting).toBe(c.out.supporting);
    expect(e.groups.map((g) => ({ source: g.source, items: g.items }))).toEqual(c.out.groups);
    expect(e.shared).toEqual(c.out.shared);
  });
});

describe('the decision table', () => {
  test.each(G.decision.map((c, k) => [k, c]))('case %s', (_, c) => {
    const r = assessProspect(c.input);
    expect(r.recommendation).toBe(c.recommendation);
    expect(r.seismicSupport).toBe(c.seismicSupport);
    expect(r.label).toBe(RECOMMENDATIONS[c.recommendation]);
  });
});
