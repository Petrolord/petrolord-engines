import { spillAnalysis } from '../lib/gridding/closure';
import { anomalyConformance, evidenceIndependence, assessProspect, RECOMMENDATIONS } from '../engines/qi/prospectAssessment';

// A paraboloid dome z = -2000 - a r^2 on a 25 m grid. Its cap above the
// contact at radius R has the volume pi a R^4 / 2 (known truth).
const nx = 81; const ny = 81; const dx = 25; const a = 0.0004;
const spec = { x0: 0, y0: 0, dx, dy: dx, nx, ny };
const cx = 40 * dx; const cy = 40 * dx;
const r2 = (i) => { const x = (i % nx) * dx - cx; const y = Math.floor(i / nx) * dx - cy; return x * x + y * y; };
const z = Float64Array.from({ length: nx * ny }, (_, i) => -2000 - a * r2(i));
const spill = spillAnalysis(z, spec);
const R = 500; const contact = -2000 - a * R * R;
const flatMask = Float64Array.from(z, (v) => (v >= contact ? 1 : 0));
// a patch across the east flank, cutting the contours
const offMask = Float64Array.from({ length: nx * ny }, (_, i) => {
  const x = (i % nx) * dx - (cx + 450); const y = Math.floor(i / nx) * dx - cy;
  return x * x + y * y <= 300 * 300 ? 1 : 0;
});

describe('anomaly conformance', () => {
  test('a contact-bounded anomaly conforms, implies its contact and its GRV matches the paraboloid cap', () => {
    const c = anomalyConformance({ z, spec, mask: flatMask, spill });
    expect(c.conformance).toBeGreaterThan(0.95);
    expect(Math.abs(c.impliedContactZ - contact)).toBeLessThan(a * 2 * R * dx); // within one cell of relief
    expect(c.insideClosure).toBe(1);
    const truth = (Math.PI * a * R ** 4) / 2;
    expect(Math.abs(c.grvAtImpliedM3 - truth) / truth).toBeLessThan(0.05);
    expect(c.grvAtSpillM3).toBeGreaterThan(c.grvAtImpliedM3);
  });
  test('negative control: a patch across the flank does not conform', () => {
    const c = anomalyConformance({ z, spec, mask: offMask, spill });
    expect(c.conformance).toBeLessThan(0.85);
    expect(c.edgeSdM).toBeGreaterThan(5 * anomalyConformance({ z, spec, mask: flatMask, spill }).edgeSdM);
  });
  test('refusals', () => {
    expect(() => anomalyConformance({ z, spec, mask: new Float64Array(nx * ny), spill })).toThrow(/no mapped nodes/);
    expect(() => anomalyConformance({ z, spec, mask: [1], spill })).toThrow(/one grid/);
  });
});

describe('evidence independence', () => {
  test('attributes from one response count once', () => {
    const e = evidenceIndependence([
      { name: 'RMS amplitude', source: 'full_stack' },
      { name: 'Low impedance', source: 'full_stack' },
    ]);
    expect(e.independent).toBe(1);
    expect(e.shared).toEqual([{ source: 'full_stack', items: ['RMS amplitude', 'Low impedance'] }]);
    const f = evidenceIndependence([{ name: 'RMS', source: 'full_stack' }, { name: 'Class III AVO', source: 'avo' }, { name: 'Shows', source: 'well', supports: false }]);
    expect(f.independent).toBe(2);
    expect(f.supporting).toBe(2);
  });
});

describe('the assessment table', () => {
  const base = { anomalyPresent: true, conformance: 0.9, insideClosure: 1, independent: 2, feasibility: 'feasible', competing: [{ name: 'tuning', status: 'ruled-out' }] };
  test.each([
    [{}, 'mature', 'supports'],
    [{ independent: 1 }, 'investigate', 'supports'],
    [{ conformance: 0.5 }, 'investigate', 'supports'],
    [{ conformance: 0.2 }, 'investigate', 'neutral'],
    [{ competing: [{ name: 'low-saturation gas', status: 'open' }] }, 'investigate', 'supports'],
    [{ competing: [{ name: 'lithology', status: 'likely' }] }, 'investigate', 'neutral'],
    [{ competing: [{ name: 'lithology', status: 'likely' }], conformance: 0.2 }, 'downgrade', 'against'],
    [{ feasibility: 'not-feasible' }, 'investigate', 'supports'],
    [{ anomalyPresent: false, feasibility: 'feasible' }, 'downgrade', 'against'],
    [{ anomalyPresent: false, feasibility: 'not-feasible' }, 'retain', 'neutral'],
    [{ anomalyPresent: false, feasibility: 'conditional' }, 'retain', 'neutral'],
  ])('case %#', (over, rec, support) => {
    const r = assessProspect({ ...base, ...over });
    expect(r.recommendation).toBe(rec);
    expect(r.seismicSupport).toBe(support);
    expect(r.label).toBe(RECOMMENDATIONS[rec]);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
  test('negative control: the absence of an anomaly is not evidence unless the case would be visible', () => {
    expect(assessProspect({ anomalyPresent: false, feasibility: '' }).recommendation).toBe('retain');
  });
});
