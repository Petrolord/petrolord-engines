// Moved with engines/qi/prospectTrap.js from the Suite (QI course gate E2). The Suite reads surfaces
// through its registry door (readDepthSurface); here the same frame is built from the engines' own
// grid maths: spec {x0, y0, dx, dy, nx, ny}, nodeXY and sampleAt.
import { gridXY, sampleAtXY, isNull } from '../lib/gridding/gridmath';
import { analyseProspect, climbToCrest, anomalyMaskOn, keepTouching, nearestNode } from '../engines/qi/prospectTrap';

const readDepthSurface = (row, values) => {
  const spec = { x0: row.origin_x, y0: row.origin_y, dx: row.dx, dy: row.dy, nx: row.nx, ny: row.ny };
  const grid = Float32Array.from(values);
  return {
    ok: true, grid, spec,
    nodeXY: (r, c) => gridXY(spec, r, c),
    sampleAt: (x, y) => { const v = sampleAtXY(grid, spec, x, y); return isNull(v) ? null : v; },
  };
};

// A dome (paraboloid) on a 25 m grid, read through the registry door, and an
// attribute map that is bright above a flat contact at 2100 m plus a second
// bright patch far off the structure.
const nx = 81; const ny = 81; const dx = 25; const a = 0.0004;
const row = (over) => ({ name: 'Top Sand A', nx, ny, dx, dy: dx, origin_x: 500000, origin_y: 6000000, z_domain: 'elevation', z_unit: 'm', xy_unit: 'm', ...over });
const cx = 40 * dx; const cy = 40 * dx;
const elev = Float32Array.from({ length: nx * ny }, (_, i) => { const x = (i % nx) * dx - cx; const y = Math.floor(i / nx) * dx - cy; return -2000 - a * (x * x + y * y); });
const depth = readDepthSurface(row({}), elev, { accept: ['elevation', 'depth'], as: 'elevation', xy: 'm' });
const bright = Float32Array.from(elev, (v, i) => {
  const c = i % nx; const r = Math.floor(i / nx);
  if (v >= -2100) return 1.0;
  if (c < 6 && r < 6) return 1.0; // an unrelated patch in a corner
  return 0.1;
});
const attr = readDepthSurface(row({ name: 'RMS amplitude', z_domain: 'attribute', z_unit: null }), bright, { accept: ['attribute'], xy: 'm' });

describe('prospect analysis', () => {
  test('the reader frames are usable', () => {
    expect(depth.ok).toBe(true);
    expect(attr.ok).toBe(true);
  });
  test('trap, conforming anomaly, implied contact and the assessment', () => {
    const r = analyseProspect({
      depth, attr, feasibility: 'feasible',
      prospect: {
        crestX: 500000 + 900, crestY: 6000000 + 1100, anomaly: { threshold: 0.5, sense: 'high' },
        evidence: [{ name: 'RMS amplitude', source: 'full_stack' }, { name: 'Class III AVO', source: 'avo' }],
        competing: [{ name: 'Tuning', status: 'ruled-out' }],
      },
    });
    expect(r.trap.crest.depthM).toBeCloseTo(2000, 6);
    expect(r.trap.columnM).toBeGreaterThan(200);
    expect(r.anomaly.conformance).toBeGreaterThan(0.95);
    expect(Math.abs(r.anomaly.impliedContactDepthM - 2100)).toBeLessThan(6);
    expect(r.anomaly.insideClosure).toBe(1); // the corner patch is dropped
    const truth = (Math.PI * a * 500 ** 4) / 2; // the cap above 2100 m: R = 500 m
    expect(Math.abs(r.anomaly.grvImpliedM3 - truth) / truth).toBeLessThan(0.05);
    expect(r.assessment.recommendation).toBe('mature');
    expect(r.evidence.independent).toBe(2);
  });
  test('negative control: the same anomaly from one response only does not mature', () => {
    const r = analyseProspect({ depth, attr, feasibility: 'feasible', prospect: { anomaly: { threshold: 0.5 }, evidence: [{ name: 'RMS amplitude', source: 'full_stack' }, { name: 'Low impedance', source: 'full_stack' }] } });
    expect(r.evidence.independent).toBe(1);
    expect(r.assessment.recommendation).toBe('investigate');
  });
  test('no anomaly: downgrade where the case would be visible, retain where not', () => {
    expect(analyseProspect({ depth, attr: null, feasibility: 'feasible', prospect: {} }).assessment.recommendation).toBe('downgrade');
    expect(analyseProspect({ depth, attr: null, feasibility: 'not-feasible', prospect: {} }).assessment.recommendation).toBe('retain');
  });
  test('the map edge spill is said', () => {
    const r = analyseProspect({ depth, attr: null, feasibility: '', prospect: {} });
    expect(r.trap.limitedByEdge).toBe(true);
    expect(r.assessment.reasons.join(' ')).toMatch(/edge of the mapped area/);
  });
  test('an anomaly filled past the edge spill: the contact is held at spill and the prospect does not mature', () => {
    const wide = readDepthSurface(row({ name: 'RMS amplitude', z_domain: 'attribute', z_unit: null }), Float32Array.from(elev, (v) => (v >= -2500 ? 1.0 : 0.1)), { accept: ['attribute'], xy: 'm' });
    const r = analyseProspect({
      depth, attr: wide, feasibility: 'feasible',
      prospect: { anomaly: { threshold: 0.5 }, evidence: [{ name: 'RMS amplitude', source: 'full_stack' }, { name: 'Class III AVO', source: 'avo' }], competing: [{ name: 'Tuning', status: 'ruled-out' }] },
    });
    expect(r.trap.limitedByEdge).toBe(true);
    expect(r.anomaly.impliedContactDepthM).toBeCloseTo(r.trap.spill.depthM, 6);
    expect(r.anomaly.edgeBelowSpillM).toBeGreaterThan(50);
    expect(r.assessment.recommendation).not.toBe('mature');
    expect(r.assessment.reasons.join(' ')).toMatch(/spill on the map edge/);
    expect(r.assessment.reasons.join(' ')).toMatch(/below the spill point; the contact is held at the spill/);
  });
  test('helpers: nearest node, climb, mask, connected patches', () => {
    const n = nearestNode(depth, 500000 + 0, 6000000 + 0);
    expect(n).toBe(0);
    expect(climbToCrest(Float64Array.from(elev), depth.spec, 0)).toBe(40 * nx + 40);
    const m = anomalyMaskOn(depth, attr, { threshold: 0.5 });
    const inside = new Uint8Array(nx * ny); inside[40 * nx + 40] = 1;
    const kept = keepTouching(m, depth.spec, inside);
    expect(kept[0]).toBe(0); expect(m[0]).toBe(1); expect(kept[40 * nx + 40]).toBe(1);
  });
});
