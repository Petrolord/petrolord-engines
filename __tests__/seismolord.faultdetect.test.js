/**
 * TP3F automatic fault picking gates. The engine runs on the analytic
 * synthetic field (syntheticField.js) and its sticks are scored against
 * the field's EXACT fault planes: a stick point (il, xl, s) is converted to
 * depth through the field's own time-depth relation at that position
 * (twtAtDepth inverted by bisection), then truth.faults[k].sideAt gives its
 * signed map distance from the plane. Nothing here restates the detector's
 * math; negative controls show every gate can fail.
 */

import { buildSyntheticField, DEFAULT_FIELD_SPEC } from '../engines/seismolord/syntheticField';
import {
  detectFaults, patchToSticks, FAULT_DETECT_DEFAULTS,
} from '../engines/seismolord/faultDetect';
import { loftFaultSurface } from '../engines/seismolord/faultObjects';

const SMALL = { nIl: 50, nXl: 44, ns: 360 };
const F1 = DEFAULT_FIELD_SPEC.faults[0];
const F1_STRIKE_DEG = Math.atan2(F1.dXl, F1.dIl) * 180 / Math.PI; // -14.04
const F2 = {
  name: 'F2', il0: 30, xl0: 0, dIl: 0.25, dXl: 1, dipDeg: 60, throwM: 40, zRefM: 1000,
};

/** Depth (m) of sample s at (il, xl): bisection on the field's twtAtDepth. */
function depthAtSample(field, il, xl, s) {
  const t = s * field.dtMs;
  let lo = 0;
  let hi = 8000;
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (field.twtAtDepth(il, xl, mid) < t) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** |map distance| of a stick point from a truth fault plane, in cells. */
function cellsFromPlane(field, fault, p) {
  const z = depthAtSample(field, p.il, p.xl, p.s);
  return Math.abs(fault.sideAt(p.il, p.xl, z)) / field.spec.binM;
}

/** Truth-like plane displaced sideways (for negative controls). */
function shiftedPlane(field, fault, cells) {
  return { sideAt: (il, xl, z) => fault.sideAt(il, xl, z) - cells * field.spec.binM };
}

const allPoints = (sticks) => sticks.flatMap((st) => st.points);

function fractionWithin(field, fault, points, cells = 2) {
  const ok = points.filter((p) => cellsFromPlane(field, fault, p) <= cells).length;
  return ok / points.length;
}

/** Fraction of all inlines carrying a stick whose median point distance is
 *  within 2 cells of the plane (every inline is crossed in the field). */
function inlineRecall(field, fault, sticks) {
  const good = new Set();
  for (const st of sticks) {
    const d = st.points.map((p) => cellsFromPlane(field, fault, p)).sort((a, b) => a - b);
    if (d[d.length >> 1] <= 2) good.add(st.points[0].il);
  }
  return good.size / field.geom.nIl;
}

/** Strike (lattice degrees) measured from inline sticks: slope of xl
 *  against il at common sample levels, averaged over levels. */
function strikeFromSticks(sticks) {
  const lvl = [];
  const interp = (pts, s) => {
    for (let k = 1; k < pts.length; k++) {
      if (pts[k - 1].s <= s && pts[k].s >= s) {
        const t = (s - pts[k - 1].s) / (pts[k].s - pts[k - 1].s);
        return pts[k - 1].xl + t * (pts[k].xl - pts[k - 1].xl);
      }
    }
    return null;
  };
  const sMin = Math.min(...sticks.map((st) => st.points[0].s));
  const sMax = Math.max(...sticks.map((st) => st.points[st.points.length - 1].s));
  for (let s = sMin; s <= sMax; s += 4) {
    const xs = [];
    for (const st of sticks) {
      const xl = interp(st.points, s);
      if (xl != null) xs.push([st.points[0].il, xl]);
    }
    if (xs.length < 3) continue;
    const n = xs.length;
    const mi = xs.reduce((a, q) => a + q[0], 0) / n;
    const mx = xs.reduce((a, q) => a + q[1], 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (const [i, x] of xs) {
      sxy += (i - mi) * (x - mx);
      sxx += (i - mi) ** 2;
    }
    if (sxx > 0) lvl.push(sxy / sxx);
  }
  const slope = lvl.reduce((a, b) => a + b, 0) / lvl.length;
  return Math.atan2(slope, 1) * 180 / Math.PI;
}

/** Least-squares slope of xl against s along one stick (cells/sample). */
function stickXlSlope(st) {
  const p = st.points;
  const ms = p.reduce((a, q) => a + q.s, 0) / p.length;
  const mx = p.reduce((a, q) => a + q.xl, 0) / p.length;
  let num = 0;
  let den = 0;
  for (const q of p) {
    num += (q.s - ms) * (q.xl - mx);
    den += (q.s - ms) ** 2;
  }
  return num / den;
}

const run = (field, params) => detectFaults({
  getTrace: field.getTrace, geom: field.geom, dtMs: field.dtMs, params,
});

describe('TP3F fault detection on the default synthetic field', () => {
  let field;
  let res;
  let runtimeMs;
  beforeAll(async () => {
    field = buildSyntheticField();
    const t0 = Date.now();
    res = await run(field);
    runtimeMs = Date.now() - t0;
  }, 60000);

  test('one fault is proposed, named Auto-1, above the confidence floor', () => {
    // eslint-disable-next-line no-console
    console.log(`default field ${field.geom.nIl}x${field.geom.nXl}x${field.geom.ns}: ${runtimeMs} ms,`
      + ` faults ${res.faults.map((f) => `${f.name} conf ${f.confidence.toFixed(3)} sticks ${f.sticks.length}`).join('; ')}`);
    expect(res.faults).toHaveLength(1);
    expect(res.faults[0].name).toBe('Auto-1');
    expect(res.faults[0].confidence).toBeGreaterThanOrEqual(FAULT_DETECT_DEFAULTS.confidenceFloor);
    expect(res.faults[0].confidence).toBeLessThanOrEqual(1);
    expect(res.likelihood).toHaveLength(field.geom.nIl * field.geom.nXl * field.geom.ns);
    expect(res.patches).toHaveLength(1);
  });

  test('location: >= 90 percent of stick points within 2 cells of the true plane', () => {
    const pts = allPoints(res.faults[0].sticks);
    const frac = fractionWithin(field, field.truth.faults[0], pts);
    // eslint-disable-next-line no-console
    console.log(`location: ${pts.length} points, fraction within 2 cells ${frac.toFixed(3)}`);
    expect(frac).toBeGreaterThanOrEqual(0.9);
    // negative control: the same points against a plane moved 6 cells fail
    const wrong = fractionWithin(field, shiftedPlane(field, field.truth.faults[0], 6), pts);
    expect(wrong).toBeLessThan(0.5);
  });

  test('recall: >= 70 percent of inlines get a stick within 2 cells', () => {
    const { sticks } = patchToSticks(res.patches[0], field.geom, { every: 1, orientation: 'inline' });
    const recall = inlineRecall(field, field.truth.faults[0], sticks);
    // eslint-disable-next-line no-console
    console.log(`recall: ${recall.toFixed(3)} of ${field.geom.nIl} inlines`);
    expect(recall).toBeGreaterThanOrEqual(0.7);
    // negative control: against a plane moved 6 cells the recall collapses
    expect(inlineRecall(field, shiftedPlane(field, field.truth.faults[0], 6), sticks)).toBeLessThan(0.3);
  });

  test('strike within 10 degrees of truth; dip sense toward the hanging wall', () => {
    const f = res.faults[0];
    const strike = strikeFromSticks(f.sticks);
    // eslint-disable-next-line no-console
    console.log(`strike: sticks ${strike.toFixed(2)}, patch ${f.stats.strikeDeg.toFixed(2)},`
      + ` truth ${F1_STRIKE_DEG.toFixed(2)} (lattice degrees)`);
    expect(Math.abs(strike - F1_STRIKE_DEG)).toBeLessThanOrEqual(10);
    expect(Math.abs(f.stats.strikeDeg - F1_STRIKE_DEG)).toBeLessThanOrEqual(10);
    // negative control: a fault striking along crosslines would fail
    expect(Math.abs(strike - 76)).toBeGreaterThan(10);

    // truth dip sense, from the plane itself: where is the plane at 800 m
    // and 1200 m on inline 30? (sideAt is monotonic in xl)
    const planeXl = (z) => {
      let lo = 0;
      let hi = field.geom.nXl - 1;
      for (let k = 0; k < 50; k++) {
        const mid = 0.5 * (lo + hi);
        if (field.truth.faults[0].sideAt(30, mid, z) < 0) lo = mid; else hi = mid;
      }
      return lo;
    };
    const truthSense = Math.sign(planeXl(1200) - planeXl(800));
    expect(truthSense).toBe(1); // hanging wall is +xl for F1
    const slopes = f.sticks.map(stickXlSlope);
    const agree = slopes.filter((b) => Math.sign(b) === truthSense).length / slopes.length;
    expect(agree).toBeGreaterThanOrEqual(0.8);
    expect(Math.sign(f.stats.dipIndicator)).toBe(truthSense);
  });

  test('stick shape: >= 3 points, s strictly increasing, loftable', () => {
    for (const f of res.faults) {
      expect(f.sticks.length).toBeGreaterThanOrEqual(2);
      for (const st of f.sticks) {
        expect(st.points.length).toBeGreaterThanOrEqual(3);
        for (let k = 1; k < st.points.length; k++) expect(st.points[k].s).toBeGreaterThan(st.points[k - 1].s);
        for (const p of st.points) {
          expect(Number.isFinite(p.il) && Number.isFinite(p.xl) && Number.isFinite(p.s)).toBe(true);
          expect(p.il).toBeGreaterThanOrEqual(0);
          expect(p.il).toBeLessThanOrEqual(field.geom.nIl - 1);
          expect(p.xl).toBeGreaterThanOrEqual(0);
          expect(p.xl).toBeLessThanOrEqual(field.geom.nXl - 1);
        }
      }
      const surf = loftFaultSurface(f.sticks, { samples: 16 });
      expect(surf).not.toBeNull();
      expect(surf.rails).toHaveLength(f.sticks.length);
    }
  });
});

describe('TP3F two non-parallel faults stay separate', () => {
  test('a crossing pair yields two faults, each on its own plane', async () => {
    const field = buildSyntheticField({ ...SMALL, faults: [F1, F2] });
    const res = await run(field);
    // eslint-disable-next-line no-console
    console.log(`two faults: ${res.faults.map((f) => `${f.name} strike ${f.stats.strikeDeg.toFixed(1)} conf ${f.confidence.toFixed(2)}`).join('; ')}`);
    expect(res.faults.length).toBeGreaterThanOrEqual(2);
    const [t1, t2] = field.truth.faults;
    const assigned = res.faults.slice(0, 2).map((f) => {
      const pts = allPoints(f.sticks);
      const a = fractionWithin(field, t1, pts);
      const b = fractionWithin(field, t2, pts);
      return { which: a >= b ? 0 : 1, frac: Math.max(a, b), other: Math.min(a, b) };
    });
    // each proposed fault lives on one plane, and the two cover both planes
    expect(new Set(assigned.map((q) => q.which)).size).toBe(2);
    for (const q of assigned) {
      expect(q.frac).toBeGreaterThanOrEqual(0.8);
      // a merged fault would put a large share of points on the other plane
      expect(q.other).toBeLessThan(0.35);
    }
  }, 60000);
});

describe('TP3F negative controls', () => {
  test('an unfaulted field proposes no fault', async () => {
    const field = buildSyntheticField({ ...SMALL, faults: [] });
    const res = await run(field);
    let max = 0;
    for (const v of res.likelihood) if (v > max) max = v;
    // eslint-disable-next-line no-console
    console.log(`unfaulted: max likelihood ${max.toFixed(3)}, faults ${res.faults.length}`);
    expect(res.faults).toHaveLength(0);
  }, 60000);

  test('an unfaulted field with noise 0.03 proposes no fault', async () => {
    const field = buildSyntheticField({ ...SMALL, faults: [], noise: 0.03 });
    const res = await run(field);
    let max = 0;
    for (const v of res.likelihood) if (v > max) max = v;
    // eslint-disable-next-line no-console
    console.log(`unfaulted + noise: max likelihood ${max.toFixed(3)}, faults ${res.faults.length}`);
    expect(res.faults).toHaveLength(0);
  }, 60000);

  test('the floor is live: the two-fault volume proposes nothing when the floor is above every confidence', async () => {
    // the same field yields two faults at the default floor (test above)
    const field = buildSyntheticField({ ...SMALL, faults: [F1, F2] });
    const res = await run(field, { confidenceFloor: 0.99 });
    expect(res.faults).toHaveLength(0);
  }, 60000);
});
