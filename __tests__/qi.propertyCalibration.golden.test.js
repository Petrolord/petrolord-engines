/**
 * Golden gate for engines/qi/propertyCalibration.js (QI course gate E2-B). Every value comes from
 * tools/validation/qi/oracle_qi_property_calibration.py, which rebuilds the upscale, the rational
 * least-squares line, the closed-form Student t, the leave-one-out widening of #987 and the facies
 * posteriors by its own routes. Every assertion calls the shipped engine.
 */
import G from '../test-data/qi/goldens.propertyCalibration.json';
import { modeFilter, upscaleWells, predictTrace, calibrateProperty, fitProperty } from '../engines/qi/propertyCalibration';

const nan = (a) => (a == null ? a : a.map((v) => (v == null ? NaN : v)));
const close = (got, want, rel = 1e-9, abs = 1e-12) => {
  if (want == null) { expect(Number.isFinite(got)).toBe(false); return; }
  expect(Math.abs(got - want)).toBeLessThanOrEqual(abs + rel * Math.abs(want));
};
const job = (pr) => ({ ...pr, wells: pr.wells.map((w) => ({ ...w, ln_ai: nan(w.ln_ai), target: nan(w.target), vpvs: nan(w.vpvs) })) });

test('mode filter on facies codes', () => {
  for (const c of G.modeFilter) {
    const got = modeFilter(nan(c.codes), c.half);
    c.out.forEach((v, i) => (v == null ? expect(got[i]).toBeNaN() : expect(got[i]).toBe(v)));
  }
});

test('upscaled impedance and porosity (prefix-sum moving average, half window round half up)', () => {
  const up = upscaleWells(job(G.upscale.pr), G.dtMs);
  G.upscale.wells.forEach((w, k) => {
    w.ai.forEach((v, i) => close(up[k].ai[i], v, 1e-13));
    w.target.forEach((v, i) => close(up[k].target[i], v, 1e-13));
  });
});

describe('porosity: fit, left-out check and the widened band', () => {
  for (const c of G.porosity) {
    test(c.name, () => {
      const pr = job(c.pr);
      const res = calibrateProperty({ pr, aiTraces: c.aiTraces.map(nan), dtMs: G.dtMs });
      for (const k of ['a', 'b', 'r2', 's', 'sLoo', 'sExtra']) close(res.summary[k], c.summary[k], 1e-9);
      expect(res.summary.n).toBe(c.summary.n);
      c.rows.forEach((r, j) => {
        const g = res.rows[j];
        expect(g.name).toBe(r.name);
        expect(g.n).toBe(r.n);
        expect(g.coverage).toBe(r.coverage);
        close(g.rms, r.rms, 1e-9); close(g.bias, r.bias, 1e-8, 1e-13); close(g.corr, r.corr, 1e-8);
      });
      const q = predictTrace(res.model, pr, c.probe.map((v) => (v == null ? NaN : v)));
      c.probeQ.forEach((row, i) => row.forEach((v, j) => close(q[j][i], v, 1e-9)));
    });
  }
});

describe('facies: calibration and the tabulated posterior of the volume run', () => {
  for (const c of G.facies) {
    test(c.name, () => {
      const pr = job(c.pr);
      const ai = c.aiTraces.map(nan);
      const vt = c.vpvsTraces ? c.vpvsTraces.map(nan) : null;
      const res = calibrateProperty({ pr, aiTraces: ai, vpvsTraces: vt, dtMs: G.dtMs });
      expect(res.summary.density).toBe(c.summary.density);
      expect(res.summary.attributes).toBe(c.summary.attributes);
      c.summary.classes.forEach((cl, j) => {
        const g = res.summary.classes[j];
        expect(g.name).toBe(cl.name); expect(g.n).toBe(cl.n);
        for (const k of ['prior', 'mean', 'sd', 'meanVpVs', 'sdVpVs']) if (k in cl) close(g[k], cl[k], 1e-10);
      });
      c.rows.forEach((r, j) => { expect(res.rows[j].n).toBe(r.n); expect(res.rows[j].accuracy).toBe(r.accuracy); });
      const up = upscaleWells(pr, G.dtMs);
      const m = fitProperty(up, pr, G.dtMs);
      const out = predictTrace(m, pr, ai[c.trace.k], vt ? vt[c.trace.k] : null);
      const best = out[out.length - 1];
      c.trace.best.forEach((b, i) => {
        if (b == null) { expect(best[i]).toBeNaN(); return; }
        expect(best[i]).toBe(b);
        c.trace.probs[i].forEach((p, j) => close(out[j][i], p, 1e-7, 1e-10));
      });
    });
  }
});
